import { useEffect, useRef, useState, type SetStateAction } from "react";
import {
  subscribePersistedStateWrites,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getInputReviewsKey,
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
  // The latest attachments, including writes React has not rendered yet (see setAttachments).
  const latestAttachmentsRef = useRef(attachments);
  const setAttachments = (
    value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
  ) => {
    // Computed and stored now, not in a React state updater: an updater runs only when this
    // composer next renders, so a composer unmounted first (a workspace switch in the same batch
    // as an unsent-input restoration, which is acknowledged as soon as it is applied) would never
    // store the restored attachments.
    const next = value instanceof Function ? value(latestAttachmentsRef.current) : value;
    latestAttachmentsRef.current = next;
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
    setAttachmentsState(next);
  };
  useEffect(() => {
    const loadAttachments = () => {
      latestAttachmentsRef.current = readPersistedChatAttachments(attachmentsKey);
      setAttachmentsState(latestAttachmentsRef.current);
    };
    tooLargeToastKeyRef.current = null;
    loadAttachments();
    return subscribePersistedStateWrites((event) => {
      if (event.key === attachmentsKey && !selfWriteRef.current) {
        loadAttachments();
      }
    });
  }, [attachmentsKey]);
  // The review-note override is draft state like the text: a restored unsent message's reviews
  // must survive the composer remounting (switching workspaces away and back), because the
  // restoration is acknowledged — and the backend copy dropped — as soon as it is applied. The
  // persisted setter writes storage synchronously, so the override is remount-safe before that
  // acknowledgement. null (key absent) = no override; [] = the user cleared the restored notes.
  const [storedDraftReviews, setStoredDraftReviews] = usePersistedState<
    ReviewNoteDataForDisplay[] | null
  >(getInputReviewsKey(scopeId), null, { listener: true });
  const isDraftReviewData = (value: unknown): value is ReviewNoteDataForDisplay =>
    typeof value === "object" && value !== null;
  // Self-heal a malformed stored value instead of bricking the composer: a non-array reads as no
  // override and non-object items are dropped. A valid value keeps its reference.
  const asDraftReviews = (value: unknown): ReviewNoteDataForDisplay[] | null => {
    if (!Array.isArray(value)) return null;
    return value.every(isDraftReviewData) ? value : value.filter(isDraftReviewData);
  };
  const draftReviews = asDraftReviews(storedDraftReviews);
  const setDraftReviews = (value: SetStateAction<ReviewNoteDataForDisplay[] | null>) =>
    setStoredDraftReviews((previous) =>
      value instanceof Function ? value(asDraftReviews(previous)) : value
    );
  // Each write re-parses the stored notes, so object identity does not survive it: a draft
  // note's id is its position.
  const idForIndex = (index: number) => "draft-review-" + index;
  const mutateDraftReview = (reviewId: string, userNote?: string) =>
    setDraftReviews((previous) => {
      if (previous === null) return previous;
      const index = previous.findIndex((_, itemIndex) => idForIndex(itemIndex) === reviewId);
      if (index === -1) return previous;
      if (userNote === undefined) return previous.filter((_, itemIndex) => itemIndex !== index);
      const review = previous[index];
      if (!review || review.userNote === userNote) return previous;
      const next = [...previous];
      next[index] = { ...review, userNote };
      return next;
    });
  const reviewOverrideActive = draftReviews !== null;
  const draftReviewItems = draftReviews ?? [];
  const reviews = reviewOverrideActive
    ? draftReviewItems
    : attachedReviews.map((review) => review.data);
  const reviewData = reviews.length > 0 ? reviews : undefined;
  const reviewIdsForCheck = reviewOverrideActive ? [] : attachedReviews.map(({ id }) => id);
  const reviewPanelItems = reviewOverrideActive
    ? draftReviewItems.map((data, index) => ({
        id: idForIndex(index),
        data,
        status: "attached" as const,
        createdAt: 0,
      }))
    : attachedReviews;
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
    removeDraftReview: (reviewId: string) => mutateDraftReview(reviewId),
    updateDraftReviewNote: mutateDraftReview,
  };
}
