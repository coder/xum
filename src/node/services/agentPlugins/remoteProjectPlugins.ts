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
import { MAX_REMOTE_PLUGIN_ENTRIES, parseRemotePluginListing } from "./remotePluginListing";

/**
 * Encoded listing output (base64 lines plus the entry lines). It holds about 12 MiB of tar, and
 * tar adds 512 to 1023 bytes per file (header and padding).
 */
export const MAX_LISTING_OUTPUT_BYTES = 16 * 1024 * 1024;
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
    `root=$(readlink -f "$r") || exit 3`,
    `shift`,
    `tab=$(printf '\\t')`,
    `nl='`,
    `'`,
    `count=0`,
    `files=`,
    `walk() {`,
    `  count=$((count + $(${tree} | head -n ${limit} | wc -l)))`,
    `  [ "$count" -lt ${limit} ] || exit 5`,
    `  [ -z "$(${tree} -name "*$nl*" | head -n 1)" ] || exit 4`,
    `  ${tree} -type d | sed "s|^|D\${tab}\${tab}|"`,
    `  ${tree} -type l | while IFS= read -r e; do t=$(readlink -f "$e" 2>/dev/null) || t=; printf 'L\\t%s\\t%s\\n' "$t" "$e"; done`,
    `  f=$(${tree} -type f -size -${MAX_FILE_SIZE + 1}c)`,
    `  [ -z "$f" ] || { printf '%s\\n' "$f" | sed "s|^|F\${tab}\${tab}|"; files="$files$f$nl"; }`,
    `}`,
    `for c in "$@"; do`,
    `  case "$c" in "$rootarg"/*) lex="$root/\${c#"$rootarg"/}" ;; *) continue ;; esac`,
    `  real=$(readlink -f "$lex" 2>/dev/null) || continue`,
    `  [ -d "$real" ] || continue`,
    // A container that resolves outside the checkout is never walked, so none of its bytes leave.
    `  case "$real" in "$root"/*) ;; *) continue ;; esac`,
    `  printf 'K\\t%s\\t%s\\n' "$real" "$lex"`,
    `  walk "$real"`,
    // A plugin folder may be a symlink to a directory elsewhere in the checkout.
    `  for e in "$real"/* "$real"/.[!.]*; do [ -L "$e" ] || continue; t=$(readlink -f "$e" 2>/dev/null) || continue`,
    `    case "$t" in "$root"/*) [ -d "$t" ] && { count=$((count + 1)); printf 'D\\t\\t%s\\n' "$t"; walk "$t"; } ;; esac`,
    `  done`,
    `done`,
    `printf 'ROOT\\t\\t%s\\nT\\n' "$root"`,
    // tar exits non-zero on a vanished file; the host then sees a member set that differs.
    `[ -z "$files" ] || printf '%s' "$files" | tar -cf - -T - | base64`,
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

function evictOverCap(): void {
  for (const [key] of snapshots) {
    if (snapshots.size <= MAX_CACHED_SNAPSHOTS && cachedBytes() <= MAX_CACHED_SNAPSHOT_BYTES)
      return;
    snapshots.delete(key);
  }
}

/** A failure older than FAILURE_RETRY_MS is read again. */
function isExpiredFailure(entry: SnapshotEntry): boolean {
  return entry.settled?.snapshot === null && entry.settled.at <= Date.now() - FAILURE_RETRY_MS;
}

/** The usable cached entry of `key`, now the most recently used one. */
function freshEntry(key: string): SnapshotEntry | undefined {
  const cached = snapshots.get(key);
  if (cached === undefined || isExpiredFailure(cached)) return undefined;
  snapshots.delete(key);
  snapshots.set(key, cached);
  return cached;
}

/** Starts a read for `key`; it is published only if no trust change overtook it. */
function startRead(key: string, args: RemotePluginArgs): SnapshotEntry {
  const generation = trustGeneration;
  const entry: SnapshotEntry = {
    promise: createRemoteProjectPluginSnapshot(args).then((snapshot) => {
      // Read under an old trust: drop it.
      if (generation !== trustGeneration) return null;
      entry.settled = { snapshot, at: Date.now() };
      // Evicted or replaced meanwhile: the caller still gets it, the cache does not.
      if (snapshots.get(key) === entry) evictOverCap();
      return snapshot;
    }),
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
  const hostKey = runtime instanceof RemoteRuntime ? runtime.getAgentHostKey() : undefined;
  if (hostKey === undefined) return Promise.resolve(null);
  const key = JSON.stringify([hostKey, checkoutRoot, containers]);
  const entry = freshEntry(key) ?? startRead(key, { runtime, checkoutRoot, containers });
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
