import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspacePinnable } from "@/common/utils/pin";
import { hasWorkspaceRepository } from "@/browser/utils/workspaceCapabilities";

/** Every row either "Workspace actions" menu can show (#6202). */
export type WorkspaceActionId =
  | "editTitle"
  | "generateTitle"
  | "configureMcp"
  | "configureHeartbeat"
  | "configureMessaging"
  | "immersiveReview"
  | "touchFullscreenReview"
  | "openSidebar"
  | "openTerminal"
  | "togglePinned"
  | "markUnread"
  | "toggleSubAgents"
  | "fork"
  | "stopRuntime"
  | "archive";

interface CommonActionsState {
  /** Undefined while the menu bar waits for the workspace's metadata. */
  workspace:
    | Pick<FrontendWorkspaceMetadata, "kind" | "parentWorkspaceId" | "archivedAt" | "unarchivedAt">
    | undefined;
  /**
   * The menu's row or header shows the workspace as a sub-agent. The sidebar nests a sub-agent
   * only under a visible parent, so a sub-agent whose parent is hidden shows as a root row and
   * keeps Archive there.
   */
  showsSubAgent: boolean;
  /** A devcontainer runtime that is running now. */
  isRuntimeRunning: boolean;
}

/** The menu of a sidebar row. Its row items change how that row looks. */
interface SidebarActionsState extends CommonActionsState {
  surface: "sidebar";
  /** The row is read and not selected. */
  canMarkUnread: boolean;
  /** The row has completed sub-agents to show or hide. */
  canToggleSubAgents: boolean;
}

/** The menu of the workspace header. Its view items act on the open workspace. */
interface TopBarActionsState extends CommonActionsState {
  surface: "topbar";
  /** Touch tablets and phones: the review opens in its touch full-screen mode. */
  isTouchMobileScreen: boolean;
  /** Touch phones: the header has no room for its terminal button. */
  isPhoneHeader: boolean;
  /** The narrow layout hides the right sidebar. */
  isRightSidebarHidden: boolean;
}

export type WorkspaceActionsState = SidebarActionsState | TopBarActionsState;

/**
 * The one decision of which items each menu shows, and in which order. Each surface keeps the
 * rows and order it had before the two menus shared this list.
 */
export function getWorkspaceActions(state: WorkspaceActionsState): WorkspaceActionId[] {
  // Heartbeats never fire for sub-agent workspaces.
  const isSubAgent = state.workspace?.parentWorkspaceId != null;
  // Scratch chats have no repo: the backend rejects forking them and RightSidebar ignores
  // review events for them.
  const hasRepository = hasWorkspaceRepository(state.workspace);
  const topBar = state.surface === "topbar" ? state : null;
  const sidebar = state.surface === "sidebar" ? state : null;
  const ids: Array<WorkspaceActionId | false | null> = [
    sidebar && "editTitle",
    topBar && "configureMcp",
    !isSubAgent && "configureHeartbeat",
    topBar && "configureMessaging",
    topBar && hasRepository && topBar.isTouchMobileScreen && "touchFullscreenReview",
    topBar && hasRepository && !topBar.isTouchMobileScreen && "immersiveReview",
    topBar?.isRightSidebarHidden === true && "openSidebar",
    topBar?.isPhoneHeader === true && "openTerminal",
    state.isRuntimeRunning && "stopRuntime",
    hasRepository && "fork",
    state.workspace != null && isWorkspacePinnable(state.workspace) && "togglePinned",
    !state.showsSubAgent && "archive",
    sidebar?.canMarkUnread === true && "markUnread",
    sidebar?.canToggleSubAgents === true && "toggleSubAgents",
    sidebar && "generateTitle",
  ];
  return ids.filter((id): id is WorkspaceActionId => typeof id === "string");
}
