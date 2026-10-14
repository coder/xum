import { describe, expect, test } from "bun:test";
import { getCacheHealth } from "./cacheHealth";
import { createDisplayUsage } from "./displayUsage";
import { getAssistantMessageModelUsages } from "./messageModelUsages";
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
  return getCacheHealth([{ usage }]);
}

function display(model: string, write: number) {
  const usage = createDisplayUsage(
    { inputTokens: 1_000 + write, cachedInputTokens: 0, outputTokens: 100 },
    model,
    { anthropic: { cacheCreationInputTokens: write } }
  );
  if (usage === undefined) throw new Error("expected display usage");
  return usage;
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
      expect(getCacheHealth([{ usage: sum }]).rewriteCostUsd).toBeUndefined();
    }
    expect(getCacheHealth([{ usage: priced }]).rewriteCostUsd).toBeGreaterThan(0);
  });

  test("an unpriced part that wrote no cache tokens keeps a known rewrite cost", () => {
    const priced = display(MODEL, 20_000);
    const unpricedWithoutWrites = display("custom:unpriced-model", 0);
    const pricedCost = getCacheHealth([{ usage: priced }]).rewriteCostUsd;
    expect(pricedCost).toBeGreaterThan(0);
    // Per request (turn rows) and as summed per-model buckets (the session summary).
    const bucket = sumUsageHistory([unpricedWithoutWrites, unpricedWithoutWrites]);
    if (bucket === undefined) throw new Error("expected a bucket");
    expect(bucket.hasUnknownCosts).toBe(true);
    for (const unpriced of [unpricedWithoutWrites, bucket]) {
      expect(getCacheHealth([{ usage: priced }, { usage: unpriced }]).rewriteCostUsd).toBeCloseTo(
        pricedCost ?? NaN,
        12
      );
    }
    // An unpriced part that did write keeps the cost unknown.
    expect(
      getCacheHealth([{ usage: priced }, { usage: display("custom:unpriced-model", 5_000) }])
        .rewriteCostUsd
    ).toBeUndefined();
  });

  test("ignores a malformed raw input count instead of reading it as legacy input", () => {
    const usage = createDisplayUsage(
      { inputTokens: 10_000, cachedInputTokens: 9_000, outputTokens: 10 },
      MODEL,
      { anthropic: { cacheCreationInputTokens: 1_000 } }
    );
    if (usage === undefined) throw new Error("expected display usage");
    const health = getCacheHealth([{ usage, rawInputTokens: -50_000 }]);
    // The clamped display input (0) stands: 9k read of a 10k prompt.
    expect(health.readRatio).toBeCloseTo(0.9, 12);
    expect(getCacheHealth([{ usage, rawInputTokens: Number.NaN }])).toEqual(health);
  });

  test("reads a pre-AI-SDK-v6 row's uncached input from its raw usage", () => {
    // Before v6, Anthropic's inputTokens excluded cache tokens: 9k uncached, 1k read, 9.5k written.
    const legacyRow = {
      model: "anthropic:claude-sonnet-4-5",
      usage: {
        inputTokens: 9_000,
        cachedInputTokens: 1_000,
        outputTokens: 10,
        totalTokens: 19_510,
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 9_500 } },
    };
    const health = getCacheHealth(getAssistantMessageModelUsages(legacyRow));
    expect(health.readRatio).toBeCloseTo(1_000 / 19_500, 12);
    // 9.5k of 19.5k prompt tokens is under half: not a cold start.
    expect(health.coldStart).toBe(false);
    // The same counts in the v6 shape (inputTokens includes cache tokens) read as before.
    const v6Row = { ...legacyRow, usage: { ...legacyRow.usage, inputTokens: 19_500 } };
    expect(getCacheHealth(getAssistantMessageModelUsages(v6Row))).toEqual(health);
  });

  test("reports no read share for a turn without prompt tokens", () => {
    const empty = turn({ uncached: 0, read: 0, write: 0 });
    expect(empty.readRatio).toBeUndefined();
    expect(empty.coldStart).toBe(false);
  });
});
