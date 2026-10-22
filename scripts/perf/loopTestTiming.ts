/**
 * Pure timing wrappers for scripts/perf/loopTests.preload.ts (agent loop refactor, phase 1).
 *
 * The preload replaces the fs functions, setTimeout and Bun.sleep of one `bun test` process with
 * these wrappers, so the loop test baseline can report how much of a test file's time an fs call or
 * a real timer was open. The numbers are an upper bound on what an Effect service can save: they
 * are tripwire data, never a target. This module installs nothing, so its tests can run in the
 * shared `bun test ./scripts/` process without patching that process.
 */
import assert from "node:assert/strict";

/** [start, end] in milliseconds of one open fs call or timer. */
export type Interval = readonly [number, number];

export type RecordInterval = (interval: Interval) => void;

type AnyFunction = (...args: never[]) => unknown;

/** Total time covered by at least one interval: overlapping calls count once. */
export function unionMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let start = Number.NaN;
  let end = Number.NaN;
  for (const [s, e] of sorted) {
    assert(e >= s, `interval ends before it starts: [${s}, ${e}]`);
    if (Number.isNaN(end) || s > end) {
      if (!Number.isNaN(end)) total += end - start;
      start = s;
      end = e;
    } else if (e > end) {
      end = e;
    }
  }
  if (!Number.isNaN(end)) total += end - start;
  return total;
}

// A function's own length, name and prototype describe the wrapper itself.
const FUNCTION_KEYS = new Set<PropertyKey>(["length", "name", "prototype", "arguments", "caller"]);

/**
 * Copies the own properties of `from` to `to`, symbols included, so a wrapper keeps the
 * extras callers use: `util.promisify(setTimeout)` reads `setTimeout[util.promisify.custom]`,
 * and `fs.realpath.native` is a property of `fs.realpath`.
 */
export function copyOwnProperties(from: AnyFunction, to: AnyFunction): void {
  for (const key of Reflect.ownKeys(from)) {
    if (FUNCTION_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(from, key);
    assert(descriptor, `missing own property ${String(key)}`);
    Object.defineProperty(to, key, descriptor);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps one fs function. A sync call records until it returns, a promise until it settles, and a
 * callback-style call (last argument is a function) until its callback runs.
 */
export function timed<F extends AnyFunction>(fn: F, record: RecordInterval, now: () => number): F {
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const start = now();
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === "function") {
      args[last] = function (this: unknown, ...results: unknown[]): unknown {
        record([start, now()]);
        return (callback as (...a: unknown[]) => unknown).apply(this, results);
      };
      return (fn as unknown as (...a: unknown[]) => unknown).apply(this, args);
    }
    let result: unknown;
    try {
      result = (fn as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } catch (error) {
      record([start, now()]);
      throw error;
    }
    if (isThenable(result)) {
      const settle = () => record([start, now()]);
      result.then(settle, settle);
    } else {
      record([start, now()]);
    }
    return result;
  };
  copyOwnProperties(fn, wrapper as AnyFunction);
  return wrapper as unknown as F;
}

/**
 * Wraps setTimeout. A timer with a delay of at least 1 ms that fires records from the call to
 * the fire. Cleared timers and 0 ms timers (event loop yields) record nothing.
 */
export function timedTimeout<F extends AnyFunction>(
  setTimeoutFn: F,
  record: RecordInterval,
  now: () => number
): F {
  const wrapper = function (this: unknown, handler: unknown, delay?: unknown, ...rest: unknown[]) {
    const call = setTimeoutFn as unknown as (...a: unknown[]) => unknown;
    if (typeof handler !== "function" || !(Number(delay) >= 1)) {
      return call.call(this, handler, delay, ...rest);
    }
    const start = now();
    const fire = function (this: unknown, ...args: unknown[]): unknown {
      record([start, now()]);
      return (handler as (...a: unknown[]) => unknown).apply(this, args);
    };
    return call.call(this, fire, delay, ...rest);
  };
  copyOwnProperties(setTimeoutFn, wrapper as AnyFunction);
  return wrapper as unknown as F;
}

/**
 * The fs exports to time: functions with a lowercase name. Classes (Dirent, Stats), stream
 * factories and watchers are left alone: a stream or a watcher stays open for its whole life.
 */
export function isTimedFsName(name: string, value: unknown): boolean {
  return (
    typeof value === "function" &&
    /^[a-z]/.test(name) &&
    !name.startsWith("create") &&
    !/^(un)?watch/.test(name)
  );
}

/** True for a mkdir or mkdtemp call whose path is under the OS temp dir. */
export function isTempDirCall(name: string, firstArg: unknown, tmpDir: string): boolean {
  if (!/^mk(dir|dtemp)/.test(name)) return false;
  const target = firstArg instanceof URL ? firstArg.pathname : firstArg;
  return typeof target === "string" && target.startsWith(tmpDir);
}
