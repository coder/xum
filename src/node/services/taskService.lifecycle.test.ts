import * as path from "path";
import { describe, test, expect, mock, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import {
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
  TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { Config } from "@/node/config";
import { upsertSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { Ok, Err, type Result } from "@/common/types/result";
import { defaultModel } from "@/common/utils/ai/models";
import type { WorkspaceMetadata } from "@/common/types/workspace";
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
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createNullInitLogger,
  createTaskServiceHarness,
  registerTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
  rootDir,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  registerTaskServiceTestRoot();

  test("task creation waits for ancestor lifecycle changes and rejects an archived parent", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const { workspaceService, create } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    let releaseArchive: (() => void) | undefined;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveEntered: (() => void) | undefined;
    const archiveStarted = new Promise<void>((resolve) => {
      archiveEntered = resolve;
    });
    const archiveOperation = taskService.withTaskTreeLifecycleLock(parentId, async () => {
      archiveEntered?.();
      await archiveGate;
    });
    await archiveStarted;

    const creation = createAgentTask(taskService, parentId, "Inspect the archived parent race");
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    await config.editConfig((cfg) => {
      const parent = cfg.projects
        .get(projectPath)
        ?.workspaces.find((workspace) => workspace.id === parentId);
      assert(parent, "parent workspace must exist");
      parent.archivedAt = "2026-08-10T00:00:00.000Z";
      return cfg;
    });
    releaseArchive?.();

    expect(await creation).toEqual(Err("Task.create: parent workspace is archived"));
    await archiveOperation;
    expect(
      await taskService.createMany([
        {
          parentWorkspaceId: parentId,
          kind: "agent",
          agentId: "explore",
          prompt: "Inspect the archived parent race in bulk",
          title: "Archived bulk task",
        },
      ])
    ).toEqual(Err("Task.createMany: parent workspace is archived"));
    expect(create).not.toHaveBeenCalled();
  });

  test("task stop serializes descendant creation and leaves the stopped parent inactive", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-stop-create-race";
    const childTaskId = "child-stop-create-race";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === childTaskId) {
        markStopStarted?.();
        await stopGate;
      }
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const create = mock(
      (): Promise<Result<{ metadata: WorkspaceMetadata }>> =>
        Promise.resolve(Err("creation should be rejected after stop"))
    );
    const { workspaceService } = createWorkspaceServiceMocks({ create });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const stopping = taskService.stopDescendantAgentTask(parentWorkspaceId, childTaskId);
    await stopStarted;

    const creation = createAgentTask(taskService, childTaskId, "Spawn after stop");
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();

    releaseStop?.();
    expect(await stopping).toEqual(Ok({ stoppedTaskIds: [childTaskId] }));
    expect(await creation).toEqual(Err("Task.create: cannot spawn new tasks after task_stop"));
    expect(create).not.toHaveBeenCalled();
  });

  test("bulk task creation waits for task stop and rejects the interrupted parent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-stop-create-many-race";
    const childTaskId = "child-stop-create-many-race";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    let markStopStarted: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopStream = mock(async (workspaceId: string) => {
      if (workspaceId === childTaskId) {
        markStopStarted?.();
        await stopGate;
      }
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const stopping = taskService.stopDescendantAgentTask(parentWorkspaceId, childTaskId);
    await stopStarted;
    const creation = taskService.createMany([
      {
        parentWorkspaceId: childTaskId,
        kind: "agent",
        agentId: "explore",
        prompt: "Spawn workflow workers after stop",
        title: "Workflow worker",
      },
    ]);
    await Promise.resolve();

    releaseStop?.();
    expect(await stopping).toEqual(Ok({ stoppedTaskIds: [childTaskId] }));
    expect(await creation).toEqual(Err("Task.createMany: cannot spawn new tasks after task_stop"));
    expect(
      Array.from(config.loadConfigOrDefault().projects.values())
        .flatMap((project) => project.workspaces)
        .filter((workspace) => workspace.parentWorkspaceId === childTaskId)
    ).toHaveLength(0);
  });

  test("task tree lifecycle locks serialize descendants with their ancestor", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-tree-lock";
    const childTaskId = "child-tree-lock";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );
    const { taskService } = createTaskServiceHarness(config);

    let releaseChild: (() => void) | undefined;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childEntered: (() => void) | undefined;
    const childStarted = new Promise<void>((resolve) => {
      childEntered = resolve;
    });
    let ancestorEntered = false;
    const childOperation = taskService.withTaskTreeLifecycleLock(childTaskId, async () => {
      childEntered?.();
      await childGate;
    });
    await childStarted;
    const ancestorOperation = taskService.withTaskTreeLifecycleLock(parentWorkspaceId, () => {
      ancestorEntered = true;
      return Promise.resolve();
    });
    await Promise.resolve();
    expect(ancestorEntered).toBe(false);
    releaseChild?.();
    await Promise.all([childOperation, ancestorOperation]);
    expect(ancestorEntered).toBe(true);
  });

  test("task removal waits for active patch generation before deleting the child", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-remove-active-patch";
    const childTaskId = "child-remove-active-patch";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-08-18T00:00:00.000Z",
        }),
      ],
      testTaskSettings()
    );
    await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: path.join(config.sessionsDir, parentWorkspaceId),
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status: "skipped",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "skipped",
            commitCount: 0,
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 1,
        totalCommitCount: 0,
      }),
    });

    let releaseGeneration: (() => void) | undefined;
    const generation = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ removeWhileTaskTreeLocked: remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const gitPatchArtifactService = (
      taskService as unknown as {
        gitPatchArtifactService: { pendingJobsByTaskId: Map<string, Promise<void>> };
      }
    ).gitPatchArtifactService;
    gitPatchArtifactService.pendingJobsByTaskId.set(childTaskId, generation);

    const removal = taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId);
    await Promise.resolve();
    expect(remove).not.toHaveBeenCalled();

    releaseGeneration?.();
    expect(await removal).toMatchObject(
      Ok({ status: "removed", action: "remove", taskId: childTaskId })
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("task removal preserves an inactive child while its patch artifact is pending", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-remove-pending-patch";
    const childTaskId = "child-remove-pending-patch";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-08-18T00:00:00.000Z",
        }),
      ],
      testTaskSettings()
    );
    await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: path.join(config.sessionsDir, parentWorkspaceId),
      childTaskId,
      updater: () => ({
        childTaskId,
        parentWorkspaceId,
        createdAtMs: 1,
        updatedAtMs: 1,
        status: "pending",
        projectArtifacts: [
          {
            projectPath,
            projectName: "repo",
            storageKey: "repo",
            status: "pending",
          },
        ],
        readyProjectCount: 0,
        failedProjectCount: 0,
        skippedProjectCount: 0,
        totalCommitCount: 0,
      }),
    });

    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ removeWhileTaskTreeLocked: remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId)
    ).toEqual(
      Ok({
        status: "error",
        action: "remove",
        taskId: childTaskId,
        workspaceId: childTaskId,
        displayName: "child",
        error: "Cannot remove the sub-agent while its git patch artifact is still pending.",
      })
    );
    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)).toBeDefined();

    await upsertSubagentGitPatchArtifact({
      workspaceId: parentWorkspaceId,
      workspaceSessionDir: path.join(config.sessionsDir, parentWorkspaceId),
      childTaskId,
      updater: (existing) => {
        assert(existing, "pending artifact must exist");
        return {
          ...existing,
          updatedAtMs: 2,
          projectArtifacts: existing.projectArtifacts.map((projectArtifact) => ({
            ...projectArtifact,
            status: "skipped" as const,
            commitCount: 0,
          })),
        };
      },
    });

    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId)
    ).toMatchObject(Ok({ status: "removed", action: "remove", taskId: childTaskId }));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("task removal waits for inactive-child reawakening and then rejects the active child", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["racehandle", "raceturn"]);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-remove-reactivate-race";
    const childTaskId = "child-remove-reactivate-race";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          runtimeConfig: { type: "local" },
          parentWorkspaceId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-08-10T00:00:00.000Z",
          title: "API reliability expert",
        }),
      ],
      testTaskSettings()
    );

    let markSendStarted: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
      markSendStarted?.();
      await sendGate;
      const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
      await internal?.onAccepted?.();
      return Ok(undefined);
    });
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage, remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const reactivatePromise = taskService.sendMessageToDescendantAgentTask(
      parentWorkspaceId,
      childTaskId,
      "Investigate the retry path.",
      "tool-end"
    );
    await sendStarted;
    const removePromise = taskService.removeInactiveDescendantAgentTask(
      parentWorkspaceId,
      childTaskId
    );
    releaseSend?.();

    const [reactivated, removal] = await Promise.all([reactivatePromise, removePromise]);
    expect(reactivated).toMatchObject({
      success: true,
      data: { delivery: "reactivated" },
    });
    expect(removal).toMatchObject({ success: true, data: { status: "active" } });
    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)).toBeTruthy();
  });

  test("stopDescendantAgentTask makes active children inactive without removing their workspace", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-stop-child";
    const childTaskId = "child-stop-child";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const isStreaming = mock((workspaceId: string) => workspaceId === childTaskId);
    const stopStream = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { aiService } = createAIServiceMocks(config, { isStreaming, stopStream });
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    // The stop supersedes the child's queued incremental updates in the parent's queue; left
    // there as tool-end entries they would cut the parent's turn before being refused.
    const removeQueuedMessagesByDedupeKeyPrefix = mock((): Result<number> => {
      expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("interrupted");
      return Ok(1);
    });
    const { workspaceService } = createWorkspaceServiceMocks({
      remove,
      removeQueuedMessagesByDedupeKeyPrefix,
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const terminalAttentionStore = new TerminalAttentionStore(config);
    await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      sourceId: childTaskId,
    });
    expect(await taskService.stopDescendantAgentTask(parentWorkspaceId, childTaskId)).toEqual(
      Ok({ stoppedTaskIds: [childTaskId] })
    );
    expect(
      await terminalAttentionStore.get(parentWorkspaceId, `agent_task:${childTaskId}`)
    ).toMatchObject({ status: "superseded" });
    expect(stopStream).toHaveBeenCalledWith(childTaskId, { abandonPartial: false });
    expect(remove).not.toHaveBeenCalled();
    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("interrupted");
    expect(removeQueuedMessagesByDedupeKeyPrefix).toHaveBeenCalledWith(
      parentWorkspaceId,
      `agent-report:${childTaskId}:`,
      {
        cancelReason: "Incremental sub-agent update superseded by the terminal report.",
        skipCancelCallbacks: true,
      }
    );
  });

  test("acknowledged removal preflights activity and scope and retries deepest-first", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parent = "ack-parent";
    const child = "ack-child";
    const grandchild = "ack-grandchild";
    const workspaces = [
      projectWorkspace(projectPath, "parent", parent),
      projectWorkspace(projectPath, "child", child, {
        parentWorkspaceId: parent,
        taskStatus: "reported",
      }),
      projectWorkspace(projectPath, "grandchild", grandchild, {
        parentWorkspaceId: child,
        taskStatus: "running",
        taskIsolation: "none",
      }),
    ];
    await saveWorkspaces(config, projectPath, workspaces, testTaskSettings());
    let fail = true;
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      if (workspaceId === child && fail) return Err("runtime failure");
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ removeWhileTaskTreeLocked: remove });
    let streaming = false;
    const { aiService } = createAIServiceMocks(config, {
      isStreaming: mock((id: string) => streaming && id === grandchild),
    });
    const { taskService } = createTaskServiceHarness(config, { workspaceService, aiService });
    const removeScope = (ids: string[]) =>
      taskService.withTaskTreeLifecycleLock(parent, () =>
        taskService.removeAcknowledgedDescendantsWhileTaskTreeLocked(parent, ids)
      );
    expect(taskService.listWorkspaceRemovalDescendants(parent)).toContainEqual({
      workspaceId: grandchild,
      title: "grandchild",
      active: true,
    });
    expect((await removeScope([child, grandchild])).success).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    workspaces[2].taskStatus = "reported";
    await saveWorkspaces(config, projectPath, workspaces, testTaskSettings());
    streaming = true;
    expect((await removeScope([child, grandchild])).success).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    streaming = false;
    expect((await removeScope([child])).success).toBe(false);
    expect((await removeScope([child, grandchild, "unrelated"])).success).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    expect(
      taskService.listWorkspaceRemovalDescendants(parent).map((entry) => entry.workspaceId)
    ).toEqual([grandchild, child]);
    const failure = await removeScope([child, grandchild]);
    expect(failure.success).toBe(false);
    if (!failure.success) {
      expect(failure.error).toContain(child);
      expect(failure.error).toContain("runtime failure");
    }
    expect(
      taskService.listWorkspaceRemovalDescendants(parent).map((entry) => entry.workspaceId)
    ).toEqual([child]);
    expect(config.findWorkspace(parent)).not.toBeNull();
    fail = false;
    expect(await removeScope([child, grandchild])).toEqual(Ok(undefined));
    expect(remove.mock.calls.map((call) => call[0])).toEqual([grandchild, child, child]);
    expect(await removeScope([child, grandchild])).toEqual(Ok(undefined));
  });

  test("removeInactiveDescendantAgentTask enforces scope, leaf order, and idempotency", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-remove-child";
    const childTaskId = "child-remove-child";
    const grandchildTaskId = "grandchild-remove-child";
    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId),
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId,
          taskStatus: "reported",
          title: "React lifecycle expert",
        }),
        projectWorkspace(projectPath, "grandchild", grandchildTaskId, {
          parentWorkspaceId: childTaskId,
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      await removeWorkspaceFromTestConfig(config, workspaceId);
      return Ok(undefined);
    });
    const { workspaceService } = createWorkspaceServiceMocks({ removeWhileTaskTreeLocked: remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, "foreign-child")
    ).toMatchObject({ success: true, data: { status: "invalid_scope" } });
    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId)
    ).toMatchObject({
      success: true,
      data: { status: "error", descendantTaskIds: [grandchildTaskId] },
    });
    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, grandchildTaskId)
    ).toMatchObject({ success: true, data: { status: "removed" } });
    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId)
    ).toMatchObject({ success: true, data: { status: "removed" } });
    expect(await taskService.isDescendantAgentTask(parentWorkspaceId, childTaskId)).toBe(true);
    expect(
      await taskService.removeInactiveDescendantAgentTask(parentWorkspaceId, childTaskId)
    ).toMatchObject({ success: true, data: { status: "already_removed" } });
    expect(remove.mock.calls.map((call) => call[0])).toEqual([grandchildTaskId, childTaskId]);
    expect(
      await taskService.sendMessageToDescendantAgentTask(
        parentWorkspaceId,
        childTaskId,
        "Resume work",
        "tool-end"
      )
    ).toEqual(Err({ code: "not_found" }));
  });

  test("requestAgentFinalReportForTimeout records finalization token only after prompt send succeeds", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-child";
    let sendSucceeds = false;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    let isStreaming = false;
    let callOnAccepted = true;
    let queuedOnAccepted: (() => Promise<void> | void) | undefined;
    const { aiService, stopStream } = createAIServiceMocks(config, {
      isStreaming: mock(() => isStreaming),
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks({
      sendMessage: mock(async (...args: unknown[]): Promise<Result<void>> => {
        if (!sendSucceeds) {
          return Err("send failed");
        }
        const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
        if (callOnAccepted) {
          await internal?.onAccepted?.();
        } else {
          queuedOnAccepted = internal?.onAccepted;
        }
        return Ok(undefined);
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const request = {
      workflowRunId: "wfr_timeout",
      stepId: "slow-step",
      inputHash: "hash",
      finalizationToken: "token-1",
    };

    const failedPromptResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(failedPromptResult).toBe("not_active");
    let childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toBeUndefined();

    sendSucceeds = true;
    const promptedResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(promptedResult).toBe("prompted");
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(sendMessage).toHaveBeenLastCalledWith(
      childTaskId,
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ startStreamInBackground: true })
    );
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1"]);
    isStreaming = true;
    const alreadyPromptedResult = await taskService.requestAgentFinalReportForTimeout(
      childTaskId,
      request
    );
    expect(alreadyPromptedResult).toBe("prompted");
    expect(stopStream).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    isStreaming = false;
    callOnAccepted = false;
    const queuedPromptResult = await taskService.requestAgentFinalReportForTimeout(childTaskId, {
      ...request,
      finalizationToken: "token-queued",
    });
    expect(queuedPromptResult).toBe("queued");
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1"]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await queuedOnAccepted?.();
    childWorkspace = config
      .loadConfigOrDefault()
      .projects.get(projectPath)
      ?.workspaces.find((workspace) => workspace.id === childTaskId);
    expect(childWorkspace?.taskTimeoutFinalizationTokens).toEqual(["token-1", "token-queued"]);
  });

  test("requestAgentFinalReportForTimeout requires propose_plan for timed-out plan agents", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-plan-child";
    let sentMessage = "";
    let sentToolPolicy: Array<{ regex_match: string; action: string }> | undefined;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_plan_child",
          parentWorkspaceId,
          agentId: "plan",
          agentType: "plan",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks({
      sendMessage: mock(
        async (
          _workspaceId: string,
          message: string,
          options: { toolPolicy?: Array<{ regex_match: string; action: string }> },
          internal?: { onAccepted?: () => Promise<void> | void }
        ): Promise<Result<void>> => {
          sentMessage = message;
          sentToolPolicy = options.toolPolicy;
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      ),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const result = await taskService.requestAgentFinalReportForTimeout(childTaskId, {
      workflowRunId: "wfr_timeout",
      stepId: "plan-step",
      inputHash: "hash",
      finalizationToken: "plan-token",
    });
    expect(result).toBe("prompted");

    expect(sentToolPolicy).toEqual([{ regex_match: "^propose_plan$", action: "require" }]);
    expect(sentMessage).toContain("propose_plan");
    expect(sentMessage).not.toContain("agent_report");
  });

  test("failAgentTaskForHardTimeout clears queued finalization before aborting the stream", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentWorkspaceId = "parent-111";
    const childTaskId = "task-timeout-child";
    const operations: string[] = [];

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentWorkspaceId, {
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "medium",
        }),
      ],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config, {
      stopStream: mock((): Promise<Result<void>> => {
        operations.push("stopStream");
        return Promise.resolve(Ok(undefined));
      }),
    });
    const { workspaceService, clearQueue } = createWorkspaceServiceMocks({
      clearQueue: mock((): Result<void> => {
        operations.push("clearQueue");
        return Ok(undefined);
      }),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.failAgentTaskForHardTimeout(childTaskId, {
      workflowRunId: "wfr_timeout",
      stepId: "slow-step",
      inputHash: "hash",
      reason: "timed out",
    });

    expect(clearQueue).toHaveBeenCalledWith(childTaskId);
    expect(stopStream).toHaveBeenCalledWith(childTaskId, {
      abandonPartial: true,
      abortReason: "system",
    });
    expect(operations.slice(0, 2)).toEqual(["clearQueue", "stopStream"]);
  });

  test("terminateDescendantAgentTask stops stream, removes workspace, and rejects waiters", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const taskId = "task-222";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "task", taskId, {
          name: "agent_exec_task",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waiter = taskService
      .waitForAgentReport(taskId, { timeoutMs: 10_000 })
      .catch((error: unknown) => error);

    const terminateResult = await taskService.terminateDescendantAgentTask(rootWorkspaceId, taskId);
    expect(terminateResult.success).toBe(true);

    const caught = await waiter;
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/terminated/i);
    }
    expect(stopStream).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ abandonPartial: true })
    );
    expect(remove).toHaveBeenCalledWith(taskId, true);
  });

  test("terminateDescendantAgentTask terminates descendant tasks leaf-first", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const terminateResult = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    expect(terminateResult.success).toBe(true);
    if (!terminateResult.success) return;
    expect(terminateResult.data.terminatedTaskIds).toEqual([childTaskId, parentTaskId]);

    expect(remove).toHaveBeenNthCalledWith(1, childTaskId, true);
    expect(remove).toHaveBeenNthCalledWith(2, parentTaskId, true);
  });

  test("terminateDescendantAgentTask skips a timed-out stream and continues other descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const stuckTaskId = "task-stuck";
    const siblingTaskId = "task-sibling";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "stuck-task", stuckTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "sibling-task", siblingTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      return workspaceId === stuckTaskId
        ? new Promise(() => undefined)
        : Promise.resolve(Ok(undefined));
    });
    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (timeout === TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS) {
        // Fire on a 0ms macrotask, not a microtask: already-resolved stop
        // promises settle through several microtask hops first, so only the
        // genuinely stuck stream can lose the race to this timer.
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);

    const terminateResult = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    timeoutSpy.mockRestore();

    expect(terminateResult.success).toBe(false);
    if (terminateResult.success) return;
    expect(terminateResult.error).toContain(`Timed out stopping task stream (${stuckTaskId})`);
    expect(terminateResult.error).toContain(
      `Skipped removing task workspace (${parentTaskId}): a descendant task workspace was not removed`
    );
    expect(remove).not.toHaveBeenCalledWith(stuckTaskId, true);
    expect(remove).toHaveBeenCalledWith(siblingTaskId, true);
    // The stuck child survives, so its ancestor must survive too: a live child
    // must never point at removed parent metadata.
    expect(remove).not.toHaveBeenCalledWith(parentTaskId, true);
  });

  test("terminate retry awaits the original in-flight removal instead of trusting a dedup Ok", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "parent-task", parentTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    // First removal of the child hangs; later calls return Ok, simulating
    // WorkspaceService.remove()'s short-circuit for IDs already being removed.
    let childRemoveCalls = 0;
    const remove = mock((workspaceId: string, _force?: boolean): Promise<Result<void>> => {
      if (workspaceId === childTaskId) {
        childRemoveCalls += 1;
        if (childRemoveCalls === 1) {
          return new Promise(() => undefined);
        }
      }
      return Promise.resolve(Ok(undefined));
    });
    const { workspaceService } = createWorkspaceServiceMocks({ remove });
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      timeout?: number
    ) => {
      if (timeout === TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS) {
        // 0ms macrotask so pending microtask chains settle first (see above).
        return originalSetTimeout(handler, 0);
      }
      return originalSetTimeout(handler, timeout);
    }) as typeof setTimeout);

    const firstAttempt = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    const retryAttempt = await taskService.terminateDescendantAgentTask(
      rootWorkspaceId,
      parentTaskId
    );
    timeoutSpy.mockRestore();

    expect(firstAttempt.success).toBe(false);
    expect(retryAttempt.success).toBe(false);
    if (retryAttempt.success) return;
    expect(retryAttempt.error).toContain(`Timed out removing task workspace (${childTaskId})`);
    // The retry must not re-call remove for the child (a fresh call would
    // return the dedup Ok) and must keep the parent blocked.
    expect(childRemoveCalls).toBe(1);
    expect(remove).not.toHaveBeenCalledWith(parentTaskId, true);
  });

  test("descendant traversal terminates when task metadata contains a cycle", () => {
    const config = new Config(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const traversal = taskService as unknown as {
      listDescendantAgentTaskIdsFromIndex: (
        index: {
          byId: Map<string, unknown>;
          childrenByParent: Map<string, string[]>;
          parentById: Map<string, string>;
        },
        workspaceId: string
      ) => string[];
    };
    const index = {
      byId: new Map<string, unknown>(),
      childrenByParent: new Map([
        ["root", ["child"]],
        ["child", ["grandchild"]],
        ["grandchild", ["child", "root"]],
      ]),
      parentById: new Map<string, string>(),
    };

    expect(traversal.listDescendantAgentTaskIdsFromIndex(index, "root")).toEqual([
      "child",
      "grandchild",
    ]);
  });

  test("terminateAllDescendantAgentTasks interrupts entire subtree leaf-first", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const callOrder: string[] = [];
    const clearQueue = mock((workspaceId: string): Result<void> => {
      callOrder.push(`clear:${workspaceId}`);
      return Ok(undefined);
    });
    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      callOrder.push(`stop:${workspaceId}`);
      return Promise.resolve(Ok(undefined));
    });

    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService, remove } = createWorkspaceServiceMocks({ clearQueue });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    expect(clearQueue).toHaveBeenNthCalledWith(1, childTaskId);
    expect(clearQueue).toHaveBeenNthCalledWith(2, parentTaskId);
    expect(stopStream).toHaveBeenNthCalledWith(
      1,
      childTaskId,
      expect.objectContaining({ abandonPartial: false })
    );
    expect(stopStream).toHaveBeenNthCalledWith(
      2,
      parentTaskId,
      expect.objectContaining({ abandonPartial: false })
    );
    expect(callOrder).toEqual([
      `clear:${childTaskId}`,
      `stop:${childTaskId}`,
      `clear:${parentTaskId}`,
      `stop:${parentTaskId}`,
    ]);
    expect(remove).not.toHaveBeenCalled();

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const parentTask = tasks.find((workspace) => workspace.id === parentTaskId);
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(parentTask?.taskStatus).toBe("interrupted");
    expect(childTask?.taskStatus).toBe("interrupted");
  });

  test("terminateAllDescendantAgentTasks can scope interrupts to one workflow run", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const otherTaskId = "task-other";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "other-task", otherTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_other", stepId: "scope" },
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId, {
      workflowRunId: "wfr_target",
    });

    expect(interruptedTaskIds).toEqual([workflowChildTaskId, workflowTaskId]);
    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    expect(tasks.find((workspace) => workspace.id === workflowTaskId)?.taskStatus).toBe(
      "interrupted"
    );
    expect(tasks.find((workspace) => workspace.id === workflowChildTaskId)?.taskStatus).toBe(
      "interrupted"
    );
    expect(tasks.find((workspace) => workspace.id === otherTaskId)?.taskStatus).toBe("running");
  });

  test("listDescendantAgentTasks can exclude workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const regularTaskId = "task-regular";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "regular-task", regularTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(
      new Set(taskService.listDescendantAgentTasks(rootWorkspaceId).map((task) => task.taskId))
    ).toEqual(new Set([regularTaskId, workflowChildTaskId, workflowTaskId]));
    expect(
      taskService
        .listDescendantAgentTasks(rootWorkspaceId, {
          excludeWorkflowTasks: true,
        })
        .map((task) => task.taskId)
    ).toEqual([regularTaskId]);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, workflowTaskId)
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, workflowChildTaskId)
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(rootWorkspaceId, regularTaskId)
    ).toBe(false);
  });

  test("listDescendantAgentTasks exposes current grouped-task metadata", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const groupedTaskId = "task-grouped";
    const standaloneTaskId = "task-standalone";
    const bestOf = { groupId: "task-group:root-111:call-1", index: 0, total: 2 } as const;

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "grouped-task", groupedTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "reported",
          bestOf,
        }),
        projectWorkspace(projectPath, "standalone-task", standaloneTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "reported",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });
    const listedTasks = taskService.listDescendantAgentTasks(rootWorkspaceId);

    expect(listedTasks.find((task) => task.taskId === groupedTaskId)?.bestOf).toEqual(bestOf);
    expect(listedTasks.find((task) => task.taskId === standaloneTaskId)?.bestOf).toBeUndefined();
  });

  test("isWorkflowOwnedDescendantAgentTask consults persisted report metadata", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const removedWorkflowChildTaskId = "task-workflow-child-removed";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "reported",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
      ],
      testTaskSettings()
    );

    await upsertSubagentReportArtifact({
      workspaceId: rootWorkspaceId,
      workspaceSessionDir: path.join(config.sessionsDir, rootWorkspaceId),
      childTaskId: removedWorkflowChildTaskId,
      parentWorkspaceId: workflowTaskId,
      ancestorWorkspaceIds: [workflowTaskId, rootWorkspaceId],
      workflowOwnedAncestorWorkspaceIds: [rootWorkspaceId],
      reportMarkdown: "done",
      nowMs: 1,
    });

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(
        rootWorkspaceId,
        removedWorkflowChildTaskId
      )
    ).toBe(true);
    expect(
      await taskService.isWorkflowOwnedDescendantAgentTask(
        workflowTaskId,
        removedWorkflowChildTaskId
      )
    ).toBe(false);
  });

  test("listActiveDescendantAgentTaskIds can exclude workflow-owned descendants", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const workflowTaskId = "task-workflow";
    const workflowChildTaskId = "task-workflow-child";
    const regularTaskId = "task-regular";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "workflow-task", workflowTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
          workflowTask: { runId: "wfr_target", stepId: "scope" },
        }),
        projectWorkspace(projectPath, "workflow-child", workflowChildTaskId, {
          parentWorkspaceId: workflowTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "regular-task", regularTaskId, {
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    expect(new Set(taskService.listActiveDescendantAgentTaskIds(rootWorkspaceId))).toEqual(
      new Set([regularTaskId, workflowChildTaskId, workflowTaskId])
    );
    expect(
      taskService.listActiveDescendantAgentTaskIds(rootWorkspaceId, {
        excludeWorkflowTasks: true,
      })
    ).toEqual([regularTaskId]);
  });

  test("terminateAllDescendantAgentTasks preserves already-completed descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";
    const completedAt = "2026-03-09T11:05:58.780Z";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: completedAt,
        }),
      ],
      testTaskSettings()
    );

    const callOrder: string[] = [];
    const clearQueue = mock((workspaceId: string): Result<void> => {
      callOrder.push(`clear:${workspaceId}`);
      return Ok(undefined);
    });
    const stopStream = mock((workspaceId: string): Promise<Result<void>> => {
      callOrder.push(`stop:${workspaceId}`);
      return Promise.resolve(Ok(undefined));
    });

    const { aiService } = createAIServiceMocks(config, { stopStream });
    const { workspaceService } = createWorkspaceServiceMocks({ clearQueue });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([parentTaskId]);
    expect(callOrder).toEqual([
      `clear:${childTaskId}`,
      `stop:${childTaskId}`,
      `clear:${parentTaskId}`,
      `stop:${parentTaskId}`,
    ]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const parentTask = tasks.find((workspace) => workspace.id === parentTaskId);
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(parentTask?.taskStatus).toBe("interrupted");
    expect(childTask?.taskStatus).toBe("reported");
    expect(childTask?.reportedAt).toBe(completedAt);
  });

  test("terminateAllDescendantAgentTasks still interrupts running descendants with stale reportedAt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";
    const staleReportedAt = "2026-03-09T11:05:58.780Z";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
          reportedAt: staleReportedAt,
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");
    expect(childTask?.reportedAt).toBeUndefined();
  });

  test("terminateAllDescendantAgentTasks rejects waiters when a descendant disappears mid-cascade", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const waiterResult = taskService
      .waitForAgentReport(childTaskId, {
        timeoutMs: 1_000,
        requestingWorkspaceId: rootWorkspaceId,
      })
      .then(() => new Error("Expected waiter to reject"))
      .catch((error: unknown) => error);

    const internal = taskService as unknown as {
      editWorkspaceEntry: (
        workspaceId: string,
        updater: (workspace: unknown) => void,
        options?: { allowMissing?: boolean }
      ) => Promise<boolean>;
    };
    const originalEditWorkspaceEntry = internal.editWorkspaceEntry.bind(taskService);
    const editWorkspaceEntrySpy = spyOn(internal, "editWorkspaceEntry").mockImplementation(
      (workspaceId, updater, options) => {
        if (workspaceId === childTaskId) {
          return Promise.resolve(false);
        }
        return originalEditWorkspaceEntry(workspaceId, updater, options);
      }
    );

    try {
      const interruptedTaskIds =
        await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
      expect(interruptedTaskIds).toEqual([parentTaskId]);

      const waiterError = await waiterResult;
      expect(waiterError).toBeInstanceOf(Error);
      if (waiterError instanceof Error) {
        expect(waiterError.message).toBe("Parent workspace interrupted");
      }
    } finally {
      editWorkspaceEntrySpy.mockRestore();
    }
  });

  test("terminateAllDescendantAgentTasks preserves completed report cache for interrupted descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const parentTaskId = "task-parent";
    const childTaskId = "task-child";

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
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const internal = taskService as unknown as {
      resolveWaiters: (
        taskId: string,
        report: { reportMarkdown: string; title?: string }
      ) => boolean;
    };
    internal.resolveWaiters(childTaskId, {
      reportMarkdown: "cached report",
      title: "cached title",
    });

    const interruptedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(interruptedTaskIds).toEqual([childTaskId, parentTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");

    const report = await taskService.waitForAgentReport(childTaskId, {
      timeoutMs: 10_000,
      requestingWorkspaceId: rootWorkspaceId,
    });
    expect(report).toEqual({ reportMarkdown: "cached report", title: "cached title" });
  });

  test("terminateAllDescendantAgentTasks is a no-op with no descendants", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";

    await saveWorkspaces(
      config,
      projectPath,
      [projectWorkspace(projectPath, "root", rootWorkspaceId)],
      testTaskSettings()
    );

    const { aiService, stopStream } = createAIServiceMocks(config);
    const { workspaceService, remove } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    const terminatedTaskIds = await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(terminatedTaskIds).toEqual([]);
    expect(stopStream).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("terminateAllDescendantAgentTasks preserves queued task prompts across repeated interrupts", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const queuedTaskId = "task-queued";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "queued-task", queuedTaskId, {
          name: "agent_exec_queued",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "exec",
          taskStatus: "queued",
          taskPrompt: "resume me later",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const firstInterruptedTaskIds =
      await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(firstInterruptedTaskIds).toEqual([queuedTaskId]);

    const secondInterruptedTaskIds =
      await taskService.terminateAllDescendantAgentTasks(rootWorkspaceId);
    expect(secondInterruptedTaskIds).toEqual([queuedTaskId]);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const queuedTask = tasks.find((workspace) => workspace.id === queuedTaskId);
    expect(queuedTask?.taskStatus).toBe("interrupted");
    expect(queuedTask?.taskPrompt).toBe("resume me later");
  });

  test("markInterruptedTaskRunning restores interrupted descendant tasks to running without clearing prompt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "interrupted",
          taskPrompt: "stale prompt",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    const transitioned = await taskService.markInterruptedTaskRunning(childTaskId);
    expect(transitioned).toBe(true);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("running");
    expect(childTask?.taskPrompt).toBe("stale prompt");
  });

  test("markInterruptedTaskRunning is a no-op for non-interrupted workspaces", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const editConfigSpy = spyOn(config, "editConfig");
    const { taskService } = createTaskServiceHarness(config);

    const transitioned = await taskService.markInterruptedTaskRunning(childTaskId);

    expect(transitioned).toBe(false);
    expect(editConfigSpy).not.toHaveBeenCalled();
  });

  test("restoreInterruptedTaskAfterResumeFailure reverts running descendant tasks and clears stale reportedAt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootWorkspaceId = "root-111";
    const childTaskId = "task-child";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootWorkspaceId),
        projectWorkspace(projectPath, "child-task", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: rootWorkspaceId,
          agentType: "explore",
          taskStatus: "running",
          reportedAt: "2026-03-09T11:05:58.780Z",
        }),
      ],
      testTaskSettings(1, 3)
    );

    const { taskService } = createTaskServiceHarness(config);

    await taskService.restoreInterruptedTaskAfterResumeFailure(childTaskId);

    const saved = config.loadConfigOrDefault();
    const tasks = saved.projects.get(projectPath)?.workspaces ?? [];
    const childTask = tasks.find((workspace) => workspace.id === childTaskId);
    expect(childTask?.taskStatus).toBe("interrupted");
    expect(childTask?.reportedAt).toBeUndefined();
  });

  test("initialize interrupts workflow-owned tasks instead of recovering them after owning workflow interrupt", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const runtimeConfig = { type: "local" as const };
    const parentId = "parent-workflow-interrupted";
    const queuedChildId = "child-workflow-queued";
    const runningChildId = "child-workflow-running";
    const awaitingChildId = "child-workflow-awaiting";
    const nestedRunningChildId = "child-workflow-nested-running";
    const workflowRunId = "wfr_interrupted_owner";
    const innerWorkflowRunId = "wfr_active_inner_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId, { runtimeConfig }),
        projectWorkspace(projectPath, "queued", queuedChildId, {
          name: "agent_explore_queued",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued work",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "queued" },
        }),
        projectWorkspace(projectPath, "running", runningChildId, {
          name: "agent_explore_running",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "running" },
        }),
        projectWorkspace(projectPath, "awaiting", awaitingChildId, {
          name: "agent_explore_awaiting",
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "awaiting" },
        }),
        projectWorkspace(projectPath, "nested-running", nestedRunningChildId, {
          name: "agent_explore_nested_running",
          parentWorkspaceId: runningChildId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: innerWorkflowRunId, stepId: "nested" },
        }),
      ],
      testTaskSettings(10, 3)
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
    const innerRunStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, runningChildId),
    });
    await innerRunStore.createRun({
      id: innerWorkflowRunId,
      workspaceId: runningChildId,
      workflow: {
        name: "inner-running",
        description: "Inner running",
        scope: "built-in",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await innerRunStore.appendStatus(innerWorkflowRunId, "running", "2026-05-29T00:00:01.000Z");

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage, resumeStream } = createWorkspaceServiceMocks({
      getStartupRecoveryState: mock(() => Promise.resolve("blocked" as const)),
    });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(resumeStream).not.toHaveBeenCalled();
    for (const taskId of [queuedChildId, runningChildId, awaitingChildId, nestedRunningChildId]) {
      expect(findWorkspaceInConfig(config, taskId)?.taskStatus).toBe("interrupted");
    }
    expect(findWorkspaceInConfig(config, queuedChildId)?.taskPrompt).toBe("queued work");
  });

  test("initialize recovers parent tasks after interrupting inactive workflow children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-workflow-child-interrupted";
    const parentTaskId = "parent-awaiting-after-child-interrupt";
    const childTaskId = "child-running-inactive-workflow";
    const workflowRunId = "wfr_child_inactive_owner";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "parent", parentTaskId, {
          name: "agent_explore_parent",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "awaiting_report",
          taskModelString: defaultModel,
        }),
        projectWorkspace(projectPath, "child", childTaskId, {
          name: "agent_explore_child",
          parentWorkspaceId: parentTaskId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(config.sessionsDir, parentTaskId),
    });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: parentTaskId,
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

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(findWorkspaceInConfig(config, childTaskId)?.taskStatus).toBe("interrupted");
    expect(sendMessage).toHaveBeenCalledWith(
      parentTaskId,
      expect.stringContaining("awaiting its final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true })
    );
  });

  // Archive mock that mirrors the real WorkspaceService.archive persistence effect
  // (sets archivedAt in config) so tests can assert the sidebar-relevant state rather
  // than only mock call counts.
  function createConfigMutatingArchiveMock(getConfig: () => Config) {
    return mock(async (workspaceId: string): Promise<Result<{ kind: "archived" }>> => {
      await getConfig().editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((w) => w.id === workspaceId);
          if (workspace) workspace.archivedAt = new Date().toISOString();
        }
        return cfg;
      });
      return Ok({ kind: "archived" });
    });
  }

  test("markWorkflowRunEnded archives interrupted workflow children and blocked reported ancestors", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-run-ended";
    const reportedParentId = "reported-parent-blocked";
    const interruptedChildId = "interrupted-child-no-report";
    const completedChildId = "completed-leaf-child";
    const stickyInterruptedId = "sticky-interrupted-child";
    const stickyCompletedId = "sticky-completed-parent";
    const stickyParentChildId = "sticky-parent-interrupted-child";
    const userInterruptedId = "user-spawned-interrupted";
    const workflowRunId = "wfr_ended_garbage_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Reported workflow-owned task blocked by the structural-leaf topology gate:
        // its interrupted-without-report child keeps hasChildAgentTasks true forever.
        projectWorkspace(projectPath, "reported-parent", reportedParentId, {
          name: "agent_exec_reported_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:02.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        // Interrupted WITHOUT a completed report: canCleanupReportedTask never accepts
        // it, so before the sweep it lingered in the active sidebar forever.
        projectWorkspace(projectPath, "interrupted-child", interruptedChildId, {
          name: "agent_explore_interrupted",
          parentWorkspaceId: reportedParentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
        // Completed-report leaf: must go through the existing remove-based cleanup,
        // not the archive path.
        projectWorkspace(projectPath, "completed-child", completedChildId, {
          name: "agent_explore_completed",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:03.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "completed" },
        }),
        // Legacy taskSticky fields remain readable but are inert in the uniform lifecycle.
        projectWorkspace(projectPath, "sticky-interrupted", stickyInterruptedId, {
          name: "agent_exec_sticky_interrupted",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          taskSticky: true,
          workflowTask: { runId: workflowRunId, stepId: "sticky-interrupted" },
        }),
        projectWorkspace(projectPath, "sticky-completed", stickyCompletedId, {
          name: "agent_exec_sticky_completed",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:04.000Z",
          taskModelString: defaultModel,
          taskSticky: true,
          workflowTask: { runId: workflowRunId, stepId: "sticky-completed" },
        }),
        projectWorkspace(projectPath, "sticky-parent-child", stickyParentChildId, {
          name: "agent_explore_sticky_parent_child",
          parentWorkspaceId: stickyCompletedId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
        // User-spawned interrupted task (no workflowTask in ancestry): intentionally
        // stays visible for manual inspection.
        projectWorkspace(projectPath, "user-interrupted", userInterruptedId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    const archive = createConfigMutatingArchiveMock(() => config);
    const remove = mock(async (workspaceId: string): Promise<Result<void>> => {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const index = project.workspaces.findIndex((w) => w.id === workspaceId);
          if (index !== -1) project.workspaces.splice(index, 1);
        }
        return cfg;
      });
      return Ok(undefined);
    });
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive, remove });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.markWorkflowRunEnded(workflowRunId);

    // Interrupted-without-report workflow child: archived (hidden from the active
    // sidebar) but preserved, still interrupted.
    const interruptedChild = findWorkspaceInConfig(config, interruptedChildId);
    expect(interruptedChild?.archivedAt).toBeString();
    expect(interruptedChild?.taskStatus).toBe("interrupted");

    // Completed-report leaf: removed via the existing cleanup walk, never archived.
    expect(findWorkspaceInConfig(config, completedChildId)).toBeUndefined();

    // Legacy taskSticky markers are inert: workflow-owned leftovers follow normal workflow cleanup.
    const stickyInterrupted = findWorkspaceInConfig(config, stickyInterruptedId);
    expect(stickyInterrupted?.archivedAt).toBeString();
    expect(stickyInterrupted?.taskStatus).toBe("interrupted");
    const stickyCompleted = findWorkspaceInConfig(config, stickyCompletedId);
    expect(stickyCompleted?.archivedAt).toBeString();
    expect(stickyCompleted?.taskStatus).toBe("reported");

    expect(findWorkspaceInConfig(config, stickyParentChildId)?.archivedAt).toBeString();

    // Reported ancestor blocked only by its archived interrupted child: archived too,
    // so the garbage cluster leaves the active sidebar without deleting anything.
    const reportedParent = findWorkspaceInConfig(config, reportedParentId);
    expect(reportedParent?.archivedAt).toBeString();
    expect(reportedParent?.taskStatus).toBe("reported");

    // User-spawned interrupted task keeps current behavior: visible, untouched.
    const userInterrupted = findWorkspaceInConfig(config, userInterruptedId);
    expect(userInterrupted?.archivedAt).toBeUndefined();
    expect(userInterrupted?.taskStatus).toBe("interrupted");
  });

  test("terminateAllDescendantAgentTasks archives run-scoped interrupted children immediately", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-run-interrupt";
    const workflowChildId = "workflow-running-child";
    const userChildId = "user-running-child";
    const workflowRunId = "wfr_interrupt_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "workflow-child", workflowChildId, {
          name: "agent_explore_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
        projectWorkspace(projectPath, "user-child", userChildId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    // Run-scoped interrupt (WorkflowService.interruptRun path): the sweep archives the
    // freshly interrupted workflow child even if the runner's onRunEnded hook already
    // fired before the children were interrupted.
    await taskService.terminateAllDescendantAgentTasks(rootId, { workflowRunId });

    const workflowChild = findWorkspaceInConfig(config, workflowChildId);
    expect(workflowChild?.taskStatus).toBe("interrupted");
    expect(workflowChild?.archivedAt).toBeString();

    // The run-scoped filter leaves the user-spawned sibling running and unarchived.
    const userChild = findWorkspaceInConfig(config, userChildId);
    expect(userChild?.taskStatus).toBe("running");
    expect(userChild?.archivedAt).toBeUndefined();
  });

  test("sweep keeps an ancestor visible when a descendant archive is skipped", async () => {
    // Regression (PR #3694 Codex P2): a child archive skipped by the lossy-untracked-file
    // confirmation (or a failed archive) must block its ancestors' archives too —
    // otherwise the parent gets hidden while its unarchived child stays active in the
    // sidebar as an orphan.
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-skip-blocks-ancestor";
    const parentTaskId = "interrupted-parent-task";
    const childTaskId = "interrupted-child-lossy";
    const workflowRunId = "wfr_skip_blocks_ancestor";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        projectWorkspace(projectPath, "interrupted-parent", parentTaskId, {
          name: "agent_exec_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        projectWorkspace(projectPath, "interrupted-child", childTaskId, {
          name: "agent_exec_child",
          parentWorkspaceId: parentTaskId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );

    // Child archive is deferred pending untracked-file confirmation; parent would archive.
    const archived: string[] = [];
    const archive = mock(
      async (
        workspaceId: string
      ): Promise<Result<{ kind: "archived" } | { kind: "confirm-lossy-untracked-files" }>> => {
        if (workspaceId === childTaskId) {
          return Ok({ kind: "confirm-lossy-untracked-files" });
        }
        await config.editConfig((cfg) => {
          for (const project of cfg.projects.values()) {
            const workspace = project.workspaces.find((w) => w.id === workspaceId);
            if (workspace) workspace.archivedAt = new Date().toISOString();
          }
          return cfg;
        });
        archived.push(workspaceId);
        return Ok({ kind: "archived" });
      }
    );
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.markWorkflowRunEnded(workflowRunId);

    // Child stayed visible (confirmation pending) — so the parent must stay visible too.
    expect(findWorkspaceInConfig(config, childTaskId)?.archivedAt).toBeUndefined();
    expect(findWorkspaceInConfig(config, parentTaskId)?.archivedAt).toBeUndefined();
    expect(archived).not.toContain(parentTaskId);
  });

  test("initialize archives interrupted workflow-owned children of inactive runs but not user-spawned tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-startup-sweep";
    const workflowChildId = "workflow-child-startup";
    const staleInterruptedId = "workflow-child-stale-interrupted";
    const userInterruptedId = "user-interrupted-startup";
    const workflowRunId = "wfr_startup_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Running child of an inactive run: the startup prepass transitions it to
        // "interrupted"; the startup sweep must then archive it.
        projectWorkspace(projectPath, "workflow-child", workflowChildId, {
          name: "agent_explore_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "child" },
        }),
        // Historical garbage: already interrupted (pre-sweep sessions) — must self-heal.
        projectWorkspace(projectPath, "stale-interrupted", staleInterruptedId, {
          name: "agent_explore_stale",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "stale" },
        }),
        projectWorkspace(projectPath, "user-interrupted", userInterruptedId, {
          name: "agent_explore_user",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
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

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    // Prepass interrupted the running child; the startup sweep archived both it and
    // the historical interrupted leftover.
    for (const taskId of [workflowChildId, staleInterruptedId]) {
      const workspace = findWorkspaceInConfig(config, taskId);
      expect(workspace?.taskStatus).toBe("interrupted");
      expect(workspace?.archivedAt).toBeString();
    }

    // User-spawned interrupted task keeps current behavior: visible, untouched.
    const userInterrupted = findWorkspaceInConfig(config, userInterruptedId);
    expect(userInterrupted?.taskStatus).toBe("interrupted");
    expect(userInterrupted?.archivedAt).toBeUndefined();
  });

  test("initialize re-sweeps a run whose interrupted children were archived but reported ancestor was not", async () => {
    // Regression (PR #3694 Codex P2): crash window between sweep phases. If a previous
    // session archived the interrupted child (phase 1) but crashed before archiving the
    // reported ancestor it blocks (phase 2), no unarchived interrupted task remains to
    // seed the startup sweep — so the reported ancestor stayed visible forever. The
    // seeding now also considers unarchived reported workflow-owned tasks.
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-crash-window";
    const reportedParentId = "reported-parent-crash-window";
    const archivedChildId = "archived-interrupted-child";
    const workflowRunId = "wfr_crash_window_sweep";

    await saveWorkspaces(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "root", rootId),
        // Phase-2 leftover: reported, unarchived, blocked by its archived child.
        projectWorkspace(projectPath, "reported-parent", reportedParentId, {
          name: "agent_exec_reported_parent",
          parentWorkspaceId: rootId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "reported",
          reportedAt: "2026-05-29T00:00:02.000Z",
          taskModelString: defaultModel,
          workflowTask: { runId: workflowRunId, stepId: "parent" },
        }),
        // Phase-1 result from the crashed session: interrupted child already archived.
        projectWorkspace(projectPath, "archived-child", archivedChildId, {
          name: "agent_explore_archived",
          parentWorkspaceId: reportedParentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "interrupted",
          taskModelString: defaultModel,
          archivedAt: "2026-05-29T00:00:03.000Z",
        }),
      ],
      testTaskSettings(10, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
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

    const archive = createConfigMutatingArchiveMock(() => config);
    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService } = createWorkspaceServiceMocks({ archive });
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    // The startup sweep re-seeded the run from the unarchived reported ancestor and
    // archived it (blocked only by its archived child), completing the interrupted sweep.
    const reportedParent = findWorkspaceInConfig(config, reportedParentId);
    expect(reportedParent?.archivedAt).toBeString();
    expect(reportedParent?.taskStatus).toBe("reported");
  });

  test("initialize drains queued tasks after interrupting inactive workflow children", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = await createTestProject(rootDir, "repo-queue-after-interrupt");
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const runtime = createRuntime(runtimeConfig, { projectPath });
    const rootName = "root";
    await runtime.createWorkspace({
      projectPath,
      branchName: rootName,
      trunkBranch: "main",
      directoryName: rootName,
      initLogger: createNullInitLogger(),
    });

    const rootId = "root-queue-after-interrupt";
    const runningTaskId = "running-inactive-workflow-occupies-slot";
    const queuedWorkflowTaskId = "queued-inactive-workflow";
    const queuedTaskId = "queued-starts-after-interrupt";
    const workflowRunId = "wfr_queue_after_interrupt";

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: runtime.getWorkspacePath(projectPath, rootName),
          id: rootId,
          name: rootName,
          createdAt: new Date().toISOString(),
          runtimeConfig,
        },
        projectWorkspace(projectPath, "running", runningTaskId, {
          name: "agent_explore_running",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "running",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "running" },
        }),
        projectWorkspace(projectPath, "queued-workflow", queuedWorkflowTaskId, {
          name: "agent_explore_queued_workflow",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "abandoned workflow queued work",
          taskModelString: defaultModel,
          runtimeConfig,
          workflowTask: { runId: workflowRunId, stepId: "queued" },
        }),
        projectWorkspace(projectPath, "queued", queuedTaskId, {
          name: "agent_explore_queued",
          parentWorkspaceId: rootId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "queued",
          taskPrompt: "queued work",
          taskModelString: defaultModel,
          runtimeConfig,
        }),
      ],
      testTaskSettings(1, 3)
    );
    const runStore = new WorkflowRunStore({ sessionDir: path.join(config.sessionsDir, rootId) });
    await runStore.createRun({
      id: workflowRunId,
      workspaceId: rootId,
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

    const { aiService } = createAIServiceMocks(config, { isStreaming: mock(() => false) });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();
    await taskService.maybeStartQueuedTasks();

    expect(findWorkspaceInConfig(config, runningTaskId)?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, queuedWorkflowTaskId)?.taskStatus).toBe("interrupted");
    expect(findWorkspaceInConfig(config, queuedTaskId)?.taskStatus).toBe("running");
    expect(sendMessage).toHaveBeenCalledWith(
      queuedTaskId,
      "queued work",
      expect.objectContaining({ agentId: "explore" }),
      expect.objectContaining({ allowQueuedAgentTask: true })
    );
  });

  test("initialize resumes awaiting_report tasks after restart", async () => {
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

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { aiService, workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its final assistant response"),
      expect.any(Object),
      expect.objectContaining({ synthetic: true })
    );
  });

  test("initialize uses legacy agentType when modern agentId is unavailable for awaiting_report tasks", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-111";
    const childId = "child-custom-plan-222";
    const customAgentId = "custom_plan_runner";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-custom-plan");

    const customAgentDir = path.join(parentWorkspacePath, ".mux", "agents");
    await fsPromises.mkdir(customAgentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(customAgentDir, `${customAgentId}.md`),
      [
        "---",
        "name: Custom Plan Runner",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Custom plan-like agent for restart handling tests.",
        "",
      ].join("\n")
    );

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_custom_plan_child",
          parentWorkspaceId: parentId,
          agentId: "missing-agent",
          agentType: customAgentId,
          taskStatus: "awaiting_report",
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
        agentId: customAgentId,
      }),
      expect.objectContaining({ synthetic: true })
    );
  });

  test("initialize honors child project agent overrides before parent built-in fallback", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo-child-override");
    const parentId = "parent-child-override-111";
    const childId = "child-exec-override-222";
    const runtimeConfig = { type: "worktree" as const, srcBaseDir: config.srcDir };
    const parentWorkspacePath = path.join(projectPath, "parent");
    const childWorkspacePath = path.join(projectPath, "child-exec-override");

    const childAgentDir = path.join(childWorkspacePath, ".mux", "agents");
    await fsPromises.mkdir(childAgentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(childAgentDir, "exec.md"),
      [
        "---",
        "name: Child Exec Override",
        "base: plan",
        "subagent:",
        "  runnable: true",
        "---",
        "Child plan-like Exec override for restart handling tests.",
        "",
      ].join("\n")
    );

    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: parentWorkspacePath,
          id: parentId,
          name: "parent",
          runtimeConfig,
        },
        {
          path: childWorkspacePath,
          id: childId,
          name: "agent_exec_child",
          parentWorkspaceId: parentId,
          agentId: "exec",
          agentType: "exec",
          taskStatus: "awaiting_report",
          runtimeConfig,
        },
      ],
      testTaskSettings(1, 3)
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    await taskService.initialize();

    expect(sendMessage).toHaveBeenCalledWith(
      childId,
      expect.stringContaining("awaiting its propose_plan"),
      expect.objectContaining({
        toolPolicy: [{ regex_match: "^propose_plan$", action: "require" }],
        agentId: "exec",
      }),
      expect.objectContaining({ synthetic: true })
    );
  });
});
