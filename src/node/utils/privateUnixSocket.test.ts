/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `rejects` as non-thenable */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { assertLockPathUsable, withPrivateUnixSocketPath } from "./privateUnixSocket";
import { MAX_UNIX_SOCKET_PATH_BYTES } from "./privateUnixSocketFolder";

const posix = process.platform !== "win32";

/** Everything that runs before the bind: folder checks, the lock, and the stale-socket removal. */
const prepare = (socketPath: string, ownerUid?: number) =>
  withPrivateUnixSocketPath(socketPath, () => Promise.resolve(undefined), ownerUid);

function listenOn(server: net.Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function connects(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const client = net.connect(socketPath, () => client.end(() => resolve(true)));
    client.once("error", () => resolve(false));
  });
}

describe.skipIf(!posix)("withPrivateUnixSocketPath", () => {
  let base: string;
  let dir: string;
  let socketPath: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "xum-sock-test-"));
    dir = path.join(base, "run");
    socketPath = path.join(dir, "b.sock");
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  test("creates the folder with mode 0700 and accepts it again", async () => {
    await prepare(socketPath);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    await prepare(socketPath);
  });

  test("refuses a folder that other users can enter", async () => {
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    await expect(prepare(socketPath)).rejects.toThrow(/private|0700/);
  });

  test("refuses a symlink in place of the folder", async () => {
    const elsewhere = path.join(base, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, dir);
    await expect(prepare(socketPath)).rejects.toThrow(/not a directory|symlink/);
  });

  // /usr is a real folder that another user (root) owns.
  test.skipIf(process.getuid?.() === 0)("refuses a folder owned by another user", async () => {
    await expect(prepare("/usr/xum-never-created.sock")).rejects.toThrow(/owned by another user/);
  });

  test("refuses a parent folder owned by another user", async () => {
    await fs.mkdir(dir, { mode: 0o700 });
    await expect(prepare(socketPath, process.getuid!() + 1)).rejects.toThrow(
      /parent folder .*owned by another user/
    );
  });

  test("names the length limit, and creates nothing, for a path that cannot fit", async () => {
    const long = path.join(base, "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES), "b.sock");
    const error = await prepare(long).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(String(MAX_UNIX_SOCKET_PATH_BYTES));
    expect((error as Error).message).toMatch(/too long/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  test("accepts a path of exactly the limit and refuses one byte more", async () => {
    const prefix = `${base}${path.sep}d${path.sep}`;
    const exact = `${prefix}${"s".repeat(MAX_UNIX_SOCKET_PATH_BYTES - Buffer.byteLength(prefix))}`;
    expect(Buffer.byteLength(exact)).toBe(MAX_UNIX_SOCKET_PATH_BYTES);
    await prepare(exact);
    await expect(prepare(`${exact}s`)).rejects.toThrow(/too long/);
  });

  test("removes a stale socket that a crashed run left in the folder", async () => {
    await prepare(socketPath);
    // A server that dies without closing leaves its socket file behind.
    const crash = Bun.spawn(
      [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, "SIGKILL"))`,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    await crash.exited;
    expect((await fs.lstat(socketPath)).isSocket()).toBe(true);

    await prepare(socketPath);
    await expect(fs.lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    // The path is usable again.
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Someone who can write to a parent folder can rename the verified folder away and put their own
  // in its place, so a 0700 folder is private only if no other user can modify its parents.
  describe("parent folders", () => {
    let shared: string;

    beforeEach(async () => {
      shared = path.join(base, "shared");
      await fs.mkdir(shared);
    });

    test("refuses a parent that other users can write to", async () => {
      await fs.chmod(shared, 0o777);
      const underShared = path.join(shared, "run", "b.sock");
      await expect(prepare(underShared)).rejects.toThrow(/parent folder .*writable by other users/);
      // It must not leave a folder behind for someone to swap.
      expect(await fs.readdir(shared)).toEqual([]);
    });

    test("refuses a group-writable parent", async () => {
      await fs.chmod(shared, 0o770);
      await expect(prepare(path.join(shared, "run", "b.sock"))).rejects.toThrow(
        /writable by other users/
      );
    });

    test("accepts a sticky parent, which stops others from renaming our folder (like /tmp)", async () => {
      await fs.chmod(shared, 0o1777);
      await prepare(path.join(shared, "run", "b.sock"));
    });

    test("checks every ancestor, not only the parent", async () => {
      await fs.chmod(shared, 0o777);
      const inner = path.join(shared, "inner");
      await fs.mkdir(inner, { mode: 0o700 });
      await expect(prepare(path.join(inner, "run", "b.sock"))).rejects.toThrow(
        /writable by other users/
      );
    });

    test("checks where a symlinked parent leads", async () => {
      await fs.chmod(shared, 0o777);
      const link = path.join(base, "link");
      await fs.symlink(shared, link);
      await expect(prepare(path.join(link, "run", "b.sock"))).rejects.toThrow(
        /writable by other users/
      );
    });

    test("accepts a symlink to a private parent", async () => {
      const link = path.join(base, "link");
      await fs.symlink(shared, link);
      await prepare(path.join(link, "run", "b.sock"));
    });
  });

  test("refuses to remove the socket of a server that is still listening", async () => {
    await prepare(socketPath);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(prepare(socketPath)).rejects.toThrow(/in use/);
      // The live server must still own the path.
      await new Promise<void>((resolve, reject) => {
        const client = net.connect(socketPath, () => client.end(resolve));
        client.once("error", reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("never removes something at the socket path that is not a socket", async () => {
    await prepare(socketPath);
    await fs.writeFile(socketPath, "precious");
    await expect(prepare(socketPath)).rejects.toThrow(/not a socket/);
    expect(await fs.readFile(socketPath, "utf8")).toBe("precious");

    await fs.rm(socketPath);
    await fs.symlink(path.join(base, "target"), socketPath);
    await expect(prepare(socketPath)).rejects.toThrow(/not a socket/);
    expect((await fs.lstat(socketPath)).isSymbolicLink()).toBe(true);
  });

  // A socket file that no server holds: what a SIGKILLed backend leaves. Hard links of it stand in
  // for a fresh crash leftover in every round of a race test.
  async function makeStaleSocketTemplate(): Promise<string> {
    const template = path.join(base, "stale-template.sock");
    const crash = Bun.spawn(
      [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(template)}, () => process.kill(process.pid, "SIGKILL"))`,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    await crash.exited;
    expect((await fs.lstat(template)).isSocket()).toBe(true);
    return template;
  }

  describe("two starts on one socket path", () => {
    // Without the lock, both starts read the stale socket as stale, the first unlinks and binds, and
    // the second then unlinks the first one's live socket and binds too: the first server keeps
    // listening on a name nobody can reach, and its Vite proxy talks to the wrong backend.
    test("exactly one binds, the other is refused as in use, and the winner still answers", async () => {
      const template = await makeStaleSocketTemplate();
      await fs.mkdir(dir, { mode: 0o700 });
      for (let round = 0; round < 25; round++) {
        await fs.link(template, socketPath);
        const servers = [net.createServer(), net.createServer()];
        const results = await Promise.allSettled(
          servers.map((server) =>
            withPrivateUnixSocketPath(socketPath, () => listenOn(server, socketPath))
          )
        );
        const winners = results.flatMap((result, i) => (result.status === "fulfilled" ? [i] : []));
        expect(
          winners,
          `round ${round}: ${JSON.stringify(results.map((r) => r.status))}`
        ).toHaveLength(1);
        const refusals = results.flatMap((result) =>
          result.status === "rejected" ? [String(result.reason)] : []
        );
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatch(/in use/);
        expect(await connects(socketPath)).toBe(true);
        await closeServer(servers[winners[0]]);
        await fs.rm(socketPath, { force: true });
      }
    }, 60_000);

    test("the same race between two processes", async () => {
      const template = await makeStaleSocketTemplate();
      await fs.mkdir(dir, { mode: 0o700 });
      const child = path.join(import.meta.dir, "privateUnixSocket.raceChild.ts");
      for (let round = 0; round < 8; round++) {
        await fs.link(template, socketPath);
        const procs = [0, 1].map(() =>
          Bun.spawn([process.execPath, child, socketPath], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
          })
        );
        // Each child prints one line, "bound" or "refused: <why>", then holds the socket until stdin closes.
        const lines = await Promise.all(
          procs.map(async (proc) => {
            const reader = proc.stdout.getReader();
            const { value } = await reader.read();
            return new TextDecoder().decode(value).trim();
          })
        );
        const bound = lines.filter((line) => line === "bound");
        expect(bound, `round ${round}: ${JSON.stringify(lines)}`).toHaveLength(1);
        expect(lines.find((line) => line !== "bound")).toMatch(/^refused: .*in use/);
        expect(await connects(socketPath)).toBe(true);
        for (const proc of procs) {
          void proc.stdin.end();
          await proc.exited;
        }
        await fs.rm(socketPath, { force: true });
      }
    }, 120_000);

    test("a start waits while another process holds the lock, then goes on", async () => {
      await fs.mkdir(dir, { mode: 0o700 });
      const lock = await acquireProcessFileLock({
        lockPath: `${socketPath}.lock`,
        createParentDir: false,
        timeoutMs: 5_000,
        label: "test lock",
      });
      const server = net.createServer();
      let bound = false;
      const start = withPrivateUnixSocketPath(socketPath, async () => {
        await listenOn(server, socketPath);
        bound = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bound).toBe(false);
      await lock[Symbol.asyncDispose]();
      await start;
      expect(bound).toBe(true);
      expect(await connects(socketPath)).toBe(true);
      await closeServer(server);
    });

    test("the lock is gone after the bind, and after a failed bind", async () => {
      await prepare(socketPath);
      await expect(fs.lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        withPrivateUnixSocketPath(socketPath, () => Promise.reject(new Error("bind failed")))
      ).rejects.toThrow(/bind failed/);
      await expect(fs.lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("the lock path", () => {
    test("refuses a symlink and never follows it", async () => {
      await fs.mkdir(dir, { mode: 0o700 });
      const target = path.join(base, "lock-target");
      await fs.writeFile(target, "precious");
      await fs.symlink(target, `${socketPath}.lock`);
      await expect(prepare(socketPath)).rejects.toThrow(/lock .*symlink|not a regular file/);
      expect(await fs.readFile(target, "utf8")).toBe("precious");
      expect((await fs.lstat(`${socketPath}.lock`)).isSymbolicLink()).toBe(true);
    });

    // Called on its own: through withPrivateUnixSocketPath a foreign uid fails the folder check first,
    // and only root could make a file of another user inside our private folder. The file here is
    // ours, and the expected owner is not.
    test("refuses a lock file that another user owns", async () => {
      await fs.mkdir(dir, { mode: 0o700 });
      const lockPath = `${socketPath}.lock`;
      await fs.writeFile(lockPath, "someone else", { mode: 0o600 });
      await expect(assertLockPathUsable(lockPath, process.getuid!() + 1)).rejects.toThrow(
        /owned by another user/
      );
      await assertLockPathUsable(lockPath, process.getuid!());
    });

    test("accepts a missing lock file", async () => {
      await fs.mkdir(dir, { mode: 0o700 });
      await assertLockPathUsable(`${socketPath}.lock`, process.getuid!());
    });

    test("refuses a lock path that is a folder", async () => {
      await fs.mkdir(dir, { mode: 0o700 });
      await fs.mkdir(`${socketPath}.lock`);
      await expect(prepare(socketPath)).rejects.toThrow(/not a regular file/);
    });
  });
});
