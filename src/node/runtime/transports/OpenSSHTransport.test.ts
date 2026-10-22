import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { IPty } from "@lydell/node-pty";
import { toXumDaytonaHost } from "@/common/constants/daytona";
import * as ptySpawn from "../ptySpawn";
import { RuntimeError, isRuntimeTransportError } from "../Runtime";
import { sshConnectionPool } from "../sshConnectionPool";
import { getDaytonaSshConfigPath } from "../daytonaSshConfig";
import { OpenSSHTransport, retireOpenSSHMasters } from "./OpenSSHTransport";
import { retireSshConnections } from "./index";

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

  it("never sends a later command to a master that was still connecting at the retirement", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-fake-ssh-"));
    const calls = path.join(dir, "calls");
    await fs.writeFile(path.join(dir, "ssh"), `#!/bin/sh\necho "$@" >> ${calls}\n`, {
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(undefined);
    const config = { host: toXumDaytonaHost("sb-connecting") };
    const base = sshConnectionPool.getControlPath(config);
    const oldPaths = [base, ...Array.from({ length: 8 }, (_, shard) => `${base}-${shard}`)];
    try {
      // No socket yet: a master is still authenticating with the old credentials.
      await retireOpenSSHMasters(config);
      // It finishes after the retirement and listens at its old path.
      for (const oldPath of oldPaths) await fs.writeFile(oldPath, "");

      const transport = new OpenSSHTransport(config);
      for (let i = 0; i < 8; i++) {
        const { process: child } = await transport.spawnRemoteProcess("true", {});
        await new Promise((resolve) => child.once("close", resolve));
      }

      const used = (await fs.readFile(calls, "utf-8"))
        .trim()
        .split("\n")
        .map((line) => /ControlPath=(\S+)/.exec(line)?.[1]);
      expect(used).toHaveLength(8);
      for (const controlPath of used) expect(oldPaths).not.toContain(controlPath);
    } finally {
      process.env.PATH = originalPath;
      for (const oldPath of oldPaths) await fs.rm(oldPath, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OpenSSH reverse forwards", () => {
  it("ends a forward an earlier process left when its host is retired", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-fake-ssh-"));
    // A fake ssh: `-N` runs a master that holds its ControlPath until it exits; the control
    // commands (`-O check|forward|exit|stop`) act on the master at `-S`.
    await fs.writeFile(
      path.join(dir, "ssh"),
      `#!/bin/sh
socket=""; op=""; prev=""; master=no
for arg in "$@"; do
  case "$prev" in -S) socket="$arg" ;; -O) op="$arg" ;; esac
  case "$arg" in ControlPath=*) socket="\${arg#ControlPath=}" ;; -N) master=yes ;; esac
  prev="$arg"
done
if [ "$master" = yes ]; then
  echo $$ > "$socket.pid"; echo $$ > "${dir}/master.pid"; : > "$socket"
  trap 'rm -f "$socket" "$socket.pid"; exit 0' TERM
  while :; do sleep 0.05; done
fi
case "$op" in
  check|forward) [ -e "$socket" ] ;;
  exit) [ -e "$socket.pid" ] && kill "$(cat "$socket.pid")" ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
    spyOn(sshConnectionPool, "acquireConnection").mockResolvedValue(undefined);
    const config = { host: toXumDaytonaHost("sb-forwarded") };
    let masterPid: number | undefined;
    try {
      const forward = await new OpenSSHTransport(config).openReverseForward(40123, 40124);
      const pid = Number(await fs.readFile(path.join(dir, "master.pid"), "utf-8"));
      masterPid = pid;
      expect(isAlive(pid)).toBe(true);
      // A restart: the new process holds no handle to the forward, which it adopts.
      void forward;

      await retireSshConnections(config);

      await waitFor(() => !isAlive(pid));
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (masterPid !== undefined && isAlive(masterPid)) process.kill(masterPid);
      process.env.PATH = originalPath;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
