import { describe, expect, test } from "bun:test";
import { DEFAULT_GOAL_DEFAULTS, type GoalDefaults } from "@/constants/goals";
import {
  canonicalGoalDefaultsOverride,
  mergeGoalDefaults,
  resolveModelGoalSetIntent,
  sameGoalDefaultsOverride,
  type WorkspaceGoalDefaultsOverride,
} from "./resolveGoalSetIntent";

describe("resolveModelGoalSetIntent", () => {
  const defaults: GoalDefaults = {
    ...DEFAULT_GOAL_DEFAULTS,
    defaultBudgetCents: 500,
    defaultTurnCap: 4,
    alwaysRequireExplicitBudget: true,
  };

  test("omitted budget and turn cap apply effective defaults", () => {
    const intent = resolveModelGoalSetIntent({ objective: " ship " }, defaults);

    expect(intent).toEqual({ objective: "ship", budgetCents: 500, turnCap: 4 });
  });

  test("null budget and turn cap apply effective defaults", () => {
    const intent = resolveModelGoalSetIntent(
      { objective: "ship", budgetCents: null, turnCap: null },
      defaults
    );

    expect(intent.budgetCents).toBe(500);
    expect(intent.turnCap).toBe(4);
  });

  test("positive budget and turn cap override defaults", () => {
    const intent = resolveModelGoalSetIntent(
      { objective: "ship", budgetCents: 750, turnCap: 8 },
      defaults
    );

    expect(intent.budgetCents).toBe(750);
    expect(intent.turnCap).toBe(8);
  });

  test("applies the positive budget default even when user-authored goals may omit budgets", () => {
    const intent = resolveModelGoalSetIntent(
      { objective: "ship", budgetCents: null, turnCap: null },
      { ...defaults, alwaysRequireExplicitBudget: false, defaultTurnCap: null }
    );

    expect(intent.budgetCents).toBe(500);
    expect(intent.turnCap).toBeNull();
  });

  test("resolves to unbounded only when effective defaults have no positive budget or turn cap", () => {
    const intent = resolveModelGoalSetIntent(
      { objective: "ship", budgetCents: null, turnCap: null },
      {
        ...defaults,
        defaultBudgetCents: 0,
        defaultTurnCap: null,
        alwaysRequireExplicitBudget: false,
      }
    );

    expect(intent.budgetCents).toBeNull();
    expect(intent.turnCap).toBeNull();
  });
});

describe("mergeGoalDefaults", () => {
  const globalDefaults: GoalDefaults = {
    defaultBudgetCents: 200,
    defaultTurnCap: null,
    alwaysRequireExplicitBudget: true,
  };

  test("null override returns a copy of the global defaults", () => {
    const merged = mergeGoalDefaults(globalDefaults, null);
    expect(merged).toEqual(globalDefaults);
    expect(merged).not.toBe(globalDefaults);
  });

  test("all-null override is equivalent to inherit-all", () => {
    const override: WorkspaceGoalDefaultsOverride = {
      defaultBudgetCents: null,
      defaultTurnCap: null,
      alwaysRequireExplicitBudget: null,
    };
    expect(mergeGoalDefaults(globalDefaults, override)).toEqual(globalDefaults);
  });

  test("non-null override fields win over the global", () => {
    const override: WorkspaceGoalDefaultsOverride = {
      defaultBudgetCents: 1500,
      defaultTurnCap: 8,
      alwaysRequireExplicitBudget: false,
    };
    expect(mergeGoalDefaults(globalDefaults, override)).toEqual({
      defaultBudgetCents: 1500,
      defaultTurnCap: 8,
      alwaysRequireExplicitBudget: false,
    });
  });
});

const override = (
  fields: Partial<WorkspaceGoalDefaultsOverride>
): WorkspaceGoalDefaultsOverride => ({
  defaultBudgetCents: null,
  defaultTurnCap: null,
  alwaysRequireExplicitBudget: null,
  ...fields,
});

describe("canonicalGoalDefaultsOverride", () => {
  test("keeps set fields, including 0 and false", () => {
    expect(canonicalGoalDefaultsOverride(override({ defaultTurnCap: 5 }))).toEqual(
      override({ defaultTurnCap: 5 })
    );
    expect(
      canonicalGoalDefaultsOverride(
        override({ defaultBudgetCents: 0, alwaysRequireExplicitBudget: false })
      )
    ).toEqual(override({ defaultBudgetCents: 0, alwaysRequireExplicitBudget: false }));
  });

  test("is null when every field is null", () => {
    expect(canonicalGoalDefaultsOverride(override({}))).toBeNull();
  });
});

describe("sameGoalDefaultsOverride", () => {
  const next = canonicalGoalDefaultsOverride(override({ defaultBudgetCents: 500 }));

  test("matches a stored record with the same fields", () => {
    expect(sameGoalDefaultsOverride(override({ defaultBudgetCents: 500 }), next)).toBe(true);
  });

  test("differs when any field differs", () => {
    expect(sameGoalDefaultsOverride(override({ defaultBudgetCents: 400 }), next)).toBe(false);
    expect(
      sameGoalDefaultsOverride(override({ defaultBudgetCents: 500, defaultTurnCap: 3 }), next)
    ).toBe(false);
    expect(
      sameGoalDefaultsOverride(
        override({ defaultBudgetCents: 500, alwaysRequireExplicitBudget: true }),
        next
      )
    ).toBe(false);
  });

  test("clearing matches only when no record is stored", () => {
    expect(sameGoalDefaultsOverride(undefined, null)).toBe(true);
    expect(sameGoalDefaultsOverride(undefined, next)).toBe(false);
    expect(sameGoalDefaultsOverride(override({ defaultBudgetCents: 500 }), null)).toBe(false);
    // An all-null record is still a record: clearing removes it.
    expect(sameGoalDefaultsOverride(override({}), null)).toBe(false);
  });
});
