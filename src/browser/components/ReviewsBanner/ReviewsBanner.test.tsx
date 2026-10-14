import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { createTestApiClient } from "@/browser/testUtils";
import { getReviewStateStore } from "@/browser/stores/ReviewStateStore";
import type { ReviewStateEvent } from "@/common/orpc/schemas/reviewState";
import type { Review, ReviewStatus } from "@/common/types/review";
import { ReviewsBanner } from "./ReviewsBanner";

function review(id: string, status: ReviewStatus): Review {
  return {
    id,
    status,
    createdAt: 1,
    data: { filePath: "src/a.ts", lineRange: "+1", selectedCode: "a", userNote: "Why?" },
  };
}

/** Review-state backend holding a fixed set of reviews for every workspace. */
function serveReviews(reviews: Review[]) {
  const sections = { reviews: Object.fromEntries(reviews.map((r) => [r.id, r])) };
  const reviewState = {
    subscribe: (_input: { workspaceId: string }, opts?: { signal?: AbortSignal }) => {
      const first: ReviewStateEvent = { type: "snapshot", snapshot: { sections }, revision: 1 };
      return Promise.resolve(
        (async function* () {
          yield first;
          await new Promise<void>((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        })()
      );
    },
    update: () => Promise.resolve({ sections, revision: 2 }),
  };
  getReviewStateStore().setClient(createTestApiClient({ workspace: { reviewState } }));
}

describe("ReviewsBanner", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    getReviewStateStore().setClient(null);
    cleanupDom?.();
    cleanupDom = null;
  });

  // Bug bash (#5675): attached reviews show in the composer, not here, so a banner holding only
  // them said "No pending reviews" and, expanded, "No reviews yet".
  test("stays hidden while every review is attached to the composer", async () => {
    serveReviews([review("r1", "attached")]);
    const view = render(<ReviewsBanner workspaceId="ws-attached-only" />);
    // Wait for hydration: the banner reads the review store, which loads asynchronously.
    await waitFor(() =>
      expect(getReviewStateStore().getView("ws-attached-only").isReady).toBe(true)
    );
    expect(view.container.textContent).toBe("");
  });

  test("shows pending reviews", async () => {
    serveReviews([review("r1", "attached"), review("r2", "pending")]);
    const view = render(<ReviewsBanner workspaceId="ws-pending" />);
    expect(await view.findByText(/pending review/)).toBeTruthy();
  });
});
