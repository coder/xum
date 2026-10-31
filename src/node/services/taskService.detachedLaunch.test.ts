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
    /** Forks a real worktree, stops the task while the fork returns, and lets the launch end. */
    async function stopTaskDuringFork(sanitizeResult: string | undefined) {
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
      const sanitize = spyOn(
        host.workspaceService,
        "sanitizeMaterializedTaskWorkspace"
      ).mockResolvedValue(sanitizeResult);
      const initStateManager = new InitStateManager(config);
      spyOn(initStateManager, "startInit").mockImplementation(() => undefined);
      spyOn(initStateManager, "endInit").mockResolvedValue(undefined);
      const { taskService } = harness({
        workspaceService: host.workspaceService,
        initStateManager,
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
      await forked.promise;
      const stopped = await taskService.stopDescendantAgentTask(parentId, created.data.taskId);
      assert(stopped.success, JSON.stringify(stopped));
      release.resolve();
      await taskService.reservedLaunchesSettled();
      return { taskId: created.data.taskId, host, sanitize, initStateManager };
    }

    test("gets that checkout sanitized all the same", async () => {
      const { taskId, host, sanitize } = await stopTaskDuringFork(undefined);
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
      expect(sanitize).toHaveBeenCalledWith(taskId, expect.any(String), expect.anything());
      expect(host.sendMessage.mock.calls.some(([id]) => id === taskId)).toBe(false);
    }, 20_000);

    test("keeps a checkout that fails to sanitize quarantined, also after a restart", async () => {
      const { taskId, initStateManager } = await stopTaskDuringFork("fixture: sanitize failed");
      expect(initStateManager.getUnsanitizedCheckoutError(taskId)).toBeDefined();
      expect(findWorkspaceInConfig(config, taskId)?.taskCheckoutUnsanitized).toBe(true);
      expect(new InitStateManager(config).getUnsanitizedCheckoutError(taskId)).toBeDefined();
    }, 20_000);
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

  test("a foreground spawn's launch failure reaches the parent once, through its wait", async () => {
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
    // The launch fails before the tool waits, as a best-of member's can while the tool still
    // creates the other members.
    await taskService.reservedLaunchesSettled();
    const waited = taskService.waitForAgentReport(created.data.taskId, {
      requestingWorkspaceId: parentId,
      backgroundOnMessageQueued: true,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see
    await expect(waited).rejects.toThrow(SEND_FAILURE);
    expect(await failureMessages(historyService, parentId)).toEqual([]);
    expect(wakes).not.toHaveBeenCalled();
  });
});

describe("a Coder parent's task whose fork does not finish", () => {
  // A parent on a Coder workspace that Xum created: removing a workspace with this runtime
  // config deletes the Coder workspace itself (CoderSSHRuntime.deleteWorkspace).
  const DEDICATED_CODER_RUNTIME: RuntimeConfig = {
    type: "ssh",
    host: "mux-parent.coder",
    srcBaseDir: "~/mux",
    coder: { workspaceName: "mux-parent", existingWorkspace: false },
  };
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

  /** The Coder workspaces a forced removal of the task's row deletes (as task_remove does). */
  async function coderWorkspacesDeletedByRemoving(taskId: string): Promise<unknown[]> {
    const row = findWorkspaceInConfig(config, taskId);
    assert(
      row?.runtimeConfig != null && row.name != null,
      "the task's row must have a runtime config and a name"
    );
    const deleteWorkspaceEventually = mock(() =>
      Promise.resolve({ success: true as const, data: undefined })
    );
    // The SSH cleanup of the task's own directory is not under test.
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

  test("a Stop during the fork leaves a row whose removal keeps the parent's Coder workspace", async () => {
    const forkedRuntime: RuntimeConfig = {
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
        forkedRuntimeConfig: forkedRuntime,
        sourceRuntimeConfigUpdate: forkedRuntime,
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
      expect(await coderWorkspacesDeletedByRemoving(taskId)).toEqual([]);
    } finally {
      forkMayFinish.resolve();
    }
  });
});
