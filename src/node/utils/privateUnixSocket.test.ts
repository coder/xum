/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `rejects` as non-thenable */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_UNIX_SOCKET_PATH_BYTES, preparePrivateUnixSocketPath } from "./privateUnixSocket";

const posix = process.platform !== "win32";

describe.skipIf(!posix)("preparePrivateUnixSocketPath", () => {
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
    await preparePrivateUnixSocketPath(socketPath);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    await preparePrivateUnixSocketPath(socketPath);
  });

  test("refuses a folder that other users can enter", async () => {
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    await expect(preparePrivateUnixSocketPath(socketPath)).rejects.toThrow(/private|0700/);
  });

  test("refuses a symlink in place of the folder", async () => {
    const elsewhere = path.join(base, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, dir);
    await expect(preparePrivateUnixSocketPath(socketPath)).rejects.toThrow(
      /not a directory|symlink/
    );
  });

  test("refuses a folder owned by another user", async () => {
    await fs.mkdir(dir, { mode: 0o700 });
    await expect(preparePrivateUnixSocketPath(socketPath, process.getuid!() + 1)).rejects.toThrow(
      /owned by another user/
    );
  });

  test("names the length limit, and creates nothing, for a path that cannot fit", async () => {
    const long = path.join(base, "x".repeat(MAX_UNIX_SOCKET_PATH_BYTES), "b.sock");
    const error = await preparePrivateUnixSocketPath(long).then(
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
    await preparePrivateUnixSocketPath(exact);
    await expect(preparePrivateUnixSocketPath(`${exact}s`)).rejects.toThrow(/too long/);
  });

  test("removes a stale socket that a crashed run left in the folder", async () => {
    await preparePrivateUnixSocketPath(socketPath);
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

    await preparePrivateUnixSocketPath(socketPath);
    await expect(fs.lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    // The path is usable again.
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("never removes something at the socket path that is not a socket", async () => {
    await preparePrivateUnixSocketPath(socketPath);
    await fs.writeFile(socketPath, "precious");
    await expect(preparePrivateUnixSocketPath(socketPath)).rejects.toThrow(/not a socket/);
    expect(await fs.readFile(socketPath, "utf8")).toBe("precious");

    await fs.rm(socketPath);
    await fs.symlink(path.join(base, "target"), socketPath);
    await expect(preparePrivateUnixSocketPath(socketPath)).rejects.toThrow(/not a socket/);
    expect((await fs.lstat(socketPath)).isSymbolicLink()).toBe(true);
  });
});
