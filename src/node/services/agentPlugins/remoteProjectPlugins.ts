/**
 * #6426: the Agent Plugins (skills and agents only) of a project checkout on a remote runtime
 * (SSH, Docker), read without host files.
 *
 * One remote command lists each plugin container: directory and symlink lines, plus one tar of
 * every regular file of at most MAX_FILE_SIZE. Each tar header carries the size of its own bytes,
 * so a file that changes during the listing cannot shift another file's content. The host holds
 * the listing in memory (createMemoryPluginFs) and runs the unchanged discovery rules on it.
 * Nothing in it ever runs. Plugin MCP servers, hooks, workflows and slash commands run code, so
 * they are not part of the result (#7218). Any failure gives no remote plugins at all, never a
 * partial set: remote plugins are best-effort and must never block a turn. The caller gates on
 * project trust.
 */
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { log } from "@/node/services/log";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { discoverAgentPluginsIn, type AgentPluginInfo, type PluginFs } from "./discovery";
import { createMemoryPluginFs } from "./memoryPluginFs";
import {
  MAX_LISTING_OUTPUT_BYTES,
  MAX_REMOTE_PLUGIN_ENTRIES,
  parseRemotePluginListing,
} from "./remotePluginListing";

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
 * tab-separated: `K real lexical` per container (lexical under the real checkout root), then for
 * each walked tree `D  path`, `L target path` (target: the link's `readlink -f`, empty when that
 * fails) and `F  path` lines. Then `ROOT  <real root>`, `T`, the base64 tar of every F file, `.`
 * and `END`. The entry count runs first and stops after MAX_REMOTE_PLUGIN_ENTRIES + 1 entries,
 * so a huge tree costs no full walk. A name with a newline exits the script (fail closed).
 * `~` and `~/x` expand like SSHRuntime.resolvePath; a relative root is refused.
 */
export function buildRemotePluginListingScript(checkoutRoot: string, containers: string[]): string {
  const limit = MAX_REMOTE_PLUGIN_ENTRIES + 1;
  const tree = `find -P "$1" -mindepth 1`;
  return [
    `set -- ${[checkoutRoot, ...containers].map(shellQuote).join(" ")}`,
    `command -v tar >/dev/null 2>&1 || exit 6`,
    `case "$1" in "~") r=$HOME ;; "~/"*) r="$HOME/\${1#"~/"}" ;; /*) r=$1 ;; *) exit 3 ;; esac`,
    `rootarg=$1`,
    // `readlink -f` is not POSIX: fall back to realpath. A host with neither loads no plugins.
    `rp() { readlink -f "$1" 2>/dev/null || realpath "$1" 2>/dev/null; }`,
    `root=$(rp "$r") || exit 3`,
    `shift`,
    `tab=$(printf '\\t')`,
    `nl='`,
    `'`,
    // One `readlink -f` (else one `realpath`) for all links of a walk: one fork per link took ~1 ms,
    // seconds near the entry cap (#7249). GNU prints no line for a link that fails and BusyBox
    // readlink takes one file, so the batch counts only when it exits 0 with one line per link.
    // Otherwise each link runs rp alone, with an empty target when it fails. The subshell keeps
    // set -f and IFS from the rest of the script.
    `links() (`,
    `  set -f; IFS=$nl; lk=$1`,
    `  ts=$(readlink -f $lk 2>/dev/null) || ts=$(realpath $lk 2>/dev/null) || ts=`,
    `  set -- $lk; n=$#; set -- $ts; [ $# -eq "$n" ] || set --`,
    `  for e in $lk; do`,
    `    if [ $# -gt 0 ]; then t=$1; shift; else t=$(rp "$e") || t=; fi`,
    `    printf 'L\\t%s\\t%s\\n' "$t" "$e"`,
    `  done`,
    `)`,
    `count=0`,
    `files=`,
    `walked=$nl`,
    `walk() {`,
    // Two containers (or a plugin link) that resolve to one tree walk it once.
    `  case "$walked" in *"$nl$1$nl"*) return ;; esac`,
    `  walked="$walked$1$nl"`,
    `  count=$((count + $(${tree} | head -n ${limit} | wc -l)))`,
    `  [ "$count" -lt ${limit} ] || exit 5`,
    `  [ -z "$(${tree} -name "*$nl*" | head -n 1)" ] || exit 4`,
    // Each list is captured first, so a find error (an unreadable or vanished directory) exits
    // the script instead of leaving a partial tree: a pipeline's status is its last command's.
    `  d=$(${tree} -type d) || exit 7`,
    `  l=$(${tree} -type l) || exit 7`,
    `  f=$(${tree} -type f -size -${MAX_FILE_SIZE + 1}c) || exit 7`,
    `  [ -z "$d" ] || printf '%s\\n' "$d" | sed "s|^|D\${tab}\${tab}|"`,
    `  [ -z "$l" ] || links "$l"`,
    `  [ -z "$f" ] || { printf '%s\\n' "$f" | sed "s|^|F\${tab}\${tab}|"; files="$files$f$nl"; }`,
    `}`,
    `for c in "$@"; do`,
    `  case "$c" in "$rootarg"/*) lex="$root/\${c#"$rootarg"/}" ;; *) continue ;; esac`,
    `  real=$(rp "$lex") || continue`,
    `  [ -d "$real" ] || continue`,
    // A container that resolves outside the checkout is never walked, so none of its bytes leave.
    `  case "$real" in "$root"/*) ;; *) continue ;; esac`,
    `  printf 'K\\t%s\\t%s\\n' "$real" "$lex"`,
    `  walk "$real"`,
    // A plugin folder may be a symlink to a directory elsewhere in the checkout. One inside this
    // container was walked with it already.
    `  for e in "$real"/* "$real"/.[!.]*; do [ -L "$e" ] || continue; t=$(rp "$e") || continue`,
    `    case "$t" in "$real"/*) continue ;; esac`,
    `    case "$t" in "$root"/*) [ -d "$t" ] && { count=$((count + 1)); printf 'D\\t\\t%s\\n' "$t"; walk "$t"; } ;; esac`,
    `  done`,
    `done`,
    `printf 'ROOT\\t\\t%s\\nT\\n' "$root"`,
    // A pipeline's status is base64's, so tar's status goes out on fd 3 and the archive on fd 4
    // (stdout). Any tar failure, e.g. GNU tar's exit 1 for "file changed as we read it" with a
    // whole archive, exits 8 before the END frame, so the host refuses the listing.
    // COPYFILE_DISABLE: macOS bsdtar would add `._name` metadata members, which the host refuses.
    `if [ -n "$files" ]; then`,
    `  { s=$( { { printf '%s' "$files" | COPYFILE_DISABLE=1 tar -cf - -T -; echo $? >&3; } | base64 >&4; } 3>&1 ); } 4>&1`,
    `  [ "$s" = 0 ] || exit 8`,
    `fi`,
    `printf '.\\nEND\\n'`,
  ].join("\n");
}

/** A remote checkout's project plugins, with remote paths, and the PluginFs to read their files. */
export interface RemoteProjectPluginSnapshot {
  fs: PluginFs;
  /** The real checkout root on the remote host. */
  root: string;
  plugins: RemoteProjectAgentPlugin[];
  /** Decoded bytes held in memory, for the cache's byte cap. */
  bytes: number;
}

interface RemotePluginArgs {
  runtime: Runtime;
  checkoutRoot: string;
  /** Remote container paths under checkoutRoot, e.g. `<checkoutRoot>/.xum/plugins`. */
  containers: string[];
}

function pickSkillsAndAgents(plugin: AgentPluginInfo): RemoteProjectAgentPlugin {
  return {
    name: plugin.name,
    scope: plugin.scope,
    rootPath: plugin.rootPath,
    containerPath: plugin.containerPath,
    dirName: plugin.dirName,
    manifest: plugin.manifest,
    ...(plugin.codexFallback ? { codexFallback: true as const } : {}),
    ...(plugin.claudeFallback ? { claudeFallback: true as const } : {}),
    ...(plugin.skillsOnly ? { skillsOnly: true as const } : {}),
    ...(plugin.skillsDirs !== undefined ? { skillsDirs: plugin.skillsDirs } : {}),
    ...(plugin.agentsDir !== undefined ? { agentsDir: plugin.agentsDir } : {}),
  };
}

/** One listing exec, parsed and discovered in memory; null on any failure. */
export async function createRemoteProjectPluginSnapshot(
  args: RemotePluginArgs
): Promise<RemoteProjectPluginSnapshot | null> {
  assert(args.checkoutRoot.length > 0, "remote project plugins: checkoutRoot required");
  if (args.containers.length === 0) return null;
  try {
    const result = await execBuffered(
      args.runtime,
      buildRemotePluginListingScript(args.checkoutRoot, args.containers),
      { cwd: "/", timeout: LISTING_TIMEOUT_SECONDS, maxOutputBytes: MAX_LISTING_OUTPUT_BYTES }
    );
    const listing = result.exitCode === 0 ? parseRemotePluginListing(result.stdout) : null;
    if (listing === null) {
      // Exit 6: no tar on the remote host.
      log.debug("Remote project plugins: no usable listing", { exitCode: result.exitCode });
      return null;
    }
    const fs = createMemoryPluginFs(listing.nodes, listing.root, new Date());
    // The script reports each container under the REAL checkout root.
    const containers = args.containers.flatMap((remote) =>
      remote.startsWith(args.checkoutRoot + "/")
        ? [
            {
              path: listing.root + remote.slice(args.checkoutRoot.length),
              scope: "project" as const,
            },
          ]
        : []
    );
    const { plugins } = await discoverAgentPluginsIn(fs, containers);
    return {
      fs,
      root: listing.root,
      plugins: plugins.map(pickSkillsAndAgents),
      bytes: listing.bytes,
    };
  } catch (error) {
    log.debug(`Remote project plugins: discovery failed: ${getErrorMessage(error)}`);
    return null;
  }
}

/** Cache bounds: the least recently used snapshot goes first. */
export const MAX_CACHED_SNAPSHOTS = 16;
export const MAX_CACHED_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** A failed snapshot is not retried for this long, so a down host costs no exec per turn. */
const FAILURE_RETRY_MS = 60_000;
/**
 * Distinct cold reads that run at once. Each one can buffer MAX_LISTING_OUTPUT_BYTES, and the
 * cache caps count settled entries only, so this bounds the memory of a burst of new keys.
 * Callers of a pending key still share its read.
 */
export const MAX_COLD_READS = 4;
/** Per agent host, inside MAX_COLD_READS: a slow or unreachable host never takes every slot. */
export const MAX_COLD_READS_PER_HOST = 2;
let coldReads = 0;
const coldReadsByHost = new Map<string, number>();
const waitingColdReads: Array<{ host: string; start: () => void }> = [];

function hasColdReadSlot(host: string): boolean {
  return coldReads < MAX_COLD_READS && (coldReadsByHost.get(host) ?? 0) < MAX_COLD_READS_PER_HOST;
}

function takeColdReadSlot(host: string): void {
  coldReads++;
  coldReadsByHost.set(host, (coldReadsByHost.get(host) ?? 0) + 1);
}

/** Frees one slot and starts the oldest waiter that now fits (at most one can). */
function releaseColdReadSlot(host: string): void {
  coldReads--;
  const left = (coldReadsByHost.get(host) ?? 1) - 1;
  if (left === 0) coldReadsByHost.delete(host);
  else coldReadsByHost.set(host, left);
  const next = waitingColdReads.findIndex((waiter) => hasColdReadSlot(waiter.host));
  if (next === -1) return;
  const [waiter] = waitingColdReads.splice(next, 1);
  takeColdReadSlot(waiter.host);
  waiter.start();
}

/** Runs `read` once a cold-read slot for `host` is free. */
async function withColdReadSlot<T>(host: string, read: () => Promise<T>): Promise<T> {
  if (hasColdReadSlot(host)) takeColdReadSlot(host);
  else await new Promise<void>((start) => waitingColdReads.push({ host, start }));
  try {
    return await read();
  } finally {
    releaseColdReadSlot(host);
  }
}

interface SnapshotEntry {
  promise: Promise<RemoteProjectPluginSnapshot | null>;
  /** Set once the read lands. */
  settled?: { snapshot: RemoteProjectPluginSnapshot | null; at: number };
}
/** Map order is the LRU order: a hit moves its entry to the end. */
const snapshots = new Map<string, SnapshotEntry>();
/** Bumped by every clear: a read that a clear overtook is never published. */
let trustGeneration = 0;

function cachedBytes(): number {
  let total = 0;
  for (const entry of snapshots.values()) total += entry.settled?.snapshot?.bytes ?? 0;
  return total;
}

function settledCount(): number {
  let count = 0;
  for (const entry of snapshots.values()) count += entry.settled === undefined ? 0 : 1;
  return count;
}

/** Evicts settled snapshots, least recently used first, until both caps hold. */
function evictOverCap(): void {
  for (const [key, entry] of snapshots) {
    if (settledCount() <= MAX_CACHED_SNAPSHOTS && cachedBytes() <= MAX_CACHED_SNAPSHOT_BYTES) {
      return;
    }
    // An in-flight read stays: dropping it would let a second caller start the same read.
    if (entry.settled !== undefined) snapshots.delete(key);
  }
}

/** A failure older than FAILURE_RETRY_MS is read again. */
function isExpiredFailure(entry: SnapshotEntry): boolean {
  return entry.settled?.snapshot === null && entry.settled.at <= Date.now() - FAILURE_RETRY_MS;
}

/** The usable cached entry of `key`, now the most recently used one. */
function freshEntry(key: string): SnapshotEntry | undefined {
  const cached = snapshots.get(key);
  if (cached === undefined) return undefined;
  // Re-inserted at the tail; an expired failure is dropped, so its retry lands at the tail too.
  snapshots.delete(key);
  if (isExpiredFailure(cached)) return undefined;
  snapshots.set(key, cached);
  return cached;
}

/** Starts a read for `key`; it is published only if no trust change overtook it. */
function startRead(key: string, host: string, args: RemotePluginArgs): SnapshotEntry {
  const generation = trustGeneration;
  const read = withColdReadSlot(host, () =>
    // A trust change while this read waited for a slot: it never runs a command.
    generation === trustGeneration ? createRemoteProjectPluginSnapshot(args) : Promise.resolve(null)
  );
  const entry: SnapshotEntry = {
    promise: read.then(
      (snapshot) => {
        // Read under an old trust: drop it.
        if (generation !== trustGeneration) return null;
        entry.settled = { snapshot, at: Date.now() };
        // Evicted or replaced meanwhile: the caller still gets it, the cache does not.
        if (snapshots.get(key) === entry) evictOverCap();
        return snapshot;
      },
      (error: unknown) => {
        // Never throws to the caller. The entry goes, so the next call reads again.
        log.debug(`Remote project plugins: read failed: ${getErrorMessage(error)}`);
        if (snapshots.get(key) === entry) snapshots.delete(key);
        return null;
      }
    ),
  };
  snapshots.set(key, entry);
  evictOverCap();
  return entry;
}

/**
 * The cached snapshot of a TRUSTED remote checkout (the caller checks trust). One listing exec
 * per key until clearRemoteProjectPluginSnapshots (a trust change), eviction or the end of the
 * process. Concurrent callers share one in-flight read. The key is the runtime's agent host (an
 * SSH connection, a Docker container), the checkout root and the containers, so two workspaces
 * never share a snapshot. A runtime without a host key gets no remote plugins.
 */
export function getRemoteProjectPluginSnapshot(
  runtime: Runtime,
  checkoutRoot: string,
  containers: string[]
): Promise<RemoteProjectPluginSnapshot | null> {
  let hostKey: string | undefined;
  try {
    hostKey = runtime instanceof RemoteRuntime ? runtime.getAgentHostKey() : undefined;
  } catch (error) {
    // E.g. SSH's os.userInfo() for a uid without a passwd entry.
    log.debug(`Remote project plugins: no host key: ${getErrorMessage(error)}`);
    return Promise.resolve(null);
  }
  if (hostKey === undefined) return Promise.resolve(null);
  const key = JSON.stringify([hostKey, checkoutRoot, containers]);
  const entry = freshEntry(key) ?? startRead(key, hostKey, { runtime, checkoutRoot, containers });
  return entry.promise;
}

/**
 * Drops every snapshot (project trust changed). Synchronous and never throws, so it cannot
 * delay or block the trust change. A snapshot is immutable memory, so a reader that holds one
 * finishes with it.
 */
export function clearRemoteProjectPluginSnapshots(): void {
  trustGeneration++;
  snapshots.clear();
}
