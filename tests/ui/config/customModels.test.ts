/**
 * Integration tests for custom model persistence.
 *
 * Users reported that adding a custom model "flashes" and then disappears.
 *
 * We intentionally do NOT drive the full Settings → Models UI here:
 * - Radix Dialog/Select portals are flaky in happy-dom
 * - happy-dom doesn't reliably flush React controlled input updates
 *
 * Instead, we reproduce the critical behavior we rely on in the UI:
 * - call updateModelsOptimistically(...)
 * - immediately use its returned array in api.providers.setModels(...)
 *
 * If updateModelsOptimistically returns a stale/empty array, the backend will
 * persist the wrong config and the UI will appear to "revert".
 */

import "../dom";
import React, { useEffect, useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

import { APIProvider, useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import type { ProviderModelEntry } from "@/common/orpc/types";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";

import { shouldRunIntegrationTests } from "../../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
} from "../../ipc/sendMessageTestHelpers";

import { installDom } from "../dom";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

function AddCustomModelHarness(props: {
  provider: string;
  modelId: string;
  onDone: (modelsSent: ProviderModelEntry[]) => void;
}) {
  const { api } = useAPI();
  const { config, loading, updateModelsOptimistically } = useProvidersConfig();
  const didRunRef = useRef(false);

  useEffect(() => {
    if (didRunRef.current) return;
    if (!api || loading || !config) return;

    didRunRef.current = true;

    const modelsSent = updateModelsOptimistically(props.provider, (models) => [
      ...models,
      props.modelId,
    ]);

    void api.providers
      .setModels({ provider: props.provider, models: modelsSent })
      .finally(() => props.onDone(modelsSent));
  }, [
    api,
    config,
    loading,
    props.modelId,
    props.onDone,
    props.provider,
    updateModelsOptimistically,
  ]);

  return React.createElement("div", { "data-testid": "harness" }, loading ? "loading" : "ready");
}

describeIntegration("Custom Models", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("updateModelsOptimistically return is safe to persist", async () => {
    const env = getSharedEnv();

    const cleanupDom = installDom();

    // useProvidersConfig reads the shared ProvidersConfigStore, which gets its
    // client from AppLoader in the real app. This harness bypasses AppLoader
    // (see module doc comment), so wire the store manually.
    getProvidersConfigStore().setClient(env.orpc);

    // Ensure starting from a clean slate.
    const reset = await env.orpc.providers.setModels({ provider: "anthropic", models: [] });
    if (!reset.success) {
      throw new Error(`Failed to reset models: ${reset.error}`);
    }

    let done = false;
    let modelsSent: ProviderModelEntry[] | null = null;

    const testModelId = "claude-test-custom-model";

    const view = render(
      React.createElement(APIProvider, {
        client: env.orpc,
        children: React.createElement(AddCustomModelHarness, {
          provider: "anthropic",
          modelId: testModelId,
          onDone: (value) => {
            done = true;
            modelsSent = value;
          },
        }),
      })
    );

    try {
      await waitFor(
        () => {
          if (!done) throw new Error("Harness did not complete");
        },
        { timeout: 10_000 }
      );

      expect((modelsSent ?? []).map((entry) => getProviderModelEntryId(entry))).toContain(
        testModelId
      );

      const cfg = await env.orpc.providers.getConfig();
      expect((cfg.anthropic.models ?? []).map((entry) => getProviderModelEntryId(entry))).toContain(
        testModelId
      );
    } finally {
      view.unmount();
      cleanup();
      cleanupDom();
      getProvidersConfigStore().setClient(null);

      // Best-effort cleanup so other tests don't inherit custom models.
      await env.orpc.providers.setModels({ provider: "anthropic", models: [] });
    }
  }, 60_000);
});
