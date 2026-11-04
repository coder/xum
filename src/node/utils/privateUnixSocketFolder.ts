/**
 * Folder rules for a private Unix socket. This file uses only node built-ins, with no path aliases,
 * so that `scripts/devServerSocketPath.ts` can run it from `make` before anything is built.
 * privateUnixSocket.ts adds the lock and the stale-socket removal on top.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Longest Unix socket path in bytes. `sockaddr_un.sun_path` holds 108 bytes on Linux and 104 on
 * macOS, and the kernel needs one of them for the terminating NUL.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

/** Appended to every folder refusal: the two ways a user can pick a folder that passes. */
const SOCKET_FOLDER_HINT =
  "Set XUM_BACKEND_SOCKET to a socket path in a folder that only you can write to, or XDG_RUNTIME_DIR to such a folder.";

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export async function assertPrivateFolder(dir: string, ownerUid: number): Promise<void> {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) {
    throw new Error(
      `${dir} is not a directory (a symlink is refused): the socket folder must be a real private directory. ${SOCKET_FOLDER_HINT}`
    );
  }
  if (stat.uid !== ownerUid) {
    throw new Error(
      `${dir} is owned by another user: refusing to put the socket there. ${SOCKET_FOLDER_HINT}`
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `${dir} is not private (mode ${(stat.mode & 0o777).toString(8)}): it must be 0700 so that no other user can create or replace the socket. ${SOCKET_FOLDER_HINT}`
    );
  }
}

/**
 * Every folder above `dir` must be one that only this user (or root) can modify. A user who can
 * write to a parent can rename the private folder away and put their own in its place, and then bind
 * the socket path. A sticky parent (like /tmp) is safe: there only the owner of an entry can rename
 * it. A symlink is followed, so `assertAncestorsTrusted` runs on both the path as given (a symlink
 * must belong to us or root, and its folder was checked on the way up) and where it leads.
 */
export async function assertAncestorsTrusted(start: string, ownerUid: number): Promise<void> {
  for (let current = start; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    const trusted = stat.uid === ownerUid || stat.uid === 0;
    if (!trusted) {
      throw new Error(
        `The parent folder ${current} is owned by another user: that user could replace the socket folder. ${SOCKET_FOLDER_HINT}`
      );
    }
    // A symlink's own mode is always 0777 and means nothing: the folder it lives in decides who can
    // swap it, and that folder is checked next.
    const writableByOthers = !stat.isSymbolicLink() && (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(
        `The parent folder ${current} is writable by other users (mode ${(stat.mode & 0o777).toString(8)}) and not sticky: one of them could rename the socket folder and put their own there. ${SOCKET_FOLDER_HINT}`
      );
    }
    if (path.dirname(current) === current) return;
  }
}

export function assertSocketPathFits(socketPath: string): void {
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

/** The folder's parents, checked as given and where they lead (see assertAncestorsTrusted). */
async function assertParentsTrusted(dir: string, ownerUid: number): Promise<void> {
  const parent = path.dirname(dir);
  await assertAncestorsTrusted(path.resolve(parent), ownerUid);
  await assertAncestorsTrusted(await fs.realpath(parent), ownerUid);
}

/**
 * Checks the path, trusts the folder's parents, creates the last path component with mode 0700 and
 * checks that it is private and ours. Throws before it creates anything when a parent is unsafe.
 */
export async function preparePrivateSocketFolder(
  socketPath: string,
  ownerUid: number
): Promise<void> {
  assertSocketPathFits(socketPath);
  const dir = path.dirname(socketPath);
  // Before mkdir, so that a refused path leaves nothing behind.
  await assertParentsTrusted(dir, ownerUid);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await assertPrivateFolder(dir, ownerUid);
}

export interface DevSocketChoice {
  socketPath: string;
  /** Set when `folder` was not safely ours and `socketPath` is in a fresh folder instead. */
  fellBackFrom?: { folder: string; reason: string };
}

/** mkdtemp appends this to the folder name: "." and six characters. */
const MKDTEMP_SUFFIX = ".XXXXXX";

/**
 * Where `make dev-server` puts the backend socket. The answer is `folder/fileName`, with `folder`
 * created here (mode 0700, atomically) when it is missing, or already a private folder of ours.
 * `make` builds for a while between this choice and the start of the backend, so a missing folder
 * is claimed at once: another account cannot take the name in between.
 *
 * Another account can also create the default folder first, and the backend then refuses to use
 * it. A folder that is not safely ours is therefore replaced by a fresh one from mkdtemp next to it
 * (mode 0700, a random name that nobody else can have made), and the reason goes back to the
 * caller to tell the user. The Vite hop never falls back to TCP: the squat window that the socket
 * closes would open again.
 *
 * Throws, before it creates anything, when the default path does not fit a socket path.
 * Throws when a parent of the folder is unsafe: a fresh folder next to it would be just as open to
 * another account, so only the user can fix it (XUM_BACKEND_SOCKET or XDG_RUNTIME_DIR). It also
 * throws, before it creates the fresh folder, when the longer fallback path would not fit.
 */
export async function chooseDevSocketPath(
  folder: string,
  fileName: string,
  ownerUid: number
): Promise<DevSocketChoice> {
  const preferred = path.join(folder, fileName);
  // Before anything is created: the backend refuses a path that does not fit, and the folder made
  // for it would stay empty.
  assertSocketPathFits(preferred);
  await assertParentsTrusted(folder, ownerUid);
  try {
    await fs.mkdir(folder, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  let reason: string;
  try {
    await assertPrivateFolder(folder, ownerUid);
    return { socketPath: preferred };
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  assertSocketPathFits(path.join(`${folder}${MKDTEMP_SUFFIX}`, fileName));
  const fresh = await fs.mkdtemp(`${folder}.`);
  await assertPrivateFolder(fresh, ownerUid);
  return { socketPath: path.join(fresh, fileName), fellBackFrom: { folder, reason } };
}
