import { useEffect, useState, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";

interface PostCompactionState {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: Set<string>;
  toggleExclusion: (itemId: string) => Promise<void>;
}

interface CachedPostCompactionData {
  planPath: string | null;
  trackedFilePaths: string[];
  excludedItems: string[];
}

/**
 * Last fetched state per workspace, used only to seed the hook on remount. The backend owns
 * this state and the hook refetches it on every mount, so it is kept in memory rather than
 * localStorage (per-workspace copies there contributed to QuotaExceededError).
 */
const postCompactionStateCache = new Map<string, CachedPostCompactionData>();

/** Mounted hooks per workspace, so an action elsewhere can make them fetch again. */
const refetchListeners = new Map<string, Set<() => void>>();

/**
 * Make every mounted usePostCompactionState for `workspaceId` fetch again: for actions outside
 * the hook that change its state without a backend event (a legacy plan import, #5174).
 */
export function refetchPostCompactionState(workspaceId: string): void {
  for (const listener of refetchListeners.get(workspaceId) ?? []) listener();
}

function loadFromCache(wsId: string) {
  const cached = postCompactionStateCache.get(wsId);
  return {
    planPath: cached?.planPath ?? null,
    trackedFilePaths: cached?.trackedFilePaths ?? [],
    excludedItems: new Set(cached?.excludedItems ?? []),
  };
}

/**
 * Hook to get post-compaction context state for a workspace.
 * Fetches lazily from the backend API and caches in memory.
 * This avoids the expensive runtime.stat calls during workspace.list().
 *
 * Always enabled: post-compaction context is a stable feature (not an experiment).
 */
export function usePostCompactionState(workspaceId: string): PostCompactionState {
  const { api } = useAPI();
  const [state, setState] = useState(() => loadFromCache(workspaceId));
  // Bumped by refetchPostCompactionState to fetch again.
  const [fetchCount, setFetchCount] = useState(0);

  // Subscribing to the external refetch signal for this workspace.
  useEffect(() => {
    const listener = () => setFetchCount((count) => count + 1);
    const listeners = refetchListeners.get(workspaceId) ?? new Set<() => void>();
    listeners.add(listener);
    refetchListeners.set(workspaceId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) refetchListeners.delete(workspaceId);
    };
  }, [workspaceId]);

  // Track which workspaceId the current state belongs to.
  // Reset synchronously during render when workspaceId changes (React-recommended pattern).
  const prevWorkspaceIdRef = useRef(workspaceId);
  if (prevWorkspaceIdRef.current !== workspaceId) {
    prevWorkspaceIdRef.current = workspaceId;
    setState(loadFromCache(workspaceId));
  }

  // Fetch fresh data when workspaceId changes
  useEffect(() => {
    if (!api) return;

    let cancelled = false;
    const fetchState = async () => {
      try {
        const result = await api.workspace.getPostCompactionState({ workspaceId });
        if (cancelled) return;

        // Update state
        setState({
          planPath: result.planPath,
          trackedFilePaths: result.trackedFilePaths,
          excludedItems: new Set(result.excludedItems),
        });

        // Cache for next time
        postCompactionStateCache.set(workspaceId, {
          planPath: result.planPath,
          trackedFilePaths: result.trackedFilePaths,
          excludedItems: result.excludedItems,
        });
      } catch (error) {
        // Silently fail - use cached or empty state
        console.warn("[usePostCompactionState] Failed to fetch:", error);
      }
    };

    void fetchState();
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, fetchCount]);

  const toggleExclusion = useCallback(
    async (itemId: string) => {
      if (!api) return;
      const isCurrentlyExcluded = state.excludedItems.has(itemId);
      const result = await api.workspace.setPostCompactionExclusion({
        workspaceId,
        itemId,
        excluded: !isCurrentlyExcluded,
      });
      if (result.success) {
        // Optimistic update for immediate UI feedback
        setState((prev) => {
          const newSet = new Set(prev.excludedItems);
          if (isCurrentlyExcluded) {
            newSet.delete(itemId);
          } else {
            newSet.add(itemId);
          }
          const newState = { ...prev, excludedItems: newSet };

          postCompactionStateCache.set(workspaceId, {
            planPath: newState.planPath,
            trackedFilePaths: newState.trackedFilePaths,
            excludedItems: Array.from(newSet),
          });

          return newState;
        });
      }
    },
    [api, workspaceId, state.excludedItems]
  );

  return { ...state, toggleExclusion };
}
