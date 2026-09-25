import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { existsSync } from "fs";
import { execSync } from "node:child_process";
import type { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import {
  getSubagentGitPatchMboxPath,
  readSubagentGitPatchArtifact,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import { upsertSubagentFailureArtifact } from "@/node/services/subagentFailureArtifacts";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { agentReportProgressDedupePrefix } from "@/constants/agentMessaging";
import type { TaskService } from "@/node/services/taskService";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Ok, Err, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  initGitRepo,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  collectFullHistory,
  createAgentTask,
  createBestOfTaskServiceTestHarness,
  createNullInitLogger,
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  getTaskToolPart,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
  upsertTestSubagentReports,
  writePendingBestOfParentPartial,
} from "@/node/services/taskService.shared.testHarness";

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
      const internal = taskService as unknown as {
        backgroundableForegroundWaitersByWorkspaceId: Map<string, Set<unknown>>;
        pendingStartWaitersByTaskId: Map<string, unknown[]>;
        pendingWaitersByTaskId: Map<string, unknown[]>;
      };

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
      expect.objectContaining({ synthetic: true, agentInitiated: true })
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
      workspaceId: parentId,
      workspaceSessionDir: path.join(config.sessionsDir, parentId),
      childTaskId: failedChildId,
      parentWorkspaceId: parentId,
      ancestorWorkspaceIds: [parentId],
      errorType: "model_refusal",
      errorMessage: "Model refused (finishReason: refusal): anthropic:claude-fable-5",
    });
    await upsertSubagentFailureArtifact({
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
      taskService as unknown as { completedReportsByTaskId: Map<string, unknown> }
    ).completedReportsByTaskId.clear();

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

    expect(created.success).toBe(false);

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

  test("rolls back a forked checkout when persistence throws after the fork", async () => {
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
    const { workspaceService, sendMessage, discardExtensionMetadataEntry } =
      createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    // Deterministic post-fork failure: the transform that registers the child entry throws, so
    // the checkout already exists on disk while nothing was persisted.
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
    expect(discardExtensionMetadataEntry).toHaveBeenCalledWith(childTaskId);
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

  test("agent_report posts report to parent, finalizes pending task tool output, and triggers cleanup", async () => {
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
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, resumeStream, emit } = createWorkspaceServiceMocks({
      remove,
    });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    // Seed child history with the initial prompt + assistant placeholder so committing the final
    // partial updates the existing assistant message (matching real streaming behavior).
    const childPrompt = createMuxMessage("user-child-prompt", "user", "do the thing", {
      timestamp: Date.now(),
    });
    const appendChildPrompt = await historyService.appendToHistory(childId, childPrompt);
    expect(appendChildPrompt.success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage("assistant-child-partial", "assistant", "", {
      timestamp: Date.now(),
    });
    const appendChildPlaceholder = await historyService.appendToHistory(
      childId,
      childAssistantPlaceholder
    );
    expect(appendChildPlaceholder.success).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Hello from child",
            title: "Result",
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    // Simulate stream manager committing the final partial right before natural stream end.
    const commitChildPartial = await partialService.commitPartial(childId);
    expect(commitChildPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await flushTerminalAttentionDrains(taskService);

    const updatedChildPartial = await partialService.readPartial(childId);
    expect(updatedChildPartial).toBeNull();

    await collectFullHistory(historyService, parentId);

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      expect(JSON.stringify(toolPart?.output)).toContain("Hello from child");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(emit).toHaveBeenCalledWith(
      "metadata",
      expect.objectContaining({ workspaceId: childId })
    );

    const reportArtifact = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(reportArtifact?.reportMarkdown).toBe("Hello from child");
    expect(reportArtifact?.structuredOutput).toBeUndefined();

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
    expect(emit).toHaveBeenCalled();
  });

  function getConfiguredWorkspaceIds(config: Config): string[] {
    return Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
  }

  async function finalizeReportedChildTaskForTest(params: {
    historyService: HistoryService;
    partialService: ReturnType<typeof createTaskServiceHarness>["partialService"];
    taskService: TaskService;
    childId: string;
    reportMarkdown: string;
    title: string;
    prompt?: string;
  }): Promise<void> {
    const childPrompt = createMuxMessage(
      `user-${params.childId}-prompt`,
      "user",
      params.prompt ?? "compare options",
      {
        timestamp: Date.now(),
      }
    );
    expect((await params.historyService.appendToHistory(params.childId, childPrompt)).success).toBe(
      true
    );

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await params.historyService.appendToHistory(params.childId, childAssistantPlaceholder))
        .success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${params.childId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${params.childId}`,
          toolName: "agent_report",
          input: { reportMarkdown: params.reportMarkdown, title: params.title },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: params.reportMarkdown },
      ]
    );
    expect((await params.partialService.writePartial(params.childId, childPartial)).success).toBe(
      true
    );
    expect((await params.partialService.commitPartial(params.childId)).success).toBe(true);

    await streamEnd(params.taskService, {
      type: "stream-end",
      workspaceId: params.childId,
      messageId: `assistant-${params.childId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });
  }

  test("agent_report waits for all best-of reports before finalizing pending parent task output", async () => {
    const parentId = "parent-best-of";
    const childOneId = "child-best-of-1";
    const childTwoId = "child-best-of-2";
    const bestOf = { groupId: "best-of-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService, remove } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "running",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-partial",
      toolCallId: "task-best-of-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
    expect(remove).not.toHaveBeenCalled();

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });

    const afterSecondParentPartial = await partialService.readPartial(parentId);
    expect(afterSecondParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterSecondParentPartial);
    expect(toolPart?.state).toBe("output-available");
    expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);
    expect(serializedOutput).toContain("Report from child one");
    expect(serializedOutput).toContain("Report from child two");

    const remainingTaskIds = getConfiguredWorkspaceIds(config);
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);
  });

  test("best-of finalization never ships a report a resumed sibling is replacing", async () => {
    const parentId = "parent-best-of-resumed-sibling";
    const childOneId = "child-best-of-resumed-sibling-1";
    const childTwoId = "child-best-of-resumed-sibling-2";
    const bestOf = { groupId: "best-of-resumed-sibling", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            // Reported once, then its re-run was stopped: the user resume below replaces its report.
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "interrupted",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-resumed-sibling",
      toolCallId: "task-best-of-resumed-sibling-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        {
          childTaskId: childTwoId,
          reportMarkdown: "Report from child two (pre-continuation)",
          title: "Option two (stale)",
        },
      ],
    });

    // Barrier at the commit of child one's grouped output: its assembly has already read child
    // two's old artifact. Resume child two and let its replacement report race the commit. The
    // replacement is started, not awaited (awaiting it under the assembly's lock would deadlock);
    // the barrier lifts once child two asks for the group lock, so it has run as far as the lock
    // lets it: blocked before publishing, or, were publication unserialized, already published
    // and queueing for delivery.
    const groupLocks = (taskService as unknown as { deferredBestOfLocks: MutexMap<string> })
      .deferredBestOfLocks;
    const withGroupLock = groupLocks.withLock.bind(groupLocks);
    let onGroupLockRequested: (() => void) | undefined;
    spyOn(groupLocks, "withLock").mockImplementation(((
      key: string,
      operation: () => Promise<unknown>
    ) => {
      if (key === parentId) onGroupLockRequested?.();
      return withGroupLock(key, operation);
    }) as typeof groupLocks.withLock);
    const updatePartial = historyService.updatePartialIfMessageIdMatches.bind(historyService);
    let replacementReport: Promise<void> | undefined;
    spyOn(historyService, "updatePartialIfMessageIdMatches").mockImplementationOnce(
      async (workspaceId, messageId, updater) => {
        expect(await taskService.markInterruptedTaskRunning(childTwoId)).toBe(true);
        const groupLockRequested = new Promise<void>((resolve) => {
          onGroupLockRequested = resolve;
        });
        replacementReport = finalizeReportedChildTaskForTest({
          historyService,
          partialService,
          taskService,
          childId: childTwoId,
          reportMarkdown: "Report from child two (continuation)",
          title: "Option two",
        });
        await groupLockRequested;
        return updatePartial(workspaceId, messageId, updater);
      }
    );

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });
    expect(replacementReport).toBeDefined();
    await replacementReport;
    await flushTerminalAttentionDrains(taskService);

    const toolPart = getTaskToolPart(await partialService.readPartial(parentId));
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain("Report from child one");
    expect(serializedOutput).toContain("Report from child two (continuation)");
    expect(serializedOutput).not.toContain("pre-continuation");
    const parentHistory = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistory)).not.toContain("pre-continuation");
  });

  test("agent_report recovers a pending legacy variants task call", async () => {
    const parentId = "parent-legacy-variants";
    const childOneId = "child-legacy-variant-1";
    const childTwoId = "child-legacy-variant-2";
    const groupId = "legacy-variant-group";

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_frontend",
            title: "Split review",
            taskStatus: "running",
            bestOf: { groupId, index: 0, total: 2 },
          },
          {
            id: childTwoId,
            name: "agent_explore_backend",
            title: "Split review",
            taskStatus: "running",
            bestOf: { groupId, index: 1, total: 2 },
          },
        ],
      });

    const configFile = path.join(config.rootDir, "config.json");
    const rawConfig = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as {
      projects: Array<[string, { workspaces: Array<Record<string, unknown>> }]>;
    };
    for (const [, project] of rawConfig.projects) {
      for (const workspace of project.workspaces) {
        if (workspace.id === childOneId) {
          workspace.bestOf = {
            groupId,
            index: 0,
            total: 2,
            kind: "variants",
            label: "frontend",
          };
        }
        if (workspace.id === childTwoId) {
          workspace.bestOf = {
            groupId,
            index: 1,
            total: 2,
            kind: "variants",
            label: "backend",
          };
        }
      }
    }
    await fsPromises.writeFile(configFile, JSON.stringify(rawConfig, null, 2));

    const runtimeWorkspaces = Array.from(config.loadConfigOrDefault().projects.values()).flatMap(
      (project) => project.workspaces
    );
    expect(
      runtimeWorkspaces.find((workspace) => workspace.id === childOneId)?.bestOf
    ).toBeUndefined();
    expect(
      runtimeWorkspaces.find((workspace) => workspace.id === childTwoId)?.bestOf
    ).toBeUndefined();

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-legacy-variants-partial",
      toolCallId: "task-legacy-variants-call",
      title: "Split review",
      legacyVariants: ["frontend", "backend"],
      prompt: "Review ${variant} for regressions",
      timestamp: Date.now(),
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Frontend findings",
      title: "Frontend review",
      prompt: "Review frontend for regressions",
    });
    expect(getTaskToolPart(await partialService.readPartial(parentId))?.state).toBe(
      "input-available"
    );
    const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Frontend findings");

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Backend findings",
      title: "Backend review",
      prompt: "Review backend for regressions",
    });

    const toolPart = getTaskToolPart(await partialService.readPartial(parentId));
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain("Frontend findings");
    expect(serializedOutput).toContain("Backend findings");

    const persisted = JSON.parse(await fsPromises.readFile(configFile, "utf-8")) as {
      projects: Array<
        [string, { workspaces: Array<{ id?: string; bestOf?: { kind?: string; label?: string } }> }]
      >;
    };
    const persistedWorkspaces = persisted.projects.flatMap(([, project]) => project.workspaces);
    expect(
      persistedWorkspaces.find((workspace) => workspace.id === childOneId)?.bestOf
    ).toMatchObject({ kind: "variants", label: "frontend" });
    expect(
      persistedWorkspaces.find((workspace) => workspace.id === childTwoId)?.bestOf
    ).toMatchObject({ kind: "variants", label: "backend" });
  });

  // Test exercises real config + history + partial-on-disk I/O across many
  // sequential awaits. Under CI parallel-test contention this can momentarily
  // exceed Bun's default 5s per-test timeout even though it completes in
  // ~250ms locally; bump the budget for headroom.
  test(
    "agent_report finalizes interrupted best-of parent output after partial best-of spawn failure",
    async () => {
      const parentId = "parent-best-of-partial-spawn";
      const childOneId = "child-best-of-partial-1";
      const childTwoId = "child-best-of-partial-2";
      const bestOf = { groupId: "best-of-partial-group", index: 0, total: 3 } as const;

      const { config, historyService, partialService, taskService, remove } =
        await createBestOfTaskServiceTestHarness({
          rootDir,
          parentId,
          children: [
            {
              id: childOneId,
              name: "agent_explore_child_1",
              taskStatus: "running",
              bestOf,
            },
            {
              id: childTwoId,
              name: "agent_explore_child_2",
              taskStatus: "running",
              bestOf: { ...bestOf, index: 1 },
            },
          ],
        });

      await writePendingBestOfParentPartial({
        partialService,
        parentId,
        messageId: "assistant-parent-best-of-partial-spawn",
        toolCallId: "task-best-of-partial-call",
        title: "Best of 3",
        n: 3,
        timestamp: Date.now(),
      });

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childOneId,
        reportMarkdown: "Report from child one",
        title: "Option one",
      });

      const parentHistoryAfterFirst = await collectFullHistory(historyService, parentId);
      expect(JSON.stringify(parentHistoryAfterFirst)).not.toContain("Report from child one");

      const afterFirstParentPartial = await partialService.readPartial(parentId);
      expect(afterFirstParentPartial).not.toBeNull();
      expect(getTaskToolPart(afterFirstParentPartial)?.state).toBe("input-available");
      expect(remove).not.toHaveBeenCalled();

      await finalizeReportedChildTaskForTest({
        historyService,
        partialService,
        taskService,
        childId: childTwoId,
        reportMarkdown: "Report from child two",
        title: "Option two",
      });

      const afterSecondParentPartial = await partialService.readPartial(parentId);
      expect(afterSecondParentPartial).not.toBeNull();
      const toolPart = getTaskToolPart(afterSecondParentPartial);
      expect(toolPart?.state).toBe("output-available");
      expect(toolPart?.output && typeof toolPart.output === "object").toBe(true);
      const serializedOutput = JSON.stringify(toolPart?.output);
      expect(serializedOutput).toContain(childOneId);
      expect(serializedOutput).toContain(childTwoId);
      expect(serializedOutput).toContain("Report from child one");
      expect(serializedOutput).toContain("Report from child two");

      const remainingTaskIds = getConfiguredWorkspaceIds(config);
      expect(remainingTaskIds).toContain(childOneId);
      expect(remainingTaskIds).toContain(childTwoId);
    },
    { timeout: 15_000 }
  );

  test("grouped partial finalization exposes each terminal report exactly once", async () => {
    const parentId = "parent-best-of-no-duplicate";
    const childOneId = "child-best-of-no-duplicate-1";
    const childTwoId = "child-best-of-no-duplicate-2";
    const bestOf = { groupId: "best-of-no-duplicate-group", index: 0, total: 2 } as const;

    const { config, historyService, partialService, taskService } =
      await createBestOfTaskServiceTestHarness({
        rootDir,
        parentId,
        children: [
          {
            id: childOneId,
            name: "agent_explore_child_1",
            taskStatus: "running",
            bestOf,
          },
          {
            // Already reported (artifact seeded below) and then stopped; its late stream-end
            // below re-delivers the same report.
            id: childTwoId,
            name: "agent_explore_child_2",
            taskStatus: "interrupted",
            bestOf: { ...bestOf, index: 1 },
          },
        ],
      });

    await writePendingBestOfParentPartial({
      partialService,
      parentId,
      messageId: "assistant-parent-best-of-no-duplicate",
      toolCallId: "task-best-of-no-duplicate-call",
      title: "Best of 2",
      n: 2,
      timestamp: Date.now(),
    });
    await upsertTestSubagentReports({
      config,
      parentId,
      reports: [
        {
          childTaskId: childTwoId,
          reportMarkdown: "Report from child two",
          title: "Option two",
        },
      ],
    });

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childOneId,
      reportMarkdown: "Report from child one",
      title: "Option one",
    });

    const afterFirstParentPartial = await partialService.readPartial(parentId);
    expect(afterFirstParentPartial).not.toBeNull();
    const toolPart = getTaskToolPart(afterFirstParentPartial);
    expect(toolPart?.state).toBe("output-available");
    const serializedOutput = JSON.stringify(toolPart?.output);
    expect(serializedOutput).toContain(childOneId);
    expect(serializedOutput).toContain(childTwoId);

    await finalizeReportedChildTaskForTest({
      historyService,
      partialService,
      taskService,
      childId: childTwoId,
      reportMarkdown: "Report from child two",
      title: "Option two",
    });
    await flushTerminalAttentionDrains(taskService);

    const serializedParentHistory = JSON.stringify(
      await collectFullHistory(historyService, parentId)
    );
    expect(serializedParentHistory.match(/<mux_subagent_report>/g)).toHaveLength(2);
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory).toContain("Report from child two");
  });

  test("agent_report falls back to synthetic parent reports when grouped recovery cannot finish", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-fallback";
    const childOneId = "child-best-of-fallback-1";
    const childTwoId = "child-best-of-fallback-2";
    const bestOf = { groupId: "best-of-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "interrupted",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
        {
          type: "dynamic-tool",
          toolCallId: "task-secondary-pending-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "secondary task",
            title: "Secondary task",
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPrompt = createMuxMessage(`user-${childOneId}-prompt`, "user", "compare options", {
      timestamp: Date.now(),
    });
    expect((await historyService.appendToHistory(childOneId, childPrompt)).success).toBe(true);

    const childAssistantPlaceholder = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now() }
    );
    expect(
      (await historyService.appendToHistory(childOneId, childAssistantPlaceholder)).success
    ).toBe(true);

    const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
    if (typeof childHistorySequence !== "number") {
      throw new Error("Expected child historySequence to be a number");
    }

    const childPartial = createMuxMessage(
      `assistant-${childOneId}-partial`,
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: childHistorySequence },
      [
        {
          type: "dynamic-tool",
          toolCallId: `agent-report-${childOneId}`,
          toolName: "agent_report",
          input: { reportMarkdown: "Report from child one", title: "Option one" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Report from child one" },
      ]
    );
    expect((await partialService.writePartial(childOneId, childPartial)).success).toBe(true);
    expect((await partialService.commitPartial(childOneId)).success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childOneId,
      messageId: `assistant-${childOneId}-partial`,
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const parentHistory = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistory);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");

    const remainingTaskIds = Array.from(config.loadConfigOrDefault().projects.values())
      .flatMap((project) => project.workspaces)
      .map((workspace) => workspace.id)
      .filter((id): id is string => typeof id === "string");
    expect(remainingTaskIds).toContain(childOneId);
    expect(remainingTaskIds).toContain(childTwoId);
  });

  test("interrupted best-of siblings trigger deferred fallback delivery for earlier reports", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-best-of-deferred-fallback";
    const childOneId = "child-best-of-deferred-fallback-1";
    const childTwoId = "child-best-of-deferred-fallback-2";
    const bestOf = { groupId: "best-of-deferred-fallback-group", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        {
          path: path.join(projectPath, "child-1"),
          id: childOneId,
          name: "agent_explore_child_1",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf,
        },
        projectWorkspace(projectPath, "child-2", childTwoId, {
          name: "agent_explore_child_2",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "running",
          bestOf: { ...bestOf, index: 1 },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-best-of-deferred-fallback",
      "assistant",
      "Waiting on best-of subagents…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-best-of-deferred-fallback-call",
          toolName: "task",
          input: {
            subagent_type: "explore",
            prompt: "compare options",
            title: "Best of 2",
            n: 2,
          },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    async function finalizeChildReport(
      childId: string,
      reportMarkdown: string,
      title: string
    ): Promise<void> {
      const childPrompt = createMuxMessage(`user-${childId}-prompt`, "user", "compare options", {
        timestamp: Date.now(),
      });
      expect((await historyService.appendToHistory(childId, childPrompt)).success).toBe(true);

      const childAssistantPlaceholder = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now() }
      );
      expect(
        (await historyService.appendToHistory(childId, childAssistantPlaceholder)).success
      ).toBe(true);

      const childHistorySequence = childAssistantPlaceholder.metadata?.historySequence;
      if (typeof childHistorySequence !== "number") {
        throw new Error("Expected child historySequence to be a number");
      }

      const childPartial = createMuxMessage(
        `assistant-${childId}-partial`,
        "assistant",
        "",
        { timestamp: Date.now(), historySequence: childHistorySequence },
        [
          {
            type: "dynamic-tool",
            toolCallId: `agent-report-${childId}`,
            toolName: "agent_report",
            input: { reportMarkdown, title },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: reportMarkdown },
        ]
      );
      expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);
      expect((await partialService.commitPartial(childId)).success).toBe(true);

      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: childId,
        messageId: `assistant-${childId}-partial`,
        metadata: { model: "test-model", finishReason: "stop" },
        parts: childPartial.parts as StreamEndEvent["parts"],
      });
    }

    await finalizeChildReport(childOneId, "Report from child one", "Option one");
    const parentHistoryBeforeInterrupt = await collectFullHistory(historyService, parentId);
    expect(JSON.stringify(parentHistoryBeforeInterrupt)).not.toContain("Report from child one");

    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const childTwo = project.workspaces.find((workspace) => workspace.id === childTwoId);
        if (childTwo) {
          childTwo.taskStatus = "interrupted";
        }
      }
      return cfg;
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });
    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childTwoId,
      messageId: "assistant-child-two-interrupted-repeat",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: [],
    });

    const parentHistoryAfterInterrupt = await collectFullHistory(historyService, parentId);
    const serializedParentHistory = JSON.stringify(parentHistoryAfterInterrupt);
    expect(serializedParentHistory).toContain("<mux_subagent_report>");
    expect(serializedParentHistory).toContain("Report from child one");
    expect(serializedParentHistory.match(/child-best-of-deferred-fallback-1/g)).toHaveLength(1);
  });

  test("agent_report uses legacy exec agentType for git format-patch eligibility", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"world\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "explore",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);

    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
  }, 20_000);

  test("agent_report generates mixed per-project git format-patch artifacts for multi-project exec tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const primaryProjectPath = path.join(rootDir, "project-a");
    const secondaryProjectPath = path.join(rootDir, "project-b");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(primaryProjectPath, "parent");
    const childWorkspacePath = path.join(rootDir, "multi-project-container");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childWorkspacePath, { recursive: true });
    await fsPromises.mkdir(primaryProjectPath, { recursive: true });
    await fsPromises.mkdir(secondaryProjectPath, { recursive: true });

    initGitRepo(primaryProjectPath);
    initGitRepo(secondaryProjectPath);
    const primaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: primaryProjectPath,
      encoding: "utf-8",
    }).trim();
    const secondaryBaseCommitSha = execSync("git rev-parse HEAD", {
      cwd: secondaryProjectPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \"secondary\" >> README.md'", {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });
    execSync("git add README.md", { cwd: secondaryProjectPath, stdio: "ignore" });
    execSync('git commit -m "secondary change"', {
      cwd: secondaryProjectPath,
      stdio: "ignore",
    });

    await saveWorkspaces(
      config,
      primaryProjectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          agentId: "exec",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: primaryBaseCommitSha,
          taskBaseCommitShaByProjectPath: {
            [primaryProjectPath]: primaryBaseCommitSha,
            [secondaryProjectPath]: secondaryBaseCommitSha,
          },
          projects: [
            { projectPath: primaryProjectPath, projectName: "project-a" },
            { projectPath: secondaryProjectPath, projectName: "project-b" },
          ],
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "exec", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    expect((await partialService.writePartial(parentId, parentPartial)).success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const secondaryPatchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "project-b");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await waiter;

    const start = Date.now();
    let artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    while (artifact?.status === "pending") {
      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for multi-project patch generation: ${JSON.stringify(artifact)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    }

    expect(artifact?.status).toBe("ready");
    expect(artifact?.readyProjectCount).toBe(1);
    expect(artifact?.skippedProjectCount).toBe(1);
    expect(artifact?.projectArtifacts).toEqual([
      expect.objectContaining({
        projectPath: primaryProjectPath,
        projectName: "project-a",
        status: "skipped",
        commitCount: 0,
      }),
      expect.objectContaining({
        projectPath: secondaryProjectPath,
        projectName: "project-b",
        status: "ready",
        commitCount: 1,
      }),
    ]);
    await fsPromises.stat(secondaryPatchPath);
  }, 20_000);

  test("agent_report generates git format-patch artifact for exec-derived custom tasks before cleanup", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-222";

    const parentPath = path.join(projectPath, "parent");
    const childPath = path.join(projectPath, "child");
    await fsPromises.mkdir(parentPath, { recursive: true });
    await fsPromises.mkdir(childPath, { recursive: true });

    // Custom agent definition stored in the parent workspace (.mux/agents).
    const agentsDir = path.join(parentPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "test-file.md"),
      `---\nname: Test File\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    initGitRepo(childPath);
    const baseCommitSha = execSync("git rev-parse HEAD", {
      cwd: childPath,
      encoding: "utf-8",
    }).trim();

    execSync("bash -lc 'echo \\\"world\\\" >> README.md'", { cwd: childPath, stdio: "ignore" });
    execSync("git add README.md", { cwd: childPath, stdio: "ignore" });
    execSync('git commit -m "child change"', { cwd: childPath, stdio: "ignore" });

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentPath,
          id: parentId,
          name: "parent",
          runtimeConfig: { type: "local" },
        },
        {
          path: childPath,
          id: childId,
          name: "agent_test_file_child",
          parentWorkspaceId: parentId,
          agentType: "test-file",
          agentId: "test-file",
          taskStatus: "running",
          runtimeConfig: { type: "local" },
          taskBaseCommitSha: baseCommitSha,
        },
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "test-file", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    const parentSessionDir = path.join(config.sessionsDir, parentId);
    const patchPath = getSubagentGitPatchMboxPath(parentSessionDir, childId, "repo");

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    const report = await waiter;
    expect(report).toEqual({ reportMarkdown: "Hello from child", title: "Result" });

    const artifactAfterStreamEnd = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(
      artifactAfterStreamEnd?.status === "pending" || artifactAfterStreamEnd?.status === "ready"
    ).toBe(true);

    const start = Date.now();
    let lastArtifact: unknown = null;
    while (true) {
      const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
      lastArtifact = artifact;

      if (artifact?.status === "ready") {
        try {
          await fsPromises.stat(patchPath);
          break;
        } catch {
          // Keep polling until the patch file exists.
        }
      } else if (artifact?.status === "failed" || artifact?.status === "skipped") {
        throw new Error(
          `Patch artifact generation failed with status=${artifact.status}: ${
            artifact.projectArtifacts.find((projectArtifact) => projectArtifact.status === "failed")
              ?.error ?? "unknown error"
          }`
        );
      }

      if (Date.now() - start > 20_000) {
        throw new Error(
          `Timed out waiting for patch artifact generation (lastArtifact=${JSON.stringify(lastArtifact)})`
        );
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    const artifact = await readSubagentGitPatchArtifact(parentSessionDir, childId);
    expect(artifact?.status).toBe("ready");

    await fsPromises.stat(patchPath);

    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
  }, 20_000);

  test("agent_report updates queued/running task tool output in parent history", async () => {
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
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const {
      workspaceService,
      sendMessage: sendMessageMock,
      resumeStream,
    } = createWorkspaceServiceMocks({ remove });
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentHistoryMessage = createMuxMessage(
      "assistant-parent-history",
      "assistant",
      "Spawned subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", run_in_background: true },
          state: "output-available",
          output: { status: "running", taskId: childId },
        },
      ]
    );
    const appendParentHistory = await historyService.appendToHistory(
      parentId,
      parentHistoryMessage
    );
    expect(appendParentHistory.success).toBe(true);

    const childPartial = createMuxMessage(
      "assistant-child-partial",
      "assistant",
      "",
      { timestamp: Date.now(), historySequence: 0 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ]
    );
    const writeChildPartial = await partialService.writePartial(childId, childPartial);
    expect(writeChildPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });

    await flushTerminalAttentionDrains(taskService);

    const parentMessages = await collectFullHistory(historyService, parentId);
    // Original task tool call remains immutable ("running"), and a synthetic report message is appended.
    expect(parentMessages.length).toBeGreaterThanOrEqual(2);

    const taskCallMessage = parentMessages.find((m) => m.id === "assistant-parent-history") ?? null;
    expect(taskCallMessage).not.toBeNull();
    if (taskCallMessage) {
      const toolPart = taskCallMessage.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as { output?: unknown } | undefined;
      expect(JSON.stringify(toolPart?.output)).toContain('"status":"running"');
      expect(JSON.stringify(toolPart?.output)).toContain(childId);
    }

    const syntheticReport = parentMessages.find((m) => m.metadata?.synthetic) ?? null;
    expect(syntheticReport).not.toBeNull();
    if (syntheticReport) {
      expect(syntheticReport.role).toBe("user");
      const text = syntheticReport.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      expect(text).toContain("Hello from child");
      expect(text).toContain(childId);
    }

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
  });

  test("stream-end with agent_report parts finalizes report and triggers cleanup", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Hello from child", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Hello from child" },
      ],
    });

    await flushTerminalAttentionDrains(taskService);

    // No agent_report reminder or handoff message should fire; the parent resumes from history.
    const sendCalls = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of sendCalls) {
      const msg = call[1] as string;
      expect(msg).not.toContain("agent_report");
    }

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain("Hello from child");
      expect(outputJson).toContain("Result");
      expect(outputJson).not.toContain("fallback");
    }

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
    });
  });

  test("agent_report attributes child usage to parent goal and emits one child-budget toast", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-goal-report";
    const childUnderId = "child-under-budget";
    const childOverId = "child-over-budget";
    const childModel = "openai:gpt-4o-mini";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child-under", childUnderId, {
          name: "agent_explore_under",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: childModel,
        }),
        projectWorkspace(projectPath, "child-over", childOverId, {
          name: "agent_explore_over",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: childModel,
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, emitChatEvent } = createWorkspaceServiceMocks({ remove });
    const historyService = new HistoryService(config);
    const sessionUsageService = new SessionUsageService(config, historyService);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(rootDir, "task-report-goals-extensionMetadata.json")
    );
    const workspaceGoalService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata
    );
    workspaceGoalService.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: () => Promise.resolve(true),
    });
    const goalResult = await workspaceGoalService.setGoal({
      workspaceId: parentId,
      objective: "Parent budget",
      budgetCents: 100,
    });
    expect(goalResult.success).toBe(true);

    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
      sessionUsageService,
      workspaceGoalService,
    });
    async function finishChildReport(input: {
      workspaceId: string;
      costUsd: number;
      messageId: string;
      toolCallId: string;
      reportMarkdown: string;
      title: string;
    }): Promise<void> {
      await sessionUsageService.recordUsage(input.workspaceId, childModel, {
        input: { tokens: 100, cost_usd: input.costUsd },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 0, cost_usd: 0 },
        reasoning: { tokens: 0, cost_usd: 0 },
        model: childModel,
      });
      await streamEnd(taskService, {
        type: "stream-end",
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        metadata: { model: childModel, finishReason: "stop" },
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: input.toolCallId,
            toolName: "agent_report",
            input: { reportMarkdown: input.reportMarkdown, title: input.title },
            state: "output-available",
            output: { success: true },
          },
          { type: "text", text: input.reportMarkdown },
        ],
      });
    }

    await finishChildReport({
      workspaceId: childUnderId,
      costUsd: 0.37,
      messageId: "assistant-child-under",
      toolCallId: "agent-report-under",
      reportMarkdown: "Under budget",
      title: "Under",
    });

    expect(await workspaceGoalService.getGoal(parentId)).toMatchObject({
      status: "active",
      costCents: 37,
      turnsUsed: 1,
      attributedChildren: [childUnderId],
    });
    expect(emitChatEvent).not.toHaveBeenCalledWith(
      parentId,
      expect.objectContaining({ type: "goal-budget-limited" })
    );

    await finishChildReport({
      workspaceId: childOverId,
      costUsd: 0.75,
      messageId: "assistant-child-over",
      toolCallId: "agent-report-over",
      reportMarkdown: "Over budget",
      title: "Over",
    });

    expect(await workspaceGoalService.getGoal(parentId)).toMatchObject({
      status: "budget_limited",
      costCents: 112,
      turnsUsed: 2,
      attributedChildren: [childUnderId, childOverId],
    });
    expect(emitChatEvent).toHaveBeenCalledWith(
      parentId,
      expect.objectContaining({
        type: "goal-budget-limited",
        causedByChild: true,
        childWorkspaceId: childOverId,
        message: "Child workspace exceeded the parent's goal budget.",
      })
    );
  });

  test("task stream-end waits for task-local background workflows before final report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-wait";
    const childId = "child-workflow-wait";
    const workflowRunId = "wfr_child_active";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, childId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: childId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, childId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Premature" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test("task stream-end waits for completed task-local workflows before final report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-completed-wait";
    const childId = "child-workflow-completed-wait";
    const workflowRunId = "wfr_child_completed";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, childId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: childId,
      workflow: {
        name: "child-workflow",
        description: "Child workflow",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return { reportMarkdown: 'done' }; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");
    await runStore.appendStatus(workflowRunId, "completed", "2026-06-04T00:00:02.000Z");
    await recordAgentWorkflowRunReference({
      workspaceSessionDir: path.join(config.sessionsDir, childId),
      runId: workflowRunId,
      createdAtMs: 1_000,
    });

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage, isWorkflowInvocationCurrent } =
      createWorkspaceServiceMocks({
        remove,
      });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Premature report", title: "Premature" },
          state: "output-available",
          output: { success: true },
        },
      ],
    });

    expect(isWorkflowInvocationCurrent).toHaveBeenCalledWith(childId, workflowRunId);
    expect(remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining(workflowRunId),
      expect.objectContaining({ model: "openai:gpt-4o-mini", agentId: "exec" }),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test("handleStreamEnd finalizes report when task status is interrupted", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const isStreaming = mock((workspaceId: string): boolean => workspaceId === childId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const waiter = taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });

    const internal = taskService as unknown as {
      completedReportsByTaskId: Map<string, unknown>;
    };

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Interrupted child report", title: "Result" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Interrupted child report" },
      ],
    });

    const report = await waiter;
    expect(report).toEqual({
      reportMarkdown: "Interrupted child report",
      title: "Result",
      model: "openai:gpt-4o-mini",
    });

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    // Validate report persistence path (not just in-memory cache).
    internal.completedReportsByTaskId.clear();
    const persisted = await taskService.waitForAgentReport(childId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: parentId,
    });
    expect(persisted).toEqual({
      reportMarkdown: "Interrupted child report",
      title: "Result",
      model: "openai:gpt-4o-mini",
    });
  });

  test("handleStreamEnd rejects waiters when interrupted task stream ends without report", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    let childStreaming = true;
    const isStreaming = mock(
      (workspaceId: string): boolean => workspaceId === childId && childStreaming
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const waiter = taskService
      .waitForAgentReport(childId, {
        timeoutMs: 10_000,
        requestingWorkspaceId: parentId,
      })
      .catch((error: unknown) => error);

    childStreaming = false;

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    const waiterError = await waiter;
    expect(waiterError).toBeInstanceOf(Error);
    if (waiterError instanceof Error) {
      expect(waiterError.message).toMatch(/Task interrupted/);
      expect(waiterError.message).not.toMatch(/Timed out/);
    }
  });

  test("handleStreamEnd interrupts workflow-owned tasks when owning workflow is already interrupted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-stream-workflow-interrupted";
    const childId = "child-stream-workflow-interrupted";
    const workflowRunId = "wfr_stream_interrupted_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "slow-step" },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "interrupted",
        description: "Interrupted",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "interrupted", "2026-05-29T00:00:01.000Z");

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const maybeStartQueuedTasks = spyOn(
      taskService as unknown as { maybeStartQueuedTasks: () => Promise<void> },
      "maybeStartQueuedTasks"
    ).mockResolvedValue(undefined);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("interrupted");
    expect(maybeStartQueuedTasks).toHaveBeenCalledTimes(1);
  });

  test("agent_report wakes the parent repeatedly without completing the subagent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-progress";
    const childId = "child-progress";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_review_child",
          parentWorkspaceId: parentId,
          agentType: "review",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.reportAgentProgress(childId, "progress-1", {
      reportMarkdown: "Found a correctness issue.",
      title: "Finding",
    });
    await taskService.reportAgentProgress(childId, "progress-2", {
      reportMarkdown: "Found a second issue.",
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      parentId,
      expect.stringContaining("Found a correctness issue."),
      expect.any(Object),
      expect.objectContaining({
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        queueDedupeKey: "agent-report:child-progress:progress-1",
        promoteAheadOfHiddenTurnEnd: true,
      })
    );
    expect(sendMessage.mock.calls[0]?.[1]).toContain('"status": "in_progress"');
    expect(sendMessage.mock.calls[1]?.[1]).toContain("Found a second issue.");
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
    // The probe re-checked at the parent's admission gates flips once the run is over — for an
    // original run, on a terminal report or a stop without one.
    const superseded = (sendMessage.mock.calls[1]?.[3] as { admissionStale?: () => boolean })
      .admissionStale;
    assert(superseded, "progress sends must carry a supersession probe");
    expect(superseded()).toBe(false);
    await config.editConfig((cfg) => {
      const workspace = cfg.projects
        .get(projectPath)
        ?.workspaces.find((candidate) => candidate.id === childId);
      assert(workspace, "child workspace must exist");
      workspace.taskStatus = "interrupted";
      return cfg;
    });
    expect(superseded()).toBe(true);
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
  });

  test("agent_report refuses an update whose run ended before the wake was sent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-late-progress";
    const childId = "child-late-progress";

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
      testTaskSettings()
    );

    // A stop that lands between the entry checks and the probe evaluation (the stop path does not
    // share the child's event lock) must refuse the update instead of waking the parent with it.
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const realLoad = config.loadConfigOrDefault.bind(config);
    let loads = 0;
    const loadSpy = spyOn(config, "loadConfigOrDefault").mockImplementation(() => {
      loads += 1;
      const cfg = realLoad();
      if (loads > 1) {
        const workspace = cfg.projects
          .get(projectPath)
          ?.workspaces.find((candidate) => candidate.id === childId);
        if (workspace) workspace.taskStatus = "interrupted";
      }
      return cfg;
    });
    try {
      const failure: unknown = await taskService
        .reportAgentProgress(childId, "progress-late", { reportMarkdown: "Obsolete finding." })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toEqual(
        new Error("agent_report cannot send updates after the sub-agent's run has ended")
      );
    } finally {
      loadSpy.mockRestore();
    }
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("terminal reports supersede queued incremental updates for the same child", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-queued-progress";
    const childId = "child-queued-progress";

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
      testTaskSettings()
    );

    // Order matters: while a queued update sits at the parent's queue head as a tool-end entry,
    // the parent's stream stops at its next step boundary for it. Removal must happen with the
    // terminal status commit, before the report's slower follow-up work (artifacts, patch
    // generation), and only once the supersession probe would already refuse a dequeued update.
    const order: string[] = [];
    const removeQueuedMessagesByDedupeKeyPrefix = mock(
      (_workspaceId: string, prefix: string): Result<number> => {
        // The same terminal commit also drops the child's own queued recovery prompts; only the
        // parent-queue progress removal is under test here.
        if (prefix === agentReportProgressDedupePrefix(childId)) {
          order.push(`remove:${findWorkspaceInConfig(config, childId)?.taskStatus ?? "missing"}`);
        }
        return Ok(1);
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({
      removeQueuedMessagesByDedupeKeyPrefix,
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    spyOn(
      taskService as unknown as { maybeStartPatchGenerationForReportedTask: () => Promise<void> },
      "maybeStartPatchGenerationForReportedTask"
    ).mockImplementation(() => {
      order.push("patch");
      return Promise.resolve();
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-final",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Terminal result" }],
    });

    expect(removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
      parentId,
      `agent-report:${childId}:`,
      {
        cancelReason: "Incremental sub-agent update superseded by the terminal report.",
        skipCancelCallbacks: true,
      }
    );
    expect(order).toEqual(["remove:reported", "patch"]);
  });

  test("workflow-owned agent_report updates do not wake the parent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-workflow-progress";
    const childId = "child-workflow-progress";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_progress", stepId: "collect", outputSchema: {} },
        }),
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.reportAgentProgress(childId, "workflow-progress", {
      reportMarkdown: "Structured workflow update submitted.",
      structuredOutput: { claims: ["verified"] },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("running");
  });

  test("non-plan subagent stream-end with final assistant text finalizes an implicit report", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-1",
          toolName: "agent_report",
          input: { reportMarkdown: "Early finding", title: "Finding" },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress-2",
          toolName: "agent_report",
          input: { reportMarkdown: "Later finding", title: "Latest update" },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nImplicit report content from the child." },
      ],
    });

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("output-available");
      const outputJson = JSON.stringify(toolPart?.output);
      expect(outputJson).toContain("Implicit report content from the child.");
      expect(outputJson).not.toContain("fallback");
    }

    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nImplicit report content from the child."
    );
    expect(report?.title).toBe("Latest update");

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("reported");

    expect(remove).not.toHaveBeenCalled();
    const sendCalls = (sendMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of sendCalls) {
      const msg = call[1] as string;
      expect(msg).not.toContain("agent_report");
    }
  });

  test("workflow subagent reuses structured agent_report metadata from an earlier turn", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-history";
    const childId = "child-structured-history";
    const workflowRunId = "wfr_structured_history";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-history",
        description: "Structured history",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    const progressMessage = createMuxMessage(
      "assistant-progress",
      "assistant",
      "",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-progress",
          toolName: "agent_report",
          input: { claims: ["persisted"] },
          state: "output-available",
          output: { success: true },
        },
      ]
    );
    expect((await historyService.appendToHistory(childId, progressMessage)).success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "## Final answer\n\nFinal prose after an earlier update." }],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("## Final answer\n\nFinal prose after an earlier update.");
    expect(report?.structuredOutput).toEqual({ claims: ["persisted"] });
  });

  test("workflow subagent uses agent_report metadata with the final assistant response", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-structured-text";
    const childId = "child-structured-text";
    const workflowRunId = "wfr_structured_text";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "structured-text",
        description: "Structured text",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-structured",
          toolName: "agent_report",
          input: { claims: ["verified"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "## Final answer\n\nThis prose is the final workflow summary." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe(
      "## Final answer\n\nThis prose is the final workflow summary."
    );
    expect(report?.structuredOutput).toEqual({ claims: ["verified"] });
  });

  test("failed final workflow agent_report does not reuse stale structured output", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-stale-structured";
    const childId = "child-stale-structured";
    const workflowRunId = "wfr_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "stale-structured",
        description: "Stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    expect(
      (
        await historyService.appendToHistory(
          childId,
          createMuxMessage("assistant-progress", "assistant", "", { timestamp: Date.now() }, [
            {
              type: "dynamic-tool",
              toolCallId: "agent-report-old",
              toolName: "agent_report",
              input: { claims: ["stale"] },
              state: "output-available",
              output: { success: true },
            },
          ])
        )
      ).success
    ).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary should not reuse stale output." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("failed newer in-turn workflow agent_report invalidates an earlier success", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-in-turn-stale-structured";
    const childId = "child-in-turn-stale-structured";
    const workflowRunId = "wfr_in_turn_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "in-turn-stale-structured",
        description: "In-turn stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-success",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        { type: "text", text: "Final summary after failed replacement." },
      ],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("newer valid in-turn workflow agent_report corrects an earlier failure", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-corrected-structured";
    const childId = "child-corrected-structured";
    const workflowRunId = "wfr_corrected_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "running",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "corrected-structured",
        description: "Corrected structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-failed",
          toolName: "agent_report",
          input: { claims: [1] },
          state: "output-available",
          output: {
            success: false,
            message: "Structured output failed schema validation.",
            errors: [{ path: "$.claims[0]", message: "must be string" }],
          },
        },
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-corrected",
          toolName: "agent_report",
          input: { claims: ["corrected"] },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary after correcting structured output." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Final summary after correcting structured output.");
    expect(report?.structuredOutput).toEqual({ claims: ["corrected"] });
  });

  test("recovery final text does not scan past a failed workflow agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-recovery-stale-structured";
    const childId = "child-recovery-stale-structured";
    const workflowRunId = "wfr_recovery_stale_structured";
    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: { runId: workflowRunId, stepId: "collect", outputSchema },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "recovery-stale-structured",
        description: "Recovery stale structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { historyService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });
    for (const message of [
      createMuxMessage("assistant-old-progress", "assistant", "", { timestamp: Date.now() - 2 }, [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-old",
          toolName: "agent_report",
          input: { claims: ["stale"] },
          state: "output-available",
          output: { success: true },
        },
      ]),
      createMuxMessage(
        "assistant-failed-progress",
        "assistant",
        "",
        { timestamp: Date.now() - 1 },
        [
          {
            type: "dynamic-tool",
            toolCallId: "agent-report-failed",
            toolName: "agent_report",
            input: { claims: [1] },
            state: "output-available",
            output: {
              success: false,
              message: "Structured output failed schema validation.",
              errors: [{ path: "$.claims[0]", message: "must be string" }],
            },
          },
        ]
      ),
    ]) {
      expect((await historyService.appendToHistory(childId, message)).success).toBe(true);
    }

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-recovery-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [{ type: "text", text: "Recovery final text without a fresh structured report." }],
    });

    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("First call agent_report"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
  });

  test("workflow subagent invalid structured agent_report does not finalize", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-invalid-structured";
    const childId = "child-invalid-structured";
    const workflowRunId = "wfr_invalid_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["claims"],
              properties: { claims: { type: "array", items: { type: "string" } } },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "invalid-structured",
        description: "Invalid structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            structuredOutput: { claims: [1] },
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Final summary with invalid structured metadata." },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("The previous final assistant response attempt failed"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("awaiting_report");
    expect(
      await readSubagentReportArtifact(path.join(config.sessionsDir, parentId), childId)
    ).toBeNull();
  });

  test("legacy workflow subagent with invalid old outputSchema can finalize markdown-only report", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-schema";
    const childId = "child-legacy-invalid-schema";
    const workflowRunId = "wfr_legacy_invalid_schema";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-schema",
        description: "Legacy invalid schema",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Legacy report",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Legacy report" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Legacy report");
    expect(report?.structuredOutput).toBeUndefined();
  });

  test("legacy invalid workflow schemas recover with a final response instead of structured agent_report", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-legacy-invalid-recovery";
    const childId = "child-legacy-invalid-recovery";
    const workflowRunId = "wfr_legacy_invalid_recovery";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { $ref: "#/defs/pre-upgrade" },
          },
        }),
      ],
      testTaskSettings()
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "legacy-invalid-recovery",
        description: "Legacy invalid recovery",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      agentOutputSchemaRequired: false,
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const internal = taskService as unknown as {
      promptTaskForRequiredCompletionTool: (
        workspaceId: string,
        options: { expectedAttemptId: string | null }
      ) => Promise<boolean>;
    };

    expect(
      await internal.promptTaskForRequiredCompletionTool(childId, { expectedAttemptId: null })
    ).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("respond with your final assistant message"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain("First call agent_report");
  });

  test("workflow subagent treats strict-provider null optional fields as omitted", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-optional-null-structured";
    const childId = "child-optional-null-structured";
    const workflowRunId = "wfr_optional_null_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: {
              type: "object",
              required: ["code", "nested"],
              properties: {
                code: { type: "string" },
                notes: { type: "string" },
                nullableNote: { type: ["string", "null"] },
                nested: {
                  type: "object",
                  required: ["id"],
                  properties: {
                    id: { type: "string" },
                    detail: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "optional-null-structured",
        description: "Optional null structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            code: "ABC",
            notes: null,
            nullableNote: null,
            nested: { id: "nested-1", detail: null },
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Optional fields normalized." },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.structuredOutput).toEqual({
      code: "ABC",
      nullableNote: null,
      nested: { id: "nested-1" },
    });
  });

  test("workflow subagent accepts direct schema-shaped report for object schema", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-missing-structured";
    const childId = "child-missing-structured";
    const workflowRunId = "wfr_missing_structured";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentType: "exec",
          taskStatus: "awaiting_report",
          taskModelString: "openai:gpt-4o-mini",
          workflowTask: {
            runId: workflowRunId,
            stepId: "collect",
            outputSchema: { type: "object" },
          },
        }),
      ],
      testTaskSettings()
    );

    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, parentId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentId,
      workflow: {
        name: "missing-structured",
        description: "Missing structured",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-06-04T00:00:00.000Z",
    });
    await runStore.appendStatus(workflowRunId, "running", "2026-06-04T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "stop" },
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "agent-report-call-1",
          toolName: "agent_report",
          input: {
            reportMarkdown: "Done",
            title: null,
          },
          state: "output-available",
          output: { success: true },
        },
        { type: "text", text: "Done" },
      ],
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childId)?.taskStatus).toBe("reported");
    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report?.reportMarkdown).toBe("Done");
    expect(report?.structuredOutput).toEqual({ reportMarkdown: "Done", title: null });
  });

  test("length-truncated final assistant text still requires explicit agent_report", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini", finishReason: "length" },
      parts: [{ type: "text", text: "Partial final-looking text that was cut off" }],
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");
  });

  test("missing agent_report keeps the task awaiting_report and retries with agent_report-only prompts", async () => {
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
          taskModelString: "openai:gpt-4o-mini",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const remove = mock(async (workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({ remove });
    const { partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const parentPartial = createMuxMessage(
      "assistant-parent-partial",
      "assistant",
      "Waiting on subagent…",
      { timestamp: Date.now() },
      [
        {
          type: "dynamic-tool",
          toolCallId: "task-call-1",
          toolName: "task",
          input: { subagent_type: "explore", prompt: "do the thing", title: "Test task" },
          state: "input-available",
        },
      ]
    );
    const writeParentPartial = await partialService.writePartial(parentId, parentPartial);
    expect(writeParentPartial.success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-output",
      metadata: { model: "openai:gpt-4o-mini" },
      parts: [],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      childId,
      expect.stringContaining("Your stream ended without a final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      childId,
      expect.stringContaining("Do not continue investigating or call other tools"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true, agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const ws = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === childId);
    expect(ws?.taskStatus).toBe("awaiting_report");

    const updatedParentPartial = await partialService.readPartial(parentId);
    expect(updatedParentPartial).not.toBeNull();
    if (updatedParentPartial) {
      const toolPart = updatedParentPartial.parts.find(
        (p) =>
          p &&
          typeof p === "object" &&
          "type" in p &&
          (p as { type?: unknown }).type === "dynamic-tool"
      ) as unknown as
        | {
            toolName: string;
            state: string;
            output?: unknown;
          }
        | undefined;
      expect(toolPart?.toolName).toBe("task");
      expect(toolPart?.state).toBe("input-available");
      expect(toolPart?.output).toBeUndefined();
    }

    const report = await readSubagentReportArtifact(
      path.join(config.sessionsDir, parentId),
      childId
    );
    expect(report).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
