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

  test("directory reads through opendir count as fs time", async () => {
    // Made here, in a process without the preload, so the fixture's fs time is the opendir call
    // and the reads of the Dir it returns.
    for (let i = 0; i < 3000; i++) write(`many/f${i}`);
    const readMsFile = path.join(root, "read-ms");
    write(
      "dir.test.ts",
      [
        'import { test } from "bun:test";',
        'import { opendir } from "node:fs/promises";',
        'test("dir", async () => {',
        `  const dir = await opendir(${JSON.stringify(path.join(root, "many"))});`,
        "  const start = performance.now();",
        "  let entries = 0;",
        "  for await (const _ of dir) entries++;",
        "  const readMs = performance.now() - start;",
        "  if (entries !== 3000) throw new Error(`read ${entries} entries`);",
        // Bun.write: not an fs export, so the preload does not time it.
        `  await Bun.write(${JSON.stringify(readMsFile)}, String(readMs));`,
        "});",
      ].join("\n")
    );
    const run = await runFile(root, "dir.test.ts", root);
    expect(run.exitCode).toBe(0);
    const readMs = Number(fs.readFileSync(readMsFile, "utf8"));
    // Without the Dir methods timed, only the opendir call counts, a small part of the reads.
    expect(run.preload?.fsMs).toBeGreaterThanOrEqual(readMs / 2);
  });

  test("an interval that a test waits on counts as timer time", async () => {
    write(
      "interval.test.ts",
      [
        'import { test } from "bun:test";',
        'test("interval", async () => {',
        "  await new Promise<void>((resolve) => {",
        "    let fires = 0;",
        "    const id = setInterval(() => {",
        "      if (++fires < 5) return;",
        "      clearInterval(id);",
        "      resolve();",
        "    }, 10);",
        "  });",
        "});",
      ].join("\n")
    );
    const run = await runFile(root, "interval.test.ts", root);
    expect(run.exitCode).toBe(0);
    expect(run.preload?.timerMs).toBeGreaterThanOrEqual(40);
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

  test("lists the changes of a base that is not an ancestor of HEAD", () => {
    sh("init", "-q", "-b", "main");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    write("a.ts", "a\n");
    sh("add", ".");
    sh("commit", "-qm", "root");
    sh("checkout", "-qb", "other");
    write("only-on-base.ts", "x\n");
    sh("add", ".");
    sh("commit", "-qm", "base change");
    const base = sh("rev-parse", "HEAD");
    sh("checkout", "-q", "main");
    write("a.ts", "a2\n");
    sh("commit", "-qam", "head change");
    expect(changedFiles(root, base).sort()).toEqual(["a.ts", "only-on-base.ts"]);
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
  expect(recordName(sha, false, "tools", 2, 6)).toBe("0123456789-tools-r2");
  expect(recordName(sha, false, undefined, 10, 8)).toBe("0123456789-j8");
  const slash = recordName(sha, false, "tools/bash", 10, 6);
  const space = recordName(sha, false, "tools bash", 10, 6);
  expect(slash).toStartWith("0123456789-tools_bash_");
  expect(space).toStartWith("0123456789-tools_bash_");
  expect(slash).not.toBe(space);
});

describe("the script on a fixture repo", () => {
  const script = path.join(import.meta.dir, "loopTestBaseline.ts");
  const loopTest = "src/node/services/tools/fixture.test.ts";
  let tmp: string;

  const sh = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };

  /** A git repo in `root` with src/version.ts and one loop test file with `body`. */
  function repo(body: string): void {
    sh("init", "-q");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    write(".gitignore", "artifacts/\nsrc/version.ts\ntmp/\nfake-bin/\nchild.pid\n");
    write("src/version.ts", "export const VERSION = {};\n");
    write("tracked.txt", "a\n");
    write(loopTest, `import { test } from "bun:test";\n${body}`);
    sh("add", ".");
    sh("commit", "-qm", "fixture");
  }

  /** Starts the script in `root` with a `bun` on PATH that is not process.execPath. */
  function start(args: string[]) {
    tmp = path.join(root, "tmp");
    fs.mkdirSync(tmp);
    const fakeBin = path.join(root, "fake-bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "bun"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    return Bun.spawn([process.execPath, script, ...args], {
      cwd: root,
      env: { ...process.env, TMPDIR: tmp, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  async function finish(child: ReturnType<typeof start>) {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, lastLine: stdout.trim().split("\n").at(-1), stderr };
  }

  test("the children run process.execPath, not the first bun on PATH", async () => {
    repo('test("ok", () => {});\n');
    const result = await finish(start(["--runs", "1"]));
    expect(result.exitCode).toBe(0);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          "artifacts",
          "loop-tests",
          `${sh("rev-parse", "HEAD").slice(0, 10)}-r1.json`
        ),
        "utf8"
      )
    ) as { files: Array<{ file: string; failedRuns: number }> };
    expect(record.files).toEqual([expect.objectContaining({ file: loopTest, failedRuns: 0 })]);
  });

  test("without src/version.ts it exits 2 and asks for make version", async () => {
    repo('test("ok", () => {});\n');
    fs.rmSync(path.join(root, "src", "version.ts"));
    const result = await finish(start(["--runs", "1"]));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("run make version");
    expect(result.lastLine).toBe("loop-tests: error");
  });

  test("a tracked file that changes during the run exits 2 and writes no record", async () => {
    repo(
      'import * as fs from "node:fs";\n' +
        'test("edits", () => { fs.appendFileSync(`${process.cwd()}/tracked.txt`, "b\\n"); });\n'
    );
    const result = await finish(start(["--runs", "1"]));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("changed during the run");
    expect(fs.readdirSync(path.join(root, "artifacts", "loop-tests"))).toEqual([]);
  });

  test("a compare that selects only skipped heavy tests lists them and exits 0", async () => {
    repo('test("ok", () => {});\n');
    write(
      "src/node/services/backgroundProcessManager.test.ts",
      'import { test } from "bun:test";\ntest("x", () => {});\n'
    );
    sh("add", ".");
    sh("commit", "-qm", "heavy");
    const result = await finish(
      start(["--base", "HEAD", "--runs", "2", "--filter", "backgroundProcessManager"])
    );
    expect(result.exitCode).toBe(0);
    expect(result.lastLine).toBe("loop-tests: 0 trips");
    const markdown = fs
      .readdirSync(path.join(root, "artifacts", "loop-tests"))
      .find((f) => f.endsWith(".md"));
    expect(markdown).toBeDefined();
    expect(
      fs.readFileSync(path.join(root, "artifacts", "loop-tests", markdown ?? ""), "utf8")
    ).toContain("skip src/node/services/backgroundProcessManager.test.ts");
  });

  test("SIGTERM stops the running bun test children before the cleanup", async () => {
    const pidFile = path.join(root, "child.pid");
    repo(
      'import * as fs from "node:fs";\n' +
        `test("waits", async () => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60_000); }, 120_000);\n`
    );
    const child = start(["--base", "HEAD", "--runs", "2"]);
    while (!fs.existsSync(pidFile)) await Bun.sleep(20);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    child.kill("SIGTERM");
    const result = await finish(child);
    expect(result.exitCode).toBe(143);
    // The test process is gone, and so are the scratch dir and the base worktree.
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(sh("worktree", "list").split("\n")).toHaveLength(1);
  }, 30_000);
});
