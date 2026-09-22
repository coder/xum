import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import * as ActualAPIModule from "@/browser/contexts/API";
import * as ActualModelsFromSettingsModule from "@/browser/hooks/useModelsFromSettings";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import * as ActualModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import {
  getDefaultAutoModelRoutingConfig,
  type AutoModelRoutingConfig,
  type AutoModelRoutingEvaluationStatus,
} from "@/common/types/autoModelRouting";
import {
  DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
  TYPESAFE_PROVIDER_KEY,
} from "@/constants/autoModelRouting";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import { installDom } from "../../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualAPIModule = { ...ActualAPIModule };
const actualModelsFromSettingsModule = { ...ActualModelsFromSettingsModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
let mockProvidersConfig: ProvidersConfigMap | null = null;
const actualModelSelectorModule = { ...ActualModelSelectorModule };

interface MockApi {
  config: {
    getConfig: ReturnType<typeof mock>;
    onConfigChanged: ReturnType<typeof mock>;
    updateAutoModelRouting: ReturnType<typeof mock>;
    getAutoModelRoutingEvaluationStatus: ReturnType<typeof mock>;
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
void mock.module("@/browser/hooks/useProvidersConfig", () => ({
  useProvidersConfig: () => ({ config: mockProvidersConfig, loading: false }),
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
  let stored: AutoModelRoutingConfig = initial ?? getDefaultAutoModelRoutingConfig();
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
      getAutoModelRoutingEvaluationStatus: mock(
        (input?: { evaluationModel?: string }): Promise<AutoModelRoutingEvaluationStatus> =>
          Promise.resolve({
            evaluationModel: input?.evaluationModel ?? stored.evaluationModel,
            available: true,
          })
      ),
      previewAutoModelRouting: mock(() =>
        Promise.resolve({
          success: true as const,
          data: {
            tierId: "hard",
            tierLabel: "Hard",
            confidence: 0.7,
            probabilities: { easy: 0.1, hard: 0.7 },
            evaluationModel: DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
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

function lastUpdate(): AutoModelRoutingConfig {
  const call = mockApi.config.updateAutoModelRouting.mock.calls.at(-1)?.[0] as {
    autoModelRouting: AutoModelRoutingConfig;
  };
  return call.autoModelRouting;
}

describe("AutoModelRoutingExperimentConfig", () => {
  let cleanupDom: (() => void) | null = null;

  afterAll(async () => {
    await mock.module("@/browser/contexts/API", () => actualAPIModule);
    await mock.module(
      "@/browser/hooks/useModelsFromSettings",
      () => actualModelsFromSettingsModule
    );
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
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
    mockProvidersConfig = null;
    // Settings routes carry no workspace; the panel bills previews to the last selected one.
    updatePersistedState(SELECTED_WORKSPACE_KEY, {
      workspaceId: "ws-settings",
      projectPath: "/repos/xum",
      projectName: "xum",
      namedWorkspacePath: "/repos/xum/mike/routing",
    });
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

  function statusText(container: HTMLElement) {
    return container.querySelector("[data-auto-model-routing-evaluation-status]")?.textContent;
  }

  test("adds and removes tiers through the update route, respecting the minimum", async () => {
    const { container, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    fireEvent.click(getByRole("button", { name: "Add tier" }));
    expect(tierRows(container)).toHaveLength(5);
    expect(lastUpdate().tiers).toHaveLength(5);
    // New ids never collide with existing ones, and the evaluator rides along untouched.
    const ids = lastUpdate().tiers.map((tier) => tier.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(lastUpdate().evaluationModel).toBe(DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL);

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
    expect(lastUpdate().tiers.map((tier) => tier.id)).toEqual([
      "medium",
      "easy",
      "hard",
      "extreme",
    ]);
  });

  test("commits a label edit on blur", async () => {
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    // Typing over a full selection replaces the value (user-event has no clear() in happy-dom).
    const replaceAll = { initialSelectionStart: 0, initialSelectionEnd: label.value.length };
    await userEvent.type(label, "Quick", replaceAll);
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();
    fireEvent.blur(label);
    expect(lastUpdate().tiers[0].label).toBe("Quick");
    expect(mockApi.config.updateAutoModelRouting).toHaveBeenCalledTimes(1);
  });

  test("Enter commits a label; a duplicate label is flagged, never written, and reverts on blur", async () => {
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    const replaceAll = { initialSelectionStart: 0, initialSelectionEnd: label.value.length };
    await userEvent.type(label, "Fast", replaceAll);
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();
    fireEvent.keyDown(label, { key: "Enter" });
    expect(mockApi.config.updateAutoModelRouting).toHaveBeenCalledTimes(1);
    expect(lastUpdate().tiers[0].label).toBe("Fast");

    // Tier 2 is still labelled "Medium"; reusing it must not persist.
    await userEvent.type(label, "medium", {
      initialSelectionStart: 0,
      initialSelectionEnd: label.value.length,
    });
    expect(container.querySelector("[data-auto-model-routing-text-error]")?.textContent).toBe(
      "Another tier already uses this label"
    );
    fireEvent.keyDown(label, { key: "Enter" });
    expect(mockApi.config.updateAutoModelRouting).toHaveBeenCalledTimes(1);
    expect(label.value).toBe("Fast");
    expect(container.querySelector("[data-auto-model-routing-text-error]")).toBeNull();
  });

  test("a label committed on blur spreads the config another window replaced while typing", async () => {
    const configChange = { signal: null as (() => void) | null };
    mockApi.config.onConfigChanged = mock(() =>
      Promise.resolve({
        next: () =>
          new Promise<IteratorResult<void>>((resolve) => {
            configChange.signal = () => resolve({ done: false, value: undefined });
          }),
        return: () => Promise.resolve({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
      })
    );
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));
    await waitFor(() => expect(configChange.signal).not.toBeNull());

    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    await userEvent.type(label, "Fast", {
      initialSelectionStart: 0,
      initialSelectionEnd: label.value.length,
    });
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();

    // Another window switches the evaluator while this label is still being edited.
    mockApi.config.getConfig = mock(() =>
      Promise.resolve({
        autoModelRouting: {
          ...getDefaultAutoModelRoutingConfig(),
          evaluationModel: "openai:gpt-5.5",
        },
      })
    );
    configChange.signal?.();
    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("openai:gpt-5.5"));

    fireEvent.blur(label);
    expect(mockApi.config.updateAutoModelRouting).toHaveBeenCalledTimes(1);
    expect(lastUpdate().tiers[0].label).toBe("Fast");
    expect(lastUpdate().evaluationModel).toBe("openai:gpt-5.5");
  });

  test("loads the config only once the change subscription is live", async () => {
    // A save landing between a snapshot and the subscription emits no event this panel can
    // see; it is only visible when the first fetch runs after subscribing.
    const subscribe = mockApi.config.onConfigChanged as () => Promise<unknown>;
    mockApi.config.onConfigChanged = mock(() => {
      mockApi.config.getConfig = mock(() =>
        Promise.resolve({
          autoModelRouting: {
            ...getDefaultAutoModelRoutingConfig(),
            evaluationModel: "openai:gpt-5.5",
          },
        })
      );
      return subscribe();
    });
    const { getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("openai:gpt-5.5"));
  });

  test("a rejected write shows the error and reverts the field to the persisted config", async () => {
    mockApi.config.updateAutoModelRouting = mock(() => Promise.reject(new Error("disk full")));
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));
    const fetchesBefore = mockApi.config.getConfig.mock.calls.length;

    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    await userEvent.type(label, "Quick", {
      initialSelectionStart: 0,
      initialSelectionEnd: label.value.length,
    });
    fireEvent.blur(label);
    // The optimistic edit shows until the rejection re-fetches the persisted config.
    expect(label.value).toBe("Quick");
    await waitFor(() =>
      expect(container.textContent).toContain("Could not save routing settings: disk full")
    );
    await waitFor(() => expect(label.value).toBe("Easy"));
    expect(mockApi.config.getConfig.mock.calls.length).toBeGreaterThan(fetchesBefore);
  });

  test("a valid evaluation model is saved with the tiers on Enter", async () => {
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    expect(field.value).toBe(DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL);
    await userEvent.type(field, "openai:gpt-5.5{enter}", {
      initialSelectionStart: 0,
      initialSelectionEnd: field.value.length,
    });
    expect(mockApi.config.updateAutoModelRouting).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toEqual({
      ...getDefaultAutoModelRoutingConfig(),
      evaluationModel: "openai:gpt-5.5",
    });
    expect(field.value).toBe("openai:gpt-5.5");
    // The status probe follows the typed value rather than the saved one.
    const probed = mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls.at(-1)?.[0] as {
      evaluationModel: string;
    };
    expect(probed.evaluationModel).toBe("openai:gpt-5.5");
  });

  test("an unsupported evaluation model is flagged, never saved, and reverts on blur", async () => {
    const { container, getByLabelText } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    const statusCallsBefore = mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls.length;
    await userEvent.type(field, "xai:grok-4", {
      initialSelectionStart: 0,
      initialSelectionEnd: field.value.length,
    });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Invalid candidates are not probed either: the message explains the format instead.
    expect(mockApi.config.getAutoModelRoutingEvaluationStatus.mock.calls.length).toBe(
      statusCallsBefore
    );
    await userEvent.type(field, "{enter}");
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();
    // Enter with an invalid value reverted to the saved model; a fresh invalid draft reverts on blur too.
    expect(field.value).toBe(DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL);
    await userEvent.type(field, "nonsense", {
      initialSelectionStart: 0,
      initialSelectionEnd: field.value.length,
    });
    fireEvent.blur(field);
    expect(field.value).toBe(DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL);
    expect(mockApi.config.updateAutoModelRouting).not.toHaveBeenCalled();
  });

  test("an unavailable evaluation model shows the backend's reason", async () => {
    mockApi.config.getAutoModelRoutingEvaluationStatus.mockImplementation(
      (input?: { evaluationModel?: string }): Promise<AutoModelRoutingEvaluationStatus> =>
        Promise.resolve({
          evaluationModel: input?.evaluationModel ?? DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL,
          available: false,
          reason: "No TypeSafe API key configured",
        })
    );
    const { container } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(statusText(container)).toBe("No TypeSafe API key configured"));
  });

  test("the TypeSafe key field only appears for a typesafe evaluator and writes the provider entry", async () => {
    const { container, getByLabelText, getByRole, queryByLabelText } = render(
      <AutoModelRoutingExperimentConfig />
    );
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

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

    fireEvent.click(getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(mockApi.providers.setProviderConfig).toHaveBeenCalledTimes(2));
    expect(mockApi.providers.setProviderConfig.mock.calls[1]?.[0]).toMatchObject({
      provider: TYPESAFE_PROVIDER_KEY,
      value: "",
    });

    // Switching to another provider's evaluator hides the TypeSafe-only field.
    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    await userEvent.type(field, "anthropic:claude-haiku-4-5", {
      initialSelectionStart: 0,
      initialSelectionEnd: field.value.length,
    });
    expect(queryByLabelText("TypeSafe API key")).toBeNull();
  });

  test("the TypeSafe key controls stay hidden while typesafe is a legacy custom chat provider", async () => {
    // Save/Clear would write that entry's apiKey, which the evaluator refuses to use anyway.
    mockProvidersConfig = {
      [TYPESAFE_PROVIDER_KEY]: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        isCustom: true,
        providerType: "openai-compatible",
        baseUrl: "https://llm.example.internal/v1",
      },
    };
    const { container, queryByLabelText, queryByRole } = render(
      <AutoModelRoutingExperimentConfig />
    );
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));
    expect(queryByLabelText("TypeSafe API key")).toBeNull();
    expect(queryByRole("button", { name: "Clear" })).toBeNull();
    expect(mockApi.providers.setProviderConfig).not.toHaveBeenCalled();
  });

  test("classifying a sample prompt shows the chosen tier, model, and evaluator", async () => {
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

  test("classifying bills the preview to the last selected workspace and says so", async () => {
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));
    expect(
      container.querySelector("[data-auto-model-routing-preview-workspace]")?.textContent
    ).toContain("xum/routing");

    await userEvent.type(getByLabelText("Sample prompt"), "Refactor the queue");
    fireEvent.click(getByRole("button", { name: "Classify" }));
    await waitFor(() => expect(mockApi.config.previewAutoModelRouting).toHaveBeenCalledTimes(1));
    expect(mockApi.config.previewAutoModelRouting.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws-settings",
    });
  });

  test("Classify stays disabled while there is no workspace to bill the preview to", async () => {
    updatePersistedState(SELECTED_WORKSPACE_KEY, null);
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    await userEvent.type(getByLabelText("Sample prompt"), "Refactor the queue");
    expect((getByRole("button", { name: "Classify" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      container.querySelector("[data-auto-model-routing-preview-workspace]")?.textContent
    ).toContain("Open a workspace first");
    expect(mockApi.config.previewAutoModelRouting).not.toHaveBeenCalled();
  });

  test("classifying sends the tiers on screen, not the last persisted config", async () => {
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    // The edit is saved optimistically on blur; a save still in flight must not make the
    // preview classify against the previous tiers.
    mockApi.config.updateAutoModelRouting.mockImplementation(
      () => new Promise<void>(() => undefined)
    );
    const label = getByLabelText("Tier 1 label") as HTMLInputElement;
    await userEvent.type(label, "Quick", {
      initialSelectionStart: 0,
      initialSelectionEnd: label.value.length,
    });
    fireEvent.blur(label);
    await userEvent.type(getByLabelText("Sample prompt"), "Rename a variable");
    fireEvent.click(getByRole("button", { name: "Classify" }));

    await waitFor(() => expect(mockApi.config.previewAutoModelRouting).toHaveBeenCalledTimes(1));
    const request = mockApi.config.previewAutoModelRouting.mock.calls[0]?.[0] as {
      prompt: string;
      config?: AutoModelRoutingConfig;
    };
    expect(request.config?.tiers[0]?.label).toBe("Quick");
  });

  test("a preview without confidence or probabilities still renders the tier", async () => {
    mockApi.config.previewAutoModelRouting.mockImplementation(() =>
      Promise.resolve({
        success: true as const,
        data: {
          tierId: "easy",
          tierLabel: "Easy",
          evaluationModel: "anthropic:claude-haiku-4-5",
        },
      })
    );
    const { container, getByLabelText, getByRole } = render(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    await userEvent.type(getByLabelText("Sample prompt"), "Rename a variable");
    fireEvent.click(getByRole("button", { name: "Classify" }));
    await waitFor(() =>
      expect(container.querySelector("[data-auto-model-routing-preview]")).not.toBeNull()
    );
    const preview = container.querySelector("[data-auto-model-routing-preview]")!;
    expect(preview.textContent).toContain("Easy");
    expect(preview.textContent).not.toContain("%");
  });
});
