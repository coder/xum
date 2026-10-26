// Fake-clock helpers for browser tests whose code under test waits on timers (debounces,
// cooldowns, retries) and on promise pipelines between them. Call `vi.useFakeTimers()` in
// `beforeEach` and `vi.useRealTimers()` in `afterEach`. A fixed real-time sleep in such a test is
// slow and racy: a negative check after it also passes when the unwanted call only comes later.
import assert from "node:assert/strict";
import { vi } from "bun:test";

/** `vi` with the fake-timer methods bun implements but bun-types does not declare. */
export const fakeTimers = vi as typeof vi & {
  advanceTimersByTime(ms: number): void;
  isFakeTimers(): boolean;
  getTimerCount(): number;
};

/**
 * Runs every promise continuation that is already queued, and the ones those queue: one
 * macrotask turn (`setImmediate`, which the fake timers leave real) after the whole microtask
 * queue has drained. Work that waits on a timer or real I/O stays pending.
 */
export function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Moves the fake clock forward by `ms`, one millisecond at a time, draining microtasks at each
 * step. A timer that a promise continuation starts inside the window still fires in order.
 */
export async function advanceClock(ms: number): Promise<void> {
  assert(Number.isInteger(ms) && ms >= 0, `advanceClock needs a whole ms count, got ${ms}`);
  assert(fakeTimers.isFakeTimers(), "advanceClock needs vi.useFakeTimers()");
  await drainMicrotasks();
  for (let elapsed = 0; elapsed < ms; elapsed++) {
    fakeTimers.advanceTimersByTime(1);
    await drainMicrotasks();
  }
}

/**
 * Advances the fake clock until `condition` holds. Fails once `budgetMs` of fake time passed
 * without it, so a missing call fails the test instead of hanging it.
 */
export async function advanceClockUntil(
  condition: () => boolean,
  budgetMs: number,
  what = "condition"
): Promise<void> {
  assert(fakeTimers.isFakeTimers(), "advanceClockUntil needs vi.useFakeTimers()");
  await drainMicrotasks();
  for (let elapsed = 0; !condition(); elapsed++) {
    if (elapsed >= budgetMs) {
      throw new Error(`${what} did not hold within ${budgetMs} ms of fake time`);
    }
    fakeTimers.advanceTimersByTime(1);
    await drainMicrotasks();
  }
}
