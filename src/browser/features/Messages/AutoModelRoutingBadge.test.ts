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

  test("fallback reason that is already a sentence does not double the period", () => {
    const [line] = buildAutoModelRoutingTooltipLines({
      requestedFallbackModel: "anthropic:claude-opus-4-6",
      model: "anthropic:claude-opus-4-6",
      status: "fallback",
      reason: "Model xai:grok-3 does not support PDF input.",
    });
    expect(line).not.toContain("..");
    expect(line).toContain("does not support PDF input.");
  });

  test("fallback carries the failure reason and omits probabilities when absent", () => {
    const lines = buildAutoModelRoutingTooltipLines({
      requestedFallbackModel: "anthropic:claude-opus-4-6",
      model: "anthropic:claude-opus-4-6",
      status: "fallback",
      reason: "Evaluation model returned HTTP 429",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HTTP 429");
    expect(lines[0]).toContain("Opus 4.6");
  });

  test("a fallback after a verdict keeps the tier and names the model that ran", () => {
    const lines = buildAutoModelRoutingTooltipLines({
      ...routed,
      model: routed.requestedFallbackModel,
      status: "fallback",
      reason: "Model openai:gpt-5.5-mini is not allowed by policy",
    });
    expect(lines[0]).toContain("Easy");
    expect(lines[0]).toContain("82%");
    expect(lines[1]).toContain("Opus 4.6");
    expect(lines[1]).toContain("not allowed by policy");
    expect(lines[1]).not.toContain("..");
    expect(lines.join("\n")).not.toContain("Classification failed");
    expect(lines.slice(2)).toEqual(["easy: 82%", "medium: 15%", "hard: 3%"]);
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

  test("names the routed thinking level only when Auto set it", () => {
    expect(buildAutoModelRoutingTooltipLines(routed)[1]).not.toContain("thinking");
    expect(buildAutoModelRoutingBadgeLabel(routed)).not.toContain("HIGH");

    const withThinking: AutoModelRoutingRecord = { ...routed, thinkingLevel: "high" };
    expect(buildAutoModelRoutingTooltipLines(withThinking)[1]).toContain("HIGH");
    expect(buildAutoModelRoutingBadgeLabel(withThinking)).toContain("HIGH");
  });

  test("an escalated turn is labeled at its final level and lists each raise", () => {
    const escalated: AutoModelRoutingRecord = {
      ...routed,
      thinkingLevel: "low",
      escalations: [
        {
          step: 4,
          from: "low",
          to: "medium",
          reason: "3 consecutive steps with only failing tool calls",
        },
        { step: 7, from: "medium", to: "high", reason: "the same bash call repeated 3 times" },
      ],
    };
    // The badge names the level the turn finished at, not the tier's starting level.
    expect(buildAutoModelRoutingBadgeLabel(escalated)).toContain("HIGH");
    expect(buildAutoModelRoutingBadgeLabel(escalated)).not.toContain("LOW");
    const lines = buildAutoModelRoutingTooltipLines(escalated);
    // The run line keeps the starting level; one line per raise follows it, in order.
    expect(lines[1]).toContain("LOW");
    expect(lines[2]).toContain("MED");
    expect(lines[2]).toContain("step 4");
    expect(lines[3]).toContain("HIGH");
    expect(lines[3]).toContain("step 7");
    // Probabilities still trail the raises.
    expect(lines[4]).toContain("easy");
  });

  test("labels the thinking level against the model that ran", () => {
    // OpenAI reports max as xhigh unless the model has a native max effort.
    const openai: AutoModelRoutingRecord = {
      ...routed,
      model: "openai:gpt-5.5-mini",
      thinkingLevel: "max",
    };
    const anthropic: AutoModelRoutingRecord = {
      ...routed,
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "max",
    };
    expect(buildAutoModelRoutingBadgeLabel(openai)).toContain("XHIGH");
    expect(buildAutoModelRoutingBadgeLabel(anthropic)).toContain("MAX");
  });
});
