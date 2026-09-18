import { describe, expect, test } from "bun:test";

import { DEFAULT_HIDDEN_MODELS, KNOWN_MODELS } from "@/common/constants/knownModels";
import type { EffectivePolicy, ProvidersConfigMap } from "@/common/orpc/types";

import {
  getExplicitCompactionSuggestion,
  getHigherContextCompactionSuggestion,
} from "./suggestion";

const COPILOT_ONLY_PROVIDERS_CONFIG: ProvidersConfigMap = {
  "github-copilot": {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
  },
};

const COPILOT_ONLY_OPTIONS = {
  providersConfig: COPILOT_ONLY_PROVIDERS_CONFIG,
  policy: null,
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
        modelId: `github-copilot:${KNOWN_MODELS.GPT_54_MINI.providerModelId}`,
      })
    ).toMatchObject({
      kind: "preferred",
      modelId: `github-copilot:${KNOWN_MODELS.GPT_54_MINI.providerModelId}`,
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
        policy: null,
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
        policy: null,
        routePriority: ["direct"],
        routeOverrides: {},
        modelId: "coder:openai/claude-sonnet-4-5",
      })
    ).toBeNull();
  });
});

describe("getHigherContextCompactionSuggestion", () => {
  const OPENAI_PROVIDERS_CONFIG: ProvidersConfigMap = {
    openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
  };

  test("never auto-suggests default-hidden models even when policy leaves only them", () => {
    // Policy allows the small current model plus only default-hidden entries
    // (restricted Daybreak tiers, provisional GPT-6 Sol). Without the
    // default-hidden exclusion, the provisional GPT-6 Sol entry (1.05M-context
    // estimate, first such candidate in registry order) would win the
    // higher-context scan and "Compact & retry" would route to a model most
    // users cannot call.
    const hiddenOnlyPolicy: EffectivePolicy = {
      policyFormatVersion: "0.1",
      providerAccess: [
        {
          id: "openai",
          allowedModels: [
            KNOWN_MODELS.GPT_54_MINI.providerModelId,
            ...DEFAULT_HIDDEN_MODELS.map((id) => id.split(":")[1]),
          ],
        },
      ],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    };

    expect(
      getHigherContextCompactionSuggestion({
        currentModel: KNOWN_MODELS.GPT_54_MINI.id,
        providersConfig: OPENAI_PROVIDERS_CONFIG,
        policy: hiddenOnlyPolicy,
        routePriority: ["direct"],
        routeOverrides: {},
      })
    ).toBeNull();
  });

  test("still suggests a visible higher-context model when one is allowed", () => {
    expect(
      getHigherContextCompactionSuggestion({
        currentModel: KNOWN_MODELS.GPT_54_MINI.id,
        providersConfig: OPENAI_PROVIDERS_CONFIG,
        policy: null,
        routePriority: ["direct"],
        routeOverrides: {},
      })
    ).toMatchObject({ kind: "higher_context", modelId: KNOWN_MODELS.GPT.id });
  });
});
