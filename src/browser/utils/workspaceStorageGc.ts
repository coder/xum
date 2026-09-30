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
 * - Only keys of stable-format workspace ids are ever collected (see
 *   findOrphanedWorkspaceStorageKeys). Creation-draft scopes are never collected here; the
 *   creation-draft pass (creationDraftStorageGc.ts) checks them against the backend draft list.
 * - Keys are removed through removePersistedStateKeys so mounted usePersistedState consumers and
 *   write listeners observe the removal instead of writing a stale value back.
 *
 * Known limitation: localStorage is per origin. Two XUM roots served on the same origin over time
 * (e.g. dev servers reusing a port) share it, so GC under one root removes the other root's
 * workspace keys. Desktop remote windows use per-URL partitions and are unaffected.
 */
import { removePersistedStateKeys } from "@/browser/hooks/usePersistedState";
import { findOrphanedWorkspaceStorageKeys } from "@/common/constants/storage";
import { listWorkspaceStorageGcCandidateKeys } from "@/browser/utils/workspaceStorage";

let gcStarted = false;

export function resetWorkspaceStorageGcForTests(): void {
  gcStarted = false;
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

  const orphans = findOrphanedWorkspaceStorageKeys(
    candidateKeys,
    new Set(knownWorkspaceIds as string[])
  );
  removePersistedStateKeys(orphans);
  return orphans;
}
