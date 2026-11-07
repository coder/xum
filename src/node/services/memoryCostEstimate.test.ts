import { describe, expect, it } from "bun:test";

import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import { defaultModel } from "@/common/utils/ai/models";
import { MEMORY_ANALYZER_MAX_STEPS } from "@/common/constants/memory";
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

  // A prompt token is billed by every step, at the uncached input rate: the provider's prompt cache
  // may miss, so the estimate takes no discount for it. The first step may instead write the prompt
  // to the cache (Anthropic charges 1.25x input for that), so it prices at the higher of the two.
  // The slope of the estimate in the prompt size is that sum, whatever the rest of the estimate holds.
  it.each(["anthropic:claude-sonnet-5-5", "google:gemini-3-pro-preview"])(
    "bills each prompt token at the uncached rate on every step, and at the cache-write rate on the first if higher on %s",
    (pricingModel) => {
      const stats = getModelStats(pricingModel);
      const input = stats?.input_cost_per_token ?? 0;
      const firstStepRate = Math.max(input, stats?.cache_creation_input_token_cost ?? 0);
      // The cache would discount every resent token on these models, so a bound that took the
      // discount would price below the slope asserted here.
      expect(stats?.cache_read_input_token_cost).toBeLessThan(input);
      const [small, large] = [40_000, 80_000];
      const estimate = (chars: number) =>
        estimateAnalyzerUpperBoundUsd({ pricingModel, chunkInputChars: [chars], memoryChars: 0 }) ??
        0;

      const perToken =
        (estimate(large) - estimate(small)) / ((large - small) / APPROX_CHARS_PER_TOKEN);

      expect(perToken).toBeCloseTo(firstStepRate + (MEMORY_ANALYZER_MAX_STEPS - 1) * input, 9);
    }
  );

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

describe("service tier", () => {
  // gpt-6.1-sol's published tiers, as multiples of its Standard rates: Fast (priority) 2x, Flex
  // 0.5x, Ultrafast 6x. A reported "default" or "auto" bills at Standard.
  const MODEL = "openai:gpt-6.1-sol";
  const analyzer = (serviceTier?: ServiceTier) =>
    estimateAnalyzerUpperBoundUsd({
      pricingModel: MODEL,
      chunkInputChars: [8_000, 20_000],
      memoryChars: 30_000,
      serviceTier,
    }) ?? 0;
  const organizer = (serviceTier?: ServiceTier) =>
    estimateOrganizerUpperBoundUsd({
      pricingModel: MODEL,
      systemPromptChars: 12_000,
      memoryChars: 30_000,
      serviceTier,
    }) ?? 0;

  it.each<[ServiceTier, number]>([
    ["priority", 2],
    ["flex", 0.5],
    ["ultrafast", 6],
    ["default", 1],
    ["auto", 1],
  ])("prices a run on the %s tier at %dx its Standard estimate", (serviceTier, factor) => {
    expect(analyzer()).toBeGreaterThan(0);
    expect(analyzer(serviceTier)).toBeCloseTo(factor * analyzer(), 9);
    expect(organizer(serviceTier)).toBeCloseTo(factor * organizer(), 9);
  });

  it("applies the tier to the long-context rates too (a prompt over the 272k threshold)", () => {
    const longPrompt = (serviceTier?: ServiceTier) =>
      estimateOrganizerUpperBoundUsd({
        pricingModel: MODEL,
        systemPromptChars: 12_000,
        memoryChars: 400_000 * APPROX_CHARS_PER_TOKEN,
        serviceTier,
      }) ?? 0;
    expect(longPrompt("priority")).toBeCloseTo(2 * longPrompt(), 6);
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

  it("prices the same workload at no less than its recorded cost", () => {
    const recordedUsd = getTotalCost(createDisplayUsage(RECORDED_USAGE, MODEL)) ?? 0;
    const estimate =
      estimateOrganizerUpperBoundUsd({
        pricingModel: MODEL,
        systemPromptChars: SYSTEM_PROMPT_CHARS,
        memoryChars,
      }) ?? 0;

    expect(recordedUsd).toBeGreaterThan(0);
    // An upper bound must not fall under what the run billed. It is not held near that bill: the
    // recorded run was 93% cache hits, and the estimate takes none, so it sits about ten times over.
    expect(estimate).toBeGreaterThanOrEqual(recordedUsd);
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

  it("never prints an estimate over the ceiling as equal to it", () => {
    const check = checkCostCeiling({
      ceilingUsd: 1,
      estimatedUsd: 1.001,
      pricingModel: defaultModel,
    });
    expect(check.allowed).toBe(false);
    // Rounding to nearest would print 1.00 against a 1.00 ceiling, a refusal that reads as a mistake.
    if (!check.allowed) expect(check.reason).toContain("estimate 1.01 USD");
  });

  // 1.1, 0.07 and 0.14 times 100 come out a hair over a whole number, so rounding them up print a cent too many.
  it.each([
    [1.1, "1.10"],
    [0.07, "0.07"],
    [0.14, "0.14"],
  ])("prints a %d ceiling as the user set it", (ceilingUsd, printed) => {
    const refused = checkCostCeiling({ ceilingUsd, estimatedUsd: 50, pricingModel: defaultModel });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.reason).toContain(`over the ${printed} USD ceiling`);

    const unpriced = checkCostCeiling({
      ceilingUsd,
      estimatedUsd: undefined,
      pricingModel: UNPRICED_MODEL,
    });
    expect(unpriced.allowed).toBe(false);
    if (!unpriced.allowed) expect(unpriced.reason).toContain(`the ${printed} USD ceiling`);
  });

  it.each([
    [1.1, "1.10"],
    [0.07, "0.07"],
    [0.14, "0.14"],
    [1.1000001, "1.11"],
  ])("prints an estimate of %d as %s: up, but not past an exact cent", (estimatedUsd, printed) => {
    const check = checkCostCeiling({
      ceilingUsd: 0.01,
      estimatedUsd,
      pricingModel: defaultModel,
    });
    expect(check.allowed).toBe(false);
    if (!check.allowed) expect(check.reason).toContain(`estimate ${printed} USD`);
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
