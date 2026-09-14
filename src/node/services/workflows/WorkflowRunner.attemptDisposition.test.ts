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

async function createStore(sessionDir: string, source = SINGLE_STEP_SOURCE) {
  const store = new WorkflowRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
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

    const retried = await runner.run(RUN_ID, { allowRetryFromFailedCheckpoint: true });
    expect(retried).toEqual({ reportMarkdown: "report from task_fail_2|report from task_ok_1" });
    // Only the failed step reran; the settled sibling was reused.
    expect(createAgentTasks.mock.calls.at(-1)?.[0].map((spec) => spec.id)).toEqual(["fail"]);
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
    const runner = createRunner(store, {
      async runAgent() {
        throw new Error("must reserve through createAgentTasks");
      },
      async createAgentTasks(specs, lifecycle) {
        created.push(...specs.map((spec) => spec.id));
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
        return { kind: "terminal-no-report" };
      },
    });

    await expect(runner.run(RUN_ID, { allowResumeFromInterrupted: true })).resolves.toEqual({
      reportMarkdown: "Final: report from task_replacement",
    });
    expect(settlementWaits).toEqual([
      { taskId: "task_prior", timeoutMs: WORKFLOW_ATTEMPT_SETTLEMENT_TIMEOUT_MS, hasSignal: true },
    ]);
    expect(created).toEqual(["summarize"]);
    const run = await store.getRun(RUN_ID);
    expect(run.steps).toMatchObject([{ taskId: "task_replacement", status: "completed" }]);
    expect(taskEvents(run.events)).toEqual([
      ["task_prior", "failed"],
      ["task_replacement", "started"],
      ["task_replacement", "completed"],
    ]);
  });

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
