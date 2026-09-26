import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { TaskHandleStore } from "@/node/services/taskHandleStore";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { createWorkspaceTurnManagerHarness } from "@/node/services/workspaceTurnManager.testHarness";
import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { Ok, Err, type Result } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import assert from "node:assert";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  workspaceTurnRecord,
} from "@/node/services/taskService.testHarness";

/** Lossy snapshot archives refuse with the blocking paths and an explanation (#3950). */
function expectLossyArchiveRefusal(
  result: Awaited<ReturnType<WorkspaceTurnManager["archiveOwnedWorkspaceTurnWorkspace"]>>,
  expected: { taskId?: string; workspaceId: string; displayName: string; paths: string[] }
): void {
  assert(result.success, "archive must return a lifecycle result");
  const { error, ...fields } = result.data;
  expect(fields).toEqual({ status: "error", action: "archive", ...expected });
  expect(typeof error).toBe("string");
}

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  test("shared desktop execution mirror rejects stale active and terminal callbacks", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: parentId,
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
          taskDesktopOwnerWorkspaceId: parentId,
          taskExecutionId: "new",
          taskExecutionStatus: "running",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const internals = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string; accepted: boolean }
      >;
    };
    internals.activeWorkspaceTurnHandleByWorkspaceId.set("child", {
      handleId: "new",
      ownerWorkspaceId: parentId,
      accepted: true,
    });
    for (const status of ["queued", "starting", "running", "completed", null] as const) {
      await taskService.updateAgentTaskExecutionState("child", "old", status);
      expect(findWorkspaceInConfig(config, "child")?.taskExecutionId).toBe("new");
      expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBe("running");
    }
    await taskService.updateAgentTaskExecutionState("child", "new", "completed");
    await taskService.updateAgentTaskExecutionState("child", "old", "running");
    await taskService.updateAgentTaskExecutionState("child", "new", "running");
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBe("completed");
  });

  test("an active mirror commit rejects a competing controller written while admission was suspended", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        ...["child", "competitor"].map((id) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: parentId,
            agentId: "explore",
            taskStatus: "reported",
            runtimeConfig: { type: "local" },
            taskDesktopOwnerWorkspaceId: parentId,
          })
        )
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    // A reservation registered by createWorkspaceTurn: the acceptance below claims this handle.
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string; accepted: boolean }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set("child", {
      handleId: "wst_child",
      ownerWorkspaceId: parentId,
      accepted: false,
    });
    // The gate admitted the child against a config where nothing else was active. Publish an
    // independent (gate-bypassing) competing controller after the mirror edit was scheduled but
    // before its transform runs, as a concurrent process or unrelated writer could.
    const editConfig = config.editConfig.bind(config);
    let intercepted = false;
    const editSpy = spyOn(config, "editConfig").mockImplementation(async (transform) => {
      if (intercepted) return editConfig(transform);
      intercepted = true;
      await editConfig((cfg) => {
        const competitor = findWorkspaceEntry(cfg, "competitor")?.workspace;
        assert(competitor, "competitor fixture must exist");
        competitor.taskStatus = "running";
        return cfg;
      });
      return editConfig(transform);
    });
    try {
      const failure = await taskService
        .updateAgentTaskExecutionState("child", "wst_child", "running")
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
      expect(failure).not.toBeNull();
    } finally {
      editSpy.mockRestore();
    }
    // Nothing from the rejected transaction reached disk; the competitor keeps control.
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionId).toBeUndefined();
    expect(findWorkspaceInConfig(config, "child")?.taskExecutionStatus).toBeUndefined();
    expect(findWorkspaceInConfig(config, "competitor")?.taskStatus).toBe("running");
  });

  test("startup clears an orphan execution mirror that has no handle ID and no handle record", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        // Codex P2: a bound child whose persisted mirror lost its ID (and whose handle record is
        // gone) reads as live desktop control forever — the ID-guarded clear never matches it.
        projectWorkspace(projectPath, "shared-orphan", "shared-orphan", {
          parentWorkspaceId: parentId,
          agentId: "explore",
          taskStatus: "reported",
          runtimeConfig: { type: "local" },
          taskDesktopOwnerWorkspaceId: parentId,
          taskExecutionStatus: "running",
        }),
        // The stable task status is a separate activity source and must survive the repair.
        projectWorkspace(projectPath, "running-orphan", "running-orphan", {
          parentWorkspaceId: parentId,
          agentId: "explore",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskExecutionStatus: "starting",
        })
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const desktop = new DesktopInputCoordinator(config);
    const ownerInput = () =>
      desktop
        .withInput(parentId, () => Promise.resolve("clicked"))
        .then(
          (value) => value,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
    expect(await ownerInput()).toContain("active borrower shared-orphan");

    await taskService.reconcileAgentTaskExecutionIds();

    for (const id of ["shared-orphan", "running-orphan"]) {
      expect(findWorkspaceInConfig(config, id)?.taskExecutionStatus).toBeUndefined();
      expect(findWorkspaceInConfig(config, id)?.taskExecutionId).toBeUndefined();
      expect(taskService.getLiveWorkspaceTurnRegistration(id)).toBeUndefined();
    }
    expect(findWorkspaceInConfig(config, "shared-orphan")?.taskStatus).toBe("reported");
    expect(findWorkspaceInConfig(config, "running-orphan")?.taskStatus).toBe("running");
    expect(await ownerInput()).toBe("clicked");
  });

  test("shared desktop active mirror refuses a missing target or competing child", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces.push(
        ...["missing", "child", "competitor"].map((id) =>
          projectWorkspace(projectPath, id, id, {
            parentWorkspaceId: parentId,
            agentId: "explore",
            taskStatus: id === "competitor" ? "running" : "reported",
            runtimeConfig: { type: "local" },
            taskDesktopOwnerWorkspaceId: id === "missing" ? "deleted" : parentId,
            taskExecutionId: id,
            taskExecutionStatus: "completed",
          })
        )
      );
      return cfg;
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    // Exercise admission itself deterministically; startup normalization may settle dead streams.
    for (const id of ["missing", "child"]) {
      const failure = await taskService.updateAgentTaskExecutionState(id, id, "running").then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(findWorkspaceInConfig(config, id)?.taskExecutionStatus).toBe("completed");
    }
    expect(taskService.getLiveWorkspaceTurnRegistration("child")).toBeUndefined();
  });

  async function createWorkspaceLifecycleHarness(
    options: {
      archived?: boolean;
      archive?: ReturnType<typeof mock>;
      unarchive?: ReturnType<typeof mock>;
      preflightArchive?: ReturnType<typeof mock>;
      listLiveWorkspaceActivity?: ReturnType<typeof mock>;
      getStoppablePreparingWorkspaceTurn?: ReturnType<typeof mock>;
      acquirePreInterruptionArchiveHold?: ReturnType<typeof mock>;
      waitForIdle?: ReturnType<typeof mock>;
      hasRunningBackgroundBashProcesses?: ReturnType<typeof mock>;
      isSnapshotArchiveEligibilityMutationSensitive?: ReturnType<typeof mock>;
      hasUntrackableExternalAppOpen?: ReturnType<typeof mock>;
      create?: ReturnType<typeof mock>;
    } = {}
  ) {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "child"),
        id: "childworkspace",
        name: "child",
        title: "Child workspace",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
        ...(options.archived ? { archivedAt: new Date().toISOString() } : {}),
      });
      project.workspaces.push({
        path: path.join(projectPath, "unowned"),
        id: "unownedworkspace",
        name: "unowned",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    // WorkspaceTurnManager's lifecycle actions run under the task-tree lock, so the caller's
    // archive/unarchive mocks back the WhileTaskTreeLocked sinks.
    const { archive, unarchive, ...hostOverrides } = options;
    const workspaceMocks = createWorkspaceServiceMocks({
      ...hostOverrides,
      ...(archive != null ? { archiveWhileTaskTreeLocked: archive } : {}),
      ...(unarchive != null ? { unarchiveWhileTaskTreeLocked: unarchive } : {}),
    });
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_created", "completed", {
        turnId: "turn-created",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        title: "Created child",
      })
    );
    return {
      config,
      parentId,
      projectPath,
      taskService,
      taskHost,
      taskHandleStore,
      ...workspaceMocks,
      archive: workspaceMocks.archiveWhileTaskTreeLocked,
      unarchive: workspaceMocks.unarchiveWhileTaskTreeLocked,
    };
  }

  function markWorkspaceTurnActive(
    taskService: WorkspaceTurnManager,
    workspaceId: string,
    handleId: string,
    ownerWorkspaceId: string
  ): void {
    // normalizeWorkspaceTurnRecord self-heals "running" records that have no live
    // in-process execution, so active-turn tests must register the handle as live.
    (
      taskService as unknown as {
        activeWorkspaceTurnHandleByWorkspaceId: Map<
          string,
          { handleId: string; ownerWorkspaceId: string }
        >;
      }
    ).activeWorkspaceTurnHandleByWorkspaceId.set(workspaceId, { handleId, ownerWorkspaceId });
  }

  test("workspace lifecycle archives only parent-owned created workspace turns", async () => {
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness();

    const archived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const unowned = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "unownedworkspace" },
      {}
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "archive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle treats existing follow-up handles as owned when the workspace was created by the parent", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_existing", "completed", {
        turnId: "turn-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Existing child",
      })
    );

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_existing" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        taskId: "wst_existing",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes concurrent handles that resolve to the same workspace", async () => {
    let archiveCallCount = 0;
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      archiveCallCount += 1;
      await Promise.resolve();
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_existing", "completed", {
        turnId: "turn-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Existing child",
      })
    );

    const results = await Promise.all([
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_created" },
        {}
      ),
      harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
        harness.parentId,
        { taskId: "wst_existing" },
        {}
      ),
    ]);

    expect(results.map((result) => (result.success ? result.data.status : "error")).sort()).toEqual(
      ["already_archived", "archived"]
    );
    expect(archiveCallCount).toBe(1);
  });

  test("workspace lifecycle rejects existing follow-up handles for workspaces this parent did not create", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "unownedworkspace", "wst_foreignexisting", "completed", {
        turnId: "turn-foreign-existing",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "Unowned existing child",
      })
    );

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_foreignexisting" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "invalid_scope",
        action: "archive",
        taskId: "wst_foreignexisting",
        workspaceId: "unownedworkspace",
      })
    );
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses a valid handle owned by another workspace", async () => {
    // Ownership is decided by the durable workspace-turn graph, never by whether the caller knows
    // (or can message) the target. The same handle stays fully usable for its actual owner.
    const { parentId, projectPath, config, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    const otherOwnerId = "otherowner";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "other-owner"),
        id: otherOwnerId,
        name: "other-owner",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(otherOwnerId, "unownedworkspace", "wst_otherowned", "completed", {
        turnId: "turn-other-owned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        title: "Other owner's child",
      })
    );

    const refused = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { taskId: "wst_otherowned" },
      {}
    );

    // The record lives in the other owner's store, so it does not even resolve to a workspace.
    expect(refused).toEqual(
      Ok({ status: "invalid_scope", action: "archive", taskId: "wst_otherowned" })
    );
    expect(archive).not.toHaveBeenCalled();

    const ownerArchive = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      otherOwnerId,
      { taskId: "wst_otherowned" },
      {}
    );
    expect(ownerArchive.success && ownerArchive.data.status).toBe("archived");
    expect(archive).toHaveBeenCalledTimes(1);
  });

  test("workspace lifecycle refuses lossy snapshot archives and treats already archived as idempotent", async () => {
    const confirmationArchive = mock(
      (): Promise<Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] }>> =>
        Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const { config, parentId, projectPath, taskService, taskHandleStore } =
      await createWorkspaceLifecycleHarness({ archive: confirmationArchive });

    // Only the user can approve losing untracked files (#3950): the model-driven archive never
    // hands the sink an acknowledgement, and a lossy result is a refusal that lists the paths
    // instead of a confirmation round trip the model could answer itself.
    const refusal = await taskService.archiveOwnedWorkspaceTurnWorkspace(parentId, {
      workspaceId: "childworkspace",
    });

    expectLossyArchiveRefusal(refusal, {
      workspaceId: "childworkspace",
      displayName: "Child workspace",
      paths: ["scratch.txt"],
    });
    expect(confirmationArchive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    const refusalByTaskId = await taskService.archiveOwnedWorkspaceTurnWorkspace(parentId, {
      taskId: "wst_created",
    });

    expectLossyArchiveRefusal(refusalByTaskId, {
      taskId: "wst_created",
      workspaceId: "childworkspace",
      displayName: "Child workspace",
      paths: ["scratch.txt"],
    });
    expect(confirmationArchive).toHaveBeenLastCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });

    await config.editConfig((cfg) => {
      const child = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === "childworkspace");
      assert(child, "child workspace must exist");
      child.archivedAt = new Date().toISOString();
      return cfg;
    });
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );

    const alreadyArchived = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(alreadyArchived).toEqual(
      Ok({
        status: "already_archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(confirmationArchive).toHaveBeenCalledTimes(2);
  });

  test("workspace lifecycle requires explicit interruption for active workspace turns before archive", async () => {
    const { parentId, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const active = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    const interrupted = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(interrupted).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("interrupted");
  });

  test("workspace lifecycle unarchives archived owned workspaces and treats unarchived as idempotent", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const unarchive = mock(async (): Promise<Result<void>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before unarchive runs");
      assert(projectPath, "harness project path must be assigned before unarchive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.unarchivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archived: true, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const unarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { taskId: "wst_created" }
    );

    expect(unarchived).toEqual(
      Ok({
        status: "unarchived",
        action: "unarchive",
        taskId: "wst_created",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledWith("childworkspace");

    const alreadyUnarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" }
    );

    expect(alreadyUnarchived).toEqual(
      Ok({
        status: "already_unarchived",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(unarchive).toHaveBeenCalledTimes(1);

    const unowned = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "unownedworkspace" }
    );

    expect(unowned).toEqual(
      Ok({ status: "invalid_scope", action: "unarchive", workspaceId: "unownedworkspace" })
    );
  });

  test("workspace lifecycle unarchive reports active turns without interrupting", async () => {
    const { parentId, taskService, taskHandleStore, unarchive } =
      await createWorkspaceLifecycleHarness({ archived: true });
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(taskService, "childworkspace", "wst_running", parentId);

    const result = await taskService.unarchiveOwnedWorkspaceTurnWorkspace(parentId, {
      workspaceId: "childworkspace",
    });

    expect(result).toEqual(
      Ok({
        status: "active",
        action: "unarchive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_running"],
      })
    );
    expect(unarchive).not.toHaveBeenCalled();
    const runningRecord = await taskHandleStore.getWorkspaceTurn(parentId, "wst_running");
    expect(runningRecord?.status).toBe("running");
  });

  test("workspace lifecycle archive blocks existing-mode follow-ups until unarchive restores them", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    const editChildWorkspace = async (
      edit: (child: WorkspaceConfigEntry) => void
    ): Promise<void> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned");
      assert(projectPath, "harness project path must be assigned");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        edit(child);
        return cfg;
      });
    };
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await editChildWorkspace((child) => {
        child.archivedAt = new Date().toISOString();
      });
      return Ok({ kind: "archived" });
    });
    const unarchive = mock(async (): Promise<Result<void>> => {
      await editChildWorkspace((child) => {
        child.unarchivedAt = new Date().toISOString();
      });
      return Ok(undefined);
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, unarchive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archived = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    expect(archived.success && archived.data.status === "archived").toBe(true);

    const refused = await harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(refused).toEqual(Err("Task.createWorkspaceTurn: existing workspace is archived"));

    const unarchived = await harness.taskService.unarchiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" }
    );
    expect(unarchived.success && unarchived.data.status === "unarchived").toBe(true);

    const followUp = await harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
  });

  test("workspace lifecycle serializes archive with follow-up handle persistence", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    // Wait until the archive operation holds the lifecycle lock (it is inside
    // workspaceService.archive, gated on archiveGate).
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Launch a follow-up while the archive is mid-flight: it must serialize on the shared
    // lifecycle lock and be refused after the archive lands, instead of persisting a handle
    // the already-committed archive would silently truncate.
    const followUpPromise = harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: harness.parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, followUp] = await Promise.all([archivePromise, followUpPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(followUp.success).toBe(false);
    expect(followUp.success ? "" : followUp.error).toMatch(/archived/);
    const activeHandles = await harness.taskService.listWorkspaceTurnTasks(harness.parentId, {
      statuses: ["queued", "starting", "running"],
    });
    expect(activeHandles).toEqual([]);
  });

  test("workspace lifecycle archive blocks on active turns owned by the target", async () => {
    const { config, parentId, projectPath, taskService, taskHandleStore, archive } =
      await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, "grandchild"),
        id: "grandchildworkspace",
        name: "grandchild",
        createdAt: new Date().toISOString(),
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });
    // Nested delegation: the peer (childworkspace) owns an active turn targeting a grandchild.
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord("childworkspace", "grandchildworkspace", "wst_nested", "running", {
        turnId: "turn-nested",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        title: "Nested turn",
      })
    );
    markWorkspaceTurnActive(taskService, "grandchildworkspace", "wst_nested", "childworkspace");

    const active = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(active).toEqual(
      Ok({
        status: "active",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
        activeTaskIds: ["wst_nested"],
      })
    );
    expect(archive).not.toHaveBeenCalled();

    // interrupt_active does not cascade into turns running in OTHER workspaces: the nested
    // workspace never gets the activity checks and admission holds the target does, so
    // interruption (and any disposable cleanup) there could destroy user work unseen.
    const refusedNested = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(refusedNested.success).toBe(true);
    if (refusedNested.success) {
      expect(refusedNested.data.status).toBe("active");
      expect(refusedNested.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(archive).not.toHaveBeenCalled();
    const nested = await taskHandleStore.getWorkspaceTurn("childworkspace", "wst_nested");
    expect(nested?.status).toBe("running");
  });

  test("workspace lifecycle refuses lossy archives before interrupting active turns", async () => {
    const preflightArchive = mock(
      (): Promise<
        Result<{ kind: "confirm-lossy-untracked-files"; paths: string[] } | { kind: "ready" }>
      > => Promise.resolve(Ok({ kind: "confirm-lossy-untracked-files", paths: ["scratch.txt"] }))
    );
    const archive = mock(
      (): Promise<Result<{ kind: "archived" }>> => Promise.resolve(Ok({ kind: "archived" }))
    );
    const harness = await createWorkspaceLifecycleHarness({ archive, preflightArchive });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // The lossy refusal must surface BEFORE any interruption so the in-flight work keeps running.
    const refusal = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expectLossyArchiveRefusal(refusal, {
      workspaceId: "childworkspace",
      displayName: "Child workspace",
      paths: ["scratch.txt"],
    });
    expect(archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");

    // Once nothing would be lost (e.g. the files were committed), interruption proceeds.
    preflightArchive.mockImplementation(() => Promise.resolve(Ok({ kind: "ready" as const })));
    const archived = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    // Preflight runs before interruption on BOTH calls, and the sink never receives an
    // acknowledgement from the model-driven path.
    expect(preflightArchive).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "keep",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when worktree archive behavior deletes checkouts", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // The refusal is scoped to targets the worktree archive hook would actually delete, so
      // this test's child must be a managed worktree runtime.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = { type: "local", srcBaseDir: "/tmp/src" };
        }
      }
      return cfg;
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Delete checkout");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses snapshot archive after a native terminal was opened", async () => {
    // Native emulator lifetime is untrackable, so a snapshot archive (which removes the
    // checkout) must fail closed instead of deleting the directory under the user's shell.
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive: mock(() => true),
      hasUntrackableExternalAppOpen: mock(() => true),
    });

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("native terminal");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle archives non-worktree targets despite the delete worktree policy", async () => {
    const { config, parentId, taskService, archive } = await createWorkspaceLifecycleHarness();
    await config.editConfig((cfg) => {
      cfg.worktreeArchiveBehavior = "delete";
      // SSH runtime: the worktree archive hook skips non-worktree runtimes, so the unrelated
      // global delete policy must not make reversible archive unavailable for this peer.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "peer.example",
            srcBaseDir: "/home/user/src",
          };
        }
      }
      return cfg;
    });

    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      {}
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(archive).toHaveBeenCalledWith("childworkspace", undefined, {
      forbidWorktreeCheckoutDeletion: true,
      refuseLiveUserActivity: true,
      forbidCoderWorkspaceDeletion: true,
      worktreeArchiveBehaviorOverride: "delete",
      coderWorkspaceArchiveBehaviorOverride: "stop",
    });
  });

  test("workspace lifecycle serializes nested turn creation with archiving its owner", async () => {
    const harnessRefs: { config?: Config; projectPath?: string } = {};
    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive = mock(async (): Promise<Result<{ kind: "archived" }>> => {
      await archiveGate;
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before archive runs");
      assert(projectPath, "harness project path must be assigned before archive runs");
      await config.editConfig((cfg) => {
        const child = cfg.projects
          .get(projectPath)
          ?.workspaces.find((workspace) => workspace.id === "childworkspace");
        assert(child, "child workspace must exist");
        child.archivedAt = new Date().toISOString();
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
    const create = mock(async (): Promise<Result<{ metadata: WorkspaceMetadata }>> => {
      const config = harnessRefs.config;
      const projectPath = harnessRefs.projectPath;
      assert(config, "harness config must be assigned before create runs");
      assert(projectPath, "harness project path must be assigned before create runs");
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "grandchild"),
          id: "grandchildworkspace",
          name: "grandchild",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
        });
        return cfg;
      });
      return Ok({
        metadata: {
          id: "grandchildworkspace",
          name: "grandchild",
          projectName: "repo",
          projectPath,
          runtimeConfig: { type: "local" },
          createdAt: new Date().toISOString(),
        },
      });
    });
    const harness = await createWorkspaceLifecycleHarness({ archive, create });
    harnessRefs.config = harness.config;
    harnessRefs.projectPath = harness.projectPath;

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      {}
    );
    const waitStart = Date.now();
    while (archive.mock.calls.length === 0) {
      if (Date.now() - waitStart > 5000) throw new Error("archive mock was never invoked");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The peer starts a nested workspace turn while its own archive is mid-flight. The
    // persist section locks on the OWNER too, so it must serialize behind the archive and be
    // refused instead of leaving an active nested handle owned by an archived workspace.
    const nestedPromise = harness.taskService.createWorkspaceTurn({
      ownerWorkspaceId: "childworkspace",
      prompt: "Nested work",
      title: "Nested work",
      workspace: { mode: "new" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseArchive?.();

    const [archived, nested] = await Promise.all([archivePromise, nestedPromise]);
    expect(archived).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(nested.success).toBe(false);
    expect(nested.success ? "" : nested.error).toMatch(/owner workspace was archived/);
    // The refused nested creation had already materialized its workspace; without an ownership
    // handle the archived owner could never manage it, so it must be removed, not leaked.
    expect(harness.removeWhileTaskTreeLocked).toHaveBeenCalledWith("grandchildworkspace", true);
    const nestedHandles = await harness.taskService.listWorkspaceTurnTasks("childworkspace", {
      statuses: ["queued", "starting", "running"],
    });
    expect(nestedHandles).toEqual([]);
  });

  test("workspace lifecycle refuses archive while the target has live non-turn activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: true,
      terminalSessions: true,
      desktopViewers: false,
    }));
    const { parentId, taskService, archive } = await createWorkspaceLifecycleHarness({
      listLiveWorkspaceActivity,
    });

    // No delegated turns explain the stream, and terminals are never turn-driven; even
    // interrupt_active must not let the tool kill user activity.
    const result = await taskService.archiveOwnedWorkspaceTurnWorkspace(
      parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.note : "").toContain("an active stream");
    expect(data?.status === "active" ? data.note : "").toContain("open terminal sessions");
    expect(archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active when snapshot eligibility is mutation-sensitive", async () => {
    const isSnapshotArchiveEligibilityMutationSensitive = mock(() => true);
    const harness = await createWorkspaceLifecycleHarness({
      isSnapshotArchiveEligibilityMutationSensitive,
    });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // Running turns can create untracked files mid-interruption, so honoring interrupt_active
    // could destroy in-flight work and still end in a lossy-archive refusal. Refuse instead and
    // leave the turn running.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toEqual(["wst_running"]);
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "interrupt_active was not honored"
    );
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle archive interruption never removes a disposable target workspace", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_disposable", "running", {
        turnId: "turn-disposable",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        disposableWorkspace: true,
      })
    );
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_disposable",
      harness.parentId
    );

    // Interrupting a disposable workspace-turn normally auto-removes its workspace; when the
    // interruption serves an archive (retain), that cleanup would delete the checkout out from
    // under the subsequent archive call, which would then fail with "Workspace not found".
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    expect(harness.remove).not.toHaveBeenCalled();
    const interrupted = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_disposable"
    );
    expect(interrupted?.status).toBe("interrupted");
  });

  test("workspace lifecycle refuses archive when the workflow activity scan fails", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    // A corrupt run record makes the strict activity scan throw: the absence of active
    // workflow runs is no longer provable, so archive must refuse instead of proceeding
    // while a crash-recovered run might still resume into the archived workspace.
    await fsPromises.mkdir(
      path.join(
        path.join(harness.config.sessionsDir, "childworkspace"),
        "workflows",
        "wfr_corrupt"
      ),
      { recursive: true }
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain("Could not verify");
    expect(harness.archive).not.toHaveBeenCalled();
    // The sink-side recheck fails closed on the same unreadable store.
    let scanError: unknown;
    try {
      await harness.taskHost.listActiveWorkflowRunIdsForWorkspaceStrict("childworkspace");
    } catch (error: unknown) {
      scanError = error;
    }
    expect(scanError).toBeInstanceOf(Error);
  });

  test("workspace lifecycle refuses archive while the target owns an active workflow run", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(harness.config.sessionsDir, "childworkspace"),
    });
    await runStore.createRun({
      id: "wfr_child_active",
      workspaceId: "childworkspace",
      workflow: {
        name: "child-active",
        description: "Active child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: new Date().toISOString(),
    });

    // Workflows idle between steps own no descendant agent or turn at that instant, but
    // archiving would break the next step; interrupt_active must not apply to workflow runs.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? data.activeTaskIds : []).toContain("wfr_child_active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("workflow runs");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle treats queued user messages as live activity", async () => {
    const listLiveWorkspaceActivity = mock(() => ({
      streaming: false,
      queuedMessages: true,
      terminalSessions: false,
      desktopViewers: false,
    }));
    const harness = await createWorkspaceLifecycleHarness({ listLiveWorkspaceActivity });

    // No delegated queued turn explains the queue entry, so it is user work: a queued message
    // would dispatch through AgentSession's internal send path after archive and stream hidden.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("queued messages");
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle interrupts a delegated turn whose send is still PREPARING", async () => {
    // A fresh delegated turn's handle already reads "running" while the target session is
    // PREPARING, which listLiveWorkspaceActivity reports as queued messages. The exemption
    // must bind to the exact correlation of the collected turn, not to PREPARING alone.
    const preparingTurn = {
      taskHandleId: "wst_running",
      ownerWorkspaceId: "",
      turnId: "turn-running",
    };
    const getStoppablePreparingWorkspaceTurn = mock(() => preparingTurn);
    const acquirePreInterruptionArchiveHold = mock(() => Ok({ [Symbol.dispose]: () => undefined }));
    const harness = await createWorkspaceLifecycleHarness({
      listLiveWorkspaceActivity: mock(() => ({
        streaming: false,
        queuedMessages: true,
        backgroundBashProcesses: false,
        terminalSessions: false,
        desktopSession: false,
      })),
      getStoppablePreparingWorkspaceTurn,
      acquirePreInterruptionArchiveHold,
    });
    preparingTurn.ownerWorkspaceId = harness.parentId;
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    // A PREPARING send correlated to some other turn (the collected turn ended and a
    // different delegated turn, or none, took the session) is not explained by the
    // collected handle: still user-shaped work, still refused.
    getStoppablePreparingWorkspaceTurn.mockReturnValueOnce({
      ...preparingTurn,
      turnId: "turn-other",
    });
    const mismatched = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );
    expect(mismatched.success).toBe(true);
    const mismatchedData = mismatched.success ? mismatched.data : undefined;
    expect(mismatchedData?.status).toBe("active");
    expect(mismatchedData?.status === "active" ? (mismatchedData.note ?? "") : "").toContain(
      "queued messages"
    );
    expect(harness.archive).not.toHaveBeenCalled();

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    // The hold binds the interruptible turn by correlation so a stream that starts for it
    // between the gate and interruption is still recognized as the delegated turn.
    expect(acquirePreInterruptionArchiveHold).toHaveBeenLastCalledWith("childworkspace", {
      queuedDelegatedTurnCount: 0,
      expectedDelegatedTurnCorrelations: [preparingTurn],
    });
    expect(harness.archive).toHaveBeenCalledTimes(1);
    const record = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_running");
    expect(record?.status).toBe("interrupted");
  });

  test("workspace lifecycle waits for interrupted turns to settle before the archive sink", async () => {
    // stopStream resolves before the target session leaves PREPARING/COMPLETING; entering
    // the sink on that residue would refuse with the turns already destroyed.
    const settled = Promise.withResolvers<void>();
    const waitForIdle = mock(() => settled.promise);
    const harness = await createWorkspaceLifecycleHarness({ waitForIdle });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    const archivePromise = harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );
    await waitForCondition(() => waitForIdle.mock.calls.length === 1);
    expect(waitForIdle).toHaveBeenCalledWith("childworkspace");
    const record = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_running");
    expect(record?.status).toBe("interrupted");
    expect(harness.archive).not.toHaveBeenCalled();

    settled.resolve();
    const result = await archivePromise;
    expect(result.success ? result.data.status : result.error).toBe("archived");
    expect(harness.archive).toHaveBeenCalledTimes(1);
  });

  test("workspace lifecycle refuses archive of a dedicated Coder workspace under the delete policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "delete";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    // The before-archive hook would permanently delete the dedicated remote Coder workspace
    // and unarchive cannot recreate it — the reversible model-facing verb must fail closed.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "Coder workspace archive behavior"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses stopping a dedicated Coder workspace under an untrackable app", async () => {
    // Snapshot capture never runs for SSH runtimes, but a "stop" Coder policy still pulls the
    // remote environment out from under a native terminal/editor the user may be connected
    // through — the untrackable-app refusal must cover that hazard too.
    const harness = await createWorkspaceLifecycleHarness({
      hasUntrackableExternalAppOpen: mock(() => true),
    });
    await harness.config.editConfig((cfg) => {
      cfg.coderWorkspaceArchiveBehavior = "stop";
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(harness.parentId, {
      workspaceId: "childworkspace",
    });

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("error");
    expect(data?.status === "error" ? data.error : "").toContain(
      "stop the dedicated remote Coder workspace"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for nested disposable turn workspaces", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      for (const [, project] of cfg.projects) {
        if (project.workspaces.some((w) => w.id === "childworkspace")) {
          project.workspaces.push({
            path: `${project.workspaces[0].path}-grandchild`,
            id: "grandchildworkspace",
            name: "grandchild",
            title: "Grandchild workspace",
            createdAt: new Date().toISOString(),
            runtimeConfig: { type: "local" },
          });
        }
      }
      return cfg;
    });
    // Nested turn OWNED BY the archive target, running in its own disposable workspace:
    // interrupting it would trigger that workspace's disposable force-removal without any of
    // the activity checks or admission holds the target gets — user terminals/editors/queued
    // work there would be destroyed unseen. interrupt_active must refuse instead of
    // cascading; the caller stops the turn explicitly (task_stop), which runs the same
    // user-visible cleanup as normal settlement.
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord("childworkspace", "grandchildworkspace", "wst_nested", "running", {
        turnId: "turn-nested",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdWorkspace: true,
        disposableWorkspace: true,
      })
    );
    markWorkspaceTurnActive(
      harness.taskService,
      "grandchildworkspace",
      "wst_nested",
      "childworkspace"
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
      expect(result.data.activeTaskIds).toEqual(["wst_nested"]);
      expect(result.data.note).toContain("nested workspaces (grandchildworkspace)");
    }
    expect(harness.archive).not.toHaveBeenCalled();
    // Nothing was interrupted or removed: the nested turn and its workspace are untouched.
    expect(harness.remove).not.toHaveBeenCalled();
    const nestedRecord = await harness.taskHandleStore.getWorkspaceTurn(
      "childworkspace",
      "wst_nested"
    );
    expect(nestedRecord?.status).toBe("running");
  });

  test("workspace lifecycle refuses archive while background bash processes are running", async () => {
    const hasRunningBackgroundBashProcesses = mock((): Promise<boolean> => Promise.resolve(true));
    const harness = await createWorkspaceLifecycleHarness({ hasRunningBackgroundBashProcesses });

    // Detached background bash outlives its spawning turn: interruption cannot stop it, and a
    // snapshot archive could remove the worktree under a process still writing.
    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain(
      "running background bash processes"
    );
    expect(harness.archive).not.toHaveBeenCalled();
  });

  test("workspace lifecycle refuses interrupt_active for a dedicated Coder workspace under the stop policy", async () => {
    const harness = await createWorkspaceLifecycleHarness();
    await harness.config.editConfig((cfg) => {
      // Default Coder policy is "stop": the sink's before-archive hook stops the remote
      // workspace and can fail AFTER interruption destroyed the turns.
      for (const [, project] of cfg.projects) {
        const child = project.workspaces.find((w) => w.id === "childworkspace");
        if (child) {
          child.runtimeConfig = {
            type: "ssh",
            host: "coder.example",
            srcBaseDir: "/home/coder/src",
            coder: { workspaceName: "mux-child", existingWorkspace: false },
          };
        }
      }
      return cfg;
    });
    await harness.taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(harness.parentId, "childworkspace", "wst_running", "running", {
        turnId: "turn-running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    );
    markWorkspaceTurnActive(harness.taskService, "childworkspace", "wst_running", harness.parentId);

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result.success).toBe(true);
    const data = result.success ? result.data : undefined;
    expect(data?.status).toBe("active");
    expect(data?.status === "active" ? (data.note ?? "") : "").toContain("fallible remote stop");
    expect(harness.archive).not.toHaveBeenCalled();
    const stillRunning = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_running"
    );
    expect(stillRunning?.status).toBe("running");
  });

  test("workspace lifecycle interruption tolerates turns that settled after collection", async () => {
    // The preflight runs between collection and interruption; settle one of the two active
    // turns there to prove a now-terminal handle is skipped instead of aborting the archive.
    const harnessRefs: {
      taskHandleStore?: TaskHandleStore;
      taskService?: WorkspaceTurnManager;
      parentId?: string;
    } = {};
    const preflightArchive = mock(async (): Promise<Result<{ kind: "ready" }>> => {
      const { taskHandleStore, taskService, parentId } = harnessRefs;
      assert(taskHandleStore && taskService && parentId, "harness refs must be assigned");
      const settled = await taskHandleStore.getWorkspaceTurn(parentId, "wst_settling");
      assert(settled, "settling turn must exist");
      await taskHandleStore.upsertWorkspaceTurn({
        ...settled,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
      (
        taskService as unknown as {
          activeWorkspaceTurnHandleByWorkspaceId: Map<string, unknown>;
        }
      ).activeWorkspaceTurnHandleByWorkspaceId.delete("childworkspace");
      return Ok({ kind: "ready" });
    });
    const harness = await createWorkspaceLifecycleHarness({ preflightArchive });
    harnessRefs.taskHandleStore = harness.taskHandleStore;
    harnessRefs.taskService = harness.taskService;
    harnessRefs.parentId = harness.parentId;
    const baseRecord = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: harness.parentId,
      workspaceId: "childworkspace",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdWorkspace: false,
      disposableWorkspace: false,
    };
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_settling",
      turnId: "turn-settling",
      status: "running",
    });
    await harness.taskHandleStore.upsertWorkspaceTurn({
      ...baseRecord,
      handleId: "wst_queued",
      turnId: "turn-queued",
      status: "queued",
    });
    markWorkspaceTurnActive(
      harness.taskService,
      "childworkspace",
      "wst_settling",
      harness.parentId
    );

    const result = await harness.taskService.archiveOwnedWorkspaceTurnWorkspace(
      harness.parentId,
      { workspaceId: "childworkspace" },
      { interruptActive: true }
    );

    expect(result).toEqual(
      Ok({
        status: "archived",
        action: "archive",
        workspaceId: "childworkspace",
        displayName: "Child workspace",
      })
    );
    const settled = await harness.taskHandleStore.getWorkspaceTurn(
      harness.parentId,
      "wst_settling"
    );
    expect(settled?.status).toBe("completed");
    const queued = await harness.taskHandleStore.getWorkspaceTurn(harness.parentId, "wst_queued");
    expect(queued?.status).toBe("interrupted");
  });
});
