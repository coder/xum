import type { ReviewSortOrder } from "@/common/types/review";
import type { Review } from "@/common/types/review";
import { REVIEW_SORT_ORDER_KEY } from "@/common/constants/storage";
import { seedMockReviewState } from "@/browser/stories/mocks/reviewState";

/**
 * Set hunk first-seen timestamps for a workspace (for storybook). Seeds the mock backend's
 * review state, so call it before creating the story's mock client.
 */
export function setHunkFirstSeen(workspaceId: string, firstSeen: Record<string, number>): void {
  seedMockReviewState(workspaceId, { firstSeen });
}

/** Set the review panel sort order (global) */
export function setReviewSortOrder(order: ReviewSortOrder): void {
  localStorage.setItem(REVIEW_SORT_ORDER_KEY, JSON.stringify(order));
}

/** Create a sample review for stories */
export function createReview(
  id: string,
  filePath: string,
  lineRange: string,
  note: string,
  status: "pending" | "attached" | "checked" = "pending",
  createdAt?: number
): Review {
  return {
    id,
    data: {
      filePath,
      lineRange,
      selectedCode: "// sample code",
      userNote: note,
    },
    status,
    createdAt: createdAt ?? Date.now(),
    statusChangedAt: status === "checked" ? Date.now() : undefined,
  };
}
