import { describe, expect, test } from "bun:test";
import { KeyedFifoLock } from "./keyedFifoLock";

describe("KeyedFifoLock", () => {
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
});
