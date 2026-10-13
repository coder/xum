import { describe, expect, test } from "bun:test";
import {
  getWorkspaceActions,
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

const cases: Array<{ name: string; state: WorkspaceActionsState; ids: WorkspaceActionId[] }> = [
  {
    name: "sidebar, root workspace",
    state: sidebar({}),
    ids: ["editTitle", "configureHeartbeat", "fork", "togglePinned", "archive", "generateTitle"],
  },
  {
    name: "sidebar, root with a running devcontainer, read, with completed sub-agents",
    state: sidebar({ isRuntimeRunning: true, canMarkUnread: true, canToggleSubAgents: true }),
    ids: [
      "editTitle",
      "configureHeartbeat",
      "stopRuntime",
      "fork",
      "togglePinned",
      "archive",
      "markUnread",
      "toggleSubAgents",
      "generateTitle",
    ],
  },
  {
    name: "sidebar, sub-agent nested under its parent",
    state: sidebar({ workspace: subAgent, showsSubAgent: true }),
    ids: ["editTitle", "fork", "generateTitle"],
  },
  {
    name: "sidebar, sub-agent shown as a root row (parent hidden)",
    state: sidebar({ workspace: subAgent }),
    ids: ["editTitle", "fork", "archive", "generateTitle"],
  },
  {
    name: "sidebar, scratch chat",
    state: sidebar({ workspace: scratch }),
    ids: ["editTitle", "configureHeartbeat", "togglePinned", "archive", "generateTitle"],
  },
  {
    name: "sidebar, archived workspace",
    state: sidebar({ workspace: archived }),
    ids: ["editTitle", "configureHeartbeat", "fork", "archive", "generateTitle"],
  },
  {
    name: "top bar, root workspace on a desktop",
    state: topBar({}),
    ids: [
      "configureMcp",
      "configureHeartbeat",
      "configureMessaging",
      "immersiveReview",
      "fork",
      "togglePinned",
      "archive",
    ],
  },
  {
    name: "top bar, root workspace on a touch phone with the sidebar hidden",
    state: topBar({ isTouchMobileScreen: true, isPhoneHeader: true, isRightSidebarHidden: true }),
    ids: [
      "configureMcp",
      "configureHeartbeat",
      "configureMessaging",
      "touchFullscreenReview",
      "openSidebar",
      "openTerminal",
      "fork",
      "togglePinned",
      "archive",
    ],
  },
  {
    name: "top bar, scratch chat on a touch phone",
    state: topBar({
      workspace: scratch,
      isTouchMobileScreen: true,
      isPhoneHeader: true,
      isRightSidebarHidden: true,
    }),
    ids: [
      "configureMcp",
      "configureHeartbeat",
      "configureMessaging",
      "openSidebar",
      "openTerminal",
      "togglePinned",
      "archive",
    ],
  },
  {
    name: "top bar, sub-agent",
    state: topBar({ workspace: subAgent, showsSubAgent: true }),
    ids: ["configureMcp", "configureMessaging", "immersiveReview", "fork"],
  },
  {
    name: "top bar, root with a running devcontainer",
    state: topBar({ isRuntimeRunning: true }),
    ids: [
      "configureMcp",
      "configureHeartbeat",
      "configureMessaging",
      "immersiveReview",
      "stopRuntime",
      "fork",
      "togglePinned",
      "archive",
    ],
  },
  {
    name: "top bar, archived workspace",
    state: topBar({ workspace: archived }),
    ids: [
      "configureMcp",
      "configureHeartbeat",
      "configureMessaging",
      "immersiveReview",
      "fork",
      "archive",
    ],
  },
  {
    name: "top bar, before the workspace's metadata arrives",
    state: topBar({ workspace: undefined }),
    ids: ["configureMcp", "configureHeartbeat", "configureMessaging", "archive"],
  },
];

describe("getWorkspaceActions", () => {
  test.each(cases)("$name", ({ state, ids }) => {
    expect(getWorkspaceActions(state)).toEqual(ids);
  });
});
