import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { EXIT_CODE_TIMEOUT } from "@/common/constants/exitCodes";
import {
  type ExecOptions,
  type ExecStream,
  isRuntimePathAbsentError,
  isRuntimeReadFailure,
  isRuntimeTransportError,
} from "./Runtime";
import { ssh2ConnectionPool } from "./SSH2ConnectionPool";
import { SSHRuntime } from "./SSHRuntime";
import { DockerRuntime } from "./DockerRuntime";
import { DevcontainerRuntime } from "./DevcontainerRuntime";
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

// #4827: only a positively absent file may read as missing. Every other failed
// read (permission denied, I/O error) must stop a fallback chain too.
describe("read failure vs positive absence", () => {
  const classify = async (stderr: string) =>
    (await failures(new StubbedSSHRuntime([stderr, 1]), false)).map((error) => ({
      absent: isRuntimePathAbsentError(error),
      readFailure: isRuntimeReadFailure(error),
    }));
  const absent = { absent: true, readFailure: false };
  const unreadable = { absent: false, readFailure: true };

  it("treats the tool's own ENOENT/ENOTDIR diagnostics as absence", async () => {
    expect(await classify(MISSING)).toEqual([absent, absent]);
    expect(await classify("stat: cannot statx '/remote/AGENTS.md/x': Not a directory")).toEqual([
      absent,
      absent,
    ]);
  });

  it("treats permission and other errors as read failures", async () => {
    expect(await classify("cat: /remote/AGENTS.md: Permission denied")).toEqual([
      unreadable,
      unreadable,
    ]);
    // OpenSSH can warn about a missing identity file on a working connection:
    // that line must not turn the permission error into "missing".
    expect(
      await classify(
        "Warning: Identity file /k/id not accessible: No such file or directory.\n" +
          "cat: /remote/AGENTS.md: Permission denied"
      )
    ).toEqual([unreadable, unreadable]);
  });

  it("keeps transport failures in the read-failure class", async () => {
    const errors = await failures(new StubbedSSHRuntime([REFUSED, 255]), false);
    expect(errors.map((error) => isRuntimeReadFailure(error))).toEqual([true, true]);
  });
});

// #4828: a docker/devcontainer exec that never reached the container (stopped,
// paused, removed, daemon down) is a transport failure too. Stderr samples were
// captured from docker 27.5.1 and devcontainer CLI 0.87.0; all of them exit 1.
describe("container exec failures", () => {
  class StubbedDockerRuntime extends DockerRuntime {
    constructor(private readonly result: [stderr: string, exitCode: number]) {
      super({ image: "alpine:3", containerName: "ws" });
    }
    override exec(): Promise<ExecStream> {
      return Promise.resolve(execResult(...this.result));
    }
  }
  class StubbedDevcontainerRuntime extends DevcontainerRuntime {
    constructor(private readonly result: [stderr: string, exitCode: number]) {
      super({ srcBaseDir: "/tmp/mux", configPath: ".devcontainer/devcontainer.json" });
    }
    override exec(): Promise<ExecStream> {
      return Promise.resolve(execResult(...this.result));
    }
  }
  const unavailable = [
    "Error response from daemon: container d5b714b147cb is not running\n",
    "Error response from daemon: Container ws is paused, unpause the container before exec\n",
    "Error response from daemon: No such container: ws\n",
    "Cannot connect to the Docker daemon at unix:///tmp/nope.sock. Is the docker daemon running?\n",
    // Docker Desktop stopped on Windows (wording from docker/for-win#13137; not measured here).
    'error during connect: This error may indicate that the docker daemon is not running.: Get "http:////./pipe/docker_engine/v1.24/containers/json": open //./pipe/docker_engine: The system cannot find the file specified.\n',
    // #4985: any daemon refusal counts, not just the listed states (measured on docker 27.5.1).
    "Error response from daemon: Container 506af2d53fea is restarting, wait until the container is running\n",
    // #4985: newer clients' connection failure (moby client/request.go; not measured here).
    "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory\n",
  ];
  const devcontainerUnavailable = [
    "Shell server terminated (code: 1, signal: null)\n\n" + unavailable[0],
    "[2026-09-28T07:09:47.831Z] Error: Dev container not found.\n    at Ng (devContainersSpecCLI.js:473:1096)\n",
  ];
  // #5018: the OS refused the dial (a Windows named-pipe ACL, or EPERM). Only a
  // permission change fixes it. Windows wordings: older clients (docker/for-win
  // issues) and newer clients (moby client/request.go); not measured here.
  const ACCESS_DENIAL = /Access is denied\.|operation not permitted/;
  const accessDenied = [
    'error during connect: This error may indicate that the docker daemon is not running.: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/containers/json": open //./pipe/docker_engine: Access is denied.\n',
    "failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: Access is denied.\n",
    'error during connect: Get "http://10.0.0.5:2375/v1.47/containers/ws/json": dial tcp 10.0.0.5:2375: connect: operation not permitted\n',
  ];
  const transport = async (runtime: Probed) =>
    (await failures(runtime, false)).map((error) => isRuntimeTransportError(error));

  it("classifies an unavailable container as transport on reads and stats", async () => {
    for (const stderr of unavailable) {
      expect(await transport(new StubbedDockerRuntime([stderr, 1]))).toEqual([true, true]);
    }
    for (const stderr of [...unavailable, ...devcontainerUnavailable]) {
      expect(await transport(new StubbedDevcontainerRuntime([stderr, 1]))).toEqual([true, true]);
    }
    // An unresponsive daemon/CLI hits the probe deadline, often with empty stderr.
    expect(await transport(new StubbedDockerRuntime(["", EXIT_CODE_TIMEOUT]))).toEqual([
      true,
      true,
    ]);
    expect(await transport(new StubbedDevcontainerRuntime(["", EXIT_CODE_TIMEOUT]))).toEqual([
      true,
      true,
    ]);
  });

  it("keeps a missing file and an unstartable exec out of the transport class", async () => {
    const missing = "cat: can't open '/remote/AGENTS.md': No such file or directory\n";
    expect(await transport(new StubbedDockerRuntime([missing, 1]))).toEqual([false, false]);
    expect(await transport(new StubbedDevcontainerRuntime([missing, 1]))).toEqual([false, false]);
    // No bash in the image: retrying cannot fix it, so it stays a (loud) read failure.
    const noBash =
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "bash": executable file not found in $PATH: unknown\n';
    const errors = await failures(new StubbedDockerRuntime([noBash, 126]), false);
    expect(errors.map((error) => isRuntimeTransportError(error))).toEqual([false, false]);
    expect(errors.map((error) => isRuntimeReadFailure(error))).toEqual([true, true]);
    // #4985: permanent refusals (API version, authz plugin, socket permission) need a
    // configuration change, not a retry.
    for (const refusal of [
      "Error response from daemon: client version 1.52 is too new. Maximum supported API version is 1.47\n",
      "Error response from daemon: authorization denied by plugin opa-docker-authz: request rejected by administrative policy\n",
      "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: permission denied\n",
      ...accessDenied,
    ]) {
      const refused = await failures(new StubbedDockerRuntime([refusal, 1]), false);
      expect(refused.map((error) => isRuntimeTransportError(error))).toEqual([false, false]);
      expect(refused.map((error) => isRuntimeReadFailure(error))).toEqual([true, true]);
    }
    // Near miss: the same connection lines with a dial error that is not a denial
    // (the pipe/socket is simply absent) stay transport.
    for (const denied of accessDenied) {
      const absent = denied.replace(ACCESS_DENIAL, "The system cannot find the file specified.");
      expect(absent).not.toBe(denied);
      expect(await transport(new StubbedDockerRuntime([absent, 1]))).toEqual([true, true]);
    }
    // #5021: a probe SIGKILLed with empty output (exit 137) stays a read failure.
    // Measured on docker 27.5.1, a container killed mid-exec and a probe OOM-killed
    // inside a still-running container both give exactly this shape, so it does
    // not prove the container is gone.
    const killed = await failures(new StubbedDockerRuntime(["", 137]), false);
    expect(killed.map((error) => isRuntimeTransportError(error))).toEqual([false, false]);
    expect(killed.map((error) => isRuntimeReadFailure(error))).toEqual([true, true]);
    // #4985: a daemon line does not make an uninvokable command (exit 126/127) transport.
    const daemonNoBash = `Error response from daemon: ${noBash}`;
    for (const exitCode of [126, 127]) {
      expect(await transport(new StubbedDockerRuntime([daemonNoBash, exitCode]))).toEqual([
        false,
        false,
      ]);
    }
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
    // The one transport retry (#4830) must not find a healthy channel: refuse
    // every later open, which ssh2 reports through the exec callback.
    client.exec = (_command, cb) => cb(new Error("(SSH) Channel open failure: open failed"));
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
