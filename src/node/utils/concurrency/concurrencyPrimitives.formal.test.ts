/**
 * Deterministic repros of the violations found by the TLA+ models in formal/primitives/
 * (run formal/primitives/check.sh). Each test states the CORRECT contract and is marked
 * `test.failing` because the current code breaks it; when a fix lands, the test starts
 * passing, bun reports it as a failure, and the fix should flip it to a plain `test`.
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
  // asyncSemaphore.ts:7-8 promises that further acquirers wait FIFO. releaseSlot() frees the
  // slot but the woken waiter only re-checks in a later microtask, so a caller in between takes
  // the slot and the waiter re-queues at the TAIL, behind a waiter that arrived after it.
  test.failing("waiters get slots in arrival order", async () => {
    const semaphore = new AsyncSemaphore(1);
    const order: string[] = [];
    const holder = await semaphore.acquire();

    const first = semaphore.acquire().then((slot) => {
      order.push("first");
      return slot;
    });
    await settle(); // `first` is parked in the queue

    holder.release(); // wakes `first`; its re-check runs in a later microtask
    const barger = semaphore.acquire(); // runs synchronously: takes the free slot
    const second = semaphore.acquire().then((slot) => {
      order.push("second");
      return slot;
    });
    await settle(); // `first` finds the slot taken and re-queues behind `second`

    (await barger).release();
    (await second).release();
    (await first).release();

    expect(order).toEqual(["first", "second"]); // actual: ["second", "first"]
  });
});

describe("AsyncMutex (formal/primitives/AsyncMutex.tla)", () => {
  // AsyncMutex_fifo.cfg: same mechanism as above (asyncMutex.ts:24-25 and :57-63).
  test.failing("queued waiters get the lock in arrival order", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];
    const holder = await mutex.acquire();

    const first = mutex.acquire().then((lock) => {
      order.push("first");
      return lock;
    });
    await settle();

    void holder[Symbol.asyncDispose](); // release() runs synchronously and wakes `first`
    const barger = mutex.acquire(); // takes the lock before `first` re-checks
    const second = mutex.acquire().then((lock) => {
      order.push("second");
      return lock;
    });
    await settle(); // `first` re-queues behind `second`

    await (await barger)[Symbol.asyncDispose]();
    await (await second)[Symbol.asyncDispose]();
    await (await first)[Symbol.asyncDispose]();

    expect(order).toEqual(["first", "second"]); // actual: ["second", "first"]
  });

  // AsyncMutex_double.cfg: AsyncMutexLock (asyncMutex.ts:78-81) has no released flag, so
  // disposing a handle twice clears `locked` while the next holder still holds the lock.
  test.failing("disposing a handle twice never frees a lock held by someone else", async () => {
    const mutex = new AsyncMutex();
    const first = await mutex.acquire();
    await first[Symbol.asyncDispose]();
    const second = await mutex.acquire();

    await first[Symbol.asyncDispose](); // stale handle
    const intruder = mutex.tryAcquire();
    try {
      expect(intruder).toBeNull(); // actual: a second concurrent holder
    } finally {
      await intruder?.[Symbol.asyncDispose]();
      await second[Symbol.asyncDispose]();
    }
  });
});
