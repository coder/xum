import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import {
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
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
  workspaceTurnStreamEndEvent,
} from "@/node/services/taskService.testHarness";
import type { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";

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
});
