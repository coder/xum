import { describe, expect, test } from "bun:test";
import { McpIconRefCache } from "./iconRefCache";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const ref = (n: number) => n.toString(16).padStart(32, "0");
type Icons = Record<string, string | null>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake API client that records every bulk lookup so tests can assert batching and coalescing. */
function client(answer: (refs: readonly string[]) => Promise<Icons>) {
  const calls: string[][] = [];
  return {
    calls,
    mcp: {
      icons: (input: { iconRefs: string[] }) => {
        calls.push([...input.iconRefs]);
        return answer(input.iconRefs);
      },
    },
  };
}
const icons = (refs: readonly string[], value: string | null = PNG): Icons =>
  Object.fromEntries(refs.map((r) => [r, value]));

describe("McpIconRefCache", () => {
  test("distinct misses in one tick become one bulk lookup; duplicates coalesce; results cache", async () => {
    const cache = new McpIconRefCache(200);
    const pending = deferred<Icons>();
    const api = client(() => pending.promise);
    const { calls } = api;
    const results = [ref(1), ref(2), ref(1), ref(3), ref(2)].map((r) => cache.resolve(r, api));
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual([[ref(1), ref(2), ref(3)]]);
    expect(cache.peek(ref(1))).toBeUndefined();
    pending.resolve({ [ref(1)]: PNG, [ref(2)]: null, [ref(3)]: PNG });
    expect(await Promise.all(results)).toEqual([PNG, null, PNG, PNG, null]);
    expect(cache.peek(ref(1))).toBe(PNG);
    expect(cache.peek(ref(2))).toBeNull();
    // Resolved refs (including null) never go back to the host.
    expect(await cache.resolve(ref(2), api)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("a rejected bulk lookup caches nothing and the next mount retries", async () => {
    const cache = new McpIconRefCache(200);
    const failing = client(() => Promise.reject(new Error("ipc down")));
    let rejection: unknown;
    try {
      await cache.resolve(ref(1), failing);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(cache.peek(ref(1))).toBeUndefined();
    const ok = client((refs) => Promise.resolve(icons(refs)));
    expect(await cache.resolve(ref(1), ok)).toBe(PNG);
    expect(ok.calls).toEqual([[ref(1)]]);
  });

  test("evicts the least recently used entry beyond the capacity", async () => {
    const cache = new McpIconRefCache(2);
    const ok = client((refs) => Promise.resolve(icons(refs)));
    await cache.resolve(ref(1), ok);
    await cache.resolve(ref(2), ok);
    // Touch ref 1 so ref 2 becomes the oldest.
    expect(await cache.resolve(ref(1), ok)).toBe(PNG);
    await cache.resolve(ref(3), ok);
    expect(cache.peek(ref(2))).toBeUndefined();
    expect(cache.peek(ref(1))).toBe(PNG);
    expect(cache.peek(ref(3))).toBe(PNG);
  });

  test("bounds entries and batch sizes including pending lookups; evicted refs restart later", async () => {
    const cache = new McpIconRefCache(2);
    const batches: Array<ReturnType<typeof deferred<Icons>>> = [];
    const api = client(() => {
      const batch = deferred<Icons>();
      batches.push(batch);
      return batch.promise;
    });
    const { calls } = api;
    const p1 = cache.resolve(ref(1), api);
    const p2 = cache.resolve(ref(2), api);
    const p3 = cache.resolve(ref(3), api);
    await Promise.resolve();
    // Never more refs per IPC call than the capacity; never more entries either.
    expect(calls).toEqual([[ref(1), ref(2)], [ref(3)]]);
    expect(cache.size).toBe(2);
    expect(cache.peek(ref(1))).toBeUndefined();

    // The evicted ref is looked up again instead of joining the evicted request.
    const p1b = cache.resolve(ref(1), api);
    await Promise.resolve();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual([ref(1)]);
    expect(cache.size).toBe(2);

    // The evicted request still answers its callers but cannot cache or evict.
    batches[0].resolve({ [ref(1)]: "data:image/png;base64,old=", [ref(2)]: null });
    expect(await p1).toBe("data:image/png;base64,old=");
    expect(await p2).toBeNull();
    expect(cache.peek(ref(1))).toBeUndefined();
    batches[2].resolve(icons([ref(1)]));
    expect(await p1b).toBe(PNG);
    expect(cache.peek(ref(1))).toBe(PNG);
    batches[1].resolve(icons([ref(3)]));
    expect(await p3).toBe(PNG);
    expect(cache.size).toBe(2);
  });

  test("a replacement client owns pending refs; the old client's late outcome cannot touch them", async () => {
    const cache = new McpIconRefCache(200);
    const oldBatch = deferred<Icons>();
    const old = client(() => oldBatch.promise);
    const stale = cache.resolve(ref(1), old);
    const staleToo = cache.resolve(ref(2), old);
    await Promise.resolve();
    expect(old.calls).toEqual([[ref(1), ref(2)]]);

    // Reconnect: the same refs are requested through the new client.
    const newBatch = deferred<Icons>();
    const fresh = client(() => newBatch.promise);
    const current = cache.resolve(ref(1), fresh);
    const currentToo = cache.resolve(ref(2), fresh);
    await Promise.resolve();
    expect(fresh.calls).toEqual([[ref(1), ref(2)]]);
    expect(cache.size).toBe(2);

    // Old rejection: nothing deleted, the new lookup still succeeds.
    oldBatch.reject(new Error("socket closed"));
    await stale.catch(() => undefined);
    await staleToo.catch(() => undefined);
    expect(cache.size).toBe(2);
    newBatch.resolve({ [ref(1)]: PNG, [ref(2)]: null });
    expect(await current).toBe(PNG);
    expect(await currentToo).toBeNull();
    expect(cache.peek(ref(1))).toBe(PNG);
    expect(cache.peek(ref(2))).toBeNull();

    // Old success arriving late cannot overwrite the new generation either.
    const other = deferred<Icons>();
    const lateOld = cache.resolve(
      ref(3),
      client(() => other.promise)
    );
    const replaced = cache.resolve(
      ref(3),
      client(() => Promise.resolve(icons([ref(3)], null)))
    );
    await Promise.resolve();
    expect(await replaced).toBeNull();
    other.resolve(icons([ref(3)]));
    expect(await lateOld).toBe(PNG);
    expect(cache.peek(ref(3))).toBeNull();
    // Immutable answers survive client changes without another lookup.
    const untouched = client(() => Promise.reject(new Error("unused")));
    expect(await cache.resolve(ref(1), untouched)).toBe(PNG);
    expect(untouched.calls).toEqual([]);
  });

  test("more misses than the capacity in one tick stay bounded in entries and per-call batches", async () => {
    const cache = new McpIconRefCache(3);
    const api = client((refs) => Promise.resolve(icons(refs)));
    const refs = Array.from({ length: 8 }, (_, i) => ref(i + 1));
    const results = refs.map((r) => cache.resolve(r, api));
    expect(cache.size).toBe(3);
    await Promise.resolve();
    expect(api.calls.map((call) => call.length)).toEqual([3, 3, 2]);
    expect(api.calls.flat()).toEqual(refs);
    // Every caller is answered; only the surviving entries are memoized.
    expect(await Promise.all(results)).toEqual(refs.map(() => PNG));
    expect(cache.size).toBe(3);
    expect(refs.slice(0, 5).map((r) => cache.peek(r))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(refs.slice(5).map((r) => cache.peek(r))).toEqual([PNG, PNG, PNG]);
  });

  test("rejects a non-positive capacity", () => {
    expect(() => new McpIconRefCache(0)).toThrow();
  });
});
