import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loopTestFiles, patchesGlobalTime, runFile } from "./loopTestBaseline";
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
