/**
 * User Timing mark for the first app shell commit of this page load. Why (T3, #5971): the
 * desktop cold-start A/B and the first-load JS work read it.
 *
 * A module-level flag, because AppInner can remount (after the auth modal, or StrictMode in
 * dev) and later attaches must add nothing. A ref callback, because it needs no useEffect and
 * suits the React Compiler: a module function is a stable ref, so React calls it only on
 * attach and detach.
 */
export const APP_SHELL_READY_MARK = "xum:app-shell-ready";

let marked = false;

export function markAppShellReady(element: HTMLElement | null): void {
  if (element == null || marked) return;
  marked = true;
  // bun tests / happy-dom may lack User Timing; the mark is optional there.
  if (typeof performance !== "undefined" && typeof performance.mark === "function") {
    performance.mark(APP_SHELL_READY_MARK);
  }
}
