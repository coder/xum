import { StructuredTaskOutputSchema, WorkflowResultSchema } from "@/common/orpc/schemas";
import { TaskApplyGitPatchToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import type { TaskAttemptOutcome, TaskAttemptSettlement } from "@/common/types/tasks";
import type {
  StructuredTaskOutput,
  WorkflowResult,
  WorkflowRunEvent,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import { parseThinkingInput, type ParsedThinkingInput } from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";
import {
  WORKFLOW_AGENT_RESERVATION_TIMEOUT_MS,
  WORKFLOW_ATTEMPT_SETTLEMENT_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { WORKFLOW_RUNTIME_STDLIB_SOURCE } from "./workflowRuntimeSources.generated";
import { log } from "@/node/services/log";
import type { IJSRuntime, IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type {
  AppendWorkflowRunEventOptions,
  WorkflowAgentAttemptWriteOptions,
  WorkflowCancellationSettlement,
  WorkflowRunStore,
} from "./WorkflowRunStore";
import { assertWorkflowStepId, hashWorkflowStepInput } from "./workflowReplayKey";

export class WorkflowRunBackgroundedError extends Error {
  constructor(runId: string) {
    super(`Workflow run backgrounded: ${runId}`);
    this.name = "WorkflowRunBackgroundedError";
  }
}

class WorkflowAgentOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowAgentOutputValidationError";
  }
}

const WORKFLOW_RUN_ALREADY_ACTIVE_PREFIX = "Workflow run is already active: ";

/**
 * Another runner holds the run's lease. The message carries the lease owner and how long ago
 * it was last renewed so a stuck-lease diagnosis does not require reading lease.json by hand.
 */
export class WorkflowRunAlreadyActiveError extends Error {
  constructor(
    readonly runId: string,
    readonly lease: { ownerId: string; renewedAgoMs: number } | null
  ) {
    super(
      lease == null
        ? `${WORKFLOW_RUN_ALREADY_ACTIVE_PREFIX}${runId}`
        : `${WORKFLOW_RUN_ALREADY_ACTIVE_PREFIX}${runId} (lease owner ${lease.ownerId}, renewed ${Math.round(lease.renewedAgoMs / 1000)}s ago)`
    );
    this.name = "WorkflowRunAlreadyActiveError";
  }
}

/**
 * Callers classify by this predicate, never by exact message: the message now carries lease
 * diagnostics, and errors that crossed a serialization boundary keep only the legacy text.
 */
export function isWorkflowRunAlreadyActiveError(error: unknown, runId: string): boolean {
  if (error instanceof WorkflowRunAlreadyActiveError) {
    return error.runId === runId;
  }
  const message = getErrorMessage(error);
  const base = `${WORKFLOW_RUN_ALREADY_ACTIVE_PREFIX}${runId}`;
  return message === base || message.startsWith(`${base} (`);
}

/** The reservation deadline fired while the child task was still in a cancellable admission stage. */
export class WorkflowAgentReservationTimeoutError extends Error {
  constructor(stepIds: readonly string[], timeoutMs: number) {
    super(`Workflow agent reservation for ${stepIds.join(", ")} exceeded ${timeoutMs}ms`);
    this.name = "WorkflowAgentReservationTimeoutError";
  }
}

/**
 * A resumed step's prior attempt could not be classified as reported, live, or settled without a
 * report. The run is re-interrupted (never failed, never replaced): a later resume re-inspects.
 */
export class WorkflowPriorAttemptUnresolvedError extends Error {
  constructor(
    readonly stepId: string,
    readonly taskId: string,
    readonly outcome: "indeterminate" | "cleanup-pending" | "timeout",
    detail: string
  ) {
    // Avoid the word "interrupted": the sandbox normalizes any such error text.
    super(`Workflow agent step ${stepId} previous attempt ${taskId} is unresolved: ${detail}`);
    this.name = "WorkflowPriorAttemptUnresolvedError";
  }
}

function createReservationCanceledError(stepIds: readonly string[]): Error {
  return new Error(`Workflow agent reservation canceled for ${stepIds.join(", ")}`);
}

/** A durably checkpointed attempt this runner instance owns until it settles or is replaced. */
interface OwnedWorkflowAgentAttempt {
  stepId: string;
  inputHash: string;
  taskId: string;
  title?: string;
  resultSpec: WorkflowAgentSpec;
  startedAt: string;
  /**
   * Releases this attempt's share of its reservation's upstream abort link (see
   * reserveAgentTasks). Called when the attempt settles, is superseded, or the run ends.
   */
  releaseLaunchSignal?: () => void;
}

function getOwnedAttemptKey(attempt: { stepId: string; inputHash: string }): string {
  return `${attempt.stepId}\0${attempt.inputHash}`;
}

type WorkflowAttemptDisposition =
  | { kind: "completed"; result: StructuredTaskOutput }
  | { kind: "failed" }
  | { kind: "retained"; outcome: TaskAttemptSettlement<WorkflowAgentResult>["kind"] };

/** What a wait or classification decided about a prior attempt before the caller continues. */
type WorkflowPriorAttemptPlan =
  | { kind: "adopt"; report: WorkflowAgentResult }
  | { kind: "reattach" }
  | { kind: "replace" }
  | { kind: "rethrow" };

export interface WorkflowAgentTimeoutSpec {
  softMs: number;
  graceMs: number;
  finalInstructions?: string;
}

export interface WorkflowAgentSpec {
  id: string;
  prompt: string;
  title?: string;
  agentId?: string;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  isolation?: "fork" | "none";
  outputSchema?: unknown;
  timeout?: WorkflowAgentTimeoutSpec;
  /** Internal marker for new `agent(prompt, { id })` prose-only steps. */
  markdownOnly?: boolean;
  /**
   * Model-refusal policy for this step's child task. "fail" opts out of
   * configured model-fallback chains so a refusal fails the step terminally
   * (verifier steps demand honest failure, not a silent model swap).
   * Defaults to "fallback" (chains apply when configured).
   */
  onRefusal?: "fail" | "fallback";
}

export interface WorkflowAgentWaitOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  backgroundOnMessageQueued?: boolean;
  onExecutionStarted?: () => void | Promise<void>;
}

export type WorkflowAgentResult = StructuredTaskOutput & { taskId: string };

interface WorkflowAgentRunResult {
  rawResult: WorkflowAgentResult;
  resultSpec: WorkflowAgentSpec;
  /** The checkpointed attempt this result settles; every terminal write is fenced to it. */
  taskId: string;
}

interface StartedWorkflowAgentHandle {
  handleId: string;
}

interface StartedWorkflowAgentState {
  handleId: string;
  spec: WorkflowAgentSpec;
  resultSpec: WorkflowAgentSpec;
  inputHash: string;
  startedAt: string;
  taskId?: string;
  rawResultPromise?: Promise<WorkflowAgentResult>;
  terminalResult?: StructuredTaskOutput;
}

interface StartedWorkflowAgentCompletion {
  handleId: string;
  result: StructuredTaskOutput;
}

export type WorkflowApplyPatchStatus = "applied" | "conflict" | "failed";

export interface WorkflowApplyPatchSpec {
  id: string;
  sourceTaskId: string;
  /** Public workflow authors pass the stable `agent(..., { id })` value as `agentId`. */
  agentId?: string;
  target: "parent";
  projectPath?: string;
  threeWay: boolean;
  expectedHeadSha?: string;
  force: boolean;
  allowedPathPrefixes?: string[];
}

interface ParsedWorkflowApplyPatchSpec extends Omit<WorkflowApplyPatchSpec, "sourceTaskId"> {
  sourceTaskId?: string;
}

export interface WorkflowApplyPatchResult {
  success: boolean;
  status: WorkflowApplyPatchStatus;
  taskId: string;
  dryRun?: boolean;
  projectResults?: unknown;
  appliedCommits?: unknown;
  headCommitSha?: string;
  conflictPaths?: string[];
  failedPatchSubject?: string;
  error?: string;
  note?: string;
}

export interface WorkflowNestedWorkflowSpec {
  id: string;
  scriptPath: string;
  args: unknown;
}

export interface WorkflowNestedWorkflowRun {
  runId: string;
  name: string;
}

export interface WorkflowNestedWorkflowAdapter {
  createRun(input: {
    parentRunId: string;
    stepId: string;
    inputHash: string;
    spec: WorkflowNestedWorkflowSpec;
  }): Promise<WorkflowNestedWorkflowRun>;
  run(
    runId: string,
    options?: Pick<
      WorkflowRunnerRunOptions,
      | "abortSignal"
      | "backgroundOnMessageQueued"
      | "allowResumeFromInterrupted"
      | "allowRetryFromFailedCheckpoint"
    >
  ): Promise<WorkflowResult>;
}

export interface WorkflowTaskAdapter {
  runAgent(
    spec: WorkflowAgentSpec,
    lifecycle?: { onTaskCreated?: (taskId: string) => Promise<void> | void },
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  createAgentTasks?(
    specs: WorkflowAgentSpec[],
    lifecycle?: {
      onTaskCreated?: (index: number, taskId: string) => Promise<void> | void;
      /**
       * Cancels the reservation while it is still in a cancellable admission stage. Entered
       * checkpoint and config writes are owned to completion regardless.
       */
      abortSignal?: AbortSignal;
    }
  ): Promise<Array<{ taskId: string; status: "queued" | "starting" | "running" }>>;
  waitForAgentTask?(
    taskId: string,
    spec: WorkflowAgentSpec,
    waitOptions?: WorkflowAgentWaitOptions
  ): Promise<WorkflowAgentResult>;
  /**
   * Authoritative outcome of a checkpointed attempt. Absent when the task service cannot answer;
   * the runner then treats the attempt as indeterminate rather than guessing.
   */
  readSettledAgentResult?(taskId: string): Promise<TaskAttemptOutcome<WorkflowAgentResult>>;
  /** Bounded wait for an unsettled attempt; a timeout is never permission to replace it. */
  waitForAttemptSettlement?(
    taskId: string,
    options: { abortSignal?: AbortSignal; timeoutMs: number }
  ): Promise<TaskAttemptSettlement<WorkflowAgentResult>>;
  requestAgentFinalReportForTimeout?(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      finalizationToken: string;
      finalInstructions?: string;
    }
  ): Promise<"prompted" | "queued" | "already_reported" | "not_active">;
  failAgentTaskForHardTimeout?(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      reason: string;
    }
  ): Promise<void>;
  applyPatch?(
    spec: WorkflowApplyPatchSpec,
    options?: { abortSignal?: AbortSignal }
  ): Promise<unknown>;
  interruptRun?(): Promise<void>;
  /**
   * Called when the run reaches a terminal state. Not called when the run is
   * backgrounded (the background continuation re-enters run()) or when the
   * lease was held by another runner.
   */
  onRunEnded?(): Promise<void> | void;
}

export interface WorkflowRunnerRunOptions {
  onLeaseAcquired?: () => void;
  abortSignal?: AbortSignal;
  backgroundOnMessageQueued?: boolean;
  allowResumeFromInterrupted?: boolean;
  allowRetryFromFailedCheckpoint?: boolean;
}

interface WorkflowRunnerLeaseGuard {
  throwIfLost(): void;
}

export interface WorkflowRunnerClock {
  nowIso(): string;
  nowMs(): number;
}

export interface WorkflowRunnerOptions {
  runStore: WorkflowRunStore;
  runtimeFactory: IJSRuntimeFactory;
  taskAdapter: WorkflowTaskAdapter;
  nestedWorkflowAdapter?: WorkflowNestedWorkflowAdapter;
  runnerId: string;
  clock?: WorkflowRunnerClock;
  /** Reservation liveness backstop; defaults to WORKFLOW_AGENT_RESERVATION_TIMEOUT_MS (tests shorten it). */
  reservationTimeoutMs?: number;
}

const WORKFLOW_AGENT_MAX_ATTEMPTS = 3;

const WORKFLOW_RUNTIME_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Shared shape for the `.name`-tagged sentinel errors used throughout this runner
// (foreground-backgrounded, agent-report timeout, hard timeout). Keeps the
// `instanceof Error && error.name === ...` guard in one place so the individual
// predicates can't drift in how they recognize a tagged error.
function isErrorWithName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function isForegroundWaitBackgroundedError(error: unknown): boolean {
  return isErrorWithName(error, "ForegroundWaitBackgroundedError");
}

function createForegroundWaitBackgroundedError(): Error {
  const error = new Error("Workflow foreground wait backgrounded");
  error.name = "ForegroundWaitBackgroundedError";
  return error;
}

// Parallel fan-out primitives accept an optional second argument: { maxParallel?: number }.
// maxParallel caps how many steps run at once; remaining specs start as running
// ones finish (sliding window) instead of all launching up front.
function parseWorkflowParallelOptions(
  raw: unknown,
  primitiveName: "parallel"
): { maxParallel?: number } {
  if (raw == null) {
    return {};
  }
  assert(
    typeof raw === "object" && !Array.isArray(raw),
    `${primitiveName} options must be an object`
  );
  const { maxParallel } = raw as { maxParallel?: unknown };
  if (maxParallel == null) {
    return {};
  }
  assert(
    typeof maxParallel === "number" && Number.isInteger(maxParallel) && maxParallel > 0,
    `${primitiveName} options.maxParallel must be a positive integer`
  );
  return { maxParallel };
}

function parseParallelAgentsOptions(raw: unknown): { maxParallel?: number } {
  return parseWorkflowParallelOptions(raw, "parallel");
}

function isAgentReportWaitTimeoutError(error: unknown): boolean {
  return isErrorWithName(error, "AgentReportWaitTimeoutError");
}

function buildWorkflowAgentTimeoutFinalizationToken(
  runId: string,
  step: { spec: WorkflowAgentSpec; inputHash: string; taskId: string },
  softTimedOutAt: string
): string {
  return `workflow-agent-timeout:${runId}:${step.spec.id}:${step.inputHash}:${step.taskId}:${softTimedOutAt}`;
}

function createWorkflowAgentHardTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "WorkflowAgentHardTimeoutError";
  return error;
}

function isWorkflowAgentHardTimeoutError(error: unknown): boolean {
  return isErrorWithName(error, "WorkflowAgentHardTimeoutError");
}

function shouldRestartUnrecoverableStartedTask(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message === "Task not found" || message === "Task interrupted";
}

function getTaskTerminalStatusForError(
  error: unknown,
  abortSignal?: AbortSignal
): "failed" | "interrupted" {
  if (abortSignal?.aborted === true || getErrorMessage(error) === "Task interrupted") {
    return "interrupted";
  }
  return "failed";
}

function isRetryableAgentOutputError(error: unknown): boolean {
  return error instanceof WorkflowAgentOutputValidationError;
}

function buildRetryAgentSpec(
  spec: WorkflowAgentSpec,
  attempt: number,
  validationMessage: string
): WorkflowAgentSpec {
  return {
    ...spec,
    prompt:
      `${spec.prompt}\n\n` +
      `Previous workflow attempt ${attempt} failed output validation: ${validationMessage}\n` +
      "Rerun the task from scratch, call agent_report with structured output that satisfies the requested schema, then summarize the result in the final assistant response. " +
      "In file-backed report mode, rewrite structured-output.json before sending the structured update.",
  };
}

function abortRuntimeOnSignal(runtime: IJSRuntime, abortSignal?: AbortSignal): () => void {
  if (abortSignal == null) {
    return () => undefined;
  }
  if (abortSignal.aborted) {
    runtime.abort();
    return () => undefined;
  }
  const abortRuntime = () => runtime.abort();
  abortSignal.addEventListener("abort", abortRuntime, { once: true });
  return () => abortSignal.removeEventListener("abort", abortRuntime);
}

function getWorkflowAgentWaitOptions(
  runtime: IJSRuntime,
  options: WorkflowRunnerRunOptions | undefined
): WorkflowAgentWaitOptions {
  return {
    abortSignal: runtime.getAbortSignal(),
    timeoutMs: WORKFLOW_RUNTIME_TIMEOUT_MS,
    backgroundOnMessageQueued: options?.backgroundOnMessageQueued ?? true,
  };
}

const DEFAULT_CLOCK: WorkflowRunnerClock = {
  nowIso: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

export class WorkflowRunner {
  private readonly runStore: WorkflowRunStore;
  private readonly runtimeFactory: IJSRuntimeFactory;
  private readonly taskAdapter: WorkflowTaskAdapter;
  private readonly nestedWorkflowAdapter?: WorkflowNestedWorkflowAdapter;
  private readonly runnerId: string;
  private readonly clock: WorkflowRunnerClock;
  private readonly reservationTimeoutMs: number;
  private readonly taskEventMutex = new AsyncMutex();
  /**
   * Checkpointed attempts per active run, keyed by step identity. The cancellation drain settles
   * exactly these after a Stop; entries leave when their terminal write lands or a replacement
   * attempt is checkpointed under the same key.
   */
  private readonly ownedAttemptsByRun = new Map<string, Map<string, OwnedWorkflowAgentAttempt>>();

  constructor(options: WorkflowRunnerOptions) {
    assert(options.runnerId.length > 0, "WorkflowRunner: runnerId is required");
    this.runStore = options.runStore;
    this.runtimeFactory = options.runtimeFactory;
    this.taskAdapter = options.taskAdapter;
    this.nestedWorkflowAdapter = options.nestedWorkflowAdapter;
    this.runnerId = options.runnerId;
    this.clock = options.clock ?? DEFAULT_CLOCK;
    this.reservationTimeoutMs =
      options.reservationTimeoutMs ?? WORKFLOW_AGENT_RESERVATION_TIMEOUT_MS;
    assert(this.reservationTimeoutMs > 0, "WorkflowRunner: reservationTimeoutMs must be positive");
  }

  async run(runId: string, options?: WorkflowRunnerRunOptions): Promise<WorkflowResult> {
    assert(runId.length > 0, "WorkflowRunner.run: runId is required");
    try {
      const result = await this.runWithLease(runId, options);
      await this.taskAdapter.onRunEnded?.();
      return result;
    } catch (error) {
      // Backgrounding is not terminal (the background continuation re-enters
      // run()), and a lease-acquisition loss means another runner owns the run
      // and will release the hold itself when it finishes.
      const keepsHold =
        error instanceof WorkflowRunBackgroundedError ||
        isWorkflowRunAlreadyActiveError(error, runId);
      if (!keepsHold) {
        await this.taskAdapter.onRunEnded?.();
      }
      throw error;
    }
  }

  private async runWithLease(
    runId: string,
    options?: WorkflowRunnerRunOptions
  ): Promise<WorkflowResult> {
    const leaseAcquired = await this.runStore.acquireLease(
      runId,
      this.runnerId,
      this.clock.nowMs()
    );
    if (!leaseAcquired) {
      const lease = await this.runStore.getLeaseDiagnostics(runId, this.clock.nowMs());
      const error = new WorkflowRunAlreadyActiveError(runId, lease);
      log.warn(`[workflow-runner] ${error.message}`);
      throw error;
    }

    options?.onLeaseAcquired?.();
    this.ownedAttemptsByRun.set(runId, new Map());
    let activeRuntime: IJSRuntime | null = null;
    let leaseLostError: Error | null = null;
    const markLeaseLost = (cause?: unknown) => {
      leaseLostError ??= new Error(
        cause instanceof Error
          ? `Workflow run lease lost: ${runId}: ${cause.message}`
          : `Workflow run lease lost: ${runId}`
      );
      activeRuntime?.abort();
    };
    const leaseGuard: WorkflowRunnerLeaseGuard = {
      throwIfLost() {
        if (leaseLostError != null) {
          throw leaseLostError;
        }
      },
    };
    let leaseRenewalInFlight = false;
    const leaseRenewal = setInterval(() => {
      if (leaseRenewalInFlight) {
        return;
      }
      leaseRenewalInFlight = true;
      void this.runStore
        .renewLease(runId, this.runnerId, this.clock.nowMs())
        .then((renewed) => {
          if (!renewed) {
            markLeaseLost();
          }
        })
        .catch(markLeaseLost)
        .finally(() => {
          leaseRenewalInFlight = false;
        });
    }, this.runStore.getLeaseRenewalIntervalMs());

    let removeAbortListener: () => void = () => undefined;
    try {
      const run = await this.runStore.getRun(runId);
      const sequence = new WorkflowEventSequence(run.events.at(-1)?.sequence ?? 0);
      if (run.status === "completed") {
        const completedResult = run.events.findLast((event) => event.type === "result")?.result;
        if (completedResult != null) {
          return completedResult;
        }
      }
      const resumingInterruptedRun = run.status === "interrupted";
      const retryingFailedRun = run.status === "failed";
      if (resumingInterruptedRun && options?.allowResumeFromInterrupted !== true) {
        throw new Error(`Workflow run interrupted: ${runId}`);
      }
      if (retryingFailedRun && options?.allowRetryFromFailedCheckpoint !== true) {
        throw new Error(`Workflow run failed: ${runId}`);
      }
      const allowLegacyMissingOutputSchema = run.agentOutputSchemaRequired !== true;
      // Runs persisted before agentType was removed lack this marker but may still resume their
      // original source snapshot. New runs set it to false at creation and fail fast.
      const allowLegacyAgentType = run.agentTypeAliasAllowed !== false;
      let backgrounded: Promise<void> | null = null;
      const markBackgrounded = async () => {
        leaseGuard.throwIfLost();
        backgrounded ??= this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "backgrounded",
        }).then(() => undefined);
        await backgrounded;
      };
      // The sandbox flattens host errors to strings, so the typed blocker is kept here; it only
      // matters if the script lets it end the run (a script that catches it continues as usual).
      let priorAttemptUnresolved: WorkflowPriorAttemptUnresolvedError | null = null;
      const noteAgentStepFailure = async (error: unknown): Promise<void> => {
        if (isForegroundWaitBackgroundedError(error)) {
          await markBackgrounded();
        } else if (error instanceof WorkflowPriorAttemptUnresolvedError) {
          priorAttemptUnresolved ??= error;
        }
      };

      const startedWorkflowAgentSteps = new Map<string, StartedWorkflowAgentState>();
      let nextStartedWorkflowAgentHandleIndex = 0;
      const createStartedWorkflowAgentHandleId = (stepId: string): string => {
        assert(stepId.length > 0, "WorkflowRunner: started agent stepId is required");
        nextStartedWorkflowAgentHandleIndex += 1;
        return `agent:${nextStartedWorkflowAgentHandleIndex}:${stepId}`;
      };

      leaseGuard.throwIfLost();
      await this.appendEvent(
        runId,
        {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "running",
        },
        {
          allowInterruptedResume: resumingInterruptedRun,
          allowFailedCheckpointRetry: retryingFailedRun,
        }
      );

      let runtime: IJSRuntime | undefined;
      try {
        runtime = await this.runtimeFactory.create();
        const setupRuntime = runtime;
        activeRuntime = setupRuntime;
        if (leaseLostError != null) {
          setupRuntime.abort();
        }
        removeAbortListener = abortRuntimeOnSignal(setupRuntime, options?.abortSignal);
        setupRuntime.setLimits({ timeoutMs: WORKFLOW_RUNTIME_TIMEOUT_MS });
        setupRuntime.registerFunction("__workflowArgs", () => Promise.resolve(run.args));
        setupRuntime.registerFunction("__workflowPhase", async (name, details) => {
          assert(typeof name === "string" && name.length > 0, "phase requires a non-empty name");
          leaseGuard.throwIfLost();
          await this.appendEvent(runId, {
            sequence: sequence.next(),
            type: "phase",
            at: this.clock.nowIso(),
            name,
            details,
          });
          return null;
        });
        setupRuntime.registerFunction("__workflowLog", async (message, data) => {
          assert(
            typeof message === "string" && message.length > 0,
            "log requires a non-empty message"
          );
          leaseGuard.throwIfLost();
          await this.appendEvent(runId, {
            sequence: sequence.next(),
            type: "log",
            at: this.clock.nowIso(),
            message,
            data,
          });
          return null;
        });
        setupRuntime.registerFunction("__workflowAgent", async (rawSpec) => {
          try {
            return await this.runAgentStep(runId, sequence, rawSpec, {
              allowLegacyMissingOutputSchema,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
            });
          } catch (error) {
            await noteAgentStepFailure(error);
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowApplyPatch", async (rawSpec) => {
          try {
            return await this.runApplyPatchStep(runId, sequence, rawSpec, {
              abortSignal: setupRuntime.getAbortSignal(),
              leaseGuard,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowParallelAgents", async (rawSpecs, rawOptions) => {
          try {
            return await this.runAgentStepsInParallel(runId, sequence, rawSpecs, {
              allowLegacyMissingOutputSchema,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
              rawOptions,
            });
          } catch (error) {
            await noteAgentStepFailure(error);
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowAgentStart", async (rawSpec) => {
          try {
            return await this.startAgentStepWithoutWaiting(runId, sequence, rawSpec, {
              allowLegacyMissingOutputSchema,
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
              startedAgentSteps: startedWorkflowAgentSteps,
              createHandleId: createStartedWorkflowAgentHandleId,
            });
          } catch (error) {
            await noteAgentStepFailure(error);
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowAgentWaitAny", async (rawHandles) => {
          try {
            return await this.waitForAnyStartedAgentStep(runId, sequence, rawHandles, {
              waitOptions: getWorkflowAgentWaitOptions(setupRuntime, options),
              leaseGuard,
              startedAgentSteps: startedWorkflowAgentSteps,
            });
          } catch (error) {
            await noteAgentStepFailure(error);
            throw error;
          }
        });
        setupRuntime.registerFunction("__workflowNestedWorkflow", async (rawSpec) => {
          try {
            return await this.runNestedWorkflowStep(runId, sequence, rawSpec, {
              abortSignal: setupRuntime.getAbortSignal(),
              leaseGuard,
              allowResumeFromInterrupted: resumingInterruptedRun,
              allowRetryFromFailedCheckpoint: retryingFailedRun,
            });
          } catch (error) {
            if (isForegroundWaitBackgroundedError(error)) {
              await markBackgrounded();
            }
            throw error;
          }
        });
      } catch (error) {
        await this.appendFailureStatus(runId, sequence, error, {
          leaseGuard,
          abortSignal: options?.abortSignal,
        });
        throw error;
      }
      if (runtime == null) {
        throw new Error("Workflow runtime setup did not return a runtime");
      }
      using _runtimeResource = runtime;

      let compiledSource: string;
      try {
        compiledSource = compileWorkflowSource(run.source, { allowLegacyAgentType });
      } catch (error) {
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: error instanceof Error ? error.message : "Workflow compilation failed",
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw error;
      }

      const execution = await runtime.eval(compiledSource);
      if (!execution.success) {
        if (backgrounded != null) {
          throw new WorkflowRunBackgroundedError(runId);
        }
        if (options?.abortSignal?.aborted === true) {
          // Asyncified host functions settle before eval returns, so every step's own handling
          // is done; this runner is now the draining owner for its checkpointed attempts.
          await this.settleOwnedAttemptsAfterCancellation(
            runId,
            sequence,
            options.abortSignal,
            leaseGuard
          );
          throw new Error(execution.error ?? "Workflow run aborted");
        }
        if (priorAttemptUnresolved != null && leaseLostError == null) {
          const unresolved: WorkflowPriorAttemptUnresolvedError = priorAttemptUnresolved;
          await this.appendInterruptedForUnresolvedAttempt(runId, sequence, unresolved, leaseGuard);
          throw unresolved;
        }
        await this.throwIfInterrupted(runId);
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: execution.error ?? "Workflow execution failed",
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw new Error(execution.error ?? "Workflow execution failed");
      }

      await this.throwIfInterrupted(runId);
      let result: WorkflowResult;
      try {
        result = normalizeWorkflowResultForEvent(execution.result);
      } catch (error) {
        leaseGuard.throwIfLost();
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "error",
          at: this.clock.nowIso(),
          message: getErrorMessage(error),
        });
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "status",
          at: this.clock.nowIso(),
          status: "failed",
        });
        throw error;
      }
      leaseGuard.throwIfLost();
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "result",
        at: this.clock.nowIso(),
        result,
      });
      await this.throwIfInterrupted(runId);
      leaseGuard.throwIfLost();
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "status",
        at: this.clock.nowIso(),
        status: "completed",
      });
      return result;
    } finally {
      removeAbortListener();
      clearInterval(leaseRenewal);
      this.releaseOwnedAttempts(runId);
      await this.runStore.releaseLease(runId, this.runnerId);
    }
  }

  private async appendFailureStatus(
    runId: string,
    sequence: WorkflowEventSequence,
    error: unknown,
    options: { leaseGuard: WorkflowRunnerLeaseGuard; abortSignal?: AbortSignal }
  ): Promise<void> {
    if (options.abortSignal?.aborted === true) {
      return;
    }
    await this.throwIfInterrupted(runId);
    options.leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "error",
      at: this.clock.nowIso(),
      message: getErrorMessage(error),
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "status",
      at: this.clock.nowIso(),
      status: "failed",
    });
  }

  private async appendEvent(
    runId: string,
    event: WorkflowRunEvent,
    options: AppendWorkflowRunEventOptions = {}
  ) {
    const { sequence: _storeAssignedSequence, ...eventDraft } = event;
    return await this.runStore.appendNextEvent(runId, eventDraft, {
      ...options,
      expectedLeaseOwnerId: this.runnerId,
    });
  }

  private async recordStepStarted(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepStarted"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepStarted(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async recordStepCompleted(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepCompleted"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepCompleted(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async recordStepTimeoutMetadata(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepTimeoutMetadata"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepTimeoutMetadata(runId, input, {
      expectedLeaseOwnerId: this.runnerId,
    });
  }

  private async recordStepFailed(
    runId: string,
    input: Parameters<WorkflowRunStore["recordStepFailed"]>[1]
  ): Promise<void> {
    await this.runStore.recordStepFailed(runId, input, { expectedLeaseOwnerId: this.runnerId });
  }

  private async throwIfInterrupted(runId: string): Promise<void> {
    const run = await this.runStore.getRun(runId);
    if (run.status === "interrupted") {
      throw new Error(`Workflow run interrupted: ${runId}`);
    }
  }

  private async runApplyPatchStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowApplyPatchResult> {
    const parsedSpec = parseWorkflowApplyPatchSpec(rawSpec);
    const spec = await this.resolveWorkflowApplyPatchSpec(runId, parsedSpec);
    assertWorkflowStepId(spec.id, "applyPatch");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();
    const unsafePriorAttempt = await this.findUnsafePriorApplyPatchAttempt(
      runId,
      spec.id,
      inputHash
    );
    if (unsafePriorAttempt != null) {
      const message =
        unsafePriorAttempt.inputHash === inputHash
          ? `Workflow applyPatch step ${spec.id} has an incomplete or failed patch attempt and cannot be replayed automatically`
          : `Workflow applyPatch step ${spec.id} has a prior patch attempt with a different replay identity and cannot be replayed automatically`;
      await this.recordApplyPatchReplayFailure(runId, sequence, spec, inputHash, {
        message,
        startedAt: unsafePriorAttempt.startedAt,
      });
      throw new Error(message);
    }

    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (existingStep?.status === "completed" && existingStep.result?.structuredOutput != null) {
      const cached = normalizeWorkflowApplyPatchResult(existingStep.result.structuredOutput);
      await this.recordPatchTerminalEventIfMissing(runId, sequence, {
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        result: cached,
      });
      return cached;
    }

    options.leaseGuard.throwIfLost();
    await this.assertTaskBelongsToCompletedWorkflowStep(runId, spec.sourceTaskId);
    const startedAt = existingStep?.startedAt ?? this.clock.nowIso();
    await this.recordStepStarted(runId, {
      stepId: spec.id,
      inputHash,
      taskId: spec.sourceTaskId,
      startedAt,
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: spec.id,
      sourceTaskId: spec.sourceTaskId,
      status: "started",
      details:
        spec.projectPath != null
          ? { target: spec.target, projectPath: spec.projectPath }
          : { target: spec.target },
    });

    try {
      if (this.taskAdapter.applyPatch == null) {
        throw new Error("Workflow task adapter does not support applyPatch");
      }
      const rawResult = await this.taskAdapter.applyPatch(spec, {
        abortSignal: options.abortSignal,
      });
      options.leaseGuard.throwIfLost();
      const result = normalizeWorkflowApplyPatchResult(rawResult);
      const reportMarkdown = formatWorkflowApplyPatchReport(result);
      await this.recordStepCompleted(runId, {
        stepId: spec.id,
        inputHash,
        taskId: spec.sourceTaskId,
        result: {
          reportMarkdown,
          structuredOutput: result,
        },
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "patch",
        at: this.clock.nowIso(),
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        status: result.status,
        details: result,
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      await this.recordStepFailed(runId, {
        stepId: spec.id,
        inputHash,
        taskId: spec.sourceTaskId,
        error: message,
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "patch",
        at: this.clock.nowIso(),
        stepId: spec.id,
        sourceTaskId: spec.sourceTaskId,
        status: "failed",
        details: { error: message },
      });
      throw error;
    }
  }

  private async runNestedWorkflowStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      abortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
      allowResumeFromInterrupted: boolean;
      allowRetryFromFailedCheckpoint: boolean;
    }
  ): Promise<WorkflowResult> {
    const spec = parseWorkflowNestedWorkflowSpec(rawSpec);
    assertWorkflowStepId(spec.id, "workflow");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();

    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (existingStep?.status === "completed" && existingStep.result != null) {
      const cached = getNestedWorkflowStepOutput(existingStep.result);
      if (cached != null) {
        await this.recordWorkflowEventIfMissing(runId, sequence, {
          stepId: spec.id,
          runId: cached.runId,
          name: cached.name,
          status: "completed",
          details: cached.result,
        });
        return cached.result;
      }
    }

    const nestedWorkflowAdapter = this.nestedWorkflowAdapter;
    assert(nestedWorkflowAdapter != null, "Nested workflows are not supported by this runner");
    const child = await nestedWorkflowAdapter.createRun({
      parentRunId: runId,
      stepId: spec.id,
      inputHash,
      spec,
    });
    const startedAt = existingStep?.startedAt ?? this.clock.nowIso();
    await this.recordStepStarted(runId, { stepId: spec.id, inputHash, startedAt });
    await this.recordWorkflowEventIfMissing(runId, sequence, {
      stepId: spec.id,
      runId: child.runId,
      name: child.name,
      status: "started",
      details: { scriptPath: spec.scriptPath },
    });

    try {
      const result = await nestedWorkflowAdapter.run(child.runId, {
        abortSignal: options.abortSignal,
        backgroundOnMessageQueued: false,
        allowResumeFromInterrupted: options.allowResumeFromInterrupted,
        allowRetryFromFailedCheckpoint: options.allowRetryFromFailedCheckpoint,
      });
      const stepResult = buildNestedWorkflowStepResult(child, result);
      await this.recordStepCompleted(runId, {
        stepId: spec.id,
        inputHash,
        result: stepResult,
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.recordWorkflowEventIfMissing(runId, sequence, {
        stepId: spec.id,
        runId: child.runId,
        name: child.name,
        status: "completed",
        details: getJsonWorkflowResult(result),
      });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      await this.recordStepFailed(runId, {
        stepId: spec.id,
        inputHash,
        error: message,
        startedAt,
        completedAt: this.clock.nowIso(),
      });
      await this.recordWorkflowEventIfMissing(runId, sequence, {
        stepId: spec.id,
        runId: child.runId,
        name: child.name,
        status: options.abortSignal?.aborted === true ? "interrupted" : "failed",
        details: { error: message },
      });
      throw error;
    }
  }

  private async resolveWorkflowApplyPatchSpec(
    runId: string,
    spec: ParsedWorkflowApplyPatchSpec
  ): Promise<WorkflowApplyPatchSpec> {
    if (spec.sourceTaskId != null) {
      return { ...spec, sourceTaskId: spec.sourceTaskId };
    }
    assert(
      spec.agentId != null && spec.agentId.length > 0,
      "applyPatch requires agentId or a source taskId"
    );
    const sourceTaskId = await this.getCompletedAgentTaskIdForPatch(runId, spec.agentId);
    return { ...spec, sourceTaskId };
  }

  private async getCompletedAgentTaskIdForPatch(runId: string, agentId: string): Promise<string> {
    const run = await this.runStore.getRun(runId);
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      if (step?.stepId !== agentId || step.status !== "completed") {
        continue;
      }
      const taskId = step.taskId ?? step.result?.taskId;
      if (taskId != null && taskId.length > 0 && step.result?.taskId === taskId) {
        return taskId;
      }
    }
    throw new Error(
      `applyPatch agentId ${agentId} was not produced by a completed workflow agent step`
    );
  }

  private async assertTaskBelongsToCompletedWorkflowStep(
    runId: string,
    taskId: string
  ): Promise<void> {
    const run = await this.runStore.getRun(runId);
    const owningStep = run.steps.find(
      (step) =>
        step.status === "completed" && step.taskId === taskId && step.result?.taskId === taskId
    );
    assert(
      owningStep != null,
      `applyPatch source taskId ${taskId} was not produced by a completed workflow agent step`
    );
  }
  private async findUnsafePriorApplyPatchAttempt(
    runId: string,
    stepId: string,
    currentInputHash: string
  ): Promise<WorkflowStepRecord | null> {
    const run = await this.runStore.getRun(runId);
    for (let index = run.steps.length - 1; index >= 0; index -= 1) {
      const step = run.steps[index];
      assert(step != null, "Workflow step index must resolve to a record");
      if (step.stepId !== stepId) {
        continue;
      }
      if (step.status === "completed" && step.inputHash === currentInputHash) {
        continue;
      }
      if (step.status === "started" || step.status === "failed" || step.status === "completed") {
        return step;
      }
    }
    return null;
  }

  private async recordApplyPatchReplayFailure(
    runId: string,
    sequence: WorkflowEventSequence,
    spec: WorkflowApplyPatchSpec,
    inputHash: string,
    failure: { message: string; startedAt: string }
  ): Promise<void> {
    await this.recordStepFailed(runId, {
      stepId: spec.id,
      inputHash,
      taskId: spec.sourceTaskId,
      error: failure.message,
      startedAt: failure.startedAt,
      completedAt: this.clock.nowIso(),
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: spec.id,
      sourceTaskId: spec.sourceTaskId,
      status: "failed",
      details: { error: failure.message, replayBlocked: true },
    });
  }

  private async startAgentStepWithoutWaiting(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      allowLegacyMissingOutputSchema: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
      startedAgentSteps: Map<string, StartedWorkflowAgentState>;
      createHandleId: (stepId: string) => string;
    }
  ): Promise<StartedWorkflowAgentHandle> {
    const spec = parseWorkflowAgentSpec(rawSpec, {
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
    });
    assertWorkflowStepId(spec.id, "agent");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();
    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    const handleId = options.createHandleId(spec.id);

    if (existingStep?.status === "completed" && existingStep.result != null) {
      if (existingStep.taskId != null) {
        options.leaseGuard.throwIfLost();
        await this.recordTaskCompletedEventIfMissing(runId, sequence, {
          stepId: spec.id,
          taskId: existingStep.taskId,
          title: spec.title,
        });
      }
      options.startedAgentSteps.set(handleId, {
        handleId,
        spec,
        resultSpec: spec,
        inputHash,
        startedAt: existingStep.startedAt,
        taskId: existingStep.taskId,
        terminalResult: existingStep.result,
      });
      return { handleId };
    }

    assert(
      this.taskAdapter.createAgentTasks != null && this.taskAdapter.waitForAgentTask != null,
      "pipeline requires workflow task adapter support for nonblocking agent starts"
    );
    const priorTaskId = existingStep?.status === "started" ? existingStep.taskId : undefined;
    if (priorTaskId != null) {
      assert(existingStep != null, "started pipeline step must have an existing step record");
      const resultSpec = options.allowLegacyMissingOutputSchema
        ? omitWorkflowAgentOutputSchema(spec)
        : spec;
      const attempt: OwnedWorkflowAgentAttempt = {
        stepId: spec.id,
        inputHash,
        taskId: priorTaskId,
        title: spec.title,
        resultSpec,
        startedAt: existingStep.startedAt,
      };
      const plan = await this.classifyPriorAttempt(runId, sequence, attempt, {
        leaseGuard: options.leaseGuard,
        runAbortSignal: options.waitOptions?.abortSignal,
      });
      if (plan.kind !== "replace") {
        await this.recordTaskStartedEventIfMissing(runId, sequence, {
          stepId: spec.id,
          taskId: priorTaskId,
          title: spec.title,
        });
        const state: StartedWorkflowAgentState = {
          handleId,
          spec,
          resultSpec,
          inputHash,
          startedAt: existingStep.startedAt,
          taskId: priorTaskId,
        };
        if (plan.kind === "adopt") {
          // Persisted before the interruption: record it now under the current lease so the
          // handle resolves without waiting on a child that already reported.
          state.terminalResult = await this.recordAgentResult(runId, sequence, {
            spec: resultSpec,
            inputHash,
            startedAt: existingStep.startedAt,
            taskId: priorTaskId,
            leaseGuard: options.leaseGuard,
            rawResult: plan.report,
          });
        }
        options.startedAgentSteps.set(handleId, state);
        return { handleId };
      }
    }

    const resultSpec = normalizeWorkflowAgentSpecForExecution(spec, {
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
    });
    const startedAt =
      priorTaskId == null && existingStep != null ? existingStep.startedAt : this.clock.nowIso();
    const [taskId] = await this.reserveAgentTasks(runId, sequence, {
      steps: [{ spec: resultSpec, inputHash, startedAt, title: spec.title }],
      abortSignal: options.waitOptions?.abortSignal,
      runAbortSignal: options.waitOptions?.abortSignal,
      leaseGuard: options.leaseGuard,
    });
    assert(taskId != null, "pipeline agent start must return a task");
    options.startedAgentSteps.set(handleId, {
      handleId,
      spec,
      resultSpec,
      inputHash,
      startedAt,
      taskId,
    });
    return { handleId };
  }

  private async waitForAnyStartedAgentStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawHandles: unknown,
    options: {
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
      startedAgentSteps: Map<string, StartedWorkflowAgentState>;
    }
  ): Promise<StartedWorkflowAgentCompletion> {
    assert(Array.isArray(rawHandles), "pipeline wait requires an array of started agent handles");
    assert(rawHandles.length > 0, "pipeline wait requires at least one started agent handle");
    const states = rawHandles.map((rawHandle) => {
      const handleId = parseStartedWorkflowAgentHandle(rawHandle).handleId;
      const state = options.startedAgentSteps.get(handleId);
      assert(state != null, `pipeline wait received unknown agent handle ${handleId}`);
      return state;
    });

    const alreadyCompleted = states.find((state) => state.terminalResult != null);
    if (alreadyCompleted?.terminalResult != null) {
      return { handleId: alreadyCompleted.handleId, result: alreadyCompleted.terminalResult };
    }

    assert(
      this.taskAdapter.waitForAgentTask != null,
      "pipeline requires workflow task adapter support for waiting on started agents"
    );
    for (const state of states) {
      if (state.rawResultPromise != null) {
        continue;
      }
      assert(state.taskId != null, `pipeline agent ${state.spec.id} has no taskId to wait for`);
      const taskId = state.taskId;
      state.rawResultPromise =
        state.spec.timeout == null
          ? this.taskAdapter.waitForAgentTask(taskId, state.resultSpec, options.waitOptions)
          : this.waitForAgentTaskWithGracefulTimeout(runId, sequence, {
              spec: state.spec,
              inputHash: state.inputHash,
              startedAt: state.startedAt,
              taskId,
              resultSpec: state.resultSpec,
              waitOptions: options.waitOptions,
              leaseGuard: options.leaseGuard,
            });
    }

    let interruptPromise: Promise<void> | undefined;
    const interruptRemainingTasks = async (): Promise<void> => {
      interruptPromise ??= this.taskAdapter.interruptRun?.() ?? Promise.resolve();
      try {
        await interruptPromise;
      } catch {
        // Preserve the original child failure; workflow failure handling will surface that cause.
      }
    };

    const toAttempt = (state: StartedWorkflowAgentState): OwnedWorkflowAgentAttempt => {
      assert(state.taskId != null, `pipeline agent ${state.spec.id} has no started taskId`);
      return {
        stepId: state.spec.id,
        inputHash: state.inputHash,
        taskId: state.taskId,
        title: state.spec.title,
        resultSpec: state.resultSpec,
        startedAt: state.startedAt,
      };
    };
    // Fail-fast stopped the siblings through interruptRun; each still gets its report-first
    // disposition (bounded settlement wait) so a report that landed before the stop is kept.
    const disposeSiblings = async (failed: StartedWorkflowAgentState): Promise<void> => {
      for (const state of states) {
        if (state === failed || state.terminalResult != null) {
          continue;
        }
        try {
          await this.disposeStartedAttempt(runId, sequence, toAttempt(state), {
            leaseGuard: options.leaseGuard,
            ...(options.waitOptions?.abortSignal != null
              ? { abortSignal: options.waitOptions.abortSignal }
              : {}),
            wait: "pending-or-live",
          });
        } catch (error) {
          log.warn(`[workflow-runner] Draining pipeline sibling ${state.spec.id} failed`, {
            runId,
            error: getErrorMessage(error),
          });
        }
      }
    };

    let settled = await Promise.race(
      states.map(async (state) => {
        assert(state.rawResultPromise != null, `pipeline agent ${state.spec.id} is not waiting`);
        try {
          return { state, rawResult: await state.rawResultPromise };
        } catch (error) {
          return { state, error };
        }
      })
    );

    if ("error" in settled) {
      if (isForegroundWaitBackgroundedError(settled.error)) {
        throw settled.error;
      }
      const plan = await this.handleAgentWaitFailure(
        runId,
        sequence,
        toAttempt(settled.state),
        settled.error,
        {
          leaseGuard: options.leaseGuard,
          waitOptions: options.waitOptions,
          runAbortSignal: options.waitOptions?.abortSignal,
          allowReplacement: false,
        }
      );
      if (plan.kind !== "adopt") {
        // A pipeline can have several active child waits; stop siblings when fail-fast throws.
        await interruptRemainingTasks();
        await disposeSiblings(settled.state);
        throw settled.error;
      }
      // The wait failed but the child's report was already persisted: consume it normally.
      settled = { state: settled.state, rawResult: plan.report };
    }

    let result: StructuredTaskOutput;
    try {
      assert(settled.state.taskId != null, "pipeline agent result requires a started taskId");
      result = await this.recordAgentResult(runId, sequence, {
        spec: settled.state.resultSpec,
        inputHash: settled.state.inputHash,
        startedAt: settled.state.startedAt,
        taskId: settled.state.taskId,
        leaseGuard: options.leaseGuard,
        rawResult: settled.rawResult,
      });
    } catch (error) {
      // Validation can fail after one child completes while sibling waits are still active.
      await interruptRemainingTasks();
      await disposeSiblings(settled.state);
      throw error;
    }
    settled.state.terminalResult = result;
    return { handleId: settled.state.handleId, result };
  }

  private async runAgentStep(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpec: unknown,
    options: {
      allowLegacyMissingOutputSchema: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    const spec = parseWorkflowAgentSpec(rawSpec, {
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
    });
    assertWorkflowStepId(spec.id, "agent");
    const inputHash = hashWorkflowStepInput(spec.id, spec);
    options.leaseGuard.throwIfLost();
    const existingStep = await this.runStore.getStep(runId, spec.id, inputHash);
    if (existingStep?.status === "completed" && existingStep.result != null) {
      if (existingStep.taskId != null) {
        options.leaseGuard.throwIfLost();
        await this.recordTaskCompletedEventIfMissing(runId, sequence, {
          stepId: spec.id,
          taskId: existingStep.taskId,
          title: spec.title,
        });
      }
      return existingStep.result;
    }

    options.leaseGuard.throwIfLost();
    return await this.runAndRecordAgentStepWithRetries(runId, sequence, {
      spec,
      inputHash,
      startedAt: existingStep?.startedAt ?? this.clock.nowIso(),
      // Classified by its authoritative outcome in runOrResumeAgentStep, never discarded blindly.
      taskId: existingStep?.status === "started" ? existingStep.taskId : undefined,
      allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
      leaseGuard: options.leaseGuard,
      waitOptions: options.waitOptions,
    });
  }

  private async runAgentStepsInParallel(
    runId: string,
    sequence: WorkflowEventSequence,
    rawSpecs: unknown,
    options: {
      allowLegacyMissingOutputSchema: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
      rawOptions?: unknown;
    }
  ): Promise<StructuredTaskOutput[]> {
    assert(Array.isArray(rawSpecs), "parallel requires an array of agent specs");
    assert(rawSpecs.length > 0, "parallel requires at least one agent spec");
    const { maxParallel } = parseParallelAgentsOptions(options.rawOptions);

    const results = new Array<StructuredTaskOutput>(rawSpecs.length);
    const parsedSteps = rawSpecs.map((rawSpec) => {
      const spec = parseWorkflowAgentSpec(rawSpec, {
        allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
      });
      assertWorkflowStepId(spec.id, "parallel");
      return { spec, inputHash: hashWorkflowStepInput(spec.id, spec) };
    });
    options.leaseGuard.throwIfLost();
    const existingSteps = await this.runStore.getSteps(
      runId,
      parsedSteps.map((step) => ({ stepId: step.spec.id, inputHash: step.inputHash }))
    );
    let pending: Array<{
      index: number;
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      reservedInThisRun?: boolean;
      attempt: number;
      retryMessage?: string;
      allowMissingOutputSchema: boolean;
    }> = [];
    for (const [index, step] of parsedSteps.entries()) {
      const existingStep = existingSteps[index];
      if (existingStep?.status === "completed" && existingStep.result != null) {
        if (existingStep.taskId != null) {
          options.leaseGuard.throwIfLost();
          await this.recordTaskCompletedEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: existingStep.taskId,
            title: step.spec.title,
          });
        }
        results[index] = existingStep.result;
        continue;
      }
      pending.push({
        index,
        spec: step.spec,
        inputHash: step.inputHash,
        startedAt: existingStep?.startedAt ?? this.clock.nowIso(),
        // A started checkpoint is classified by its authoritative outcome when the step runs,
        // for explicit resumes as much as for crash replay; it is never discarded blindly.
        taskId: existingStep?.status === "started" ? existingStep.taskId : undefined,
        allowMissingOutputSchema: options.allowLegacyMissingOutputSchema,
        attempt: 1,
      });
    }

    while (pending.length > 0) {
      const queued = pending;
      pending = [];
      const batchAbortController = new AbortController();
      const upstreamAbortSignal = options.waitOptions?.abortSignal;
      const abortBatch = () => batchAbortController.abort();
      if (upstreamAbortSignal?.aborted) {
        abortBatch();
      } else {
        upstreamAbortSignal?.addEventListener("abort", abortBatch, { once: true });
      }
      let foregroundBackgrounded = false;
      let batchFailed = false;
      // The first failure is the root cause the batch surfaces; sibling aborts and draining
      // failures that follow it are consequences and never replace it.
      let firstBatchError: unknown;
      let interruptPromise: Promise<void> | undefined;
      const interruptRemainingTasks = async (): Promise<void> => {
        interruptPromise ??= this.taskAdapter.interruptRun?.() ?? Promise.resolve();
        try {
          await interruptPromise;
        } catch {
          // Preserve the original child failure; workflow failure handling will surface that cause.
        }
      };
      // A child-task failure aborts the batch the same way regardless of which
      // launch path raised it: a foreground-backgrounded wait flips the batch to
      // backgrounded and aborts it (so the abort guards drain queued work),
      // while any other failure aborts the batch (unblocking siblings still stuck
      // in a cancellable reservation stage) and then interrupts the still-running
      // siblings unless the batch was already backgrounded. Shared by the per-run
      // and bulk-create catch blocks so the two stay in lockstep.
      const applyChildFailureToBatch = async (error: unknown): Promise<void> => {
        firstBatchError ??= error;
        batchFailed = true;
        if (isForegroundWaitBackgroundedError(error)) {
          foregroundBackgrounded = true;
          abortBatch();
        } else if (!foregroundBackgrounded) {
          abortBatch();
          await interruptRemainingTasks();
        }
      };
      // Every sibling that settled while the batch was failing still gets its disposition: a
      // fulfilled wait is recorded (validated) so its report is reused on replay, and a rejected
      // one already ran its own disposition. Draining failures are logged, never surfaced.
      const drainSettledSiblings = async (): Promise<void> => {
        const settledSiblings = await Promise.allSettled(unsettledRuns.values());
        for (const sibling of settledSiblings) {
          if (sibling.status !== "fulfilled" || !("runResult" in sibling.value)) {
            continue;
          }
          const { step, runResult } = sibling.value;
          try {
            options.leaseGuard.throwIfLost();
            results[step.index] = await this.recordAgentResult(runId, sequence, {
              spec: runResult.resultSpec,
              inputHash: step.inputHash,
              startedAt: step.startedAt,
              taskId: runResult.taskId,
              leaseGuard: options.leaseGuard,
              rawResult: runResult.rawResult,
            });
          } catch (error) {
            log.warn(`[workflow-runner] Draining sibling ${step.spec.id} did not record`, {
              runId,
              error: getErrorMessage(error),
            });
          }
        }
      };
      const batchWaitOptions: WorkflowAgentWaitOptions = {
        ...options.waitOptions,
        abortSignal: batchAbortController.signal,
      };
      // maxParallel caps live child tasks with a sliding window: the next spec
      // starts as soon as any running one finishes. Validation retries are
      // requeued at the front so a schema-only failure immediately uses the
      // freed slot instead of waiting for unrelated slow siblings to drain.
      const maxActive = maxParallel ?? queued.length;
      assert(maxActive > 0, "WorkflowRunner.parallel maxActive must be positive");
      const usesWindow = maxParallel != null && maxParallel < queued.length;

      const throwIfAbortPreventsQueuedWork = async (): Promise<void> => {
        if (queued.length === 0 || !batchAbortController.signal.aborted) {
          return;
        }
        if (foregroundBackgrounded) {
          throw createForegroundWaitBackgroundedError();
        }
        await interruptRemainingTasks();
        throw new Error(`parallel aborted before launching ${queued.length} queued step(s)`);
      };

      // Under a window, tasks must be created lazily when a slot frees;
      // bulk-creating the whole wave up front would start every child at once.
      const createAgentTasks =
        !usesWindow &&
        this.taskAdapter.createAgentTasks != null &&
        this.taskAdapter.waitForAgentTask != null
          ? this.taskAdapter.createAgentTasks.bind(this.taskAdapter)
          : undefined;
      const bulkCreatableSteps =
        createAgentTasks != null ? queued.filter((step) => step.taskId == null) : [];
      let nextRunIndex = 0;
      const unsettledRuns = new Map<
        number,
        Promise<
          | {
              runIndex: number;
              step: (typeof queued)[number];
              runResult: WorkflowAgentRunResult;
            }
          | { runIndex: number; step: (typeof queued)[number]; error: unknown }
        >
      >();

      const startRun = (step: (typeof queued)[number]): void => {
        const runIndex = nextRunIndex;
        nextRunIndex += 1;
        const runSpec =
          step.attempt === 1
            ? step.spec
            : buildRetryAgentSpec(
                step.spec,
                step.attempt - 1,
                step.retryMessage ?? "previous attempt failed"
              );
        const run = (async () => {
          try {
            if (batchFailed || batchAbortController.signal.aborted) {
              throw new Error(
                `parallel step ${step.spec.id} canceled before it started: a sibling task failed or the batch was aborted`
              );
            }
            const runResult = await this.runOrResumeAgentStep(runId, sequence, {
              spec: runSpec,
              inputHash: step.inputHash,
              startedAt: step.startedAt,
              taskId: step.taskId,
              reservedInThisRun: step.reservedInThisRun,
              allowMissingOutputSchema: step.allowMissingOutputSchema,
              leaseGuard: options.leaseGuard,
              waitOptions: batchWaitOptions,
              runAbortSignal: upstreamAbortSignal,
            });
            return { runIndex, step, runResult };
          } catch (error) {
            await applyChildFailureToBatch(error);
            return { runIndex, step, error };
          }
        })();
        unsettledRuns.set(runIndex, run);
      };

      const launchAvailable = (): void => {
        while (
          !batchFailed &&
          !batchAbortController.signal.aborted &&
          unsettledRuns.size < maxActive &&
          queued.length > 0
        ) {
          const step = queued.shift();
          assert(step != null, "WorkflowRunner.parallel queued step is required");
          startRun(step);
        }
      };

      try {
        await throwIfAbortPreventsQueuedWork();
        if (createAgentTasks != null && bulkCreatableSteps.length > 0) {
          try {
            const taskIds = await this.reserveAgentTasks(runId, sequence, {
              steps: bulkCreatableSteps.map((step) => ({
                spec: step.spec,
                inputHash: step.inputHash,
                startedAt: step.startedAt,
                title: step.spec.title,
              })),
              abortSignal: batchAbortController.signal,
              runAbortSignal: upstreamAbortSignal,
              leaseGuard: options.leaseGuard,
            });
            for (const [index, taskId] of taskIds.entries()) {
              bulkCreatableSteps[index].taskId = taskId;
              bulkCreatableSteps[index].reservedInThisRun = true;
            }
          } catch (error) {
            await applyChildFailureToBatch(error);
            throw error;
          }
        }

        await throwIfAbortPreventsQueuedWork();
        launchAvailable();
        await throwIfAbortPreventsQueuedWork();
        while (unsettledRuns.size > 0) {
          const settled = await Promise.race(unsettledRuns.values());
          unsettledRuns.delete(settled.runIndex);
          if ("error" in settled) {
            await drainSettledSiblings();
            if (foregroundBackgrounded) {
              throw createForegroundWaitBackgroundedError();
            }
            throw firstBatchError ?? settled.error;
          }
          try {
            results[settled.step.index] = await this.recordAgentResult(runId, sequence, {
              spec: settled.runResult.resultSpec,
              inputHash: settled.step.inputHash,
              startedAt: settled.step.startedAt,
              taskId: settled.runResult.taskId,
              leaseGuard: options.leaseGuard,
              rawResult: settled.runResult.rawResult,
            });
          } catch (error) {
            if (
              !isRetryableAgentOutputError(error) ||
              settled.step.attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS
            ) {
              await applyChildFailureToBatch(error);
              await drainSettledSiblings();
              throw firstBatchError ?? error;
            }
            options.leaseGuard.throwIfLost();
            await this.recordAgentRetry(
              runId,
              sequence,
              settled.step.spec.id,
              settled.step.attempt,
              error
            );
            queued.unshift({
              ...settled.step,
              startedAt: this.clock.nowIso(),
              taskId: undefined,
              attempt: settled.step.attempt + 1,
              retryMessage: getErrorMessage(error),
            });
          }
          launchAvailable();
          await throwIfAbortPreventsQueuedWork();
        }
      } finally {
        upstreamAbortSignal?.removeEventListener("abort", abortBatch);
      }
    }
    return results;
  }

  private async runAndRecordAgentStepWithRetries(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      waitOptions?: WorkflowAgentWaitOptions;
      allowMissingOutputSchema: boolean;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<StructuredTaskOutput> {
    let attempt = 1;
    let startedAt = step.startedAt;
    let taskId = step.taskId;
    let spec = step.spec;
    while (attempt <= WORKFLOW_AGENT_MAX_ATTEMPTS) {
      const runResult = await this.runOrResumeAgentStep(runId, sequence, {
        spec,
        inputHash: step.inputHash,
        startedAt,
        taskId,
        allowMissingOutputSchema: step.allowMissingOutputSchema,
        leaseGuard: step.leaseGuard,
        waitOptions: step.waitOptions,
        // Single steps have no batch signal: the run signal is the wait signal.
        runAbortSignal: step.waitOptions?.abortSignal,
      });
      try {
        return await this.recordAgentResult(runId, sequence, {
          spec: runResult.resultSpec,
          inputHash: step.inputHash,
          startedAt,
          taskId: runResult.taskId,
          leaseGuard: step.leaseGuard,
          rawResult: runResult.rawResult,
        });
      } catch (error) {
        if (!isRetryableAgentOutputError(error) || attempt >= WORKFLOW_AGENT_MAX_ATTEMPTS) {
          throw error;
        }
        step.leaseGuard.throwIfLost();
        await this.recordAgentRetry(runId, sequence, step.spec.id, attempt, error);
        spec = buildRetryAgentSpec(step.spec, attempt, getErrorMessage(error));
        startedAt = this.clock.nowIso();
        taskId = undefined;
        attempt += 1;
      }
    }
    throw new Error(`agent ${step.spec.id} exhausted validation retries`);
  }

  private async recordAgentRetry(
    runId: string,
    sequence: WorkflowEventSequence,
    stepId: string,
    attempt: number,
    error: unknown
  ): Promise<void> {
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "log",
      at: this.clock.nowIso(),
      message: `Retrying ${stepId} after validation failure`,
      data: {
        attempt,
        maxAttempts: WORKFLOW_AGENT_MAX_ATTEMPTS,
        error: getErrorMessage(error),
      },
    });
  }

  private async waitForAgentTaskWithGracefulTimeout(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId: string;
      resultSpec: WorkflowAgentSpec;
      waitOptions?: WorkflowAgentWaitOptions;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowAgentResult> {
    const timeout = step.spec.timeout;
    assert(timeout != null, "WorkflowRunner timeout wait requires timeout spec");
    assert(
      this.taskAdapter.waitForAgentTask != null,
      "WorkflowRunner timeout wait requires waitForAgentTask"
    );
    const waitForAgentTask = this.taskAdapter.waitForAgentTask.bind(this.taskAdapter);
    const existingStep = await this.runStore.getStep(runId, step.spec.id, step.inputHash);
    let existingTimeout = existingStep?.timeout;
    let executionStartedRecord: Promise<void> | undefined;
    const recordExecutionStarted = (): void => {
      if (existingTimeout?.executionStartedAt != null && existingTimeout.softDeadlineAt != null) {
        return;
      }
      if (executionStartedRecord != null) {
        return;
      }
      const executionStartedAt = this.clock.nowIso();
      const softDeadlineAt = new Date(this.clock.nowMs() + timeout.softMs).toISOString();
      existingTimeout = { ...existingTimeout, executionStartedAt, softDeadlineAt };
      executionStartedRecord = this.recordStepTimeoutMetadata(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        startedAt: step.startedAt,
        timeout: { executionStartedAt, softDeadlineAt },
      });
    };
    const waitForExecutionStartRecord = async (): Promise<void> => {
      if (executionStartedRecord != null) {
        await executionStartedRecord;
      }
    };
    const waitForReport = async (timeoutMs: number): Promise<WorkflowAgentResult> => {
      assert(timeoutMs > 0, "WorkflowRunner timeout wait requires positive timeoutMs");
      try {
        const result = await waitForAgentTask(step.taskId, step.resultSpec, {
          ...step.waitOptions,
          timeoutMs,
          onExecutionStarted: () => {
            recordExecutionStarted();
            return step.waitOptions?.onExecutionStarted?.();
          },
        });
        await waitForExecutionStartRecord();
        return result;
      } catch (error) {
        await waitForExecutionStartRecord();
        throw error;
      }
    };
    const remainingMsUntil = (deadlineIso: string | undefined, fallbackMs: number): number => {
      if (deadlineIso == null) {
        return fallbackMs;
      }
      const parsedDeadlineMs = Date.parse(deadlineIso);
      if (!Number.isFinite(parsedDeadlineMs)) {
        return fallbackMs;
      }
      return Math.max(1, parsedDeadlineMs - this.clock.nowMs());
    };
    const tryReadAcceptedReport = async (): Promise<WorkflowAgentResult | null> => {
      const completedStep = await this.runStore.getCompletedStep(
        runId,
        step.spec.id,
        step.inputHash
      );
      if (completedStep?.result != null) {
        return { ...completedStep.result, taskId: step.taskId };
      }
      try {
        return await waitForReport(1);
      } catch {
        return null;
      }
    };
    const hardTimeout = async (): Promise<WorkflowAgentResult> => {
      const acceptedReportBeforeHardTimeout = await tryReadAcceptedReport();
      if (acceptedReportBeforeHardTimeout != null) {
        return acceptedReportBeforeHardTimeout;
      }

      const errorMessage = `Workflow agent step ${step.spec.id} exceeded its soft timeout (${timeout.softMs}ms) and did not produce a valid final response within the grace period (${timeout.graceMs}ms).`;
      const hardTimedOutAt = this.clock.nowIso();
      await this.recordStepTimeoutMetadata(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        startedAt: step.startedAt,
        timeout: { hardTimedOutAt },
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "timeout",
        at: hardTimedOutAt,
        stepId: step.spec.id,
        taskId: step.taskId,
        phase: "hard",
        details: { error: errorMessage },
      });
      await this.recordTaskEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId: step.taskId,
        title: step.spec.title,
        status: "timed_out",
      });
      await this.taskAdapter.failAgentTaskForHardTimeout?.(step.taskId, {
        workflowRunId: runId,
        stepId: step.spec.id,
        inputHash: step.inputHash,
        reason: errorMessage,
      });
      const acceptedReportAfterHardTimeout = await tryReadAcceptedReport();
      if (acceptedReportAfterHardTimeout != null) {
        return acceptedReportAfterHardTimeout;
      }
      await this.recordStepFailed(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        error: errorMessage,
        startedAt: step.startedAt,
        completedAt: hardTimedOutAt,
      });
      throw createWorkflowAgentHardTimeoutError(errorMessage);
    };
    const buildHardDeadlineFromNow = (): string =>
      new Date(this.clock.nowMs() + timeout.graceMs).toISOString();
    const recordFinalizationPromptAccepted = async (
      finalizationToken: string | undefined,
      finalizationResult: "prompted" | "queued" | "already_reported" | "not_active"
    ): Promise<string> => {
      const finalizationPromptSentAt = this.clock.nowIso();
      const hardDeadlineAt = buildHardDeadlineFromNow();
      step.leaseGuard.throwIfLost();
      await this.recordStepTimeoutMetadata(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        startedAt: step.startedAt,
        timeout: {
          ...(finalizationToken != null ? { finalizationToken } : {}),
          finalizationPromptSentAt,
          hardDeadlineAt,
        },
      });
      await this.appendEvent(runId, {
        sequence: sequence.next(),
        type: "timeout",
        at: finalizationPromptSentAt,
        stepId: step.spec.id,
        taskId: step.taskId,
        phase: "finalization_prompt_sent",
        details: { result: finalizationResult },
      });
      return hardDeadlineAt;
    };
    const waitDuringGrace = async (graceTimeoutMs: number): Promise<WorkflowAgentResult> => {
      try {
        const result = await waitForReport(graceTimeoutMs);
        await this.appendEvent(runId, {
          sequence: sequence.next(),
          type: "timeout",
          at: this.clock.nowIso(),
          stepId: step.spec.id,
          taskId: step.taskId,
          phase: "recovered",
          details: { graceMs: timeout.graceMs },
        });
        return result;
      } catch (error) {
        if (!isAgentReportWaitTimeoutError(error)) {
          throw error;
        }
      }
      return await hardTimeout();
    };

    if (existingTimeout?.softTimedOutAt != null) {
      assert(
        this.taskAdapter.requestAgentFinalReportForTimeout != null,
        "WorkflowRunner timeout wait requires requestAgentFinalReportForTimeout"
      );
      const finalizationToken =
        existingTimeout.finalizationToken ??
        buildWorkflowAgentTimeoutFinalizationToken(runId, step, existingTimeout.softTimedOutAt);
      if (existingTimeout.finalizationPromptSentAt == null) {
        const finalizationResult = await this.taskAdapter.requestAgentFinalReportForTimeout(
          step.taskId,
          {
            workflowRunId: runId,
            stepId: step.spec.id,
            inputHash: step.inputHash,
            finalizationToken,
            finalInstructions: timeout.finalInstructions,
          }
        );
        if (finalizationResult === "already_reported") {
          return await waitForReport(
            remainingMsUntil(existingTimeout.hardDeadlineAt, timeout.graceMs)
          );
        }
        if (finalizationResult === "prompted") {
          const hardDeadlineAt = await recordFinalizationPromptAccepted(
            finalizationToken,
            finalizationResult
          );
          existingTimeout = { ...existingTimeout, hardDeadlineAt };
        }
      }
      return await waitDuringGrace(
        remainingMsUntil(existingTimeout.hardDeadlineAt, timeout.graceMs)
      );
    }

    try {
      return await waitForReport(remainingMsUntil(existingTimeout?.softDeadlineAt, timeout.softMs));
    } catch (error) {
      if (!isAgentReportWaitTimeoutError(error)) {
        throw error;
      }
    }

    const completedAfterSoftTimeout = await this.runStore.getCompletedStep(
      runId,
      step.spec.id,
      step.inputHash
    );
    if (completedAfterSoftTimeout?.result != null) {
      return { ...completedAfterSoftTimeout.result, taskId: step.taskId };
    }

    assert(
      this.taskAdapter.requestAgentFinalReportForTimeout != null,
      "WorkflowRunner timeout wait requires requestAgentFinalReportForTimeout"
    );
    const softTimedOutAt = this.clock.nowIso();
    const finalizationToken = buildWorkflowAgentTimeoutFinalizationToken(
      runId,
      step,
      softTimedOutAt
    );
    const hardDeadlineAt = buildHardDeadlineFromNow();
    await this.recordStepTimeoutMetadata(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      taskId: step.taskId,
      startedAt: step.startedAt,
      timeout: {
        softTimedOutAt,
        hardDeadlineAt,
        finalizationToken,
      },
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "timeout",
      at: softTimedOutAt,
      stepId: step.spec.id,
      taskId: step.taskId,
      phase: "soft",
      details: { softMs: timeout.softMs, graceMs: timeout.graceMs },
    });
    await this.recordTaskEventIfMissing(runId, sequence, {
      stepId: step.spec.id,
      taskId: step.taskId,
      title: step.spec.title,
      status: "finalizing",
    });

    const finalizationResult = await this.taskAdapter.requestAgentFinalReportForTimeout(
      step.taskId,
      {
        workflowRunId: runId,
        stepId: step.spec.id,
        inputHash: step.inputHash,
        finalizationToken,
        finalInstructions: timeout.finalInstructions,
      }
    );
    if (finalizationResult === "already_reported") {
      return await waitForReport(timeout.graceMs);
    }
    const acceptedHardDeadlineAt =
      finalizationResult === "prompted"
        ? await recordFinalizationPromptAccepted(finalizationToken, finalizationResult)
        : hardDeadlineAt;

    return await waitDuringGrace(remainingMsUntil(acceptedHardDeadlineAt, timeout.graceMs));
  }

  private async runOrResumeAgentStep(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId?: string;
      /**
       * True when `taskId` was reserved by this run (bulk parallel reservation) rather than read
       * from a prior checkpoint: it is awaited directly instead of classified as a prior attempt.
       */
      reservedInThisRun?: boolean;
      waitOptions?: WorkflowAgentWaitOptions;
      /** Run-level signal (distinct from a batch signal) that bounds settlement waits. */
      runAbortSignal?: AbortSignal;
      allowMissingOutputSchema: boolean;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<WorkflowAgentRunResult> {
    step.leaseGuard.throwIfLost();
    const restart = async (): Promise<WorkflowAgentRunResult> =>
      await this.runOrResumeAgentStep(runId, sequence, {
        ...step,
        startedAt: this.clock.nowIso(),
        taskId: undefined,
        reservedInThisRun: false,
      });
    const settleWaitFailure = async (
      attempt: OwnedWorkflowAgentAttempt,
      error: unknown,
      allowReplacement: boolean
    ): Promise<WorkflowAgentRunResult> => {
      const plan = await this.handleAgentWaitFailure(runId, sequence, attempt, error, {
        leaseGuard: step.leaseGuard,
        waitOptions: step.waitOptions,
        runAbortSignal: step.runAbortSignal,
        allowReplacement,
      });
      switch (plan.kind) {
        case "adopt":
          return { rawResult: plan.report, resultSpec: attempt.resultSpec, taskId: attempt.taskId };
        case "replace":
          return await restart();
        case "reattach":
        case "rethrow":
          throw error;
      }
    };
    const usesTimeoutWait = step.spec.timeout != null && this.taskAdapter.waitForAgentTask != null;

    if (step.taskId != null && this.taskAdapter.waitForAgentTask != null) {
      // A checkpointed prior attempt (crash replay or explicit resume) is classified before it
      // is reattached or discarded: a persisted report wins, a live child is awaited, and only
      // a positively absent report after settlement allows exactly one replacement.
      const resultSpec = usesTimeoutWait
        ? normalizeWorkflowAgentSpecForExecution(step.spec, {
            allowMissingOutputSchema: step.allowMissingOutputSchema,
          })
        : step.allowMissingOutputSchema
          ? omitWorkflowAgentOutputSchema(step.spec)
          : step.spec;
      const attempt: OwnedWorkflowAgentAttempt = {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        title: step.spec.title,
        resultSpec,
        startedAt: step.startedAt,
      };
      const isPriorAttempt = step.reservedInThisRun !== true;
      if (isPriorAttempt) {
        const plan = await this.classifyPriorAttempt(runId, sequence, attempt, {
          leaseGuard: step.leaseGuard,
          runAbortSignal: step.runAbortSignal,
        });
        if (plan.kind === "adopt") {
          await this.recordTaskStartedEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            taskId: attempt.taskId,
            title: step.spec.title,
          });
          return { rawResult: plan.report, resultSpec, taskId: attempt.taskId };
        }
        if (plan.kind === "replace") {
          return await restart();
        }
        assert(
          plan.kind === "reattach",
          "classifyPriorAttempt returns adopt, replace, or reattach"
        );
        await this.recordTaskStartedEventIfMissing(runId, sequence, {
          stepId: step.spec.id,
          taskId: attempt.taskId,
          title: step.spec.title,
        });
      }
      try {
        const rawResult = usesTimeoutWait
          ? await this.waitForAgentTaskWithGracefulTimeout(runId, sequence, {
              spec: step.spec,
              inputHash: step.inputHash,
              startedAt: step.startedAt,
              taskId: attempt.taskId,
              resultSpec,
              waitOptions: step.waitOptions,
              leaseGuard: step.leaseGuard,
            })
          : await this.taskAdapter.waitForAgentTask(attempt.taskId, resultSpec, step.waitOptions);
        return { rawResult, resultSpec, taskId: attempt.taskId };
      } catch (error) {
        return await settleWaitFailure(attempt, error, isPriorAttempt);
      }
    }

    const resultSpec = normalizeWorkflowAgentSpecForExecution(step.spec, {
      allowMissingOutputSchema: step.allowMissingOutputSchema,
    });
    if (usesTimeoutWait || this.taskAdapter.createAgentTasks != null) {
      assert(
        this.taskAdapter.createAgentTasks != null && this.taskAdapter.waitForAgentTask != null,
        usesTimeoutWait
          ? "agent timeout requires workflow task adapter support for nonblocking agent starts"
          : "WorkflowRunner: createAgentTasks requires waitForAgentTask"
      );
      // Checkpoint the workflow step before reserving the child task. Reservation can
      // block on task-service gates, and replay needs a visible boundary instead of a
      // phase-only run if startup stalls before a taskId exists.
      const [taskId] = await this.reserveAgentTasks(runId, sequence, {
        steps: [
          {
            spec: resultSpec,
            inputHash: step.inputHash,
            startedAt: step.startedAt,
            title: step.spec.title,
          },
        ],
        abortSignal: step.waitOptions?.abortSignal,
        runAbortSignal: step.runAbortSignal,
        leaseGuard: step.leaseGuard,
      });
      assert(taskId != null, "agent start must return a task");
      const attempt: OwnedWorkflowAgentAttempt = {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId,
        title: step.spec.title,
        resultSpec,
        startedAt: step.startedAt,
      };
      try {
        const rawResult = usesTimeoutWait
          ? await this.waitForAgentTaskWithGracefulTimeout(runId, sequence, {
              spec: step.spec,
              inputHash: step.inputHash,
              startedAt: step.startedAt,
              taskId,
              resultSpec,
              waitOptions: step.waitOptions,
              leaseGuard: step.leaseGuard,
            })
          : await this.taskAdapter.waitForAgentTask(taskId, resultSpec, step.waitOptions);
        return { rawResult, resultSpec, taskId };
      } catch (error) {
        return await settleWaitFailure(attempt, error, false);
      }
    }

    step.leaseGuard.throwIfLost();
    let recordedTaskId: string | undefined;
    let rawResult: WorkflowAgentResult;
    try {
      rawResult = await this.taskAdapter.runAgent(
        resultSpec,
        {
          onTaskCreated: async (taskId) => {
            step.leaseGuard.throwIfLost();
            recordedTaskId = taskId;
            await this.recordStepStarted(runId, {
              stepId: step.spec.id,
              inputHash: step.inputHash,
              taskId,
              startedAt: step.startedAt,
            });
            this.trackAttempt(runId, {
              stepId: step.spec.id,
              inputHash: step.inputHash,
              taskId,
              title: step.spec.title,
              resultSpec,
              startedAt: step.startedAt,
            });
            await this.recordTaskStartedEventIfMissing(runId, sequence, {
              stepId: step.spec.id,
              taskId,
              title: step.spec.title,
            });
          },
        },
        step.waitOptions
      );
    } catch (error) {
      if (recordedTaskId == null) {
        throw error;
      }
      return await settleWaitFailure(
        {
          stepId: step.spec.id,
          inputHash: step.inputHash,
          taskId: recordedTaskId,
          title: step.spec.title,
          resultSpec,
          startedAt: step.startedAt,
        },
        error,
        false
      );
    }
    step.leaseGuard.throwIfLost();
    if (recordedTaskId == null) {
      recordedTaskId = rawResult.taskId;
      await this.recordStepStarted(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: recordedTaskId,
        startedAt: step.startedAt,
      });
      this.trackAttempt(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: recordedTaskId,
        title: step.spec.title,
        resultSpec,
        startedAt: step.startedAt,
      });
      await this.recordTaskStartedEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId: recordedTaskId,
        title: step.spec.title,
      });
    }
    return { rawResult, resultSpec, taskId: recordedTaskId };
  }

  private trackAttempt(runId: string, attempt: OwnedWorkflowAgentAttempt): void {
    assert(attempt.taskId.length > 0, "WorkflowRunner: owned attempt taskId is required");
    const owned = this.ownedAttemptsByRun.get(runId);
    if (owned == null) {
      attempt.releaseLaunchSignal?.();
      return;
    }
    const key = getOwnedAttemptKey(attempt);
    const superseded = owned.get(key);
    if (superseded != null && superseded.taskId !== attempt.taskId) {
      // A replacement attempt for the same step identity supersedes the obsolete one; the
      // store's attempt fence already rejects the old task id, so only the current one is worth
      // draining and only its launch can still be pending.
      superseded.releaseLaunchSignal?.();
    }
    owned.set(key, attempt);
  }

  private untrackAttempt(
    runId: string,
    attempt: { stepId: string; inputHash: string; taskId: string }
  ) {
    const owned = this.ownedAttemptsByRun.get(runId);
    const key = getOwnedAttemptKey(attempt);
    const current = owned?.get(key);
    if (owned != null && current?.taskId === attempt.taskId) {
      current.releaseLaunchSignal?.();
      owned.delete(key);
    }
  }

  private releaseOwnedAttempts(runId: string): void {
    const owned = this.ownedAttemptsByRun.get(runId);
    if (owned == null) {
      return;
    }
    for (const attempt of owned.values()) {
      attempt.releaseLaunchSignal?.();
    }
    this.ownedAttemptsByRun.delete(runId);
  }

  /**
   * Reads the authoritative attempt outcome and, when asked, waits within the teardown-scale
   * bound for a settlement the owner has promised: `pending` waits on `cleanup-pending`,
   * `pending-or-live` also on `live` (the caller already asked the child to stop), `never`
   * only reads (the Stop drain must not pin the lease). Missing capability is unavailable
   * authority: it reads as `indeterminate`, never as "no report". A wait cut short by
   * `abortSignal` keeps the pre-wait outcome so the caller retains the checkpoint.
   */
  private async resolveAttemptOutcome(
    taskId: string,
    options: { abortSignal?: AbortSignal; wait: "never" | "pending" | "pending-or-live" }
  ): Promise<TaskAttemptSettlement<WorkflowAgentResult>> {
    assert(taskId.length > 0, "WorkflowRunner.resolveAttemptOutcome: taskId is required");
    if (this.taskAdapter.readSettledAgentResult == null) {
      return {
        kind: "indeterminate",
        reason: "task adapter cannot read attempt outcomes",
      };
    }
    let outcome: TaskAttemptOutcome<WorkflowAgentResult>;
    try {
      outcome = await this.taskAdapter.readSettledAgentResult(taskId);
    } catch (error) {
      return {
        kind: "indeterminate",
        reason: `attempt outcome read failed: ${getErrorMessage(error)}`,
      };
    }
    const settlementPromised =
      options.wait !== "never" &&
      (outcome.kind === "cleanup-pending" ||
        (outcome.kind === "live" && options.wait === "pending-or-live"));
    if (
      !settlementPromised ||
      this.taskAdapter.waitForAttemptSettlement == null ||
      options.abortSignal?.aborted
    ) {
      return outcome;
    }
    try {
      return await this.taskAdapter.waitForAttemptSettlement(taskId, {
        ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
        timeoutMs: WORKFLOW_ATTEMPT_SETTLEMENT_TIMEOUT_MS,
      });
    } catch (error) {
      if (options.abortSignal?.aborted === true) {
        return outcome;
      }
      throw error;
    }
  }

  /**
   * Terminal disposition for a checkpointed attempt, report-first: a persisted report is adopted
   * (validated and recorded completed), a positively absent report after settlement is recorded
   * failed, and everything else keeps the `started` checkpoint (`indeterminate` also leaves a
   * diagnostic). Shared by fail-fast batch draining, pipeline sibling draining, reservation
   * cleanup after a checkpoint, late reservations after abort, and the cancellation drain.
   */
  private async disposeStartedAttempt(
    runId: string,
    sequence: WorkflowEventSequence,
    attempt: OwnedWorkflowAgentAttempt,
    options: {
      leaseGuard: WorkflowRunnerLeaseGuard;
      abortSignal?: AbortSignal;
      wait: "never" | "pending" | "pending-or-live";
      settlement?: WorkflowCancellationSettlement;
    }
  ): Promise<WorkflowAttemptDisposition> {
    options.leaseGuard.throwIfLost();
    const outcome = await this.resolveAttemptOutcome(attempt.taskId, {
      ...(options.abortSignal != null ? { abortSignal: options.abortSignal } : {}),
      wait: options.wait,
    });
    options.leaseGuard.throwIfLost();
    switch (outcome.kind) {
      case "reported": {
        try {
          const result = await this.recordAgentResult(
            runId,
            sequence,
            {
              spec: attempt.resultSpec,
              inputHash: attempt.inputHash,
              startedAt: attempt.startedAt,
              taskId: attempt.taskId,
              leaseGuard: options.leaseGuard,
              rawResult: outcome.report,
            },
            options.settlement
          );
          return { kind: "completed", result };
        } catch (error) {
          if (!isRetryableAgentOutputError(error)) {
            throw error;
          }
          // recordAgentResult already recorded the failed attempt; nothing consumes this result.
          return { kind: "failed" };
        }
      }
      case "terminal-no-report":
        await this.recordStartedAttemptFailed(
          runId,
          sequence,
          attempt,
          `agent ${attempt.stepId} task ${attempt.taskId} ended without a report`,
          options.settlement
        );
        return { kind: "failed" };
      case "indeterminate":
        await this.recordAgentAttemptIndeterminateEventIfMissing(runId, sequence, {
          stepId: attempt.stepId,
          inputHash: attempt.inputHash,
          taskId: attempt.taskId,
          title: attempt.title,
          reason: outcome.reason,
        });
        return { kind: "retained", outcome: outcome.kind };
      case "live":
      case "cleanup-pending":
      case "timeout":
        log.debug(
          `[workflow-runner] Retaining started checkpoint for ${attempt.stepId} (${attempt.taskId}): ${outcome.kind}`
        );
        return { kind: "retained", outcome: outcome.kind };
    }
  }

  private async recordStartedAttemptFailed(
    runId: string,
    sequence: WorkflowEventSequence,
    attempt: OwnedWorkflowAgentAttempt,
    error: string,
    settlement?: WorkflowCancellationSettlement
  ): Promise<void> {
    const failedAt = this.clock.nowIso();
    sequence.next();
    await this.runStore.recordStepFailedIfCurrent(
      runId,
      {
        stepId: attempt.stepId,
        inputHash: attempt.inputHash,
        taskId: attempt.taskId,
        title: attempt.title,
        error,
        startedAt: attempt.startedAt,
        completedAt: failedAt,
      },
      this.attemptWriteOptions(settlement)
    );
    this.untrackAttempt(runId, attempt);
  }

  private attemptWriteOptions(
    settlement?: WorkflowCancellationSettlement
  ): WorkflowAgentAttemptWriteOptions {
    return {
      expectedLeaseOwnerId: this.runnerId,
      ...(settlement != null ? { settlement } : {}),
    };
  }

  /**
   * Diagnostic for an attempt whose owner cannot be established. Recorded on the existing
   * `agent-step` event (status `reserved`) so no persisted schema changes; the `started`
   * checkpoint stays untouched because the outcome is unknown, not failed.
   */
  private async recordAgentAttemptIndeterminateEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    agent: { stepId: string; inputHash: string; taskId: string; title?: string; reason: string }
  ): Promise<void> {
    assert(agent.stepId.length > 0, "WorkflowRunner: indeterminate attempt stepId is required");
    assert(agent.taskId.length > 0, "WorkflowRunner: indeterminate attempt taskId is required");
    const details = { disposition: "indeterminate", taskId: agent.taskId, reason: agent.reason };
    log.warn(`[workflow-runner] Workflow agent attempt outcome is indeterminate`, {
      runId,
      stepId: agent.stepId,
      taskId: agent.taskId,
      reason: agent.reason,
    });
    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "agent-step" &&
        event.status === "reserved" &&
        event.stepId === agent.stepId &&
        event.inputHash === agent.inputHash &&
        typeof event.details === "object" &&
        event.details != null &&
        !Array.isArray(event.details) &&
        (event.details as Record<string, unknown>).disposition === details.disposition &&
        (event.details as Record<string, unknown>).taskId === agent.taskId
    );
    if (alreadyRecorded) {
      return;
    }
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "agent-step",
      at: this.clock.nowIso(),
      stepId: agent.stepId,
      inputHash: agent.inputHash,
      status: "reserved",
      title: agent.title,
      details,
    });
  }

  /**
   * Reserves child tasks with a linked cancellation: the caller's batch/run signal or the
   * reservation deadline aborts only the cancellable admission stages. `onTaskCreated` observes
   * the signal BEFORE entering recordStepStarted (the last cancellation point); once the
   * checkpoint write has entered the store lock it is owned to completion. Steps checkpointed by
   * a reservation that then fails or completes after an abort are disposed report-first.
   *
   * Lifetime: the deadline is cleared when the reservation call returns, but the upstream abort
   * link is NOT. createMany returns before the children launch (queued children may wait for
   * capacity) and the task service re-checks this signal at launch admission, so the link stays
   * connected until every attempt it reserved has settled, been superseded, or the run ends.
   */
  private async reserveAgentTasks(
    runId: string,
    sequence: WorkflowEventSequence,
    input: {
      steps: ReadonlyArray<{
        spec: WorkflowAgentSpec;
        inputHash: string;
        startedAt: string;
        title?: string;
      }>;
      abortSignal?: AbortSignal;
      runAbortSignal?: AbortSignal;
      leaseGuard: WorkflowRunnerLeaseGuard;
    }
  ): Promise<string[]> {
    assert(input.steps.length > 0, "WorkflowRunner.reserveAgentTasks: steps are required");
    assert(
      this.taskAdapter.createAgentTasks != null,
      "WorkflowRunner.reserveAgentTasks requires createAgentTasks"
    );
    const createAgentTasks = this.taskAdapter.createAgentTasks.bind(this.taskAdapter);
    const stepIds = input.steps.map((step) => step.spec.id);
    for (const step of input.steps) {
      await this.recordAgentReservationEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        title: step.title,
        spec: step.spec,
      });
    }

    const reservation = new AbortController();
    let deadlineFired = false;
    const abortReservation = () => reservation.abort();
    const upstream = input.abortSignal;
    // Link the batch signal AND the run signal: a batch controller is unlinked from the run
    // when its loop ends, but a child reserved by that batch may still be waiting to launch.
    const upstreamSignals = Array.from(
      new Set([input.abortSignal, input.runAbortSignal].filter((signal) => signal != null))
    );
    const linkedSignals = new Set<AbortSignal>();
    for (const signal of upstreamSignals) {
      if (signal.aborted) {
        abortReservation();
      } else {
        signal.addEventListener("abort", abortReservation, { once: true });
        linkedSignals.add(signal);
      }
    }
    const releaseUpstreamLink = (): void => {
      for (const signal of linkedSignals) {
        signal.removeEventListener("abort", abortReservation);
      }
      linkedSignals.clear();
    };
    // Every checkpointed attempt holds one share of the link; the last release disconnects it.
    let linkedAttempts = 0;
    const releaseAttemptLink = (): void => {
      linkedAttempts -= 1;
      if (linkedAttempts <= 0) {
        releaseUpstreamLink();
      }
    };
    const deadline = setTimeout(() => {
      deadlineFired = true;
      abortReservation();
    }, this.reservationTimeoutMs);
    const checkpointed = new Map<number, OwnedWorkflowAgentAttempt>();
    const reservationError = (): Error =>
      deadlineFired && upstream?.aborted !== true
        ? new WorkflowAgentReservationTimeoutError(stepIds, this.reservationTimeoutMs)
        : createReservationCanceledError(stepIds);
    const checkpoint = async (index: number, taskId: string): Promise<void> => {
      const step = input.steps[index];
      assert(step != null, "WorkflowRunner.reserveAgentTasks: lifecycle index mismatch");
      assert(taskId.length > 0, "WorkflowRunner.reserveAgentTasks: created taskId is required");
      assert(!checkpointed.has(index), "WorkflowRunner.reserveAgentTasks: duplicate checkpoint");
      input.leaseGuard.throwIfLost();
      linkedAttempts += 1;
      const attempt: OwnedWorkflowAgentAttempt = {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId,
        title: step.title,
        resultSpec: step.spec,
        startedAt: step.startedAt,
        releaseLaunchSignal: releaseAttemptLink,
      };
      await this.recordStepStarted(runId, {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId,
        startedAt: step.startedAt,
      });
      checkpointed.set(index, attempt);
      this.trackAttempt(runId, attempt);
      await this.recordTaskStartedEventIfMissing(runId, sequence, {
        stepId: step.spec.id,
        taskId,
        title: step.title,
      });
    };
    const disposeCheckpointed = async (): Promise<void> => {
      for (const attempt of checkpointed.values()) {
        try {
          await this.disposeStartedAttempt(runId, sequence, attempt, {
            leaseGuard: input.leaseGuard,
            ...(input.runAbortSignal != null ? { abortSignal: input.runAbortSignal } : {}),
            wait: "pending",
          });
        } catch (error) {
          log.warn(`[workflow-runner] Failed to dispose reserved attempt ${attempt.taskId}`, {
            runId,
            stepId: attempt.stepId,
            error: getErrorMessage(error),
          });
        }
      }
    };

    let createdTasks: Array<{ taskId: string; status: "queued" | "starting" | "running" }>;
    try {
      createdTasks = await createAgentTasks(
        input.steps.map((step) => step.spec),
        {
          abortSignal: reservation.signal,
          onTaskCreated: async (index, taskId) => {
            if (reservation.signal.aborted) {
              // Last cancellation point: nothing durable exists for this task yet.
              throw reservationError();
            }
            await checkpoint(index, taskId);
          },
        }
      );
    } catch (error) {
      const failure = reservation.signal.aborted ? reservationError() : error;
      for (const [index, step] of input.steps.entries()) {
        if (!checkpointed.has(index)) {
          await this.recordAgentReservationFailedEventIfMissing(runId, sequence, {
            stepId: step.spec.id,
            inputHash: step.inputHash,
            title: step.title,
            error: failure,
          });
        }
      }
      // A checkpoint whose reservation then failed is still disposed by its authoritative
      // outcome: the child may have launched and reported before the failure surfaced.
      await disposeCheckpointed();
      // No launch can still be pending once the reservation call itself failed.
      releaseUpstreamLink();
      throw failure;
    } finally {
      // Only the deadline ends here: it bounds admission stages, never a pending launch.
      clearTimeout(deadline);
    }

    if (createdTasks.length !== input.steps.length) {
      throw new Error("Workflow agent reservation returned the wrong number of tasks");
    }
    for (const [index, createdTask] of createdTasks.entries()) {
      assert(createdTask.taskId.length > 0, "WorkflowRunner: created taskId is required");
      const attempt = checkpointed.get(index);
      if (attempt == null) {
        // Adapters without a reservation lifecycle checkpoint after creation.
        await checkpoint(index, createdTask.taskId);
      } else {
        assert(
          attempt.taskId === createdTask.taskId,
          "WorkflowRunner lifecycle taskId must match created taskId"
        );
      }
    }
    if (upstream?.aborted === true) {
      // Late reservation: the batch/run was aborted while admission was already past its fence.
      // The children are run descendants, so stopping the run again (idempotent) covers them.
      await this.taskAdapter.interruptRun?.();
      await disposeCheckpointed();
      throw createReservationCanceledError(stepIds);
    }
    return createdTasks.map((createdTask) => createdTask.taskId);
  }

  /**
   * Decides what a resumed step does with its checkpointed prior attempt before reattaching or
   * discarding it. Never replaces a child whose report may still arrive: only a positively
   * absent report after settlement yields `replace`.
   */
  private async classifyPriorAttempt(
    runId: string,
    sequence: WorkflowEventSequence,
    attempt: OwnedWorkflowAgentAttempt,
    options: { leaseGuard: WorkflowRunnerLeaseGuard; runAbortSignal?: AbortSignal }
  ): Promise<WorkflowPriorAttemptPlan> {
    options.leaseGuard.throwIfLost();
    const outcome = await this.resolveAttemptOutcome(attempt.taskId, {
      ...(options.runAbortSignal != null ? { abortSignal: options.runAbortSignal } : {}),
      wait: "pending",
    });
    options.leaseGuard.throwIfLost();
    switch (outcome.kind) {
      case "reported":
        this.trackAttempt(runId, attempt);
        return { kind: "adopt", report: outcome.report };
      case "live":
        this.trackAttempt(runId, attempt);
        return { kind: "reattach" };
      case "terminal-no-report":
        this.trackAttempt(runId, attempt);
        await this.recordStartedAttemptFailed(
          runId,
          sequence,
          attempt,
          `agent ${attempt.stepId} task ${attempt.taskId} ended without a report`
        );
        return { kind: "replace" };
      case "indeterminate":
        await this.recordAgentAttemptIndeterminateEventIfMissing(runId, sequence, {
          stepId: attempt.stepId,
          inputHash: attempt.inputHash,
          taskId: attempt.taskId,
          title: attempt.title,
          reason: outcome.reason,
        });
        throw new WorkflowPriorAttemptUnresolvedError(
          attempt.stepId,
          attempt.taskId,
          "indeterminate",
          outcome.reason
        );
      case "cleanup-pending":
      case "timeout":
        throw new WorkflowPriorAttemptUnresolvedError(
          attempt.stepId,
          attempt.taskId,
          outcome.kind,
          "the previous attempt's cleanup is still in progress; resume again once it settles"
        );
    }
  }

  /**
   * Disposition after a report wait rejected for a checkpointed attempt. Records the terminal
   * task event as before, then decides report-first: an already persisted report is adopted, a
   * positively absent one fails the attempt (and, for a resumed prior attempt on the exact
   * restart sentinels, allows exactly one replacement), anything unresolved is retained. An
   * aborted batch never recreates a child; a run-level abort leaves settlement to the
   * cancellation drain.
   */
  private async handleAgentWaitFailure(
    runId: string,
    sequence: WorkflowEventSequence,
    attempt: OwnedWorkflowAgentAttempt,
    error: unknown,
    options: {
      leaseGuard: WorkflowRunnerLeaseGuard;
      waitOptions?: WorkflowAgentWaitOptions;
      runAbortSignal?: AbortSignal;
      allowReplacement: boolean;
    }
  ): Promise<WorkflowPriorAttemptPlan> {
    if (isForegroundWaitBackgroundedError(error)) {
      return { kind: "rethrow" };
    }
    const runAborted = options.runAbortSignal?.aborted === true;
    if (!isWorkflowAgentHardTimeoutError(error)) {
      options.leaseGuard.throwIfLost();
      try {
        await this.recordTaskTerminalEventIfMissing(runId, sequence, {
          stepId: attempt.stepId,
          taskId: attempt.taskId,
          title: attempt.title,
          status: getTaskTerminalStatusForError(error, options.waitOptions?.abortSignal),
        });
      } catch (eventError) {
        // A Stop may have persisted `interrupted` already; the original failure is what matters.
        if (!runAborted) {
          throw eventError;
        }
        log.debug(
          `[workflow-runner] Skipped terminal task event after abort: ${getErrorMessage(eventError)}`
        );
      }
    }
    if (isWorkflowAgentHardTimeoutError(error) || runAborted) {
      // Hard timeouts already recorded their failed attempt; run aborts settle in the drain.
      return { kind: "rethrow" };
    }
    if (options.waitOptions?.abortSignal?.aborted === true) {
      // Batch-level abort (fail-fast): the batch asked the child to stop, so wait for it.
      await this.disposeStartedAttempt(runId, sequence, attempt, {
        leaseGuard: options.leaseGuard,
        ...(options.runAbortSignal != null ? { abortSignal: options.runAbortSignal } : {}),
        wait: "pending-or-live",
      });
      return { kind: "rethrow" };
    }
    const outcome = await this.resolveAttemptOutcome(attempt.taskId, {
      ...(options.runAbortSignal != null ? { abortSignal: options.runAbortSignal } : {}),
      wait: "pending-or-live",
    });
    options.leaseGuard.throwIfLost();
    switch (outcome.kind) {
      case "reported":
        return { kind: "adopt", report: outcome.report };
      case "terminal-no-report":
        await this.recordStartedAttemptFailed(
          runId,
          sequence,
          attempt,
          `agent ${attempt.stepId} task ${attempt.taskId} ended without a report: ${getErrorMessage(error)}`
        );
        return options.allowReplacement && shouldRestartUnrecoverableStartedTask(error)
          ? { kind: "replace" }
          : { kind: "rethrow" };
      case "indeterminate":
        await this.recordAgentAttemptIndeterminateEventIfMissing(runId, sequence, {
          stepId: attempt.stepId,
          inputHash: attempt.inputHash,
          taskId: attempt.taskId,
          title: attempt.title,
          reason: outcome.reason,
        });
        return { kind: "rethrow" };
      case "live":
      case "cleanup-pending":
      case "timeout":
        return { kind: "rethrow" };
    }
  }

  /**
   * Post-Stop disposition pass by the runner whose abort fired. Adopts reports that landed before
   * the stop and fails attempts that settled without one; anything still live, cleaning up, or
   * indeterminate keeps its checkpoint for the next resume. Deliberately does not wait for
   * settlement: that bounded wait belongs to resume, and Stop must release the lease promptly.
   */
  private async settleOwnedAttemptsAfterCancellation(
    runId: string,
    sequence: WorkflowEventSequence,
    abortSignal: AbortSignal,
    leaseGuard: WorkflowRunnerLeaseGuard
  ): Promise<void> {
    assert(abortSignal.aborted, "cancellation drain requires the runner's aborted signal");
    const owned = this.ownedAttemptsByRun.get(runId);
    if (owned == null || owned.size === 0) {
      return;
    }
    const attempts = Array.from(owned.values());
    let settlement: WorkflowCancellationSettlement;
    try {
      settlement = await this.runStore.openCancellationSettlement(
        runId,
        this.runnerId,
        abortSignal
      );
    } catch (error) {
      log.warn(`[workflow-runner] Skipping cancellation drain: ${getErrorMessage(error)}`, {
        runId,
      });
      return;
    }
    using _settlement = settlement;
    const dispositions = await Promise.allSettled(
      attempts.map(async (attempt) => {
        leaseGuard.throwIfLost();
        try {
          return await this.disposeStartedAttempt(runId, sequence, attempt, {
            leaseGuard,
            wait: "never",
            settlement,
          });
        } catch (error) {
          // The indeterminate diagnostic is an ordinary event and is rejected once the run is
          // interrupted; the checkpoint itself is what matters and it stays intact.
          log.warn(`[workflow-runner] Cancellation drain could not settle ${attempt.taskId}`, {
            runId,
            stepId: attempt.stepId,
            error: getErrorMessage(error),
          });
          throw error;
        }
      })
    );
    log.debug(`[workflow-runner] Cancellation drain settled ${dispositions.length} attempt(s)`, {
      runId,
    });
  }

  /**
   * A resumed step could not resolve its prior attempt. Re-interrupt (running → interrupted is a
   * valid transition) instead of failing so the run stays explicitly resumable, and stop any
   * children this attempt started through the existing cancellation path.
   */
  private async appendInterruptedForUnresolvedAttempt(
    runId: string,
    sequence: WorkflowEventSequence,
    error: WorkflowPriorAttemptUnresolvedError,
    leaseGuard: WorkflowRunnerLeaseGuard
  ): Promise<void> {
    await this.throwIfInterrupted(runId);
    leaseGuard.throwIfLost();
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "error",
      at: this.clock.nowIso(),
      message: error.message,
    });
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "status",
      at: this.clock.nowIso(),
      status: "interrupted",
    });
    await this.taskAdapter.interruptRun?.();
  }

  private async recordAgentReservationEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    agent: { stepId: string; inputHash: string; title?: string; spec: WorkflowAgentSpec }
  ): Promise<void> {
    assert(
      runId.length > 0,
      "WorkflowRunner.recordAgentReservationEventIfMissing: runId is required"
    );
    assert(agent.stepId.length > 0, "WorkflowRunner: agent reservation stepId is required");
    assert(agent.inputHash.length > 0, "WorkflowRunner: agent reservation inputHash is required");

    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "agent-step" &&
        event.status === "reserving" &&
        event.stepId === agent.stepId &&
        event.inputHash === agent.inputHash
    );
    if (alreadyRecorded) {
      return;
    }

    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "agent-step",
      at: this.clock.nowIso(),
      stepId: agent.stepId,
      inputHash: agent.inputHash,
      status: "reserving",
      title: agent.title,
      details: {
        agentId: agent.spec.agentId ?? null,
        isolation: agent.spec.isolation ?? null,
      },
    });
  }

  private async recordAgentReservationFailedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    agent: { stepId: string; inputHash: string; title?: string; error: unknown }
  ): Promise<void> {
    assert(
      runId.length > 0,
      "WorkflowRunner.recordAgentReservationFailedEventIfMissing: runId is required"
    );
    assert(agent.stepId.length > 0, "WorkflowRunner: agent reservation stepId is required");
    assert(agent.inputHash.length > 0, "WorkflowRunner: agent reservation inputHash is required");

    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "agent-step" &&
        event.status === "failed" &&
        event.stepId === agent.stepId &&
        event.inputHash === agent.inputHash
    );
    if (alreadyRecorded) {
      return;
    }

    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "agent-step",
      at: this.clock.nowIso(),
      stepId: agent.stepId,
      inputHash: agent.inputHash,
      status: "failed",
      title: agent.title,
      details: { error: getErrorMessage(agent.error) },
    });
  }

  private async recordTaskStartedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "started" });
  }

  private async recordTaskCompletedEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, { ...task, status: "completed" });
  }

  private async recordTaskTerminalEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string; status: "failed" | "interrupted" }
  ): Promise<void> {
    await this.recordTaskEventIfMissing(runId, sequence, task);
  }

  private async recordTaskEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    task: { stepId: string; taskId: string; title?: string; status: string }
  ): Promise<void> {
    assert(runId.length > 0, "WorkflowRunner.recordTaskEventIfMissing: runId is required");
    assert(task.stepId.length > 0, "WorkflowRunner: task event stepId is required");
    assert(task.taskId.length > 0, "WorkflowRunner: task event taskId is required");
    assert(task.status.length > 0, "WorkflowRunner: task event status is required");

    await using _lock = await this.taskEventMutex.acquire();
    sequence.next();
    await this.runStore.appendTaskEventIfMissing(
      runId,
      {
        stepId: task.stepId,
        taskId: task.taskId,
        status: task.status,
        at: this.clock.nowIso(),
        title: task.title,
      },
      { expectedLeaseOwnerId: this.runnerId }
    );
  }

  private async recordWorkflowEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    workflow: {
      stepId: string;
      runId: string;
      name: string;
      status: Extract<WorkflowRunEvent, { type: "workflow" }>["status"];
      details?: unknown;
    }
  ): Promise<void> {
    assert(runId.length > 0, "WorkflowRunner.recordWorkflowEventIfMissing: runId is required");
    assert(workflow.stepId.length > 0, "WorkflowRunner: workflow event stepId is required");
    assert(workflow.runId.length > 0, "WorkflowRunner: workflow event runId is required");
    assert(workflow.name.length > 0, "WorkflowRunner: workflow event name is required");

    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "workflow" &&
        event.status === workflow.status &&
        event.stepId === workflow.stepId &&
        event.runId === workflow.runId
    );
    if (alreadyRecorded) {
      return;
    }
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "workflow",
      at: this.clock.nowIso(),
      stepId: workflow.stepId,
      runId: workflow.runId,
      name: workflow.name,
      status: workflow.status,
      details: workflow.details,
    });
  }

  private async recordPatchTerminalEventIfMissing(
    runId: string,
    sequence: WorkflowEventSequence,
    patch: { stepId: string; sourceTaskId: string; result: WorkflowApplyPatchResult }
  ): Promise<void> {
    assert(runId.length > 0, "WorkflowRunner.recordPatchTerminalEventIfMissing: runId is required");
    assert(patch.stepId.length > 0, "WorkflowRunner: patch event stepId is required");
    assert(patch.sourceTaskId.length > 0, "WorkflowRunner: patch event sourceTaskId is required");

    await using _lock = await this.taskEventMutex.acquire();
    const run = await this.runStore.getRun(runId);
    const alreadyRecorded = run.events.some(
      (event) =>
        event.type === "patch" &&
        event.status === patch.result.status &&
        event.stepId === patch.stepId &&
        event.sourceTaskId === patch.sourceTaskId
    );
    if (alreadyRecorded) {
      return;
    }
    await this.appendEvent(runId, {
      sequence: sequence.next(),
      type: "patch",
      at: this.clock.nowIso(),
      stepId: patch.stepId,
      sourceTaskId: patch.sourceTaskId,
      status: patch.result.status,
      details: patch.result,
    });
  }

  private async recordAgentResult(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
      rawResult: WorkflowAgentResult;
    },
    settlement?: WorkflowCancellationSettlement
  ): Promise<StructuredTaskOutput> {
    assert(
      step.rawResult.taskId === step.taskId,
      `agent ${step.spec.id} result task ${step.rawResult.taskId} does not match attempt ${step.taskId}`
    );
    let result: StructuredTaskOutput;
    try {
      result = StructuredTaskOutputSchema.parse(step.rawResult);
    } catch (error) {
      const message = `agent ${step.spec.id} returned invalid task output: ${getErrorMessage(error)}`;
      await this.recordFailedAgentAttempt(runId, sequence, step, message, settlement);
      throw new WorkflowAgentOutputValidationError(message);
    }

    if (step.spec.outputSchema !== undefined) {
      if (!Object.hasOwn(result, "structuredOutput") || result.structuredOutput === undefined) {
        const message = `agent ${step.spec.id} structured output failed schema validation: $.structuredOutput: Required property is missing`;
        await this.recordFailedAgentAttempt(runId, sequence, step, message, settlement);
        throw new WorkflowAgentOutputValidationError(message);
      }
      const validation = validateJsonSchemaSubset(step.spec.outputSchema, result.structuredOutput);
      if (!validation.success) {
        const message = `agent ${step.spec.id} structured output failed schema validation: ${formatJsonSchemaValidationErrors(validation.errors)}`;
        await this.recordFailedAgentAttempt(runId, sequence, step, message, settlement);
        throw new WorkflowAgentOutputValidationError(message);
      }
    }
    step.leaseGuard.throwIfLost();
    const completedAt = this.clock.nowIso();
    sequence.next();
    await this.runStore.recordStepCompletedAndAppendTaskEvent(
      runId,
      {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        title: step.spec.title,
        result,
        startedAt: step.startedAt,
        completedAt,
      },
      this.attemptWriteOptions(settlement)
    );
    this.untrackAttempt(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      taskId: step.taskId,
    });
    return result;
  }

  private async recordFailedAgentAttempt(
    runId: string,
    sequence: WorkflowEventSequence,
    step: {
      spec: WorkflowAgentSpec;
      inputHash: string;
      startedAt: string;
      taskId: string;
      leaseGuard: WorkflowRunnerLeaseGuard;
    },
    message: string,
    settlement?: WorkflowCancellationSettlement
  ): Promise<void> {
    step.leaseGuard.throwIfLost();
    const failedAt = this.clock.nowIso();
    sequence.next();
    sequence.next();
    await this.runStore.recordStepFailedAndAppendTaskEvent(
      runId,
      {
        stepId: step.spec.id,
        inputHash: step.inputHash,
        taskId: step.taskId,
        title: step.spec.title,
        error: message,
        startedAt: step.startedAt,
        completedAt: failedAt,
        validationAt: failedAt,
        taskFailedAt: failedAt,
      },
      this.attemptWriteOptions(settlement)
    );
    this.untrackAttempt(runId, {
      stepId: step.spec.id,
      inputHash: step.inputHash,
      taskId: step.taskId,
    });
  }
}

class WorkflowEventSequence {
  constructor(private current: number) {}

  next(): number {
    this.current += 1;
    return this.current;
  }
}

function parseWorkflowNestedWorkflowSpec(rawSpec: unknown): WorkflowNestedWorkflowSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "workflow requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "workflow replay boundary requires a stable id");
  const scriptPath = spec.script_path ?? spec.scriptPath;
  assert(
    typeof scriptPath === "string" && scriptPath.length > 0,
    "workflow requires a non-empty script_path"
  );
  return {
    id: spec.id,
    scriptPath,
    args: spec.args ?? {},
  };
}

function buildNestedWorkflowStepResult(
  child: WorkflowNestedWorkflowRun,
  result: WorkflowResult
): StructuredTaskOutput {
  return {
    reportMarkdown: result.reportMarkdown,
    structuredOutput: {
      runId: child.runId,
      name: child.name,
      result: getJsonWorkflowResult(result),
    },
  };
}

function getJsonWorkflowResult(result: WorkflowResult): WorkflowResult {
  return result.structuredOutput === undefined ? { reportMarkdown: result.reportMarkdown } : result;
}

function getNestedWorkflowStepOutput(
  output: StructuredTaskOutput
): { runId: string; name: string; result: WorkflowResult } | null {
  const structuredOutput = output.structuredOutput;
  if (structuredOutput == null || typeof structuredOutput !== "object") {
    return null;
  }
  const record = structuredOutput as Record<string, unknown>;
  const runId = record.runId;
  const name = record.name;
  const result = WorkflowResultSchema.safeParse(record.result);
  if (typeof runId !== "string" || typeof name !== "string" || !result.success) {
    return null;
  }
  return { runId, name, result: result.data };
}

function parseWorkflowApplyPatchSpec(rawSpec: unknown): ParsedWorkflowApplyPatchSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "applyPatch requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "applyPatch replay boundary requires a stable id");

  const sourceTaskId = getApplyPatchSourceTaskId(
    spec.source ?? spec.from ?? spec.task ?? spec.taskId
  );
  const agentId = spec.agentId;
  assert(
    sourceTaskId != null || (typeof agentId === "string" && agentId.length > 0),
    "applyPatch requires agentId or a source taskId"
  );

  const target = spec.target ?? "parent";
  assert(target === "parent", "applyPatch target currently supports only 'parent'");
  if (spec.onConflict !== undefined) {
    assert(spec.onConflict === "return", "applyPatch onConflict currently supports only 'return'");
  }
  if (spec.strategy !== undefined) {
    assert(
      spec.strategy === "three-way" || spec.strategy === "dry-run-then-apply",
      "applyPatch strategy currently supports 'three-way' or 'dry-run-then-apply'"
    );
  }

  const parsed: ParsedWorkflowApplyPatchSpec = {
    id: spec.id,
    ...(sourceTaskId != null ? { sourceTaskId } : {}),
    ...(typeof agentId === "string" && agentId.length > 0 ? { agentId } : {}),
    target,
    threeWay: spec.threeWay !== false && spec.three_way !== false,
    force: spec.force === true,
  };
  const expectedHeadSha = spec.expectedHeadSha ?? spec.expected_head_sha;
  if (expectedHeadSha !== undefined) {
    assert(
      typeof expectedHeadSha === "string" && expectedHeadSha.length > 0,
      "applyPatch expectedHeadSha must be a non-empty string"
    );
    parsed.expectedHeadSha = expectedHeadSha;
  }
  if (typeof spec.projectPath === "string" && spec.projectPath.length > 0) {
    parsed.projectPath = spec.projectPath;
  } else if (typeof spec.project_path === "string" && spec.project_path.length > 0) {
    parsed.projectPath = spec.project_path;
  }
  const allowedPathPrefixes = spec.allowedPathPrefixes ?? spec.allowed_path_prefixes;
  if (allowedPathPrefixes !== undefined) {
    assert(Array.isArray(allowedPathPrefixes), "applyPatch allowedPathPrefixes must be an array");
    parsed.allowedPathPrefixes = allowedPathPrefixes.map((prefix) => {
      assert(
        typeof prefix === "string" && prefix.trim().length > 0,
        "applyPatch allowedPathPrefixes entries must be non-empty strings"
      );
      return prefix.trim();
    });
  }
  return parsed;
}

function getApplyPatchSourceTaskId(source: unknown): string | undefined {
  if (typeof source === "string" && source.length > 0) {
    return source;
  }
  if (source != null && typeof source === "object") {
    const taskId = (source as Record<string, unknown>).taskId;
    if (typeof taskId === "string" && taskId.length > 0) {
      return taskId;
    }
  }
  return undefined;
}

function isWorkflowApplyPatchResult(value: unknown): value is WorkflowApplyPatchResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.success === "boolean" &&
    typeof record.taskId === "string" &&
    (record.status === "applied" || record.status === "conflict" || record.status === "failed")
  );
}

function normalizeWorkflowApplyPatchResult(rawResult: unknown): WorkflowApplyPatchResult {
  if (isWorkflowApplyPatchResult(rawResult)) {
    return rawResult;
  }
  const parsed = TaskApplyGitPatchToolResultSchema.parse(rawResult);
  const conflictPaths = getConflictPathsFromPatchResult(parsed);
  const failedPatchSubject = getFailedPatchSubjectFromPatchResult(parsed);
  const status: WorkflowApplyPatchStatus = parsed.success
    ? "applied"
    : conflictPaths.length > 0 || failedPatchSubject != null
      ? "conflict"
      : "failed";

  return stripUndefinedDeep({
    success: parsed.success,
    status,
    taskId: parsed.taskId,
    ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
    ...(parsed.projectResults !== undefined ? { projectResults: parsed.projectResults } : {}),
    ...(parsed.appliedCommits !== undefined ? { appliedCommits: parsed.appliedCommits } : {}),
    ...(parsed.headCommitSha !== undefined ? { headCommitSha: parsed.headCommitSha } : {}),
    ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
    ...(failedPatchSubject !== undefined ? { failedPatchSubject } : {}),
    ...(parsed.success ? {} : { error: parsed.error }),
    ...(parsed.note !== undefined ? { note: parsed.note } : {}),
  }) as WorkflowApplyPatchResult;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (value == null || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (nestedValue !== undefined) {
      output[key] = stripUndefinedDeep(nestedValue);
    }
  }
  return output;
}

function getFailedPatchSubjectFromPatchResult(
  result: ReturnType<typeof TaskApplyGitPatchToolResultSchema.parse>
): string | undefined {
  if (result.success) {
    return undefined;
  }
  if (result.failedPatchSubject != null) {
    return result.failedPatchSubject;
  }
  return result.projectResults
    ?.map((projectResult) => projectResult.failedPatchSubject)
    .find((subject) => subject != null);
}

function getConflictPathsFromPatchResult(
  result: ReturnType<typeof TaskApplyGitPatchToolResultSchema.parse>
): string[] {
  const paths = new Set<string>();
  const topLevelConflictPaths = result.success ? [] : (result.conflictPaths ?? []);
  for (const path of topLevelConflictPaths) {
    paths.add(path);
  }
  for (const projectResult of result.projectResults ?? []) {
    for (const path of projectResult.conflictPaths ?? []) {
      paths.add(path);
    }
  }
  return Array.from(paths);
}

function formatWorkflowApplyPatchReport(result: WorkflowApplyPatchResult): string {
  if (result.status === "applied") {
    return `Patch applied from task ${result.taskId}.`;
  }
  if (result.status === "conflict") {
    const paths = result.conflictPaths?.length
      ? ` Conflicts: ${result.conflictPaths.join(", ")}.`
      : "";
    return `Patch from task ${result.taskId} did not apply cleanly.${paths}`;
  }
  return `Patch from task ${result.taskId} failed: ${result.error ?? "unknown error"}`;
}

function normalizeWorkflowAgentSpecForExecution(
  spec: WorkflowAgentSpec,
  options: { allowMissingOutputSchema: boolean }
): WorkflowAgentSpec {
  if (!options.allowMissingOutputSchema) {
    return spec;
  }
  if (spec.outputSchema === undefined) {
    return spec.markdownOnly === true ? spec : { ...spec, outputSchema: {} };
  }
  const outputSchemaValidation = validateJsonSchemaSubsetSchema(spec.outputSchema, {
    requireObjectSchema: true,
  });
  return outputSchemaValidation.success ? spec : omitWorkflowAgentOutputSchema(spec);
}

function omitWorkflowAgentOutputSchema(spec: WorkflowAgentSpec): WorkflowAgentSpec {
  const { outputSchema: _outputSchema, ...schemaLessSpec } = spec;
  return schemaLessSpec;
}

function validateWorkflowAgentOutputSchema(stepId: string, outputSchema: unknown): void {
  const outputSchemaValidation = validateJsonSchemaSubsetSchema(outputSchema, {
    requireObjectSchema: true,
  });
  if (!outputSchemaValidation.success) {
    throw new Error(
      `Workflow agent step ${stepId} has invalid outputSchema: ${formatJsonSchemaValidationErrors(
        outputSchemaValidation.errors
      )}`
    );
  }
}

function parseStartedWorkflowAgentHandle(rawHandle: unknown): StartedWorkflowAgentHandle {
  assert(
    rawHandle != null && typeof rawHandle === "object",
    "pipeline wait requires agent handles"
  );
  const handleId = (rawHandle as Record<string, unknown>).handleId;
  assert(typeof handleId === "string" && handleId.length > 0, "pipeline agent handle is invalid");
  return { handleId };
}

function parseWorkflowAgentModelString(rawValue: unknown): string | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  assert(
    typeof rawValue === "string" && rawValue.trim().length > 0,
    "agent model must be a non-empty string"
  );
  const normalized = normalizeModelInput(rawValue);
  assert(
    normalized.model != null,
    `agent model "${rawValue}" must be a known alias or provider:model string`
  );
  return normalized.model;
}

function parseWorkflowAgentThinkingLevel(rawValue: unknown): ParsedThinkingInput | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  const value = typeof rawValue === "number" ? String(rawValue) : rawValue;
  assert(
    typeof value === "string" && value.trim().length > 0,
    "agent thinking must be a non-empty string or numeric index"
  );
  const parsed = parseThinkingInput(value);
  assert(
    parsed !== undefined,
    "agent thinking must be one of off, low, medium, high, xhigh, max, or a numeric index"
  );
  return parsed;
}

const WORKFLOW_AGENT_TIMEOUT_MIN_MS = 1_000;
const WORKFLOW_AGENT_SOFT_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1000;
const WORKFLOW_AGENT_GRACE_TIMEOUT_MAX_MS = 60 * 60 * 1000;
const WORKFLOW_AGENT_FINAL_INSTRUCTIONS_MAX_LENGTH = 4_000;

function parseWorkflowAgentTimeoutSpec(rawValue: unknown): WorkflowAgentTimeoutSpec | undefined {
  if (rawValue === undefined) {
    return undefined;
  }
  assert(
    rawValue != null && typeof rawValue === "object" && !Array.isArray(rawValue),
    "agent timeout must be an object"
  );
  const timeout = rawValue as Record<string, unknown>;
  const softMs = timeout.softMs;
  assert(
    typeof softMs === "number" &&
      Number.isInteger(softMs) &&
      softMs >= WORKFLOW_AGENT_TIMEOUT_MIN_MS &&
      softMs <= WORKFLOW_AGENT_SOFT_TIMEOUT_MAX_MS,
    "agent timeout.softMs must be a positive integer between 1000ms and 24h"
  );
  const graceMs = timeout.graceMs;
  assert(
    typeof graceMs === "number" &&
      Number.isInteger(graceMs) &&
      graceMs >= WORKFLOW_AGENT_TIMEOUT_MIN_MS &&
      graceMs <= WORKFLOW_AGENT_GRACE_TIMEOUT_MAX_MS,
    "agent timeout.graceMs must be a positive integer between 1000ms and 1h"
  );
  const parsed: WorkflowAgentTimeoutSpec = { softMs, graceMs };
  if (timeout.finalInstructions !== undefined) {
    assert(
      typeof timeout.finalInstructions === "string" &&
        timeout.finalInstructions.trim().length > 0 &&
        timeout.finalInstructions.length <= WORKFLOW_AGENT_FINAL_INSTRUCTIONS_MAX_LENGTH,
      "agent timeout.finalInstructions must be a non-empty string under 4000 characters"
    );
    parsed.finalInstructions = timeout.finalInstructions;
  }
  return parsed;
}

function parseWorkflowAgentSpec(
  rawSpec: unknown,
  options: { allowMissingOutputSchema: boolean }
): WorkflowAgentSpec {
  assert(rawSpec != null && typeof rawSpec === "object", "agent requires a spec object");
  const spec = rawSpec as Record<string, unknown>;
  assert(typeof spec.id === "string", "agent replay boundary requires a stable id");
  assert(
    typeof spec.prompt === "string" && spec.prompt.length > 0,
    "agent requires a non-empty prompt"
  );
  const parsed: WorkflowAgentSpec = {
    id: spec.id,
    prompt: spec.prompt,
  };
  if (typeof spec.title === "string" && spec.title.length > 0) {
    parsed.title = spec.title;
  }
  if (typeof spec.agentId === "string" && spec.agentId.length > 0) {
    parsed.agentId = spec.agentId;
  }
  const modelString = parseWorkflowAgentModelString(spec.modelString);
  if (modelString !== undefined) {
    parsed.modelString = modelString;
  }
  const thinkingLevel = parseWorkflowAgentThinkingLevel(spec.thinkingLevel);
  if (thinkingLevel !== undefined) {
    parsed.thinkingLevel = thinkingLevel;
  }
  if (spec.isolation !== undefined) {
    assert(
      spec.isolation === "fork" || spec.isolation === "none",
      'agent isolation must be "fork" or "none"'
    );
    parsed.isolation = spec.isolation;
  }
  const timeout = parseWorkflowAgentTimeoutSpec(spec.timeout);
  if (timeout !== undefined) {
    parsed.timeout = timeout;
  }
  if (spec.markdownOnly !== undefined) {
    assert(spec.markdownOnly === true, "agent markdownOnly must be true when provided");
    parsed.markdownOnly = true;
  }
  if (spec.outputSchema === undefined) {
    assert(
      options.allowMissingOutputSchema || parsed.markdownOnly === true,
      `Workflow agent step ${parsed.id} must declare outputSchema`
    );
  } else {
    if (!options.allowMissingOutputSchema) {
      validateWorkflowAgentOutputSchema(parsed.id, spec.outputSchema);
    }
    parsed.outputSchema = spec.outputSchema;
  }
  if (spec.onRefusal !== undefined) {
    assert(
      spec.onRefusal === "fail" || spec.onRefusal === "fallback",
      'agent onRefusal must be "fail" or "fallback"'
    );
    parsed.onRefusal = spec.onRefusal;
  }
  return parsed;
}

function normalizeWorkflowResultForEvent(result: unknown): WorkflowResult {
  if (result != null && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.reportMarkdown === "string") {
      return WorkflowResultSchema.parse({
        reportMarkdown: record.reportMarkdown,
        structuredOutput: record.structuredOutput,
      });
    }
  }

  let reportMarkdown: string | undefined;
  try {
    reportMarkdown = JSON.stringify(result);
  } catch (error) {
    throw new Error(`Workflow result must be JSON-serializable: ${getErrorMessage(error)}`);
  }
  assert(
    typeof reportMarkdown === "string",
    "Workflow must return a reportMarkdown result or another JSON-serializable value"
  );
  return WorkflowResultSchema.parse({ reportMarkdown });
}

function compileWorkflowSource(source: string, options: { allowLegacyAgentType: boolean }): string {
  // Workflow scripts are evaluated as a script (not a module), so export
  // syntax must be rewritten away. Top-level named export declarations are
  // allowed so built-in workflows can expose pure helpers for direct unit
  // tests; only the declaration forms below are supported (no `export {...}`
  // lists). Like the default-export rewrite, this is a lexical transform: a
  // template-literal line inside the workflow that starts with `export ` would
  // also be rewritten, so authors must keep flush-left `export ` lines out of
  // template literals.
  const withoutNamedExports = source.replace(
    /^export\s+(?=(?:async\s+)?function\s|class\s|const\s|let\s|var\s)/gmu,
    ""
  );
  const compiled = withoutNamedExports.replace(
    /export\s+default\s+(async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/u,
    (_match, asyncKeyword: string | undefined) => `${asyncKeyword ?? ""}function __muxWorkflow(`
  );
  assert(compiled !== withoutNamedExports, "Workflow script must export a default function");

  return `
Date = undefined;
Math.random = undefined;
${WORKFLOW_RUNTIME_STDLIB_SOURCE}
let __muxParallelCollectingAgents = null;
let __muxPipelineCollectingAgents = null;
const __MUX_PARALLEL_AGENT_MARKER = "__muxParallelAgentMarker";
const __MUX_ALLOW_LEGACY_AGENT_TYPE = ${options.allowLegacyAgentType ? "true" : "false"};
function __muxParallel(thunks, options) {
  if (!Array.isArray(thunks)) {
    throw new Error("parallel requires an array of thunks");
  }
  const collected = [];
  const previous = __muxParallelCollectingAgents;
  __muxParallelCollectingAgents = collected;
  let branchResults;
  try {
    branchResults = thunks.map((thunk, index) => {
      if (typeof thunk !== "function") {
        throw new Error("parallel entries must be functions");
      }
      return thunk(index);
    });
  } finally {
    __muxParallelCollectingAgents = previous;
  }
  if (collected.length === 0) {
    return branchResults;
  }
  const taskResults = __workflowParallelAgents(collected.map((entry) => entry.spec), options);
  return branchResults.map((branchResult) => {
    if (
      branchResult === null ||
      typeof branchResult !== "object" ||
      branchResult[__MUX_PARALLEL_AGENT_MARKER] !== true
    ) {
      return branchResult;
    }
    const taskResult = taskResults[branchResult.index];
    return __muxAgentReturnValue(taskResult, branchResult.hasSchema, branchResult.isPlanAgent);
  });
}
function __muxPipeline(items, ...stages) {
  if (!Array.isArray(items)) {
    throw new Error("pipeline requires an array of items");
  }
  for (const stage of stages) {
    if (typeof stage !== "function") {
      throw new Error("pipeline stages must be functions");
    }
  }
  const states = items.map((item, index) => ({ index, stageIndex: 0, value: item, done: false }));
  const pending = new Map();
  function startNextStage(state) {
    while (state.stageIndex < stages.length) {
      const stage = stages[state.stageIndex];
      const previous = __muxPipelineCollectingAgents;
      const collected = [];
      __muxPipelineCollectingAgents = collected;
      let stageResult;
      try {
        stageResult = stage(state.value, state.index);
      } finally {
        __muxPipelineCollectingAgents = previous;
      }
      if (collected.length > 0) {
        if (collected.length !== 1) {
          throw new Error("pipeline stages must start exactly one agent task");
        }
        const collectedAgent = collected[0];
        const handle = collectedAgent.handle;
        pending.set(handle.handleId, { state, collectedAgent, handle });
        return;
      }
      state.value = stageResult;
      state.stageIndex += 1;
    }
    state.done = true;
  }
  for (const state of states) {
    startNextStage(state);
  }
  while (pending.size > 0) {
    const completion = __workflowAgentWaitAny(
      Array.from(pending.values()).map((entry) => entry.handle)
    );
    const pendingEntry = pending.get(completion.handleId);
    if (pendingEntry === undefined) {
      throw new Error("pipeline wait returned an unknown agent handle");
    }
    pending.delete(completion.handleId);
    const taskResult = completion.result;
    pendingEntry.state.value = __muxAgentReturnValue(
      taskResult,
      pendingEntry.collectedAgent.hasSchema,
      pendingEntry.collectedAgent.isPlanAgent
    );
    pendingEntry.state.stageIndex += 1;
    startNextStage(pendingEntry.state);
  }
  return states.map((state) => state.value);
}
function __muxPlanAgentResult(taskResult) {
  if (typeof taskResult.reportMarkdown !== "string") {
    throw new Error("Workflow plan agent result is missing reportMarkdown");
  }
  if (typeof taskResult.planFilePath !== "string" || taskResult.planFilePath.length === 0) {
    throw new Error("Workflow plan agent result is missing planFilePath");
  }
  return {
    reportMarkdown: taskResult.reportMarkdown,
    planFilePath: taskResult.planFilePath,
  };
}
function __muxAgentReturnValue(taskResult, hasSchema, isPlanAgent) {
  if (hasSchema) {
    return taskResult.structuredOutput;
  }
  if (isPlanAgent) {
    return __muxPlanAgentResult(taskResult);
  }
  return taskResult.reportMarkdown;
}
function __muxApplyPatch(spec) {
  if (spec === null || typeof spec !== "object") {
    throw new Error("applyPatch requires a spec object");
  }
  return __workflowApplyPatch(spec);
}
function __muxNestedWorkflow(scriptPathOrSpec, options) {
  let spec;
  if (typeof scriptPathOrSpec === "string") {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("workflow replay boundary requires a stable id");
    }
    spec = { ...options, scriptPath: scriptPathOrSpec };
  } else if (
    scriptPathOrSpec !== null &&
    typeof scriptPathOrSpec === "object" &&
    !Array.isArray(scriptPathOrSpec)
  ) {
    if (options !== undefined) {
      throw new Error("workflow object form does not accept a second argument");
    }
    spec = scriptPathOrSpec;
  } else {
    throw new Error("workflow requires a script path string or spec object");
  }
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new Error("workflow replay boundary requires a stable id");
  }
  return __workflowNestedWorkflow(spec);
}
function __muxAgent(prompt, options) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("agent requires a non-empty prompt");
  }
  if (options === null || typeof options !== "object") {
    throw new Error("agent replay boundary requires a stable id");
  }
  if (typeof options.id !== "string" || options.id.length === 0) {
    throw new Error("agent replay boundary requires a stable id");
  }
  if (Object.prototype.hasOwnProperty.call(options, "effort")) {
    throw new Error("agent options.effort is not supported; use options.thinking");
  }
  const spec = { ...options, prompt };
  if (Object.prototype.hasOwnProperty.call(spec, "model")) {
    spec.modelString = spec.model;
    delete spec.model;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "thinking")) {
    spec.thinkingLevel = spec.thinking;
    delete spec.thinking;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "schema")) {
    spec.outputSchema = spec.schema;
    delete spec.schema;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "agentType")) {
    if (!__MUX_ALLOW_LEGACY_AGENT_TYPE) {
      throw new Error("agent options.agentType is not supported; use options.agentId");
    }
    spec.agentId = spec.agentType;
    delete spec.agentType;
  }
  const hasSchema = Object.prototype.hasOwnProperty.call(spec, "outputSchema");
  const isPlanAgent = spec.agentId === "plan";
  if (isPlanAgent && hasSchema) {
    throw new Error(
      "Workflow plan agents return { reportMarkdown, planFilePath }; do not provide schema/outputSchema."
    );
  }
  if (!hasSchema) {
    spec.markdownOnly = true;
  }
  if (__muxParallelCollectingAgents !== null) {
    const index = __muxParallelCollectingAgents.length;
    __muxParallelCollectingAgents.push({ spec });
    return {
      [__MUX_PARALLEL_AGENT_MARKER]: true,
      index,
      hasSchema,
      isPlanAgent,
    };
  }
  if (__muxPipelineCollectingAgents !== null) {
    __muxPipelineCollectingAgents.push({
      handle: __workflowAgentStart(spec),
      hasSchema,
      isPlanAgent,
    });
    return null;
  }
  const result = __workflowAgent(spec);
  return __muxAgentReturnValue(result, hasSchema, isPlanAgent);
}
${compiled}
return (async () => await __muxWorkflow({
  args: __workflowArgs(),
  phase: __workflowPhase,
  log: __workflowLog,
  agent: __muxAgent,
  parallel: __muxParallel,
  pipeline: __muxPipeline,
  applyPatch: __muxApplyPatch,
  workflow: __muxNestedWorkflow,
}))();
`;
}
