import { describe, expect, test } from "bun:test";
import { getCacheHealth } from "./cacheHealth";
import { createDisplayUsage } from "./displayUsage";
import { sumUsageHistory } from "./usageAggregator";

const MODEL = "anthropic:claude-sonnet-5-5";

function turn(opts: { uncached: number; read: number; write: number; write1h?: number }) {
  const usage = createDisplayUsage(
    {
      inputTokens: opts.uncached + opts.read + opts.write,
      cachedInputTokens: opts.read,
      outputTokens: 100,
    },
    MODEL,
    {
      anthropic: {
        cacheCreationInputTokens: opts.write,
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: opts.write - (opts.write1h ?? 0),
            ephemeral_1h_input_tokens: opts.write1h ?? 0,
          },
        },
      },
    }
  );
  if (usage === undefined) throw new Error("expected display usage");
  return getCacheHealth(usage);
}

describe("getCacheHealth", () => {
  test("flags a turn that rewrote most of its prompt as cold, not one that read it", () => {
    const cold = turn({ uncached: 1_000, read: 9_000, write: 40_000 });
    expect(cold.coldStart).toBe(true);
    expect(cold.readRatio).toBeCloseTo(9_000 / 50_000, 12);
    expect(cold.cacheWriteTokens).toBe(40_000);

    const warm = turn({ uncached: 1_000, read: 45_000, write: 4_000 });
    expect(warm.coldStart).toBe(false);
    expect(warm.readRatio).toBeCloseTo(0.9, 12);

    // Exactly half is not "more than half".
    expect(turn({ uncached: 0, read: 5_000, write: 5_000 }).coldStart).toBe(false);
  });

  test("rewrite cost follows the cache TTL the provider billed", () => {
    const fiveMinute = turn({ uncached: 1_000, read: 0, write: 20_000 });
    const oneHour = turn({ uncached: 1_000, read: 0, write: 20_000, write1h: 20_000 });
    expect(oneHour.rewriteCostUsd).toBeGreaterThan(fiveMinute.rewriteCostUsd ?? Infinity);
  });

  test("reports an unknown rewrite cost when any summed usage is unpriced", () => {
    const unpriced = createDisplayUsage(
      { inputTokens: 21_000, cachedInputTokens: 0, outputTokens: 100 },
      "custom:unpriced-model",
      { anthropic: { cacheCreationInputTokens: 20_000 } }
    );
    const priced = createDisplayUsage(
      { inputTokens: 21_000, cachedInputTokens: 0, outputTokens: 100 },
      MODEL,
      { anthropic: { cacheCreationInputTokens: 20_000 } }
    );
    if (unpriced === undefined || priced === undefined) throw new Error("expected usage");
    // The sum prices the unpriced writes at $0 and marks the total as incomplete.
    for (const parts of [[unpriced], [priced, unpriced]]) {
      const sum = sumUsageHistory(parts);
      if (sum === undefined) throw new Error("expected a sum");
      expect(getCacheHealth(sum).rewriteCostUsd).toBeUndefined();
    }
    expect(getCacheHealth(priced).rewriteCostUsd).toBeGreaterThan(0);
  });

  test("reports no read share for a turn without prompt tokens", () => {
    const empty = turn({ uncached: 0, read: 0, write: 0 });
    expect(empty.readRatio).toBeUndefined();
    expect(empty.coldStart).toBe(false);
  });
});
