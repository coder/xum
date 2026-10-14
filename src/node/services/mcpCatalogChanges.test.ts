import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { coalesceCatalogChanges } from "./mcpCatalogChanges";

const fakeTimers = jest as typeof jest & { advanceTimersByTime: (ms: number) => void };
const INTERVAL = 5_000;

/** Let settled promises run their continuations (fake timers do not touch microtasks). */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("coalesceCatalogChanges", () => {
  let startedAt = 0;
  beforeEach(() => {
    startedAt = Date.now();
    fakeTimers.useFakeTimers();
    setSystemTime(new Date(startedAt));
  });
  afterEach(() => {
    const now = Date.now();
    fakeTimers.useRealTimers();
    setSystemTime(new Date(now));
  });

  test("a burst re-lists once now and once after the interval, then reports each", async () => {
    let relists = 0;
    let reports = 0;
    const changes = coalesceCatalogChanges({
      relist: () => {
        relists++;
        return Promise.resolve();
      },
      report: () => reports++,
      minIntervalMs: INTERVAL,
      maxRetries: 3,
    });
    // A server floods tools/list_changed: each re-list is a tools/list to that server.
    for (let i = 0; i < 10; i++) changes.notify();
    await settle();
    expect([relists, reports]).toEqual([1, 1]);
    fakeTimers.advanceTimersByTime(INTERVAL - 1);
    await settle();
    expect(relists).toBe(1);
    // The last change of the burst is not lost.
    fakeTimers.advanceTimersByTime(1);
    await settle();
    expect([relists, reports]).toEqual([2, 2]);
    fakeTimers.advanceTimersByTime(INTERVAL * 3);
    await settle();
    expect([relists, reports]).toEqual([2, 2]);
  });

  test("a failed re-list is retried after the interval and reported only once it lists", async () => {
    let relists = 0;
    let reports = 0;
    const changes = coalesceCatalogChanges({
      relist: () => (++relists === 1 ? Promise.reject(new Error("busy")) : Promise.resolve()),
      report: () => reports++,
      minIntervalMs: INTERVAL,
      maxRetries: 3,
    });
    changes.notify();
    await settle();
    expect([relists, reports]).toEqual([1, 0]);
    fakeTimers.advanceTimersByTime(INTERVAL);
    await settle();
    expect([relists, reports]).toEqual([2, 1]);
  });

  test("a server that keeps failing is retried a bounded number of times", async () => {
    let relists = 0;
    const changes = coalesceCatalogChanges({
      relist: () => {
        relists++;
        return Promise.reject(new Error("down"));
      },
      report: () => undefined,
      minIntervalMs: INTERVAL,
      maxRetries: 2,
    });
    changes.notify();
    for (let i = 0; i < 6; i++) {
      await settle();
      fakeTimers.advanceTimersByTime(INTERVAL);
    }
    await settle();
    expect(relists).toBe(3);
  });

  test("dispose cancels a scheduled re-list", async () => {
    let relists = 0;
    const changes = coalesceCatalogChanges({
      relist: () => {
        relists++;
        return Promise.resolve();
      },
      report: () => undefined,
      minIntervalMs: INTERVAL,
      maxRetries: 3,
    });
    changes.notify();
    await settle();
    changes.notify();
    changes.dispose();
    fakeTimers.advanceTimersByTime(INTERVAL);
    await settle();
    expect(relists).toBe(1);
  });
});
