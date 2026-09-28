import { describe, expect, test } from "bun:test";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { resolveContextStrategy, type ContextStrategySelection } from "./selection";

type Flags = NonNullable<Parameters<typeof resolveContextStrategy>[0]["experiments"]>;

const cases: Array<{
  name: string;
  flags: Flags;
  compact?: boolean;
  expected: ContextStrategySelection;
}> = [
  { name: "default", flags: {}, expected: { configured: "summarize" } },
  { name: "budget", flags: { tokenBudget: true }, expected: { configured: "token-budget" } },
  {
    name: "continuous",
    flags: { continuousCompaction: true },
    expected: { configured: "continuous" },
  },
  {
    name: "both flags",
    flags: { continuousCompaction: true, tokenBudget: true },
    expected: { configured: "continuous", tokenBudgetSuppressedBy: "continuous" },
  },
  {
    name: "RLM without its PTC parent",
    flags: { tokenBudget: true, rlm: true },
    expected: { configured: "token-budget" },
  },
  {
    name: "PTC without RLM",
    flags: { tokenBudget: true, programmaticToolCalling: true },
    expected: { configured: "token-budget" },
  },
  {
    name: "RLM suppresses saved budget selection",
    flags: { tokenBudget: true, rlm: true, programmaticToolCalling: true },
    expected: { configured: "token-budget", tokenBudgetSuppressedBy: "rlm" },
  },
  {
    name: "Continuous takes precedence over RLM",
    flags: {
      tokenBudget: true,
      continuousCompaction: true,
      rlm: true,
      programmaticToolCalling: true,
    },
    expected: { configured: "continuous", tokenBudgetSuppressedBy: "continuous" },
  },
  {
    name: "manual or idle compact suppresses budget",
    flags: { tokenBudget: true },
    compact: true,
    expected: { configured: "token-budget", tokenBudgetSuppressedBy: "compaction-request" },
  },
  {
    name: "Continuous suppression still wins on compact requests",
    flags: { tokenBudget: true, continuousCompaction: true },
    compact: true,
    expected: { configured: "continuous", tokenBudgetSuppressedBy: "continuous" },
  },
  {
    name: "RLM suppression still wins on compact requests",
    flags: { tokenBudget: true, rlm: true, programmaticToolCalling: true },
    compact: true,
    expected: { configured: "token-budget", tokenBudgetSuppressedBy: "rlm" },
  },
  {
    name: "no suppression when budget is not configured",
    flags: { rlm: true, programmaticToolCalling: true },
    compact: true,
    expected: { configured: "summarize" },
  },
];

function backendFlags(flags: Flags): (id: ExperimentId) => boolean {
  const values: Partial<Record<ExperimentId, boolean>> = {
    [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: flags.continuousCompaction,
    [EXPERIMENT_IDS.TOKEN_BUDGET]: flags.tokenBudget,
    [EXPERIMENT_IDS.RLM]: flags.rlm,
    [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: flags.programmaticToolCalling,
  };
  return (id) => values[id] === true;
}

describe("context strategy selection", () => {
  for (const source of ["request", "backend"] as const) {
    test.each(cases)(`${source}: $name`, ({ flags, compact, expected }) => {
      expect(
        resolveContextStrategy({
          experiments: source === "request" ? flags : undefined,
          isEnabled: backendFlags(source === "backend" ? flags : {}),
          isCompactionRequest: compact ?? false,
        })
      ).toEqual(expected);
    });
  }

  test.each([
    {
      flags: { continuousCompaction: false },
      expected: { configured: "token-budget", tokenBudgetSuppressedBy: "rlm" },
    },
    {
      flags: { continuousCompaction: false, rlm: false },
      expected: { configured: "token-budget" },
    },
    {
      flags: { continuousCompaction: false, programmaticToolCalling: false },
      expected: { configured: "token-budget" },
    },
    {
      flags: { continuousCompaction: false, tokenBudget: false },
      expected: { configured: "summarize" },
    },
    { flags: { tokenBudget: false }, expected: { configured: "continuous" } },
  ])("request overrides resolve per field: $flags", ({ flags, expected }) => {
    expect(
      resolveContextStrategy({
        experiments: flags,
        isEnabled: backendFlags({
          tokenBudget: true,
          continuousCompaction: true,
          rlm: true,
          programmaticToolCalling: true,
        }),
        isCompactionRequest: false,
      })
    ).toEqual(expected);
  });

  test("an empty request override preserves backend selection and later calls remain dynamic", () => {
    let tokenBudget = true;
    const input = {
      experiments: {},
      isEnabled: (id: ExperimentId) => id === EXPERIMENT_IDS.TOKEN_BUDGET && tokenBudget,
      isCompactionRequest: false,
    };
    expect(resolveContextStrategy(input)).toEqual({ configured: "token-budget" });
    tokenBudget = false;
    expect(resolveContextStrategy(input)).toEqual({ configured: "summarize" });
  });
});
