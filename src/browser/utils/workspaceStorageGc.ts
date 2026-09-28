/**
 * Startup garbage collection of orphaned workspace-scoped localStorage keys.
 *
 * deleteWorkspaceStorage only runs in a tab that observes the delete, so keys of workspaces
 * deleted elsewhere (another tab, the CLI, a crash mid-delete, older builds that missed keys)
 * accumulate until they fill the origin quota. This pass removes them once per session.
 *
 * GC deletes user data when it is wrong, so every rule below fails closed:
 * - The caller runs it only after the startup metadata load succeeded (never after a failed load,
 *   never on later refreshes or config notifications).
 * - Known workspace ids come from the strict backend endpoint workspace.listKnownIdsForStorageGc,
 *   which fails instead of returning a partial set. The frontend cannot build that set itself:
 *   workspace.list swallows errors and substitutes fallback ids, legacy alias ids exist only in
 *   the strict backend build, and projects.list hides archived workspaces. Any endpoint failure
 *   removes nothing, and a failed run is not retried until the next reload.
 * - Candidate keys are snapshotted before the endpoint call. Workspace keys are only written after
 *   the backend returns a new id, i.e. after its config entry is persisted, so a workspace created
 *   after the snapshot either has no candidate keys or is in the backend set.
 * - Only stable-format workspace ids and exact creation-draft scopes are ever collected (see
 *   findOrphanedWorkspaceStorageKeys).
 *
 * Known limitation: localStorage is per origin. Two XUM roots served on the same origin over time
 * (e.g. dev servers reusing a port) share it, so GC under one root removes the other root's
 * workspace keys. Desktop remote windows use per-URL partitions and are unaffected.
 */
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import {
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
  findOrphanedWorkspaceStorageKeys,
  getDraftScopeId,
  listWorkspaceStorageGcCandidateKeys,
} from "@/common/constants/storage";

let gcStarted = false;

export function resetWorkspaceStorageGcForTests(): void {
  gcStarted = false;
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
  /** Every known workspace id from the backend; must reject rather than return a partial set. */
  listKnownWorkspaceIds: () => Promise<readonly string[]>;
}

/**
 * Run the once-per-session orphan GC. Resolves with the removed keys; rejects (removing nothing)
 * when the known-id set cannot be read.
 */
export async function collectOrphanedWorkspaceStorage(
  input: CollectOrphanedWorkspaceStorageInput
): Promise<string[]> {
  // Latch before any await so concurrent mounts cannot start a second pass.
  if (gcStarted) return [];
  gcStarted = true;

  const candidateKeys = listWorkspaceStorageGcCandidateKeys();
  if (candidateKeys.length === 0) return [];

  const knownWorkspaceIds: unknown = await input.listKnownWorkspaceIds();
  if (!Array.isArray(knownWorkspaceIds) || knownWorkspaceIds.some((id) => typeof id !== "string")) {
    throw new Error("Malformed known workspace id list; skipping workspace storage GC");
  }

  // Read drafts and remove in one synchronous pass: a draft created meanwhile writes its keys in
  // the same synchronous update that adds it to the drafts map, so no await may sit between
  // reading the map and removing keys.
  const orphans = findOrphanedWorkspaceStorageKeys(
    candidateKeys,
    new Set(knownWorkspaceIds as string[]),
    readLiveDraftScopeIds()
  );
  for (const key of orphans) {
    localStorage.removeItem(key);
  }
  return orphans;
}
