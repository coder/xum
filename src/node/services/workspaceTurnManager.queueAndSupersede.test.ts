import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import type { HistoryService } from "@/node/services/historyService";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import {
  TaskHandleStore,
  type WorkspaceTurnTaskHandleRecord,
} from "@/node/services/taskHandleStore";
import {
  createWorkspaceTurnManagerHarness,
  finalizeWorkspaceTurnStreamEndForTest,
  startWorkspaceTurnForTest,
} from "@/node/services/workspaceTurnManager.testHarness";
import { Ok, type Result } from "@/common/types/result";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import type { SendMessageError } from "@/common/types/errors";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  makeWorkspaceTurnCreateMock,
  findWorkspaceInConfig,
  projectWorkspace,
  saveLocalParentWorkspace,
  stubStableIds,
  workspaceTurnMuxMetadata,
  workspaceTurnRecord,
  workspaceTurnSnapshot,
} from "@/node/services/taskService.testHarness";

describe("WorkspaceTurnManager", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-"));
  });

  afterEach(async () => {
    await fsPromises.rm(rootDir, { recursive: true, force: true });
  });

  async function appendUncorrelatedWakeHistory(params: {
    historyService: HistoryService;
    parentId: string;
    taskId: string;
    workspaceId: string;
    inputSynthetic: boolean;
  }): Promise<StreamEndEvent> {
    const prompt = createMuxMessage("turn-prompt", "user", "Summarize the repo", {
      muxMetadata: workspaceTurnMuxMetadata(params.parentId, params.taskId),
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, prompt)).success).toBe(
      true
    );
    const input = createMuxMessage("wake-input", "user", "Continue after a wake", {
      synthetic: params.inputSynthetic,
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, input)).success).toBe(
      true
    );
    const output = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await params.historyService.appendToHistory(params.workspaceId, output)).success).toBe(
      true
    );
    return {
      type: "stream-end",
      workspaceId: params.workspaceId,
      messageId: output.id,
      metadata: {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
      },
      parts: [{ type: "text", text: "Wake result" }],
    };
  }

  test.each(["isolated", "shared", "busy"] as const)(
    "internal workspace-turn reported child continuation (%s desktop)",
    async (desktop) => {
      const config = await createTestConfig(rootDir);
      stubStableIds(config, ["followuphandle", "followupturn"]);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
      const childWorkspaceId = "reported-child-workspace";
      await config.editConfig((cfg) => {
        const project = cfg.projects.get(projectPath);
        assert(project, "test project must exist");
        project.workspaces.push({
          path: path.join(projectPath, "reported-child"),
          id: childWorkspaceId,
          name: "agent_explore_reported_child",
          parentWorkspaceId: parentId,
          agentType: "explore",
          taskStatus: "reported",
          taskDesktopOwnerWorkspaceId: desktop === "isolated" ? undefined : parentId,
          reportedAt: "2026-06-19T00:00:00.000Z",
          aiSettingsByAgent: {
            explore: { model: "anthropic:claude-sonnet-4-6", thinkingLevel: "medium" },
          },
          taskModelString: "openai:gpt-5.2",
          taskThinkingLevel: "high",
          runtimeConfig: { type: "local" },
        });
        if (desktop === "busy") {
          project.workspaces.push(
            projectWorkspace(projectPath, "competitor", "competitor", {
              parentWorkspaceId: parentId,
              agentId: "explore",
              taskStatus: "running",
              taskDesktopOwnerWorkspaceId: parentId,
              runtimeConfig: { type: "local" },
            })
          );
        }
        return cfg;
      });

      const sendMessage = mock(async (...args: unknown[]): Promise<Result<void>> => {
        const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
        await internal?.onAccepted?.();
        return Ok(undefined);
      });
      const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
      const { taskService } = createWorkspaceTurnManagerHarness(config, { workspaceService });

      const result = await taskService.createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        prompt: "Investigate the follow-up root cause",
        title: "Continue reported child",
        allowAgentWorkspace: true,
        workspace: { mode: "existing", workspaceId: childWorkspaceId },
      });

      if (desktop === "busy") {
        expect(result.success).toBe(false);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskExecutionId).toBeUndefined();
        expect(await new TaskHandleStore(config).listAllWorkspaceTurns()).toHaveLength(0);
        return;
      }
      expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskDesktopOwnerWorkspaceId).toBe(
        desktop === "isolated" ? undefined : parentId
      );
      expect(findWorkspaceInConfig(config, childWorkspaceId)?.taskExecutionStatus).toBe("running");
      expect(result).toEqual(
        Ok({
          taskId: "wst_followuphandle",
          kind: "workspace_turn",
          status: "running",
          workspaceId: childWorkspaceId,
        })
      );
      expect(sendMessage).toHaveBeenCalledWith(
        childWorkspaceId,
        "Investigate the follow-up root cause",
        expect.objectContaining({
          model: "anthropic:claude-sonnet-4-6",
          agentId: "explore",
          thinkingLevel: "medium",
        }),
        expect.objectContaining({ requireIdle: true })
      );
    }
  );

  test("late direct-parent snapshot consumption suppresses duplicate continuation delivery", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-late-direct-parent-await";
    const handleId = "wst_late_direct_parent_await";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Late Await Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const terminalRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "late-direct-parent-await",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      reportMarkdown: "Already returned by task_await.",
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(terminalRecord);

    const consumed = await taskService.getWorkspaceTurnSnapshot(parentId, handleId, {
      consumingWorkspaceId: parentId,
    });
    expect(consumed?.directParentResultDeliveredAt).toBeDefined();

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(terminalRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    expect(JSON.stringify(parentHistory)).not.toContain("Already returned by task_await.");
  });

  test("queue-cut supersede settlement is delivered to the persistent child's direct parent", async () => {
    // The old error settlement appended a terminal failure to the direct
    // parent; the interrupted supersede settlement must not silently vanish.
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-superseded-delivery";
    const handleId = "wst_superseded_delivery";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Superseded Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const supersededRecord: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "superseded-delivery",
      status: "interrupted",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(supersededRecord);

    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(supersededRecord, new Set());

    const parentHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(parentHistory.success).toBe(true);
    const serialized = JSON.stringify(parentHistory);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("superseded by new input in the target workspace");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, handleId))?.directParentResultDeliveredAt
    ).toBeDefined();

    // Explicit cancellations (no supersede reason) must stay silent.
    const { error: _supersedeReason, ...canceledBase } = supersededRecord;
    const canceledRecord: WorkspaceTurnTaskHandleRecord = {
      ...canceledBase,
      handleId: "wst_canceled_delivery",
      turnId: "canceled-delivery",
    };
    await taskHandleStore.upsertWorkspaceTurn(canceledRecord);
    await (
      taskService as unknown as {
        deliverPersistentChildWorkspaceTurnResult: (
          record: WorkspaceTurnTaskHandleRecord,
          waiterWorkspaceIds: ReadonlySet<string>
        ) => Promise<void>;
      }
    ).deliverPersistentChildWorkspaceTurnResult(canceledRecord, new Set());
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_canceled_delivery"))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();
  });

  test("terminal recovery dedupes a matching ordinary legacy workspace-turn notification", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_legacy_ordinary_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "legacy-ordinary-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Already delivered ordinary result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "completed",
      createdAt: "2026-08-11T00:00:01.500Z",
    });
    assert(legacy, "legacy ordinary attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    expect(
      await (
        taskService as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("terminal recovery versions corrected workspace-turn attention past a legacy tombstone", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_corrected_attention_recovery",
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      turnId: "corrected-attention-recovery",
      status: "completed",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:02.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal",
      reportMarkdown: "Corrected recovered result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(record);
    const terminalAttentionStore = new TerminalAttentionStore(config);
    const legacy = await terminalAttentionStore.enqueueIfAbsent({
      ownerWorkspaceId: parentId,
      sourceKind: "workspace_turn",
      sourceId: record.handleId,
      terminalOutcome: "error",
    });
    assert(legacy, "legacy workspace-turn attention must exist");
    await terminalAttentionStore.markDelivered(parentId, legacy.id);

    const recovered = await (
      taskService as unknown as {
        recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
      }
    ).recoverTerminalWorkspaceTurnAttentionNotifications();
    expect(recovered).toBe(1);

    const versionedId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      record.handleId,
      `${record.handleId}:${record.status}:${record.updatedAt}`
    );
    expect(await terminalAttentionStore.get(parentId, versionedId)).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, record.handleId))
        ?.terminalAttentionNotifiedAt
    ).toBeDefined();
  });

  test("createWorkspaceTurn queues busy owner-created existing workspaces", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock(
      (..._args: unknown[]): Promise<Result<void, SendMessageError>> =>
        Promise.resolve(Ok(undefined))
    );
    const busyWorkspaceIds = new Set<string>();
    const isStreaming = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const isBusyForMessage = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const hasQueuedMessages = mock((workspaceId: string) => busyWorkspaceIds.has(workspaceId));
    const workspaceMocks = createWorkspaceServiceMocks({
      create: createWorkspace,
      sendMessage,
      hasQueuedWorkspaceTurn: mock(
        (workspaceId: string, handleId: string) =>
          workspaceId === "childworkspace" && handleId === "wst_secondhandle"
      ),
      isBusyForMessage,
      hasQueuedMessages,
    });
    const aiMocks = createAIServiceMocks(config, { isStreaming });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);
    busyWorkspaceIds.add("childworkspace");

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });

    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data).toMatchObject({
      taskId: "wst_secondhandle",
      workspaceId: "childworkspace",
      kind: "workspace_turn",
      status: "queued",
    });
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const secondSend = sendMessage.mock.calls[1];
    expect(secondSend[0]).toBe("childworkspace");
    expect(secondSend[1]).toBe("Queued prompt");
    expect(secondSend[2]).toMatchObject({
      queueDispatchMode: "turn-end",
      muxMetadata: workspaceTurnMuxMetadata(parentId, "wst_secondhandle", "secondturn"),
    });
    expect(secondSend[3]).toMatchObject({
      startStreamInBackground: true,
      requireIdle: false,
      agentInitiated: true,
    });
    expect(secondSend[3]).toHaveProperty("onAccepted");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId, "wst_secondhandle");
    expect(snapshot).toMatchObject({
      createdWorkspace: false,
      workspaceId: "childworkspace",
      status: "queued",
    });

    const internal = taskService as unknown as { countActiveWorkspaceTurns: () => Promise<number> };
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);

    const interrupted = await taskService.interruptWorkspaceTurn(parentId, "wst_secondhandle");
    expect(interrupted.success).toBe(true);
    expect(workspaceMocks.removeQueuedWorkspaceTurn).toHaveBeenCalledWith(
      "childworkspace",
      "wst_secondhandle",
      { cancelReason: "Workspace turn interrupted" }
    );
    const sendInternal = secondSend[3] as { onAccepted: () => Promise<void> };
    let acceptedAfterInterruptError: unknown;
    try {
      await sendInternal.onAccepted();
    } catch (error) {
      acceptedAfterInterruptError = error;
    }
    if (!(acceptedAfterInterruptError instanceof Error)) {
      throw new Error("Expected onAccepted to reject after interrupt");
    }
    expect(acceptedAfterInterruptError.message).toMatch(/canceled before stream start/);
    expect(aiMocks.stopStream).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn reserves a slot before queueing a manually busy existing workspace", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["queuedhandle", "queuedturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        {
          path: path.join(projectPath, "childworkspace"),
          id: "childworkspace",
          name: "childworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        },
        {
          path: path.join(projectPath, "otherworkspace"),
          id: "otherworkspace",
          name: "otherworkspace",
          createdAt: "2026-06-19T00:00:00.000Z",
          runtimeConfig: { type: "local" },
        }
      );
      return cfg;
    });

    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({
      sendMessage,
      isBusyForMessage: mock((workspaceId: string) => workspaceId === "childworkspace"),
    });
    const aiMocks = createAIServiceMocks(config, {
      isStreaming: mock((workspaceId: string) => workspaceId === "otherworkspace"),
    });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService: workspaceMocks.workspaceService,
    });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const createdAt = "2026-06-19T00:00:00.000Z";
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_owned", "completed", {
        turnId: "ownedturn",
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
      })
    );
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "otherworkspace", "wst_other", "running", {
        turnId: "otherturn",
        createdAt,
        updatedAt: createdAt,
        createdWorkspace: true,
      })
    );

    const result = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Queued prompt",
      title: "Follow-up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("maxParallelAgentTasks exceeded");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("createWorkspaceTurn counts active workspace turns across all owners", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["firsthandle", "firstturn", "secondhandle", "secondturn"]);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const otherParentId = "other-parent";
    await config.editConfig((cfg) => {
      cfg.taskSettings = { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 1 };
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push({
        path: path.join(projectPath, otherParentId),
        id: otherParentId,
        name: otherParentId,
        createdAt: "2026-06-19T00:00:00.000Z",
        runtimeConfig: { type: "local" },
      });
      return cfg;
    });

    const createWorkspace = makeWorkspaceTurnCreateMock(config, projectPath);
    const sendMessage = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const workspaceMocks = createWorkspaceServiceMocks({ create: createWorkspace, sendMessage });
    const { taskService } = createWorkspaceTurnManagerHarness(config, {
      workspaceService: workspaceMocks.workspaceService,
    });

    const first = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "First prompt",
      title: "Workspace turn",
      workspace: { mode: "new" },
    });
    expect(first.success).toBe(true);

    const second = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: otherParentId,
      prompt: "Second prompt",
      title: "Other workspace turn",
      workspace: { mode: "new" },
    });
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.error).toContain("maxParallelAgentTasks exceeded");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("active workspace turn count excludes foreground-waiting workspace turns", async () => {
    const { taskService, taskHost } = await startWorkspaceTurnForTest(rootDir);
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    const stopForegroundAwait = taskHost.startForegroundAwait("childworkspace");
    try {
      expect(await internal.countActiveWorkspaceTurns()).toBe(0);
    } finally {
      stopForegroundAwait();
    }
  });

  test("parallel quota counts a reawakened child only through its continuation handle", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const reawakenedTaskId = "reawakened-quota-child";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "ordinary-child", "ordinary-quota-child", {
          parentWorkspaceId: parentId,
          taskStatus: "running",
        }),
        projectWorkspace(projectPath, "reawakened-child", reawakenedTaskId, {
          parentWorkspaceId: parentId,
          taskStatus: "reported",
          taskExecutionId: "wst_reawakened_quota",
          taskExecutionStatus: "running",
        })
      );
      return cfg;
    });
    const isStreaming = mock((workspaceId: string) => workspaceId === reawakenedTaskId);
    const { aiService } = createAIServiceMocks(config, { isStreaming });
    const { taskService, taskHost } = createWorkspaceTurnManagerHarness(config, { aiService });
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    await taskHandleStore.upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, reawakenedTaskId, "wst_reawakened_quota", "running", {
        turnId: "turn-reawakened-quota",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:01.000Z",
      })
    );
    const internal = taskService as unknown as {
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    const activeAgentCount = taskHost.countActiveAgentTasks(config.loadConfigOrDefault());
    const activeWorkspaceTurnCount = await internal.countActiveWorkspaceTurns();

    expect(activeAgentCount).toBe(1);
    expect(activeWorkspaceTurnCount).toBe(1);
    expect(activeAgentCount + activeWorkspaceTurnCount).toBe(2);
  });

  test("active workspace turn count settles stale persisted handles", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(0);

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("active workspace turn count keeps startup-retrying handles live", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      hasPendingQueuedOrPreparingTurn,
    });
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
      countActiveWorkspaceTurns: () => Promise<number>;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(await internal.countActiveWorkspaceTurns()).toBe(1);
    expect(hasPendingQueuedOrPreparingTurn).toHaveBeenCalledWith("childworkspace");

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: "childworkspace" });
    expect(snapshot?.error).toBeUndefined();
  });

  test("getWorkspaceTurnSnapshot settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: "Workspace turn interrupted after restart",
      workspaceId: "childworkspace",
    });
  });

  test("uncorrelated stream-end before queued workspace turn prompt does not interrupt it", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const oldAssistant = createMuxMessage("old-assistant", "assistant", "Previous turn", {
      model: "anthropic:claude-opus-4-6",
      finishReason: "stop",
    });
    const queuedPrompt = createMuxMessage("queued-prompt", "user", "Queued follow-up", {
      muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
    });
    expect((await historyService.appendToHistory(created.workspaceId, oldAssistant)).success).toBe(
      true
    );
    expect((await historyService.appendToHistory(created.workspaceId, queuedPrompt)).success).toBe(
      true
    );

    const internal = taskService as unknown as {
      interruptWorkspaceTurnFromUncorrelatedStreamEnd: (event: StreamEndEvent) => Promise<boolean>;
    };
    const handled = await internal.interruptWorkspaceTurnFromUncorrelatedStreamEnd({
      type: "stream-end",
      workspaceId: created.workspaceId,
      messageId: "old-assistant",
      metadata: {
        model: "anthropic:claude-opus-4-6",
        finishReason: "stop",
      },
      parts: [],
    });

    expect(handled).toBe(true);
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({ status: "running", workspaceId: created.workspaceId });
  });

  test("uncorrelated synthetic wake end leaves the active handle running", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const event = await appendUncorrelatedWakeHistory({
      historyService,
      parentId,
      taskId: created.taskId,
      workspaceId: created.workspaceId,
      inputSynthetic: true,
    });

    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "running",
    });

    const correlatedFinal: StreamEndEvent = {
      ...event,
      messageId: "real-final",
      metadata: {
        ...event.metadata,
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      },
      parts: [{ type: "text", text: "Real final result" }],
    };
    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, correlatedFinal)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "completed",
      messageId: "real-final",
      reportMarkdown: "Real final result",
    });
  });

  test("compaction-preserved turn anchor ignores an uncorrelated synthetic wake end", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const compactionSummary = createMuxMessage("compaction-summary", "user", "Compacted context", {
      muxMetadata: {
        type: "compaction-summary",
        pendingFollowUp: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          text: "Continue the delegated work",
          workspaceTurnMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
        },
      },
    });
    expect(
      (await historyService.appendToHistory(created.workspaceId, compactionSummary)).success
    ).toBe(true);
    const wakeInput = createMuxMessage("wake-input", "user", "Continue after a wake", {
      synthetic: true,
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeInput)).success).toBe(
      true
    );
    const wakeOutput = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeOutput)).success).toBe(
      true
    );

    expect(
      await finalizeWorkspaceTurnStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: created.workspaceId,
        messageId: wakeOutput.id,
        metadata: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          finishReason: "stop",
        },
        parts: [{ type: "text", text: "Wake result" }],
      })
    ).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "running",
    });
  });

  test("manual user input still supersedes an active workspace turn on uncorrelated end", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const event = await appendUncorrelatedWakeHistory({
      historyService,
      parentId,
      taskId: created.taskId,
      workspaceId: created.workspaceId,
      inputSynthetic: false,
    });

    expect(await finalizeWorkspaceTurnStreamEndForTest(taskService, event)).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "interrupted",
      messageId: "wake-output",
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
  });

  test("malformed user-triggered auto-compaction still supersedes an active workspace turn", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const prompt = createMuxMessage("turn-prompt", "user", "Summarize the repo", {
      muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
    });
    expect((await historyService.appendToHistory(created.workspaceId, prompt)).success).toBe(true);
    const compactionRequest = createMuxMessage(
      "auto-compaction",
      "user",
      "Compacting before a new user prompt",
      {
        synthetic: true,
        muxMetadata: {
          type: "compaction-request",
          rawCommand: "/compact",
          parsed: null,
          source: "auto-compaction",
        } as unknown as MuxMessageMetadata,
      }
    );
    expect(
      (await historyService.appendToHistory(created.workspaceId, compactionRequest)).success
    ).toBe(true);
    const wakeOutput = createMuxMessage("wake-output", "assistant", "Wake result", {
      model: "anthropic:claude-opus-4-6",
      agentId: "exec",
      finishReason: "stop",
    });
    expect((await historyService.appendToHistory(created.workspaceId, wakeOutput)).success).toBe(
      true
    );

    expect(
      await finalizeWorkspaceTurnStreamEndForTest(taskService, {
        type: "stream-end",
        workspaceId: created.workspaceId,
        messageId: wakeOutput.id,
        metadata: {
          model: "anthropic:claude-opus-4-6",
          agentId: "exec",
          finishReason: "stop",
        },
        parts: [{ type: "text", text: "Wake result" }],
      })
    ).toBe(true);
    expect(await workspaceTurnSnapshot(taskService, parentId, created.taskId)).toMatchObject({
      status: "interrupted",
      messageId: wakeOutput.id,
      error: "Workspace turn superseded by an uncorrelated workspace stream-end",
    });
  });

  test("getWorkspaceTurnSnapshot recovers stale completed handles from matching history", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_completed", "assistant", "Recovered final text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "stop",
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "completed",
      workspaceId: created.workspaceId,
      messageId: "msg_completed",
      reportMarkdown: "Recovered final text",
      finalMessageRef: { messageId: "msg_completed", finishReason: "stop", textCharCount: 20 },
    });
  });

  test("getWorkspaceTurnSnapshot recovers stale truncated handles from matching history as errors", async () => {
    const { parentId, taskService, historyService, created } =
      await startWorkspaceTurnForTest(rootDir);
    const appendResult = await historyService.appendToHistory(
      created.workspaceId,
      createMuxMessage("msg_truncated_history", "assistant", "Partial text", {
        model: "anthropic:claude-opus-4-6",
        agentId: "exec",
        finishReason: "length",
        muxMetadata: workspaceTurnMuxMetadata(parentId, created.taskId),
      })
    );
    expect(appendResult.success).toBe(true);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    const snapshot = await workspaceTurnSnapshot(taskService, parentId, created.taskId);
    expect(snapshot).toMatchObject({
      status: "error",
      workspaceId: created.workspaceId,
      messageId: "msg_truncated_history",
      error: "Workspace turn ended before completion (finishReason: length)",
    });
    expect(snapshot?.reportMarkdown).toBeUndefined();
  });

  test("listWorkspaceTurnTasks settles stale active handles before returning", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const internal = taskService as unknown as {
      activeWorkspaceTurnHandleByWorkspaceId: Map<
        string,
        { handleId: string; ownerWorkspaceId: string }
      >;
    };

    internal.activeWorkspaceTurnHandleByWorkspaceId.clear();
    expect(
      await taskService.listWorkspaceTurnTasks(parentId, {
        statuses: ["running"],
      })
    ).toEqual([]);

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({ status: "interrupted", workspaceId: "childworkspace" });
  });

  test("terminal notify policy updates preserve the terminal outcome version", async () => {
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir);
    const terminal: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_handle",
      ownerWorkspaceId: parentId,
      workspaceId: "childworkspace",
      turnId: "turn",
      status: "completed",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:01.000Z",
      createdWorkspace: true,
      disposableWorkspace: false,
      reportMarkdown: "Terminal result",
    };
    const taskHandleStore = new TaskHandleStore(config);
    await taskHandleStore.upsertWorkspaceTurn(terminal);

    await taskService.markWorkspaceTurnBackgroundWorkNotifyOnTerminal(terminal.handleId, parentId);

    const updated = await taskHandleStore.getWorkspaceTurn(parentId, terminal.handleId);
    expect(updated).toMatchObject({
      status: "completed",
      updatedAt: terminal.updatedAt,
      attentionPolicy: "notify_on_terminal",
    });
    const attentionId = TerminalAttentionStore.notificationId(
      "workspace_turn",
      terminal.handleId,
      `${terminal.handleId}:${terminal.status}:${terminal.updatedAt}`
    );
    expect(await new TerminalAttentionStore(config).get(parentId, attentionId)).not.toBeNull();
  });

  const OWNER_FOLLOW_UP_SUPERSEDE_PREFIX = "Workspace turn superseded by follow-up turn ";

  test("startup recovery does not resurrect a quiet owner-follow-up supersede wake", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = new TaskHandleStore(config);
    const base = {
      kind: "workspace_turn" as const,
      ownerWorkspaceId: parentId,
      workspaceId: parentId,
      status: "interrupted" as const,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      attentionPolicy: "notify_on_terminal" as const,
    };
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_quiet_recovery",
      turnId: "quiet-recovery",
      error: `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`,
    });
    await taskHandleStore.upsertWorkspaceTurn({
      ...base,
      handleId: "wst_generic_recovery",
      turnId: "generic-recovery",
      error:
        "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
    });

    expect(
      await (
        taskService as unknown as {
          recoverTerminalWorkspaceTurnAttentionNotifications: () => Promise<number>;
        }
      ).recoverTerminalWorkspaceTurnAttentionNotifications()
    ).toBe(1);

    const attentionStore = new TerminalAttentionStore(config);
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_quiet_recovery",
          "wst_quiet_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).toBeNull();
    expect(
      await attentionStore.get(
        parentId,
        TerminalAttentionStore.notificationId(
          "workspace_turn",
          "wst_generic_recovery",
          "wst_generic_recovery:interrupted:2026-08-11T00:00:01.000Z"
        )
      )
    ).not.toBeNull();
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, "wst_quiet_recovery"))
        ?.terminalAttentionNotifiedAt
    ).toBeUndefined();
  });

  test("owner-follow-up supersede skips the direct-parent envelope only when the parent initiated it", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const childTaskId = "child-quiet-supersede";
    await config.editConfig((cfg) => {
      const project = cfg.projects.get(projectPath);
      assert(project, "test project must exist");
      project.workspaces.push(
        projectWorkspace(projectPath, "child", childTaskId, {
          parentWorkspaceId: parentId,
          agentId: "explore",
          agentType: "explore",
          taskStatus: "reported",
          title: "Quiet Reviewer",
        })
      );
      return cfg;
    });
    const { historyService, taskService } = createWorkspaceTurnManagerHarness(config);
    const taskHandleStore = (taskService as unknown as { taskHandleStore: TaskHandleStore })
      .taskHandleStore;
    const quietError = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const ownerInitiated: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId: "wst_quiet_owner_parent",
      // The direct parent IS the owner that initiated the successor.
      ownerWorkspaceId: parentId,
      workspaceId: childTaskId,
      turnId: "quiet-owner-parent",
      status: "interrupted",
      error: quietError,
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:01.000Z",
      createdWorkspace: false,
      disposableWorkspace: false,
      directParentResultDeliveryRequiredAt: "2026-08-11T00:00:01.000Z",
    };
    await taskHandleStore.upsertWorkspaceTurn(ownerInitiated);
    const internal = taskService as unknown as {
      deliverPersistentChildWorkspaceTurnResult: (
        record: WorkspaceTurnTaskHandleRecord,
        waiterWorkspaceIds: ReadonlySet<string>
      ) => Promise<void>;
      workspaceTurnRequiresDirectParentDelivery: (record: WorkspaceTurnTaskHandleRecord) => boolean;
    };

    await internal.deliverPersistentChildWorkspaceTurnResult(ownerInitiated, new Set());
    const ownerHistory = await historyService.getHistoryFromLatestBoundary(parentId);
    expect(ownerHistory.success).toBe(true);
    expect(JSON.stringify(ownerHistory)).not.toContain("workspace_turn_superseded");
    expect(
      (await taskHandleStore.getWorkspaceTurn(parentId, ownerInitiated.handleId))
        ?.directParentResultDeliveredAt
    ).toBeUndefined();

    // A different owner's follow-up cut is NOT the direct parent's doing: the
    // envelope still gets delivered with the supersede error type.
    const ancestorInitiated: WorkspaceTurnTaskHandleRecord = {
      ...ownerInitiated,
      handleId: "wst_quiet_ancestor",
      ownerWorkspaceId: "ancestorownerws",
      turnId: "quiet-ancestor",
    };
    await taskHandleStore.upsertWorkspaceTurn(ancestorInitiated);
    await internal.deliverPersistentChildWorkspaceTurnResult(ancestorInitiated, new Set());
    const delivered = await historyService.getHistoryFromLatestBoundary(parentId);
    const serialized = JSON.stringify(delivered);
    expect(serialized).toContain("workspace_turn_superseded");
    expect(serialized).toContain("wst_successor");

    // Settle-path predicate agrees, so no delivery-required marker is ever set
    // for the owner-initiated flavor.
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ownerInitiated)).toBe(false);
    expect(internal.workspaceTurnRequiresDirectParentDelivery(ancestorInitiated)).toBe(true);
  });

  test("snapshot history repair preserves the owner-follow-up supersede flavor", async () => {
    // Same race as the generic supersede repair test: a snapshot read from the
    // SAME correlated final must keep the quiet flavor instead of downgrading
    // it to the generic reason or a truncation error.
    const { config, parentId, taskService, historyService } =
      await startWorkspaceTurnForTest(rootDir);
    const quietReason = `${OWNER_FOLLOW_UP_SUPERSEDE_PREFIX}wst_successor from the same owner workspace`;
    const muxMetadata = {
      type: "workspace-turn-task" as const,
      taskHandleId: "wst_handle",
      ownerWorkspaceId: parentId,
      turnId: "turn",
    };
    expect(
      (
        await historyService.appendToHistory(
          "childworkspace",
          createMuxMessage("msg_owner_cut", "assistant", "Cut mid-work", {
            model: "anthropic:claude-opus-4-6",
            agentId: "exec",
            finishReason: "tool-calls",
            muxMetadata,
          })
        )
      ).success
    ).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord(parentId, "childworkspace", "wst_handle", "interrupted", {
        error: quietReason,
        createdWorkspace: true,
        messageId: "msg_owner_cut",
      })
    );

    const snapshot = await workspaceTurnSnapshot(taskService, parentId);
    expect(snapshot).toMatchObject({
      status: "interrupted",
      error: quietReason,
      messageId: "msg_owner_cut",
    });
  });

  test("mode=existing tool-end follow-up reports the same-owner turn it may supersede", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("queued");
    expect(followUp.data.maySupersedeTaskId).toBe("wst_handle");

    // turn-end dispatch never cuts the active turn, so no announcement.
    const turnEnd = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up later",
      title: "Follow up later",
      workspace: {
        mode: "existing",
        workspaceId: "childworkspace",
        queueDispatchMode: "turn-end",
      },
    });
    expect(turnEnd.success).toBe(true);
    if (!turnEnd.success) throw new Error(turnEnd.error);
    expect(turnEnd.data.maySupersedeTaskId).toBeUndefined();
  });

  test("mode=existing follow-up to an idle target reports no supersession", async () => {
    const { parentId, taskService } = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["handle", "turn", "handle2", "turn2"],
    });

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.status).toBe("running");
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });

  test("mode=existing announcement names the immediate queued predecessor", async () => {
    // Codex P2: with A active and same-owner tool-end follow-ups B and C
    // queued, C supersedes B (not A) at B's first boundary — and B's own
    // settlement wake is suppressed, so C's announcement is the only place
    // B's interruption can surface.
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(rootDir, {
      stableIds: ["handle", "turn", "handle2", "turn2", "handle3", "turn3"],
      hasPendingQueuedOrPreparingTurn,
    });
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUpB = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up B",
      title: "Follow up B",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpB.success).toBe(true);
    if (!followUpB.success) throw new Error(followUpB.error);
    expect(followUpB.data.maySupersedeTaskId).toBe("wst_handle");

    // createdAt is per-process monotonic (nextWorkspaceTurnCreatedAt), so the
    // newest-first predecessor scan is deterministic even when the original
    // turn and follow-up B are created within the same millisecond.
    const followUpC = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up C",
      title: "Follow up C",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUpC.success).toBe(true);
    if (!followUpC.success) throw new Error(followUpC.error);
    expect(followUpC.data.maySupersedeTaskId).toBe(followUpB.data.taskId);
  });

  test("settlement preserves a disposable ownership transfer that raced its snapshot", async () => {
    // Codex P2: a settlement built from a record read BEFORE
    // transferDisposableWorkspaceToSuccessor flipped disposableWorkspace on
    // disk must not persist the stale false bit — the record reloaded inside
    // the settlement lock is authoritative, so the successor still cleans up
    // the transferred checkout instead of leaking it.
    const remove = mock((): Promise<Result<void>> => Promise.resolve(Ok(undefined)));
    const { config, parentId, taskService } = await startWorkspaceTurnForTest(rootDir, { remove });
    const taskHandleStore = new TaskHandleStore(config);
    const running = await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle");
    assert(running, "running handle must exist");
    const staleSnapshot = { ...running };
    expect(staleSnapshot.disposableWorkspace).toBe(false);
    // Transfer lands after the snapshot was taken.
    await taskHandleStore.upsertWorkspaceTurn({ ...running, disposableWorkspace: true });
    const internal = taskService as unknown as {
      settleWorkspaceTurn: (params: {
        record: WorkspaceTurnTaskHandleRecord;
        next: WorkspaceTurnTaskHandleRecord;
        cause: { kind: "user-stream-abort" };
        waiterSettlement: { status: "error"; error: Error };
      }) => Promise<void>;
    };

    await internal.settleWorkspaceTurn({
      cause: { kind: "user-stream-abort" },
      record: staleSnapshot,
      next: {
        ...staleSnapshot,
        status: "interrupted",
        updatedAt: new Date().toISOString(),
        error: "Workspace turn interrupted",
      },
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });

    expect(await taskHandleStore.getWorkspaceTurn(parentId, "wst_handle")).toMatchObject({
      status: "interrupted",
      disposableWorkspace: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("mode=existing follow-up over a different owner's active turn reports no supersession", async () => {
    const hasPendingQueuedOrPreparingTurn = mock(
      (workspaceId: string) => workspaceId === "childworkspace"
    );
    const { config, parentId, taskService, workspaceMocks } = await startWorkspaceTurnForTest(
      rootDir,
      {
        stableIds: ["handle", "turn", "handle2", "turn2"],
        hasPendingQueuedOrPreparingTurn,
      }
    );
    const interrupted = await taskService.interruptWorkspaceTurn(parentId, "wst_handle");
    expect(interrupted.success).toBe(true);
    await new TaskHandleStore(config).upsertWorkspaceTurn(
      workspaceTurnRecord("ancestorownerws", "childworkspace", "wst_other_owner_turn", "running", {
        turnId: "other-owner-turn",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      })
    );
    workspaceMocks.isBusyForMessage.mockImplementation(
      (workspaceId: string) => workspaceId === "childworkspace"
    );

    const followUp = await taskService.createWorkspaceTurn({
      ownerWorkspaceId: parentId,
      prompt: "Follow up",
      title: "Follow up",
      workspace: { mode: "existing", workspaceId: "childworkspace" },
    });
    expect(followUp.success).toBe(true);
    if (!followUp.success) throw new Error(followUp.error);
    expect(followUp.data.maySupersedeTaskId).toBeUndefined();
  });
});
