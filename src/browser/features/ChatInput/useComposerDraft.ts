import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  defaultCreationDraftScope,
  getDraftStore,
  useDraft,
  type DraftStoreScope,
} from "@/browser/stores/DraftStore";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { Review } from "@/common/types/review";
import assert from "@/common/utils/assert";
import { DRAFT_ID_PATTERN } from "@/constants/drafts";
import { joinDraftText } from "@/common/utils/composerDraftText";
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

// The open edit's buffer per workspace, in module memory. A workspace switch remounts the
// composer (ChatPane keys it by workspace) while ChatPane keeps the edit open, so the buffer
// must outlive the composer (#5808). Module memory, not the draft store: a reload still drops
// the edit, and another window never sees it (#5672, #5571).
const editDrafts = new Map<string, EditDraft>();
const editDraftListeners = new Map<string, Set<() => void>>();
function writeStoredEditDraft(key: string, next: EditDraft | null) {
  if (next) editDrafts.set(key, next);
  else editDrafts.delete(key);
  for (const listener of editDraftListeners.get(key) ?? []) listener();
}
function subscribeEditDraft(key: string, listener: () => void) {
  const listeners = editDraftListeners.get(key) ?? new Set<() => void>();
  editDraftListeners.set(key, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) editDraftListeners.delete(key);
  };
}

/**
 * The one rule for an edit that loses its target without a settle (cancel and accepted sends
 * settle first and leave no buffer): ChatPane calls this whenever a workspace's edit target is
 * cleared or replaced (transcript-only, a second Edit, a deleted row, a refresh that finds no
 * target). The edit's text and files stay in the workspace's normal draft, after the unsent
 * draft, never over it. Taking the buffer first makes it exactly once.
 */
export function keepUnsettledEditInDraft(workspaceId: string, editId: string) {
  const edit = editDrafts.get(workspaceId);
  if (edit?.editId !== editId) return;
  writeStoredEditDraft(workspaceId, null);
  const scope: DraftStoreScope = { kind: "workspace", workspaceId };
  if (edit.text.trim().length > 0) {
    getDraftStore().setText(scope, (current) => joinDraftText(current, edit.text));
  }
  if (edit.attachments.length > 0) {
    getDraftStore().setAttachments(scope, (current) => [...current, ...edit.attachments]);
  }
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
  // Edits exist only in a workspace composer, so the workspace keys the buffer (editDrafts).
  const editKey = options.variant === "workspace" ? options.workspaceId : null;
  const readEditDraft = () => (editKey ? (editDrafts.get(editKey) ?? null) : null);
  const editDraft = useSyncExternalStore(
    (listener) => (editKey ? subscribeEditDraft(editKey, listener) : () => undefined),
    readEditDraft
  );
  const editIdRef = useRef(options.editMessageId);
  useLayoutEffect(() => {
    editIdRef.current = options.editMessageId;
  });
  const writeEditDraft = (next: EditDraft | null) => {
    if (!editKey) {
      assert(next === null, "An edit buffer needs a workspace composer");
      return;
    }
    writeStoredEditDraft(editKey, next);
  };
  // Only the open edit's buffer counts. One left behind by an edit that ended without settling
  // (its row was replaced) is ignored until the composer releases it.
  const liveEditDraft = () => {
    const current = readEditDraft();
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
    /**
     * Fill the edit buffer; from now on the composer edits it, not the draft. A buffer this edit
     * already has (it outlived a workspace switch) is kept with its typed changes.
     */
    beginEditDraft: (editId: string, next: { text: string; attachments: ChatAttachment[] }) => {
      if (readEditDraft()?.editId === editId) return;
      writeEditDraft({ editId, ...next });
    },
    /**
     * Change this edit's buffer, whether or not ChatPane still shows the edit (an accepted edit
     * command replaces its row before it clears the composer). Never the shared draft.
     */
    updateEditDraft: (editId: string, patch: Partial<Pick<EditDraft, "text" | "attachments">>) => {
      const edit = readEditDraft();
      if (edit?.editId === editId) writeEditDraft({ ...edit, ...patch });
    },
    /** Drop the edit buffer and return what it held (text typed during an edit send). */
    endEditDraft: () => {
      const edit = readEditDraft();
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
