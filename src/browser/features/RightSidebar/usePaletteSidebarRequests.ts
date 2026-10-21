import React from "react";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { isBaseTabId, type BaseTabType } from "./Tabs/tabConfig";
import { NEW_TAB, isNewTab, isTerminalTab, type TabType } from "@/browser/types/rightSidebar";
import {
  getFocusedActiveTab,
  openToolFromNewTab,
  splitFocusedTabset,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import { isRightSidebarResponsivelyHidden } from "./rightSidebarVisibility";

interface PaletteSidebarRequestOptions {
  workspaceId: string;
  sidebarContainerRef: React.RefObject<HTMLDivElement | null>;
  getBaseLayout: () => RightSidebarLayoutState;
  setLayout: (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => void;
  setCollapsed: (collapsed: boolean) => void;
  /** Focus the first row of this tabset's New tab launcher once it shows. */
  focusLauncher: (tabsetId: string) => void;
  /** Focus this terminal tab's terminal (a no-op for other tabs). */
  focusTerminalTab: (tab: TabType) => void;
  /** Focus this tab's button in the focused pane once it shows. */
  focusTab: (tab: TabType) => void;
  /** Open the tool from this tabset's New tab, with the launcher's focus follow-ups. */
  openToolWithFocus: (tabsetId: string, tool: BaseTabType) => void;
}

/**
 * The command palette's "Right Sidebar: Split Horizontally/Vertically" (SPLIT_SIDEBAR_PANE) and
 * "Add Tool…" (OPEN_SIDEBAR_TOOL). The palette row unmounts with the palette, so focus would fall
 * to <body>. Like "Right Sidebar: New Tab", the sidebar acts on them, so focus moves into the new
 * pane (its launcher's first row, or the tab that the split moved there) or into the tool, as
 * picking it in the launcher does. Both reveal a collapsed sidebar. While the narrow layout hides
 * the sidebar, the layout still changes (its full-screen view shows it), but nothing takes focus.
 */
export function usePaletteSidebarRequests(options: PaletteSidebarRequestOptions): void {
  const {
    workspaceId,
    sidebarContainerRef,
    getBaseLayout,
    setLayout,
    setCollapsed,
    focusLauncher,
    focusTerminalTab,
    focusTab,
    openToolWithFocus,
  } = options;
  React.useEffect(() => {
    const shown = () => isSidebarShown(sidebarContainerRef.current);
    const handleSplit = (event: Event) => {
      const detail = (event as CustomEventType<typeof CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      setCollapsed(false);
      const next = splitFocusedTabset(getBaseLayout(), detail.direction);
      setLayout(() => next);
      if (!shown()) return;
      const tab = getFocusedActiveTab(next, NEW_TAB);
      if (isNewTab(tab)) focusLauncher(next.focusedTabsetId);
      else if (isTerminalTab(tab)) focusTerminalTab(tab);
      else focusTab(tab);
    };
    const handleOpenTool = (event: Event) => {
      const detail = (event as CustomEventType<typeof CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL>).detail;
      if (detail?.workspaceId !== workspaceId || !isBaseTabId(detail.tool)) return;
      const tool = detail.tool;
      setCollapsed(false);
      const tabsetId = getBaseLayout().focusedTabsetId;
      if (shown()) openToolWithFocus(tabsetId, tool);
      else setLayout((prev) => openToolFromNewTab(prev, tabsetId, tool));
    };
    window.addEventListener(CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE, handleSplit);
    window.addEventListener(CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL, handleOpenTool);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE, handleSplit);
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL, handleOpenTool);
    };
  }, [
    workspaceId,
    sidebarContainerRef,
    getBaseLayout,
    setLayout,
    setCollapsed,
    focusLauncher,
    focusTerminalTab,
    focusTab,
    openToolWithFocus,
  ]);
}

function isSidebarShown(container: HTMLElement | null): boolean {
  return container == null || !isRightSidebarResponsivelyHidden(container);
}
