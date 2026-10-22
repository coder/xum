import { createContext, useContext } from "react";
import { useNarrowViewport } from "@/browser/hooks/useNarrowViewport";

/**
 * True while the right sidebar shows as its full-window overlay (WorkspaceShell's full-screen
 * sidebar, `.right-sidebar-fullscreen`). That happens whenever the docked sidebar is responsively
 * hidden: a narrow viewport, or a workspace shell too narrow for it (globals.css container query,
 * e.g. a ~900px window with the left sidebar expanded). RightSidebar provides it.
 */
export const RightSidebarOverlayContext = createContext(false);

/**
 * Whether a pinned view (Artifacts fullscreen, a maximized App View tab) covers the whole window
 * as a modal dialog, instead of only the workspace shell. It must when the right sidebar that
 * holds it is already a full-window overlay: that layer covers the left sidebar and makes it inert,
 * so a workspace-scoped pin could not leave the left sidebar usable.
 */
export function usePinnedViewCoversWindow(): boolean {
  const narrow = useNarrowViewport();
  const inOverlay = useContext(RightSidebarOverlayContext);
  return narrow || inOverlay;
}
