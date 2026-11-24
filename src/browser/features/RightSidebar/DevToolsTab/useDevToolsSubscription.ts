import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { DevToolsEvent, DevToolsRunSummary, DevToolsStep } from "@/common/types/devtools";
import { assertNever } from "@/common/utils/assertNever";

export function useDevToolsSubscription(workspaceId: string) {
  const { api } = useAPI();
  const [runs, setRuns] = useState<DevToolsRunSummary[]>([]);
  const [stepsByRun, setStepsByRun] = useState<Map<string, DevToolsStep[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // The workspace whose runs are shown. Only another workspace clears them: a re-run for the same
  // one (no client during a reconnect, then a new client) keeps them until the new snapshot.
  const shownWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (shownWorkspaceIdRef.current !== workspaceId) {
      shownWorkspaceIdRef.current = workspaceId;
      setRuns([]);
      setStepsByRun(new Map());
    }

    if (!api) {
      return;
    }

    setError(null);

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<DevToolsEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.devtools.subscribe({ workspaceId }, { signal });

      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }

      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) break;

        switch (event.type) {
          case "snapshot":
            setRuns(event.runs);
            setStepsByRun(new Map());
            break;
          case "run-created":
            setRuns((previousRuns) => upsertRun(previousRuns, event.run));
            break;
          case "run-updated":
            setRuns((previousRuns) =>
              previousRuns.map((run) => (run.id === event.run.id ? event.run : run))
            );
            break;
          case "step-created":
            setStepsByRun((previousStepsByRun) => upsertStep(previousStepsByRun, event.step));
            break;
          case "step-updated":
            setStepsByRun((previousStepsByRun) => upsertStep(previousStepsByRun, event.step));
            break;
          case "runs-evicted": {
            const evictedRunIds = new Set(event.runIds);
            setRuns((previousRuns) => previousRuns.filter((run) => !evictedRunIds.has(run.id)));
            setStepsByRun((previousStepsByRun) => {
              const nextStepsByRun = new Map(previousStepsByRun);
              for (const runId of evictedRunIds) {
                nextStepsByRun.delete(runId);
              }
              return nextStepsByRun;
            });
            break;
          }
          case "cleared":
            setRuns([]);
            setStepsByRun(new Map());
            break;
          default:
            assertNever(event);
        }
      }
    };

    subscribe().catch((subscriptionError: unknown) => {
      if (signal.aborted || isAbortError(subscriptionError)) return;
      setError(
        subscriptionError instanceof Error ? subscriptionError.message : "Subscription failed"
      );
    });

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, workspaceId]);

  return { runs, stepsByRun, error };
}

function upsertRun(
  previousRuns: DevToolsRunSummary[],
  incomingRun: DevToolsRunSummary
): DevToolsRunSummary[] {
  // De-duplicate if the run is already in state (e.g., from initial snapshot).
  const existingRunIndex = previousRuns.findIndex((run) => run.id === incomingRun.id);
  if (existingRunIndex >= 0) {
    const updatedRuns = [...previousRuns];
    updatedRuns[existingRunIndex] = incomingRun;
    return updatedRuns;
  }

  return [incomingRun, ...previousRuns];
}

function upsertStep(
  previousStepsByRun: Map<string, DevToolsStep[]>,
  incomingStep: DevToolsStep
): Map<string, DevToolsStep[]> {
  const nextStepsByRun = new Map(previousStepsByRun);
  const previousSteps = nextStepsByRun.get(incomingStep.runId) ?? [];
  const existingStepIndex = previousSteps.findIndex((step) => step.id === incomingStep.id);

  if (existingStepIndex === -1) {
    nextStepsByRun.set(incomingStep.runId, sortSteps([...previousSteps, incomingStep]));
    return nextStepsByRun;
  }

  const updatedSteps = [...previousSteps];
  updatedSteps[existingStepIndex] = incomingStep;
  nextStepsByRun.set(incomingStep.runId, sortSteps(updatedSteps));
  return nextStepsByRun;
}

function sortSteps(steps: DevToolsStep[]): DevToolsStep[] {
  return [...steps].sort((left, right) => left.stepNumber - right.stepNumber);
}
