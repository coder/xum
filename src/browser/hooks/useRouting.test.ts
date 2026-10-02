import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import React from "react";

import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";

import { useRouting } from "./useRouting";
import { createTestApiClient, createTestConfig, type TestClientConfig } from "@/browser/testUtils";

// providers.getConfig never resolves null; an empty map means no providers configured.
let providersConfig: ProvidersConfigMap = {};
let routePriority: string[] = ["direct"];
let routeOverrides: Record<string, string> = {};
let configGetConfig: () => Promise<TestClientConfig>;
let updateRoutePreferencesImpl: () => Promise<undefined>;

// `never` items fit every event stream (the subscriptions here yield void).
async function* emptyStream() {
  await Promise.resolve();
  const items: never[] = [];
  for (const item of items) {
    yield item;
  }
}

function createStubApiClient(): APIClient {
  return createTestApiClient({
    providers: {
      getConfig: () => Promise.resolve(providersConfig),
      onConfigChanged: () => Promise.resolve(emptyStream()),
    },
    config: {
      getConfig: () => configGetConfig(),
      onConfigChanged: () => Promise.resolve(emptyStream()),
      updateRoutePreferences: () => updateRoutePreferencesImpl(),
    },
  });
}

const stubClient = createStubApiClient();

const wrapper: React.FC<{ children: React.ReactNode }> = (props) =>
  React.createElement(
    APIProvider,
    { client: stubClient } as React.ComponentProps<typeof APIProvider>,
    props.children
  );

describe("useRouting", () => {
  let previousWindow: typeof globalThis.window;
  let previousDocument: typeof globalThis.document;
  let testWindow: GlobalWindow | null = null;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    testWindow = new GlobalWindow({ url: "https://mux.example.com/" });
    globalThis.window = testWindow as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    providersConfig = {};
    routePriority = ["direct"];
    routeOverrides = {};
    configGetConfig = () => Promise.resolve(createTestConfig({ routePriority, routeOverrides }));
    updateRoutePreferencesImpl = () => Promise.resolve(undefined);
  });

  afterEach(() => {
    cleanup();
    getProvidersConfigStore().setClient(null);
    getAppConfigStore().setClient(null);
    testWindow?.close();
    testWindow = null;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  });

  test("resolveRoute and availableRoutes honor gateway model accessibility", async () => {
    providersConfig = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
      "github-copilot": {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [KNOWN_MODELS.GPT_6_LUNA.providerModelId],
      },
    };

    // useProvidersConfig/useRouting read the shared stores (wired by
    // AppLoader in the real app); this hook test bypasses AppLoader, so wire
    // them manually AFTER the stubbed config is in place so the stores' fetch
    // observes it.
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(
        result.current
          .availableRoutes(KNOWN_MODELS.GPT.id)
          .some((route) => route.route === "github-copilot")
      ).toBe(false);
    });

    expect(result.current.resolveRoute(KNOWN_MODELS.GPT.id)).toEqual({
      route: "direct",
      isAuto: true,
      displayName: "Direct",
    });
  });

  const coderFallbackCases: Array<{
    availability: Partial<NonNullable<ProvidersConfigMap["coder"]>>;
    override?: string;
    expected: string;
  }> = [
    { availability: { isEnabled: false }, override: undefined, expected: "mux-gateway" },
    {
      availability: { discoveredModels: [], models: [] },
      override: undefined,
      expected: "mux-gateway",
    },
    {
      availability: { removedModels: ["prod-openai/gpt-6-astra"] },
      override: undefined,
      expected: "mux-gateway",
    },
    { availability: { isEnabled: false }, override: "direct", expected: "direct" },
    { availability: {}, override: "direct", expected: "coder" },
  ];
  test.each(coderFallbackCases)(
    "resolves Pro's effective custom-instance route: %j",
    async (testCase) => {
      const model = "coder:prod-openai/gpt-6-astra";
      providersConfig = {
        openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
        "mux-gateway": { apiKeySet: true, isEnabled: true, isConfigured: true },
        coder: {
          apiKeySet: false,
          isEnabled: true,
          isConfigured: true,
          discoveredProviders: [{ name: "prod-openai", type: "openai" }],
          // Capability overrides must not change the fallback's provider or route key.
          models: [{ id: "prod-openai/gpt-6-astra", mappedToModel: "anthropic:claude-opus-4-6" }],
          ...testCase.availability,
        },
      };
      routePriority = ["mux-gateway", "direct"];
      if (testCase.override) routeOverrides = { "openai:gpt-6-astra": testCase.override };
      getProvidersConfigStore().setClient(stubClient);
      getAppConfigStore().setClient(stubClient);
      const { result } = renderHook(() => useRouting(), { wrapper });
      await waitFor(() => expect(result.current.routePriority).toEqual(routePriority));
      expect(result.current.resolveEffectiveRoute(model)).toBe(testCase.expected);
    }
  );

  test("hook instances share one config fetch via the AppConfigStore", async () => {
    routeOverrides = { "openai:gpt-5.4": "mux-gateway" };
    let configFetchCount = 0;
    const baseGetConfig = configGetConfig;
    configGetConfig = () => {
      configFetchCount++;
      return baseGetConfig();
    };
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    // Regression: each useRouting instance used to issue its own
    // config.getConfig fetch + onConfigChanged subscription, so surfaces with
    // one picker per row fanned out O(rows) backend reads.
    const first = renderHook(() => useRouting(), { wrapper });
    const second = renderHook(() => useRouting(), { wrapper });

    await waitFor(() => {
      expect(first.result.current.routeOverrides).toEqual(routeOverrides);
      expect(second.result.current.routeOverrides).toEqual(routeOverrides);
    });
    expect(configFetchCount).toBe(1);
  });

  test("failed route persistence refreshes the shared store from the backend", async () => {
    // The optimistic update lands in the SINGLETON store, so a failed write
    // must re-fetch: otherwise the stale route survives navigation and every
    // picker keeps gating on state the backend never accepted.
    updateRoutePreferencesImpl = () => Promise.reject(new Error("write failed"));
    getProvidersConfigStore().setClient(stubClient);
    getAppConfigStore().setClient(stubClient);

    const { result } = renderHook(() => useRouting(), { wrapper });
    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));

    act(() => {
      result.current.setRoutePriority(["mux-gateway", "direct"]);
    });
    expect(result.current.routePriority).toEqual(["mux-gateway", "direct"]);

    await waitFor(() => expect(result.current.routePriority).toEqual(["direct"]));
  });
});
