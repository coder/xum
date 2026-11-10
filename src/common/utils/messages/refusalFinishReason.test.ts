import { describe, expect, test } from "bun:test";

import { readNoFallbackRefusalCategory } from "./refusalFinishReason";

const withCategory = (category: unknown) => ({
  anthropic: { stopDetails: { type: "refusal", category } },
});

describe("readNoFallbackRefusalCategory", () => {
  test("names the categories Anthropic gives no fallback", () => {
    expect(readNoFallbackRefusalCategory(withCategory("reasoning_extraction"))).toBe(
      "reasoning_extraction"
    );
  });

  test.each(["cyber", "bio", "frontier_llm", "general_harms", "a_future_category", null, 7])(
    "leaves category %p to the fallback chain",
    (category) => {
      expect(readNoFallbackRefusalCategory(withCategory(category))).toBeUndefined();
    }
  );

  test.each([
    undefined,
    null,
    "reasoning_extraction",
    {},
    { anthropic: null },
    { anthropic: { stopDetails: undefined } },
    { anthropic: { stopDetails: "reasoning_extraction" } },
    { openai: { stopDetails: { category: "reasoning_extraction" } } },
  ])("reads no category from metadata %p", (providerMetadata) => {
    expect(readNoFallbackRefusalCategory(providerMetadata)).toBeUndefined();
  });
});
