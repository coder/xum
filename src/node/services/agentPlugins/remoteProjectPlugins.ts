/**
 * #6426: discover the Agent Plugins of a project checkout that lives on a remote runtime (SSH,
 * Docker), for their skills and agents only.
 *
 * discoverAgentPlugins reads the host filesystem. To apply its exact manifest, containment and
 * component rules to a remote checkout, one remote command lists each plugin container (entry
 * types, sizes, symlink targets, and the bytes of plugin.json and SKILL.md files under their
 * caps). The host rebuilds that listing in a private temp directory, runs the unchanged
 * discoverAgentPlugins on it, and maps the result back to remote paths:
 * - Regular files become sparse files of their remote size, so every size cap still applies.
 * - A symlink is rebuilt only when its remote realpath stays inside the checkout root. Any other
 *   symlink (outside the root, dangling) is left out, so discovery sees nothing there.
 * Plugin MCP servers, hooks, workflows and slash commands run code, so they are dropped from the
 * result (#7218). Any failure returns no plugins: remote plugins are best-effort and must never
 * block a turn. The caller gates on project trust.
 */
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { MAX_PLUGIN_MANIFEST_BYTES, discoverAgentPlugins, type AgentPluginInfo } from "./discovery";

/** Deep enough for `<plugin>/skills/<name>/SKILL.md` and nested `contributes` paths. */
const MAX_LISTING_DEPTH = 6;
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
 * tab-separated: `K 0 real lexical` per container (lexical under the real checkout root), then
 * `D|F|f|L size target path` per entry (`F` is followed by one base64 content line), then
 * `ROOT 0 <real checkout root>` and `END`. Names with a tab or a newline produce lines the host
 * rejects, which fails the whole listing closed. `head` bounds the walk of each tree; the host
 * refuses a listing over MAX_REMOTE_PLUGIN_ENTRIES.
 */
export function buildRemotePluginListingScript(checkoutRoot: string, containers: string[]): string {
  const contentCase = (name: string, cap: number) =>
    `${name}) if [ "$s" -le ${cap} ]; then printf 'F\\t%s\\t\\t%s\\n' "$s" "$p"; base64 < "$p" | tr -d '\\n'; printf '\\n'; return; fi ;;`;
  const limit = MAX_REMOTE_PLUGIN_ENTRIES + 1;
  return [
    `set -- ${[checkoutRoot, ...containers].map(shellQuote).join(" ")}`,
    `rootarg=$1`,
    `root=$(readlink -f "$1") || exit 3`,
    `shift`,
    `emit() {`,
    `  p=$1`,
    `  if [ -L "$p" ]; then t=$(readlink -f "$p" 2>/dev/null) || t=; printf 'L\\t0\\t%s\\t%s\\n' "$t" "$p"`,
    `  elif [ -d "$p" ]; then printf 'D\\t0\\t\\t%s\\n' "$p"`,
    `  elif [ -f "$p" ]; then s=$(wc -c < "$p" | tr -d ' ')`,
    `    case "\${p##*/}" in ${contentCase("plugin.json", MAX_PLUGIN_MANIFEST_BYTES)} ${contentCase("SKILL.md", MAX_FILE_SIZE)} esac`,
    `    printf 'f\\t%s\\t\\t%s\\n' "$s" "$p"`,
    `  fi`,
    `}`,
    `walk() { find -P "$1" -mindepth 1 -maxdepth "$2" | head -n ${limit} | while IFS= read -r e; do emit "$e"; done; }`,
    `for c in "$@"; do`,
    `  case "$c" in "$rootarg"/*) lex="$root/\${c#"$rootarg"/}" ;; *) continue ;; esac`,
    `  real=$(readlink -f "$c" 2>/dev/null) || continue`,
    `  [ -d "$real" ] || continue`,
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
  kind: "K" | "D" | "F" | "f" | "L";
  size: number;
  target: string;
  path: string;
  content?: string;
}

const ENTRY_KINDS = new Set<string>(["K", "D", "F", "f", "L"]);

interface Listing {
  root: string;
  entries: ListingEntry[];
}

/** One entry line's fields as an entry; null when they are malformed. */
function parseEntryFields(fields: string[]): ListingEntry | null {
  const [kind, size, target, entryPath] = fields;
  if (!ENTRY_KINDS.has(kind) || !path.posix.isAbsolute(entryPath) || !/^\d+$/.test(size)) {
    return null;
  }
  return { kind: kind as ListingEntry["kind"], size: Number(size), target, path: entryPath };
}

/** The listing's lines without the final END line; null when the output was cut off. */
function listingLines(stdout: string): string[] | null {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.pop() === "END" ? lines : null;
}

/** Line `i` (with the base64 content line after an F line); null when malformed. */
function parseLineAt(
  lines: string[],
  i: number
): { entry?: ListingEntry; root?: string; next: number } | null {
  const fields = lines[i].split("\t");
  if (fields.length !== 4) return null;
  if (fields[0] === "ROOT") return { root: fields[2], next: i + 1 };
  const entry = parseEntryFields(fields);
  if (entry === null) return null;
  if (entry.kind !== "F") return { entry, next: i + 1 };
  // A missing content line means the output was cut.
  if (i + 1 >= lines.length) return null;
  return { entry: { ...entry, content: lines[i + 1] }, next: i + 2 };
}

/** Parses the listing; null when it is cut off, too big or malformed (fail closed). */
export function parseRemotePluginListing(stdout: string): Listing | null {
  const lines = listingLines(stdout);
  if (lines === null) return null;
  const entries: ListingEntry[] = [];
  let root: string | undefined;
  for (let i = 0; i < lines.length; ) {
    const parsed = parseLineAt(lines, i);
    if (parsed === null) return null;
    if (parsed.entry !== undefined) entries.push(parsed.entry);
    else root = parsed.root;
    i = parsed.next;
  }
  if (root === undefined || !path.posix.isAbsolute(root)) return null;
  return entries.length <= MAX_REMOTE_PLUGIN_ENTRIES ? { root, entries } : null;
}

/** `remote` relative to `root`, or null when it is not strictly inside it. */
function relativeInside(root: string, remote: string): string | null {
  if (!remote.startsWith(root + "/")) return null;
  const relative = remote.slice(root.length + 1);
  // A `..` segment would let a crafted line escape the mirror.
  return relative.split("/").includes("..") ? null : relative;
}

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
    await fsPromises.writeFile(local, Buffer.from(entry.content ?? "", "base64"));
  } else if (entry.kind === "f") {
    // Sparse: no bytes are copied, yet stat reports the remote size for the caps.
    await fsPromises.writeFile(local, "");
    await fsPromises.truncate(local, entry.size);
  }
}

/** Rebuilds the listing under `mirrorRoot`; returns each listed container's mirror path. */
async function buildMirror(mirrorRoot: string, listing: Listing): Promise<Map<string, string>> {
  const toMirror: ToMirror = (remote) => {
    const relative = relativeInside(listing.root, remote);
    return relative === null ? null : path.join(mirrorRoot, ...relative.split("/"));
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

/** Runs local discovery on the mirror and maps its plugins back to remote paths. */
async function discoverInMirror(
  args: RemotePluginArgs,
  listing: Listing,
  mirrorRoot: string
): Promise<RemoteProjectAgentPlugin[]> {
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
  return plugins.map((plugin) => {
    const container = localContainers.find(({ local }) => local === plugin.containerPath);
    assert(container !== undefined, "remote plugin from an unknown container");
    return toRemotePlugin(plugin, container.remote, toRemote);
  });
}

/**
 * The project Agent Plugins (skills and agents only) of a remote checkout. Every path in the
 * result is a remote path. Returns [] on any failure.
 */
export async function discoverRemoteProjectAgentPlugins(
  args: RemotePluginArgs
): Promise<RemoteProjectAgentPlugin[]> {
  assert(args.checkoutRoot.length > 0, "discoverRemoteProjectAgentPlugins: checkoutRoot required");
  if (args.containers.length === 0) return [];
  let mirrorRoot: string | undefined;
  try {
    const listing = await readRemoteListing(args);
    if (listing === null) return [];
    mirrorRoot = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "xum-remote-plugins-"))
    );
    return await discoverInMirror(args, listing, mirrorRoot);
  } catch (error) {
    log.debug(`Remote project plugins: discovery failed: ${getErrorMessage(error)}`);
    return [];
  } finally {
    if (mirrorRoot !== undefined) {
      await fsPromises.rm(mirrorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
