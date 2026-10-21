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

/** Returns false when the layout write was refused (see updateRightSidebarLayout). */
export function focusRightSidebarTab(workspaceId: string, tab: TabType): boolean {
  // Explicit navigation must reveal the requested tool even though chats start collapsed.
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  return updateRightSidebarLayout(workspaceId, (state) => selectOrAddTab(state, tab));
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
  if (updateRightSidebarLayout(workspaceId, (state) => splitFocusedTabset(state, direction))) {
    requestFocusedTabFocus(workspaceId);
  }
}

/**
 * The command palette's "Right Sidebar: Add Tool…": the same as picking the tool in the focused
 * pane's New tab (it takes the New tab's place, or is selected where it is already open), focus
 * included.
 */
export function openRightSidebarTool(workspaceId: string, tool: TabType): void {
  updatePersistedState(getRightSidebarCollapsedKey(workspaceId), false);
  const stored = updateRightSidebarLayout(workspaceId, (state) =>
    openToolFromNewTab(state, state.focusedTabsetId, tool)
  );
  if (stored) requestFocusedTabFocus(workspaceId);
}

/**
 * The palette row that ran a command unmounts with the palette, so focus would fall to <body>.
 * Ask the workspace's sidebar to focus the tab its focused pane now shows, as "Right Sidebar: New
 * Tab" focuses its launcher. Only focus travels by event: the layout is already stored, so a
 * sidebar that is not mounted (the shell's loading placeholder) still shows it once it mounts.
 * Callers skip it when the layout write was refused: nothing changed on screen, and focus would
 * jump to the tab that the focused pane showed before.
 */
export function requestFocusedTabFocus(workspaceId: string): void {
  const layout = readRightSidebarLayout(workspaceId);
  window.dispatchEvent(
    createCustomEvent(CUSTOM_EVENTS.FOCUS_SIDEBAR_TAB, {
      workspaceId,
      tabsetId: layout.focusedTabsetId,
      tab: getFocusedActiveTab(layout, NEW_TAB),
    })
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
