import { describe, expect, it } from "bun:test";
import { type ExecOptions, type ExecStream, isRuntimeTransportError } from "./Runtime";
import { SSHRuntime } from "./SSHRuntime";
import type { SSHRuntimeConfig } from "./sshConnectionPool";
import { TestRemoteRuntime } from "./testRemoteRuntime";
import type { SSHTransport } from "./transports";

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
  constructor(private readonly result: [stderr: string, exitCode: number]) {
    const config: SSHRuntimeConfig = { host: "example.test", srcBaseDir: "/remote/src" };
    // OpenSSH semantics: exit 255 is the ssh client's own connection failure.
    const transport: SSHTransport = {
      isConnectionFailure: (exitCode) => exitCode === 255,
      acquireConnection: () => Promise.resolve(),
      getConfig: () => config,
      spawnRemoteProcess: () => Promise.reject(new Error("exec is stubbed")),
      createPtySession: () => Promise.reject(new Error("no PTY here")),
    };
    super(config, transport);
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
