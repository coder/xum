import { describe, expect, it } from "bun:test";

import { applyAiSelectionIntentToPins, taskAiPinsToLayer } from "./agentAiSettings";

describe("taskAiPinsToLayer", () => {
  it("keeps valid pins and drops malformed fields", () => {
    expect(
      taskAiPinsToLayer({ model: "openai:gpt-5", thinkingLevel: "high", reasoningMode: "pro" })
    ).toEqual({ model: "openai:gpt-5", thinkingLevel: "high", reasoningMode: "pro" });
    expect(taskAiPinsToLayer({ model: "  ", thinkingLevel: "extreme", reasoningMode: 3 })).toEqual(
      {}
    );
    expect(taskAiPinsToLayer("not an object")).toEqual({});
  });

  it("leaves an omitted reasoning mode unpinned instead of defaulting to standard", () => {
    expect(taskAiPinsToLayer({ model: "openai:gpt-5" })).toEqual({ model: "openai:gpt-5" });
  });
});

describe("applyAiSelectionIntentToPins", () => {
  const sent = { model: "openai:gpt-5", thinkingLevel: "high" as const };

  it("pins a deliberate same-value pick", () => {
    const pins = {};
    expect(applyAiSelectionIntentToPins(pins, { model: true }, sent)).toEqual({
      model: "openai:gpt-5",
    });
  });

  it("pins only the intended fields and records an absent reasoning mode as standard", () => {
    expect(
      applyAiSelectionIntentToPins({ model: "anthropic:x" }, { reasoningMode: true }, sent)
    ).toEqual({ model: "anthropic:x", reasoningMode: "standard" });
  });

  it("is idempotent and returns the same reference when nothing changes", () => {
    const once = applyAiSelectionIntentToPins({}, { model: true, thinkingLevel: true }, sent);
    const twice = applyAiSelectionIntentToPins(once, { model: true, thinkingLevel: true }, sent);
    expect(twice).toBe(once);
    const untouched = { model: "anthropic:x" };
    expect(applyAiSelectionIntentToPins(untouched, {}, sent)).toBe(untouched);
  });
});
