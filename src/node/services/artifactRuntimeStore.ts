import { assert } from "@/common/utils/assert";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";
import type { Runtime } from "@/node/runtime/Runtime";
import { shescape, streamToStringCapped } from "@/node/runtime/streamUtils";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  ARTIFACTS_DIR_NAME,
  MAX_ARTIFACT_LIST_DEPTH,
  MAX_ARTIFACT_LIST_ENTRIES,
  MAX_ARTIFACT_LIST_VISITS,
  parseArtifactRelativePath,
  sortArtifactEntries,
  toArtifactReadOutcome,
  type ArtifactBytesOutcome,
  type ArtifactReadOptions,
  type ArtifactReadOutcome,
} from "./artifactStore";

/**
 * Artifacts dir access through a Runtime (SSH and Docker scratch dirs live on the runtime, not
 * this host). Same rules and wire results as artifactStore's host path: the dir is
 * agent-writable and untrusted, hidden entries and symlinks are skipped, reads are confined to
 * the dir and capped.
 *
 * Each operation is ONE exec of a POSIX sh script, so it works with busybox, GNU and BSD tools
 * (no `find -printf`). Output is NUL-delimited because file names may contain spaces and
 * newlines but never NUL; a magic header marks where the script's output starts, because login
 * shells on SSH hosts can print banners first.
 */

const LIST_MAGIC = "XUMARTIFACTS1";
const READ_MAGIC = "XUMREAD1";
const WRITE_MAGIC = "XUMWRITE1";
const EXEC_TIMEOUT_SECONDS = 30;
/**
 * MAX_ARTIFACT_LIST_VISITS records of max-depth paths stay below this; a cut-off listing fails
 * to parse.
 */
const MAX_LIST_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Room for the read header and any shell banner on top of the file bytes. */
const READ_OUTPUT_SLACK_BYTES = 64 * 1024;

/**
 * Picks a stat flavor once. GNU coreutils and busybox take `-c`, BSD/macOS takes `-f`; without
 * either, size comes from `wc -c` and the mtime is unknown (0).
 */
const STAT_PRELUDE = String.raw`if stat -c %s / >/dev/null 2>&1; then xum_stat=gnu
elif stat -f %z / >/dev/null 2>&1; then xum_stat=bsd
else xum_stat=none; fi
xum_meta() {
  case $xum_stat in
    gnu) stat -c '%s %Y' -- "$1" 2>/dev/null ;;
    bsd) stat -f '%z %m' -- "$1" 2>/dev/null ;;
    *) xum_size=$(wc -c < "$1" 2>/dev/null) || return 1; echo "$xum_size" 0 ;;
  esac
}`;

/**
 * Lists `$XUM_ARTIFACTS_DIR`. Records: header `MAGIC dir`, then `F relpath "size mtime"` per
 * regular file, then `END truncated`. The `*` glob skips dotfiles, matching the host listing's
 * hidden-entry rule; symlinks are skipped before any test that would follow them. POSIX sh has
 * no `local`, so nothing may read a loop variable after the recursive call returns.
 *
 * The walk is bounded by entries visited (folders included), not by files emitted: glob order
 * is alphabetical, so stopping at MAX_ARTIFACT_LIST_ENTRIES files would drop the newest file
 * whenever its name sorts last. The parser keeps the newest MAX_ARTIFACT_LIST_ENTRIES.
 */
export const ARTIFACT_LIST_SCRIPT =
  String.raw`d=$XUM_ARTIFACTS_DIR
printf '${LIST_MAGIC}\0%s\0' "$d"
if [ -L "$d" ] || [ ! -d "$d" ]; then printf 'END\0%s\0' 0; exit 0; fi
${STAT_PRELUDE}
xum_visits=0
xum_trunc=0
xum_walk() {
  for xum_f in "$1"/*; do
    if [ "$xum_visits" -ge ${MAX_ARTIFACT_LIST_VISITS} ]; then xum_trunc=1; return 0; fi
    xum_visits=$((xum_visits + 1))
    if [ -L "$xum_f" ] || [ ! -e "$xum_f" ]; then continue; fi
    xum_name=$` +
  "{xum_f##*/}" +
  String.raw`
    if [ -z "$2" ]; then xum_rel=$xum_name; else xum_rel=$2/$xum_name; fi
    if [ -d "$xum_f" ]; then
      if [ "$3" -ge ${MAX_ARTIFACT_LIST_DEPTH} ]; then xum_trunc=1
      else xum_walk "$xum_f" "$xum_rel" $(($3 + 1)); fi
    elif [ -f "$xum_f" ]; then
      # stat writes straight to stdout (one fork per file, no subshell); a file that
      # vanished prints no metadata and the parser drops the record.
      printf 'F\0%s\0' "$xum_rel"
      xum_meta "$xum_f"
      printf '\0'
    fi
  done
}
xum_walk "$d" "" 0
printf 'END\0%s\0' "$xum_trunc"
`;

export interface RuntimeArtifactListing {
  /** The artifacts dir as the runtime expanded it (absolute). */
  dir: string;
  entries: ArtifactEntry[];
  truncated: boolean;
}

function parseMeta(meta: string): { size: number; modifiedMs: number } | null {
  // stat prints a negative mtime for files dated before 1970.
  const match = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(meta);
  if (!match) return null;
  return { size: Number(match[1]), modifiedMs: Number(match[2]) * 1000 };
}

/** Parse ARTIFACT_LIST_SCRIPT output. Throws on anything malformed or cut off. */
export function parseArtifactListOutput(stdout: string): RuntimeArtifactListing {
  const start = stdout.indexOf(`${LIST_MAGIC}\0`);
  if (start === -1) throw new Error("Artifact listing output has no header");
  const fields = stdout.slice(start).split("\0");
  // fields: MAGIC, dir, records..., END, flag, "" (after the final NUL)
  let index = 1;
  const next = (): string => {
    if (index >= fields.length) throw new Error("Artifact listing output is cut off");
    return fields[index++];
  };
  const dir = next();
  const entries: ArtifactEntry[] = [];
  for (;;) {
    const tag = next();
    if (tag === "END") {
      const flag = next();
      if (flag !== "0" && flag !== "1") throw new Error("Artifact listing output is malformed");
      if (index !== fields.length - 1 || fields[index] !== "") {
        throw new Error("Artifact listing output has trailing data");
      }
      sortArtifactEntries(entries);
      // Newest first, so the cap keeps the newest files (same bound as the host listing).
      const overCap = entries.length > MAX_ARTIFACT_LIST_ENTRIES;
      return {
        dir,
        entries: overCap ? entries.slice(0, MAX_ARTIFACT_LIST_ENTRIES) : entries,
        truncated: flag === "1" || overCap,
      };
    }
    if (tag !== "F") throw new Error("Artifact listing output is malformed");
    const relPath = next();
    const meta = parseMeta(next());
    // Same path rules as reads: an entry the read route would refuse is not listed.
    if (meta === null || typeof parseArtifactRelativePath(relPath) === "string") continue;
    entries.push({ path: relPath, kind: getArtifactKind(relPath), ...meta });
  }
}

export async function listArtifactsOnRuntime(
  runtime: Runtime,
  artifactsDir: string,
  abortSignal?: AbortSignal
): Promise<RuntimeArtifactListing> {
  const result = await execBuffered(runtime, ARTIFACT_LIST_SCRIPT, {
    cwd: "/",
    pathEnv: { XUM_ARTIFACTS_DIR: artifactsDir },
    timeout: EXEC_TIMEOUT_SECONDS,
    abortSignal,
    maxOutputBytes: MAX_LIST_OUTPUT_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Listing artifacts failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`
    );
  }
  return parseArtifactListOutput(result.stdout);
}

/**
 * Reads one artifact. Containment without following symlinks: cd one folder at a time,
 * refusing symlinked folders, so the shell's cwd pins each checked folder; the final cwd must
 * still be under the root's real path. The root itself could be swapped for a symlink between
 * its `-L` check and `cd`, so after `cd` its real path must be the parent's real path plus the
 * dir's own name. The leaf is opened on fd 3 and, where /proc exists, the
 * descriptor's own path must be inside the root (a leaf swapped for a symlink after its check).
 * Header `MAGIC status [size mtime]`, then for `ok` at most cap + 1 raw bytes.
 */
export function buildArtifactReadScript(
  segments: string[],
  maxBytes: number,
  options?: Pick<ArtifactReadOptions, "requireArtifactsBasename">
): string {
  assert(segments.length > 0, "segments must not be empty");
  assert(Number.isInteger(maxBytes) && maxBytes > 0, "maxBytes must be a positive integer");
  const dirSegments = segments.slice(0, -1).map((segment) => shescape.quote(segment));
  const leaf = shescape.quote(segments[segments.length - 1]);
  // The root's real path must be its real parent plus its own name (or `artifacts`).
  const rootName = (options?.requireArtifactsBasename ?? true) ? ARTIFACTS_DIR_NAME : "${d##*/}";
  return (
    String.raw`xum_missing() { printf '${READ_MAGIC}\0missing\0'; exit 0; }
d=$XUM_ARTIFACTS_DIR
if [ -L "$d" ] || [ ! -d "$d" ]; then xum_missing; fi
cd -- "$d" 2>/dev/null || xum_missing
xum_root=$(pwd -P) || xum_missing
xum_parent=$(cd -P -- "$` +
    "{d%/*}" +
    String.raw`" 2>/dev/null && pwd -P) || xum_missing
if [ "$xum_root" != "$xum_parent/${rootName}" ]; then xum_missing; fi
for xum_seg in ${dirSegments.join(" ")}; do
  if [ -L "$xum_seg" ] || [ ! -d "$xum_seg" ]; then xum_missing; fi
  cd -- "$xum_seg" 2>/dev/null || xum_missing
done
case $(pwd -P) in "$xum_root"/*|"$xum_root") ;; *) xum_missing ;; esac
xum_leaf=${leaf}
if [ -L "$xum_leaf" ] || [ ! -f "$xum_leaf" ]; then xum_missing; fi
${STAT_PRELUDE}
xum_send() {
  if xum_fd=$(readlink "/proc/$$/fd/3" 2>/dev/null); then
    case $xum_fd in "$xum_root"/*) ;; *) xum_missing ;; esac
  fi
  if [ -L "$xum_leaf" ]; then xum_missing; fi
  xum_m=$(xum_meta "./$xum_leaf") || xum_missing
  set -- $xum_m
  if [ "$1" -gt ${maxBytes} ]; then printf '${READ_MAGIC}\0too_large\0%s\0%s\0' "$1" "$2"; exit 0; fi
  printf '${READ_MAGIC}\0ok\0%s\0%s\0' "$1" "$2"
  head -c ${maxBytes + 1} <&3
  exit 0
}
xum_send 3< "./$xum_leaf" || xum_missing
`
  );
}

async function collectBytesWithCeiling(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Artifact read output exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Parse buildArtifactReadScript output into the shared wire result. */
export function parseArtifactReadOutput(
  stdout: Buffer,
  relPath: string,
  maxBytes: number
): ArtifactReadOutcome {
  return toArtifactReadOutcome(relPath, parseArtifactReadBytes(stdout, maxBytes), maxBytes);
}

/** Parse buildArtifactReadScript output into raw bytes. Throws on malformed output. */
export function parseArtifactReadBytes(stdout: Buffer, maxBytes: number): ArtifactBytesOutcome {
  const start = stdout.indexOf(`${READ_MAGIC}\0`);
  if (start === -1) throw new Error("Artifact read output has no header");
  let offset = start + READ_MAGIC.length + 1;
  const nextField = (): string => {
    const end = stdout.indexOf(0, offset);
    if (end === -1) throw new Error("Artifact read output is cut off");
    const field = stdout.subarray(offset, end).toString("utf8");
    offset = end + 1;
    return field;
  };
  const status = nextField();
  if (status === "missing") return { status: "missing" };
  if (status !== "ok" && status !== "too_large") {
    throw new Error("Artifact read output is malformed");
  }
  const size = Number(nextField());
  const mtimeSeconds = Number(nextField());
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtimeSeconds)) {
    throw new Error("Artifact read output is malformed");
  }
  const modifiedMs = mtimeSeconds * 1000;
  if (status === "too_large") return { status: "too_large", size, modifiedMs };
  const bytes = stdout.subarray(offset);
  // The script reads at most cap + 1 bytes: one more means the file grew past the cap.
  if (bytes.length > maxBytes) return { status: "too_large", size: bytes.length, modifiedMs };
  return { status: "ok", bytes: Buffer.from(bytes), modifiedMs };
}

export async function readArtifactOnRuntime(
  runtime: Runtime,
  artifactsDir: string,
  relPath: string,
  maxBytes: number,
  abortSignal?: AbortSignal,
  options?: ArtifactReadOptions
): Promise<ArtifactReadOutcome> {
  return toArtifactReadOutcome(
    relPath,
    await readArtifactBytesOnRuntime(
      runtime,
      artifactsDir,
      relPath,
      maxBytes,
      abortSignal,
      options
    ),
    maxBytes
  );
}

export async function readArtifactBytesOnRuntime(
  runtime: Runtime,
  artifactsDir: string,
  relPath: string,
  maxBytes: number,
  abortSignal?: AbortSignal,
  options?: ArtifactReadOptions
): Promise<ArtifactBytesOutcome> {
  const segments = parseArtifactRelativePath(relPath, options);
  if (typeof segments === "string") return { status: "invalid", error: segments };

  const stream = await runtime.exec(buildArtifactReadScript(segments, maxBytes, options), {
    cwd: "/",
    pathEnv: { XUM_ARTIFACTS_DIR: artifactsDir },
    timeout: EXEC_TIMEOUT_SECONDS,
    abortSignal,
  });
  await stream.stdin.close();
  const [stdout, stderr, exitCode] = await Promise.all([
    collectBytesWithCeiling(stream.stdout, maxBytes + 1 + READ_OUTPUT_SLACK_BYTES),
    streamToStringCapped(stream.stderr, 4096),
    stream.exitCode,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Reading artifact failed (exit ${exitCode}): ${stderr.trim().slice(0, 500)}`);
  }
  return parseArtifactReadBytes(stdout, maxBytes);
}

/**
 * Writes one host-maintained artifact (the goal status board) through the Runtime. Only the
 * artifacts folder itself is created (no `mkdir -p`): the scratch dir above it is deleted when
 * the workspace is removed, and a late refresh must not recreate it. Same containment as
 * reads: cd one folder at a time (creating missing ones), refusing symlinked
 * folders, the final cwd must stay under the root's real path, and an existing leaf must be a
 * regular file. Content arrives on stdin into a hidden temp file (noclobber) that is renamed
 * over the leaf, so readers never see a partial board. Runtime.writeFile is not used: on SSH it
 * deliberately writes through symlinks, which would let the agent redirect a host write.
 * Prints `MAGIC ok` or `MAGIC refused reason`.
 */
export function buildArtifactWriteScript(segments: string[]): string {
  assert(segments.length > 0, "segments must not be empty");
  const dirSegments = segments.slice(0, -1).map((segment) => shescape.quote(segment));
  const leaf = shescape.quote(segments[segments.length - 1]);
  return String.raw`xum_refuse() { printf '${WRITE_MAGIC}\0refused\0%s\0' "$1"; cat >/dev/null; exit 0; }
d=$XUM_ARTIFACTS_DIR
if [ ! -e "$d" ] && [ ! -L "$d" ]; then mkdir -- "$d" 2>/dev/null || xum_refuse mkdir; fi
if [ -L "$d" ] || [ ! -d "$d" ]; then xum_refuse root; fi
cd -- "$d" 2>/dev/null || xum_refuse root
xum_root=$(pwd -P) || xum_refuse root
for xum_seg in ${dirSegments.join(" ")}; do
  if [ ! -e "$xum_seg" ] && [ ! -L "$xum_seg" ]; then mkdir -- "$xum_seg" 2>/dev/null || xum_refuse folder; fi
  if [ -L "$xum_seg" ] || [ ! -d "$xum_seg" ]; then xum_refuse folder; fi
  cd -- "$xum_seg" 2>/dev/null || xum_refuse folder
done
case $(pwd -P) in "$xum_root"/*|"$xum_root") ;; *) xum_refuse folder ;; esac
xum_leaf=${leaf}
if [ -L "$xum_leaf" ]; then xum_refuse leaf; fi
if [ -e "$xum_leaf" ] && [ ! -f "$xum_leaf" ]; then xum_refuse leaf; fi
xum_tmp=".$xum_leaf.$$.tmp"
rm -f -- "$xum_tmp"
set -C
(umask 022; cat > "$xum_tmp") || { rm -f -- "$xum_tmp"; exit 1; }
mv -f -- "$xum_tmp" "$xum_leaf" || { rm -f -- "$xum_tmp"; exit 1; }
printf '${WRITE_MAGIC}\0ok\0'
`;
}

export async function writeArtifactOnRuntime(
  runtime: Runtime,
  artifactsDir: string,
  relPath: string,
  content: string,
  abortSignal?: AbortSignal
): Promise<void> {
  const segments = parseArtifactRelativePath(relPath);
  if (typeof segments === "string") throw new Error(segments);
  const result = await execBuffered(runtime, buildArtifactWriteScript(segments), {
    cwd: "/",
    pathEnv: { XUM_ARTIFACTS_DIR: artifactsDir },
    timeout: EXEC_TIMEOUT_SECONDS,
    abortSignal,
    stdin: content,
    maxOutputBytes: READ_OUTPUT_SLACK_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Writing artifact failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`
    );
  }
  const start = result.stdout.indexOf(`${WRITE_MAGIC}\0`);
  if (start === -1) throw new Error("Artifact write output has no header");
  const [status, reason] = result.stdout.slice(start + WRITE_MAGIC.length + 1).split("\0");
  if (status === "ok") return;
  if (status === "refused") throw new Error(`Artifact write refused (${reason ?? "unknown"})`);
  throw new Error("Artifact write output is malformed");
}
