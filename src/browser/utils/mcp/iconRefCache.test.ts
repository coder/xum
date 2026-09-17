import { describe, expect, test } from "bun:test";
import { McpIconRefCache } from "./iconRefCache";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const ref = (n: number) => n.toString(16).padStart(32, "0");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("McpIconRefCache", () => {
  test("coalesces concurrent lookups into one request and caches the result", async () => {
    const cache = new McpIconRefCache(200);
    const pending = deferred<string | null>();
    let calls = 0;
    const fetch = () => {
      calls += 1;
      return pending.promise;
    };
    const first = cache.resolve(ref(1), fetch);
    const second = cache.resolve(ref(1), fetch);
    expect(calls).toBe(1);
    expect(cache.peek(ref(1))).toBeUndefined();
    pending.resolve(PNG);
    expect(await first).toBe(PNG);
    expect(await second).toBe(PNG);
    expect(cache.peek(ref(1))).toBe(PNG);
    expect(await cache.resolve(ref(1), fetch)).toBe(PNG);
    expect(calls).toBe(1);
  });

  test("caches a resolved null (unknown ref) but never a rejected request", async () => {
    const cache = new McpIconRefCache(200);
    let calls = 0;
    expect(await cache.resolve(ref(2), () => (calls++, Promise.resolve(null)))).toBeNull();
    expect(cache.peek(ref(2))).toBeNull();
    expect(await cache.resolve(ref(2), () => (calls++, Promise.resolve(PNG)))).toBeNull();
    expect(calls).toBe(1);

    let rejection: unknown;
    try {
      await cache.resolve(ref(3), () => (calls++, Promise.reject(new Error("ipc down"))));
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect(cache.peek(ref(3))).toBeUndefined();
    // A later mount retries and the fresh answer is stored.
    expect(await cache.resolve(ref(3), () => (calls++, Promise.resolve(PNG)))).toBe(PNG);
    expect(calls).toBe(3);
  });

  test("evicts the least recently used entry beyond the capacity", async () => {
    const cache = new McpIconRefCache(2);
    await cache.resolve(ref(1), () => Promise.resolve(PNG));
    await cache.resolve(ref(2), () => Promise.resolve(null));
    // Touch ref 1 so ref 2 becomes the oldest.
    expect(await cache.resolve(ref(1), () => Promise.reject(new Error("unused")))).toBe(PNG);
    await cache.resolve(ref(3), () => Promise.resolve(PNG));
    expect(cache.peek(ref(2))).toBeUndefined();
    expect(cache.peek(ref(1))).toBe(PNG);
    expect(cache.peek(ref(3))).toBe(PNG);
  });

  test("bounds entries including pending lookups; evicted refs restart and stale completions are ignored", async () => {
    const cache = new McpIconRefCache(2);
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const third = deferred<string | null>();
    const p1 = cache.resolve(ref(1), () => first.promise);
    const p2 = cache.resolve(ref(2), () => second.promise);
    const p3 = cache.resolve(ref(3), () => third.promise);
    expect(cache.size).toBe(2);
    expect(cache.peek(ref(1))).toBeUndefined();

    // The evicted ref is looked up again instead of joining the evicted request.
    let calls = 0;
    const firstAgain = deferred<string | null>();
    const p1b = cache.resolve(ref(1), () => (calls++, firstAgain.promise));
    expect(calls).toBe(1);
    expect(cache.size).toBe(2);

    // The evicted request's completion neither caches nor disturbs the replacement.
    first.resolve("data:image/png;base64,old=");
    expect(await p1).toBe("data:image/png;base64,old=");
    expect(cache.peek(ref(1))).toBeUndefined();
    firstAgain.resolve(PNG);
    expect(await p1b).toBe(PNG);
    expect(cache.peek(ref(1))).toBe(PNG);

    // An evicted request's rejection must not delete a newer resolved entry.
    expect(await cache.resolve(ref(2), () => Promise.resolve(null))).toBeNull();
    second.reject(new Error("late failure"));
    await p2.catch(() => undefined);
    expect(cache.peek(ref(2))).toBeNull();

    // An evicted request's late success does not reinsert itself.
    third.resolve(PNG);
    expect(await p3).toBe(PNG);
    expect(cache.peek(ref(3))).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  test("rejects a non-positive capacity", () => {
    expect(() => new McpIconRefCache(0)).toThrow();
  });
});
