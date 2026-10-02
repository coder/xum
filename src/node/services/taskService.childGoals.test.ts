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
import type { ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/common/types/project";
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
    sendResult: () => Result<void> = () => Ok(undefined),
    hostOverrides: Parameters<typeof createWorkspaceServiceMocks>[0] = {}
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
    const { workspaceService } = createWorkspaceServiceMocks({ ...hostOverrides, sendMessage });
    const { aiService } = createAIServiceMocks(config);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(rootDir, "child-goals-extensionMetadata.json")
    );
    const goals = new WorkspaceGoalService(config, historyService, extensionMetadata);
    // The workspace-selected model (what the generic kickoff path would bill).
    let workspaceModel = model;
    // The generic idle dispatcher: it must never drive a child (TaskService owns child turns).
    const idleDispatcher = new IdleDispatcher();
    const requestDispatch = spyOn(idleDispatcher, "requestDispatch");
    const executeGoalContinuation = mock(() => Promise.resolve(true));
    goals.registerGoalContinuationConsumer(idleDispatcher, {
      hasActiveDescendantTasks: () => false,
      getRuntimeState: () => ({ isRuntimeCompatible: true }),
      executeGoalContinuation,
      // As in production (WorkspaceService): a kickoff model is available, so arming would proceed.
      getKickoffSendOptions: () => Promise.resolve({ model: workspaceModel, agentId: "exec" }),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService,
      workspaceService,
      historyService,
      workspaceGoalService: goals,
    });
    // Production wiring (core.ts): TaskService gates and continues a child goal's user resume.
    goals.setChildGoalResumeHooks({
      getResumeRefusal: (id) => taskService.getChildGoalResumeRefusal(id),
      captureActivationAttempt: (id) => taskService.captureChildGoalActivationAttempt(id),
      isActivationAllowed: (id, attemptId) =>
        taskService.isChildGoalActivationAllowed(id, attemptId),
      getTurnModel: (id) => taskService.getChildGoalTurnModel(id),
      onGoalResumed: (id) => taskService.continueResumedChildGoal(id),
    });
    /** Mutate the child's task row (e.g. a termination or report obligation after its goal). */
    const editChild = (mutate: (workspace: WorkspaceConfigEntry) => void) =>
      config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          for (const workspace of project.workspaces) {
            if (workspace.id === childId) mutate(workspace);
          }
        }
        return cfg;
      });
    const setChildGoal = async (budgetCents?: number): Promise<GoalRecordV1> => {
      const result = await goals.setGoal({
        workspaceId: childId,
        objective: "Finish the child work",
        // Child goals are created by the child's own model (set_goal); users cannot create them.
        initiator: "model",
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
    const untilSends = async (count: number) => {
      for (let i = 0; i < 500 && sendMessage.mock.calls.length < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    };
    const untilStatus = async (status: string) => {
      for (
        let i = 0;
        i < 500 && findWorkspaceInConfig(config, childId)?.taskStatus !== status;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
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
      extensionMetadata,
      setWorkspaceModel: (next: string) => {
        workspaceModel = next;
      },
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
      editChild,
      untilSends,
      untilStatus,
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

  // #5402: an unavailable pinned agent pauses the goal; the prose is published as the report.
  test("an unavailable pinned agent pauses the goal and sends no goal turn", async () => {
    const refuse = mock(() =>
      Promise.resolve<string | null>("Selected agent 'explore' is unavailable: it is disabled")
    );
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(refuse).toHaveBeenCalledWith(
      childId,
      expect.objectContaining({ agentId: "explore" }),
      expect.any(Function)
    );
    expect(t.sends()).toEqual([]);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(await t.parentReports()).toHaveLength(1);
  });

  // #5402: if that pause fails to persist, the child still never runs an active goal unattended:
  // the report publishes and the reported transition owes and settles the pause.
  test("a failed unavailable-agent pause is settled by the reported transition", async () => {
    const refuse = mock(() => Promise.resolve<string | null>("Selected agent 'explore' is gone"));
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    await t.setChildGoal();
    const setGoal = spyOn(t.goals, "setGoal").mockRejectedValueOnce(new Error("EIO"));

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(setGoal).toHaveBeenCalledTimes(2);
    expect(t.sends()).toEqual([]);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(await t.parentReports()).toHaveLength(1);
  });

  // #5452 item 1: the agent check awaits; a refusal that went stale meanwhile must neither show
  // its chat error (the probe) nor pause the goal a newer attempt now runs.
  test("a refusal whose attempt was replaced during the check leaves the goal alone", async () => {
    let currentAtCheck: boolean | undefined;
    let editChild: ((mutate: (workspace: WorkspaceConfigEntry) => void) => Promise<void>) | null =
      null;
    const refuse = mock(
      async (_id: string, _options: unknown, isCurrent?: () => boolean | Promise<boolean>) => {
        await editChild?.((workspace) => {
          workspace.taskAttemptId = "att_00000000000000c2";
        });
        currentAtCheck = await isCurrent?.();
        return "Selected agent 'explore' is unavailable: it is disabled";
      }
    );
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    editChild = t.editChild;
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(refuse).toHaveBeenCalledTimes(1);
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
    expect(currentAtCheck).toBe(false);
    expect(t.sends()).toEqual([]);
  });

  test("a refusal whose goal was paused and resumed during the check shows no chat error", async () => {
    let currentAtCheck: boolean | undefined;
    let resumedAtCheck = false;
    let goals: WorkspaceGoalService | null = null;
    const resumes: Array<Promise<unknown>> = [];
    const refuse = mock(
      async (_id: string, _options: unknown, isCurrent?: () => boolean | Promise<boolean>) => {
        if (goals == null || resumes.length > 0) return null;
        await goals.setGoal({ workspaceId: childId, status: "paused" });
        // The resume's own continuation waits for this stream end's event lock.
        resumes.push(goals.setGoal({ workspaceId: childId, status: "active" }));
        for (
          let i = 0;
          i < 500 && (await goals.readGoalSerialized(childId))?.status !== "active";
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        resumedAtCheck = (await goals.readGoalSerialized(childId))?.status === "active";
        currentAtCheck = await isCurrent?.();
        return "Selected agent 'explore' is unavailable: it is disabled";
      }
    );
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    goals = t.goals;
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    await Promise.all(resumes);

    // The race really happened: the goal was active again (resumed) when the probe ran.
    expect(resumedAtCheck).toBe(true);
    expect(currentAtCheck).toBe(false);
  });

  // #5452: the pause itself is fenced under the goal file lock, so an attempt replaced after the
  // last check but before the pause write does not get its goal paused by the stale refusal.
  test("an attempt replaced just before the refusal's pause write keeps its goal", async () => {
    const refuse = mock(() =>
      Promise.resolve<string | null>("Selected agent 'explore' is unavailable: it is disabled")
    );
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    await t.setChildGoal();
    const realPause = t.goals.pauseForUnavailableAgent.bind(t.goals);
    const pause = spyOn(t.goals, "pauseForUnavailableAgent").mockImplementationOnce(
      async (...args) => {
        await t.editChild((workspace) => {
          workspace.taskAttemptId = "att_00000000000000c2";
        });
        return realPause(...args);
      }
    );

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(pause).toHaveBeenCalledTimes(1);
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
  });

  // An unreadable goal during the staleness probe keeps the fail-closed path: the goal pauses
  // and the report publishes (the stream end is never left unhandled).
  test("a failed goal read in the staleness probe still pauses and reports", async () => {
    let currentAtCheck: boolean | undefined;
    let replacedAtCheck: boolean | undefined;
    let editChild: ((mutate: (workspace: WorkspaceConfigEntry) => void) => Promise<void>) | null =
      null;
    let readGoal: (() => void) | null = null;
    const refuse = mock(
      async (_id: string, _options: unknown, isCurrent?: () => boolean | Promise<boolean>) => {
        currentAtCheck = await isCurrent?.();
        // The same failed read after the attempt was replaced: the attempt fence still holds.
        readGoal?.();
        await editChild?.((workspace) => {
          workspace.taskAttemptId = "att_00000000000000c2";
        });
        replacedAtCheck = await isCurrent?.();
        await editChild?.((workspace) => {
          workspace.taskAttemptId = "att_00000000000000c1";
        });
        return "Selected agent 'explore' is unavailable: it is disabled";
      }
    );
    const t = await setup({}, undefined, { refuseUnavailableGoalTurnAgent: refuse });
    await t.setChildGoal();
    editChild = t.editChild;
    const read = spyOn(t.goals, "readGoalSerialized").mockRejectedValueOnce(new Error("EIO"));
    readGoal = () => {
      read.mockRejectedValueOnce(new Error("EIO"));
    };

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(currentAtCheck).toBe(true);
    expect(replacedAtCheck).toBe(false);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(await t.parentReports()).toHaveLength(1);
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
    const t = await setup();
    await t.setChildGoal();
    await t.editChild((workspace) => {
      workspace.taskGoalPauseOwed = "*";
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("reported");
  });

  test("a report owed by a required-report prompt pauses the goal (never completes it)", async () => {
    const t = await setup();
    await t.setChildGoal();
    await t.editChild((workspace) => {
      workspace.taskStatus = "awaiting_report";
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(t.sends()).toHaveLength(0);
  });

  test("a failed termination pause stays owed", async () => {
    const t = await setup();
    await t.setChildGoal();
    await t.editChild((workspace) => {
      workspace.taskStatus = "awaiting_report";
    });
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
    const t = await setup();
    const goal = await t.setChildGoal(1);
    await t.editChild((workspace) => {
      workspace.taskGoalPauseOwed = "*";
    });
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

  test("a termination between a resume's admission and its write refuses it; active is never written", async () => {
    const t = await setup();
    await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    const internal = t.goals as unknown as {
      setGoalInternal(input: unknown, entry: unknown): Promise<unknown>;
      writeGoal(workspaceId: string, goal: GoalRecordV1): Promise<void>;
    };
    const writes: string[] = [];
    const realWrite = internal.writeGoal.bind(t.goals);
    spyOn(internal, "writeGoal").mockImplementation((workspaceId, goal) => {
      if (workspaceId === childId) writes.push(goal.status);
      return realWrite(workspaceId, goal);
    });
    // Admitted (the resume gate passed, the attempt was captured); the report lands before the
    // durable write.
    const realInternal = internal.setGoalInternal.bind(t.goals);
    spyOn(internal, "setGoalInternal").mockImplementationOnce(async (input, entry) => {
      await streamEnd(t.taskService, t.proseEnd("assistant-1"));
      return realInternal(input, entry);
    });

    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });

    expect(resumed.success).toBe(false);
    expect(writes).not.toContain("active");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskStatus).toBe("reported");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("a termination after a resume's write pauses the goal and refuses the resume", async () => {
    const t = await setup();
    await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    // The parent is interrupted after the resume persisted active, before its continuation runs.
    const realContinue = t.taskService.continueResumedChildGoal.bind(t.taskService);
    spyOn(t.taskService, "continueResumedChildGoal").mockImplementationOnce(async (id) => {
      await t.taskService.terminateAllDescendantAgentTasks(parentId);
      return realContinue(id);
    });

    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });

    expect(resumed.success).toBe(false);
    expect(t.child()?.taskStatus).toBe("interrupted");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(t.sends()).toHaveLength(0);
  });

  test("a parent interruption pauses the child's goal; a failed pause stays owed until recovery", async () => {
    const t = await setup();
    await t.setChildGoal();
    const realSetGoal = t.goals.setGoal.bind(t.goals);
    let failPause = true;
    spyOn(t.goals, "setGoal").mockImplementation((input) =>
      failPause && input.status === "paused" && input.initiator === "auto"
        ? Promise.resolve(Err({ type: "invalid_transition", message: "disk full" }))
        : realSetGoal(input)
    );

    await t.taskService.terminateAllDescendantAgentTasks(parentId);

    expect(t.child()?.taskStatus).toBe("interrupted");
    expect((await t.goals.getGoal(childId))?.status).toBe("active");
    expect(t.child()?.taskGoalPauseOwed).toBeDefined();

    // Recovery: reactivating the task settles the owed pause before the task runs again.
    failPause = false;
    await t.taskService.reawakenInterruptedTask(childId);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    expect(t.sends().filter((send) => send.internal?.taskTurnKind === "goal_continuation")).toEqual(
      []
    );
  });

  // settleChildGoalPause is non-throwing for its callers (startup recovery loops, stop paths): a
  // failed marker write after a durable pause is logged and the marker stays for a later retry.
  test("a failed owed-marker cleanup does not throw; the marker stays owed", async () => {
    const t = await setup();
    await t.setChildGoal();
    const realEdit = t.taskService.editWorkspaceEntry.bind(t.taskService);
    let failMarkerClear = true;
    spyOn(t.taskService, "editWorkspaceEntry").mockImplementation(
      (workspaceId, updater, options) => {
        // Fail only the marker-clearing write: it deletes a currently owed marker.
        const owed = t.child()?.taskGoalPauseOwed;
        if (failMarkerClear && workspaceId === childId && owed != null) {
          const probe: Pick<WorkspaceConfigEntry, "taskGoalPauseOwed"> = {
            taskGoalPauseOwed: owed,
          };
          updater(probe as WorkspaceConfigEntry, {} as ProjectsConfig);
          if (probe.taskGoalPauseOwed == null) {
            return Promise.reject(new Error("config lock unavailable"));
          }
        }
        return realEdit(workspaceId, updater, options);
      }
    );

    await t.taskService.terminateAllDescendantAgentTasks(parentId);

    expect(t.child()?.taskStatus).toBe("interrupted");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeDefined();
    failMarkerClear = false;
  });

  test("a workflow run interruption pauses its step's goal", async () => {
    const t = await setup({ workflowTask: { runId: "wfr_child_interrupt", stepId: "explore" } });
    await t.recordWorkflowRun("wfr_child_interrupt", "running");
    await t.setChildGoal();

    await t.taskService.terminateAllDescendantAgentTasks(parentId, {
      workflowRunId: "wfr_child_interrupt",
    });

    expect(t.child()?.taskStatus).toBe("interrupted");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
  });

  test("a step whose workflow run ended is interrupted with its goal paused", async () => {
    const t = await setup({ workflowTask: { runId: "wfr_child_owner_gone", stepId: "explore" } });
    await t.recordWorkflowRun("wfr_child_owner_gone", "completed");
    await t.setChildGoal();

    await streamEnd(t.taskService, t.workEnd("assistant-1"));

    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("interrupted");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
  });

  /** A goal creation accepted mid-stream (pending until the stream-end drain). */
  async function queueChildGoalCreation(t: Awaited<ReturnType<typeof setup>>) {
    await t.extensionMetadata.setStreaming(childId, true);
    const queued = await t.goals.setGoal({
      workspaceId: childId,
      objective: "Queued child goal",
      initiator: "model",
    });
    expect(queued.success).toBe(true);
    expect(await t.goals.getGoal(childId)).toBeNull();
    await t.extensionMetadata.setStreaming(childId, false);
  }

  test("a pending goal creation drained in its own running attempt becomes active", async () => {
    const t = await setup();
    await queueChildGoalCreation(t);

    await t.goals.applyPendingAfterStreamEnd(childId);

    expect(await t.goals.getGoal(childId)).toMatchObject({
      objective: "Queued child goal",
      status: "active",
    });
  });

  test("a pending goal creation draining after its attempt closed lands paused", async () => {
    const t = await setup();
    await queueChildGoalCreation(t);
    await t.taskService.terminateAllDescendantAgentTasks(parentId);
    expect(t.child()?.taskStatus).toBe("interrupted");

    await t.goals.applyPendingAfterStreamEnd(childId);

    expect(await t.goals.getGoal(childId)).toMatchObject({
      objective: "Queued child goal",
      status: "paused",
    });
  });

  test("an old attempt's pending creation draining after reactivation lands paused", async () => {
    const t = await setup();
    await queueChildGoalCreation(t);
    // A newer attempt of the task is running when the old attempt's drain finally runs.
    await t.editChild((workspace) => {
      workspace.taskAttemptId = "att_00000000000000c2";
      workspace.taskStatus = "running";
    });

    await t.goals.applyPendingAfterStreamEnd(childId);

    expect(await t.goals.getGoal(childId)).toMatchObject({
      objective: "Queued child goal",
      status: "paused",
    });
    expect(t.sends()).toHaveLength(0);
  });

  test("child budget pricing uses the task-pinned model, not the workspace selection", async () => {
    // Task model priced, workspace selection unpriced: budget edits and resumes are allowed.
    const priced = await setup();
    priced.setWorkspaceModel("custom:unpriced-model");
    await priced.setChildGoal();
    const edited = await priced.goals.setGoal({ workspaceId: childId, budgetCents: 500 });
    expect(edited.success).toBe(true);
    expect((await priced.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(
      true
    );
    expect((await priced.goals.setGoal({ workspaceId: childId, status: "active" })).success).toBe(
      true
    );
    expect((await priced.goals.getGoal(childId))?.budgetCents).toBe(500);
  });

  test("an unpriced task model refuses child budget edits and resumes despite a priced workspace", async () => {
    // The task is pinned to an unpriced model; the workspace selection stays priced.
    const pinUnpriced = (workspace: WorkspaceConfigEntry) => {
      workspace.taskModelString = "custom:unpriced-model";
    };
    const editing = await setup();
    await editing.setChildGoal();
    await editing.editChild(pinUnpriced);
    const edited = await editing.goals.setGoal({ workspaceId: childId, budgetCents: 900 });
    expect(edited.success).toBe(false);
    expect((await editing.goals.getGoal(childId))?.budgetCents).toBeNull();

    const resuming = await setup();
    await resuming.setChildGoal(5);
    expect((await resuming.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(
      true
    );
    await resuming.editChild(pinUnpriced);
    const resumed = await resuming.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(resumed.success).toBe(false);
    expect((await resuming.goals.getGoal(childId))?.status).toBe("paused");
    expect(resuming.sends()).toHaveLength(0);
  });

  test("the user cannot create or replace a child's goal, but can still edit, pause and clear it", async () => {
    const t = await setup();
    const created = await t.goals.setGoal({ workspaceId: childId, objective: "User goal" });
    expect(!created.success && created.error.type === "invalid_transition").toBe(true);
    expect(await t.goals.getGoal(childId)).toBeNull();

    const goal = await t.setChildGoal();
    const replaced = await t.goals.setGoal({ workspaceId: childId, objective: "Other goal" });
    expect(!replaced.success && replaced.error.type === "invalid_transition").toBe(true);
    const forced = await t.goals.setGoal({
      workspaceId: childId,
      objective: goal.objective,
      forceNewGoal: true,
    });
    expect(forced.success).toBe(false);
    expect((await t.goals.getGoal(childId))?.goalId).toBe(goal.goalId);

    // Edits of the child's own goal stay available.
    expect(
      (await t.goals.setGoal({ workspaceId: childId, objective: goal.objective, budgetCents: 400 }))
        .success
    ).toBe(true);
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    expect(await t.goals.getGoal(childId)).toMatchObject({
      goalId: goal.goalId,
      budgetCents: 400,
      status: "paused",
    });
    await t.goals.clearGoal(childId);
    expect(await t.goals.getGoal(childId)).toBeNull();
    expect(t.sends()).toHaveLength(0);
  });

  test("a queued goal turn cancelled after the user paused the goal asks for the report", async () => {
    const t = await setup();
    await t.setChildGoal();
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
    expect(await t.parentReports()).toHaveLength(0);

    // The turn waits in the queue; the user pauses the goal, and its admission probe cancels it.
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    await t.sends()[0].internal?.onCanceled?.("admission stale");
    await t.untilSends(2);

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual([
      "goal_continuation",
      "required_report",
    ]);
    expect(t.child()?.taskStatus).toBe("awaiting_report");
  });

  test("a queued goal turn cancelled by the attempt's own termination asks for nothing", async () => {
    const t = await setup();
    await t.setChildGoal();
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(t.sends()).toHaveLength(1);

    await t.taskService.terminateAllDescendantAgentTasks(parentId);
    await t.sends()[0].internal?.onCanceled?.("task interrupted");
    // Drain the recovery's lock turn: it must find the attempt closed and send nothing.
    await streamEnd(t.taskService, t.workEnd("assistant-2"));

    expect(t.sends()).toHaveLength(1);
    expect(t.child()?.taskStatus).toBe("interrupted");
  });

  test("a child pinned to a plan-like agent never gets a goal turn: it is asked for its plan", async () => {
    const t = await setup({ agentType: "plan", agentId: "plan" });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["required_report"]);
    expect(t.child()?.taskStatus).toBe("awaiting_report");
  });

  test("a child pinned to a custom plan-like agent never gets a goal turn", async () => {
    const t = await setup({ agentType: "planner", agentId: "planner" });
    const agentDir = path.join(rootDir, "repo", "child", ".xum", "agents");
    await fsPromises.mkdir(agentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentDir, "planner.md"),
      "---\nname: Planner\nbase: plan\nsubagent:\n  runnable: true\n---\nPlan-derived test agent.\n"
    );
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));

    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["required_report"]);
  });

  test("a child pinned to compact never gets a goal turn: its final prose is the report", async () => {
    const t = await setup({ agentType: "compact", agentId: "compact" });
    await t.setChildGoal();

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    for (let i = 0; i < 500 && (await t.parentReports()).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(t.sends()).toHaveLength(0);
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.child()?.taskStatus).toBe("reported");
  });

  test("a removed child's goal arbitration history is dropped", async () => {
    const t = await setup();
    await t.setChildGoal();
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    const internal = t.taskService as unknown as {
      childGoalArbitratedStreams: Map<string, string[]>;
    };
    expect(internal.childGoalArbitratedStreams.get(childId)).toEqual(["assistant-1"]);

    t.taskService.noteWorkspaceRemoved(childId);

    expect(internal.childGoalArbitratedStreams.has(childId)).toBe(false);
  });

  // #5411: the goal service's stream-accounting receipts are dropped with the workspace too; an
  // open receipt is released (never left hanging) rather than counted as settled.
  test("a removed workspace's stream-accounting receipts are dropped", async () => {
    const t = await setup();
    t.goals.beginStreamAccountingReceipt(childId, "assistant-open");
    t.goals.beginStreamAccountingReceipt(childId, "assistant-released");
    t.goals.releaseUnaccountedStreamAccountingReceipt(childId, "assistant-released");
    const open = t.goals.streamAccountingReceiptOutcome(childId, "assistant-open");
    const internal = t.goals as unknown as {
      streamAccountingReceipts: Map<string, unknown>;
      evictedStreamAccountingReceipts: Map<string, unknown>;
    };
    expect(internal.evictedStreamAccountingReceipts.has(childId)).toBe(true);

    t.taskService.noteWorkspaceRemoved(childId);

    expect(await open).toBe("evicted");
    expect(internal.streamAccountingReceipts.has(childId)).toBe(false);
    expect(internal.evictedStreamAccountingReceipts.has(childId)).toBe(false);
  });

  // #5411: a pause owed by a closing write outside TaskService (an archive or unarchive of a
  // shared-desktop child) is settled by the integration hooks, not left owed.
  test.each(["settleOwedChildGoalPause", "noteWorkspaceUnarchived"] as const)(
    "%s settles an owed child goal pause",
    async (hook) => {
      const t = await setup();
      await t.setChildGoal();
      await t.editChild((workspace) => {
        workspace.taskStatus = "interrupted";
        workspace.taskGoalPauseOwed = "att_00000000000000c1";
      });

      await t.taskService[hook](childId);

      expect((await t.goals.getGoal(childId))?.status).toBe("paused");
      expect(t.child()?.taskGoalPauseOwed).toBeUndefined();
    }
  );

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

  test("a resume while the required report is owed is refused and the goal stays paused", async () => {
    const t = await setup();
    await t.setChildGoal();
    await t.editChild((workspace) => {
      workspace.taskStatus = "awaiting_report";
    });
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);

    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });

    expect(!resumed.success && resumed.error.type === "invalid_transition").toBe(true);
    expect(resumed.success ? null : JSON.stringify(resumed.error)).toContain("required report");
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.sends()).toHaveLength(0);
  });

  test("unsettled accounting defers the stream end without finalizing; its settlement resumes it", async () => {
    const t = await setup();
    await t.setChildGoal();
    // The session opened this stream's accounting receipt and settles it only later.
    const realWait = t.goals.waitForStreamAccountingReceipt.bind(t.goals);
    spyOn(t.goals, "waitForStreamAccountingReceipt").mockImplementation((workspaceId, messageId) =>
      realWait(workspaceId, messageId, 20)
    );
    t.goals.beginStreamAccountingReceipt(childId, "assistant-1");

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    // Deferred: no report published, no prompt or goal turn, and the event lock is released.
    expect(t.sends()).toHaveLength(0);
    expect(t.child()?.taskStatus).toBe("running");
    expect(await t.parentReports()).toHaveLength(0);

    t.goals.settleStreamAccountingReceipt(childId, "assistant-1");
    await t.untilSends(1);
    expect(t.sends().map((send) => send.internal?.taskTurnKind)).toEqual(["goal_continuation"]);
    expect(t.staleAtSend).toEqual([false]);
    expect(await t.parentReports()).toHaveLength(0);
  });

  test("a deferred stream end whose goal settled paused publishes its report exactly once", async () => {
    const t = await setup();
    await t.setChildGoal();
    const realWait = t.goals.waitForStreamAccountingReceipt.bind(t.goals);
    spyOn(t.goals, "waitForStreamAccountingReceipt").mockImplementation((workspaceId, messageId) =>
      realWait(workspaceId, messageId, 20)
    );
    t.goals.beginStreamAccountingReceipt(childId, "assistant-1");
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(await t.parentReports()).toHaveLength(0);

    // The accounting outcome lands: the user paused the goal meanwhile.
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    t.goals.settleStreamAccountingReceipt(childId, "assistant-1");
    for (let i = 0; i < 500 && (await t.parentReports()).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await t.untilStatus("reported");
    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("an evicted accounting receipt never counts as settled: the deferred stream end reports", async () => {
    const t = await setup();
    await t.setChildGoal();
    const realWait = t.goals.waitForStreamAccountingReceipt.bind(t.goals);
    spyOn(t.goals, "waitForStreamAccountingReceipt").mockImplementation((workspaceId, messageId) =>
      realWait(workspaceId, messageId, 20)
    );
    t.goals.beginStreamAccountingReceipt(childId, "assistant-1");
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(await t.parentReports()).toHaveLength(0);

    // Newer streams' receipts push the deferred one out without its accounting ever running.
    for (let i = 2; i <= 10; i++) t.goals.beginStreamAccountingReceipt(childId, `assistant-${i}`);
    for (let i = 0; i < 500 && (await t.parentReports()).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await t.untilStatus("reported");

    expect(t.child()?.taskStatus).toBe("reported");
    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
  });

  test("a receipt released unaccounted reports instead of a goal turn; a settled one stays settled", async () => {
    const t = await setup();
    await t.setChildGoal();
    const realWait = t.goals.waitForStreamAccountingReceipt.bind(t.goals);
    spyOn(t.goals, "waitForStreamAccountingReceipt").mockImplementation((workspaceId, messageId) =>
      realWait(workspaceId, messageId, 20)
    );
    // Releasing an already-settled receipt never downgrades it.
    t.goals.beginStreamAccountingReceipt(childId, "assistant-0");
    t.goals.settleStreamAccountingReceipt(childId, "assistant-0");
    t.goals.releaseUnaccountedStreamAccountingReceipt(childId, "assistant-0");
    expect(await t.goals.streamAccountingReceiptOutcome(childId, "assistant-0")).toBe("settled");

    t.goals.beginStreamAccountingReceipt(childId, "assistant-1");
    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    expect(await t.parentReports()).toHaveLength(0);
    // The session's completion handling failed before its accounting finished.
    t.goals.releaseUnaccountedStreamAccountingReceipt(childId, "assistant-1");
    for (let i = 0; i < 500 && (await t.parentReports()).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await t.untilStatus("reported");

    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("a refused child-turn admission falls back to the report instead of idling", async () => {
    const t = await setup();
    await t.setChildGoal();
    // The strict admission check fails transiently (e.g. an unreadable registry): no goal turn
    // can be queued, so the stream end must not be treated as handled.
    spyOn(t.taskService, "admitTaskWorkspaceTurn").mockReturnValueOnce({
      kind: "refused",
      message: "Workspace registry unreadable; send refused: EIO",
    });

    await streamEnd(t.taskService, t.proseEnd("assistant-1"));
    await t.untilStatus("reported");

    expect(await t.parentReports()).toHaveLength(1);
    expect(t.sends()).toHaveLength(0);
  });

  test("a user stop landing while a child resume is classified discards the resume", async () => {
    const t = await setup();
    await t.setChildGoal();
    expect((await t.goals.setGoal({ workspaceId: childId, status: "paused" })).success).toBe(true);
    // The Stop lands during setGoal's child-resume classification (its first await).
    const internal = t.goals as unknown as {
      isChildGoalResume(input: unknown): Promise<boolean>;
    };
    const realClassify = internal.isChildGoalResume.bind(t.goals);
    spyOn(internal, "isChildGoalResume").mockImplementationOnce(async (input) => {
      const classified = await realClassify(input);
      await t.goals.recordUserStoppedStream(childId);
      return classified;
    });

    const resumed = await t.goals.setGoal({ workspaceId: childId, status: "active" });

    expect(resumed.success).toBe(false);
    expect((await t.goals.getGoal(childId))?.status).toBe("paused");
    expect(t.sends()).toHaveLength(0);
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

    // #5411: reactivating a reported child keeps it reported, so its refusal must not send the
    // user to reactivate it; an interrupted child is reactivated (it runs again) first.
    await t.editChild((workspace) => {
      workspace.taskStatus = "interrupted";
    });
    const interrupted = await t.goals.setGoal({ workspaceId: childId, status: "active" });
    expect(interrupted.success).toBe(false);
    if (refused.success || interrupted.success) return;
    expect(interrupted.error).toMatchObject({ type: "invalid_transition" });
    expect(refused.error).toMatchObject({ type: "invalid_transition" });
    expect(JSON.stringify(interrupted.error)).toContain("Reactivate the task");
    expect(JSON.stringify(refused.error)).not.toContain("Reactivate the task");
  });
});
