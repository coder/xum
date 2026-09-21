import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AUTO_MODEL_ROUTING_TIERS,
  normalizeAutoModelRoutingConfig,
} from "./autoModelRouting";
import { DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL } from "@/constants/autoModelRouting";

describe("normalizeAutoModelRoutingConfig", () => {
  it("drops tiers whose label or description is whitespace-only and trims the rest", () => {
    const { tiers } = normalizeAutoModelRoutingConfig({
      tiers: [
        { id: "easy", label: "  Easy ", description: " trivial edits " },
        { id: "medium", label: "Medium", description: "small fixes" },
        { id: "blank-label", label: "   ", description: "described" },
        { id: "blank-description", label: "Blank", description: "\t\n" },
      ],
    });

    expect(tiers.map((tier) => tier.id)).toEqual(["easy", "medium"]);
    expect(tiers[0]).toMatchObject({ label: "Easy", description: "trivial edits" });
  });

  it("heals the evaluation model and the tier list independently", () => {
    const tiers = [
      { id: "easy", label: "Easy", description: "trivial" },
      { id: "hard", label: "Hard", description: "complex" },
    ];
    // Missing, malformed, and unsupported-provider values all fall back to the default.
    for (const evaluationModel of [undefined, 42, "jev-latest", "coder:openai/gpt-5"]) {
      expect(normalizeAutoModelRoutingConfig({ tiers, evaluationModel })).toEqual({
        tiers,
        evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
      });
    }
    // A valid evaluator survives a tier list that collapses to the defaults, and vice versa.
    expect(
      normalizeAutoModelRoutingConfig({ tiers: "nope", evaluationModel: "openai:gpt-5-nano" })
    ).toEqual({
      tiers: [...DEFAULT_AUTO_MODEL_ROUTING_TIERS],
      evaluationModel: "openai:gpt-5-nano",
    });
    expect(normalizeAutoModelRoutingConfig(null)).toEqual({
      tiers: [...DEFAULT_AUTO_MODEL_ROUTING_TIERS],
      evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
    });
  });
});
