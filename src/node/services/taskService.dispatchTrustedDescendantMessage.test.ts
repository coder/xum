// Characterization tests for TaskService.dispatchTrustedDescendantMessage, written before the method
// is split into steps. They drive it through sendMessageToDescendantAgentTask and pin: the result and
// the row of each path, the lock scopes (a trace of the mutex, the event lock, the task-tree lock,
// the desktop gate and every config edit), and that an inactive target goes to
// reactivateInactiveAgentTask in the tick of the inactive decision. The reactivation itself is a
// stub here: the reawakening suites cover it.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { PreparedReawakenAi } from "@/node/services/agentTaskReawakenAi";
import type {
  SendAgentTaskMessageError,
  SendAgentTaskMessageResult,
  TaskService,
} from "@/node/services/taskService";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
  startLiveWorkspaceTurn,
} from "@/node/services/taskService.shared.testHarness";
import type { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";

const PARENT = "parent";
const CHILD = "child";
/** A second tree root: an out-of-scope sender, or the child's new parent. */
const OTHER = "other-root";
const ATTEMPT = "att_00000000000000a1";
const MESSAGE = "Fix the parser.";
const LABEL = "Label";
/** The message as the child sees it (renderLabeledTaskMessage). */
const LABELED = `${LABEL}:\n\n${MESSAGE}`;
const ARCHIVED_AT = "2026-08-01T00:00:00.000Z";
/** Matches any message: the tests never assert prose. */
const PROSE = expect.any(String) as string;
const ROW = createMuxMessage("payload-1", "assistant", "Payload.", { synthetic: true });

type DispatchResult = Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>;
/** What the reactivation stub returns: the dispatch must hand back this exact object. */
const REACTIVATED: DispatchResult = Ok({ delivery: "reactivated" });

/** Private members the trace wraps by name. The split keeps them as instance calls. */
interface DispatchInternals {
  workspaceEventLocks: MutexMap<string>;
  workspaceTreeLifecycleLocks: MutexMap<string>;
  mutex: AsyncMutex;
  desktopInputCoordinator: { withAdmission<T>(id: string, admit: () => Promise<T>): Promise<T> };
  prepareReawakenAi(taskId: string): Promise<PreparedReawakenAi | undefined>;
  dropKeptTaskPromptAlreadyInHistory(taskId: string): Promise<void>;
  reactivateInactiveAgentTask(params: Record<string, unknown>): Promise<DispatchResult>;
}

/** Runs operation between `${label}+` and `${label}-` trace entries. */
async function scoped<T>(trace: string[], label: string, operation: () => Promise<T>) {
  trace.push(`${label}+`);
  try {
    return await operation();
  } finally {
    trace.push(`${label}-`);
  }
}

/** Traces the locks; returns the keys each task lock was taken for, in order. */
function traceLocks(trace: string[], internals: DispatchInternals) {
  const keys = { event: [] as string[], tree: [] as string[] };
  for (const [label, locks] of [
    ["event", internals.workspaceEventLocks],
    ["tree", internals.workspaceTreeLifecycleLocks],
  ] as const) {
    const withLock = locks.withLock.bind(locks);
    locks.withLock = (key, operation) => {
      keys[label].push(key);
      return withLock(key, () => scoped(trace, label, operation));
    };
  }
  const mutex = internals.mutex;
  const acquire = mutex.acquire.bind(mutex);
  mutex.acquire = async () => {
    const lock = await acquire();
    trace.push("mutex+");
    const release = lock[Symbol.asyncDispose].bind(lock);
    lock[Symbol.asyncDispose] = () => {
      trace.push("mutex-");
      return release();
    };
    return lock;
  };
  const gate = internals.desktopInputCoordinator;
  const withAdmission = gate.withAdmission.bind(gate);
  gate.withAdmission = (id, admit) => withAdmission(id, () => scoped(trace, "gate", admit));
  return keys;
}

/** Edits one config row in place. */
async function editRow(config: Config, id: string, edit: (row: WorkspaceConfigEntry) => void) {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const row = project.workspaces.find((workspace) => workspace.id === id);
      if (row != null) edit(row);
    }
    return cfg;
  });
}

describe("TaskService.dispatchTrustedDescendantMessage", () => {
  let rootDir: string;
  // Each test awaits every send it starts. The background work left: terminal-attention drains of
  // the services, and the persist of the config migrations a load can start (one more edit on the
  // same serialized queue settles it). allSettled: a test that failed early still settles both,
  // and a drain that failed in the background still fails the test once cleanup is done.
  let configs: Config[];
  let services: TaskService[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    configs = [];
    services = [];
  });
  afterEach(async () => {
    const drains = await Promise.allSettled(
      services.splice(0).map((s) => flushTerminalAttentionDrains(s))
    );
    mock.restore();
    await Promise.allSettled(configs.splice(0).map((config) => config.editConfig((cfg) => cfg)));
    await removeTaskServiceTestRoot(rootDir);
    const failed = drains.find((drain) => drain.status === "rejected");
    if (failed != null) throw failed.reason;
  });

  /**
   * CHILD of PARENT (plus the root OTHER) with real checkout markers, behind a host whose
   * sendMessage accepts the turn while `flags.accept`. The trace records the locks, every config
   * edit and history append, the definition read, the kept-brief check and the reactivation stub.
   */
  async function setup(child: Partial<WorkspaceConfigEntry>, options = { checkout: true }) {
    const config = await createTestConfig(rootDir);
    configs.push(config);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspacesWithCheckouts(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", PARENT),
        projectWorkspace(projectPath, "other", OTHER),
        projectWorkspace(projectPath, "child", CHILD, {
          parentWorkspaceId: PARENT,
          agentId: "exec",
          agentType: "exec",
          taskAttemptId: ATTEMPT,
          ...child,
        }),
      ],
      testTaskSettings()
    );
    if (!options.checkout)
      await fsPromises.rm(path.join(projectPath, "child", ".git"), { recursive: true });
    const trace: string[] = [];
    const flags = { streaming: false, accept: true };
    // The decision tick. The last await before the inactive decision (the kept-brief check, or
    // the execution snapshot) arms it; the next config read or stream probe starts it, and a
    // microtask marks it passed. `passed: false` at the reactivation: no await in between.
    const tick = { armed: false, passed: undefined as boolean | undefined };
    const startTick = () => {
      if (!tick.armed) return;
      tick.armed = false;
      tick.passed = false;
      queueMicrotask(() => (tick.passed = true));
    };
    const arm = () => void (tick.armed = true);
    const isStreaming = mock((_workspaceId: string) => {
      startTick();
      return flags.streaming;
    });
    const sendMessage = mock(
      async (
        _workspaceId: string,
        _message: string,
        _options: unknown,
        internal?: { onAccepted?: () => Promise<void> }
      ): Promise<Result<void>> => {
        trace.push("send+");
        if (flags.accept) await internal?.onAccepted?.();
        trace.push("send-");
        return Ok(undefined);
      }
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService, historyService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    services.push(taskService);
    const internals = taskService as unknown as DispatchInternals;
    const lockKeys = traceLocks(trace, internals);
    const load = config.loadConfigOrDefault.bind(config);
    spyOn(config, "loadConfigOrDefault").mockImplementation((loadOptions) => {
      startTick();
      return load(loadOptions);
    });
    const editConfig = config.editConfig.bind(config);
    spyOn(config, "editConfig").mockImplementation((fn, editOptions) => {
      trace.push("edit");
      return editConfig(fn, editOptions);
    });
    const append = historyService.appendToHistory.bind(historyService);
    const appendToHistory = spyOn(historyService, "appendToHistory").mockImplementation(
      (workspaceId, message) => {
        trace.push("append");
        return append(workspaceId, message);
      }
    );
    const prepareReawakenAi = internals.prepareReawakenAi.bind(taskService);
    const prepare = spyOn(internals, "prepareReawakenAi").mockImplementation((taskId) => {
      trace.push("prepare");
      return prepareReawakenAi(taskId);
    });
    const drop = internals.dropKeptTaskPromptAlreadyInHistory.bind(taskService);
    spyOn(internals, "dropKeptTaskPromptAlreadyInHistory").mockImplementation((taskId) => {
      trace.push("drop");
      return drop(taskId).then(arm);
    });
    const snapshot = taskService.getDescendantAgentTaskExecutionSnapshot.bind(taskService);
    spyOn(taskService, "getDescendantAgentTaskExecutionSnapshot").mockImplementation(
      async (...args) => {
        trace.push("snapshot");
        const record = await snapshot(...args);
        arm();
        return record;
      }
    );
    const reactivations: Array<Record<string, unknown>> = [];
    const passedAtReactivation: Array<boolean | undefined> = [];
    spyOn(internals, "reactivateInactiveAgentTask").mockImplementation(async (params) => {
      passedAtReactivation.push(tick.passed);
      reactivations.push(params);
      trace.push("reactivate+");
      await Promise.resolve();
      trace.push("reactivate-");
      return REACTIVATED;
    });
    const send = (mode: "tool-end" | "turn-end" = "tool-end", sendOptions = {}) =>
      taskService.sendMessageToDescendantAgentTask(PARENT, CHILD, MESSAGE, mode, sendOptions);
    return {
      ...{ config, taskService, historyService, trace, lockKeys, flags, isStreaming, sendMessage },
      ...{ appendToHistory, prepare, reactivations, passedAtReactivation, send },
      row: () => findWorkspaceInConfig(config, CHILD),
      history: async () => (await collectFullHistory(historyService, CHILD)).map((m) => m.id),
    };
  }

  /** The trace of a send that passed the queued check and took both task locks. */
  const LOCKED = ["mutex+", "mutex-", "prepare", "event+", "tree+", "drop"];
  /** The reactivation runs inside both task locks, which wait for it to settle. */
  const REAWAKEN_TAIL = ["reactivate+", "reactivate-", "tree-", "event-"];
  const REAWAKENED = [...LOCKED, ...REAWAKEN_TAIL];

  describe("queued target", () => {
    test("splices the prompt under the mutex alone, after the pre-turn rows", async () => {
      const s = await setup({
        taskStatus: "queued",
        taskPrompt: "Brief",
        taskPromptSendId: "send-1",
      });
      const result = await s.send("turn-end", { messageLabel: LABEL, preTurnMessages: [ROW] });
      expect(result).toStrictEqual(Ok({ delivery: "queued" }));
      expect(s.trace).toEqual(["mutex+", "append", "edit", "mutex-"]);
      expect(s.row()?.taskPrompt).toBe(`Brief\n\n${LABELED}`);
      expect(s.row()?.taskPromptSendId).toBe(undefined);
      expect(await s.history()).toEqual([ROW.id]);
      expect(s.sendMessage).not.toHaveBeenCalled();
    });

    test("an archived queued target is reawakened, not spliced", async () => {
      const s = await setup({ taskStatus: "queued", taskPrompt: "Brief", archivedAt: ARCHIVED_AT });
      expect(await s.send("tool-end", { messageLabel: LABEL })).toBe(REACTIVATED);
      expect(s.trace).toEqual(REAWAKENED);
      expect(s.reactivations).toHaveLength(1);
      expect(s.row()?.taskPrompt).toBe("Brief");
      expect(s.sendMessage).not.toHaveBeenCalled();
    });

    test("a queued target without a durable prompt is refused before any row is written", async () => {
      const s = await setup({ taskStatus: "queued", taskPrompt: "  " });
      const before = s.row();
      const result = await s.send("tool-end", { preTurnMessages: [ROW] });
      expect(result).toStrictEqual(Err({ code: "send_failed", message: PROSE }));
      expect(s.trace).toEqual(["mutex+", "mutex-"]);
      expect(s.row()).toEqual(before);
      expect(await s.history()).toEqual([]);
    });

    test("a failed pre-turn append leaves the prompt as it was", async () => {
      const s = await setup({ taskStatus: "queued", taskPrompt: "Brief" });
      s.appendToHistory.mockImplementationOnce(() => {
        s.trace.push("append");
        return Promise.resolve(Err("disk full"));
      });
      const result = await s.send("tool-end", { preTurnMessages: [ROW] });
      expect(result).toStrictEqual(Err({ code: "send_failed", message: "disk full" }));
      expect(s.trace).toEqual(["mutex+", "append", "mutex-"]);
      expect(s.row()?.taskPrompt).toBe("Brief");
      expect(await s.history()).toEqual([]);
    });
  });

  describe("under the task locks", () => {
    test("a child moved out of the sender's tree during the definition read is refused", async () => {
      const s = await setup({ taskStatus: "running" });
      s.prepare.mockImplementation(async () => {
        s.trace.push("prepare");
        await editRow(s.config, CHILD, (row) => (row.parentWorkspaceId = OTHER));
        return undefined;
      });
      expect(await s.send()).toStrictEqual(Err({ code: "invalid_scope" }));
      expect(s.trace).toEqual([
        ...["mutex+", "mutex-", "prepare", "edit"],
        ...["event+", "tree+", "drop", "tree-", "event-"],
      ]);
      const row = s.row();
      expect([row?.parentWorkspaceId, row?.taskStatus, row?.taskAttemptId]).toEqual([
        OTHER,
        "running",
        ATTEMPT,
      ]);
      expect(row?.taskPendingGuidance).toBe(undefined);
      expect(s.sendMessage).not.toHaveBeenCalled();
    });

    test("an archived target under an active continuation is refused, and steered once restored", async () => {
      const s = await setup({ taskStatus: "reported" });
      await startLiveWorkspaceTurn(s.taskService, s.config, {
        ownerWorkspaceId: PARENT,
        workspaceId: CHILD,
        handleId: "wst_live",
      });
      await editRow(s.config, CHILD, (row) => (row.archivedAt = ARCHIVED_AT));
      s.trace.length = 0;
      const refused = await s.send();
      expect(refused).toStrictEqual(
        Err({ code: "not_active", taskStatus: "reported", message: PROSE })
      );
      expect(s.trace).toEqual([...LOCKED, "snapshot", "tree-", "event-"]);
      expect(s.row()?.taskPendingGuidance).toBe(undefined);
      expect(s.sendMessage).not.toHaveBeenCalled();

      // Not archived: the live stream of the continuation takes the guidance, correlated to it.
      await editRow(s.config, CHILD, (row) => delete row.archivedAt);
      expect(await s.send()).toStrictEqual(Ok({ delivery: "accepted" }));
      const [, , options, internal] = s.sendMessage.mock.calls[0] as unknown as [
        string,
        string,
        { muxMetadata?: unknown },
        { workspaceTurnContinuation?: boolean },
      ];
      expect(options.muxMetadata).toEqual({
        type: "workspace-turn-task",
        taskHandleId: "wst_live",
        ownerWorkspaceId: PARENT,
        turnId: "wst_live-turn",
      });
      expect(internal.workspaceTurnContinuation).toBe(true);
      expect(s.reactivations).toEqual([]);
    });
  });

  test("live guidance is reserved under the desktop gate and sent under both task locks", async () => {
    // Missing status is a legacy running task: the reservation persists `running`.
    const s = await setup({ taskStatus: undefined });
    expect(await s.send()).toStrictEqual(Ok({ delivery: "accepted" }));
    expect(s.trace).toEqual([
      ...LOCKED,
      ...["gate+", "edit", "gate-"],
      ...["send+", "edit", "send-"],
      ...["tree-", "event-"],
    ]);
    // The event lock of the target, the tree lock of its root.
    expect(s.lockKeys).toEqual({ event: [CHILD], tree: [PARENT] });
    expect(s.row()?.taskStatus).toBe("running");
    expect(s.row()?.taskPendingGuidance).toBe(undefined);
    expect(s.prepare).toHaveBeenCalledTimes(1);
  });

  // No await runs from the last await before the inactive decision (the kept-brief check, or the
  // execution snapshot) to the reactivateInactiveAgentTask call, which reads the row in that tick.
  test.each([
    { name: "no execution", child: {}, reads: [] },
    { name: "a stale execution", child: { taskExecutionId: "wst_gone" }, reads: ["snapshot"] },
  ])("an inactive target with $name is reawakened in the decision's tick", async (c) => {
    const s = await setup({ taskStatus: "reported", ...c.child });
    const prepared: PreparedReawakenAi = {
      taskId: CHILD,
      agentId: "exec",
      contextKey: "k",
      layers: null,
    };
    s.prepare.mockImplementation(() => {
      s.trace.push("prepare");
      return Promise.resolve(prepared);
    });
    let epoch = 1;
    spyOn(s.taskService, "getWorkspaceStopEpoch").mockImplementation(() => epoch);
    const sending = s.send("turn-end", { messageLabel: LABEL, preTurnMessages: [ROW] });
    // A Stop after the send started, while it waits for its first lock: the fence predates it.
    epoch = 2;
    expect(await sending).toBe(REACTIVATED);
    expect(s.reactivations).toStrictEqual([
      {
        ancestorWorkspaceId: PARENT,
        taskId: CHILD,
        message: LABELED,
        prependKeptBrief: true,
        queueDispatchMode: "turn-end",
        preTurnMessages: [ROW],
        aiRefresh: { prepared },
        stopFence: new Map([
          [CHILD, 1],
          [PARENT, 1],
        ]),
      },
    ]);
    expect(s.passedAtReactivation).toEqual([false]);
    // Probed by the F54 deferral, then by the inactive decision.
    expect(s.isStreaming.mock.calls).toEqual([[CHILD], [CHILD]]);
    // The locks stay held until the reactivation settled.
    expect(s.trace).toEqual([...LOCKED, ...c.reads, ...REAWAKEN_TAIL]);
  });
});
