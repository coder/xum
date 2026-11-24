import React from "react";
import {
  KEYBINDS,
  isDesktopViewportFocused,
  isDialogOpen,
  isTerminalFocused,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";
import { isTabSelected, type RightSidebarLayoutState } from "@/browser/utils/rightSidebarLayout";
import {
  isRightSidebarResponsivelyHidden,
  isRightSidebarToggleBlocked,
  toggleRightSidebarFromKey,
} from "./rightSidebarVisibility";

interface ArtifactsTabKeyOptions {
  workspaceId: string;
  /** The Artifacts experiment: the key does nothing while it is off. */
  enabled: boolean;
  collapsed: boolean;
  sidebarContainerRef: React.RefObject<HTMLDivElement | null>;
  getLayout: () => RightSidebarLayoutState;
  /** Un-collapse the sidebar on the Artifacts tab and give the tab focus. */
  openArtifactsTab: () => void;
}

/**
 * True for OPEN_ARTIFACTS_TAB that this sidebar owns. While the narrow layout hides the sidebar,
 * WorkspaceMenuBar shows the tab in the full-screen sidebar instead, so one keystroke never acts
 * twice. Remote desktops and terminals own their keystrokes.
 */
function isSidebarArtifactsKey(e: KeyboardEvent, container: HTMLElement | null): boolean {
  return (
    matchesKeybind(e, KEYBINDS.OPEN_ARTIFACTS_TAB) &&
    (container == null || !isRightSidebarResponsivelyHidden(container)) &&
    !isDialogOpen() &&
    !isTerminalFocused(e.target) &&
    !isDesktopViewportFocused(e.target)
  );
}

/** True when the key was pressed with focus inside the Artifacts panel (an artifact frame included). */
function isFocusInArtifactsPanel(e: KeyboardEvent, container: HTMLElement | null): boolean {
  // A key pressed in an artifact frame is replayed on the <iframe> (SandboxedArtifactFrame), which
  // sits inside the panel, so that press counts as focus in the panel too.
  return (
    e.target instanceof Element &&
    container?.contains(e.target) === true &&
    e.target.closest('[data-testid="artifacts-panel"]') != null
  );
}

/**
 * What the key does. Collapsed, or with another tab showing, it opens the Artifacts tab and focuses
 * it. While the expanded sidebar shows the tab, the key first moves focus into it, and only a press
 * with focus already there toggles the sidebar like TOGGLE_RIGHT_SIDEBAR (user request). Both keep
 * the toggle's blocks: a modal dialog, the command palette or a focused popover leaves focus and the
 * sidebar as they are, and immersive review and the failed-load frame keep the sidebar open
 * (toggleRightSidebarFromKey refuses there).
 */
function artifactsKeyAction(
  e: KeyboardEvent,
  collapsed: boolean,
  layout: RightSidebarLayoutState,
  container: HTMLElement | null
): "open" | "toggle" | "none" {
  if (collapsed || !isTabSelected(layout.root, "artifacts")) return "open";
  if (isRightSidebarToggleBlocked(e)) return "none";
  // The tab already shows, so "open" only moves focus into it.
  return isFocusInArtifactsPanel(e, container) ? "toggle" : "open";
}

/**
 * Global shortcut: open (and un-collapse) the Artifacts tab and focus it, or collapse the sidebar
 * when focus is already in the tab (artifactsKeyAction). Works from the chat input too, because
 * the chord inserts nothing there.
 */
export function useArtifactsTabKey(options: ArtifactsTabKeyOptions): void {
  const { workspaceId, enabled, collapsed, sidebarContainerRef, getLayout, openArtifactsTab } =
    options;
  React.useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      const container = sidebarContainerRef.current;
      if (!isSidebarArtifactsKey(e, container)) return;
      e.preventDefault();
      // A held key would open and collapse the sidebar on every repeat.
      if (e.repeat) return;
      const action = artifactsKeyAction(e, collapsed, getLayout(), container);
      if (action === "open") {
        openArtifactsTab();
      } else if (action === "toggle") {
        toggleRightSidebarFromKey(
          workspaceId,
          container?.closest("[data-workspace-shell]") ?? null
        );
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [collapsed, enabled, getLayout, openArtifactsTab, sidebarContainerRef, workspaceId]);
}
