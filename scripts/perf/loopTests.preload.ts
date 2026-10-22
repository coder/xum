/**
 * Measures one `bun test` process for the loop test baseline (agent loop refactor, phase 1).
 *
 * Usage: LOOP_TESTS_OUT=<file.json> bun test --preload ./scripts/perf/loopTests.preload.ts <test>
 *
 * It replaces the fs and fs/promises functions, the FileHandle methods, setTimeout and Bun.sleep
 * with the timing wrappers of loopTestTiming.ts. In Bun 1.4.3 a new value on require("fs/promises") also reaches
 * `import { readFile } from "fs/promises"` in test and product code, so no product file changes.
 * After all tests it writes { fsMs, timerMs, usesTempDir } to $LOOP_TESTS_OUT. The runner times the
 * whole process itself, so a crash at import still counts.
 *
 * No test imports this file: it patches the process that loads it.
 */
import assert from "node:assert/strict";
import { afterAll } from "bun:test";
import { createRequire } from "node:module";
import {
  copyOwnProperties,
  type Interval,
  isTempDirCall,
  isTimedFsName,
  timed,
  timedDelay,
  timedTimeout,
  unionMs,
} from "./loopTestTiming";

const outPath = process.env.LOOP_TESTS_OUT;
assert(outPath, "loopTests.preload.ts needs LOOP_TESTS_OUT");

// Mutate the CommonJS export objects: Bun's ESM views of node builtins read through to them.
const require = createRequire(import.meta.url);
const fsModule = require("fs") as Record<string, unknown>;
const fsPromises = require("fs/promises") as Record<string, unknown>;
const tmpDir = (require("os") as { tmpdir(): string }).tmpdir();
const writeFileSync = fsModule.writeFileSync as (file: string, data: string) => void;

// Bind the clock now: tests spy on performance.now (session_history.budget.test.ts counts its
// reads), and the wrappers must not read through such a spy.
const perfNow = performance.now.bind(performance);
const now = () => perfNow();
const fsIntervals: Interval[] = [];
const timerIntervals: Interval[] = [];
const recordFs = (interval: Interval) => fsIntervals.push(interval);
const recordTimer = (interval: Interval) => timerIntervals.push(interval);
let usesTempDir = false;

type Fn = (...args: unknown[]) => unknown;

/** mkdir and mkdtemp also note a path under the OS temp dir. */
function flagTempDir(name: string, fn: Fn): Fn {
  if (!/^mk(dir|dtemp)/.test(name)) return fn;
  const flagged = function (this: unknown, ...args: unknown[]): unknown {
    if (isTempDirCall(name, args[0], tmpDir)) usesTempDir = true;
    return fn.apply(this, args);
  };
  copyOwnProperties(fn, flagged);
  return flagged;
}

// FileHandle methods: history code reads and writes through handles that open() returns.
const FILE_HANDLE_METHODS = [
  "appendFile",
  "chmod",
  "chown",
  "close",
  "datasync",
  "read",
  "readFile",
  "readv",
  "stat",
  "sync",
  "truncate",
  "utimes",
  "write",
  "writeFile",
  "writev",
];
const open = fsPromises.open as (file: string, flags: string) => Promise<object>;
const handle = await open(import.meta.path, "r");
const fileHandle = Object.getPrototypeOf(handle) as Record<string, unknown>;
await (handle as { close(): Promise<void> }).close();
for (const name of FILE_HANDLE_METHODS) {
  const method = fileHandle[name];
  assert(typeof method === "function", `FileHandle.${name} is not a function`);
  fileHandle[name] = timed(method as Fn, recordFs, now);
}

for (const mod of [fsModule, fsPromises]) {
  for (const [name, value] of Object.entries(mod)) {
    if (!isTimedFsName(name, value)) continue;
    mod[name] = timed(flagTempDir(name, value as Fn), recordFs, now);
  }
}
globalThis.setTimeout = timedTimeout(globalThis.setTimeout, recordTimer, now);
Bun.sleep = timedDelay(Bun.sleep, recordTimer, now);

afterAll(() => {
  const result = {
    fsMs: unionMs(fsIntervals),
    timerMs: unionMs(timerIntervals),
    usesTempDir,
  };
  writeFileSync(outPath, JSON.stringify(result));
});
