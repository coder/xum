import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { IPty } from "@lydell/node-pty";
import { toXumDaytonaHost } from "@/common/constants/daytona";
import * as ptySpawn from "../ptySpawn";
import { RuntimeError, isRuntimeTransportError } from "../Runtime";
import { sshConnectionPool } from "../sshConnectionPool";
import { OpenSSHTransport, retireOpenSSHMasters } from "./OpenSSHTransport";

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
  it("force strict host key checking, as every other ssh call to the alias does", async () => {
    spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(undefined);
    const spawnPty = spyOn(ptySpawn, "spawnPtyProcess").mockReturnValue({} as IPty);
    const host = toXumDaytonaHost("sb-1");

    await new OpenSSHTransport({ host }).createPtySession({
      workspacePath: "~/src/project/feature",
      cols: 80,
      rows: 24,
    });

    const args = spawnPty.mock.calls[0][0].args;
    // Command-line options beat a user `Host *` entry with `StrictHostKeyChecking no`.
    const strict = args.findIndex(
      (arg, i) => args[i - 1] === "-o" && arg === "StrictHostKeyChecking=yes"
    );
    expect(strict).toBeGreaterThan(-1);
    expect(strict).toBeLessThan(args.indexOf(host));
  });
});

describe("retireOpenSSHMasters", () => {
  it("stops every exec ControlMaster of the host that has a socket", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-fake-ssh-"));
    const calls = path.join(dir, "calls");
    // A fake ssh on PATH records its arguments, one call per line.
    await fs.writeFile(path.join(dir, "ssh"), `#!/bin/sh\necho "$@" >> ${calls}\n`, {
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    const config = { host: toXumDaytonaHost("sb-retire") };
    const base = sshConnectionPool.getControlPath(config);
    // Two masters are up: the default path and one exec shard.
    await fs.writeFile(base, "");
    await fs.writeFile(`${base}-2`, "");
    try {
      await retireOpenSSHMasters(config);

      const lines = (await fs.readFile(calls, "utf-8")).trim().split("\n").sort();
      expect(lines).toEqual([
        `-F /dev/null -S ${base} -O stop ${config.host}`,
        `-F /dev/null -S ${base}-2 -O stop ${config.host}`,
      ]);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(base, { force: true });
      await fs.rm(`${base}-2`, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
