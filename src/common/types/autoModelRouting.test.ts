import { describe, expect, it } from "bun:test";
import { normalizeAutoModelRoutingConfig } from "./autoModelRouting";

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
});
