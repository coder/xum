import { useEffect, useLayoutEffect, useRef } from "react";
import {
  isDesktopViewportFocused,
  isDialogOpen,
  isTerminalFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";

/**
 * Close an overlay (the narrow-screen sidebar drawer, the full-screen right sidebar) on Escape,
 * but only when nothing else claimed the key.
 *
 * The overlay does not own focus, so Escape usually arrives from somewhere else, often the
 * composer. A capture-phase listener took Escape from every popover, menu, dialog and edit mode
 * (#5670 tried one for the tutorial and reverted it). This one runs in the window's bubble phase,
 * after the open layers had their turn:
 * - Radix popovers, menus and dialogs stop Escape in the document capture phase.
 * - React handlers that call stopKeyboardPropagation stop it at the React root.
 * - Document listeners (composer suggestions, the send-mode menu) call preventDefault.
 * The stream interrupt (useAIViewKeybinds) listens in the same phase and mounts first, so it
 * would see Escape before this listener. It asks isEscapeDismissOverlayOpen() instead and yields
 * while an overlay is open: one Escape never does both. When no overlay is open, no listener
 * exists and Escape behaves exactly as it does without this hook.
 *
 * Two overlays use this hook: the narrow-screen sidebar drawer and the full-screen right sidebar
 * (WorkspaceShell). Both can be open at once (the New tab shortcut opens the full-screen sidebar
 * over an open drawer, Ctrl+P opens the drawer under it). Listeners run in registration order,
 * not in visual order, so each overlay passes its `layer` and only the open overlay with the
 * highest layer answers Escape: one Escape closes the overlay the user sees. Ties go to the one
 * opened last.
 */
const openOverlays: Array<{ layer: number }> = [];

/** True while an overlay that closes on Escape is open (see useEscapeToDismiss). */
export function isEscapeDismissOverlayOpen(): boolean {
  return openOverlays.length > 0;
}

function isTopOverlay(overlay: { layer: number }): boolean {
  // The last entry wins ties, because it opened last.
  const top = openOverlays.reduce((best, entry) => (entry.layer >= best.layer ? entry : best));
  return top === overlay;
}

/** `layer`: the overlay's stacking order (higher is drawn above lower). */
export function useEscapeToDismiss(enabled: boolean, onDismiss: () => void, layer = 0): void {
  // A ref keeps one subscription per open overlay. Re-subscribing on every render would move this
  // listener behind later window listeners and change which one sees Escape first.
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;
    const overlay = { layer };

    const handleKeyDown = (e: KeyboardEvent) => {
      // KEYBINDS.CANCEL is bare Escape: modified Escape belongs to other shortcuts.
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      // Something closer to the focus already handled Escape, or an IME is composing text.
      if (e.defaultPrevented || e.isComposing) return;
      // Terminals and remote desktops own their keyboard, Escape included.
      if (isTerminalFocused(e.target) || isDesktopViewportFocused(e.target)) return;
      // A modal above the overlay closes first.
      if (isDialogOpen()) return;
      // Another overlay is drawn above this one: it answers.
      if (!isTopOverlay(overlay)) return;

      e.preventDefault();
      onDismissRef.current();
    };

    openOverlays.push(overlay);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      openOverlays.splice(openOverlays.indexOf(overlay), 1);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, layer]);
}
