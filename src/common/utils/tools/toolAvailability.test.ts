import { describe, expect, test } from "bun:test";

import {
  getGoalToolAvailability,
  getSetGoalRefusalReason,
  getToolAvailabilityOptions,
} from "./toolAvailability";
import type { GoalStatus } from "@/common/types/goal";
import type { TaskTurnKind } from "@/constants/goals";

function availableGoalToolNames(input: {
  goalStatus: GoalStatus | null;
  parentWorkspaceId?: string | null;
  taskTurnKind?: TaskTurnKind;
}): string[] {
  const availability = getGoalToolAvailability({
    goalStatus: input.goalStatus,
    parentWorkspaceId: input.parentWorkspaceId,
    agentId: "exec",
    taskTurnKind: input.taskTurnKind,
  });

  return [
    ...(availability.setGoal ? ["set_goal"] : []),
    ...(availability.getGoal ? ["get_goal"] : []),
    ...(availability.completeGoal ? ["complete_goal"] : []),
  ];
}

describe("goal tool availability", () => {
  test("allows set_goal in a top-level workspace when no goal is set", () => {
    expect(availableGoalToolNames({ goalStatus: null })).toEqual(["set_goal"]);
  });

  test.each(["active", "budget_limited", "paused", "complete"] as const)(
    "allows set_goal for %s goals in top-level workspaces",
    (goalStatus) => {
      expect(availableGoalToolNames({ goalStatus })).toContain("set_goal");
    }
  );

  // Sub-agents own goals: a user or delegated turn in a child may set one, but no turn
  // TaskService drove automatically may (it would reset the child goal's caps).
  test("allows set_goal on a child's own turns but not its automatic task turns", () => {
    expect(availableGoalToolNames({ goalStatus: null, parentWorkspaceId: "parent" })).toEqual([
      "set_goal",
    ]);
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        parentWorkspaceId: "parent",
        taskTurnKind: "goal_continuation",
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });

  test.each(["paused", "complete"] as const)(
    "allows get_goal for %s goals when set_goal is available for safe replacement",
    (goalStatus) => {
      expect(availableGoalToolNames({ goalStatus })).toEqual(["set_goal", "get_goal"]);
    }
  );

  test.each(["paused", "complete"] as const)(
    "omits goal tools for %s goals on a child's automatic task turns",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          parentWorkspaceId: "parent",
          taskTurnKind: "recovery",
        })
      ).toEqual([]);
    }
  );

  test("allows all goal tools for active goals in top-level workspaces", () => {
    expect(availableGoalToolNames({ goalStatus: "active" })).toEqual([
      "set_goal",
      "get_goal",
      "complete_goal",
    ]);
  });

  test("allows get_goal and complete_goal for budget-limited goals without set_goal", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "budget_limited",
        parentWorkspaceId: "parent",
        taskTurnKind: "goal_budget_limit",
      })
    ).toEqual(["get_goal", "complete_goal"]);
  });
});

describe("set_goal refusal for plan and compact turns", () => {
  // Automatic goal turns would run plan/compact as exec: the turn's agent id decides.
  test.each(["plan", "compact"])("refuses set_goal on a top-level %s turn", (agentId) => {
    const context = { parentWorkspaceId: null, agentId };
    expect(getSetGoalRefusalReason(context)).toBe("non_goal_agent");
    expect(getGoalToolAvailability({ ...context, goalStatus: null }).setGoal).toBe(false);
  });

  test("refuses set_goal on a top-level custom plan-like turn", () => {
    const context = {
      parentWorkspaceId: null,
      agentId: "my-planner",
      agentIsPlanLike: true,
    };
    expect(getSetGoalRefusalReason(context)).toBe("non_goal_agent");
    expect(getSetGoalRefusalReason({ ...context, agentIsPlanLike: false })).toBeNull();
  });

  test("refuses set_goal when the turn disabled workspace agent definitions", () => {
    // Goal continuations and recovery resolve agents without the per-turn override,
    // so a same-id workspace definition could run them instead.
    const context = {
      parentWorkspaceId: null,
      agentId: "exec",
      agentDiscoveryOverridden: true,
    };
    expect(getSetGoalRefusalReason(context)).toBe("agent_discovery_override");
    expect(getGoalToolAvailability({ ...context, goalStatus: null }).setGoal).toBe(false);
    expect(getSetGoalRefusalReason({ ...context, agentDiscoveryOverridden: false })).toBeNull();
  });

  // Plan-like goal turns only re-plan, in a child as much as at the top level.
  test("refuses set_goal on a plan child's own turn", () => {
    expect(getSetGoalRefusalReason({ parentWorkspaceId: "parent", agentId: "plan" })).toBe(
      "non_goal_agent"
    );
  });

  test("allows set_goal for a read-only agent", () => {
    expect(getSetGoalRefusalReason({ parentWorkspaceId: null, agentId: "explore" })).toBeNull();
  });
});

describe("getSetGoalRefusalReason", () => {
  // Every automatic task turn of a child refuses set_goal; a persisted malformed kind replays as
  // "recovery" (coerceTaskTurnKind fails closed), so it refuses too.
  test.each(["required_report", "recovery", "goal_continuation", "goal_budget_limit"] as const)(
    "refuses set_goal on a child's %s turn",
    (taskTurnKind) => {
      expect(
        getSetGoalRefusalReason({ parentWorkspaceId: "parent", agentId: "exec", taskTurnKind })
      ).toBe("automatic_task_turn");
    }
  );

  test("allows set_goal on a child's own (non-automatic) turn", () => {
    expect(getSetGoalRefusalReason({ parentWorkspaceId: "parent", agentId: "exec" })).toBeNull();
  });

  test("ignores task turn provenance outside sub-agents", () => {
    expect(getSetGoalRefusalReason({ agentId: "exec", taskTurnKind: "recovery" })).toBeNull();
  });
});

describe("getToolAvailabilityOptions", () => {
  test("enables the Review pane for top-level workspaces", () => {
    const options = getToolAvailabilityOptions({ workspaceId: "ws-1" });
    expect(options.enableReviewPane).toBe(true);
    expect(options.enableAgentReport).toBe(false);
  });

  test("withholds the Review pane (and enables agent_report) for sub-agents", () => {
    const options = getToolAvailabilityOptions({
      workspaceId: "ws-child",
      parentWorkspaceId: "ws-parent",
    });
    expect(options.enableReviewPane).toBe(false);
    expect(options.enableAgentReport).toBe(true);
  });
});
