/**
 * Artifacts route operations (Artifacts tab, experiment: "artifacts").
 *
 * The artifacts dir is `$XUM_SCRATCH_DIR/artifacts`, wherever the runtime keeps the scratch
 * dir (runtimeScratchDir.ts). Host dirs (local, worktree, a devcontainer's same-path mount)
 * are read from this host's filesystem; SSH and Docker dirs through the Runtime.
 */
import { ORPCError } from "@orpc/server";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactListing } from "@/common/orpc/schemas/artifacts";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { getErrorMessage } from "@/common/utils/errors";
import type { ORPCContext } from "@/node/orpc/context";
import type { Runtime } from "@/node/runtime/Runtime";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { ensureScratchDirForSpec, resolveScratchDirSpec } from "@/node/runtime/runtimeScratchDir";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/attachmentLimits";
import { listArtifactsOnRuntime, readArtifactOnRuntime } from "./artifactRuntimeStore";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  listArtifactsInDir,
  readArtifactFromDir,
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
  | { kind: "host"; dir: string }
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
      return { kind: "host", dir: getArtifactsDir(spec.dir) };
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
  const { entries, truncated } = await listArtifactsInDir(location.dir);
  return { success: true, data: { available: true, dir: location.dir, entries, truncated } };
}

export async function readArtifact(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string },
  abortSignal?: AbortSignal
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  const location = await resolveForWorkspace(context, input.workspaceId, abortSignal);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  if (location.kind === "runtime") {
    try {
      return await readArtifactOnRuntime(
        location.runtime,
        location.dir,
        input.path,
        MAX_ARTIFACT_READ_BYTES,
        abortSignal
      );
    } catch (error) {
      return unreachableError(error);
    }
  }
  return readArtifactFromDir(location.dir, input.path, MAX_ARTIFACT_READ_BYTES);
}
