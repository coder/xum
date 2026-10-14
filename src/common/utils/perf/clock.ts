/**
 * Shared perf clock: float epoch milliseconds built from the high-resolution
 * monotonic clock. The backend flight recorder, the renderer collector and later
 * oRPC spans all stamp with it so their timelines line up on one axis.
 * `globalThis.performance` exists in Node 22 and every supported browser.
 */
export function perfEpochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Converts a `PerformanceEntry.startTime` (relative to timeOrigin) to perf epoch ms. */
export function perfEpochFromRelativeMs(relativeMs: number): number {
  return performance.timeOrigin + relativeMs;
}
