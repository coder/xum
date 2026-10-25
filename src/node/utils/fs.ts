import fs from "fs/promises";
import { chmodSync, mkdirSync } from "fs";

/**
 * Ensure a directory exists with owner-only permissions (0o700).
 * Defense-in-depth: the process umask should already enforce this,
 * but explicit mode makes the security intent clear at each callsite.
 * Also tightens permissions on pre-existing directories from older installs.
 */
export async function ensurePrivateDir(
  dirPath: string,
  // Another file system (the in-memory session files) passes its own; the default is read on
  // each call.
  fsp: Pick<typeof fs, "mkdir" | "chmod"> = fs
): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
  // chmod is needed because mkdir does not change permissions on existing dirs
  await fsp.chmod(dirPath, 0o700);
}

export function ensurePrivateDirSync(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  // chmod is needed because mkdir does not change permissions on existing dirs
  chmodSync(dirPath, 0o700);
}

/**
 * Returns true when `error` looks like a Node `NodeJS.ErrnoException`
 * carrying the given POSIX-style error `code` (e.g. "ENOENT", "EEXIST").
 *
 * Centralised because fs / runtime callers across the node layer need this
 * exact narrow-and-compare pattern and previously each open-coded it.
 */
export function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

/** True for Node fs-style errors carrying a string errno code (EACCES, EIO, ...). */
export function isErrnoException(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
  );
}
