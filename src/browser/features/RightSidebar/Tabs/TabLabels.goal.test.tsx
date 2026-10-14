import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
import type { GoalSnapshot } from "@/common/types/goal";
import type { WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { restoreModulesAfterSuite } from "../../../../../tests/ui/moduleMocks";

// The label subscribes to the workspace sidebar store to surface the
// "active goal" accent. Mocking the hook keeps these tests focused on the
// label's CSS behavior without spinning up a real workspace store.
let mockedSidebarState: WorkspaceSidebarState | null = null;
// The partial store stub below drops every other export; restore the real module after this
// suite so later files see the full WorkspaceStore.
restoreModulesAfterSuite([["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }]]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useOptionalWorkspaceSidebarState: () => mockedSidebarState,
  useWorkspaceUsage: () => ({
    sessionTotal: null,
    liveCostUsage: null,
  }),
}));

import { GoalTabLabel } from "./TabLabels";

function makeGoal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    objective: "Ship the goal lifecycle slice",
    budgetCents: null,
    costCents: 0,
    turnsUsed: 0,
    turnCap: null,
    startedAtMs: Date.now(),
    ...overrides,
  };
}

function makeSidebarState(goal: GoalSnapshot | null): WorkspaceSidebarState {
  // Only `goal` matters for this label; other fields are unused by the
  // accent predicate so we keep this fixture intentionally narrow.
  const state: Partial<WorkspaceSidebarState> = { goal };
  return state as WorkspaceSidebarState;
}

describe("GoalTabLabel", () => {
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

  test("renders without accent when no workspace goal exists", () => {
    mockedSidebarState = null;

    const { container, getByText } = render(<GoalTabLabel workspaceId="w1" />);

    expect(getByText("Goal")).toBeTruthy();
    // The outer span owns the accent class; absence guards against
    // accidentally lighting the tab for inactive / history-only / empty
    // workspaces.
    expect(container.querySelector(".text-success")).toBeNull();
  });

  test("renders with goal-green accent when the workspace has a live active goal", () => {
    mockedSidebarState = makeSidebarState(makeGoal({ status: "active" }));

    const { container } = render(<GoalTabLabel workspaceId="w1" />);

    expect(container.querySelector(".text-success")).not.toBeNull();
  });

  test("uses warning amber accent for paused goals (active but not auto-running)", () => {
    // Paused is a lifecycle-active sub-status: the goal is still the
    // workspace's active goal but won't progress without user action.
    // The tab label surfaces this with the warning amber accent
    // (matching the Goals-tab header band + `GoalStatusBadge` paused
    // color) so the workspace shows "needs attention" without claiming
    // the goal-green "running" cue.
    mockedSidebarState = makeSidebarState(makeGoal({ status: "paused" }));

    const { container } = render(<GoalTabLabel workspaceId="w1" />);

    expect(container.querySelector(".text-warning")).not.toBeNull();
    expect(container.querySelector(".text-success")).toBeNull();
  });

  test("uses warning amber accent for budget-limited goals", () => {
    // budget_limited shares the "active but not auto-running" semantics
    // with paused — the goal hit its cost or turn cap and is waiting
    // for the user to raise the cap or wrap up. Same amber accent.
    mockedSidebarState = makeSidebarState(makeGoal({ status: "budget_limited" }));

    const { container } = render(<GoalTabLabel workspaceId="w1" />);

    expect(container.querySelector(".text-warning")).not.toBeNull();
    expect(container.querySelector(".text-success")).toBeNull();
  });

  test("does not accent complete goals", () => {
    mockedSidebarState = makeSidebarState(
      makeGoal({ status: "complete", completionSummary: "done" })
    );

    const { container } = render(<GoalTabLabel workspaceId="w1" />);

    expect(container.querySelector(".text-success")).toBeNull();
    expect(container.querySelector(".text-warning")).toBeNull();
  });

  test("does not accent pending-persistence goals (mid-stream / unsaved)", () => {
    mockedSidebarState = makeSidebarState(makeGoal({ status: "active", pendingPersistence: true }));

    const { container } = render(<GoalTabLabel workspaceId="w1" />);

    // Pending goals haven't been committed to disk yet — treating them as
    // "active" would briefly flash the accent during a stream and then
    // un-flash once persistence lands. Mirrors `useActiveGoalCount`.
    expect(container.querySelector(".text-success")).toBeNull();
  });
});
