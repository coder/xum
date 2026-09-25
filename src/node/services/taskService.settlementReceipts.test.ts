import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { existsSync, writeFileSync } from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";

import { configFilePath, type Config } from "@/node/config";
import { type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { SecretsStore } from "@/node/config";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  getSubagentAttemptSettlementReceiptPath,
  readSubagentAttemptSettlementReceiptStrict,
  writeSubagentAttemptSettlementReceipt,
  type SubagentAttemptSettlementSource,
} from "@/node/services/subagentAttemptSettlements";
import { ATTEMPT_CLOSURE_SETTLE_WAIT_MS, TaskService } from "@/node/services/taskService";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import {
  createAIServiceMocks,
  createMockInitStateManager,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { TurnAdmissionToken } from "@/node/services/taskWorkspaceSeam";
import { TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE } from "@/constants/agentMessaging";
import { EventEmitter } from "events";

/**
 * G2 — settlement receipt producers. Every point that ends an OWNED, receipt-eligible attempt
 * without a report writes a receipt naming exactly that attempt into every owner session dir (the
 * parent and its ancestors) BEFORE the in-memory settlement is recorded. Nothing reads receipts
 * for replacement yet; the only reader is the lineage proof of a reawaken/reactivation.
 *
 * Tree: root (plain workspace) → mid (task) → children. A child's owners are [mid, root].
 */
const rootId = "root-receipts";
const midId = "mid-receipts";
const OWNERS = [midId, rootId];
const PREDECESSOR = "att_00000000000000f1";

interface Internals {
  ownedAttemptByTaskId: Map<string, { attemptId?: string; receiptEligible: boolean }>;
  attemptSettlementByTaskId: Map<string, { attemptId?: string; phase: string; source: string }>;
  workspaceStopRecords: Map<string, unknown>;
  releaseSharedDesktopTaskOnUserStop: (taskId: string, abortOrigin: unknown) => Promise<void>;
  resolveStreamAttemptAtEvent: (taskId: string) => unknown;
  failAgentTaskTerminally: (
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    options: { expectedAttemptId: string | null }
  ) => Promise<void>;
  startReservedAgentTask: (plan: unknown) => Promise<void>;
  materializeReservedTaskWorkspace: (...args: unknown[]) => Promise<unknown>;
  cleanupMaterializedTaskWorkspace: (...args: unknown[]) => Promise<void>;
  evaluateAttemptLineage: (
    taskId: string,
    entry: WorkspaceConfigEntry
  ) => Promise<{ proven: boolean; reason: string }>;
  emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
  writeSettlementReceipt: (...args: unknown[]) => Promise<boolean>;
  workspaceEventLocks: { withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T> };
  streamEndDecisionsByTaskId: Map<string, Array<{ attemptId: string; outcome: string }>>;
}
const internals = (service: TaskService) => service as unknown as Internals;

describe("TaskService settlement receipt producers (G2)", () => {
  let rootDir: string;
  let fixture: Awaited<ReturnType<typeof createTestHistoryService>>;
  let restoreTimers: (() => void) | undefined;

  beforeEach(async () => {
    fixture = await createTestHistoryService();
    rootDir = fixture.tempDir;
  });
  afterEach(async () => {
    restoreTimers?.();
    restoreTimers = undefined;
    await fixture.cleanup();
  });

  async function setupTree(
    children: Array<{ id: string; overrides?: Partial<WorkspaceConfigEntry> }>
  ): Promise<{ config: Config; projectPath: string }> {
    const config = fixture.config;
    await fsPromises.mkdir(config.srcDir, { recursive: true });
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    const task = (
      id: string,
      parentWorkspaceId: string,
      overrides?: Partial<WorkspaceConfigEntry>
    ) =>
      projectWorkspace(projectPath, id, id, {
        parentWorkspaceId,
        agentType: "explore",
        agentId: "explore",
        taskStatus: "running",
        taskModelString: "openai:gpt-5.2",
        runtimeConfig: { type: "local" },
        ...overrides,
      });
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId, { runtimeConfig: { type: "local" } }),
        task(midId, rootId),
        ...children.map(({ id, overrides }) => task(id, midId, overrides)),
      ],
      testTaskSettings(4, 3)
    );
    return { config, projectPath };
  }

  function createHarness(
    config: Config,
    overrides?: {
      aiService?: ReturnType<typeof createAIServiceMocks>["aiService"];
      workspaceService?: ReturnType<typeof createWorkspaceServiceMocks>["workspaceService"];
    }
  ) {
    const aiService = overrides?.aiService ?? createAIServiceMocks(config).aiService;
    const workspaceService =
      overrides?.workspaceService ?? createWorkspaceServiceMocks().workspaceService;
    const initStateManager = createMockInitStateManager();
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const taskService = new TaskService(
      config,
      fixture.historyService,
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
        fixture.historyService,
        aiService,
        workspaceService,
        initStateManager,
        taskService,
        terminalAttentionStore,
        aiService as unknown as ConstructorParameters<typeof WorkspaceTurnManager>[7]
      )
    );
    return { taskService, svc: internals(taskService) };
  }

  /** Fire the closure-settle wait immediately (see the G1 suite's shortenTerminationTimers). */
  function shortenClosureSettleWait(): void {
    const originalSetTimeout = globalThis.setTimeout;
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (
        timeout != null &&
        timeout <= ATTEMPT_CLOSURE_SETTLE_WAIT_MS &&
        timeout > ATTEMPT_CLOSURE_SETTLE_WAIT_MS - 100
      ) {
        return originalSetTimeout(() => {
          setSystemTime(new Date(Date.now() + timeout));
          handler();
        }, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);
    restoreTimers = () => {
      spy.mockRestore();
      setSystemTime();
    };
  }

  async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
  }

  const entryOf = (config: Config, id: string) => findWorkspaceInConfig(config, id);
  const ownerDir = (config: Config, ownerId: string) => path.join(config.sessionsDir, ownerId);
  function entryWithProject(config: Config, id: string) {
    for (const [projectPath, project] of config.loadConfigOrDefault().projects) {
      const workspace = project.workspaces.find((w) => w.id === id);
      if (workspace) return { projectPath, workspace };
    }
    throw new Error(`workspace ${id} not found`);
  }

  /**
   * Seed a receipt for the child's persisted predecessor in the parent's dir, then reawaken: the
   * successor is owned by this process with PROVEN lineage (receipt-eligible). Returns its id.
   */
  async function ownEligibleAttempt(
    config: Config,
    taskService: TaskService,
    taskId: string
  ): Promise<string> {
    const seeded = await writeSubagentAttemptSettlementReceipt({
      ownerWorkspaceSessionDirs: [ownerDir(config, midId)],
      receipt: {
        taskId,
        attemptId: PREDECESSOR,
        parentWorkspaceId: midId,
        source: "idle-settled",
        settledAt: "2026-09-25T00:00:00.000Z",
      },
    });
    expect(seeded.success).toBe(true);
    expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
    const attemptId = entryOf(config, taskId)!.taskAttemptId!;
    expect(internals(taskService).ownedAttemptByTaskId.get(taskId)).toMatchObject({
      attemptId,
      receiptEligible: true,
    });
    return attemptId;
  }

  /** The receipt files present for `taskId` in `ownerId`'s dir (attempt ids, sorted). */
  async function receiptFiles(config: Config, ownerId: string, taskId: string): Promise<string[]> {
    const dir = path.dirname(
      getSubagentAttemptSettlementReceiptPath(ownerDir(config, ownerId), taskId, PREDECESSOR)
    );
    try {
      return (await fsPromises.readdir(dir)).map((name) => name.replace(/\.json$/, "")).sort();
    } catch {
      return [];
    }
  }

  /**
   * A receipt naming exactly `attemptId` exists in every owner dir, and the producer wrote no
   * other file (the parent's dir may also hold the seeded predecessor receipt).
   */
  async function expectReceiptEverywhere(
    config: Config,
    taskId: string,
    attemptId: string,
    source: SubagentAttemptSettlementSource,
    seeded: boolean
  ): Promise<void> {
    for (const owner of OWNERS) {
      const read = await readSubagentAttemptSettlementReceiptStrict(
        ownerDir(config, owner),
        taskId,
        attemptId
      );
      expect(read).toMatchObject({
        kind: "found",
        receipt: { taskId, attemptId, parentWorkspaceId: midId, source },
      });
      const expected = seeded && owner === midId ? [attemptId, PREDECESSOR] : [attemptId];
      expect(await receiptFiles(config, owner, taskId)).toEqual(expected.sort());
    }
  }

  async function expectNoReceipt(config: Config, taskId: string, attemptId: string) {
    for (const owner of OWNERS) {
      expect(
        await readSubagentAttemptSettlementReceiptStrict(ownerDir(config, owner), taskId, attemptId)
      ).toEqual({ kind: "not_found" });
    }
  }

  /** Mocks for a reserved launch that never reaches a real runtime. */
  function stubMaterialize(svc: Internals, projectPath: string) {
    spyOn(svc, "cleanupMaterializedTaskWorkspace").mockImplementation(() => Promise.resolve());
    return spyOn(svc, "materializeReservedTaskWorkspace").mockImplementation(() =>
      Promise.resolve({
        workspacePath: projectPath,
        trunkBranch: "main",
        forkedRuntimeConfig: { type: "local" },
        runtimeForTaskWorkspace: {
          deleteWorkspace: mock(() => Promise.resolve(Ok(undefined))),
          getWorkspacePath: () => "/tmp/receipts",
        },
        inheritedProjects: undefined,
      })
    );
  }

  const spawn = {
    parentWorkspaceId: midId,
    kind: "agent",
    agentId: "explore",
    prompt: "go",
    title: "T",
  } as const;

  describe("one receipt per producer", () => {
    test("idle user Stop writes the receipt before recording the settlement", async () => {
      const taskId = "idlestop";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: {
            taskStatus: "interrupted",
            taskAttemptId: PREDECESSOR,
            taskDesktopOwnerWorkspaceId: rootId,
          },
        },
      ]);
      const { taskService, svc } = createHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      await svc.releaseSharedDesktopTaskOnUserStop(taskId, svc.resolveStreamAttemptAtEvent(taskId));
      expect(entryOf(config, taskId)?.taskStatus).toBe("interrupted");
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "user-stop-idle",
      });
      await expectReceiptEverywhere(config, taskId, attemptId, "idle-settled", true);
    });

    test("idle terminal failure writes the receipt", async () => {
      const taskId = "idlefailure";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
      ]);
      const { taskService, svc } = createHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      await svc.failAgentTaskTerminally(
        taskId,
        entryWithProject(config, taskId),
        { errorType: "provider", errorMessage: "boom" },
        { expectedAttemptId: attemptId }
      );
      expect(entryOf(config, taskId)?.taskStatus).toBe("interrupted");
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "terminal-failure",
      });
      await expectReceiptEverywhere(config, taskId, attemptId, "idle-settled", true);
    });

    test("stop-record release: the receipt is durable before the latch releases", async () => {
      const taskId = "stoprecord";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
      ]);
      const { taskService, svc } = createHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      const parentReceipt = getSubagentAttemptSettlementReceiptPath(
        ownerDir(config, midId),
        taskId,
        attemptId
      );
      const stopped = await taskService.stopDescendantAgentTask(rootId, taskId);
      expect(stopped.success).toBe(true);
      // Observed at the first moment the latch is gone: the receipt already exists.
      let receiptAtRelease: boolean | undefined;
      await waitForCondition(() => {
        if (taskService.isWorkspaceStopInProgress(taskId)) return false;
        receiptAtRelease ??= existsSync(parentReceipt);
        return true;
      });
      expect(receiptAtRelease).toBe(true);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "stop-settled",
      });
      expect(
        await taskService.readAttemptOutcome(taskId, { requestingWorkspaceId: midId })
      ).toEqual({
        kind: "terminal-no-report",
      });
      await expectReceiptEverywhere(config, taskId, attemptId, "execution-settled", true);
    });

    test("reservation canceled inside the commit writes the receipt", async () => {
      const spawnedId = "reservecanceled";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService, svc } = createHarness(config);
      const launch = spyOn(svc, "startReservedAgentTask").mockImplementation(() =>
        Promise.resolve()
      );
      const controller = new AbortController();
      const created = await taskService.createMany([spawn], {
        abortSignal: controller.signal,
        onTaskReserved: () => controller.abort(),
      });
      expect(created.success).toBe(false);
      expect(launch).not.toHaveBeenCalled();
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "reservation-canceled",
      });
      await expectReceiptEverywhere(config, spawnedId, attemptId, "reservation-canceled", false);
    });

    test("reservation failed after its commit landed writes the receipt; one never committed writes none", async () => {
      const spawnedId = "reservefailed";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService, svc } = createHarness(config);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      // The commit's write is durable, but the call reports failure (e.g. a post-write error).
      const editConfig = config.editConfig.bind(config);
      const editSpy = spyOn(config, "editConfig").mockImplementationOnce(async (...args) => {
        await editConfig(...args);
        throw new Error("disk hiccup after write");
      });
      const created = await taskService.createMany([spawn]);
      editSpy.mockRestore();
      expect(created.success).toBe(false);
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "reservation-failed",
      });
      await expectReceiptEverywhere(config, spawnedId, attemptId, "reservation-failed", false);

      // Control: a checkpoint callback failing before the commit leaves no row, so no receipt.
      const neverCommitted = "reservenever";
      stubStableIds(config, [neverCommitted]);
      const failed = await taskService.createMany([spawn], {
        onTaskReserved: () => {
          throw new Error("checkpoint failed");
        },
      });
      expect(failed.success).toBe(false);
      expect(entryOf(config, neverCommitted)).toBeUndefined();
      expect(await receiptFiles(config, midId, neverCommitted)).toEqual([]);
    });

    test.each(["never-sent", "sent"] as const)(
      "a reserved launch that fails (%s) writes a receipt only when its send was never admitted",
      async (variant) => {
        const spawnedId = variant === "sent" ? "launchsent" : "launchnever";
        const { config, projectPath } = await setupTree([]);
        stubStableIds(config, [spawnedId]);
        const { workspaceService } = createWorkspaceServiceMocks({
          sendMessage: mock(
            (): Promise<Result<void>> => Promise.resolve(Err("provider unavailable"))
          ),
        });
        spyOn(workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(() =>
          Promise.resolve(undefined)
        );
        const { taskService, svc } = createHarness(config, { workspaceService });
        const materialize = stubMaterialize(svc, projectPath);
        if (variant === "never-sent") {
          materialize.mockImplementation(() => Promise.reject(new Error("fork failed")));
        }
        const created = await taskService.createMany([spawn]);
        expect(created.success).toBe(true);
        await waitForCondition(() => entryOf(config, spawnedId)?.taskStatus === "interrupted");
        const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
        await waitForCondition(
          () => svc.attemptSettlementByTaskId.get(spawnedId)?.phase === "settled"
        );
        expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
          attemptId,
          source: "launch-failed",
        });
        if (variant === "never-sent") {
          await expectReceiptEverywhere(config, spawnedId, attemptId, "launch-failed", false);
        } else {
          // Err after the fence admitted the send does not prove nothing ran: in-memory only.
          await expectNoReceipt(config, spawnedId, attemptId);
        }
      }
    );
  });

  describe("crash cut", () => {
    test.each([
      ["idle stop", midId],
      ["idle stop", rootId],
      ["stop record", midId],
      ["stop record", rootId],
    ] as const)(
      "%s: a failed receipt write in %s's dir leaves the attempt closing, never settled, and proves nothing",
      async (producer, failingOwner) => {
        const taskId = producer === "idle stop" ? "cutidle" : "cutrecord";
        const { config } = await setupTree([
          {
            id: taskId,
            overrides: {
              taskStatus: "interrupted",
              taskAttemptId: PREDECESSOR,
              taskDesktopOwnerWorkspaceId: rootId,
            },
          },
        ]);
        const { taskService, svc } = createHarness(config);
        const attemptId = await ownEligibleAttempt(config, taskService, taskId);
        // A regular file where the receipts dir must be: every write under it fails (ENOTDIR).
        const blocker = path.join(ownerDir(config, failingOwner), "subagent-attempt-settlements");
        await fsPromises.rm(blocker, { recursive: true, force: true });
        await fsPromises.mkdir(path.dirname(blocker), { recursive: true });
        await fsPromises.writeFile(blocker, "not a directory", "utf-8");

        if (producer === "idle stop") {
          await svc.releaseSharedDesktopTaskOnUserStop(
            taskId,
            svc.resolveStreamAttemptAtEvent(taskId)
          );
        } else {
          expect((await taskService.stopDescendantAgentTask(rootId, taskId)).success).toBe(true);
          // A failed write still releases the latch (no latch pinned until restart).
          await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
          expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
        }
        expect(entryOf(config, taskId)?.taskStatus).toBe("interrupted");
        expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
          attemptId,
          phase: "closing",
        });
        expect(
          await taskService.readAttemptOutcome(taskId, { requestingWorkspaceId: midId })
        ).toEqual({
          kind: "cleanup-pending",
        });
        // The parent's copy is written last: absent whichever owner failed.
        expect(
          await readSubagentAttemptSettlementReceiptStrict(
            ownerDir(config, midId),
            taskId,
            attemptId
          )
        ).toMatchObject({ kind: failingOwner === midId ? "unreadable" : "not_found" });
        if (failingOwner === rootId) {
          await fsPromises.rm(blocker);
          await expectNoReceipt(config, taskId, attemptId);
        }

        // Another process (a second Config on the same root) finds no proof for the attempt.
        const other = createHarness(await createTestConfig(rootDir));
        const row = findWorkspaceInConfig(await createTestConfig(rootDir), taskId)!;
        expect((await other.svc.evaluateAttemptLineage(taskId, row)).proven).toBe(false);
        // Nor does this process: the closing entry never upgrades, so a reawaken waits out the
        // bound and then marks the successor unproven.
        shortenClosureSettleWait();
        expect(await taskService.markInterruptedTaskRunning(taskId)).toBe(true);
        expect(svc.ownedAttemptByTaskId.get(taskId)?.receiptEligible).toBe(false);
        expect(entryOf(config, taskId)?.taskAttemptUnproven).toBe(true);
      }
    );
  });

  test.each(["idle stop", "stop record"] as const)(
    "%s: an unreadable config at the receipt decision fails closed — closing, no receipt, unproven",
    async (producer) => {
      const taskId = producer === "idle stop" ? "unreadableidle" : "unreadablerecord";
      const { config } = await setupTree([
        {
          id: taskId,
          overrides: {
            taskStatus: "interrupted",
            taskAttemptId: PREDECESSOR,
            taskDesktopOwnerWorkspaceId: rootId,
          },
        },
      ]);
      const { taskService, svc } = createHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      // config.json becomes unparseable exactly when the producer reaches its receipt decision
      // (after its own status write): lenient reads then see an empty default config — no row,
      // which must not be mistaken for a confirmed superseded row — and strict reads throw.
      const configPath = configFilePath(config.rootDir);
      const goodBytes = await fsPromises.readFile(configPath);
      const decider = svc as unknown as {
        decideSettlementReceipt: (...args: unknown[]) => unknown;
      };
      const decide = decider.decideSettlementReceipt;
      const decideSpy = spyOn(decider, "decideSettlementReceipt").mockImplementation(
        (...args: unknown[]) => {
          writeFileSync(configPath, "{ not json", "utf-8");
          return decide.apply(taskService, args);
        }
      );

      if (producer === "idle stop") {
        await svc.releaseSharedDesktopTaskOnUserStop(
          taskId,
          svc.resolveStreamAttemptAtEvent(taskId)
        );
      } else {
        expect((await taskService.stopDescendantAgentTask(rootId, taskId)).success).toBe(true);
        // The failed decision still releases the latch (nothing pinned until restart).
        await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
      }
      expect(decideSpy).toHaveBeenCalledTimes(1);
      decideSpy.mockRestore();
      await fsPromises.writeFile(configPath, goodBytes);

      expect(entryOf(config, taskId)?.taskAttemptId).toBe(attemptId);
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "closing",
      });
      expect(
        await taskService.readAttemptOutcome(taskId, { requestingWorkspaceId: midId })
      ).toEqual({ kind: "cleanup-pending" });
      await expectNoReceipt(config, taskId, attemptId);
      const otherConfig = await createTestConfig(rootDir);
      const other = createHarness(otherConfig);
      expect(
        (await other.svc.evaluateAttemptLineage(taskId, entryOf(otherConfig, taskId)!)).proven
      ).toBe(false);
    }
  );

  test("idle Stop rejects its own waiters, never a successor's registered during the receipt write", async () => {
    const taskId = "waiterrace";
    const successor = "att_00000000000000b3";
    const { config } = await setupTree([
      {
        id: taskId,
        overrides: {
          taskStatus: "interrupted",
          taskAttemptId: PREDECESSOR,
          taskDesktopOwnerWorkspaceId: rootId,
        },
      },
    ]);
    const { taskService, svc } = createHarness(config);
    await ownEligibleAttempt(config, taskService, taskId);
    const pendingWaiters = () =>
      (
        svc as unknown as { pendingWaitersByTaskId: Map<string, unknown[]> }
      ).pendingWaitersByTaskId.get(taskId)?.length ?? 0;
    const settledOf = (promise: Promise<unknown>) => {
      const state: { settled?: "resolved" | "rejected"; error?: unknown } = {};
      promise.then(
        () => (state.settled = "resolved"),
        (error: unknown) => {
          state.settled = "rejected";
          state.error = error;
        }
      );
      return state;
    };
    // A waiter of the attempt being stopped.
    const stoppedAttemptWaiter = settledOf(
      taskService.waitForAgentReport(taskId, { timeoutMs: 10_000 })
    );
    await waitForCondition(() => pendingWaiters() === 1);

    // Hold the idle Stop's receipt write.
    const gate = Promise.withResolvers<void>();
    let writing = false;
    const write = svc.writeSettlementReceipt.bind(taskService);
    spyOn(svc, "writeSettlementReceipt").mockImplementation(async (...args: unknown[]) => {
      writing = true;
      await gate.promise;
      return write(...args);
    });
    const stop = svc.releaseSharedDesktopTaskOnUserStop(
      taskId,
      svc.resolveStreamAttemptAtEvent(taskId)
    );
    await waitForCondition(() => writing);

    // Meanwhile another backend re-admits the interrupted row as a successor, and a new
    // task_await registers for it.
    await (
      await createTestConfig(rootDir)
    ).editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const ws = project.workspaces.find((w) => w.id === taskId);
        if (ws) {
          ws.taskStatus = "running";
          ws.taskAttemptId = successor;
          ws.taskAttemptUnproven = true;
        }
      }
      return cfg;
    });
    const waitersBefore = pendingWaiters();
    const abortSuccessorWait = new AbortController();
    const successorWaiter = settledOf(
      taskService.waitForAgentReport(taskId, {
        timeoutMs: 10_000,
        abortSignal: abortSuccessorWait.signal,
      })
    );
    await waitForCondition(() => pendingWaiters() === waitersBefore + 1);

    gate.resolve();
    await stop;
    await new Promise((resolve) => setImmediate(resolve));
    expect(stoppedAttemptWaiter.settled).toBe("rejected");
    expect(String(stoppedAttemptWaiter.error)).toContain("Task interrupted");
    // The successor's waiter is untouched by the stopped attempt's settlement.
    expect(successorWaiter.settled).toBeUndefined();
    expect(pendingWaiters()).toBe(1);
    abortSuccessorWait.abort();
    await waitForCondition(() => successorWaiter.settled != null);
  });

  test("a successor another backend admitted never receives the predecessor's receipt", async () => {
    const taskId = "rotated";
    const successor = "att_00000000000000b2";
    const { config } = await setupTree([
      { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
    ]);
    const { taskService, svc } = createHarness(config);
    const predecessor = await ownEligibleAttempt(config, taskService, taskId);
    // Backend B rotates the row through its own Config (#4450 harness shape).
    const otherBackend = await createTestConfig(rootDir);
    await otherBackend.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const ws = project.workspaces.find((w) => w.id === taskId);
        if (ws) ws.taskAttemptId = successor;
      }
      return cfg;
    });
    expect((await taskService.stopDescendantAgentTask(rootId, taskId)).success).toBe(true);
    await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
    expect(svc.workspaceStopRecords.has(taskId)).toBe(false);
    expect(entryOf(config, taskId)?.taskAttemptId).toBe(successor);
    // Neither id gets a receipt: the predecessor's settlement vouches only while the row names it.
    await expectNoReceipt(config, taskId, successor);
    await expectNoReceipt(config, taskId, predecessor);
    const other = createHarness(await createTestConfig(rootDir));
    expect(
      (await other.svc.evaluateAttemptLineage(taskId, entryOf(otherBackend, taskId)!)).proven
    ).toBe(false);
  });

  describe("lineage now that receipts exist", () => {
    test("another process proves a successor from a producer's receipt; a marked attempt stays unproven", async () => {
      const eligible = "lineageeligible";
      const marked = "lineagemarked";
      const { config } = await setupTree([
        { id: eligible, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
        {
          id: marked,
          overrides: { taskStatus: "interrupted", taskAttemptId: "att_00000000000000e1" },
        },
      ]);
      const first = createHarness(config);
      const eligibleAttempt = await ownEligibleAttempt(config, first.taskService, eligible);
      // No receipt for the marked child's predecessor: its reawakened attempt is ineligible.
      expect(await first.taskService.markInterruptedTaskRunning(marked)).toBe(true);
      const markedAttempt = entryOf(config, marked)!.taskAttemptId!;
      expect(first.svc.ownedAttemptByTaskId.get(marked)?.receiptEligible).toBe(false);
      await first.taskService.terminateAllDescendantAgentTasks(midId);
      await waitForCondition(
        () =>
          !first.taskService.isWorkspaceStopInProgress(eligible) &&
          !first.taskService.isWorkspaceStopInProgress(marked)
      );
      await expectNoReceipt(config, marked, markedAttempt);

      // A fresh process (restart): before receipt producers, every predecessor was unproven here.
      const restartedConfig = await createTestConfig(rootDir);
      const restarted = createHarness(restartedConfig);
      expect(
        await restarted.svc.evaluateAttemptLineage(eligible, entryOf(restartedConfig, eligible)!)
      ).toEqual({ proven: true, reason: "settlement receipt found" });
      expect(await restarted.taskService.markInterruptedTaskRunning(eligible)).toBe(true);
      expect(restarted.svc.ownedAttemptByTaskId.get(eligible)?.receiptEligible).toBe(true);
      expect(entryOf(restartedConfig, eligible)?.taskAttemptUnproven).toBeUndefined();
      expect(entryOf(restartedConfig, eligible)?.taskAttemptId).not.toBe(eligibleAttempt);

      expect(
        (await restarted.svc.evaluateAttemptLineage(marked, entryOf(restartedConfig, marked)!))
          .proven
      ).toBe(false);
      expect(await restarted.taskService.markInterruptedTaskRunning(marked)).toBe(true);
      expect(restarted.svc.ownedAttemptByTaskId.get(marked)?.receiptEligible).toBe(false);
      expect(entryOf(restartedConfig, marked)?.taskAttemptUnproven).toBe(true);
    });
  });

  describe("no-report boundary (attemptCannotStillReport)", () => {
    function admit(taskService: TaskService, taskId: string) {
      return taskService.admitTaskWorkspaceTurn(taskId, { acceptanceOrigin: "manual" });
    }

    test("a send admitted between the reservation commit and its cancel keeps the attempt memory-only", async () => {
      const spawnedId = "cancelracesend";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService, svc } = createHarness(config);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      const controller = new AbortController();
      let token: TurnAdmissionToken | undefined;
      const emit = svc.emitWorkspaceMetadata.bind(taskService);
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
        await emit(id);
        // Committed and published, not yet canceled: a send is admitted (and stays pending).
        if (id === spawnedId && token == null) {
          const admission = admit(taskService, spawnedId);
          expect(admission.kind).toBe("admitted");
          if (admission.kind === "admitted") token = admission.token;
          controller.abort();
        }
      });
      const created = await taskService.createMany([spawn], { abortSignal: controller.signal });
      expect(created.success).toBe(false);
      expect(token).toBeDefined();
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      expect(entryOf(config, spawnedId)?.taskStatus).toBe("interrupted");
      // The obligation may still run toward a report: settled in memory only, no durable claim.
      expect(svc.attemptSettlementByTaskId.get(spawnedId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "reservation-canceled",
      });
      await expectNoReceipt(config, spawnedId, attemptId);
      token?.onDisposed("refused");
    });

    test("a send attempted once the cancel began is refused, and the receipt follows", async () => {
      const spawnedId = "cancelthensend";
      const { config } = await setupTree([]);
      stubStableIds(config, [spawnedId]);
      const { taskService, svc } = createHarness(config);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      const controller = new AbortController();
      const emit = svc.emitWorkspaceMetadata.bind(taskService);
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
        await emit(id);
        if (id === spawnedId) controller.abort();
      });
      let raced: ReturnType<typeof admit> | undefined;
      const edit = taskService.editWorkspaceEntry.bind(taskService);
      spyOn(taskService, "editWorkspaceEntry").mockImplementation(async (id, updater, options) => {
        // The cancel's per-plan status edit: the attempt is already closed.
        if (id === spawnedId && controller.signal.aborted && raced == null) {
          raced = admit(taskService, spawnedId);
        }
        return edit(id, updater, options);
      });
      const created = await taskService.createMany([spawn], { abortSignal: controller.signal });
      expect(created.success).toBe(false);
      expect(raced).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      const attemptId = entryOf(config, spawnedId)!.taskAttemptId!;
      await expectReceiptEverywhere(config, spawnedId, attemptId, "reservation-canceled", false);
    });

    test("in a batch cancel, a send racing an earlier plan's receipt write is refused for the later plan", async () => {
      const first = "batchfirst";
      const second = "batchsecond";
      const { config } = await setupTree([]);
      stubStableIds(config, [first, second]);
      const { taskService, svc } = createHarness(config);
      spyOn(svc, "startReservedAgentTask").mockImplementation(() => Promise.resolve());
      const controller = new AbortController();
      const emit = svc.emitWorkspaceMetadata.bind(taskService);
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
        await emit(id);
        if (id === second) controller.abort();
      });
      let raced: ReturnType<typeof admit> | undefined;
      const write = svc.writeSettlementReceipt.bind(taskService);
      spyOn(svc, "writeSettlementReceipt").mockImplementation(async (...args: unknown[]) => {
        // The first plan's receipt write: the second plan's attempt was closed with the batch.
        if (args[0] === first) raced = admit(taskService, second);
        return write(...args);
      });
      const created = await taskService.createMany([spawn, spawn], {
        abortSignal: controller.signal,
      });
      expect(created.success).toBe(false);
      expect(raced).toEqual({
        kind: "refused",
        message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
      });
      // Nothing could gain work under either attempt, so both receipts are sound.
      for (const id of [first, second]) {
        const attemptId = entryOf(config, id)!.taskAttemptId!;
        await expectReceiptEverywhere(config, id, attemptId, "reservation-canceled", false);
      }
    });

    /** A harness whose AI service delivers real stream-end events to TaskService's listener. */
    function createStreamHarness(config: Config) {
      const emitter = new EventEmitter();
      const { aiService } = createAIServiceMocks(config, {
        on: mock((event: string, listener: (payload: unknown) => void) => {
          emitter.on(event, listener);
        }),
      });
      return { ...createHarness(config, { aiService }), emitter };
    }

    function streamEnd(taskId: string, messageId: string, reportMarkdown?: string) {
      return {
        type: "stream-end",
        workspaceId: taskId,
        messageId,
        metadata: { model: "openai:gpt-5.2", finishReason: "stop" },
        parts:
          reportMarkdown == null
            ? [{ type: "text", text: "still working" }]
            : [
                {
                  type: "dynamic-tool",
                  toolCallId: `${messageId}-report`,
                  toolName: "agent_report",
                  input: { reportMarkdown },
                  state: "output-available",
                  output: { success: true, report: { reportMarkdown } },
                },
                { type: "text", text: reportMarkdown },
              ],
      };
    }

    test("a Stop racing a natural stream end holds its receipt until the decision resolves nonreport", async () => {
      const taskId = "stopracenonreport";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
      ]);
      const { taskService, svc, emitter } = createStreamHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      // Hold the task's event lock: the stream-end decision registers in the event's own tick and
      // stays pending while the handler waits for the lock.
      const gate = Promise.withResolvers<void>();
      const held = svc.workspaceEventLocks.withLock(taskId, () => gate.promise);
      emitter.emit("stream-end", streamEnd(taskId, "assistant-1"));
      expect(svc.streamEndDecisionsByTaskId.get(taskId)?.map((d) => d.outcome)).toEqual([
        "pending",
      ]);
      expect((await taskService.stopDescendantAgentTask(rootId, taskId)).success).toBe(true);
      // Every other release condition holds once the cleanup paid back; the pending decision
      // alone keeps the latch, and no receipt write has even begun.
      const record = () =>
        svc.workspaceStopRecords.get(taskId) as
          | { cleanupInFlight: number; receipt?: string }
          | undefined;
      await waitForCondition(() => record()?.cleanupInFlight === 0);
      expect(record()?.receipt).toBeUndefined();
      expect(taskService.isWorkspaceStopInProgress(taskId)).toBe(true);
      await expectNoReceipt(config, taskId, attemptId);
      gate.resolve();
      await held;
      await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
      expect(svc.attemptSettlementByTaskId.get(taskId)).toMatchObject({
        attemptId,
        phase: "settled",
        source: "stop-settled",
      });
      await expectReceiptEverywhere(config, taskId, attemptId, "execution-settled", true);
    });

    test("a Stop racing a stream end that publishes the report releases without a receipt", async () => {
      const taskId = "stoprace-published";
      const { config } = await setupTree([
        { id: taskId, overrides: { taskStatus: "interrupted", taskAttemptId: PREDECESSOR } },
      ]);
      const { taskService, svc, emitter } = createStreamHarness(config);
      const attemptId = await ownEligibleAttempt(config, taskService, taskId);
      // Hold the handler right after it persisted `reported`, decision still pending.
      const gate = Promise.withResolvers<void>();
      let blocked = false;
      const emit = svc.emitWorkspaceMetadata.bind(taskService);
      spyOn(svc, "emitWorkspaceMetadata").mockImplementation(async (id: string) => {
        if (id === taskId && entryOf(config, taskId)?.taskStatus === "reported" && !blocked) {
          blocked = true;
          await gate.promise;
        }
        return emit(id);
      });
      emitter.emit("stream-end", streamEnd(taskId, "assistant-1", "done"));
      await waitForCondition(() => blocked);
      expect(svc.streamEndDecisionsByTaskId.get(taskId)?.map((d) => d.outcome)).toEqual([
        "pending",
      ]);
      expect((await taskService.stopDescendantAgentTask(rootId, taskId)).success).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      await expectNoReceipt(config, taskId, attemptId);
      gate.resolve();
      await waitForCondition(() => !taskService.isWorkspaceStopInProgress(taskId));
      await waitForCondition(() => !svc.streamEndDecisionsByTaskId.has(taskId));
      expect(entryOf(config, taskId)).toMatchObject({
        taskStatus: "reported",
        taskAttemptId: attemptId,
      });
      await expectNoReceipt(config, taskId, attemptId);
    });
  });
});
