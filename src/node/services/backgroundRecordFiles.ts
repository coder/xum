import { constants } from "fs";
import * as fs from "fs/promises";
import * as path from "path";

/*
 * Host-local background records live under /tmp, which the macOS agent sandbox lets agent
 * commands write. Xum reads and writes them with the user's full access, so a symlink that a
 * sandboxed command puts in place of a record, or of a folder above it, would make Xum read a
 * file the sandbox hides or write one it protects. So records open only as regular files (a
 * FIFO must not block Xum) and with every symlink below the temp root refused: O_NOFOLLOW_ANY
 * on macOS, the only platform with the sandbox; elsewhere O_NOFOLLOW refuses the last part.
 */

/** macOS open(2): fail with ELOOP when any part of the path is a symlink. */
const O_NOFOLLOW_ANY = 0x20000000;
// On Windows both constants are undefined, which `|` reads as 0.
const NO_FOLLOW =
  (process.platform === "darwin" ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW) | constants.O_NONBLOCK;

/**
 * `target`, a path below `tempRoot`, spelled from the real path of `tempRoot` (/private/tmp for
 * /tmp), so that it opens with NO_FOLLOW. No agent command can change `tempRoot` itself.
 */
export async function realRecordPath(tempRoot: string, target: string): Promise<string> {
  return path.join(await fs.realpath(tempRoot), path.relative(tempRoot, target));
}

/** Opens the record at `realPath` (see realRecordPath) as a regular file, never through a symlink. */
export async function openRecordFile(realPath: string, flags: number): Promise<fs.FileHandle> {
  const handle = await fs.open(realPath, flags | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${realPath} is not a regular file`);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The size of the record at `realPath`, which must be a regular file, not a symlink. */
export async function recordFileSize(realPath: string): Promise<number> {
  const stat = await fs.lstat(realPath);
  if (!stat.isFile()) throw new Error(`${realPath} is not a regular file`);
  return stat.size;
}

export async function readRecordFile(realPath: string): Promise<string> {
  const handle = await openRecordFile(realPath, constants.O_RDONLY);
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/** Writes `data` to the record at `realPath`; `exclusive` fails when it exists already. */
export async function writeRecordFile(
  realPath: string,
  data: string,
  options?: { exclusive?: boolean }
): Promise<void> {
  const replace = options?.exclusive === true ? constants.O_EXCL : constants.O_TRUNC;
  const handle = await openRecordFile(realPath, constants.O_WRONLY | constants.O_CREAT | replace);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}
