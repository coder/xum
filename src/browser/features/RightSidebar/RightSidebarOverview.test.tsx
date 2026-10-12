import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import { restoreModulesAfterSuite } from "../../../../tests/ui/moduleMocks";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import {
  WorkspaceContext,
  type WorkspaceContext as WorkspaceContextValue,
  type WorkspaceMetadataContextValue,
} from "@/browser/contexts/WorkspaceContext";
import { createWorkspace } from "@/browser/stories/mocks/workspaces";
import { createTestApiClient } from "@/browser/testUtils";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { formatHeartbeatIntervalShort, HEARTBEAT_DEFAULT_INTERVAL_MS } from "@/constants/heartbeat";
import type { ArtifactEntry } from "@/common/orpc/schemas/artifacts";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import type { GoalSnapshot } from "@/common/types/goal";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import type { WorkspaceSidebarState, WorkspaceUsageState } from "@/browser/stores/WorkspaceStore";
import type { TabType } from "@/browser/types/rightSidebar";
import * as RealWorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RealGitStatusStoreModule from "@/browser/stores/GitStatusStore";

// The card subscribes to the workspace and git stores directly; stubbing those hooks keeps
// these tests on the card's own gating and navigation.
let sidebarState: Partial<WorkspaceSidebarState> | null = null;
let gitStatus: GitStatus | null = null;
let workspaceUsage: WorkspaceUsageState = { totalTokens: 0 };
restoreModulesAfterSuite([
  ["@/browser/stores/WorkspaceStore", { ...RealWorkspaceStoreModule }],
  ["@/browser/stores/GitStatusStore", { ...RealGitStatusStoreModule }],
]);
void mock.module("@/browser/stores/WorkspaceStore", () => ({
  ...RealWorkspaceStoreModule,
  useOptionalWorkspaceSidebarState: () => sidebarState,
  useWorkspaceUsage: () => workspaceUsage,
}));
void mock.module("@/browser/stores/GitStatusStore", () => ({
  ...RealGitStatusStoreModule,
  useGitStatus: () => gitStatus,
}));

import { OVERVIEW_MAX_LIST_ROWS, RightSidebarOverview } from "./RightSidebarOverview";
import {
  closeMcpAppView,
  openMcpAppView,
  type McpAppViewRef,
} from "./ArtifactsTab/mcpAppViewsStore";

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

/** Usage with all of its tokens and cost on input, which is all the card's totals need. */
function usage(tokens: number, costUsd: number): ChatUsageDisplay {
  const none = { tokens: 0, cost_usd: 0 };
  return {
    input: { tokens, cost_usd: costUsd },
    cached: none,
    cacheCreate: none,
    output: none,
    reasoning: none,
  };
}

function artifact(path: string, modifiedMs: number): ArtifactEntry {
  return { path, kind: "markdown", size: 10, modifiedMs };
}

function renderOverview(
  workspaces: FrontendWorkspaceMetadata[],
  options: {
    canStartSideChat?: boolean;
    artifactsEnabled?: boolean;
    unreadAssisted?: number;
    client?: APIClient;
  } = {}
) {
  const opened: TabType[] = [];
  let expanded = 0;
  let terminalOpens = 0;
  let newSideChats = 0;
  const value: WorkspaceMetadataContextValue = {
    workspaceMetadata: new Map(workspaces.map((meta) => [meta.id, meta])),
    loading: false,
    loaded: true,
    loadError: null,
  };
  const card = (
    <WorkspaceContext.Provider value={value as WorkspaceContextValue}>
      <TooltipProvider>
        <RightSidebarOverview
          workspaceId={WORKSPACE_ID}
          onExpand={() => {
            expanded += 1;
          }}
          onOpenTab={(tab) => opened.push(tab)}
          onOpenTerminals={() => {
            terminalOpens += 1;
          }}
          onNewSideChat={
            options.canStartSideChat === false
              ? undefined
              : () => {
                  newSideChats += 1;
                }
          }
          creatingSideChat={false}
          artifactsEnabled={options.artifactsEnabled ?? false}
          unreadAssisted={options.unreadAssisted ?? 0}
        />
      </TooltipProvider>
    </WorkspaceContext.Provider>
  );
  const view = render(
    options.client != null ? <APIProvider client={options.client}>{card}</APIProvider> : card
  );
  return {
    view,
    opened,
    expandCount: () => expanded,
    terminalOpenCount: () => terminalOpens,
    newSideChatCount: () => newSideChats,
  };
}

describe("RightSidebarOverview", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    sidebarState = null;
    gitStatus = null;
    workspaceUsage = { totalTokens: 0 };
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("leads with the session cost and tokens, live stream included, and opens Stats", () => {
    workspaceUsage = {
      totalTokens: 0,
      sessionTotal: usage(1_000_000, 1.25),
      liveCostUsage: usage(200_000, 0.5),
    };
    const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })]);

    const stats = view.getByRole("button", { name: /\$1\.75/ });
    expect(stats.textContent).toContain("1.2M tokens");
    fireEvent.click(stats);
    expect(opened).toEqual(["costs"]);
  });

  test("marks the cost as incomplete when some usage has unknown pricing", () => {
    workspaceUsage = { totalTokens: 0, sessionTotal: usage(1_000, 1.25) };
    const complete = renderOverview([workspace({ id: WORKSPACE_ID })]);
    expect(complete.view.queryByLabelText("Cost may be incomplete")).toBeNull();
    cleanup();

    workspaceUsage = {
      totalTokens: 0,
      sessionTotal: { ...usage(1_000, 1.25), hasUnknownCosts: true },
    };
    const partial = renderOverview([workspace({ id: WORKSPACE_ID })]);
    const stats = partial.view.getByRole("button", { name: /\$1\.25/ });
    expect(within(stats).getByLabelText("Cost may be incomplete")).toBeTruthy();
  });

  test("labels the tokens when no usage is priced", () => {
    const none = { tokens: 0 };
    workspaceUsage = {
      totalTokens: 0,
      sessionTotal: {
        input: { tokens: 1_200 },
        cached: none,
        cacheCreate: none,
        output: none,
        reasoning: none,
        hasUnknownCosts: true,
      },
    };
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })]);
    expect(view.getByRole("button", { name: "1.2k tokens" })).toBeTruthy();
  });

  test("shows no stats before the session has usage", () => {
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })]);
    expect(view.queryByRole("button", { name: /\$/ })).toBeNull();
    expect(view.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
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
      `${chats.length - OVERVIEW_MAX_LIST_ROWS} more`,
    ]);
    expect(view.queryByText("Someone else's side chat")).toBeNull();

    fireEvent.click(rows[0]);
    expect(opened).toEqual(["side:side-new"]);

    // A hidden side chat may have no open tab, so "more" lists every chat in the card and hands
    // focus to the first one it revealed, instead of expanding the sidebar.
    fireEvent.click(rows[3]);
    expect(expandCount()).toBe(0);
    const revealed = section.getByRole("button", { name: "Oldest question" });
    expect(document.activeElement).toBe(revealed);
    expect(section.queryByRole("button", { name: /more$/ })).toBeNull();
    fireEvent.click(revealed);
    expect(opened).toEqual(["side:side-new", "side:side-old"]);
  });

  test("numbers side chats that share a title, oldest first", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID }),
      sideChat("side-a", 30),
      sideChat("side-b", 20, "Unique question"),
      sideChat("side-c", 10),
    ]);
    const section = within(view.getByRole("region", { name: "Side chats" }));
    const rows = section
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label") !== "New side chat");
    expect(rows.map((row) => row.textContent)).toEqual([
      "New chat#2",
      "Unique question",
      "New chat#1",
    ]);
  });

  test("an empty side chat section is only its heading and the new-chat button", () => {
    const startable = renderOverview([workspace({ id: WORKSPACE_ID })]);
    const section = startable.view.getByRole("region", { name: "Side chats" });
    // No rows and no explanatory copy, just the action.
    expect(section.textContent).toBe("Side chats");
    fireEvent.click(within(section).getByRole("button", { name: "New side chat" }));
    expect(startable.newSideChatCount()).toBe(1);
    cleanup();

    // A side chat cannot start another one, and with none to list the section disappears.
    const sideChatWorkspace = renderOverview([workspace({ id: WORKSPACE_ID })], {
      canStartSideChat: false,
    });
    expect(sideChatWorkspace.view.queryByRole("region", { name: "Side chats" })).toBeNull();
  });

  test("shows changes and flagged hunks under the branch, and opens Review", () => {
    gitStatus = {
      branch: "feature/overview",
      ahead: 1,
      behind: 0,
      dirty: true,
      outgoingAdditions: 29692,
      outgoingDeletions: 6248,
      incomingAdditions: 0,
      incomingDeletions: 0,
    };
    const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })], {
      unreadAssisted: 3,
    });

    const section = within(view.getByRole("region", { name: "feature/overview" }));
    const changes = section.getByRole("button");
    expect(changes.textContent).toContain("+29,692");
    expect(changes.textContent).toContain("-6,248");
    expect(section.getByLabelText("3 unread agent-flagged hunks")).toBeTruthy();
    fireEvent.click(changes);
    expect(opened).toEqual(["review"]);
  });

  test("shows flagged hunks before git status has loaded", () => {
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })], { unreadAssisted: 1 });
    const changes = view.getByRole("button", { name: /Changes/ });
    expect(within(changes).getByLabelText("1 unread agent-flagged hunk")).toBeTruthy();
    expect(changes.textContent).not.toContain("+");
  });

  test("leaves out changes for scratch workspaces, which have no repository", () => {
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID, kind: "scratch" })]);
    expect(view.queryByRole("button", { name: /Changes/ })).toBeNull();
  });

  test("summarizes the goal against its limits and the workspace's activity", () => {
    sidebarState = {
      goal: goal({ status: "paused", costCents: 42, budgetCents: 500, turnsUsed: 3, turnCap: 10 }),
      activeWorkflowRunCount: 2,
      terminalSessionCount: 1,
    };
    const { view, opened, terminalOpenCount } = renderOverview([workspace({ id: WORKSPACE_ID })]);

    const goalRow = within(view.getByRole("region", { name: "Goal" })).getByRole("button");
    expect(goalRow.textContent).toContain("Ship the overview card");
    expect(goalRow.textContent).toContain("Paused");
    expect(goalRow.textContent).toContain("$0.42 / $5.00 · 3 / 10 turns");
    fireEvent.click(goalRow);

    const activity = within(view.getByRole("region", { name: "Activity" }));
    fireEvent.click(activity.getByRole("button", { name: /Workflows/ }));
    fireEvent.click(activity.getByRole("button", { name: /Terminals/ }));

    expect(opened).toEqual(["goal", "workflows"]);
    expect(terminalOpenCount()).toBe(1);
  });

  test("a goal without limits shows no limits line", () => {
    sidebarState = { goal: goal() };
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })]);
    const goalRow = within(view.getByRole("region", { name: "Goal" })).getByRole("button");
    expect(goalRow.textContent).toContain("Active");
    expect(goalRow.textContent).not.toMatch(/\$|turns/);
  });

  test("a status change queued mid-stream keeps its label, without the accent", () => {
    sidebarState = { goal: goal({ status: "paused", pendingPersistence: true }) };
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })]);
    const goalRow = within(view.getByRole("region", { name: "Goal" })).getByRole("button");
    const status = within(goalRow).getByText("Paused");
    expect(status.className).not.toContain("text-warning");
  });

  test("a truncated listing says more outputs exist without claiming a count", async () => {
    const client = createTestApiClient({
      artifacts: {
        list: () =>
          Promise.resolve({
            success: true as const,
            data: {
              available: true as const,
              dir: "/a",
              entries: [artifact("a.md", 2), artifact("b.md", 1)],
              truncated: true,
            },
          }),
      },
    });
    const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })], {
      artifactsEnabled: true,
      client,
    });
    const section = within(await view.findByRole("region", { name: "Outputs" }));
    const rows = section.getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual(["a.md", "b.md", "More"]);
    fireEvent.click(rows[2]);
    expect(opened).toEqual(["artifacts"]);
  });

  test("a truncated listing that found no file still offers More", async () => {
    const client = createTestApiClient({
      artifacts: {
        list: () =>
          Promise.resolve({
            success: true as const,
            data: { available: true as const, dir: "/a", entries: [], truncated: true },
          }),
      },
    });
    const { view } = renderOverview([workspace({ id: WORKSPACE_ID })], {
      artifactsEnabled: true,
      client,
    });
    const section = within(await view.findByRole("region", { name: "Outputs" }));
    expect(section.getAllByRole("button").map((row) => row.textContent)).toEqual(["More"]);
  });

  test("keeps a row for app views when files alone would fill the list", async () => {
    const client = createTestApiClient({
      artifacts: {
        list: () =>
          Promise.resolve({
            success: true as const,
            data: {
              available: true as const,
              dir: "/a",
              entries: [artifact("a.md", 4), artifact("b.md", 3), artifact("c.md", 2)],
              truncated: false,
            },
          }),
      },
    });
    openMcpAppView(WORKSPACE_ID, {
      toolCallId: "call-new",
      serverName: "dice",
      resourceUri: "ui://dice/roll",
      toolName: "roll",
      label: "Roll dice",
      arguments: {},
      cancelled: false,
      failed: false,
    });
    try {
      const { view } = renderOverview([workspace({ id: WORKSPACE_ID })], {
        artifactsEnabled: true,
        client,
      });
      const section = within(await view.findByRole("region", { name: "Outputs" }));
      await waitFor(() =>
        expect(section.getAllByRole("button").map((row) => row.textContent)).toEqual([
          "a.md",
          "b.md",
          "Roll dice",
          "1 more",
        ])
      );
    } finally {
      closeMcpAppView(WORKSPACE_ID, "call-new");
    }
  });

  test("tells repeated MCP app calls apart and marks failed ones", async () => {
    const client = createTestApiClient({
      artifacts: {
        list: () =>
          Promise.resolve({
            success: true as const,
            data: { available: true as const, dir: "/a", entries: [], truncated: false },
          }),
      },
    });
    const appView = (toolCallId: string, failed = false): McpAppViewRef => ({
      toolCallId,
      serverName: "dice",
      resourceUri: "ui://dice/roll",
      toolName: "roll",
      label: "Roll dice",
      arguments: { sides: 6 },
      cancelled: failed,
      failed,
    });
    // Opened oldest first, so the newest ends up first, as the transcript lists them.
    for (const view of [appView("call-1"), appView("call-2"), appView("call-3", true)]) {
      openMcpAppView(WORKSPACE_ID, view);
    }
    try {
      const { view } = renderOverview([workspace({ id: WORKSPACE_ID })], {
        artifactsEnabled: true,
        client,
      });
      const section = within(await view.findByRole("region", { name: "Outputs" }));
      expect(section.getAllByRole("button").map((row) => row.textContent)).toEqual([
        "Roll dicefailed · sides: 6",
        "Roll dicesides: 6 · #2",
        "Roll dicesides: 6 · #1",
      ]);
    } finally {
      for (const id of ["call-1", "call-2", "call-3"]) closeMcpAppView(WORKSPACE_ID, id);
    }
  });

  test("hides goal and activity when there is nothing to report", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID, heartbeat: { enabled: false, intervalMs: 300_000 } }),
    ]);
    for (const name of ["Goal", "Activity", "Outputs"]) {
      expect(view.queryByRole("region", { name })).toBeNull();
    }
  });

  test("shows an enabled heartbeat's cadence", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID, heartbeat: { enabled: true, intervalMs: 300_000 } }),
    ]);
    const activity = view.getByRole("region", { name: "Activity" });
    expect(activity.textContent).toContain("Every 5m");
  });

  test("a heartbeat without its own interval shows the default cadence", () => {
    const { view } = renderOverview([
      workspace({ id: WORKSPACE_ID, heartbeat: { enabled: true } }),
    ]);
    const activity = view.getByRole("region", { name: "Activity" });
    expect(activity.textContent).toContain(
      `Every ${formatHeartbeatIntervalShort(HEARTBEAT_DEFAULT_INTERVAL_MS)}`
    );
  });

  test("lists the newest outputs when Artifacts is on, and opens the picked one", async () => {
    let listCalls = 0;
    const client = createTestApiClient({
      artifacts: {
        list: () => {
          listCalls += 1;
          return Promise.resolve({
            success: true as const,
            data: {
              available: true as const,
              dir: "/scratch/artifacts",
              // Newest first, as the backend lists them.
              entries: [
                artifact("reports/summary.md", 4),
                artifact("plan.md", 3),
                // Same name as the newest, in another folder.
                artifact("drafts/summary.md", 2),
                artifact("old.md", 1),
              ],
              truncated: false,
            },
          });
        },
      },
    });
    const openedArtifacts: string[] = [];
    const onOpenArtifact = (event: Event) =>
      openedArtifacts.push((event as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpenArtifact);

    try {
      const { view, opened } = renderOverview([workspace({ id: WORKSPACE_ID })], {
        artifactsEnabled: true,
        client,
      });
      const section = within(await view.findByRole("region", { name: "Outputs" }));
      const rows = section.getAllByRole("button");
      // Rows show the file name, and the folder under it so same-named files read apart.
      expect(rows.map((row) => row.textContent)).toEqual([
        "summary.mdreports",
        "plan.md",
        "summary.mddrafts",
        "1 more",
      ]);

      // An output selects itself, then asks for the Artifacts tab (which takes focus).
      fireEvent.click(rows[0]);
      expect(openedArtifacts).toEqual(["reports/summary.md"]);
      expect(opened).toEqual(["artifacts"]);
      fireEvent.click(rows[3]);
      expect(opened).toEqual(["artifacts", "artifacts"]);
      cleanup();

      // With the experiment off the card neither lists nor shows outputs.
      const callsBefore = listCalls;
      const off = renderOverview([workspace({ id: WORKSPACE_ID })], { client });
      await waitFor(() =>
        expect(off.view.getByRole("button", { name: "Expand sidebar" })).toBeTruthy()
      );
      expect(off.view.queryByRole("region", { name: "Outputs" })).toBeNull();
      expect(listCalls).toBe(callsBefore);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_ARTIFACT, onOpenArtifact);
    }
  });
});
