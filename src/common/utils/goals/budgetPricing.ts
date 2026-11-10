import assert from "@/common/utils/assert";
import type { GoalRecordV1, GoalSnapshot } from "@/common/types/goal";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getModelStatsResolved } from "@/common/utils/tokens/modelStats";

/** Format a non-negative cents value as a dollar-prefixed two-decimal string ("$1.25"). */
export function formatGoalCents(cents: number): string {
  assert(Number.isInteger(cents) && cents >= 0, "formatGoalCents requires non-negative cents");
  return `$${(cents / 100).toFixed(2)}`;
}

type GoalBudgetState = Pick<GoalRecordV1 | GoalSnapshot, "status" | "budgetCents">;

/** True when the budget imposes a positive dollar limit; zero cents means no budget. */
export function hasGoalBudgetLimit(budgetCents: number | null | undefined): boolean {
  if (budgetCents == null) {
    return false;
  }
  assert(
    Number.isInteger(budgetCents) && budgetCents >= 0,
    `goal budget limit requires non-negative integer cents, got ${budgetCents}`
  );
  return budgetCents > 0;
}

/** Collapse zero-cent and nullish budgets to null (no dollar limit). */
export function normalizeGoalBudgetCents(budgetCents: number | null | undefined): number | null {
  return budgetCents != null && hasGoalBudgetLimit(budgetCents) ? budgetCents : null;
}

/**
 * Returns true for any goal whose budget will be debited again if the user
 * continues working — i.e. `active`, `paused`, or `budget_limited` (the
 * non-terminal states with a positive `budgetCents`). Used to gate model
 * switches: an unpriced model on such a goal silently records 0 cost on the
 * next stream, breaking budget enforcement after resume. A zero-dollar budget
 * is treated as "no budget" so users can disable dollar limits from settings.
 */
export function hasBudgetedResumableGoal(goal: GoalBudgetState | null | undefined): boolean {
  if (!goal || !hasGoalBudgetLimit(goal.budgetCents)) {
    return false;
  }
  return goal.status === "active" || goal.status === "paused" || goal.status === "budget_limited";
}

function modelStatsHasBillableCosts(
  stats: NonNullable<ReturnType<typeof getModelStatsResolved>>
): boolean {
  return (
    stats.input_cost_per_token > 0 ||
    stats.output_cost_per_token > 0 ||
    (stats.input_cost_per_token_above_threshold ?? 0) > 0 ||
    (stats.output_cost_per_token_above_threshold ?? 0) > 0 ||
    (stats.cache_creation_input_token_cost ?? 0) > 0 ||
    (stats.cache_creation_input_token_cost_above_threshold ?? 0) > 0 ||
    (stats.cache_read_input_token_cost ?? 0) > 0 ||
    (stats.cache_read_input_token_cost_above_threshold ?? 0) > 0
  );
}

export function modelHasPricingData(model: string, providersConfig: unknown = null): boolean {
  const stats = getModelStatsResolved(model, providersConfig as ProvidersConfigMap | null);
  return stats != null && modelStatsHasBillableCosts(stats);
}

export const UNPRICED_CURRENT_MODEL_GOAL_MESSAGE =
  "Current model has no pricing data. Pick a priced model, use -b 0 with a turn cap, or change goal budget defaults in Settings.";

export const UNPRICED_TARGET_MODEL_GOAL_MESSAGE =
  "Target model has no pricing data. Pick a priced model before switching.";
