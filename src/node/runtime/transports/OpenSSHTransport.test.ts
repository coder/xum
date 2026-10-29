import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { IPty } from "@lydell/node-pty";
import { toXumDaytonaHost } from "@/common/constants/daytona";
import * as ptySpawn from "../ptySpawn";
import { RuntimeError, isRuntimeTransportError } from "../Runtime";
import { sshConnectionPool } from "../sshConnectionPool";
import { getDaytonaSshConfigPath } from "../daytonaSshConfig";
import { OpenSSHTransport } from "./OpenSSHTransport";

const BACKOFF_MESSAGE =
  "SSH connection to example.test is in backoff for 2s. Last error: Connection refused";

afterEach(() => mock.restore());

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("OpenSSHTransport connection acquisition failures", () => {
  it("surface as transport failures with the pool's message", async () => {
    spyOn(sshConnectionPool, "acquireConnection").mockRejectedValue(new Error(BACKOFF_MESSAGE));
    const transport = new OpenSSHTransport({ host: "example.test" });

    for (const attempt of [
      () => transport.spawnRemoteProcess("cat AGENTS.md", {}),
      () => transport.acquireConnection(),
    ]) {
      const error = await rejection(attempt());
      expect(isRuntimeTransportError(error)).toBe(true);
      expect((error as Error).message).toBe(BACKOFF_MESSAGE);
    }
  });

  it("keep an aborted acquisition out of the transport class", async () => {
    const abortError = new Error("Operation aborted");
    spyOn(sshConnectionPool, "acquireConnection").mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort();
    const transport = new OpenSSHTransport({ host: "example.test" });

    const error = await rejection(
      transport.spawnRemoteProcess("cat AGENTS.md", { abortSignal: controller.signal })
    );
    expect(error).toBe(abortError);
    expect(error).not.toBeInstanceOf(RuntimeError);
  });
});

describe("OpenSSHTransport terminals on a Daytona alias", () => {
  async function terminalArgs(host: string): Promise<string[]> {
    spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(undefined);
    const spawnPty = spyOn(ptySpawn, "spawnPtyProcess").mockReturnValue({} as IPty);
    await new OpenSSHTransport({ host }).createPtySession({
      workspacePath: "~/src/project/feature",
      cols: 80,
      rows: 24,
    });
    return spawnPty.mock.calls[0][0].args;
  }

  const logLevels = (args: string[]) => args.filter((arg) => arg.startsWith("LogLevel="));

  it("read only Xum's include file, as every other ssh call to the alias does", async () => {
    const host = toXumDaytonaHost("sb-1");
    const args = await terminalArgs(host);
    const configFile = args.indexOf("-F");
    expect(args[configFile + 1]).toBe(getDaytonaSshConfigPath());
    expect(configFile).toBeGreaterThan(-1);
    expect(configFile).toBeLessThan(args.indexOf(host));
  });

  // The token is the ssh user name, and ssh prints `<user>@<host>: Permission denied` at FATAL.
  it("print no ssh messages, so a refused token never reaches the terminal", async () => {
    expect(logLevels(await terminalArgs(toXumDaytonaHost("sb-1")))).toEqual(["LogLevel=QUIET"]);
    mock.restore();
    expect(logLevels(await terminalArgs("example.test"))).toEqual(["LogLevel=FATAL"]);
  });
});
