import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { WorkflowRunEvent, WorkflowStepRecord } from "@/common/types/workflow";
import {
  EvaluationAdmissionSchema,
  EvaluationStateSchema,
  EvaluationStepResultSchema,
  WorkflowEvaluateSpecSchema,
  canonicalEvaluationJson,
  canonicalRequestBytes,
  parseEvaluationInputBounded,
  validateAnswersAgainstQuestions,
  type EvaluationAdmission,
  type EvaluationState,
  WORKFLOW_EVALUATION_STEP_ERROR_NAME,
  type EvaluationStepFailureCode,
  type EvaluationStepFailureReason,
  type EvaluationStepResult,
  type WorkflowEvaluateSpec,
} from "@/common/types/evaluation";
import assert from "@/common/utils/assert";
import {
  EVALUATION_DEFAULT_TIMEOUT_MS,
  EVALUATION_MAX_ATTEMPTS,
  EVALUATION_MAX_TIMEOUT_MS,
  EVALUATION_MIN_TIMEOUT_MS,
} from "@/constants/evaluation";
import { sha256Hex } from "@/node/services/evaluation/evaluationDigest";
import { log } from "@/node/services/log";
import type { WorkflowEvaluationAdapter } from "./WorkflowEvaluationAdapter";
import type { WorkflowRunStore } from "./WorkflowRunStore";
import { assertWorkflowStepId, hashWorkflowStepInput } from "./workflowReplayKey";

/**
 * The workflow `evaluate()` step lifecycle (plan §"Step lifecycle contract"):
 * validate → hash → lookup/replay → select → admit → recheck → dispatch →
 * commit → account. Lives outside `WorkflowRunner` so the runner only
 * registers the host function and lends its journal wrappers; every branch
 * here is unit-testable with a fake adapter and store.
 *
 * Text discipline (plan §"Security model"): everything this module writes
 * into step `error`, `reportMarkdown`, thrown messages or log lines is built
 * from fixed templates over enum/number/digest fields. Author text (`state`,
 * step id, `title`, option labels) and provider text (model ids, response
 * bodies) never enter those surfaces; `title`/`modelString`/`responseModelId`
 * appear only in their own event fields, rendered through React escaping.
 * The thrown message is also the run `error` that
 * `buildWorkflowResultContextMessage` forwards to the parent chat on failure,
 * so it must stay template-only.
 */

export interface WorkflowEvaluationStepJournal {
  readonly getStep: WorkflowRunStore["getStep"];
  readonly recordStepStarted: (
    input: Parameters<WorkflowRunStore["recordStepStarted"]>[1]
  ) => Promise<void>;
  readonly recordStepCompleted: (
    input: Parameters<WorkflowRunStore["recordStepCompleted"]>[1]
  ) => Promise<void>;
  readonly recordStepFailed: (
    input: Parameters<WorkflowRunStore["recordStepFailed"]>[1]
  ) => Promise<void>;
  /** Appends with the next sequence number under the runner's lease. */
  readonly appendEvent: (event: WorkflowEvaluationRunEventDraft) => Promise<void>;
}

/** The `evaluation` run event without its sequence (assigned by the runner). */
export type WorkflowEvaluationRunEventDraft = Omit<
  Extract<WorkflowRunEvent, { type: "evaluation" }>,
  "sequence"
>;

/** The adapter surface this lifecycle consumes; `WorkflowEvaluationAdapter` implements it, tests fake it. */
export type WorkflowEvaluationPort = Pick<
  WorkflowEvaluationAdapter,
  "resolveSelection" | "dispatch" | "recordUsage"
>;

export interface WorkflowEvaluationStepContext {
  readonly runId: string;
  /** Absent when the host has no evaluation services; the step fails closed. */
  readonly adapter: WorkflowEvaluationPort | undefined;
  readonly journal: WorkflowEvaluationStepJournal;
  readonly clock: { nowIso(): string; nowMs(): number };
  readonly leaseGuard: { throwIfLost(): void };
  readonly abortSignal: AbortSignal;
}

/** Thrown into the sandbox; authors may catch it, but a caught failure is never an answer. */
export class WorkflowEvaluationStepError extends Error {
  constructor(
    readonly reason: EvaluationStepFailureReason,
    readonly code: EvaluationStepFailureCode,
    readonly stepDigest: string,
    readonly attempt: number,
    readonly statusCode?: number
  ) {
    super(formatEvaluationFailure({ reason, code, statusCode, stepDigest, attempt }));
    this.name = WORKFLOW_EVALUATION_STEP_ERROR_NAME;
  }
}

/** The runner maps this exact message to an interrupted (not failed) terminal status. */
export const WORKFLOW_EVALUATION_INTERRUPTED_MESSAGE = "Task interrupted";

export const EVALUATION_POST_COMMIT_EVENT_FAILED_CODE = "evaluation-post-commit-event-failed";
export const EVALUATION_POST_COMMIT_USAGE_FAILED_CODE = "evaluation-post-commit-usage-failed";
export const EVALUATION_CACHED_EVENT_FAILED_CODE = "evaluation-cached-event-failed";

export function formatEvaluationFailure(input: {
  reason: EvaluationStepFailureReason;
  code: EvaluationStepFailureCode;
  statusCode?: number;
  stepDigest: string;
  attempt: number;
}): string {
  const status = input.statusCode !== undefined ? ` status ${input.statusCode}` : "";
  return `evaluation failed: ${input.reason}/${input.code}${status} (step ${input.stepDigest}, attempt ${input.attempt})`;
}

export function evaluationStepDigest(stepId: string): string {
  return sha256Hex(stepId).slice(0, 12);
}

/**
 * Replay identity: everything that shapes the provider request (state,
 * questions, per-call model, provider options). The Settings default, timeout
 * and title are execution config and stay out of the key, so a completed step
 * never replays a result produced under different request settings.
 */
export function hashEvaluationStepInput(
  spec: WorkflowEvaluateSpec,
  state: EvaluationState
): string {
  return hashWorkflowStepInput(spec.id, {
    kind: "evaluate",
    state,
    questions: spec.questions,
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.providerOptions !== undefined ? { providerOptions: spec.providerOptions } : {}),
  });
}

function clampTimeoutMs(requested: number | undefined): number {
  const value = requested ?? EVALUATION_DEFAULT_TIMEOUT_MS;
  return Math.min(EVALUATION_MAX_TIMEOUT_MS, Math.max(EVALUATION_MIN_TIMEOUT_MS, value));
}

function interrupted(): Error {
  return new Error(WORKFLOW_EVALUATION_INTERRUPTED_MESSAGE);
}

export async function runWorkflowEvaluationStep(
  context: WorkflowEvaluationStepContext,
  rawState: unknown,
  rawSpec: unknown
): Promise<EvaluationStepResult> {
  const { journal, clock, leaseGuard, abortSignal } = context;

  // 1. Validate before any selection or provider call. The step id is not
  //    known until the spec parses, so pre-parse failures carry no digest.
  const parsedSpec = parseEvaluationInputBounded(WorkflowEvaluateSpecSchema, rawSpec);
  if (!parsedSpec.ok) {
    throw new WorkflowEvaluationStepError(
      "invalid-input",
      parsedSpec.violation === "invalid" ? "invalid-spec" : parsedSpec.violation,
      "unknown",
      1
    );
  }
  const spec = parsedSpec.value;
  assertWorkflowStepId(spec.id, "evaluate");
  const stepDigest = evaluationStepDigest(spec.id);
  const parsedState = parseEvaluationInputBounded(EvaluationStateSchema, rawState);
  if (!parsedState.ok) {
    throw new WorkflowEvaluationStepError(
      "invalid-input",
      parsedState.violation === "invalid" ? "invalid-state" : parsedState.violation,
      stepDigest,
      1
    );
  }
  const state = parsedState.value;
  const canonical = canonicalRequestBytes({ state, questions: spec.questions });
  if (!canonical.ok) {
    throw new WorkflowEvaluationStepError("invalid-input", canonical.violation, stepDigest, 1);
  }
  if (context.adapter === undefined) {
    throw new WorkflowEvaluationStepError("unsupported", "runtime-unavailable", stepDigest, 1);
  }
  const adapter = context.adapter;
  const questionCount = Object.keys(spec.questions).length;
  const stateCanonical = canonicalEvaluationJson(state);
  const stateSha256 = sha256Hex(stateCanonical);
  const stateBytes = Buffer.byteLength(stateCanonical, "utf8");
  const questionsSha256 = sha256Hex(canonicalEvaluationJson(spec.questions));

  // 2. Entry time precedes lookup so preparation counts against the deadline.
  const enteredAt = clock.nowMs();
  const inputHash = hashEvaluationStepInput(spec, state);
  leaseGuard.throwIfLost();

  // 3. Lookup.
  const existing = await journal.getStep(context.runId, spec.id, inputHash);
  if (existing?.status === "completed") {
    return await replayCompletedStep(context, { spec, existing, inputHash, stepDigest });
  }

  let attempt = 1;
  let persisted: EvaluationAdmission | undefined;
  if (existing !== null) {
    // `started` (resume) or `failed`/`interrupted` (checkpoint retry): every
    // record of an evaluate step carries its admission, so a missing or
    // malformed one is corruption and fails closed instead of re-selecting.
    const admission = EvaluationAdmissionSchema.safeParse(existing.evaluation);
    if (!admission.success) {
      const error = new WorkflowEvaluationStepError(
        "admission-missing",
        "admission-missing",
        stepDigest,
        1
      );
      await recordFailure(context, {
        spec,
        inputHash,
        startedAt: existing.startedAt,
        admission: undefined,
        error,
      });
      throw error;
    }
    persisted = admission.data;
    attempt = persisted.attempt + 1;
  }
  const timeoutMs = persisted?.timeoutMs ?? clampTimeoutMs(spec.timeoutMs);
  const attemptDeadlineAt = enteredAt + timeoutMs;
  const startedAt = existing?.startedAt ?? clock.nowIso();

  // 4. Selection (pre-admission: on a first attempt failures here write no
  //    step record; once a record is admitted, every failure is written onto
  //    it so the run stays recoverable — see below).
  if (attempt > EVALUATION_MAX_ATTEMPTS) {
    assert(persisted !== undefined, "attempt > 1 requires a persisted admission");
    const error = new WorkflowEvaluationStepError(
      "attempts-exhausted",
      "attempts-exhausted",
      stepDigest,
      attempt
    );
    await recordFailure(context, { spec, inputHash, startedAt, admission: persisted, error });
    throw error;
  }
  const selection = await adapter.resolveSelection({ model: spec.model }, persisted?.selection);
  if (!selection.ok) {
    const error = new WorkflowEvaluationStepError(
      selection.reason,
      selection.code,
      stepDigest,
      attempt
    );
    if (persisted !== undefined) {
      // A resumed or retried step already owns a record. Writing this failure
      // onto it (keeping the persisted admission — no billable attempt was
      // admitted, so the budget is untouched) is what lets a later checkpoint
      // retry match the run's error to a failed evaluation step; otherwise a
      // revoked key would strand the run at a `started` or stale record with
      // neither resume nor retry available after the credentials return.
      await recordFailure(context, { spec, inputHash, startedAt, admission: persisted, error });
    } else {
      assert(
        selection.reason !== "admission-mismatch",
        "admission-mismatch requires a persisted admission"
      );
    }
    throw error;
  }
  if (abortSignal.aborted) {
    throw interrupted();
  }
  if (clock.nowMs() >= attemptDeadlineAt) {
    const error = new WorkflowEvaluationStepError("deadline", "deadline", stepDigest, attempt);
    if (persisted !== undefined) {
      // Same recoverability rule as a failed selection above.
      await recordFailure(context, { spec, inputHash, startedAt, admission: persisted, error });
    }
    throw error;
  }
  leaseGuard.throwIfLost();

  // 5. Admission: one record write carrying everything a resume needs.
  const admission: EvaluationAdmission = {
    attempt,
    selection: {
      modelString: selection.pinned.modelString,
      effectiveModelString: selection.pinned.effectiveModelString,
      wireProviderName: selection.pinned.wireProviderName,
      routeKind: selection.pinned.routeKind,
      configFingerprint: selection.pinned.configFingerprint,
    },
    timeoutMs,
    attemptDeadlineAt: new Date(attemptDeadlineAt).toISOString(),
    ...(spec.providerOptions !== undefined ? { providerOptions: spec.providerOptions } : {}),
    stateSha256,
    stateBytes,
    questionsSha256,
    questionCount,
  };
  await journal.recordStepStarted({
    stepId: spec.id,
    inputHash,
    startedAt,
    evaluation: admission,
  });
  await journal.appendEvent({
    type: "evaluation",
    at: clock.nowIso(),
    stepId: spec.id,
    inputHash,
    attempt,
    status: "started",
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    modelString: admission.selection.modelString,
    stateBytes,
    questionCount,
  });

  // 6. Recheck immediately before dispatch; the re-resolved instance is the
  //    one dispatched so a credential/endpoint change during preparation is
  //    caught here rather than mid-request.
  const failPostAdmission = async (
    reason: EvaluationStepFailureReason,
    code: EvaluationStepFailureCode,
    statusCode?: number,
    defect?: boolean
  ): Promise<never> => {
    const error = new WorkflowEvaluationStepError(reason, code, stepDigest, attempt, statusCode);
    await recordFailure(context, { spec, inputHash, startedAt, admission, error, defect });
    throw error;
  };
  leaseGuard.throwIfLost();
  if (abortSignal.aborted) {
    throw interrupted();
  }
  if (clock.nowMs() >= attemptDeadlineAt) {
    return await failPostAdmission("deadline", "deadline");
  }
  const rechecked = await adapter.resolveSelection({ model: spec.model }, admission.selection);
  if (!rechecked.ok) {
    return await failPostAdmission(rechecked.reason, rechecked.code);
  }
  leaseGuard.throwIfLost();
  if (abortSignal.aborted) {
    throw interrupted();
  }
  if (clock.nowMs() >= attemptDeadlineAt) {
    return await failPostAdmission("deadline", "deadline");
  }

  // 7. Dispatch.
  const outcome = await adapter.dispatch(
    rechecked.pinned,
    {
      state,
      questions: spec.questions,
      ...(spec.providerOptions !== undefined
        ? { providerOptions: spec.providerOptions as SharedV4ProviderOptions }
        : {}),
    },
    { runtimeAbortSignal: abortSignal, attemptDeadlineAt }
  );
  if (outcome.status === "interrupted") {
    throw interrupted();
  }
  if (outcome.status === "failed") {
    return await failPostAdmission(
      outcome.reason,
      outcome.code,
      outcome.statusCode,
      outcome.defect
    );
  }

  // 8. Completion: validate → lease → commit. Once the completed record is
  //    durable the step is complete; nothing after `completedCommitted` may
  //    turn it into a failure or dispatch again.
  const validated = validateAnswersAgainstQuestions(
    spec.questions,
    outcome.result.answers,
    outcome.result.rounding
  );
  if (!validated.ok) {
    return await failPostAdmission("invalid-output", "answer-validation");
  }
  const result: EvaluationStepResult = {
    answers: validated.answers,
    rounding: outcome.result.rounding,
    model: {
      modelString: rechecked.pinned.modelString,
      responseModelId: outcome.result.responseModelId,
    },
    usage: outcome.result.usage,
    state: { sha256: stateSha256, bytes: stateBytes },
  };
  leaseGuard.throwIfLost();
  await journal.recordStepCompleted({
    stepId: spec.id,
    inputHash,
    result: {
      ...(spec.title !== undefined ? { title: spec.title } : {}),
      reportMarkdown: `Evaluation step completed (${questionCount} answers)`,
      structuredOutput: result,
    },
    startedAt,
    completedAt: clock.nowIso(),
    evaluation: admission,
  });
  // --- irreversible boundary ---
  try {
    await journal.appendEvent({
      type: "evaluation",
      at: clock.nowIso(),
      stepId: spec.id,
      inputHash,
      attempt,
      status: "completed",
      ...(spec.title !== undefined ? { title: spec.title } : {}),
      modelString: result.model.modelString,
      responseModelId: result.model.responseModelId,
      usage: result.usage,
      stateBytes,
      questionCount,
    });
  } catch (error) {
    log.warn("Workflow evaluation completed event append failed after commit", {
      code: EVALUATION_POST_COMMIT_EVENT_FAILED_CODE,
      runId: context.runId,
      stepDigest,
      attempt,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  // Ledger after journal (documented accounting contract): a crash between the
  // two under-counts. The adapter swallows its own ledger failures; the catch
  // keeps the committed step from failing if an adapter ever breaks that rule.
  try {
    await adapter.recordUsage(rechecked.pinned, outcome.result, {
      runId: context.runId,
      stepDigest,
      attempt,
    });
  } catch (error) {
    log.warn("Workflow evaluation usage accounting threw after commit", {
      code: EVALUATION_POST_COMMIT_USAGE_FAILED_CODE,
      runId: context.runId,
      stepDigest,
      attempt,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return result;
}

/**
 * A completed record is immutable for its `(stepId, inputHash)`: a valid stored
 * result is returned verbatim and never re-dispatched; a malformed one fails
 * the run without touching the record (an older build's reader may have
 * written something this build cannot trust).
 */
async function replayCompletedStep(
  context: WorkflowEvaluationStepContext,
  input: {
    spec: WorkflowEvaluateSpec;
    existing: WorkflowStepRecord;
    inputHash: string;
    stepDigest: string;
  }
): Promise<EvaluationStepResult> {
  const parsed = EvaluationStepResultSchema.safeParse(input.existing.result?.structuredOutput);
  const validated = parsed.success
    ? validateAnswersAgainstQuestions(
        input.spec.questions,
        parsed.data.answers,
        parsed.data.rounding
      )
    : undefined;
  if (!parsed.success || validated?.ok !== true) {
    throw new Error(`evaluation replay failed: cached result invalid (step ${input.stepDigest})`);
  }
  const admission = EvaluationAdmissionSchema.safeParse(input.existing.evaluation);
  try {
    await context.journal.appendEvent({
      type: "evaluation",
      at: context.clock.nowIso(),
      stepId: input.spec.id,
      inputHash: input.inputHash,
      attempt: admission.success ? admission.data.attempt : 1,
      status: "cached",
      ...(input.spec.title !== undefined ? { title: input.spec.title } : {}),
      modelString: parsed.data.model.modelString,
      responseModelId: parsed.data.model.responseModelId,
      usage: parsed.data.usage,
      stateBytes: parsed.data.state.bytes,
      questionCount: Object.keys(input.spec.questions).length,
    });
  } catch (error) {
    // The completed record is the source of truth; a missing progress event
    // must not fail a step that already finished.
    log.warn("Workflow evaluation cached event append failed", {
      code: EVALUATION_CACHED_EVENT_FAILED_CODE,
      runId: context.runId,
      stepDigest: input.stepDigest,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return parsed.data;
}

async function recordFailure(
  context: WorkflowEvaluationStepContext,
  input: {
    spec: WorkflowEvaluateSpec;
    inputHash: string;
    startedAt: string;
    admission: EvaluationAdmission | undefined;
    error: WorkflowEvaluationStepError;
    defect?: boolean;
  }
): Promise<void> {
  const { spec, error } = input;
  await context.journal.recordStepFailed({
    stepId: spec.id,
    inputHash: input.inputHash,
    error: error.message,
    startedAt: input.startedAt,
    completedAt: context.clock.nowIso(),
    ...(input.admission !== undefined ? { evaluation: input.admission } : {}),
  });
  await context.journal.appendEvent({
    type: "evaluation",
    at: context.clock.nowIso(),
    stepId: spec.id,
    inputHash: input.inputHash,
    attempt: error.attempt,
    status: "failed",
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    ...(input.admission !== undefined
      ? { modelString: input.admission.selection.modelString }
      : {}),
    reason: error.reason,
    code: error.code,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(input.defect ? { defect: true } : {}),
  });
}
