import * as crypto from "node:crypto";
import * as path from "node:path";

import {
  isTerminalWorkflowRunStatus,
  type WorkflowScriptDescriptor,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import type { BackgroundWorkAttentionPolicy } from "@/common/types/backgroundWorkAttention";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import { getWorkflowCheckpointRetryEligibility } from "@/common/utils/workflowRetryEligibility";
import { log } from "@/node/services/log";
import type { IJSRuntimeFactory } from "@/node/services/ptc/runtime";
import { WORKFLOW_RUN_TASK_ID_PREFIX } from "@/node/services/tools/taskId";
import type { WorkflowRunStatusSnapshot, WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunBackgroundedError,
  WorkflowRunner,
  type WorkflowNestedWorkflowSpec,
  type WorkflowRunnerClock,
  type WorkflowRunnerRunOptions,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { deriveChildWorkflowRunId, MAX_NESTED_WORKFLOW_DEPTH } from "./nestedWorkflowRuns";
import {
  acquireWorkflowArchiveAdmission,
  registerInProcessWorkflowRun,
} from "./workflowArchiveAdmission";
import { normalizeWorkflowArgsForSource } from "./workflowArgs";
import { parseWorkflowDescription, parseWorkflowName } from "./workflowDescription";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

export interface WorkflowBackgroundRunTerminalEvent {
  runId: string;
  status: WorkflowRunStatus;
  result: unknown;
  run: WorkflowRunRecord;
}

export interface WorkflowRunStatusChangedEvent {
  workspaceId: string;
  runId: string;
  status: WorkflowRunStatus;
}

export interface WorkflowServiceOptions {
  runStore: WorkflowRunStore;
  runtimeFactory: IJSRuntimeFactory;
  taskAdapter?: WorkflowTaskAdapter;
  /** workflowName is the human-readable display name, used to label spawned tasks. */
  taskAdapterFactory?: (runId: string, workflowName?: string) => WorkflowTaskAdapter;
  resolveWorkflowScript?: (scriptPath: string) => Promise<ResolvedWorkflowScript>;
  onBackgroundRunTerminal?: (event: WorkflowBackgroundRunTerminalEvent) => Promise<void> | void;
  onRunStatusChanged?: (event: WorkflowRunStatusChangedEvent) => Promise<void> | void;
  /** When true, background terminal notifications also fire for interrupted runs. */
  notifyInterruptedBackgroundRunTerminal?: boolean;
  generateRunId?: () => string;
  // Delayed crash-recovery retries must use current trust, not the value captured when scheduled.
  getCurrentProjectTrusted?: () => boolean | Promise<boolean>;
  /** Stable prefix; WorkflowService appends run identity and a nonce for each lease owner. */
  runnerId: string;
  clock?: WorkflowRunnerClock;
}

export interface WorkflowRunCreatedEvent {
  runId: string;
  status: "pending";
  result: null;
  run: WorkflowRunRecord;
}

export interface WorkflowBackgroundRunCreatedEvent {
  runId: string;
  status: "running";
  result: null;
  run: WorkflowRunRecord;
}

export interface StartWorkflowInput {
  script: ResolvedWorkflowScript;
  workspaceId: string;
  projectTrusted: boolean;
  args: unknown;
  /** Server-resolved invocation context; applied only to schema-declared args that callers omit. */
  defaultArgs?: Record<string, unknown>;
  /** Called after the durable run record exists but before the foreground runner can block. */
  onRunCreated?: (event: WorkflowRunCreatedEvent) => Promise<void> | void;
  onBackgroundRunCreated?: (event: WorkflowBackgroundRunCreatedEvent) => Promise<void> | void;
  abortSignal?: AbortSignal;
  backgroundOnMessageQueued?: boolean;
  /**
   * Background runs persist "notify_on_terminal" so the owner's stream-end does not force a
   * task_await; foreground/default runs omit this (blocking). Terminal wake-up for background runs
   * is handled by AIService.onBackgroundRunTerminal.
   */
  attentionPolicy?: BackgroundWorkAttentionPolicy;
}

export interface StartNamedWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  result: unknown;
}

const WORKFLOW_BACKGROUND_CONTINUATION_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "failed",
]);

// oRPC creates a WorkflowService per request, so workflow lifecycle state that spans requests
// needs process-wide registries.
const pendingCrashResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeWorkflowInterruptStatusWrites = new Map<string, Promise<void>>();
const activeWorkflowRunnerAbortControllers = new Map<string, AbortController>();

export class WorkflowService {
  private readonly runStore: WorkflowRunStore;
  private readonly runtimeFactory: IJSRuntimeFactory;
  private readonly taskAdapter?: WorkflowTaskAdapter;
  private readonly taskAdapterFactory?: (
    runId: string,
    workflowName?: string
  ) => WorkflowTaskAdapter;
  private readonly resolveWorkflowScript?: (scriptPath: string) => Promise<ResolvedWorkflowScript>;
  private readonly onBackgroundRunTerminal?: (
    event: WorkflowBackgroundRunTerminalEvent
  ) => Promise<void> | void;
  private readonly onRunStatusChanged?: (
    event: WorkflowRunStatusChangedEvent
  ) => Promise<void> | void;
  private readonly notifyInterruptedBackgroundRunTerminal: boolean;
  private readonly generateRunId: () => string;
  private readonly getCurrentProjectTrusted?: () => boolean | Promise<boolean>;
  private readonly runnerId: string;
  private readonly clock?: WorkflowRunnerClock;

  private readonly backgroundRuns = new Set<Promise<void>>();

  constructor(options: WorkflowServiceOptions) {
    assert(options.runnerId.length > 0, "WorkflowService: runnerId is required");
    this.runStore = options.runStore;
    this.runtimeFactory = options.runtimeFactory;
    assert(
      options.taskAdapter != null || options.taskAdapterFactory != null,
      "WorkflowService: taskAdapter or taskAdapterFactory is required"
    );
    this.taskAdapter = options.taskAdapter;
    this.taskAdapterFactory = options.taskAdapterFactory;
    this.resolveWorkflowScript = options.resolveWorkflowScript;
    this.onBackgroundRunTerminal = options.onBackgroundRunTerminal;
    this.onRunStatusChanged = options.onRunStatusChanged;
    this.notifyInterruptedBackgroundRunTerminal =
      options.notifyInterruptedBackgroundRunTerminal === true;
    this.generateRunId = options.generateRunId ?? generateWorkflowRunId;
    this.getCurrentProjectTrusted = options.getCurrentProjectTrusted;
    this.runnerId = options.runnerId;
    this.clock = options.clock;
  }

  async listRuns(input: { workspaceId: string }): Promise<WorkflowRunRecord[]> {
    assert(input.workspaceId.length > 0, "WorkflowService.listRuns: workspaceId is required");
    const snapshots = await this.runStore.listRunStatusSnapshots();
    const runs = await Promise.all(
      snapshots
        .filter(
          (snapshot) =>
            snapshot.workspaceId === input.workspaceId && snapshot.parentWorkflow == null
        )
        .map(async (snapshot): Promise<WorkflowRunRecord | null> => {
          try {
            const run = await this.runStore.getRun(snapshot.id);
            return run.workspaceId === input.workspaceId && run.parentWorkflow == null ? run : null;
          } catch (error) {
            log.warn(
              `Skipping unreadable workflow run '${snapshot.id}': ${getErrorMessage(error)}`
            );
            return null;
          }
        })
    );
    return runs.filter((run): run is WorkflowRunRecord => run != null);
  }

  async resumeCrashedRuns(input: {
    workspaceId: string;
    projectTrusted: boolean;
  }): Promise<string[]> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowService.resumeCrashedRuns: workspaceId is required"
    );
    const runs = await this.listRuns({ workspaceId: input.workspaceId });
    const resumable = runs.filter(
      (run) => run.status === "running" || run.status === "backgrounded"
    );
    const resumedRunIds: string[] = [];
    for (const run of resumable) {
      if (
        await this.resumeCrashRecoveredRun({
          runId: run.id,
          projectTrusted: input.projectTrusted,
          failureMessage: "Auto-resumed workflow run failed:",
        })
      ) {
        resumedRunIds.push(run.id);
      }
    }
    return resumedRunIds;
  }

  async getRun(input: { workspaceId: string; runId: string }): Promise<WorkflowRunRecord | null> {
    assert(input.workspaceId.length > 0, "WorkflowService.getRun: workspaceId is required");
    assert(input.runId.length > 0, "WorkflowService.getRun: runId is required");
    try {
      const run = await this.runStore.getRun(input.runId);
      return run.workspaceId === input.workspaceId ? run : null;
    } catch {
      return null;
    }
  }

  private async notifyRunStatusChanged(
    run: WorkflowRunStatusSnapshot,
    status: WorkflowRunStatus = run.status
  ): Promise<void> {
    if (this.onRunStatusChanged == null || run.parentWorkflow != null) {
      return;
    }
    try {
      await this.onRunStatusChanged({ workspaceId: run.workspaceId, runId: run.id, status });
    } catch (error) {
      console.error("Workflow run activity notification failed:", error);
    }
  }

  private async notifyLatestRunStatus(runId: string): Promise<void> {
    if (this.onRunStatusChanged == null) {
      return;
    }
    try {
      await this.notifyRunStatusChanged(await this.runStore.getRunStatusSnapshot(runId));
    } catch (error) {
      console.error("Failed to load workflow run for activity notification:", error);
    }
  }

  async interruptRun(input: { workspaceId: string; runId: string }): Promise<WorkflowRunRecord> {
    return await this.interruptRunTree(input, new Set(), false);
  }

  private async interruptRunTree(
    input: { workspaceId: string; runId: string },
    visitedRunIds: Set<string>,
    skipTerminalRun: boolean
  ): Promise<WorkflowRunRecord> {
    const run = await this.requireRunForWorkspace(input);
    if (visitedRunIds.has(input.runId)) {
      return run;
    }
    visitedRunIds.add(input.runId);
    if (skipTerminalRun && isTerminalWorkflowRunStatus(run.status)) {
      return run;
    }
    assertWorkflowRunCanTransition(run.status, "interrupted");
    const interruptStatusWrite = Promise.withResolvers<void>();
    activeWorkflowInterruptStatusWrites.set(input.runId, interruptStatusWrite.promise);
    let statusWriteSettled = false;
    const settleStatusWrite = () => {
      if (statusWriteSettled) {
        return;
      }
      statusWriteSettled = true;
      interruptStatusWrite.resolve();
    };
    try {
      // Stop the active coordinator only after ownership is validated; status writes can block on
      // I/O, but a mis-scoped request must not abort another workspace's run.
      this.abortActiveRunner(input.runId);
      const interrupted = await this.runStore.appendStatus(
        input.runId,
        "interrupted",
        this.clock?.nowIso() ?? new Date().toISOString()
      );
      settleStatusWrite();
      await this.notifyRunStatusChanged(interrupted);
      await (this.taskAdapterFactory?.(input.runId) ?? this.requireTaskAdapter()).interruptRun?.();
      await this.interruptChildWorkflowRuns(input, visitedRunIds);
      return interrupted;
    } finally {
      settleStatusWrite();
      if (activeWorkflowInterruptStatusWrites.get(input.runId) === interruptStatusWrite.promise) {
        activeWorkflowInterruptStatusWrites.delete(input.runId);
      }
    }
  }

  private async interruptChildWorkflowRuns(
    input: { workspaceId: string; runId: string },
    visitedRunIds: Set<string>
  ): Promise<void> {
    const childRuns = (await this.runStore.listRunStatusSnapshots()).filter(
      (snapshot) =>
        snapshot.workspaceId === input.workspaceId &&
        snapshot.parentWorkflow?.runId === input.runId &&
        !isTerminalWorkflowRunStatus(snapshot.status)
    );
    for (const childRun of childRuns) {
      // Child workflow runs from older workflow scripts are still persisted separately;
      // interrupting the parent must also stop their run-scoped agents before returning.
      await this.interruptRunTree(
        { workspaceId: input.workspaceId, runId: childRun.id },
        visitedRunIds,
        true
      );
    }
  }

  async retryRunFromCheckpointInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing; see resumeRunInBackground.
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanRetryFromCheckpoint(run);
    // A checkpoint retry dispatched in the background is non-blocking just like background resume:
    // persist notify_on_terminal before starting the background runner.
    await this.runStore.setAttentionPolicy(input.runId, "notify_on_terminal");
    await this.runInBackground(input.runId, "Background workflow checkpoint retry failed:", {
      allowRetryFromFailedCheckpoint: true,
      projectTrusted: input.projectTrusted,
    });
    await this.notifyRunStatusChanged(run, "running");
    return { runId: input.runId, status: "running", result: null };
  }

  async resumeRunInBackground(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
  }): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing: refuse while the workspace is archiving/archived, and hold
    // the admission across the method so the archive sink observes a resume that has not yet
    // durably re-activated its run (see workflowArchiveAdmission).
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanTransition(run.status, "running");
    // A run resumed in the background becomes non-blocking; persist so future stream-ends do not
    // re-force a task_await even if the run was originally started in the foreground.
    await this.runStore.setAttentionPolicy(input.runId, "notify_on_terminal");
    await this.runInBackground(input.runId, "Background workflow resume failed:", {
      allowResumeFromInterrupted: run.status === "interrupted",
      projectTrusted: input.projectTrusted,
    });
    await this.notifyRunStatusChanged(run, "running");
    return { runId: input.runId, status: "running", result: null };
  }

  async resumeRun(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing; see resumeRunInBackground.
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanTransition(run.status, "running");
    return await this.runForegroundWithAbortInterrupt({
      workspaceId: input.workspaceId,
      run,
      projectTrusted: input.projectTrusted,
      abortSignal: input.abortSignal,
      runnerOptions: { allowResumeFromInterrupted: run.status === "interrupted" },
      backgroundedFailureMessage: "Backgrounded workflow resume failed:",
    });
  }

  async retryRunFromCheckpoint(input: {
    workspaceId: string;
    runId: string;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
  }): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing; see resumeRunInBackground.
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const run = await this.requireRunForWorkspace(input);
    assertRunCanResumeWithCurrentTrust(run, input.projectTrusted);
    assertWorkflowRunCanRetryFromCheckpoint(run);
    return await this.runForegroundWithAbortInterrupt({
      workspaceId: input.workspaceId,
      run,
      projectTrusted: input.projectTrusted,
      abortSignal: input.abortSignal,
      runnerOptions: { allowRetryFromFailedCheckpoint: true },
      backgroundedFailureMessage: "Backgrounded workflow checkpoint retry failed:",
    });
  }

  /**
   * Shared foreground runner choreography: abort-signal -> interrupt wiring, lease-scoped
   * runner abort registration, and self-backgrounding continuation.
   */
  private async runForegroundWithAbortInterrupt(input: {
    workspaceId: string;
    run: WorkflowRunStatusSnapshot;
    projectTrusted: boolean;
    abortSignal?: AbortSignal;
    runnerOptions: Pick<
      WorkflowRunnerRunOptions,
      "allowResumeFromInterrupted" | "allowRetryFromFailedCheckpoint"
    >;
    backgroundedFailureMessage: string;
  }): Promise<StartNamedWorkflowResult> {
    const runId = input.run.id;
    if (isAbortSignalAborted(input.abortSignal)) {
      // The caller was aborted before the runner started; leave the run in its current
      // (still resumable) state instead of churning status transitions.
      throw new Error(`Workflow run interrupted: ${runId}`);
    }

    await this.notifyRunStatusChanged(input.run, "running");

    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    const abortInterrupt = this.interruptRunOnAbort(
      input.workspaceId,
      runId,
      input.abortSignal,
      runnerAbortController
    );
    try {
      const runner = await this.createRunner(runId);
      const result = await runner.run(runId, {
        abortSignal: runnerAbortController.signal,
        onLeaseAcquired: () => {
          unregisterRunnerAbort = this.registerActiveRunnerAbortController(
            runId,
            input.workspaceId,
            runnerAbortController
          );
        },
        ...input.runnerOptions,
      });
      await this.notifyRunStatusChanged(input.run, "completed");
      return { runId, status: "completed", result };
    } catch (error) {
      if (error instanceof WorkflowRunBackgroundedError) {
        // The runner durably appended `backgrounded` before throwing, so the continuation
        // needs no resume/retry permission flags. Deliberately do NOT forward
        // `allowResumeFromInterrupted`/`allowRetryFromFailedCheckpoint` here: an
        // `interrupted` status observed by the continuation means someone interrupted the
        // run during the lease handoff, and that interrupt must win instead of being
        // silently reverted back to `running`. Likewise skip the continuation entirely
        // when this call was aborted (interruptRunOnAbort aborts our runner controller and
        // is concurrently transitioning the run to `interrupted`).
        await this.runStore.setAttentionPolicy(runId, "notify_on_terminal");
        await this.notifyRunStatusChanged(input.run, "backgrounded");
        if (!runnerAbortController.signal.aborted) {
          void this.runInBackground(runId, input.backgroundedFailureMessage, {
            projectTrusted: input.projectTrusted,
          }).catch(() => undefined);
        }
        return { runId, status: "backgrounded", result: null };
      }
      await this.notifyLatestRunStatus(runId);
      throw error;
    } finally {
      abortInterrupt.remove();
      try {
        await abortInterrupt.wait();
        await this.ensureInterruptedAfterAbort(input.workspaceId, runId, input.abortSignal);
      } finally {
        unregisterRunnerAbort();
      }
    }
  }

  async startWorkflowInBackground(input: StartWorkflowInput): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing; see resumeRunInBackground.
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const createdRun = await this.createWorkflowRun({
      ...input,
      attentionPolicy: "notify_on_terminal",
    });
    const runId = createdRun.id;
    await this.notifyRunStatusChanged(createdRun);
    await input.onRunCreated?.({ runId, status: "pending", result: null, run: createdRun });
    const run = await this.runStore.appendStatus(
      runId,
      "running",
      this.clock?.nowIso() ?? new Date().toISOString()
    );
    await this.notifyRunStatusChanged(run);
    await input.onBackgroundRunCreated?.({ runId, status: "running", result: null, run });
    void this.runInBackground(runId, "Background workflow run failed:", {
      projectTrusted: input.projectTrusted,
    }).catch(() => undefined);
    return { runId, status: "running", result: null };
  }

  async startWorkflow(input: StartWorkflowInput): Promise<StartNamedWorkflowResult> {
    // Archive admission pairing; see resumeRunInBackground.
    using _archiveAdmission = acquireWorkflowArchiveAdmission(input.workspaceId);
    const createdRun = await this.createWorkflowRun(input);
    const runId = createdRun.id;
    await this.notifyRunStatusChanged(createdRun);
    await input.onRunCreated?.({ runId, status: "pending", result: null, run: createdRun });
    if (isAbortSignalAborted(input.abortSignal)) {
      await this.interruptRun({ workspaceId: input.workspaceId, runId });
      throw new Error(`Workflow run interrupted: ${runId}`);
    }

    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    const abortInterrupt = this.interruptRunOnAbort(
      input.workspaceId,
      runId,
      input.abortSignal,
      runnerAbortController
    );
    try {
      const runner = await this.createRunner(runId);
      const result = await runner.run(runId, {
        abortSignal: runnerAbortController.signal,
        ...(input.backgroundOnMessageQueued !== undefined
          ? { backgroundOnMessageQueued: input.backgroundOnMessageQueued }
          : {}),
        onLeaseAcquired: () => {
          unregisterRunnerAbort = this.registerActiveRunnerAbortController(
            runId,
            input.workspaceId,
            runnerAbortController
          );
        },
      });
      await this.notifyRunStatusChanged(createdRun, "completed");
      return { runId, status: "completed", result };
    } catch (error) {
      if (error instanceof WorkflowRunBackgroundedError) {
        await this.runStore.setAttentionPolicy(runId, "notify_on_terminal");
        await this.notifyRunStatusChanged(createdRun, "backgrounded");
        if (!runnerAbortController.signal.aborted) {
          void this.runInBackground(runId, "Backgrounded workflow run failed:", {
            projectTrusted: input.projectTrusted,
          }).catch(() => undefined);
        }
        return { runId, status: "backgrounded", result: null };
      }
      await this.notifyLatestRunStatus(runId);
      throw error;
    } finally {
      abortInterrupt.remove();
      await abortInterrupt.wait();
      unregisterRunnerAbort();
    }
  }

  private async resumeCrashRecoveredRun(input: {
    runId: string;
    projectTrusted: boolean;
    failureMessage: string;
  }): Promise<boolean> {
    const projectTrusted = await this.resolveCurrentProjectTrust(input.projectTrusted);
    const run = await this.getCrashRecoverableRun(input.runId);
    if (run == null || !canResumeRunWithCurrentTrust(run, projectTrusted)) {
      return false;
    }

    const retryDelayMs = await this.runStore.getLeaseRetryDelayMs(
      input.runId,
      this.clock?.nowMs() ?? Date.now()
    );
    if (retryDelayMs > 0) {
      this.scheduleCrashResumeRetry(input, retryDelayMs);
      return true;
    }

    try {
      await this.runInBackground(input.runId, input.failureMessage, { projectTrusted });
      return true;
    } catch (error) {
      if (isWorkflowRunAlreadyActiveError(error, input.runId)) {
        const nextRetryDelayMs = await this.runStore.getLeaseRetryDelayMs(
          input.runId,
          this.clock?.nowMs() ?? Date.now()
        );
        this.scheduleCrashResumeRetry(input, Math.max(1, nextRetryDelayMs));
        return true;
      }
      console.error(input.failureMessage, error);
      return false;
    }
  }

  private async resolveCurrentProjectTrust(fallback: boolean): Promise<boolean> {
    return (await this.getCurrentProjectTrusted?.()) ?? fallback;
  }

  private async getCrashRecoverableRun(runId: string): Promise<WorkflowRunRecord | null> {
    try {
      const run = await this.runStore.getRun(runId);
      return run.status === "running" || run.status === "backgrounded" ? run : null;
    } catch {
      return null;
    }
  }

  private scheduleCrashResumeRetry(
    input: { runId: string; projectTrusted: boolean; failureMessage: string },
    delayMs: number
  ): void {
    assert(delayMs > 0, "WorkflowService.scheduleCrashResumeRetry: delayMs must be positive");
    if (pendingCrashResumeTimers.has(input.runId)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingCrashResumeTimers.delete(input.runId);
      void this.resumeCrashRecoveredRun(input).catch((error: unknown) => {
        console.error(input.failureMessage, error);
      });
    }, delayMs);
    unrefTimer(timer);
    pendingCrashResumeTimers.set(input.runId, timer);
  }

  private registerActiveRunnerAbortController(
    runId: string,
    workspaceId: string,
    controller: AbortController
  ): () => void {
    assert(runId.length > 0, "WorkflowService.registerActiveRunnerAbortController: runId required");
    const existing = activeWorkflowRunnerAbortControllers.get(runId);
    if (existing != null && existing !== controller) {
      existing.abort();
    }
    activeWorkflowRunnerAbortControllers.set(runId, controller);
    // Registration happens at lease acquisition, while the entry point's archive admission is
    // still held, so the archive sink observes in-process workflow work continuously from
    // admission entry to terminal settlement (see workflowArchiveAdmission).
    const releaseInProcessWork = registerInProcessWorkflowRun(workspaceId);
    return () => {
      if (activeWorkflowRunnerAbortControllers.get(runId) === controller) {
        activeWorkflowRunnerAbortControllers.delete(runId);
      }
      releaseInProcessWork();
    };
  }

  private abortActiveRunner(runId: string): void {
    activeWorkflowRunnerAbortControllers.get(runId)?.abort();
  }

  private async ensureInterruptedAfterAbort(
    workspaceId: string,
    runId: string,
    callerAbortSignal: AbortSignal | undefined
  ): Promise<void> {
    // Only the caller's abort signal means this resume/retry should preserve an interrupt.
    // The runner controller can also be aborted during legitimate lease handoffs/replacements.
    if (callerAbortSignal?.aborted !== true) {
      return;
    }

    const run = await this.getRun({ workspaceId, runId });
    if (run == null || isTerminalWorkflowRunStatus(run.status)) {
      return;
    }

    await this.interruptRun({ workspaceId, runId });
  }

  private interruptRunOnAbort(
    workspaceId: string,
    runId: string,
    abortSignal: AbortSignal | undefined,
    runnerAbortController: AbortController | undefined
  ): { remove: () => void; wait: () => Promise<void> } {
    if (abortSignal == null) {
      return { remove: () => undefined, wait: () => Promise.resolve() };
    }
    let interruptPromise: Promise<void> | null = null;
    const interrupt = () => {
      // Cancel the coordinator before interrupt side effects can block on task cleanup or disk I/O.
      runnerAbortController?.abort();
      interruptPromise = (async () => {
        try {
          await this.interruptRun({ workspaceId, runId });
        } catch {
          // The run may have completed or failed before the abort event was delivered.
        }
      })();
    };
    abortSignal.addEventListener("abort", interrupt, { once: true });
    return {
      remove: () => abortSignal.removeEventListener("abort", interrupt),
      wait: async () => {
        await interruptPromise;
      },
    };
  }

  private async createWorkflowRun(input: StartWorkflowInput): Promise<WorkflowRunRecord> {
    assert(
      input.workspaceId.length > 0,
      "WorkflowService.createWorkflowRun: workspaceId is required"
    );
    const runId = this.generateRunId();
    assert(runId.length > 0, "WorkflowService.createWorkflowRun: generated run id is required");

    const normalized = normalizeWorkflowArgsForSource(input.script.source, input.args, {
      defaultArgs: input.defaultArgs,
    });
    return await this.runStore.createRun({
      id: runId,
      workspaceId: input.workspaceId,
      workflow: buildWorkflowScriptDescriptor(input.script),
      source: input.script.source,
      args: normalized.args,
      ...(input.attentionPolicy != null ? { attentionPolicy: input.attentionPolicy } : {}),
      now: this.clock?.nowIso() ?? new Date().toISOString(),
    });
  }

  private async runInBackground(
    runId: string,
    failureMessage: string,
    runnerOptions: Pick<
      WorkflowRunnerRunOptions,
      "allowResumeFromInterrupted" | "allowRetryFromFailedCheckpoint"
    > & {
      projectTrusted: boolean;
    }
  ): Promise<void> {
    const runStatus = await this.runStore.getRunStatusSnapshot(runId);
    const runner = await this.createRunner(runId);
    const runnerAbortController = new AbortController();
    let unregisterRunnerAbort: () => void = () => undefined;
    let startedSettled = false;
    let resolveStarted: (() => void) | null = null;
    let rejectStarted: ((error: unknown) => void) | null = null;
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const markStarted = () => {
      if (startedSettled) {
        return;
      }
      startedSettled = true;
      assert(resolveStarted != null, "WorkflowService.runInBackground: resolveStarted missing");
      resolveStarted();
    };
    const markStartFailed = (error: unknown) => {
      if (startedSettled) {
        return;
      }
      startedSettled = true;
      assert(rejectStarted != null, "WorkflowService.runInBackground: rejectStarted missing");
      rejectStarted(error);
    };
    const markLeaseAcquired = () => {
      unregisterRunnerAbort = this.registerActiveRunnerAbortController(
        runId,
        runStatus.workspaceId,
        runnerAbortController
      );
      markStarted();
    };
    const runPromise = runner
      .run(runId, {
        abortSignal: runnerAbortController.signal,
        onLeaseAcquired: markLeaseAcquired,
        backgroundOnMessageQueued: false,
        ...runnerOptions,
      })
      .then(async (result) => {
        await this.notifyRunStatusChanged(runStatus, "completed");
        await this.notifyBackgroundRunTerminal(runId, result);
      })
      .catch(async (error: unknown) => {
        const hadStarted = startedSettled;
        markStartFailed(error);
        if (!hadStarted && isWorkflowRunAlreadyActiveError(error, runId)) {
          return;
        }
        if (!(await this.isInterruptedBackgroundRun(runId))) {
          console.error(failureMessage, error);
        }
        await this.notifyLatestRunStatus(runId);
        await this.notifyBackgroundRunTerminal(runId, null);
      });
    this.backgroundRuns.add(runPromise);
    void runPromise.finally(() => {
      unregisterRunnerAbort();
      this.backgroundRuns.delete(runPromise);
    });
    return started;
  }

  private async isInterruptedBackgroundRun(runId: string): Promise<boolean> {
    assert(runId.length > 0, "WorkflowService.isInterruptedBackgroundRun: runId required");
    // interruptRun aborts the active runner before writing the durable interrupted status so
    // cancellation is prompt; wait for that status write before classifying the background exit.
    await activeWorkflowInterruptStatusWrites.get(runId);
    try {
      const run = await this.runStore.getRun(runId);
      return run.status === "interrupted";
    } catch {
      return false;
    }
  }

  private async notifyBackgroundRunTerminal(runId: string, result: unknown): Promise<void> {
    if (this.onBackgroundRunTerminal == null) {
      return;
    }

    let run: WorkflowRunRecord;
    try {
      run = await this.runStore.getRun(runId);
    } catch (error) {
      console.error("Failed to load terminal workflow run for notification:", error);
      return;
    }

    if (
      !WORKFLOW_BACKGROUND_CONTINUATION_STATUSES.has(run.status) &&
      !(this.notifyInterruptedBackgroundRunTerminal && run.status === "interrupted")
    ) {
      return;
    }

    try {
      await this.onBackgroundRunTerminal({ runId, status: run.status, result, run });
    } catch (error) {
      console.error("Workflow background terminal notification failed:", error);
    }
  }

  private async createNestedWorkflowRun(input: {
    parentRunId: string;
    stepId: string;
    inputHash: string;
    spec: WorkflowNestedWorkflowSpec;
  }): Promise<WorkflowRunRecord> {
    assert(
      input.parentRunId.length > 0,
      "WorkflowService.createNestedWorkflowRun: parentRunId required"
    );
    const childRunId = deriveChildWorkflowRunId({
      parentRunId: input.parentRunId,
      stepId: input.stepId,
      inputHash: input.inputHash,
    });
    try {
      return await this.runStore.getRun(childRunId);
    } catch {
      // No existing child run for this replay identity; resolve and snapshot below.
    }

    const resolveScript = this.resolveWorkflowScript;
    assert(resolveScript != null, "Nested workflows are not supported by this workflow service");
    const parentRun = await this.runStore.getRun(input.parentRunId);
    const childDepth = (parentRun.parentWorkflow?.depth ?? -1) + 1;
    assert(
      childDepth < MAX_NESTED_WORKFLOW_DEPTH,
      `Nested workflow depth limit exceeded (${MAX_NESTED_WORKFLOW_DEPTH})`
    );
    const script = await resolveScript(input.spec.scriptPath);
    const normalized = normalizeWorkflowArgsForSource(script.source, input.spec.args);
    return await this.runStore.createRunIfAbsent({
      id: childRunId,
      workspaceId: parentRun.workspaceId,
      workflow: buildWorkflowScriptDescriptor(script),
      source: script.source,
      args: normalized.args,
      parentWorkflow: {
        runId: input.parentRunId,
        stepId: input.stepId,
        inputHash: input.inputHash,
        depth: childDepth,
      },
      now: this.clock?.nowIso() ?? new Date().toISOString(),
    });
  }

  private async createRunner(runId: string): Promise<WorkflowRunner> {
    // The run record always exists by the time a runner is created (create/resume/retry
    // paths persist it first), so resolve the display name for task labeling here.
    const workflowName =
      this.taskAdapterFactory != null
        ? (await this.runStore.getRun(runId)).workflow.name
        : undefined;
    return new WorkflowRunner({
      runStore: this.runStore,
      runtimeFactory: this.runtimeFactory,
      taskAdapter: this.taskAdapterFactory?.(runId, workflowName) ?? this.requireTaskAdapter(),
      nestedWorkflowAdapter: {
        createRun: async (input) => {
          const run = await this.createNestedWorkflowRun(input);
          return { runId: run.id, name: run.workflow.name };
        },
        run: async (childRunId, options) => {
          const childRunner = await this.createRunner(childRunId);
          return await childRunner.run(childRunId, options);
        },
      },
      runnerId: generateWorkflowRunnerOwnerId(this.runnerId, runId),
      ...(this.clock != null ? { clock: this.clock } : {}),
    });
  }

  private async requireRunForWorkspace(input: {
    workspaceId: string;
    runId: string;
  }): Promise<WorkflowRunRecord> {
    assert(input.workspaceId.length > 0, "WorkflowService: workspaceId is required");
    assert(input.runId.length > 0, "WorkflowService: runId is required");
    const run = await this.runStore.getRun(input.runId);
    if (run.workspaceId !== input.workspaceId) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    return run;
  }

  private requireTaskAdapter(): WorkflowTaskAdapter {
    assert(this.taskAdapter != null, "WorkflowService: taskAdapter is required");
    return this.taskAdapter;
  }
}

export function buildWorkflowScriptDescriptor(
  script: ResolvedWorkflowScript
): WorkflowScriptDescriptor {
  return {
    name: getWorkflowScriptDefinitionName(script),
    description:
      parseWorkflowDescription(script.source) ?? `Workflow script ${script.canonicalScriptPath}`,
    // Skill and plugin scripts carry their discovery scope (project/global/built-in);
    // workspace-file and inline scripts are project-trust-gated by definition.
    scope:
      script.sourceKind === "skill" || script.sourceKind === "plugin"
        ? (script.scope ?? "global")
        : "project",
    sourcePath: script.canonicalScriptPath,
    requestedScriptPath: script.requestedScriptPath,
    canonicalScriptPath: script.canonicalScriptPath,
    sourceKind: script.sourceKind,
    sourceHash: script.sourceHash,
    executable: true,
  };
}

function getWorkflowScriptDefinitionName(
  script: ResolvedWorkflowScript
): WorkflowScriptDescriptor["name"] {
  const displayName = parseWorkflowName(script.source);
  const fallbackSource =
    script.sourceKind === "inline"
      ? `inline-${script.sourceHash.slice(0, 12)}`
      : (script.relativePath ?? script.resolvedPath ?? script.canonicalScriptPath);
  const basename = displayName ?? path.basename(fallbackSource, ".js");
  const normalized = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return normalized.length > 0 ? normalized : "workflow";
}

function isWorkflowRunAlreadyActiveError(error: unknown, runId: string): boolean {
  return error instanceof Error && error.message === `Workflow run is already active: ${runId}`;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== "object" || timer == null || !("unref" in timer)) {
    return;
  }
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function isAbortSignalAborted(abortSignal?: AbortSignal): boolean {
  return abortSignal?.aborted === true;
}

function canResumeRunWithCurrentTrust(run: WorkflowRunRecord, projectTrusted: boolean): boolean {
  return run.workflow.scope !== "project" || projectTrusted;
}

function assertRunCanResumeWithCurrentTrust(run: WorkflowRunRecord, projectTrusted: boolean): void {
  if (!canResumeRunWithCurrentTrust(run, projectTrusted)) {
    throw new Error("Project trust is required to resume project-local workflow runs");
  }
}

function assertWorkflowRunCanRetryFromCheckpoint(run: WorkflowRunRecord): void {
  const eligibility = getWorkflowCheckpointRetryEligibility(run);
  if (!eligibility.canRetry) {
    throw new Error(eligibility.reason ?? "Workflow run cannot be retried from checkpoint");
  }
}

function assertWorkflowRunCanTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  if (from === "completed" || from === "failed") {
    throw new Error(`Cannot transition workflow run from ${from} to ${to}`);
  }
}

function generateWorkflowRunnerOwnerId(baseRunnerId: string, runId: string): string {
  assert(baseRunnerId.length > 0, "WorkflowService: base runner id is required");
  assert(runId.length > 0, "WorkflowService: run id is required for runner owner id");
  // Lease ownership must fence individual runner processes, not just the workspace/request that
  // created them, so stale runners cannot renew or release a replacement runner's lease.
  return `${baseRunnerId}:${runId}:${crypto.randomBytes(8).toString("hex")}`;
}

function generateWorkflowRunId(): string {
  return `${WORKFLOW_RUN_TASK_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}
