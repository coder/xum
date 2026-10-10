import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
  type WorkspaceMetadataContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import type { GoalSnapshot } from "@/common/types/goal";
import type { WorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import type { TabType } from "@/browser/types/rightSidebar";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RealGitStatusStoreModule from "@/browser/stores/GitStatusStore";

// The card subscribes to the workspace and git stores directly; stubbing the two hooks keeps
// these tests on the card's own gating and navigation.
let sidebarState: Partial<WorkspaceSidebarState> | null = null;
let gitStatus: GitStatus | null = null;
restoreModulesAfterSuite([
  ["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }],
  ["@/browser/stores/GitStatusStore", { ...RealGitStatusStoreModule }],
]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...RealWorkspaceStoreModule,
  useOptionalWorkspaceSidebarState: () => sidebarState,
}));
void mock.module("@/browser/stores/GitStatusStore", () => ({
  ...RealGitStatusStoreModule,
  useGitStatus: () => gitStatus,
}));

import { OVERVIEW_MAX_SIDE_CHATS, RightSidebarOverview } from "./RightSidebarOverview";

const WORKSPACE_ID = "ws-main";

function workspace(
  overrides: Partial<FrontendWorkspaceMetadata> & { id: string }
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace({ id: overrides.id, name: `${overrides.id}-branch`, projectName: "app" }),
    ...overrides,
  };
}

function sideChat(id: string, minutesAgo: number, title?: string): FrontendWorkspaceMetadata {
  return workspace({
    id,
    title,
    sideChatParentWorkspaceId: WORKSPACE_ID,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 60 - minutesAgo)).toISOString(),
  });
}

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    objective: "Ship the overview card",
    budgetCents: null,
    costCents: 0,
    turnsUsed: 0,
    turnCap: null,
    startedAtMs: 0,
    ...overrides,
  };
}

function renderOverview(
  workspaces: FrontendWorkspaceMetadata[],
  options: { canStartSideChat?: boolean } = {}
) {
  const opened: TabType[] = [];
  let expanded = 0;
  let newSideChats = 0;
  const value: WorkspaceMetadataContextValue = {
    workspaceMetadata: new Map(workspaces.map((meta) => [meta.id, meta])),
    loading: false,
    loaded: true,
    loadError: null,
  };
  const view = render(
    <WorkspaceContext.Provider value={value as WorkspaceContextValue}>
      <TooltipProvider>
        <RightSidebarOverview
          workspaceId={WORKSPACE_ID}
          onExpand={() => {
            expanded += 1;
          }}
          onOpenTab={(tab) => opened.push(tab)}
          onNewSideChat={
            options.canStartSideChat === false
              ? undefined
              : () => {
                  newSideChats += 1;
                }
          }
          creatingSideChat={false}
        />
      </TooltipProvider>
    </WorkspaceContext.Provider>
  );
  return {
    view,
    opened,
    expandCount: () => expanded,
    newSideChatCount: () => newSideChats,
  };
}

describe("RightSidebarOverview", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    sidebarState = null;
    gitStatus = null;
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("lists this workspace's side chats newest first, capped, and opens the picked one", () => {
    const chats = [
      sideChat("side-old", 50, "Oldest question"),
      sideChat("side-new", 1, "Newest question"),
      sideChat("side-mid", 20),
      sideChat("side-mid2", 30, "Middle question"),
    ];
    const otherParentChat = workspace({
      id: "side-elsewhere",
      title: "Someone else's side chat",
      sideChatParentWorkspaceId: "ws-other",
    });
    const { view, opened, expandCount } = renderOverview([
      workspace({ id: WORKSPACE_ID }),
      ...chats,
      otherParentChat,
    ]);

    const section = within(view.getByRole("region", { name: "Side chats" }));
    const rows = section
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label") !== "New side chat");
    // Untitled chats fall back to the initial title, and the oldest chat folds into "1 more".
    expect(rows.map((row) => row.textContent)).toEqual([
      "Newest question",
      "New chat",
      "Middle question",
      `${chats.length - OVERVIEW_MAX_SIDE_CHATS} more`,
    ]);
    expect(view.queryByText("Someone else's side chat")).toBeNull();

    fireEvent.click(rows[0]);
    expect(opened).toEqual(["side:side-new"]);
    fireEvent.click(rows[3]);
    expect(expandCount()).toBe(1);
  });

  test("offers starting a side chat only where one can start", () => {
    const startable = renderOverview([workspace({ id: WORKSPACE_ID })]);
    fireEvent.click(startable.view.getByRole("button", { name: "New side chat" }));
    expect(startable.newSideChatCount()).toBe(1);
    cleanup();

    // A side chat cannot start another one, and with none to list the section disappears.
    const sideChatWorkspace = renderOverview([workspace({ id: WORKSPACE_ID })], {
      canStartSideChat: false,
    });
    expect(sideChatWorkspace.view.queryByRole("region", { name: "Side chats" })).toBeNull();
  });

  test("shows changes under the branch for repository workspaces and opens Review", () => {
    const status: GitStatus = {
      branch: "feature/overview",
      ahead: 1,
      behind: 0,
      dirty: true,
      outgoingAdditions: 29692,
      outgoingDeletions: 6248,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    gitStatus = status;
    const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })]);

    const section = within(view.getByRole("region", { name: "feature/overview" }));
    const changes = section.getByRole("button");
    expect(changes.textContent).toContain("+29,692");
    expect(changes.textContent).toContain("-6,248");
    fireEvent.click(changes);
    expect(opened).toEqual(["review"]);
  });

  test("leaves out changes for scratch workspaces, which have no repository", () => {
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID, kind: "scratch" })]);
    expect(view.queryByRole("button", { name: /Changes/ })).toBeNull();
  });

  test("summarizes the goal and running work, each opening its tab", () => {
    sidebarState = {
      goal: goal({ status: "paused" }),
      activeWorkflowRunCount: 2,
      terminalActiveCount: 0,
    };
    const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })]);

    const goalRow = within(view.getByRole("region", { name: "Goal" })).getByRole("button");
    expect(goalRow.textContent).toContain("Ship the overview card");
    expect(goalRow.textContent).toContain("Paused");
    fireEvent.click(goalRow);

    const running = within(view.getByRole("region", { name: "Running" }));
    // Idle terminals are not running work, so only the workflows row shows.
    expect(running.queryByText("Terminals")).toBeNull();
    fireEvent.click(running.getByRole("button", { name: /Workflows/ }));

    expect(opened).toEqual(["goal", "workflows"]);
  });

  test("hides goal, running, and scheduled sections when there is nothing to report", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID, heartbeat: { enabled: false, intervalMs: 300_000 } }),
    ]);
    for (const name of ["Goal", "Running", "Scheduled"]) {
      expect(view.queryByRole("region", { name })).toBeNull();
    }
  });

  test("shows an enabled heartbeat's cadence", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID, heartbeat: { enabled: true, intervalMs: 300_000 } }),
    ]);
    const scheduled = view.getByRole("region", { name: "Scheduled" });
    expect(scheduled.textContent).toContain("Every 5 minutes");
  });
});
