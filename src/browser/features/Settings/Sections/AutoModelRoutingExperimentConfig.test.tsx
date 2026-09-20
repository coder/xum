import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import * as ActualAPIModule from "@/browser/contexts/API";
import * as ActualModelsFromSettingsModule from "@/browser/hooks/useModelsFromSettings";
import * as ActualModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import {
  DEFAULT_AUTO_MODEL_ROUTING_TIERS,
  type AutoModelRoutingConfig,
} from "@/common/types/autoModelRouting";
import { TYPESAFE_PROVIDER_KEY } from "@/constants/autoModelRouting";
import { installDom } from "../../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualAPIModule = { ...ActualAPIModule };
const actualModelsFromSettingsModule = { ...ActualModelsFromSettingsModule };
const actualModelSelectorModule = { ...ActualModelSelectorModule };

interface MockApi {
  config: {
    getConfig: ReturnType<typeof mock>;
    onConfigChanged: ReturnType<typeof mock>;
    updateAutoModelRouting: ReturnType<typeof mock>;
    getAutoModelRoutingClassifierStatus: ReturnType<typeof mock>;
    previewAutoModelRouting: ReturnType<typeof mock>;
  };
  providers: {
    setProviderConfig: ReturnType<typeof mock>;
  };
}

let mockApi: MockApi;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: mockApi, status: "connected" as const }),
  useOptionalAPI: () => ({ api: mockApi, status: "connected" as const }),
}));
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () =>
  createSelectPrimitiveDouble()
);
void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  useModelsFromSettings: () => ({
    models: ["openai:gpt-5.5", "anthropic:claude-opus-4-6"],
    hiddenModelsForSelector: [],
  }),
}));
void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    onChange: (value: string) => void;
    models: string[];
    emptyLabel?: string;
  }) => (
    <button
      type="button"
      data-tier-model-selector
      onClick={() => props.onChange(props.models[0] ?? "")}
    >
      {props.value !== "" ? props.value : (props.emptyLabel ?? "Select model")}
    </button>
  ),
}));

import { AutoModelRoutingExperimentConfig } from "./AutoModelRoutingExperimentConfig";

function createMockApi(initial?: AutoModelRoutingConfig): MockApi {
  let stored: AutoModelRoutingConfig = initial ?? {
    tiers: DEFAULT_AUTO_MODEL_ROUTING_TIERS.map((tier) => ({ ...tier })),
  };
  return {
    config: {
      getConfig: mock(() => Promise.resolve({ autoModelRouting: stored })),
      // Never yields: the hook only needs a subscribable iterator to start fetching.
      onConfigChanged: mock(() =>
        Promise.resolve({
          next: () => new Promise<IteratorResult<void>>(() => undefined),
          return: () => Promise.resolve({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        })
      ),
      updateAutoModelRouting: mock((input: { autoModelRouting: AutoModelRoutingConfig }) => {
        stored = input.autoModelRouting;
        return Promise.resolve();
      }),
      getAutoModelRoutingClassifierStatus: mock(() =>
        Promise.resolve({ apiKeySource: "none" as const })
      ),
      previewAutoModelRouting: mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            tierId: "hard",
            tierLabel: "Hard",
            confidence: 0.7,
            probabilities: { easy: 0.1, hard: 0.7 },
            classifierModel: "jev-1.13.0",
            model: "openai:gpt-5.5",
          },
        })
      ),
    },
    providers: {
      setProviderConfig: mock(() => Promise.resolve({ success: true as const, data: undefined })),
    },
  };
}

describe("AutoModelRoutingExperimentConfig", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/contexts/API", () => actualAPIModule);
    await mock.module(
      "@/browser/hooks/useModelsFromSettings",
      () => actualModelsFromSettingsModule
    );
    await mock.module(
      "@/browser/components/ModelSelector/ModelSelector",
      () => actualModelSelectorModule
    );
    await mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => ActualSelectPrimitiveModule
    );
  });

  beforeEach(() => {
    cleanupDom = installDom();
    mockApi = createMockApi();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  function tierRows(container: HTMLElement) {
    return Array.from(container.querySelectorAll("[data-auto-model-routing-tier]"));
  }

  test("adds and removes tiers through the update route, respecting the minimum", async () => {
    const { container, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    fireEvent.click(getByRole("button", { name: "Add tier" }));
    expect(tierRows(container)).toHaveLength(5);
    const lastUpdate = mockApi.config.updateAutoModelRouting.mock.calls.at(-1)?.[0] as {
      autoModelRouting: AutoModelRoutingConfig;
    };
    expect(lastUpdate.autoModelRouting.tiers).toHaveLength(5);
    // New ids never collide with existing ones.
    const ids = lastUpdate.autoModelRouting.tiers.map((tier) => tier.id);
    expect(new Set(ids).size).toBe(ids.length);

    fireEvent.click(getByRole("button", { name: "Remove tier 5" }));
    fireEvent.click(getByRole("button", { name: "Remove tier 4" }));
    fireEvent.click(getByRole("button", { name: "Remove tier 3" }));
    expect(tierRows(container)).toHaveLength(2);
    // Below the minimum the remaining remove buttons are disabled.
    expect((getByRole("button", { name: "Remove tier 1" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  test("moving a tier reorders the persisted list", async () => {
    const { container, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    fireEvent.click(getByRole("button", { name: "Move tier 2 up" }));
    const lastUpdate = mockApi.config.updateAutoModelRouting.mock.calls.at(-1)?.[0] as {
      autoModelRouting: AutoModelRoutingConfig;
    };
    expect(lastUpdate.autoModelRouting.tiers.map((tier) => tier.id)).toEqual([
      "medium",
      "easy",
      "hard",
      "extreme",
    ]);
  });

  test("commits label edits on blur and ignores empty drafts", async () => {
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    // Typing over a full selection replaces the value (user-event has no clear() in happy-dom).
    const replaceAll = { initialSelectionStart: 0, initialSelectionEnd: label.value.length };
    await userEvent.type(label, "Quick", replaceAll);
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();
    fireEvent.blur(label);
    let lastUpdate = mockApi.config.updateAutoModelRouting.mock.calls.at(-1)?.[0] as {
      autoModelRouting: AutoModelRoutingConfig;
    };
    expect(lastUpdate.autoModelRouting.tiers[0].label).toBe("Quick");

    await userEvent.type(label, "   ", replaceAll);
    fireEvent.blur(label);
    lastUpdate = mockApi.config.updateAutoModelRouting.mock.calls.at(-1)?.[0] as {
      autoModelRouting: AutoModelRoutingConfig;
    };
    expect(lastUpdate.autoModelRouting.tiers[0].label).toBe("Quick");
    expect(label.value).toBe("Quick");
  });

  test("saving and clearing the key writes the typesafe provider entry", async () => {
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    // The status refresh after saving reports the stored key, which enables Clear.
    mockApi.config.getAutoModelRoutingClassifierStatus.mockImplementation(() =>
      Promise.resolve({ apiKeySource: "config" as const })
    );
    await userEvent.type(getByLabelText("TypeSafe API key"), " sk-test ");
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.providers.setProviderConfig).toHaveBeenCalledTimes(1));
    expect(mockApi.providers.setProviderConfig.mock.calls[0]?.[0]).toEqual({
      provider: TYPESAFE_PROVIDER_KEY,
      keyPath: ["apiKey"],
      value: "sk-test",
    });
    // The draft is cleared so the key never lingers in the DOM.
    expect((getByLabelText("TypeSafe API key") as HTMLInputElement).value).toBe("");

    await waitFor(() =>
      expect((getByRole("button", { name: "Clear" }) as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mockApi.providers.setProviderConfig).toHaveBeenCalledTimes(2));
    expect(mockApi.providers.setProviderConfig.mock.calls[1]?.[0]).toMatchObject({
      provider: TYPESAFE_PROVIDER_KEY,
      value: "",
    });
  });

  test("classifying a sample prompt shows the chosen tier and model", async () => {
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    await userEvent.type(getByLabelText("Sample prompt"), "Refactor the queue");
    fireEvent.click(getByRole("button", { name: "Classify" }));
    await waitFor(() =>
      expect(container.querySelector("[data-auto-model-routing-preview]")).not.toBeNull()
    );
    const preview = container.querySelector("[data-auto-model-routing-preview]")!;
    expect(preview.textContent).toContain("Hard");
    expect(preview.textContent).toContain("70%");
    expect(preview.textContent).toContain("GPT-5.5");
  });
});
