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
 * one the user sees on top: the highest layer, and of equal layers the most recently opened.
 * Open order alone is not enough: a window resized to the drawer width opens the drawer under a
 * tutorial that was already showing.
 */
/** Stacking order of the overlays, lowest first. Keep it in line with their z-index. */
export const ESCAPE_DISMISS_LAYER = {
  sidebarDrawer: 0,
  tutorial: 1,
} as const;

type EscapeDismissLayer = (typeof ESCAPE_DISMISS_LAYER)[keyof typeof ESCAPE_DISMISS_LAYER];

interface OpenOverlay {
  layer: EscapeDismissLayer;
}

const openOverlays: OpenOverlay[] = [];

function topOverlay(): OpenOverlay | undefined {
  let top: OpenOverlay | undefined;
  for (const overlay of openOverlays) {
    // >= so that, within one layer, the most recently opened overlay wins.
    if (top == null || overlay.layer >= top.layer) top = overlay;
  }
  return top;
}

/** True while an overlay that closes on Escape is open (see useEscapeToDismiss). */
export function isEscapeDismissOverlayOpen(): boolean {
  return openOverlays.length > 0;
}

export function useEscapeToDismiss(
  enabled: boolean,
  layer: EscapeDismissLayer,
  onDismiss: () => void
): void {
  // A ref keeps one subscription per open overlay. Re-subscribing on every render would move this
  // listener behind later window listeners and change which one sees Escape first.
  const onDismissRef = useRef(onDismiss);
  useLayoutEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;

    const overlay: OpenOverlay = { layer };
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the overlay on top answers Escape.
      if (topOverlay() !== overlay) return;
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
  }, [enabled, layer]);
}
