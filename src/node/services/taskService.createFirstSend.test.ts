// TaskService.create holds the task-tree lock and the global mutex until the session admits a
// direct launch's first turn, then lets the rest of that send run after releasing them:
// concurrent spawns overlap their first sends, and Stops, failures and the child's own lifecycle
// operations behave as when the send held both locks.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert";
import type { SendMessageError } from "@/common/types/errors";
import { Err, Ok, type Result } from "@/common/types/result";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import type { HistoryService } from "@/node/services/historyService";
import type { TaskService } from "@/node/services/taskService";
import {
  createAgentTask,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import type { TurnAdmissionToken } from "@/node/services/taskWorkspaceSeam";
import { createTaskAwaitTool } from "@/node/services/tools/task_await";
import { createTestToolConfig, mockToolCallOptions } from "@/node/services/tools/testHelpers";

const PARENT_A = "1111111111";
const PARENT_B = "2222222222";
const PARENT_C = "3333333333";
const CHILD_IDS = ["aaaaaaaaa1", "aaaaaaaaa2", "aaaaaaaaa3"];
const CHILD = CHILD_IDS[0];
const SIBLING = "bbbbbbbbb1";
const QUEUED = "ccccccccc1";
const GATE_MS = 1_000;
const OVERLAP_WAIT_MS = 3_000;
// How long a probe waits for an operation that must not run before the brief's turn is admitted.
const ADMISSION_PROBE_MS = 200;

type SendMock = (
  workspaceId: string,
  message: string,
  options: unknown,
  internal?: { admissionStale?: () => boolean; turnAdmission?: TurnAdmissionToken }
) => Promise<Result<void, SendMessageError>>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = GATE_MS): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await sleep(5);
  }
  return true;
}

async function withinGate<T>(what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} waited for the first send`)), GATE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The session admits the send's turn, as AgentSession does once the brief's rows are durable. */
function admitTurn(internal: Parameters<SendMock>[3]): void {
  internal?.turnAdmission?.onAdmitted(Symbol("turn"));
}

async function failureNotices(historyService: HistoryService, parentId: string) {
  const history = await historyService.getHistoryFromLatestBoundary(parentId);
  assert(history.success, "the parent's history must be readable");
  return history.data.filter((message) =>
    message.parts.some(
      (part) => part.type === "text" && part.text.includes("<mux_subagent_failure>")
    )
  );
}

interface Internals {
  attemptLedger: {
    attemptSettlementByTaskId: Map<string, { phase: "closing" | "settled"; source: string }>;
  };
  emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
}

function internals(taskService: TaskService): Internals {
  return taskService as unknown as Internals;
}

describe("TaskService.create: the first send runs after the create locks are released", () => {
  let rootDir: string;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    stubStableIds(config, CHILD_IDS);
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  const row = (id: string) => findWorkspaceInConfig(config, id);

  function workspace(id: string, overrides: Partial<WorkspaceConfigEntry> = {}) {
    return {
      path: projectPath,
      id,
      name: id,
      createdAt: new Date().toISOString(),
      runtimeConfig: { type: "local" as const },
      ...overrides,
    } satisfies WorkspaceConfigEntry;
  }

  async function setup(
    send: SendMock,
    rows: WorkspaceConfigEntry[] = [],
    settings = testTaskSettings(8, 3)
  ) {
    await saveWorkspaces(
      config,
      projectPath,
      [workspace(PARENT_A), workspace(PARENT_B), workspace(PARENT_C), ...rows],
      settings
    );
    const host = createWorkspaceServiceMocks({ sendMessage: mock(send) });
    return createTaskServiceHarness(config, { workspaceService: host.workspaceService });
  }

  test.each([
    ["one parent", [PARENT_A, PARENT_A, PARENT_A]],
    ["three parents", [PARENT_A, PARENT_B, PARENT_C]],
  ])(
    "concurrent creates under %s overlap their first sends in wall time",
    async (_, parents) => {
      const sends: Array<{ startedAt: number; endedAt: number }> = [];
      let started = 0;
      const { taskService } = await setup(async (_workspaceId, _message, _options, internal) => {
        admitTurn(internal);
        const startedAt = performance.now();
        started++;
        // Each send lasts until every send started (bounded), so the sends overlap unless a
        // create waits for another create's send.
        await waitFor(() => started === parents.length, OVERLAP_WAIT_MS);
        sends.push({ startedAt, endedAt: performance.now() });
        return Ok(undefined);
      });

      const created = await Promise.all(
        parents.map((parentId, index) => createAgentTask(taskService, parentId, `part ${index}`))
      );

      expect(created.map((result) => result.success && result.data.status)).toEqual([
        "running",
        "running",
        "running",
      ]);
      expect(sends).toHaveLength(3);
      expect(Math.max(...sends.map((send) => send.startedAt))).toBeLessThan(
        Math.min(...sends.map((send) => send.endedAt))
      );
    },
    4 * OVERLAP_WAIT_MS
  );

  test("a parent Stop issued while the create holds its locks waits until the brief's turn is admitted", async () => {
    let stopping: Promise<string[]> | undefined;
    let latchedBeforeAdmission: boolean | undefined;
    const harness = await setup(async (workspaceId, _message, _options, internal) => {
      // A Stop that did not wait for create's locks would latch the child here.
      latchedBeforeAdmission = await waitFor(
        () => harness.taskService.isWorkspaceStopInProgress(workspaceId),
        ADMISSION_PROBE_MS
      );
      admitTurn(internal);
      return Ok(undefined);
    });
    const { taskService } = harness;
    const svc = internals(taskService);
    const emit = svc.emitWorkspaceMetadata.bind(taskService);
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation((id) => {
      // The parent is stopped as soon as the child appears: its cascade queues on the mutex.
      if (id === CHILD) stopping ??= taskService.terminateAllDescendantAgentTasks(PARENT_A);
      return emit(id);
    });

    const created = await createAgentTask(taskService, PARENT_A, "go");

    expect(latchedBeforeAdmission).toBe(false);
    expect(created).toMatchObject({ success: true, data: { status: "running" } });
    expect(await stopping).toEqual([CHILD]);
    expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted" });
  });

  test("a parent Stop during the brief's preparation does not wait for it", async () => {
    const preparing = Promise.withResolvers<void>();
    const finishPreparation = Promise.withResolvers<void>();
    const { taskService } = await setup(async (_workspaceId, _message, _options, internal) => {
      admitTurn(internal);
      preparing.resolve();
      await finishPreparation.promise;
      return Ok(undefined);
    });

    const creating = createAgentTask(taskService, PARENT_A, "go");
    try {
      await preparing.promise;
      expect(
        await withinGate("the parent Stop", taskService.terminateAllDescendantAgentTasks(PARENT_A))
      ).toEqual([CHILD]);
      expect(row(CHILD)).toMatchObject({ taskStatus: "interrupted" });
    } finally {
      finishPreparation.resolve();
    }
    expect((await creating).success).toBe(true);
  });

  test("a first send that fails before its turn is admitted fails the launch under create's locks", async () => {
    const entered = Promise.withResolvers<void>();
    const failSend = Promise.withResolvers<void>();
    const { taskService } = await setup(async () => {
      entered.resolve();
      await failSend.promise;
      return Err({ type: "unknown", raw: "provider unavailable" });
    });

    const creating = createAgentTask(taskService, PARENT_A, "go");
    await entered.promise;
    const lock = taskService.acquireTaskCreationLock();
    const lockedBeforeAdmission = await Promise.race([
      lock.then(() => true),
      sleep(ADMISSION_PROBE_MS).then(() => false),
    ]);
    failSend.resolve();

    expect(lockedBeforeAdmission).toBe(false);
    expect(await creating).toEqual(Err("provider unavailable"));
    await (await lock)[Symbol.asyncDispose]();
    expect(row(CHILD)).toMatchObject({
      taskStatus: "interrupted",
      taskLaunchError: "provider unavailable",
    });
  });

  test("a first send that fails after the release reaches the parent only through create's result", async () => {
    const entered = Promise.withResolvers<void>();
    const failSend = Promise.withResolvers<void>();
    const { taskService, historyService, workspaceTurnManager } = await setup(
      async (_workspaceId, _message, _options, internal) => {
        admitTurn(internal);
        entered.resolve();
        await failSend.promise;
        return Err({ type: "unknown", raw: "provider unavailable" });
      }
    );
    const wakes = spyOn(taskService, "enqueueTerminalAttention");
    const settlements = internals(taskService).attemptLedger.attemptSettlementByTaskId;

    const creating = createAgentTask(taskService, PARENT_A, "go", {
      attentionPolicy: "blocking_until_terminal",
    });
    await entered.promise;
    {
      await using _lock = await withinGate(
        "the task-creation lock",
        taskService.acquireTaskCreationLock()
      );
      failSend.resolve();
      expect(await waitFor(() => settlements.get(CHILD)?.phase === "closing")).toBe(true);
      expect(
        taskService.admitTaskWorkspaceTurn(CHILD, { acceptanceOrigin: "manual" })
      ).toMatchObject({ kind: "refused" });
      expect(row(CHILD)).toMatchObject({ taskStatus: "running" });
    }

    expect(await creating).toEqual(Err("provider unavailable"));
    expect(row(CHILD)).toMatchObject({
      taskStatus: "interrupted",
      taskLaunchError: "provider unavailable",
    });
    expect(settlements.get(CHILD)).toMatchObject({ phase: "settled", source: "launch-failed" });
    const awaitTool = createTaskAwaitTool({
      ...createTestToolConfig(rootDir, { workspaceId: PARENT_A }),
      taskService,
      workspaceTurnManager,
    });
    const awaited = (await awaitTool.execute!(
      { task_ids: [CHILD], timeout_secs: 5 },
      mockToolCallOptions
    )) as { results: Array<{ taskId: string; status: string; error?: string }> };
    expect(awaited.results.map((result) => [result.taskId, result.status, result.error])).toEqual([
      [CHILD, "error", "provider unavailable"],
    ]);
    expect(await failureNotices(historyService, PARENT_A)).toHaveLength(0);
    expect(wakes).not.toHaveBeenCalled();
  });

  test("a first send that fails after the release starts the task queued behind it", async () => {
    const [failing, queued] = CHILD_IDS;
    const entered = Promise.withResolvers<void>();
    const failSend = Promise.withResolvers<void>();
    let queuedSent = false;
    const { taskService } = await setup(
      async (workspaceId, _message, _options, internal) => {
        admitTurn(internal);
        if (workspaceId === queued) {
          queuedSent = true;
          return Ok(undefined);
        }
        entered.resolve();
        await failSend.promise;
        return Err({ type: "unknown", raw: "provider unavailable" });
      },
      [],
      testTaskSettings(1, 3)
    );

    const creating = createAgentTask(taskService, PARENT_A, "go");
    try {
      await entered.promise;
      const next = await withinGate(
        "a create under the full limit",
        createAgentTask(taskService, PARENT_B, "next")
      );
      expect(next.success && next.data).toMatchObject({ taskId: queued, status: "queued" });
      // The drain the queued create scheduled has run and found the slot taken.
      await taskService.maybeStartQueuedTasks();
      expect(queuedSent).toBe(false);
    } finally {
      failSend.resolve();
    }

    expect(await creating).toEqual(Err("provider unavailable"));
    expect(row(failing)).toMatchObject({ taskStatus: "interrupted" });
    expect(await waitFor(() => queuedSent)).toBe(true);
    await taskService.queueDrainSettled();
  });

  test("reawaken, queue drain and the task-creation lock do not wait for another task's first send", async () => {
    const entered = Promise.withResolvers<void>();
    const finishBrief = Promise.withResolvers<void>();
    let briefDone = false;
    let queuedSent = false;
    const { taskService } = await setup(
      async (workspaceId, _message, _options, internal) => {
        admitTurn(internal);
        if (workspaceId === QUEUED) {
          queuedSent = true;
          return Ok(undefined);
        }
        if (workspaceId === CHILD) {
          entered.resolve();
          await finishBrief.promise;
          briefDone = true;
        }
        return Ok(undefined);
      },
      [
        workspace(SIBLING, {
          parentWorkspaceId: PARENT_B,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskAttemptId: "att_00000000000000b1",
          taskModelString: "openai:gpt-5.2",
        }),
        workspace(QUEUED, {
          parentWorkspaceId: PARENT_C,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued work",
          taskModelString: "openai:gpt-5.2",
        }),
      ]
    );

    const creating = createAgentTask(taskService, PARENT_A, "go");
    try {
      await entered.promise;
      const reawakened = await withinGate("reawaken", taskService.reawakenInterruptedTask(SIBLING));
      expect(reawakened.kind).toBe("reawakened");
      await withinGate("the queue drain", taskService.maybeStartQueuedTasks());
      expect(await waitFor(() => queuedSent)).toBe(true);
      const lock = await withinGate(
        "the task-creation lock",
        taskService.acquireTaskCreationLock()
      );
      await lock[Symbol.asyncDispose]();
      expect(briefDone).toBe(false);
    } finally {
      finishBrief.resolve();
    }
    expect((await creating).success).toBe(true);
    await taskService.queueDrainSettled();
  });

  test("a tree-locked operation naming the child waits for its first send; others in the tree run", async () => {
    const finishBrief = Promise.withResolvers<void>();
    let briefDone = false;
    const order: string[] = [];
    const { taskService } = await setup(async (workspaceId, _message, _options, internal) => {
      admitTurn(internal);
      if (workspaceId === CHILD) {
        await finishBrief.promise;
        briefDone = true;
      }
      return Ok(undefined);
    });
    const svc = internals(taskService);
    const emit = svc.emitWorkspaceMetadata.bind(taskService);
    let queuedBehindCreate: Promise<void> | undefined;
    spyOn(svc, "emitWorkspaceMetadata").mockImplementation((id) => {
      // Issued while the create still holds the tree lock: this one queues on that lock.
      if (id === CHILD) {
        queuedBehindCreate ??= taskService.withTaskTreeLifecycleLock(CHILD, () => {
          order.push(`queued on the lock, brief done: ${briefDone}`);
          return Promise.resolve();
        });
      }
      return emit(id);
    });

    const creating = createAgentTask(taskService, PARENT_A, "go");
    try {
      await waitFor(() => queuedBehindCreate != null);
      const naming = taskService.withTaskTreeLifecycleLock(CHILD, () => {
        order.push(`named the child, brief done: ${briefDone}`);
        return Promise.resolve();
      });
      // Takes the same root lock, so it ran after both child operations had they been granted.
      await withinGate(
        "an operation naming the parent",
        taskService.withTaskTreeLifecycleLock(PARENT_A, () => {
          order.push("named the parent");
          return Promise.resolve();
        })
      );
      expect(order).toEqual(["named the parent"]);
      finishBrief.resolve();
      expect((await creating).success).toBe(true);
      await naming;
      await queuedBehindCreate;
    } finally {
      finishBrief.resolve();
    }
    expect(order.slice(1).sort()).toEqual([
      "named the child, brief done: true",
      "queued on the lock, brief done: true",
    ]);
  });
});
