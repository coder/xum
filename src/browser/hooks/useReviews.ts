/**
 * Hook for managing reviews per workspace
 * Provides interface for adding, checking, and removing reviews
 */

import { useCallback, useMemo } from "react";
import { getReviewStateStore, useReviewStateSelector } from "@/browser/stores/ReviewStateStore";
import type { Review, ReviewNoteData, ReviewStatus } from "@/common/types/review";

/**
 * Generate a unique ID for a review
 */
function generateReviewId(): string {
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const EMPTY_REVIEWS: Record<string, Review> = {};

export interface UseReviewsReturn {
  /** All reviews (pending, attached, and checked) */
  reviews: Review[];
  /** Count of pending reviews (not attached, not checked) */
  pendingCount: number;
  /** Count of attached reviews (in chat input draft) */
  attachedCount: number;
  /** Count of checked reviews */
  checkedCount: number;
  /** Reviews currently attached to chat input */
  attachedReviews: Review[];
  /** Add a new review from structured data (starts as attached) */
  addReview: (data: ReviewNoteData) => Review;
  /** Mark a review as attached to chat input */
  attachReview: (reviewId: string) => void;
  /** Detach a review from chat input (back to pending) */
  detachReview: (reviewId: string) => void;
  /** Attach all pending reviews to chat input */
  attachAllPending: () => void;
  /** Detach all attached reviews from chat input (back to pending) */
  detachAllAttached: () => void;
  /** Mark a review as checked (sent) */
  checkReview: (reviewId: string) => void;
  /** Uncheck a review (mark as pending again) */
  uncheckReview: (reviewId: string) => void;
  /** Remove a review entirely */
  removeReview: (reviewId: string) => void;
  /** Update a review's note/comment */
  updateReviewNote: (reviewId: string, newNote: string) => void;
  /** Clear all checked reviews */
  clearChecked: () => void;
  /** Clear all reviews (for error recovery) */
  clearAll: () => void;
  /** Get a review by ID */
  getReview: (reviewId: string) => Review | undefined;
  /** False until the backend review state has hydrated */
  isLoaded: boolean;
}

/**
 * Hook for managing reviews for a workspace
 * Persists reviews in the backend review-state store (review-state.json), shared by every
 * hook instance and browser window, so the banner updates when AIView adds reviews.
 */
export function useReviews(workspaceId: string): UseReviewsReturn {
  // Selected per section so hunk read/expand changes do not re-render the chat pane.
  const stateReviews = useReviewStateSelector(
    workspaceId,
    (view) => view.sections.reviews ?? EMPTY_REVIEWS
  );
  const isLoaded = useReviewStateSelector(workspaceId, (view) => view.isReady);

  // Convert reviews object to sorted array (oldest first - newest at end)
  const reviews = useMemo(() => {
    return Object.values(stateReviews).sort((a, b) => a.createdAt - b.createdAt);
  }, [stateReviews]);

  // Filter reviews by status
  const attachedReviews = useMemo(() => {
    return reviews.filter((r) => r.status === "attached");
  }, [reviews]);

  // Count reviews by status
  const pendingCount = useMemo(() => {
    return reviews.filter((r) => r.status === "pending").length;
  }, [reviews]);

  const attachedCount = attachedReviews.length;

  const checkedCount = useMemo(() => {
    return reviews.filter((r) => r.status === "checked").length;
  }, [reviews]);

  // Updaters are pure over the latest composed view: before hydration the store replays
  // them onto the server data instead of writing over it.
  const setStatuses = useCallback(
    (select: (review: Review) => boolean, status: ReviewStatus) => {
      getReviewStateStore().mutate(workspaceId, "reviews", (prev) => {
        const now = Date.now();
        const set: Record<string, Review> = {};
        for (const [id, review] of Object.entries(prev)) {
          if (review.status !== status && select(review)) {
            set[id] = { ...review, status, statusChangedAt: now };
          }
        }
        return { set };
      });
    },
    [workspaceId]
  );

  const addReview = useCallback(
    (data: ReviewNoteData): Review => {
      const review: Review = {
        id: generateReviewId(),
        data,
        status: "attached", // New reviews start attached to chat input
        createdAt: Date.now(),
      };

      getReviewStateStore().mutate(workspaceId, "reviews", () => ({
        set: { [review.id]: review },
      }));

      return review;
    },
    [workspaceId]
  );

  const attachReview = useCallback(
    (reviewId: string) => setStatuses((review) => review.id === reviewId, "attached"),
    [setStatuses]
  );

  const detachReview = useCallback(
    (reviewId: string) =>
      setStatuses((review) => review.id === reviewId && review.status === "attached", "pending"),
    [setStatuses]
  );

  const attachAllPending = useCallback(
    () => setStatuses((review) => review.status === "pending", "attached"),
    [setStatuses]
  );

  const detachAllAttached = useCallback(
    () => setStatuses((review) => review.status === "attached", "pending"),
    [setStatuses]
  );

  const checkReview = useCallback(
    (reviewId: string) => setStatuses((review) => review.id === reviewId, "checked"),
    [setStatuses]
  );

  const uncheckReview = useCallback(
    (reviewId: string) => setStatuses((review) => review.id === reviewId, "pending"),
    [setStatuses]
  );

  const removeReview = useCallback(
    (reviewId: string) => {
      getReviewStateStore().mutate(workspaceId, "reviews", () => ({ delete: [reviewId] }));
    },
    [workspaceId]
  );

  const updateReviewNote = useCallback(
    (reviewId: string, newNote: string) => {
      getReviewStateStore().mutate(workspaceId, "reviews", (prev) => {
        const review = prev[reviewId];
        if (!review) return null;
        return { set: { [reviewId]: { ...review, data: { ...review.data, userNote: newNote } } } };
      });
    },
    [workspaceId]
  );

  const clearChecked = useCallback(() => {
    getReviewStateStore().mutate(workspaceId, "reviews", (prev) => ({
      delete: Object.values(prev)
        .filter((review) => review.status === "checked")
        .map((review) => review.id),
    }));
  }, [workspaceId]);

  const clearAll = useCallback(() => {
    getReviewStateStore().mutate(workspaceId, "reviews", (prev) => ({
      delete: Object.keys(prev),
    }));
  }, [workspaceId]);

  const getReview = useCallback(
    (reviewId: string): Review | undefined => {
      return stateReviews[reviewId];
    },
    [stateReviews]
  );

  return useMemo(
    () => ({
      reviews,
      pendingCount,
      attachedCount,
      checkedCount,
      attachedReviews,
      addReview,
      attachReview,
      detachReview,
      attachAllPending,
      detachAllAttached,
      checkReview,
      uncheckReview,
      removeReview,
      updateReviewNote,
      clearChecked,
      clearAll,
      getReview,
      isLoaded,
    }),
    [
      reviews,
      pendingCount,
      attachedCount,
      checkedCount,
      attachedReviews,
      addReview,
      attachReview,
      detachReview,
      attachAllPending,
      detachAllAttached,
      checkReview,
      uncheckReview,
      removeReview,
      updateReviewNote,
      clearChecked,
      clearAll,
      getReview,
      isLoaded,
    ]
  );
}
