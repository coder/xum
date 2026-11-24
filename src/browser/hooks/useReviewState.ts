/**
 * Hook for managing hunk read state
 * Provides interface for tracking which hunks have been reviewed, persisted in the
 * backend review-state store (review-state.json). The per-workspace cap is enforced by
 * the shared merge helper on both client and server.
 */

import { useCallback, useMemo } from "react";
import type { HunkReadState } from "@/common/types/review";
import { getReviewStateStore, useReviewStateSelector } from "@/browser/stores/ReviewStateStore";

const EMPTY_READ_STATE: Record<string, HunkReadState> = {};

export interface UseReviewStateReturn {
  /** Check if a hunk is marked as read */
  isRead: (hunkId: string) => boolean;
  /** Mark one or more hunks as read */
  markAsRead: (hunkIds: string | string[]) => void;
  /** Mark a hunk as unread */
  markAsUnread: (hunkId: string) => void;
  /** Toggle read state of a hunk */
  toggleRead: (hunkId: string) => void;
  /** Clear all read states */
  clearAll: () => void;
  /** Number of hunks marked as read */
  readCount: number;
  /** False until the backend review state has hydrated */
  isLoaded: boolean;
}

/**
 * Hook for managing hunk read state for a workspace
 */
export function useReviewState(workspaceId: string): UseReviewStateReturn {
  // Multiple Review surfaces read/write the same state (the panel marks hunks read, the
  // always-mounted sidebar reporter updates the Review tab badge); the shared store keeps
  // every hook instance synchronized.
  const readState = useReviewStateSelector(
    workspaceId,
    (view) => view.sections.readState ?? EMPTY_READ_STATE
  );
  const isLoaded = useReviewStateSelector(workspaceId, (view) => view.isReady);

  /**
   * Check if a hunk is marked as read
   */
  const isRead = useCallback(
    (hunkId: string): boolean => {
      return readState[hunkId]?.isRead ?? false;
    },
    [readState]
  );

  /**
   * Mark one or more hunks as read
   * Optimized to only update changed entries
   */
  const markAsRead = useCallback(
    (hunkIds: string | string[]) => {
      const ids = Array.isArray(hunkIds) ? hunkIds : [hunkIds];
      if (ids.length === 0) return;

      const timestamp = Date.now();
      getReviewStateStore().mutate(workspaceId, "readState", (prev) => {
        const set: Record<string, HunkReadState> = {};
        for (const hunkId of ids) {
          if (!prev[hunkId]?.isRead) {
            set[hunkId] = { hunkId, isRead: true, timestamp };
          }
        }
        return { set };
      });
    },
    [workspaceId]
  );

  /**
   * Mark a hunk as unread
   */
  const markAsUnread = useCallback(
    (hunkId: string) => {
      getReviewStateStore().mutate(workspaceId, "readState", (prev) =>
        prev[hunkId] ? { delete: [hunkId] } : null
      );
    },
    [workspaceId]
  );

  /**
   * Toggle read state of a hunk
   */
  const toggleRead = useCallback(
    (hunkId: string) => {
      if (isRead(hunkId)) {
        markAsUnread(hunkId);
      } else {
        markAsRead(hunkId);
      }
    },
    [isRead, markAsRead, markAsUnread]
  );

  /**
   * Clear all read states
   */
  const clearAll = useCallback(() => {
    getReviewStateStore().mutate(workspaceId, "readState", (prev) => ({
      delete: Object.keys(prev),
    }));
  }, [workspaceId]);

  /**
   * Calculate number of read hunks
   */
  const readCount = useMemo(() => {
    return Object.values(readState).filter((state) => state.isRead).length;
  }, [readState]);

  return {
    isRead,
    markAsRead,
    markAsUnread,
    toggleRead,
    clearAll,
    readCount,
    isLoaded,
  };
}
