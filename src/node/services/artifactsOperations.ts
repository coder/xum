/**
 * Artifacts route operations (Artifacts tab, experiment: "artifacts").
 *
 * The artifacts dir is `$XUM_SCRATCH_DIR/artifacts`, wherever the runtime keeps the scratch
 * dir (runtimeScratchDir.ts). Host dirs (local, worktree, and a devcontainer's same-path mount
 * where the host can pin folders by descriptor) are read from this host's filesystem; SSH,
 * Docker and the other devcontainer dirs through the Runtime.
 */
import * as path from "path";
import { ORPCError } from "@orpc/server";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type {
  ArtifactCapabilities,
  ArtifactEntry,
  ArtifactListing,
} from "@/common/orpc/schemas/artifacts";
import type { ProjectsConfig } from "@/common/types/project";
import type { ArtifactKind } from "@/common/utils/artifactKind";
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
import { log } from "@/node/services/log";
import { getArtifactCapabilities } from "./artifactCapabilities";
import {
  getArtifactId,
  listArtifactRecords,
  readArtifactRecord,
  withPublishedKinds,
  type ArtifactRecord,
} from "./artifactRecordStore";
import {
  listArtifactsOnRuntime,
  readArtifactBytesOnRuntime,
  readArtifactOnRuntime,
  writeArtifactOnRuntime,
} from "./artifactRuntimeStore";
import {
  ARTIFACTS_DIR_NAME,
  getArtifactsDir,
  hostSupportsDescriptorPaths,
  listArtifactsInDir,
  readArtifactBytesFromDir,
  readArtifactFromDir,
  writeArtifactToDir,
  type ArtifactBytesOutcome,
  type ArtifactReadOptions,
  type ArtifactReadOutcome,
  type ArtifactWriteOptions,
} from "./artifactStore";

export type ArtifactsContext = Pick<
  ORPCContext,
  "experimentsService" | "workspaceService" | "config"
>;

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

export function assertArtifactsEnabled(context: ArtifactsContext): void {
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
      if (!(await hostSupportsDescriptorPaths())) {
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

export async function resolveForWorkspace(
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

export function unreachableError(error: unknown): { success: false; error: string } {
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
  const records = await listPublishedArtifacts(context, input.workspaceId);
  const publishedPaths = records.map((record) => record.path);
  try {
    const listing = await listArtifactsAtLocation(location, abortSignal);
    const entries = withPublishedKinds(listing.entries, records);
    return { success: true, data: { available: true, ...listing, entries, publishedPaths } };
  } catch (error) {
    // Only a runtime can be unreachable: a host dir that fails to list is not that.
    if (location.kind === "runtime") return unreachableError(error);
    throw error;
  }
}

/**
 * The files of an available artifacts location, newest first, each with the kind its extension
 * gives (a publish record can override it: withPublishedKinds). The tab and the turn-end layout
 * audit both list through this. Runtime failures throw.
 */
export async function listArtifactsAtLocation(
  location: AvailableArtifactsLocation,
  abortSignal?: AbortSignal
): Promise<{ dir: string; entries: ArtifactEntry[]; truncated: boolean }> {
  if (location.kind === "runtime") {
    return listArtifactsOnRuntime(location.runtime, location.dir, abortSignal);
  }
  const { entries, truncated } = await listArtifactsInDir(location.dir, {
    requireDescriptorPaths: location.containerWritable,
  });
  return { dir: location.dir, entries, truncated };
}

/**
 * Records of published artifacts (host session dir): the tab lists published files first and
 * shows each as its published kind. Unreadable records leave the list short, never fail it.
 */
async function listPublishedArtifacts(
  context: ArtifactsContext,
  workspaceId: string
): Promise<ArtifactRecord[]> {
  try {
    return await listArtifactRecords(path.join(context.config.sessionsDir, workspaceId));
  } catch (error) {
    log.debug("Could not list artifact records", { error: getErrorMessage(error) });
    return [];
  }
}

async function readKindOverride(
  context: ArtifactsContext,
  workspaceId: string,
  relPath: string
): Promise<ArtifactKind | undefined> {
  try {
    const record = await readArtifactRecord(
      path.join(context.config.sessionsDir, workspaceId),
      getArtifactId(relPath)
    );
    return record?.kind;
  } catch (error) {
    log.debug("Could not read artifact record", { error: getErrorMessage(error) });
    return undefined;
  }
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
  const kind = await readKindOverride(context, input.workspaceId, input.path);
  if (location.kind === "runtime") {
    try {
      return await readArtifactOnRuntime(
        location.runtime,
        location.dir,
        input.path,
        maxBytes,
        abortSignal,
        { kind }
      );
    } catch (error) {
      return unreachableError(error);
    }
  }
  return readArtifactFromDir(location.dir, input.path, maxBytes, {
    requireDescriptorPaths: location.containerWritable,
    kind,
  });
}

/**
 * Write one host-maintained artifact (e.g. the goal status board) wherever the location lives,
 * with the same containment rules as reads. Throws on failure; callers decide whether to care.
 * `createOnly` writes only a missing file, atomically: a file that exists, or appears while
 * the write runs, is left as it is.
 */
export async function writeArtifactAtLocation(
  location: Exclude<ArtifactsLocation, { kind: "unavailable" }>,
  relPath: string,
  content: string,
  options?: ArtifactWriteOptions & { abortSignal?: AbortSignal }
): Promise<void> {
  if (location.kind === "runtime") {
    await writeArtifactOnRuntime(location.runtime, location.dir, relPath, content, {
      abortSignal: options?.abortSignal,
      createOnly: options?.createOnly,
    });
    return;
  }
  await writeArtifactToDir(location.dir, relPath, content, {
    requireDescriptorPaths: location.containerWritable,
    createOnly: options?.createOnly,
  });
}

export async function getArtifactsCapabilities(
  context: ArtifactsContext,
  input: { workspaceId: string }
): Promise<ArtifactCapabilities> {
  assertArtifactsEnabled(context);
  const metadata = await context.workspaceService.getInfo(input.workspaceId);
  if (!metadata) return { agentBrowserAvailable: null };
  return getWorkspaceArtifactCapabilities(
    input.workspaceId,
    metadata,
    context.config.loadConfigOrDefault().projects
  );
}

/**
 * The capability probe of a workspace whose metadata the caller has. The tab and the turn-end
 * layout audit both call it, so they share one cache entry and one answer.
 */
export function getWorkspaceArtifactCapabilities(
  workspaceId: string,
  metadata: FrontendWorkspaceMetadata,
  projects: ProjectsConfig["projects"]
): Promise<ArtifactCapabilities> {
  return getArtifactCapabilities({
    workspaceId,
    // A recreated workspace on another runtime must not reuse the old answer.
    runtimeKey: JSON.stringify(metadata.runtimeConfig ?? null),
    createRuntime: () => createRuntimeForWorkspace(metadata),
    // Probe where and how the agent's bash tool runs, tool_env included.
    resolveCwd: (runtime) => resolveWorkspaceExecutionPath(metadata, runtime),
    trusted: isWorkspaceTrustedForSharedExecution(metadata, projects),
  });
}

export type AvailableArtifactsLocation = Exclude<ArtifactsLocation, { kind: "unavailable" }>;

/** Raw bytes of one file at an available location, capped. Runtime failures throw. */
export async function readArtifactBytesAtLocation(
  location: AvailableArtifactsLocation,
  relPath: string,
  maxBytes: number,
  abortSignal?: AbortSignal,
  options?: ArtifactReadOptions
): Promise<ArtifactBytesOutcome> {
  if (location.kind === "runtime") {
    return readArtifactBytesOnRuntime(
      location.runtime,
      location.dir,
      relPath,
      maxBytes,
      abortSignal,
      options
    );
  }
  return readArtifactBytesFromDir(location.dir, relPath, maxBytes, {
    ...options,
    requireDescriptorPaths: location.containerWritable,
  });
}
