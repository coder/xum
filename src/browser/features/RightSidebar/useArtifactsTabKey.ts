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

/**
 * Global shortcut: open (and un-collapse) the Artifacts tab, or, when the expanded sidebar already
 * shows it, collapse the whole sidebar like TOGGLE_RIGHT_SIDEBAR (user request: the key toggles
 * the tab). Works from the chat input too, because the chord inserts nothing there.
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
      // The collapse refuses where it would not show (immersive review, the failed-load frame):
      // the key then opens the tab as before.
      if (
        !collapsed &&
        isTabSelected(getLayout().root, "artifacts") &&
        toggleRightSidebarFromKey(workspaceId, container?.closest("[data-workspace-shell]") ?? null)
      ) {
        return;
      }
      openArtifactsTab();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [collapsed, enabled, getLayout, openArtifactsTab, sidebarContainerRef, workspaceId]);
}
