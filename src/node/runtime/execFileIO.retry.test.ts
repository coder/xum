import { describe, expect, it } from "bun:test";
import {
  type ExecOptions,
  type ExecStream,
  RuntimeError,
  isRuntimeReadFailure,
  isRuntimeTransportError,
} from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import type { SSHTransport } from "./transports";

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
});
