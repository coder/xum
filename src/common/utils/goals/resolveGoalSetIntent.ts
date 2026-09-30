import { normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";
import type { z } from "zod";
import type { WorkspaceGoalDefaultsOverrideSchema } from "@/common/orpc/schemas";
import { normalizeGoalBudgetCents } from "@/common/utils/goals/budgetPricing";

export type WorkspaceGoalDefaultsOverride = z.infer<typeof WorkspaceGoalDefaultsOverrideSchema>;

/**
 * Merge a per-workspace sparse override on top of global defaults.
 *
 * Each field in the override is independently nullable:
 *   - `null` → follow the global default
 *   - explicit value → use this value
 *
 * Returns a fully-normalized `GoalDefaults` object so downstream
 * `resolveGoalSetIntent` does not need to know which fields were
 * inherited vs overridden.
 */
export function mergeGoalDefaults(
  global: GoalDefaults,
  override: WorkspaceGoalDefaultsOverride | null | undefined
): GoalDefaults {
  if (!override) {
    return { ...global };
  }
  // `defaultTurnCap` is itself nullable in the global shape (null = no
  // cap), so an override field of `null` means "inherit", not "no cap".
  // `??` is the right operator: it picks the override only when it's
  // non-null/undefined, otherwise falls back to the global value.
  return normalizeGoalDefaults({
    defaultBudgetCents: override.defaultBudgetCents ?? global.defaultBudgetCents,
    defaultTurnCap: override.defaultTurnCap ?? global.defaultTurnCap,
    alwaysRequireExplicitBudget:
      override.alwaysRequireExplicitBudget ?? global.alwaysRequireExplicitBudget,
  });
}

/**
 * Inputs passed by callers (slash command, command palette, GoalTab) when
 * creating a goal. Each field is optional — defaults fill in the rest.
 *
 * - `budgetCents` is a discriminated tri-state:
 *   - `undefined` → "user did not specify; apply default"
 *   - `null` or `0` → "no budget" (explicit clear)
 *   - positive `number` → explicit cents value
 */
export interface GoalSetIntentInput {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
}

export interface GoalSetIntent {
  objective: string;
  budgetCents: number | null;
  turnCap: number | null;
}

/**
 * Apply goal defaults to a user-authored partial goal-creation intent.
 *
 * Defaults are surface-agnostic:
 *   - If the caller omitted `budgetCents`:
 *     - `alwaysRequireExplicitBudget` → fall back to `defaultBudgetCents`.
 *     - Otherwise → `null` (no budget).
 *   - `null` and `0` both become no budget (explicit "no budget" clear).
 *   - If the caller omitted `turnCap`, fall back to `defaultTurnCap`.
 *
 * Coder-agents-review P3 DEREM-27: the slash command path (`/goal`) used to
 * apply this and the command palette did not, so a blank palette budget
 * silently created an unbudgeted goal in violation of the GoalsSection
 * contract ("omitted budgets use the default budget instead of creating
 * unbudgeted goals"). This helper unifies both entry points.
 */
export function resolveGoalSetIntent(
  input: GoalSetIntentInput,
  defaults: GoalDefaults
): GoalSetIntent {
  let budgetCents: number | null;
  if (input.budgetCents !== undefined) {
    budgetCents = normalizeGoalBudgetCents(input.budgetCents);
  } else if (defaults.alwaysRequireExplicitBudget) {
    budgetCents = normalizeGoalBudgetCents(defaults.defaultBudgetCents);
  } else {
    budgetCents = null;
  }

  const turnCap = input.turnCap !== undefined ? input.turnCap : defaults.defaultTurnCap;

  return {
    objective: input.objective,
    budgetCents,
    turnCap,
  };
}

/**
 * Resolve a model-authored goal intent.
 *
 * Model tool schemas normalize omitted optional values to `null` on some
 * providers. For agent-created goals, `null` must therefore mean "use the
 * effective defaults" rather than the UI meaning "the user explicitly cleared
 * this bound"; otherwise a model could accidentally create an unbounded goal.
 * The budget default applies even when user-authored forms allow omitted
 * budgets to mean "no budget" — a model omission is not an explicit user clear.
 */
export function resolveModelGoalSetIntent(
  input: GoalSetIntentInput,
  defaults: GoalDefaults
): GoalSetIntent {
  const objective = input.objective.trim();
  const budgetCents =
    input.budgetCents != null
      ? normalizeGoalBudgetCents(input.budgetCents)
      : normalizeGoalBudgetCents(defaults.defaultBudgetCents);
  const turnCap = input.turnCap ?? defaults.defaultTurnCap;

  return {
    objective,
    budgetCents,
    turnCap,
  };
}
