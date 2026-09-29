import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import {
  getThinkingPolicyForModel,
  enforceThinkingPolicy,
  resolveThinkingInput,
  isGeminiFlashThinkingLevelModelName,
  isGeminiFlashMinimalRejectingModelName,
  getDefaultMinimumThinkingLevel,
  lookupMinThinkingLevelOverride,
  resolveMinimumThinkingLevel,
  resolveEffectiveThinkingLevel,
  getAvailableThinkingLevels,
  isXaiGrokFastVariantSwap,
} from "./policy";

describe("getThinkingPolicyForModel", () => {
  test.each(["gpt-6-luna"])("preserves off and native max for %s", (model) => {
    for (const id of [
      `openai:${model}`,
      `mux-gateway:openai/${model}`,
      `openrouter:openai/${model}-2026-09-22`,
    ]) {
      expect(getThinkingPolicyForModel(id)).toEqual([
        "off",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
      expect(enforceThinkingPolicy(id, "off")).toBe("off");
      expect(enforceThinkingPolicy(id, "max")).toBe("max");
    }
    expect(enforceThinkingPolicy(`openai:${model}-mini`, "max")).toBe("high");
  });

  // GPT-6 Astra keeps native max but rejects effort "none" (HTTP 400), so "off"
  // is not offered. Named variants and other GPT-6 ids stay outside the rule.
  test("returns 5 levels (no off) including max for gpt-6-astra (direct, gateway, dated)", () => {
    const fiveLevels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
    expect(getThinkingPolicyForModel("openai:gpt-6-astra")).toEqual(fiveLevels);
    expect(getThinkingPolicyForModel("mux-gateway:openai/gpt-6-astra")).toEqual(fiveLevels);
    expect(getThinkingPolicyForModel("openrouter:openai/gpt-6-astra-2026-09-30")).toEqual(
      fiveLevels
    );
    expect(enforceThinkingPolicy("openai:gpt-6-astra", "max")).toBe("max");
    expect(enforceThinkingPolicy("openai:gpt-6-astra", "off")).toBe("low");
  });

  test("gpt-6.1-sol follows Astra: 5 levels (no off), off and unset clamp to low", () => {
    const fiveLevels: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
    for (const id of ["openai:gpt-6.1-sol", "mux-gateway:openai/gpt-6.1-sol"]) {
      expect(getThinkingPolicyForModel(id)).toEqual(fiveLevels);
      expect(enforceThinkingPolicy(id, "off")).toBe("low");
      expect(resolveEffectiveThinkingLevel(id, undefined)).toBe("low");
      expect(resolveEffectiveThinkingLevel(id, "max")).toBe("max");
    }
  });

  test("gpt-6-astra named variants and other GPT-6 ids fall through to the default policy", () => {
    const defaultPolicy: ThinkingLevel[] = ["off", "low", "medium", "high"];
    expect(getThinkingPolicyForModel("openai:gpt-6-astra-mini")).toEqual(defaultPolicy);
    expect(getThinkingPolicyForModel("openai:gpt-6")).toEqual(defaultPolicy);
    expect(enforceThinkingPolicy("openai:gpt-6-astra-mini", "max")).toBe("high");
  });

  test("gpt-6-astra clamps unset/off to low (forced thinking, like Mythos/GLM/3.8 Flash)", () => {
    expect(resolveEffectiveThinkingLevel("openai:gpt-6-astra", undefined)).toBe("low");
    expect(resolveEffectiveThinkingLevel("openai:gpt-6-astra", "off")).toBe("low");
    expect(resolveEffectiveThinkingLevel("mux-gateway:openai/gpt-6-astra", null)).toBe("low");
    expect(resolveEffectiveThinkingLevel("openai:gpt-6-astra", "max")).toBe("max");
    // Luna keeps a real "off" (wire effort "none"); the clamp is Astra/6.1 Sol-specific.
    expect(resolveEffectiveThinkingLevel("openai:gpt-6-luna", undefined)).toBe("off");
    // Recognized reasoning model: default medium floor applies like GPT-6 Luna.
    expect(getDefaultMinimumThinkingLevel("openai:gpt-6-astra")).toBe("medium");
    expect(getAvailableThinkingLevels("openai:gpt-6-astra", "medium")).toEqual([
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("mappedToModel aliases inherit gpt-6-astra's 5-level ladder", () => {
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-astra", mappedToModel: "openai:gpt-6-astra" }],
      },
    };
    expect(getThinkingPolicyForModel("openai:team-astra", providersConfig)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(enforceThinkingPolicy("openai:team-astra", "max", null, providersConfig)).toBe("max");
    expect(resolveEffectiveThinkingLevel("openai:team-astra", undefined, providersConfig)).toBe(
      "low"
    );
    expect(getDefaultMinimumThinkingLevel("openai:team-astra", providersConfig)).toBe("medium");
    // Without providers config the alias is unknown: default 4-level policy clamps max down.
    expect(enforceThinkingPolicy("openai:team-astra", "max")).toBe("high");
  });

  test("returns all levels for other OpenAI models", () => {
    expect(getThinkingPolicyForModel("openai:gpt-4o")).toEqual(["off", "low", "medium", "high"]);
    expect(getThinkingPolicyForModel("openai:gpt-4o-mini")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns all levels for Opus 4.5 (uses default policy)", () => {
    // Opus 4.5 uses the default policy - no special case needed
    // The effort parameter handles the "off" case by setting effort="low"
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-5-20251101")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns 5 levels including xhigh for Opus 4.6", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-6-20260201")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Behind gateway
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-opus-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns all 6 levels for Opus 4.7 (native xhigh effort)", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-7")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-7-20260416")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("returns all 6 levels for Opus 4.8 and future Opus versions", () => {
    // Detection should extend forward so new Opus models don't regress to the default policy.
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4-8")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-5-0")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("excludes 'off' for Mythos-class Fable 5 / Mythos 5 (API rejects disabled thinking)", () => {
    // Fable / Mythos sit above Opus and support the native xhigh effort level, but the
    // API rejects `thinking: { type: "disabled" }`, so "off" is not offered.
    expect(getThinkingPolicyForModel("anthropic:claude-fable-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-fable-5-1")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-mythos-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Opus 5.5 is the first Opus that cannot disable thinking (Opus 5 still can).
    expect(getThinkingPolicyForModel("anthropic:claude-opus-5-5")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-opus-5-5-20260922")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-mythos-5-1")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("clamps 'off' up to 'low' for Mythos-class models", () => {
    // A stored/legacy "off" selection must not reach the wire as disabled thinking.
    expect(enforceThinkingPolicy("anthropic:claude-fable-5", "off")).toBe("low");
    expect(enforceThinkingPolicy("anthropic:claude-fable-5-1", "off")).toBe("low");
    expect(enforceThinkingPolicy("anthropic:claude-mythos-5", "off")).toBe("low");
    expect(enforceThinkingPolicy("anthropic:claude-mythos-5-1", "off")).toBe("low");
    expect(enforceThinkingPolicy("anthropic:claude-opus-5-5", "off")).toBe("low");
  });

  test("resolveEffectiveThinkingLevel clamps unset/off for forced-thinking models", () => {
    // Mythos-class cannot disable thinking: unset and "off" both resolve to "low"
    // so provider options, replay transforms, and metadata stay consistent with
    // the provider's always-thinking behavior.
    expect(resolveEffectiveThinkingLevel("anthropic:claude-fable-5", undefined)).toBe("low");
    expect(resolveEffectiveThinkingLevel("anthropic:claude-fable-5", "off")).toBe("low");
    expect(resolveEffectiveThinkingLevel("anthropic:claude-fable-5", "medium")).toBe("medium");
    // Opus 5.5 always thinks; Opus 5 (and Bedrock-style ids) keep their own behavior.
    expect(resolveEffectiveThinkingLevel("anthropic:claude-opus-5-5", undefined)).toBe("low");
    expect(resolveEffectiveThinkingLevel("bedrock:anthropic.claude-opus-5-5", "off")).toBe("low");
    expect(resolveEffectiveThinkingLevel("anthropic:claude-opus-5", undefined)).toBe("off");
    // Other models keep legacy behavior: unset means "off", explicit levels pass through
    // unclamped (policy enforcement happens at the call sites that own it).
    expect(resolveEffectiveThinkingLevel("anthropic:claude-opus-4-8", undefined)).toBe("off");
    expect(resolveEffectiveThinkingLevel("openai:gpt-5-pro", undefined)).toBe("off");
    expect(resolveEffectiveThinkingLevel("anthropic:claude-sonnet-4-5", "high")).toBe("high");
  });

  test("resolveEffectiveThinkingLevel clamps unset/off for Gemini 3.8 Flash but not older Flash", () => {
    // 3.8 Flash rejects "minimal": the tracked level must already be "low" so the
    // request envelope and debug snapshots agree with what the Google adapter sends.
    for (const model of ["google:gemini-3.8-flash", "mux-gateway:google/gemini-3.8-flash"]) {
      expect(resolveEffectiveThinkingLevel(model, undefined)).toBe("low");
      expect(resolveEffectiveThinkingLevel(model, "off")).toBe("low");
      expect(resolveEffectiveThinkingLevel(model, "high")).toBe("high");
    }
    // Older Flash tiers still express "off" as minimal, so nothing is forced.
    expect(resolveEffectiveThinkingLevel("google:gemini-3.7-flash", undefined)).toBe("off");
    expect(resolveEffectiveThinkingLevel("google:gemini-3.8-flash-lite", undefined)).toBe("off");
  });

  test("resolveEffectiveThinkingLevel resolves mappedToModel aliases before the Mythos check", () => {
    // A configured alias entry mapped to a Mythos-class model must follow the same
    // no-disabled-thinking rule as the canonical id, matching buildProviderOptions'
    // capability resolution.
    const providersConfig: ProvidersConfigMap = {
      anthropic: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "internal-fable", mappedToModel: "anthropic:claude-fable-5" }],
      },
    };
    expect(
      resolveEffectiveThinkingLevel("anthropic:internal-fable", undefined, providersConfig)
    ).toBe("low");
    expect(resolveEffectiveThinkingLevel("anthropic:internal-fable", "off", providersConfig)).toBe(
      "low"
    );
    // Without providers config the alias is unknown and keeps legacy off behavior.
    expect(resolveEffectiveThinkingLevel("anthropic:internal-fable", undefined)).toBe("off");
  });

  test("policy path resolves mappedToModel aliases to the target's capability", () => {
    // An alias mapped to GPT-6 Luna must expose the target's 6-level
    // ladder (incl. native max) and clamp against it — otherwise AgentSession
    // strips "max" before buildProviderOptions can resolve the alias.
    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-luna", mappedToModel: "openai:gpt-6-luna" }],
      },
    };
    expect(getThinkingPolicyForModel("openai:team-luna", providersConfig)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getAvailableThinkingLevels("openai:team-luna", null, providersConfig)).toContain("max");
    expect(enforceThinkingPolicy("openai:team-luna", "max", null, providersConfig)).toBe("max");
    // Aliases inherit the target's default medium floor (recognized reasoning model).
    expect(getDefaultMinimumThinkingLevel("openai:team-luna", providersConfig)).toBe("medium");
    expect(resolveMinimumThinkingLevel("openai:team-luna", null, providersConfig)).toBe("medium");
    // Without providers config the alias is unknown: default 4-level policy clamps max down.
    expect(enforceThinkingPolicy("openai:team-luna", "max")).toBe("high");
    expect(getDefaultMinimumThinkingLevel("openai:team-luna")).toBe("off");
  });

  test("returns all 6 levels for Sonnet 5 (native xhigh)", () => {
    // Sonnet 5 introduced the native xhigh effort level for the Sonnet tier, so it exposes
    // all 6 levels (unlike Sonnet 4.6, which maps xhigh -> "max" and stops at 5).
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-5-20260630")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // Behind gateway
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-sonnet-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("drops 'off' for Sonnet 5.5 (provisional always-thinking) but not Sonnet 5", () => {
    const noOff: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-5-5")).toEqual(noOff);
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-5-5-20261001")).toEqual(noOff);
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-sonnet-5-5")).toEqual(noOff);
    expect(enforceThinkingPolicy("anthropic:claude-sonnet-5-5", "off")).toBe("low");
    expect(resolveEffectiveThinkingLevel("bedrock:anthropic.claude-sonnet-5-5", "off")).toBe("low");
    // Sonnet 5 keeps its "off" level.
    expect(resolveEffectiveThinkingLevel("anthropic:claude-sonnet-5", undefined)).toBe("off");
  });

  test("returns 5 levels including xhigh for Sonnet 4.6", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getThinkingPolicyForModel("anthropic:claude-sonnet-4-6-20260201")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    // Behind gateway
    expect(getThinkingPolicyForModel("mux-gateway:anthropic/claude-sonnet-4-6")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  test("returns low/high for Gemini 3.1 Pro", () => {
    expect(getThinkingPolicyForModel("google:gemini-3.1-pro-preview")).toEqual(["low", "high"]);
  });

  test("returns off/low/medium/high for stable Gemini 3.5 Flash", () => {
    expect(getThinkingPolicyForModel("google:gemini-3.5-flash")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getThinkingPolicyForModel("mux-gateway:google/gemini-3.5-flash")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns off/low/medium/high for versioned stable Gemini 3.5 Flash IDs", () => {
    for (const model of [
      "google:gemini-3.5-flash-001",
      "google:gemini-3.5-flash-latest",
      "google:gemini-3.5-flash-preview",
    ]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  test("returns off/low/medium/high for stable Gemini 3.6 Flash", () => {
    for (const model of [
      "google:gemini-3.6-flash",
      "mux-gateway:google/gemini-3.6-flash",
      "google:gemini-3.6-flash-001",
    ]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  test("returns off/low/medium/high for stable Gemini 3.7 Flash", () => {
    for (const model of [
      "google:gemini-3.7-flash",
      "mux-gateway:google/gemini-3.7-flash",
      "google:gemini-3.7-flash-001",
    ]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  test("returns low/medium/high (no off) for Gemini 3.8 Flash, which rejects minimal", () => {
    for (const model of [
      "google:gemini-3.8-flash",
      "mux-gateway:google/gemini-3.8-flash",
      "openrouter:google/gemini-3.8-flash",
      "google:gemini-3.8-flash-001",
    ]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["low", "medium", "high"]);
      expect(enforceThinkingPolicy(model, "off")).toBe("low");
      expect(enforceThinkingPolicy(model, "xhigh")).toBe("high");
    }
    // Still a recognized reasoning model: defaults to the medium floor like other Flash tiers.
    expect(getDefaultMinimumThinkingLevel("google:gemini-3.8-flash")).toBe("medium");
  });

  test("returns off/low/medium/high for stable Gemini 3.5 Flash behind OpenRouter", () => {
    expect(getThinkingPolicyForModel("openrouter:google/gemini-3.5-flash")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns a fixed max policy for Kimi K3 (direct and via OpenRouter)", () => {
    expect(getThinkingPolicyForModel("moonshotai:kimi-k3")).toEqual(["max"]);
    expect(getThinkingPolicyForModel("openrouter:moonshotai/kimi-k3")).toEqual(["max"]);
    // Variant ids must not inherit the fixed K3 policy.
    expect(getThinkingPolicyForModel("moonshotai:kimi-k3-turbo")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns off/low/medium/high for non-preview Gemini 3 Flash IDs", () => {
    for (const model of ["google:gemini-3-flash", "google:gemini-3-flash-001"]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  test("returns off/low/medium/high for versioned Gemini 3 Flash Preview IDs", () => {
    for (const model of [
      "google:gemini-3-flash-preview-20251217",
      "google:gemini-3-flash-preview-latest",
    ]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["off", "low", "medium", "high"]);
    }
  });

  test("returns off/low/medium/high for Gemini 3 Flash", () => {
    expect(getThinkingPolicyForModel("google:gemini-3-flash-preview")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("returns all levels for other providers", () => {
    expect(getThinkingPolicyForModel("anthropic:claude-opus-4")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getThinkingPolicyForModel("google:gemini-2.0-flash-thinking")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("isGeminiFlashThinkingLevelModelName", () => {
  test("does not classify Gemini Flash Lite variants as Flash thinking-level chat models", () => {
    expect(isGeminiFlashThinkingLevelModelName("gemini-3-flash-lite")).toBe(false);
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.5-flash-lite")).toBe(false);
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.6-flash-lite")).toBe(false);
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.7-flash-lite")).toBe(false);
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.8-flash-lite")).toBe(false);
  });

  test("classifies stable Gemini 3.8 Flash IDs as Flash thinking-level chat models", () => {
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.8-flash")).toBe(true);
    expect(isGeminiFlashThinkingLevelModelName("Gemini-3.8-Flash ")).toBe(true);
    expect(isGeminiFlashThinkingLevelModelName("gemini-3.8-flash-001")).toBe(true);
  });
});

describe("isGeminiFlashMinimalRejectingModelName", () => {
  test("matches only Gemini 3.8 Flash chat IDs, not older Flash tiers or Lite variants", () => {
    expect(isGeminiFlashMinimalRejectingModelName("gemini-3.8-flash")).toBe(true);
    expect(isGeminiFlashMinimalRejectingModelName("Gemini-3.8-Flash ")).toBe(true);
    expect(isGeminiFlashMinimalRejectingModelName("gemini-3.8-flash-001")).toBe(true);
    expect(isGeminiFlashMinimalRejectingModelName("gemini-3.8-flash-lite")).toBe(false);
    expect(isGeminiFlashMinimalRejectingModelName("gemini-3.7-flash")).toBe(false);
    expect(isGeminiFlashMinimalRejectingModelName("gemini-3-flash")).toBe(false);
  });
});

describe("enforceThinkingPolicy", () => {
  describe("multi-option policy models", () => {
    test("allows requested level if in allowed set", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4", "high")).toBe("high");
    });
  });

  describe("Opus 4.5 (all levels supported)", () => {
    test("allows all levels including off", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "high")).toBe("high");
    });

    test("allows off for versioned model", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5-20251101", "off")).toBe("off");
    });
  });

  describe("Opus 4.6 (5 levels including xhigh)", () => {
    test("allows all 5 levels including xhigh", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "high")).toBe("high");
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-6", "xhigh")).toBe("xhigh");
    });
  });

  describe("Sonnet 4.6 (5 levels including xhigh)", () => {
    test("allows all 5 levels including xhigh", () => {
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "off")).toBe("off");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "low")).toBe("low");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "medium")).toBe("medium");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "high")).toBe("high");
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-6", "xhigh")).toBe("xhigh");
    });
  });

  describe("xhigh fallback for models without xhigh support", () => {
    test("clamps to highest allowed when xhigh requested on standard model", () => {
      expect(enforceThinkingPolicy("anthropic:claude-opus-4-5", "xhigh")).toBe("high");
    });

    test("clamps xhigh to high for standard Anthropic models", () => {
      expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "xhigh")).toBe("high");
    });
  });
});

// Note: Tests for invalid levels removed - TypeScript type system prevents invalid
// ThinkingLevel values at compile time, making runtime invalid-level tests unnecessary.
describe("resolveThinkingInput", () => {
  test("passes through named levels directly", () => {
    expect(resolveThinkingInput("off", "anthropic:claude-opus-4-1")).toBe("off");
    expect(resolveThinkingInput("high", "anthropic:claude-opus-4-1")).toBe("high");
    expect(resolveThinkingInput("medium", "openai:gpt-6-astra")).toBe("medium");
  });

  test("numeric 0 maps to model's lowest allowed level", () => {
    // Default models: lowest = "off"
    expect(resolveThinkingInput(0, "anthropic:claude-opus-4-1")).toBe("off");
    // gpt-6-astra: lowest = "low"
    expect(resolveThinkingInput(0, "openai:gpt-6-astra")).toBe("low");
    // gemini-3: lowest = "low"
    expect(resolveThinkingInput(0, "google:gemini-3")).toBe("low");
  });

  test("numeric indices map through model's sorted allowed levels", () => {
    // Default: [off, low, medium, high] → 0=off, 1=low, 2=medium, 3=high
    expect(resolveThinkingInput(0, "anthropic:claude-sonnet-4-5")).toBe("off");
    expect(resolveThinkingInput(1, "anthropic:claude-sonnet-4-5")).toBe("low");
    expect(resolveThinkingInput(2, "anthropic:claude-sonnet-4-5")).toBe("medium");
    expect(resolveThinkingInput(3, "anthropic:claude-sonnet-4-5")).toBe("high");

    // gpt-6-astra: [low, medium, high, xhigh, max] → 0=low, 1=medium, ..., 4=max
    expect(resolveThinkingInput(0, "openai:gpt-6-astra")).toBe("low");
    expect(resolveThinkingInput(1, "openai:gpt-6-astra")).toBe("medium");
    expect(resolveThinkingInput(4, "openai:gpt-6-astra")).toBe("max");
  });

  test("out-of-range numeric index clamps to model's highest level", () => {
    // Default has 4 levels, index 9 clamps to "high"
    expect(resolveThinkingInput(9, "anthropic:claude-sonnet-4-5")).toBe("high");
    // gemini-3 has 2 levels, index 4 clamps to "high"
    expect(resolveThinkingInput(4, "google:gemini-3")).toBe("high");
  });
});

describe("getDefaultMinimumThinkingLevel", () => {
  test("defaults to medium for explicitly-recognized reasoning models", () => {
    expect(getDefaultMinimumThinkingLevel("anthropic:claude-sonnet-4-6")).toBe("medium");
    expect(getDefaultMinimumThinkingLevel("openai:gpt-6-luna")).toBe("medium");
  });

  test("defaults to medium even when medium is not a native level (gemini-3)", () => {
    // gemini-3 capability is ["low","high"]; the default floor is still medium and the
    // available set resolves up to "high" via getAvailableThinkingLevels.
    expect(getDefaultMinimumThinkingLevel("google:gemini-3")).toBe("medium");
  });

  test("keeps off for the shared fallback policy (non-reasoning / unrecognized models)", () => {
    // The fallback policy is shared by non-reasoning models (gpt-4o, claude-3.5) where a
    // non-off default would send unsupported reasoning params, so they stay "off".
    expect(getDefaultMinimumThinkingLevel("openai:gpt-4o")).toBe("off");
    expect(getDefaultMinimumThinkingLevel("anthropic:claude-3-5-sonnet-latest")).toBe("off");
    expect(getDefaultMinimumThinkingLevel("anthropic:claude-sonnet-4-5")).toBe("off");
  });
});

describe("resolveMinimumThinkingLevel", () => {
  test("prefers the explicit override", () => {
    expect(resolveMinimumThinkingLevel("anthropic:claude-sonnet-4-6", "off")).toBe("off");
    expect(resolveMinimumThinkingLevel("anthropic:claude-sonnet-4-6", "high")).toBe("high");
  });

  test("falls back to the model default when override is null/undefined", () => {
    // Recognized reasoning model → medium default.
    expect(resolveMinimumThinkingLevel("anthropic:claude-sonnet-4-6", null)).toBe("medium");
    expect(resolveMinimumThinkingLevel("anthropic:claude-sonnet-4-6")).toBe("medium");
    // Fallback policy → off default.
    expect(resolveMinimumThinkingLevel("openai:gpt-4o")).toBe("off");
  });
});

describe("lookupMinThinkingLevelOverride", () => {
  test("prefers the gateway-preserving key over the legacy canonical key", () => {
    const map = {
      "coder:openai/gpt-5.5": "low",
      "openai:gpt-5.5": "high",
    } as const;
    expect(lookupMinThinkingLevelOverride({ ...map }, "coder:openai/gpt-5.5")).toBe("low");
  });

  test("falls back to the legacy name-canonical key persisted by older versions", () => {
    // Older versions keyed floors via normalizeToCanonical, collapsing
    // coder:openai/<model> into openai:<model>.
    const map = { "openai:gpt-5.5": "high" } as const;
    expect(lookupMinThinkingLevelOverride({ ...map }, "coder:openai/gpt-5.5")).toBe("high");
    // The direct selection still reads its own key.
    expect(lookupMinThinkingLevelOverride({ ...map }, "openai:gpt-5.5")).toBe("high");
  });

  test("returns undefined when neither key is present", () => {
    expect(
      lookupMinThinkingLevelOverride(
        { "anthropic:claude-opus-4-6": "high" },
        "coder:openai/gpt-5.5"
      )
    ).toBeUndefined();
    expect(lookupMinThinkingLevelOverride(undefined, "openai:gpt-5.5")).toBeUndefined();
  });
});

describe("Grok 4.1 Fast thinking policy", () => {
  test("offers a binary ladder without turning legacy non-Off effort off", () => {
    const model = "xai:grok-4-1-fast";
    expect(getThinkingPolicyForModel(model)).toEqual(["off", "high"]);
    expect(getDefaultMinimumThinkingLevel(model)).toBe("off");
    expect(enforceThinkingPolicy(model, "off")).toBe("off");
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(enforceThinkingPolicy(model, level)).toBe("high");
    }
    expect(resolveThinkingInput(1, model)).toBe("high");
    expect(getAvailableThinkingLevels(model, "medium")).toEqual(["high"]);
  });
});

describe("Grok 4.5 thinking policy", () => {
  test("offers only the reasoning efforts accepted by xAI", () => {
    expect(getThinkingPolicyForModel("xai:grok-4.5")).toEqual(["low", "medium", "high"]);
    expect(getDefaultMinimumThinkingLevel("xai:grok-4.5")).toBe("medium");
    expect(enforceThinkingPolicy("xai:grok-4.5", "off")).toBe("low");
    expect(enforceThinkingPolicy("xai:grok-4.5", "max")).toBe("high");
  });
});

describe("Grok 4.6 thinking policy", () => {
  test("adds native xhigh on top of the frontier Grok ladder", () => {
    expect(getThinkingPolicyForModel("xai:grok-4.6")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getDefaultMinimumThinkingLevel("xai:grok-4.6")).toBe("medium");
    expect(enforceThinkingPolicy("xai:grok-4.6", "off")).toBe("low");
    expect(enforceThinkingPolicy("xai:grok-4.6", "max")).toBe("xhigh");
  });
});

describe("Grok 4.7 thinking policy", () => {
  test("keeps the native-xhigh frontier Grok ladder", () => {
    expect(getThinkingPolicyForModel("xai:grok-4.7")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getDefaultMinimumThinkingLevel("xai:grok-4.7")).toBe("medium");
    expect(enforceThinkingPolicy("xai:grok-4.7", "off")).toBe("low");
    expect(enforceThinkingPolicy("xai:grok-4.7", "max")).toBe("xhigh");
  });
});

describe("GLM 5.3 thinking policy", () => {
  test("offers only Z.ai's forced-thinking effort levels", () => {
    for (const model of ["glm-5.3-flash", "zai:glm-5.3", "zai:glm-5.3-flash-2026-08-26"]) {
      expect(getThinkingPolicyForModel(model)).toEqual(["low", "high", "max"]);
    }

    expect(enforceThinkingPolicy("zai:glm-5.3-flash", "off")).toBe("low");
    expect(enforceThinkingPolicy("zai:glm-5.3-flash", "medium")).toBe("low");
    expect(enforceThinkingPolicy("zai:glm-5.3-flash", "xhigh")).toBe("high");
    expect(resolveEffectiveThinkingLevel("zai:glm-5.3-flash", undefined)).toBe("low");
    expect(resolveEffectiveThinkingLevel("zai:glm-5.3-flash", "off")).toBe("low");
  });

  test("does not apply the GLM 5.3 policy to named variants", () => {
    expect(getThinkingPolicyForModel("zai:glm-5.3-flashx")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("getAvailableThinkingLevels", () => {
  test("returns the raw capability when no floor is provided", () => {
    expect(getAvailableThinkingLevels("anthropic:claude-sonnet-4-5")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getAvailableThinkingLevels("anthropic:claude-sonnet-4-5", null)).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  test("medium floor hides off/low", () => {
    expect(getAvailableThinkingLevels("anthropic:claude-sonnet-4-5", "medium")).toEqual([
      "medium",
      "high",
    ]);
  });

  test("floor with no exact match clamps by ordering (gemini-3 medium -> high only)", () => {
    expect(getAvailableThinkingLevels("google:gemini-3", "medium")).toEqual(["high"]);
  });

  test("never returns empty: floor above the model's max locks to the highest level", () => {
    // Opus 4.6 tops out at xhigh; a "max" floor locks to xhigh rather than emptying out.
    expect(getAvailableThinkingLevels("anthropic:claude-opus-4-6", "max")).toEqual(["xhigh"]);
  });

  test("off floor leaves the full capability intact", () => {
    expect(getAvailableThinkingLevels("anthropic:claude-sonnet-4-5", "off")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });
});

describe("enforceThinkingPolicy with a minimum floor", () => {
  test("clamps a below-floor request up to the floor", () => {
    // Stored "off" with a medium floor becomes "medium".
    expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "off", "medium")).toBe("medium");
    expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "low", "medium")).toBe("medium");
  });

  test("leaves at-or-above-floor requests untouched", () => {
    expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "high", "medium")).toBe("high");
  });

  test("omitting the floor preserves legacy capability-only behavior", () => {
    expect(enforceThinkingPolicy("anthropic:claude-sonnet-4-5", "off")).toBe("off");
  });
});

describe("isXaiGrokFastVariantSwap", () => {
  test("flags only off<->on transitions on xai:grok-4-1-fast", () => {
    // off <-> non-off swaps the underlying reasoning/non-reasoning variant.
    expect(isXaiGrokFastVariantSwap("xai:grok-4-1-fast", "off", "high")).toBe(true);
    expect(isXaiGrokFastVariantSwap("xai:grok-4-1-fast", "high", "off")).toBe(true);
    // non-off -> non-off stays on the reasoning variant (no swap).
    expect(isXaiGrokFastVariantSwap("xai:grok-4-1-fast", "low", "high")).toBe(false);
    // Other models never swap instances on thinking-level changes.
    expect(isXaiGrokFastVariantSwap("xai:grok-4-1-fast-reasoning", "off", "high")).toBe(false);
    expect(isXaiGrokFastVariantSwap("anthropic:claude-sonnet-4-5", "off", "high")).toBe(false);
  });
});
