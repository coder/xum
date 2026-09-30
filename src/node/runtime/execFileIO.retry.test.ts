import { afterEach, describe, expect, it } from "bun:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { shellQuote } from "@/common/utils/shell";
import {
  type ExecOptions,
  type ExecStream,
  RuntimeError,
  isRuntimeReadFailure,
  isRuntimeRetryableTransportError,
  isRuntimeTransportError,
} from "./Runtime";
import type { SpawnResult } from "./RemoteRuntime";
import { SSHRuntime } from "./SSHRuntime";
import { TestRemoteRuntime } from "./testRemoteRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import { createSSHTransport, type SSHTransport } from "./transports";
import type { AddressInfo } from "node:net";
import { Server, utils } from "ssh2";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";

// #4830: one transient SSH blip during stream startup (connection reset, a
// channel refused under MaxSessions, a pool refusal) must not fail the turn.
// Idempotent reads retry ONCE on a transport failure, with a short deadline so
// a persistent outage still fails fast and retryably.

const REFUSED = "ssh: connect to host example.test port 22: Connection refused";
const STAT_OUTPUT = "12 1700000000 regular file";

/** One scripted exec outcome: an exit, or a rejected exec (pool refusal, SSH2 channel error). */
type Outcome = { stdout?: string; stderr?: string; exitCode: number } | { reject: Error };

interface ExecCall {
  command: string;
  timeout: number | undefined;
}

class ScriptedSSHRuntime extends SSHRuntime {
  readonly calls: ExecCall[] = [];

  constructor(
    private readonly outcomes: Outcome[],
    private readonly onExec?: (callIndex: number) => void
  ) {
    const config: SSHRuntimeConfig = { host: "example.test", srcBaseDir: "/remote/src" };
    const transport: SSHTransport = {
      isConnectionFailure: (exitCode) => exitCode === 255,
      acquireConnection: () => Promise.resolve(),
      getConfig: () => config,
      spawnRemoteProcess: () => Promise.reject(new Error("exec is stubbed")),
      createPtySession: () => Promise.reject(new Error("no PTY here")),
    };
    super(config, transport);
  }

  override exec(command: string, options: ExecOptions): Promise<ExecStream> {
    const index = this.calls.length;
    this.calls.push({ command, timeout: options.timeout });
    this.onExec?.(index);
    const outcome = this.outcomes[index];
    if (outcome == null) throw new Error(`unexpected exec #${index}: ${command}`);
    if ("reject" in outcome) return Promise.reject(outcome.reject);
    return Promise.resolve({
      stdout: new Blob([outcome.stdout ?? ""]).stream(),
      stderr: new Blob([outcome.stderr ?? ""]).stream(),
      stdin: new WritableStream<Uint8Array>(),
      exitCode: Promise.resolve(outcome.exitCode),
      duration: Promise.resolve(0),
    });
  }
}

const refused: Outcome = { stderr: REFUSED, exitCode: 255 };

function settle<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error))
  );
}

const read = (runtime: SSHRuntime, filePath = "/remote/AGENTS.md", signal?: AbortSignal) =>
  settle(new Response(runtime.readFile(filePath, signal)).text());
const stat = (runtime: SSHRuntime, signal?: AbortSignal) =>
  settle(runtime.stat("/remote/AGENTS.md", signal));

describe("bounded retry of idempotent SSH reads (#4830)", () => {
  it("absorbs one transport blip on a read, a stat and a path resolution", async () => {
    const reader = new ScriptedSSHRuntime([refused, { stdout: "# rules", exitCode: 0 }]);
    expect(await read(reader)).toBe("# rules");

    const stater = new ScriptedSSHRuntime([refused, { stdout: STAT_OUTPUT, exitCode: 0 }]);
    expect(await stat(stater)).toMatchObject({ size: 12, isDirectory: false });

    const resolver = new ScriptedSSHRuntime([refused, { stdout: "/home/u/.xum\n", exitCode: 0 }]);
    expect(await settle(resolver.resolvePath("~/.xum"))).toBe("/home/u/.xum");

    // A pool refusal or SSH2 channel error rejects the exec itself.
    const rejected = new ScriptedSSHRuntime([
      { reject: new RuntimeError("SSH connection is in backoff", "network") },
      { stdout: "# rules", exitCode: 0 },
    ]);
    expect(await read(rejected)).toBe("# rules");
  });

  it("gives the retry a short deadline, so a persistent outage fails fast and retryably", async () => {
    // The exec deadline also bounds how long the SSH pool waits through its
    // backoff; reusing readFile's 300 s would hang the turn for minutes.
    const reader = new ScriptedSSHRuntime([refused, refused]);
    const readError = await read(reader);
    expect(isRuntimeTransportError(readError)).toBe(true);
    expect(reader.calls.map((call) => call.timeout)).toEqual([300, 10]);

    const stater = new ScriptedSSHRuntime([refused, refused]);
    expect(isRuntimeTransportError(await stat(stater))).toBe(true);
    expect(stater.calls.map((call) => call.timeout)).toEqual([10, 10]);

    const resolver = new ScriptedSSHRuntime([refused, refused]);
    expect(isRuntimeTransportError(await settle(resolver.resolvePath("~/.xum")))).toBe(true);
    expect(resolver.calls).toHaveLength(2);
  });

  it("does not multiply retries when a read resolves a ~ path", async () => {
    // readFile("~/…") resolves the path inside its exec factory: the read's one
    // retry must not stack on top of a resolvePath retry (4 attempts).
    const reader = new ScriptedSSHRuntime([refused, refused, refused, refused]);
    expect(isRuntimeTransportError(await read(reader, "~/.xum/AGENTS.md"))).toBe(true);
    expect(reader.calls).toHaveLength(2);
  });

  it("never retries a permission error or a missing file", async () => {
    for (const stderr of [
      "cat: /remote/AGENTS.md: Permission denied",
      "cat: /remote/AGENTS.md: No such file or directory",
    ]) {
      const reader = new ScriptedSSHRuntime([{ stderr, exitCode: 1 }]);
      const error = await read(reader);
      expect(isRuntimeReadFailure(error)).toBe(stderr.includes("Permission denied"));
      expect(isRuntimeTransportError(error)).toBe(false);
      expect(reader.calls).toHaveLength(1);

      const stater = new ScriptedSSHRuntime([
        { stderr: stderr.replace("cat", "stat"), exitCode: 1 },
      ]);
      expect(isRuntimeTransportError(await stat(stater))).toBe(false);
      expect(stater.calls).toHaveLength(1);
    }
  });

  // #5034: both transports report every pool-acquisition failure as "network" (#4812), which
  // fallback callers need. A rejected key or a failed host-key check cannot recover, though,
  // so the one retry would only repeat the whole authentication attempt.
  it("never retries a permanent acquisition failure (auth, host key)", async () => {
    const permanent = [
      // OpenSSH probe stderr, as the pool reports it.
      new RuntimeError("testuser@example.test: Permission denied (publickey,password).", "network"),
      new RuntimeError("Host key verification failed.", "network"),
      // The pool's backoff refusal after an earlier authentication failure.
      new RuntimeError(
        "SSH connection to example.test is in backoff for 5s. Last error: testuser@example.test: Permission denied (publickey).",
        "network"
      ),
      // SSH2Transport's wrap of the ssh2 client error, which carries its level.
      new RuntimeError(
        "SSH2 connection failed: All configured authentication methods failed",
        "network",
        Object.assign(new Error("All configured authentication methods failed"), {
          level: "client-authentication",
        })
      ),
    ];
    for (const failure of permanent) {
      const reader = new ScriptedSSHRuntime([
        { reject: failure },
        { stdout: "# rules", exitCode: 0 },
      ]);
      // Still a transport failure for fallback callers, and the first error is what they see.
      expect(await read(reader)).toBe(failure);
      expect(reader.calls).toHaveLength(1);

      const stater = new ScriptedSSHRuntime([
        { reject: failure },
        { stdout: STAT_OUTPUT, exitCode: 0 },
      ]);
      expect(await stat(stater)).toBe(failure);
      expect(stater.calls).toHaveLength(1);

      const resolver = new ScriptedSSHRuntime([
        { reject: failure },
        { stdout: "/home/u/.xum\n", exitCode: 0 },
      ]);
      expect(await settle(resolver.resolvePath("~/.xum"))).toBe(failure);
      expect(resolver.calls).toHaveLength(1);
    }
  });

  it("still retries transient drops that mention no authentication failure", async () => {
    for (const failure of [
      new RuntimeError("kex_exchange_identification: read: Connection reset by peer", "network"),
      new RuntimeError("SSH2 channel failed: (SSH) Channel open failure: open failed", "network"),
      new RuntimeError(
        "SSH connection to example.test is in backoff for 2s. Last error: Connection timed out",
        "network"
      ),
    ]) {
      const reader = new ScriptedSSHRuntime([
        { reject: failure },
        { stdout: "# rules", exitCode: 0 },
      ]);
      expect(await read(reader)).toBe("# rules");
      const resolver = new ScriptedSSHRuntime([
        { reject: failure },
        { stdout: "/home/u/.xum\n", exitCode: 0 },
      ]);
      expect(await settle(resolver.resolvePath("~/.xum"))).toBe("/home/u/.xum");
    }
  });

  it("never retries a read that already delivered bytes", async () => {
    // The consumer already holds the first chunk; a second cat would repeat it.
    const reader = new ScriptedSSHRuntime([{ stdout: "partial", stderr: REFUSED, exitCode: 255 }]);
    expect(isRuntimeTransportError(await read(reader))).toBe(true);
    expect(reader.calls).toHaveLength(1);
  });

  it("never retries after the caller aborted", async () => {
    const readAbort = new AbortController();
    const reader = new ScriptedSSHRuntime([refused, refused], () => readAbort.abort());
    expect(await read(reader, "/remote/AGENTS.md", readAbort.signal)).toBeInstanceOf(Error);
    expect(reader.calls).toHaveLength(1);

    const statAbort = new AbortController();
    const stater = new ScriptedSSHRuntime([refused, refused], () => statAbort.abort());
    expect(await stat(stater, statAbort.signal)).toBeInstanceOf(Error);
    expect(stater.calls).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "retries only a regular file, never a FIFO the failed attempt may have drained, and keeps the first error",
    async () => {
      // The first attempt fails in transport (before any remote process); the
      // retry runs in a real local shell against a FIFO that has a writer.
      class BlipThenLocalShell extends TestRemoteRuntime {
        spawns = 0;
        protected override quoteForRemote(filePath: string): string {
          return shellQuote(filePath);
        }
        protected override cdCommand(cwd: string): string {
          return `cd ${shellQuote(cwd)}`;
        }
        protected override getBasePath(): string {
          return os.tmpdir();
        }
        // Optional only to stay assignable to TestRemoteRuntime's zero-argument stub.
        protected override spawnRemoteProcess(fullCommand?: string): Promise<SpawnResult> {
          if (this.spawns++ === 0) {
            return Promise.reject(new RuntimeError("Connection reset", "network"));
          }
          const child = spawn("bash", ["-c", fullCommand ?? "exit 1"], { stdio: "pipe" });
          return Promise.resolve({ process: child });
        }
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-read-retry-fifo-"));
      const fifo = path.join(dir, "AGENTS.md");
      execFileSync("mkfifo", [fifo]);
      const writer = execFile("sh", ["-c", 'printf "next writer" > "$0"', fifo]);
      try {
        const runtime = new BlipThenLocalShell();
        const result = await settle(new Response(runtime.readFile(fifo)).text());
        // The retry ran, refused the FIFO without reading the writer's data,
        // and the caller still gets the original, retryable transport error.
        expect(runtime.spawns).toBe(2);
        expect(isRuntimeTransportError(result)).toBe(true);
        expect(String(result)).toContain("Connection reset");
      } finally {
        writer.kill("SIGKILL");
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe("real SSH2 acquisition failure shapes (#5034)", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    ssh2ConnectionPool.clearAllHealthForTests();
    await cleanup?.();
    cleanup = undefined;
  });

  // The predicate matches error text, so check it against what the real ssh2 client and pool
  // produce, not only against hand-written messages. ECDSA keys: ssh2's ed25519 generator
  // emits an unparseable key ~0.4% of the time under Bun.
  const newPrivateKey = () => utils.generateKeyPairSync("ecdsa", { bits: 256 }).private;

  async function startServer(onConnection: ConstructorParameters<typeof Server>[1]) {
    const server = new Server({ hostKeys: [newPrivateKey()] }, onConnection);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-ssh-acquire-"));
    const identityFile = path.join(dir, "id_ecdsa");
    await fs.writeFile(identityFile, newPrivateKey(), { mode: 0o600 });
    const config: SSHRuntimeConfig = {
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      identityFile,
      srcBaseDir: "/remote/src",
    };
    const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup = async () => {
      await close().catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    };
    return { config, close };
  }

  // maxWaitMs 0: one connection attempt, without the pool's own wait loop.
  const acquireOnce = (config: SSHRuntimeConfig) =>
    createSSHTransport(config, true)
      .acquireConnection({ maxWaitMs: 0 })
      .then(
        () => new Error("acquisition unexpectedly succeeded"),
        (error: unknown) => error
      );

  it("a rejected key is a transport failure that does not retry", async () => {
    let connections = 0;
    const { config } = await startServer((conn) => {
      connections++;
      conn.on("authentication", (ctx) => ctx.reject());
      conn.on("error", () => undefined);
    });
    const error = await acquireOnce(config);
    expect(isRuntimeTransportError(error)).toBe(true);
    expect(isRuntimeRetryableTransportError(error)).toBe(false);
    expect(connections).toBe(1);

    // In backoff, the pool's refusal repeats the authentication error: still no retry.
    const refusal = await acquireOnce(config);
    expect(String(refusal)).toContain("backoff");
    expect(isRuntimeRetryableTransportError(refusal)).toBe(false);
  });

  it("a refused connection stays retryable", async () => {
    const { config, close } = await startServer((conn) => conn.on("error", () => undefined));
    await close(); // Nothing listens on the port any more: ECONNREFUSED.
    const error = await acquireOnce(config);
    expect(isRuntimeTransportError(error)).toBe(true);
    expect(isRuntimeRetryableTransportError(error)).toBe(true);
  });
});
