import { describe, expect, test } from "bun:test";

import { getTotalCost, getTotalTokens, sumUsageHistory } from "./usageAggregator";

describe("sumUsageHistory", () => {
  test("preserves hasUnknownCosts when an entry is approximate but still has numeric costs", () => {
    const result = sumUsageHistory([
      {
        input: { tokens: 200000, cost_usd: 0.5 },
        cached: { tokens: 100000, cost_usd: 0.025 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 1000, cost_usd: 0.015 },
        reasoning: { tokens: 0, cost_usd: 0 },
        hasUnknownCosts: true,
      },
      {
        input: { tokens: 1000, cost_usd: 0.0025 },
        cached: { tokens: 0, cost_usd: 0 },
        cacheCreate: { tokens: 0, cost_usd: 0 },
        output: { tokens: 100, cost_usd: 0.0015 },
        reasoning: { tokens: 0, cost_usd: 0 },
      },
    ]);

    expect(result).toBeDefined();
    expect(result?.hasUnknownCosts).toBe(true);
    expect(getTotalCost(result)).toBeCloseTo(0.544);
  });
});

describe("getTotalTokens", () => {
  test("sums tokens across all five components", () => {
    expect(
      getTotalTokens({
        input: { tokens: 100 },
        cached: { tokens: 20 },
        cacheCreate: { tokens: 5 },
        output: { tokens: 10 },
        reasoning: { tokens: 3 },
      })
    ).toBe(138);
  });

  test("returns 0 for undefined usage", () => {
    expect(getTotalTokens(undefined)).toBe(0);
  });
});
