/**
 * What a sub-agent launch leaves behind when it fails, is stopped, or reclaims its checkout. The
 * launch runs after create() returned at the reservation, so these outcomes reach the parent and
 * a later removal only through the task's row, its failure artifacts and its waiters.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Err, Ok, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import { getErrorMessage } from "@/common/utils/errors";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { Config } from "@/node/config";
import { DockerRuntime, getContainerName } from "@/node/runtime/DockerRuntime";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import * as runtimeHelpers from "@/node/runtime/runtimeHelpers";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import type { CoderService } from "@/node/services/coderService";
import type { HistoryService } from "@/node/services/historyService";
import { InitStateManager } from "@/node/services/initStateManager";
import type { TaskService } from "@/node/services/taskService";
import { createTaskAwaitTool } from "@/node/services/tools/task_await";
import { createTestToolConfig, mockToolCallOptions } from "@/node/services/tools/testHelpers";
import * as forkOrchestrator from "@/node/services/utils/forkOrchestrator";
import {
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  flushTerminalAttentionDrains,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

const SEND_FAILURE = "provider unavailable";

/** The parent's history messages that report a sub-agent failure. */
async function failureMessages(historyService: HistoryService, parentId: string) {
  const history = await historyService.getHistoryFromLatestBoundary(parentId);
  assert(history.success, "the parent's history must be readable");
  return history.data.filter(
    (message) =>
      message.role === "user" &&
      message.metadata?.synthetic === true &&
      message.parts.some(
        (part) => part.type === "text" && part.text.includes("<mux_subagent_failure>")
      )
  );
}

describe("a sub-agent launch after create() returned", () => {
  let rootDir: string;
  let config: Config;
  let services: TaskService[];
  // Gates a test holds; opened before teardown waits for the launches they hold.
  let gates: Array<() => void>;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    services = [];
    gates = [];
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const open of gates) open();
    for (const taskService of services) {
      await taskService.reservedLaunchesSettled();
      await flushTerminalAttentionDrains(taskService);
    }
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  function harness(overrides: Parameters<typeof createTaskServiceHarness>[1] = {}) {
    const created = createTaskServiceHarness(config, overrides);
    services.push(created.taskService);
    return created;
  }

  test("a Docker task forks its own container though the parent's container has /src", async () => {
    const projectPath = await createTestProject(rootDir, "docker-project", { initGit: false });
    const parentId = "dockerparent";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          id: parentId,
          name: "parent",
          path: "/src",
          runtimeConfig: { type: "docker", image: "test-image" },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "high" },
        },
      ],
      testTaskSettings(3)
    );
    // Only the parent's container exists. Its /src is the project; any other container's
    // commands fail, as a missing container's do.
    const parentContainer = getContainerName(projectPath, "parent");
    const local = new LocalRuntime(projectPath);
    const toHostPath = (filePath: string) =>
      filePath
        .replace(/^\/src(?=\/|$)/, projectPath)
        .replace(/^\/root(?=\/|$)/, `${rootDir}/container-home`);
    spyOn(DockerRuntime.prototype, "readFile").mockImplementation((filePath, signal, options) =>
      local.readFile(toHostPath(filePath), signal, options)
    );
    spyOn(DockerRuntime.prototype, "stat").mockImplementation(function (
      this: DockerRuntime,
      filePath,
      signal
    ) {
      if (this.getContainerName() !== parentContainer) {
        return Promise.reject(new Error("No such container"));
      }
      return local.stat(toHostPath(filePath), signal);
    });
    spyOn(DockerRuntime.prototype, "exec").mockImplementation((command, options) =>
      local.exec(command, { ...options, cwd: projectPath })
    );
    const fork = spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue(
      Err("fork was invoked")
    );
    const host = createWorkspaceServiceMocks();
    const { taskService } = harness({ workspaceService: host.workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Read the repository",
      title: "Docker child",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    await taskService.reservedLaunchesSettled();

    expect(fork).toHaveBeenCalledTimes(1);
    expect(host.sendMessage.mock.calls.some(([id]) => id === created.data.taskId)).toBe(false);
  });

  describe("a task stopped while its checkout forks", () => {
    /** What a test does to the stopped task, and what the launch's sanitize returns. */
    interface StoppedLaunchScenario {
      sanitizeResult: string | undefined;
      /** Runs after the Stop, before the fork returns. */
      beforeForkReturns?: (taskService: TaskService, taskId: string) => Promise<void>;
      /** Runs while the launch sanitizes the stopped task's checkout. */
      whileSanitizing?: (taskService: TaskService, taskId: string) => Promise<void>;
    }

    /** A resume of the stopped task, as a user's send makes before the send itself. */
    async function resume(taskService: TaskService, taskId: string) {
      const resumed = await taskService.reawakenInterruptedTask(taskId);
      expect(resumed.kind).toBe("reawakened");
      // Nothing can run the task yet: sends and MCP refuse it, also after a restart.
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeDefined();
    }

    /** Forks a real worktree, stops the task while the fork returns, and lets the launch end. */
    async function stopTaskDuringFork(scenario: StoppedLaunchScenario) {
      const projectPath = await createTestProject(rootDir, "worktree-project");
      const parentId = "wtparent";
      stubStableIds(config, ["stoppedchild"]);
      await saveWorkspaces(
        config,
        projectPath,
        [
          {
            id: parentId,
            name: "main",
            path: projectPath,
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "high" },
          },
        ],
        testTaskSettings(3)
      );
      const forked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      gates.push(release.resolve);
      const realFork = forkOrchestrator.orchestrateFork;
      spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(async (options) => {
        const result = await realFork(options);
        forked.resolve();
        await release.promise;
        return result;
      });
      const host = createWorkspaceServiceMocks();
      const initStateManager = new InitStateManager(config);
      spyOn(initStateManager, "startInit").mockImplementation(() => undefined);
      spyOn(initStateManager, "endInit").mockResolvedValue(undefined);
      const { taskService } = harness({
        workspaceService: host.workspaceService,
        initStateManager,
      });
      const reserved = Promise.withResolvers<string>();
      const sanitize = spyOn(
        host.workspaceService,
        "sanitizeMaterializedTaskWorkspace"
      ).mockImplementation(async () => {
        await scenario.whileSanitizing?.(taskService, await reserved.promise);
        return scenario.sanitizeResult;
      });

      const created = await taskService.create({
        parentWorkspaceId: parentId,
        kind: "agent",
        agentId: "explore",
        prompt: "Read the repository",
        title: "Stopped while forking",
      });
      assert(
        created.success,
        `the spawn must be reserved: ${created.success ? "" : created.error}`
      );
      const taskId = created.data.taskId;
      reserved.resolve(taskId);
      await forked.promise;
      const stopped = await taskService.stopDescendantAgentTask(parentId, taskId);
      assert(stopped.success, JSON.stringify(stopped));
      await scenario.beforeForkReturns?.(taskService, taskId);
      release.resolve();
      await taskService.reservedLaunchesSettled();
      return { taskId, host, sanitize, initStateManager };
    }

    test("gets that checkout sanitized all the same, which lifts its quarantine", async () => {
      const { taskId, host, sanitize } = await stopTaskDuringFork({ sanitizeResult: undefined });
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
      expect(sanitize).toHaveBeenCalledWith(taskId, expect.any(String), expect.anything());
      expect(host.sendMessage.mock.calls.some(([id]) => id === taskId)).toBe(false);
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeUndefined();
    }, 20_000);

    test("keeps a checkout that fails to sanitize quarantined, also after a restart", async () => {
      const { taskId, initStateManager } = await stopTaskDuringFork({
        sanitizeResult: "fixture: sanitize failed",
      });
      expect(initStateManager.getUnsanitizedCheckoutError(taskId)).toBeDefined();
      expect(findWorkspaceInConfig(config, taskId)?.taskCheckoutUnsanitized).toBe(true);
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeDefined();
    }, 20_000);

    test("gets that checkout sanitized when a resume superseded the launch before the fork returned", async () => {
      const { taskId, sanitize } = await stopTaskDuringFork({
        sanitizeResult: undefined,
        beforeForkReturns: resume,
      });
      expect(sanitize).toHaveBeenCalledTimes(1);
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeUndefined();
    }, 20_000);

    test("keeps the quarantine across a restart when a resume lands while a failing sanitize runs", async () => {
      const { taskId } = await stopTaskDuringFork({
        sanitizeResult: "fixture: sanitize failed",
        whileSanitizing: resume,
      });
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeDefined();
    }, 20_000);
  });

  test("a task is quarantined from its reservation until its launch sanitizes its checkout", async () => {
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const host = createWorkspaceServiceMocks();
    const sanitizing = Promise.withResolvers<void>();
    const sanitizeMayPass = Promise.withResolvers<void>();
    gates.push(sanitizeMayPass.resolve);
    spyOn(host.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
      async () => {
        sanitizing.resolve();
        await sanitizeMayPass.promise;
        return undefined;
      }
    );
    const { taskService } = harness({ workspaceService: host.workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Read the repository",
      title: "Quarantined until sanitized",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    // Before the reservation returned, and still while the sanitize runs: a restart at either
    // point keeps refusing the task.
    expect(
      new InitStateManager(config).getUnsanitizedCheckoutError(created.data.taskId)
    ).toBeDefined();
    await sanitizing.promise;
    expect(
      new InitStateManager(config).getUnsanitizedCheckoutError(created.data.taskId)
    ).toBeDefined();

    sanitizeMayPass.resolve();
    await taskService.reservedLaunchesSettled();
    expect(findWorkspaceInConfig(config, created.data.taskId)?.taskStatus).toBe("running");
    expect(
      new InitStateManager(config).getUnsanitizedCheckoutError(created.data.taskId)
    ).toBeUndefined();
  });

  test("a foreground spawn backgrounded while it sanitizes still gets its launch failure delivered", async () => {
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const host = createWorkspaceServiceMocks();
    const sanitizing = Promise.withResolvers<void>();
    const sanitizeMayFail = Promise.withResolvers<void>();
    gates.push(sanitizeMayFail.resolve);
    spyOn(host.workspaceService, "sanitizeMaterializedTaskWorkspace").mockImplementation(
      async () => {
        sanitizing.resolve();
        await sanitizeMayFail.promise;
        return "Cannot sanitize stale plugin override";
      }
    );
    const { taskService, historyService } = harness({ workspaceService: host.workspaceService });
    const wakes = spyOn(taskService, "enqueueTerminalAttention");

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Read the repository",
      title: "Backgrounded while sanitizing",
      attentionPolicy: "blocking_until_terminal",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    const foregroundWait = taskService
      .waitForAgentReport(created.data.taskId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: true,
      })
      .catch(() => undefined);
    await sanitizing.promise;
    // A message queued for the parent sends its foreground waits to the background.
    expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(1);
    await foregroundWait;

    sanitizeMayFail.resolve();
    await taskService.reservedLaunchesSettled();
    expect(await failureMessages(historyService, parentId)).toHaveLength(1);
    expect(wakes).toHaveBeenCalledTimes(1);
  });

  test("task_await returns the launch error of a task whose reclaim removed its row", async () => {
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const host = createWorkspaceServiceMocks();
    const failure = "Cannot sanitize stale plugin override";
    spyOn(host.workspaceService, "sanitizeMaterializedTaskWorkspace").mockResolvedValue(failure);
    const { taskService } = harness({ workspaceService: host.workspaceService });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Read the repository",
      title: "Child whose sanitize fails",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    await taskService.reservedLaunchesSettled();
    expect(findWorkspaceInConfig(config, created.data.taskId)).toBeUndefined();

    const awaitTool = createTaskAwaitTool({
      ...createTestToolConfig(rootDir, { workspaceId: parentId }),
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      taskService,
      workspaceTurnManager: workspaceTurnManagerFor(taskService),
    });
    assert(awaitTool.execute != null);
    const result: unknown = await awaitTool.execute(
      { task_ids: [created.data.taskId], timeout_secs: 0 },
      mockToolCallOptions
    );
    expect(result).toMatchObject({
      results: [
        {
          status: "error",
          taskId: created.data.taskId,
          error: expect.stringContaining(failure) as string,
        },
      ],
    });
  });

  test("a wait that starts as the reclaim removes the task's row gets the launch error", async () => {
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const host = createWorkspaceServiceMocks();
    const failure = "Cannot sanitize stale plugin override";
    spyOn(host.workspaceService, "sanitizeMaterializedTaskWorkspace").mockResolvedValue(failure);
    const { taskService } = harness({ workspaceService: host.workspaceService });
    const taskRowIds = () =>
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .flatMap((ws) => (ws.parentWorkspaceId === parentId && ws.id != null ? [ws.id] : []));
    // The wait starts right after the config edit that removes the task's row, and the launch
    // goes on only once the wait settled.
    let waitAtRemoval: Promise<string> | undefined;
    const editConfig = config.editConfig.bind(config);
    spyOn(config, "editConfig").mockImplementation(async (...args) => {
      const idsBefore = taskRowIds();
      await editConfig(...args);
      const removedId = idsBefore.find((id) => !taskRowIds().includes(id));
      if (removedId != null && waitAtRemoval == null) {
        waitAtRemoval = taskService
          .waitForAgentReport(removedId, { requestingWorkspaceId: parentId })
          .then(
            () => "reported",
            (error: unknown) => getErrorMessage(error)
          );
        await waitAtRemoval;
      }
    });

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Read the repository",
      title: "Child whose sanitize fails",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    await taskService.reservedLaunchesSettled();

    expect(findWorkspaceInConfig(config, created.data.taskId)).toBeUndefined();
    expect(await waitAtRemoval).toBe(failure);
  });

  test("a foreground spawn whose launch fails with no waiter pending still reaches the parent", async () => {
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        (workspaceId: string): Promise<Result<void, SendMessageError>> =>
          Promise.resolve(
            workspaceId === parentId ? Ok(undefined) : Err({ type: "unknown", raw: SEND_FAILURE })
          )
      ),
    });
    const { taskService, historyService } = harness({ workspaceService });
    const wakes = spyOn(taskService, "enqueueTerminalAttention");

    const created = await taskService.create({
      parentWorkspaceId: parentId,
      kind: "agent",
      agentId: "explore",
      prompt: "Survey the repository",
      title: "Survey",
      attentionPolicy: "blocking_until_terminal",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    // The launch fails before any wait, as after a restart, where no wait of the parent's turn
    // survives: like a stream failure, it then reaches the parent's history and wakes it.
    await taskService.reservedLaunchesSettled();
    expect(await failureMessages(historyService, parentId)).toHaveLength(1);
    expect(wakes).toHaveBeenCalledTimes(1);

    // A wait started later still gets the launch error.
    const waited = taskService.waitForAgentReport(created.data.taskId, {
      requestingWorkspaceId: parentId,
      backgroundOnMessageQueued: true,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see
    await expect(waited).rejects.toThrow(SEND_FAILURE);
  });
});

describe("a Coder parent's task whose fork does not finish", () => {
  // A parent on a Coder workspace that Xum created: removing a workspace with this runtime
  // config deletes the Coder workspace itself (CoderSSHRuntime.deleteWorkspace).
  const DEDICATED_CODER_RUNTIME = {
    type: "ssh",
    host: "mux-parent.coder",
    srcBaseDir: "~/mux",
    coder: { workspaceName: "mux-parent", existingWorkspace: false },
  } satisfies RuntimeConfig;
  const PARENT_ID = "1111111111";

  /** Reads the local project for the parent; a task's checkout path does not exist yet. */
  class CheckoutProbeRuntime extends LocalRuntime {
    override getWorkspacePath(projectPath: string, workspaceName: string): string {
      return workspaceName === "parent"
        ? projectPath
        : path.join(path.dirname(projectPath), "never-forked", workspaceName);
    }
  }

  let rootDir: string;
  let config: Config;
  let services: TaskService[];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    services = [];
    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: PARENT_ID,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: DEDICATED_CODER_RUNTIME,
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      testTaskSettings(3)
    );
    // Every runtime the spawn builds reads the local project instead of an SSH host.
    spyOn(runtimeHelpers, "createRuntimeForWorkspace").mockImplementation(
      () => new CheckoutProbeRuntime(projectPath)
    );
    spyOn(runtimeFactory, "runBackgroundInit").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    for (const taskService of services) {
      await taskService.reservedLaunchesSettled();
      await flushTerminalAttentionDrains(taskService);
    }
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  async function spawnChild() {
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    services.push(taskService);
    const created = await taskService.create({
      parentWorkspaceId: PARENT_ID,
      kind: "agent",
      agentId: "explore",
      prompt: "Survey the repository",
      title: "Survey",
      attentionPolicy: "notify_on_terminal",
    });
    assert(created.success, `the spawn must be reserved: ${created.success ? "" : created.error}`);
    return { taskService, taskId: created.data.taskId };
  }

  /** The Coder workspaces a forced removal of a workspace's row deletes (as task_remove does). */
  async function coderWorkspacesDeletedByRemoving(workspaceId: string): Promise<unknown[]> {
    const row = findWorkspaceInConfig(config, workspaceId);
    assert(
      row?.runtimeConfig != null && row.name != null,
      "the workspace's row must have a runtime config and a name"
    );
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    // The SSH cleanup of the workspace's own directory is not under test.
    spyOn(SSHRuntime.prototype, "deleteWorkspace").mockResolvedValue({
      success: true,
      deletedPath: row.path,
    });
    const runtime = runtimeFactory.createRuntime(row.runtimeConfig, {
      projectPath: path.dirname(row.path),
      workspaceName: row.name,
      workspacePath: row.path,
      coderService: { deleteWorkspaceEventually } as unknown as CoderService,
    });
    await runtime.deleteWorkspace(path.dirname(row.path), row.name, true);
    return deleteWorkspaceEventually.mock.calls.map(([name]: unknown[]) => name);
  }

  test("a failed fork leaves a row whose removal keeps the parent's Coder workspace", async () => {
    spyOn(forkOrchestrator, "orchestrateFork").mockResolvedValue(
      Err("ssh: connect to host mux-parent.coder port 22: Connection refused")
    );
    const { taskService, taskId } = await spawnChild();
    await taskService.reservedLaunchesSettled();
    expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
    expect(await coderWorkspacesDeletedByRemoving(taskId)).toEqual([]);
  });

  /**
   * Stops the task while its fork runs, then lets the fork finish as a Coder fork does: both the
   * task and the parent share the parent's Coder workspace. Returns once the launch ended.
   */
  async function stopTaskDuringFork(): Promise<string> {
    const sharedRuntime: RuntimeConfig = {
      ...DEDICATED_CODER_RUNTIME,
      coder: { workspaceName: "mux-parent", existingWorkspace: true },
    };
    const forkEntered = Promise.withResolvers<void>();
    const forkMayFinish = Promise.withResolvers<void>();
    spyOn(forkOrchestrator, "orchestrateFork").mockImplementation(async () => {
      forkEntered.resolve();
      await forkMayFinish.promise;
      return Ok({
        workspacePath: path.join(rootDir, "never-forked", "child"),
        trunkBranch: "main",
        forkedRuntimeConfig: sharedRuntime,
        sourceRuntimeConfigUpdate: sharedRuntime,
        targetRuntime: new LocalRuntime(rootDir),
        forkedFromSource: true,
        sourceRuntimeConfigUpdated: true,
      });
    });
    try {
      const { taskService, taskId } = await spawnChild();
      await forkEntered.promise;
      const stopped = await taskService.stopDescendantAgentTask(PARENT_ID, taskId);
      assert(stopped.success, JSON.stringify(stopped));
      forkMayFinish.resolve();
      await taskService.reservedLaunchesSettled();
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
      return taskId;
    } finally {
      forkMayFinish.resolve();
    }
  }

  test("a Stop during the fork leaves a row whose removal keeps the parent's Coder workspace", async () => {
    const taskId = await stopTaskDuringFork();
    expect(await coderWorkspacesDeletedByRemoving(taskId)).toEqual([]);
  });

  test("a Stop during the fork leaves a parent whose removal keeps the task's Coder workspace", async () => {
    await stopTaskDuringFork();
    // The stopped task keeps its checkout in the parent's Coder workspace.
    expect(await coderWorkspacesDeletedByRemoving(PARENT_ID)).toEqual([]);
  });
});
