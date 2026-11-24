import * as fs from "node:fs/promises";
import * as net from "node:net";
import { acquireProcessFileLock } from "@/node/utils/concurrency/fileLock";
import { errorCode, preparePrivateSocketFolder } from "./privateUnixSocketFolder";

/** How long a start waits for another start on the same socket path (a few filesystem calls each). */
const SOCKET_LOCK_TIMEOUT_MS = 10_000;

/** A server that does not answer a connect within this long is treated as running. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * True when a server accepts connections at `socketPath`: only a refused connection is stale. A
 * server that takes too long to answer counts as running, so that the caller never removes the
 * socket of a live but busy server.
 */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    probe.setTimeout(PROBE_TIMEOUT_MS, () => {
      probe.destroy();
      resolve(true);
    });
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

/** The lock file must be a regular file of ours: a symlink would send the lock somewhere else. */
export async function assertLockPathUsable(lockPath: string, ownerUid: number): Promise<void> {
  let entry;
  try {
    entry = await fs.lstat(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!entry.isFile()) {
    throw new Error(
      `The socket lock ${lockPath} is not a regular file (a symlink is refused): remove it if you made it`
    );
  }
  if (entry.uid !== ownerUid) {
    throw new Error(`The socket lock ${lockPath} is owned by another user: refusing to use it`);
  }
}

/**
 * Prepares `socketPath` and runs `bind`, which must listen on it, with a lock held from the first
 * look at the old socket to the end of `bind`. Returns what `bind` returns.
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
 * The lock (`<socketPath>.lock`, in the same private folder) closes a race between two starts on
 * one path: both could read a stale socket as stale, the first unlinks it and binds, and the
 * second then unlinks the first's new socket and binds as well. The first server would keep
 * listening on a name nobody can reach. With the lock the second start sees the first one's live
 * socket and refuses as in use. The lock is the repo's process file lock: a crashed holder's lock is
 * reclaimed only when the holder is known to be dead, and never from a live one.
 *
 * `ownerUid` is a parameter so that a test can stand in for another user.
 */
export async function withPrivateUnixSocketPath<T>(
  socketPath: string,
  bind: () => Promise<T>,
  ownerUid: number | undefined = process.getuid?.()
): Promise<T> {
  if (ownerUid === undefined) {
    throw new Error("A private Unix socket folder needs POSIX file ownership (not Windows)");
  }
  await preparePrivateSocketFolder(socketPath, ownerUid);

  const lockPath = `${socketPath}.lock`;
  await assertLockPathUsable(lockPath, ownerUid);
  await using lock = await acquireProcessFileLock({
    lockPath,
    createParentDir: false,
    timeoutMs: SOCKET_LOCK_TIMEOUT_MS,
    label: "Unix socket lock",
  });
  await removeStaleSocket(socketPath, ownerUid);
  // Another build's lease-based reclaim could have displaced this lock while the probe ran.
  await lock.assertStillOwned();
  return await bind();
}
