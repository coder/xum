export const GOAL_CONTINUATION_IDLE_CONSUMER_NAME = "goal_continuation";
export const GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY = 100;
export const DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS = 60_000;
export const CLI_GOAL_CONTINUATION_SAFETY_LIMIT = 10_000;

/**
 * Upper bound for waiting on a CLI goal continuation to actually start. This is
 * intentionally much longer than normal stream startup so slow CI/runtime warmup
 * does not fail goal runs, while still preventing indefinite benchmark hangs.
 */
export const CLI_GOAL_STREAM_START_TIMEOUT_MS = 5 * 60 * 1000;
export const GOAL_CONTINUATION_KIND = "goal_continuation";
export const GOAL_BUDGET_LIMIT_KIND = "goal_budget_limit";
export const GOAL_OBJECTIVE_OPEN_TAG = "<untrusted_objective>";

/**
 * Agents that can never drive a model-created goal: plan and compact are UI
 * modes, not continuation-capable agents, so automatic goal turns map them to
 * exec. A top-level plan/compact turn therefore must not create a goal, or the
 * goal would continue autonomously under Exec's editing policy.
 */
const NON_GOAL_AGENT_IDS: ReadonlySet<string> = new Set(["plan", "compact"]);

export function canAgentDriveGoal(agentId: string): boolean {
  return !NON_GOAL_AGENT_IDS.has(agentId);
}
export const GOAL_OBJECTIVE_CLOSE_TAG = "</untrusted_objective>";

/**
 * Synthesized completion summary used when the agent ends a goal-continuation
 * turn with a text-only response (no tool calls). Real models occasionally
 * finish a continuation with a plain "looks done" reply instead of calling
 * `complete_goal`; without an implicit completion the continuation loop
 * would re-fire on the same idle output until budget/cooldown gates
 * intervene. Prefer the last text part from the turn (truncated to
 * {@link SILENT_CONTINUATION_COMPLETION_SUMMARY_MAX_LENGTH}); fall back to
 * this constant when no usable text exists.
 */
export const SILENT_CONTINUATION_COMPLETION_SUMMARY_FALLBACK =
  "Agent ended the goal-continuation turn without calling complete_goal — treated as goal completion.";
export const SILENT_CONTINUATION_COMPLETION_SUMMARY_MAX_LENGTH = 500;

/**
 * Placeholder shown wherever a user is asked to write a goal objective
 * (right-sidebar form, command palette, queued-goal input). The text is
 * deliberately educational: it teaches what a good agent goal looks like
 * (concrete + measurable + constraints) so the agent has a verifiable
 * definition of "done". Keep this to <=3 sentences so it stays readable
 * as placeholder copy and doesn't dwarf the surrounding form chrome.
 */
export const GOAL_OBJECTIVE_PLACEHOLDER =
  'Good goals are concrete and measurable. Try "Improve the performance of this function by 30% given X, Y constraints" or "Find one critical security vulnerability." Specific, quantitative targets help the agent know when it\'s done.';

export type GoalSyntheticMessageKind =
  | typeof GOAL_CONTINUATION_KIND
  | typeof GOAL_BUDGET_LIMIT_KIND;

/**
 * Provenance of an automatic turn TaskService drives in a sub-agent (child task) workspace:
 * required-report prompts, recovery re-drives, and (later) child goal continuations and
 * budget wrap-ups. Persisted on the turn's user row and every replay path so a resumed or
 * compaction-replayed turn keeps its classification: the goal tools refuse set_goal on these
 * turns, which must not reset a child goal's caps behind the user's back.
 */
export const TASK_TURN_KINDS = [
  "required_report",
  "recovery",
  "goal_continuation",
  "goal_budget_limit",
] as const;

export type TaskTurnKind = (typeof TASK_TURN_KINDS)[number];

/** Validates an unchecked persisted value (chat.jsonl rows are raw JSON); unknown values drop. */
export function coerceTaskTurnKind(value: unknown): TaskTurnKind | undefined {
  return TASK_TURN_KINDS.find((kind) => kind === value);
}

export interface GoalDefaults {
  defaultBudgetCents: number;
  defaultTurnCap: number | null;
  alwaysRequireExplicitBudget: boolean;
}

export const DEFAULT_GOAL_BUDGET_CENTS = 200;
export const DEFAULT_GOAL_TURN_CAP = null;
export const DEFAULT_GOAL_ALWAYS_REQUIRE_EXPLICIT_BUDGET = true;

export const DEFAULT_GOAL_DEFAULTS: GoalDefaults = {
  defaultBudgetCents: DEFAULT_GOAL_BUDGET_CENTS,
  defaultTurnCap: DEFAULT_GOAL_TURN_CAP,
  alwaysRequireExplicitBudget: DEFAULT_GOAL_ALWAYS_REQUIRE_EXPLICIT_BUDGET,
};

export function normalizeGoalDefaults(
  value: Partial<GoalDefaults> | null | undefined
): GoalDefaults {
  if (!value) {
    return { ...DEFAULT_GOAL_DEFAULTS };
  }

  const defaultBudgetCents = value.defaultBudgetCents;
  const defaultTurnCap = value.defaultTurnCap;

  let normalizedTurnCap = DEFAULT_GOAL_DEFAULTS.defaultTurnCap;
  if (defaultTurnCap == null) {
    normalizedTurnCap = null;
  } else if (Number.isInteger(defaultTurnCap) && defaultTurnCap > 0) {
    normalizedTurnCap = defaultTurnCap;
  }

  return {
    defaultBudgetCents:
      typeof defaultBudgetCents === "number" &&
      Number.isInteger(defaultBudgetCents) &&
      defaultBudgetCents >= 0
        ? defaultBudgetCents
        : DEFAULT_GOAL_DEFAULTS.defaultBudgetCents,
    defaultTurnCap: normalizedTurnCap,
    alwaysRequireExplicitBudget:
      typeof value.alwaysRequireExplicitBudget === "boolean"
        ? value.alwaysRequireExplicitBudget
        : DEFAULT_GOAL_DEFAULTS.alwaysRequireExplicitBudget,
  };
}
