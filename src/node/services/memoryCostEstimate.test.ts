import { describe, expect, it } from "bun:test";

import { defaultModel } from "@/common/utils/ai/models";
import { MEMORY_CONSOLIDATION_MAX_STEPS } from "@/common/constants/memory";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { APPROX_CHARS_PER_TOKEN } from "@/constants/streaming";
import {
  checkCostCeiling,
  estimateAnalyzerUpperBoundUsd,
  estimateOrganizerUpperBoundUsd,
} from "./memoryCostEstimate";

const UNPRICED_MODEL = "ollama:no-such-model";

describe("estimateAnalyzerUpperBoundUsd", () => {
  const priced = (chunkInputChars: number[], memoryChars = 0) =>
    estimateAnalyzerUpperBoundUsd({ pricingModel: defaultModel, chunkInputChars, memoryChars });

  it("costs a job of two chunks as the two chunks run apart", () => {
    expect(priced([8_000, 20_000])).toBeCloseTo((priced([8_000]) ?? 0) + (priced([20_000]) ?? 0));
  });

  it("grows with the memory a step may read and with the size of the chunk", () => {
    const base = priced([8_000]) ?? 0;
    expect(base).toBeGreaterThan(0);
    expect(priced([8_000], 100_000) ?? 0).toBeGreaterThan(base);
    expect(priced([40_000]) ?? 0).toBeGreaterThan(base);
  });

  it("has no estimate for a model with no known price", () => {
    expect(
      estimateAnalyzerUpperBoundUsd({
        pricingModel: UNPRICED_MODEL,
        chunkInputChars: [8_000],
        memoryChars: 0,
      })
    ).toBeUndefined();
  });
});

describe("estimateOrganizerUpperBoundUsd", () => {
  it("grows with the memory the run may read", () => {
    const estimate = (memoryChars: number) =>
      estimateOrganizerUpperBoundUsd({
        pricingModel: defaultModel,
        systemPromptChars: 5_000,
        memoryChars,
      }) ?? 0;
    expect(estimate(0)).toBeGreaterThan(0);
    expect(estimate(100_000)).toBeGreaterThan(estimate(0));
  });
});

describe("calibration against a recorded dream", () => {
  // The one real dream recorded on this host: openai:gpt-6.1-sol, archive trigger, 8 ops. Its
  // cached input is 14 of 15 equal prompts (1,023,197 / 14 = 73,085; 1,096,238 / 15 = 73,083), so it
  // ran 15 steps over a prompt of about 73k tokens, the system prompt and the memory it read.
  const MODEL = "openai:gpt-6.1-sol";
  const RECORDED_USAGE = {
    inputTokens: 1_096_238,
    cachedInputTokens: 1_023_197,
    outputTokens: 4_033,
  };
  const SYSTEM_PROMPT_CHARS = 12_000;
  const memoryChars =
    Math.round(RECORDED_USAGE.inputTokens / 15) * APPROX_CHARS_PER_TOKEN - SYSTEM_PROMPT_CHARS;

  it("prices the same workload within 3x of its recorded cost, and not under it", () => {
    const recordedUsd = getTotalCost(createDisplayUsage(RECORDED_USAGE, MODEL)) ?? 0;
    const estimate =
      estimateOrganizerUpperBoundUsd({
        pricingModel: MODEL,
        systemPromptChars: SYSTEM_PROMPT_CHARS,
        memoryChars,
      }) ?? 0;

    expect(recordedUsd).toBeGreaterThan(0);
    // An upper bound: it must not fall under what the run billed.
    expect(estimate).toBeGreaterThanOrEqual(recordedUsd);
    // Pricing all 32 steps at the full input rate came to about 9x.
    expect(estimate).toBeLessThanOrEqual(3 * recordedUsd);
  });

  it("keeps the resent prefix at the full input rate for a priced model with no cache-read rate", () => {
    // A cached token with no rate would price at zero, leaving only the first step's prompt.
    const uncached = "openai:chatgpt-4o-latest";
    const stats = getModelStats(uncached);
    expect(stats?.cache_read_input_token_cost).toBeUndefined();
    const promptTokens = Math.round(RECORDED_USAGE.inputTokens / 15);
    const estimate = estimateOrganizerUpperBoundUsd({
      pricingModel: uncached,
      systemPromptChars: SYSTEM_PROMPT_CHARS,
      memoryChars,
    });

    expect(estimate).toBeGreaterThan(
      MEMORY_CONSOLIDATION_MAX_STEPS * promptTokens * (stats?.input_cost_per_token ?? 0)
    );
  });
});

describe("checkCostCeiling", () => {
  it("allows every run when no ceiling is set, even one with no estimate", () => {
    for (const estimatedUsd of [0.5, 1_000, undefined]) {
      expect(
        checkCostCeiling({ ceilingUsd: undefined, estimatedUsd, pricingModel: UNPRICED_MODEL })
      ).toEqual({ allowed: true });
    }
  });

  it("allows an estimate at or under the ceiling", () => {
    for (const estimatedUsd of [0.4, 1]) {
      expect(checkCostCeiling({ ceilingUsd: 1, estimatedUsd, pricingModel: defaultModel })).toEqual(
        {
          allowed: true,
        }
      );
    }
  });

  it("refuses an estimate over the ceiling with both amounts in the reason", () => {
    const check = checkCostCeiling({
      ceilingUsd: 1,
      estimatedUsd: 3.199,
      pricingModel: defaultModel,
    });
    expect(check.allowed).toBe(false);
    // Rounded up, so a refusal never prints the estimate as equal to the ceiling.
    if (!check.allowed) expect(check.reason).toContain("estimate 3.20 USD");
    if (!check.allowed) expect(check.reason).toContain("over the 1.00 USD ceiling");
  });

  it("refuses a model with no known price once a ceiling is set, and names the model", () => {
    const check = checkCostCeiling({
      ceilingUsd: 1,
      estimatedUsd: undefined,
      pricingModel: UNPRICED_MODEL,
    });
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toContain(UNPRICED_MODEL);
  });
});
