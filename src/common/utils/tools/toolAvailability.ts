import type { GoalStatus } from "@/common/types/goal";
import type { AgentId } from "@/common/types/agentDefinition";
import {
  isExecLikeEditingCapableInResolvedChain,
  type ToolsConfigCarrier,
} from "@/common/utils/agentTools";

export interface ToolAvailabilityContext {
  workspaceId: string;
  parentWorkspaceId?: string | null;
}

/**
 * Which goal tool operations are allowed right now. The goal tools themselves
 * are always registered whenever a goal service exists, so the tool block stays
 * byte-identical across turns for provider prompt caching (#5247). The tool
 * handlers call this with the live goal status at execution time and refuse
 * with a typed result when an operation is not allowed.
 */
export interface GoalToolAvailability {
  setGoal: boolean;
  getGoal: boolean;
  completeGoal: boolean;
}

/** Per-turn inputs to the goal tool gates. Deliberately excludes goal status. */
export interface GoalToolContext {
  parentWorkspaceId?: string | null;
  allowAgentSetGoal?: boolean;
  agentInheritanceChain: ReadonlyArray<ToolsConfigCarrier & { id: AgentId }>;
}

export interface GoalToolAvailabilityContext extends GoalToolContext {
  goalStatus: GoalStatus | null;
}

export type SetGoalRefusalReason = "sub_agent" | "agent_set_goal_disabled" | "read_only_agent";

const GOAL_TOOL_ACTIVE_STATUSES: ReadonlySet<GoalStatus> = new Set(["active", "budget_limited"]);
const GOAL_TOOL_REPLACEABLE_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "budget_limited",
  "paused",
  "complete",
]);

/** Why set_goal is refused in this turn, or null when it is allowed. */
export function getSetGoalRefusalReason(context: GoalToolContext): SetGoalRefusalReason | null {
  if (context.parentWorkspaceId != null) return "sub_agent";
  if (context.allowAgentSetGoal !== true) return "agent_set_goal_disabled";
  if (!isExecLikeEditingCapableInResolvedChain(context.agentInheritanceChain)) {
    return "read_only_agent";
  }
  return null;
}

export function getGoalToolAvailability(
  context: GoalToolAvailabilityContext
): GoalToolAvailability {
  const isEditingCapable = isExecLikeEditingCapableInResolvedChain(context.agentInheritanceChain);
  const setGoal = getSetGoalRefusalReason(context) === null;
  const hasActiveGoal =
    context.goalStatus != null && GOAL_TOOL_ACTIVE_STATUSES.has(context.goalStatus);
  const hasGoalReadableForReplacement =
    setGoal && context.goalStatus != null && GOAL_TOOL_REPLACEABLE_STATUSES.has(context.goalStatus);

  return {
    setGoal,
    getGoal: hasActiveGoal || hasGoalReadableForReplacement,
    completeGoal: hasActiveGoal && isEditingCapable,
  };
}

/**
 * Derive canonical tool-availability options from workspace context.
 * Single source of truth for which capability flags to pass to getAvailableTools().
 */
export function getToolAvailabilityOptions(context: ToolAvailabilityContext) {
  return {
    enableAgentReport: Boolean(context.parentWorkspaceId),
    // The Review pane is a user-facing parent-workspace concept. Sub-agents
    // (child task workspaces, identified by a parentWorkspaceId) shouldn't pin
    // code to it, so withhold the review_pane_* tools from them.
    enableReviewPane: !context.parentWorkspaceId,
    // skills_catalog_* tools are always available; agent tool policy controls access.
  } as const;
}
