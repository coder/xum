import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import { type ExecOptions, type ExecStream, isRuntimeTransportError } from "./Runtime";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import { TestRemoteRuntime } from "./testRemoteRuntime";
import { createSSHTransport, type SSHTransport } from "./transports";

// #4438: a remote probe that failed in transport (host unreachable) must be
// distinguishable from one that proved the file absent, so callers never read
// an SSH drop as "missing" and fall back to a lower-priority file or scope.

const REFUSED = "ssh: connect to host example.test port 22: Connection refused";
const MISSING = "cat: /remote/AGENTS.md: No such file or directory";

function execResult(stderr: string, exitCode: number): ExecStream {
  return {
    stdout: new Blob([""]).stream(),
    stderr: new Blob([stderr]).stream(),
    stdin: new WritableStream<Uint8Array>(),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

type Probed = Pick<SSHRuntime, "readFile" | "stat" | "resolvePath">;

async function failures(runtime: Probed, withResolve: boolean): Promise<unknown[]> {
  const probes: Array<() => Promise<unknown>> = [
    () => new Response(runtime.readFile("/remote/AGENTS.md")).text(),
    () => runtime.stat("/remote/AGENTS.md"),
  ];
  if (withResolve) probes.push(() => runtime.resolvePath("~/.xum/agents"));
  const errors: unknown[] = [];
  for (const probe of probes) {
    errors.push(
      await probe().then(
        () => new Error("expected a failure"),
        (error: unknown) => error
      )
    );
  }
  return errors;
}

class StubbedSSHRuntime extends SSHRuntime {
  constructor(
    private readonly result: [stderr: string, exitCode: number],
    workspace?: { projectPath: string; workspaceName: string }
  ) {
    const config: SSHRuntimeConfig = { host: "example.test", srcBaseDir: "/remote/src" };
    // OpenSSH semantics: exit 255 is the ssh client's own connection failure.
    const transport: SSHTransport = {
      isConnectionFailure: (exitCode) => exitCode === 255,
      acquireConnection: () => Promise.resolve(),
      getConfig: () => config,
      spawnRemoteProcess: () => Promise.reject(new Error("exec is stubbed")),
      createPtySession: () => Promise.reject(new Error("no PTY here")),
    };
    super(config, transport, workspace);
  }

  override exec(_command: string, _options: ExecOptions): Promise<ExecStream> {
    return Promise.resolve(execResult(...this.result));
  }
}

class StubbedRemoteRuntime extends TestRemoteRuntime {
  override exec(): Promise<ExecStream> {
    return Promise.resolve(execResult(REFUSED, 255));
  }
}

describe("transport failure classification", () => {
  it("marks SSH connection-failure exits on reads, stats and path resolution", async () => {
    const errors = await failures(new StubbedSSHRuntime([REFUSED, 255]), true);
    expect(errors.map(isRuntimeTransportError)).toEqual([true, true, true]);
  });

  it("keeps a missing file out of the transport class", async () => {
    const errors = await failures(new StubbedSSHRuntime([MISSING, 1]), true);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(errors.map(isRuntimeTransportError)).toEqual([false, false, false]);
  });

  it("leaves remote runtimes without a transport classifier unchanged", async () => {
    const errors = await failures(new StubbedRemoteRuntime(), false);
    expect(errors.map(isRuntimeTransportError)).toEqual([false, false]);
  });
});

// #4835: an SSH2 channel that fails AFTER it was acquired (the connection drops
// mid-exec or mid-read) must classify as transport too, through the real
// SSHRuntime → RemoteRuntime.exec → SSH2Transport path.
class FakeSSH2Channel extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  pipe<T extends NodeJS.WritableStream>(destination: T): T {
    return this.stdout.pipe(destination);
  }
  write(): boolean {
    return true;
  }
  end(): void {
    // stdin EOF: nothing to do.
  }
  signal(): void {
    // Remote signals are irrelevant here.
  }
  close(): void {
    this.dropStreams();
    this.emit("close");
  }
  /** What ssh2 does to open channels when the TCP connection dies: EOF, then close, no exit status. */
  dropStreams(): void {
    this.stdout.end();
    this.stderr.end();
  }
}

describe("SSH2 channel failures after acquisition (#4835)", () => {
  let channels: FakeSSH2Channel[];
  let client: EventEmitter & {
    exec: (command: string, cb: (err?: Error, stream?: unknown) => void) => void;
  };
  let acquire: ReturnType<typeof spyOn<typeof ssh2ConnectionPool, "acquireConnection">>;
  let reportFailure: ReturnType<typeof spyOn<typeof ssh2ConnectionPool, "reportFailure">>;

  beforeEach(() => {
    channels = [];
    client = Object.assign(new EventEmitter(), {
      exec: (_command: string, cb: (err?: Error, stream?: unknown) => void) => {
        const channel = new FakeSSH2Channel();
        channels.push(channel);
        cb(undefined, channel);
      },
    });
    acquire = spyOn(ssh2ConnectionPool, "acquireConnection").mockResolvedValue({
      client,
      openChannels: 0,
    } as never);
    reportFailure = spyOn(ssh2ConnectionPool, "reportFailure").mockImplementation(() => undefined);
  });

  afterEach(() => {
    acquire.mockRestore();
    reportFailure.mockRestore();
  });

  function ssh2Runtime(): SSHRuntime {
    const config: SSHRuntimeConfig = { host: "example.test", srcBaseDir: "/remote/src" };
    return new SSHRuntime(config, createSSHTransport(config, true));
  }

  /** Starts the reads and stats, waits for their channels to open, then applies `fail` to each. */
  async function probeWith(
    fail: (channel: FakeSSH2Channel) => void,
    abortSignal?: AbortSignal
  ): Promise<unknown[]> {
    const runtime = ssh2Runtime();
    const pending = [
      new Response(runtime.readFile("/remote/AGENTS.md", abortSignal)).text(),
      runtime.stat("/remote/AGENTS.md", abortSignal),
    ].map((probe) =>
      probe.then(
        () => new Error("expected a failure"),
        (error: unknown) => error
      )
    );
    while (channels.length < pending.length) await new Promise((r) => setTimeout(r, 1));
    for (const channel of channels) fail(channel);
    return Promise.all(pending);
  }

  it("classifies a channel error after the channel opened as transport", async () => {
    const errors = await probeWith((channel) => {
      channel.emit("error", new Error("read ECONNRESET"));
    });
    expect(errors.map(isRuntimeTransportError)).toEqual([true, true]);
  });

  it("classifies a connection that closes before the command exited as transport", async () => {
    const errors = await probeWith((channel) => {
      // ssh2 order on a dead socket: the client closes first, then its open
      // channels close with EOF and no exit status.
      client.emit("close");
      channel.dropStreams();
      channel.emit("close");
    });
    expect(errors.map(isRuntimeTransportError)).toEqual([true, true]);
  });

  it("keeps an aborted exec out of the transport class", async () => {
    const controller = new AbortController();
    const errors = await probeWith((channel) => {
      controller.abort();
      channel.emit("error", new Error("Channel closed by abort"));
    }, controller.signal);
    expect(errors.every((error) => error instanceof Error)).toBe(true);
    expect(errors.map(isRuntimeTransportError)).toEqual([false, false]);
  });
});

// #4825: a probe that hit its own client-side deadline proved nothing about the
// file. A stalled SSH link (e.g. `docker pause` on sshd) reaches the 10 s stat
// deadline before keepalives notice the dead peer, so trivial non-login probes
// must not read it as "missing" and ensureReady must stay retryable.
describe("client-side probe timeouts on SSH (#4825)", () => {
  it("marks timed-out reads and stats as transport, but not login-shell path resolution", async () => {
    // resolvePath runs `bash -lc`: slow login shells must keep failing as a
    // plain resolution error, not a transport outage on every turn.
    const errors = await failures(new StubbedSSHRuntime(["", EXIT_CODE_TIMEOUT]), true);
    expect(errors.map(isRuntimeTransportError)).toEqual([true, true, false]);
  });

  it("reports a timed-out repository check as a retryable start failure", async () => {
    const workspace = { projectPath: "/local/project", workspaceName: "feature" };
    const timedOut = await new StubbedSSHRuntime(["", EXIT_CODE_TIMEOUT], workspace).ensureReady();
    expect(timedOut).toMatchObject({ ready: false, errorType: "runtime_start_failed" });

    // A real missing checkout stays permanent.
    const missing = await new StubbedSSHRuntime(["missing .git", 10], workspace).ensureReady();
    expect(missing).toMatchObject({ ready: false, errorType: "runtime_not_ready" });
  });
});
