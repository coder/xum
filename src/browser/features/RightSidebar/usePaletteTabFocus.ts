import React from "react";
import { CUSTOM_EVENTS, type CustomEventType } from "@/common/constants/events";
import { isNewTab, isTabType, isTerminalTab, type TabType } from "@/browser/types/rightSidebar";
import { isRightSidebarResponsivelyHidden } from "./rightSidebarVisibility";

interface PaletteTabFocusOptions {
  workspaceId: string;
  sidebarContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Focus the first row of this tabset's New tab launcher once it shows. */
  focusLauncher: (tabsetId: string) => void;
  /** Focus this terminal tab's terminal. */
  focusTerminalTab: (tab: TabType) => void;
  /** The launcher's follow-ups for a picked tool in this tabset: its panel or its tab button. */
  focusTool: (tabsetId: string, tab: TabType) => void;
}

/**
 * FOCUS_SIDEBAR_TAB: the command palette's "Right Sidebar: Split Horizontally/Vertically" and
 * "Add Tool…" store their layout, then ask for focus here. Like "Right Sidebar: New Tab", focus
 * moves into the new pane (its launcher's first row, or the tab that the split moved there) or into
 * the tool, as picking it in the launcher does. While the narrow layout or immersive review hides
 * the sidebar, nothing takes focus.
 */
export function usePaletteTabFocus(options: PaletteTabFocusOptions): void {
  // A ref, so the listener subscribes once per workspace and still calls the latest callbacks
  // (as in useWorkspaceActionKeybinds).
  const optionsRef = React.useRef(options);
  React.useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const workspaceId = options.workspaceId;
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEventType<typeof CUSTOM_EVENTS.FOCUS_SIDEBAR_TAB>).detail;
      if (detail?.workspaceId !== workspaceId || !isTabType(detail.tab)) return;
      focusTab(optionsRef.current, detail.tabsetId, detail.tab);
    };
    window.addEventListener(CUSTOM_EVENTS.FOCUS_SIDEBAR_TAB, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.FOCUS_SIDEBAR_TAB, handler);
  }, [workspaceId]);
}

function focusTab(options: PaletteTabFocusOptions, tabsetId: string, tab: TabType): void {
  if (!isSidebarShown(options.sidebarContainerRef.current)) return;
  if (isNewTab(tab)) options.focusLauncher(tabsetId);
  else if (isTerminalTab(tab)) options.focusTerminalTab(tab);
  else options.focusTool(tabsetId, tab);
}

function isSidebarShown(container: HTMLElement | null): boolean {
  if (container == null) return true;
  // Immersive review hides the sidebar too (aria-hidden and inert), which
  // isRightSidebarResponsivelyHidden does not count: nothing in it can take focus.
  return (
    container.getAttribute("aria-hidden") !== "true" && !isRightSidebarResponsivelyHidden(container)
  );
}
