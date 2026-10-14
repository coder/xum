import { describe, expect, test } from "bun:test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";

import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
} from "./suggestion";

const COPILOT_ONLY_PROVIDERS_CONFIG: ProvidersConfigMap = {
  "github-copilot": {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    models: [KNOWN_MODELS.GPT_6_LUNA.providerModelId],
  },
};

const COPILOT_ONLY_OPTIONS = {
  providersConfig: COPILOT_ONLY_PROVIDERS_CONFIG,
  routePriority: ["direct"],
  routeOverrides: {},
};

describe("getExplicitCompactionSuggestion", () => {
  test("rejects explicit Copilot models missing from the authoritative catalog", () => {
    expect(
      getExplicitCompactionSuggestion({
        ...COPILOT_ONLY_OPTIONS,
        modelId: `github-copilot:${KNOWN_MODELS.GPT.providerModelId}`,
      })
    ).toBeNull();
  });

  test("keeps explicit Copilot models that the authoritative catalog exposes", () => {
    expect(
      getExplicitCompactionSuggestion({
        ...COPILOT_ONLY_OPTIONS,
        modelId: `github-copilot:${KNOWN_MODELS.GPT_6_LUNA.providerModelId}`,
      })
    ).toMatchObject({
      kind: "preferred",
      modelId: `github-copilot:${KNOWN_MODELS.GPT_6_LUNA.providerModelId}`,
    });
  });

  test("validates cross-typed Coder compaction models against the Coder catalog", () => {
    // {name:"openai", type:"anthropic"}: name-only canonicalization rewrites
    // coder:openai/<claude> to openai:<claude> and rejects it against the
    // direct OpenAI catalog even though the Coder gateway exposes it.
    const providersConfig: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        additionalProviders: [{ name: "openai", type: "anthropic" }],
        discoveredModels: ["openai/claude-opus-4-1"],
      },
    };

    expect(
      getExplicitCompactionSuggestion({
        providersConfig,
        routePriority: ["direct"],
        routeOverrides: {},
        modelId: "coder:openai/claude-opus-4-1",
      })
    ).toMatchObject({
      kind: "preferred",
      modelId: "coder:openai/claude-opus-4-1",
    });
  });

  test("rejects Coder compaction models missing from the Coder catalog", () => {
    const providersConfig: ProvidersConfigMap = {
      coder: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        additionalProviders: [{ name: "openai", type: "anthropic" }],
        discoveredModels: ["openai/claude-opus-4-1"],
      },
    };

    expect(
      getExplicitCompactionSuggestion({
        providersConfig,
        routePriority: ["direct"],
        routeOverrides: {},
        modelId: "coder:openai/claude-sonnet-4-5",
      })
    ).toBeNull();
  });
});

describe("Coder canonicalRoutes", () => {
  // Unknown anthropic/openai mappings leave Google as the only origin Coder could serve.
  const coderConfig = (canonicalRoutes: Record<string, string>): ProvidersConfigMap => ({
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      discoveredProviders: [{ name: "agents-google", type: "google" }],
      canonicalRoutes: { anthropic: "unknown", openai: "unknown", ...canonicalRoutes },
    },
  });

  test.each<{ canonicalRoutes: Record<string, string>; routed: boolean }>([
    { canonicalRoutes: { google: "agents-google" }, routed: true },
    { canonicalRoutes: {}, routed: false },
  ])("Google compaction suggestions follow the mapping: %j", (testCase) => {
    const options = {
      providersConfig: coderConfig(testCase.canonicalRoutes),
      routePriority: ["coder"],
      routeOverrides: {},
    };

    expect(
      getExplicitCompactionSuggestion({ ...options, modelId: KNOWN_MODELS.GEMINI_FLASH.id }) != null
    ).toBe(testCase.routed);
    expect(
      getHigherContextCompactionSuggestion({
        ...options,
        currentModel: KNOWN_MODELS.HAIKU.id,
      })?.modelId.startsWith("google:") === true
    ).toBe(testCase.routed);
  });
});
