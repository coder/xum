import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTestApiClient } from "@/browser/testUtils";
import type { ReactNode } from "react";

import * as ActualSelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { APIProvider } from "@/browser/contexts/API";
import * as ActualModelsFromSettingsModule from "@/browser/hooks/useModelsFromSettings";
import * as ActualProvidersConfigModule from "@/browser/hooks/useProvidersConfig";
import * as ActualWorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as ActualModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import {
  getDefaultAutoModelRoutingConfig,
  type AutoModelRoutingConfig,
  type AutoModelRoutingEvaluationStatus,
} from "@/common/types/autoModelRouting";
import { DEFAULT_AUTO_MODEL_ROUTING_EVALUATION_MODEL } from "@/constants/autoModelRouting";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { SELECTED_WORKSPACE_KEY } from "@/common/constants/storage";
import { installDom } from "../../../../../tests/ui/dom";
import { createSelectPrimitiveDouble } from "../../../../../tests/ui/selectPrimitiveDouble";

// Capture before installing module mocks; mock.restore() does not undo them.
const actualModelsFromSettingsModule = { ...ActualModelsFromSettingsModule };
const actualProvidersConfigModule = { ...ActualProvidersConfigModule };
let mockProvidersConfig: ProvidersConfigMap | null = null;
const actualModelSelectorModule = { ...ActualModelSelectorModule };
const actualWorkspaceContextModule = { ...ActualWorkspaceContextModule };
const actualSelectPrimitiveModule = { ...ActualSelectPrimitiveModule };
// Settings renders inside the workspace shell; the panel resolves the billed workspace through
// its metadata map. selectedWorkspace is null on /settings, as in the app.
const SETTINGS_WORKSPACE = {
  id: "ws-settings",
  name: "routing",
  projectName: "xum",
  projectPath: "/repos/xum",
  namedWorkspacePath: "/repos/xum/mike/routing",
} as unknown as FrontendWorkspaceMetadata;
let mockWorkspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();

interface MockApi {
  config: {
    getConfig: ReturnType<typeof mock>;
    onConfigChanged: ReturnType<typeof mock>;
    updateAutoModelRouting: ReturnType<typeof mock>;
    getAutoModelRoutingEvaluationStatus: ReturnType<typeof mock>;
    previewAutoModelRouting: ReturnType<typeof mock>;
  };
}

let mockApi: MockApi;

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
void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  ...actualWorkspaceContextModule,
  useOptionalWorkspaceContext: () => ({
    selectedWorkspace: null,
    workspaceMetadata: mockWorkspaceMetadata,
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
  };
}

// Inject the per-test client through the real provider; mocking the API module leaks across files.
function ApiWrapper(props: { children: ReactNode }) {
  return <APIProvider client={createTestApiClient(mockApi)}>{props.children}</APIProvider>;
}

function renderConfig() {
  return render(<AutoModelRoutingExperimentConfig />, { wrapper: ApiWrapper });
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
    await mock.module(
      "@/browser/hooks/useModelsFromSettings",
      () => actualModelsFromSettingsModule
    );
    await mock.module("@/browser/hooks/useProvidersConfig", () => actualProvidersConfigModule);
    await mock.module("@/browser/contexts/WorkspaceContext", () => actualWorkspaceContextModule);
    await mock.module(
      "@/browser/components/ModelSelector/ModelSelector",
      () => actualModelSelectorModule
    );
    await mock.module(
      "@/browser/components/SelectPrimitive/SelectPrimitive",
      () => actualSelectPrimitiveModule
    );
  });

  beforeEach(() => {
    cleanupDom = installDom();
    mockApi = createMockApi();
    mockProvidersConfig = null;
    // Settings routes carry no workspace; the panel bills previews to the last selected one.
    // Stored in the legacy id-only shape: the label must come from metadata, not from here.
    updatePersistedState(SELECTED_WORKSPACE_KEY, { workspaceId: "ws-settings" });
    mockWorkspaceMetadata = new Map([[SETTINGS_WORKSPACE.id, SETTINGS_WORKSPACE]]);
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
    const { container, getByRole } = renderConfig();
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
    const { container, getByRole } = renderConfig();
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
    const { container, getByLabelText } = renderConfig();
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
    const { container, getByLabelText } = renderConfig();
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
    const { container, getByLabelText } = renderConfig();
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
    const { getByLabelText } = renderConfig();
    const field = getByLabelText("Evaluation model") as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("openai:gpt-5.5"));
  });

  test("a rejected write shows the error and reverts the field to the persisted config", async () => {
    mockApi.config.updateAutoModelRouting = mock(() => Promise.reject(new Error("disk full")));
    const { container, getByLabelText } = renderConfig();
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
    const { container, getByLabelText } = renderConfig();
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
    const { container, getByLabelText } = renderConfig();
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
    const { container } = renderConfig();
    await waitFor(() => expect(statusText(container)).toBe("No TypeSafe API key configured"));
  });

  test("classifying a sample prompt shows the chosen tier, model, and evaluator", async () => {
    const { container, getByLabelText, getByRole } = renderConfig();
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
    const { container, getByLabelText, getByRole } = renderConfig();
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

  test.each([
    ["no workspace was ever selected", () => updatePersistedState(SELECTED_WORKSPACE_KEY, null)],
    [
      "the last selected workspace no longer exists",
      () => updatePersistedState(SELECTED_WORKSPACE_KEY, { workspaceId: "ws-removed" }),
    ],
  ])("Classify stays disabled when %s", async (_case, arrange) => {
    arrange();
    const { container, getByLabelText, getByRole } = renderConfig();
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));

    await userEvent.type(getByLabelText("Sample prompt"), "Refactor the queue");
    expect((getByRole("button", { name: "Classify" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      container.querySelector("[data-auto-model-routing-preview-workspace]")?.textContent
    ).toContain("Open a workspace first");
    expect(mockApi.config.previewAutoModelRouting).not.toHaveBeenCalled();
  });

  test("re-checks the evaluator's availability when the providers config changes", async () => {
    const getStatus = mockApi.config.getAutoModelRoutingEvaluationStatus;
    const { container, rerender } = renderConfig();
    await waitFor(() => expect(tierRows(container)).toHaveLength(4));
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(0));
    const checksAfterLoad = getStatus.mock.calls.length;

    // A key saved or a provider disabled from another window arrives as a new config
    // snapshot; the evaluator text is unchanged, so only this dependency can trigger it.
    const providersWithOpenAI: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };
    mockProvidersConfig = providersWithOpenAI;
    rerender(<AutoModelRoutingExperimentConfig />);
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(checksAfterLoad + 1));
  });

  test("classifying sends the tiers on screen, not the last persisted config", async () => {
    const { container, getByLabelText, getByRole } = renderConfig();
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
    const { container, getByLabelText, getByRole } = renderConfig();
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
