/**
 * Deterministic regression tests for the violations the TLA+ models in formal/primitives/
 * found in the pre-handoff primitives (run formal/primitives/check.sh). Each test states the
 * contract the fixed code now keeps.
 *
 * Only microtask order matters: `settle()` drains every queued microtask and nothing
 * depends on wall-clock time.
 */
import { describe, expect, test } from "bun:test";
import { AsyncMutex } from "./asyncMutex";
import { AsyncSemaphore } from "./asyncSemaphore";

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("AsyncSemaphore (formal/primitives/AsyncSemaphore.tla, AsyncSemaphore_fifo.cfg)", () => {
  // The docstring promises that further acquirers wait FIFO. When releaseSlot() freed the slot
  // and the woken waiter only re-checked in a later microtask, a caller in between took the slot
  // and the waiter re-queued at the TAIL; releaseSlot() now hands the slot to the waiter.
  test("waiters get slots in arrival order", async () => {
    const semaphore = new AsyncSemaphore(1);
    const order: string[] = [];
    // Each acquirer records its turn and releases at once, so any grant order completes.
    const take = (name: string) =>
      semaphore.acquire().then((slot) => {
        order.push(name);
        slot.release();
      });
    const holder = await semaphore.acquire();

    const first = take("first");
    await settle(); // `first` is parked in the queue

    holder.release(); // hands the slot to `first`
    const barger = take("barger"); // runs synchronously: must queue behind `first`
    const second = take("second");
    await Promise.all([first, barger, second]);

    expect(order).toEqual(["first", "barger", "second"]);
  });
});

describe("AsyncMutex (formal/primitives/AsyncMutex.tla)", () => {
  // AsyncMutex_fifo.cfg: same mechanism as above; release() now hands the lock to the waiter.
  test("queued waiters get the lock in arrival order", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const take = (name: string) =>
      mutex.acquire().then(async (lock) => {
        order.push(name);
        await lock[Symbol.asyncDispose]();
      });
    const holder = await mutex.acquire();

    const first = take("first");
    await settle();

    void holder[Symbol.asyncDispose](); // release() runs synchronously and hands off to `first`
    const barger = take("barger"); // must queue behind `first`
    const second = take("second");
    await Promise.all([first, barger, second]);

    expect(order).toEqual(["first", "barger", "second"]);
  });

  // AsyncMutex_double.cfg: without a per-handle released flag, disposing a handle twice cleared
  // `locked` while the next holder still held the lock. A second dispose is now a no-op.
  test("disposing a handle twice never frees a lock held by someone else", async () => {
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();
    await first[Symbol.asyncDispose]();
    const second = await mutex.acquire();

    await first[Symbol.asyncDispose](); // stale handle
    const intruder = mutex.tryAcquire();
    try {
      expect(intruder).toBeNull();
    } finally {
      await intruder?.[Symbol.asyncDispose]();
      await second[Symbol.asyncDispose]();
    }
  });
});
