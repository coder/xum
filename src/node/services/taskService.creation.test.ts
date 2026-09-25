import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { SecretsStore } from "@/node/config";
import * as path from "path";
import { describe, test, expect, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import { existsSync } from "fs";
import { Config, type ProjectsConfig, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { findWorkspaceEntry, resolveWorkspaceModelFallbackChain } from "@/node/services/taskUtils";
import type { TaskService } from "@/node/services/taskService";
import { TaskHandleStore } from "@/node/services/taskHandleStore";
import type { WorkspaceForkParams } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { ContainerManager } from "@/node/multiProject/containerManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createRuntimeContextForWorkspace } from "@/node/runtime/runtimeHelpers";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import { Ok, Err, type Result } from "@/common/types/result";
import { MULTI_PROJECT_CONFIG_KEY } from "@/common/constants/multiProject";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { defaultModel } from "@/common/utils/ai/models";
import { createMuxMessage, parseWorkspaceTurnTaskCorrelation } from "@/common/types/message";
import type { InitStateManager } from "@/node/services/initStateManager";
import { InitStateManager as RealInitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createNullInitLogger,
  createTaskServiceHarness,
  registerTaskServiceTestRoot,
  rootDir,
  waitForWorkspaceTaskStatus,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  registerTaskServiceTestRoot();

  test("enforces maxTaskNestingDepth", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(3, 2)
    );
    const { taskService } = createTaskServiceHarness(config);

    const first = await createAgentTask(taskService, parentId, "explore this repo");
    expect(first.success).toBe(true);
    if (!first.success) return;

    const second = await createAgentTask(taskService, first.data.taskId, "nested explore");
    expect(second.success).toBe(true);
    if (!second.success) return;

    const third = await createAgentTask(taskService, second.data.taskId, "nested explore again");
    expect(third.success).toBe(false);
    if (!third.success) {
      expect(third.error).toContain("maxTaskNestingDepth");
    }
  }, 20_000);

  test("plan is only runnable for workflow-owned task creation", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["planworkflow"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const normal = await createAgentTask(taskService, parentId, "plan normally", {
      agentId: "plan",
      agentType: "plan",
    });
    expect(normal.success).toBe(false);

    const workflowOwned = await createAgentTask(taskService, parentId, "plan workflow step", {
      agentId: "plan",
      agentType: "plan",
      workflowTask: { runId: "wfr_plan", stepId: "plan" },
    });
    expect(workflowOwned.success).toBe(true);
  });

  test("createMany allows workflow-owned plan tasks but not normal plan tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["planbatcha", "planbatchb"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const normal = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "plan",
        prompt: "plan normally",
        title: "Normal plan",
      },
    ]);
    expect(normal.success).toBe(false);

    const workflowOwned = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "plan",
        prompt: "plan workflow step",
        title: "Workflow plan",
        workflowTask: { runId: "wfr_plan_many", stepId: "plan" },
      },
    ]);
    expect(workflowOwned.success).toBe(true);
  });

  test.each(["single", "batch"] as const)(
    "shared desktop best-of %s refuses before creation side effects",
    async (mode) => {
      const config = await createTestConfig(rootDir);
      const { taskService, aiService } = createTaskServiceHarness(config);
      const metadata = spyOn(aiService, "getWorkspaceMetadata");
      const args = {
        parentWorkspaceId: "missing-parent",
        kind: "agent" as const,
        agentId: "desktop",
        prompt: "Inspect the desktop",
        title: "Inspector",
        bestOf: { groupId: "group", index: 0, total: 2 },
      };
      const result =
        mode === "single" ? await taskService.create(args) : await taskService.createMany([args]);
      expect(result.success).toBe(false);
      expect(metadata).not.toHaveBeenCalled();
      expect(config.loadConfigOrDefault().projects.size).toBe(0);
    }
  );

  test("shared desktop batch rejects competing children before reservation callbacks", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const onTaskReserved = mock(() => undefined);
    const fork = spyOn(forkOrchestrator, "orchestrateFork");
    try {
      const result = await taskService.createMany(
        ["one", "two"].map((prompt) => ({
          parentWorkspaceId: parentId,
          kind: "agent" as const,
          agentId: "explore",
          prompt,
          title: prompt,
          desktop: "shared" as const,
        })),
        { onTaskReserved }
      );
      expect(result.success).toBe(false);
      expect(onTaskReserved).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
      expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toHaveLength(1);
    } finally {
      fork.mockRestore();
    }
  });

  test("shared desktop reservations from separate backends commit only one borrower", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = testTaskSettings(1, 3);
      cfg.projects.get(projectPath)!.workspaces.push(
        projectWorkspace(projectPath, "busy", "busy", {
          parentWorkspaceId: parentId,
          taskStatus: "running",
          agentId: "explore",
        })
      );
      return cfg;
    });
    const otherConfig = new Config(config.rootDir);
    const services = [config, otherConfig].map((cfg) => createTaskServiceHarness(cfg).taskService);
    let reservations = 0;
    const results = await Promise.all(
      services.map((service) =>
        service.createMany(
          [
            {
              parentWorkspaceId: parentId,
              kind: "agent",
              agentId: "explore",
              prompt: "Inspect",
              title: "Inspector",
              desktop: "shared",
            },
          ],
          {
            onTaskReserved: () => {
              reservations += 1;
            },
          }
        )
      )
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(reservations).toBe(1);
    const failure = results.find((result) => !result.success);
    assert(failure != null && !failure.success);
    expect(failure.error).toContain("controlled by active borrower");
    expect(
      config
        .loadConfigOrDefault()
        .projects.get(projectPath)!
        .workspaces.filter((workspace) => workspace.taskDesktopOwnerWorkspaceId === parentId)
    ).toHaveLength(1);
  });

  test("shared desktop batch preserves distinct owners through queued reservation", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = testTaskSettings(1, 3);
      const project = cfg.projects.get(projectPath)!;
      project.workspaces.push(
        { ...project.workspaces[0], id: "second-parent", name: "second-parent" },
        projectWorkspace(projectPath, "busy", "busy", {
          parentWorkspaceId: parentId,
          taskStatus: "running",
          agentId: "explore",
        })
      );
      return cfg;
    });
    const { taskService } = createTaskServiceHarness(config);
    const owners = [parentId, "second-parent"];
    const result = await taskService.createMany(
      owners.map((owner) => ({
        parentWorkspaceId: owner,
        kind: "agent" as const,
        agentId: "explore",
        prompt: "Inspect",
        title: "Inspector",
        desktop: "shared" as const,
      }))
    );
    assert(result.success);
    expect(result.data.map((task) => task.status)).toEqual(["queued", "queued"]);
    expect(result.data.map((task) => task.desktopOwnerWorkspaceId)).toEqual(owners);
    expect(
      result.data.map(
        (task) => findWorkspaceInConfig(config, task.taskId)?.taskDesktopOwnerWorkspaceId
      )
    ).toEqual(owners);
  });

  test.each([undefined, "isolated"] as const)(
    "desktop specialist queued binding respects explicit override %s",
    async (desktop) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      await config.editConfig((cfg) => {
        cfg.taskSettings = testTaskSettings(1, 3);
        cfg.projects.get(projectPath)!.workspaces.push(
          projectWorkspace(projectPath, "busy", "busy", {
            parentWorkspaceId: parentId,
            agentId: "explore",
            taskStatus: "running",
            runtimeConfig: { type: "local" },
          })
        );
        return cfg;
      });
      const { taskService } = createTaskServiceHarness(config);
      const result = await createAgentTask(taskService, parentId, "Inspect", {
        agentId: " Desktop ",
        desktop,
      });
      assert(result.success);
      expect(result.data.status).toBe("queued");
      expect(findWorkspaceInConfig(config, result.data.taskId)?.taskDesktopOwnerWorkspaceId).toBe(
        desktop === "isolated" ? undefined : parentId
      );
      expect(result.data.desktopOwnerWorkspaceId).toBe(
        desktop === "isolated" ? result.data.taskId : parentId
      );
    }
  );

  test("shared desktop creation waits for open input then releases its gate before sending", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const desktop = new DesktopInputCoordinator(config);
    let releaseInput!: () => void;
    const inputReleased = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    let inputStarted!: () => void;
    const inputEntered = new Promise<void>((resolve) => {
      inputStarted = resolve;
    });
    let reservationStarted!: () => void;
    const reservationEntered = new Promise<void>((resolve) => {
      reservationStarted = resolve;
    });
    const reserve = desktop.withReservation.bind(desktop);
    const reservationSpy = spyOn(desktop, "withReservation").mockImplementation(
      (owner, borrower, persist) => {
        reservationStarted();
        return reserve(owner, borrower, persist);
      }
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    sendMessage.mockImplementation((id: string) =>
      desktop.withInput(id, () => Promise.resolve(Ok(undefined)))
    );
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      desktopInputCoordinator: desktop,
    });
    const input = desktop.withInput(parentId, async () => {
      inputStarted();
      await inputReleased;
    });
    try {
      await inputEntered;
      const creation = createAgentTask(taskService, parentId, "Inspect", { desktop: "shared" });
      await reservationEntered;
      expect(config.loadConfigOrDefault().projects.get(projectPath)?.workspaces).toHaveLength(1);
      expect(sendMessage).not.toHaveBeenCalled();
      releaseInput();
      await input;
      const result = await creation;
      assert(result.success);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const failure = await desktop
        .withInput(parentId, () => Promise.resolve())
        .then(
          () => null,
          (error: unknown) => error
        );
      expect(failure).toBeInstanceOf(Error);
      await taskService.editWorkspaceEntry(result.data.taskId, (workspace) => {
        workspace.taskStatus = "interrupted";
      });
      await desktop.withInput(parentId, () => Promise.resolve());
    } finally {
      releaseInput();
      await input;
      reservationSpy.mockRestore();
    }
  });

  test.each(["queued", "starting", "running", "awaiting_report"] as const)(
    "shared desktop startup recovery refuses a missing owner from %s",
    async (taskStatus) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push(
          projectWorkspace(projectPath, "child", "child", {
            parentWorkspaceId: parentId,
            taskStatus,
            agentId: "explore",
            agentType: "explore",
            runtimeConfig: { type: "local" },
            taskDesktopOwnerWorkspaceId: "deleted",
            taskPrompt: "Inspect",
            taskModelString: "anthropic:claude-opus-4-6",
          })
        );
        return cfg;
      });
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      await taskService.recoverInterruptedTasks();
      await taskService.maybeStartQueuedTasks();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, "child")?.taskStatus).toBe("interrupted");
      expect(findWorkspaceInConfig(config, "child")?.taskDesktopOwnerWorkspaceId).toBe("deleted");
    }
  );

  test("shared desktop failed launch releases the owner for the next child", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    sendMessage.mockResolvedValueOnce(Err("launch refused"));
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const failed = await createAgentTask(taskService, parentId, "First", { desktop: "shared" });
    expect(failed.success).toBe(false);
    const next = await createAgentTask(taskService, parentId, "Second", { desktop: "shared" });
    assert(next.success);
    expect(findWorkspaceInConfig(config, next.data.taskId)?.taskDesktopOwnerWorkspaceId).toBe(
      parentId
    );
    const fork = spyOn(forkOrchestrator, "orchestrateFork");
    try {
      const competing = await createAgentTask(taskService, parentId, "Third", {
        desktop: "shared",
      });
      expect(competing.success).toBe(false);
      expect(fork).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      fork.mockRestore();
    }
  });

  test.each([
    ["initial", "shared", "user", "idle", "interrupted"],
    ["initial", "shared", "system", "idle", "running"],
    ["initial", "isolated", "user", "idle", "running"],
    ["reawakened", "shared", "user", "idle", "interrupted"],
    ["reawakened", "shared", "user", "pending successor", "running"],
  ] as const)(
    "%s %s desktop child %s stream abort while %s leaves the task %s",
    async (run, desktop, abortReason, successor, expectedStatus) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const desktopCoordinator = new DesktopInputCoordinator(config);
      // Drive the real aiService subscription so the abort flows through the event lock.
      const listeners = new Map<string, (payload: unknown) => void>();
      const on = mock((event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler);
      });
      const { aiService } = createAIServiceMocks(config, { on });
      // The real WorkspaceService restores a reawakened child to running before dispatching;
      // the mock mirrors that and accepts the turn.
      const serviceRef: { current?: TaskService } = {};
      // The real WorkspaceService skips its user-resume rescue for a correlated workspace-turn
      // send (createWorkspaceTurn holds the task-creation lock across it, and the rescue's
      // identity CAS serializes on that lock), so the mock only awaits the rescue for
      // uncorrelated sends; for the reawakening turn it is applied once the turn was admitted.
      let deferredRescue: Promise<boolean> | undefined;
      const sendMessage = mock(
        async (
          workspaceId: string,
          _message: string,
          options: { muxMetadata?: unknown },
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          if (parseWorkspaceTurnTaskCorrelation(options?.muxMetadata) == null) {
            await serviceRef.current?.markInterruptedTaskRunning(workspaceId);
          } else {
            deferredRescue = serviceRef.current?.markInterruptedTaskRunning(workspaceId);
          }
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      );
      const { workspaceService } = createWorkspaceServiceMocks({
        sendMessage,
        hasPendingQueuedOrPreparingTurn: mock(() => successor === "pending successor"),
      });
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
        desktopInputCoordinator: desktopCoordinator,
      });
      serviceRef.current = taskService;

      let childId: string;
      let waiter: Promise<string>;
      if (run === "initial") {
        const created = await createAgentTask(taskService, parentId, "Inspect", { desktop });
        assert(created.success, "Expected the child task to start");
        childId = created.data.taskId;
        waiter = taskService.waitForAgentReport(childId, { timeoutMs: 5_000 }).then(
          () => "settled",
          (error: unknown) => (error instanceof Error ? error.message : "?")
        );
      } else {
        childId = "reported-child";
        await config.editConfig((cfg) => {
          cfg.projects.get(projectPath)!.workspaces.push(
            projectWorkspace(projectPath, childId, childId, {
              parentWorkspaceId: parentId,
              agentId: "explore",
              agentType: "explore",
              taskStatus: "reported",
              reportedAt: "2026-09-01T00:00:00.000Z",
              runtimeConfig: { type: "local" },
              taskDesktopOwnerWorkspaceId: parentId,
            })
          );
          return cfg;
        });
        const continuation = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
          ownerWorkspaceId: parentId,
          prompt: "Continue on the same desktop",
          title: "Reawaken",
          allowAgentWorkspace: true,
          workspace: { mode: "existing", workspaceId: childId },
        });
        assert(continuation.success, "Expected the reawakening turn to be admitted");
        expect(await deferredRescue).toBe(true);
        expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
        expect(findWorkspaceInConfig(config, childId)?.taskExecutionStatus).toBe("running");
        waiter = workspaceTurnManagerFor(taskService)
          .waitForWorkspaceTurn(continuation.data.taskId, {
            requestingWorkspaceId: parentId,
            ownerWorkspaceId: parentId,
            timeoutMs: 5_000,
          })
          .then(
            () => "settled",
            (error: unknown) => (error instanceof Error ? error.message : "?")
          );
      }
      const ownerInput = () =>
        desktopCoordinator
          .withInput(parentId, () => Promise.resolve("clicked"))
          .then(
            (value) => value,
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          );
      if (desktop === "shared") {
        expect(await ownerInput()).toContain(`active borrower ${childId}`);
      }

      const onStreamAbort = listeners.get("stream-abort");
      assert(onStreamAbort, "TaskService must subscribe to stream-abort");
      onStreamAbort({
        type: "stream-abort",
        workspaceId: childId,
        messageId: "msg_1",
        abortReason,
      });

      if (expectedStatus === "interrupted") {
        await waitForWorkspaceTaskStatus(config, childId, "interrupted");
        // Clicking Stop in the child UI hands the desktop back to the owner immediately...
        expect(await ownerInput()).toBe("clicked");
        expect(await waiter).toBe(
          run === "initial" ? "Task interrupted" : "Workspace turn interrupted"
        );
        if (run === "reawakened") {
          expect(findWorkspaceInConfig(config, childId)?.taskExecutionStatus).toBe("interrupted");
        }
        // ...and the paused child still reawakens onto the same desktop when the user resumes it.
        expect(await taskService.markInterruptedTaskRunning(childId)).toBe(true);
        expect(findWorkspaceInConfig(config, childId)?.taskDesktopOwnerWorkspaceId).toBe(parentId);
        expect(await ownerInput()).toContain(`active borrower ${childId}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
      if (desktop === "shared") {
        // A pending successor turn (or a non-user abort) keeps the child in control.
        expect(await ownerInput()).toContain(`active borrower ${childId}`);
      } else {
        expect(await ownerInput()).toBe("clicked");
      }
    }
  );

  test.each(["successor mirror", "pending turn"] as const)(
    "user stop release re-evaluates a %s published while its config edit was queued",
    async (race) => {
      const config = await createTestConfig(rootDir);
      const { parentId } = await saveLocalParentWorkspace(config, rootDir);
      const desktopCoordinator = new DesktopInputCoordinator(config);
      const listeners = new Map<string, (payload: unknown) => void>();
      const on = mock((event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler);
      });
      const { aiService } = createAIServiceMocks(config, { on });
      const pendingTurn = { value: false };
      const { workspaceService } = createWorkspaceServiceMocks({
        hasPendingQueuedOrPreparingTurn: mock(() => pendingTurn.value),
      });
      const { taskService } = createTaskServiceHarness(config, {
        aiService,
        workspaceService,
        desktopInputCoordinator: desktopCoordinator,
      });
      const created = await createAgentTask(taskService, parentId, "Inspect", {
        desktop: "shared",
      });
      assert(created.success, "Expected the child task to start");
      const childId = created.data.taskId;

      // The release's edit is the first config edit after the abort. Publish the successor after
      // that edit was scheduled but before its transform runs, mimicking a config-queue suspension.
      const editConfig = config.editConfig.bind(config);
      let releaseEditSettled!: () => void;
      const releaseEdit = new Promise<void>((resolve) => {
        releaseEditSettled = resolve;
      });
      let intercepted = false;
      const editSpy = spyOn(config, "editConfig").mockImplementation(async (transform) => {
        if (intercepted) return editConfig(transform);
        intercepted = true;
        if (race === "successor mirror") {
          await editConfig((cfg) => {
            const child = findWorkspaceEntry(cfg, childId)?.workspace;
            assert(child, "child entry must exist");
            child.taskExecutionId = "wst_successor";
            child.taskExecutionStatus = "running";
            return cfg;
          });
        } else {
          pendingTurn.value = true;
        }
        try {
          return await editConfig(transform);
        } finally {
          releaseEditSettled();
        }
      });
      try {
        const onStreamAbort = listeners.get("stream-abort");
        assert(onStreamAbort, "TaskService must subscribe to stream-abort");
        onStreamAbort({
          type: "stream-abort",
          workspaceId: childId,
          messageId: "msg_1",
          abortReason: "user",
        });
        await releaseEdit;
      } finally {
        editSpy.mockRestore();
      }

      // The stale abort must not clear the successor's control.
      const child = findWorkspaceInConfig(config, childId);
      expect(child?.taskStatus).toBe("running");
      if (race === "successor mirror") {
        expect(child?.taskExecutionId).toBe("wst_successor");
        expect(child?.taskExecutionStatus).toBe("running");
      }
      const ownerInput = await desktopCoordinator
        .withInput(parentId, () => Promise.resolve("clicked"))
        .then(
          (value) => value,
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        );
      expect(ownerInput).toContain(`active borrower ${childId}`);
    }
  );

  test.each(["reported", "interrupted"] as const)(
    "shared desktop %s resume preserves binding and refuses a competing controller",
    async (taskStatus) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      await config.editConfig((cfg) => {
        cfg.projects.get(projectPath)!.workspaces.push(
          ...["child", "competitor"].map((id) =>
            projectWorkspace(projectPath, id, id, {
              parentWorkspaceId: parentId,
              taskStatus: id === "child" ? taskStatus : "running",
              agentId: "explore",
              runtimeConfig: { type: "local" },
              taskDesktopOwnerWorkspaceId: parentId,
            })
          )
        );
        return cfg;
      });
      const { taskService } = createTaskServiceHarness(config);
      const failure = await taskService.markInterruptedTaskRunning("child").then(
        () => null,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(findWorkspaceInConfig(config, "child")?.taskStatus).toBe(taskStatus);
      await taskService.editWorkspaceEntry("competitor", (workspace) => {
        workspace.taskStatus = "interrupted";
      });
      expect(await taskService.markInterruptedTaskRunning("child")).toBe(true);
      expect(await taskService.markInterruptedTaskRunning("child")).toBe(false);
      expect(findWorkspaceInConfig(config, "child")?.taskDesktopOwnerWorkspaceId).toBe(parentId);
      await taskService.restoreInterruptedTaskAfterResumeFailure("child", taskStatus);
      expect(findWorkspaceInConfig(config, "child")?.taskStatus).toBe(taskStatus);
    }
  );

  test("createMany reserves admitted tasks as starting and over-capacity tasks as queued", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 2, maxTaskNestingDepth: 3 };
      return cfg;
    });

    const sendMessage = mock(() => new Promise<Result<void>>(() => undefined));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany(
      ["one", "two", "three"].map((prompt, index) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "explore",
        prompt,
        title: `Task ${index + 1}`,
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "starting", "queued"]);

    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskStatus)).toEqual(["starting", "starting", "queued"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createMany persists task policies for both admitted and queued tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb"], "cccccccccc");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 };
      return cfg;
    });

    const sendMessage = mock(() => new Promise<Result<void>>(() => undefined));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany(
      ["one", "two"].map((prompt, index) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "explore",
        prompt,
        title: `Task ${index + 1}`,
        // Refusal policy must survive queueing so post-restart behavior keeps caller intent.
        onRefusal: "fail" as const,
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "queued"]);

    // Both the immediately-admitted and queued task must persist refusal policy for restart.
    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskOnRefusal)).toEqual(["fail", "fail"]);
    expect(tasks.map((task) => task.taskSticky)).toEqual([undefined, undefined]);
  });

  test("createMany stamps the rlm experiment on admitted and queued task records", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["rlma000001", "rlmq000002"], "rlmfb00003");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 };
      return cfg;
    });

    const sendMessage = mock(() => new Promise<Result<void>>(() => undefined));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany(
      ["one", "two"].map((prompt, index) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "explore",
        prompt,
        title: `Task ${index + 1}`,
        // RLM children must keep family messaging across restarts even when the
        // frontend experiment toggles off, so the spawn stamp is the durable gate.
        experiments: { rlm: true, programmaticToolCalling: true },
      }))
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((task) => task.status)).toEqual(["starting", "queued"]);

    const tasks = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.parentWorkspaceId === parentId);
    expect(tasks.map((task) => task.taskExperiments?.rlm)).toEqual([true, true]);
  });

  test("resolveWorkspaceModelFallbackChain honors taskOnRefusal opt-out", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const failChildId = "child-fail";
    const fallbackChildId = "child-fallback";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-fail", failChildId, {
          name: "agent_explore_fail",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          taskOnRefusal: "fail",
        }),
        projectWorkspace(projectPath, "child-fallback", fallbackChildId, {
          name: "agent_explore_fallback",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );
    await config.editConfig((cfg) => {
      cfg.modelFallbacks = {
        "anthropic:claude-fable-5": { models: ["openai:gpt-5.5"] },
      };
      return cfg;
    });

    const cfg = config.loadConfigOrDefault();

    // Tasks default to the configured chain; "fail" opts out; workspaces not
    // in config (plain non-task sends) keep the chain; unconfigured source
    // models have no chain at all.
    expect(
      resolveWorkspaceModelFallbackChain(cfg, fallbackChildId, "anthropic:claude-fable-5")
    ).toEqual(["openai:gpt-5.5"]);
    expect(
      resolveWorkspaceModelFallbackChain(cfg, failChildId, "anthropic:claude-fable-5")
    ).toEqual([]);
    expect(
      resolveWorkspaceModelFallbackChain(cfg, "not-in-config", "anthropic:claude-fable-5")
    ).toEqual(["openai:gpt-5.5"]);
    expect(resolveWorkspaceModelFallbackChain(cfg, fallbackChildId, "openai:gpt-5.5")).toEqual([]);
  });

  test("createMany launch failure preserves returned task metadata and launch error", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Err("Forbidden")));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const result = await taskService.createMany([
      {
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "launch should fail",
        title: "Failing task",
      },
    ]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const taskId = result.data[0]?.taskId;
    assert(typeof taskId === "string" && taskId.length > 0, "created task id is required");

    let launchError: unknown;
    try {
      await taskService.waitForAgentReport(taskId, {
        timeoutMs: 10_000,
        requestingWorkspaceId: parentId,
      });
    } catch (error: unknown) {
      launchError = error;
    }
    assert(launchError instanceof Error, "waitForAgentReport should reject with launch error");
    expect(launchError.message).toContain("Forbidden");

    const taskEntry = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === taskId);
    expect(taskEntry?.taskStatus).toBe("interrupted");
    expect(taskEntry?.taskLaunchError).toBe("Forbidden");
  });

  test("queues tasks when maxParallelAgentTasks is reached and starts them when a slot frees", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"], "eeeeeeeeee");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parent1Name = "parent1";
    const parent2Name = "parent2";
    await runtime.createWorkspace({
      projectPath,
      branchName: parent1Name,
      trunkBranch: "main",
      directoryName: parent1Name,
      initLogger,
    });
    await runtime.createWorkspace({
      projectPath,
      branchName: parent2Name,
      trunkBranch: "main",
      directoryName: parent2Name,
      initLogger,
    });

    const parent1Id = "1111111111";
    const parent2Id = "2222222222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parent1Name),
          id: parent1Id,
          name: parent1Name,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, parent2Name),
          id: parent2Id,
          name: parent2Name,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const running = await createAgentTask(taskService, parent1Id, "task 1");
    expect(running.success).toBe(true);
    if (!running.success) return;

    const queued = await createAgentTask(taskService, parent2Id, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Free the slot by marking the first task as reported. Also simulate a legacy queued
    // task that only has agentType so dequeue preserves Explore instead of falling back to Exec.
    await config.editConfig((cfg) => {
      for (const [_project, project] of cfg.projects) {
        const ws = project.workspaces.find((w) => w.id === running.data.taskId);
        if (ws) {
          ws.taskStatus = "reported";
        }
        const queuedWs = project.workspaces.find((w) => w.id === queued.data.taskId);
        if (queuedWs) {
          queuedWs.agentId = "";
        }
      }
      return cfg;
    });

    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      await taskService.initialize();
      await taskService.maybeStartQueuedTasks();

      expect(sendMessage).toHaveBeenCalledWith(
        queued.data.taskId,
        "task 2",
        expect.objectContaining({ agentId: "explore" }),
        expect.objectContaining({ allowQueuedAgentTask: true })
      );
      expect(runBackgroundInitSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ skipInitHook: true }),
        queued.data.taskId
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
    }

    const cfg = config.loadConfigOrDefault();
    const started = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
    expect(started?.taskStatus).toBe("running");
  }, 20_000);

  test("resumes accepted queued starts instead of replaying prompts", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_explore_task-queued";
    const acceptedStartingTaskId = "task-starting-accepted";
    const acceptedStartingWorkspaceName = "agent_explore_task-starting-accepted";
    const acceptedPrompt = "already accepted prompt";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, queuedWorkspaceName),
          id: queuedTaskId,
          name: queuedWorkspaceName,
          title: "Legacy queued task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
        },
        {
          path: runtime.getWorkspacePath(projectPath, acceptedStartingWorkspaceName),
          id: acceptedStartingTaskId,
          name: acceptedStartingWorkspaceName,
          title: "Accepted starting task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "starting",
          taskPrompt: acceptedPrompt,
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
        },
      ],
      testTaskSettings(2, 3)
    );

    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, { workspaceService });
    const appendAcceptedPrompt = await historyService.appendToHistory(
      acceptedStartingTaskId,
      createMuxMessage("accepted-starting-prompt", "user", acceptedPrompt)
    );
    expect(appendAcceptedPrompt.success).toBe(true);
    expect(findWorkspaceInConfig(config, queuedTaskId)?.taskPrompt).toBeUndefined();
    expect(findWorkspaceInConfig(config, acceptedStartingTaskId)?.taskPrompt).toBe(acceptedPrompt);

    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      await taskService.initialize();
      await taskService.maybeStartQueuedTasks();

      for (const taskId of [queuedTaskId, acceptedStartingTaskId]) {
        expect(resumeStream).toHaveBeenCalledWith(
          taskId,
          expect.objectContaining({ model: defaultModel, agentId: "explore" }),
          expect.objectContaining({ allowQueuedAgentTask: true, agentInitiated: true })
        );
      }
      const sendMessagePrompts = (
        sendMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.map((call) => call[1]);
      expect(sendMessagePrompts).not.toContain(acceptedPrompt);
    } finally {
      runBackgroundInitSpy.mockRestore();
    }

    await Promise.all([
      waitForWorkspaceTaskStatus(config, queuedTaskId, "running"),
      waitForWorkspaceTaskStatus(config, acceptedStartingTaskId, "running"),
    ]);

    const queued = findWorkspaceInConfig(config, queuedTaskId);
    expect(queued?.taskStatus).toBe("running");
    const acceptedStarting = findWorkspaceInConfig(config, acceptedStartingTaskId);
    expect(acceptedStarting?.taskStatus).toBe("running");
    expect(acceptedStarting?.taskPrompt).toBeUndefined();
  }, 20_000);

  test("does not count foreground-awaiting tasks towards maxParallelAgentTasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    let streamingWorkspaceId: string | null = null;
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === streamingWorkspaceId),
    });

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const rootName = "root";
    await runtime.createWorkspace({
      projectPath,
      branchName: rootName,
      trunkBranch: "main",
      directoryName: rootName,
      initLogger,
    });

    const rootWorkspaceId = "root-111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, rootName),
          id: rootWorkspaceId,
          name: rootName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const parentTask = await createAgentTask(taskService, rootWorkspaceId, "parent task");
    expect(parentTask.success).toBe(true);
    if (!parentTask.success) return;
    streamingWorkspaceId = parentTask.data.taskId;

    // With maxParallelAgentTasks=1, nested tasks will be created as queued.
    const childTask = await createAgentTask(taskService, parentTask.data.taskId, "child task");
    expect(childTask.success).toBe(true);
    if (!childTask.success) return;
    expect(childTask.data.status).toBe("queued");

    // Simulate a foreground await from the parent task workspace. This should allow the queued child
    // to start despite maxParallelAgentTasks=1, avoiding a scheduler deadlock.
    const waiter = taskService.waitForAgentReport(childTask.data.taskId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentTask.data.taskId,
    });

    const internal = taskService as unknown as {
      maybeStartQueuedTasks: () => Promise<void>;
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };

    await internal.maybeStartQueuedTasks();

    expect(sendMessage).toHaveBeenCalledWith(
      childTask.data.taskId,
      "child task",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    const cfgAfterStart = config.loadConfigOrDefault();
    const startedEntry = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childTask.data.taskId);
    expect(startedEntry?.taskStatus).toBe("running");

    internal.resolveWaiters(childTask.data.taskId, { reportMarkdown: "ok" });
    const report = await waiter;
    expect(report.reportMarkdown).toBe("ok");
  }, 20_000);

  test("persists forked runtime config updates when dequeuing tasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb"], "cccccccccc");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const forkedSrcBaseDir = path.join(config.srcDir, "forked-runtime");
    const sourceSrcBaseDir = path.join(config.srcDir, "source-runtime");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- intentionally capturing prototype method for spy
    const originalFork = WorktreeRuntime.prototype.forkWorkspace;
    let forkCallCount = 0;
    const forkSpy = spyOn(WorktreeRuntime.prototype, "forkWorkspace").mockImplementation(
      async function (this: WorktreeRuntime, params: WorkspaceForkParams) {
        const result = await originalFork.call(this, params);
        if (!result.success) return result;
        forkCallCount += 1;
        if (forkCallCount === 2) {
          return {
            ...result,
            forkedRuntimeConfig: { ...runtimeConfig, srcBaseDir: forkedSrcBaseDir },
            sourceRuntimeConfig: { ...runtimeConfig, srcBaseDir: sourceSrcBaseDir },
          };
        }
        return result;
      }
    );

    try {
      const { taskService } = createTaskServiceHarness(config);

      const running = await createAgentTask(taskService, parentId, "task 1");
      expect(running.success).toBe(true);
      if (!running.success) return;

      const queued = await createAgentTask(taskService, parentId, "task 2");
      expect(queued.success).toBe(true);
      if (!queued.success) return;
      expect(queued.data.status).toBe("queued");

      await config.editConfig((cfg) => {
        for (const [_project, project] of cfg.projects) {
          const ws = project.workspaces.find((w) => w.id === running.data.taskId);
          if (ws) {
            ws.taskStatus = "reported";
          }
        }
        return cfg;
      });

      await taskService.initialize();
      await taskService.maybeStartQueuedTasks();

      const postCfg = config.loadConfigOrDefault();
      const workspaces = Array.from(postCfg.projects.values()).flatMap((p) => p.workspaces);
      const parentEntry = workspaces.find((w) => w.id === parentId);
      const childEntry = workspaces.find((w) => w.id === queued.data.taskId);
      expect(parentEntry?.runtimeConfig).toMatchObject({
        type: "worktree",
        srcBaseDir: sourceSrcBaseDir,
      });
      expect(childEntry?.runtimeConfig).toMatchObject({
        type: "worktree",
        srcBaseDir: forkedSrcBaseDir,
      });
    } finally {
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("configures MultiProjectRuntime envResolver before queued task background init", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = await createTestProject(rootDir, "repo-primary");
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary");

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath: primaryProjectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath: primaryProjectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";
    const projects = [
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
      },
      {
        projectPath: secondaryProjectPath,
        projectName: path.basename(secondaryProjectPath),
      },
    ];

    await config.editConfig(() => ({
      projects: new Map([
        [
          primaryProjectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: runtime.getWorkspacePath(primaryProjectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                projects,
              },
              {
                path: runtime.getWorkspacePath(primaryProjectPath, queuedWorkspaceName),
                id: queuedTaskId,
                name: queuedWorkspaceName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                parentWorkspaceId: parentId,
                taskStatus: "queued",
                taskPrompt: "start queued task",
                taskTrunkBranch: "main",
                projects,
              },
            ],
          },
        ],
        [secondaryProjectPath, { trusted: true, workspaces: [] }],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    }));

    await new SecretsStore(config.rootDir).updateProjectSecrets(primaryProjectPath, [
      { key: "PRIMARY_SECRET", value: "primary-secret" },
    ]);
    await new SecretsStore(config.rootDir).updateProjectSecrets(secondaryProjectPath, [
      { key: "SECONDARY_SECRET", value: "secondary-secret" },
    ]);

    const targetRuntime = new MultiProjectRuntime(
      new ContainerManager(config.srcDir),
      [
        {
          projectPath: primaryProjectPath,
          projectName: path.basename(primaryProjectPath),
          runtime: {
            getWorkspacePath: mock(() => path.join(primaryProjectPath, queuedWorkspaceName)),
            initWorkspace: mock(() => Promise.resolve({ success: true })),
          } as unknown as WorktreeRuntime,
        },
        {
          projectPath: secondaryProjectPath,
          projectName: path.basename(secondaryProjectPath),
          runtime: {
            getWorkspacePath: mock(() => path.join(secondaryProjectPath, queuedWorkspaceName)),
            initWorkspace: mock(() => Promise.resolve({ success: true })),
          } as unknown as WorktreeRuntime,
        },
      ],
      queuedWorkspaceName
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue({
      success: true,
      data: {
        workspacePath: path.join(config.srcDir, "_workspaces", queuedWorkspaceName),
        trunkBranch: "main",
        forkedRuntimeConfig: runtimeConfig,
        targetRuntime,
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: false,
        projects,
      },
    });
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );

    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      await taskService.initialize();
      await taskService.maybeStartQueuedTasks();

      expect(forkSpy).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        queuedTaskId,
        "start queued task",
        expect.anything(),
        expect.objectContaining({ allowQueuedAgentTask: true })
      );
      expect(runBackgroundInitSpy).toHaveBeenCalledTimes(1);

      const firstBackgroundInitCall = runBackgroundInitSpy.mock.calls[0];
      assert(firstBackgroundInitCall, "Expected queued task to trigger background init");
      const [runtimeArg, initParams] = firstBackgroundInitCall;
      expect(runtimeArg).toBe(targetRuntime);
      expect(initParams.env).toEqual({ PRIMARY_SECRET: "primary-secret" });
      assert(
        runtimeArg instanceof MultiProjectRuntime,
        "Expected queued task runtime to be multi-project"
      );
      assert(runtimeArg.envResolver, "Expected MultiProjectRuntime.envResolver to be configured");
      expect(await runtimeArg.envResolver(primaryProjectPath)).toEqual({
        PRIMARY_SECRET: "primary-secret",
      });
      expect(await runtimeArg.envResolver(secondaryProjectPath)).toEqual({
        SECONDARY_SECRET: "secondary-secret",
      });
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("isolation: none shares the parent worktree without forking or re-initializing", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const childTaskId = "2222222222";
    stubStableIds(config, [childTaskId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings()
    );

    // orchestrateFork must NOT be called for isolation: "none"; runBackgroundInit is stubbed only
    // so a stray call would be observable (it should not be invoked either).
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, parentId, "read-only analysis", {
        isolation: "none",
      });

      expect(result.success).toBe(true);
      assert(result.success, "Expected shared-workspace task to be created");
      expect(result.data.status).toBe("running");
      expect(result.data.taskId).toBe(childTaskId);

      // No fork and no init: the sub-agent reuses the parent's live checkout.
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();

      // The persisted child entry points at the parent's checkout and is flagged shared.
      const childEntry = findWorkspaceInConfig(config, childTaskId);
      assert(childEntry, "Expected child task workspace to be persisted");
      expect(childEntry.path).toBe(parentPath);
      expect(childEntry.taskIsolation).toBe("none");
      expect(childEntry.runtimeConfig?.type).toBe("worktree");

      expect(sendMessage).toHaveBeenCalledWith(
        childTaskId,
        "read-only analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  async function setUpSharedChild(
    childFields: Partial<WorkspaceConfigEntry> = { taskStatus: "reported" }
  ): Promise<{
    config: Config;
    projectPath: string;
    runtime: ReturnType<typeof createRuntime>;
    parentId: string;
    childTaskId: string;
    parentPath: string;
  }> {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    await runtime.createWorkspace({
      projectPath,
      branchName: "parent",
      trunkBranch: "main",
      directoryName: "parent",
      initLogger: createNullInitLogger(),
    });
    const parentPath = runtime.getWorkspacePath(projectPath, "parent");
    const parentId = "1111111111";
    const childTaskId = "2222222222";
    await saveWorkspaces(
      config,
      projectPath,
      [
        { path: parentPath, id: parentId, name: "parent", runtimeConfig },
        {
          path: parentPath,
          id: childTaskId,
          name: "agent_explore_2222222222",
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          taskIsolation: "none",
          taskTrunkBranch: "parent",
          ...childFields,
        },
      ],
      testTaskSettings()
    );
    return { config, projectPath, runtime, parentId, childTaskId, parentPath };
  }

  async function renameSharedOwner(
    config: Config,
    runtime: ReturnType<typeof createRuntime>,
    projectPath: string,
    ownerId: string
  ): Promise<string> {
    const renamed = await runtime.renameWorkspace(
      projectPath,
      "parent",
      "renamed",
      undefined,
      true
    );
    assert(renamed.success, "Expected owner checkout rename to succeed");
    await config.editConfig((cfg) => {
      const owner = cfg.projects.get(projectPath)?.workspaces.find((ws) => ws.id === ownerId);
      assert(owner, "Expected owner entry");
      owner.name = "renamed";
      owner.path = renamed.newPath;
      return cfg;
    });
    return renamed.newPath;
  }

  test("isolation: none child reawakens in its owner's checkout after the owner is renamed", async () => {
    const { config, projectPath, runtime, parentId, childTaskId, parentPath } =
      await setUpSharedChild();
    const renamedPath = await renameSharedOwner(config, runtime, projectPath, parentId);
    expect(renamedPath).not.toBe(parentPath);

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const result = await taskService.sendMessageToDescendantAgentTask(
      parentId,
      childTaskId,
      "Follow up",
      "tool-end"
    );

    expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
    expect(sendMessage).toHaveBeenCalled();
    expect(config.findWorkspace(childTaskId)?.workspacePath).toBe(renamedPath);
    const metadata = await config.getWorkspaceMetadataById(childTaskId);
    assert(metadata, "Expected child metadata");
    const { runtime: streamRuntime } = createRuntimeContextForWorkspace({
      ...metadata,
      namedWorkspacePath: config.findWorkspace(childTaskId)?.workspacePath,
    });
    expect(await streamRuntime.ensureReady()).toEqual({ ready: true });
  }, 20_000);

  test.each([
    ["a worktree runtime", { taskStatus: "reported" }],
    ["no persisted runtime (legacy default)", { taskStatus: "reported", runtimeConfig: undefined }],
  ] satisfies Array<[string, Partial<WorkspaceConfigEntry>]>)(
    "reawakening a child whose host-local checkout is gone fails without starting a turn (%s)",
    async (_label, childFields) => {
      const { config, parentId, childTaskId, parentPath } = await setUpSharedChild(childFields);
      await fsPromises.rm(parentPath, { recursive: true, force: true });

      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService, historyService } = createTaskServiceHarness(config, {
        workspaceService,
      });
      const result = await taskService.sendMessageToDescendantAgentTask(
        parentId,
        childTaskId,
        "Follow up",
        "tool-end",
        {
          preTurnMessages: [
            createMuxMessage("pre-turn-row", "assistant", "Family note", { timestamp: Date.now() }),
          ],
        }
      );

      expect(result.success).toBe(false);
      assert(!result.success, "Expected reawaken to fail");
      expect(result.error.code).toBe("send_failed");
      expect(sendMessage).not.toHaveBeenCalled();
      const turns = await new TaskHandleStore(config).listWorkspaceTurns(parentId);
      expect(turns).toEqual([]);
      const history = await historyService.getHistoryFromLatestBoundary(childTaskId);
      expect(history).toEqual(Ok([]));
    },
    20_000
  );

  test("dequeued isolation: none task reuses the parent checkout without forking or init", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const queuedTaskId = "task-shared-queued";
    const queuedWorkspaceName = "agent_explore_task-shared-queued";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          // Shared queued tasks persist the parent's checkout path (see TaskService.create).
          path: parentPath,
          id: queuedTaskId,
          name: queuedWorkspaceName,
          title: "Shared queued task",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued shared analysis",
          taskModelString: defaultModel,
          taskTrunkBranch: parentName,
          taskIsolation: "none",
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      await taskService.initialize();
      await waitForWorkspaceTaskStatus(config, queuedTaskId, "running");

      // Dequeue must reuse the existing shared checkout: no fork, no init.
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();

      const entry = findWorkspaceInConfig(config, queuedTaskId);
      assert(entry, "Expected queued shared task to remain persisted");
      expect(entry.path).toBe(parentPath);
      expect(entry.taskIsolation).toBe("none");

      expect(sendMessage).toHaveBeenCalledWith(
        queuedTaskId,
        "queued shared analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("dequeued isolation: none task stays shared when its owner is renamed mid-launch", async () => {
    const { config, projectPath, runtime, parentId, childTaskId } = await setUpSharedChild({
      taskStatus: "queued",
      taskPrompt: "queued shared analysis",
      taskModelString: defaultModel,
    });

    // Rename during admission to exercise the gap between config read and checkout reuse.
    const desktop = new DesktopInputCoordinator(config);
    const admit = desktop.withAdmission.bind(desktop);
    let renamedPath: string | undefined;
    const admissionSpy = spyOn(desktop, "withAdmission").mockImplementation(
      async (workspaceId, fn) => {
        if (
          renamedPath == null &&
          workspaceId === childTaskId &&
          findWorkspaceInConfig(config, childTaskId)?.taskStatus === "starting"
        ) {
          renamedPath = await renameSharedOwner(config, runtime, projectPath, parentId);
        }
        return admit(workspaceId, fn);
      }
    );
    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    try {
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService,
        desktopInputCoordinator: desktop,
      });

      await taskService.initialize();
      await waitForWorkspaceTaskStatus(config, childTaskId, "running");

      assert(renamedPath, "Expected the owner to be renamed during the launch");
      expect(forkSpy).not.toHaveBeenCalled();
      const entry = findWorkspaceInConfig(config, childTaskId);
      // Clearing isolation here would make cleanup treat the owner's checkout as task-owned.
      expect(entry?.taskIsolation).toBe("none");
      expect(entry?.path).toBe(renamedPath);
    } finally {
      forkSpy.mockRestore();
      admissionSpy.mockRestore();
    }
  }, 20_000);

  test("nested isolation: none task inherits the shared parent's real branch and checkout", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const grandparentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: grandparentName,
      trunkBranch: "main",
      directoryName: grandparentName,
      initLogger,
    });
    const checkoutPath = runtime.getWorkspacePath(projectPath, grandparentName);

    const grandparentId = "1111111111";
    const sharedParentId = "2222222222";
    const nestedChildId = "4444444444";
    stubStableIds(config, [nestedChildId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: checkoutPath,
          id: grandparentId,
          name: grandparentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          // The parent is itself a shared task: synthetic name, path = grandparent's checkout,
          // and taskTrunkBranch names the real branch checked out there.
          path: checkoutPath,
          id: sharedParentId,
          name: "agent_explore_shared-parent",
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: grandparentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          taskTrunkBranch: grandparentName,
          taskIsolation: "none",
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      const { workspaceService } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, sharedParentId, "nested analysis", {
        isolation: "none",
      });

      expect(result.success).toBe(true);
      assert(result.success, "Expected nested shared task to be created");
      expect(forkSpy).not.toHaveBeenCalled();

      const childEntry = findWorkspaceInConfig(config, nestedChildId);
      assert(childEntry, "Expected nested shared task to be persisted");
      // Path resolves through the parent's persisted (shared) checkout, not its synthetic name.
      expect(childEntry.path).toBe(checkoutPath);
      // The persisted trunk branch is the REAL branch in the shared checkout (the grandparent's),
      // not the parent's synthetic agent workspace name — fork fallbacks depend on it existing.
      expect(childEntry.taskTrunkBranch).toBe(grandparentName);
      expect(childEntry.taskIsolation).toBe("none");
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("createMany honors isolation: none by reusing the parent checkout", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    const parentId = "1111111111";
    const childTaskId = "3333333333";
    stubStableIds(config, [childTaskId]);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings()
    );

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await taskService.createMany([
        {
          parentWorkspaceId: parentId,
          kind: "agent" as const,
          agentId: "explore",
          prompt: "batched shared analysis",
          title: "Batched shared task",
          isolation: "none" as const,
        },
      ]);

      expect(result.success).toBe(true);
      assert(result.success, "Expected createMany to succeed");
      expect(result.data[0]?.status).toBe("starting");

      // The reserved entry must point at the parent's checkout and carry the shared flag so
      // the reservation launch path reuses it (no fork, no init) and removal preserves it.
      const entry = findWorkspaceInConfig(config, childTaskId);
      assert(entry, "Expected batched shared task to be persisted");
      expect(entry.path).toBe(parentPath);
      expect(entry.taskIsolation).toBe("none");

      await waitForWorkspaceTaskStatus(config, childTaskId, "running");
      expect(forkSpy).not.toHaveBeenCalled();
      expect(runBackgroundInitSpy).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith(
        childTaskId,
        "batched shared analysis",
        expect.anything(),
        expect.objectContaining({ agentInitiated: true })
      );
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  // Issue #4411: a multi-project workspace executes through a MultiProjectRuntime that derives the
  // container (`_workspaces/<name>`) and every per-project checkout (`<srcBaseDir>/<project>/<name>`)
  // from the workspace's OWN name, ignoring any persisted shared path. A multi-project task must
  // therefore fork real checkouts under its own name, and isolation: "none" (which would reuse the
  // parent's checkouts) is refused explicitly rather than silently turned into a fork.
  async function setUpMultiProjectParent(): Promise<{
    config: Config;
    runtimeConfig: { type: "worktree"; srcBaseDir: string };
    projects: Array<{ projectPath: string; projectName: string }>;
    parentId: string;
    containerPath: string;
  }> {
    const config = await createTestConfig(rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const projects: Array<{ projectPath: string; projectName: string }> = [];
    for (const name of ["mp-primary", "mp-secondary"]) {
      const projectPath = await createTestProject(rootDir, name);
      projects.push({ projectPath, projectName: path.basename(projectPath) });
    }
    const parentName = "parent";
    const projectWorkspaces: Array<{ projectName: string; workspacePath: string }> = [];
    for (const project of projects) {
      const created = await createRuntime(runtimeConfig, {
        projectPath: project.projectPath,
      }).createWorkspace({
        projectPath: project.projectPath,
        branchName: parentName,
        trunkBranch: "main",
        directoryName: parentName,
        initLogger: createNullInitLogger(),
      });
      assert(created.success && created.workspacePath, "Expected parent checkout to be created");
      projectWorkspaces.push({
        projectName: project.projectName,
        workspacePath: created.workspacePath,
      });
    }
    // Same layout as WorkspaceService's multi-project create: a container of symlinks, persisted
    // under the _multi bucket with the container as the workspace path.
    const containerPath = await new ContainerManager(config.srcDir).createContainer(
      parentName,
      projectWorkspaces
    );
    const parentId = "1111111111";
    await config.editConfig(() => {
      const projectsConfig: ProjectsConfig["projects"] = new Map();
      projectsConfig.set(MULTI_PROJECT_CONFIG_KEY, {
        projectKind: "system",
        workspaces: [
          {
            path: containerPath,
            id: parentId,
            name: parentName,
            createdAt: new Date().toISOString(),
            runtimeConfig,
            projects,
          },
        ],
      });
      for (const project of projects) {
        projectsConfig.set(project.projectPath, { trusted: true, workspaces: [] });
      }
      return { projects: projectsConfig, taskSettings: testTaskSettings() };
    });
    return { config, runtimeConfig, projects, parentId, containerPath };
  }

  function createMultiProjectExperimentHost() {
    return createWorkspaceServiceMocks({
      isExperimentEnabled: mock(
        (experimentId: string) => experimentId === EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
      ),
    });
  }

  // Mirrors AIService.createWorkspaceRuntimeContext for multi-project rows: every path comes from
  // the task's own name, so each one must exist on disk for the task to run anywhere real.
  function expectMultiProjectExecutionPathsExist(
    config: Config,
    runtimeConfig: { type: "worktree"; srcBaseDir: string },
    projects: Array<{ projectPath: string; projectName: string }>,
    childEntry: WorkspaceConfigEntry
  ): void {
    const childName = childEntry.name;
    assert(childName, "Expected child task to have a workspace name");
    expect(childEntry.projects).toEqual(projects);
    expect(existsSync(new ContainerManager(config.srcDir).getContainerPath(childName))).toBe(true);
    for (const project of projects) {
      const projectRuntime = createRuntime(runtimeConfig, {
        projectPath: project.projectPath,
        workspaceName: childName,
      });
      expect(existsSync(projectRuntime.getWorkspacePath(project.projectPath, childName))).toBe(
        true
      );
    }
  }

  test("a multi-project task forks checkouts under its own name that execution can use", async () => {
    const { config, runtimeConfig, projects, parentId, containerPath } =
      await setUpMultiProjectParent();
    const childTaskId = "2222222222";
    stubStableIds(config, [childTaskId]);

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    const runBackgroundInitSpy = spyOn(runtimeFactory, "runBackgroundInit").mockImplementation(() =>
      Promise.resolve(undefined)
    );
    try {
      const { workspaceService } = createMultiProjectExperimentHost();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, parentId, "multi-project analysis");

      expect(result.success).toBe(true);
      assert(result.success, "Expected multi-project task to be created");
      expect(forkSpy).toHaveBeenCalledTimes(1);

      const childEntry = findWorkspaceInConfig(config, childTaskId);
      assert(childEntry, "Expected child task workspace to be persisted");
      expect(childEntry.taskIsolation).toBeUndefined();
      expect(childEntry.path).not.toBe(containerPath);
      expectMultiProjectExecutionPathsExist(config, runtimeConfig, projects, childEntry);
    } finally {
      runBackgroundInitSpy.mockRestore();
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("create refuses isolation: none under a multi-project parent before reserving or forking", async () => {
    const { config, parentId } = await setUpMultiProjectParent();
    const childTaskId = "2222222222";
    stubStableIds(config, [childTaskId]);

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    try {
      const { workspaceService, sendMessage } = createMultiProjectExperimentHost();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await createAgentTask(taskService, parentId, "multi-project analysis", {
        isolation: "none",
      });

      expect(result.success).toBe(false);
      assert(!result.success, "Expected isolation: none to be refused");
      expect(result.error).toContain('isolation: "none"');
      expect(result.error).toContain('isolation: "fork"');
      expect(forkSpy).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
    } finally {
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("createMany refuses isolation: none under a multi-project parent before reserving or forking", async () => {
    const { config, parentId } = await setUpMultiProjectParent();
    const childTaskId = "3333333333";
    stubStableIds(config, [childTaskId]);

    const forkSpy = spyOn(forkOrchestrator, "orchestrateFork");
    try {
      const { workspaceService, sendMessage } = createMultiProjectExperimentHost();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      const result = await taskService.createMany([
        {
          parentWorkspaceId: parentId,
          kind: "agent" as const,
          agentId: "explore",
          prompt: "batched multi-project analysis",
          title: "Batched multi-project task",
          isolation: "none" as const,
        },
      ]);

      expect(result.success).toBe(false);
      assert(!result.success, "Expected isolation: none to be refused");
      expect(result.error).toContain('isolation: "none"');
      expect(result.error).toContain('isolation: "fork"');
      expect(forkSpy).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
    } finally {
      forkSpy.mockRestore();
    }
  }, 20_000);

  test("interrupts queued tasks when the primary project loses trust before dequeue", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        {
          path: runtime.getWorkspacePath(projectPath, queuedWorkspaceName),
          id: queuedTaskId,
          name: queuedWorkspaceName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
          parentWorkspaceId: parentId,
          taskStatus: "queued",
          taskPrompt: "start queued task",
          taskTrunkBranch: "main",
        },
      ],
      testTaskSettings(1, 3)
    );

    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "Expected queued task project to exist before revoking trust");
      project.trusted = false;
      return cfg;
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();
    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const queuedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
  }, 20_000);

  test("interrupts queued multi-project tasks when a secondary project loses trust", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = await createTestProject(rootDir, "repo-primary");
    const secondaryProjectPath = await createTestProject(rootDir, "repo-secondary");

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath: primaryProjectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath: primaryProjectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    const queuedTaskId = "task-queued";
    const queuedWorkspaceName = "agent_exec_task-queued";
    const projects = [
      {
        projectPath: primaryProjectPath,
        projectName: path.basename(primaryProjectPath),
      },
      {
        projectPath: secondaryProjectPath,
        projectName: path.basename(secondaryProjectPath),
      },
    ];

    await config.editConfig(() => ({
      projects: new Map([
        [
          primaryProjectPath,
          {
            trusted: true,
            workspaces: [
              {
                path: runtime.getWorkspacePath(primaryProjectPath, parentName),
                id: parentId,
                name: parentName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                projects,
              },
              {
                path: runtime.getWorkspacePath(primaryProjectPath, queuedWorkspaceName),
                id: queuedTaskId,
                name: queuedWorkspaceName,
                createdAt: new Date().toISOString(),
                runtimeConfig,
                parentWorkspaceId: parentId,
                taskStatus: "queued",
                taskPrompt: "start queued task",
                taskTrunkBranch: "main",
                projects,
              },
            ],
          },
        ],
        [secondaryProjectPath, { trusted: true, workspaces: [] }],
      ]),
      taskSettings: { maxParallelAgentTasks: 1, maxTaskNestingDepth: 3 },
    }));

    await config.editConfig((cfg) => {
      const secondaryProject = cfg.projects.get(secondaryProjectPath);
      assert(secondaryProject, "Expected secondary project to exist before revoking trust");
      secondaryProject.trusted = false;
      return cfg;
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();
    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const queuedTask = Array.from(postCfg.projects.values())
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
  }, 20_000);

  test("does not run init hooks for queued tasks until they start", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const initLogger = createNullInitLogger();

    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const initStateManager = new RealInitStateManager(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager: initStateManager as unknown as InitStateManager,
    });

    const running = await createAgentTask(taskService, parentId, "task 1");
    expect(running.success).toBe(true);
    if (!running.success) return;

    // Wait for running task init (fire-and-forget) so the init-status file exists.
    await initStateManager.waitForInit(running.data.taskId);

    const queued = await createAgentTask(taskService, parentId, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    // Queued tasks should not create a worktree directory until they're dequeued.
    const cfgBeforeStart = config.loadConfigOrDefault();
    const queuedEntryBeforeStart = Array.from(cfgBeforeStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
    expect(queuedEntryBeforeStart).toBeTruthy();
    await fsPromises.stat(queuedEntryBeforeStart!.path).then(
      () => {
        throw new Error("Expected queued task workspace path to not exist before start");
      },
      () => undefined
    );

    const queuedInitStatusPath = path.join(
      config.sessionsDir,
      queued.data.taskId,
      "init-status.json"
    );
    await fsPromises.stat(queuedInitStatusPath).then(
      () => {
        throw new Error("Expected queued task init-status to not exist before start");
      },
      () => undefined
    );

    // Free slot and start queued tasks.
    await config.editConfig((cfg) => {
      for (const [_project, project] of cfg.projects) {
        const ws = project.workspaces.find((w) => w.id === running.data.taskId);
        if (ws) {
          ws.taskStatus = "reported";
        }
      }
      return cfg;
    });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(sendMessage).toHaveBeenCalledWith(
      queued.data.taskId,
      "task 2",
      expect.anything(),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );

    // Init should start only once the task is dequeued.
    await initStateManager.waitForInit(queued.data.taskId);
    expect(await fsPromises.stat(queuedInitStatusPath)).toBeTruthy();

    const cfgAfterStart = config.loadConfigOrDefault();
    const queuedEntryAfterStart = Array.from(cfgAfterStart.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queued.data.taskId);
    expect(queuedEntryAfterStart).toBeTruthy();
    expect(await fsPromises.stat(queuedEntryAfterStart!.path)).toBeTruthy();
  }, 20_000);

  test("startup recovery does not wait for queued task launches to finish", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const parentName = "parent";
    await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger: createNullInitLogger(),
    });
    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, parentName),
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const running = await createAgentTask(taskService, parentId, "task 1");
    expect(running.success).toBe(true);
    if (!running.success) return;
    const queued = await createAgentTask(taskService, parentId, "task 2");
    expect(queued.success).toBe(true);
    if (!queued.success) return;
    expect(queued.data.status).toBe("queued");

    await config.editConfig((cfg) => {
      for (const [_project, project] of cfg.projects) {
        const ws = project.workspaces.find((w) => w.id === running.data.taskId);
        if (ws) ws.taskStatus = "reported";
      }
      return cfg;
    });

    // The dequeued launch's first turn hangs, like a stream start blocked on a slow runtime.
    const launchSend = Promise.withResolvers<Result<void>>();
    const launchSendStarted = Promise.withResolvers<void>();
    sendMessage.mockImplementationOnce(() => {
      launchSendStarted.resolve();
      return launchSend.promise;
    });

    const recovery = taskService.recoverInterruptedTasks();
    await launchSendStarted.promise;
    try {
      expect((await raceWithAbortAndTimeout(recovery, { timeoutMs: 5_000 })).kind).toBe("ok");
      // Shutdown joins the drain instead: it still covers the hanging launch.
      const drainSettled = taskService.queueDrainSettled();
      expect((await raceWithAbortAndTimeout(drainSettled, { timeoutMs: 50 })).kind).toBe("timeout");
      launchSend.resolve(Ok(undefined));
      expect((await raceWithAbortAndTimeout(drainSettled, { timeoutMs: 5_000 })).kind).toBe("ok");
    } finally {
      launchSend.resolve(Ok(undefined));
      await recovery;
    }
    await taskService.maybeStartQueuedTasks();
    expect(findWorkspaceInConfig(config, queued.data.taskId)?.taskStatus).toBe("running");
  }, 20_000);

  test("does not start queued tasks while a reported task is still streaming", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const reportedTaskId = "task-reported";
    const queuedTaskId = "task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "reported", reportedTaskId, {
          name: "agent_explore_reported",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "reported",
        }),
        projectWorkspace(projectPath, "queued", queuedTaskId, {
          name: "agent_explore_queued",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "queued",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === reportedTaskId),
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(sendMessage).not.toHaveBeenCalled();

    const cfg = config.loadConfigOrDefault();
    const queued = Array.from(cfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === queuedTaskId);
    expect(queued?.taskStatus).toBe("queued");
  });

  test("allows multiple agent tasks under the same parent up to maxParallelAgentTasks", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], "dddddddddd");

    const projectPath = await createTestProject(rootDir);

    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });

    const initLogger = createNullInitLogger();

    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger,
    });
    expect(parentCreate.success).toBe(true);

    const parentId = "1111111111";
    const parentPath = runtime.getWorkspacePath(projectPath, parentName);

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: parentName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
      ],
      testTaskSettings(2, 3)
    );
    const { taskService } = createTaskServiceHarness(config);

    const first = await createAgentTask(taskService, parentId, "task 1");
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.status).toBe("running");

    const second = await createAgentTask(taskService, parentId, "task 2");
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.status).toBe("running");

    const third = await createAgentTask(taskService, parentId, "task 3");
    expect(third.success).toBe(true);
    if (!third.success) return;
    expect(third.data.status).toBe("queued");
  }, 20_000);

  test("supports creating agent tasks from local (project-dir) workspaces without requiring git", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        },
      ],
      testTaskSettings()
    );
    const { taskService } = createTaskServiceHarness(config);

    const created = await createAgentTask(taskService, parentId, "run task from local workspace", {
      modelString: "openai:gpt-5.2",
      thinkingLevel: "medium",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.path).toBe(projectPath);
    expect(childEntry?.runtimeConfig?.type).toBe("local");
    expect(childEntry?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "medium" });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);
});
