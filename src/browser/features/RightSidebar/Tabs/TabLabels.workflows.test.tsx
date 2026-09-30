import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";

// The label subscribes to the workspace sidebar store to surface a live count
// of active workflow runs. Mock the hook so these tests stay focused on the
// badge's gating without a real workspace store.
let mockedSidebarState: WorkspaceSidebarState | null = null;
// The partial store stub below drops every other export; restore the real module after this
// suite so later files see the full WorkspaceStore.
restoreModulesAfterSuite([["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }]]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useOptionalWorkspaceSidebarState: () => mockedSidebarState,
  useWorkspaceUsage: () => ({ sessionTotal: null, liveCostUsage: null }),
}));

import { WorkflowsTabLabel } from "./TabLabels";

function makeSidebarState(activeWorkflowRunCount: number): WorkspaceSidebarState {
  // Only activeWorkflowRunCount matters for this label; keep the fixture narrow.
  const state: Partial<WorkspaceSidebarState> = { activeWorkflowRunCount };
  return state as WorkspaceSidebarState;
}

describe("WorkflowsTabLabel", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    mockedSidebarState = null;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mockedSidebarState = null;
  });

  test("shows no count badge when there are no active runs", () => {
    mockedSidebarState = makeSidebarState(0);

    const { container, getByText } = render(<WorkflowsTabLabel workspaceId="w1" />);

    expect(getByText("Workflows")).toBeTruthy();
    // No active-run accent when the workspace has nothing running.
    expect(container.querySelector(".text-accent")).toBeNull();
  });

  test("shows the active-run count badge when runs are in flight", () => {
    mockedSidebarState = makeSidebarState(3);

    const { container, getByText } = render(<WorkflowsTabLabel workspaceId="w1" />);

    const badge = container.querySelector(".text-accent");
    expect(badge).not.toBeNull();
    expect(getByText("3")).toBeTruthy();
  });

  test("renders without a badge when sidebar state is unavailable", () => {
    mockedSidebarState = null;

    const { container, getByText } = render(<WorkflowsTabLabel workspaceId="w1" />);

    expect(getByText("Workflows")).toBeTruthy();
    expect(container.querySelector(".text-accent")).toBeNull();
  });
});
