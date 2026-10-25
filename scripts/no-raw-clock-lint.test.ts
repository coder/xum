// Cases for `local/no-raw-clock` and `local/no-global-clock-patch` (eslint-local-rules.mjs), the
// clock ratchet of the agent loop refactor (phase 3): agent-loop files read time and arm timers
// through the HostClock service, so tests drive loop time with the TestClock. The allow map holds
// exact per-file counts of today's raw reads, so it can only go down.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Linter, type Rule } from "eslint";
import tseslint from "typescript-eslint";
import config from "../eslint.config.mjs";

function findRule(name: string): Rule.RuleModule {
  for (const entry of config) {
    const plugin = entry.plugins?.local as { rules?: Record<string, Rule.RuleModule> } | undefined;
    const rule = plugin?.rules?.[name];
    if (rule) {
      return rule;
    }
  }
  throw new Error(`local/${name} is not registered in eslint.config.mjs`);
}

const linter = new Linter({ configType: "flat" });

function ids(rule: string, code: string, options?: unknown): string[] {
  const lintConfig = [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
      plugins: { local: { rules: { [rule]: findRule(rule) } } },
      rules: {
        [`local/${rule}`]: (options === undefined ? ["error"] : ["error", options]) as [
          "error",
          ...unknown[],
        ],
      },
    },
  ];
  return linter
    .verify(code, lintConfig, "src/node/services/tools/x.ts")
    .map((message) => message.messageId ?? message.message);
}

const rawClock = (code: string, allow: Record<string, number> = {}) =>
  ids("no-raw-clock", code, { allow });

test("reports raw clock reads and global timers", () => {
  expect(rawClock(`const t = Date.now();`)).toEqual(["raw"]);
  expect(rawClock(`const d = new Date();`)).toEqual(["raw"]);
  expect(rawClock(`setTimeout(() => undefined, 10);`)).toEqual(["raw"]);
  expect(rawClock(`const id = setInterval(tick, 10);`)).toEqual(["raw"]);
  expect(rawClock(`globalThis.setTimeout(() => undefined, 10);`)).toEqual(["raw"]);
  expect(rawClock(`globalThis.setInterval(tick, 10);`)).toEqual(["raw"]);
  expect(rawClock(`const t = globalThis.Date.now();`)).toEqual(["raw"]);
  expect(rawClock(`const d = new globalThis.Date();`)).toEqual(["raw"]);
});

// #7282: forms the first version of the rule missed, one test per gap.
test("reports a Date() call", () => {
  expect(rawClock(`const s = Date();`)).toEqual(["raw"]);
  expect(rawClock(`const s = globalThis.Date();`)).toEqual(["raw"]);
});

test("reports AbortSignal.timeout()", () => {
  expect(rawClock(`const signal = AbortSignal.timeout(10);`)).toEqual(["raw"]);
  expect(rawClock(`const signal = globalThis.AbortSignal.timeout(10);`)).toEqual(["raw"]);
});

test("reports timers imported from the timers modules under another name", () => {
  expect(
    rawClock(`import { setTimeout as delay } from "node:timers/promises";\nawait delay(10);`)
  ).toEqual(["raw"]);
  expect(rawClock(`import { setInterval as every } from "timers";\nevery(tick, 10);`)).toEqual([
    "raw",
  ]);
  expect(rawClock(`import * as timers from "node:timers";\ntimers.setTimeout(fire, 10);`)).toEqual([
    "raw",
  ]);
  // A call above the import still counts, and an unaliased import counts once.
  expect(
    rawClock(`await delay(10);\nimport { setTimeout as delay } from "timers/promises";`)
  ).toEqual(["raw"]);
  expect(rawClock(`import { setTimeout } from "timers/promises";\nawait setTimeout(10);`)).toEqual([
    "raw",
  ]);
});

test("passes non-timer imports from the timers modules and other abort signals", () => {
  expect(
    rawClock(`import { setImmediate as yieldNow } from "node:timers/promises";\nawait yieldNow();`)
  ).toEqual([]);
  expect(rawClock(`import { setTimeout as delay } from "./delay";\nawait delay(10);`)).toEqual([]);
  expect(rawClock(`const signal = AbortSignal.any([a, b]);`)).toEqual([]);
  expect(rawClock(`const signal = clock.timeout(10);`)).toEqual([]);
});

test("passes HostClock reads, monotonic durations and date parsing", () => {
  expect(rawClock(`const t = clock.nowMs();`)).toEqual([]);
  expect(rawClock(`const cancel = clock.setTimer(fire, 10);`)).toEqual([]);
  expect(rawClock(`const started = performance.now();`)).toEqual([]);
  expect(rawClock(`const d = new Date(clock.nowMs());`)).toEqual([]);
  expect(rawClock(`const ms = Date.parse(header);`)).toEqual([]);
  expect(rawClock(`clearTimeout(timer);`)).toEqual([]);
});

test("an allow entry is an exact count", () => {
  const file = "src/node/services/tools/x.ts";
  const code = `const a = Date.now();\nconst b = Date.now();`;
  expect(rawClock(code, { [file]: 2 })).toEqual([]);
  expect(rawClock(code, { [file]: 1 })).toEqual(["raw"]);
  expect(rawClock(code, { [file]: 3 })).toEqual(["lowerAllow"]);
  expect(rawClock(`export {};`, { [file]: 1 })).toEqual(["lowerAllow"]);
});

test("reports global time patches in tests that moved to the TestClock", () => {
  const patch = (code: string) => ids("no-global-clock-patch", code);
  expect(patch(`jest.useFakeTimers();`)).toEqual(["patch"]);
  expect(patch(`vi.useFakeTimers();`)).toEqual(["patch"]);
  expect(patch(`setSystemTime(new Date(0));`)).toEqual(["patch"]);
  expect(patch(`setSystemTime();`)).toEqual(["patch"]);
  expect(patch(`jest.advanceTimersByTime(1000);`)).toEqual(["patch"]);
  expect(patch(`spyOn(Date, "now").mockReturnValue(1);`)).toEqual(["patch"]);
  expect(patch(`vi.spyOn(Date, "now");`)).toEqual(["patch"]);
  // Default-runner smoke tests intercept real timers on purpose.
  expect(patch(`spyOn(globalThis, "setTimeout");`)).toEqual([]);
  expect(patch(`spyOn(Date, "parse");`)).toEqual([]);
  expect(patch(`await clock.adjust(1000);`)).toEqual([]);
});

// #7282: direct assignment replaces the clock too.
test("reports a direct Date.now assignment in tests that moved to the TestClock", () => {
  const patch = (code: string) => ids("no-global-clock-patch", code);
  expect(patch(`Date.now = () => 1;`)).toEqual(["patch"]);
  expect(patch(`globalThis.Date.now = () => 1;`)).toEqual(["patch"]);
  expect(patch(`Date["now"] = () => 1;`)).toEqual(["patch"]);
  expect(patch(`const now = Date.now;`)).toEqual([]);
  expect(patch(`clock.now = () => 1;`)).toEqual([]);
});

// The raw reads of each loop file when the ratchet landed. Entries only go down: a later PR
// lowers or removes a file's entry when it moves that file onto the HostClock service.
const RAW_CLOCK_CEILING: Record<string, number> = {
  "src/node/services/agentSession.ts": 11,
  "src/node/services/aiService.ts": 7,
  "src/node/services/backgroundProcessManager.ts": 25,
  "src/node/services/contextManagement/strategies/continuous.ts": 1,
  "src/node/services/contextManagement/strategies/tokenBudget.ts": 1,
  "src/node/services/retryManager.ts": 1,
  "src/node/services/streamManager.ts": 18,
  "src/node/services/tools/bash.ts": 3,
  "src/node/services/tools/bash_background_list.ts": 1,
  "src/node/services/tools/code_execution.ts": 3,
  "src/node/services/tools/skills_catalog_read.ts": 1,
  // Its AbortSignal.timeout() was there when the ratchet landed, but the rule counted it only
  // from #7282 on.
  "src/node/services/tools/skillsCatalogFetch.ts": 1,
  "src/node/services/tools/task.ts": 1,
  "src/node/services/tools/task_await.ts": 7,
  "src/node/services/tools/toolUtils.ts": 1,
  "src/node/services/tools/web_fetch.ts": 2,
  "src/node/services/tools/withHooks.ts": 6,
  "src/node/services/tools/workflow_resume.ts": 1,
  "src/node/services/tools/workflow_run.ts": 1,
  "src/node/services/turnRequestBuilder.ts": 29,
};

function rawClockEntry() {
  const entry = config.find((candidate) => candidate.rules?.["local/no-raw-clock"] !== undefined);
  if (entry === undefined) throw new Error("local/no-raw-clock is in no config entry");
  return entry;
}

function allowMap(): Record<string, number> {
  const setting = rawClockEntry().rules?.["local/no-raw-clock"] as [
    string,
    { allow: Record<string, number> },
  ];
  return setting[1].allow;
}

test("the allow map only shrinks", () => {
  for (const [file, count] of Object.entries(allowMap())) {
    expect({ file, count: Math.min(count, RAW_CLOCK_CEILING[file] ?? 0) }).toEqual({
      file,
      count,
    });
  }
});

test("each allow key is a file that the rule lints", () => {
  const entry = rawClockEntry();
  const root = path.join(import.meta.dir, "..");
  const matches = (globs: unknown, file: string) =>
    (globs as string[]).some((glob) => new Bun.Glob(glob).match(file));
  for (const file of Object.keys(allowMap())) {
    expect({ file, exists: fs.existsSync(path.join(root, file)) }).toEqual({ file, exists: true });
    expect({ file, linted: matches(entry.files, file) && !matches(entry.ignores, file) }).toEqual({
      file,
      linted: true,
    });
  }
});
