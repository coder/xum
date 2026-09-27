import { describe, test, expect } from "bun:test";
import {
  addUsage,
  accumulateProviderMetadata,
  accumulateStepsProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
} from "./usageHelpers";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

describe("normalizeUsage", () => {
  test("maps AI SDK 7 nested details to the flat persisted shape", () => {
    expect(
      normalizeUsage({
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 },
        outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
      })
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      reasoningTokens: 50,
      cachedInputTokens: 700,
    });
  });

  test("passes already-flat (persisted v6) usage through unchanged", () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        reasoningTokens: 10,
        cachedInputTokens: 20,
      })
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 10,
      cachedInputTokens: 20,
    });
  });

  test("prefers nested details over stale flat fields", () => {
    const normalized = normalizeUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      reasoningTokens: 1,
      cachedInputTokens: 2,
      inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 45, reasoningTokens: 5 },
    });
    expect(normalized.reasoningTokens).toBe(5);
    expect(normalized.cachedInputTokens).toBe(40);
  });

  test("returns undefined for undefined usage", () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
  });
});

describe("withCacheWriteMetadata", () => {
  test("injects anthropic.cacheCreationInputTokens from v7 usage", () => {
    expect(
      withCacheWriteMetadata(
        { anthropic: { usage: { foo: 1 } } },
        { inputTokenDetails: { cacheWriteTokens: 321 } }
      )
    ).toEqual({
      anthropic: { usage: { foo: 1 }, cacheCreationInputTokens: 321 },
    });
  });

  test("creates metadata when none exists and cache writes are reported", () => {
    expect(
      withCacheWriteMetadata(undefined, { inputTokenDetails: { cacheWriteTokens: 5 } })
    ).toEqual({ anthropic: { cacheCreationInputTokens: 5 } });
  });

  test("no-ops when the usage reports no cache writes", () => {
    const metadata = { openai: { responseId: "resp_1" } };
    expect(withCacheWriteMetadata(metadata, { inputTokens: 10 })).toBe(metadata);
    expect(withCacheWriteMetadata(undefined, undefined)).toBeUndefined();
  });
});

describe("addUsage", () => {
  test("sums all fields when both arguments have values", () => {
    const a: LanguageModelV2Usage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 20,
      reasoningTokens: 10,
    };
    const b: LanguageModelV2Usage = {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cachedInputTokens: 30,
      reasoningTokens: 15,
    };

    expect(addUsage(a, b)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cachedInputTokens: 50,
      reasoningTokens: 25,
    });
  });

  test("handles undefined first argument", () => {
    const b: LanguageModelV2Usage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };

    expect(addUsage(undefined, b)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("handles sparse usage objects (missing fields treated as 0)", () => {
    // Simulating sparse SDK responses where not all fields are present
    // Using Partial to represent incomplete usage data from the SDK
    const a: Partial<LanguageModelV2Usage> = { inputTokens: 100 };
    const b: Partial<LanguageModelV2Usage> = { outputTokens: 50 };

    expect(addUsage(a as LanguageModelV2Usage, b as LanguageModelV2Usage)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("handles zero values correctly", () => {
    const a: LanguageModelV2Usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
    const b: LanguageModelV2Usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };

    expect(addUsage(a, b)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  test("accumulates across multiple calls (simulating multi-step)", () => {
    let cumulative: LanguageModelV2Usage | undefined = undefined;

    // Step 1
    cumulative = addUsage(cumulative, { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
    expect(cumulative.inputTokens).toBe(1000);
    expect(cumulative.outputTokens).toBe(100);

    // Step 2
    cumulative = addUsage(cumulative, { inputTokens: 1200, outputTokens: 150, totalTokens: 1350 });
    expect(cumulative.inputTokens).toBe(2200);
    expect(cumulative.outputTokens).toBe(250);

    // Step 3
    cumulative = addUsage(cumulative, { inputTokens: 1500, outputTokens: 200, totalTokens: 1700 });
    expect(cumulative.inputTokens).toBe(3700);
    expect(cumulative.outputTokens).toBe(450);
  });
});

describe("accumulateProviderMetadata", () => {
  test("returns undefined when both arguments are undefined", () => {
    expect(accumulateProviderMetadata(undefined, undefined)).toBeUndefined();
  });

  test("returns existing when step is undefined", () => {
    const existing = { anthropic: { cacheCreationInputTokens: 100 } };
    expect(accumulateProviderMetadata(existing, undefined)).toBe(existing);
  });

  test("returns step when existing is undefined", () => {
    const step = { anthropic: { cacheCreationInputTokens: 50 } };
    expect(accumulateProviderMetadata(undefined, step)).toBe(step);
  });

  test("returns step when neither has cache creation tokens", () => {
    const existing = { anthropic: { cacheReadInputTokens: 100 } };
    const step = { anthropic: { cacheReadInputTokens: 200 } };
    expect(accumulateProviderMetadata(existing, step)).toBe(step);
  });

  test("keeps the costliest reported OpenAI service tier across steps (#4352)", () => {
    // A ramp downgrade mid-turn: the aggregate must not price earlier Fast steps at Standard.
    const downgraded = accumulateProviderMetadata(
      { openai: { serviceTier: "priority", responseId: "resp_1" } },
      { openai: { serviceTier: "default", responseId: "resp_2" } }
    );
    expect(downgraded).toEqual({ openai: { serviceTier: "priority", responseId: "resp_2" } });

    const upgradedFromFlex = { openai: { serviceTier: "default", responseId: "resp_4" } };
    expect(
      accumulateProviderMetadata(
        { openai: { serviceTier: "flex", responseId: "resp_3" } },
        upgradedFromFlex
      )
    ).toBe(upgradedFromFlex);
  });

  test("sums cache creation tokens when both have them", () => {
    const existing = { anthropic: { cacheCreationInputTokens: 100 } };
    const step = { anthropic: { cacheCreationInputTokens: 50 } };

    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      anthropic: { cacheCreationInputTokens: 150 },
    });
  });

  test("preserves step cache tokens when existing has none", () => {
    const existing = { anthropic: { cacheReadInputTokens: 100 } };
    const step = { anthropic: { cacheCreationInputTokens: 50, cacheReadInputTokens: 200 } };

    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      anthropic: { cacheCreationInputTokens: 50, cacheReadInputTokens: 200 },
    });
  });

  test("preserves other anthropic fields when merging", () => {
    const existing = { anthropic: { cacheCreationInputTokens: 100 } };
    const step = {
      anthropic: {
        cacheCreationInputTokens: 50,
        cacheReadInputTokens: 200,
        modelId: "claude-sonnet-4-5",
      },
    };

    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      anthropic: {
        cacheCreationInputTokens: 150,
        cacheReadInputTokens: 200,
        modelId: "claude-sonnet-4-5",
      },
    });
  });

  test("sums xAI exact cost ticks across model steps", () => {
    const existing = { xai: { costInUsdTicks: 10_000_000 } };
    const step = { xai: { costInUsdTicks: 25_000_000, requestId: "req_2" } };

    expect(accumulateProviderMetadata(existing, step)).toEqual({
      xai: { costInUsdTicks: 35_000_000, requestId: "req_2" },
    });
  });

  test("handles non-anthropic providers (returns step as-is when no cache tokens)", () => {
    const existing = { openai: { reasoningTokens: 100 } };
    const step = { openai: { reasoningTokens: 200 } };

    // No cache creation tokens, so returns step
    expect(accumulateProviderMetadata(existing, step)).toBe(step);
  });

  test("preserves non-anthropic provider fields alongside anthropic", () => {
    const existing = {
      anthropic: { cacheCreationInputTokens: 100 },
      openai: { reasoningTokens: 50 },
    };
    const step = {
      anthropic: { cacheCreationInputTokens: 50, cacheReadInputTokens: 200 },
      openai: { reasoningTokens: 100 },
    };

    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      anthropic: { cacheCreationInputTokens: 150, cacheReadInputTokens: 200 },
      openai: { reasoningTokens: 100 }, // From step, not accumulated
    });
  });

  test("accumulates across multiple steps (simulating multi-step tool calls)", () => {
    let cumulative: Record<string, unknown> | undefined = undefined;

    // Step 1: Initial cache creation
    cumulative = accumulateProviderMetadata(cumulative, {
      anthropic: { cacheCreationInputTokens: 1000, cacheReadInputTokens: 0 },
    });
    expect(
      (cumulative?.anthropic as { cacheCreationInputTokens: number }).cacheCreationInputTokens
    ).toBe(1000);

    // Step 2: More cache creation
    cumulative = accumulateProviderMetadata(cumulative, {
      anthropic: { cacheCreationInputTokens: 500, cacheReadInputTokens: 800 },
    });
    expect(
      (cumulative?.anthropic as { cacheCreationInputTokens: number }).cacheCreationInputTokens
    ).toBe(1500);

    // Step 3: No cache creation (reading from cache)
    cumulative = accumulateProviderMetadata(cumulative, {
      anthropic: { cacheCreationInputTokens: 0, cacheReadInputTokens: 1200 },
    });
    // Total should still be 1500 (0 + existing 1500)
    expect(
      (cumulative?.anthropic as { cacheCreationInputTokens: number }).cacheCreationInputTokens
    ).toBe(1500);
  });

  test("handles missing anthropic field in existing", () => {
    const existing = { someOtherProvider: { field: "value" } };
    const step = { anthropic: { cacheCreationInputTokens: 50 } };

    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      anthropic: { cacheCreationInputTokens: 50 },
    });
  });

  test("handles missing anthropic field in step (returns step)", () => {
    const existing = { anthropic: { cacheCreationInputTokens: 100 } };
    const step = { someOtherProvider: { field: "value" } };

    // No cache creation in step means total is 100 (from existing)
    // But step has no anthropic, so stepCacheCreate=0, existingCacheCreate=100
    // total=100, which is > 0, so we merge
    const result = accumulateProviderMetadata(existing, step);
    expect(result).toEqual({
      someOtherProvider: { field: "value" },
      anthropic: { cacheCreationInputTokens: 100 },
    });
  });
});

describe("accumulateStepsProviderMetadata", () => {
  test("returns undefined for streams that never reported metadata", () => {
    expect(accumulateStepsProviderMetadata([])).toBeUndefined();
    expect(accumulateStepsProviderMetadata([{}, {}])).toBeUndefined();
  });

  test("sums cache-write tokens across steps (last-step metadata alone would drop them)", () => {
    const result = accumulateStepsProviderMetadata([
      { providerMetadata: { anthropic: { cacheCreationInputTokens: 1000 } } },
      { providerMetadata: { anthropic: { cacheCreationInputTokens: 500 } } },
      // Final step reads from cache only — its own metadata reports 0 writes.
      { providerMetadata: { anthropic: { cacheCreationInputTokens: 0 } } },
    ]);
    expect(
      (result?.anthropic as { cacheCreationInputTokens: number }).cacheCreationInputTokens
    ).toBe(1500);
  });

  test("keeps earlier metadata when a later step reports none", () => {
    const result = accumulateStepsProviderMetadata([
      { providerMetadata: { anthropic: { cacheCreationInputTokens: 300 } } },
      {},
    ]);
    expect(
      (result?.anthropic as { cacheCreationInputTokens: number }).cacheCreationInputTokens
    ).toBe(300);
  });
});
