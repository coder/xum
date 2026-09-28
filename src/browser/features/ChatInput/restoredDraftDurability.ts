import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { readPersistedChatAttachments } from "./draftAttachmentsStorage";

/**
 * Whether every part of a restore the composer just applied is in persisted storage (#4448).
 * Only then may the composer release the backend's held copy. Persisted-state writes swallow
 * storage failures, and oversized attachment drafts are kept in memory by design, so this reads
 * back what landed instead of trusting the setters: the exact merged text, each restored
 * attachment, and each note the review store added (`null` when the notes went to the
 * memory-only override instead). Review notes live in the backend review-state store, so the
 * caller additionally confirms restored note ids asynchronously (flush + server-acknowledged ids).
 */
export function isRestoredDraftDurable(params: {
  inputKey: string;
  expectedText: string;
  attachmentsKey: string;
  restoredAttachmentIds: readonly string[];
  restoredReviewIds: readonly string[] | null;
}): boolean {
  if (readPersistedState<string>(params.inputKey, "") !== params.expectedText) return false;
  const storedAttachmentIds = new Set(
    readPersistedChatAttachments(params.attachmentsKey).map(({ id }) => id)
  );
  if (!params.restoredAttachmentIds.every((id) => storedAttachmentIds.has(id))) return false;
  return params.restoredReviewIds !== null;
}
