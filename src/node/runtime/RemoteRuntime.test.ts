import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { EXIT_CODE_ABORTED } from "@/common/constants/exitCodes";
import type { ExecOptions, ExecStream } from "./Runtime";
import type { SpawnResult } from "./RemoteRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import {
  MISSING_CWD_COMMANDS,
  MULTI_LINE_COMMAND_CASES,
  ShellRemoteRuntime,
  TestRemoteRuntime,
} from "./testRemoteRuntime";

class RecordingRemoteRuntime extends TestRemoteRuntime {
  spawnCount = 0;

  protected override spawnRemoteProcess(): Promise<SpawnResult> {
    this.spawnCount += 1;
    throw new Error("spawn should not be called");
  }
}

function createStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

class CanonicalPathRemoteRuntime extends RecordingRemoteRuntime {
  commands: string[] = [];

  override resolvePath(filePath: string): Promise<string> {
    if (filePath === "~") return Promise.resolve("/home/test");
    if (filePath.startsWith("~/")) return Promise.resolve(`/home/test/${filePath.slice(2)}`);
    return Promise.resolve(filePath);
  }

  override exec(command: string, _options: ExecOptions): Promise<ExecStream> {
    this.commands.push(command);
    return Promise.resolve({
      stdout: createStream(
        command.startsWith("LC_ALL=C stat ") ? "1 2 regular file\n" : "contents"
      ),
      stderr: createStream(""),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(0),
      duration: Promise.resolve(0),
    });
  }
}

/**
 * Fake exec: records the abortSignal readFile passes and returns a wedged
 * cat whose stdout never yields — exactly the stalled remote read the r18
 * cancellation fix must be able to kill.
 */
class ReadFileRemoteRuntime extends RecordingRemoteRuntime {
  capturedSignal: AbortSignal | undefined;

  override exec(_command: string, options: ExecOptions): Promise<ExecStream> {
    this.capturedSignal = options.abortSignal;
    return Promise.resolve({
      stdout: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      stderr: new ReadableStream<Uint8Array>({
        start: (controller) => controller.close(),
      }),
      stdin: new WritableStream<Uint8Array>(),
      // Wedged process: never exits on its own.
      exitCode: new Promise<number>(() => undefined),
      duration: new Promise<number>(() => undefined),
    });
  }
}

describe("RemoteRuntime file path canonicalization", () => {
  it("resolves relative and tilde paths inside file operations", async () => {
    const runtime = new CanonicalPathRemoteRuntime();

    const reader = runtime.readFile("nested/../read.txt").getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    const writer = runtime.writeFile("~/write.txt").getWriter();
    await writer.close();
    await runtime.stat("nested/../stat.txt");
    await runtime.ensureDir("~/dir");

    expect(runtime.commands).toContain("LC_ALL=C cat '/workspace/read.txt'");
    expect(runtime.commands.some((command) => command.includes("'/home/test/write.txt'"))).toBe(
      true
    );
    expect(runtime.commands).toContain("LC_ALL=C stat -L -c '%s %Y %F' '/workspace/stat.txt'");
    expect(runtime.commands).toContain("mkdir -p '/home/test/dir'");
  });
});

describe("RemoteRuntime.readFile", () => {
  it("cancelling the stream aborts the underlying cat exec", async () => {
    // r18: without cancel forwarding, a cancelled reader (e.g. mux.load's
    // byte ceiling) left the remote cat blocked until its 300s timeout,
    // accumulating remote processes across repeated caught failures.
    const runtime = new ReadFileRemoteRuntime();
    const reader = runtime.readFile("/workspace/huge.bin").getReader();
    // Let start() run: exec is invoked and captures its signal.
    await Bun.sleep(0);
    expect(runtime.capturedSignal).toBeDefined();
    expect(runtime.capturedSignal?.aborted).toBe(false);

    await reader.cancel();
    expect(runtime.capturedSignal?.aborted).toBe(true);
  });

  it("a caller abort forwards into the cat exec", async () => {
    const runtime = new ReadFileRemoteRuntime();
    const abort = new AbortController();
    const stream = runtime.readFile("/workspace/huge.bin", abort.signal);
    const reader = stream.getReader();
    await Bun.sleep(0);
    expect(runtime.capturedSignal?.aborted).toBe(false);

    abort.abort();
    expect(runtime.capturedSignal?.aborted).toBe(true);
    reader.releaseLock();
  });
});

describe("RemoteRuntime file operation aborts", () => {
  it("stat settles immediately when aborted instead of waiting out path resolution", async () => {
    const runtime = new RecordingRemoteRuntime();
    let resolverSettled = false;
    runtime.resolvePath = () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolverSettled = true;
          resolve("/workspace");
        }, 1000)
      );
    const controller = new AbortController();
    controller.abort();

    const rejected = await runtime.stat("relative/file.txt", controller.signal).then(
      () => false,
      () => true
    );
    expect(rejected).toBe(true);
    expect(resolverSettled).toBe(false);
  });
});

/** Spawns a real long-running local process so abort handling can be observed end to end. */
class SleepingRemoteRuntime extends TestRemoteRuntime {
  spawned: ReturnType<typeof spawn> | undefined;

  protected override spawnRemoteProcess(): Promise<SpawnResult> {
    // A later exec is the abort's remote stop (#6923); it has nothing to stop here.
    if (this.spawned) {
      return Promise.resolve({ process: spawn("true", [], { stdio: ["pipe", "pipe", "pipe"] }) });
    }
    this.spawned = spawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
    return Promise.resolve({ process: this.spawned });
  }
}

describe("RemoteRuntime abort cancels the underlying command", () => {
  // Reawakened sub-agents bound definition reads with an abort signal; the timeout only
  // bounds remote work if an aborted stat/readFile really ends its command.
  it("a caller abort forwards into the stat exec", async () => {
    const runtime = new ReadFileRemoteRuntime();
    const abort = new AbortController();
    const pending = runtime.stat("/workspace/agent.md", abort.signal).catch(() => undefined);
    await Bun.sleep(0);
    expect(runtime.capturedSignal).toBeDefined();
    expect(runtime.capturedSignal?.aborted).toBe(false);

    abort.abort();
    expect(runtime.capturedSignal?.aborted).toBe(true);
    void pending;
  });

  it("aborting exec terminates the spawned process", async () => {
    const runtime = new SleepingRemoteRuntime();
    const abort = new AbortController();
    const stream = await runtime.exec("sleep 30", {
      cwd: "/workspace",
      abortSignal: abort.signal,
    });
    expect(runtime.spawned?.exitCode).toBeNull();

    abort.abort();
    expect(await stream.exitCode).toBe(EXIT_CODE_ABORTED);
    expect(runtime.spawned?.signalCode).toBe("SIGTERM");
    await runtime.awaitPendingStops();
  });
});

describe("RemoteRuntime.exec output streams", () => {
  // Bun 1.4.3: a child pipe can emit `data` after the caller cancelled its reader (the bash tool
  // does on output overflow). Readable.toWeb then enqueues on a closed controller and throws from
  // the emitter, an uncaught exception that ends the CLI (nodeReadableToWeb).
  it("drops output that arrives after the caller cancels its readers", async () => {
    const runtime = new SleepingRemoteRuntime();
    const abort = new AbortController();
    const stream = await runtime.exec("sleep 30", { cwd: "/workspace", abortSignal: abort.signal });
    const child = runtime.spawned;
    expect(child).toBeDefined();
    try {
      await stream.stdout.cancel();
      await stream.stderr.cancel();
      expect(() => child?.stdout?.emit("data", Buffer.from("late"))).not.toThrow();
      expect(() => child?.stderr?.emit("data", Buffer.from("late"))).not.toThrow();
    } finally {
      abort.abort();
      await stream.exitCode;
    }
  });
});

/**
 * Spawns a fake child whose stdin never finishes flushing: `final` never calls back, so
 * end() stays pending until the test destroys stdin, as Node does when a child exits.
 */
class PendingStdinRemoteRuntime extends TestRemoteRuntime {
  readonly endCalled = Promise.withResolvers<void>();
  readonly child = Object.assign(new EventEmitter(), {
    stdin: new Writable({
      write: (_chunk, _encoding, callback) => callback(),
      final: () => this.endCalled.resolve(),
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true,
  });

  protected override spawnRemoteProcess(): Promise<SpawnResult> {
    return Promise.resolve({ process: this.child as unknown as ChildProcess });
  }
}

/** Resolves "settled" if `promise` settles before the next macrotask turn, else "pending". */
function settledByNextTurn(promise: Promise<unknown>): Promise<"settled" | "pending"> {
  return Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

describe("RemoteRuntime.exec stdin close (#7436)", () => {
  // execBuffered awaits stdin.close(). When the child exited while end() was still
  // flushing, Node destroyed stdin and emitted only 'close', so close() never settled.
  it("settles when the child's stdin is destroyed while end() is pending", async () => {
    const runtime = new PendingStdinRemoteRuntime();
    const stream = await runtime.exec("cat", { cwd: "/workspace" });
    const closing = stream.stdin.close();
    await runtime.endCalled.promise;

    runtime.child.stdin.destroy();
    await once(runtime.child.stdin, "close");

    expect(await settledByNextTurn(closing)).toBe("settled");
    runtime.child.emit("close", 0, null);
  });

  it("settles at once when the child's stdin is already destroyed", async () => {
    const runtime = new PendingStdinRemoteRuntime();
    const stream = await runtime.exec("cat", { cwd: "/workspace" });
    runtime.child.stdin.destroy();
    await once(runtime.child.stdin, "close");

    expect(await settledByNextTurn(stream.stdin.close())).toBe("settled");
    runtime.child.emit("close", 0, null);
  });
});

/** ShellRemoteRuntime that records the full remote commands it spawns. */
class RecordingShellRemoteRuntime extends ShellRemoteRuntime {
  readonly fullCommands: string[] = [];

  protected override spawnRemoteProcess(...args: unknown[]): Promise<SpawnResult> {
    if (typeof args[0] === "string") this.fullCommands.push(args[0]);
    return super.spawnRemoteProcess(...args);
  }
}

/** Pids whose environment holds exactly `marker` (Linux /proc), other than this process. */
function markedPids(marker: string): number[] {
  const out = spawnSync("sh", ["-c", `grep -lzxF '${marker}' /proc/[0-9]*/environ 2>/dev/null`], {
    encoding: "utf-8",
  }).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((file) => Number(file.split("/")[2]))
    .filter((pid) => pid !== process.pid);
}

describe("RemoteRuntime abort stops the remote command (#6923)", () => {
  // Killing the local client left the remote command running (docker exec passes no signal). The
  // stand-in "remote" here is a local sh, whose SIGTERM leaves its children running the same way.
  // A caller's XUM_EXEC_ID export would replace the marker and hide the command from the stop.
  it.skipIf(process.platform !== "linux").each([
    // Without a timeout there is no `timeout` wrapper, which would pass the TERM on itself.
    ["no caller env", undefined],
    ["a caller env that sets the marker key, and no timeout", { XUM_EXEC_ID: "spoofed" }],
  ] as const)(
    "an abort stops every process that carries the exec's marker (%s)",
    async (_name, env) => {
      const loginDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-abort-"));
      const runtime = new RecordingShellRemoteRuntime(loginDir);
      const abort = new AbortController();
      try {
        // Unique durations find these sleeps whatever their environment holds.
        const seconds = 3000 + Math.floor(Math.random() * 900);
        const sleeps = () =>
          spawnSync("pgrep", ["-f", `^sleep (${seconds}|${seconds + 1})$`], { encoding: "utf-8" })
            .stdout.split("\n")
            .filter(Boolean);
        const stream = await runtime.exec(`sleep ${seconds}; sleep ${seconds + 1}`, {
          cwd: loginDir,
          abortSignal: abort.signal,
          ...(env ? { env } : { timeout: 60 }),
        });
        const marker = /env '(XUM_EXEC_ID=[0-9a-f-]{36})'/.exec(runtime.fullCommands[0] ?? "")?.[1];
        expect(marker).toBeDefined();
        const deadline = Date.now() + 3_000;
        while (markedPids(marker!).length === 0 && Date.now() < deadline) await Bun.sleep(20);
        expect(markedPids(marker!).length).toBeGreaterThan(0);

        abort.abort();
        expect(await stream.exitCode).toBe(EXIT_CODE_ABORTED);
        await runtime.awaitPendingStops();
        // One stop exec, with its own marker.
        expect(runtime.fullCommands).toHaveLength(2);
        expect(runtime.fullCommands[1]).toContain(marker!);
        expect(runtime.fullCommands[1]).not.toMatch(new RegExp(`^env '${marker!}'`));
        expect(markedPids(marker!)).toEqual([]);
        expect(sleeps()).toEqual([]);
      } finally {
        await fs.rm(loginDir, { recursive: true, force: true });
      }
    }
  );

  // The env prefix changes nothing a caller sees (#6923).
  it("a command that is not aborted keeps its stdout, stderr and exit code", async () => {
    const loginDir = await fs.mkdtemp(path.join(os.tmpdir(), "remote-plain-"));
    const runtime = new RecordingShellRemoteRuntime(loginDir);
    try {
      const result = await execBuffered(runtime, "echo out; echo err >&2; exit 7", {
        cwd: loginDir,
        timeout: 10,
      });
      expect([result.stdout, result.stderr, result.exitCode]).toEqual(["out\n", "err\n", 7]);
      expect(runtime.fullCommands).toHaveLength(1);
    } finally {
      await fs.rm(loginDir, { recursive: true, force: true });
    }
  });
});

describe("RemoteRuntime.writeFile", () => {
  it("does not start a remote write command when aborted before the first write", async () => {
    const runtime = new RecordingRemoteRuntime();
    const writer = runtime.writeFile("/workspace/file.txt").getWriter();

    try {
      await writer.abort("cancelled");
      throw new Error("Expected writer abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cancelled");
    }

    expect(runtime.spawnCount).toBe(0);
  });
});

// ShellRemoteRuntime needs GNU-style `timeout` and bash.
const noShellTransport = process.platform === "win32" || process.platform === "darwin";

describe("RemoteRuntime.exec multi-line commands", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "remote-exec-lines-")));
    await fs.mkdir(path.join(root, "login"));
    await fs.mkdir(path.join(root, "workspace"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.skipIf(noShellTransport)(
    "a missing cwd fails the command instead of running later lines in the login directory",
    async () => {
      const runtime = new ShellRemoteRuntime(path.join(root, "login"));
      for (const command of MISSING_CWD_COMMANDS) {
        const result = await execBuffered(runtime, command, {
          cwd: path.join(root, "missing"),
          env: { XUM_TEST_VAR: "set" },
          timeout: 10,
        });
        expect({ command, failed: result.exitCode !== 0, stdout: result.stdout }).toEqual({
          command,
          failed: true,
          stdout: "",
        });
      }
    }
  );

  it.skipIf(noShellTransport)("later lines run in the cwd with the exported env", async () => {
    const runtime = new ShellRemoteRuntime(path.join(root, "login"));
    const cwd = path.join(root, "workspace");
    const result = await execBuffered(runtime, 'true\npwd\necho "var=$XUM_TEST_VAR"', {
      cwd,
      env: { XUM_TEST_VAR: "set" },
      timeout: 10,
    });
    expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
      exitCode: 0,
      stdout: `${cwd}\nvar=set\n`,
    });
  });

  for (const c of MULTI_LINE_COMMAND_CASES) {
    it.skipIf(noShellTransport)(`keeps output and exit code: ${c.name}`, async () => {
      const runtime = new ShellRemoteRuntime(path.join(root, "login"));
      const result = await execBuffered(runtime, c.command, {
        cwd: path.join(root, "workspace"),
        timeout: 10,
      });
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({
        exitCode: c.exitCode,
        stdout: c.stdout,
      });
    });
  }
});
