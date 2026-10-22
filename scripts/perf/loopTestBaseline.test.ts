import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  changedFiles,
  heavySkips,
  loopTestFiles,
  patchesGlobalTime,
  recordName,
  runFile,
  runPool,
} from "./loopTestBaseline";
import { summarizeFile } from "./loopTestStats";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-tests-fixture-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, text = ""): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

describe("loopTestFiles", () => {
  test("selects the tests of the loop code and nothing else", () => {
    const selected = [
      "src/node/services/agentSession.send.test.ts",
      "src/node/services/turnEnvelope.test.ts",
      "src/node/services/tools/shared/configReadWrite.test.ts",
      "src/node/services/contextManagement/x.test.ts",
      "src/node/utils/concurrency/fileLock.repro.test.ts",
      "src/node/utils/writeFileAtomic.test.ts",
    ];
    const ignored = [
      "src/node/services/agentSession.ts",
      "src/node/services/workspaceService.test.ts",
      "src/node/utils/concurrency/asyncMutex.test.ts",
      "src/browser/tools/x.test.ts",
    ];
    for (const file of [...selected, ...ignored]) write(file);
    expect(loopTestFiles(root)).toEqual([...selected].sort());
    expect(loopTestFiles(root, "tools/")).toEqual([
      "src/node/services/tools/shared/configReadWrite.test.ts",
    ]);
  });
});

describe("patchesGlobalTime", () => {
  test("flags time calls in the test file", () => {
    write("a.test.ts", 'import { setSystemTime } from "bun:test";\nsetSystemTime(new Date(0));');
    write("b.test.ts", 'const spy = spyOn(globalThis, "setTimeout");');
    expect(patchesGlobalTime(root, "a.test.ts")).toBe(true);
    expect(patchesGlobalTime(root, "b.test.ts")).toBe(true);
  });

  test("ignores comparisons and spies on other globals", () => {
    write("c.test.ts", 'if (Date.now === now) {}\nspyOn(globalThis, "fetch");');
    expect(patchesGlobalTime(root, "c.test.ts")).toBe(false);
  });

  test("follows test helpers, through @/ and relative imports, but not product modules", () => {
    write("src/node/x/clock.testHarness.ts", "jest.useFakeTimers();");
    write("src/node/x/product.ts", "jest.useFakeTimers();");
    write("src/node/x/testHelpers.ts", 'export * from "./clock.testHarness";');
    write("src/node/x/a.test.ts", 'import { h } from "@/node/x/testHelpers";');
    write("src/node/x/b.test.ts", 'import { p } from "./product";');
    expect(patchesGlobalTime(root, "src/node/x/a.test.ts")).toBe(true);
    expect(patchesGlobalTime(root, "src/node/x/b.test.ts")).toBe(false);
  });
});

describe("runFile", () => {
  test("the preload reads no clock through a test's performance.now spy", async () => {
    // session_history.budget.test.ts counts its own clock reads; a wrapper read would change them.
    write(
      "spy.test.ts",
      [
        'import { expect, spyOn, test } from "bun:test";',
        'import * as fs from "node:fs";',
        'test("spy", () => {',
        "  let reads = 0;",
        '  const spy = spyOn(performance, "now").mockImplementation(() => ++reads);',
        '  fs.existsSync("/");',
        "  spy.mockRestore();",
        "  expect(reads).toBe(0);",
        "});",
      ].join("\n")
    );
    expect((await runFile(root, "spy.test.ts", root)).exitCode).toBe(0);
  });

  test("measures a passing file, and counts a crash at import as a failed run", async () => {
    write(
      "ok.test.ts",
      'import { test } from "bun:test";\ntest("ok", async () => { await Bun.sleep(5); });'
    );
    write("crash.test.ts", 'throw new Error("crash at import");');
    const ok = await runFile(root, "ok.test.ts", root);
    const crash = await runFile(root, "crash.test.ts", root);
    expect(ok.exitCode).toBe(0);
    expect(ok.preload?.timerMs).toBeGreaterThan(0);
    expect(crash.exitCode).not.toBe(0);
    expect(summarizeFile("f", [ok, crash], false).failedRuns).toBe(1);
  });
});

describe("heavySkips", () => {
  const heavy = "src/node/services/backgroundProcessManager.test.ts";

  test("a short compare skips backgroundProcessManager.test.ts unless its code changed", () => {
    expect(heavySkips(3, ["src/node/services/historyService.ts"])).toEqual([heavy]);
    expect(heavySkips(3, ["src/node/services/backgroundProcessManager.ts"])).toEqual([]);
    expect(heavySkips(3, [heavy])).toEqual([]);
  });

  test("a full compare never skips it", () => {
    expect(heavySkips(5, [])).toEqual([]);
  });
});

describe("changedFiles", () => {
  const sh = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };

  test("lists a renamed file under its old and its new path", () => {
    sh("init", "-q");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    write("a.ts", "export const a = 1;\n".repeat(20));
    write("b.ts", "export const b = 1;\n".repeat(20));
    sh("add", ".");
    sh("commit", "-qm", "base");
    const base = sh("rev-parse", "HEAD");
    sh("mv", "a.ts", "a2.ts");
    sh("commit", "-qm", "rename a");
    sh("mv", "b.ts", "b2.ts");
    expect(changedFiles(root, base).sort()).toEqual(["a.ts", "a2.ts", "b.ts", "b2.ts"]);
  });
});

test("an unknown --base exits 2 with a last loop-tests line", () => {
  const result = Bun.spawnSync(
    [
      "bun",
      "scripts/perf/loopTestBaseline.ts",
      "--base",
      "no-such-ref-for-loop-tests",
      "--runs",
      "3",
    ],
    { cwd: path.join(import.meta.dir, "..", ".."), stdout: "pipe", stderr: "pipe" }
  );
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString().trim().split("\n").at(-1)).toBe("loop-tests: error");
});

describe("runPool", () => {
  test("never runs two tasks of one key at once, and other keys side by side", async () => {
    const active = new Map<string, number>();
    let most = 0;
    let mostOfOneKey = 0;
    const task = (key: string, value: number) => ({
      key,
      run: async () => {
        active.set(key, (active.get(key) ?? 0) + 1);
        mostOfOneKey = Math.max(mostOfOneKey, ...active.values());
        most = Math.max(
          most,
          [...active.values()].reduce((a, b) => a + b, 0)
        );
        await Bun.sleep(5);
        active.set(key, (active.get(key) ?? 0) - 1);
        return value;
      },
    });
    const tasks = [task("a", 1), task("a", 2), task("a", 3), task("b", 4), task("b", 5)];
    expect(await runPool(tasks, 6)).toEqual([1, 2, 3, 4, 5]);
    expect(mostOfOneKey).toBe(1);
    expect(most).toBe(2);
  });

  test("after a failure it starts no task and waits for the running ones", async () => {
    const started: string[] = [];
    let slowDone = false;
    const tasks = [
      { key: "fail", run: () => Promise.reject(new Error("broken record")) },
      {
        key: "slow",
        run: async () => {
          started.push("slow");
          await Bun.sleep(20);
          slowDone = true;
        },
      },
      { key: "late", run: () => Promise.resolve(started.push("late")).then(() => undefined) },
    ];
    await expect(runPool(tasks, 2).finally(() => expect(slowDone).toBe(true))).rejects.toThrow(
      "broken record"
    );
    expect(started).toEqual(["slow"]);
  });
});

test("recordName keeps a filtered, short or other-jobs run off the full record of a commit", () => {
  const sha = "0123456789abcdef";
  expect(recordName(sha, false, undefined, 10, 6)).toBe("0123456789");
  expect(recordName(sha, true, undefined, 10, 6)).toBe("0123456789-dirty");
  expect(recordName(sha, false, "tools/bash", 2, 6)).toBe("0123456789-tools_bash-r2");
  expect(recordName(sha, false, undefined, 10, 8)).toBe("0123456789-j8");
});
