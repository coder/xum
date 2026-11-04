import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chooseDevSocketPath, MAX_UNIX_SOCKET_PATH_BYTES } from "./privateUnixSocketFolder";

const posix = process.platform !== "win32";

// `make dev-server` asks for `<runtime dir>/xum-dev-<uid>/b<port>-<host>.sock`. Another account can
// create that folder first (in /tmp it is a name anyone can take), and the backend then refuses
// to put its socket there, so the dev server would never start. A folder that is not safely ours is
// replaced by a fresh private one next to it; the Vite hop never falls back to TCP.
describe.skipIf(!posix)("chooseDevSocketPath", () => {
  const uid = process.getuid!();
  let base: string;
  let preferred: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "xum-choose-test-"));
    preferred = path.join(base, `xum-dev-${uid}`);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  async function expectFreshPrivateFolder(socketPath: string): Promise<string> {
    const folder = path.dirname(socketPath);
    expect(folder).not.toBe(preferred);
    expect(path.dirname(folder)).toBe(base);
    expect(path.basename(folder).startsWith(`xum-dev-${uid}.`)).toBe(true);
    const stat = await fs.lstat(folder);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.uid).toBe(uid);
    expect(stat.mode & 0o777).toBe(0o700);
    return folder;
  }

  // make builds for a while between choosing the path and starting the backend, so a missing folder
  // is claimed at once: another account cannot take the name in between.
  test("a missing folder is created private and is the answer", async () => {
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice).toEqual({ socketPath: path.join(preferred, "b1.sock") });
    const stat = await fs.lstat(preferred);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.uid).toBe(uid);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  test("a default path that cannot fit is refused before the folder is created", async () => {
    const error = await chooseDevSocketPath(
      preferred,
      "s".repeat(MAX_UNIX_SOCKET_PATH_BYTES),
      uid
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/too long/);
    expect(await fs.readdir(base)).toEqual([]);
  });

  test("a private folder of ours is the answer", async () => {
    await fs.mkdir(preferred, { mode: 0o700 });
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice).toEqual({ socketPath: path.join(preferred, "b1.sock") });
    expect(await fs.readdir(base)).toEqual([`xum-dev-${uid}`]);
  });

  // A folder that another user owns takes the same branch (assertPrivateFolder refuses it); only
  // root can make one, so the PR's live proof uses a folder that `nobody` created.
  test("a folder that others can enter is replaced by a fresh private one", async () => {
    await fs.mkdir(preferred, { mode: 0o755 });
    await fs.chmod(preferred, 0o755);
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice.fellBackFrom?.folder).toBe(preferred);
    expect(choice.fellBackFrom?.reason).toMatch(/not private/);
    await expectFreshPrivateFolder(choice.socketPath);
    // The other user's folder is left alone.
    expect((await fs.lstat(preferred)).mode & 0o777).toBe(0o755);
  });

  test("a symlink in place of the folder is replaced, and never followed", async () => {
    const elsewhere = path.join(base, "elsewhere");
    await fs.mkdir(elsewhere, { mode: 0o700 });
    await fs.symlink(elsewhere, preferred);
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice.fellBackFrom?.reason).toMatch(/not a directory|symlink/);
    await expectFreshPrivateFolder(choice.socketPath);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  test("a fallback that would not fit a socket path is refused before it creates anything", async () => {
    await fs.mkdir(preferred, { mode: 0o755 });
    await fs.chmod(preferred, 0o755);
    // The folder name gains "." and six characters: pick a file name that fits only without them.
    const room = MAX_UNIX_SOCKET_PATH_BYTES - Buffer.byteLength(path.join(preferred, "x")) - 3;
    const fileName = "s".repeat(room + 1);
    expect(Buffer.byteLength(path.join(preferred, fileName))).toBeLessThanOrEqual(
      MAX_UNIX_SOCKET_PATH_BYTES
    );
    const error = await chooseDevSocketPath(preferred, fileName, uid).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/too long/);
    expect(await fs.readdir(base)).toEqual([`xum-dev-${uid}`]);
  });

  test("every fallback gets its own folder", async () => {
    await fs.mkdir(preferred, { mode: 0o755 });
    await fs.chmod(preferred, 0o755);
    const [a, b] = [
      await chooseDevSocketPath(preferred, "b1.sock", uid),
      await chooseDevSocketPath(preferred, "b1.sock", uid),
    ];
    expect(path.dirname(a.socketPath)).not.toBe(path.dirname(b.socketPath));
  });

  test("a parent that others can rename in names XUM_BACKEND_SOCKET and XDG_RUNTIME_DIR, and creates nothing", async () => {
    const shared = path.join(base, "shared");
    await fs.mkdir(shared);
    await fs.chmod(shared, 0o777);
    const error = await chooseDevSocketPath(
      path.join(shared, `xum-dev-${uid}`),
      "b1.sock",
      uid
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/writable by other users/);
    expect((error as Error).message).toContain("XUM_BACKEND_SOCKET");
    expect((error as Error).message).toContain("XDG_RUNTIME_DIR");
    expect(await fs.readdir(shared)).toEqual([]);
  });
});
