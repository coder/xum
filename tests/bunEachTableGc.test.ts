import { expect, test } from "bun:test";
import * as path from "node:path";

const FIXTURE = path.join(import.meta.dir, "bunEachTableGc.child.ts");
const CHILD_TIMEOUT_MS = 60_000;

// Bun 1.3.12 frees `.each` tables in the GC window before registration (#6020). The fixture
// forces that window in a child process with the repo's bunfig preloads, so a regression
// shows up as a normal assertion failure here instead of a crash in a shared test process.
test(
  "test.each and describe.each rows survive a GC before registration",
  () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "test", FIXTURE],
      cwd: path.resolve(import.meta.dir, ".."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
    // A segfault or a timeout surfaces as a signal rather than an exit code.
    expect({ exitCode: child.exitCode, signal: child.signalCode ?? null, output }).toMatchObject({
      exitCode: 0,
      signal: null,
    });
    // A skipped or undiscovered fixture is not evidence that the rows survived.
    expect(output).toMatch(/\b4 pass\b/);
    expect(output).toMatch(/\b0 fail\b/);
  },
  CHILD_TIMEOUT_MS + 10_000
);
