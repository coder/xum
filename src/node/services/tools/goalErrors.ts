import type { GoalSetError, GoalStatus } from "@/common/types/goal";
import type { SetGoalRefusalReason } from "@/common/utils/tools/toolAvailability";

export function formatGoalSetError(error: GoalSetError): string {
  switch (error.type) {
    case "goal_conflict":
      return `goal_conflict (expected ${error.expectedGoalId ?? "no goal"}, actual ${error.actualGoalId ?? "no goal"})`;
    case "child_workspace":
    case "invalid_transition":
      return `${error.type}: ${error.message}`;
  }
}

/**
 * Typed refusal returned (not thrown) by the goal tools when a call is not
 * allowed. The goal tools are registered on every turn so the tool block stays
 * stable for prompt caching (#5247); these results replace the old behavior of
 * hiding the tool, so the model gets a reason it can act on.
 */
export type GoalToolRefusal =
  | {
      success: false;
      code: "set_goal_not_allowed";
      reason: SetGoalRefusalReason;
      error: string;
    }
  | { success: false; code: "complete_goal_not_allowed"; reason: "read_only_agent"; error: string }
  | { success: false; code: "no_active_goal"; goalStatus: GoalStatus | null; error: string };

const SET_GOAL_REFUSAL_MESSAGES: Record<SetGoalRefusalReason, string> = {
  sub_agent:
    "set_goal is not allowed here: this is a sub-agent workspace, and only the top-level parent workspace can create goals. Report to your parent instead.",
  agent_set_goal_disabled:
    "set_goal is not allowed here: agent goal-setting (allowAgentSetGoal) is off for this turn. Goal-continuation turns and sends that did not opt in (headless runs, delegated turns without permission) cannot create goals. Continue or complete the current goal, or ask the user to set one.",
  read_only_agent:
    "set_goal is not allowed here: the current agent cannot edit files, and only editing-capable (exec-like) agents can create goals. Ask the user to switch to an editing agent.",
};

export function setGoalRefusal(reason: SetGoalRefusalReason): GoalToolRefusal {
  return {
    success: false,
    code: "set_goal_not_allowed",
    reason,
    error: SET_GOAL_REFUSAL_MESSAGES[reason],
  };
}

export function completeGoalReadOnlyRefusal(): GoalToolRefusal {
  return {
    success: false,
    code: "complete_goal_not_allowed",
    reason: "read_only_agent",
    error:
      "complete_goal is not allowed here: the current agent cannot edit files, and only editing-capable (exec-like) agents can complete goals.",
  };
}

export function noActiveGoalRefusal(goalStatus: GoalStatus | null): GoalToolRefusal {
  return {
    success: false,
    code: "no_active_goal",
    goalStatus,
    error: `There is no active goal to complete (current goal status: ${goalStatus ?? "none"}). complete_goal only completes active or budget-limited goals.`,
  };
}
