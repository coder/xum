import { describe, expect, test } from "bun:test";

import { getGoalToolAvailability, getToolAvailabilityOptions } from "./toolAvailability";
import type { GoalStatus } from "@/common/types/goal";

const execAgent = {
  id: "exec" as const,
  tools: { add: [".*"], remove: ["propose_plan"] },
};
const exploreAgent = {
  id: "explore" as const,
  tools: { remove: ["file_edit_.*", "task_apply_git_patch"] },
};
const execBaseForExplore = {
  id: "exec" as const,
  tools: { add: [".*"], remove: ["propose_plan"] },
};

function availableGoalToolNames(input: {
  goalStatus: GoalStatus | null;
  editingCapable: boolean;
  parentWorkspaceId?: string | null;
}): string[] {
  const availability = getGoalToolAvailability({
    goalStatus: input.goalStatus,
    parentWorkspaceId: input.parentWorkspaceId,
    agentInheritanceChain: input.editingCapable ? [execAgent] : [exploreAgent, execBaseForExplore],
  });

  return [
    ...(availability.setGoal ? ["set_goal"] : []),
    ...(availability.getGoal ? ["get_goal"] : []),
    ...(availability.completeGoal ? ["complete_goal"] : []),
  ];
}

describe("goal tool availability", () => {
  test("allows set_goal for a continuation-capable parent editing agent when no goal is set", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: true,
      })
    ).toEqual(["set_goal"]);
  });

  test.each(["active", "budget_limited", "paused", "complete"] as const)(
    "allows set_goal for %s goals in parent editing sessions",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          editingCapable: true,
        })
      ).toContain("set_goal");
    }
  );

  test("withholds set_goal from child workspaces", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: true,
        parentWorkspaceId: "parent",
      })
    ).not.toContain("set_goal");
  });

  test("withholds set_goal from non-editing agents", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: false,
      })
    ).not.toContain("set_goal");
  });

  test.each(["paused", "complete"] as const)(
    "allows get_goal for %s goals when set_goal is available for safe replacement",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          editingCapable: true,
        })
      ).toEqual(["set_goal", "get_goal"]);
    }
  );

  test.each(["paused", "complete"] as const)(
    "omits goal tools for %s goals in child workspaces, where set_goal is unavailable",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          editingCapable: true,
          parentWorkspaceId: "parent",
        })
      ).toEqual([]);
    }
  );

  test("allows get_goal only for active goals with a non-editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: false,
      })
    ).toEqual(["get_goal"]);
  });

  test("allows all goal tools for active goals with a parent editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: true,
      })
    ).toEqual(["set_goal", "get_goal", "complete_goal"]);
  });

  test("allows get_goal and complete_goal for budget-limited goals without set_goal", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "budget_limited",
        editingCapable: true,
        parentWorkspaceId: "parent",
      })
    ).toEqual(["get_goal", "complete_goal"]);
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
