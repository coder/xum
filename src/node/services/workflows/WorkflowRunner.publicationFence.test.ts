/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/require-await */
/**
 * coder/xum #4452 gap 2: a step's child must be published at most once, even when runner A's
 * lease lapses between its fenced checkpoint and its (unfenced) publishing config commit.
 *
 * Harness: two real WorkflowRunners (production-shaped unique owner IDs), two real
 * WorkflowRunStores on one session dir, and two real WorkflowTaskServiceAdapters. Each adapter
 * wraps a per-backend task-service stub whose `createMany` keeps the real TaskService ordering
 * (taskService.ts createMany `commit`): call `onTaskReserved` for every child (the runner's
 * lease-fenced checkpoint), abandon the reservation if a callback throws, otherwise run the
 * UNFENCED config commit that publishes the child. The stub can hold between the callbacks and
 * the commit, which is the window the issue describes. Backend B's `readAttemptOutcome` is the
 * REAL TaskService (a fresh instance on the shared config that owns no attempts, i.e. another
 * process) unless a test says otherwise.
 *
 * Where a test stalls runner A's lease renewals, A is a stalled holder; B runs on a clock 60 s
 * ahead so A's lease reads as stale to B without real waits.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TaskAttemptOutcome } from "@/common/types/tasks";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import type { Config } from "@/node/config";
import { SecretsStore } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { TaskService } from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createWorkspaceServiceMocks,
} from "@/node/services/taskService.testHarness";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  isWorkflowRunAlreadyActiveError,
  WorkflowPriorAttemptUnresolvedError,
  WorkflowRunner,
} from "./WorkflowRunner";
import {
  WorkflowTaskServiceAdapter,
  type WorkflowTaskServiceAdapterOptions,
} from "./WorkflowTaskServiceAdapter";

type TaskServiceLike = WorkflowTaskServiceAdapterOptions["taskService"];
type WorkflowTaskReport = Awaited<ReturnType<TaskServiceLike["waitForAgentReport"]>>;

const RUN_ID = "wfr_4452_gap2";
const PARENT_ID = "parent-4452";
const STALE_LEASE_MS = 100;
const STEP_ID = "summarize";
// Production-shaped unique owner IDs (WorkflowService.generateWorkflowRunnerOwnerId shape).
const OWNER_A = `workflow-runner:${PARENT_ID}:${RUN_ID}:aaaaaaaaaaaaaaaa`;
const OWNER_B = `workflow-runner:${PARENT_ID}:${RUN_ID}:bbbbbbbbbbbbbbbb`;
const SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "${STEP_ID}" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function settle(promise: Promise<unknown>) {
  try {
    return { kind: "resolved" as const, value: await promise };
  } catch (error) {
    return { kind: "rejected" as const, error };
  }
}

/** Store whose lease renewals can be stalled: the holder is alive but cannot renew. */
class StallableRenewalStore extends WorkflowRunStore {
  private renewalStall: Promise<void> | null = null;
  private readonly releaseStall = createDeferred();

  stallRenewals(): void {
    this.renewalStall = this.releaseStall.promise;
  }

  unstallRenewals(): void {
    this.releaseStall.resolve();
  }

  override async renewLease(runId: string, ownerId: string, nowMs?: number): Promise<boolean> {
    if (this.renewalStall != null) {
      await this.renewalStall;
      // The stalled renewal comes back after the takeover; never touch disk after teardown.
      return false;
    }
    return await super.renewLease(runId, ownerId, nowMs);
  }
}

/**
 * One-shot pause on the store's next `getRunUnlocked`, which in appendStepRecord runs after
 * withWorkflowMutationLock + withExpectedLeaseOwner took their locks and checked the owner.
 */
function pauseNextOwnerCheckedWrite(store: WorkflowRunStore) {
  const entered = createDeferred();
  const release = createDeferred();
  // Private seam, reached the same way other store/service tests reach internals.
  const internals = store as unknown as {
    getRunUnlocked: (runId: string) => Promise<WorkflowRunRecord>;
  };
  const original = internals.getRunUnlocked.bind(store);
  internals.getRunUnlocked = async (runId: string): Promise<WorkflowRunRecord> => {
    internals.getRunUnlocked = original;
    entered.resolve();
    await release.promise;
    return await original(runId);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

interface Backend {
  readonly createManyCalls: number;
  /** Resolves once this backend's reservation callbacks (the runner checkpoint) returned. */
  readonly checkpointed: Promise<void>;
  /** Resolves once this backend's config commit published its children. */
  readonly published: Promise<void>;
  releaseCommit(): void;
  releaseReports(): void;
}

/**
 * Per-backend task-service stub. `published` is shared across backends: it is the config's set
 * of published child tasks (both backends share one Xum root).
 */
function createBackendTaskService(options: {
  name: "a" | "b";
  published: string[];
  holdCommit: boolean;
  /** Called right before the reservation callbacks run (used to arm a pause). */
  beforeReservationCallbacks?: () => void;
  readAttemptOutcome?: TaskServiceLike["readAttemptOutcome"];
}): { taskService: TaskServiceLike; backend: Backend } {
  let createManyCalls = 0;
  const checkpointed = createDeferred();
  const published = createDeferred();
  const commitGate = createDeferred();
  const reportGate = createDeferred();
  if (!options.holdCommit) {
    commitGate.resolve();
  }
  const taskService: TaskServiceLike = {
    async create() {
      throw new Error("the runner must reserve through createMany");
    },
    async createMany(args, createOptions) {
      createManyCalls += 1;
      const results = args.map((_, index) => ({
        taskId: `task_${options.name}_${createManyCalls}_${index}`,
        kind: "agent" as const,
        status: "running" as const,
      }));
      options.beforeReservationCallbacks?.();
      try {
        for (const [index, result] of results.entries()) {
          await createOptions?.onTaskReserved?.(index, result);
        }
      } catch (error) {
        // Real createMany: settleFailedReservations, nothing is committed.
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      checkpointed.resolve();
      // The stall window: checkpoint durable, config commit (publication) not yet written.
      await commitGate.promise;
      // commitReservations: publishes without checking the workflow run lease.
      options.published.push(...results.map((result) => result.taskId));
      published.resolve();
      return { success: true, data: results };
    },
    async waitForAgentReport(taskId): Promise<WorkflowTaskReport> {
      await reportGate.promise;
      return { reportMarkdown: `report from ${taskId}` };
    },
    ...(options.readAttemptOutcome != null
      ? { readAttemptOutcome: options.readAttemptOutcome }
      : {}),
  };
  return {
    taskService,
    backend: {
      get createManyCalls() {
        return createManyCalls;
      },
      checkpointed: checkpointed.promise,
      published: published.promise,
      releaseCommit: () => commitGate.resolve(),
      releaseReports: () => reportGate.resolve(),
    },
  };
}

function createRunner(options: {
  store: WorkflowRunStore;
  taskService: TaskServiceLike;
  ownerId: string;
  clockOffsetMs?: number;
}) {
  const clockOffsetMs = options.clockOffsetMs ?? 0;
  return new WorkflowRunner({
    runStore: options.store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: new WorkflowTaskServiceAdapter({
      taskService: options.taskService,
      parentWorkspaceId: PARENT_ID,
      workflowRunId: RUN_ID,
      defaultAgentId: "exec",
    }),
    runnerId: options.ownerId,
    clock: {
      nowIso: () => new Date(Date.now() + clockOffsetMs).toISOString(),
      nowMs: () => Date.now() + clockOffsetMs,
    },
  });
}

/** A second backend's TaskService on the shared config: it owns no attempt of backend A. */
function createOtherProcessTaskService(
  config: Config,
  historyService: Awaited<ReturnType<typeof createTestHistoryService>>["historyService"]
) {
  const aiService = createAIServiceMocks(config).aiService;
  const workspaceService = createWorkspaceServiceMocks().workspaceService;
  const initStateManager = createMockInitStateManager();
  const terminalAttentionStore = new TerminalAttentionStore(config);
  const taskService = new TaskService(
    config,
    historyService,
    aiService,
    workspaceService,
    initStateManager,
    undefined,
    undefined,
    new SecretsStore(config.rootDir),
    terminalAttentionStore
  );
  taskService.setWorkspaceTurnManager(
    new WorkspaceTurnManager(
      config,
      historyService,
      aiService,
      workspaceService,
      initStateManager,
      taskService,
      terminalAttentionStore,
      aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
    )
  );
  return taskService;
}

function startedTaskIdForStep(run: WorkflowRunRecord): string | undefined {
  return run.steps.find((step) => step.stepId === STEP_ID)?.taskId;
}

describe("WorkflowRunner child publication after a lease takeover (#4452 gap 2)", () => {
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let sessionDir: string;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    sessionDir = path.join(fixture.config.sessionsDir, PARENT_ID);
    await fs.mkdir(sessionDir, { recursive: true });
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  async function createStores() {
    const storeA = new StallableRenewalStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
    const storeB = new WorkflowRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
    await storeA.createRun({
      id: RUN_ID,
      workspaceId: PARENT_ID,
      workflow: definition,
      source: SOURCE,
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    return { storeA, storeB };
  }

  test("control: without a takeover exactly one child is published and the journal names it", async () => {
    const { storeA } = await createStores();
    const published: string[] = [];
    const a = createBackendTaskService({ name: "a", published, holdCommit: false });
    a.backend.releaseReports();
    const runnerA = createRunner({ store: storeA, taskService: a.taskService, ownerId: OWNER_A });

    await expect(runnerA.run(RUN_ID)).resolves.toEqual({
      reportMarkdown: "Final: report from task_a_1_0",
    });
    const run = await storeA.getRun(RUN_ID);
    expect(published).toEqual(["task_a_1_0"]);
    expect(startedTaskIdForStep(run)).toBe("task_a_1_0");
  });

  test("gap 2 is not reachable directly: another backend's recovery refuses to replace A's checkpointed, unpublished child", async () => {
    const { storeA, storeB } = await createStores();
    const published: string[] = [];
    const otherProcessTaskService = createOtherProcessTaskService(
      fixture.config,
      fixture.historyService
    );
    const a = createBackendTaskService({ name: "a", published, holdCommit: true });
    const b = createBackendTaskService({
      name: "b",
      published,
      holdCommit: false,
      readAttemptOutcome: (taskId, readOptions) =>
        otherProcessTaskService.readAttemptOutcome(taskId, readOptions),
    });
    a.backend.releaseReports();
    b.backend.releaseReports();
    storeA.stallRenewals();
    const runnerA = createRunner({ store: storeA, taskService: a.taskService, ownerId: OWNER_A });
    const runnerB = createRunner({
      store: storeB,
      taskService: b.taskService,
      ownerId: OWNER_B,
      clockOffsetMs: 60_000,
    });

    const runA = settle(runnerA.run(RUN_ID));
    await a.backend.checkpointed;
    expect(startedTaskIdForStep(await storeB.getRun(RUN_ID))).toBe("task_a_1_0");

    // A stalls between its fenced checkpoint and its config commit; B takes over the run.
    const runB = await settle(runnerB.run(RUN_ID));
    a.backend.releaseCommit();
    await a.backend.published;
    // run() awaits an in-flight renewal before releasing: let the stalled one return (false).
    storeA.unstallRenewals();
    await runA;

    // What B's real cross-process classification returned for A's unpublished child.
    const bClassification: TaskAttemptOutcome<WorkflowTaskReport> =
      await otherProcessTaskService.readAttemptOutcome("task_a_1_0", {
        requestingWorkspaceId: PARENT_ID,
      });
    expect(bClassification).toEqual({
      kind: "indeterminate",
      reason: "no task record and no attempt owned by this process",
    });
    expect(runB.kind).toBe("rejected");
    expect(runB.kind === "rejected" && runB.error).toBeInstanceOf(
      WorkflowPriorAttemptUnresolvedError
    );
    expect(b.backend.createManyCalls).toBe(0);
    // SAFE outcome holds on this path: one published child, and the journal names it.
    const run = await storeB.getRun(RUN_ID);
    expect({ published, journal: startedTaskIdForStep(run) }).toEqual({
      published: ["task_a_1_0"],
      journal: "task_a_1_0",
    });
  });

  // Expected to fail until G2's single-use publication check (or a lease-owner check inside the
  // publishing config commit) lands: nothing fences the commit today. Latent on main because the
  // cross-process classification above refuses to replace the unpublished child.
  test.failing(
    "latent gap 2: if B's recovery may replace the unpublished child, A's unfenced commit publishes a second child",
    async () => {
      const { storeA, storeB } = await createStores();
      const published: string[] = [];
      const a = createBackendTaskService({ name: "a", published, holdCommit: true });
      const b = createBackendTaskService({
        name: "b",
        published,
        holdCommit: false,
        // NOT what today's cross-process TaskService answers (see the finding above): this models
        // a classifier/claim that authorizes replacing a prior attempt with no positive evidence
        // of a live child, which is what G2's replacement path must allow for this window.
        readAttemptOutcome: async () => ({ kind: "terminal-no-report" }),
      });
      a.backend.releaseReports();
      storeA.stallRenewals();
      const runnerA = createRunner({ store: storeA, taskService: a.taskService, ownerId: OWNER_A });
      const runnerB = createRunner({
        store: storeB,
        taskService: b.taskService,
        ownerId: OWNER_B,
        clockOffsetMs: 60_000,
      });

      const runA = settle(runnerA.run(RUN_ID));
      await a.backend.checkpointed;
      const runB = settle(runnerB.run(RUN_ID));
      await b.backend.published;

      // A's lease is gone, but its config commit is not fenced by the lease.
      a.backend.releaseCommit();
      await a.backend.published;
      storeA.unstallRenewals();
      await runA;
      const journal = startedTaskIdForStep(await storeB.getRun(RUN_ID));
      const publishedAtDecision = [...published];
      b.backend.releaseReports();
      await runB;

      // SAFE outcome: at most one published child for the step, and it is the one the journal names.
      expect({ published: publishedAtDecision, journal }).toEqual({
        published: ["task_b_1_0"],
        journal: "task_b_1_0",
      });
    }
  );

  test("fixed gap 1 closes the compound path: a checkpoint stalled inside its owner-checked write keeps B out", async () => {
    // Before the #4452 gap-1 fix, B reclaimed A's aged mkdir locks here, reserved and published
    // its own child, and A's stalled checkpoint then landed and re-pointed the journal at A's
    // never-published child, so B could not settle its real one ("not the current started
    // attempt"). Now A keeps its locks while it lives, so B's lease acquire refuses.
    const { storeA, storeB } = await createStores();
    const published: string[] = [];
    let pauseA: ReturnType<typeof pauseNextOwnerCheckedWrite> | undefined;
    const armed = createDeferred();
    const a = createBackendTaskService({
      name: "a",
      published,
      holdCommit: false,
      beforeReservationCallbacks: () => {
        // The next locked read on A's store is the checkpoint's recordStepStarted, after its
        // owner check: A stalls there holding the events and lease locks. A's own renewal ticks
        // queue behind that lease lock, which is the stall the issue describes.
        pauseA = pauseNextOwnerCheckedWrite(storeA);
        armed.resolve();
      },
    });
    const b = createBackendTaskService({ name: "b", published, holdCommit: false });
    a.backend.releaseReports();
    b.backend.releaseReports();
    const runnerA = createRunner({ store: storeA, taskService: a.taskService, ownerId: OWNER_A });
    const runnerB = createRunner({
      store: storeB,
      taskService: b.taskService,
      ownerId: OWNER_B,
      clockOffsetMs: 60_000,
    });

    const runA = settle(runnerA.run(RUN_ID));
    await armed.promise;
    await pauseA?.entered;

    // A's lease is stale by B's clock, but A is alive inside its critical section.
    const runB = await settle(runnerB.run(RUN_ID));
    pauseA?.release();
    const runAOutcome = await runA;

    expect(runB.kind === "rejected" && isWorkflowRunAlreadyActiveError(runB.error, RUN_ID)).toBe(
      true
    );
    expect(b.backend.createManyCalls).toBe(0);
    expect({
      runA: runAOutcome.kind === "resolved" ? runAOutcome.value : "rejected",
      published,
      journal: startedTaskIdForStep(await storeA.getRun(RUN_ID)),
    }).toEqual({
      runA: { reportMarkdown: "Final: report from task_a_1_0" },
      published: ["task_a_1_0"],
      journal: "task_a_1_0",
    });
  });
});
