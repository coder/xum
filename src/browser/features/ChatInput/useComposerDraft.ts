import { useEffect, useRef, useState } from "react";
import {
  getDraftStore,
  useDraft,
  type DraftStoreScope,
  type DraftView,
} from "@/browser/stores/DraftStore";
import {
  getCreationDraftStore,
  useCreationDraft,
  type CreationDraftView,
} from "@/browser/stores/CreationDraftStore";
import type { ReviewNoteDataForDisplay } from "@/common/types/message";
import type { Review } from "@/common/types/review";
import type { ChatAttachment } from "./ChatAttachments";
import type { Toast } from "./ChatInputToast";

interface UseComposerDraftOptions {
  variant: "creation" | "workspace";
  workspaceId: string | null;
  pendingDraftId?: string;
  attachedReviews: Review[];
  pushToast: (toast: Omit<Toast, "id" | "type"> & { type: Toast["type"] | "info" }) => void;
}

/**
 * The workspace DraftStore scope a composer edits. A workspace composer that has no workspace id
 * yet, and every creation composer (its draft is a CreationDraftStore record), use the
 * memory-only pending scope (see PendingDraftScope), which never writes to the backend.
 */
export function getComposerDraftScope(options: {
  variant: "creation" | "workspace";
  workspaceId: string | null;
}): DraftStoreScope {
  return options.variant === "workspace" && options.workspaceId
    ? { kind: "workspace", workspaceId: options.workspaceId }
    : { kind: "pending", projectPath: "" };
}

const NO_ATTACHMENTS: ChatAttachment[] = [];

type DraftUpdate<T> = T | ((previous: T) => T);

/** What a composer edits: a workspace DraftStore scope or a creation draft record. */
interface ComposerDraftSource {
  text: string;
  attachments: ChatAttachment[];
  setText: (value: DraftUpdate<string>) => void;
  setAttachments: (value: DraftUpdate<ChatAttachment[]>) => void;
  /** The live text (async phases can outlive the render that started them). */
  getLiveText: () => string;
  /** Save now instead of after the debounce; a failure keeps the change for a retry. */
  flush: () => Promise<void>;
  /** A creation draft whose last save failed (its local copy stays; Send waits for a save). */
  saveError: string | null;
  payloadsLoaded: boolean;
  unresolvedSendCount: number;
}

function workspaceDraftSource(scope: DraftStoreScope, draft: DraftView): ComposerDraftSource {
  const store = getDraftStore();
  return {
    text: draft.text,
    attachments: draft.attachments,
    setText: (value) => store.setText(scope, value),
    setAttachments: (value) => store.setAttachments(scope, value),
    getLiveText: () => store.getText(scope),
    flush: () => store.flush(scope),
    saveError: null,
    payloadsLoaded: draft.payloadsLoaded,
    unresolvedSendCount: draft.unresolvedSendCount,
  };
}

const NO_CONTENT = { text: "", attachments: NO_ATTACHMENTS };

function resolveUpdate<T>(value: DraftUpdate<T>, previous: T): T {
  return typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
}

function creationDraftSource(draftId: string, view: CreationDraftView): ComposerDraftSource {
  const store = getCreationDraftStore();
  const live = () => store.getView(draftId).draft ?? NO_CONTENT;
  const current = view.draft ?? NO_CONTENT;
  return {
    text: current.text,
    attachments: current.attachments,
    setText: (value) => store.update(draftId, { text: resolveUpdate(value, live().text) }),
    setAttachments: (value) =>
      store.update(draftId, {
        // A creation draft has no worktree, so it never holds staged attachments.
        attachments: resolveUpdate(value, live().attachments).filter(
          (attachment) => attachment.kind !== "staged"
        ),
      }),
    getLiveText: () => live().text,
    flush: () => store.flush(draftId),
    saveError: view.saveError,
    payloadsLoaded: true,
    unresolvedSendCount: 0,
  };
}

/** The composer's draft, and saving it when the composer leaves it. */
function useComposerDraftSource(options: UseComposerDraftOptions) {
  const draftScope = getComposerDraftScope(options);
  // Drafts live in the in-memory DraftStore, persisted to the backend in the background. The
  // rendered text never waits for (or depends on) a storage write succeeding (issue 5006).
  const draft = useDraft(draftScope);
  const creationDraftId = options.variant === "creation" ? (options.pendingDraftId ?? "") : null;
  const creation = useCreationDraft(creationDraftId ?? "");
  const pushToastRef = useRef(options.pushToast);
  pushToastRef.current = options.pushToast;
  const { variant, workspaceId } = options;
  useEffect(() => {
    if (creationDraftId !== null) {
      // Leaving the draft: save now. A failure keeps the change and shows "Not saved".
      return () => {
        getCreationDraftStore()
          .flush(creationDraftId)
          .catch((error: unknown) => console.warn("Failed to save a creation draft:", error));
      };
    }
    const scope = getComposerDraftScope({ variant, workspaceId });
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
  }, [variant, workspaceId, creationDraftId]);
  return {
    draftScope,
    source:
      creationDraftId === null
        ? workspaceDraftSource(draftScope, draft)
        : creationDraftSource(creationDraftId, creation),
  };
}

export function useComposerDraft(options: UseComposerDraftOptions) {
  const { attachedReviews } = options;
  const { draftScope, source } = useComposerDraftSource(options);
  const { text: input, attachments, setText: setInput } = source;
  const latestInputValueRef = useRef(input);
  latestInputValueRef.current = input;
  // Synchronous: the store applies the change before returning, so a Stop restore can flush it
  // right after this call (#4448) even if the composer unmounts before the next render.
  const setAttachments = source.setAttachments;
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
    payloadsLoaded: source.payloadsLoaded,
    unresolvedSendCount: source.unresolvedSendCount,
    saveError: source.saveError,
    getLiveText: source.getLiveText,
    flush: source.flush,
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
