import { describe, expect, test } from "bun:test";
import { shouldAllowRouteOverrideInSettings } from "./ModelsSection";

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
