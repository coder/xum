import { CUSTOM_EVENTS } from "@/common/constants/events";
import {
  isDialogOpen,
  isEditableElement,
  KEYBINDS,
  matchesKeybind,
  matchesNewSidebarTabKeybind,
} from "@/browser/utils/ui/keybinds";

/** Replays one held input. WorkspaceShell queues these while the right sidebar's chunk loads. */
export type HeldSidebarInput = () => void;

// Input that only RightSidebar (or, on phones, WorkspaceMenuBar) acts on. Keep in sync with the
// window listeners in RightSidebar.tsx. Not OPEN_SIDE_CHAT_TAB: its sender reads the dispatch result
// at once and opens the side chat full-screen when no sidebar claims it, as on a narrow layout.
const SIDEBAR_EVENTS = [
  CUSTOM_EVENTS.OPEN_GOAL_TAB,
  CUSTOM_EVENTS.OPEN_NEW_SIDEBAR_TAB,
  CUSTOM_EVENTS.OPEN_MCP_APP_VIEW,
  CUSTOM_EVENTS.OPEN_ARTIFACT,
  CUSTOM_EVENTS.OPEN_REVIEW_IMMERSIVE,
  CUSTOM_EVENTS.OPEN_TOUCH_REVIEW_IMMERSIVE,
];
const SIDEBAR_KEYBINDS = [
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => KEYBINDS[`SIDEBAR_TAB_${n}`]),
  KEYBINDS.OPEN_ARTIFACTS_TAB,
  KEYBINDS.CLOSE_TAB,
];

/**
 * T3 #5971: RightSidebar is code-split, so its window listeners do not exist until its chunk
 * loads. Until then this holds its input (a window capture listener runs before every other
 * window listener, even at the window target) and queues a replay, so the input acts exactly
 * once, after the sidebar mounts. Returns the cleanup.
 */
export function holdSidebarInput(held: HeldSidebarInput[]): () => void {
  const holdKey = (e: KeyboardEvent) => {
    const sidebarKey =
      SIDEBAR_KEYBINDS.some((keybind) => matchesKeybind(e, keybind)) ||
      matchesNewSidebarTabKeybind(e) || // its own matcher: AltGr does not count
      // Shift+I types a letter in a text field, where the sidebar ignores it.
      (matchesKeybind(e, KEYBINDS.TOGGLE_REVIEW_IMMERSIVE) && !isEditableElement(e.target));
    if (!sidebarKey) return;
    // Like RightSidebar: Cmd/Ctrl+W must not close the window, even while a dialog is open.
    if (matchesKeybind(e, KEYBINDS.CLOSE_TAB)) e.preventDefault();
    if (isDialogOpen()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const { target, key, code, ctrlKey, shiftKey, altKey, metaKey } = e;
    const init = { key, code, ctrlKey, shiftKey, altKey, metaKey, bubbles: true, cancelable: true };
    held.push(() => {
      const node = target instanceof Node && target.isConnected ? target : window;
      node.dispatchEvent(new window.KeyboardEvent("keydown", init));
    });
  };
  const holdEvent = (e: Event) => {
    e.stopImmediatePropagation();
    const detail: unknown = e instanceof window.CustomEvent ? e.detail : undefined;
    held.push(() => window.dispatchEvent(new window.CustomEvent(e.type, { detail })));
  };
  window.addEventListener("keydown", holdKey, true);
  for (const type of SIDEBAR_EVENTS) window.addEventListener(type, holdEvent, true);
  return () => {
    window.removeEventListener("keydown", holdKey, true);
    for (const type of SIDEBAR_EVENTS) window.removeEventListener(type, holdEvent, true);
  };
}

/**
 * After the sidebar chunk failed to load: RightSidebar never mounts, so keep its guard that stops
 * Cmd/Ctrl+W from closing the window. Returns the cleanup.
 */
export function guardCloseTab(): () => void {
  const guard = (e: KeyboardEvent) => {
    if (matchesKeybind(e, KEYBINDS.CLOSE_TAB)) e.preventDefault();
  };
  window.addEventListener("keydown", guard);
  return () => window.removeEventListener("keydown", guard);
}
