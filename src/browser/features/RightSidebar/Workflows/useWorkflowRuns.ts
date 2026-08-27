import { useContext, useEffect, useState } from "react";

import { APIContext, useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { WorkflowRunRecord, WorkflowRunStreamEvent } from "@/common/types/workflow";
import { assertNever } from "@/common/utils/assertNever";

export interface UseWorkflowRunsResult {
  /** Top-level runs for the workspace, most-recently-updated first. */
  runs: WorkflowRunRecord[];
  /** True until the first snapshot arrives. */
  loading: boolean;
  error: string | null;
}

export interface UseWorkflowRunLiveSnapshotResult {
  run: WorkflowRunRecord | null;
  failed: boolean;
}

function recency(run: WorkflowRunRecord): number {
  const value = Date.parse(run.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Live workflow-run feed for one workspace. Subscribes to `workflows.subscribe`
 * (snapshot + per-write deltas) and keeps a local id→record map in sync, so the
 * tab reflects step/status progress in real time without polling. Mirrors
 * `useDevToolsSubscription`.
 */
export function useWorkflowRuns(workspaceId: string): UseWorkflowRunsResult {
  const { api } = useAPI();
  const [runsById, setRunsById] = useState<Map<string, WorkflowRunRecord>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setRunsById(new Map());
      setLoading(false);
      return;
    }

    setRunsById(new Map());
    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<WorkflowRunStreamEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.workflows.subscribe({ workspaceId }, { signal });
      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }
      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) {
          break;
        }
        switch (event.type) {
          case "snapshot":
            setRunsById(new Map(event.runs.map((run) => [run.id, run])));
            setLoading(false);
            break;
          case "run-changed":
            setRunsById((previous) => {
              const next = new Map(previous);
              next.set(event.run.id, event.run);
              return next;
            });
            break;
          default:
            assertNever(event);
        }
      }
    };

    subscribe().catch((subscriptionError: unknown) => {
      if (signal.aborted || isAbortError(subscriptionError)) {
        return;
      }
      setError(
        subscriptionError instanceof Error
          ? subscriptionError.message
          : "Workflow subscription failed"
      );
      setLoading(false);
    });

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, workspaceId]);

  // React Compiler memoizes this derivation; no manual useMemo needed.
  const runs = [...runsById.values()].sort((a, b) => recency(b) - recency(a));
  return { runs, loading, error };
}

/** Live snapshots for one known run, used by transcript tool cards while the run is active. */
export function useWorkflowRunLiveSnapshot(input: {
  workspaceId?: string;
  runId?: string;
  enabled: boolean;
}): UseWorkflowRunLiveSnapshotResult {
  const api = useContext(APIContext)?.api;
  const subscriptionKey =
    input.enabled && api != null && input.workspaceId != null && input.runId != null
      ? `${input.workspaceId}:${input.runId}`
      : null;
  const [state, setState] = useState<{
    key: string;
    run: WorkflowRunRecord | null;
    failed: boolean;
  }>({ key: "", run: null, failed: false });
  const run = state.key === subscriptionKey ? state.run : null;
  const failed = state.key === subscriptionKey && state.failed;

  useEffect(() => {
    if (
      subscriptionKey == null ||
      api == null ||
      input.workspaceId == null ||
      input.runId == null
    ) {
      return;
    }

    const workspaceId = input.workspaceId;
    const runId = input.runId;
    setState({ key: subscriptionKey, run: null, failed: false });

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<WorkflowRunStreamEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.workflows.subscribe({ workspaceId }, { signal });
      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }
      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) {
          break;
        }
        switch (event.type) {
          case "snapshot": {
            const matchingRun = event.runs.find((candidate) => candidate.id === runId);
            if (matchingRun != null) {
              setState({ key: subscriptionKey, run: matchingRun, failed: false });
            }
            break;
          }
          case "run-changed":
            if (event.run.id === runId) {
              setState({ key: subscriptionKey, run: event.run, failed: false });
            }
            break;
          default:
            assertNever(event);
        }
      }
    };

    subscribe().catch((subscriptionError: unknown) => {
      if (signal.aborted || isAbortError(subscriptionError)) {
        return;
      }
      setState((current) =>
        current.key === subscriptionKey ? { ...current, failed: true } : current
      );
    });

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, input.runId, input.workspaceId, subscriptionKey]);

  return { run, failed };
}
