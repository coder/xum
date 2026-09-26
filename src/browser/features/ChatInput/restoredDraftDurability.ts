import { readPersistedState } from "@/browser/hooks/usePersistedState";
import type { ReviewsState } from "@/common/types/review";
import { readPersistedChatAttachments } from "./draftAttachmentsStorage";

/**
 * Whether every part of a restore the composer just applied is in persisted storage (#4448).
 * Only then may the composer release the backend's held copy. Persisted-state writes swallow
 * storage failures, and oversized attachment drafts are kept in memory by design, so this reads
 * back what landed instead of trusting the setters: the exact merged text, each restored
 * attachment, and each note the review store added (`null` when the notes went to the
 * memory-only override instead).
 */
export function isRestoredDraftDurable(params: {
  inputKey: string;
  expectedText: string;
  attachmentsKey: string;
  restoredAttachmentIds: readonly string[];
  reviewsKey: string;
  restoredReviewIds: readonly string[] | null;
}): boolean {
  if (readPersistedState<string>(params.inputKey, "") !== params.expectedText) return false;
  const storedAttachmentIds = new Set(
    readPersistedChatAttachments(params.attachmentsKey).map(({ id }) => id)
  );
  if (!params.restoredAttachmentIds.every((id) => storedAttachmentIds.has(id))) return false;
  if (params.restoredReviewIds === null) return false;
  if (params.restoredReviewIds.length === 0) return true;
  const storedReviews = readPersistedState<ReviewsState | null>(params.reviewsKey, null)?.reviews;
  return params.restoredReviewIds.every((id) => storedReviews?.[id] != null);
}
