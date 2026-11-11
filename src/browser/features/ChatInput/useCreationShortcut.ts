import { useEffect, useRef } from "react";
import {
  isAltGraphPressed,
  isDialogOpen,
  matchesKeybind,
  type Keybind,
} from "@/browser/utils/ui/keybinds";

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
      // The page's shortcuts are Ctrl+Alt+Shift chords, and AltGr reports as Ctrl+Alt: Shift+AltGr
      // types a character on some layouts, so that input stays text.
      if (isAltGraphPressed(event) || !matchesKeybind(event, keybind) || isDialogOpen()) return;
      event.preventDefault();
      if (!event.repeat) void actionRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, keybind]);
}
