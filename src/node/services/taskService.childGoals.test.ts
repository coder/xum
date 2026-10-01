import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { IdleDispatcher } from "@/node/services/idleDispatcher";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import { Err, Ok, type Result } from "@/common/types/result";
import type { StreamEndEvent } from "@/common/types/stream";
import { createMuxMessage } from "@/common/types/message";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { Workspace as WorkspaceConfigEntry } from "@/common/types/project";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { SendMessageInternalOptions } from "@/node/services/taskWorkspaceSeam";
import {
  createAIServiceMocks,
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
  let cleanups: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    cleanups = [];
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setup(
    overrides: Partial<WorkspaceConfigEntry> = {},
    sendResult: () => Result<void> = () => Ok(undefined)
  ) {
    // Real HistoryService (AGENTS.md); TaskService and the goal service share its Config.
    const { historyService, config, cleanup } = await createTestHistoryService();
    cleanups.push(cleanup);
    await fsPromises.mkdir(config.srcDir, { recursive: true });
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
    const goals = new WorkspaceGoalService(
      config,
      historyService,
      new ExtensionMetadataService(path.join(rootDir, "child-goals-extensionMetadata.json"))
    );
    // The generic idle dispatcher: it must never drive a child (TaskService owns child turns).
    const idleDispatcher = new IdleDispatcher();
    const requestDispatch = spyOn(idleDispatcher, "requestDispatch");
    const executeGoalContinuation = mock(() => Promise.resolve(true));
    goals.registerGoalContinuationConsumer(idleDispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation,
      // As in production (WorkspaceService): a kickoff model is available, so arming would proceed.
      getKickoffSendOptions: () => Promise.resolve({ model, agentId: "exec" }),
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
    /** Record the parent's workflow run `runId` in `status` (the child's owning run). */
    const recordWorkflowRun = async (runId: string, status: "running" | "completed") => {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(config.sessionsDir, parentId),
      });
      await runStore.createRun({
        id: runId,
        workspaceId: parentId,
        workflow: { name: "explore", description: "Explore", scope: "built-in", executable: true },
        source: "export default function workflow() { return {}; }\n",
        args: {},
        now: "2026-10-01T00:00:00.000Z",
      });
      await runStore.appendStatus(runId, status, "2026-10-01T00:00:01.000Z");
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
      recordWorkflowRun,
      requestDispatch,
      executeGoalContinuation,
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
    await t.recordWorkflowRun("wfr_child_goal", "running");
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
    expect(t.child()?.taskStatus).toBe("running");
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("a workflow step whose run is no longer active reports instead of pursuing its goal", async () => {
    const t = await setup({ workflowTask: { runId: "wfr_child_goal_done", stepId: "explore" } });
    await t.recordWorkflowRun("wfr_child_goal_done", "completed");
    await t.setChildGoal();

    // The active goal starts no continuation: the step's final prose is its (workflow) report.
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("reported");
  });

  test("a budget-limited workflow step whose run ended gets no wrap-up", async () => {
    const t = await setup({ workflowTask: { runId: "wfr_child_budget_done", stepId: "explore" } });
    await t.recordWorkflowRun("wfr_child_budget_done", "completed");
    const goal = await t.setChildGoal(1);
    await t.goals.recordStreamAccounting({
      workspaceId: childId,
      costUsd: 1,
      streamStartedAtMs: goal.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect((await t.goals.getGoal(childId))?.status).toBe("budget_limited");

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("reported");
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

  test("a child goal never arms the generic idle dispatcher; TaskService drives its only turn", async () => {
    const t = await setup();
    // A user-created goal, then a model replacement (both arm a kickoff for top-level workspaces).
    await t.setChildGoal();
    const replaced = await t.goals.setGoal({
      workspaceId: childId,
      objective: "Model goal",
      initiator: "model",
      forceNewGoal: true,
    });
    expect(replaced.success).toBe(true);
    await t.goals.requestContinuationAfterStreamEnd({
      workspaceId: childId,
      sendOptions: { model, agentId: "exec" },
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.requestDispatch.mock.calls.filter((call) => call[0] === childId)).toHaveLength(0);
    expect(t.executeGoalContinuation).not.toHaveBeenCalled();
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
  });

  test("restart recovery arms nothing for a child goal, even while a pause is owed", async () => {
    const t = await setup({ taskGoalPauseOwed: "*" });
    const goal = await t.setChildGoal(1);
    t.requestDispatch.mockClear();
    await t.goals.recoverPendingDispatchAfterRestart(childId);
    // A budget-limited child goal owes its wrap-up to TaskService, not the generic dispatcher.
    await t.goals.recordStreamAccounting({
      workspaceId: childId,
      costUsd: 1,
      streamStartedAtMs: goal.createdAtMs + 1,
      streamOriginKind: "goal_continuation",
    });
    expect((await t.goals.getGoal(childId))?.status).toBe("budget_limited");
    await t.goals.recoverPendingDispatchAfterRestart(childId);

    expect(t.requestDispatch.mock.calls.filter((call) => call[0] === childId)).toHaveLength(0);
    expect(t.executeGoalContinuation).not.toHaveBeenCalled();
    expect(t.sends()).toHaveLength(0);
  });

  test("a user resume racing the report's terminal write is still paused", async () => {
    const t = await setup();
    await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    // The resume commits right after the report path read the (paused) goal and before its
    // terminal write. Its continuation hook waits on the stream-end lock, so it is not awaited.
    const internal = t.taskService as unknown as {
      readChildGoalToPause(id: string): Promise<string | undefined>;
    };
    const realRead = internal.readChildGoalToPause.bind(t.taskService);
    let resume: Promise<unknown> | undefined;
    spyOn(internal, "readChildGoalToPause").mockImplementationOnce(async (id) => {
      const read = await realRead(id);
      resume = t.goals.setGoal({ workspaceId: childId, status: "active" });
      while ((await t.goals.getGoal(childId))?.status !== "active") {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return read;
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    await resume;

    expect(t.child()?.taskStatus).toBe("reported");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(t.sends()).toHaveLength(0);
  });

  test("a resume whose continuation is refused stays paused and is refused", async () => {
    let refuse = true;
    const t = await setup({}, () => (refuse ? Err("queue closed") : Ok(undefined)));
    await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);

    const refused = await t.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(refused.success).toBe(false);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");

    refuse = false;
    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(resumed.success).toBe(true);
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual([
      "goal_continuation",
      "goal_continuation",
    ]);
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
