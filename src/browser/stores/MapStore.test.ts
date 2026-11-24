import { describe, test, expect, beforeEach } from "bun:test";
import { MapStore } from "./MapStore";

describe("MapStore", () => {
  let store: MapStore<string, number>;

  beforeEach(() => {
    store = new MapStore<string, number>();
  });

  describe("basic operations", () => {
    test("get computes value on first call", () => {
      let computeCount = 0;
      const value = store.get("key1", () => {
        computeCount++;
        return 42;
      });
      expect(value).toBe(42);
      expect(computeCount).toBe(1);
    });

    test("get returns cached value on second call", () => {
      let computeCount = 0;
      store.get("key1", () => {
        computeCount++;
        return 42;
      });
      const value = store.get("key1", () => {
        computeCount++;
        return 99;
      });
      expect(value).toBe(42); // Original cached value
      expect(computeCount).toBe(1); // Computed only once
    });

    test("has returns false for missing key", () => {
      expect(store.has("missing")).toBe(false);
    });

    test("has returns true after bump", () => {
      store.bump("key1");
      expect(store.has("key1")).toBe(true);
    });

    test("has returns false after only get (not bumped)", () => {
      store.get("key1", () => 42);
      expect(store.has("key1")).toBe(false); // Not bumped yet
    });

    test("delete removes key", () => {
      store.bump("key1");
      store.delete("key1");
      expect(store.has("key1")).toBe(false);
    });

    test("delete non-existent key is no-op", () => {
      store.delete("missing");
      expect(store.has("missing")).toBe(false);
    });

    test("clear removes all keys", () => {
      store.bump("key1");
      store.bump("key2");
      store.clear();
      expect(store.has("key1")).toBe(false);
      expect(store.has("key2")).toBe(false);
    });
  });

  describe("versioning and cache invalidation", () => {
    test("bump invalidates cache and recomputes on next get", () => {
      let computeCount = 0;
      store.get("key1", () => {
        computeCount++;
        return 42;
      });
      expect(computeCount).toBe(1);

      // Bump version - invalidates cache
      store.bump("key1");

      // Next get recomputes
      const value = store.get("key1", () => {
        computeCount++;
        return 99;
      });
      expect(value).toBe(99);
      expect(computeCount).toBe(2);
    });

    test("get without bump uses cached value", () => {
      let value = 1;
      store.get("key1", () => value);

      value = 2;
      const cached = store.get("key1", () => value);

      expect(cached).toBe(1); // Still cached
    });

    test("bump notifies subscribers", () => {
      let notified = false;
      store.subscribeAny(() => {
        notified = true;
      });

      store.bump("key1");
      expect(notified).toBe(true);
    });

    test("delete clears all cached values for key", () => {
      store.get("key1", () => 42);
      store.bump("key1");
      store.get("key1", () => 99);

      // After delete, key should not have versioned state
      store.delete("key1");
      expect(store.has("key1")).toBe(false);

      // Getting again should start from version 0
      const value = store.get("key1", () => 123);
      expect(value).toBe(123);
    });
  });

  describe("bounded snapshots", () => {
    test("keeps snapshot identity until only that key is bumped", () => {
      const snapshots = new MapStore<string, object>();
      let computeCount = 0;
      const compute = () => ({ revision: ++computeCount });
      const first = snapshots.get("first", compute);
      const second = snapshots.get("second", compute);

      expect(snapshots.get("first", compute)).toBe(first);
      snapshots.bump("first");
      expect(computeCount).toBe(2); // Invalidation stays lazy.
      expect(snapshots.get("second", compute)).toBe(second);
      const updated = snapshots.get("first", compute);
      expect(updated).not.toBe(first);
      expect(snapshots.get("first", compute)).toBe(updated);
      expect(computeCount).toBe(3);
    });

    test("releases old snapshots on bump and bounds retention across many updates", () => {
      const snapshots = new MapStore<string, object>();
      const idle = snapshots.get("idle", () => ({}));
      snapshots.get("streaming", () => ({}));

      // Inspect strong cache references directly: a GC/WeakRef assertion would be nondeterministic.
      const { cache } = snapshots as unknown as { cache: ReadonlyMap<unknown, unknown> };
      for (let revision = 0; revision < 1_000; revision++) {
        snapshots.bump("streaming");
        expect(cache.size).toBe(1);
        snapshots.get("streaming", () => ({ revision }));
        expect(cache.size).toBe(2);
      }
      expect(snapshots.get("idle", () => ({}))).toBe(idle);
      snapshots.delete("streaming");
      expect(cache.size).toBe(1);
      snapshots.clear();
      expect(cache.size).toBe(0);
    });

    test("invalidates before notifying global and per-key subscribers", () => {
      let value = 1;
      store.get("key1", () => value);
      const observed: number[] = [];
      store.subscribeAny(() => observed.push(store.get("key1", () => value)));
      store.subscribeKey("key1", () => observed.push(store.get("key1", () => value)));
      value = 2;
      store.bump("key1");
      expect(observed).toEqual([2, 2]);
    });

    test("caches undefined values until invalidation", () => {
      const snapshots = new MapStore<string, number | undefined>();
      expect(snapshots.get("key", () => undefined)).toBeUndefined();
      expect(snapshots.get("key", () => 42)).toBeUndefined();
      snapshots.bump("key");
      expect(snapshots.get("key", () => 42)).toBe(42);
    });

    test("delete clears read-only snapshots and notifies once, but missing keys are a no-op", () => {
      store.get("key1", () => 42);
      let globalCount = 0;
      let keyCount = 0;
      store.subscribeAny(() => globalCount++);
      store.subscribeKey("key1", () => keyCount++);
      expect(store.has("key1")).toBe(false);

      store.delete("key1");
      store.delete("key1");
      expect(globalCount).toBe(1);
      expect(keyCount).toBe(1);
      expect(store.has("key1")).toBe(false);
      expect(store.get("key1", () => 99)).toBe(99);
    });

    test("delete leaves keys sharing a string prefix untouched", () => {
      store.bump("key");
      store.get("key", () => 1);
      store.get("key:child", () => 2);
      store.delete("key");
      expect(store.get("key:child", () => 3)).toBe(2);
    });

    test("keys with the same string representation have independent snapshots", () => {
      const snapshots = new MapStore<object | string | number, object>();
      const keys = [{}, {}, "1", 1];
      const values = keys.map((key) => snapshots.get(key, () => ({})));
      expect(new Set(values).size).toBe(keys.length);
      snapshots.bump(keys[0]);
      snapshots.delete(keys[1]);
      for (const index of [2, 3]) {
        expect(snapshots.get(keys[index], () => ({}))).toBe(values[index]);
      }
    });

    test("clear invalidates bumped and read-only snapshots before notifying", () => {
      store.bump("bumped");
      store.get("bumped", () => 1);
      store.get("read-only", () => 2);
      const observed: number[] = [];
      store.subscribeAny(() => {
        expect(store.has("bumped")).toBe(false);
        observed.push(
          store.get("bumped", () => 3),
          store.get("read-only", () => 4)
        );
      });
      let keyCount = 0;
      store.subscribeKey("bumped", () => keyCount++);
      store.clear();
      expect(observed).toEqual([3, 4]);
      expect(keyCount).toBe(0); // clear retains its global-only notification contract.
    });
  });

  describe("subscribeAny", () => {
    test("notifies on bump", () => {
      let count = 0;
      store.subscribeAny(() => count++);

      store.bump("key1");
      expect(count).toBe(1);
    });

    test("notifies on delete", () => {
      store.bump("key1");

      let count = 0;
      store.subscribeAny(() => count++);

      store.delete("key1");
      expect(count).toBe(1);
    });

    test("notifies on clear", () => {
      store.bump("key1");

      let count = 0;
      store.subscribeAny(() => count++);

      store.clear();
      expect(count).toBe(1);
    });

    test("does not notify after unsubscribe", () => {
      let count = 0;
      const unsubscribe = store.subscribeAny(() => count++);

      store.bump("key1");
      expect(count).toBe(1);

      unsubscribe();
      store.bump("key2");
      expect(count).toBe(1); // Still 1
    });

    test("notifies multiple subscribers", () => {
      let count1 = 0;
      let count2 = 0;
      store.subscribeAny(() => count1++);
      store.subscribeAny(() => count2++);

      store.bump("key1");
      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });
  });

  describe("subscribeKey", () => {
    test("notifies only on matching key bump", () => {
      let count1 = 0;
      let count2 = 0;
      store.subscribeKey("key1", () => count1++);
      store.subscribeKey("key2", () => count2++);

      store.bump("key1");
      expect(count1).toBe(1);
      expect(count2).toBe(0); // Not notified

      store.bump("key2");
      expect(count1).toBe(1); // Not notified again
      expect(count2).toBe(1);
    });

    test("notifies on key delete", () => {
      store.bump("key1");

      let count = 0;
      store.subscribeKey("key1", () => count++);

      store.delete("key1");
      expect(count).toBe(1);
    });

    test("does not notify after unsubscribe", () => {
      let count = 0;
      const unsubscribe = store.subscribeKey("key1", () => count++);

      store.bump("key1");
      expect(count).toBe(1);

      unsubscribe();
      store.bump("key1");
      expect(count).toBe(1); // Still 1
    });

    test("notifies multiple subscribers for same key", () => {
      let count1 = 0;
      let count2 = 0;
      store.subscribeKey("key1", () => count1++);
      store.subscribeKey("key1", () => count2++);

      store.bump("key1");
      expect(count1).toBe(1);
      expect(count2).toBe(1);
    });

    test("cleans up per-key listener set when empty", () => {
      let count1 = 0;
      let count2 = 0;
      const unsubscribe1 = store.subscribeKey("key1", () => {
        count1++;
      });
      const unsubscribe2 = store.subscribeKey("key1", () => {
        count2++;
      });

      // Both listeners should work
      store.bump("key1");
      expect(count1).toBe(1);
      expect(count2).toBe(1);

      // After first unsubscribe, second still works
      unsubscribe1();
      store.bump("key1");
      expect(count1).toBe(1); // Not incremented
      expect(count2).toBe(2);

      // After second unsubscribe, none work
      unsubscribe2();
      store.bump("key1");
      expect(count1).toBe(1);
      expect(count2).toBe(2);
    });
  });

  describe("combined subscriptions", () => {
    test("both global and per-key subscribers notified", () => {
      let globalCount = 0;
      let keyCount = 0;

      store.subscribeAny(() => globalCount++);
      store.subscribeKey("key1", () => keyCount++);

      store.bump("key1");
      expect(globalCount).toBe(1);
      expect(keyCount).toBe(1);

      store.bump("key2");
      expect(globalCount).toBe(2);
      expect(keyCount).toBe(1); // Per-key not notified
    });
  });
});
