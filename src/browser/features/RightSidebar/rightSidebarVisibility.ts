import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getReviewImmersiveKey, getRightSidebarCollapsedKey } from "@/common/constants/storage";
import { NARROW_VIEWPORT_MAX_WIDTH_PX, RIGHT_SIDEBAR_DEFAULT_COLLAPSED } from "@/constants/layout";
import { isCommandPaletteTarget, isDialogOpen } from "@/browser/utils/ui/keybinds";

/**
 * True when the right sidebar container is hidden by the responsive (narrow) layout. Immersive
 * review hides it too, with the same display:none, but marks it aria-hidden: that is not a
 * responsive hide, so the full-screen entry points stay off and the sidebar keeps its shortcuts.
 * WorkspaceMenuBar (opens a tab full-screen while the sidebar is hidden) and RightSidebar (its
 * own shortcuts) both read this, so exactly one of them acts on a sidebar shortcut.
 */
export function isRightSidebarResponsivelyHidden(sidebar: HTMLElement): boolean {
  if (sidebar.getAttribute("aria-hidden") === "true") {
    return false;
  }
  return window.getComputedStyle(sidebar).display === "none";
}

/**
 * True when the right sidebar inside a workspace shell is responsively hidden. The CSS hides it
 * by two independent rules, for any pointer type: a viewport media query (narrow viewports) and
 * the shell's container query (e.g. a ~900px window with the left sidebar expanded), so read the
 * sidebar's computed visibility. Falls back to the media query when no sidebar is in the DOM
 * (scratch pages, first render before refs attach).
 */
export function isWorkspaceRightSidebarHidden(shell: Element | null | undefined): boolean {
  const sidebar = shell?.querySelector(".mobile-hide-right-sidebar");
  if (sidebar instanceof HTMLElement) {
    return isRightSidebarResponsivelyHidden(sidebar);
  }
  return window.matchMedia(`(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`).matches;
}

// The toggle helpers live here, not in rightSidebarTabFocus.ts: the VS Code webview bundles that
// file, and these read desktop-only layout classes (vscode/src/webview/webviewCss.test.ts).

/**
 * True when the right sidebar's collapse state can change on screen, so the TOGGLE_RIGHT_SIDEBAR
 * key and its palette command act only then (and the palette lists the command only then).
 * A narrow window or immersive review hides the sidebar, so a flip there would be invisible until
 * later. Immersive review also hides the header toggle (ShellRightSidebarToggle). The phone
 * full-screen view shows the narrow layout's sidebar, and a collapse there left a blank view (bug
 * bash RS2): its own Close button closes it. The failed-load frame ignores the collapse state to
 * keep its Reload button on screen, so a flip there would only surface after a reload.
 */
export function canToggleRightSidebar(workspaceId: string, shell: Element | null): boolean {
  // No mounted shell (AIView's incompatible-runtime screen, a loading placeholder): no sidebar.
  if (
    shell == null ||
    shell.querySelector(".right-sidebar-fullscreen, [data-right-sidebar-load-failed]") != null
  ) {
    return false;
  }
  if (isWorkspaceRightSidebarHidden(shell)) return false;
  return !readPersistedState(getReviewImmersiveKey(workspaceId), false);
}

/**
 * Collapses or expands the right sidebar (the TOGGLE_RIGHT_SIDEBAR key and its palette command).
 * Returns false, and changes nothing, unless canToggleRightSidebar() allows it.
 */
export function toggleRightSidebarCollapsed(workspaceId: string, shell: Element | null): boolean {
  if (!canToggleRightSidebar(workspaceId, shell)) return false;
  updatePersistedState<boolean>(
    getRightSidebarCollapsedKey(workspaceId),
    (prev) => !prev,
    RIGHT_SIDEBAR_DEFAULT_COLLAPSED
  );
  return true;
}

/**
 * Focuses the right sidebar's header toggle. A toggle from the hotkey or the palette can unmount
 * the control that had focus (a sidebar control, or the closed palette's input), and focus then
 * fell to <body>. The toggle keeps its place in both states, and a click on it leaves focus there.
 */
export function focusRightSidebarToggle(root: ParentNode | null | undefined): void {
  root?.querySelector<HTMLElement>('[data-testid="right-sidebar-toggle-bar"] button')?.focus();
}

/**
 * True when an overlay blocks the right sidebar toggle: a modal dialog, the command palette (not a
 * modal dialog, bug bash RS1), or a focused popover or menu (Radix portals them out of the sidebar,
 * so a collapse would unmount the control with focus and leave focus on <body>). A held key also
 * blocks it, or it would flip the sidebar on every repeat.
 */
export function isRightSidebarToggleBlocked(e: KeyboardEvent): boolean {
  return (
    e.repeat ||
    isDialogOpen() ||
    isCommandPaletteTarget(e.target) ||
    (e.target instanceof Element && e.target.closest("[data-radix-popper-content-wrapper]") != null)
  );
}

/**
 * Toggles the right sidebar for a hotkey (TOGGLE_RIGHT_SIDEBAR, and OPEN_ARTIFACTS_TAB while the
 * Artifacts tab shows). A collapse unmounts the focused control, and focus then fell to <body>
 * (bug bash RS3), so focus moves to the header toggle. Returns whether the sidebar toggled.
 */
export function toggleRightSidebarFromKey(workspaceId: string, shell: Element | null): boolean {
  const sidebar = shell?.querySelector(".mobile-hide-right-sidebar");
  const focusWasInSidebar = sidebar?.contains(document.activeElement) === true;
  if (!toggleRightSidebarCollapsed(workspaceId, shell)) return false;
  if (focusWasInSidebar) focusRightSidebarToggle(shell);
  return true;
}

/**
 * The command palette's "Right Sidebar: Toggle". The palette closes before its command runs, and
 * its input took focus with it, so a toggle moves focus to the header toggle.
 */
export function toggleRightSidebarFromPalette(workspaceId: string): void {
  if (toggleRightSidebarCollapsed(workspaceId, document.querySelector("[data-workspace-shell]"))) {
    focusRightSidebarToggle(document);
  }
}

/**
 * Whether the palette lists "Right Sidebar: Toggle": only while the toggle can act (Codex review
 * of #7128: the command closed the palette and did nothing). Without a DOM (command-source unit
 * tests) there is no layout to check.
 */
export function isRightSidebarToggleAvailable(workspaceId: string): boolean {
  return (
    typeof document === "undefined" ||
    canToggleRightSidebar(workspaceId, document.querySelector("[data-workspace-shell]"))
  );
}
