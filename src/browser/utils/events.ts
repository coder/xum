import type React from "react";

export function isEventFromDialogPortal(target: EventTarget | null): boolean {
  // Dialogs rendered through React portals still bubble through the caller's React tree.
  // Callers can ignore those events without stopping native propagation that Radix and
  // popovers need for outside-interaction tracking.
  return target instanceof Element && target.closest('[role="dialog"]') != null;
}

/**
 * Stop keyboard event propagation for both React synthetic events and native KeyboardEvents.
 *
 * Use this when handling keyboard events in React components that need to prevent
 * global window listeners (like stream interrupt) from firing.
 *
 * Background: React's `e.stopPropagation()` only stops propagation within React's
 * synthetic event system. Native window listeners attached via `addEventListener`
 * will still receive the event. This helper stops both.
 *
 * Note: This only affects bubble-phase native listeners. Capture-phase listeners
 * will have already fired before this is called.
 */
export function stopKeyboardPropagation(e: React.KeyboardEvent | KeyboardEvent): void {
  if ("nativeEvent" in e) {
    // React synthetic event - stop both React and native propagation
    e.stopPropagation();
    e.nativeEvent.stopPropagation();
    return;
  }

  // Native KeyboardEvent - stop propagation directly
  e.stopPropagation();
}

/**
 * Adds a window listener only while `enabled` (for example its experiment is on) and returns the
 * cleanup, a no-op when nothing was added. Keeps one effect free of a branch per gated event.
 */
export function addWindowListenerWhile(
  enabled: boolean,
  type: string,
  listener: (event: Event) => void
): () => void {
  if (!enabled) return () => undefined;
  window.addEventListener(type, listener);
  return () => window.removeEventListener(type, listener);
}
