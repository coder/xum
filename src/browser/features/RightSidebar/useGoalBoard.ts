import { useCallback, useContext, useEffect, useState } from "react";

import { APIContext, type APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { GoalBoardSnapshot } from "@/common/types/goal";

/**
 * React hook for the GoalTab board (multi-goal queue). Subscribes to
 * the API's `workspace.getGoalBoard` endpoint and exposes a
 * stable `refresh()` callback so board mutations (add / archive /
 * revive / reorder / promote) can trigger a re-read inline.
 *
 * Always returns a value: while the initial fetch is in flight we serve
 * an empty board so the UI doesn't flash null. `isLoading` flips false
 * after the first resolution.
 *
 * Note: we deliberately don't subscribe to workspace activity events
 * here — board mutations are user-initiated through this hook's
 * callbacks (or transparent auto-promotion after a setGoal/clear, which
 * the existing activity snapshot pipeline already nudges). A future
 * tighter coupling could push board snapshots through the activity
 * channel; today's reads are cheap enough to drive on-demand.
 */
const EMPTY_BOARD: GoalBoardSnapshot = { entries: [] };

/**
 * Reads a workspace's board. A failed read is an empty board, as before, but a read cut off by a
 * lost connection resolves to null: the caller keeps the board it shows for the next client.
 */
async function readGoalBoard(
  api: APIClient,
  workspaceId: string
): Promise<GoalBoardSnapshot | null> {
  try {
    return (await api.workspace.getGoalBoard({ workspaceId })) ?? EMPTY_BOARD;
  } catch (error) {
    return isAbortError(error) ? null : EMPTY_BOARD;
  }
}

export interface UseGoalBoardResult {
  board: GoalBoardSnapshot;
  isLoading: boolean;
  refresh: () => void;
}

/**
 * @param workspaceId — Workspace whose board to read.
 * @param activeGoalKey — Optional cache-busting key derived from the
 *   parent's view of the active goal (typically
 *   `${goalId}:${status}`). Including this in the effect deps makes
 *   the hook re-fetch when `setGoal` or `clearGoal` mutates the
 *   active goal — for example, when the backend's
 *   `maybeAutoPromoteOnComplete` swaps the active slot. Without this,
 *   the board would show stale Upcoming/Completed lists until another
 *   board mutation forced a refetch.
 */
export function useGoalBoard(
  workspaceId: string | undefined,
  activeGoalKey?: string | null
): UseGoalBoardResult {
  // Read APIContext directly (vs `useAPI()`) so the hook tolerates
  // missing provider in storybook stories. Same rationale as
  // `useGoalDefaults`.
  const context = useContext(APIContext);
  const api = context?.api ?? null;
  const [board, setBoard] = useState<GoalBoardSnapshot>(EMPTY_BOARD);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!api || !workspaceId) {
      // No client (a reconnect) keeps the shown board; no workspace has no board.
      setBoard((current) => (workspaceId ? current : EMPTY_BOARD));
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void readGoalBoard(api, workspaceId).then((snapshot) => {
      if (cancelled || snapshot == null) return;
      setBoard(snapshot);
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, refreshKey, activeGoalKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { board, isLoading, refresh };
}
