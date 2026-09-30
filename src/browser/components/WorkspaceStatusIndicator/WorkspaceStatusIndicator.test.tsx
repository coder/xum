import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";

import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName } from "@/common/utils/ai/models";
import { WorkspaceStatusIndicator } from "./WorkspaceStatusIndicator";

function mockSidebarState(
  overrides: Partial<WorkspaceStoreModule.WorkspaceSidebarState> = {}
): void {
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => ({
    canInterrupt: false,
    isStarting: false,
    awaitingUserQuestion: false,
    lastAbortReason: null,
    currentModel: null,
    pendingStreamModel: null,
    recencyTimestamp: null,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    activeWorkflowRunCount: 0,
    activeBashMonitorCount: 0,
    terminalActiveCount: 0,
    terminalSessionCount: 0,
    ...overrides,
  }));
}

describe("WorkspaceStatusIndicator", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps unfinished todo status static once the stream is idle", () => {
    mockSidebarState({
      agentStatus: { emoji: "🔄", message: "Run checks" },
    });

    const view = render(
      <WorkspaceStatusIndicator workspaceId="workspace-idle" fallbackModel="openai:gpt-5.5" />
    );

    const icon = view.container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-spin");
  });

  test("keeps refresh-style status animated while a stream is still active", () => {
    mockSidebarState({
      canInterrupt: true,
      agentStatus: { emoji: "🔄", message: "Run checks" },
    });

    const view = render(
      <WorkspaceStatusIndicator workspaceId="workspace-streaming" fallbackModel="openai:gpt-5.5" />
    );

    const icon = view.container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-spin");
    expect(icon?.parentElement?.classList.contains("animate-spin")).toBe(true);
  });

  test("keeps the steady streaming layout free of the transient handoff slot", () => {
    mockSidebarState({
      canInterrupt: true,
      currentModel: "openai:gpt-4o-mini",
    });

    const view = render(
      <WorkspaceStatusIndicator
        workspaceId="workspace-live-stream"
        fallbackModel="anthropic:claude-sonnet-4-5"
      />
    );

    expect(view.container.querySelector("[data-phase-slot]")).toBeNull();
    expect(view.container.textContent?.toLowerCase()).toContain("streaming");
  });

  test("keeps provisioning-only startup distinct from active streaming through teardown", () => {
    mockSidebarState({
      isStarting: false,
      pendingStreamModel: "openai:gpt-4o-mini",
    });

    const workspaceId = "workspace-provisioning";
    const fallbackModel = "anthropic:claude-sonnet-4-5";
    const view = render(
      <WorkspaceStatusIndicator
        workspaceId={workspaceId}
        fallbackModel={fallbackModel}
        isCreating
      />
    );

    const expectProvisioningChrome = () => {
      const phaseSlot = view.container.querySelector("[data-phase-slot]");
      expect(phaseSlot).toBeTruthy();
      expect(phaseSlot?.querySelector("svg")?.getAttribute("class") ?? "").toContain(
        "animate-spin"
      );
      expect(view.container.textContent?.toLowerCase()).toContain("starting");
      expect(view.container.textContent?.toLowerCase()).not.toContain("streaming");
    };

    expectProvisioningChrome();

    view.rerender(
      <WorkspaceStatusIndicator
        workspaceId={workspaceId}
        fallbackModel={fallbackModel}
        isCreating={false}
      />
    );

    expectProvisioningChrome();
  });

  test("uses the steady streaming layout during pre-stream startup and the idle handoff gap", () => {
    const pendingModel = "openai:gpt-4o-mini";
    const fallbackModel = "anthropic:claude-sonnet-4-5";
    const pendingDisplayName = formatModelDisplayName(getModelName(pendingModel));
    const state: WorkspaceStoreModule.WorkspaceSidebarState = {
      canInterrupt: false,
      isStarting: true,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: pendingModel,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      activeWorkflowRunCount: 0,
      activeBashMonitorCount: 0,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => state);

    const workspaceId = "workspace-handoff-gap";
    const view = render(
      <WorkspaceStatusIndicator workspaceId={workspaceId} fallbackModel={fallbackModel} />
    );

    const getPhaseSlot = () => view.container.querySelector("[data-phase-slot]");
    const getModelDisplay = () => view.container.querySelector("[data-model-display]");
    const expectStreamingChrome = () => {
      expect(getPhaseSlot()).toBeNull();
      expect(getModelDisplay()?.textContent ?? "").toContain(pendingDisplayName);
      expect(view.container.textContent?.toLowerCase()).toContain("streaming");
      expect(view.container.textContent?.toLowerCase()).not.toContain("starting");
    };

    expectStreamingChrome();

    state.isStarting = false;
    view.rerender(
      <WorkspaceStatusIndicator
        workspaceId={workspaceId}
        fallbackModel={fallbackModel}
        isCreating={false}
      />
    );

    expectStreamingChrome();

    state.canInterrupt = true;
    state.currentModel = pendingModel;
    state.pendingStreamModel = null;
    view.rerender(
      <WorkspaceStatusIndicator workspaceId={workspaceId} fallbackModel={fallbackModel} />
    );

    expectStreamingChrome();
  });

  test("keeps the model label anchored when pre-stream startup hands off to streaming", async () => {
    const pendingModel = "openai:gpt-4o-mini";
    const fallbackModel = "anthropic:claude-sonnet-4-5";
    const pendingDisplayName = formatModelDisplayName(getModelName(pendingModel));
    const fallbackDisplayName = formatModelDisplayName(getModelName(fallbackModel));
    const state: WorkspaceStoreModule.WorkspaceSidebarState = {
      canInterrupt: false,
      isStarting: true,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: pendingModel,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      activeWorkflowRunCount: 0,
      activeBashMonitorCount: 0,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => state);

    const workspaceId = "workspace-phase-shift";
    const view = render(
      <WorkspaceStatusIndicator workspaceId={workspaceId} fallbackModel={fallbackModel} />
    );

    const getModelDisplay = () => view.container.querySelector("[data-model-display]");

    expect(view.container.querySelector("[data-phase-slot]")).toBeNull();
    expect(getModelDisplay()?.textContent ?? "").toContain(pendingDisplayName);
    expect(getModelDisplay()?.textContent ?? "").not.toContain(fallbackDisplayName);
    expect(view.container.textContent?.toLowerCase()).toContain("streaming");
    expect(view.container.textContent?.toLowerCase()).not.toContain("starting");

    state.isStarting = false;
    state.canInterrupt = true;
    state.currentModel = pendingModel;
    state.pendingStreamModel = null;
    view.rerender(
      <WorkspaceStatusIndicator
        workspaceId={workspaceId}
        fallbackModel={fallbackModel}
        isCreating={false}
      />
    );

    await waitFor(() => {
      expect(getModelDisplay()?.textContent ?? "").toContain(pendingDisplayName);
      expect(getModelDisplay()?.textContent ?? "").not.toContain(fallbackDisplayName);
      expect(view.container.querySelector("[data-phase-slot]")).toBeNull();
      expect(view.container.textContent?.toLowerCase()).toContain("streaming");
      expect(view.container.textContent?.toLowerCase()).not.toContain("starting");
    });
  });
});
