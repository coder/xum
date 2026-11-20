// Shared by the tests of scripts/retry.sh and scripts/ci/*.sh: spawn a script and make small
// executable stubs (a fake `sleep`, `curl` or `uname` first on PATH).
import { chmod, writeFile } from "node:fs/promises";

// Per-test limit for the tests that spawn programs. Bun's default is 5 s, and these tests start
// bash, make, python or node a few times each: with 8 copies of one test file and 24 busy loops
// on a 32-CPU host (load 264) the slowest test took 28.3 s and the median test 3.3 s (672 runs),
// and with the limit lifted on a host at a load of about 100 four of the six files had a test
// over 3 s. A test that spawns once still takes a few hundred milliseconds when the host is
// quiet. The limit is 4 times the slowest run of that first measurement (28.3 s). A later run on
// a more loaded host reached 102 s, so the margin there is about 1.2 times. The limit keeps a
// loaded host from failing a test with a timeout that says nothing about the script, and a test
// that hangs still fails.
// `setDefaultTimeout` applies to the file that calls it.
export const SPAWNING_TEST_TIMEOUT_MS = 120_000;

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runScript(
  cmd: string[],
  options: { cwd: string; env?: Record<string, string> }
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function writeExecutable(file: string, body: string): Promise<void> {
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}
