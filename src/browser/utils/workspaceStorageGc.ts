/**
 * Startup garbage collection of orphaned workspace-scoped localStorage keys.
 *
 * deleteWorkspaceStorage only runs in a tab that observes the delete, so keys of workspaces
 * deleted elsewhere (another tab, the CLI, a crash mid-delete, older builds that missed keys)
 * accumulate until they fill the origin quota. This pass removes them once per session.
 *
 * GC deletes user data when it is wrong, so every rule below fails closed:
 * - It only runs after the startup metadata load succeeded (never after a failed load, never on
 *   later refreshes or config notifications) and never when that load returned no workspaces,
 *   because workspace.list swallows backend errors and resolves [].
 * - Candidate keys are snapshotted before the metadata load, so keys written for workspaces
 *   created later in this session are never candidates.
 * - A key is removed only when its id is unknown to active metadata, archived metadata, the
 *   project config (which still lists workspaces the backend hides, e.g. multi-project ones while
 *   that experiment is off) and the metadata this tab currently holds. The backend reports no
 *   per-project metadata failures, so the project config ids (read straight from config.json)
 *   are the backstop when a metadata build drops or re-identifies an active workspace. An empty
 *   project list aborts the pass, because it means the config read behind both lists failed.
 * - Only stable-format workspace ids and exact creation-draft scopes are ever collected (see
 *   findOrphanedWorkspaceStorageKeys).
 */
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  findOrphanedWorkspaceStorageKeys,
  getDraftScopeId,
  listWorkspaceScopedStorageKeys,
  removeWorkspaceStorageKeys,
} from "@/common/constants/storage";
import type { ProjectConfig } from "@/common/types/project";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

let gcStarted = false;

export function resetWorkspaceStorageGcForTests(): void {
  gcStarted = false;
}

/**
 * Snapshot candidate keys before the startup metadata load. Returns null once GC already ran in
 * this session, so callers can skip the work.
 */
export function snapshotWorkspaceStorageForGc(): string[] | null {
  return gcStarted ? null : listWorkspaceScopedStorageKeys();
}

/**
 * Draft scope ids of every draft in the persisted drafts map, or null when the map is missing or
 * unreadable (then draft keys are never collected). Entries are read leniently: any entry with a
 * string draftId protects its keys, even if the rest of the entry is malformed.
 */
function readLiveDraftScopeIds(): Set<string> | null {
  const stored = readPersistedState<unknown>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, null);
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;

  const scopeIds = new Set<string>();
  for (const [projectPath, drafts] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(drafts)) continue;
    for (const draft of drafts as unknown[]) {
      const draftId = (draft as { draftId?: unknown } | null)?.draftId;
      if (typeof draftId === "string") scopeIds.add(getDraftScopeId(projectPath, draftId));
    }
  }
  return scopeIds;
}

export interface CollectOrphanedWorkspaceStorageInput {
  /** From snapshotWorkspaceStorageForGc(), taken before the metadata load. */
  candidateKeys: readonly string[];
  /** Result of the successful startup metadata load. */
  activeWorkspaces: readonly FrontendWorkspaceMetadata[];
  listArchivedWorkspaces: () => Promise<readonly FrontendWorkspaceMetadata[]>;
  listProjects: () => Promise<ReadonlyArray<[string, ProjectConfig]>>;
  /** Workspace ids this tab holds right now (covers workspaces created during GC). */
  getCurrentWorkspaceIds: () => Iterable<string>;
}

/** Run the once-per-session orphan GC. Resolves with the removed keys. */
export async function collectOrphanedWorkspaceStorage(
  input: CollectOrphanedWorkspaceStorageInput
): Promise<string[]> {
  if (gcStarted) return [];
  gcStarted = true;

  if (input.activeWorkspaces.length === 0) return [];

  const knownWorkspaceIds = new Set(input.activeWorkspaces.map((workspace) => workspace.id));
  for (const id of input.getCurrentWorkspaceIds()) knownWorkspaceIds.add(id);

  // Cheap first pass against active metadata; skip the extra backend calls when nothing is stale.
  const tentativeOrphans = findOrphanedWorkspaceStorageKeys(
    input.candidateKeys,
    knownWorkspaceIds,
    readLiveDraftScopeIds()
  );
  if (tentativeOrphans.length === 0) return [];

  const [archivedWorkspaces, projects] = await Promise.all([
    input.listArchivedWorkspaces(),
    input.listProjects(),
  ]);
  // Both lists are built from config.json and resolve empty instead of throwing when the backend
  // cannot read it (workspace.list swallows errors, loadConfigOrDefault falls back to defaults).
  // Active workspaces exist, so an empty project list means that read failed, and then an empty
  // archived list proves nothing either. projects.list omits archived workspaces, so it cannot
  // stand in for the archived list.
  if (projects.length === 0) return [];
  for (const workspace of archivedWorkspaces) knownWorkspaceIds.add(workspace.id);
  for (const [, project] of projects) {
    for (const workspace of project.workspaces) {
      if (workspace.id) knownWorkspaceIds.add(workspace.id);
    }
  }
  for (const id of input.getCurrentWorkspaceIds()) knownWorkspaceIds.add(id);

  // Re-read drafts and remove in one synchronous pass: a draft created meanwhile writes its keys
  // in the same synchronous update that adds it to the drafts map, so no await may sit between
  // reading the map and removing keys.
  const orphans = findOrphanedWorkspaceStorageKeys(
    tentativeOrphans,
    knownWorkspaceIds,
    readLiveDraftScopeIds()
  );
  removeWorkspaceStorageKeys(orphans);
  return orphans;
}
