import { createContext, useContext, type ComponentType } from "react";
import { useEscapeToDismiss } from "@/browser/hooks/useEscapeToDismiss";
import { useNarrowViewport } from "@/browser/hooks/useNarrowViewport";

/**
 * True while the right sidebar shows as its full-window overlay (WorkspaceShell's full-screen
 * sidebar). That happens whenever the docked sidebar is responsively
 * hidden: a narrow viewport, or a workspace shell too narrow for it (globals.css container query,
 * e.g. a ~900px window with the left sidebar expanded). RightSidebar provides it.
 */
export const RightSidebarOverlayContext = createContext(false);

/**
 * What a pinned view's toolbar renders at its start while pinned: RightSidebar provides the left
 * sidebar toggle bar spacer (PinnedViewToggleBarSpacer). A context, not an import, so the VS Code
 * webview, which bundles ArtifactsPanel and McpAppFrame but has no app shell, never bundles the
 * desktop shell classes (vscode/src/webview/webviewCss.test.ts).
 */
export const PinnedViewToolbarSpacerContext = createContext<ComponentType>(NoToolbarSpacer);

/**
 * No toggle bar to keep clear: outside RightSidebar (the webview, tests), or while the left
 * sidebar is expanded (its toggle bar then sits over the sidebar, not over the pinned view).
 */
export function NoToolbarSpacer() {
  return null;
}

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

/**
 * Escape layer of a workspace-scoped pinned view: above the narrow-screen drawer (0) and the
 * full-screen right sidebar (1), though neither can be open with it.
 */
const PINNED_VIEW_ESCAPE_LAYER = 2;

/**
 * Escape from the usable left sidebar beside a workspace-scoped pinned view ends it, like
 * Escape from inside the panel. Without this, Escape from a sidebar control reached
 * Escape-to-interrupt and stopped the chat stream behind the panel (useAIViewKeybinds yields to
 * open useEscapeToDismiss overlays). A window-scoped view needs none: everything else is inert.
 */
export function usePinnedViewEscape(active: boolean, coversWindow: boolean, onExit: () => void) {
  useEscapeToDismiss(active && !coversWindow, onExit, PINNED_VIEW_ESCAPE_LAYER);
}
