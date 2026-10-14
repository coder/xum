/**
 * The export stream of the bug-bash sandbox (#5714). The container gets no read-write mount
 * of the host. When its e2e job ends, sandbox/entry.ts sends the job's output folder on its
 * stdout, and the host launcher writes the files itself.
 *
 * Frames: a JSON header line, then exactly `n` bytes. The last frame is the end frame.
 *   {"p":"web/report.json","n":1234}\n <1234 bytes> … {"end":true}\n
 *
 * Code in the container is untrusted, so the receiver is the trust boundary. It writes new
 * regular files only, in a folder that it creates itself, and it stops at the first frame
 * that breaks a rule. A stream without the end frame is incomplete evidence.
 */
import * as fs from "fs";
import * as path from "path";
import type { Readable, Writable } from "stream";

export interface ExportLimits {
  files: number;
  bytes: number;
  headerBytes: number;
}
export const EXPORT_LIMITS: ExportLimits = { files: 10_000, bytes: 1 << 30, headerBytes: 4096 };

export interface ExportResult {
  /** True only when the end frame arrived and the receiver refused nothing. */
  complete: boolean;
  files: number;
  bytes: number;
  /** Why the receiver stopped. Absent when the export is complete. */
  error?: string;
}

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = fs.constants;

/** Container side: sends each regular file under `root`. Skips symlinks and special files. */
export async function writeExport(
  out: Writable,
  root: string
): Promise<{ files: number; bytes: number; skipped: string[] }> {
  const result = { files: 0, bytes: 0, skipped: [] as string[] };
  for (const rel of listFiles(root, "", result.skipped)) {
    const data = readRegularFile(path.join(root, rel));
    if (data == null) {
      result.skipped.push(rel);
      continue;
    }
    await send(out, Buffer.from(`${JSON.stringify({ p: rel, n: data.length })}\n`));
    await send(out, data);
    result.files += 1;
    result.bytes += data.length;
  }
  await send(out, Buffer.from(`${JSON.stringify({ end: true })}\n`));
  return result;
}

function listFiles(root: string, rel: string, skipped: string[]): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    // A job that failed early has no output folder. It still sends the end frame.
    if (rel === "" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) return listFiles(root, child, skipped);
      if (entry.isFile()) return [child];
      skipped.push(child);
      return [];
    });
}

/** The bytes of a regular file, or null. O_NONBLOCK: a FIFO swapped in cannot block the open. */
function readRegularFile(file: string): Buffer | null {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } finally {
    fs.closeSync(fd);
  }
}

function send(out: Writable, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(data, (error) => (error == null ? resolve() : reject(error)));
  });
}

/**
 * Host side: writes the files of the stream into `dest`. `dest` must not exist: then only this
 * function writes in it, so it cannot hold a symlink. A stream that breaks a rule gives
 * complete: false with the reason, and the files received before it stay.
 */
export async function receiveExport(
  input: Readable,
  dest: string,
  limits: ExportLimits = EXPORT_LIMITS
): Promise<ExportResult> {
  fs.mkdirSync(dest, { mode: 0o700 }); // EEXIST, also for a symlink: the caller's bug
  const result: ExportResult = { complete: false, files: 0, bytes: 0 };
  let buffered = Buffer.alloc(0);
  let file: { fd: number; left: number } | null = null;
  let ended = false;
  try {
    for await (const chunk of input) {
      buffered = Buffer.concat([buffered, chunk as Buffer]);
      while (buffered.length > 0) {
        if (file != null) {
          const part = buffered.subarray(0, file.left);
          writeAll(file.fd, part);
          buffered = buffered.subarray(part.length);
          file.left -= part.length;
          if (file.left === 0) file = closeFile(file);
          continue;
        }
        if (ended) throw new Error("bytes after the end frame");
        const newline = buffered.indexOf(0x0a);
        if (newline > limits.headerBytes || (newline < 0 && buffered.length > limits.headerBytes))
          throw new Error(`a header over ${limits.headerBytes} bytes`);
        if (newline < 0) break;
        const frame = parseHeader(buffered.subarray(0, newline).toString("utf8"));
        buffered = buffered.subarray(newline + 1);
        if (frame === "end") {
          ended = true;
          continue;
        }
        if (result.files + 1 > limits.files) throw new Error(`more than ${limits.files} files`);
        if (result.bytes + frame.n > limits.bytes)
          throw new Error(`more than ${limits.bytes} bytes`);
        file = { fd: createFile(dest, frame.p), left: frame.n };
        result.files += 1;
        result.bytes += frame.n;
        if (frame.n === 0) file = closeFile(file);
      }
    }
    if (file != null) return { ...result, error: "the stream ended inside a file" };
    if (!ended) return { ...result, error: "no end frame" };
    return { ...result, complete: true };
  } catch (error) {
    input.destroy(); // the container's writer gets EPIPE and stops
    return { ...result, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (file != null) closeFile(file);
  }
}

function parseHeader(line: string): "end" | { p: string; n: number } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("a header that is not JSON");
  }
  if (typeof value !== "object" || value == null || Array.isArray(value))
    throw new Error("a header that is not an object");
  const header = value as Record<string, unknown>;
  const keys = Object.keys(header).sort().join(",");
  if (keys === "end" && header.end === true) return "end";
  if (keys !== "n,p") throw new Error(`header fields ${keys}`);
  const n = header.n;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
    throw new Error("a size that is not a whole number");
  return { p: safeRelative(header.p), n };
}

/** A relative, normalized path without control characters, at most 32 folders deep. */
function safeRelative(p: unknown): string {
  if (typeof p !== "string" || p.length === 0 || p.length > 1024) throw new Error("a bad path");
  // eslint-disable-next-line no-control-regex -- control characters are what this check refuses
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new Error("a control character in a path");
  const parts = p.split("/");
  if (path.posix.isAbsolute(p) || path.posix.normalize(p) !== p || parts.length > 32)
    throw new Error(`a path that is not plain: ${JSON.stringify(p)}`);
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new Error(`a path that is not plain: ${JSON.stringify(p)}`);
  return p;
}

function createFile(dest: string, rel: string): number {
  const parts = rel.split("/");
  let dir = dest;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!fs.lstatSync(dir).isDirectory()) throw new Error(`a path under a file: ${rel}`);
    }
  }
  // O_EXCL: a duplicate path fails. O_NOFOLLOW: never through a symlink.
  return fs.openSync(path.join(dest, rel), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
}

function writeAll(fd: number, data: Buffer): void {
  for (let done = 0; done < data.length; ) done += fs.writeSync(fd, data, done);
}

function closeFile(file: { fd: number }): null {
  fs.closeSync(file.fd);
  return null;
}
