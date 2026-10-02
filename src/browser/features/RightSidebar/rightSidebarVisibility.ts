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
