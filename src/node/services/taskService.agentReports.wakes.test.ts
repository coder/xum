import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { HistoryService } from "@/node/services/historyService";
import { readSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { SessionUsageService } from "@/node/services/sessionUsageService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { agentReportProgressDedupePrefix } from "@/constants/agentMessaging";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { recordAgentWorkflowRunReference } from "@/node/services/agentWorkflowRunReferences";
import { Ok, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  saveWorkspacesWithCheckouts,
  streamEnd,
  testTaskSettings,
  workspaceTurnManagerFor,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  flushTerminalAttentionDrains,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  removeWorkspaceFromTestConfig,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  // A nested task owner resumed (prompt-free) for its own child's report runs an automatic
  // task turn, so the resume carries provenance that keeps set_goal refused there.
  test("a nested task owner's prompt-free report wake is a recovery task turn", async () => {
    const config = await createTestConfig(rootDir);

    const projectPath = path.join(rootDir, "repo");
    const rootId = "root-000";
    const parentId = "parent-111";
    const childId = "child-222";

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
      testTaskSettings()
    );

    const { aiService } = createAIServiceMocks(config);
    const { workspaceService, resumeStream } = createWorkspaceServiceMocks();
    const { historyService, partialService, taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
    });

    const appendParentHistory = await historyService.appendToHistory(
      parentId,
      createMuxMessage(
        "assistant-parent-history",
        "assistant",
        "Spawned subagent",
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
      )
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
    expect((await partialService.writePartial(childId, childPartial)).success).toBe(true);

    await streamEnd(taskService, {
      type: "stream-end",
      workspaceId: childId,
      messageId: "assistant-child-partial",
      metadata: { model: "test-model", finishReason: "stop" },
      parts: childPartial.parts as StreamEndEvent["parts"],
    });
    await flushTerminalAttentionDrains(taskService);

    expect(resumeStream).toHaveBeenCalledWith(parentId, expect.any(Object), {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
      taskTurnKind: "recovery",
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

    await saveWorkspacesWithCheckouts(
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
        // The report text is the message and its supersession probe is in memory (#4721).
        skipOnSendCompaction: true,
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

  for (const [name, parentHold, expectedMode] of [
    ["a parent that holds agent messages waits for its turn to end", "turn-end", "turn-end"],
    ["a parent with the default preference is cut at the next step", undefined, "tool-end"],
  ] satisfies Array<[string, "turn-end" | undefined, "turn-end" | "tool-end"]>) {
    test(`agent_report wake: ${name}`, async () => {
      const config = await createTestConfig(rootDir);
      const projectPath = path.join(rootDir, "repo");
      const parentId = "parent-progress-hold";
      const childId = "child-progress-hold";
      await saveWorkspacesWithCheckouts(
        config,
        projectPath,
        [
          projectWorkspace(projectPath, "parent", parentId, {
            ...(parentHold != null ? { agentMessageDispatchMode: parentHold } : {}),
          }),
          projectWorkspace(projectPath, "child", childId, {
            name: "agent_review_child",
            parentWorkspaceId: parentId,
            agentType: "review",
            taskStatus: "running",
          }),
        ],
        testTaskSettings()
      );
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, { workspaceService });

      await taskService.reportAgentProgress(childId, "progress-1", {
        reportMarkdown: "Found a correctness issue.",
      });

      // Only a tool-end queue entry cuts the parent's busy turn; a turn-end entry dispatches
      // when that turn ends.
      expect(sendMessage).toHaveBeenCalledWith(
        parentId,
        expect.stringContaining("Found a correctness issue."),
        expect.objectContaining({ queueDispatchMode: expectedMode }),
        expect.anything()
      );
    });
  }

  test("agent_report wake applies a hold preference enabled during its preflight", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-progress-late-hold";
    const childId = "child-progress-late-hold";
    await saveWorkspacesWithCheckouts(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", parentId),
        projectWorkspace(projectPath, "child", childId, {
          name: "agent_review_child",
          parentWorkspaceId: parentId,
          agentType: "review",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    // The user turns hold on while the wake awaits its workspace-turn lookup.
    spyOn(
      workspaceTurnManagerFor(taskService),
      "getActiveWorkspaceTurnMuxMetadataForWorkspace"
    ).mockImplementation(async () => {
      await config.editConfig((cfg) => {
        const parent = cfg.projects
          .get(projectPath)
          ?.workspaces.find((candidate) => candidate.id === parentId);
        assert(parent, "parent workspace must exist");
        parent.agentMessageDispatchMode = "turn-end";
        return cfg;
      });
      return undefined;
    });

    await taskService.reportAgentProgress(childId, "progress-1", {
      reportMarkdown: "Found a correctness issue.",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      parentId,
      expect.any(String),
      expect.objectContaining({ queueDispatchMode: "turn-end" }),
      expect.anything()
    );
  });

  test("agent_report refuses to wake a parent whose checkout is missing (#4824)", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    await saveWorkspacesWithCheckouts(
      config,
      projectPath,
      [
        projectWorkspace(projectPath, "parent", "parent"),
        projectWorkspace(projectPath, "child", "child", {
          parentWorkspaceId: "parent",
          agentType: "review",
          taskStatus: "running",
        }),
      ],
      testTaskSettings()
    );
    await fsPromises.rm(path.join(projectPath, "parent", ".git"), { recursive: true, force: true });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    let caught: unknown;
    try {
      await taskService.reportAgentProgress("child", "progress-1", { reportMarkdown: "Finding." });
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).toContain("checkout is unavailable");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("agent_report refuses an update whose run ended before the wake was sent", async () => {
    const config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
    const parentId = "parent-late-progress";
    const childId = "child-late-progress";

    await saveWorkspacesWithCheckouts(
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
});
