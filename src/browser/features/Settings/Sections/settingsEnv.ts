// Browser mode: window.api is not set (only exists in Electron via preload). Read it when
// used rather than at module evaluation, so the answer never depends on which environment
// happened to import this module first (e.g. an earlier test file in the same process).
export function isBrowserMode(): boolean {
  return typeof window !== "undefined" && !window.api;
}
