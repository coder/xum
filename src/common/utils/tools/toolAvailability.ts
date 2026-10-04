import type { GoalStatus } from "@/common/types/goal";
import {
  canAgentDriveGoal,
  type GoalSyntheticMessageKind,
  type TaskTurnKind,
} from "@/constants/goals";
import type { AgentId } from "@/common/types/agentDefinition";

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
  /**
   * Set when this turn is an automatic goal turn (goal continuation or budget
   * wrap-up) rather than a user, delegated or heartbeat turn.
   */
  goalTurnKind?: GoalSyntheticMessageKind;
  /**
   * The goal an automatic goal turn was dispatched for. complete_goal without a goalId targets
   * it, so a goal replaced after dispatch is refused instead of completed (#5461).
   */
  goalId?: string;
  /** Agent this turn actually resolved to (not the requested id). */
  agentId: AgentId;
  /**
   * The resolved agent inherits plan (a custom plan-like agent). Its automatic goal turns
   * would stay in Plan Mode (propose_plan required, edits restricted) and only re-plan, so
   * it cannot drive a goal any more than the built-in plan agent can.
   */
  agentIsPlanLike?: boolean;
  /**
   * The turn resolved its agent with workspace definitions disabled (the per-turn
   * disableWorkspaceAgents "unbrick" override). Automatic goal turns and recovery
   * do not carry that override, so they could run a different definition with the
   * same id; such a turn cannot create a goal.
   */
  agentDiscoveryOverridden?: boolean;
  /**
   * Set when TaskService drove this turn automatically in a sub-agent workspace (required
   * report, recovery re-drive, child goal continuation or wrap-up) rather than a user or
   * delegated turn.
   */
  taskTurnKind?: TaskTurnKind;
}

export interface GoalToolAvailabilityContext extends GoalToolContext {
  goalStatus: GoalStatus | null;
}

export type SetGoalRefusalReason =
  | "automatic_goal_turn"
  | "automatic_task_turn"
  | "agent_discovery_override"
  | "non_goal_agent";

const GOAL_TOOL_ACTIVE_STATUSES: ReadonlySet<GoalStatus> = new Set(["active", "budget_limited"]);
const GOAL_TOOL_REPLACEABLE_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "budget_limited",
  "paused",
  "complete",
]);

/** Why set_goal is refused in this turn, or null when it is allowed. */
export function getSetGoalRefusalReason(context: GoalToolContext): SetGoalRefusalReason | null {
  // Every workspace (sub-agents included) may set a goal, but a turn the goal loop started
  // itself may not: replacing (or completing then re-creating) the goal would
  // reset its spend and turn caps and re-arm continuations, so the budget could
  // never stop the loop.
  if (context.goalTurnKind != null) return "automatic_goal_turn";
  // Same reasoning for sub-agents: a turn TaskService drove automatically (report prompt,
  // recovery re-drive, child goal continuation or wrap-up) must not create or replace the
  // child's goal. A user or delegated turn in the child may.
  if (context.parentWorkspaceId != null && context.taskTurnKind != null) {
    return "automatic_task_turn";
  }
  if (context.agentDiscoveryOverridden === true) return "agent_discovery_override";
  // Plan, plan-like and compact agents cannot drive a goal (see canAgentDriveGoal): at the top
  // level the workspace kickoff would run plan/compact as exec, and a plan-like agent's goal
  // turns (top-level or a child's) stay in Plan Mode and only re-plan.
  if (!canAgentDriveGoal(context.agentId) || context.agentIsPlanLike === true) {
    return "non_goal_agent";
  }
  // Read-only agents (explore) may set goals too: a research goal is pursued and
  // completed without editing tools, under the agent's own tool policy, as long
  // as that agent is the workspace's selected agent (checked by the goal service).
  return null;
}

export function getGoalToolAvailability(
  context: GoalToolAvailabilityContext
): GoalToolAvailability {
  const setGoal = getSetGoalRefusalReason(context) === null;
  const hasActiveGoal =
    context.goalStatus != null && GOAL_TOOL_ACTIVE_STATUSES.has(context.goalStatus);
  const hasGoalReadableForReplacement =
    setGoal && context.goalStatus != null && GOAL_TOOL_REPLACEABLE_STATUSES.has(context.goalStatus);

  return {
    setGoal,
    getGoal: hasActiveGoal || hasGoalReadableForReplacement,
    completeGoal: hasActiveGoal,
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
