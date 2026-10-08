import { useEffect, useRef, useState } from "react";
import {
  defaultCreationDraftScope,
  getDraftStore,
  useDraft,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { Review } from "@/common/types/review";
import { joinDraftText } from "@/common/utils/composerDraftText";
import { DRAFT_ID_PATTERN } from "@/constants/drafts";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";

interface UseComposerDraftOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  creationProjectPath: string;
  pendingDraftId?: string;
  attachedReviews: Review[];
  pushToast: (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
}

/**
 * The draft scope a composer edits. A creation composer without a (valid) draft id edits the
 * project's default creation draft, which the backend persists like any other. A workspace
 * composer that has no workspace id yet uses the memory-only pending scope (see
 * PendingDraftScope), because it must never write to the backend.
 */
export function getComposerDraftScope(options: {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  creationProjectPath: string;
  pendingDraftId?: string;
}): DraftStoreScope {
  if (options.variant === "workspace") {
    return options.workspaceId
      ? { kind: "workspace", workspaceId: options.workspaceId }
      : { kind: "pending", projectPath: "" };
  }
  const draftId = options.pendingDraftId?.trim() ?? "";
  return DRAFT_ID_PATTERN.test(draftId)
    ? { kind: "creation", projectPath: options.creationProjectPath, draftId }
    : defaultCreationDraftScope(options.creationProjectPath);
}

/** An open edit's text and files. They live only in the composer that opened the edit. */
export interface EditDraft {
  id: string;
  text: string;
  attachments: ChatAttachment[];
}

/** Appends an edit's text after the draft in `scope`, and its files whose ids are missing. */
function appendToStoredDraft(scope: DraftStoreScope, snapshot: Omit<EditDraft, "id">) {
  const store = getDraftStore();
  if (snapshot.text.trim())
    store.setText(scope, (current) => joinDraftText(current, snapshot.text));
  if (snapshot.attachments.length === 0) return;
  store.setAttachments(scope, (current) => {
    const ids = new Set(current.map(({ id }) => id));
    return [...current, ...snapshot.attachments.filter(({ id }) => !ids.has(id))];
  });
}

export function useComposerDraft(options: UseComposerDraftOptions) {
  const { attachedReviews, pushToast } = options;
  const draftStore = getDraftStore();
  const draftScope = getComposerDraftScope(options);
  // Drafts live in the in-memory DraftStore, persisted to the backend in the background. The
  // rendered text never waits for (or depends on) a storage write succeeding (issue 5006).
  const draft = useDraft(draftScope);
  const input = draft.text;
  const attachments = draft.attachments;
  const setInput = (value: string | ((previous: string) => string)) =>
    draftStore.setText(draftScope, value);
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  // Synchronous: the store applies the change before returning, so a Stop restore can flush it
  // right after this call (#4448) even if the composer unmounts before the next render.
  const setAttachments = (
    value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
  ) => draftStore.setAttachments(draftScope, value);
  // The open edit's buffer: an edit never reaches the shared, persisted draft, so a reload or a
  // second window keeps the unsent draft (#5672, #5571). The ref is the live value.
  const [editDraft, setEditDraftState] = useState<EditDraft | null>(null);
  const editDraftRef = useRef<EditDraft | null>(null);
  const writeEditDraft = (next: EditDraft | null) => {
    editDraftRef.current = next;
    setEditDraftState(next);
  };
  const updateEditDraft = (update: (current: EditDraft) => EditDraft) => {
    if (editDraftRef.current) writeEditDraft(update(editDraftRef.current));
  };
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;
  const { variant, workspaceId, creationProjectPath, pendingDraftId } = options;
  useEffect(() => {
    const scope = getComposerDraftScope({
      variant,
      workspaceId,
      creationProjectPath,
      pendingDraftId,
    });
    // Hydration carries attachment metadata only; fetch this draft's payloads once it is shown.
    getDraftStore()
      .ensurePayloads(scope)
      .catch((error: unknown) => console.warn("Failed to load draft attachments:", error));
    // A persistent save failure (e.g. a draft over the size limit) is surfaced once per streak.
    // A failure after unmount stays unreported, so the next composer of this scope surfaces it.
    const unsubscribeSaveErrors = getDraftStore().subscribeSaveErrors(scope, (message) => {
      pushToastRef.current({
        type: "error",
        message: `Failed to save draft: ${message}`,
        duration: 5000,
      });
    });
    return () => {
      unsubscribeSaveErrors();
      // A switch or transcript-only unmounts the composer with its edit open: no text is lost.
      if (editDraftRef.current) appendToStoredDraft(scope, editDraftRef.current);
      editDraftRef.current = null;
      // Leaving this draft (workspace switch, route change, unmount): write it now rather than
      // after the debounce. A failure keeps the change in the store, which retries it.
      getDraftStore()
        .flush(scope)
        .catch(() => undefined);
    };
  }, [variant, workspaceId, creationProjectPath, pendingDraftId]);
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
  const reviewIdsForCheck = reviewOverrideActive ? [] : attachedReviews.map(({ id }) => id);
  const reviewPanelItems = reviewOverrideActive
    ? draftReviewItems.map((data) => ({
        id: idForReview(data),
        data,
        status: "attached" as const,
        createdAt: 0,
      }))
    : attachedReviews;
  const getDraft = () => ({ text: input, attachments });
  const setDraft = (next: { text: string; attachments: ChatAttachment[] }) => {
    setInput(next.text);
    setAttachments(next.attachments);
  };
  // The only edit operations that write the normal draft: after it, once.
  const consumeEditDraftIntoDraft = () => {
    if (editDraftRef.current) appendToStoredDraft(draftScope, editDraftRef.current);
    writeEditDraft(null);
  };
  return {
    draftScope,
    editDraft,
    getEditDraft: () => editDraftRef.current,
    beginEditDraft: writeEditDraft,
    setEditText: (value: string | ((previous: string) => string)) =>
      updateEditDraft((current) => ({
        ...current,
        text: typeof value === "function" ? value(current.text) : value,
      })),
    setEditAttachments: (
      value: ChatAttachment[] | ((previous: ChatAttachment[]) => ChatAttachment[])
    ) =>
      updateEditDraft((current) => ({
        ...current,
        attachments: typeof value === "function" ? value(current.attachments) : value,
      })),
    dropEditDraft: () => writeEditDraft(null),
    consumeEditDraftIntoDraft,
    appendSnapshotToDraft: (snapshot: Omit<EditDraft, "id">) =>
      appendToStoredDraft(draftScope, snapshot),
    input,
    setInput,
    payloadsLoaded: draft.payloadsLoaded,
    unresolvedSendCount: draft.unresolvedSendCount,
    latestInputValueRef,
    attachments,
    setAttachments,
    draftReviews,
    setDraftReviews,
    getDraft,
    setDraft,
    reviewOverrideActive,
    reviewData,
    reviewIdsForCheck,
    reviewPanelItems,
    removeDraftReview: (reviewId: string) => mutateDraftReview(reviewId),
    updateDraftReviewNote: mutateDraftReview,
  };
}
