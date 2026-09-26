import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { TaskHandleStore } from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import {
  workspaceTurnOwnerLockPath,
  type WorkspaceTurnManager,
} from "@/node/services/workspaceTurnManager";
import { registerLiveWorkspaceTurnHandle } from "@/node/services/taskService.shared.testHarness";
import {
  createTaskServiceStack,
  createTestConfig,
  projectWorkspace,
  saveWorkspaces,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";

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

    // B's task-creation path counts active turns; A's turn is not live in B's memory.
    expect(await internals(backendB).countActiveWorkspaceTurns()).toBe(0);

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
});
