/**
 * Artifacts route operations (Artifacts tab, experiment: "artifacts").
 *
 * Today only local/worktree workspaces have a scratch dir, and it lives on this host,
 * so reads use the host filesystem. Remote runtimes report `available: false` until
 * their runtime-side scratch dir exists; `resolveArtifactsLocation` is the seam where
 * that lands.
 */
import { ORPCError } from "@orpc/server";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ArtifactListing } from "@/common/orpc/schemas/artifacts";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ORPCContext } from "@/node/orpc/context";
import { getRuntimeType } from "@/node/runtime/initHook";
import { getWorkspaceScratchDir } from "@/node/runtime/workspaceScratchDir";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/attachmentLimits";
import {
  getArtifactsDir,
  listArtifactsInDir,
  readArtifactFromDir,
  type ArtifactReadOutcome,
} from "./artifactStore";

type ArtifactsContext = Pick<ORPCContext, "experimentsService" | "workspaceService" | "config">;

/** Same cap as attach_file, so anything the agent can attach can also be previewed. */
export const MAX_ARTIFACT_READ_BYTES = MAX_ATTACH_FILE_SIZE_BYTES;

export const ARTIFACTS_UNAVAILABLE_REASON =
  "Artifacts are not available on this runtime yet. They work in local and worktree workspaces.";

function assertArtifactsEnabled(context: ArtifactsContext): void {
  if (!context.experimentsService.isExperimentEnabled(EXPERIMENT_IDS.ARTIFACTS)) {
    throw new ORPCError("BAD_REQUEST", { message: "Artifacts are disabled" });
  }
}

type ArtifactsLocation = { kind: "host"; dir: string } | { kind: "unavailable"; reason: string };

export function resolveArtifactsLocation(
  sessionsDir: string,
  workspaceId: string,
  metadata: Pick<WorkspaceMetadata, "runtimeConfig">
): ArtifactsLocation {
  const runtimeType = getRuntimeType(metadata.runtimeConfig);
  // Mirrors turnRequestBuilder: only local/worktree commands run on this host, where
  // the session-scoped scratch dir lives.
  if (runtimeType === "local" || runtimeType === "worktree") {
    return { kind: "host", dir: getArtifactsDir(getWorkspaceScratchDir(sessionsDir, workspaceId)) };
  }
  return { kind: "unavailable", reason: ARTIFACTS_UNAVAILABLE_REASON };
}

async function resolveForWorkspace(
  context: ArtifactsContext,
  workspaceId: string
): Promise<ArtifactsLocation | null> {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) return null;
  return resolveArtifactsLocation(context.config.sessionsDir, workspaceId, metadata);
}

export async function listArtifacts(
  context: ArtifactsContext,
  input: { workspaceId: string }
): Promise<{ success: true; data: ArtifactListing } | { success: false; error: string }> {
  assertArtifactsEnabled(context);
  const location = await resolveForWorkspace(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") {
    return { success: true, data: { available: false, reason: location.reason } };
  }
  const { entries, truncated } = await listArtifactsInDir(location.dir);
  return { success: true, data: { available: true, dir: location.dir, entries, truncated } };
}

export async function readArtifact(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string }
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  const location = await resolveForWorkspace(context, input.workspaceId);
  if (!location) return { success: false, error: `Workspace not found: ${input.workspaceId}` };
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  return readArtifactFromDir(location.dir, input.path, MAX_ARTIFACT_READ_BYTES);
}
