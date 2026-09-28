import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

// Cache the MediaQueryList at module level so subscribe/getSnapshot don't
// create a new object on every call.
// Also require matchMedia itself: a window without it (a partial test DOM left behind by an
// earlier file in a shared test process) made this module throw at import, poisoning every
// later importer of the tool-renderer graph with "before initialization" errors.
const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;

function subscribe(callback: () => void): () => void {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no matchMedia in SSR
  if (!mql) return () => {};
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return mql?.matches ?? false;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the user has enabled "reduce motion" in their OS settings.
 * Reacts to live changes (e.g. toggling the setting while the app is open).
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
