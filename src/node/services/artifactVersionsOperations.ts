import * as path from "path";
import type {
  ArtifactPin,
  ArtifactVersionList,
  ArtifactVersionSource,
} from "@/common/orpc/schemas/artifacts";
import type { ArtifactsIndexAttachment } from "@/common/types/attachment";
import { getArtifactKind, type ArtifactKind } from "@/common/utils/artifactKind";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";
import {
  ARTIFACTS_DIR_NAME,
  buildArtifactReadResult,
  getArtifactsDir,
  parseArtifactRelativePath,
  type ArtifactReadOutcome,
} from "./artifactStore";
import {
  assertArtifactsEnabled,
  listArtifactsAtLocation,
  MAX_ARTIFACT_READ_BYTES,
  readArtifactBytesAtLocation,
  type ArtifactsContext,
  type ArtifactsLocation,
  type AvailableArtifactsLocation,
} from "./artifactsOperations";
import {
  ARTIFACT_PUBLISH_INTERRUPTED,
  getArtifactId,
  hasPublishSince,
  listArtifactIndexes,
  readArtifactIndex,
  readArtifactVersionBytes,
  recordArtifactVersion,
  toPublicVersion,
  type RecordArtifactVersionResult,
} from "./artifactVersionStore";

/**
 * Version operations over the artifacts location abstraction: publishing (artifact tool,
 * attach_file), turn-end snapshots, and the listVersions/readVersion routes.
 */

/**
 * The artifacts location a tool sees, from its exported env: XUM_SCRATCH_DIR is set exactly where
 * the workspace has a scratch dir; host-visible runtimes read the host fs, SSH/Docker the Runtime.
 */
export function getToolArtifactsLocation(
  config: Pick<ToolConfiguration, "xumEnv" | "runtime">
): AvailableArtifactsLocation | null {
  const scratchDir = config.xumEnv?.XUM_SCRATCH_DIR;
  if (scratchDir == null) return null;
  if (isScratchDirOnHost(config.xumEnv?.XUM_RUNTIME)) {
    return { kind: "host", dir: getArtifactsDir(scratchDir) };
  }
  return {
    kind: "runtime",
    runtime: config.runtime,
    dir: `${scratchDir.replace(/\/+$/, "")}/${ARTIFACTS_DIR_NAME}`,
  };
}

/**
 * Map a tool-supplied path (relative to the artifacts dir, or absolute inside it) to the
 * artifacts-relative POSIX path, or an error string. Host dirs use this host's path rules (a
 * Windows dir is `C:\\...\\artifacts`); runtime dirs are POSIX. `pathImpl` is for tests.
 */
export function resolveArtifactToolPath(
  location: AvailableArtifactsLocation,
  inputPath: string,
  pathImpl: path.PlatformPath = path
): string | { error: string } {
  const trimmed = inputPath.trim();
  const dir = location.dir.replace(/\/+$/, "");
  let relPath = trimmed;
  if (location.kind === "host" && pathImpl.isAbsolute(trimmed)) {
    const relative = pathImpl.relative(location.dir, trimmed);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${pathImpl.sep}`) ||
      pathImpl.isAbsolute(relative)
    ) {
      return { error: `Path must be inside ${location.dir} ($XUM_SCRATCH_DIR/artifacts)` };
    }
    relPath = relative.split(pathImpl.sep).join("/");
  } else if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    if (!trimmed.startsWith(`${dir}/`)) {
      return { error: `Path must be inside ${dir} ($XUM_SCRATCH_DIR/artifacts)` };
    }
    relPath = trimmed.slice(dir.length + 1);
  }
  relPath = relPath.replace(/^\.\//, "");
  const segments = parseArtifactRelativePath(relPath);
  if (typeof segments === "string") return { error: segments };
  return segments.join("/");
}

export type PublishOutcome =
  | { success: true; result: RecordArtifactVersionResult; kind: ArtifactKind }
  | { success: false; error: string };

/** Copy the file's current bytes into the version store (deduped against the latest version). */
export async function publishArtifactVersion(params: {
  sessionDir: string;
  location: AvailableArtifactsLocation;
  relPath: string;
  source: ArtifactVersionSource;
  label: string | null;
  kind?: ArtifactKind;
  pin?: ArtifactPin | null;
  abortSignal?: AbortSignal;
}): Promise<PublishOutcome> {
  const read = await readArtifactBytesAtLocation(
    params.location,
    params.relPath,
    MAX_ARTIFACT_READ_BYTES,
    params.abortSignal
  );
  switch (read.status) {
    case "invalid":
      return { success: false, error: read.error };
    case "missing":
      return { success: false, error: `Artifact not found: ${params.relPath}` };
    case "too_large":
      return {
        success: false,
        error: `Artifact is ${read.size} bytes; versions are capped at ${MAX_ARTIFACT_READ_BYTES} bytes`,
      };
    case "ok":
      break;
  }
  // The tool call was cancelled while the file was read: record nothing. Re-checked under the
  // index lock, so a cancel that lands while waiting for the lock writes nothing either.
  if (params.abortSignal?.aborted) return { success: false, error: ARTIFACT_PUBLISH_INTERRUPTED };
  let result: RecordArtifactVersionResult;
  try {
    result = await recordArtifactVersion({
      sessionDir: params.sessionDir,
      relPath: params.relPath,
      bytes: read.bytes,
      source: params.source,
      label: params.label,
      kind: params.kind,
      pin: params.pin,
      sourceModifiedMs: read.modifiedMs,
      abortSignal: params.abortSignal,
    });
  } catch (error) {
    if (params.abortSignal?.aborted) return { success: false, error: ARTIFACT_PUBLISH_INTERRUPTED };
    throw error;
  }
  return {
    success: true,
    result,
    kind: result.version.kind ?? params.kind ?? getArtifactKind(params.relPath),
  };
}

/** Kinds attach_file registers as artifact versions (rich, user-facing documents). */
const ATTACH_FILE_ARTIFACT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "html",
  "markdown",
  "json",
  "svg",
  "csv",
  "mermaid",
]);

/**
 * attach_file registration: when the attached file sits inside the artifacts dir and is a rich
 * document kind, record the bytes attach_file already read (no second read) as a version.
 * Returns null when the file is not an artifact. Counts as a publish for the turn.
 */
export async function registerAttachedArtifact(params: {
  sessionDir: string;
  location: AvailableArtifactsLocation;
  /** Absolute path attach_file read, in the runtime's namespace. */
  resolvedPath: string;
  bytes: Buffer;
  /** Expands a home-relative (`~/...`) remote artifacts dir; SSH only. */
  resolveRuntimePath?: (p: string) => Promise<string>;
  /** Checked under the index lock: a cancelled attach_file records nothing. */
  abortSignal?: AbortSignal;
}): Promise<{ id: string; version: number; path: string } | null> {
  let relPath = resolveArtifactToolPath(params.location, params.resolvedPath);
  if (
    typeof relPath !== "string" &&
    params.location.kind === "runtime" &&
    params.location.dir.startsWith("~") &&
    params.resolveRuntimePath != null
  ) {
    const dir = await params.resolveRuntimePath(params.location.dir);
    relPath = resolveArtifactToolPath({ ...params.location, dir }, params.resolvedPath);
  }
  if (typeof relPath !== "string") return null;
  if (!ATTACH_FILE_ARTIFACT_KINDS.has(getArtifactKind(relPath))) return null;
  const recorded = await recordArtifactVersion({
    sessionDir: params.sessionDir,
    relPath,
    bytes: params.bytes,
    source: "attach_file",
    label: path.posix.basename(relPath),
    abortSignal: params.abortSignal,
  });
  return { id: recorded.artifactId, version: recorded.version.version, path: relPath };
}

/**
 * Host-maintained live artifacts that never get turn-end versions: the goal status board is
 * rewritten on goal events and every continuation turn, so snapshotting it would only add noise.
 */
export const TURN_END_SNAPSHOT_EXCLUDED_PATHS: ReadonlySet<string> = new Set(["goal.status.html"]);

/**
 * Turn-end snapshot (logical turn completed, never on abort/error): when nothing was published
 * during the turn, copy every artifact whose bytes differ from its latest version. One version per
 * file per turn, however often it was edited. Files whose size and mtime match the latest version's
 * copy are skipped unread. Returns the paths that got a new version.
 */
export async function snapshotArtifactsAtTurnEnd(params: {
  sessionDir: string;
  location: AvailableArtifactsLocation;
  turnStartedAtMs: number;
  abortSignal?: AbortSignal;
}): Promise<string[]> {
  const indexes = await listArtifactIndexes(params.sessionDir);
  if (hasPublishSince(indexes, params.turnStartedAtMs)) return [];
  const latestByPath = new Map(
    indexes.map((index) => [index.path, index.versions.at(-1)] as const)
  );
  const listing = await listArtifactsAtLocation(params.location, params.abortSignal);
  const snapshotted: string[] = [];
  for (const entry of listing.entries) {
    if (params.abortSignal?.aborted) break;
    if (TURN_END_SNAPSHOT_EXCLUDED_PATHS.has(entry.path)) continue;
    if (entry.size > MAX_ARTIFACT_READ_BYTES) continue;
    const latest = latestByPath.get(entry.path);
    // Same size and mtime means unchanged. The store keeps sourceModifiedMs only when it was
    // read at least 1 s after that mtime (whole-second runtime stat), and refreshes it when
    // unchanged bytes are seen again, so a touched file is read once and then skipped.
    // Host files only: that 1 s check uses the host clock, and a runtime (SSH) clock that lags
    // it would let a same-size rewrite in the same remote second be skipped. Runtime files are
    // always read and hashed (dedupe still adds no version for unchanged bytes).
    if (
      params.location.kind === "host" &&
      latest?.size === entry.size &&
      latest.sourceModifiedMs != null &&
      latest.sourceModifiedMs === entry.modifiedMs
    ) {
      continue;
    }
    try {
      const read = await readArtifactBytesAtLocation(
        params.location,
        entry.path,
        MAX_ARTIFACT_READ_BYTES,
        params.abortSignal
      );
      if (read.status !== "ok") continue;
      // A read that finished after the turn-end bound fired must not write a version.
      if (params.abortSignal?.aborted) break;
      const recorded = await recordArtifactVersion({
        sessionDir: params.sessionDir,
        relPath: entry.path,
        bytes: read.bytes,
        source: "turn-end",
        label: null,
        sourceModifiedMs: read.modifiedMs,
        abortSignal: params.abortSignal,
      });
      if (recorded.created) snapshotted.push(entry.path);
    } catch (error) {
      log.debug("Turn-end artifact snapshot skipped a file", {
        path: entry.path,
        error: getErrorMessage(error),
      });
    }
  }
  return snapshotted;
}

/**
 * AgentSession logical-turn hooks for turn-end snapshots. The turn start is kept in memory only:
 * after a restart mid-turn the first completion has no start and takes no snapshot (the next
 * turn catches the changes), which is safer than snapshotting across an unknown window.
 */
export function createArtifactTurnSnapshotHooks(params: {
  isEnabled: () => boolean;
  sessionDir: string;
  resolveLocation: () => Promise<ArtifactsLocation | null>;
  now?: () => number;
}): {
  onLogicalTurnStarted: () => void;
  onLogicalTurnCompleted: (abortSignal: AbortSignal) => Promise<void>;
} {
  const now = params.now ?? Date.now;
  let turnStartedAtMs: number | undefined;
  return {
    onLogicalTurnStarted: () => {
      turnStartedAtMs = now();
    },
    onLogicalTurnCompleted: async (abortSignal) => {
      const startedAtMs = turnStartedAtMs;
      turnStartedAtMs = undefined;
      if (startedAtMs == null || !params.isEnabled()) return;
      const location = await params.resolveLocation();
      if (location == null || location.kind === "unavailable" || abortSignal.aborted) return;
      await snapshotArtifactsAtTurnEnd({
        sessionDir: params.sessionDir,
        location,
        turnStartedAtMs: startedAtMs,
        abortSignal,
      });
    },
  };
}

/**
 * Post-compaction artifacts index: every artifact with a version, newest publish first. Null when
 * there are none, so workspaces without artifacts add nothing to context.
 */
export async function generateArtifactsIndexAttachment(
  sessionDir: string
): Promise<ArtifactsIndexAttachment | null> {
  const indexes = await listArtifactIndexes(sessionDir);
  const artifacts = indexes
    .flatMap((index) => {
      const latest = index.versions.at(-1);
      return latest
        ? [
            {
              path: index.path,
              latestVersion: latest.version,
              label: latest.label,
              at: latest.createdAtMs,
            },
          ]
        : [];
    })
    // Stable order (newest first, path tiebreak) keeps the injected note cache-friendly.
    .sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
    .map(({ at: _at, ...rest }) => rest);
  return artifacts.length > 0 ? { type: "artifacts_index", artifacts } : null;
}

function sessionDirFor(context: ArtifactsContext, workspaceId: string): string {
  return path.join(context.config.sessionsDir, workspaceId);
}

export async function listArtifactVersions(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string }
): Promise<{ success: true; data: ArtifactVersionList } | { success: false; error: string }> {
  assertArtifactsEnabled(context);
  if (!(await context.workspaceService.getInfo(input.workspaceId))) {
    return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  }
  const segments = parseArtifactRelativePath(input.path);
  if (typeof segments === "string") return { success: false, error: segments };
  const artifactId = getArtifactId(input.path);
  const index = await readArtifactIndex(sessionDirFor(context, input.workspaceId), artifactId);
  return {
    success: true,
    data: {
      artifactId,
      path: input.path,
      pin: index?.pin ?? null,
      versions: (index?.versions ?? []).map(toPublicVersion).reverse(),
    },
  };
}

export async function readArtifactVersion(
  context: ArtifactsContext,
  input: { workspaceId: string; artifactId: string; version: number }
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  if (!(await context.workspaceService.getInfo(input.workspaceId))) {
    return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  }
  const stored = await readArtifactVersionBytes(
    sessionDirFor(context, input.workspaceId),
    input.artifactId,
    input.version
  );
  if (!stored) {
    return { success: false, error: `Artifact version not found: v${input.version}` };
  }
  return {
    success: true,
    data: buildArtifactReadResult(
      stored.version.path,
      stored.bytes,
      stored.version.createdAtMs,
      MAX_ARTIFACT_READ_BYTES,
      stored.version.kind ?? getArtifactKind(stored.version.path)
    ),
  };
}
