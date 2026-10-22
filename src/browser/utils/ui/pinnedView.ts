import { makeOthersInert } from "@/browser/utils/ui/makeOthersInert";
import { refocusFallenFocus } from "@/browser/utils/ui/refocusFallenFocus";

/** Marks the workspace shell (WorkspaceShell), the box a wide-window pinned view covers. */
const WORKSPACE_SHELL_SELECTOR = "[data-workspace-shell]";

const BOX_PROPERTIES = ["top", "left", "width", "height"] as const;

/**
 * Pins a `position: fixed` panel (Artifacts fullscreen, a maximized App View tab) over the
 * workspace shell that holds it, the same box immersive review covers (#review-immersive-root),
 * so the left sidebar stays visible and usable in a wide window. The panel stays in place, not in
 * a portal: a portal remounts the viewer and reloads its frames. It cannot be `absolute inset-0`
 * either: it has positioned ancestors inside the shell (the right sidebar's panes). So the inline
 * top/left/width/height copied from the shell win over the panel's `inset-0`.
 *
 * Only the shell's other content goes inert, and focus the user moves out of the shell stays
 * there. Returns the undo.
 */
export function pinOverWorkspace(panel: HTMLElement): () => void {
  const shell = panel.closest<HTMLElement>(WORKSPACE_SHELL_SELECTOR);
  // Every pinned view renders inside a workspace shell; tests and stories wrap it in one.
  if (shell == null) throw new Error("pinOverWorkspace: panel is not inside a workspace shell");
  const place = () => {
    const box = shell.getBoundingClientRect();
    panel.style.top = `${box.top}px`;
    panel.style.left = `${box.left}px`;
    panel.style.width = `${box.width}px`;
    panel.style.height = `${box.height}px`;
  };
  place();
  // In this layout the shell moves only when its size changes too: a left sidebar drag or
  // collapse changes its width, a banner above it changes its height, and so does the window.
  const observer = new ResizeObserver(place);
  observer.observe(shell);
  const restoreInert = makeOthersInert(panel, shell);
  const stopRefocus = refocusFallenFocus(panel, shell);
  return () => {
    observer.disconnect();
    stopRefocus();
    restoreInert();
    for (const property of BOX_PROPERTIES) panel.style.removeProperty(property);
  };
}

/**
 * Pins the panel over the whole window (narrow windows, where the left sidebar is a drawer that
 * opens under the panel): everything else goes inert and fallen focus returns. Returns the undo.
 */
export function pinOverWindow(panel: HTMLElement): () => void {
  const restoreInert = makeOthersInert(panel);
  const stopRefocus = refocusFallenFocus(panel);
  return () => {
    stopRefocus();
    restoreInert();
  };
}

/**
 * Pins a fullscreen or maximized panel for the current width: over the window when `narrow`,
 * else over the workspace shell. Returns the undo.
 */
export function pinView(panel: HTMLElement, narrow: boolean): () => void {
  return narrow ? pinOverWindow(panel) : pinOverWorkspace(panel);
}

/**
 * The role of a pinned panel. Narrow: the rest of the window is inert, so a modal dialog. Wide: a
 * region over the workspace shell beside the usable left sidebar, like immersive review, so
 * shortcuts that check isDialogOpen() work as they do there.
 */
export function pinnedViewRole(narrow: boolean): {
  role: "dialog" | "region";
  "aria-modal": true | undefined;
} {
  return narrow
    ? { role: "dialog", "aria-modal": true }
    : { role: "region", "aria-modal": undefined };
}

/**
 * The position and layer of a pinned panel. Narrow: z-[1500], the shared Dialog layer. Wide:
 * z-[1040], above the chat's menus and toasts (z-[1000]-z-[1020]) and below the left sidebar
 * toggle bar (z-[1050]), so a collapsed sidebar can still be opened; pinOverWorkspace sets the box
 * inline over `inset-0`. Portaled menus and tooltips stay above both.
 */
export function pinnedViewClass(narrow: boolean): string {
  return narrow
    ? "bg-background ios-standalone:top-px fixed inset-0 z-[1500]"
    : "bg-background fixed inset-0 z-[1040]";
}
