import { useCallback, useEffect, useRef, useState } from "react";
import {
  subscribePersistedStateWrites,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
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

interface DraftState {
  text: string;
  attachments: ChatAttachment[];
}

interface UseComposerDraftOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  creationProjectPath: string;
  pendingDraftId?: string;
  attachedReviews: Review[];
  pushToast: (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
}

export function useComposerDraft(options: UseComposerDraftOptions) {
  const pendingScopeId = options.pendingDraftId?.trim().length
    ? getDraftScopeId(options.creationProjectPath, options.pendingDraftId)
    : getPendingScopeId(options.creationProjectPath);
  const scopeId = options.variant === "creation" ? pendingScopeId : (options.workspaceId ?? "");
  const inputKey = getInputKey(scopeId);
  const attachmentsKey = getInputAttachmentsKey(scopeId);
  const modelKey = getModelKey(
    options.variant === "creation" ? getProjectScopeId(options.creationProjectPath) : scopeId
  );
  const [input, setInput] = usePersistedState(inputKey, "", { listener: true });
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;

  const tooLargeToastKeyRef = useRef<string | null>(null);
  const selfWriteRef = useRef(false);
  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>(() =>
    readPersistedChatAttachments(attachmentsKey)
  );
  const persistAttachments = useCallback(
    (next: ChatAttachment[]) => {
      selfWriteRef.current = true;
      try {
        if (next.length === 0) {
          tooLargeToastKeyRef.current = null;
          updatePersistedState<ChatAttachment[] | undefined>(attachmentsKey, undefined);
        } else if (
          estimatePersistedChatAttachmentsChars(next) > MAX_PERSISTED_ATTACHMENT_DRAFT_CHARS
        ) {
          updatePersistedState<ChatAttachment[] | undefined>(attachmentsKey, undefined);
          if (tooLargeToastKeyRef.current !== attachmentsKey) {
            tooLargeToastKeyRef.current = attachmentsKey;
            options.pushToast({
              type: "error",
              message:
                "This draft attachment is too large to save. It will be lost when you switch workspaces or restart.",
              duration: 5000,
            });
          }
        } else {
          tooLargeToastKeyRef.current = null;
          updatePersistedState<ChatAttachment[] | undefined>(attachmentsKey, next);
        }
      } finally {
        selfWriteRef.current = false;
      }
    },
    [attachmentsKey, options.pushToast]
  );
  const setAttachments = useCallback(
    (value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])) => {
      setAttachmentsState((previous) => {
        const next = value instanceof Function ? value(previous) : value;
        persistAttachments(next);
        return next;
      });
    },
    [persistAttachments]
  );

  useEffect(() => {
    tooLargeToastKeyRef.current = null;
    setAttachmentsState(readPersistedChatAttachments(attachmentsKey));
  }, [attachmentsKey]);
  useEffect(
    () =>
      subscribePersistedStateWrites((event) => {
        if (event.key === attachmentsKey && !selfWriteRef.current) {
          setAttachmentsState(readPersistedChatAttachments(attachmentsKey));
        }
      }),
    [attachmentsKey]
  );

  const [draftReviews, setDraftReviews] = useState<ReviewNoteDataForDisplay[] | null>(null);
  const draftReviewIdsByValueRef = useRef(new WeakMap<ReviewNoteDataForDisplay, string>());
  const nextDraftReviewIdRef = useRef(0);
  const isDraftReviewData = (value: unknown): value is ReviewNoteDataForDisplay =>
    typeof value === "object" && value !== null;
  const getDraftReviewId = (review: ReviewNoteDataForDisplay): string => {
    const existingId = draftReviewIdsByValueRef.current.get(review);
    if (existingId) return existingId;
    const newId = "draft-review-" + nextDraftReviewIdRef.current++;
    draftReviewIdsByValueRef.current.set(review, newId);
    return newId;
  };
  const withDraftReview = (
    reviewId: string,
    update: (reviews: ReviewNoteDataForDisplay[], reviewIndex: number) => ReviewNoteDataForDisplay[]
  ) =>
    setDraftReviews((previous) => {
      if (previous === null) return previous;
      const reviewIndex = previous.findIndex(
        (review) => isDraftReviewData(review) && getDraftReviewId(review) === reviewId
      );
      return reviewIndex === -1 ? previous : update(previous, reviewIndex);
    });
  const removeDraftReview = (reviewId: string) =>
    withDraftReview(reviewId, (previous, reviewIndex) =>
      previous.filter((_, index) => index !== reviewIndex)
    );
  const updateDraftReviewNote = (reviewId: string, userNote: string) =>
    withDraftReview(reviewId, (previous, reviewIndex) => {
      const review = previous[reviewIndex];
      if (!review || review.userNote === userNote) return previous;
      const next = [...previous];
      const updatedReview = { ...review, userNote };
      draftReviewIdsByValueRef.current.set(updatedReview, reviewId);
      next[reviewIndex] = updatedReview;
      return next;
    });

  const reviewOverrideActive = draftReviews !== null;
  const draftReviewItems = (draftReviews ?? []).filter(isDraftReviewData);
  const reviewData = reviewOverrideActive
    ? draftReviewItems.length > 0
      ? draftReviewItems
      : undefined
    : options.attachedReviews.length > 0
      ? options.attachedReviews.map((review) => review.data)
      : undefined;
  const reviewIdsForCheck = reviewOverrideActive
    ? []
    : options.attachedReviews.map((review) => review.id);
  const reviewPanelItems: Review[] = reviewOverrideActive
    ? draftReviewItems.map((data) => ({
        id: getDraftReviewId(data),
        data,
        status: "attached",
        createdAt: 0,
      }))
    : options.attachedReviews;

  const getDraft = useCallback(
    (): DraftState => ({ text: input, attachments }),
    [input, attachments]
  );
  const setDraft = useCallback(
    (draft: DraftState) => {
      setInput(draft.text);
      setAttachments(draft.attachments);
    },
    [setAttachments, setInput]
  );
  const preEditDraftRef = useRef<DraftState>({ text: "", attachments: [] });
  const preEditReviewsRef = useRef<ReviewNoteDataForDisplay[] | null>(null);

  return {
    storageKeys: { inputKey, attachmentsKey, modelKey },
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
    removeDraftReview,
    updateDraftReviewNote,
  };
}
