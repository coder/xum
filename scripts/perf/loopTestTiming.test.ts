/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import {
  type Interval,
  isTempDirCall,
  isTimedFsName,
  timed,
  timedDelay,
  timedInterval,
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

  test("a rejection the caller leaves unhandled stays unhandled", () => {
    // In its own process: bun test fails any test that leaves a rejection unhandled.
    const script = `import { timed } from ${JSON.stringify(`${import.meta.dir}/loopTestTiming.ts`)};
      void timed(() => Promise.reject(new Error("left unhandled")), () => undefined, () => 0)();`;
    const result = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("left unhandled");
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

  test("keeps own properties, symbols included, and times the callable ones", () => {
    const seen: Interval[] = [];
    const fn = Object.assign(() => 1, { native: () => 2, [promisify.custom]: () => "custom" });
    const wrapped = timed(fn, (i) => seen.push(i), clock(1, 2, 3, 4));
    expect(wrapped.native()).toBe(2);
    expect((promisify(wrapped) as () => string)()).toBe("custom");
    expect(seen).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("timedTimeout", () => {
  test("records a timer of 1 ms or more from the call to the fire, with its arguments", () => {
    const seen: Interval[] = [];
    const fired: unknown[][] = [];
    const queued: (() => void)[] = [];
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

  test("times util.promisify.custom like a delay", async () => {
    const seen: Interval[] = [];
    const custom = (_ms: number, value?: unknown) => Promise.resolve(value);
    const fake = Object.assign(() => 0, { [promisify.custom]: custom });
    const sleep = promisify(timedTimeout(fake, (i) => seen.push(i), clock(5, 9)));
    expect(await sleep(0, "yield")).toBe("yield");
    expect(await sleep(4, "wait")).toBe("wait");
    expect(seen).toEqual([[5, 9]]);
  });
});

test("timedDelay records delays of 1 ms or more and Dates, not event loop yields", async () => {
  const seen: Interval[] = [];
  const sleep = timedDelay(
    (_ms: number | Date) => Promise.resolve(),
    (i) => seen.push(i),
    clock(1, 2, 3, 4)
  );
  await sleep(0);
  await sleep(10);
  await sleep(new Date());
  expect(seen).toEqual([
    [1, 2],
    [3, 4],
  ]);
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
  expect(isTempDirCall("mkdir", "/tmp", tmp)).toBe(true);
  expect(isTempDirCall("mkdir", "/home/x", tmp)).toBe(false);
  expect(isTempDirCall("mkdir", "/tmp-backup/a", tmp)).toBe(false);
  expect(isTempDirCall("writeFile", "/tmp/a", tmp)).toBe(false);
});

test("timedDelay resolves with a function value, as setTimeout(ms, value) does", async () => {
  const seen: Interval[] = [];
  const delay = (_ms: number, value?: unknown) => Promise.resolve(value);
  const value = () => "the value";
  expect(await timedDelay(delay, (i) => seen.push(i), clock(3, 8))(5, value)).toBe(value);
  expect(seen).toEqual([[3, 8]]);
});

describe("timedInterval", () => {
  test("each fire of an interval of 1 ms or more records since the call or the fire before", () => {
    const seen: Interval[] = [];
    const fired: unknown[][] = [];
    const handlers: ((...args: unknown[]) => void)[] = [];
    const fakeSetInterval = (handler: (...args: unknown[]) => void, _ms?: number) =>
      handlers.push(handler);
    const wrapped = timedInterval(fakeSetInterval, (i) => seen.push(i), clock(0, 10, 25));
    wrapped((...args: unknown[]) => fired.push(args), 10);
    wrapped(() => fired.push(["yield"]), 0);
    handlers[0]("a");
    handlers[0]("b");
    handlers[1]();
    expect(fired).toEqual([["a"], ["b"], ["yield"]]);
    expect(seen).toEqual([
      [0, 10],
      [10, 25],
    ]);
  });
});
