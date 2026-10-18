/**
 * #6923: aborting a command through RemoteRuntime (Docker, SSH) must stop the command on the
 * remote side, not only the local client. Docker's `docker exec` does not pass SIGTERM to the
 * process it started, and an OpenSSH client's exit sends no signal to a command without a pty.
 * One SSH test container serves all three paths: SSH (OpenSSH and the SSH2 transport) through
 * its port, Docker through `docker exec <container>`.
 */
import { execFileSync } from "child_process";
import {
  isDockerAvailable,
  startSSHServer,
  stopSSHServer,
  type SSHServerConfig,
} from "./test-fixtures/ssh-fixture";
import { shouldRunIntegrationTests } from "../testUtils";
import { DockerRuntime } from "@/node/runtime/DockerRuntime";
import { SSHRuntime } from "@/node/runtime/SSHRuntime";
import { createSSHTransport } from "@/node/runtime/transports";
import type { Runtime } from "@/node/runtime/Runtime";
import { EXIT_CODE_ABORTED } from "@/common/constants/exitCodes";
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";
import { ssh2ConnectionPool } from "@/node/runtime/SSH2ConnectionPool";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

let sshConfig: SSHServerConfig | undefined;

function sshRuntime(config: SSHServerConfig, useSSH2: boolean): Runtime {
  const runtimeConfig = {
    host: "testuser@localhost",
    srcBaseDir: config.workdir,
    identityFile: config.privateKeyPath,
    port: config.port,
  };
  return new SSHRuntime(runtimeConfig, createSSHTransport(runtimeConfig, useSSH2));
}

/** The container's processes whose command line contains `needle`. */
function remoteProcesses(containerId: string, needle: string): string[] {
  const listing = execFileSync("docker", ["exec", containerId, "ps", "-eo", "pid,args"], {
    encoding: "utf-8",
  });
  return listing.split("\n").filter((line) => line.includes(needle) && !line.includes("ps -eo"));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return condition();
}

describeIntegration("RemoteRuntime abort stops the remote command (#6923)", () => {
  beforeAll(async () => {
    if (!(await isDockerAvailable())) throw new Error("Docker is required for these tests");
    sshConfig = await startSSHServer();
  }, 180_000);

  afterAll(async () => {
    if (sshConfig) await stopSSHServer(sshConfig);
  }, 30_000);

  beforeEach(() => {
    sshConnectionPool.clearAllHealthForTests();
    ssh2ConnectionPool.clearAllHealthForTests();
  });

  const cases: [string, (config: SSHServerConfig) => { runtime: Runtime; cwd: string }][] = [
    [
      "Docker",
      (config) => ({
        runtime: new DockerRuntime({ image: "mux-ssh-test", containerName: config.containerId }),
        cwd: "/",
      }),
    ],
    ["SSH (OpenSSH)", (config) => ({ runtime: sshRuntime(config, false), cwd: "/home/testuser" })],
    [
      "SSH (SSH2 transport)",
      (config) => ({ runtime: sshRuntime(config, true), cwd: "/home/testuser" }),
    ],
  ];

  test.each(cases)("%s: an aborted sleep is gone from the remote side", async (_name, make) => {
    const config = sshConfig!;
    const { runtime, cwd } = make(config);
    // A unique duration identifies this command among the container's processes.
    const seconds = 3000 + Math.floor(Math.random() * 900);
    const needle = `sleep ${seconds}`;
    const abort = new AbortController();
    const stream = await runtime.exec(needle, { cwd, abortSignal: abort.signal, timeout: 120 });
    expect(
      await waitFor(() => remoteProcesses(config.containerId, needle).length > 0, 10_000)
    ).toBe(true);

    abort.abort();
    // The abort settles at once, and not only when the remote command ends (OpenSSH waited for
    // the remote `timeout` wrapper, 120 s here).
    const settled = await Promise.race([
      stream.exitCode,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 15_000)),
    ]);
    expect(settled).toBe(EXIT_CODE_ABORTED);
    const gone = await waitFor(
      () => remoteProcesses(config.containerId, needle).length === 0,
      5_000
    );
    expect(remoteProcesses(config.containerId, needle)).toEqual([]);
    expect(gone).toBe(true);
  });
});
