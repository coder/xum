import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import {
  type Interval,
  isTempDirCall,
  isTimedFsName,
  timed,
  timedTimeout,
  unionMs,
} from "./loopTestTiming";

/** A clock that returns the given times in order. */
function clock(...times: number[]): () => number {
  return () => {
    const next = times.shift();
    if (next === undefined) throw new Error("clock ran out of times");
    return next;
  };
}

describe("unionMs", () => {
  test("counts overlapping and nested intervals once", () => {
    expect(
      unionMs([
        [10, 20],
        [0, 5],
        [15, 30],
        [16, 18],
        [40, 41],
      ])
    ).toBe(5 + 20 + 1);
  });

  test("is 0 without intervals", () => {
    expect(unionMs([])).toBe(0);
  });
});

describe("timed", () => {
  test("a sync call records until it returns, also when it throws", () => {
    const seen: Interval[] = [];
    const ok = timed(
      (x: number) => x * 2,
      (i) => seen.push(i),
      clock(1, 4)
    );
    expect(ok(21)).toBe(42);
    const bad = timed(
      () => {
        throw new Error("boom");
      },
      (i) => seen.push(i),
      clock(5, 9)
    );
    expect(() => bad()).toThrow("boom");
    expect(seen).toEqual([
      [1, 4],
      [5, 9],
    ]);
  });

  test("a promise records when it settles, resolved or rejected", async () => {
    const seen: Interval[] = [];
    const record = (i: Interval) => seen.push(i);
    const resolved = timed(() => Promise.resolve("ok"), record, clock(1, 7));
    const rejected = timed(() => Promise.reject(new Error("no")), record, clock(10, 12));
    expect(await resolved()).toBe("ok");
    await expect(rejected()).rejects.toThrow("no");
    expect(seen).toEqual([
      [1, 7],
      [10, 12],
    ]);
  });

  test("a callback-style call records when its callback runs", () => {
    const seen: Interval[] = [];
    let later: (() => void) | undefined;
    const readLater = (_path: string, cb: (err: null, data: string) => void) => {
      later = () => cb(null, "data");
    };
    const wrapped = timed(readLater, (i) => seen.push(i), clock(3, 8));
    let got = "";
    wrapped("a.txt", (_err, data) => {
      got = data;
    });
    expect(seen).toEqual([]);
    later?.();
    expect(got).toBe("data");
    expect(seen).toEqual([[3, 8]]);
  });

  test("keeps own properties, symbols included", () => {
    const custom = () => "custom";
    const fn = Object.assign(() => 1, { native: () => 2, [promisify.custom]: custom });
    const wrapped = timed(fn, () => undefined, clock(0, 0));
    expect(wrapped.native()).toBe(2);
    expect(promisify(wrapped)).toBe(custom);
  });
});

describe("timedTimeout", () => {
  test("records a timer of 1 ms or more from the call to the fire, with its arguments", () => {
    const seen: Interval[] = [];
    const fired: unknown[][] = [];
    const queued: Array<() => void> = [];
    const fakeSetTimeout = (
      handler: (...args: unknown[]) => void,
      _ms?: number,
      ...args: unknown[]
    ) => queued.push(() => handler(...args));
    const wrapped = timedTimeout(fakeSetTimeout, (i) => seen.push(i), clock(2, 50));
    wrapped((...args: unknown[]) => fired.push(args), 25, "a", 1);
    wrapped(() => fired.push(["yield"]), 0);
    for (const run of queued) run();
    expect(fired).toEqual([["a", 1], ["yield"]]);
    expect(seen).toEqual([[2, 50]]);
  });

  test("keeps util.promisify.custom", () => {
    const custom = () => Promise.resolve();
    const fake = Object.assign(() => 0, { [promisify.custom]: custom });
    expect(promisify(timedTimeout(fake, () => undefined, clock()))).toBe(custom);
  });
});

test("isTimedFsName times functions, not classes, streams or watchers", () => {
  const fn = () => undefined;
  expect(["readFile", "readFileSync", "mkdtemp", "open"].map((n) => isTimedFsName(n, fn))).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(
    ["Dirent", "createReadStream", "watch", "watchFile", "unwatchFile"].map((n) =>
      isTimedFsName(n, fn)
    )
  ).toEqual([false, false, false, false, false]);
  expect(isTimedFsName("constants", {})).toBe(false);
});

test("isTempDirCall flags mkdir and mkdtemp under the temp dir only", () => {
  const tmp = "/tmp";
  expect(isTempDirCall("mkdtempSync", "/tmp/xum-", tmp)).toBe(true);
  expect(isTempDirCall("mkdir", new URL("file:///tmp/a"), tmp)).toBe(true);
  expect(isTempDirCall("mkdir", "/home/x", tmp)).toBe(false);
  expect(isTempDirCall("writeFile", "/tmp/a", tmp)).toBe(false);
});
