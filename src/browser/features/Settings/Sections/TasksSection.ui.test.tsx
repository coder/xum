// Real Radix exports must initialize after the DOM, even when this suite runs first.
import { installDom } from "../../../../../tests/ui/dom";
import assert from "@/common/utils/assert";
import type React from "react";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as tooltipModule from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { createConnectionHarness, GAP_MODES } from "@/browser/contexts/connection.testHarness";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import {
  createTestApiClient,
  createTestConfig,
  type TestApiOverrides,
  type TestClientConfig,
} from "@/browser/testUtils";
import * as WorkspaceModule from "@/browser/contexts/WorkspaceContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as ExperimentsModule from "@/browser/hooks/useExperiments";
import * as ModelsModule from "@/browser/hooks/useModelsFromSettings";
import * as ModelSelectorModule from "@/browser/components/ModelSelector/ModelSelector";
import * as SelectPrimitiveModule from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  markAiSelectionIntent,
  resetAiSelectionIntentForTests,
} from "@/browser/utils/aiSelectionIntent";
import { getAppConfigStore } from "@/browser/stores/AppConfigStore";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import { FALLBACK_AGENTS } from "./TasksSection.agents";

let experimentsEnabledByDefault = false;
let experimentValues: Record<string, boolean> = {};

let apiMock: {
  config: {
    getConfig: ReturnType<typeof mock>;
    saveConfig: ReturnType<typeof mock>;
  };
  agents?: {
    list: ReturnType<typeof mock>;
  };
} | null = null;

let selectedWorkspaceMock: { projectPath: string; workspaceId: string } | null = null;
let pendingProjectMock: string | null = null;

// Snapshot real exports before Bun replaces their live bindings for this suite.
restoreModulesAfterSuite([
  ["@/browser/contexts/WorkspaceContext", { ...WorkspaceModule }],
  ["@/browser/contexts/ProjectContext", { ...ProjectContextModule }],
  ["@/browser/hooks/useExperiments", { ...ExperimentsModule }],
  ["@/browser/hooks/useModelsFromSettings", { ...ModelsModule }],
  ["@/browser/components/Tooltip/Tooltip", { ...tooltipModule }],
  ["@/browser/components/ModelSelector/ModelSelector", { ...ModelSelectorModule }],
  ["@/browser/components/SelectPrimitive/SelectPrimitive", { ...SelectPrimitiveModule }],
]);

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({
    selectedWorkspace: selectedWorkspaceMock,
    pendingNewWorkspaceProject: pendingProjectMock,
  }),
}));

// The resource limits section lists projects; these tests have none.
void mock.module("@/browser/contexts/ProjectContext", () => ({
  ...ProjectContextModule,
  useProjectContext: () => ({ userProjects: new Map() }),
}));

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: (id: string) => experimentValues[id] ?? experimentsEnabledByDefault,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  getDefaultModel: () => "anthropic:workspace-default",
  useModelsFromSettings: () => ({
    models: [
      "anthropic:foo",
      "anthropic:ui-exec",
      "xai:grok-4-1-fast",
      "openai:gpt-6-luna",
      "openai:subagent-model",
      "xai:grok-code-fast-1",
    ],
    hiddenModelsForSelector: [],
  }),
}));

void mock.module("@/browser/components/Tooltip/Tooltip", () => ({
  Tooltip: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipTrigger: (props: { children: React.ReactNode }) => <>{props.children}</>,
  TooltipContent: (props: { children: React.ReactNode }) => <div>{props.children}</div>,
}));

void mock.module("@/browser/components/ModelSelector/ModelSelector", () => ({
  ModelSelector: (props: {
    value: string;
    emptyLabel?: string;
    onChange: (value: string) => void;
    models: string[];
    autoRouting?: { active: boolean; onSelect: () => void };
  }) => (
    <>
      <select
        aria-label="Model"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <option value="">{props.emptyLabel ?? "Inherit"}</option>
        {props.models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      {props.autoRouting ? (
        <button
          type="button"
          aria-label="Model Auto"
          aria-pressed={props.autoRouting.active}
          onClick={props.autoRouting.onSelect}
        />
      ) : null}
    </>
  ),
}));

// The native select takes the trigger's accessible name, as the Radix trigger carries it.
function MockSelectTrigger(_props: { "aria-label"?: string }) {
  return null;
}
void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => {
    const trigger = (Array.isArray(props.children) ? props.children : [props.children]).find(
      (child): child is React.ReactElement<{ "aria-label"?: string }> =>
        (child as React.ReactElement | null)?.type === MockSelectTrigger
    );
    return (
      <select
        aria-label={trigger?.props["aria-label"] ?? "Select"}
        value={props.value}
        onChange={(event) => props.onValueChange(event.currentTarget.value)}
      >
        {props.children}
      </select>
    );
  },
  SelectContent: (props: { children: React.ReactNode }) => <>{props.children}</>,
  SelectItem: (props: { value: string; children: React.ReactNode }) => (
    <option value={props.value}>{props.children}</option>
  ),
  SelectTrigger: MockSelectTrigger,
  SelectValue: () => null,
}));

import { TasksSection } from "./TasksSection";

interface RenderTasksSectionOptions {
  agentAiDefaults?: AgentAiDefaults;
  /** When set, serves this discovered-agent list instead of FALLBACK_AGENTS. */
  agents?: AgentDefinitionDescriptor[];
  workspaceModel?: string;
  minThinkingLevelByModel?: TestClientConfig["minThinkingLevelByModel"];
  /** Settings over the project page: the agents come from the project, with no workspace. */
  projectPageOnly?: boolean;
}

function renderTasksSection(options: RenderTasksSectionOptions = {}) {
  const saveConfig = mock(() => Promise.resolve(undefined));
  const getConfig = mock(() =>
    Promise.resolve(
      createTestConfig({
        agentAiDefaults: options.agentAiDefaults ?? {},
        minThinkingLevelByModel: options.minThinkingLevelByModel,
      })
    )
  );

  apiMock = {
    config: {
      getConfig,
      saveConfig,
    },
    ...(options.agents || options.workspaceModel
      ? { agents: { list: mock(() => Promise.resolve(options.agents ?? FALLBACK_AGENTS)) } }
      : {}),
  } satisfies TestApiOverrides<APIClient>;
  // Discovery only runs for a selected workspace's project.
  selectedWorkspaceMock =
    (options.agents || options.workspaceModel) && !options.projectPageOnly
      ? { projectPath: "/proj", workspaceId: "ws-1" }
      : null;
  pendingProjectMock = options.projectPageOnly ? "/proj" : null;
  resetAiSelectionIntentForTests();
  if (options.workspaceModel) {
    markAiSelectionIntent("ws-1", "model", options.workspaceModel);
  }

  // Inject the per-test client through the real provider; mocking the API module leaks into
  // later files.
  const view = render(
    <APIProvider client={createTestApiClient(apiMock)}>
      <TasksSection />
    </APIProvider>
  );
  return { ...view, getConfig, saveConfig };
}

function getExecSubagentRow(view: ReturnType<typeof renderTasksSection>): HTMLElement {
  return view.getByRole("group", { name: "Exec defaults" });
}

function getAgentCardByName(
  view: ReturnType<typeof renderTasksSection>,
  name: string
): HTMLElement {
  const title = view.getByText(name);
  const card = title.closest(".rounded-md");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Could not find ${name} agent card`);
  }
  return card;
}

const CYBER_CAPABLE_MODEL = "openai:gpt-6.1-sol";
const REASONING_MODE_TOGGLES: Array<{ mode: "pro" | "cyber"; component: string }> = [
  { mode: "pro", component: "ProModeToggle" },
  { mode: "cyber", component: "CyberModeToggle" },
];

let providersConfigSpy: { mockRestore: () => void } | null = null;

function enableCyberModel() {
  providersConfigSpy = spyOn(getProvidersConfigStore(), "getConfig").mockReturnValue({
    openai: { apiKeySet: true, isEnabled: true, isConfigured: true, cyberModelEnabled: true },
  });
}

function getLatestSavePayload(saveConfig: ReturnType<typeof mock>) {
  const calls = saveConfig.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as {
    agentAiDefaults: AgentAiDefaults;
  };
}

// The Reasoning control is the shared ThinkingSelectorControl (inline menu, not
// a native select), so tests drive it by opening the trigger and clicking rows.
function selectReasoningOption(container: HTMLElement, optionName: string) {
  fireEvent.click(within(container).getByRole("button", { name: "Reasoning" }));
  const listbox = within(container).getByRole("listbox", { name: "Reasoning effort" });
  fireEvent.click(within(listbox).getByRole("option", { name: optionName }));
}

describe("TasksSection Exec subagent defaults", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    getAppConfigStore().updateOptimistically({ minThinkingLevelByModel: {} });
    experimentsEnabledByDefault = false;
    experimentValues = {};
    apiMock = null;
    selectedWorkspaceMock = null;
  });

  afterEach(() => {
    cleanup();
    providersConfigSpy?.mockRestore();
    providersConfigSpy = null;
    getAppConfigStore().updateOptimistically({ minThinkingLevelByModel: {} });
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  test("renders a distinct Exec subagent row", async () => {
    const view = renderTasksSection();

    await view.findByRole("group", { name: "Exec defaults" });
    expect(within(getExecSubagentRow(view)).getByText("Exec")).toBeTruthy();
    expect(view.getByText("UI agents")).toBeTruthy();
    expect(view.getByText("Sub-agents")).toBeTruthy();
  });

  test("preserves unchanged nested subagent defaults when saving an agent-only change", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        foo: { enabled: true },
        exec: { subagent: { modelString: "openai:subagent-model" } },
      },
    });

    await view.findByText("Explore");
    fireEvent.click(
      within(getAgentCardByName(view, "Explore")).getByRole("switch", {
        name: "Toggle explore enabled",
      })
    );

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore).toEqual({ enabled: false });
    expect(payload.agentAiDefaults.exec?.subagent).toEqual({
      modelString: "openai:subagent-model",
    });
    expect("subagentAiDefaults" in payload).toBe(false);
  });

  test("pagehide saves a change made inside the autosave delay, once (#7157)", async () => {
    // Record which pagehide listeners come and go; the real methods still run. Wrapped by hand
    // and restored from their descriptors: bun's spyOn on the happy-dom window broke later
    // test files.
    const addDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener");
    const removeDescriptor = Object.getOwnPropertyDescriptor(window, "removeEventListener");
    assert(addDescriptor && removeDescriptor, "happy-dom defines the listener methods on window");
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListener, options?: boolean) => {
      if (type === "pagehide") added.push(listener);
      realAdd(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListener, options?: boolean) => {
      if (type === "pagehide") removed.push(listener);
      realRemove(type, listener, options);
    }) as typeof window.removeEventListener;
    try {
      const view = renderTasksSection();
      await view.findByText("Explore");
      fireEvent.click(
        within(getAgentCardByName(view, "Explore")).getByRole("switch", {
          name: "Toggle explore enabled",
        })
      );

      // A reload right after the change: pagehide fires before the debounced save.
      fireEvent(window, new window.Event("pagehide"));
      expect(view.saveConfig).toHaveBeenCalledTimes(1);
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.explore).toEqual({
        enabled: false,
      });

      // The unmount after pagehide does not save the same change again.
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(view.saveConfig).toHaveBeenCalledTimes(1);
      expect(added.length).toBeGreaterThan(0);
      expect(removed).toEqual(added);
    } finally {
      Object.defineProperty(window, "addEventListener", addDescriptor);
      Object.defineProperty(window, "removeEventListener", removeDescriptor);
    }
  });

  test("pagehide during an in-flight autosave still sends the newer change", async () => {
    const view = renderTasksSection();
    // The first autosave never settles, as over a slow channel.
    view.saveConfig.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    await view.findByText("Explore");
    const toggle = (agentId: string) =>
      fireEvent.click(view.getByRole("switch", { name: `Toggle ${agentId} enabled` }));

    toggle("explore");
    await waitFor(() => expect(view.saveConfig).toHaveBeenCalledTimes(1));
    toggle("name_workspace");
    fireEvent(window, new window.Event("pagehide"));

    expect(view.saveConfig).toHaveBeenCalledTimes(2);
    expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.name_workspace).toEqual({
      enabled: false,
    });
  });

  test("includes nested subagent defaults when saving a delegated default change", async () => {
    const view = renderTasksSection();
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "openai:subagent-model" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect("subagentAiDefaults" in payload).toBe(false);
    expect(payload.agentAiDefaults.exec?.subagent).toEqual({
      modelString: "openai:subagent-model",
    });
  });

  test.each(["openai:gpt-6-luna", "xai:grok-code-fast-1"])(
    "does not resolve or persist inherited preferences from global Exec model %s",
    async (modelString) => {
      const view = renderTasksSection({
        agentAiDefaults: { exec: { modelString, thinkingLevel: "medium", reasoningMode: "pro" } },
      });
      const row = await view.findByRole("group", { name: "Exec defaults" });
      const trigger = within(row).getByRole("button", { name: "Reasoning" });
      expect(trigger.textContent).not.toContain("PRO");
      expect(within(row).getByLabelText<HTMLSelectElement>("Model").value).toBe("");
      fireEvent.click(trigger);
      const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
      expect(within(listbox).getByRole("option", { selected: true }).textContent).not.toContain(
        "Medium"
      );
      for (const level of ["Off", "Low", "Medium", "High", "Extra High", "Max"]) {
        expect(
          within(listbox).getByRole("option", { name: level }).getAttribute("aria-selected")
        ).toBe("false");
      }
      expect(
        within(row)
          .getByRole("button", { name: /Pro mode/ })
          .getAttribute("aria-pressed")
      ).toBe("mixed");
      expect(within(row).queryByRole("button", { name: /Fast mode/ })).toBeNull();
      expect(view.saveConfig).not.toHaveBeenCalled();
    }
  );

  test("defers inherited-model effort capabilities without persisting a model or mode", async () => {
    const view = renderTasksSection({
      agentAiDefaults: { exec: { modelString: "xai:grok-code-fast-1", reasoningMode: "pro" } },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });
    selectReasoningOption(row, "Max");
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
        thinkingLevel: "max",
      })
    );
    const trigger = within(row).getByRole("button", { name: "Reasoning" });
    expect(trigger.textContent).toContain("Max");
    expect(trigger.textContent).not.toContain("PRO");
    const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Extra High" }));
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
        thinkingLevel: "xhigh",
      })
    );
    expect(trigger.textContent).toContain("Extra High");
  });

  test("explicit subagent models use their capabilities while mode remains inherited", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: {
          reasoningMode: "pro",
          subagent: { modelString: "openai:gpt-6-luna", thinkingLevel: "high" },
        },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: "Reasoning" }));
    expect(
      within(row)
        .getByRole("button", { name: /Pro mode/ })
        .getAttribute("aria-pressed")
    ).toBe("mixed");
    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "xai:grok-code-fast-1" },
    });
    expect(within(row).queryByRole("button", { name: /Pro mode/ })).toBeNull();
    expect(within(row).queryByRole("option", { name: "Max" })).toBeNull();
    await waitFor(() =>
      expect(
        getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent?.reasoningMode
      ).toBeUndefined()
    );
  });

  test("setting only the Exec subagent model writes only the sparse subagent model", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.change(within(row).getByLabelText("Model"), {
      target: { value: "openai:subagent-model" },
    });

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
      subagent: { modelString: "openai:subagent-model" },
    });
    expect(payload.agentAiDefaults.exec?.subagent?.thinkingLevel).toBeUndefined();
  });

  test("setting only the Exec subagent thinking writes only the sparse subagent thinking", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    selectReasoningOption(row, "High");

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toEqual({
      modelString: "anthropic:ui-exec",
      thinkingLevel: "medium",
      subagent: { thinkingLevel: "high" },
    });
    expect("modelString" in (payload.agentAiDefaults.exec?.subagent ?? {})).toBe(false);
  });

  test("resetting one Exec subagent field removes only that field", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: {
          subagent: { modelString: "openai:subagent-model", thinkingLevel: "high" },
        },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getAllByRole("button", { name: "Reset" })[0]);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec?.subagent).toEqual({ thinkingLevel: "high" });
  });

  test("resetting the last Exec subagent field removes the exec entry", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { subagent: { modelString: "openai:subagent-model" } },
      },
    });
    const row = await view.findByRole("group", { name: "Exec defaults" });

    fireEvent.click(within(row).getByRole("button", { name: "Reset" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toBeUndefined();
  });

  test.each(REASONING_MODE_TOGGLES)(
    "toggling $mode mode persists the agent default",
    async ({ mode, component }) => {
      enableCyberModel();
      const view = renderTasksSection({
        agentAiDefaults: {
          explore: { modelString: CYBER_CAPABLE_MODEL },
        },
      });

      await view.findByText("Explore");
      const card = getAgentCardByName(view, "Explore");
      fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
      const modeToggle = card.querySelector(`[data-component="${component}"]`);
      if (!(modeToggle instanceof HTMLElement)) throw new Error(`${component} not rendered`);
      fireEvent.click(modeToggle);

      await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
      const payload = getLatestSavePayload(view.saveConfig);

      expect(payload.agentAiDefaults.explore?.reasoningMode).toBe(mode);
    }
  );

  test("toggling Pro mode off removes the persisted reasoning mode", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "openai:gpt-6-luna", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBeUndefined();
    expect(payload.agentAiDefaults.explore?.modelString).toBe("openai:gpt-6-luna");
  });

  test.each(["standard", "pro"] as const)(
    "cycles inherited mode through explicit Pro and Standard regardless of global %s",
    async (reasoningMode) => {
      const view = renderTasksSection({
        agentAiDefaults: { exec: { modelString: "openai:gpt-6-luna", reasoningMode } },
      });
      const row = await view.findByRole("group", { name: "Exec defaults" });
      const trigger = within(row).getByRole("button", { name: "Reasoning" });
      fireEvent.click(trigger);
      const proToggle = within(row).getByRole("button", { name: /Pro mode/ });
      expect(proToggle.getAttribute("aria-pressed")).toBe("mixed");
      for (const mode of ["pro", "standard", "pro"] as const) {
        fireEvent.click(proToggle);
        await waitFor(() =>
          expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toEqual({
            reasoningMode: mode,
          })
        );
        expect(proToggle.getAttribute("aria-pressed")).toBe(String(mode === "pro"));
        expect(trigger.textContent).toContain(mode.toUpperCase());
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.reasoningMode).toBe(
          reasoningMode
        );
      }
      const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
      fireEvent.click(within(listbox).getByRole("option", { selected: true }));
      await waitFor(() =>
        expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.exec?.subagent).toBeUndefined()
      );
      expect(proToggle.getAttribute("aria-pressed")).toBe("mixed");
    }
  );

  test.each(REASONING_MODE_TOGGLES)(
    "disabling $mode mode inherited from a base agent persists an explicit standard override",
    async ({ mode, component }) => {
      enableCyberModel();
      // Explore's base is exec (FALLBACK_AGENTS), so ACP resolution inherits
      // exec's mode; deleting explore's override would silently fall back to it.
      const view = renderTasksSection({
        agentAiDefaults: {
          exec: { reasoningMode: mode },
          explore: { modelString: CYBER_CAPABLE_MODEL, reasoningMode: mode },
        },
      });

      await view.findByText("Explore");
      const card = getAgentCardByName(view, "Explore");
      fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
      const modeToggle = card.querySelector(`[data-component="${component}"]`);
      if (!(modeToggle instanceof HTMLElement)) throw new Error(`${component} not rendered`);
      fireEvent.click(modeToggle);

      await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
      const payload = getLatestSavePayload(view.saveConfig);

      expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("standard");
      expect(payload.agentAiDefaults.exec?.reasoningMode).toBe(mode);
    }
  );

  test("selecting Inherit clears the reasoning override along with the thinking level", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { subagent: { thinkingLevel: "high", reasoningMode: "standard" } },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: /Reasoning/ }));
    const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Use calling chat’s Exec" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    // Both fields cleared empties the entry entirely.
    expect(payload.agentAiDefaults.exec).toBeUndefined();
  });

  test("displays base-chain-inherited Pro mode and disables it in one click", async () => {
    // Explore has no direct override; its base exec supplies pro, which ACP
    // resolution applies, so the toggle must start pressed and one click must
    // persist an explicit standard override.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
        explore: { modelString: "openai:gpt-6-luna" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("standard");
  });

  test("gates Pro on the base-chain-inherited model, not the ambient default", async () => {
    // Explore inherits exec's GPT-5.6 (pro-capable) with no direct model
    // override; the ambient default (anthropic:workspace-default) is not.
    // The toggle must appear (and show inherited pro) so it can be disabled
    // without first overriding the model.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-6-luna", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
  });

  test("gates Pro on the agent definition's pinned model when Settings has no override", async () => {
    // The definition pins ai.model to GPT-5.6 (pro-capable) while Settings has
    // no model override anywhere in the chain and the ambient default is
    // Anthropic. ACP/task resolution runs the definition model, so the card
    // must gate Pro against it, not the ambient fallback.
    const view = renderTasksSection({
      agents: [
        {
          id: "researcher",
          scope: "project",
          name: "Researcher",
          uiSelectable: false,
          subagentRunnable: true,
          aiDefaults: { model: "openai:gpt-6-luna" },
        },
      ],
    });

    await view.findByText("Researcher");
    const card = getAgentCardByName(view, "Researcher");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    expect(card.querySelector('[data-component="ProModeToggle"]')).not.toBeNull();
  });

  test("gates Pro on the settings base's model, not a base pin the settings base replaced", async () => {
    // A Cursor `model: fast` agent on Exec, where a project exec.md pins a pro-capable model. A
    // run resolves [ci-watcher, explore, exec], so Explore's Settings model outranks that pin,
    // while the base-merged aiDefaults still carry it.
    const view = renderTasksSection({
      agents: [
        {
          id: "ci-watcher",
          scope: "global",
          name: "CI Watcher",
          uiSelectable: false,
          subagentRunnable: true,
          base: "exec",
          aiSettingsBase: "explore",
          aiDefaults: { model: "openai:gpt-6-luna", settingsBase: "explore" },
          aiLayers: {
            ancestors: [
              { agentId: "explore", definitionAiDefaults: { cacheTtl: "5m" } },
              { agentId: "exec", definitionAiDefaults: { model: "openai:gpt-6-luna" } },
            ],
          },
        },
      ],
      agentAiDefaults: { explore: { modelString: "anthropic:foo" } },
    });

    await view.findByText("CI Watcher");
    const card = getAgentCardByName(view, "CI Watcher");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("hides the Pro mode toggle on the Name Workspace card even for pro-capable models", async () => {
    // Name generation runs raw streamText (workspaceTitleGenerator) and never
    // applies reasoningMode, same headless class as Dream.
    const view = renderTasksSection({
      agentAiDefaults: {
        name_workspace: { modelString: "openai:gpt-6-luna" },
      },
    });

    await view.findByText("Name Workspace");
    const card = getAgentCardByName(view, "Name Workspace");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("hides the Pro mode toggle on the Dream card even for pro-capable models", async () => {
    // Dream's headless requests (raw streamText) never apply reasoningMode,
    // so the card must not offer a toggle that cannot affect them.
    experimentsEnabledByDefault = true; // enables memory consolidation
    const view = renderTasksSection({
      agentAiDefaults: {
        dream: { modelString: "openai:gpt-6-luna" },
      },
    });

    await view.findByText("Dream");
    const card = getAgentCardByName(view, "Dream");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("hides the Pro mode toggle for models without pro support", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "anthropic:foo" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));

    expect(within(card).getByRole("listbox", { name: "Reasoning effort" })).toBeTruthy();
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });
});

describe("TasksSection Auto routing defaults", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    experimentsEnabledByDefault = false;
    experimentValues = { [EXPERIMENT_IDS.AUTO_MODEL_ROUTING]: true };
    apiMock = null;
    selectedWorkspaceMock = null;
  });

  afterEach(() => {
    cleanup();
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  // "Plan" also labels a default-agent option, so resolve the card from its title element.
  function getCard(view: ReturnType<typeof renderTasksSection>, name: string): HTMLElement {
    const card = view
      .getAllByText(name)
      .map((element) => element.closest(".rounded-md"))
      .find((element) => element instanceof HTMLElement);
    if (!(card instanceof HTMLElement)) throw new Error(`Could not find ${name} agent card`);
    return card;
  }

  function openReasoningMenu(card: HTMLElement): HTMLElement {
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    return within(card).getByRole("listbox", { name: "Reasoning effort" });
  }

  test("offers Auto only on UI and unknown agent cards while the experiment is on", async () => {
    const view = renderTasksSection({
      agentAiDefaults: { mystery: { autoModelRouting: true } },
    });
    await view.findAllByText("Plan");

    const plan = getCard(view, "Plan");
    expect(within(plan).getByRole("button", { name: "Model Auto" })).toBeTruthy();
    expect(within(openReasoningMenu(plan)).getByRole("option", { name: "Auto" })).toBeTruthy();

    const mystery = getAgentCardByName(view, "mystery");
    expect(
      within(mystery).getByRole("button", { name: "Model Auto" }).getAttribute("aria-pressed")
    ).toBe("true");

    for (const card of [getAgentCardByName(view, "Explore"), getExecSubagentRow(view)]) {
      expect(within(card).queryByRole("button", { name: "Model Auto" })).toBeNull();
      expect(within(openReasoningMenu(card)).queryByRole("option", { name: "Auto" })).toBeNull();
    }
  });

  test("hides Auto while the experiment is off", async () => {
    experimentValues = {};
    const view = renderTasksSection();
    await view.findAllByText("Plan");

    const plan = getCard(view, "Plan");
    expect(within(plan).queryByRole("button", { name: "Model Auto" })).toBeNull();
    expect(within(openReasoningMenu(plan)).queryByRole("option", { name: "Auto" })).toBeNull();
  });

  test("selecting Auto keeps the concrete fallback and saves the flags", async () => {
    const view = renderTasksSection({
      agentAiDefaults: { plan: { modelString: "anthropic:foo", thinkingLevel: "medium" } },
    });
    await view.findAllByText("Plan");
    const plan = getCard(view, "Plan");

    fireEvent.click(within(plan).getByRole("button", { name: "Model Auto" }));
    fireEvent.click(within(openReasoningMenu(plan)).getByRole("option", { name: "Auto" }));

    await waitFor(() => {
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.plan).toEqual({
        modelString: "anthropic:foo",
        thinkingLevel: "medium",
        autoModelRouting: true,
        autoThinkingLevel: true,
      });
    });
  });

  test("Reset, Inherit, and concrete picks each clear their dimension's Auto flag", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        plan: { autoModelRouting: true, autoThinkingLevel: true },
        mystery: { modelString: "anthropic:foo", autoModelRouting: true },
      },
    });
    await view.findAllByText("Plan");
    const plan = getCard(view, "Plan");

    const menu = openReasoningMenu(plan);
    expect(
      within(menu).getByRole("option", { name: "Inherit" }).getAttribute("aria-selected")
    ).toBe("false");
    fireEvent.click(within(menu).getByRole("option", { name: "Inherit" }));
    fireEvent.click(within(plan).getByRole("button", { name: "Reset" }));

    fireEvent.change(within(getAgentCardByName(view, "mystery")).getByLabelText("Model"), {
      target: { value: "openai:gpt-6-luna" },
    });

    await waitFor(() => {
      const payload = getLatestSavePayload(view.saveConfig);
      expect(payload.agentAiDefaults.plan).toBeUndefined();
      expect(payload.agentAiDefaults.mystery).toEqual({ modelString: "openai:gpt-6-luna" });
    });
  });
});

// A reconnect reloads the config and the agents through the new client. The agent list stays on
// screen ("Loading agents…" is for another project only), and a value the user changed but the
// debounced autosave has not sent yet is kept and saved, not replaced by the reload.
describe.each([...GAP_MODES])("TasksSection across a reconnect (%s)", (mode) => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    experimentsEnabledByDefault = false;
    experimentValues = {};
    selectedWorkspaceMock = { projectPath: "/proj", workspaceId: "ws-1" };
  });

  afterEach(() => {
    cleanup();
    apiMock = null;
    selectedWorkspaceMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  function connect(maxParallelAgentTasks: number, agents: Promise<AgentDefinitionDescriptor[]>) {
    const saveConfig = mock((_payload: { taskSettings: { maxParallelAgentTasks: number } }) =>
      Promise.resolve(undefined)
    );
    apiMock = {
      config: {
        getConfig: mock(() =>
          Promise.resolve(
            createTestConfig({
              taskSettings: { ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks },
            })
          )
        ),
        saveConfig,
      },
      agents: { list: mock(() => agents) },
    };
    return saveConfig;
  }

  function maxParallelInput(view: ReturnType<typeof render>): HTMLInputElement {
    const row = view.getByText("Max Parallel Agent Tasks").closest(".justify-between");
    const input = row?.querySelector("input");
    if (!(input instanceof window.HTMLInputElement)) throw new Error("No max-parallel input");
    return input;
  }

  test("keeps the agent list while the reload is pending", async () => {
    connect(3, Promise.resolve(FALLBACK_AGENTS));
    const harness = createConnectionHarness(mode, () => apiMock ?? {});
    const view = render(
      <harness.Wrapper>
        <TasksSection />
      </harness.Wrapper>
    );
    await waitFor(() => expect(view.queryByText("Loading agents…") === null).toBe(true));

    connect(3, new Promise(() => undefined));
    await harness.drop();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(view.queryByText("Loading agents…")).toBeNull();
  });

  test("keeps and saves a change the reload would overwrite", async () => {
    connect(3, Promise.resolve(FALLBACK_AGENTS));
    const harness = createConnectionHarness(mode, () => apiMock ?? {});
    const view = render(
      <harness.Wrapper>
        <TasksSection />
      </harness.Wrapper>
    );
    await waitFor(() => expect(maxParallelInput(view).value).toBe("3"));

    // The change, then the reconnect, before the debounced autosave fires.
    const input = maxParallelInput(view);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps"));
    const onChange = (
      reactPropsKey ? (input as unknown as Record<string, unknown>)[reactPropsKey] : null
    ) as { onChange?: (event: { target: { value: string } }) => void } | null;
    if (!onChange?.onChange) throw new Error("Expected the input to expose its onChange handler");
    const change = onChange.onChange;
    act(() => change({ target: { value: "7" } }));
    const saveConfig = connect(5, Promise.resolve(FALLBACK_AGENTS));
    await harness.drop();
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(maxParallelInput(view).value).toBe("7");
    await waitFor(() => expect(saveConfig).toHaveBeenCalled(), { timeout: 2_000 });
    expect(saveConfig.mock.calls.at(-1)?.[0].taskSettings.maxParallelAgentTasks).toBe(7);
  });

  // Offline an edit would live only in this section's state, and leaving the section before the
  // reconnect would lose it: the controls must be disabled until a live client is back.
  test("disables the controls while offline", async () => {
    connect(3, Promise.resolve(FALLBACK_AGENTS));
    const harness = createConnectionHarness(mode, () => apiMock ?? {});
    const view = render(
      <harness.Wrapper>
        <TasksSection />
      </harness.Wrapper>
    );
    await waitFor(() => expect(maxParallelInput(view).value).toBe("3"));
    // happy-dom does not apply a disabled <fieldset> to `:disabled`: read the fieldset (browsers
    // disable every control inside it).
    const isDisabled = (input: HTMLInputElement) =>
      input.disabled || input.closest("fieldset")?.disabled === true;
    expect(isDisabled(maxParallelInput(view))).toBe(false);

    await harness.drop();
    await waitFor(() => expect(isDisabled(maxParallelInput(view))).toBe(true));
    // The kept value stays on screen.
    expect(maxParallelInput(view).value).toBe("3");

    // Until the reload answers the controls stay disabled: an edit then would be replaced by it.
    let answer: (() => void) | null = null;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    connect(3, Promise.resolve(FALLBACK_AGENTS));
    const config = apiMock?.config.getConfig;
    if (!apiMock || !config) throw new Error("connect() sets the client");
    apiMock.config.getConfig = mock(() => answered.then(() => config() as unknown));
    harness.reconnect();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(isDisabled(maxParallelInput(view))).toBe(true);
    act(() => answer?.());
    await waitFor(() => expect(isDisabled(maxParallelInput(view))).toBe(false));
  });
});

// #6384: the limit inputs used to clamp and autosave on every keystroke, so clearing a field saved
// 1. The field must keep the typed text, save only a valid value, and settle the text on blur.
describe("TasksSection limit inputs", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    experimentsEnabledByDefault = false;
    experimentValues = {};
    apiMock = null;
    selectedWorkspaceMock = null;
  });

  afterEach(() => {
    cleanup();
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  function limitInput(view: ReturnType<typeof render>, label: string): HTMLInputElement {
    const row = view.getByText(label).closest(".justify-between");
    const input = row?.querySelector("input");
    if (!(input instanceof window.HTMLInputElement)) throw new Error(`No input for ${label}`);
    return input;
  }

  // fireEvent does not reach this Input's React handlers in happy-dom (see the reconnect suite
  // above), so call them through React's props, as a browser event would.
  function reactHandlers(input: HTMLInputElement) {
    const key = Object.keys(input).find((name) => name.startsWith("__reactProps"));
    return (key ? (input as unknown as Record<string, unknown>)[key] : null) as {
      onChange?: (event: { target: { value: string } }) => void;
      onBlur?: (event: { target: { value: string } }) => void;
      onKeyDown?: (event: { key: string }) => void;
    } | null;
  }

  function type(view: ReturnType<typeof render>, label: string, value: string) {
    const onChange = reactHandlers(limitInput(view, label))?.onChange;
    if (!onChange) throw new Error("Expected an onChange handler");
    act(() => onChange({ target: { value } }));
  }

  // Without an onBlur handler, a blur changes nothing.
  function blur(view: ReturnType<typeof render>, label: string) {
    const input = limitInput(view, label);
    const onBlur = reactHandlers(input)?.onBlur;
    if (onBlur) act(() => onBlur({ target: { value: input.value } }));
  }

  const savedValues = (saveConfig: ReturnType<typeof mock>, key: string): unknown[] =>
    saveConfig.mock.calls.map(
      (call) => (call[0] as { taskSettings: Record<string, unknown> }).taskSettings[key]
    );

  // Longer than the autosave debounce, so a save of the cleared field would have happened.
  const waitPastAutosave = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

  test("Max Parallel Agent Tasks keeps the typed text and never saves a cleared field as 1", async () => {
    const view = renderTasksSection();
    const label = "Max Parallel Agent Tasks";
    await waitFor(() => expect(limitInput(view, label).value).toBe("32"));

    type(view, label, "");
    expect(limitInput(view, label).value).toBe("");
    await waitPastAutosave();
    expect(savedValues(view.saveConfig, "maxParallelAgentTasks")).not.toContain(1);

    // A valid value saves while the user types.
    type(view, label, "12");
    expect(limitInput(view, label).value).toBe("12");
    await waitFor(() =>
      expect(savedValues(view.saveConfig, "maxParallelAgentTasks")).toContain(12)
    );

    // An out-of-range value stays as typed, then clamps on blur.
    type(view, label, "999");
    expect(limitInput(view, label).value).toBe("999");
    blur(view, label);
    expect(limitInput(view, label).value).toBe("256");
    await waitFor(() =>
      expect(savedValues(view.saveConfig, "maxParallelAgentTasks").at(-1)).toBe(256)
    );

    // A field left empty goes back to the saved value.
    type(view, label, "");
    blur(view, label);
    expect(limitInput(view, label).value).toBe("256");
    await waitPastAutosave();
    expect(savedValues(view.saveConfig, "maxParallelAgentTasks")).not.toContain(1);
  });

  test("Max Task Nesting Depth keeps the typed text and reverts an empty field on blur", async () => {
    const view = renderTasksSection();
    const label = "Max Task Nesting Depth";
    await waitFor(() => expect(limitInput(view, label).value).toBe("5"));

    type(view, label, "");
    expect(limitInput(view, label).value).toBe("");
    blur(view, label);
    expect(limitInput(view, label).value).toBe("5");

    // Enter settles the text like blur: an out-of-range value clamps to the maximum.
    type(view, label, "9");
    const onKeyDown = reactHandlers(limitInput(view, label))?.onKeyDown;
    if (!onKeyDown) throw new Error("Expected an onKeyDown handler");
    act(() => onKeyDown({ key: "Enter" }));
    expect(limitInput(view, label).value).toBe("5");

    type(view, label, "2");
    await waitFor(() => expect(savedValues(view.saveConfig, "maxTaskNestingDepth")).toContain(2));
    await waitPastAutosave();
    expect(savedValues(view.saveConfig, "maxTaskNestingDepth")).not.toContain(1);
  });
});

describe("TasksSection prompt cache TTL", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    experimentsEnabledByDefault = false;
    experimentValues = {};
    apiMock = null;
    selectedWorkspaceMock = null;
  });

  afterEach(() => {
    cleanup();
    providersConfigSpy?.mockRestore();
    providersConfigSpy = null;
    apiMock = null;
    restoreDom?.();
    restoreDom = null;
  });

  const cacheSelect = (view: ReturnType<typeof renderTasksSection>, agentId: string) =>
    view.queryByRole("combobox", { name: `${agentId} prompt cache duration` });
  const selectedOptionText = (select: HTMLElement | null) => {
    const value = (select as { value?: string } | null)?.value;
    return [...(select?.querySelectorAll("option") ?? [])].find((option) => option.value === value)
      ?.textContent;
  };
  const setGlobalCacheTtl = (cacheTtl: "5m" | "1h") => {
    providersConfigSpy = spyOn(getProvidersConfigStore(), "getConfig").mockReturnValue({
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true, cacheTtl },
    });
  };

  test("choosing 1 hour saves it, and Inherit removes it", async () => {
    const view = renderTasksSection();
    await view.findByText("Explore");

    fireEvent.change(cacheSelect(view, "explore")!, { target: { value: "1h" } });
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.explore).toEqual({
        cacheTtl: "1h",
      })
    );

    fireEvent.change(cacheSelect(view, "explore")!, { target: { value: "__inherit__" } });
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.explore).toBeUndefined()
    );
  });

  test("an unknown agent's stale value shows and resets to Inherit", async () => {
    const view = renderTasksSection({ agentAiDefaults: { mystery: { cacheTtl: "1h" } } });
    await view.findAllByText("Plan");

    expect(selectedOptionText(cacheSelect(view, "mystery"))).toBe("1 hour");
    fireEvent.change(cacheSelect(view, "mystery")!, { target: { value: "__inherit__" } });
    await waitFor(() =>
      expect(getLatestSavePayload(view.saveConfig).agentAiDefaults.mystery).toBeUndefined()
    );
  });

  test("Inherit names the value the agent inherits without its own Settings value", async () => {
    setGlobalCacheTtl("1h");
    const view = renderTasksSection({
      agentAiDefaults: { exec: { cacheTtl: "5m" }, researcher: { cacheTtl: "1h" } },
      agents: [
        ...FALLBACK_AGENTS.filter((agent) => agent.id !== "explore"),
        {
          ...FALLBACK_AGENTS.find((agent) => agent.id === "explore")!,
          aiDefaults: { cacheTtl: "5m" },
        },
        {
          id: "researcher",
          scope: "project",
          name: "Researcher",
          base: "exec",
          uiSelectable: false,
          subagentRunnable: true,
        },
      ],
    });
    await view.findByText("Researcher");

    // Its own Settings value is shown as the choice, and Inherit names its base's value.
    expect(selectedOptionText(cacheSelect(view, "researcher"))).toBe("1 hour");
    expect(
      within(cacheSelect(view, "researcher")!).getByRole("option", { name: "Inherit (5 minutes)" })
    ).toBeTruthy();
    // Explore's frontmatter outranks its base's Settings value and the global 1h.
    expect(selectedOptionText(cacheSelect(view, "explore"))).toBe("Inherit (5 minutes)");
    // Plan has no base and no value: the global TTL.
    expect(selectedOptionText(cacheSelect(view, "plan"))).toBe("Inherit (1 hour)");
  });

  test("without discovered agents, Inherit reads the fallback agents' own frontmatter", async () => {
    setGlobalCacheTtl("1h");
    const view = renderTasksSection();
    await view.findByText("Explore");

    // Built-in explore's frontmatter 5m outranks the global 1h, as in a run of explore.
    expect(selectedOptionText(cacheSelect(view, "explore"))).toBe("Inherit (5 minutes)");
    expect(selectedOptionText(cacheSelect(view, "plan"))).toBe("Inherit (1 hour)");
  });

  test("Inherit ranks a base's Settings value above frontmatter merged from that base", async () => {
    const explore = FALLBACK_AGENTS.find((agent) => agent.id === "explore")!;
    const subagent = { scope: "project" as const, uiSelectable: false, subagentRunnable: true };
    const view = renderTasksSection({
      agentAiDefaults: { explore: { cacheTtl: "1h" } },
      agents: [
        ...FALLBACK_AGENTS,
        {
          ...subagent,
          id: "scout",
          name: "Scout",
          base: "explore",
          // agents.list merges explore's frontmatter 5m into Scout's aiDefaults.
          aiDefaults: explore.aiDefaults,
          aiLayers: {
            ancestors: [
              { agentId: "explore", definitionAiDefaults: explore.aiDefaults },
              { agentId: "exec" },
            ],
          },
        },
        // Did not resolve, so Inherit walks its declared base Scout, by Scout's own layer.
        { ...subagent, id: "draft", name: "Draft", base: "scout" },
      ],
    });
    await view.findByText("Scout");

    expect(selectedOptionText(cacheSelect(view, "scout"))).toBe("Inherit (1 hour)");
    expect(selectedOptionText(cacheSelect(view, "draft"))).toBe("Inherit (1 hour)");
  });

  test("Inherit follows the base layers agents.list resolves over the listed bases", async () => {
    const exec = FALLBACK_AGENTS.find((agent) => agent.id === "exec")!;
    const listed = (
      id: string,
      scope: "project" | "global",
      base: string,
      ancestorIds: string[]
    ) => ({
      id,
      scope,
      name: id,
      base,
      uiSelectable: false,
      subagentRunnable: true,
      aiLayers: { ancestors: ancestorIds.map((agentId) => ({ agentId })) },
    });
    const view = renderTasksSection({
      agentAiDefaults: { helper: { cacheTtl: "1h" } },
      agents: [
        ...FALLBACK_AGENTS.filter((agent) => agent.id !== "exec"),
        // A project exec.md, which a global agent's base resolves past.
        {
          ...exec,
          scope: "project",
          base: "exec",
          aiLayers: { targetDefinitionAiDefaults: { cacheTtl: "1h" }, ancestors: [] },
        },
        listed("helper", "global", "exec", ["exec"]),
        // Refines a global agent whose base (helper) the listed descriptor no longer shows.
        listed("refined", "project", "refined", ["helper", "exec"]),
      ],
    });
    await view.findByText("refined");

    expect(selectedOptionText(cacheSelect(view, "refined"))).toBe("Inherit (1 hour)");
    expect(
      within(cacheSelect(view, "helper")!).getByRole("option", { name: "Inherit (5 minutes)" })
    ).toBeTruthy();
  });

  test("Settings over a project page labels Inherit from that project's agents", async () => {
    const explore = FALLBACK_AGENTS.find((agent) => agent.id === "explore")!;
    const projectExplore = { ...explore, scope: "project" as const, base: "explore" };
    const view = renderTasksSection({
      projectPageOnly: true,
      agents: [
        ...FALLBACK_AGENTS.filter((agent) => agent.id !== "explore"),
        {
          ...projectExplore,
          aiDefaults: { cacheTtl: "1h" },
          aiLayers: {
            targetDefinitionAiDefaults: { cacheTtl: "1h" },
            ancestors: [{ agentId: "exec" }],
          },
        },
      ],
    });

    await waitFor(() =>
      expect(selectedOptionText(cacheSelect(view, "explore"))).toBe("Inherit (1 hour)")
    );
  });

  test("is absent on the delegated Exec card and on headless agents", async () => {
    experimentsEnabledByDefault = true; // shows the Dream and Status Page cards
    const view = renderTasksSection();
    await view.findByText("Dream");

    expect(cacheSelect(view, "exec")).toBeTruthy();
    expect(
      within(getExecSubagentRow(view)).queryByRole("combobox", { name: /prompt cache/ })
    ).toBeNull();
    for (const agentId of ["dream", "name_workspace", "status_page"]) {
      expect(cacheSelect(view, agentId)).toBeNull();
    }
  });
});
