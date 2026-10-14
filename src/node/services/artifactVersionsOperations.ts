import * as path from "path";
import type { ArtifactPin, ArtifactVersionList } from "@/common/orpc/schemas/artifacts";
import type { ArtifactsIndexAttachment } from "@/common/types/attachment";
import { getArtifactKind, type ArtifactKind } from "@/common/utils/artifactKind";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import {
  ARTIFACTS_DIR_NAME,
  buildArtifactReadResult,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  parseArtifactRelativePath,
  type ArtifactReadOutcome,
} from "./artifactStore";
import {
  assertArtifactsEnabled,
  MAX_ARTIFACT_READ_BYTES,
  readArtifactBytesAtLocation,
  type ArtifactsContext,
  type AvailableArtifactsLocation,
} from "./artifactsOperations";
import {
  ARTIFACT_PUBLISH_INTERRUPTED,
  getArtifactId,
  listArtifactIndexes,
  readArtifactIndex,
  readArtifactVersionBytes,
  recordArtifactVersion,
  type RecordArtifactVersionResult,
} from "./artifactVersionStore";

/**
 * Version operations over the artifacts location abstraction: publishing (the artifact tool,
 * the only source of new versions) and the listVersions/readVersion routes.
 */

/**
 * The artifacts location a tool sees, from its exported env: XUM_SCRATCH_DIR is set exactly where
 * the workspace has a scratch dir; host-visible runtimes read the host fs, SSH/Docker the Runtime.
 * A devcontainer writes its host-mounted dir from inside the container, so the host reads it only
 * with descriptor verification, else the container reads it (as artifact_list and the tab do).
 */
export async function getToolArtifactsLocation(
  config: Pick<ToolConfiguration, "xumEnv" | "runtime">
): Promise<AvailableArtifactsLocation | null> {
  const scratchDir = config.xumEnv?.XUM_SCRATCH_DIR;
  if (scratchDir == null) return null;
  const runtimeMode = config.xumEnv?.XUM_RUNTIME;
  if (isScratchDirOnHost(runtimeMode)) {
    if (runtimeMode !== "devcontainer") return { kind: "host", dir: getArtifactsDir(scratchDir) };
    if (await hostSupportsDescriptorPaths()) {
      return { kind: "host", dir: getArtifactsDir(scratchDir), containerWritable: true };
    }
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
  // The exact bytes: `report.md ` and `report.md` are different files (as for pinned files).
  if (inputPath.trim().length === 0) return { error: "No artifact path given" };
  const trimmed = inputPath;
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
  } else if (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/")) {
    // Only `~` and `~/...` name the home folder; `~draft.md` is a relative file name.
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
      label: params.label,
      kind: params.kind,
      pin: params.pin,
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
      versions: [...(index?.versions ?? [])].reverse(),
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
