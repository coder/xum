import { describe, expect, test } from "bun:test";

import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import {
  AUTO_COMPACTION_THRESHOLD_EFFECTIVE_MIN_PERCENT,
  DEFAULT_AUTO_COMPACTION_THRESHOLD,
} from "@/common/constants/ui";

import { resolveAutoCompactionThreshold } from "./autoCompactionThreshold";

const model = "anthropic:claude-sonnet-4-5";

function preferences(thresholds: Record<string, unknown>): UserPreferences {
  // Corrupt on-disk values bypass the schema on purpose; the resolver must still cope.
  const ai: NonNullable<UserPreferences["ai"]> = {
    autoCompactionThresholdByModel: thresholds as Record<string, number>,
  };
  return { ai };
}

describe("resolveAutoCompactionThreshold", () => {
  test("uses the persisted per-model percent as a fraction", () => {
    expect(resolveAutoCompactionThreshold(preferences({ [model]: 55 }), model)).toBe(0.55);
  });

  test("falls back to the default when preferences or the model entry are missing", () => {
    expect(resolveAutoCompactionThreshold(undefined, model)).toBe(
      DEFAULT_AUTO_COMPACTION_THRESHOLD
    );
    expect(resolveAutoCompactionThreshold({}, model)).toBe(DEFAULT_AUTO_COMPACTION_THRESHOLD);
    expect(resolveAutoCompactionThreshold(preferences({ "other:model": 40 }), model)).toBe(
      DEFAULT_AUTO_COMPACTION_THRESHOLD
    );
  });

  test("100 disables compaction (threshold 1)", () => {
    expect(resolveAutoCompactionThreshold(preferences({ [model]: 100 }), model)).toBe(1);
  });

  test.each([
    ["NaN", Number.NaN],
    ["negative", -5],
    ["above storage max", 250],
    ["string", "70"],
    ["null", null],
  ])("corrupt value (%s) falls back to the default without throwing", (_label, value) => {
    expect(resolveAutoCompactionThreshold(preferences({ [model]: value }), model)).toBe(
      DEFAULT_AUTO_COMPACTION_THRESHOLD
    );
  });

  test("clamps tiny values to the minimum fraction the UI allows", () => {
    expect(resolveAutoCompactionThreshold(preferences({ [model]: 0 }), model)).toBe(
      AUTO_COMPACTION_THRESHOLD_EFFECTIVE_MIN_PERCENT / 100
    );
  });

  test("models are independent", () => {
    const prefs = preferences({ [model]: 100, "openai:gpt-5": 30 });
    expect(resolveAutoCompactionThreshold(prefs, model)).toBe(1);
    expect(resolveAutoCompactionThreshold(prefs, "openai:gpt-5")).toBe(0.3);
  });

  test("rejects an empty model", () => {
    expect(() => resolveAutoCompactionThreshold(undefined, "")).toThrow();
  });
});
