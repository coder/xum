import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { shellQuote } from "@/common/utils/shell";
import { buildRegularFileReadCommand } from "./execFileIO";

/**
 * The remote/devcontainer `requireRegularFile` read: acquire the descriptor, classify THAT descriptor
 * (`/dev/fd/N`), and stream from the same descriptor. Exercised against a real local shell — the
 * same POSIX contract the existing `cat` read already assumes remotely.
 */
const isPosix = process.platform !== "win32";
const d = isPosix ? describe : describe.skip;
const run = promisify(execFile);

d("buildRegularFileReadCommand", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-regular-read-cmd-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("streams a regular file from the acquired descriptor with exit 0", async () => {
    const file = path.join(dir, "plan.md");
    await fs.writeFile(file, "# plan\nbody\n");
    const { stdout } = await run("bash", ["-c", buildRegularFileReadCommand(shellQuote(file))]);
    expect(stdout).toBe("# plan\nbody\n");
  });

  it("rejects a FIFO even when a writer is present, with no bytes on stdout", async () => {
    const fifo = path.join(dir, "plan.md");
    execFileSync("mkfifo", [fifo]);
    // A concurrent writer must not turn the FIFO into readable "plan content".
    const child = execFile("bash", ["-c", buildRegularFileReadCommand(shellQuote(fifo))]);
    // The writer parks on open() until a reader arrives; the command must never be that reader,
    // so the writer is killed once the command has settled.
    const writer = execFile("sh", ["-c", `exec 3>"$0"; exec 3>&-`, fifo]);
    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
      (resolve) => {
        let stderr = "";
        let stdout = "";
        child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
        child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
        child.once("exit", (code) => resolve({ code, stderr, stdout }));
      }
    );
    writer.kill("SIGKILL");
    expect(result.code).toBe(66);
    expect(result.stderr).toContain("not a regular file");
    expect(result.stdout).toBe("");
  });

  it("fails fast on a FIFO with no writer instead of blocking on acquisition (advisory precheck)", async () => {
    const fifo = path.join(dir, "plan.md");
    execFileSync("mkfifo", [fifo]);
    const started = performance.now();
    const err = await run("bash", ["-c", buildRegularFileReadCommand(shellQuote(fifo))]).then(
      () => undefined,
      (e: { code?: number; stderr?: string }) => e
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(err?.code).toBe(66);
    expect(err?.stderr).toContain("not a regular file");
  });

  it("fails with exit 65 when the path cannot be opened", async () => {
    const missing = path.join(dir, "missing.md");
    const err = await run("bash", ["-c", buildRegularFileReadCommand(shellQuote(missing))]).then(
      () => undefined,
      (e: { code?: number; stderr?: string }) => e
    );
    expect(err?.code).toBe(65);
  });
});
