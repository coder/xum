import { useEffect, useLayoutEffect, useRef } from "react";
import {
  isDesktopViewportFocused,
  isDialogOpen,
  isTerminalFocused,
  KEYBINDS,
  matchesKeybind,
} from "@/browser/utils/ui/keybinds";

/**
 * Close an overlay (the tutorial tooltip, the narrow-screen sidebar drawer) on Escape, but only
 * when nothing else claimed the key.
 *
 * These overlays sit over the whole app and do not own focus, so Escape usually arrives from
 * somewhere else, often the composer. A capture-phase listener took Escape from every popover,
 * menu, dialog and edit mode (#5670 tried it and reverted it). This one runs in the window's
 * bubble phase, after the open layers had their turn:
 * - Radix popovers, menus and dialogs stop Escape in the document capture phase.
 * - React handlers that call stopKeyboardPropagation stop it at the React root.
 * - Document listeners (composer suggestions, the send-mode menu) call preventDefault.
 * The stream interrupt (useAIViewKeybinds) listens in the same phase and mounts first, so it
 * would see Escape before this listener. It asks isEscapeDismissOverlayOpen() instead and yields
 * while an overlay is open: one Escape never does both. When no overlay is open, no listener
 * exists and Escape behaves exactly as it does without this hook.
 *
 * Several overlays can be open at once (a tutorial over the drawer). One Escape closes only the
 * most recently opened one: window listeners run in registration order, so without the stack
 * the oldest overlay would close first, under the one the user sees.
 */
const openOverlays: object[] = [];

/** True while an overlay that closes on Escape is open (see useEscapeToDismiss). */
export function isEscapeDismissOverlayOpen(): boolean {
  return openOverlays.length > 0;
}

export function useEscapeToDismiss(enabled: boolean, onDismiss: () => void): void {
  // A ref keeps one subscription per open overlay. Re-subscribing on every render would move this
  // listener behind later window listeners and change which one sees Escape first.
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;

    const overlay = {};
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the most recently opened overlay answers Escape.
      if (openOverlays[openOverlays.length - 1] !== overlay) return;
      // KEYBINDS.CANCEL is bare Escape: modified Escape belongs to other shortcuts.
      if (!matchesKeybind(e, KEYBINDS.CANCEL)) return;
      // Something closer to the focus already handled Escape, or an IME is composing text.
      if (e.defaultPrevented || e.isComposing) return;
      // Terminals and remote desktops own their keyboard, Escape included.
      if (isTerminalFocused(e.target) || isDesktopViewportFocused(e.target)) return;
      // A modal above the overlay closes first.
      if (isDialogOpen()) return;

      e.preventDefault();
      onDismissRef.current();
    };

    openOverlays.push(overlay);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      openOverlays.splice(openOverlays.indexOf(overlay), 1);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled]);
}
