/**
 * Atomic file replacement: write to a sibling temp file, fsync, then rename over
 * the destination so readers only ever see the old or the new contents.
 *
 * First-party replacement for the `write-file-atomic` npm package (same call
 * shape: default async export plus `.sync`). That package issued a single
 * write(2) and ignored the returned byte count; when a filesystem fills up,
 * write(2) accepts a short count without reporting an error, so the truncated
 * temp file was fsynced and renamed over the previous good file. In the
 * coder/xum#4197 incident that turned config.json into a page-aligned prefix
 * that later loaded as an empty registry. Shipping the fix as source (rather
 * than a bun patch) is what reaches `npm install -g @coder/xum` users, whose
 * dependencies come from the npm registry.
 *
 * Two independent defenses: the whole payload is written in a loop, and the
 * temp file's size is compared with the payload before the rename.
 */
import * as crypto from "crypto";
// Default import on purpose: it is the CommonJS module object that `require("fs")`
// returns, which is what the replaced package used. Tests across the repo observe or
// fail individual steps (fs.rename, fs.write, fs.writeSync) by spying on that object;
// the `import * as fs` namespace is a separate binding that such spies never reach.
import fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { threadId } from "worker_threads";

export interface Options {
  /** Encoding for string payloads (default utf8). */
  encoding?: BufferEncoding;
  /** File mode; defaults to the destination's current mode when it exists. */
  mode?: number;
  /** Owner to apply; defaults to the destination's current owner when it exists. */
  chown?: { uid: number; gid: number };
  /** Set to false to skip fsync before the rename (default true). */
  fsync?: boolean;
}

type ResolvedOptions = Options & { encoding: BufferEncoding };

let invocations = 0;
const pendingTempFiles = new Set<string>();
// Serializes writes to the same destination within this process so two callers
// cannot interleave their temp files and renames.
const activeWrites = new Map<string, Promise<void>>();

process.once("exit", () => {
  for (const tempFile of pendingTempFiles) {
    try {
      // eslint-disable-next-line local/no-sync-fs-methods -- exit handlers cannot await.
      fs.unlinkSync(tempFile);
    } catch {
      // Best-effort cleanup only.
    }
  }
});

function resolveOptions(options?: Options | BufferEncoding): ResolvedOptions {
  if (typeof options === "string") {
    return { encoding: options };
  }
  return { ...options, encoding: options?.encoding ?? "utf8" };
}

function toBuffer(data: string | Buffer, encoding: BufferEncoding): Buffer {
  return typeof data === "string" ? Buffer.from(data, encoding) : data;
}

function tempPathFor(filename: string): string {
  const suffix = crypto
    .createHash("sha1")
    .update(`${process.pid}|${threadId}|${++invocations}|${crypto.randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 12);
  return `${filename}.${suffix}`;
}

function incompleteWriteError(tempFile: string, written: number, expected: number): Error {
  const error: NodeJS.ErrnoException = new Error(
    `Incomplete write to ${tempFile}: ${written} of ${expected} bytes`
  );
  error.code = "EIO";
  return error;
}

// chown/chmod may legitimately fail for a non-root process on some filesystems
// (mirrors graceful-fs). Everything else propagates.
function isOwnershipErrorOk(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSYS") {
    return true;
  }
  const nonRoot = !process.getuid || process.getuid() !== 0;
  return nonRoot && (code === "EINVAL" || code === "EPERM");
}

function fillOptionsFromStats(options: ResolvedOptions, stats: fs.Stats | undefined): void {
  if (!stats) {
    return;
  }
  options.mode ??= stats.mode;
  if (process.getuid) {
    options.chown ??= { uid: stats.uid, gid: stats.gid };
  }
}

// Callback fs API promisified at call time (not the promise API), so the spies above
// see every step.
function write(fd: number, buffer: Buffer, offset: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.write(fd, buffer, offset, buffer.length - offset, offset, (error, bytesWritten) => {
      if (error) {
        reject(error);
      } else {
        resolve(bytesWritten);
      }
    });
  });
}

async function writeAll(fd: number, buffer: Buffer, tempFile: string): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const written = await write(fd, buffer, offset);
    if (!(written > 0)) {
      throw incompleteWriteError(tempFile, offset, buffer.length);
    }
    offset += written;
  }
}

function assertCompleteSize(size: number, expected: number, tempFile: string): void {
  if (size !== expected) {
    throw incompleteWriteError(tempFile, size, expected);
  }
}

async function applyOwnership(tempFile: string, options: ResolvedOptions): Promise<void> {
  if (options.chown) {
    try {
      await promisify(fs.chown)(tempFile, options.chown.uid, options.chown.gid);
    } catch (error) {
      if (!isOwnershipErrorOk(error)) throw error;
    }
  }
  if (options.mode != null) {
    // open() applies the umask to the requested mode; chmod pins the exact mode.
    try {
      await promisify(fs.chmod)(tempFile, options.mode);
    } catch (error) {
      if (!isOwnershipErrorOk(error)) throw error;
    }
  }
}

async function writeFileAtomicUnserialized(
  filename: string,
  data: string | Buffer,
  options: ResolvedOptions
): Promise<void> {
  // Follow symlinks so the rename replaces the link's target rather than the link.
  const target = await promisify(fs.realpath)(filename).catch(() => filename);
  fillOptionsFromStats(options, await promisify(fs.stat)(target).catch(() => undefined));
  const buffer = toBuffer(data, options.encoding);
  const tempFile = tempPathFor(target);
  pendingTempFiles.add(tempFile);
  let fd: number | undefined;
  try {
    fd = await promisify(fs.open)(tempFile, "w", options.mode);
    await writeAll(fd, buffer, tempFile);
    if (options.fsync !== false) {
      await promisify(fs.fsync)(fd);
    }
    assertCompleteSize((await promisify(fs.fstat)(fd)).size, buffer.length, tempFile);
    await promisify(fs.close)(fd);
    fd = undefined;
    await applyOwnership(tempFile, options);
    await promisify(fs.rename)(tempFile, target);
  } finally {
    if (fd !== undefined) {
      await promisify(fs.close)(fd).catch(() => undefined);
    }
    pendingTempFiles.delete(tempFile);
    await promisify(fs.unlink)(tempFile).catch(() => undefined);
  }
}

/**
 * Atomically replace `filename` with `data`. Resolves once the new contents are
 * durably in place; rejects (leaving the previous file untouched) on any failure,
 * including a write that stored fewer bytes than requested.
 */
export default async function writeFileAtomic(
  filename: string,
  data: string | Buffer,
  options?: Options | BufferEncoding
): Promise<void> {
  const resolved = resolveOptions(options);
  const key = path.resolve(filename);
  const previous = activeWrites.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => writeFileAtomicUnserialized(filename, data, resolved));
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  activeWrites.set(key, settled);
  try {
    await run;
  } finally {
    if (activeWrites.get(key) === settled) {
      activeWrites.delete(key);
    }
  }
}

/* eslint-disable local/no-sync-fs-methods -- the synchronous variant exists for the
   two callers that must persist before returning (providers.jsonc writers); it mirrors
   the async pipeline step for step. */

function writeAllSync(fd: number, buffer: Buffer, tempFile: string): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    if (!(written > 0)) {
      throw incompleteWriteError(tempFile, offset, buffer.length);
    }
    offset += written;
  }
}

function applyOwnershipSync(tempFile: string, options: ResolvedOptions): void {
  if (options.chown) {
    try {
      fs.chownSync(tempFile, options.chown.uid, options.chown.gid);
    } catch (error) {
      if (!isOwnershipErrorOk(error)) throw error;
    }
  }
  if (options.mode != null) {
    try {
      fs.chmodSync(tempFile, options.mode);
    } catch (error) {
      if (!isOwnershipErrorOk(error)) throw error;
    }
  }
}

/** Synchronous variant of {@link writeFileAtomic}. */
export function sync(
  filename: string,
  data: string | Buffer,
  options?: Options | BufferEncoding
): void {
  const resolved = resolveOptions(options);
  let target = filename;
  try {
    target = fs.realpathSync(filename);
  } catch {
    // A destination that does not exist yet has no link to follow.
  }
  let stats: fs.Stats | undefined;
  try {
    stats = fs.statSync(target);
  } catch {
    stats = undefined;
  }
  fillOptionsFromStats(resolved, stats);
  const buffer = toBuffer(data, resolved.encoding);
  const tempFile = tempPathFor(target);
  pendingTempFiles.add(tempFile);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempFile, "w", resolved.mode);
    writeAllSync(fd, buffer, tempFile);
    if (resolved.fsync !== false) {
      fs.fsyncSync(fd);
    }
    assertCompleteSize(fs.fstatSync(fd).size, buffer.length, tempFile);
    fs.closeSync(fd);
    fd = undefined;
    applyOwnershipSync(tempFile, resolved);
    fs.renameSync(tempFile, target);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The failing call may already have closed it.
      }
    }
    pendingTempFiles.delete(tempFile);
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Already renamed away on success.
    }
  }
}

/* eslint-enable local/no-sync-fs-methods */

writeFileAtomic.sync = sync;
