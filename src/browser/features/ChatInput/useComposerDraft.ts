import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  defaultCreationDraftScope,
  getDraftStore,
  useDraft,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { Review } from "@/common/types/review";
import { DRAFT_ID_PATTERN } from "@/constants/drafts";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";

interface UseComposerDraftOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  creationProjectPath: string;
  pendingDraftId?: string;
  /** The message being edited, if any: its text lives in the edit buffer below. */
  editMessageId?: string;
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

/** The open edit's text and attachments. Memory only: see useComposerDraft. */
interface EditDraft {
  editId: string;
  text: string;
  attachments: ChatAttachment[];
}

type Update<T> = T | ((previous: T) => T);
const applyUpdate = <T>(value: Update<T>, previous: T): T =>
  typeof value === "function" ? (value as (previous: T) => T)(previous) : value;

export function useComposerDraft(options: UseComposerDraftOptions) {
  const { attachedReviews, pushToast } = options;
  const draftStore = getDraftStore();
  const draftScope = getComposerDraftScope(options);
  // Drafts live in the in-memory DraftStore, persisted to the backend in the background. The
  // rendered text never waits for (or depends on) a storage write succeeding (issue 5006).
  const draft = useDraft(draftScope);
  // While a message is edited, the composer edits this buffer instead of the draft: the edit
  // text stays in this window's memory, so a reload keeps the unsent draft (#5672) and another
  // window never shows the edit (#5571). A reload drops the edit; that is the chosen tradeoff.
  // The ref is the live copy for writes that run after an await; renders read the state.
  const [editDraft, setEditDraftState] = useState<EditDraft | null>(null);
  const editDraftRef = useRef<EditDraft | null>(null);
  const editIdRef = useRef(options.editMessageId);
  useLayoutEffect(() => {
    editIdRef.current = options.editMessageId;
  });
  const writeEditDraft = (next: EditDraft | null) => {
    editDraftRef.current = next;
    setEditDraftState(next);
  };
  // Only the open edit's buffer counts. One left behind by an edit that ended without settling
  // (its row was replaced, a workspace switch) is ignored and discarded like a cancelled edit.
  const liveEditDraft = () => {
    const current = editDraftRef.current;
    return current !== null && current.editId === editIdRef.current ? current : null;
  };
  const editActive = editDraft !== null && editDraft.editId === options.editMessageId;
  const input = editActive ? editDraft.text : draft.text;
  const attachments = editActive ? editDraft.attachments : draft.attachments;
  const setInput = (value: Update<string>) => {
    const edit = liveEditDraft();
    if (edit) writeEditDraft({ ...edit, text: applyUpdate(value, edit.text) });
    else draftStore.setText(draftScope, value);
  };
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  // Synchronous: the store applies the change before returning, so a Stop restore can flush it
  // right after this call (#4448) even if the composer unmounts before the next render.
  const setAttachments = (value: Update<ChatAttachment[]>) => {
    const edit = liveEditDraft();
    if (edit) writeEditDraft({ ...edit, attachments: applyUpdate(value, edit.attachments) });
    else draftStore.setAttachments(draftScope, value);
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
  return {
    draftScope,
    input,
    setInput,
    /** The live composer text (the open edit's, else the draft's), for code after an await. */
    getLiveText: () => liveEditDraft()?.text ?? draftStore.getText(draftScope),
    /** Fill the edit buffer; from now on the composer edits it, not the draft. */
    beginEditDraft: (editId: string, next: { text: string; attachments: ChatAttachment[] }) =>
      writeEditDraft({ editId, ...next }),
    /** Drop the edit buffer and return what it held (text typed during an edit send). */
    endEditDraft: () => {
      const edit = editDraftRef.current;
      writeEditDraft(null);
      return edit;
    },
    // An edit's attachments come from its message, complete.
    payloadsLoaded: editActive || draft.payloadsLoaded,
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
