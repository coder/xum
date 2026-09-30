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
  allowAgentSetGoal?: boolean;
}): string[] {
  const availability = getGoalToolAvailability({
    goalStatus: input.goalStatus,
    parentWorkspaceId: input.parentWorkspaceId,
    allowAgentSetGoal: input.allowAgentSetGoal,
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
        allowAgentSetGoal: true,
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
          allowAgentSetGoal: true,
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
        allowAgentSetGoal: true,
      })
    ).not.toContain("set_goal");
  });

  test("withholds set_goal from non-editing agents", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: false,
        allowAgentSetGoal: true,
      })
    ).not.toContain("set_goal");
  });

  test("withholds set_goal from non-continuation-capable one-shot hosts", () => {
    expect(
      availableGoalToolNames({
        goalStatus: null,
        editingCapable: true,
        allowAgentSetGoal: false,
      })
    ).toEqual([]);
  });

  test.each(["paused", "complete"] as const)(
    "allows get_goal for %s goals when set_goal is available for safe replacement",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          editingCapable: true,
          allowAgentSetGoal: true,
        })
      ).toEqual(["set_goal", "get_goal"]);
    }
  );

  test.each(["paused", "complete"] as const)(
    "omits goal tools for %s goals when set_goal is unavailable",
    (goalStatus) => {
      expect(
        availableGoalToolNames({
          goalStatus,
          editingCapable: true,
          allowAgentSetGoal: false,
        })
      ).toEqual([]);
    }
  );

  test("allows get_goal only for active goals with a non-editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: false,
        allowAgentSetGoal: true,
      })
    ).toEqual(["get_goal"]);
  });

  test("allows all goal tools for active goals with a parent editing agent", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "active",
        editingCapable: true,
        allowAgentSetGoal: true,
      })
    ).toEqual(["set_goal", "get_goal", "complete_goal"]);
  });

  test("allows get_goal and complete_goal for budget-limited goals without set_goal", () => {
    expect(
      availableGoalToolNames({
        goalStatus: "budget_limited",
        editingCapable: true,
        allowAgentSetGoal: false,
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
