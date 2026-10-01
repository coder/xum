import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import type { Config } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { Err, Ok, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { Workspace as WorkspaceConfigEntry } from "@/common/types/project";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { SendMessageInternalOptions } from "@/node/services/taskWorkspaceSeam";
import {
  createAIServiceMocks,
  createTestConfig,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  streamEnd,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import {
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

// Sub-agent goals: TaskService alone drives a child's turns, so the child's goal loop (continue,
// silent completion, one budget wrap-up, report) is arbitrated at the task's stream end, before
// the child's final prose (its terminal report) is published to the parent.
describe("TaskService child goals", () => {
  const model = "openai:gpt-4o-mini";
  const parentId = "parent-goal";
  const childId = "child-goal";
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setup(
    overrides: Partial<WorkspaceConfigEntry> = {},
    sendResult: () => Result<void> = () => Ok(undefined)
  ) {
    const config: Config = await createTestConfig(rootDir);
    const projectPath = path.join(rootDir, "repo");
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
          taskModelString: model,
          taskAttemptId: "att_00000000000000c1",
          ...overrides,
        }),
      ],
      testTaskSettings(1, 3)
    );
    // The real session refuses a send whose admission is stale at handoff (e.g. while the ended
    // stream's report decision is still pending); record that probe at each send.
    const staleAtSend: boolean[] = [];
    const sendMessage = mock(
      (
        _workspaceId: string,
        _message: string,
        _options?: SendMessageOptions,
        internal?: SendMessageInternalOptions
      ): Promise<Result<void>> => {
        staleAtSend.push(internal?.admissionStale?.() ?? false);
        return Promise.resolve(sendResult());
      }
    );
    const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
    const { aiService } = createAIServiceMocks(config);
    const historyService = new HistoryService(config);
    const goals = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(rootDir, "child-goals-extensionMetadata.json"))
    );
    goals.registerGoalContinuationConsumer(new IdleDispatcher(), {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation: () => Promise.resolve(true),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
      historyService,
      workspaceGoalService: goals,
    });
    // Production wiring (core.ts): TaskService gates and continues a child goal's user resume.
    goals.setChildGoalResumeHooks({
      isTaskAttemptLive: (id) => taskService.isChildTaskAttemptLive(id),
      onGoalResumed: (id) => taskService.continueResumedChildGoal(id),
    });
    const setChildGoal = async (budgetCents?: number): Promise<GoalRecordV1> => {
      const result = await goals.setGoal({
        workspaceId: childId,
        objective: "Finish the child work",
        ...(budgetCents != null ? { budgetCents } : {}),
      });
      if (!result.success) throw new Error(`setGoal failed: ${result.error.type}`);
      return result.data;
    };
    const toolPart = (toolCallId: string, toolName = "bash") => ({
      type: "dynamic-tool" as const,
      toolCallId,
      toolName,
      input: {},
      state: "output-available" as const,
      output: { success: true },
    });
    // Tool work followed by final prose: the prose is the child's report unless its goal continues.
    const proseEnd = (messageId: string, options: { tools?: boolean } = {}): StreamEndEvent => ({
      type: "stream-end",
      workspaceId: childId,
      messageId,
      metadata: { model, finishReason: "stop" },
      parts: [
        ...(options.tools === false ? [] : [toolPart(`bash-${messageId}`)]),
        { type: "text", text: `Report from ${messageId}.` },
      ],
    });
    // A stream that ended mid-work (a step limit after a tool call): no final prose, no report.
    const workEnd = (messageId: string): StreamEndEvent => ({
      type: "stream-end",
      workspaceId: childId,
      messageId,
      metadata: { model, finishReason: "tool-calls" },
      parts: [toolPart(`bash-${messageId}`)],
    });
    /** Reports delivered to the parent (one synthetic user row each). */
    const parentReports = async () => {
      const history = await historyService.getHistoryFromLatestBoundary(parentId);
      if (!history.success) throw new Error("parent history unreadable");
      return history.data.filter((message) => message.id.startsWith("task-report"));
    };
    const appendGoalContinuationRow = async (goalId: string) => {
      const appended = await historyService.appendToHistory(
        childId,
        createMuxMessage("user-goal-turn", "user", "Continue the goal.", {
          synthetic: true,
          kind: "goal_continuation",
          goalId,
        })
      );
      if (!appended.success) throw new Error("append failed");
    };
    const sends = () =>
      sendMessage.mock.calls.map((call) => ({
        message: call[1],
        options: call[2],
        internal: call[3],
      }));
    return {
      config,
      goals,
      historyService,
      taskService,
      sendMessage,
      setChildGoal,
      toolPart,
      proseEnd,
      workEnd,
      parentReports,
      appendGoalContinuationRow,
      staleAtSend,
      sends,
      child: () => findWorkspaceInConfig(config, childId),
    };
  }

  test("an active goal continues the child after tool work and final prose, without publishing", async () => {
    const t = await setup();
    const goal = await t.setChildGoal();

    const event = t.proseEnd("assistant-1");
    await streamEnd(t.taskService, event);
    // A duplicate delivery of the same stream end must not start a second goal turn.
    await streamEnd(t.taskService, event);

    expect(t.sends()).toHaveLength(1);
    const [send] = t.sends();
    expect(send.options).toMatchObject({ model, queueDispatchMode: "turn-end" });
    expect(send.options?.toolPolicy).toBeUndefined();
    expect(send.internal).toMatchObject({
      synthetic: true,
      goalKind: "goal_continuation",
      goalId: goal.goalId,
      taskTurnKind: "goal_continuation",
    });
    expect(t.staleAtSend).toEqual([false]);
    expect(t.child()?.taskStatus).toBe("running");
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("a stream without final prose continues an active goal (agent_report is progress)", async () => {
    const t = await setup();
    await t.setChildGoal();

    await streamEnd(t.taskService, t.workEnd("assistant-1"));
    await streamEnd(t.taskService, {
      ...t.workEnd("assistant-2"),
      parts: [t.toolPart("report-update", "agent_report")],
    });

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual([
      "goal_continuation",
      "goal_continuation",
    ]);
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
  });

  test("a tool-free goal continuation completes the goal and publishes exactly one report", async () => {
    const t = await setup();
    const goal = await t.setChildGoal();
    await t.appendGoalContinuationRow(goal.goalId);

    const event = t.proseEnd("assistant-1", { tools: false });
    await streamEnd(t.taskService, event);
    await streamEnd(t.taskService, event);

    expect((await t.goals.getGoal(childId))?.status).toBe("complete");
    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("a goal continuation turn with tool work does not complete the goal", async () => {
    const t = await setup();
    const goal = await t.setChildGoal();
    await t.appendGoalContinuationRow(goal.goalId);

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect((await t.goals.getGoal(childId))?.status).toBe("active");
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("complete_goal in the turn publishes exactly one report", async () => {
    const t = await setup();
    await t.setChildGoal();
    // complete_goal committed during the stream: arbitration reads the live goal state.
    const completed = await t.goals.setGoal({
      workspaceId: childId,
      status: "complete",
      completionSummary: "All done.",
      initiator: "model",
    });
    expect(completed.success).toBe(true);

    await streamEnd(t.taskService, {
      ...t.proseEnd("assistant-1"),
      parts: [t.toolPart("complete-1", "complete_goal"), { type: "text", text: "All done." }],
    });

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("budget exhaustion gets exactly one accepted wrap-up turn, whose prose is the report", async () => {
    const t = await setup();
    const goal = await t.setChildGoal(1);
    await t.goals.recordStreamAccounting({
      workspaceId: childId,
      costUsd: 1,
      streamStartedAtMs: goal.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect((await t.goals.getGoal(childId))?.status).toBe("budget_limited");

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_budget_limit"]);
    expect(await t.parentReports()).toHaveLength(0);
    await t.sends()[0].internal?.onAccepted?.();

    await streamEnd(t.taskService, t.proseEnd("assistant-2"));
    expect(t.sends()).toHaveLength(1);
    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
  });

  test("a refused wrap-up does not consume it and asks for the report instead", async () => {
    const t = await setup({}, () => Err("refused"));
    const goal = await t.setChildGoal(1);
    await t.goals.recordStreamAccounting({
      workspaceId: childId,
      costUsd: 1,
      streamStartedAtMs: goal.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual([
      "goal_budget_limit",
      "required_report",
    ]);
    expect((await t.goals.getGoal(childId))?.budgetLimitInjectedForGoalId).toBeNull();
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("without a goal the child's final prose is published unchanged", async () => {
    const t = await setup();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("a user pause during arbitration publishes the report and starts no goal turn", async () => {
    const t = await setup();
    await t.setChildGoal();
    // Hold arbitration on this stream's accounting receipt, pause meanwhile, then release it:
    // arbitration must read the goal only after the session's accounting for the stream settled.
    const waiting = Promise.withResolvers<"waiting">();
    const realWait = t.goals.waitForStreamAccountingReceipt.bind(t.goals);
    spyOn(t.goals, "waitForStreamAccountingReceipt").mockImplementation((...args) => {
      waiting.resolve("waiting");
      return realWait(...args);
    });
    t.goals.beginStreamAccountingReceipt(childId, "assistant-1");
    const handled = streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(await Promise.race([waiting.promise, handled.then(() => "done" as const)])).toBe(
      "waiting"
    );
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    t.goals.settleStreamAccountingReceipt(childId, "assistant-1");
    await handled;

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
  });

  test("a workflow step with an output schema continues its goal instead of reporting", async () => {
    const t = await setup({
      workflowTask: {
        runId: "wfr_child_goal",
        stepId: "explore",
        outputSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
    expect(t.child()?.taskStatus).toBe("running");
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("an owed termination pause fences goal turns: the prose is published", async () => {
    const t = await setup({ taskGoalPauseOwed: "*" });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("reported");
  });

  test("a report owed by a required-report prompt pauses the goal (never completes it)", async () => {
    const t = await setup({ taskStatus: "awaiting_report" });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(t.sends()).toHaveLength(0);
  });

  test("a failed termination pause stays owed", async () => {
    const t = await setup({ taskStatus: "awaiting_report" });
    await t.setChildGoal();
    const realSetGoal = t.goals.setGoal.bind(t.goals);
    spyOn(t.goals, "setGoal").mockImplementation((input) =>
      input.status === "paused"
        ? Promise.resolve(Err({ type: "invalid_transition", message: "disk full" }))
        : realSetGoal(input)
    );

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.child()?.taskStatus).toBe("reported");
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
    expect(t.child()?.taskGoalPauseOwed).toBeDefined();
  });

  test("a user resume continues an idle live child; a terminated child must be reactivated", async () => {
    const t = await setup();
    const goal = await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);

    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(resumed.success).toBe(true);
    expect(t.sends()).toHaveLength(1);
    expect(t.sends()[0].internal).toMatchObject({
      taskTurnKind: "goal_continuation",
      goalId: goal.goalId,
    });

    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    await t.config.editConfig((config) => {
      for (const project of config.projects.values()) {
        for (const workspace of project.workspaces) {
          if (workspace.id === childId) workspace.taskStatus = "reported";
        }
      }
      return config;
    });
    const refused = await t.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(refused.success).toBe(false);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.sends()).toHaveLength(1);
  });
});
