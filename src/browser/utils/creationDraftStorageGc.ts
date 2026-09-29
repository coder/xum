/**
 * Startup garbage collection of orphaned creation-draft settings keys (#5053).
 *
 * Creation drafts keep scope-bound settings in localStorage (`model:__draft__/<project>/<id>`,
 * `workspaceNameState:…`); their text and attachments live on the backend. Only a local delete
 * or project removal cleans those keys, but the draft list is backend-owned and shared by every
 * origin (#5225): a draft deleted or turned into a workspace in another window, or a project
 * removed while this origin was closed, leaves them behind. This pass removes them once per
 * session.
 *
 * GC deletes user data when it is wrong, so every rule fails closed:
 * - The list comes from the strict backend endpoint drafts.getList, which rejects when list.json
 *   cannot be read (the subscription snapshot shows an empty list then). Any failure removes
 *   nothing and is not retried until the next reload.
 * - Candidate keys are snapshotted before the request, so keys of a draft created meanwhile are
 *   never candidates.
 * - `isLive` keeps drafts the backend does not list yet: optimistic rows whose list write is
 *   unconfirmed, legacy rows shown while their import is pending, and the routed draft.
 * - Only registered draft-scope keys of listable draft ids are candidates (never the default
 *   composer's fixed id, pending/project/global scopes or workspace keys).
 * - Keys are removed through removePersistedStateKeys, so mounted consumers observe the removal.
 */
import {
  listPersistedStateKeys,
  removePersistedStateKeys,
} from "@/browser/hooks/usePersistedState";
import {
  findOrphanedCreationDraftStorageKeys,
  isCreationDraftStorageGcCandidateKey,
} from "@/common/constants/storage";
import type { DraftList } from "@/common/orpc/schemas/drafts";

let gcStarted = false;

export function resetCreationDraftStorageGcForTests(): void {
  gcStarted = false;
}

export interface CollectOrphanedCreationDraftStorageInput {
  /** The backend creation draft list; must reject rather than return a partial list. */
  listCreationDrafts: () => Promise<DraftList>;
  /** Drafts to keep although the backend does not list them (yet). */
  isLive: (projectPath: string, draftId: string) => boolean;
}

/** Run the once-per-session pass. Resolves with the removed keys; rejects removing nothing. */
export async function collectOrphanedCreationDraftStorage(
  input: CollectOrphanedCreationDraftStorageInput
): Promise<string[]> {
  // Latch before any await so concurrent callers cannot start a second pass.
  if (gcStarted) return [];
  gcStarted = true;

  const candidateKeys = listPersistedStateKeys([""]).filter(isCreationDraftStorageGcCandidateKey);
  if (candidateKeys.length === 0) return [];

  const { entries } = await input.listCreationDrafts();
  const listed = new Set(entries.map(({ projectPath, draftId }) => `${projectPath}\0${draftId}`));
  const orphans = findOrphanedCreationDraftStorageKeys(
    candidateKeys,
    (projectPath, draftId) =>
      listed.has(`${projectPath}\0${draftId}`) || input.isLive(projectPath, draftId)
  );
  removePersistedStateKeys(orphans);
  return orphans;
}
