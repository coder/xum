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
  it("read only Xum's include file, as every other ssh call to the alias does", async () => {
    spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(undefined);
    const spawnPty = spyOn(ptySpawn, "spawnPtyProcess").mockReturnValue({} as IPty);
    const host = toXumDaytonaHost("sb-1");

    await new OpenSSHTransport({ host }).createPtySession({
      workspacePath: "~/src/project/feature",
      cols: 80,
      rows: 24,
    });

    const args = spawnPty.mock.calls[0][0].args;
    const configFile = args.indexOf("-F");
    expect(args[configFile + 1]).toBe(getDaytonaSshConfigPath());
    expect(configFile).toBeGreaterThan(-1);
    expect(configFile).toBeLessThan(args.indexOf(host));
  });
});
