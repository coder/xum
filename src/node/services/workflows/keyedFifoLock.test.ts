import { afterEach, describe, expect, jest, test } from "bun:test";
import { KeyedFifoLock } from "./keyedFifoLock";

// Bun implements advanceTimersByTime, but its jest typings omit it.
const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };

describe("KeyedFifoLock", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("hands the key over in arrival order", async () => {
    const lock = new KeyedFifoLock();
    const releaseFirst = lock.tryAcquire("key");
    expect(releaseFirst).not.toBeNull();
    const order: number[] = [];
    const waiters = [1, 2, 3].map(async (id) => {
      const release = await lock.acquire("key", Date.now() + 5_000);
      order.push(id);
      release?.();
    });
    releaseFirst?.();
    await Promise.all(waiters);
    expect({ order, waiters: lock.waiterCount("key") }).toEqual({ order: [1, 2, 3], waiters: 0 });
    // Released with nobody waiting: the key is free again.
    expect(lock.tryAcquire("key")).not.toBeNull();
  });

  test("try-lock refuses while the key is held or has waiters; other keys are independent", async () => {
    const lock = new KeyedFifoLock();
    const releaseHolder = lock.tryAcquire("key");
    const waiter = lock.acquire("key", Date.now() + 5_000);
    const refusedWhileQueued = lock.tryAcquire("key");
    const otherKey = lock.tryAcquire("other");
    releaseHolder?.();
    // Handed straight to the waiter: still refused.
    const refusedAfterHandoff = lock.tryAcquire("key");
    (await waiter)?.();
    expect({
      refusedWhileQueued,
      otherKeyTaken: otherKey != null,
      refusedAfterHandoff,
      freeAtEnd: lock.tryAcquire("key") != null,
    }).toEqual({
      refusedWhileQueued: null,
      otherKeyTaken: true,
      refusedAfterHandoff: null,
      freeAtEnd: true,
    });
  });

  test("timed-out waiters behind a hung holder leave the queue and are never granted", async () => {
    const lock = new KeyedFifoLock();
    const releaseHolder = lock.tryAcquire("key");
    const timedOut = await Promise.all(
      Array.from({ length: 5 }, () => lock.acquire("key", Date.now() + 10))
    );
    // Nothing is retained for them while the holder still holds the key.
    const whileHung = { waiters: lock.waiterCount("key"), tryLock: lock.tryAcquire("key") };
    releaseHolder?.();
    const next = await lock.acquire("key", Date.now());
    next?.();
    expect({ timedOut, whileHung, nextEntered: next != null }).toEqual({
      timedOut: [null, null, null, null, null],
      whileHung: { waiters: 0, tryLock: null },
      nextEntered: true,
    });
  });
  test("a deadline beyond the 32-bit timer range waits until the deadline, not ~1 ms", async () => {
    // Node (and Bun) clamp setTimeout delays above 2^31-1 ms (~24.8 days) to 1 ms, so a single
    // timer armed with `deadline - now` gave up almost at once (#5332). Fake timers reproduce the
    // clamp, so the test advances virtual time instead of waiting.
    jest.useFakeTimers();
    const lock = new KeyedFifoLock();
    const releaseHolder = lock.tryAcquire("key");
    const dayMs = 24 * 60 * 60_000;
    const deadline = Date.now() + 60 * dayMs;
    let settled: "pending" | "granted" | "timed-out" = "pending";
    const waiter = lock.acquire("key", deadline).then((release) => {
      settled = release == null ? "timed-out" : "granted";
      return release;
    });
    const states: string[] = [];
    const advance = async (ms: number) => {
      fakeTimers.advanceTimersByTime(ms);
      // Let a resolved waiter's promise chain settle before sampling.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      states.push(settled);
    };
    await advance(10); // past the clamped 1 ms delay
    await advance(30 * dayMs); // past one full 2^31-1 ms chunk
    await advance(60 * dayMs - 30 * dayMs - 10 - 1); // 1 ms before the deadline
    await advance(1); // at the deadline
    await waiter;
    releaseHolder?.();
    expect({ states, waiters: lock.waiterCount("key") }).toEqual({
      states: ["pending", "pending", "pending", "timed-out"],
      waiters: 0,
    });
  });

  test("a waiter with a far deadline is still granted when the holder releases", async () => {
    jest.useFakeTimers();
    const lock = new KeyedFifoLock();
    const releaseHolder = lock.tryAcquire("key");
    const waiter = lock.acquire("key", Date.now() + 2 ** 32);
    fakeTimers.advanceTimersByTime(10);
    await Promise.resolve();
    releaseHolder?.();
    const release = await waiter;
    release?.();
    expect({ granted: release != null, freeAtEnd: lock.tryAcquire("key") != null }).toEqual({
      granted: true,
      freeAtEnd: true,
    });
  });
});
