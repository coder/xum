import { useEffect, useRef } from "react";
import {
  isAltGraphPressed,
  isCommandPaletteTarget,
  isDialogOpen,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";

/**
 * Whether a creation-page chord may act on this event. Not on AltGr input: the chords are
 * Ctrl+Alt+Shift, AltGr reports as Ctrl+Alt, and Shift+AltGr types a character on some layouts.
 * Not behind a modal dialog, and not from the command palette, which isDialogOpen() does not see:
 * the actions move focus, and focus must not leave the open palette.
 */
function creationShortcutMayAct(event: KeyboardEvent): boolean {
  return !isAltGraphPressed(event) && !isDialogOpen() && !isCommandPaletteTarget(event.target);
}

/**
 * Runs a creation-page action on its keybind while enabled, outside open dialogs. Shared by the
 * page's shortcuts ("Set as default", opening the environment panel) so they gate the same way.
 */
export function useCreationShortcut(
  enabled: boolean,
  keybind: Keybind,
  action: () => void | Promise<void>
): void {
  // Read the latest action through a ref, so the listener subscribes once per enabled state
  // instead of on every render.
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!matchesKeybind(event, keybind) || !creationShortcutMayAct(event)) return;
      event.preventDefault();
      if (!event.repeat) void actionRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybind]);
}
