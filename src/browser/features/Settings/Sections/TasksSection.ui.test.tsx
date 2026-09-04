import type React from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { getThinkingOptionLabel } from "@/common/types/thinking";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";

let advisorExperimentEnabled = false;
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

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: apiMock }),
  // ThinkingSelectorControl's useMinThinkingLevels degrades to defaults without an API.
  useOptionalAPI: () => null,
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceContext: () => ({ selectedWorkspace: selectedWorkspaceMock }),
}));

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: (id: string) => experimentValues[id] ?? advisorExperimentEnabled,
}));

void mock.module("@/browser/hooks/useModelsFromSettings", () => ({
  getDefaultModel: () => "anthropic:workspace-default",
  useModelsFromSettings: () => ({
    models: [
      "anthropic:foo",
      "anthropic:ui-exec",
      "openai:gpt-5-pro",
      "openai:gpt-5.6-sol",
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
  }) => (
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
  ),
}));

void mock.module("@/browser/components/SelectPrimitive/SelectPrimitive", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Select"
      value={props.value}
      onChange={(event) => props.onValueChange(event.currentTarget.value)}
    >
      {props.children}
    </select>
  ),
  SelectContent: (props: { children: React.ReactNode }) => <>{props.children}</>,
  SelectItem: (props: { value: string; children: React.ReactNode }) => (
    <option value={props.value}>{props.children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { TasksSection } from "./TasksSection";

interface RenderTasksSectionOptions {
  agentAiDefaults?: AgentAiDefaults;
  /** When set, serves this discovered-agent list instead of FALLBACK_AGENTS. */
  agents?: AgentDefinitionDescriptor[];
}

function renderTasksSection(options: RenderTasksSectionOptions = {}) {
  const saveConfig = mock(() => Promise.resolve(undefined));
  const getConfig = mock(() =>
    Promise.resolve({
      taskSettings: {},
      agentAiDefaults: options.agentAiDefaults ?? {},
    })
  );

  apiMock = {
    config: {
      getConfig,
      saveConfig,
    },
    ...(options.agents ? { agents: { list: mock(() => Promise.resolve(options.agents)) } } : {}),
  };
  // Discovery only runs for a selected workspace's project.
  selectedWorkspaceMock = options.agents ? { projectPath: "/proj", workspaceId: "ws-1" } : null;

  const view = render(<TasksSection />);
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
    advisorExperimentEnabled = false;
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

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("gates the Intuition card on parent=%s and intuition=%s", async (memory, intuition) => {
    experimentValues = {
      [EXPERIMENT_IDS.MEMORY]: memory,
      [EXPERIMENT_IDS.MEMORY_INTUITION]: intuition,
    };
    const view = renderTasksSection({
      agentAiDefaults: { intuition: { modelString: "openai:gpt-5.6-sol" } },
    });
    await view.findByText("Name Workspace");
    if (!memory || !intuition) {
      expect(view.queryByText("Intuition")).toBeNull();
      return;
    }
    const card = getAgentCardByName(view, "Intuition");
    expect(within(card).getByRole<HTMLSelectElement>("combobox", { name: "Model" }).value).toBe(
      "openai:gpt-5.6-sol"
    );
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    expect(card.querySelector('[data-component="ProModeToggle"]')).toBeNull();
  });

  test("renders a distinct Exec subagent row", async () => {
    const view = renderTasksSection();

    await view.findByRole("group", { name: "Exec defaults" });
    expect(within(getExecSubagentRow(view)).getByText("Exec")).toBeTruthy();
    expect(view.getByText("UI agents")).toBeTruthy();
    expect(view.getByText("Sub-agents")).toBeTruthy();
  });

  test("defaults advisor on for Exec and Plan when the experiment is enabled", async () => {
    advisorExperimentEnabled = true;
    const view = renderTasksSection();

    const planAdvisorSwitch = await view.findByRole("switch", { name: "Toggle plan advisor" });
    const execAdvisorSwitch = view.getByRole("switch", { name: "Toggle exec advisor" });

    expect(execAdvisorSwitch.getAttribute("aria-checked")).toBe("true");
    expect(planAdvisorSwitch.getAttribute("aria-checked")).toBe("true");
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

  test("unset Exec subagent defaults inherit from UI Exec", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "anthropic:ui-exec", thinkingLevel: "medium" },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });

    expect(within(row).getByText("Inherits from UI Exec: anthropic:ui-exec")).toBeTruthy();
    expect(within(row).getByText("Inherits from UI Exec: medium")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Inherit from UI Exec" })).toBeNull();
  });

  test("clamps inherited Exec subagent thinking hint to the effective model policy", async () => {
    const model = "openai:gpt-5-pro";
    const expectedLabel = getThinkingOptionLabel(enforceThinkingPolicy(model, "xhigh"), model);
    const unclampedLabel = getThinkingOptionLabel("xhigh", model);

    const view = renderTasksSection({
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:ui-exec",
          thinkingLevel: "xhigh",
          subagent: { modelString: model },
        },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });

    expect(within(row).getByText(`Inherits from UI Exec: ${expectedLabel}`)).toBeTruthy();
    if (unclampedLabel !== expectedLabel) {
      expect(within(row).queryByText(`Inherits from UI Exec: ${unclampedLabel}`)).toBeNull();
    }
    expect(within(row).queryByText("Inherits from UI Exec: Inherit")).toBeNull();
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

    fireEvent.click(within(row).getAllByRole("button", { name: "Inherit from UI Exec" })[0]);

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

    fireEvent.click(within(row).getByRole("button", { name: "Inherit from UI Exec" }));

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec).toBeUndefined();
  });

  test("toggling Pro mode persists the agent default", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "openai:gpt-5.6-sol" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("pro");
  });

  test("toggling Pro mode off removes the persisted reasoning mode", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        explore: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
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
    expect(payload.agentAiDefaults.explore?.modelString).toBe("openai:gpt-5.6-sol");
  });

  test("disabling inherited Pro mode persists an explicit standard override", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: /Reasoning/ }));
    const proToggle = row.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    // Inherited from UI Exec, so the toggle starts pressed with no override.
    expect(proToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.exec?.subagent?.reasoningMode).toBe("standard");
    // UI Exec's own default stays pro; only the sub-agent override changes.
    expect(payload.agentAiDefaults.exec?.reasoningMode).toBe("pro");
  });

  test("disabling Pro mode inherited from a base agent persists an explicit standard override", async () => {
    // Explore's base is exec (FALLBACK_AGENTS), so ACP resolution inherits
    // exec's pro; deleting explore's override would silently fall back to pro.
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { reasoningMode: "pro" },
        explore: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
      },
    });

    await view.findByText("Explore");
    const card = getAgentCardByName(view, "Explore");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    const proToggle = card.querySelector('[data-component="ProModeToggle"]');
    if (!(proToggle instanceof HTMLElement)) throw new Error("Pro mode toggle not rendered");
    fireEvent.click(proToggle);

    await waitFor(() => expect(view.saveConfig).toHaveBeenCalled());
    const payload = getLatestSavePayload(view.saveConfig);

    expect(payload.agentAiDefaults.explore?.reasoningMode).toBe("standard");
    expect(payload.agentAiDefaults.exec?.reasoningMode).toBe("pro");
  });

  test("selecting Inherit clears the reasoning override along with the thinking level", async () => {
    const view = renderTasksSection({
      agentAiDefaults: {
        exec: { subagent: { thinkingLevel: "high", reasoningMode: "standard" } },
      },
    });

    const row = await view.findByRole("group", { name: "Exec defaults" });
    fireEvent.click(within(row).getByRole("button", { name: /Reasoning/ }));
    const listbox = within(row).getByRole("listbox", { name: "Reasoning effort" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Inherit from UI Exec" }));

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
        explore: { modelString: "openai:gpt-5.6-sol" },
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
        exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" },
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
          aiDefaults: { model: "openai:gpt-5.6-sol" },
        },
      ],
    });

    await view.findByText("Researcher");
    const card = getAgentCardByName(view, "Researcher");
    fireEvent.click(within(card).getByRole("button", { name: "Reasoning" }));
    expect(card.querySelector('[data-component="ProModeToggle"]')).not.toBeNull();
  });

  test("hides the Pro mode toggle on the Name Workspace card even for pro-capable models", async () => {
    // Name generation runs raw streamText (workspaceTitleGenerator) and never
    // applies reasoningMode, same headless class as Dream.
    const view = renderTasksSection({
      agentAiDefaults: {
        name_workspace: { modelString: "openai:gpt-5.6-sol" },
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
    advisorExperimentEnabled = true; // shared experiment mock also enables memory consolidation
    const view = renderTasksSection({
      agentAiDefaults: {
        dream: { modelString: "openai:gpt-5.6-sol" },
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
