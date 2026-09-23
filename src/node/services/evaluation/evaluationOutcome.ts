import assert from "node:assert";
import { Cause, Effect, Exit, Option } from "effect";
import type { EvaluationErrorCode, EvaluationErrorReason } from "@/common/types/evaluation";
import type { EvaluationError } from "@/node/services/evaluation/evaluationService";

/**
 * Pure bridge from an `EvaluationService.evaluate` effect to a Promise-facing,
 * structurally classified outcome for the workflow runner.
 *
 * Classification reads the `Exit`, never a thrown value, so every path the
 * runner must persist (completed / typed failure / deadline / interruption /
 * defect) is distinguishable. Deliberately no logging here: a defect cause can
 * carry provider payloads or the evaluated state, and this module exposes only
 * the fixed code so untrusted text stays out of records and logs.
 */

export type EvaluationOutcomeFailureReason = EvaluationErrorReason | "deadline";
export type EvaluationOutcomeFailureCode = EvaluationErrorCode | "deadline";

export type EvaluationOutcome<A> =
  | { readonly status: "completed"; readonly result: A }
  | {
      readonly status: "failed";
      readonly reason: EvaluationOutcomeFailureReason;
      readonly code: EvaluationOutcomeFailureCode;
      readonly statusCode?: number;
      /** True when the effect died (bug or unclassified throw) instead of failing with an EvaluationError. */
      readonly defect: boolean;
    }
  | { readonly status: "interrupted" };

export interface RunEvaluationToOutcomeOptions {
  /** The workflow runtime's abort signal; when it fired, the outcome is `interrupted`. */
  readonly runtimeAbortSignal: AbortSignal;
  /** Attempt budget from now. Exactly one of `timeoutMs` / `deadlineAt` is required. */
  readonly timeoutMs?: number;
  /** Absolute attempt deadline (epoch ms). Exactly one of `timeoutMs` / `deadlineAt` is required. */
  readonly deadlineAt?: number;
}

/**
 * Classify a settled `Exit`. Runtime abort wins over the timeout: when both
 * signals fired, the runner asked to stop and the step must not be recorded as
 * a deadline failure.
 */
export function classifyEvaluationExit<A>(
  exit: Exit.Exit<A, EvaluationError>,
  runtimeAbortSignal: AbortSignal
): EvaluationOutcome<A> {
  if (Exit.isSuccess(exit)) {
    return { status: "completed", result: exit.value };
  }

  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error)) {
    return {
      status: "failed",
      reason: error.value.reason,
      code: error.value.code,
      ...(error.value.statusCode !== undefined ? { statusCode: error.value.statusCode } : {}),
      defect: false,
    };
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return runtimeAbortSignal.aborted
      ? { status: "interrupted" }
      : { status: "failed", reason: "deadline", code: "deadline", defect: false };
  }

  // Any other cause is a defect. The cause object is intentionally not part of
  // the outcome (see module doc).
  return { status: "failed", reason: "provider-failure", code: "unknown", defect: true };
}

export async function runEvaluationToOutcome<A>(
  effect: Effect.Effect<A, EvaluationError>,
  options: RunEvaluationToOutcomeOptions
): Promise<EvaluationOutcome<A>> {
  assert(
    (options.timeoutMs === undefined) !== (options.deadlineAt === undefined),
    "runEvaluationToOutcome requires exactly one of timeoutMs or deadlineAt"
  );
  const remainingMs =
    options.timeoutMs ?? Math.max(0, (options.deadlineAt ?? Number.NaN) - Date.now());
  assert(
    Number.isFinite(remainingMs) && remainingMs >= 0,
    "runEvaluationToOutcome requires a finite, non-negative attempt budget"
  );

  // Settle synchronously when nothing can run: a runtime abort that already
  // happened is an interruption, and an already-expired budget is a deadline
  // failure. `AbortSignal.timeout(0)` aborts on a later task, so without this
  // the effect could dispatch (and bill) a provider request, or even complete
  // through an immediately resolved promise, before the timer fires.
  if (options.runtimeAbortSignal.aborted) {
    return { status: "interrupted" };
  }
  if (remainingMs === 0) {
    return { status: "failed", reason: "deadline", code: "deadline", defect: false };
  }

  const signal = AbortSignal.any([options.runtimeAbortSignal, AbortSignal.timeout(remainingMs)]);
  const exit = await Effect.runPromiseExit(effect, { signal });
  return classifyEvaluationExit(exit, options.runtimeAbortSignal);
}
