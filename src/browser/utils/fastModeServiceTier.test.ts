import { describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  applyFastModeServiceTierChange,
  applyFastModeToggle,
  getFastModeProvider,
  getFastModeServiceTierChange,
  getFastModeUnavailableReason,
  isFastModeActive,
  ultrafastModeAvailable,
} from "./fastModeServiceTier";

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

const OPENAI_CONFIG = { apiKeySet: true, isEnabled: true, isConfigured: true };

function createWriter() {
  const setProviderConfig = mock((_input: unknown) =>
    Promise.resolve({ success: true as const, data: undefined })
  );
  return {
    providers: { setProviderConfig } as unknown as ProviderConfigWriter,
    setProviderConfig,
  };
}

describe("fast mode service tier", () => {
  test("says whether the model or its route lacks fast mode (#5753)", () => {
    // No route gives these models fast mode.
    expect(getFastModeUnavailableReason("google:gemini-3-pro", null)).toBe("model");
    expect(getFastModeUnavailableReason("anthropic:claude-haiku-4-5", null)).toBe("model");
    expect(getFastModeUnavailableReason("xai:grok-code-fast-1", null)).toBe("model");
    // These models have fast mode, so a null provider means the route cannot send it.
    expect(getFastModeUnavailableReason("mux-gateway:anthropic/claude-opus-5-5", null)).toBe(
      "route"
    );
    expect(getFastModeUnavailableReason("openrouter:openai/gpt-6-astra", null)).toBe("route");
    expect(getFastModeUnavailableReason("xai:grok-4.7", null)).toBe("route");

    // The capability comes from the provider config, whatever the route.
    const anthropic = { apiKeySet: true, isEnabled: true, isConfigured: true };
    const mapped = {
      anthropic: {
        ...anthropic,
        models: [
          { id: "team-opus", mappedToModel: "anthropic:claude-opus-5-5" },
          { id: "team-haiku", mappedToModel: "anthropic:claude-haiku-4-5" },
        ],
      },
    } as unknown as ProvidersConfigMap;
    expect(getFastModeUnavailableReason("anthropic:team-opus", mapped)).toBe("route");
    expect(getFastModeUnavailableReason("anthropic:team-haiku", mapped)).toBe("model");
    const custom = {
      anthropic,
      "team-claude": { ...anthropic, providerType: "anthropic-messages" },
      "team-compat": { ...anthropic, providerType: "openai-compatible" },
    } as unknown as ProvidersConfigMap;
    // getFastModeProvider refuses custom providers, so the route is the reason for Opus.
    expect(getFastModeProvider("team-claude:claude-opus-5-5", { providersConfig: custom })).toBe(
      null
    );
    expect(getFastModeUnavailableReason("team-claude:claude-opus-5-5", custom)).toBe("route");
    expect(getFastModeUnavailableReason("team-claude:claude-haiku-4-5", custom)).toBe("model");
    // A generic OpenAI-compatible dialect gives the model no known identity.
    expect(getFastModeUnavailableReason("team-compat:claude-opus-5-5", custom)).toBe("model");
  });

  test("resolves direct native providers and rejects gateway routes", () => {
    expect(getFastModeProvider("openai:gpt-5.6-sol", { resolvedRouteProvider: "direct" })).toBe(
      "openai"
    );
    expect(getFastModeProvider("xai:grok-4.7", { resolvedRouteProvider: "direct" })).toBe("xai");
    expect(getFastModeProvider("xai:grok-4.6", { resolvedRouteProvider: "direct" })).toBe("xai");
    expect(getFastModeProvider("xai:grok-4.5", { resolvedRouteProvider: "direct" })).toBe("xai");
    expect(getFastModeProvider("xai:grok-4.7", { resolvedRouteProvider: "openrouter" })).toBeNull();
    expect(
      getFastModeProvider("xai:team-grok", {
        resolvedRouteProvider: "direct",
        providersConfig: {
          xai: {
            apiKeySet: true,
            isEnabled: true,
            isConfigured: true,
            models: [{ id: "team-grok", mappedToModel: "xai:grok-4.5" }],
          },
        },
      })
    ).toBe("xai");
    expect(
      getFastModeProvider("xai:grok-code-fast-1", { resolvedRouteProvider: "direct" })
    ).toBeNull();
    expect(getFastModeProvider("anthropic:claude-sonnet-4-5")).toBeNull();
  });

  test("offers the shared OpenAI tier on explicit and preference-routed gateways", () => {
    for (const route of ["coder", "openrouter", "mux-gateway", "github-copilot"]) {
      const providersConfig = {
        [route]: { apiKeySet: true, isConfigured: true, isEnabled: true },
        openai: { apiKeySet: false, isEnabled: true, isConfigured: false, codexOauthSet: true },
      };
      expect(
        getFastModeProvider("openai:gpt-6-astra", { resolvedRouteProvider: route, providersConfig })
      ).toBe("openai");
      const modelId = route === "github-copilot" ? "gpt-6-astra" : "openai/gpt-6-astra";
      expect(getFastModeProvider(`${route}:${modelId}`, { providersConfig })).toBe("openai");
    }
  });

  test("uses Coder instance types rather than names or capability mappings", () => {
    const provider = (name: string, type?: string) =>
      getFastModeProvider(`coder:${name}/gpt-6-astra`, {
        resolvedRouteProvider: "coder",
        providersConfig: {
          openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
          coder: {
            apiKeySet: false,
            isEnabled: true,
            isConfigured: true,
            discoveredProviders: type ? [{ name, type }] : [],
            models: [{ id: `${name}/gpt-6-astra`, mappedToModel: "openai:gpt-6-astra" }],
          },
        },
      });
    expect(provider("prod-ai", "openai")).toBe("openai");
    expect(provider("chat-proxy", "openai-compat")).toBe("openai");
    expect(provider("openai", "anthropic")).toBeNull();
    expect(provider("openai", "google")).toBeNull();
    expect(provider("openai", "copilot")).toBeNull();
    expect(provider("unknown-instance")).toBeNull();
  });

  test("excludes only the actual Codex OAuth transport", () => {
    const providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: true, codexOauthSet: true },
      coder: { apiKeySet: false, isConfigured: true, isEnabled: false },
    };
    expect(getFastModeProvider("openai:gpt-6-astra", { providersConfig })).toBeNull();
    expect(
      getFastModeProvider("coder:openai/gpt-6-astra", {
        providersConfig,
        resolvedRouteProvider: "direct",
      })
    ).toBeNull();
    expect(
      getFastModeProvider("openai:gpt-6-astra", {
        providersConfig: {
          openai: { ...providersConfig.openai, apiKeySet: true, wireFormat: "chatCompletions" },
        },
      })
    ).toBe("openai");
  });

  test("follows a custom-named Coder instance's fallback without treating mappings as routes", () => {
    const providersConfig = {
      openai: { apiKeySet: false, isEnabled: true, isConfigured: false },
      coder: {
        apiKeySet: false,
        isConfigured: true,
        isEnabled: false,
        discoveredProviders: [{ name: "prod-ai", type: "openai" }],
      },
    };
    expect(
      getFastModeProvider("coder:prod-ai/gpt-6-astra", {
        providersConfig,
        resolvedRouteProvider: "direct",
      })
    ).toBe("openai");
    for (const model of [
      "openrouter:anthropic/claude-sonnet-4-5",
      "github-copilot:claude-sonnet-4.5",
      "github-copilot:gemini-3-pro",
    ]) {
      expect(getFastModeProvider(model)).toBeNull();
    }
  });

  test("restores flex from the shared provider config", () => {
    expect(getFastModeServiceTierChange("openai", "priority", "flex")).toEqual({
      apiValue: "flex",
      serviceTier: "flex",
      previousServiceTier: undefined,
    });
  });

  test("persists the restore tier before enabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "flex");

    expect(change).toEqual({
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: "flex",
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "flex",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "priority",
        },
      ],
    ]);
  });

  test("restores and clears the shared tier when disabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "priority", "default");

    expect(change).toEqual({
      apiValue: "default",
      serviceTier: "default",
      previousServiceTier: undefined,
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "default",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "",
        },
      ],
    ]);
  });

  test("restores an unset tier with the backend removal value", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "openai", "priority", "unset");

    expect(change?.serviceTier).toBeUndefined();
    expect(setProviderConfig.mock.calls[0]).toEqual([
      {
        provider: "openai",
        keyPath: ["serviceTier"],
        value: "",
      },
    ]);
  });

  test("uses provider-valid fallbacks for legacy priority config without a restore tier", () => {
    expect(getFastModeServiceTierChange("openai", "priority").serviceTier).toBe("auto");
    expect(getFastModeServiceTierChange("xai", "priority").serviceTier).toBe("default");
  });

  test("offers Ultrafast only where the request path would send it", () => {
    const openai = { apiKeySet: true, isEnabled: true, isConfigured: true };
    const config = (extra: object = {}): ProvidersConfigMap => ({
      openai: { ...openai, ...extra },
    });
    expect(ultrafastModeAvailable("openai:gpt-6.1-sol", { providersConfig: config() })).toBe(true);
    expect(ultrafastModeAvailable("openai:gpt-6-astra", { providersConfig: config() })).toBe(true);
    // Fast-capable but not Ultrafast-capable model.
    expect(ultrafastModeAvailable("openai:gpt-6-luna", { providersConfig: config() })).toBe(false);
    // Chat Completions rejects the tier.
    expect(
      ultrafastModeAvailable("openai:gpt-6.1-sol", {
        providersConfig: config({ wireFormat: "chatCompletions" }),
      })
    ).toBe(false);
    // Non-OpenAI Fast modes have no Ultrafast tier.
    expect(ultrafastModeAvailable("xai:grok-4.7", { providersConfig: null })).toBe(false);
  });

  test.each([
    // [current, stored restore target, toggled tier] -> [new tier, new restore target]
    [
      "enables Ultrafast and remembers the base tier",
      "flex",
      undefined,
      "ultrafast",
      "ultrafast",
      "flex",
    ],
    [
      "turns Ultrafast off back to the base tier",
      "ultrafast",
      "flex",
      "ultrafast",
      "flex",
      undefined,
    ],
    [
      "switches Fast to Ultrafast keeping the base tier",
      "priority",
      "flex",
      "ultrafast",
      "ultrafast",
      "flex",
    ],
    [
      "switches Ultrafast to Fast keeping the base tier",
      "ultrafast",
      "unset",
      "priority",
      "priority",
      "unset",
    ],
    // Ultrafast chosen in Settings is itself the base tier Fast mode returns to.
    [
      "keeps a Settings Ultrafast as Fast mode's restore target",
      "ultrafast",
      undefined,
      "priority",
      "priority",
      "ultrafast",
    ],
    [
      "returns to a Settings Ultrafast from Fast",
      "priority",
      "ultrafast",
      "ultrafast",
      "ultrafast",
      undefined,
    ],
  ] as const)("%s", (_name, current, previous, target, serviceTier, previousServiceTier) => {
    const change = getFastModeServiceTierChange("openai", current, previous, target);
    expect(change.serviceTier).toBe(serviceTier);
    expect(change.previousServiceTier).toBe(previousServiceTier);
  });

  test("persists Ultrafast's restore target before raising the tier", async () => {
    const { providers, setProviderConfig } = createWriter();

    const patch = await applyFastModeToggle(
      providers,
      "openai",
      { ...OPENAI_CONFIG, serviceTier: "auto" },
      "ultrafast"
    );

    expect(patch).toEqual({ serviceTier: "ultrafast", fastModePreviousServiceTier: "auto" });
    expect(setProviderConfig.mock.calls.map(([input]) => input)).toEqual([
      { provider: "openai", keyPath: ["fastModePreviousServiceTier"], value: "auto" },
      { provider: "openai", keyPath: ["serviceTier"], value: "ultrafast" },
    ]);
  });

  test("writes xAI fast mode to the xAI provider config", async () => {
    const { providers, setProviderConfig } = createWriter();

    await applyFastModeServiceTierChange(providers, "xai", "default");

    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "xai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "default",
        },
      ],
      [
        {
          provider: "xai",
          keyPath: ["serviceTier"],
          value: "priority",
        },
      ],
    ]);
  });

  test("offers Anthropic Fast mode only for supported Opus models on the direct API", () => {
    const anthropic = { apiKeySet: true, isEnabled: true, isConfigured: true };
    for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
      expect(
        getFastModeProvider(`anthropic:${model}`, {
          resolvedRouteProvider: "direct",
          providersConfig: { anthropic },
        })
      ).toBe("anthropic");
    }
    // Opus 4.7 errors and Opus 4.6 silently runs at standard speed.
    for (const model of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5"]) {
      expect(getFastModeProvider(`anthropic:${model}`, { resolvedRouteProvider: "direct" })).toBe(
        null
      );
    }
    // Mapped aliases inherit their target's support.
    expect(
      getFastModeProvider("anthropic:team-opus", {
        resolvedRouteProvider: "direct",
        providersConfig: {
          anthropic: {
            ...anthropic,
            models: [{ id: "team-opus", mappedToModel: "anthropic:claude-opus-5-5" }],
          },
        },
      })
    ).toBe("anthropic");
  });

  test("hides Anthropic Fast mode on gateways, ZDR configs, and configs without Anthropic", () => {
    const anthropic = { apiKeySet: true, isEnabled: true, isConfigured: true };
    const gateway = { apiKeySet: true, isEnabled: true, isConfigured: true };
    for (const route of ["mux-gateway", "openrouter", "bedrock", "coder"]) {
      expect(
        getFastModeProvider("anthropic:claude-opus-5-5", {
          resolvedRouteProvider: route,
          providersConfig: { anthropic, [route]: gateway },
        })
      ).toBeNull();
    }
    expect(
      getFastModeProvider("mux-gateway:anthropic/claude-opus-5-5", {
        providersConfig: { anthropic, "mux-gateway": gateway },
      })
    ).toBeNull();
    expect(
      getFastModeProvider("anthropic:claude-opus-5-5", {
        resolvedRouteProvider: "direct",
        providersConfig: { anthropic: { ...anthropic, disableBetaFeatures: true } },
      })
    ).toBeNull();
    expect(
      getFastModeProvider("anthropic:claude-opus-5-5", {
        resolvedRouteProvider: "direct",
        providersConfig: { openai: anthropic },
      })
    ).toBeNull();
  });

  test("offers Anthropic Fast mode only on the official API host", () => {
    const anthropic = { apiKeySet: true, isEnabled: true, isConfigured: true };
    const withBase = (config: Record<string, string>) =>
      getFastModeProvider("anthropic:claude-opus-5-5", {
        resolvedRouteProvider: "direct",
        providersConfig: { anthropic: { ...anthropic, ...config } },
      });
    expect(withBase({ baseUrl: "https://api.anthropic.com" })).toBe("anthropic");
    expect(withBase({ baseUrl: "https://api.anthropic.com/v1/" })).toBe("anthropic");
    expect(withBase({ baseUrl: "https://llm-proxy.example.com/anthropic" })).toBeNull();
    // Env-resolved base URLs count too, and win over an official config value.
    expect(
      withBase({ baseUrl: "https://api.anthropic.com", baseUrlResolved: "https://proxy.example" })
    ).toBeNull();
  });

  test("toggles Anthropic speed without touching service tiers", async () => {
    const { providers, setProviderConfig } = createWriter();
    const base = { apiKeySet: true, isEnabled: true, isConfigured: true };

    expect(isFastModeActive("anthropic", base)).toBe(false);
    const enabled = await applyFastModeToggle(providers, "anthropic", base);
    expect(enabled).toEqual({ speed: "fast" });
    expect(isFastModeActive("anthropic", { ...base, ...enabled })).toBe(true);
    // A priority service tier on Anthropic config must not read as Fast mode.
    expect(isFastModeActive("anthropic", { ...base, serviceTier: "priority" })).toBe(false);

    const disabled = await applyFastModeToggle(providers, "anthropic", { ...base, speed: "fast" });
    expect(disabled).toEqual({ speed: undefined });

    expect(setProviderConfig.mock.calls).toEqual([
      [{ provider: "anthropic", keyPath: ["speed"], value: "fast" }],
      // Empty string removes the key; standard is the API default.
      [{ provider: "anthropic", keyPath: ["speed"], value: "" }],
    ]);
  });

  test("reports a failed Anthropic write so callers refresh", async () => {
    const setProviderConfig = mock((_input: unknown) =>
      Promise.resolve({ success: false as const, error: "denied" })
    );
    const providers = { setProviderConfig } as unknown as ProviderConfigWriter;

    expect(await applyFastModeToggle(providers, "anthropic", undefined)).toBeNull();
  });
});
