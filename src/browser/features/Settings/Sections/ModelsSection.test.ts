import { describe, expect, test } from "bun:test";
import type { ThinkingLevel } from "@/common/types/thinking";
import { replaceEditedModelEntry, shouldAllowRouteOverrideInSettings } from "./ModelsSection";

describe("shouldAllowRouteOverrideInSettings", () => {
  test("disables route overrides for explicit gateway rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openrouter:openai/gpt-5")).toBe(false);
  });

  test("keeps route overrides enabled for canonical rows", () => {
    expect(shouldAllowRouteOverrideInSettings("openai:gpt-5")).toBe(true);
  });

  test("keeps route overrides enabled for direct custom providers", () => {
    expect(shouldAllowRouteOverrideInSettings("ollama:gpt-oss:20b")).toBe(true);
  });
});

describe("replaceEditedModelEntry", () => {
  // thinkingLevels has no editor in Settings, so an edit must not drop it.
  test("keeps the edited entry's thinkingLevels", () => {
    const models = [
      "other",
      { id: "qwen", thinkingLevels: ["off", "high"] satisfies ThinkingLevel[] },
    ];
    const edited = (contextWindowTokens: number | null) =>
      replaceEditedModelEntry(models, "qwen", {
        modelId: "qwen-renamed",
        contextWindowTokens,
        mappedToModel: null,
      });

    expect(edited(32768)).toEqual([
      "other",
      { id: "qwen-renamed", contextWindowTokens: 32768, thinkingLevels: ["off", "high"] },
    ]);
    // With no other override the entry must stay an object, not collapse to a string.
    expect(edited(null)).toEqual([
      "other",
      { id: "qwen-renamed", thinkingLevels: ["off", "high"] },
    ]);
  });
});
