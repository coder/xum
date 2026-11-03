import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Longest Unix socket path in bytes. `sockaddr_un.sun_path` holds 108 bytes on Linux and 104 on
 * macOS, and the kernel needs one of them for the terminating NUL.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function assertPrivateFolder(dir: string, ownerUid: number): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) {
    throw new Error(
      `${dir} is not a directory (a symlink is refused): the socket folder must be a real private directory`
    );
  }
  if (stat.uid !== ownerUid) {
    throw new Error(`${dir} is owned by another user: refusing to put the socket there`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `${dir} is not private (mode ${(stat.mode & 0o777).toString(8)}): it must be 0700 so that no other user can create or replace the socket`
    );
  }
}

async function removeStaleSocket(socketPath: string, ownerUid: number): Promise<void> {
  let entry;
  try {
    entry = await fs.lstat(socketPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!entry.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket: refusing to remove it`);
  }
  if (entry.uid !== ownerUid) {
    throw new Error(`${socketPath} is owned by another user: refusing to remove it`);
  }
  await fs.unlink(socketPath);
}

function assertSocketPathFits(socketPath: string): void {
  if (!path.isAbsolute(socketPath)) {
    throw new Error(`The Unix socket path must be absolute: ${socketPath}`);
  }
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `The Unix socket path is too long (${bytes} bytes, the limit on this platform is ${MAX_UNIX_SOCKET_PATH_BYTES}): ${socketPath}. Choose a shorter path.`
    );
  }
}

/**
 * Make `path.dirname(socketPath)` a folder that only this user can enter, and clear a stale socket
 * that a crashed run left in it. Call it before `listen(socketPath)`.
 *
 * Why: another local account can bind any free TCP port, but it cannot create a name inside a 0700
 * folder that this user owns. So a client that connects to `socketPath` reaches this user's server
 * or nothing. The folder is the whole guarantee, so this refuses (never repairs) a symlink, a folder
 * of another user and a folder with group or other permissions. Only the last path component is
 * created: the parent must exist, and a sticky parent such as /tmp stops others from renaming ours.
 *
 * The stale-socket removal runs only when the entry is a socket owned by this user. The folder is
 * private, so nobody else can have put it there, and a regular file or a symlink at that path is
 * somebody's data: this throws instead of deleting it.
 *
 * `ownerUid` is a parameter so that a test can stand in for another user.
 */
export async function preparePrivateUnixSocketPath(
  socketPath: string,
  ownerUid: number | undefined = process.getuid?.()
): Promise<void> {
  if (ownerUid === undefined) {
    throw new Error("A private Unix socket folder needs POSIX file ownership (not Windows)");
  }
  assertSocketPathFits(socketPath);

  const dir = path.dirname(socketPath);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateFolder(dir, ownerUid);
  await removeStaleSocket(socketPath, ownerUid);
}
