import { describe, expect, test } from "bun:test";

import { getTotalCost, sumUsageHistory } from "./usageAggregator";

describe("sumUsageHistory", () => {
  test("clamps each entry's 1h share to its own cache writes before summing", () => {
    const row = (cacheCreateTokens: number, cacheCreate1hTokens?: number) => ({
      input: { tokens: 0, cost_usd: 0 },
      cached: { tokens: 0, cost_usd: 0 },
      cacheCreate: { tokens: cacheCreateTokens, cost_usd: 0 },
      output: { tokens: 0, cost_usd: 0 },
      reasoning: { tokens: 0, cost_usd: 0 },
      ...(cacheCreate1hTokens !== undefined ? { cacheCreate1hTokens } : {}),
    });
    // A malformed row claims 100 1h tokens of its 10 writes; a later row has 90 5m writes.
    expect(sumUsageHistory([row(10, 100), row(90)])?.cacheCreate1hTokens).toBe(10);
    expect(sumUsageHistory([row(10, -5), row(90)])?.cacheCreate1hTokens).toBeUndefined();
  });

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
