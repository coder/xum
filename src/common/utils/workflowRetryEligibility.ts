import { WORKFLOW_EVALUATION_STEP_ERROR_NAME } from "@/common/types/evaluation";
import type { WorkflowRunEvent, WorkflowRunRecord } from "@/common/types/workflow";

export const WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE = "Execution interrupted";

export interface WorkflowCheckpointRetryEligibility {
  canRetry: boolean;
  reason: string | null;
}

type WorkflowPatchEvent = Extract<WorkflowRunEvent, { type: "patch" }>;

export function getWorkflowCheckpointRetryEligibility(
  run: WorkflowRunRecord | null | undefined
): WorkflowCheckpointRetryEligibility {
  if (run == null) {
    return { canRetry: false, reason: "Workflow run is not available" };
  }
  if (run.status !== "failed") {
    return { canRetry: false, reason: `Workflow run is not failed: ${run.id}` };
  }
  const latestError = run.events.findLast((event) => event.type === "error");
  if (
    latestError?.message !== WORKFLOW_CHECKPOINT_RETRY_ERROR_MESSAGE &&
    !failedBecauseOfEvaluationStep(run, latestError?.message)
  ) {
    return { canRetry: false, reason: "Workflow run cannot be retried from checkpoint" };
  }
  const unsafePatchReason = getUnsafePatchRetryReason(run);
  if (unsafePatchReason != null) {
    return { canRetry: false, reason: unsafePatchReason };
  }
  return { canRetry: true, reason: null };
}

export function canRetryWorkflowFromCheckpoint(run: WorkflowRunRecord | null | undefined): boolean {
  return getWorkflowCheckpointRetryEligibility(run).canRetry;
}

/**
 * A run that failed because an `evaluate()` step failed (provider error,
 * deadline, revoked key, …) is retryable: the runner re-attempts that step with
 * its persisted admission (same model selection, attempt + 1, capped) and
 * replays every completed step. The failed record carries the exact error the
 * runner raised; the run's latest error is that text, optionally prefixed by
 * the error name when the sandbox rethrew it. Only those two exact forms
 * count: an author-thrown error that merely embeds the message does not.
 */
function failedBecauseOfEvaluationStep(
  run: WorkflowRunRecord,
  latestErrorMessage: string | undefined
): boolean {
  if (latestErrorMessage === undefined) {
    return false;
  }
  return run.steps.some(
    (step) =>
      step.status === "failed" &&
      step.evaluation != null &&
      step.error !== undefined &&
      (latestErrorMessage === step.error ||
        latestErrorMessage === `${WORKFLOW_EVALUATION_STEP_ERROR_NAME}: ${step.error}`)
  );
}

function getUnsafePatchRetryReason(run: WorkflowRunRecord): string | null {
  const latestPatchEventsByStep = new Map<string, WorkflowPatchEvent>();
  for (const event of run.events) {
    if (event.type === "patch") {
      latestPatchEventsByStep.set(getPatchEventKey(event), event);
    }
  }

  for (const event of latestPatchEventsByStep.values()) {
    if (event.status === "started" || event.status === "failed") {
      return "Workflow run cannot be retried from checkpoint with unfinished patch steps";
    }
    if (!hasCompletedPatchStep(run, event)) {
      return "Workflow run cannot be retried from checkpoint with incomplete patch step records";
    }
  }
  return null;
}

function hasCompletedPatchStep(run: WorkflowRunRecord, event: WorkflowPatchEvent): boolean {
  return run.steps.some(
    (step) =>
      step.stepId === event.stepId &&
      step.taskId === event.sourceTaskId &&
      step.status === "completed" &&
      step.result?.structuredOutput != null
  );
}

function getPatchEventKey(event: WorkflowPatchEvent): string {
  return `${event.stepId}\0${event.sourceTaskId}`;
}
