import { describe, expect, test } from "bun:test";
import {
  getWorkspaceActionGroups,
  type WorkspaceActionId,
  type WorkspaceActionsState,
} from "./workspaceActionItems";

// Which rows each "Workspace actions" menu shows, per surface and workspace kind (#6202).
// The cases pin gating and order; labels live in the menu component.

type SidebarState = Extract<WorkspaceActionsState, { surface: "sidebar" }>;
type TopBarState = Extract<WorkspaceActionsState, { surface: "topbar" }>;

const root = {};
const subAgent = { parentWorkspaceId: "parent" };
const scratch = { kind: "scratch" as const };
const archived = { archivedAt: "2026-01-02T00:00:00.000Z" };

function sidebar(overrides: Partial<Omit<SidebarState, "surface">>): SidebarState {
  return {
    surface: "sidebar",
    workspace: root,
    showsSubAgent: false,
    isRuntimeRunning: false,
    canMarkUnread: false,
    canToggleSubAgents: false,
    ...overrides,
  };
}

function topBar(overrides: Partial<Omit<TopBarState, "surface">>): TopBarState {
  return {
    surface: "topbar",
    workspace: root,
    showsSubAgent: false,
    isRuntimeRunning: false,
    isTouchMobileScreen: false,
    isPhoneHeader: false,
    isRightSidebarHidden: false,
    ...overrides,
  };
}

const TITLE: WorkspaceActionId[] = ["editTitle", "generateTitle"];
const SETTINGS: WorkspaceActionId[] = ["configureMcp", "configureHeartbeat", "configureMessaging"];
const SUB_AGENT_SETTINGS: WorkspaceActionId[] = ["configureMcp", "configureMessaging"];

const cases: Array<{ name: string; state: WorkspaceActionsState; groups: WorkspaceActionId[][] }> =
  [
    {
      name: "sidebar, root workspace",
      state: sidebar({}),
      groups: [TITLE, SETTINGS, ["togglePinned"], ["fork", "archive"]],
    },
    {
      name: "sidebar, root with a running devcontainer, read, with completed sub-agents",
      state: sidebar({ isRuntimeRunning: true, canMarkUnread: true, canToggleSubAgents: true }),
      groups: [
        TITLE,
        SETTINGS,
        ["togglePinned", "markUnread", "toggleSubAgents"],
        ["fork", "stopRuntime", "archive"],
      ],
    },
    {
      name: "sidebar, sub-agent nested under its parent",
      state: sidebar({ workspace: subAgent, showsSubAgent: true }),
      groups: [TITLE, SUB_AGENT_SETTINGS, ["fork"]],
    },
    {
      name: "sidebar, sub-agent shown as a root row (parent hidden)",
      state: sidebar({ workspace: subAgent }),
      groups: [TITLE, SUB_AGENT_SETTINGS, ["fork", "archive"]],
    },
    {
      name: "sidebar, scratch chat",
      state: sidebar({ workspace: scratch }),
      groups: [TITLE, SETTINGS, ["togglePinned"], ["archive"]],
    },
    {
      name: "sidebar, archived workspace",
      state: sidebar({ workspace: archived }),
      groups: [TITLE, SETTINGS, ["fork", "archive"]],
    },
    {
      name: "top bar, root workspace on a desktop",
      state: topBar({}),
      groups: [SETTINGS, ["immersiveReview"], ["togglePinned"], ["fork", "archive"]],
    },
    {
      name: "top bar, root workspace on a touch phone with the sidebar hidden",
      state: topBar({ isTouchMobileScreen: true, isPhoneHeader: true, isRightSidebarHidden: true }),
      groups: [
        SETTINGS,
        ["touchFullscreenReview", "openSidebar", "openTerminal"],
        ["togglePinned"],
        ["fork", "archive"],
      ],
    },
    {
      name: "top bar, root workspace on a touch tablet",
      state: topBar({ isTouchMobileScreen: true }),
      groups: [SETTINGS, ["touchFullscreenReview"], ["togglePinned"], ["fork", "archive"]],
    },
    {
      name: "top bar, scratch chat on a touch phone",
      state: topBar({
        workspace: scratch,
        isTouchMobileScreen: true,
        isPhoneHeader: true,
        isRightSidebarHidden: true,
      }),
      groups: [SETTINGS, ["openSidebar", "openTerminal"], ["togglePinned"], ["archive"]],
    },
    {
      name: "top bar, sub-agent",
      state: topBar({ workspace: subAgent, showsSubAgent: true }),
      groups: [SUB_AGENT_SETTINGS, ["immersiveReview"], ["fork"]],
    },
    {
      name: "top bar, root with a running devcontainer",
      state: topBar({ isRuntimeRunning: true }),
      groups: [SETTINGS, ["immersiveReview"], ["togglePinned"], ["fork", "stopRuntime", "archive"]],
    },
    {
      name: "top bar, archived workspace",
      state: topBar({ workspace: archived }),
      groups: [SETTINGS, ["immersiveReview"], ["fork", "archive"]],
    },
    {
      name: "top bar, before the workspace's metadata arrives",
      state: topBar({ workspace: undefined }),
      groups: [SETTINGS, ["archive"]],
    },
  ];

describe("getWorkspaceActionGroups", () => {
  test.each(cases)("$name", ({ state, groups }) => {
    expect(getWorkspaceActionGroups(state)).toEqual(groups);
  });

  // The issue's promise: apart from the view items (top bar) and the title and row items
  // (sidebar), both menus
  // show the same actions in the same order for the same workspace.
  const SURFACE_ONLY = new Set<WorkspaceActionId>([
    "editTitle",
    "generateTitle",
    "immersiveReview",
    "touchFullscreenReview",
    "openSidebar",
    "openTerminal",
    "markUnread",
    "toggleSubAgents",
  ]);
  const shared = (state: WorkspaceActionsState) =>
    getWorkspaceActionGroups(state)
      .flat()
      .filter((id) => !SURFACE_ONLY.has(id));

  test.each([
    { name: "root", workspace: root, showsSubAgent: false },
    { name: "sub-agent", workspace: subAgent, showsSubAgent: true },
    { name: "scratch", workspace: scratch, showsSubAgent: false },
    { name: "archived", workspace: archived, showsSubAgent: false },
  ])("both menus share their core actions: $name workspace", (kind) => {
    const common = { workspace: kind.workspace, showsSubAgent: kind.showsSubAgent };
    const sidebarIds = shared(
      sidebar({ ...common, isRuntimeRunning: true, canMarkUnread: true, canToggleSubAgents: true })
    );
    const topBarIds = shared(
      topBar({
        ...common,
        isRuntimeRunning: true,
        isTouchMobileScreen: true,
        isPhoneHeader: true,
        isRightSidebarHidden: true,
      })
    );
    expect(sidebarIds).toEqual(topBarIds);
  });
});
