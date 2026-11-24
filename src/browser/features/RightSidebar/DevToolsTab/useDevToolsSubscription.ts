import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { DevToolsEvent, DevToolsRunSummary, DevToolsStep } from "@/common/types/devtools";
import { assertNever } from "@/common/utils/assertNever";

export function useDevToolsSubscription(workspaceId: string) {
  const { api } = useAPI();
  const [runs, setRuns] = useState<DevToolsRunSummary[]>([]);
  const [stepsByRun, setStepsByRun] = useState<Map<string, DevToolsStep[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setRuns([]);
      setStepsByRun(new Map());
      return;
    }

    setRuns([]);
    setStepsByRun(new Map());
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
          case "run-created": {
            setRuns((previousRuns) => {
              // De-duplicate if the run is already in state (e.g., from initial snapshot).
              const existingRunIndex = previousRuns.findIndex((run) => run.id === event.run.id);
              if (existingRunIndex >= 0) {
                const updatedRuns = [...previousRuns];
                updatedRuns[existingRunIndex] = event.run;
                return updatedRuns;
              }

              return [event.run, ...previousRuns];
            });
            break;
          }
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
