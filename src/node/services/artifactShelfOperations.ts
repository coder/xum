import * as path from "path";
import type { ArtifactShelfListing, ArtifactShelfScope } from "@/common/orpc/schemas/artifacts";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { resolveMemoryProjectIdentity } from "@/node/services/memoryService";
import {
  getArtifactShelfRoot,
  getShelfScopeDir,
  listShelfScope,
  MAX_SHELF_FILE_BYTES,
  pinToShelf,
  readShelfEntry,
  unpinFromShelf,
} from "./artifactShelf";
import {
  buildArtifactReadResult,
  parseArtifactRelativePath,
  tooLargeArtifactResult,
  type ArtifactReadOutcome,
} from "./artifactStore";
import {
  assertArtifactsEnabled,
  resolveForWorkspace,
  unreachableError,
  type ArtifactsContext,
  type AvailableArtifactsLocation,
} from "./artifactsOperations";
import { probeArtifactFile } from "./artifactPublishOperations";
import { describeArtifact } from "./artifactRecordStore";

/**
 * Shelf operations shared by the oRPC routes and the agent tools. The shelf is host-local and
 * keyed by project identity, so every workspace of a project (any runtime) sees the same entries.
 */

type Outcome<T> = { success: true; data: T } | { success: false; error: string };

/** Copy the artifact's current bytes to a shelf scope (an agent pin or a user pin). */
export async function pinArtifactToShelf(params: {
  shelfRoot: string;
  projectIdentity: string;
  scope: ArtifactShelfScope;
  sessionDir: string;
  location: AvailableArtifactsLocation;
  workspaceId: string;
  relPath: string;
  pinnedBy: "agent" | "user";
  abortSignal?: AbortSignal;
  nowMs?: number;
}): Promise<Outcome<{ name: string }>> {
  const scopeDir = getShelfScopeDir(params.shelfRoot, params.scope, params.projectIdentity);
  if (typeof scopeDir !== "string") return { success: false, error: scopeDir.error };
  let probe: Awaited<ReturnType<typeof probeArtifactFile>>;
  try {
    probe = await probeArtifactFile(params.location, params.relPath, params.abortSignal);
  } catch (error) {
    return unreachableError(error);
  }
  if (!probe.success) return probe;
  if (probe.bytes == null) {
    return {
      success: false,
      error: `Artifact is ${probe.size} bytes; shelf files are capped at ${MAX_SHELF_FILE_BYTES} bytes`,
    };
  }
  const { title, kind } = await describeArtifact(params.sessionDir, params.relPath);
  const pinned = await pinToShelf({
    shelfRoot: params.shelfRoot,
    scopeDir,
    relPath: params.relPath,
    bytes: probe.bytes,
    meta: {
      sourceWorkspaceId: params.workspaceId,
      title,
      kind,
      pinnedAtMs: params.nowMs ?? Date.now(),
      pinnedBy: params.pinnedBy,
    },
  });
  return pinned.success ? { success: true, data: { name: pinned.name } } : pinned;
}

/** Both scopes as seen from one project identity ("" = multi-project: no project shelf). */
export async function listShelf(
  shelfRoot: string,
  projectIdentity: string
): Promise<ArtifactShelfListing> {
  const projectDir = getShelfScopeDir(shelfRoot, "project", projectIdentity);
  const globalDir = getShelfScopeDir(shelfRoot, "global", projectIdentity);
  if (typeof globalDir !== "string") throw new Error("global shelf always has a directory");
  const [project, global] = await Promise.all([
    typeof projectDir === "string" ? listShelfScope(shelfRoot, projectDir, "project") : null,
    listShelfScope(shelfRoot, globalDir, "global"),
  ]);
  return {
    project:
      project != null
        ? { available: true, entries: project }
        : { available: false, reason: typeof projectDir === "string" ? "" : projectDir.error },
    global,
  };
}

/** Read one entry as an ArtifactReadResult (path = entry file name, kind from the pin). */
export async function readShelf(
  shelfRoot: string,
  projectIdentity: string,
  scope: ArtifactShelfScope,
  name: string,
  maxBytes: number
): Promise<ArtifactReadOutcome> {
  const scopeDir = getShelfScopeDir(shelfRoot, scope, projectIdentity);
  if (typeof scopeDir !== "string") return { success: false, error: scopeDir.error };
  const read = await readShelfEntry(shelfRoot, scopeDir, name, maxBytes);
  switch (read.status) {
    case "missing":
      return { success: false, error: `Shelf entry not found: ${name}` };
    case "too_large":
      return {
        success: true,
        data: tooLargeArtifactResult(
          read.meta.file,
          read.size,
          read.modifiedMs,
          maxBytes,
          read.meta.kind
        ),
      };
    case "ok":
      return {
        success: true,
        data: buildArtifactReadResult(
          read.meta.file,
          read.bytes,
          read.modifiedMs,
          maxBytes,
          read.meta.kind
        ),
      };
  }
}

async function workspaceShelfContext(
  context: ArtifactsContext,
  workspaceId: string
): Promise<{ shelfRoot: string; projectIdentity: string; sessionDir: string } | null> {
  const metadata = await context.workspaceService.getInfo(workspaceId);
  if (!metadata) return null;
  return {
    shelfRoot: getArtifactShelfRoot(context.config.rootDir),
    projectIdentity: resolveMemoryProjectIdentity(metadata as WorkspaceMetadata),
    sessionDir: path.join(context.config.sessionsDir, workspaceId),
  };
}

const notFound = (workspaceId: string) => ({
  success: false as const,
  error: `Workspace not found: ${workspaceId}`,
});

export async function listShelfRoute(
  context: ArtifactsContext,
  input: { workspaceId: string }
): Promise<Outcome<ArtifactShelfListing>> {
  assertArtifactsEnabled(context);
  const ctx = await workspaceShelfContext(context, input.workspaceId);
  if (!ctx) return notFound(input.workspaceId);
  return { success: true, data: await listShelf(ctx.shelfRoot, ctx.projectIdentity) };
}

export async function readShelfRoute(
  context: ArtifactsContext,
  input: { workspaceId: string; scope: ArtifactShelfScope; name: string },
  maxBytes: number
): Promise<ArtifactReadOutcome> {
  assertArtifactsEnabled(context);
  const ctx = await workspaceShelfContext(context, input.workspaceId);
  if (!ctx) return notFound(input.workspaceId);
  return readShelf(ctx.shelfRoot, ctx.projectIdentity, input.scope, input.name, maxBytes);
}

export async function pinToShelfRoute(
  context: ArtifactsContext,
  input: { workspaceId: string; path: string; scope: ArtifactShelfScope }
): Promise<Outcome<{ name: string }>> {
  assertArtifactsEnabled(context);
  const ctx = await workspaceShelfContext(context, input.workspaceId);
  if (!ctx) return notFound(input.workspaceId);
  const segments = parseArtifactRelativePath(input.path);
  if (typeof segments === "string") return { success: false, error: segments };
  const location = await resolveForWorkspace(context, input.workspaceId, undefined);
  if (!location) return notFound(input.workspaceId);
  if (location.kind === "unavailable") return { success: false, error: location.reason };
  return pinArtifactToShelf({
    ...ctx,
    scope: input.scope,
    location,
    workspaceId: input.workspaceId,
    relPath: segments.join("/"),
    pinnedBy: "user",
  });
}

export async function unpinShelfRoute(
  context: ArtifactsContext,
  input: {
    workspaceId: string;
    scope: ArtifactShelfScope;
    name: string;
    expectedPinnedAtMs: number;
  }
): Promise<Outcome<void>> {
  assertArtifactsEnabled(context);
  const ctx = await workspaceShelfContext(context, input.workspaceId);
  if (!ctx) return notFound(input.workspaceId);
  const scopeDir = getShelfScopeDir(ctx.shelfRoot, input.scope, ctx.projectIdentity);
  if (typeof scopeDir !== "string") return { success: false, error: scopeDir.error };
  const removed = await unpinFromShelf(
    ctx.shelfRoot,
    scopeDir,
    input.name,
    input.expectedPinnedAtMs
  );
  return removed.success ? { success: true, data: undefined } : removed;
}
