// Tests for the stall watchdog in scripts/test-unit-ci.sh (#4957): the real script
// runs against a fake `bun` on PATH, so a hang costs seconds instead of CI minutes.
//
// Runs in CI's unit lane (scripts/test-unit-ci.sh); locally:
// bun test ./scripts/test-unit-ci.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "test-unit-ci.sh");
// The first isolated file on shard 1/1; the fake bun misbehaves only for it so the
// rest of the lane (other isolated files, tooling tests, the shared shard) is instant.
const FIRST_ISOLATED_FILE = "src/node/services/workflows/WorkflowRunner.test.ts";

let fakeBinDir: string;

beforeEach(async () => {
  fakeBinDir = await mkdtemp(path.join(tmpdir(), "test-unit-ci-"));
});

afterEach(async () => {
  await rm(fakeBinDir, { recursive: true, force: true });
});

async function writeFakeBun(misbehavior: string): Promise<void> {
  const fakeBun = path.join(fakeBinDir, "bun");
  await writeFile(
    fakeBun,
    [
      "#!/usr/bin/env bash",
      `case " $* " in *" ${FIRST_ISOLATED_FILE} "*) ;; *) exit 0 ;; esac`,
      misbehavior,
      "",
    ].join("\n")
  );
  await chmod(fakeBun, 0o755);
}

async function runLane(): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      SHARD_INDEX: "1",
      SHARD_TOTAL: "1",
      BUN_TEST_STALL_SECS: "2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
}

test("kills a silent bun, names the stalled test, and retries it like a crash", async () => {
  const pidFile = path.join(fakeBinDir, "pids");
  await writeFakeBun(
    [
      'echo "src/fake/hang.test.ts:"',
      'echo "(pass) fake > before the hang"',
      // A forked child, like a test's subprocess, must die with the stuck parent.
      "sleep 300 &",
      `echo "$$ $!" >> "${pidFile}"`,
      "wait",
    ].join("\n")
  );

  const result = await runLane();

  // SIGKILL (128 + 9) after the third stalled attempt.
  expect(result.exitCode).toBe(137);
  const stallReports = result.stdout.split("::error::bun test printed nothing for 2s").slice(1);
  expect(stallReports).toHaveLength(3);
  for (const report of stallReports) {
    expect(report).toContain("src/fake/hang.test.ts:\n");
    expect(report).toContain("(pass) fake > before the hang");
  }
  expect(result.stdout.match(/retrying \(attempt \d of 3\)/g)).toHaveLength(2);

  const attempts = (await readFile(pidFile, "utf8")).trim().split("\n");
  expect(attempts).toHaveLength(3);
  const pids = attempts.flatMap((line) => line.split(" ").map(Number));
  expect(pids).toHaveLength(6);
  for (const pid of pids) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
}, 60_000);

test("leaves a slow bun alone while it keeps printing", async () => {
  // Quiet gaps of 0.5 s stay well under the 2 s stall limit, but the run lasts longer than it.
  await writeFakeBun(
    ['for i in 1 2 3 4 5 6 7 8; do echo "(pass) slow > step $i"; sleep 0.5; done', "exit 0"].join("\n")
  );

  const result = await runLane();

  expect(result.stdout).not.toContain("::error::");
  expect(result.stdout).toContain("(pass) slow > step 8");
  expect(result.exitCode).toBe(0);
}, 60_000);
