/**
 * Hook for tracking when hunk content addresses were first seen.
 * Used to sort hunks by "last edit at" (LIFO) in the Review panel.
 *
 * The hunk ID is already a content-based hash, so we use it as the content address.
 * We track the first time we see each hunk ID, which represents when the edit
 * that created this hunk content was first observed.
 *
 * Persisted in the backend review-state store; the shared merge keeps the existing
 * timestamp, so a second window reporting the same hunk never moves first-seen later.
 */

import { useCallback } from "react";
import { getReviewStateStore, useReviewStateSelector } from "@/browser/stores/ReviewStateStore";

const EMPTY_FIRST_SEEN: Record<string, number> = {};

export interface UseHunkFirstSeenReturn {
  /** Get the first-seen timestamp for a hunk ID, or undefined if never seen */
  getFirstSeen: (hunkId: string) => number | undefined;

  /** Record first-seen timestamps for new hunk IDs (ignores already-seen IDs) */
  recordFirstSeen: (hunkIds: string[]) => void;

  /** Get all first-seen records (for sorting) */
  firstSeenMap: Record<string, number>;
}

/**
 * Hook for tracking when hunks were first seen in a workspace.
 * Automatically records first-seen timestamps and provides lookup.
 */
export function useHunkFirstSeen(workspaceId: string): UseHunkFirstSeenReturn {
  const firstSeen = useReviewStateSelector(
    workspaceId,
    (view) => view.sections.firstSeen ?? EMPTY_FIRST_SEEN
  );

  const getFirstSeen = useCallback(
    (hunkId: string): number | undefined => {
      return firstSeen[hunkId];
    },
    [firstSeen]
  );

  const recordFirstSeen = useCallback(
    (hunkIds: string[]) => {
      const timestamp = Date.now();
      getReviewStateStore().mutate(workspaceId, "firstSeen", (prev) => {
        const set: Record<string, number> = {};
        for (const id of hunkIds) {
          if (!(id in prev)) set[id] = timestamp;
        }
        return { set };
      });
    },
    [workspaceId]
  );

  return {
    getFirstSeen,
    recordFirstSeen,
    firstSeenMap: firstSeen,
  };
}
