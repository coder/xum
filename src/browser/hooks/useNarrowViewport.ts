import { useSyncExternalStore } from "react";
import { NARROW_VIEWPORT_MAX_WIDTH_PX } from "@/constants/layout";

const NARROW_VIEWPORT_QUERY = `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`;

// Resolve matchMedia per call rather than at module load, so tests can stub it per test and a
// window without matchMedia (a partial test DOM) reads as wide instead of throwing.
function subscribe(onChange: () => void): () => void {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no matchMedia outside a browser
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(NARROW_VIEWPORT_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(NARROW_VIEWPORT_QUERY).matches
  );
}

function getServerSnapshot(): boolean {
  return false;
}

/** True at phone and narrow-browser widths (the same breakpoint as the `max-width: 768px` CSS). */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

let narrowSession = 0;
let wasNarrow = false;

// Counts on each read that finds the viewport narrow after a wide one. Reads without a change
// return the same number, as useSyncExternalStore requires.
function getNarrowSessionSnapshot(): number {
  const narrow = getSnapshot();
  if (narrow && !wasNarrow) narrowSession++;
  wasNarrow = narrow;
  return narrow ? narrowSession : 0;
}

function getServerNarrowSessionSnapshot(): number {
  return 0;
}

/**
 * 0 while the viewport is wide; at narrow widths a number that is new each time the viewport turns
 * narrow, so state keyed by it resets on every return to narrow without a render-phase update or
 * an effect.
 */
export function useNarrowViewportSession(): number {
  return useSyncExternalStore(subscribe, getNarrowSessionSnapshot, getServerNarrowSessionSnapshot);
}
