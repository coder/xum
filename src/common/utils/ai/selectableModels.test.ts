import { describe, expect, test } from "bun:test";

import { KNOWN_MODELS, type KnownModelKey } from "@/common/constants/knownModels";
import type {
  EffectivePolicy,
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";

import {
  BUILT_IN_MODELS,
  computeSelectableModels,
  type SelectableModelsInput,
} from "./selectableModels";

// Explicit per-provider built-in lists in KNOWN_MODELS (= picker) order. The
// sanity test below fails loudly when the catalog changes so every expected
// list in this file stays explicit instead of being derived from the pipeline.
const ids = (...keys: KnownModelKey[]): string[] => keys.map((key) => KNOWN_MODELS[key].id);
const ANTHROPIC = ids("FABLE", "MYTHOS", "OPUS", "SONNET", "HAIKU");
const OPENAI = ids(
  "GPT",
  "GPT_56_TERRA",
  "GPT_56_LUNA",
  "GPT_6_ASTRA",
  "GPT_PRO",
  "GPT_54_MINI",
  "GPT_54_NANO",
  "GPT_53_CODEX",
  "GPT_53_CODEX_SPARK",
  "GPT_MINI",
  "GPT_CODEX_MAX",
  "DAYBREAK_BLUE",
  "DAYBREAK_RED"
);
const GOOGLE = ids("GEMINI_31_PRO", "GEMINI_FLASH");
const XAI = ids("GROK_46");
const DEEPSEEK = ids("DEEPSEEK_V4_PRO", "DEEPSEEK_V4_FLASH");
const MOONSHOT = ids("KIMI_K3");
const ZAI = ids("GLM_53_FLASH");
const ALL_BUILT_INS = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
  ...XAI,
  ...DEEPSEEK,
  ...MOONSHOT,
  ...ZAI,
];
const OPENROUTER_ROUTABLE_BUILT_INS = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
  ...XAI,
  ...DEEPSEEK,
  ...MOONSHOT,
];

const SONNET = KNOWN_MODELS.SONNET.id;
const SPARK = KNOWN_MODELS.GPT_53_CODEX_SPARK.id;
const without = (models: string[], ...excluded: string[]): string[] =>
  models.filter((model) => !excluded.includes(model));

function provider(overrides: Partial<ProviderConfigInfo> = {}): ProviderConfigInfo {
  return { apiKeySet: true, isEnabled: true, isConfigured: true, ...overrides };
}

function customProvider(
  models: ProviderModelEntry[],
  overrides: Partial<ProviderConfigInfo> = {}
): ProviderConfigInfo {
  return provider({ isCustom: true, providerType: "openai-compatible", models, ...overrides });
}

function enforcedPolicy(
  providerAccess: NonNullable<EffectivePolicy["providerAccess"]>
): EffectivePolicy {
  return {
    policyFormatVersion: "0.1",
    providerAccess,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  };
}

function select(overrides: Partial<SelectableModelsInput>): string[] {
  return computeSelectableModels({
    providersConfig: null,
    hiddenModels: [],
    effectivePolicy: null,
    routePriority: ["direct"],
    routeOverrides: {},
    ...overrides,
  });
}

describe("computeSelectableModels", () => {
  test("fixture lists cover the built-in catalog in picker order", () => {
    expect(ALL_BUILT_INS).toEqual(BUILT_IN_MODELS);
  });

  describe("custom models", () => {
    test("surfaces custom models of enabled providers before built-ins; skips disabled, mux-gateway and github-copilot entries", () => {
      const providersConfig: ProvidersConfigMap = {
        anthropic: provider(),
        fixture: customProvider(["fixture-a", { id: "fixture-mapped", mappedToModel: SONNET }]),
        "fixture-off": customProvider(["never"], { isEnabled: false }),
        "mux-gateway": provider({ models: ["anthropic/claude-sonnet-5"] }),
        "github-copilot": provider({ models: ["gpt-5.6-sol"] }),
      };

      expect(select({ providersConfig })).toEqual([
        "fixture:fixture-a",
        "fixture:fixture-mapped",
        ...ANTHROPIC,
      ]);
    });

    test("a custom entry equal to a built-in ID is deduped, keeping the custom position", () => {
      const providersConfig: ProvidersConfigMap = {
        anthropic: provider({ models: ["claude-sonnet-5", "claude-custom"] }),
      };

      expect(select({ providersConfig })).toEqual([
        SONNET,
        "anthropic:claude-custom",
        ...without(ANTHROPIC, SONNET),
      ]);
    });
  });

  describe("hidden models", () => {
    const providersConfig: ProvidersConfigMap = { anthropic: provider() };

    test("excludes hidden models", () => {
      expect(select({ providersConfig, hiddenModels: [SONNET] })).toEqual(
        without(ANTHROPIC, SONNET)
      );
    });

    test("an empty hidden list is a no-op", () => {
      expect(select({ providersConfig, hiddenModels: [] })).toEqual(ANTHROPIC);
    });
  });

  describe("route availability", () => {
    test("excludes built-ins of unconfigured and disabled providers", () => {
      expect(
        select({
          providersConfig: {
            anthropic: provider({ isEnabled: false }),
            openai: provider({ isConfigured: false, apiKeySet: false }),
            xai: provider(),
          },
        })
      ).toEqual(XAI);
    });

    test("includes a built-in of an unconfigured provider when a configured gateway in routePriority can route it", () => {
      const providersConfig: ProvidersConfigMap = { bedrock: provider() };

      expect(select({ providersConfig, routePriority: ["direct"] })).toEqual([]);
      // bedrock routes anthropic only, so no other provider's built-ins appear.
      expect(select({ providersConfig, routePriority: ["direct", "bedrock"] })).toEqual(ANTHROPIC);
    });

    test("a routeOverride pinning a model to an unavailable gateway falls back to the priority walk", () => {
      const routeOverrides = { [SONNET]: "openrouter" };

      // Direct anthropic is configured: resolveRoute falls through to it, so Sonnet stays.
      expect(select({ providersConfig: { anthropic: provider() }, routeOverrides })).toEqual(
        ANTHROPIC
      );
      // Nothing can route anthropic: the override alone never makes a model available.
      expect(select({ providersConfig: { xai: provider() }, routeOverrides })).toEqual(XAI);
    });

    test("explicit gateway-prefixed custom entries survive unchanged", () => {
      const providersConfig: ProvidersConfigMap = {
        openrouter: provider({ models: ["anthropic/claude-sonnet-5"] }),
        coder: provider({ models: ["openai/gpt-5.6-sol"] }),
      };

      expect(select({ providersConfig })).toEqual([
        "openrouter:anthropic/claude-sonnet-5",
        "coder:openai/gpt-5.6-sol",
      ]);
    });
  });

  describe("authoritative catalogs", () => {
    test("coder gates gateway routing on discoveredModels and honors removedModels", () => {
      const catalog = ["openai/gpt-5.6-sol", "openai/gpt-6-astra"];
      const base = { apiKeySet: false, isEnabled: true, isConfigured: true };

      // Unknown catalog (discovery pending): permissive, every routable openai built-in shows.
      expect(
        select({
          providersConfig: { coder: { ...base, models: catalog } },
          routePriority: ["coder"],
        })
      ).toEqual(["coder:openai/gpt-5.6-sol", "coder:openai/gpt-6-astra", ...ANTHROPIC, ...OPENAI]);

      // Known catalog: only listed models route through coder.
      expect(
        select({
          providersConfig: { coder: { ...base, models: catalog, discoveredModels: catalog } },
          routePriority: ["coder"],
        })
      ).toEqual([
        "coder:openai/gpt-5.6-sol",
        "coder:openai/gpt-6-astra",
        KNOWN_MODELS.GPT.id,
        KNOWN_MODELS.GPT_6_ASTRA.id,
      ]);

      // A removed model disappears from both the explicit entry and the routed built-in.
      expect(
        select({
          providersConfig: {
            coder: {
              ...base,
              models: catalog,
              discoveredModels: catalog,
              removedModels: ["openai/gpt-6-astra"],
            },
          },
          routePriority: ["coder"],
        })
      ).toEqual(["coder:openai/gpt-5.6-sol", KNOWN_MODELS.GPT.id]);
    });

    test("github-copilot's persisted catalog gates the built-ins it can route", () => {
      expect(
        select({
          providersConfig: { "github-copilot": provider({ models: ["gpt-5.6-sol"] }) },
          routePriority: ["github-copilot"],
        })
      ).toEqual([KNOWN_MODELS.GPT.id]);
    });
  });

  describe("Codex OAuth gating on the direct OpenAI route", () => {
    const openai = (auth: { apiKeySet: boolean; codexOauthSet: boolean }): ProvidersConfigMap => ({
      openai: provider({ isConfigured: true, ...auth }),
    });
    const CODEX_ALLOWED_BUILT_INS = ids(
      "GPT",
      "GPT_56_TERRA",
      "GPT_56_LUNA",
      "GPT_6_ASTRA",
      "GPT_54_MINI",
      "GPT_53_CODEX",
      "GPT_53_CODEX_SPARK",
      "GPT_MINI",
      "GPT_CODEX_MAX"
    );

    test("API key + OAuth: every OpenAI built-in", () => {
      expect(select({ providersConfig: openai({ apiKeySet: true, codexOauthSet: true }) })).toEqual(
        OPENAI
      );
    });

    test("API key only: hides OAuth-required models", () => {
      expect(
        select({ providersConfig: openai({ apiKeySet: true, codexOauthSet: false }) })
      ).toEqual(without(OPENAI, SPARK));
    });

    test("OAuth only: shows only OAuth-routable models", () => {
      expect(
        select({ providersConfig: openai({ apiKeySet: false, codexOauthSet: true }) })
      ).toEqual(CODEX_ALLOWED_BUILT_INS);
    });

    test("neither: hides OAuth-required models", () => {
      expect(
        select({ providersConfig: openai({ apiKeySet: false, codexOauthSet: false }) })
      ).toEqual(without(OPENAI, SPARK));
    });

    test("a gateway-routed OpenAI model is not gated by OpenAI auth state", () => {
      expect(
        select({
          providersConfig: {
            openai: provider({ isConfigured: false, apiKeySet: false }),
            openrouter: provider(),
          },
          routePriority: ["openrouter"],
        })
      ).toEqual(OPENROUTER_ROUTABLE_BUILT_INS);
    });
  });

  describe("policy", () => {
    test("a model denied under its canonical identity stays when its active gateway route is allowed", () => {
      expect(
        select({
          providersConfig: { openrouter: provider() },
          routePriority: ["openrouter"],
          effectivePolicy: enforcedPolicy([{ id: "openrouter", allowedModels: null }]),
        })
      ).toEqual(OPENROUTER_ROUTABLE_BUILT_INS);
    });

    test("a model denied on its active route is excluded", () => {
      expect(
        select({
          providersConfig: { anthropic: provider(), xai: provider() },
          effectivePolicy: enforcedPolicy([
            { id: "anthropic", allowedModels: ["claude-sonnet-5"] },
          ]),
        })
      ).toEqual([SONNET]);
    });

    test("effectivePolicy: null skips policy filtering", () => {
      expect(
        select({
          providersConfig: { anthropic: provider(), xai: provider() },
          effectivePolicy: null,
        })
      ).toEqual([...ANTHROPIC, ...XAI]);
    });
  });

  describe("providersConfig: null (still loading)", () => {
    test("returns the hidden-filtered suggested list without availability filtering", () => {
      expect(select({ providersConfig: null, hiddenModels: [SONNET] })).toEqual(
        without(ALL_BUILT_INS, SONNET)
      );
    });

    test("still applies the policy under canonical identity", () => {
      expect(
        select({
          providersConfig: null,
          effectivePolicy: enforcedPolicy([{ id: "anthropic", allowedModels: null }]),
        })
      ).toEqual(ANTHROPIC);
    });
  });
});
