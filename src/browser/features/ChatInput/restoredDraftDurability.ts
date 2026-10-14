import type { DraftStore, DraftStoreScope } from "@/browser/stores/DraftStore";

/**
 * Whether the draft part of a restore the composer just applied is durable (#4448). Only then may
 * the composer release the backend's held copy; otherwise the "Not sent" banner stays next to the
 * composer's copy: a visible duplicate beats a loss.
 *
 * The draft (text + attachments) lives in the backend draft store: resolve true only after the
 * backend confirmed the write that holds each restored attachment. `restoredReviewIds` is `null`
 * when the restored notes went to the memory-only override, which is never durable. Notes that
 * reached the review store live in the backend review-state store, so the caller confirms them
 * separately (flush + server-acknowledged ids). Never rejects: a failed write reports "not
 * durable".
 */
export async function isRestoredDraftDurable(params: {
  draftStore: DraftStore;
  draftScope: DraftStoreScope;
  restoredAttachmentIds: readonly string[];
  restoredReviewIds: readonly string[] | null;
}): Promise<boolean> {
  if (params.restoredReviewIds === null) return false;
  if (params.draftScope.kind === "pending") return false;
  try {
    // Restored attachments may still be queued behind a payload load; apply them first so the
    // flush below writes them.
    await params.draftStore.ensurePayloads(params.draftScope);
    await params.draftStore.flush(params.draftScope);
  } catch {
    return false;
  }
  const storedAttachmentIds = new Set(
    params.draftStore.getAttachments(params.draftScope).map(({ id }) => id)
  );
  return params.restoredAttachmentIds.every((id) => storedAttachmentIds.has(id));
}
