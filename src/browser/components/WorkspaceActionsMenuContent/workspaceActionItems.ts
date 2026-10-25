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

/** An item, or `false` when its condition hides it. */
type ActionSlot = WorkspaceActionId | false;

/**
 * The one decision of which items each menu shows, in the approved group order: Title,
 * Settings, View (top bar only), Sidebar row, Lifecycle. The sidebar row menu leads with Pin in a
 * group of its own: flat sidebar rows have no inline pin icon, so pinning lives first in the menu.
 * Empty groups are dropped, so the menu draws a separator only between groups that show.
 */
export function getWorkspaceActionGroups(state: WorkspaceActionsState): WorkspaceActionId[][] {
  // Heartbeats never fire for sub-agent workspaces.
  const isSubAgent = state.workspace?.parentWorkspaceId != null;
  // Scratch chats have no repo: the backend rejects forking them and RightSidebar ignores
  // review events for them.
  const hasRepository = hasWorkspaceRepository(state.workspace);
  const pin = state.workspace != null && isWorkspacePinnable(state.workspace) && "togglePinned";
  const title: ActionSlot[] = [
    // The top bar edits the title in the header itself, so it works with the row hidden (#6328).
    "editTitle",
    "generateTitle",
  ];
  const settings: ActionSlot[] = [
    "configureMcp",
    !isSubAgent && "configureHeartbeat",
    "configureMessaging",
  ];
  const lifecycle: ActionSlot[] = [
    hasRepository && "fork",
    state.isRuntimeRunning && "stopRuntime",
    !state.showsSubAgent && "archive",
  ];
  const groups: ActionSlot[][] =
    state.surface === "topbar"
      ? [
          title,
          settings,
          [
            hasRepository && !state.isTouchMobileScreen && "immersiveReview",
            hasRepository && state.isTouchMobileScreen && "touchFullscreenReview",
            state.isRightSidebarHidden && "openSidebar",
            state.isPhoneHeader && "openTerminal",
          ],
          [pin],
          lifecycle,
        ]
      : [
          [pin],
          title,
          settings,
          [state.canMarkUnread && "markUnread", state.canToggleSubAgents && "toggleSubAgents"],
          lifecycle,
        ];
  return groups
    .map((group) => group.filter((id): id is WorkspaceActionId => id !== false))
    .filter((group) => group.length > 0);
}
