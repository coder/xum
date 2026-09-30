import { describe, expect, test } from "bun:test";
import { buildModelFallbackTooltipLines } from "./ModelFallbackBadge";

// Tooltip copy is rendered through a Radix portal that happy-dom can't observe,
// so the line-building behavior (ordering, hop handling, defensive fallback) is
// tested directly. Assertions use model display names, not full sentences, so
// copy tweaks don't break them.
describe("buildModelFallbackTooltipLines", () => {
  test("multi-hop chain yields one line per refused model in chain order, then the answering model", () => {
    const lines = buildModelFallbackTooltipLines(
      {
        requestedModel: "openai:gpt-5.5-pro",
        refusedModels: ["openai:gpt-5.5-pro", "google:gemini-3.1-pro-preview"],
      },
      "anthropic:claude-opus-4-8"
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("GPT-5.5 Pro");
    expect(lines[1]).toContain("Gemini");
    expect(lines[2]).toContain("Opus 4.8");
  });

  test("omits the answering line when the effective model is unknown or empty", () => {
    for (const effectiveModel of [undefined, ""]) {
      const lines = buildModelFallbackTooltipLines(
        { requestedModel: "openai:gpt-5.5", refusedModels: ["openai:gpt-5.5"] },
        effectiveModel
      );

      expect(lines).toHaveLength(1);
    }
  });

  test("falls back to the requested model when refusedModels is empty (malformed record)", () => {
    const lines = buildModelFallbackTooltipLines(
      { requestedModel: "openai:gpt-5.5", refusedModels: [] },
      "anthropic:claude-sonnet-4-6"
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("GPT-5.5");
  });
});
