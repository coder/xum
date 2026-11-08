// Shared by the tests of scripts/retry.sh and scripts/ci/*.sh: spawn a script and make small
// executable stubs (a fake `sleep`, `curl` or `uname` first on PATH).
import { chmod, writeFile } from "node:fs/promises";

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
