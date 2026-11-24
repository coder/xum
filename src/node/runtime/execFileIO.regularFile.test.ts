import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { EXIT_CODE_ABORTED, EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { shellQuote } from "@/common/utils/shell";
import { buildRegularFileReadCommand } from "./execFileIO";
import type { SpawnResult } from "./RemoteRuntime";
import { type ExecOptions, type ExecStream, RuntimeError } from "./Runtime";
import { TestRemoteRuntime } from "./testRemoteRuntime";

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

/**
 * The replacement race the advisory precheck cannot close: the path is a regular file for the
 * precheck and a writer-less FIFO by the time `exec 3<` opens it, so acquisition blocks in the
 * exec's shell (as the pre-PR plain `cat` blocked on any FIFO at the path). These tests pin down
 * how that shell ends, through the real RemoteRuntime.readFile → readFileViaExec →
 * RemoteRuntime.exec path (abort/cancel forwarding, local timeout, `timeout -s KILL` wrapper);
 * only the transport is a local bash, spawned like DockerRuntime's `docker exec -i <c> bash -c`.
 *
 * The race is deterministic: the quoted "path" is a command substitution backed by a counter, so
 * evaluations 1–2 (the precheck's `[ -e ]` and `[ -f ]`) name a regular file and evaluation 3
 * (`exec 3<`) names the FIFO.
 */
class LocalBashRemoteRuntime extends TestRemoteRuntime {
  readonly transports: ChildProcess[] = [];
  readonly exitCodes: Array<Promise<number>> = [];

  constructor(
    private readonly baseDir: string,
    private readonly racyPath: string,
    private readonly racyQuoted: string,
    private readonly timeoutSecs: number,
    /** false: like ssh / docker exec, a local signal reaches only the client, not the remote shell. */
    private readonly forwardsSignals: boolean
  ) {
    super();
  }

  protected override getBasePath(): string {
    return this.baseDir;
  }

  protected override quoteForRemote(filePath: string): string {
    return filePath === this.racyPath ? this.racyQuoted : shellQuote(filePath);
  }

  protected override cdCommand(cwd: string): string {
    return `cd ${shellQuote(cwd)}`;
  }

  // Optional only to stay assignable to TestRemoteRuntime's zero-argument stub.
  protected override spawnRemoteProcess(fullCommand?: string): Promise<SpawnResult> {
    if (fullCommand === undefined) throw new Error("RemoteRuntime.exec always passes the command");
    const args = this.forwardsSignals
      ? ["-c", fullCommand]
      : ["-c", 'bash -c "$1" & wait', "client", fullCommand];
    const child = spawn("bash", args, { stdio: ["pipe", "pipe", "pipe"] });
    this.transports.push(child);
    return Promise.resolve({ process: child });
  }

  // readFile hardcodes the production 300 s budget; shorten it so the real timeout path runs here.
  override async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const stream = await super.exec(command, { ...options, timeout: this.timeoutSecs });
    this.exitCodes.push(stream.exitCode);
    return stream;
  }
}

/** The process and every descendant, via POSIX `ps` (Linux and macOS). */
function processTree(rootPid: number): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const tree = [rootPid];
  // Array iteration sees elements pushed during the loop, so this walks the whole subtree.
  for (const parent of tree) {
    for (const [pid, ppid] of rows) if (ppid === parent) tree.push(pid);
  }
  return tree;
}

/** Alive and not a zombie (a container's PID 1 may never reap reparented orphans). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return stat.stdout.trim() !== "" && !stat.stdout.trim().startsWith("Z");
}

/** A nonblocking write-open succeeds iff some reader holds or awaits the FIFO (and releases it). */
function writerOpenCode(fifo: string): string | undefined {
  try {
    fsSync.closeSync(
      fsSync.openSync(fifo, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK)
    );
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} not observed within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function settleWithin<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type ReadOutcome = { ok: true; done: boolean } | { ok: false; error: unknown };

d("exec-backed requireRegularFile read when the path turns into a FIFO after the precheck", () => {
  let dir: string;
  let racyPath: string;
  let fifo: string;
  let counter: string;
  let racyQuoted: string;
  let owned: number[];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-regular-read-race-"));
    racyPath = path.join(dir, "plan.md");
    fifo = path.join(dir, "plan.fifo");
    counter = path.join(dir, "evaluations");
    await fs.writeFile(racyPath, "# plan\n");
    execFileSync("mkfifo", [fifo]);
    await fs.writeFile(counter, "0");
    const pick = path.join(dir, "pick.sh");
    await fs.writeFile(
      pick,
      'n=$(($(cat "$1") + 1)); echo "$n" > "$1"\nif [ "$n" -le 2 ]; then printf %s "$2"; else printf %s "$3"; fi\n'
    );
    racyQuoted = `"$(sh ${[pick, counter, racyPath, fifo].map(shellQuote).join(" ")})"`;
    owned = [];
  });

  afterEach(async () => {
    // Owned cleanup that also works on a RED run: kill every captured process, then release any
    // reader still parked on the FIFO.
    for (const pid of owned) {
      if (!isRunning(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // exited in between
      }
    }
    writerOpenCode(fifo);
    await fs.rm(dir, { recursive: true, force: true });
  });

  function evaluations(): number {
    return Number(fsSync.readFileSync(counter, "utf8"));
  }

  async function startBlockedRead(runtime: LocalBashRemoteRuntime, signal?: AbortSignal) {
    const reader = runtime.readFile(racyPath, signal, { requireRegularFile: true }).getReader();
    let settled = false;
    const outcome: Promise<ReadOutcome> = reader.read().then(
      (result) => {
        settled = true;
        return { ok: true, done: result.done };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false, error };
      }
    );
    await waitFor(() => evaluations() >= 3, 5000, "the exec 3< path evaluation");
    // Give a nonblocking acquisition time to produce bytes or an exit before calling it blocked.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    expect(evaluations()).toBe(3); // precheck ×2 saw the regular file, exec 3< got the FIFO
    expect(runtime.transports).toHaveLength(1);
    expect(runtime.exitCodes).toHaveLength(1);
    const transport = runtime.transports[0];
    const tree = processTree(transport.pid!);
    owned.push(...tree);
    expect(tree.length).toBeGreaterThanOrEqual(2); // transport + the shell blocked in open()
    for (const pid of tree) expect(isRunning(pid)).toBe(true);
    return { reader, outcome, tree, transport, exitCode: runtime.exitCodes[0] };
  }

  function expectTerminated(tree: number[]): void {
    // exitCode resolves on "close", i.e. after every holder of the stdio pipes has exited.
    for (const pid of tree) expect(isRunning(pid)).toBe(false);
    expect(writerOpenCode(fifo)).toBe("ENXIO"); // no reader left parked on the FIFO
  }

  function expectTypedReadError(outcome: ReadOutcome): void {
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(RuntimeError);
    expect((outcome.error as RuntimeError).type).toBe("file_io");
  }

  it("a caller abort terminates the blocked shell (signal reaches the shell) with a typed error", async () => {
    const runtime = new LocalBashRemoteRuntime(dir, racyPath, racyQuoted, 30, true);
    const controller = new AbortController();
    const { outcome, tree, exitCode } = await startBlockedRead(runtime, controller.signal);
    controller.abort();
    expectTypedReadError(await settleWithin(outcome, 3000, "aborted read"));
    expect(await exitCode).toBe(EXIT_CODE_ABORTED);
    expectTerminated(tree);
  });

  it("cancelling the stream terminates the blocked shell (signal reaches the shell)", async () => {
    const runtime = new LocalBashRemoteRuntime(dir, racyPath, racyQuoted, 30, true);
    const { reader, outcome, tree, exitCode } = await startBlockedRead(runtime);
    await settleWithin(reader.cancel("enough"), 3000, "reader.cancel");
    // A consumer-requested cancel has no error channel: the pending read resolves as done.
    const cancelled = await outcome;
    expect(cancelled).toEqual({ ok: true, done: true });
    expect(await settleWithin(exitCode, 3000, "cancelled exec")).toBe(EXIT_CODE_ABORTED);
    expectTerminated(tree);
  });

  it("the exec timeout terminates the blocked shell (signal reaches the shell) with a typed error", async () => {
    const runtime = new LocalBashRemoteRuntime(dir, racyPath, racyQuoted, 1, true);
    const started = performance.now();
    const { outcome, tree, exitCode } = await startBlockedRead(runtime);
    expectTypedReadError(await settleWithin(outcome, 5000, "timed-out read"));
    expect(performance.now() - started).toBeGreaterThanOrEqual(950); // blocked until the timeout
    expect(await exitCode).toBe(EXIT_CODE_TIMEOUT);
    expectTerminated(tree);
  });

  it("when the local signal cannot reach the remote shell, the timeout -s KILL wrapper ends it", async () => {
    // ssh / docker exec shape: the local timeout (1.5 s) ends only the client; the remote shell
    // is bounded by RemoteRuntime.exec's `timeout -s KILL ceil(t)+1` wrapper (3 s).
    const runtime = new LocalBashRemoteRuntime(dir, racyPath, racyQuoted, 1.5, false);
    const { outcome, tree, transport, exitCode } = await startBlockedRead(runtime);
    await settleWithin(
      new Promise((resolve) => {
        if (transport.exitCode !== null || transport.signalCode !== null) resolve(undefined);
        else transport.once("exit", resolve);
      }),
      5000,
      "client exit on the local timeout"
    );
    expect(transport.signalCode).toBe("SIGTERM");
    const remote = tree.filter((pid) => pid !== transport.pid);
    expect(remote.length).toBeGreaterThanOrEqual(1);
    for (const pid of remote) expect(isRunning(pid)).toBe(true);
    expectTypedReadError(await settleWithin(outcome, 5000, "remote-wrapper-bounded read"));
    expect(await exitCode).toBe(EXIT_CODE_TIMEOUT);
    expectTerminated(tree);
  });
});
