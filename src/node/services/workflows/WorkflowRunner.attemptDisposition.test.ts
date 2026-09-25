/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import type { TaskAttemptOutcome, TaskAttemptSettlement } from "@/common/types/tasks";
import type { WorkflowRunEvent } from "@/common/types/workflow";
import { WORKFLOW_ATTEMPT_SETTLEMENT_TIMEOUT_MS } from "@/constants/terminationTimeouts";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  WorkflowRunner,
  isWorkflowRunAlreadyActiveError,
  type WorkflowAgentResult,
  type WorkflowAgentSpec,
  type WorkflowTaskAdapter,
} from "./WorkflowRunner";
import { hashWorkflowStepInput } from "./workflowReplayKey";

const STALE_LEASE_MS = 100;
const RUN_ID = "wfr_disposition";
const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};
const SINGLE_STEP_SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "summarize" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const summarizeSpec: WorkflowAgentSpec = {
  id: "summarize",
  prompt: "Summarize durable workflows",
  markdownOnly: true,
};
const summarizeHash = hashWorkflowStepInput(summarizeSpec.id, summarizeSpec);
const PRIOR_ATTEMPT = "att_00000000000000e5";

/**
 * WorkflowRunner.run() clears its renewal interval before releasing the lease, but a renewal tick
 * that was already in flight keeps retrying the lease mutation lock (jittered backoff) and can
 * re-create `lease.json.xlock` AFTER run() settled. acquireLease deliberately does not wait through
 * that lock, so a back-to-back run() would see a spurious "already active" (lease: null). Polling
 * the lock directory is a TOCTOU (absent at stat time, re-created before mkdir); awaiting the
 * in-flight renewal promises themselves is the deterministic barrier.
 */
class RenewalTrackingRunStore extends WorkflowRunStore {
  private readonly renewals = new Set<Promise<boolean>>();

  override renewLease(runId: string, ownerId: string, nowMs?: number): Promise<boolean> {
    const renewal = super.renewLease(runId, ownerId, nowMs);
    this.renewals.add(renewal);
    const forget = () => this.renewals.delete(renewal);
    renewal.then(forget, forget);
    return renewal;
  }

  /** Call after run() settled: no new ticks can start, only in-flight ones can still hold the lock. */
  async settleLeaseRenewals(): Promise<void> {
    await Promise.allSettled([...this.renewals]);
  }
}

async function createStore(sessionDir: string, source = SINGLE_STEP_SOURCE) {
  const store = new RenewalTrackingRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
  await store.createRun({
    id: RUN_ID,
    workspaceId: "workspace-1",
    workflow: definition,
    source,
    args: {},
    now: "2026-05-29T00:00:00.000Z",
  });
  return store;
}

function createRunner(
  store: WorkflowRunStore,
  taskAdapter: WorkflowTaskAdapter,
  options: { runnerId?: string; reservationTimeoutMs?: number } = {}
) {
  return new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter,
    runnerId: options.runnerId ?? "runner-a",
    clock: { nowIso: () => "2026-05-29T00:00:01.000Z", nowMs: () => Date.now() },
    ...(options.reservationTimeoutMs != null
      ? { reservationTimeoutMs: options.reservationTimeoutMs }
      : {}),
  });
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal == null) return;
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const report = (taskId: string): WorkflowAgentResult => ({
  taskId,
  reportMarkdown: `report from ${taskId}`,
});

/** Seed a checkpointed prior attempt (started record + started task event) for the single step. */
async function seedPriorAttempt(store: WorkflowRunStore, taskId: string) {
  await store.appendStatus(RUN_ID, "running", "2026-05-29T00:00:00.100Z");
  await store.recordStepStarted(RUN_ID, {
    stepId: summarizeSpec.id,
    inputHash: summarizeHash,
    taskId,
    startedAt: "2026-05-29T00:00:00.500Z",
  });
}

function taskEvents(events: readonly WorkflowRunEvent[]) {
  return events
    .filter((event) => event.type === "task")
    .map((event) => (event.type === "task" ? [event.taskId, event.status] : []));
}

function reservationFailures(events: readonly WorkflowRunEvent[]) {
  return events
    .filter((event) => event.type === "agent-step" && event.status === "failed")
    .map((event) => ({
      stepId: event.type === "agent-step" ? event.stepId : "",
      error:
        event.type === "agent-step" &&
        typeof event.details === "object" &&
        event.details != null &&
        typeof (event.details as Record<string, unknown>).error === "string"
          ? String((event.details as Record<string, unknown>).error)
          : "",
    }));
}

function indeterminateDiagnostics(events: readonly WorkflowRunEvent[]) {
  return events.filter(
    (event) =>
      event.type === "agent-step" &&
      event.status === "reserved" &&
      typeof event.details === "object" &&
      event.details != null &&
      (event.details as Record<string, unknown>).disposition === "indeterminate"
  );
}

describe("WorkflowRunner attempt disposition", () => {
  test("a sibling failure aborts a blocked reservation and surfaces the root error", async () => {
    using tmp = new DisposableTempDir("workflow-runner-batch-abort");
    const store = await createStore(
      tmp.path,
      `export default function workflow({ agent, parallel }) {
  return parallel([
    () => agent("Fails", { id: "fail" }),
    () => agent("Blocked", { id: "blocked" }),
    () => agent("Queued", { id: "queued" }),
  ], { maxParallel: 2 });
}
`
    );
    const reservationSignals: Array<AbortSignal | undefined> = [];
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: {
          onTaskCreated?: (index: number, taskId: string) => Promise<void> | void;
          abortSignal?: AbortSignal;
        }
      ) => {
        const spec = specs[0];
        if (spec?.id === "blocked") {
          reservationSignals.push(lifecycle?.abortSignal);
          // Stuck in a cancellable admission stage until the batch abort reaches it.
          await waitForAbort(lifecycle?.abortSignal);
          throw new Error("Workflow agent reservation failed: Interrupted (stage: mutex)");
        }
        for (const [index, created] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${created.id}`);
        }
        return specs.map((created) => ({
          taskId: `task_${created.id}`,
          status: "running" as const,
        }));
      }
    );
    const interruptRun = mock(async () => undefined);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("parallel must reserve through createAgentTasks");
      },
      createAgentTasks,
      async waitForAgentTask(taskId) {
        if (taskId === "task_fail") {
          throw new Error("child execution failed");
        }
        return report(taskId);
      },
      readSettledAgentResult: async () => ({ kind: "terminal-no-report" }),
      interruptRun,
    });

    await expect(runner.run(RUN_ID)).rejects.toThrow("child execution failed");

    expect(reservationSignals).toHaveLength(1);
    expect(reservationSignals[0]?.aborted).toBe(true);
    expect(interruptRun).toHaveBeenCalledTimes(1);
    // The aborted batch never recreated the blocked or the queued child.
    expect(createAgentTasks.mock.calls.map((call) => call[0].map((spec) => spec.id))).toEqual([
      ["fail"],
      ["blocked"],
    ]);
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.steps).toMatchObject([{ stepId: "fail", taskId: "task_fail", status: "failed" }]);
    const failures = reservationFailures(run.events);
    expect(failures.map((failure) => failure.stepId)).toEqual(["blocked"]);
    expect(failures[0]?.error).toContain("canceled");
  });

  test("a sibling that succeeds while another fails is recorded and reused on replay", async () => {
    using tmp = new DisposableTempDir("workflow-runner-batch-sibling-preserved");
    const store = await createStore(
      tmp.path,
      `export default function workflow({ agent, parallel }) {
  const [a, b] = parallel([
    () => agent("Fails", { id: "fail" }),
    () => agent("Succeeds", { id: "ok" }),
  ]);
  return { reportMarkdown: a + "|" + b };
}
`
    );
    const okReport = createDeferred();
    let attempt = 0;
    const createAgentTasks = mock(
      async (
        specs: WorkflowAgentSpec[],
        lifecycle?: { onTaskCreated?: (index: number, taskId: string) => Promise<void> | void }
      ) => {
        attempt += 1;
        for (const [index, spec] of specs.entries()) {
          await lifecycle?.onTaskCreated?.(index, `task_${spec.id}_${attempt}`);
        }
        return specs.map((spec) => ({
          taskId: `task_${spec.id}_${attempt}`,
          status: "running" as const,
        }));
      }
    );
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("parallel must reserve through createAgentTasks");
      },
      createAgentTasks,
      async waitForAgentTask(taskId) {
        if (taskId.startsWith("task_fail_1")) {
          throw new Error("child execution failed");
        }
        // The sibling's report lands while the batch is already failing.
        await okReport.promise;
        return report(taskId);
      },
      readSettledAgentResult: async () => ({ kind: "terminal-no-report" }),
      async interruptRun() {
        okReport.resolve();
      },
    });

    await expect(runner.run(RUN_ID)).rejects.toThrow("child execution failed");
    const failedRun = await store.getRun(RUN_ID);
    expect(failedRun.steps).toMatchObject([
      { stepId: "fail", taskId: "task_fail_1", status: "failed" },
      { stepId: "ok", taskId: "task_ok_1", status: "completed" },
    ]);

    await store.settleLeaseRenewals();
    const retried = await runner.run(RUN_ID, { allowRetryFromFailedCheckpoint: true });
    expect(retried).toEqual({ reportMarkdown: "report from task_fail_2|report from task_ok_1" });
    // Only the failed step reran; the settled sibling was reused.
    expect(createAgentTasks.mock.calls.at(-1)?.[0].map((spec) => spec.id)).toEqual(["fail"]);
  });

  test("pipeline fail-fast disposes live siblings concurrently, keeping their reports and the original error", async () => {
    for (const failureMode of ["wait-rejects", "validation-fails"] as const) {
      using tmp = new DisposableTempDir(`workflow-runner-pipeline-sibling-drain-${failureMode}`);
      const store = await createStore(
        tmp.path,
        `export default function workflow({ agent, pipeline }) {
  const schema = { type: "object", properties: { label: { type: "string" } }, required: ["label"] };
  return pipeline(["first", "reported", "silent"], (item) => agent("Stage " + item, { id: item, schema }));
}
`
      );
      const stopRequested = createDeferred();
      const interruptRun = mock(async () => {
        stopRequested.resolve();
      });
      // Each sibling's bounded settlement wait must be ENTERED before any of them is released:
      // a serial drain can never get here because its first wait would hold the second back.
      const SIBLINGS = ["task_reported", "task_silent"];
      const settlementEntered = new Set<string>();
      const settlementReleased = createDeferred();
      let barrierReached = false;
      let releasedBeforeBarrier = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const enterSettlementWait = (taskId: string): Promise<void> => {
        settlementEntered.add(taskId);
        if (SIBLINGS.every((sibling) => settlementEntered.has(sibling))) {
          // Counts only if no wait was released before every sibling had entered.
          barrierReached = !releasedBeforeBarrier;
          if (fallbackTimer != null) clearTimeout(fallbackTimer);
          settlementReleased.resolve();
        } else {
          // Only a serialized drain ever fires this: it keeps the red run from hanging for the
          // full settlement bound and is cleared once both siblings have entered.
          fallbackTimer ??= setTimeout(() => {
            releasedBeforeBarrier = true;
            settlementReleased.resolve();
          }, 250);
        }
        return settlementReleased.promise;
      };
      const runner = createRunner(store, {
        async runAgent() {
          throw new Error("pipeline must reserve through createAgentTasks");
        },
        async createAgentTasks(specs, lifecycle) {
          for (const [index, spec] of specs.entries()) {
            await lifecycle?.onTaskCreated?.(index, `task_${spec.id}`);
          }
          return specs.map((spec) => ({ taskId: `task_${spec.id}`, status: "running" as const }));
        },
        async waitForAgentTask(taskId) {
          if (taskId === "task_first") {
            if (failureMode === "wait-rejects") {
              throw new Error("first child failed");
            }
            // Schema demands a label; this validation failure must fail fast like a rejection.
            return { taskId, reportMarkdown: "first", structuredOutput: {} };
          }
          // Siblings are still live when fail-fast fires; they settle only after the stop.
          await stopRequested.promise;
          throw new Error("Task interrupted");
        },
        readSettledAgentResult: async (taskId): Promise<TaskAttemptOutcome<WorkflowAgentResult>> =>
          taskId === "task_first" ? { kind: "terminal-no-report" } : { kind: "cleanup-pending" },
        async waitForAttemptSettlement(taskId) {
          await enterSettlementWait(taskId);
          if (!barrierReached) {
            return { kind: "timeout" };
          }
          // A report that landed during the stop is retained; a silent child is settled failed.
          return taskId === "task_reported"
            ? { kind: "reported", report: { ...report(taskId), structuredOutput: { label: "r" } } }
            : { kind: "terminal-no-report" };
        },
        interruptRun,
      });

      await expect(runner.run(RUN_ID)).rejects.toThrow(
        failureMode === "wait-rejects"
          ? "first child failed"
          : /structured output failed schema validation/
      );
      expect(barrierReached).toBe(true);
      expect(interruptRun).toHaveBeenCalledTimes(1);
      const run = await store.getRun(RUN_ID);
      expect(run.status).toBe("failed");
      expect(
        run.steps.map((step) => [step.stepId, step.status]).sort((a, b) => a[0].localeCompare(b[0]))
      ).toEqual([
        ["first", "failed"],
        ["reported", "completed"],
        ["silent", "failed"],
      ]);
      expect(
        run.steps.find((step) => step.stepId === "reported")?.result?.structuredOutput
      ).toEqual({ label: "r" });
      // Every settled sibling is disposed and the lease is free for a checkpoint retry.
      await store.settleLeaseRenewals();
      await expect(store.acquireLease(RUN_ID, "runner-next", Date.now())).resolves.toBe(true);
    }
  });

  test("adopts a report persisted before the waiter aborted instead of failing the attempt", async () => {
    using tmp = new DisposableTempDir("workflow-runner-adopt-before-abort");
    const store = await createStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_1");
        return [{ taskId: "task_1", status: "running" }];
      },
      async waitForAgentTask() {
        // The wait observed the child's interruption after the report was already persisted.
        throw new Error("Task interrupted");
      },
      readSettledAgentResult: async (taskId) => ({ kind: "reported", report: report(taskId) }),
    });

    await expect(runner.run(RUN_ID)).resolves.toEqual({
      reportMarkdown: "Final: report from task_1",
    });
    const run = await store.getRun(RUN_ID);
    expect(run.steps).toMatchObject([{ taskId: "task_1", status: "completed" }]);
    expect(taskEvents(run.events)).toEqual([
      ["task_1", "started"],
      ["task_1", "interrupted"],
      ["task_1", "completed"],
    ]);
  });

  test("explicit resume under a new lease reuses the prior attempt's report without a duplicate child", async () => {
    using tmp = new DisposableTempDir("workflow-runner-resume-adopts-report");
    const store = await createStore(tmp.path);
    await seedPriorAttempt(store, "task_prior");
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
    const createAgentTasks = mock(async () => {
      throw new Error("no replacement child may be created");
    });
    const waitForAgentTask = mock(async () => {
      throw new Error("a reported attempt is not awaited");
    });
    const runner = createRunner(
      store,
      {
        async runAgent() {
          throw new Error("no replacement child may be created");
        },
        createAgentTasks,
        waitForAgentTask,
        readSettledAgentResult: async (taskId) => ({ kind: "reported", report: report(taskId) }),
      },
      { runnerId: "runner-b" }
    );

    await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: report from task_prior",
    });
    expect(createAgentTasks).not.toHaveBeenCalled();
    expect(waitForAgentTask).not.toHaveBeenCalled();
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("completed");
    expect(run.steps).toMatchObject([{ taskId: "task_prior", status: "completed" }]);
  });

  test("resume reattaches to a live prior attempt and never replaces current preparation", async () => {
    using tmp = new DisposableTempDir("workflow-runner-resume-live");
    const store = await createStore(tmp.path);
    await seedPriorAttempt(store, "task_prior");
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
    const createAgentTasks = mock(async () => {
      throw new Error("a live attempt must not be replaced");
    });
    const waitedFor: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("a live attempt must not be replaced");
      },
      createAgentTasks,
      async waitForAgentTask(taskId) {
        waitedFor.push(taskId);
        return report(taskId);
      },
      // Layer 2 persists `interrupted` before a current-generation preparation finishes; that
      // status alone is never treated as termination.
      readSettledAgentResult: async () => ({ kind: "live", executionId: "exec_prior" }),
    });

    await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: report from task_prior",
    });
    expect(waitedFor).toEqual(["task_prior"]);
    expect(createAgentTasks).not.toHaveBeenCalled();
  });

  test("resume waits (bounded) for pending cleanup, then replaces exactly once when no report exists", async () => {
    using tmp = new DisposableTempDir("workflow-runner-resume-cleanup-settles");
    const store = await createStore(tmp.path);
    await seedPriorAttempt(store, "task_prior");
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
    const settlementWaits: Array<{ taskId: string; timeoutMs: number; hasSignal: boolean }> = [];
    const created: string[] = [];
    const order: string[] = [];
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(specs, lifecycle) {
        created.push(...specs.map((spec) => spec.id));
        order.push(`reserve retires ${JSON.stringify(lifecycle?.retires)}`);
        await lifecycle?.onTaskCreated?.(0, "task_replacement");
        return [{ taskId: "task_replacement", status: "running" }];
      },
      async waitForAgentTask(taskId) {
        return report(taskId);
      },
      readSettledAgentResult: async () => ({ kind: "cleanup-pending" }),
      async waitForAttemptSettlement(taskId, options) {
        settlementWaits.push({
          taskId,
          timeoutMs: options.timeoutMs,
          hasSignal: options.abortSignal != null,
        });
        return { kind: "terminal-no-report", attemptId: PRIOR_ATTEMPT };
      },
      async claimRetiredAttempt(taskId, attemptId, claimant) {
        order.push(`claim ${taskId} ${attemptId} ${claimant.stepId}`);
        return { success: true, nonce: "nonce-1" };
      },
    });

    await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: report from task_replacement",
    });
    expect(settlementWaits).toEqual([
      { taskId: "task_prior", timeoutMs: WORKFLOW_ATTEMPT_SETTLEMENT_TIMEOUT_MS, hasSignal: true },
    ]);
    expect(created).toEqual(["summarize"]);
    // The ended attempt is retired first; the replacement's reservation consumes that claim.
    expect(order).toEqual([
      `claim task_prior ${PRIOR_ATTEMPT} summarize`,
      `reserve retires ${JSON.stringify([{ taskId: "task_prior", attemptId: PRIOR_ATTEMPT, nonce: "nonce-1" }])}`,
    ]);
    const run = await store.getRun(RUN_ID);
    expect(run.steps).toMatchObject([{ taskId: "task_replacement", status: "completed" }]);
    expect(taskEvents(run.events)).toEqual([
      ["task_prior", "failed"],
      ["task_replacement", "started"],
      ["task_replacement", "completed"],
    ]);
  });

  test.each([
    ["the claim is refused", PRIOR_ATTEMPT, true],
    ["the ended attempt has no identity (pre-identity)", undefined, true],
    ["the task adapter cannot claim", PRIOR_ATTEMPT, false],
  ] as const)(
    "a no-report prior attempt is never replaced when %s: the run stays interrupted and nothing is reserved",
    async (_label, attemptId, canClaim) => {
      using tmp = new DisposableTempDir("workflow-runner-claim-refused");
      const store = await createStore(tmp.path);
      await seedPriorAttempt(store, "task_prior");
      await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
      const createAgentTasks = mock(async () => {
        throw new Error("an unclaimed prior attempt must not be replaced");
      });
      const runner = createRunner(store, {
        async runAgent() {
          throw new Error("an unclaimed prior attempt must not be replaced");
        },
        createAgentTasks,
        async waitForAgentTask() {
          throw new Error("a settled attempt is not awaited");
        },
        readSettledAgentResult: async () =>
          attemptId != null
            ? { kind: "terminal-no-report", attemptId }
            : { kind: "terminal-no-report" },
        ...(canClaim
          ? {
              claimRetiredAttempt: async () => ({
                success: false as const,
                error: "claim lost: the task now names attempt att_00000000000000ff",
              }),
            }
          : {}),
      });

      await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).rejects.toThrow(
        /previous attempt task_prior is unresolved/
      );
      expect(createAgentTasks).not.toHaveBeenCalled();
      expect((await store.getRun(RUN_ID)).status).toBe("interrupted");
    }
  );

  test("resume on unresolved cleanup releases the lease, keeps the run interrupted, and starts nothing", async () => {
    using tmp = new DisposableTempDir("workflow-runner-resume-cleanup-timeout");
    const store = await createStore(tmp.path);
    await seedPriorAttempt(store, "task_prior");
    await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
    const createAgentTasks = mock(async () => {
      throw new Error("unresolved cleanup must not be replaced");
    });
    const interruptRun = mock(async () => undefined);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("unresolved cleanup must not be replaced");
      },
      createAgentTasks,
      async waitForAgentTask() {
        throw new Error("unresolved cleanup is not awaited");
      },
      readSettledAgentResult: async () => ({ kind: "cleanup-pending" }),
      waitForAttemptSettlement: async (): Promise<TaskAttemptSettlement<WorkflowAgentResult>> => ({
        kind: "timeout",
      }),
      interruptRun,
    });

    await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).rejects.toThrow(
      /cleanup is still in progress/
    );
    expect(createAgentTasks).not.toHaveBeenCalled();
    expect(interruptRun).toHaveBeenCalledTimes(1);
    const run = await store.getRun(RUN_ID);
    // Retryable: the run is interrupted again (not failed) and the checkpoint is intact.
    expect(run.status).toBe("interrupted");
    expect(run.steps).toMatchObject([{ taskId: "task_prior", status: "started" }]);
    const errorEvent = run.events.at(-2);
    expect(errorEvent?.type).toBe("error");
    expect(errorEvent?.type === "error" ? errorEvent.message : "").toContain(
      "cleanup is still in progress"
    );
    // The lease was released: a fresh runner can take the run immediately.
    await expect(store.acquireLease(RUN_ID, "runner-next", Date.now())).resolves.toBe(true);
  });

  test("indeterminate prior attempts (missing capability or read failure) get a diagnostic, no wait, no replacement", async () => {
    for (const variant of ["missing-capability", "read-failure"] as const) {
      using tmp = new DisposableTempDir(`workflow-runner-resume-indeterminate-${variant}`);
      const store = await createStore(tmp.path);
      await seedPriorAttempt(store, "task_legacy");
      await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:00.750Z");
      const createAgentTasks = mock(async () => {
        throw new Error("indeterminate attempts must not be replaced");
      });
      const waitForAttemptSettlement = mock(
        async (): Promise<TaskAttemptSettlement<WorkflowAgentResult>> => ({ kind: "timeout" })
      );
      const adapter: WorkflowTaskAdapter = {
        async runAgent() {
          throw new Error("indeterminate attempts must not be replaced");
        },
        createAgentTasks,
        async waitForAgentTask() {
          throw new Error("indeterminate attempts are not awaited");
        },
        waitForAttemptSettlement,
        ...(variant === "read-failure"
          ? {
              readSettledAgentResult: async (): Promise<
                TaskAttemptOutcome<WorkflowAgentResult>
              > => {
                throw new Error("settlement records unreadable");
              },
            }
          : {}),
      };
      const runner = createRunner(store, adapter);

      await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).rejects.toThrow(
        /is unresolved/
      );
      expect(createAgentTasks).not.toHaveBeenCalled();
      expect(waitForAttemptSettlement).not.toHaveBeenCalled();
      const run = await store.getRun(RUN_ID);
      expect(run.status).toBe("interrupted");
      expect(run.steps).toMatchObject([{ taskId: "task_legacy", status: "started" }]);
      const diagnostics = indeterminateDiagnostics(run.events);
      expect(diagnostics).toMatchObject([
        { stepId: "summarize", details: { disposition: "indeterminate", taskId: "task_legacy" } },
      ]);
      const reason = (
        diagnostics[0]?.type === "agent-step" &&
        typeof diagnostics[0].details === "object" &&
        diagnostics[0].details != null
          ? (diagnostics[0].details as Record<string, unknown>).reason
          : undefined
      ) as string | undefined;
      expect(reason).toContain(
        variant === "read-failure" ? "unreadable" : "cannot read attempt outcomes"
      );
    }
  });

  test("a run abort never recreates a child on the exact restart sentinel", async () => {
    using tmp = new DisposableTempDir("workflow-runner-abort-no-restart");
    const store = await createStore(tmp.path);
    await seedPriorAttempt(store, "task_prior");
    const abortController = new AbortController();
    const createAgentTasks = mock(async () => {
      throw new Error("an aborted run must not recreate the child");
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("an aborted run must not recreate the child");
      },
      createAgentTasks,
      async waitForAgentTask() {
        abortController.abort();
        throw new Error("Task interrupted");
      },
      readSettledAgentResult: async () => ({ kind: "live", executionId: "exec_prior" }),
    });

    await expect(runner.run(RUN_ID, { abortSignal: abortController.signal })).rejects.toThrow();
    expect(createAgentTasks).not.toHaveBeenCalled();
    expect((await store.getRun(RUN_ID)).steps).toMatchObject([
      { taskId: "task_prior", status: "started" },
    ]);
  });

  test("a reservation completing after the abort is stopped again and disposed", async () => {
    using tmp = new DisposableTempDir("workflow-runner-late-reservation");
    const store = await createStore(tmp.path);
    const abortController = new AbortController();
    const interruptRun = mock(async () => undefined);
    const waitForAgentTask = mock(async () => {
      throw new Error("a late reservation is never awaited");
    });
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(_specs, lifecycle) {
        // The checkpoint landed before the Stop; admission then completed past its fence, so
        // the child exists despite the abort and the reservation returns late.
        await lifecycle?.onTaskCreated?.(0, "task_late");
        abortController.abort();
        await waitForAbort(lifecycle?.abortSignal);
        return [{ taskId: "task_late", status: "running" }];
      },
      waitForAgentTask,
      readSettledAgentResult: async () => ({ kind: "terminal-no-report" }),
      interruptRun,
    });

    await expect(runner.run(RUN_ID, { abortSignal: abortController.signal })).rejects.toThrow();
    expect(interruptRun).toHaveBeenCalledTimes(1);
    expect(waitForAgentTask).not.toHaveBeenCalled();
    expect((await store.getRun(RUN_ID)).steps).toMatchObject([
      { taskId: "task_late", status: "failed" },
    ]);
  });

  test("a Stop after the reservation returned still reaches a child whose launch is pending", async () => {
    using tmp = new DisposableTempDir("workflow-runner-pending-launch-abort");
    const store = await createStore(tmp.path);
    const abortController = new AbortController();
    let reservationSignal: AbortSignal | undefined;
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(_specs, lifecycle) {
        reservationSignal = lifecycle?.abortSignal;
        await lifecycle?.onTaskCreated?.(0, "task_queued");
        // createMany returns before the queued child launches; the task service re-checks the
        // reservation signal at launch admission, so it must stay linked to the run.
        return [{ taskId: "task_queued", status: "queued" }];
      },
      async waitForAgentTask(_taskId, _spec, waitOptions) {
        expect(reservationSignal?.aborted).toBe(false);
        abortController.abort();
        await waitForAbort(waitOptions?.abortSignal);
        throw new Error("Task interrupted");
      },
      readSettledAgentResult: async () => ({ kind: "cleanup-pending" }),
    });

    await expect(runner.run(RUN_ID, { abortSignal: abortController.signal })).rejects.toThrow();
    expect(reservationSignal?.aborted).toBe(true);
    expect((await store.getRun(RUN_ID)).steps).toMatchObject([
      { taskId: "task_queued", status: "started" },
    ]);
  });

  test("a stalled reservation fails with a distinct timeout error and a breadcrumb", async () => {
    using tmp = new DisposableTempDir("workflow-runner-reservation-timeout");
    const store = await createStore(tmp.path);
    const runner = createRunner(
      store,
      {
        async runAgent() {
          throw new Error("must reserve through createAgentTasks");
        },
        async createAgentTasks(_specs, lifecycle) {
          await waitForAbort(lifecycle?.abortSignal);
          throw new Error("Workflow agent reservation failed: Interrupted (stage: tree-lock)");
        },
        async waitForAgentTask() {
          throw new Error("nothing was reserved");
        },
      },
      { reservationTimeoutMs: 20 }
    );

    await expect(runner.run(RUN_ID)).rejects.toThrow(/reservation for summarize exceeded 20ms/);
    const run = await store.getRun(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.steps).toEqual([]);
    const failures = reservationFailures(run.events);
    expect(failures.map((failure) => failure.stepId)).toEqual(["summarize"]);
    expect(failures[0]?.error).toContain("exceeded 20ms");
  });

  test("a reservation that fails after its checkpoint is disposed by the authoritative outcome", async () => {
    using tmp = new DisposableTempDir("workflow-runner-reservation-failed-after-checkpoint");
    const store = await createStore(tmp.path);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(_specs, lifecycle) {
        await lifecycle?.onTaskCreated?.(0, "task_checkpointed");
        throw new Error("Workflow agent reservation failed: config commit failed");
      },
      async waitForAgentTask() {
        throw new Error("a failed reservation is never awaited");
      },
      // The task service owns the no-launch evidence for a failed commit.
      readSettledAgentResult: async () => ({ kind: "terminal-no-report" }),
    });

    await expect(runner.run(RUN_ID)).rejects.toThrow(/config commit failed/);
    const run = await store.getRun(RUN_ID);
    expect(run.steps).toMatchObject([{ taskId: "task_checkpointed", status: "failed" }]);
    expect(taskEvents(run.events)).toEqual([
      ["task_checkpointed", "started"],
      ["task_checkpointed", "failed"],
    ]);
    // The breadcrumb is for reservations that never produced a task id; this one has a record.
    expect(
      run.events.some((event) => event.type === "agent-step" && event.status === "failed")
    ).toBe(false);
  });

  test("the Stop drain settles already-settled attempts under the cancellation capability without waiting", async () => {
    for (const outcome of ["reported", "terminal-no-report", "cleanup-pending"] as const) {
      using tmp = new DisposableTempDir(`workflow-runner-stop-drain-${outcome}`);
      const store = await createStore(tmp.path);
      const abortController = new AbortController();
      const waitForAttemptSettlement = mock(
        async (): Promise<TaskAttemptSettlement<WorkflowAgentResult>> => ({ kind: "timeout" })
      );
      const runner = createRunner(store, {
        async runAgent() {
          throw new Error("must reserve through createAgentTasks");
        },
        async createAgentTasks(_specs, lifecycle) {
          await lifecycle?.onTaskCreated?.(0, "task_1");
          return [{ taskId: "task_1", status: "running" }];
        },
        async waitForAgentTask(_taskId, _spec, waitOptions) {
          // Mirror WorkflowService.interruptRun: abort the runner, persist `interrupted`, and
          // only then let the wait observe the cancellation.
          abortController.abort();
          await store.appendStatus(RUN_ID, "interrupted", "2026-05-29T00:00:02.000Z");
          await waitForAbort(waitOptions?.abortSignal);
          throw new Error("Task interrupted");
        },
        readSettledAgentResult: async (taskId): Promise<TaskAttemptOutcome<WorkflowAgentResult>> =>
          outcome === "reported" ? { kind: "reported", report: report(taskId) } : { kind: outcome },
        waitForAttemptSettlement,
      });

      await expect(runner.run(RUN_ID, { abortSignal: abortController.signal })).rejects.toThrow();
      expect(waitForAttemptSettlement).not.toHaveBeenCalled();
      const run = await store.getRun(RUN_ID);
      expect(run.status).toBe("interrupted");
      expect(run.steps).toMatchObject([
        {
          taskId: "task_1",
          status:
            outcome === "reported"
              ? "completed"
              : outcome === "terminal-no-report"
                ? "failed"
                : "started",
        },
      ]);
      // The lease is released after the drain so an explicit resume is accepted.
      await store.settleLeaseRenewals();
      await expect(store.acquireLease(RUN_ID, "runner-next", Date.now())).resolves.toBe(true);
    }
  });

  test("already-active errors name the lease owner and its freshness", async () => {
    using tmp = new DisposableTempDir("workflow-runner-already-active");
    const store = await createStore(tmp.path);
    await expect(store.acquireLease(RUN_ID, "runner-holder", Date.now())).resolves.toBe(true);
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("no lease, no work");
      },
    });

    let caught: unknown;
    try {
      await runner.run(RUN_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(
      /^Workflow run is already active: wfr_disposition \(lease owner runner-holder, renewed \d+s ago\)$/
    );
    expect(isWorkflowRunAlreadyActiveError(caught, RUN_ID)).toBe(true);
    expect(isWorkflowRunAlreadyActiveError(caught, "wfr_other")).toBe(false);
    expect(
      isWorkflowRunAlreadyActiveError(
        new Error(`Workflow run is already active: ${RUN_ID}`),
        RUN_ID
      )
    ).toBe(true);
    await store.releaseLease(RUN_ID, "runner-holder");
  });
});
