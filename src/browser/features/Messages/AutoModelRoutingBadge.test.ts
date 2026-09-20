import { describe, expect, test } from "bun:test";
import {
  buildAutoModelRoutingBadgeLabel,
  buildAutoModelRoutingTooltipLines,
} from "./AutoModelRoutingBadge";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";

// Tooltip copy renders through a Radix portal that happy-dom can't observe, so
// the branching (status, missing confidence, probability ordering) is tested
// directly. Assertions target model display names and tier ids, not sentences.
const routed: AutoModelRoutingRecord = {
  requestedFallbackModel: "anthropic:claude-opus-4-6",
  tierId: "easy",
  tierLabel: "Easy",
  confidence: 0.82,
  probabilities: { easy: 0.82, medium: 0.15, hard: 0.03 },
  model: "openai:gpt-5.5-mini",
  status: "routed",
};

describe("buildAutoModelRoutingBadgeLabel", () => {
  test("distinguishes routed, unmapped, and fallback outcomes", () => {
    expect(buildAutoModelRoutingBadgeLabel(routed)).toContain("Easy");
    const unmapped = buildAutoModelRoutingBadgeLabel({ ...routed, status: "unmapped-tier" });
    expect(unmapped).toContain("Easy");
    expect(unmapped).not.toBe(buildAutoModelRoutingBadgeLabel(routed));
    const fallback = buildAutoModelRoutingBadgeLabel({
      ...routed,
      status: "fallback",
      tierId: undefined,
      tierLabel: undefined,
    });
    expect(fallback).not.toContain("Easy");
  });
});

describe("buildAutoModelRoutingTooltipLines", () => {
  test("routed: confidence, effective model, then probabilities sorted descending", () => {
    const lines = buildAutoModelRoutingTooltipLines(routed);
    expect(lines[0]).toContain("82%");
    expect(lines[1]).toContain("GPT-5.5 Mini");
    expect(lines.slice(2)).toEqual(["easy: 82%", "medium: 15%", "hard: 3%"]);
  });

  test("unmapped tier names the fallback model instead of a routed model", () => {
    const lines = buildAutoModelRoutingTooltipLines({
      ...routed,
      status: "unmapped-tier",
      model: routed.requestedFallbackModel,
    });
    expect(lines[1]).toContain("Opus 4.6");
    expect(lines[1]).not.toContain("GPT-5.5 Mini");
  });

  test("fallback carries the failure reason and omits probabilities when absent", () => {
    const lines = buildAutoModelRoutingTooltipLines({
      requestedFallbackModel: "anthropic:claude-opus-4-6",
      model: "anthropic:claude-opus-4-6",
      status: "fallback",
      reason: "Classifier returned HTTP 429",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HTTP 429");
    expect(lines[0]).toContain("Opus 4.6");
  });

  test("omits the confidence when the record lacks one", () => {
    const lines = buildAutoModelRoutingTooltipLines({
      ...routed,
      confidence: undefined,
      probabilities: undefined,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("%");
  });
});
