import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

/**
 * True when the right sidebar container is hidden by the responsive (narrow) layout. Immersive
 * review hides it too, with the same display:none, but marks it aria-hidden: that is not a
 * responsive hide, so the dialog entry points stay off and the sidebar keeps its shortcuts.
 * WorkspaceMenuBar (dialog fallbacks) and RightSidebar (its own shortcuts) both read this, so
 * exactly one of them acts on a shortcut such as Ctrl+Shift+K.
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
