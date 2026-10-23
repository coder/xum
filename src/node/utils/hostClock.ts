/**
 * `HostClock` — the wall clock and timers of agent-loop code (phase 3 of the
 * agent-loop host refactor).
 *
 * Loop code reads time and arms timers only through this interface, so a test
 * can run the loop on Effect's `TestClock` (see `di/hostClockLive.ts`) while
 * production keeps the exact `Date.now()` / `setTimeout()` behavior of today.
 * The interface lives in `src/node/utils` so plain helpers such as
 * `raceWithAbortAndTimeout` can take it without importing the DI graph.
 */
export interface HostClock {
  /** Wall time in ms since the epoch. `Date.now()` in production. */
  nowMs(): number;
  /**
   * `setTimeout(fn, ms)` in production; returns the cancel (`clearTimeout`).
   * `fn` never runs before `setTimer` returns. `unref` is honored only by
   * real timers.
   */
  setTimer(fn: () => void, ms: number, options?: { unref?: boolean }): () => void;
}

/**
 * Today's behavior, verbatim. It reads the globals at each call, not at
 * import, so tests that still fake timers or patch `Date.now` keep working
 * while their production code moves onto `HostClock`.
 */
export const nodeClock: HostClock = {
  nowMs: () => Date.now(),
  setTimer: (fn, ms, options) => {
    const timer = setTimeout(fn, ms);
    if (options?.unref === true) {
      timer.unref?.();
    }
    return () => clearTimeout(timer);
  },
};
