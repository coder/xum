/**
 * #6426: discover the Agent Plugins of a project checkout that lives on a remote runtime (SSH,
 * Docker), for their skills and agents only.
 *
 * discoverAgentPlugins reads the host filesystem. To apply its exact manifest, containment and
 * component rules to a remote checkout, one remote command lists each plugin container (entry
 * types, symlink targets, and the bytes of every regular file of at most MAX_FILE_SIZE). The host
 * rebuilds that listing in a private temp directory (the "mirror"), runs the unchanged
 * discoverAgentPlugins on it, and keeps the mirror as a snapshot that the host-local plugin
 * readers parse. Nothing in the mirror ever runs.
 * - A bigger file is left out, as if missing (the skill tools refuse such files anyway).
 * - A symlink is rebuilt only when its remote realpath stays inside the checkout root. Any other
 *   symlink (outside the root, dangling) is left out, so discovery sees nothing there.
 * Plugin MCP servers, hooks, workflows and slash commands run code, so they are dropped from the
 * result (#7218). Any failure gives no remote plugins at all, never a partial set: remote plugins
 * are best-effort and must never block a turn. The caller gates on project trust.
 */
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { shellQuote } from "@/common/utils/shell";
import * as fs from "node:fs";
import type { Runtime } from "@/node/runtime/Runtime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { discoverAgentPlugins, type AgentPluginInfo } from "./discovery";

/**
 * Deep enough for `<plugin>/skills/<name>/SKILL.md` and `contributes` paths of up to 7 segments.
 * Deeper files are left out (the entry cap bounds the cost, not the depth).
 */
const MAX_LISTING_DEPTH = 10;
/** Entries per call; a bigger listing loads no remote plugins (fail closed). */
export const MAX_REMOTE_PLUGIN_ENTRIES = 4000;
const MAX_LISTING_OUTPUT_BYTES = 16 * 1024 * 1024;
const LISTING_TIMEOUT_SECONDS = 10;

/** The skills and agents part of AgentPluginInfo, with remote paths. */
export type RemoteProjectAgentPlugin = Pick<
  AgentPluginInfo,
  | "name"
  | "scope"
  | "rootPath"
  | "containerPath"
  | "dirName"
  | "manifest"
  | "codexFallback"
  | "claudeFallback"
  | "skillsOnly"
  | "skillsDirs"
  | "agentsDir"
>;

/**
 * One POSIX sh script for every container: a single remote round trip. Output lines are
 * tab-separated: `K 0 real lexical` per container (lexical under the real checkout root), then per
 * walked tree `D|L 0 target path` lines, `F size  path` lines and one `B 0  tree` line that is
 * followed by the base64 bytes of those F files, in order, up to a `.` line. Then `ROOT 0 <real
 * checkout root>` and `END`. The walk runs a fixed number of processes per tree, not per entry:
 * a per-file `wc`/`base64` took ~20 s for 4000 entries. A name with a tab produces a line the host
 * rejects, and a name with a newline exits the script: both fail the whole listing closed. `head`
 * bounds the walk of each tree; the host refuses a listing over MAX_REMOTE_PLUGIN_ENTRIES.
 */
export function buildRemotePluginListingScript(checkoutRoot: string, containers: string[]): string {
  const limit = MAX_REMOTE_PLUGIN_ENTRIES + 1;
  const tree = `find -P "$1" -mindepth 1 -maxdepth "$2"`;
  // Regular files of at most MAX_FILE_SIZE bytes; the same predicate lists and reads them.
  const files = `${tree} -type f -size -${MAX_FILE_SIZE + 1}c`;
  return [
    `set -- ${[checkoutRoot, ...containers].map(shellQuote).join(" ")}`,
    `rootarg=$1`,
    `root=$(readlink -f "$1") || exit 3`,
    `shift`,
    `tab=$(printf '\\t')`,
    `nl='`,
    `'`,
    `walk() {`,
    `  [ -z "$(${tree} -name "*$nl*" | head -n 1)" ] || exit 4`,
    `  ${tree} -type d | head -n ${limit} | sed "s|^|D\${tab}0\${tab}\${tab}|"`,
    `  ${tree} -type l | head -n ${limit} | while IFS= read -r e; do t=$(readlink -f "$e" 2>/dev/null) || t=; printf 'L\\t0\\t%s\\t%s\\n' "$t" "$e"; done`,
    // Count first, so wc and cat never run over a tree the host will refuse anyway.
    `  [ $(${files} | head -n ${limit} | wc -l) -lt ${limit} ] || exit 5`,
    String.raw`  ${files} -exec wc -c {} + | sed -n "s|^ *\([0-9][0-9]*\) \(/.*\)\$|F${"$"}{tab}\1${"$"}{tab}${"$"}{tab}\2|p"`,
    `  printf 'B\\t0\\t\\t%s\\n' "$1"`,
    `  ${files} -exec cat {} + | base64`,
    `  printf '.\\n'`,
    `}`,
    `for c in "$@"; do`,
    `  case "$c" in "$rootarg"/*) lex="$root/\${c#"$rootarg"/}" ;; *) continue ;; esac`,
    `  real=$(readlink -f "$c" 2>/dev/null) || continue`,
    `  [ -d "$real" ] || continue`,
    // A container that resolves outside the checkout is never walked, so none of its bytes leave.
    `  case "$real" in "$root"/*) ;; *) continue ;; esac`,
    `  printf 'K\\t0\\t%s\\t%s\\n' "$real" "$lex"`,
    `  walk "$real" ${MAX_LISTING_DEPTH}`,
    // A plugin folder may be a symlink to a directory elsewhere in the checkout.
    `  for e in "$real"/* "$real"/.[!.]*; do [ -L "$e" ] || continue; t=$(readlink -f "$e" 2>/dev/null) || continue`,
    `    case "$t" in "$root"/*) [ -d "$t" ] && { printf 'D\\t0\\t\\t%s\\n' "$t"; walk "$t" ${MAX_LISTING_DEPTH - 1}; } ;; esac`,
    `  done`,
    `done`,
    `printf 'ROOT\\t0\\t%s\\t\\n' "$root"`,
    `printf 'END\\n'`,
  ].join("\n");
}

interface ListingEntry {
  kind: "K" | "D" | "F" | "L";
  size: number;
  target: string;
  path: string;
  data?: Buffer;
}

const ENTRY_KINDS = new Set<string>(["K", "D", "F", "L", "B"]);
const BASE64_LINE = /^[A-Za-z0-9+/=]*$/;

interface Listing {
  root: string;
  entries: ListingEntry[];
}

/**
 * An absolute POSIX path of plain names. A backslash, a `:` or a NUL could mean a separator or a
 * drive on the host (Windows), and an empty, `.` or `..` segment could climb out of the mirror,
 * so any such path refuses the whole listing.
 */
function isPlainRemotePath(remote: string): boolean {
  return (
    remote.startsWith("/") &&
    remote
      .slice(1)
      .split("/")
      .every((name) => name !== "" && name !== "." && name !== ".." && !/[\\:\0]/.test(name))
  );
}

/** One line's fields as an entry, "B" for a blob header, or null when they are malformed. */
function parseEntryFields(fields: string[]): ListingEntry | "B" | null {
  if (fields.length !== 4) return null;
  const [kind, size, target, entryPath] = fields;
  if (!ENTRY_KINDS.has(kind) || !isPlainRemotePath(entryPath) || !/^\d+$/.test(size)) {
    return null;
  }
  if (target !== "" && !isPlainRemotePath(target)) return null;
  if (kind === "B") return "B";
  return { kind: kind as ListingEntry["kind"], size: Number(size), target, path: entryPath };
}

/** The listing's lines without the final END line; null when the output was cut off. */
function listingLines(stdout: string): string[] | null {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.pop() === "END" ? lines : null;
}

/** Gives each F entry its bytes from the blob, in order; false when the sizes do not add up. */
function assignBlob(files: ListingEntry[], base64Lines: string[]): boolean {
  if (!base64Lines.every((line) => BASE64_LINE.test(line))) return false;
  const blob = Buffer.from(base64Lines.join(""), "base64");
  let offset = 0;
  for (const file of files) {
    file.data = blob.subarray(offset, offset + file.size);
    offset += file.size;
  }
  // A file that changed between the size pass and the read pass shifts every later file.
  return offset === blob.length;
}

interface ParseState {
  entries: ListingEntry[];
  /** F entries whose bytes come with the next B blob. */
  pendingFiles: ListingEntry[];
  root?: string;
}

/** Consumes line `i` (with the blob lines after a B line); the next index, or -1 if malformed. */
function consumeLine(state: ParseState, lines: string[], i: number): number {
  const fields = lines[i].split("\t");
  if (fields[0] === "ROOT" && fields.length === 4) {
    state.root = fields[2];
    return i + 1;
  }
  const entry = parseEntryFields(fields);
  if (entry === null) return -1;
  if (entry !== "B") {
    state.entries.push(entry);
    if (entry.kind === "F") state.pendingFiles.push(entry);
    return i + 1;
  }
  const end = lines.indexOf(".", i + 1);
  if (end === -1 || !assignBlob(state.pendingFiles, lines.slice(i + 1, end))) return -1;
  state.pendingFiles = [];
  return end + 1;
}

/** Parses the listing; null when it is cut off, too big or malformed (fail closed). */
export function parseRemotePluginListing(stdout: string): Listing | null {
  const lines = listingLines(stdout);
  if (lines === null) return null;
  const state: ParseState = { entries: [], pendingFiles: [] };
  for (let i = 0; i < lines.length; ) {
    i = consumeLine(state, lines, i);
    if (i === -1) return null;
  }
  const { entries, pendingFiles, root } = state;
  // F lines without their blob mean the output was cut.
  if (pendingFiles.length > 0 || root === undefined || !isPlainRemotePath(root)) return null;
  return entries.length <= MAX_REMOTE_PLUGIN_ENTRIES ? { root, entries } : null;
}

/** `remote` relative to `root`, or null when it is not strictly inside it. */
function relativeInside(root: string, remote: string): string | null {
  if (!remote.startsWith(root + "/")) return null;
  const relative = remote.slice(root.length + 1);
  // A `..` segment would let a crafted line escape the mirror.
  return relative.split("/").includes("..") ? null : relative;
}

/** True when `dest`, resolved with the host path rules, is strictly inside `mirrorRoot`. */
export function isInsideMirror(
  hostPath: typeof path.posix,
  mirrorRoot: string,
  dest: string
): boolean {
  const relative = hostPath.relative(hostPath.resolve(mirrorRoot), hostPath.resolve(dest));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${hostPath.sep}`) &&
    !hostPath.isAbsolute(relative)
  );
}

/** Remote path -> mirror path, checked inside the mirror; null outside the checkout root. */
type ToMirror = (remote: string) => string | null;

/** A container line: its real directory, plus a symlink at its lexical path when they differ. */
async function mirrorContainer(entry: ListingEntry, toMirror: ToMirror): Promise<string | null> {
  const real = toMirror(entry.target);
  const lexical = toMirror(entry.path);
  // A container outside the checkout root (or its symlink there) is not read.
  if (real === null || lexical === null) return null;
  await fsPromises.mkdir(real, { recursive: true });
  if (lexical !== real) {
    await fsPromises.mkdir(path.dirname(lexical), { recursive: true });
    await fsPromises.symlink(real, lexical).catch(() => undefined);
  }
  return lexical;
}

async function mirrorEntry(entry: ListingEntry, local: string, toMirror: ToMirror): Promise<void> {
  await fsPromises.mkdir(entry.kind === "D" ? local : path.dirname(local), { recursive: true });
  if (entry.kind === "L") {
    // Only a symlink whose remote realpath stays inside the checkout root is rebuilt.
    const target = entry.target === "" ? null : toMirror(entry.target);
    if (target !== null) await fsPromises.symlink(target, local).catch(() => undefined);
  } else if (entry.kind === "F") {
    await fsPromises.writeFile(local, entry.data ?? Buffer.alloc(0));
  }
}

/** Rebuilds the listing under `mirrorRoot`; returns each listed container's mirror path. */
async function buildMirror(mirrorRoot: string, listing: Listing): Promise<Map<string, string>> {
  const toMirror: ToMirror = (remote) => {
    const relative = relativeInside(listing.root, remote);
    if (relative === null) return null;
    const local = path.join(mirrorRoot, ...relative.split("/"));
    assert(isInsideMirror(path, mirrorRoot, local), `remote plugin mirror escaped: ${local}`);
    return local;
  };
  const containers = new Map<string, string>();
  for (const entry of listing.entries) {
    if (entry.kind === "K") {
      const lexical = await mirrorContainer(entry, toMirror);
      if (lexical !== null) containers.set(entry.path, lexical);
      continue;
    }
    const local = toMirror(entry.path);
    if (local !== null) await mirrorEntry(entry, local, toMirror);
  }
  return containers;
}

/** The skills and agents fields of a mirrored plugin, with remote paths. */
function toRemotePlugin(
  plugin: AgentPluginInfo,
  containerPath: string,
  toRemote: (local: string) => string
): RemoteProjectAgentPlugin {
  return {
    name: plugin.name,
    scope: plugin.scope,
    rootPath: toRemote(plugin.rootPath),
    containerPath,
    dirName: plugin.dirName,
    manifest: plugin.manifest,
    ...(plugin.codexFallback ? { codexFallback: true as const } : {}),
    ...(plugin.claudeFallback ? { claudeFallback: true as const } : {}),
    ...(plugin.skillsOnly ? { skillsOnly: true as const } : {}),
    ...(plugin.skillsDirs !== undefined
      ? { skillsDirs: plugin.skillsDirs.map((root) => ({ ...root, dir: toRemote(root.dir) })) }
      : {}),
    ...(plugin.agentsDir !== undefined ? { agentsDir: toRemote(plugin.agentsDir) } : {}),
  };
}

interface RemotePluginArgs {
  runtime: Runtime;
  checkoutRoot: string;
  /** Remote container paths, e.g. `<checkoutRoot>/.xum/plugins`, in precedence order. */
  containers: string[];
}

async function readRemoteListing(args: RemotePluginArgs): Promise<Listing | null> {
  const result = await execBuffered(
    args.runtime,
    buildRemotePluginListingScript(args.checkoutRoot, args.containers),
    {
      cwd: args.checkoutRoot,
      timeout: LISTING_TIMEOUT_SECONDS,
      maxOutputBytes: MAX_LISTING_OUTPUT_BYTES,
    }
  );
  const listing = result.exitCode === 0 ? parseRemotePluginListing(result.stdout) : null;
  if (listing === null) {
    log.debug("Remote project plugins: no usable listing", { exitCode: result.exitCode });
  }
  return listing;
}

/**
 * A remote checkout's project plugins, parsed from a host mirror. `plugins` carry MIRROR paths
 * (for the host-local plugin readers); `toRemote` maps a mirror path to its remote path, which
 * is what tool output and the agent see.
 */
export interface RemoteProjectPluginSnapshot {
  mirrorRoot: string;
  remoteRoot: string;
  plugins: RemoteProjectAgentPlugin[];
  toRemote: (local: string) => string;
}

/** Runs local discovery on the mirror; its plugins keep mirror paths. */
async function discoverInMirror(
  args: RemotePluginArgs,
  listing: Listing,
  mirrorRoot: string
): Promise<RemoteProjectPluginSnapshot> {
  const mirrored = await buildMirror(mirrorRoot, listing);
  // The script reports each container under the REAL checkout root.
  const localContainers = args.containers.flatMap((remote) => {
    const local = remote.startsWith(args.checkoutRoot + "/")
      ? mirrored.get(listing.root + remote.slice(args.checkoutRoot.length))
      : undefined;
    return local === undefined ? [] : [{ remote, local }];
  });
  const { plugins } = await discoverAgentPlugins(
    localContainers.map(({ local }) => ({ path: local, scope: "project" as const }))
  );
  const toRemote = (local: string): string => {
    const relative = path.relative(mirrorRoot, local);
    assert(relative !== "" && !relative.startsWith(".."), `remote plugin mirror escaped: ${local}`);
    return path.posix.join(listing.root, ...relative.split(path.sep));
  };
  return {
    mirrorRoot,
    remoteRoot: listing.root,
    plugins: plugins.map((plugin) => toRemotePlugin(plugin, plugin.containerPath, (p) => p)),
    toRemote,
  };
}

/** Mirror dirs alive in this process: removed on clear and at exit. */
const liveMirrors = new Set<string>();
let exitHookInstalled = false;
const MIRROR_PREFIX = "xum-remote-plugins-";

/** Best effort: never throws (a trust change must not fail on cleanup). */
function removeMirror(mirrorRoot: string): void {
  liveMirrors.delete(mirrorRoot);
  try {
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
  } catch (error) {
    log.debug(`Remote project plugins: mirror cleanup failed: ${getErrorMessage(error)}`);
  }
}

/** A mirror's name holds its owner's pid, so a second Xum process never removes a live one. */
const OWNER_PID = /^xum-remote-plugins-(\d+)-/;

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Best effort: mirrors that a crashed process left behind (owner pid gone, older than 1 h).
 * Never throws.
 */
async function sweepStaleMirrors(): Promise<void> {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of await fsPromises.readdir(os.tmpdir())) {
      const owner = OWNER_PID.exec(name);
      if (owner === null || isLivePid(Number(owner[1]))) continue;
      const dir = path.join(os.tmpdir(), name);
      const stat = await fsPromises.lstat(dir).catch(() => null);
      if (stat?.isDirectory() === true && stat.mtimeMs < cutoff) {
        await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    log.debug(`Remote project plugins: stale mirror sweep failed: ${getErrorMessage(error)}`);
  }
}

async function createMirrorDir(): Promise<string> {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Exit cleanup is best effort; a later start sweeps leftovers.
    process.once("exit", () => {
      for (const mirrorRoot of [...liveMirrors]) removeMirror(mirrorRoot);
    });
    await sweepStaleMirrors();
  }
  // mkdtemp creates the directory with mode 0700.
  const mirrorRoot = await fsPromises.realpath(
    await fsPromises.mkdtemp(path.join(os.tmpdir(), `${MIRROR_PREFIX}${process.pid}-`))
  );
  liveMirrors.add(mirrorRoot);
  return mirrorRoot;
}

/** One listing exec and a fresh mirror; null (and no mirror) on any failure. */
async function createSnapshot(args: RemotePluginArgs): Promise<RemoteProjectPluginSnapshot | null> {
  assert(args.checkoutRoot.length > 0, "remote project plugins: checkoutRoot required");
  if (args.containers.length === 0) return null;
  let mirrorRoot: string | undefined;
  try {
    const listing = await readRemoteListing(args);
    if (listing === null) return null;
    mirrorRoot = await createMirrorDir();
    return await discoverInMirror(args, listing, mirrorRoot);
  } catch (error) {
    log.debug(`Remote project plugins: discovery failed: ${getErrorMessage(error)}`);
    if (mirrorRoot !== undefined) removeMirror(mirrorRoot);
    return null;
  }
}

/**
 * The project Agent Plugins (skills and agents only) of a remote checkout, with remote paths
 * and no cache. Returns [] on any failure.
 */
export async function discoverRemoteProjectAgentPlugins(
  args: RemotePluginArgs
): Promise<RemoteProjectAgentPlugin[]> {
  const snapshot = await createSnapshot(args);
  if (snapshot === null) return [];
  try {
    return snapshot.plugins.map((plugin) =>
      toRemotePlugin(plugin, snapshot.toRemote(plugin.containerPath), snapshot.toRemote)
    );
  } finally {
    removeMirror(snapshot.mirrorRoot);
  }
}

/** A failed snapshot is not retried for this long, so a down host costs no exec per turn. */
const FAILURE_RETRY_MS = 60_000;
interface SnapshotEntry {
  promise: Promise<RemoteProjectPluginSnapshot | null>;
  failedAt?: number;
  /** Set once the read lands, so a clear can remove the mirror without waiting. */
  snapshot?: RemoteProjectPluginSnapshot;
  /** A trust change dropped this entry while its read was in flight. */
  cleared?: boolean;
}
const snapshots = new Map<string, SnapshotEntry>();

/**
 * The cached snapshot of a TRUSTED remote checkout (the caller checks trust). One listing exec
 * per cache key until clearRemoteProjectPluginSnapshots (a trust change) or the process ends;
 * concurrent callers share one in-flight read. The key is the runtime's agent host (from its
 * config: an SSH host, a Docker container), the checkout root and the containers, so two
 * workspaces never share a snapshot. A runtime without a host key gets no remote plugins.
 */
export function getRemoteProjectPluginSnapshot(
  runtime: Runtime,
  checkoutRoot: string,
  containers: string[]
): Promise<RemoteProjectPluginSnapshot | null> {
  const hostKey = runtime instanceof RemoteRuntime ? runtime.getAgentHostKey() : undefined;
  if (hostKey === undefined) return Promise.resolve(null);
  const key = JSON.stringify([hostKey, checkoutRoot, containers, "trusted"]);
  const cached = snapshots.get(key);
  if (cached !== undefined && (cached.failedAt ?? Infinity) > Date.now() - FAILURE_RETRY_MS) {
    return cached.promise;
  }
  const entry: SnapshotEntry = {
    promise: createSnapshot({ runtime, checkoutRoot, containers }).then((snapshot) => {
      if (snapshot === null) entry.failedAt = Date.now();
      else if (entry.cleared === true) {
        // Read under the old trust: drop it.
        removeMirror(snapshot.mirrorRoot);
        return null;
      } else entry.snapshot = snapshot;
      return snapshot;
    }),
  };
  snapshots.set(key, entry);
  return entry.promise;
}

/**
 * Drops every snapshot and its mirror (project trust changed). Synchronous and never throws, so
 * it cannot delay or block the trust change; an in-flight read removes its own mirror and
 * resolves to null.
 */
export function clearRemoteProjectPluginSnapshots(): void {
  for (const entry of snapshots.values()) {
    entry.cleared = true;
    if (entry.snapshot !== undefined) removeMirror(entry.snapshot.mirrorRoot);
  }
  snapshots.clear();
}
