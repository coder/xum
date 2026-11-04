/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `rejects` as non-thenable */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chooseDevSocketPath } from "./privateUnixSocketFolder";

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

  test("a missing folder is the answer, and nothing is created", async () => {
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice).toEqual({ socketPath: path.join(preferred, "b1.sock") });
    expect(await fs.readdir(base)).toEqual([]);
  });

  test("a private folder of ours is the answer", async () => {
    await fs.mkdir(preferred, { mode: 0o700 });
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid);
    expect(choice).toEqual({ socketPath: path.join(preferred, "b1.sock") });
    expect(await fs.readdir(base)).toEqual([`xum-dev-${uid}`]);
  });

  test("a folder that another user owns is replaced by a fresh private one", async () => {
    await fs.mkdir(preferred, { mode: 0o700 });
    const choice = await chooseDevSocketPath(preferred, "b1.sock", uid + 1);
    // Our own fresh folder counts as the other user's here, so only check the shape of the answer.
    expect(choice.fellBackFrom?.folder).toBe(preferred);
    expect(choice.fellBackFrom?.reason).toMatch(/owned by another user/);
    expect(path.basename(choice.socketPath)).toBe("b1.sock");
  });

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
