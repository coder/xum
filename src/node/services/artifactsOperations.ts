/**
 * Artifacts route operations (Artifacts tab, experiment: "artifacts").
 *
 * The artifacts dir is `$XUM_SCRATCH_DIR/artifacts`, wherever the runtime keeps the scratch
 * dir (runtimeScratchDir.ts). Host dirs (local, worktree, and a devcontainer's same-path mount
 * where the host can pin folders by descriptor) are read from this host's filesystem; SSH,
 * Docker and the other devcontainer dirs through the Runtime.
 */
import { ORPCError } from "@orpc/server";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactCapabilities, ArtifactListing } from "@/common/orpc/schemas/artifacts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "@/node/orpc/context";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  createRuntimeForWorkspace,
  resolveWorkspaceExecutionPath,
} from "@/node/runtime/runtimeHelpers";
import { ensureScratchDirForSpec, resolveScratchDirSpec } from "@/node/runtime/runtimeScratchDir";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/attachmentLimits";
import { isWorkspaceTrustedForSharedExecution } from "@/node/services/utils/workspaceTrust";
import { getArtifactCapabilities } from "./artifactCapabilities";
import {
  listArtifactsOnRuntime,
  readArtifactOnRuntime,
  writeArtifactOnRuntime,
} from "./artifactRuntimeStore";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  listArtifactsInDir,
  readArtifactFromDir,
  writeArtifactToDir,
  type ArtifactReadOutcome,
} from "./artifactStore";

type ArtifactsContext = Pick<ORPCContext, "experimentsService" | "workspaceService" | "config">;

/** Same cap as attach_file, so anything the agent can attach can also be previewed. */
export const MAX_ARTIFACT_READ_BYTES = MAX_ATTACH_FILE_SIZE_BYTES;

export const ARTIFACTS_UNAVAILABLE_REASON =
  "Artifacts are not available in this workspace: it has no scratch dir. Devcontainers need a local Docker daemon, and multi-project workspaces need a local or worktree runtime.";

export const RUNTIME_SCRATCH_DIR_MISSING_REASON =
  "Artifacts are not available in this workspace right now: Xum could not create the scratch dir on its runtime. Agent turns leave XUM_SCRATCH_DIR unset in this case too.";

export const DEVCONTAINER_SCRATCH_MOUNT_MISSING_REASON =
  "Artifacts are not available in this devcontainer yet: the container does not see the scratch dir. Rebuild the container to add the scratch mount.";

/**
 * Scratch dirs the runtime confirmed (devcontainer mounts the container sees, SSH/Docker dirs
 * mkdir created), keyed by workspace and dir. Only a positive result is kept (a rebuilt
 * container keeps its mount, a created dir stays), so the 3 s panel poll does not exec into the
 * runtime every time, while a failed probe or mkdir is retried on the next poll.
 */
const confirmedScratchDirs = new Set<string>();

function assertArtifactsEnabled(context: ArtifactsContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS)) {
    throw new ORPCError("BAD_REQUEST", { message: "Artifacts are disabled" });
  }
}

export type ArtifactsLocation =
  /**
   * `containerWritable`: a devcontainer writes this dir through its same-path mount, so host
   * access must pin folders by descriptor and never fall back to pathname checks.
   */
  | { kind: "host"; dir: string; containerWritable?: true }
  /** `dir` is in the runtime's namespace and may be home-relative (`~/...`) on SSH. */
  | { kind: "runtime"; runtime: Runtime; dir: string }
  | { kind: "unavailable"; reason: string };

type ArtifactsWorkspaceMetadata = Pick<
  FrontendWorkspaceMetadata,
  "runtimeConfig" | "projectPath" | "name" | "namedWorkspacePath"
> &
  Partial<Pick<FrontendWorkspaceMetadata, "projects">>;

export async function resolveArtifactsLocation(
  sessionsDir: string,
  workspaceId: string,
  metadata: ArtifactsWorkspaceMetadata,
  options?: {
    createRuntime?: (metadata: ArtifactsWorkspaceMetadata) => Runtime;
    canBindMountHostPaths?: () => Promise<boolean>;
    hostSupportsDescriptorPaths?: () => Promise<boolean>;
    abortSignal?: AbortSignal;
  }
): Promise<ArtifactsLocation> {
  const createRuntime = options?.createRuntime ?? createRuntimeForWorkspace;
  // Runtime construction is cheap (no I/O); remote runtimes need one to know their home.
  let runtime: Runtime | undefined;
  const getRuntime = (): Runtime => (runtime ??= createRuntime(metadata));
  // Mirrors turnRequestBuilder, which exports XUM_SCRATCH_DIR from the same spec.
  const spec = await resolveScratchDirSpec({
    runtimeConfig: metadata.runtimeConfig,
    workspaceId,
    sessionsDir,
    runtime: { getXumHome: () => getRuntime().getXumHome() },
    multiProject: (metadata.projects?.length ?? 0) > 1, // isMultiProject, on a narrower type
    canBindMountHostPaths: options?.canBindMountHostPaths,
  });
  switch (spec.kind) {
    case "host":
      return { kind: "host", dir: getArtifactsDir(spec.dir) };
    case "devcontainer-mount": {
      // Agent turns export XUM_SCRATCH_DIR only when the container sees the mount (containers
      // created before the scratch mount keep their old mounts); the tab follows the same probe
      // so it never shows a folder the agent cannot write to.
      const key = `${workspaceId}\0${spec.dir}`;
      if (!confirmedScratchDirs.has(key)) {
        if (
          (await ensureScratchDirForSpec(getRuntime(), spec, options?.abortSignal)) === undefined
        ) {
          return { kind: "unavailable", reason: DEVCONTAINER_SCRATCH_MOUNT_MISSING_REASON };
        }
        confirmedScratchDirs.add(key);
      }
      // The container can swap folders in this dir while the host walks it, and pathname checks
      // can be raced from there. Hosts with descriptor paths (Linux) pin every folder; elsewhere
      // the dir is read inside the container, where a swap reaches nothing the container could
      // not already read.
      const pinnable = await (
        options?.hostSupportsDescriptorPaths ?? hostSupportsDescriptorPaths
      )();
      if (!pinnable) {
        return { kind: "runtime", runtime: getRuntime(), dir: getArtifactsDir(spec.dir) };
      }
      return { kind: "host", dir: getArtifactsDir(spec.dir), containerWritable: true };
    }
    case "runtime": {
      // Agent turns export XUM_SCRATCH_DIR only after this mkdir succeeds; without the check a
      // dir that could not be created would show as an empty, available folder.
      const key = `${workspaceId}\0${spec.path}`;
      if (!confirmedScratchDirs.has(key)) {
        if (
          (await ensureScratchDirForSpec(getRuntime(), spec, options?.abortSignal)) === undefined
        ) {
          return { kind: "unavailable", reason: RUNTIME_SCRATCH_DIR_MISSING_REASON };
        }
        confirmedScratchDirs.add(key);
      }
      return {
        kind: "runtime",
        runtime: getRuntime(),
        dir: `${spec.path}/${ARTIFACTS_DIR_NAME}`,
      };
    }
    case "none":
      return { kind: "unavailable", reason: ARTIFACTS_UNAVAILABLE_REASON };
  }
}

async function resolveForWorkspace(
  context: ArtifactsContext,
  workspaceId: string,
  abortSignal: AbortSignal | undefined
): Promise<ArtifactsLocation | null> {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) return null;
  return resolveArtifactsLocation(context.config.sessionsDir, workspaceId, metadata, {
    abortSignal,
  });
}

function unreachableError(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: `Could not reach this workspace's runtime: ${getErrorMessage(error)}`,
  };
}

export async function listArtifacts(
  context: ArtifactsContext,
  input: { workspaceId: string },
  /** The request's signal: a closed tab or superseded poll stops the remote exec. */
  abortSignal?: AbortSignal
): Promise<{ success: true; data: ArtifactListing } | { success: false; error: string }> {
  assertArtifactsEnabled(context);
  const location = await resolveForWorkspace(context, input.workspaceId, abortSignal);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") {
    return { success: true, data: { available: false, reason: location.reason } };
  }
  if (location.kind === "runtime") {
    try {
      const listing = await listArtifactsOnRuntime(location.runtime, location.dir, abortSignal);
      return { success: true, data: { available: true, ...listing } };
    } catch (error) {
      return unreachableError(error);
    }
  }
  const { entries, truncated } = await listArtifactsInDir(location.dir, {
    requireDescriptorPaths: location.containerWritable,
  });
  return { success: true, data: { available: true, dir: location.dir, entries, truncated } };
}

export async function readArtifact(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string; maxBytes?: number | null },
  abortSignal?: AbortSignal
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  // A caller may only lower the cap (asset reads ask for their per-asset budget, so an
  // oversize asset never crosses IPC); it can never raise it.
  const maxBytes =
    input.maxBytes == null
      ? MAX_ARTIFACT_READ_BYTES
      : Math.min(input.maxBytes, MAX_ARTIFACT_READ_BYTES);
  const location = await resolveForWorkspace(context, input.workspaceId, abortSignal);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  if (location.kind === "runtime") {
    try {
      return await readArtifactOnRuntime(
        location.runtime,
        location.dir,
        input.path,
        maxBytes,
        abortSignal
      );
    } catch (error) {
      return unreachableError(error);
    }
  }
  return readArtifactFromDir(location.dir, input.path, maxBytes, {
    requireDescriptorPaths: location.containerWritable,
  });
}

/**
 * Write one host-maintained artifact (e.g. the goal status board) wherever the location lives,
 * with the same containment rules as reads. Throws on failure; callers decide whether to care.
 */
export async function writeArtifactAtLocation(
  location: Exclude<ArtifactsLocation, { kind: "unavailable" }>,
  relPath: string,
  content: string
): Promise<void> {
  if (location.kind === "runtime") {
    await writeArtifactOnRuntime(location.runtime, location.dir, relPath, content);
    return;
  }
  await writeArtifactToDir(location.dir, relPath, content, {
    requireDescriptorPaths: location.containerWritable,
  });
}

export async function getArtifactsCapabilities(
  context: ArtifactsContext,
  input: { workspaceId: string }
): Promise<ArtifactCapabilities> {
  assertArtifactsEnabled(context);
  const metadata = await context.workspaceService.getInfo(input.workspaceId);
  if (!metadata) return { agentBrowserAvailable: null };
  return getArtifactCapabilities({
    workspaceId: input.workspaceId,
    // A recreated workspace on another runtime must not reuse the old answer.
    runtimeKey: JSON.stringify(metadata.runtimeConfig ?? null),
    createRuntime: () => createRuntimeForWorkspace(metadata),
    // Probe where and how the agent's bash tool runs, tool_env included.
    resolveCwd: (runtime) => resolveWorkspaceExecutionPath(metadata, runtime),
    trusted: isWorkspaceTrustedForSharedExecution(
      metadata,
      context.config.loadConfigOrDefault().projects
    ),
  });
}
