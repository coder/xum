import { useEffect, useRef, useState } from "react";
import {
  subscribePersistedStateWrites,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getPendingScopeId,
} from "@/common/constants/storage";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { Review } from "@/common/types/review";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";
import {
  estimatePersistedChatAttachmentsChars,
  MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS,
  readPersistedChatAttachments,
} from "./draftAttachmentsStorage";

interface UseComposerDraftOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  creationProjectPath: string;
  pendingDraftId?: string;
  attachedReviews: Review[];
  pushToast: (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
}

export function useComposerDraft(options: UseComposerDraftOptions) {
  const { attachedReviews, creationProjectPath, pendingDraftId, pushToast, variant, workspaceId } =
    options;
  const scopeId =
    variant === "workspace"
      ? (workspaceId ?? "")
      : pendingDraftId?.trim().length
        ? getDraftScopeId(creationProjectPath, pendingDraftId)
        : getPendingScopeId(creationProjectPath);
  const inputKey = getInputKey(scopeId);
  const attachmentsKey = getInputAttachmentsKey(scopeId);
  const [input, setInput] = usePersistedState(inputKey, "", { listener: true });
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  const tooLargeToastKeyRef = useRef<string | null>(null);
  const selfWriteRef = useRef(false);
  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() =>
    readPersistedChatAttachments(attachmentsKey)
  );
  const setAttachments = (
    value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
  ) =>
    setAttachmentsState((previous) => {
      const next = value instanceof Function ? value(previous) : value;
      const persists =
        next.length > 0 &&
        estimatePersistedChatAttachmentsChars(next) <= MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS;
      selfWriteRef.current = true;
      try {
        updatePersistedState<ChatAttachment[] | undefined>(
          attachmentsKey,
          persists ? next : undefined
        );
      } finally {
        selfWriteRef.current = false;
      }
      if (persists || next.length === 0) tooLargeToastKeyRef.current = null;
      else if (tooLargeToastKeyRef.current !== attachmentsKey) {
        tooLargeToastKeyRef.current = attachmentsKey;
        pushToast({
          type: "error",
          message:
            "This draft attachment is too large to save. It will be lost when you switch workspaces or restart.",
          duration: 5000,
        });
      }
      return next;
    });
  useEffect(() => {
    tooLargeToastKeyRef.current = null;
    setAttachmentsState(readPersistedChatAttachments(attachmentsKey));
    return subscribePersistedStateWrites((event) => {
      if (event.key === attachmentsKey && !selfWriteRef.current) {
        setAttachmentsState(readPersistedChatAttachments(attachmentsKey));
      }
    });
  }, [attachmentsKey]);
  const [draftReviews, setDraftReviews] = useState<ReviewNoteDataForDisplay[] | null>(null);
  const draftReviewIdsRef = useRef(new WeakMap<ReviewNoteDataForDisplay, string>());
  const nextDraftReviewIdRef = useRef(0);
  const isDraftReviewData = (value: unknown): value is ReviewNoteDataForDisplay =>
    typeof value === "object" && value !== null;
  const idForReview = (review: ReviewNoteDataForDisplay) => {
    const existingId = draftReviewIdsRef.current.get(review);
    if (existingId) return existingId;
    const newId = "draft-review-" + nextDraftReviewIdRef.current++;
    draftReviewIdsRef.current.set(review, newId);
    return newId;
  };
  const mutateDraftReview = (reviewId: string, userNote?: string) =>
    setDraftReviews((previous) => {
      if (previous === null) return previous;
      const index = previous.findIndex(
        (review) => isDraftReviewData(review) && idForReview(review) === reviewId
      );
      if (index === -1) return previous;
      if (userNote === undefined) return previous.filter((_, itemIndex) => itemIndex !== index);
      const review = previous[index];
      if (!review || review.userNote === userNote) return previous;
      const next = [...previous];
      next[index] = { ...review, userNote };
      draftReviewIdsRef.current.set(next[index], reviewId);
      return next;
    });
  const reviewOverrideActive = draftReviews !== null;
  const draftReviewItems = (draftReviews ?? []).filter(isDraftReviewData);
  const reviews = reviewOverrideActive
    ? draftReviewItems
    : attachedReviews.map((review) => review.data);
  const reviewData = reviews.length > 0 ? reviews : undefined;
  // Under an override, only notes folded in from the review store (prependRestoredReviews) keep
  // their store IDs; a send checks exactly those off, so they cannot reappear after it.
  const attachedReviewIds = new Set(attachedReviews.map(({ id }) => id));
  const reviewIdsForCheck = reviewOverrideActive
    ? draftReviewItems.map(idForReview).filter((id) => attachedReviewIds.has(id))
    : attachedReviews.map(({ id }) => id);
  const reviewPanelItems = reviewOverrideActive
    ? draftReviewItems.map((data) => ({
        id: idForReview(data),
        data,
        status: "attached" as const,
        createdAt: 0,
      }))
    : attachedReviews;
  /**
   * Put restored reviews (a queued message returned by Stop, #4431) in front of the composer's
   * current reviews, dropping and duplicating neither. Reviews shown from the review store move
   * into the override with their store IDs, so the send that carries them also checks them off.
   * `storeReviewsInFlight`: the store's attached notes belong to a send in flight (hidden until
   * it settles and checked off by it), so they are not part of the draft.
   */
  const prependRestoredReviews = (
    restored: ReviewNoteDataForDisplay[],
    storeReviewsInFlight: boolean
  ) => {
    if (restored.length === 0) return;
    setDraftReviews((previous) => {
      if (previous !== null) return [...restored, ...previous];
      const fromStore = storeReviewsInFlight
        ? []
        : attachedReviews.map((review) => {
            draftReviewIdsRef.current.set(review.data, review.id);
            return review.data;
          });
      return [...restored, ...fromStore];
    });
  };
  const getDraft = () => ({ text: input, attachments });
  const setDraft = (draft: { text: string; attachments: ChatAttachment[] }) => {
    setInput(draft.text);
    setAttachments(draft.attachments);
  };
  const preEditDraftRef = useRef<ReturnType<typeof getDraft>>({ text: "", attachments: [] });
  const preEditReviewsRef = useRef<ReviewNoteDataForDisplay[] | null>(null);
  return {
    storageKeys: { inputKey },
    input,
    setInput,
    latestInputValueRef,
    attachments,
    setAttachments,
    draftReviews,
    setDraftReviews,
    getDraft,
    setDraft,
    preEditDraftRef,
    preEditReviewsRef,
    reviewOverrideActive,
    reviewData,
    reviewIdsForCheck,
    reviewPanelItems,
    prependRestoredReviews,
    removeDraftReview: (reviewId: string) => mutateDraftReview(reviewId),
    updateDraftReviewNote: mutateDraftReview,
  };
}
