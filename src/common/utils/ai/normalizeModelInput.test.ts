import { describe, expect, it } from "bun:test";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

import { normalizeModelInput } from "./normalizeModelInput";

describe("normalizeModelInput", () => {
  it("resolves every known model alias and marks it as an alias", () => {
    for (const [alias, model] of Object.entries(MODEL_ABBREVIATIONS)) {
      expect(normalizeModelInput(alias)).toEqual({
        model,
        isAlias: true,
      });
    }
  });

  it("preserves explicit gateway-scoped model strings for the backend", () => {
    expect(normalizeModelInput("openrouter:openai/gpt-5")).toEqual({
      model: "openrouter:openai/gpt-5",
      isAlias: false,
    });
    expect(normalizeModelInput("mux-gateway:anthropic/claude-sonnet-4-6")).toEqual({
      model: "mux-gateway:anthropic/claude-sonnet-4-6",
      isAlias: false,
    });
  });

  it("returns null for null and empty inputs", () => {
    expect(normalizeModelInput(null)).toEqual({ model: null, isAlias: false });
    expect(normalizeModelInput("")).toEqual({ model: null, isAlias: false });
    expect(normalizeModelInput("   ")).toEqual({ model: null, isAlias: false });
  });

  it("rejects malformed provider:model strings that would otherwise slip past the first colon check", () => {
    expect(normalizeModelInput("openai::gpt-5")).toEqual({
      model: null,
      isAlias: false,
      error: "invalid-format",
    });
  });
});
