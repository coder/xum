import * as path from "path";
import type { ArtifactPin } from "@/common/orpc/schemas/artifacts";
import type { ArtifactsIndexAttachment } from "@/common/types/attachment";
import { getArtifactKind, type ArtifactKind } from "@/common/utils/artifactKind";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { isScratchDirOnHost } from "@/node/runtime/runtimeScratchDir";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  parseArtifactRelativePath,
} from "./artifactStore";
import {
  MAX_ARTIFACT_READ_BYTES,
  readArtifactBytesAtLocation,
  type AvailableArtifactsLocation,
} from "./artifactsOperations";
import {
  ARTIFACT_PUBLISH_INTERRUPTED,
  listArtifactRecords,
  recordArtifactPublish,
  type ArtifactRecord,
} from "./artifactRecordStore";

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

/** `bytes` is null when the file is over the read cap. Runtime failures throw. */
export async function probeArtifactFile(
  location: AvailableArtifactsLocation,
  relPath: string,
  abortSignal?: AbortSignal
): Promise<
  { success: true; size: number; bytes: Buffer | null } | { success: false; error: string }
> {
  const read = await readArtifactBytesAtLocation(
    location,
    relPath,
    MAX_ARTIFACT_READ_BYTES,
    abortSignal
  );
  switch (read.status) {
    case "invalid":
      return { success: false, error: read.error };
    case "missing":
      return { success: false, error: `Artifact not found: ${relPath}` };
    case "too_large":
      return { success: true, size: read.size, bytes: null };
    case "ok":
      return { success: true, size: read.bytes.length, bytes: read.bytes };
  }
}

export type PublishOutcome =
  | { success: true; record: ArtifactRecord; kind: ArtifactKind; size: number }
  | { success: false; error: string };

export async function publishArtifact(params: {
  sessionDir: string;
  location: AvailableArtifactsLocation;
  relPath: string;
  title: string;
  kind?: ArtifactKind;
  pin?: ArtifactPin;
  abortSignal?: AbortSignal;
}): Promise<PublishOutcome> {
  const probe = await probeArtifactFile(params.location, params.relPath, params.abortSignal);
  if (!probe.success) return probe;
  // The tool call was cancelled while the file was read: record nothing. Re-checked under the
  // record lock, so a cancel that lands while waiting for the lock writes nothing either.
  if (params.abortSignal?.aborted) return { success: false, error: ARTIFACT_PUBLISH_INTERRUPTED };
  try {
    const record = await recordArtifactPublish({
      sessionDir: params.sessionDir,
      relPath: params.relPath,
      title: params.title,
      kind: params.kind,
      pin: params.pin,
      abortSignal: params.abortSignal,
    });
    return {
      success: true,
      record,
      kind: record.kind ?? getArtifactKind(params.relPath),
      size: probe.size,
    };
  } catch (error) {
    if (params.abortSignal?.aborted) return { success: false, error: ARTIFACT_PUBLISH_INTERRUPTED };
    throw error;
  }
}

/**
 * Post-compaction artifacts index: every published artifact, newest publish first. Null when
 * there are none, so workspaces without artifacts add nothing to context.
 */
export async function generateArtifactsIndexAttachment(
  sessionDir: string
): Promise<ArtifactsIndexAttachment | null> {
  const records = await listArtifactRecords(sessionDir);
  // Stable order (newest first, path tiebreak) keeps the injected note cache-friendly.
  const artifacts = records
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs || a.path.localeCompare(b.path))
    .map((record) => ({ path: record.path, title: record.title }));
  return artifacts.length > 0 ? { type: "artifacts_index", artifacts } : null;
}
