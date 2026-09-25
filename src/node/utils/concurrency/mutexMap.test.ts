import { describe, expect, test } from "bun:test";
import { MutexMap } from "./mutexMap";

describe("MutexMap", () => {
  test("serializes concurrent operations on the same key", async () => {
    const mutex = new MutexMap<string>();
    const key = "test";
    const events: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    // First operation acquires lock
    const op1 = mutex.withLock(key, async () => {
      events.push("op1-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 30));
      concurrentCount--;
      events.push("op1-end");
      return 1;
    });

    // Wait a tick for op1 to acquire lock
    await new Promise((r) => setImmediate(r));

    // Start 3 more operations while op1 holds the lock
    const op2 = mutex.withLock(key, async () => {
      events.push("op2-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 10));
      concurrentCount--;
      events.push("op2-end");
      return 2;
    });

    const op3 = mutex.withLock(key, async () => {
      events.push("op3-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 10));
      concurrentCount--;
      events.push("op3-end");
      return 3;
    });

    const op4 = mutex.withLock(key, async () => {
      events.push("op4-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 10));
      concurrentCount--;
      events.push("op4-end");
      return 4;
    });

    const results = await Promise.all([op1, op2, op3, op4]);

    expect(results).toEqual([1, 2, 3, 4]);
    expect(maxConcurrent).toBe(1); // Only one operation at a time
    expect(events).toEqual([
      "op1-start",
      "op1-end",
      "op2-start",
      "op2-end",
      "op3-start",
      "op3-end",
      "op4-start",
      "op4-end",
    ]);
  });

  test("allows concurrent operations on different keys", async () => {
    const mutex = new MutexMap<string>();
    const events: string[] = [];
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const op1 = mutex.withLock("key1", async () => {
      events.push("key1-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 30));
      concurrentCount--;
      events.push("key1-end");
      return 1;
    });

    const op2 = mutex.withLock("key2", async () => {
      events.push("key2-start");
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 30));
      concurrentCount--;
      events.push("key2-end");
      return 2;
    });

    const results = await Promise.all([op1, op2]);

    expect(results).toEqual([1, 2]);
    expect(maxConcurrent).toBe(2); // Both should run concurrently
    // Both start before either ends
    expect(events.slice(0, 2).sort()).toEqual(["key1-start", "key2-start"]);
  });

  test("cleans up locks after operation completes", async () => {
    const mutex = new MutexMap<string>();
    const key = "test";

    await mutex.withLock(key, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "done";
    });

    // Lock should be cleaned up - verify by checking a second operation runs immediately
    const start = Date.now();
    await mutex.withLock(key, () => Promise.resolve("second"));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10); // Should not wait
  });

  test("cleans up locks after operation throws", async () => {
    const mutex = new MutexMap<string>();
    const key = "test";

    let caught = false;
    try {
      await mutex.withLock(key, () => Promise.reject(new Error("intentional")));
    } catch (e) {
      expect((e as Error).message).toBe("intentional");
      caught = true;
    }
    expect(caught).toBe(true);

    // Lock should still be cleaned up
    const start = Date.now();
    const result = await mutex.withLock(key, () => Promise.resolve("recovered"));
    const elapsed = Date.now() - start;

    expect(result).toBe("recovered");
    expect(elapsed).toBeLessThan(10);
  });

  test("preserves FIFO order for queued operations", async () => {
    const mutex = new MutexMap<string>();
    const key = "test";
    const order: number[] = [];

    // Start first operation
    const op1 = mutex.withLock(key, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });

    await new Promise((r) => setImmediate(r));

    // Queue up more operations in order
    const op2 = mutex.withLock(key, () => {
      order.push(2);
      return Promise.resolve();
    });
    const op3 = mutex.withLock(key, () => {
      order.push(3);
      return Promise.resolve();
    });
    const op4 = mutex.withLock(key, () => {
      order.push(4);
      return Promise.resolve();
    });

    await Promise.all([op1, op2, op3, op4]);

    expect(order).toEqual([1, 2, 3, 4]);
  });
});
