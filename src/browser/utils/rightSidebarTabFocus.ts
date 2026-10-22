import {
  getDefaultRightSidebarLayoutState,
  getFocusedActiveTab,
  openToolFromNewTab,
  parseRightSidebarLayoutState,
  selectOrAddTab,
  splitFocusedTabset,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { NEW_TAB, isTabType, type TabType } from "@/browser/types/rightSidebar";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import {
  getRightSidebarLayoutKey,
  getRightSidebarCollapsedKey,
  RIGHT_SIDEBAR_TAB_KEY,
} from "@/common/constants/storage";

export function focusRightSidebarTab(workspaceId: string, tab: TabType): void {
  // Explicit navigation must reveal the requested tool even though chats start collapsed.
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  updateRightSidebarLayout(workspaceId, (state) => selectOrAddTab(state, tab));
}

/**
 * The command palette's "Right Sidebar: Focus Terminal" (and Add Tool > Terminal): select the
 * tab, then give it the keyboard.
 */
export function focusRightSidebarTabWithKeyboard(workspaceId: string, tab: TabType): void {
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  updateLayoutThenFocus(workspaceId, (state) => selectOrAddTab(state, tab));
}

/**
 * The command palette's "Right Sidebar: Split Horizontally/Vertically": split the focused pane and
 * move focus into the new one (see requestFocusedTabFocus).
 */
export function splitRightSidebarPane(
  workspaceId: string,
  direction: "horizontal" | "vertical"
): void {
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  updateLayoutThenFocus(workspaceId, (state) => splitFocusedTabset(state, direction));
}

/**
 * The command palette's "Right Sidebar: Add Tool…": the same as picking the tool in the focused
 * pane's New tab (it takes the New tab's place, or is selected where it is already open), focus
 * included.
 */
export function openRightSidebarTool(workspaceId: string, tool: TabType): void {
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  updateLayoutThenFocus(workspaceId, (state) =>
    openToolFromNewTab(state, state.focusedTabsetId, tool)
  );
}

/**
 * The palette row that ran a command unmounts with the palette, so focus would fall to <body>.
 * Ask the workspace's sidebar to focus the tab its focused pane now shows, as "Right Sidebar: New
 * Tab" focuses its launcher. Only focus travels by event: the layout is already stored, so a
 * sidebar that is not mounted (the shell's loading placeholder) still shows it once it mounts.
 */
function requestFocusedTabFocus(workspaceId: string): void {
  const layout = readRightSidebarLayout(workspaceId);
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.FOCUS_SIDEBAR_TAB, {
      workspaceId,
      tabsetId: layout.focusedTabsetId,
      tab: getFocusedActiveTab(layout, NEW_TAB),
    })
  );
}

/**
 * Store the updated layout, then ask for focus on its focused tab. A refused write leaves the old
 * layout on screen: then ask only when that already shows the requested tab (the request was a
 * no-op), because otherwise focus would jump to the tab that the focused pane showed before.
 */
function updateLayoutThenFocus(
  workspaceId: string,
  updater: (state: RightSidebarLayoutState) => RightSidebarLayoutState
): void {
  const before = readRightSidebarLayout(workspaceId);
  if (updateRightSidebarLayout(workspaceId, updater) || showsSameTab(before, updater(before))) {
    requestFocusedTabFocus(workspaceId);
  }
}

function showsSameTab(a: RightSidebarLayoutState, b: RightSidebarLayoutState): boolean {
  return (
    a.focusedTabsetId === b.focusedTabsetId &&
    getFocusedActiveTab(a, NEW_TAB) === getFocusedActiveTab(b, NEW_TAB)
  );
}

export function readRightSidebarLayout(workspaceId: string): RightSidebarLayoutState {
  const fallback = getRightSidebarTabFallback();
  const raw = readPersistedState(
    getRightSidebarLayoutKey(workspaceId),
    getDefaultRightSidebarLayoutState(fallback)
  );
  return parseRightSidebarLayoutState(raw, fallback);
}

/**
 * Returns false when the write was refused (updatePersistedState: localStorage full even after
 * evicting caches, setItem throwing, or no localStorage). Then the sidebar keeps its old layout.
 */
export function updateRightSidebarLayout(
  workspaceId: string,
  updater: (state: RightSidebarLayoutState) => RightSidebarLayoutState
): boolean {
  const fallback = getRightSidebarTabFallback();
  const defaultLayout = getDefaultRightSidebarLayoutState(fallback);

  return updatePersistedState<RightSidebarLayoutState>(
    getRightSidebarLayoutKey(workspaceId),
    (prev) => updater(parseRightSidebarLayoutState(prev, fallback)),
    defaultLayout
  );
}

/**
 * A tool explicitly requested for new layouts, if any. Without one a new layout holds just the
 * New tab (see getDefaultRightSidebarLayoutState).
 */
export function getRightSidebarTabFallback(): TabType | undefined {
  const raw = readPersistedState<string | null>(RIGHT_SIDEBAR_TAB_KEY, null);
  return isTabType(raw) ? raw : undefined;
}
