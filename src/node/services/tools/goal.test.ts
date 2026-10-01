import * as path from "path";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "fs/promises";
import type { ToolExecutionOptions } from "ai";

import type { Config } from "@/node/config";
import { createTestHistoryService } from "@/node/services/testHistoryService";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import type { GoalToolContext } from "@/common/utils/tools/toolAvailability";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createCompleteGoalTool } from "./complete_goal";
import { createGetGoalTool } from "./get_goal";
import { createSetGoalTool } from "./set_goal";
import { GOAL_BUDGET_LIMIT_KIND, GOAL_CONTINUATION_KIND } from "@/constants/goals";

// Goal tools do not touch runtime; ToolFactory config still requires one.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const inertRuntime = {} as never;

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "goal-tool-call",
  messages: [],
  context: undefined,
};

// Per-turn goal tool contexts (#5247). The goal tools are always registered, so
// these contexts, not tool presence, decide what each call may do.
const execAgent = { id: "exec" as const, tools: { add: [".*"], remove: ["propose_plan"] } };
const exploreAgent = {
  id: "explore" as const,
  tools: { remove: ["file_edit_.*", "task_apply_git_patch"] },
};
// User sends, delegated workspace turns and heartbeats all get this context:
// any top-level workspace may set a goal without a per-send opt-in.
const TOP_LEVEL_EXEC_CONTEXT = {
  parentWorkspaceId: null,
  agentInheritanceChain: [execAgent],
};
// Turns the goal loop starts itself (agentSession's backend-owned goalKind).
const CONTINUATION_TURN_EXEC_CONTEXT: GoalToolContext = {
  parentWorkspaceId: null,
  goalTurnKind: GOAL_CONTINUATION_KIND,
  agentInheritanceChain: [execAgent],
};
const BUDGET_WRAPUP_TURN_EXEC_CONTEXT: GoalToolContext = {
  parentWorkspaceId: null,
  goalTurnKind: GOAL_BUDGET_LIMIT_KIND,
  agentInheritanceChain: [execAgent],
};
const SUB_AGENT_EXEC_CONTEXT = {
  parentWorkspaceId: "parent-workspace",
  agentInheritanceChain: [execAgent],
};
const TOP_LEVEL_READ_ONLY_CONTEXT = {
  parentWorkspaceId: null,
  agentInheritanceChain: [exploreAgent, execAgent],
};

async function setGoalOk(
  service: WorkspaceGoalService,
  input: Parameters<WorkspaceGoalService["setGoal"]>[0]
): Promise<GoalRecordV1> {
  const result = await service.setGoal(input);
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected goal set to succeed, got ${JSON.stringify(result.error)}`);
  }
  return result.data;
}

function analyticsMock() {
  return { recordGoalLifecycleEvent: mock(() => undefined) };
}

async function expectToolError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected tool execution to fail");
}

describe("goal tools", () => {
  let config: Config;
  let cleanup: () => Promise<void>;
  let goalService: WorkspaceGoalService;
  let analytics: ReturnType<typeof analyticsMock>;
  const workspaceId = "goal-tool-workspace";

  beforeEach(async () => {
    const testServices = await createTestHistoryService();
    ({ config, cleanup } = testServices);
    await config.addWorkspace("/tmp/mux-goal-tool-test-project", {
      id: workspaceId,
      name: "goal-tool-workspace",
      projectName: "mux-goal-tool-test-project",
      projectPath: "/tmp/mux-goal-tool-test-project",
      runtimeConfig: { type: "local" },
    });
    const extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    analytics = analyticsMock();
    goalService = new WorkspaceGoalService(
      config,
      testServices.historyService,
      extensionMetadata,
      analytics
    );
  });

  afterEach(async () => {
    await cleanup();
  });

  test("get_goal returns the current goal", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Read the goal" });
    const tool = createGetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

    expect(result).toEqual({ goal: created });
  });

  test("set_goal creates an active goal using effective defaults", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 5,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Implement the goal tool" }, mockToolCallOptions)
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({
      goal: {
        objective: "Implement the goal tool",
        status: "active",
        budgetCents: 300,
        turnCap: 5,
      },
    });
    expect(goal).toMatchObject({
      objective: "Implement the goal tool",
      status: "active",
      budgetCents: 300,
      turnCap: 5,
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_created",
      expect.objectContaining({ hasBudget: true, hasTurnCap: true })
    );
  });

  test("set_goal treats null budget and turn cap as defaults", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 450,
        defaultTurnCap: 3,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { objective: "Use defaults", budgetCents: null, turnCap: null },
        mockToolCallOptions
      )
    );

    expect(result).toMatchObject({ goal: { budgetCents: 450, turnCap: 3 } });
  });

  test("set_goal uses positive default budget even when omitted user budgets are allowed", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 650,
        defaultTurnCap: null,
        alwaysRequireExplicitBudget: false,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Use global budget default" }, mockToolCallOptions)
    );

    expect(result).toMatchObject({ goal: { budgetCents: 650, turnCap: null } });
  });

  test("set_goal accepts explicit positive budget and turn cap", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 5,
        alwaysRequireExplicitBudget: true,
      },
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { objective: "Use explicit limits", budgetCents: 125, turnCap: 2 },
        mockToolCallOptions
      )
    );

    expect(result).toMatchObject({ goal: { budgetCents: 125, turnCap: 2 } });
  });

  test("set_goal rejects model-created goals that resolve without budget or turn cap", async () => {
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 0,
        defaultTurnCap: null,
        alwaysRequireExplicitBudget: false,
      },
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Unbounded" }, mockToolCallOptions))
    );

    expect(error.message).toContain("requires a budget or turn cap");
  });

  test("set_goal blocks replacing an active goal without explicit replacement intent", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Replacement" }, mockToolCallOptions))
    );

    expect(error.message).toContain("would replace the current active goal");
  });

  test("set_goal blocks replacing an active goal without matching expectedGoalId", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const error = await expectToolError(() =>
      Promise.resolve(
        tool.execute!(
          {
            objective: "Replacement",
            replaceExistingGoal: true,
            expectedGoalId: "00000000-0000-4000-8000-000000000000",
          },
          mockToolCallOptions
        )
      )
    );

    expect(error.message).toContain(existing.goalId);
  });

  test("set_goal blocks replacing an active goal without expectedGoalId", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const error = await expectToolError(() =>
      Promise.resolve(
        tool.execute!({ objective: "Replacement", replaceExistingGoal: true }, mockToolCallOptions)
      )
    );

    expect(error.message).toContain("replacement requires expectedGoalId");
  });

  test("set_goal checks replacement intent against the lock-bound current goal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    interface GetGoalOverride {
      getGoal: WorkspaceGoalService["getGoal"];
    }
    const serviceAccess = goalService as GetGoalOverride;
    const originalGetGoal = serviceAccess.getGoal;
    const staleGetGoal = mock(() => Promise.resolve(null));
    serviceAccess.getGoal = staleGetGoal;
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    try {
      const error = await expectToolError(() =>
        Promise.resolve(tool.execute!({ objective: "Replacement" }, mockToolCallOptions))
      );
      expect(error.message).toContain("would replace the current active goal");
    } finally {
      serviceAccess.getGoal = originalGetGoal;
    }

    expect(staleGetGoal).not.toHaveBeenCalled();
    expect((await goalService.getGoal(workspaceId))?.goalId).toBe(existing.goalId);
  });

  test("set_goal replaces an active goal with matching expectedGoalId", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          objective: "Replacement",
          replaceExistingGoal: true,
          expectedGoalId: existing.goalId,
        },
        mockToolCallOptions
      )
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Replacement", status: "active" } });
    expect(goal?.goalId).not.toBe(existing.goalId);
    expect(goal?.objective).toBe("Replacement");
  });

  test("set_goal replaces an active goal when the replacement objective is unchanged", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Repeatable" });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          objective: "Repeatable",
          replaceExistingGoal: true,
          expectedGoalId: existing.goalId,
          turnCap: 4,
        },
        mockToolCallOptions
      )
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Repeatable", turnCap: 4 } });
    expect((result as { goal: GoalRecordV1 }).goal.goalId).not.toBe(existing.goalId);
    expect(goal?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
  });

  test("set_goal starts a same-objective follow-on after a completed goal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Repeatable" });
    await setGoalOk(goalService, {
      workspaceId,
      status: "complete",
      completionSummary: "First pass complete.",
      expectedGoalId: existing.goalId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Repeatable", turnCap: 4 }, mockToolCallOptions)
    );
    const goal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({ goal: { objective: "Repeatable", status: "active" } });
    expect((result as { goal: GoalRecordV1 }).goal.goalId).not.toBe(existing.goalId);
    expect(goal?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
  });

  test("set_goal allows a new goal after a completed goal without replaceExistingGoal", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Existing" });
    await setGoalOk(goalService, {
      workspaceId,
      status: "complete",
      completionSummary: "Done.",
      expectedGoalId: existing.goalId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ objective: "Follow-on" }, mockToolCallOptions)
    );

    expect(result).toMatchObject({ goal: { objective: "Follow-on", status: "active" } });
  });

  test("set_goal surfaces child workspace errors clearly", async () => {
    const childWorkspaceId = "goal-tool-child";
    await config.addWorkspace("/tmp/mux-goal-tool-test-project", {
      id: childWorkspaceId,
      name: "goal-tool-child",
      projectName: "mux-goal-tool-test-project",
      projectPath: "/tmp/mux-goal-tool-test-project",
      runtimeConfig: { type: "local" },
      parentWorkspaceId: workspaceId,
    });
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId: childWorkspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const error = await expectToolError(() =>
      Promise.resolve(tool.execute!({ objective: "Child goal" }, mockToolCallOptions))
    );

    expect(error.message).toContain("child_workspace");
  });

  test("set_goal queues mid-stream goals with a durable returned goalId", async () => {
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 2,
        alwaysRequireExplicitBudget: true,
      },
    });

    let returnedGoalId = "";
    try {
      const result: unknown = await Promise.resolve(
        tool.execute!({ objective: "Queued while streaming" }, mockToolCallOptions)
      );
      expect(result).toMatchObject({ goal: { objective: "Queued while streaming" } });
      returnedGoalId = (result as { goal: GoalRecordV1 }).goal.goalId;
      expect(await goalService.getGoal(workspaceId)).toBeNull();
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }

    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);
    const durable = await goalService.getGoal(workspaceId);
    const completeTool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });
    const completed: unknown = await Promise.resolve(
      completeTool.execute!(
        { summary: "Completed with the set_goal result id.", goalId: returnedGoalId },
        mockToolCallOptions
      )
    );

    expect(drained?.objective).toBe("Queued while streaming");
    expect(drained?.goalId).toBe(returnedGoalId);
    expect(durable?.goalId).toBe(returnedGoalId);
    expect(completed).toMatchObject({ goal: { goalId: returnedGoalId, status: "complete" } });
  });

  test("set_goal returns a durable new id for same-objective mid-stream replacements", async () => {
    const existing = await setGoalOk(goalService, { workspaceId, objective: "Same objective" });
    await setGoalOk(goalService, { workspaceId, status: "paused" });
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    serviceAccess.isWorkspaceStreaming = () => Promise.resolve(true);
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    let returnedGoalId = "";
    try {
      const result: unknown = await Promise.resolve(
        tool.execute!(
          {
            objective: "Same objective",
            turnCap: 3,
            replaceExistingGoal: true,
            expectedGoalId: existing.goalId,
          },
          mockToolCallOptions
        )
      );
      returnedGoalId = (result as { goal: GoalRecordV1 }).goal.goalId;
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }

    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);
    const durable = await goalService.getGoal(workspaceId);

    expect(returnedGoalId).not.toBe(existing.goalId);
    expect(drained?.goalId).toBe(returnedGoalId);
    expect(durable).toMatchObject({ goalId: returnedGoalId, turnCap: 3 });
  });

  test("set_goal persists immediately if streaming ends before queueing under the lock", async () => {
    interface StreamingOverride {
      isWorkspaceStreaming: (workspaceId: string) => Promise<boolean>;
    }
    const serviceAccess = goalService as unknown as StreamingOverride;
    const original = serviceAccess.isWorkspaceStreaming;
    let streamingChecks = 0;
    serviceAccess.isWorkspaceStreaming = () => {
      streamingChecks += 1;
      return Promise.resolve(streamingChecks < 3);
    };
    const tool = createSetGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
      goalDefaults: {
        defaultBudgetCents: 300,
        defaultTurnCap: 2,
        alwaysRequireExplicitBudget: true,
      },
    });

    let result: unknown;
    try {
      result = await Promise.resolve(
        tool.execute!({ objective: "Persist after stream settles" }, mockToolCallOptions)
      );
    } finally {
      serviceAccess.isWorkspaceStreaming = original;
    }
    const durable = await goalService.getGoal(workspaceId);
    const drained = await goalService.applyPendingAfterStreamEnd(workspaceId);

    expect(streamingChecks).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ goal: { objective: "Persist after stream settles" } });
    expect(durable?.goalId).toBe((result as { goal: GoalRecordV1 }).goal.goalId);
    expect(drained).toBeNull();
  });

  test("complete_goal completes the goal, persists the summary, and emits model telemetry", async () => {
    const created = await setGoalOk(goalService, { workspaceId, objective: "Finish the goal" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ summary: "Implemented and verified." }, mockToolCallOptions)
    );
    const storedRaw = await fs.readFile(
      path.join(config.sessionsDir, workspaceId, "goal.json"),
      "utf-8"
    );
    const storedGoal = JSON.parse(storedRaw) as GoalRecordV1;
    const currentGoal = await goalService.getGoal(workspaceId);

    expect(result).toMatchObject({
      goal: {
        goalId: created.goalId,
        status: "complete",
        completionSummary: "Implemented and verified.",
      },
    });
    expect(storedGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(currentGoal).toMatchObject({
      goalId: created.goalId,
      status: "complete",
      completionSummary: "Implemented and verified.",
    });
    expect(analytics.recordGoalLifecycleEvent).toHaveBeenCalledWith(
      "goal_completed",
      expect.objectContaining({ initiator: "model", summaryLengthBucket: "10-49" })
    );
  });

  // ---------------------------------------------------------------------------
  // complete_goal error coverage (Coder-agents-review P3 DEREM-26 + DEREM-44).
  //
  // complete_goal is registered on every turn (#5247), so a call without an
  // active goal must come back as a typed result the model can act on, not an
  // unknown tool or a confusing validation error. Covered below: no goal, a
  // goal cleared mid-stream, and a paused goal. A forwarded `goalId` mismatch
  // still surfaces as a typed `goal_conflict` from the service.
  // ---------------------------------------------------------------------------
  test.each([
    { label: "no goal exists", arrange: () => Promise.resolve() },
    {
      label: "the goal was cleared (no goalId forwarded)",
      arrange: async () => {
        await setGoalOk(goalService, { workspaceId, objective: "Will be cleared" });
        await goalService.clearGoal(workspaceId);
      },
    },
    {
      label: "the goal is paused",
      arrange: async () => {
        await setGoalOk(goalService, { workspaceId, objective: "Will be paused" });
        await setGoalOk(goalService, { workspaceId, status: "paused" });
      },
    },
  ])("complete_goal returns a typed no_active_goal result when $label", async ({ arrange }) => {
    await arrange();
    const before = await goalService.getGoal(workspaceId);
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ summary: "Done without an active goal." }, mockToolCallOptions)
    );

    expect(result).toMatchObject({ success: false, code: "no_active_goal" });
    expect(await goalService.getGoal(workspaceId)).toEqual(before);
  });

  test("complete_goal surfaces goal_conflict when expected goalId is stale", async () => {
    await setGoalOk(goalService, { workspaceId, objective: "Compete with a stale goalId" });
    const tool = createCompleteGoalTool({
      cwd: "/tmp",
      runtimeTempDir: "/tmp",
      runtime: inertRuntime,
      workspaceId,
      goalService,
      goalToolContext: TOP_LEVEL_EXEC_CONTEXT,
    });

    // Forwarded `goalId` does not match the actual goal — setGoal returns
    // a typed `goal_conflict` error; the tool surfaces this as a thrown
    // Error rather than the misleading "Goal objective is required."
    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { summary: "Done.", goalId: "00000000-0000-4000-8000-000000000000" },
          mockToolCallOptions
        )
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("goal_conflict");
  });

  // #5247: the goal tools are always registered, so every gate that used to hide
  // them is enforced here, at execution time, with a typed refusal.
  describe("execution-time gates", () => {
    function toolConfig(goalToolContext: GoalToolContext): ToolConfiguration {
      return {
        cwd: "/tmp",
        runtimeTempDir: "/tmp",
        runtime: inertRuntime,
        workspaceId,
        goalService,
        goalToolContext,
        goalDefaults: {
          defaultBudgetCents: 300,
          defaultTurnCap: 5,
          alwaysRequireExplicitBudget: false,
        },
      };
    }

    test.each([
      { label: "a sub-agent", context: SUB_AGENT_EXEC_CONTEXT, reason: "sub_agent" },
      {
        label: "a goal-continuation turn",
        context: CONTINUATION_TURN_EXEC_CONTEXT,
        reason: "automatic_goal_turn",
      },
      {
        label: "a budget wrap-up turn",
        context: BUDGET_WRAPUP_TURN_EXEC_CONTEXT,
        reason: "automatic_goal_turn",
      },
      {
        label: "a read-only agent",
        context: TOP_LEVEL_READ_ONLY_CONTEXT,
        reason: "read_only_agent",
      },
    ])("set_goal refuses $label with a typed not-allowed result", async ({ context, reason }) => {
      const setGoalSpy = spyOn(goalService, "setGoal");
      const tool = createSetGoalTool(toolConfig(context));

      const result: unknown = await Promise.resolve(
        tool.execute!({ objective: "Not allowed here" }, mockToolCallOptions)
      );

      expect(result).toMatchObject({ success: false, code: "set_goal_not_allowed", reason });
      expect(setGoalSpy).not.toHaveBeenCalled();
      expect(await goalService.getGoal(workspaceId)).toBeNull();
    });

    // Replacing the goal from a turn the goal loop started would reset its spend
    // and turn counters and re-arm continuations, so the caps could never stop it.
    test.each([
      { label: "goal-continuation", context: CONTINUATION_TURN_EXEC_CONTEXT },
      { label: "budget wrap-up", context: BUDGET_WRAPUP_TURN_EXEC_CONTEXT },
    ])("a $label turn cannot replace the current goal", async ({ context }) => {
      const created = await setGoalOk(goalService, { workspaceId, objective: "Bounded work" });
      const tool = createSetGoalTool(toolConfig(context));

      const result: unknown = await Promise.resolve(
        tool.execute!(
          {
            objective: "Fresh budget",
            replaceExistingGoal: true,
            expectedGoalId: created.goalId,
          },
          mockToolCallOptions
        )
      );

      expect(result).toMatchObject({ success: false, reason: "automatic_goal_turn" });
      expect(await goalService.getGoal(workspaceId)).toEqual(created);
    });

    test("a goal-continuation turn cannot start a new goal after completing the current one", async () => {
      const created = await setGoalOk(goalService, { workspaceId, objective: "First goal" });
      const completeTool = createCompleteGoalTool(toolConfig(CONTINUATION_TURN_EXEC_CONTEXT));
      const setTool = createSetGoalTool(toolConfig(CONTINUATION_TURN_EXEC_CONTEXT));

      await Promise.resolve(
        completeTool.execute!({ summary: "Done.", goalId: created.goalId }, mockToolCallOptions)
      );
      const result: unknown = await Promise.resolve(
        setTool.execute!({ objective: "Chained goal" }, mockToolCallOptions)
      );

      expect(result).toMatchObject({ success: false, reason: "automatic_goal_turn" });
      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        status: "complete",
      });
    });

    test("complete_goal refuses a read-only agent and leaves the active goal untouched", async () => {
      const created = await setGoalOk(goalService, { workspaceId, objective: "Keep going" });
      const tool = createCompleteGoalTool(toolConfig(TOP_LEVEL_READ_ONLY_CONTEXT));

      const result: unknown = await Promise.resolve(
        tool.execute!({ summary: "Done.", goalId: created.goalId }, mockToolCallOptions)
      );

      expect(result).toMatchObject({ success: false, code: "complete_goal_not_allowed" });
      expect(await goalService.getGoal(workspaceId)).toMatchObject({
        goalId: created.goalId,
        status: "active",
      });
    });

    // Regression for the #5247 report: the goal was active and the continuation
    // prompt asked for complete_goal, but the tool was missing on that turn.
    test("complete_goal completes an active goal on a goal-continuation turn", async () => {
      const created = await setGoalOk(goalService, {
        workspaceId,
        objective: "Finish on continuation",
      });
      const tool = createCompleteGoalTool(toolConfig(CONTINUATION_TURN_EXEC_CONTEXT));

      const result: unknown = await Promise.resolve(
        tool.execute!({ summary: "Verified.", goalId: created.goalId }, mockToolCallOptions)
      );

      expect(result).toMatchObject({ goal: { goalId: created.goalId, status: "complete" } });
      expect(await goalService.getGoal(workspaceId)).toMatchObject({ status: "complete" });
    });

    test("set_goal creates a goal on a top-level workspace turn", async () => {
      const tool = createSetGoalTool(toolConfig(TOP_LEVEL_EXEC_CONTEXT));

      const result: unknown = await Promise.resolve(
        tool.execute!({ objective: "Allowed goal" }, mockToolCallOptions)
      );

      expect(result).toMatchObject({ goal: { objective: "Allowed goal", status: "active" } });
    });

    test("get_goal returns a null goal when no goal exists", async () => {
      const tool = createGetGoalTool(toolConfig(TOP_LEVEL_EXEC_CONTEXT));

      const result: unknown = await Promise.resolve(tool.execute!({}, mockToolCallOptions));

      expect(result).toEqual({ goal: null });
    });

    test("get_goal hides a paused goal unless the turn may replace it with set_goal", async () => {
      const created = await setGoalOk(goalService, { workspaceId, objective: "Paused work" });
      await setGoalOk(goalService, { workspaceId, status: "paused" });

      const withoutSetGoal: unknown = await Promise.resolve(
        createGetGoalTool(toolConfig(SUB_AGENT_EXEC_CONTEXT)).execute!({}, mockToolCallOptions)
      );
      const withSetGoal: unknown = await Promise.resolve(
        createGetGoalTool(toolConfig(TOP_LEVEL_EXEC_CONTEXT)).execute!({}, mockToolCallOptions)
      );

      expect(withoutSetGoal).toEqual({ goal: null });
      expect(withSetGoal).toMatchObject({ goal: { goalId: created.goalId, status: "paused" } });
    });

    test("get_goal returns an active goal to read-only agents and sub-agents", async () => {
      const created = await setGoalOk(goalService, { workspaceId, objective: "Active work" });

      for (const context of [TOP_LEVEL_READ_ONLY_CONTEXT, SUB_AGENT_EXEC_CONTEXT]) {
        const result: unknown = await Promise.resolve(
          createGetGoalTool(toolConfig(context)).execute!({}, mockToolCallOptions)
        );
        expect(result).toMatchObject({ goal: { goalId: created.goalId, status: "active" } });
      }
    });
  });
});
