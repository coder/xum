import * as fs from "node:fs/promises";
import * as net from "node:net";
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

/** True when a server accepts connections at `socketPath`: only a refused connection is stale. */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
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
  // Unlinking a live server's socket leaves that server listening on a name nobody can reach, and
  // lets a second server take the name: the first one's clients then talk to the wrong backend.
  if (await isListening(socketPath)) {
    throw new Error(`${socketPath} is in use by a running server: choose another socket path`);
  }
  await fs.rm(socketPath, { force: true });
}

/**
 * Every folder above `dir` must be one that only this user (or root) can modify. A user who can
 * write to a parent can rename the private folder away and put their own in its place, and then bind
 * the socket path. A sticky parent (like /tmp) is safe: there only the owner of an entry can rename
 * it. A symlink is followed, so `assertAncestorsTrusted` runs on both the path as given (a symlink
 * must belong to us or root, and its folder was checked on the way up) and where it leads.
 */
async function assertAncestorsTrusted(start: string, ownerUid: number): Promise<void> {
  for (let current = start; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    const trusted = stat.uid === ownerUid || stat.uid === 0;
    if (!trusted) {
      throw new Error(
        `The parent folder ${current} is owned by another user: that user could replace the socket folder`
      );
    }
    // A symlink's own mode is always 0777 and means nothing: the folder it lives in decides who can
    // swap it, and that folder is checked next.
    const writableByOthers = !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(
        `The parent folder ${current} is writable by other users (mode ${(stat.mode & 0o777).toString(8)}) and not sticky: one of them could rename the socket folder and put their own there. Choose a path under a folder that only you can write to`
      );
    }
    if (path.dirname(current) === current) return;
  }
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
 * created: the parent must exist, and no other user may be able to rename the folder: every folder
 * above it must be ours (or root's) and either not writable by others or sticky, like /tmp.
 *
 * The stale-socket removal runs only when the entry is a socket owned by this user. The folder is
 * private, so nobody else can have put it there, and a regular file or a symlink at that path is
 * somebody's data: this throws instead of deleting it. A socket that still accepts connections
 * belongs to a running server, so that throws too.
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
  // Before mkdir, so that a refused path leaves nothing behind. The second pass follows symlinks.
  const parent = path.dirname(dir);
  await assertAncestorsTrusted(path.resolve(parent), ownerUid);
  await assertAncestorsTrusted(await fs.realpath(parent), ownerUid);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateFolder(dir, ownerUid);
  await removeStaleSocket(socketPath, ownerUid);
}
