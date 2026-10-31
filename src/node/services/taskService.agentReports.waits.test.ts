import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { existsSync } from "fs";
import {
  readSubagentReportArtifact,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import { upsertSubagentFailureArtifact } from "@/node/services/subagentFailureArtifacts";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Err } from "@/common/types/result";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createNullInitLogger,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";
import { nodeSessionLocks } from "@/node/services/sessionLocks/nodeSessionLocks";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  describe("backgroundForegroundWaitsForWorkspace", () => {
    test("rejects opted-in foreground waiters with ForegroundWaitBackgroundedError", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: true,
      });

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(1);

      const err = await waitPromise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForegroundWaitBackgroundedError);

      const count2 = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count2).toBe(0);
    });

    test("backgrounds waiters when tool-end message was already queued", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "queued",
          },
        ],
        testTaskSettings(2, 3)
      );

      const hasQueuedMessages = mock(() => true);
      const { workspaceService } = createWorkspaceServiceMocks({ hasQueuedMessages });
      const { taskService } = createTaskServiceHarness(config, { workspaceService });
      const internal = (
        taskService as unknown as {
          waiters: {
            backgroundableForegroundWaitersByWorkspaceId: Map<string, Set<unknown>>;
            pendingStartWaitersByTaskId: Map<string, unknown[]>;
            pendingWaitersByTaskId: Map<string, unknown[]>;
          };
        }
      ).waiters;

      const waitError = await taskService
        .waitForAgentReport(childId, {
          requestingWorkspaceId: parentId,
          backgroundOnMessageQueued: true,
        })
        .catch((error: unknown) => error);

      expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
      expect(hasQueuedMessages).toHaveBeenCalledWith(parentId, "tool-end");
      expect(taskService.backgroundForegroundWaitsForWorkspace(parentId)).toBe(0);
      expect(internal.backgroundableForegroundWaitersByWorkspaceId.has(parentId)).toBe(false);
      expect(internal.pendingStartWaitersByTaskId.has(childId)).toBe(false);
      expect(internal.pendingWaitersByTaskId.has(childId)).toBe(false);
    });

    test("defaults to queue-backgroundable when requestingWorkspaceId is present", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
      });

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(1);

      const waitError = await waitPromise.catch((error: unknown) => error);
      expect(waitError).toBeInstanceOf(ForegroundWaitBackgroundedError);
    });

    test("does not affect foreground waiters that explicitly opt out of backgrounding", async () => {
      const config = await createTestConfig(rootDir);

      const parentId = "parent-ws";
      const childId = "child-task-ws";
      const projectPath = "/test/project";

      await saveWorkspaces(
        config,
        projectPath,
        [
          { path: `${projectPath}/parent`, id: parentId, name: "parent" },
          {
            path: `${projectPath}/child`,
            id: childId,
            name: "agent_explore_child",
            parentWorkspaceId: parentId,
            agentType: "explore",
            taskStatus: "running",
          },
        ],
        testTaskSettings(2, 3)
      );

      const { taskService } = createTaskServiceHarness(config);

      const waitPromise = taskService.waitForAgentReport(childId, {
        requestingWorkspaceId: parentId,
        backgroundOnMessageQueued: false,
      });

      const count = taskService.backgroundForegroundWaitsForWorkspace(parentId);
      expect(count).toBe(0);

      const internal = taskService as unknown as {
        resolveWaiters: (
          taskId: string,
          report: { reportMarkdown: string; title?: string }
        ) => void;
      };
      internal.resolveWaiters(childId, { reportMarkdown: "ok" });

      const result = await waitPromise;
      expect(result).toEqual({ reportMarkdown: "ok" });
    });
  });

  test("waitForAgentReport does not time out while task is queued", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "queued",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Timeout is short so the test would fail if the timer started while queued.
    const reportPromise = taskService.waitForAgentReport(childId, { timeoutMs: 50 });

    // Wait longer than timeout while task is still queued.
    await new Promise((r) => setTimeout(r, 100));

    const internal = taskService as unknown as {
      setTaskStatus: (workspaceId: string, status: "queued" | "running") => Promise<void>;
      resolveWaiters: (taskId: string, report: { reportMarkdown: string; title?: string }) => void;
    };

    await internal.setTaskStatus(childId, "running");
    internal.resolveWaiters(childId, { reportMarkdown: "ok" });

    const report = await reportPromise;
    expect(report.reportMarkdown).toBe("ok");
  });

  test("waitForAgentReport reuses the standard completion reminder for awaiting_report tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const waitError = await taskService
      .waitForAgentReport(childId, { timeoutMs: 10 })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(Error);
    if (waitError instanceof Error) {
      expect(waitError.message).toBe("Timed out waiting for agent_report");
    }

    // waitForAgentReport schedules the completion reminder as a fire-and-forget task under
    // workspaceEventLocks. The short timeout above can reject before that background work
    // finishes, so acquire the same lock (which only resolves after the holder releases)
    // before asserting on sendMessage to avoid a race under load.
    const internal = taskService as unknown as {
      workspaceEventLocks: { withLock(key: string, fn: () => Promise<void>): Promise<void> };
    };
    await internal.workspaceEventLocks.withLock(childId, () => Promise.resolve());

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      // Provenance lets the goal tools tell this automatic report prompt from user turns.
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        taskTurnKind: "required_report",
      })
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      childId,
      expect.stringContaining("A caller is still waiting for agent_report"),
      expect.any(Object),
      expect.any(Object)
    );
  });

  test("waitForAgentReport rejects interrupted tasks without waiting", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    let caught: unknown = null;
    try {
      await taskService.waitForAgentReport(childId, { timeoutMs: 10_000 });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/Task interrupted/);
    }
  });

  test("waitForAgentReport returns cached report for interrupted task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const internal = taskService as unknown as {
      resolveWaiters: (
        taskId: string,
        report: { reportMarkdown: string; title?: string }
      ) => boolean;
    };
    internal.resolveWaiters(childId, { reportMarkdown: "cached report", title: "cached title" });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({ reportMarkdown: "cached report", title: "cached title" });
  });

  test("waitForAgentReport returns persisted artifact for interrupted task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const planFilePath = path.join(rootDir, "plans", "repo", "child-222.md");
    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "persisted report",
      title: "persisted title",
      planFilePath,
      nowMs: Date.now(),
    });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({
      reportMarkdown: "persisted report",
      title: "persisted title",
      planFilePath,
    });
  });

  test("waitForAgentReport returns persisted artifact for stale running task", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);
    const patchGeneration = spyOn(
      (
        taskService as unknown as {
          gitPatchArtifactService: { maybeStartGeneration: (...args: unknown[]) => Promise<void> };
        }
      ).gitPatchArtifactService,
      "maybeStartGeneration"
    ).mockResolvedValue(undefined);

    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "persisted report",
      title: "persisted title",
      nowMs: Date.now(),
    });

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });

    expect(report).toEqual({ reportMarkdown: "persisted report", title: "persisted title" });
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    expect(patchGeneration).toHaveBeenCalledWith(
      parentId,
      childId,
      expect.any(Function),
      undefined
    );
  });

  test("waitForAgentReport releases its waiter and foreground await when the report read throws", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-000";
    const parentId = "parent-111";
    const childId = "child-222";

    // The requester is itself a running task, so a leaked foreground await shows up in the
    // parallel-slot count: a foreground-awaiting task does not charge a slot.
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "parent", parentId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // A persisted report for the running row makes the read after waiter registration adopt it.
    // The adoption's config write fails once, so that read throws.
    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId, rootId],
      reportMarkdown: "persisted report",
      nowMs: Date.now(),
    });
    spyOn(config, "editConfig").mockRejectedValueOnce(new Error("config write failed"));

    const waitError = await taskService
      .waitForAgentReport(childId, { requestingWorkspaceId: parentId })
      .catch((error: unknown) => error);

    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toBe("config write failed");
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
    const internal = (
      taskService as unknown as { waiters: { pendingWaitersByTaskId: Map<string, unknown[]> } }
    ).waiters;
    expect({
      parentForegroundAwaiting: taskService.isForegroundAwaiting(parentId),
      // Parent and child are both running and neither waits in the foreground: 2 slots.
      activeAgentTasks: taskService.countActiveAgentTasks(config.loadConfigOrDefault()),
      childHasPendingWaiter: internal.pendingWaitersByTaskId.has(childId),
      // Last: on a leak this call would reject (and so clean up) the dead waiter.
      backgroundableWaiters: taskService.backgroundForegroundWaitsForWorkspace(parentId),
    }).toEqual({
      parentForegroundAwaiting: false,
      activeAgentTasks: 2,
      childHasPendingWaiter: false,
      backgroundableWaiters: 0,
    });
  });

  test("waitForAgentReport returns persisted report after workspace is removed", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report.reportMarkdown).toBe("ok");
    expect(report.title).toBe("t");
  });

  test("isDescendantAgentTask consults persisted ancestry after workspace is removed", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    expect(await taskService.isDescendantAgentTask(parentId, childId)).toBe(true);
    expect(await taskService.isDescendantAgentTask("other-parent", childId)).toBe(false);
  });

  test("filterDescendantAgentTaskIds consults persisted ancestry after cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    expect(await taskService.filterDescendantAgentTaskIds(parentId, [childId])).toEqual([childId]);
    expect(await taskService.filterDescendantAgentTaskIds("other-parent", [childId])).toEqual([]);
  });

  test("descendant scope checks consult persisted failure artifacts after cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const failedChildId = "child-failed";
    const workflowChildId = "child-workflow-failed";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "parent", parentId)],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    // Both children failed terminally (e.g. model_refusal) and were cleaned up:
    // no config entry, no report artifact — only the failure artifact remains.
    await upsertSubagentFailureArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: failedChildId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });
    await upsertSubagentFailureArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: workflowChildId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      workflowOwnedAncestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });

    // task_await's scope gate must keep the failed child in scope so
    // waitForAgentReport can surface the persisted typed failure instead of
    // the await degrading to invalid_scope/not_found.
    expect(await taskService.filterDescendantAgentTaskIds(parentId, [failedChildId])).toEqual([
      failedChildId,
    ]);
    expect(await taskService.isDescendantAgentTask(parentId, failedChildId)).toBe(true);
    expect(await taskService.filterDescendantAgentTaskIds("other-parent", [failedChildId])).toEqual(
      []
    );
    expect(await taskService.isDescendantAgentTask("other-parent", failedChildId)).toBe(false);

    // End-to-end through the same call task_await makes after the scope gate.
    let awaitError: unknown;
    try {
      await taskService.waitForAgentReport(failedChildId, {
        timeoutMs: 10,
        requestingWorkspaceId: parentId,
      });
    } catch (error: unknown) {
      awaitError = error;
    }
    assert(awaitError instanceof Error, "waitForAgentReport should reject with the typed failure");
    expect(awaitError.message).toContain("Model refused (finishReason: refusal)");

    // A workflow-owned failed child stays excluded from direct task_await,
    // matching live behavior (its failure is consumed through the workflow run).
    expect(await taskService.isWorkflowOwnedDescendantAgentTask(parentId, failedChildId)).toBe(
      false
    );
    expect(await taskService.isWorkflowOwnedDescendantAgentTask(parentId, workflowChildId)).toBe(
      true
    );
  });

  test("waitForAgentReport falls back to persisted report after cache is cleared", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await upsertSubagentReportArtifact({
      locks: nodeSessionLocks,
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: childId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      reportMarkdown: "ok",
      title: "t",
      nowMs: Date.now(),
    });

    await config.removeWorkspace(childId);

    // Simulate process restart / eviction.
    (
      taskService as unknown as { waiters: { completedReportsByTaskId: Map<string, unknown> } }
    ).waiters.completedReportsByTaskId.clear();

    const report = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10,
      requestingWorkspaceId: parentId,
    });
    expect(report.reportMarkdown).toBe("ok");
    expect(report.title).toBe("t");
  });

  test("does not request agent_report on stream end while task has active descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal descendants are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("keeps agent_report blocked while task-owned notify_on_terminal descendants are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          taskAttentionPolicy: "notify_on_terminal",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Too early" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Premature report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, rootWorkspaceId), parentTaskId)
    ).toBeNull();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("does not force await or report while task-owned notify_on_terminal workflow runs are active", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const workflowRunId = "wfr_task_notify";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, parentTaskId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentTaskId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      attentionPolicy: "notify_on_terminal",
      now: "2026-06-19T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-19T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, parentTaskId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const ws = findWorkspaceInConfig(config, parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("reverts awaiting_report to running on stream end while task has active descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-222";
    const descendantTaskId = "task-333";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "awaiting_report",
        }),
        projectWorkspace(projectPath, "child-task", descendantTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: parentTaskId,
      messageId: "assistant-parent-task",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === parentTaskId);
    expect(ws?.taskStatus).toBe("running");
  });

  test("keeps the published workspace as an interrupted one (no rollback) when the initial sendMessage fails", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "aaaaaaaaaa");

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
      testTaskSettings()
    );
    const { aiService } = createAIServiceMocks(config);
    const failingSendMessage = mock(() => Promise.resolve(Err("send failed")));
    const { workspaceService, discardExtensionMetadataEntry } = createWorkspaceServiceMocks({
      sendMessage: failingSendMessage,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const created = await createAgentTask(taskService, parentId, "do the thing");

    expect(created.success).toBe(true);

    // The entry was persisted and announced before the send: the workspace is published, so a
    // launch failure ends it as an interrupted workspace with its launch error (removable like
    // any other) instead of deleting the row, checkout and session underneath whoever may
    // already have sent into it or re-admitted it.
    expect(findWorkspaceInConfig(config, "aaaaaaaaaa")?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, "aaaaaaaaaa")?.taskLaunchError).toContain("send failed");
    // Still registered, so its extension metadata must not be discarded (write-tombstoned).
    expect(discardExtensionMetadataEntry).not.toHaveBeenCalled();

    const workspaceName = "agent_explore_aaaaaaaaaa";
    const workspacePath = runtime.getWorkspacePath(projectPath, workspaceName);
    await fsPromises.access(workspacePath);
  }, 20_000);

  test("a reservation whose config commit throws leaves no row, no checkout and a free desktop", async () => {
    const config = await createTestConfig(rootDir);
    const childTaskId = "cccccccccc";
    stubStableIds(config, [childTaskId, "dddddddddd"], childTaskId);

    const projectPath = await createTestProject(rootDir);
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const parentName = "parent";
    const parentCreate = await runtime.createWorkspace({
      projectPath,
      branchName: parentName,
      trunkBranch: "main",
      directoryName: parentName,
      initLogger: createNullInitLogger(),
    });
    expect(parentCreate.success).toBe(true);
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
      testTaskSettings()
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const editConfig = config.editConfig.bind(config);
    const persistSpy = spyOn(config, "editConfig").mockImplementation((transform) =>
      editConfig((cfg) => {
        const next = transform(cfg);
        const registersChild = Array.from(next.projects.values()).some((project) =>
          project.workspaces.some((workspace) => workspace.id === childTaskId)
        );
        if (registersChild) throw new Error("config persistence failed after fork");
        return next;
      })
    );
    try {
      const failed = await createAgentTask(taskService, parentId, "Inspect", { desktop: "shared" });
      expect(failed).toEqual(Err("config persistence failed after fork"));
    } finally {
      persistSpy.mockRestore();
    }

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)).toBeUndefined();
    const forkedPath = runtime.getWorkspacePath(projectPath, `agent_explore_${childTaskId}`);
    expect(existsSync(forkedPath)).toBe(false);

    // The owner's desktop is free again: the reservation never outlived the failed callback.
    const next = await createAgentTask(taskService, parentId, "Inspect again", {
      desktop: "shared",
    });
    assert(next.success, "Expected the next shared desktop task to be admitted");
    expect(findWorkspaceInConfig(config, next.data.taskId)?.taskDesktopOwnerWorkspaceId).toBe(
      parentId
    );
  }, 20_000);
});
