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
 * picking it in the launcher does. Both reveal a collapsed sidebar. While the narrow layout or
 * immersive review hides the sidebar, the layout still changes, but nothing takes focus. The
 * sidebar claims each request (preventDefault), so the palette knows it acted.
 */
export function usePaletteSidebarRequests(options: PaletteSidebarRequestOptions): void {
  // A ref, so the listeners subscribe once per workspace and still call the latest callbacks
  // (as in useWorkspaceActionKeybinds).
  const optionsRef = React.useRef(options);
  React.useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const workspaceId = options.workspaceId;
  React.useEffect(() => {
    const handleSplit = (event: Event) => {
      const detail = (event as CustomEventType<typeof CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      // Claimed: the palette changes the stored layout itself only when no sidebar did.
      event.preventDefault();
      splitPane(optionsRef.current, detail.direction);
    };
    const handleOpenTool = (event: Event) => {
      const detail = (event as CustomEventType<typeof CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL>).detail;
      if (detail?.workspaceId !== workspaceId) return;
      event.preventDefault();
      if (isBaseTabId(detail.tool)) openTool(optionsRef.current, detail.tool);
    };
    window.addEventListener(CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE, handleSplit);
    window.addEventListener(CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL, handleOpenTool);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.SPLIT_SIDEBAR_PANE, handleSplit);
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SIDEBAR_TOOL, handleOpenTool);
    };
  }, [workspaceId]);
}

function splitPane(options: PaletteSidebarRequestOptions, direction: "horizontal" | "vertical") {
  options.setCollapsed(false);
  const next = splitFocusedTabset(options.getBaseLayout(), direction);
  options.setLayout(() => next);
  if (!isSidebarShown(options.sidebarContainerRef.current)) return;
  const tab = getFocusedActiveTab(next, NEW_TAB);
  if (isNewTab(tab)) options.focusLauncher(next.focusedTabsetId);
  else if (isTerminalTab(tab)) options.focusTerminalTab(tab);
  else options.focusTab(tab);
}

function openTool(options: PaletteSidebarRequestOptions, tool: BaseTabType) {
  options.setCollapsed(false);
  const tabsetId = options.getBaseLayout().focusedTabsetId;
  if (isSidebarShown(options.sidebarContainerRef.current)) {
    options.openToolWithFocus(tabsetId, tool);
  } else {
    options.setLayout((prev) => openToolFromNewTab(prev, tabsetId, tool));
  }
}

function isSidebarShown(container: HTMLElement | null): boolean {
  if (container == null) return true;
  // Immersive review hides the sidebar too (aria-hidden and inert), which
  // isRightSidebarResponsivelyHidden does not count: nothing in it can take focus.
  return (
    container.getAttribute("aria-hidden") !== "true" && !isRightSidebarResponsivelyHidden(container)
  );
}
