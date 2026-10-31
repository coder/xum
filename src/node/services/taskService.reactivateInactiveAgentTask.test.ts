// Characterization tests for TaskService.reactivateInactiveAgentTask, written before the method is
// split into steps. A reactivation reawakens an inactive sub-agent under a fresh attempt: it refuses
// a removal marker, unarchives the ancestry, plans the AI settings, appends the pre-turn rows,
// commits the new attempt id with a CAS under the TaskService mutex, owns that attempt, and starts
// the turn once the mutex is free. Each test pins one exit, the order of the checks where several
// apply, the lock nesting (event lock, tree lock, mutex, the CAS edit, the turn) or a value that
// the CAS callback sets. taskService.lifecycleRepro.test.ts covers the races with a Stop and a
// manual resume.
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { pendingRemovalAdmissionMessage, retiredAttemptMessage } from "@/constants/agentMessaging";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import type { AttemptLedger } from "@/node/services/attemptLedger";
import type { TaskService } from "@/node/services/taskService";
import {
  collectFullHistory,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspacesWithCheckouts,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isTaskAttemptId } from "@/node/utils/taskAttemptId";

const ROOT = "reactivate-root";
const PARENT = "reactivate-parent";
const CHILD = "reactivate-child";
/** The child's attempt before the reactivation, and the attempt another writer installs. */
const PRIOR = "att_00000000000000a1";
const OTHER = "att_00000000000000b2";
const MESSAGE = "Keep going";
const AT = "2026-10-01T00:00:00.000Z";
/** A live removal by another backend (a live pid, so no load takes the marker over). */
const MARKER = {
  removalId: "removal",
  instanceId: "other-backend",
  pid: process.pid,
  identity: {
    birth: null,
    bootId: null,
    pidNs: null,
    machineId: null,
    platform: process.platform,
    hostname: null,
  },
  at: AT,
};
/** Matches any message: the "changed concurrently" refusals are prose, which no test asserts. */
const PROSE = expect.any(String) as string;
const CLAIM = {
  runId: "run",
  stepId: "step",
  inputHash: "hash",
  childTaskId: CHILD,
  attemptId: PRIOR,
  mode: "no-report" as const,
  at: AT,
};

interface Lineage {
  proven: boolean;
  reason: string;
}
type Row = Omit<Partial<WorkspaceConfigEntry>, "id" | "path">;
type TurnArgs = Parameters<WorkspaceTurnManager["createWorkspaceTurn"]>[0];

/** Private members the harness wraps by name. The split keeps each one as an instance call. */
interface Internals {
  mutex: AsyncMutex;
  attemptLedger: AttemptLedger;
  workspaceEventLocks: MutexMap<string>;
  reactivateInactiveAgentTask(params: { message: string }): Promise<unknown>;
  unarchiveAgentTaskAncestry(owner: string, taskId: string): Promise<Result<boolean, string>>;
  evaluateAttemptLineage(taskId: string, entry: WorkspaceConfigEntry): Promise<Lineage>;
}

/** What a test changes inside the call-through wrappers of setup(). */
interface Hooks {
  /** Runs after the real unarchive returned: a writer during the unarchive. */
  afterUnarchive?: () => Promise<void>;
  /** Runs inside the lineage await, before the evaluation: a writer during the commit's awaits. */
  duringLineage?: () => Promise<void>;
  /** Runs after the identity CAS edit landed: another backend's write before the row check. */
  afterCas?: () => Promise<void>;
}

async function editRow(config: Config, edit: (row: WorkspaceConfigEntry) => void) {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      const row = project.workspaces.find((workspace) => workspace.id === CHILD);
      if (row != null) edit(row);
    }
    return cfg;
  });
}

async function dropRow(config: Config) {
  await config.editConfig((cfg) => {
    for (const project of cfg.projects.values()) {
      project.workspaces = project.workspaces.filter((workspace) => workspace.id !== CHILD);
    }
    return cfg;
  });
}

/** The trace segments every reactivation through task_send_message records in this order. */
const OPEN = ["event+", "tree+", "enter"];
const CLOSE = ["exit", "tree-", "event-"];
/** From the goal pause to the identity CAS, which runs under the mutex. */
const COMMIT = [
  'goal-pause {"force":true}',
  "lineage",
  "mutex+",
  "overtaken",
  "live?",
  "edit",
  "edited",
];
/** A refusal at or after the CAS returns from inside the mutex block. */
const REFUSED_AT_CAS = [...OPEN, "unarchive", ...COMMIT, "mutex-", ...CLOSE];

describe("TaskService.reactivateInactiveAgentTask", () => {
  let rootDir: string;
  let settles: Array<() => Promise<void>>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    settles = [];
  });
  afterEach(async () => {
    mock.restore();
    const settled = await Promise.allSettled(settles.splice(0).map((settle) => settle()));
    await removeTaskServiceTestRoot(rootDir);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  });

  /**
   * Every test awaits the sends it starts. What can outlive one: terminal-attention drains (and the
   * deferred-message chains they track), the queue drain, and the persist of a config migration
   * that a load started (one more edit on the same queue settles it). Each step runs even when an
   * earlier one fails, so a test that failed early leaves nothing running when its root goes.
   */
  async function settle(taskService: TaskService, config: Config): Promise<void> {
    const failures: unknown[] = [];
    for (const step of [
      () => flushTerminalAttentionDrains(taskService),
      () => taskService.queueDrainSettled(),
      () => config.editConfig((cfg) => cfg),
    ]) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "settling background work failed");
  }

  /**
   * ROOT > PARENT (running) > CHILD (reported under PRIOR, local runtime unless overridden). The
   * wrappers append to `trace`: the caller's event and tree locks of CHILD, the reactivation's
   * entry and exit, and inside it each collaborator call, the mutex and the turn. Nothing inside
   * createWorkspaceTurn is recorded, so the trace stays the reactivation's own.
   */
  async function setup(child: Row = {}) {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const local = { type: "local" as const };
    await saveWorkspacesWithCheckouts(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", ROOT),
        projectWorkspace(projectPath, "parent", PARENT, {
          runtimeConfig: local,
          parentWorkspaceId: ROOT,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", CHILD, {
          runtimeConfig: local,
          parentWorkspaceId: PARENT,
          taskStatus: "reported",
          taskAttemptId: PRIOR,
          title: "Child",
          ...child,
        }),
      ],
      testTaskSettings()
    );
    // Like WorkspaceService's unarchive, this clears the archive in config.
    const unarchive = mock(async (_workspaceId: string): Promise<Result<void, string>> => {
      await editRow(config, (row) => {
        row.unarchivedAt = new Date().toISOString();
      });
      return Ok(undefined);
    });
    const host = createWorkspaceServiceMocks({ unarchiveWhileTaskTreeLocked: unarchive });
    const { taskService, historyService } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
    });
    settles.push(() => settle(taskService, config));
    const svc = taskService as unknown as Internals;
    const ledger = svc.attemptLedger;
    const manager = workspaceTurnManagerFor(taskService);
    const hooks: Hooks = {};
    const trace: string[] = [];
    const turns: TurnArgs[] = [];
    let span = false;
    let inTurn = false;
    const note = (label: string) => {
      if (!inTurn) trace.push(label);
    };
    const step = (label: string) => {
      if (span && !inTurn) trace.push(label);
    };
    const bracket =
      <T>(name: string, operation: () => Promise<T>) =>
      async () => {
        note(`${name}+`);
        try {
          return await operation();
        } finally {
          note(`${name}-`);
        }
      };

    const locks = svc.workspaceEventLocks;
    const withEventLock = locks.withLock.bind(locks);
    locks.withLock = (key, operation) =>
      withEventLock(key, key === CHILD ? bracket("event", operation) : operation);
    const withTreeLock = taskService.withTaskTreeLifecycleLock.bind(taskService);
    taskService.withTaskTreeLifecycleLock = (id, operation) =>
      withTreeLock(id, id === CHILD ? bracket("tree", operation) : operation);
    const reactivate = svc.reactivateInactiveAgentTask.bind(taskService);
    svc.reactivateInactiveAgentTask = (p) => {
      note("enter");
      span = true;
      return reactivate(p).finally(() => {
        span = false;
        note("exit");
      });
    };
    const unarchiveAncestry = svc.unarchiveAgentTaskAncestry.bind(taskService);
    svc.unarchiveAgentTaskAncestry = async (owner, taskId) => {
      step("unarchive");
      const result = await unarchiveAncestry(owner, taskId);
      await hooks.afterUnarchive?.();
      return result;
    };
    const lineage = svc.evaluateAttemptLineage.bind(taskService);
    svc.evaluateAttemptLineage = async (taskId, entry) => {
      step("lineage");
      await hooks.duringLineage?.();
      return await lineage(taskId, entry);
    };
    const acquire = svc.mutex.acquire.bind(svc.mutex);
    svc.mutex.acquire = async () => {
      const lock = await acquire();
      if (!span || inTurn) return lock;
      trace.push("mutex+");
      const release = lock[Symbol.asyncDispose].bind(lock);
      lock[Symbol.asyncDispose] = () => {
        trace.push("mutex-");
        return release();
      };
      return lock;
    };
    const edit = taskService.editWorkspaceEntry.bind(taskService);
    taskService.editWorkspaceEntry = async (id, updater, options) => {
      const cas = span && !inTurn && id === CHILD;
      step("edit");
      const found = await edit(id, updater, options);
      step("edited");
      if (cas) await hooks.afterCas?.();
      return found;
    };
    /** A call-through that records `label` first. */
    const tap = (target: object, key: string, label: string) => {
      const methods = target as Record<string, (...args: unknown[]) => unknown>;
      const original = methods[key].bind(target);
      methods[key] = (...args) => {
        step(label === "goal-pause" ? `${label} ${JSON.stringify(args[1])}` : label);
        return original(...args);
      };
    };
    tap(svc, "appendFamilyPayloadRows", "append");
    tap(svc, "settleChildGoalPause", "goal-pause");
    tap(svc, "reawakeningOvertakenByStop", "overtaken");
    tap(ledger, "hasLiveReawakening", "live?");
    tap(svc, "editActiveWorkspaceEntry", "active-edit");
    tap(ledger, "publishAttemptRotation", "publish");
    tap(svc, "beginOwnedTaskAttempt", "own");
    tap(ledger, "beginReawakening", "reawakening+");
    tap(ledger, "endReawakening", "reawakening-");
    const createTurn = manager.createWorkspaceTurn.bind(manager);
    manager.createWorkspaceTurn = (args) => {
      step("turn+");
      inTurn = true;
      turns.push(args);
      return createTurn(args).finally(() => {
        inTurn = false;
        step("turn-");
      });
    };

    return {
      config,
      host,
      taskService,
      historyService,
      ledger,
      hooks,
      trace,
      turns,
      unarchive,
      row: () => findWorkspaceInConfig(config, CHILD),
      send: (options?: Parameters<TaskService["sendMessageToDescendantAgentTask"]>[4]) =>
        taskService.sendMessageToDescendantAgentTask(PARENT, CHILD, MESSAGE, "turn-end", options),
    };
  }

  const preTurnRow = () =>
    createMuxMessage("pre-turn-row", "assistant", "Sibling note", { synthetic: true });

  test("a removal marker read at the decision refuses before the unarchive", async () => {
    const h = await setup({ pendingRemoval: MARKER });
    expect(await h.send()).toStrictEqual(
      Err({ code: "send_failed", message: pendingRemovalAdmissionMessage(MARKER) })
    );
    expect(h.trace).toEqual([...OPEN, ...CLOSE]);
    expect(h.row()?.taskAttemptId).toBe(PRIOR);
  });

  test("a failed unarchive refuses with its error and keeps the attempt", async () => {
    const h = await setup({ archivedAt: AT });
    h.unarchive.mockImplementationOnce(() => Promise.resolve(Err("disk")));
    expect(await h.send()).toStrictEqual(Err({ code: "send_failed", message: "disk" }));
    expect(h.unarchive.mock.calls).toEqual([[CHILD]]);
    expect(h.trace).toEqual([...OPEN, "unarchive", ...CLOSE]);
    expect(h.row()?.taskAttemptId).toBe(PRIOR);
    expect(h.row()?.archivedAt).toBe(AT);
  });

  test("a row removed during the unarchive is not found", async () => {
    const h = await setup();
    h.hooks.afterUnarchive = () => dropRow(h.config);
    expect(await h.send()).toStrictEqual(Err({ code: "not_found" }));
    expect(h.trace).toEqual([...OPEN, "unarchive", ...CLOSE]);
  });

  test("a row removed during the checkout probe is not found by the AI plan", async () => {
    // The default worktree runtime probes the checkout; the probe is the only await in between.
    const h = await setup({ runtimeConfig: undefined });
    let armed = false;
    h.hooks.afterUnarchive = () => Promise.resolve(void (armed = true));
    spyOn(WorktreeRuntime.prototype, "ensureReady").mockImplementation(async () => {
      if (armed) await dropRow(h.config);
      return { ready: true };
    });
    expect(await h.send()).toStrictEqual(Err({ code: "not_found" }));
    expect(h.trace).toEqual([...OPEN, "unarchive", ...CLOSE]);
  });

  test("a failed pre-turn append refuses before the attempt changes", async () => {
    const h = await setup();
    const append = h.historyService.appendToHistory.bind(h.historyService);
    spyOn(h.historyService, "appendToHistory").mockImplementation((id, message) =>
      id === CHILD ? Promise.resolve(Err("disk full")) : append(id, message)
    );
    expect(await h.send({ preTurnMessages: [preTurnRow()] })).toStrictEqual(
      Err({ code: "send_failed", message: "disk full" })
    );
    expect(h.trace).toEqual([...OPEN, "unarchive", "append", ...CLOSE]);
    expect(h.row()?.taskAttemptId).toBe(PRIOR);
  });

  test("a removal marker that lands during the unarchive refuses before the goal pause", async () => {
    const h = await setup();
    h.hooks.afterUnarchive = () => editRow(h.config, (row) => void (row.pendingRemoval = MARKER));
    expect(await h.send()).toStrictEqual(
      Err({ code: "send_failed", message: pendingRemovalAdmissionMessage(MARKER) })
    );
    expect(h.trace).toEqual([...OPEN, "unarchive", ...CLOSE]);
    expect(h.row()?.taskAttemptId).toBe(PRIOR);
  });

  test("the pre-turn rows land before a retirement found after the unarchive, which wins over a removal", async () => {
    const h = await setup();
    h.hooks.afterUnarchive = () =>
      editRow(h.config, (row) => {
        row.taskAttemptRetiredBy = CLAIM;
        row.pendingRemoval = MARKER;
      });
    const preTurn = preTurnRow();
    expect(await h.send({ preTurnMessages: [preTurn] })).toStrictEqual(
      Err({ code: "send_failed", message: retiredAttemptMessage(CLAIM) })
    );
    expect(h.trace).toEqual([...OPEN, "unarchive", "append", ...CLOSE]);
    const history = await collectFullHistory(h.historyService, CHILD);
    expect(history.map((message) => message.id)).toEqual([preTurn.id]);
    expect(h.row()?.taskAttemptId).toBe(PRIOR);
  });

  // The identity CAS refuses a row that moved since the refresh, or is gone (its edit allows a
  // missing row). Its first three clauses are the copy that the shared rowKeepsAttempt helper will
  // replace; the message comes from the latest row. `message` undefined: the "changed
  // concurrently" refusal, whose prose is not asserted.
  test.each([
    { name: "another writer rotated the attempt", at: "lineage", id: OTHER },
    { name: "a workflow retired the attempt", at: "lineage", claim: true, message: "retired" },
    { name: "a removal began", at: "lineage", marker: true, message: "removal" },
    {
      name: "both: the retirement wins",
      at: "lineage",
      claim: true,
      marker: true,
      message: "retired",
    },
    { name: "a resume flipped it to running", at: "lineage", running: true },
    { name: "a resume flipped it to running in the unarchive", at: "unarchive", running: true },
    { name: "the row was removed", at: "lineage", drop: true },
  ])("the identity CAS refuses when $name", async (c) => {
    const h = await setup();
    const write = () =>
      c.drop === true
        ? dropRow(h.config)
        : editRow(h.config, (row) => {
            if (c.id != null) row.taskAttemptId = c.id;
            if (c.claim === true) row.taskAttemptRetiredBy = CLAIM;
            if (c.marker === true) row.pendingRemoval = MARKER;
            if (c.running === true) row.taskStatus = "running";
          });
    if (c.at === "lineage") h.hooks.duringLineage = write;
    else h.hooks.afterUnarchive = write;
    const messages = {
      retired: retiredAttemptMessage(CLAIM),
      removal: pendingRemovalAdmissionMessage(MARKER),
    };
    const message = c.message == null ? PROSE : messages[c.message as "retired"];
    expect(await h.send()).toStrictEqual(Err({ code: "send_failed", message }));
    expect(h.trace).toEqual(REFUSED_AT_CAS);
    expect(h.row()?.taskAttemptId).toBe(c.drop === true ? undefined : (c.id ?? PRIOR));
    expect(h.row()?.taskAttemptUnproven).toBe(undefined);
    expect(h.ledger.ownedAttempt(CHILD)).toBe(undefined);
    expect(h.ledger.currentAttemptIdByTaskId.get(CHILD)).toBe(undefined);
    expect(h.turns).toEqual([]);
  });

  test("a row rotated by another backend after the CAS is neither published nor owned", async () => {
    const h = await setup();
    let committed: string | undefined;
    h.hooks.afterCas = async () => {
      committed = h.row()?.taskAttemptId;
      await editRow(h.config, (row) => void (row.taskAttemptId = OTHER));
    };
    const result = await h.send();
    expect(result).toStrictEqual(Err({ code: "send_failed", message: PROSE }));
    expect(isTaskAttemptId(committed)).toBe(true);
    expect([PRIOR, OTHER]).not.toContain(committed);
    expect(h.trace).toEqual(REFUSED_AT_CAS);
    expect(h.row()?.taskAttemptId).toBe(OTHER);
    expect(h.ledger.ownedAttempt(CHILD)).toBe(undefined);
    expect(h.ledger.currentAttemptIdByTaskId.get(CHILD)).toBe(undefined);
    expect(h.ledger.hasLiveReawakening(CHILD)).toBe(false);
    expect(h.turns).toEqual([]);
  });
});
