import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createCustomEvent, CUSTOM_EVENTS } from "@/common/constants/events";
import { installDom } from "../../../../tests/ui/dom";

import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AgentModePicker } from "../AgentModePicker/AgentModePicker";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import type { ComputerUseState } from "@/browser/hooks/useComputerUse";
import type { ComputerUseStatus } from "@/common/orpc/schemas/computerUse";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

const BUILT_INS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    subagentRunnable: false,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    subagentRunnable: false,
    base: "plan",
  },
];

const HIDDEN_AGENT: AgentDefinitionDescriptor = {
  id: "explore",
  scope: "built-in",
  name: "Explore",
  uiSelectable: false,
  subagentRunnable: true,
  base: "exec",
};
const CUSTOM_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review changes",
  uiSelectable: true,
  subagentRunnable: false,
};

const noop = () => {
  // intentional noop for tests
};
const defaultContextProps = {
  currentAgent: undefined,
  isAgentSelectionLocked: false,
  disableWorkspaceAgents: false,
  setDisableWorkspaceAgents: noop,
};

let cleanupDom: (() => void) | null = null;

describe("AgentModePicker", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function Harness(props: {
    initialAgentId?: string;
    agents?: AgentDefinitionDescriptor[];
    loaded?: boolean;
    currentAgent?: AgentDefinitionDescriptor;
    locked?: boolean;
    disabled?: boolean;
    showAgentId?: boolean;
    computerUse?: ComputerUseState & { runtimeEligible: boolean };
  }) {
    const [agentId, setAgentId] = React.useState(props.initialAgentId ?? "exec");
    const contextValue: AgentContextValue & { isAgentSelectionLocked?: boolean } = {
      agentId,
      setAgentId,
      agents: props.agents ?? [...BUILT_INS, CUSTOM_AGENT],
      loaded: props.loaded ?? true,
      loadFailed: false,
      refresh: () => Promise.resolve(),
      refreshing: false,
      ...defaultContextProps,
      currentAgent: props.currentAgent,
      isAgentSelectionLocked: props.locked ?? false,
    };

    return (
      <AgentProvider value={contextValue}>
        <TooltipProvider>
          {props.showAgentId ? <div data-testid="agentId">{agentId}</div> : null}
          <AgentModePicker disabled={props.disabled} computerUse={props.computerUse} />
        </TooltipProvider>
      </AgentProvider>
    );
  }

  function renderPicker(props: Parameters<typeof Harness>[0] = {}) {
    return render(<Harness {...props} />);
  }

  test("renders a stable label for explore before agent definitions load", () => {
    const { getByText } = renderPicker({ initialAgentId: "explore", agents: [], loaded: false });

    // Regression: avoid "explore" -> "Explore" flicker while agents load.
    expect(getByText("Explore")).toBeTruthy();
  });

  test("locks the picker when workspace agent selection is locked", () => {
    const { getByLabelText, queryAllByTestId } = renderPicker({
      agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
      currentAgent: BUILT_INS[0],
      locked: true,
      showAgentId: true,
    });

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Exec");
    expect(triggerButton.disabled).toBe(true);

    fireEvent.click(triggerButton);
    expect(queryAllByTestId("agent-option").length).toBe(0);
  });

  test("disabling an open picker closes it for good", async () => {
    const view = renderPicker();
    fireEvent.click(view.getByLabelText("Select agent"));
    await waitFor(() => expect(view.getAllByTestId("agent-option").length).toBe(3));

    view.rerender(<Harness disabled />);
    expect(view.queryAllByTestId("agent-option").length).toBe(0);

    // Re-enabling must not bring back the menu that was open before.
    view.rerender(<Harness />);
    expect(view.queryAllByTestId("agent-option").length).toBe(0);
    expect(view.getByLabelText("Select agent").getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape closes the picker right after the open shortcut", () => {
    const view = renderPicker();
    // The hotkey and the palette open the picker through this event. Escape can arrive before
    // the next animation frame, so the list must already own focus when the open commits.
    act(() => {
      window.dispatchEvent(createCustomEvent(CUSTOM_EVENTS.OPEN_AGENT_PICKER));
    });
    expect(view.getAllByTestId("agent-option").length).toBe(3);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(view.queryAllByTestId("agent-option").length).toBe(0);
  });

  test("uiSelectable false without lock flag does not disable the picker", async () => {
    const { getByLabelText, queryAllByTestId } = renderPicker({
      initialAgentId: "explore",
      agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
      currentAgent: HIDDEN_AGENT,
      showAgentId: true,
    });

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Explore");
    expect(triggerButton.disabled).toBe(false);

    fireEvent.click(triggerButton);

    await waitFor(() => {
      expect(queryAllByTestId("agent-option").length).toBeGreaterThan(0);
    });
  });

  test("selects a custom agent from the dropdown", async () => {
    const { getByTestId, getByText, getByLabelText } = renderPicker({ showAgentId: true });

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Review")).toBeTruthy();
    });

    fireEvent.click(getByText("Review"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });
  });

  test("numbered guest shortcuts do not select a host agent", async () => {
    const view = renderPicker({ showAgentId: true });
    fireEvent.click(view.getByLabelText("Select agent"));
    await waitFor(() => expect(view.getAllByTestId("agent-option").length).toBe(3));
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    const event = new window.KeyboardEvent("keydown", {
      key: "3",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByTestId("agentId").textContent).toBe("exec");
    expect(view.getAllByTestId("agent-option").length).toBe(3);

    fireEvent.keyDown(document.body, { key: "3", ctrlKey: true });
    expect(view.getByTestId("agentId").textContent).toBe("review");
  });

  test("does not render auto agent affordances", async () => {
    const { getByLabelText, queryByLabelText, queryByText } = renderPicker();
    const autoSelectLabel = ["Auto-select", "agent"].join(" ");

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(queryByLabelText(autoSelectLabel)).toBeNull();
      expect(queryByText("Xum chooses the best agent")).toBeNull();
    });
  });

  describe("computer use footer", () => {
    function computerUse(options: {
      status: Partial<ComputerUseStatus> | null;
      enabledHere?: boolean;
      runtimeEligible?: boolean;
    }) {
      const calls: string[] = [];
      const state: ComputerUseState & { runtimeEligible: boolean } = {
        status:
          options.status == null
            ? null
            : {
                supported: true,
                platform: "darwin",
                ownerWorkspaceId: null,
                stopShortcutRegistered: true,
                permissions: { screenRecording: "granted", accessibility: "granted" },
                ...options.status,
              },
        enabledHere: options.enabledHere ?? false,
        error: null,
        runtimeEligible: options.runtimeEligible ?? true,
        setEnabled: (enabled) => {
          calls.push(`setEnabled ${enabled}`);
          return Promise.resolve();
        },
        toggle: () => Promise.resolve(),
        requestPermission: (kind) => {
          calls.push(`request ${kind}`);
          return Promise.resolve();
        },
        refresh: () => calls.push("refresh"),
      };
      return { state, calls };
    }

    async function openPicker(view: ReturnType<typeof renderPicker>) {
      fireEvent.click(view.getByLabelText("Select agent"));
      await waitFor(() => expect(view.getAllByTestId("agent-option").length).toBe(3));
    }

    test("is hidden while computer use is unsupported or unknown", async () => {
      for (const status of [null, { supported: false }]) {
        const view = renderPicker({ computerUse: computerUse({ status }).state });
        await openPicker(view);
        expect(view.queryByTestId("computer-use-footer")).toBeNull();
        cleanup();
      }
    });

    test("toggles computer use without changing numbered agent shortcuts", async () => {
      const { state, calls } = computerUse({ status: {} });
      const view = renderPicker({ computerUse: state, showAgentId: true });
      await openPicker(view);
      expect(calls).toEqual(["refresh"]);

      fireEvent.click(view.getByRole("switch", { name: "Computer use" }));
      expect(calls).toEqual(["refresh", "setEnabled true"]);

      fireEvent.keyDown(document.body, { key: "3", ctrlKey: true });
      expect(view.getByTestId("agentId").textContent).toBe("review");
    });

    test("disables the switch for workspaces that do not run on this machine", async () => {
      const { state, calls } = computerUse({ status: {}, runtimeEligible: false });
      const view = renderPicker({ computerUse: state });
      await openPicker(view);

      const toggle = view.getByRole("switch", { name: "Computer use" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
      fireEvent.click(toggle);
      expect(calls).toEqual(["refresh"]);
    });

    test("warns while enabled here that another app holds the stop shortcut", async () => {
      for (const [stopShortcutRegistered, enabledHere, warned] of [
        [false, true, true],
        [true, true, false],
        [false, false, false],
      ] as const) {
        const view = renderPicker({
          computerUse: computerUse({ status: { stopShortcutRegistered }, enabledHere }).state,
        });
        await openPicker(view);
        expect(view.queryByTestId("computer-use-stop-shortcut-unavailable") != null).toBe(warned);
        // Advertising a shortcut that another app owns would mislead the user about how to stop.
        expect(
          view
            .getByTestId("computer-use-footer")
            .textContent?.includes(formatKeybind(KEYBINDS.STOP_COMPUTER_USE))
        ).toBe(enabledHere && !warned);
        cleanup();
      }
    });

    test("offers missing macOS permissions only while enabled here", async () => {
      const deniedStatus = {
        ownerWorkspaceId: "ws",
        permissions: { screenRecording: "denied", accessibility: "granted" } as const,
      };
      const off = renderPicker({ computerUse: computerUse({ status: deniedStatus }).state });
      await openPicker(off);
      expect(off.queryAllByTestId("computer-use-permission")).toHaveLength(0);
      expect(off.getByLabelText("Select agent").getAttribute("aria-describedby")).toBeNull();
      cleanup();

      const { state, calls } = computerUse({ status: deniedStatus, enabledHere: true });
      const on = renderPicker({ computerUse: state });
      await openPicker(on);
      const descriptionId = on.getByLabelText("Select agent").getAttribute("aria-describedby");
      expect(document.getElementById(descriptionId ?? "")?.textContent).toMatch(/computer use/i);
      const rows = on.getAllByTestId("computer-use-permission");
      expect(rows).toHaveLength(1);
      fireEvent.click(on.getByText("Open System Settings"));
      expect(calls).toContain("request screenRecording");
    });

    test("Enter on a footer control activates it instead of picking an agent", async () => {
      const { state } = computerUse({
        status: { permissions: { screenRecording: "denied", accessibility: "granted" } },
        enabledHere: true,
      });
      const view = renderPicker({ computerUse: state });
      await openPicker(view);

      for (const control of [
        view.getByRole("switch", { name: "Computer use" }),
        view.getByText("Open System Settings"),
      ]) {
        // A prevented Enter keydown never becomes the button's click.
        expect(fireEvent.keyDown(control, { key: "Enter" })).toBe(true);
      }
      expect(view.getAllByTestId("agent-option")).toHaveLength(3);
    });
  });
});
