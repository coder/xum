import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import {
  isActiveWorkspaceTurnTaskStatus,
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  finalizeWorkspaceTurnStreamEndForTest,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import {
  workspaceTurnOwnerLockPath,
  type WorkspaceTurnManager,
} from "@/node/services/workspaceTurnManager";
import { registerLiveWorkspaceTurnHandle } from "@/node/services/taskService.shared.testHarness";
import {
  createAIServiceMocks,
  createTaskServiceStack,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";
import type { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import type { StreamManager } from "@/node/services/streamManager";
import { Err } from "@/common/types/result";
import type { Config } from "@/node/config";

/**
 * #4446: a workspace-turn handle's liveness lives in the memory of the backend that runs it. With
 * two backends on one Xum root (desktop beside `xum server`, XUM_ALLOW_MULTIPLE_INSTANCES=1),
 * another backend must never judge that handle stale while its owner is alive. Each backend here
 * is a real WorkspaceTurnManager on its own Config instance for the same root.
 */
describe("workspace-turn handles owned by another live backend (#4446)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-turn-owner-"));
  });
  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  const internals = (manager: WorkspaceTurnManager) =>
    manager as unknown as {
      taskHandleStore: TaskHandleStore;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

  const exists = (file: string) =>
    fsPromises.access(file).then(
      () => true,
      () => false
    );

  /** The owner process died: its lock record names a token no live process holds. */
  async function markTurnOwnerDead(handleId: string): Promise<void> {
    const lockPath = workspaceTurnOwnerLockPath(rootDir, handleId);
    const record = JSON.parse(await fsPromises.readFile(lockPath, "utf-8")) as object;
    await fsPromises.writeFile(lockPath, JSON.stringify({ ...record, token: "dead-owner" }));
  }

  test("another backend's count never settles a handle its live owner runs", async () => {
    const { config, parentId, taskService: backendA } = await startWorkspaceTurnForTest(rootDir);
    const { taskService: backendB } = createWorkspaceTurnManagerHarness(
      await createTestConfig(rootDir)
    );
    const writesB = spyOn(internals(backendB).taskHandleStore, "upsertWorkspaceTurn");

    // B's task-creation path counts active turns; A's turn is not live in B's memory, but A's
    // live lock keeps it active for B too (B must not admit past it or finish without it).
    expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(1);
    expect(await backendB.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toEqual(["wst_handle"]);

    expect(writesB).not.toHaveBeenCalled();
    expect(
      await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
    ).toMatchObject({ status: "running" });
    expect(await workspaceTurnSnapshot(backendA, parentId)).toMatchObject({ status: "running" });
  });

  test("another backend settles a handle whose owner died, as after a restart", async () => {
    const { parentId } = await startWorkspaceTurnForTest(rootDir);
    await markTurnOwnerDead("wst_handle");
    const { taskService: backendB } = createWorkspaceTurnManagerHarness(
      await createTestConfig(rootDir)
    );

    expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(0);

    expect(await workspaceTurnSnapshot(backendB, parentId)).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
    });
    expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_handle"))).toBe(false);
  });

  test("the owner releases its lock once the handle settles", async () => {
    const { parentId, taskService: backendA } = await startWorkspaceTurnForTest(rootDir);
    const lockPath = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
    expect(await exists(lockPath)).toBe(true);
    // Restart-style recovery inside the owner: its registration is gone, so it settles its own handle.
    (
      backendA as unknown as { activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown> }
    ).activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await workspaceTurnSnapshot(backendA, parentId)).toMatchObject({
      status: "interrupted",
    });
    expect(await exists(lockPath)).toBe(false);
  });

  test("startup adoption skips a persistent child's handle that a live backend runs", async () => {
    const configA = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      configA,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child", "task-child", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_live_elsewhere",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    // Backend A runs the handle (live registration), then its startup adoption takes the lock.
    const stackA = createTaskServiceStack(configA);
    await registerLiveWorkspaceTurnHandle(stackA.taskService, "task-child", "wst_live_elsewhere");
    await registerLiveWorkspaceTurnHandle(
      stackA.taskService,
      "task-child",
      "wst_live_elsewhere",
      "tree-root",
      "recovered"
    );

    // Backend B starts on the same root while A is alive.
    const managerB = workspaceTurnManagerFor(
      createTaskServiceStack(await createTestConfig(rootDir)).taskService
    );
    await managerB.reconcileAgentTaskExecutionIds();
    // B neither adopts A's live handle nor settles it as a restart leftover.
    expect(managerB.getLiveWorkspaceTurnRegistration("task-child")).toBeUndefined();
    expect(
      await new TaskHandleStore(configA).getWorkspaceTurn("tree-root", "wst_live_elsewhere")
    ).toMatchObject({ status: "running" });
    expect(
      workspaceTurnManagerFor(stackA.taskService).getLiveWorkspaceTurnRegistration("task-child")
        ?.handleId
    ).toBe("wst_live_elsewhere");
  });

  test("revival leaves a terminal handle's durable state alone while a live backend holds its lock", async () => {
    // A still holds the lock (live); the durable record reads terminal (e.g. a torn settlement).
    const { config, parentId } = await startWorkspaceTurnForTest(rootDir);
    const store = new TaskHandleStore(config);
    const running = await store.getWorkspaceTurn(parentId, "wst_handle");
    expect(running).not.toBeNull();
    const settled: WorkspaceTurnTaskHandleRecord = {
      ...running!,
      status: "interrupted",
      updatedAt: new Date(Date.parse(running!.updatedAt) + 1000).toISOString(),
      error: "interrupted",
    };
    await store.upsertWorkspaceTurn(settled);
    const { taskService: backendB } = createWorkspaceTurnManagerHarness(
      await createTestConfig(rootDir)
    );
    const b = backendB as unknown as {
      terminalAttentionStore: TerminalAttentionStore;
      reviveRetryingWorkspaceTurn: (
        record: WorkspaceTurnTaskHandleRecord
      ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
    };
    const attentionDeletes = spyOn(b.terminalAttentionStore, "delete");
    const writesB = spyOn(internals(backendB).taskHandleStore, "upsertWorkspaceTurn");

    expect(await b.reviveRetryingWorkspaceTurn(settled)).toMatchObject({ status: "interrupted" });

    // B must not erase A's terminal attention or revive the handle it does not own.
    expect(attentionDeletes).not.toHaveBeenCalled();
    expect(writesB).not.toHaveBeenCalled();
  });

  test("startup adoption that loses to a newer execution gives the dead owner's lock back", async () => {
    const configA = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspaces(
      configA,
      projectPath,
      [
        projectWorkspace(projectPath, "root", "tree-root"),
        projectWorkspace(projectPath, "child", "task-child", {
          parentWorkspaceId: "tree-root",
          taskStatus: "reported",
          taskExecutionId: "wst_dead_owner",
          taskExecutionStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    // The handle's owner died: the record reads running and nobody holds its lock.
    await new TaskHandleStore(configA).upsertWorkspaceTurn(
      workspaceTurnRecord("tree-root", "task-child", "wst_dead_owner", "running", {
        turnId: "wst_dead_owner-turn",
      })
    );
    // B's child is streaming, so B's startup keeps the handle active and adopts it.
    const configB = await createTestConfig(rootDir);
    const managerB = workspaceTurnManagerFor(
      createTaskServiceStack(configB, {
        aiService: createAIServiceMocks(configB, { isStreaming: mock(() => true) }).aiService,
      }).taskService
    );
    const coordinator = (
      managerB as unknown as {
        desktopInputCoordinator: {
          withAdmission: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
        };
      }
    ).desktopInputCoordinator;
    const realAdmission = coordinator.withAdmission.bind(coordinator);
    // Another backend publishes a newer execution between B's snapshot and its claim.
    spyOn(coordinator, "withAdmission").mockImplementationOnce(async (id, fn) => {
      await configA.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const ws = project.workspaces.find((w) => w.id === "task-child");
          if (ws) ws.taskExecutionId = "wst_newer";
        }
        return cfg;
      });
      return realAdmission(id, fn);
    });

    await managerB.reconcileAgentTaskExecutionIds();

    expect(managerB.getLiveWorkspaceTurnRegistration("task-child")).toBeUndefined();
    expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_dead_owner"))).toBe(false);
  });

  test("the owner gives its lock back when another backend's settlement already won", async () => {
    const { config, parentId, taskService: backendA } = await startWorkspaceTurnForTest(rootDir);
    const lockPath = workspaceTurnOwnerLockPath(rootDir, "wst_handle");
    const store = new TaskHandleStore(config);
    const running = await store.getWorkspaceTurn(parentId, "wst_handle");
    expect(running).not.toBeNull();
    // Backend B interrupted A's turn: B's terminal record lands, but B cannot release A's lock.
    await store.upsertWorkspaceTurn({
      ...running!,
      status: "interrupted",
      updatedAt: new Date(Date.parse(running!.updatedAt) + 1000).toISOString(),
      error: "Workspace turn interrupted",
    });
    expect(await exists(lockPath)).toBe(true);

    // A's stream then ends; its settlement finds B's terminal winner.
    await finalizeWorkspaceTurnStreamEndForTest(
      backendA,
      workspaceTurnStreamEndEvent(parentId, "msg_final", "done")
    );

    expect(await workspaceTurnSnapshot(backendA, parentId)).toMatchObject({
      status: "interrupted",
    });
    expect(await exists(lockPath)).toBe(false);
  });
  describe("counts keep another backend's live handle through this backend's early returns (#4801)", () => {
    test("while this backend refuses idle admission for the workspace", async () => {
      const { parentId } = await startWorkspaceTurnForTest(rootDir);
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir),
        {
          workspaceService: createWorkspaceServiceMocks({
            acquireIdleTurnExclusion: mock(() => Err(new Error("admission in flight"))),
          }).workspaceService,
        }
      );

      expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(1);
      expect(await backendB.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toEqual([
        "wst_handle",
      ]);
    });

    test("while this backend has its own stream in the workspace", async () => {
      const { parentId } = await startWorkspaceTurnForTest(rootDir);
      // A user message sent from backend B into the same workspace streams there.
      const streamManagerB = {
        acquireStreamStartLock: () => Promise.resolve(undefined),
        getStreamInfo: () => ({ messageId: "msg_b" }),
      } as unknown as StreamManager;
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir),
        { streamManager: streamManagerB }
      );

      expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(1);
      expect(await backendB.listActiveWorkspaceTurnTaskIdsForOwner(parentId)).toEqual([
        "wst_handle",
      ]);
    });

    test("a dead owner's handle is still skipped, and left for a later settlement", async () => {
      const { config, parentId } = await startWorkspaceTurnForTest(rootDir);
      await markTurnOwnerDead("wst_handle");
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir),
        {
          workspaceService: createWorkspaceServiceMocks({
            acquireIdleTurnExclusion: mock(() => Err(new Error("admission in flight"))),
          }).workspaceService,
        }
      );

      // A stale handle must not count as active (a new turn would queue behind it).
      expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(0);
      expect(
        await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
      ).toMatchObject({ status: "running" });
    });
  });

  describe("another backend cannot revive a handle while its settlement publishes (#4801)", () => {
    const CHILD_ID = "childworkspace";

    /** Backend A runs a delegated turn in an existing agent child, so the execution mirror is live. */
    async function startAgentChildTurn(): Promise<{
      config: Config;
      parentId: string;
      backendA: WorkspaceTurnManager;
    }> {
      const config = await createTestConfig(rootDir);
      stubStableIds(config, ["handle", "turn"]);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push({
          path: path.join(projectPath, "agent-child"),
          id: CHILD_ID,
          name: "agent_explore_child",
          createdAt: "2026-06-19T00:00:00.000Z",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      const { taskService: backendA } = createWorkspaceTurnManagerHarness(config);
      const created = await backendA.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        prompt: "Follow up",
        title: "Follow-up",
        allowAgentWorkspace: true,
        workspace: { mode: "existing", workspaceId: CHILD_ID },
      });
      expect(created.success).toBe(true);
      expect(findWorkspaceInConfig(config, CHILD_ID)).toMatchObject({
        taskExecutionId: "wst_handle",
        taskExecutionStatus: "running",
      });
      return { config, parentId, backendA };
    }

    const reviveOf = (manager: WorkspaceTurnManager) =>
      (
        manager as unknown as {
          reviveRetryingWorkspaceTurn: (
            record: WorkspaceTurnTaskHandleRecord
          ) => Promise<WorkspaceTurnTaskHandleRecord | null>;
        }
      ).reviveRetryingWorkspaceTurn.bind(manager);

    /**
     * Pause A inside its terminal mirror write (its handle record is already terminal) and let
     * backend B try to revive the handle there, then let A finish.
     */
    function reviveFromBInsideMirrorWrite(
      config: Config,
      parentId: string,
      backendA: WorkspaceTurnManager,
      backendB: WorkspaceTurnManager
    ): void {
      const realUpdate = backendA.updateAgentTaskExecutionState.bind(backendA);
      spyOn(backendA, "updateAgentTaskExecutionState").mockImplementationOnce(
        async (workspaceId, handleId, status) => {
          const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, handleId);
          expect(settled?.status).toBe(status!);
          await reviveOf(backendB)(settled!);
          return realUpdate(workspaceId, handleId, status);
        }
      );
    }

    async function expectHandleAndMirrorAgree(config: Config, parentId: string): Promise<void> {
      const handle = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
      const mirror = findWorkspaceInConfig(config, CHILD_ID)?.taskExecutionStatus;
      expect({
        handleActive: isActiveWorkspaceTurnTaskStatus(handle!.status),
        mirrorActive: mirror != null && isActiveWorkspaceTurnTaskStatus(mirror),
      }).toEqual({ handleActive: false, mirrorActive: false });
    }

    test("stream-end settlement", async () => {
      const { config, parentId, backendA } = await startAgentChildTurn();
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir)
      );
      reviveFromBInsideMirrorWrite(config, parentId, backendA, backendB);

      await finalizeWorkspaceTurnStreamEndForTest(
        backendA,
        workspaceTurnStreamEndEvent(parentId, "msg_final", "done")
      );

      await expectHandleAndMirrorAgree(config, parentId);
      expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_handle"))).toBe(false);
    });

    test("explicit interrupt", async () => {
      const { config, parentId, backendA } = await startAgentChildTurn();
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir)
      );
      reviveFromBInsideMirrorWrite(config, parentId, backendA, backendB);

      expect((await backendA.interruptWorkspaceTurn(parentId, "wst_handle")).success).toBe(true);

      await expectHandleAndMirrorAgree(config, parentId);
      expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_handle"))).toBe(false);
    });

    test("settlement that finds another backend's terminal record", async () => {
      const { config, parentId, backendA } = await startAgentChildTurn();
      const store = new TaskHandleStore(config);
      const running = await store.getWorkspaceTurn(parentId, "wst_handle");
      await store.upsertWorkspaceTurn({
        ...running!,
        status: "interrupted",
        updatedAt: new Date(Date.parse(running!.updatedAt) + 1000).toISOString(),
        error: "Workspace turn interrupted",
      });
      const { taskService: backendB } = createWorkspaceTurnManagerHarness(
        await createTestConfig(rootDir)
      );
      reviveFromBInsideMirrorWrite(config, parentId, backendA, backendB);

      await finalizeWorkspaceTurnStreamEndForTest(
        backendA,
        workspaceTurnStreamEndEvent(parentId, "msg_final", "done")
      );

      await expectHandleAndMirrorAgree(config, parentId);
      expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_handle"))).toBe(false);
    });

    test("a failing mirror write still releases the lock", async () => {
      const { parentId, backendA } = await startAgentChildTurn();
      spyOn(backendA, "updateAgentTaskExecutionState").mockRejectedValueOnce(
        new Error("config write failed")
      );

      await backendA.interruptWorkspaceTurn(parentId, "wst_handle").catch(() => undefined);
      expect(await exists(workspaceTurnOwnerLockPath(rootDir, "wst_handle"))).toBe(false);
    });

    /**
     * #4926: backend B explicitly interrupts a turn that backend A owns. B never holds A's
     * live-owner lock, so nothing serializes A's writes against B's two writes (handle record,
     * then execution mirror).
     */
    describe("a foreign explicit interrupt's terminal mirror write (#4926)", () => {
      function mirrorAndHandle(config: Config, parentId: string) {
        return new TaskHandleStore(config)
          .getWorkspaceTurn(parentId, "wst_handle")
          .then((handle) => ({
            handle: handle?.status,
            mirror: findWorkspaceInConfig(config, CHILD_ID)?.taskExecutionStatus,
          }));
      }

      test("lands when nothing changed the handle after B's terminal write", async () => {
        const { config, parentId } = await startAgentChildTurn();
        const { taskService: backendB } = createWorkspaceTurnManagerHarness(
          await createTestConfig(rootDir)
        );

        expect((await backendB.interruptWorkspaceTurn(parentId, "wst_handle")).success).toBe(true);

        expect(await mirrorAndHandle(config, parentId)).toEqual({
          handle: "interrupted",
          mirror: "interrupted",
        });
      });

      test("lands after a metadata-only write that keeps B's outcome", async () => {
        const { config, parentId, backendA } = await startAgentChildTurn();
        const { taskService: backendB } = createWorkspaceTurnManagerHarness(
          await createTestConfig(rootDir)
        );
        // Between B's two writes, A records a notify-on-terminal policy on B's interrupted record.
        // That write keeps updatedAt: it is not a new outcome, so B's mirror write still applies.
        const realUpdateB = backendB.updateAgentTaskExecutionState.bind(backendB);
        spyOn(backendB, "updateAgentTaskExecutionState").mockImplementationOnce(async (...args) => {
          await backendA.markWorkspaceTurnBackgroundWorkNotifyOnTerminal("wst_handle", parentId);
          return realUpdateB(...args);
        });

        expect((await backendB.interruptWorkspaceTurn(parentId, "wst_handle")).success).toBe(true);

        expect(
          await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle")
        ).toMatchObject({ status: "interrupted", attentionPolicy: "notify_on_terminal" });
        expect(await mirrorAndHandle(config, parentId)).toEqual({
          handle: "interrupted",
          mirror: "interrupted",
        });
      });

      test("does not land over a revival that A published after B's handle write", async () => {
        const { config, parentId, backendA } = await startAgentChildTurn();
        const { taskService: backendB } = createWorkspaceTurnManagerHarness(
          await createTestConfig(rootDir)
        );

        // 1. A's terminal stream-error settlement read the handle as "running" (settleWorkspaceTurn
        //    reads it under A's in-process lock only), then awaits before its upsert. Hold A there.
        const storeA = internals(backendA).taskHandleStore;
        const realUpsertA = storeA.upsertWorkspaceTurn.bind(storeA);
        let resumeA!: () => void;
        const aMayWrite = new Promise<void>((resolve) => (resumeA = resolve));
        let aReachedWrite!: () => void;
        const aAtWrite = new Promise<void>((resolve) => (aReachedWrite = resolve));
        spyOn(storeA, "upsertWorkspaceTurn").mockImplementation(async (record) => {
          if (record.status === "error") {
            aReachedWrite();
            await aMayWrite;
          }
          return realUpsertA(record);
        });
        const settleA = backendA.finalizeWorkspaceTurnFromStreamError({
          type: "error",
          workspaceId: CHILD_ID,
          messageId: "msg_1",
          error: "Provider failed",
          errorType: "authentication",
        });
        await aAtWrite;

        // 2. B interrupts: it also reads "running", writes its terminal handle record, and is held
        //    just before its terminal mirror write.
        const realUpdateB = backendB.updateAgentTaskExecutionState.bind(backendB);
        let resumeB!: () => void;
        const bMayWriteMirror = new Promise<void>((resolve) => (resumeB = resolve));
        let bReachedMirror!: () => void;
        const bAtMirror = new Promise<void>((resolve) => (bReachedMirror = resolve));
        spyOn(backendB, "updateAgentTaskExecutionState").mockImplementationOnce(async (...args) => {
          bReachedMirror();
          await bMayWriteMirror;
          return realUpdateB(...args);
        });
        const interruptB = backendB.interruptWorkspaceTurn(parentId, "wst_handle");
        await bAtMirror;
        expect((await mirrorAndHandle(config, parentId)).handle).toBe("interrupted");

        // 3. A's settlement lands over B's record (handle "error", mirror "error", lock released),
        //    then A's child auto-retries the same turn and A revives the handle: an "error" record
        //    is self-heal eligible. Revival writes the mirror "running", then the handle.
        resumeA();
        await settleA;
        const settled = await new TaskHandleStore(config).getWorkspaceTurn(parentId, "wst_handle");
        expect(settled?.status).toBe("error");
        expect((await reviveOf(backendA)(settled!))?.status).toBe("running");
        expect(await mirrorAndHandle(config, parentId)).toEqual({
          handle: "running",
          mirror: "running",
        });

        // 4. B's late terminal mirror write must not pair A's live handle with a dead mirror.
        resumeB();
        expect((await interruptB).success).toBe(true);
        expect(await mirrorAndHandle(config, parentId)).toEqual({
          handle: "running",
          mirror: "running",
        });
      });
    });
  });
});
