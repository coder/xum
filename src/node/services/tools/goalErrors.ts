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
  | { success: false; code: "no_active_goal"; goalStatus: GoalStatus | null; error: string };

const SET_GOAL_REFUSAL_MESSAGES: Record<SetGoalRefusalReason, string> = {
  sub_agent:
    "set_goal is not allowed here: this is a sub-agent workspace, and only the top-level parent workspace can create goals. Report to your parent instead.",
  automatic_goal_turn:
    "set_goal is not allowed here: this is an automatic goal turn (goal continuation or budget wrap-up), which cannot create or replace goals because that would reset the goal's budget and turn limits. Continue or complete the current goal; a user, delegated or heartbeat turn can set a new one.",
  agent_discovery_override:
    "set_goal is not allowed here: this turn resolved its agent with workspace agent definitions disabled, and the goal's automatic turns would not keep that override. Ask the user to turn workspace agents back on before setting a goal.",
  non_goal_agent:
    "set_goal is not allowed here: the current agent (plan, a plan-like agent, or compact) cannot run a goal's automatic turns. Ask the user to switch to an agent that can pursue the goal.",
  automatic_task_turn:
    "set_goal is not allowed here: this is an automatic sub-agent turn (report prompt, recovery or goal continuation), which cannot create or replace goals because that would reset the goal's budget and turn limits. Continue the current work or report to your parent; a user or delegated turn can set a new goal.",
};

export function setGoalRefusal(reason: SetGoalRefusalReason): GoalToolRefusal {
  return {
    success: false,
    code: "set_goal_not_allowed",
    reason,
    error: SET_GOAL_REFUSAL_MESSAGES[reason],
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
