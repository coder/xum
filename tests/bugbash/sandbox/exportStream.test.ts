import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PassThrough, Readable } from "stream";
import { receiveExport, writeExport, type ExportLimits } from "./exportStream";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbb-export-test-"));
  dirs.push(dir);
  return dir;
}

const header = (p: unknown, n: unknown) => `${JSON.stringify({ p, n })}\n`;
const END = `${JSON.stringify({ end: true })}\n`;
const stream = (...parts: (string | Buffer)[]) =>
  Readable.from([Buffer.concat(parts.map((part) => Buffer.from(part)))]);

/** Every entry under `root`, with its kind: what the receiver left on the host. */
function tree(root: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) return [`${child}/`, ...tree(root, child)];
      return [entry.isFile() ? child : `${child} (not a file)`];
    })
    .sort();
}

test("the host gets the regular files of the job, and nothing else", async () => {
  const src = tempDir();
  const video = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256));
  fs.mkdirSync(path.join(src, "web/video"), { recursive: true });
  fs.writeFileSync(path.join(src, "web/report.json"), '{"ok":true}');
  fs.writeFileSync(path.join(src, "web/video/run.webm"), video);
  fs.writeFileSync(path.join(src, "empty.txt"), "");
  // A container can plant these in its output folder (measured with the prototype).
  fs.symlinkSync("/etc/passwd", path.join(src, "key.txt"));
  fs.symlinkSync(os.tmpdir(), path.join(src, "web/tmp"));
  expect(spawnSync("mkfifo", [path.join(src, "pipe")]).status).toBe(0);

  const pipe = new PassThrough();
  const dest = path.join(tempDir(), "out");
  const [sent, received] = await Promise.all([
    writeExport(pipe, src).finally(() => pipe.end()),
    receiveExport(pipe, dest),
  ]);

  expect(received).toEqual({ complete: true, files: 3, bytes: 11 + video.length });
  expect(sent.skipped.sort()).toEqual(["key.txt", "pipe", "web/tmp"]);
  expect(tree(dest)).toEqual([
    "empty.txt",
    "web/",
    "web/report.json",
    "web/video/",
    "web/video/run.webm",
  ]);
  expect(fs.readFileSync(path.join(dest, "web/video/run.webm")).equals(video)).toBe(true);
});

test("an empty or missing output folder still sends the end frame", async () => {
  const pipe = new PassThrough();
  const dest = path.join(tempDir(), "out");
  const [, received] = await Promise.all([
    writeExport(pipe, path.join(tempDir(), "missing")).finally(() => pipe.end()),
    receiveExport(pipe, dest),
  ]);
  expect(received).toEqual({ complete: true, files: 0, bytes: 0 });
  expect(tree(dest)).toEqual([]);
});

test("frames split at any byte still arrive whole", async () => {
  const bytes = Buffer.from(`${header("a/b.txt", 5)}hello${header("c.txt", 0)}${END}`);
  const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
  const dest = path.join(tempDir(), "out");
  expect(await receiveExport(Readable.from(chunks), dest)).toEqual({
    complete: true,
    files: 2,
    bytes: 5,
  });
  expect(fs.readFileSync(path.join(dest, "a/b.txt"), "utf8")).toBe("hello");
});

const small: ExportLimits = { files: 2, bytes: 10, headerBytes: 4096 };
test.each([
  ["a parent path", [header("../escape.txt", 1), "x", END]],
  ["an absolute path", [header("/tmp/escape.txt", 1), "x", END]],
  ["a NUL byte", [header("a\u0000b", 1), "x", END]],
  ["a control character", [header("a\u001b[2Jb", 1), "x", END]],
  ["a path that is not normalized", [header("a//b", 1), "x", END]],
  ["a folder path", [header("a/", 1), "x", END]],
  ["a header over the limit", ["x".repeat(5000)]],
  ["a header that is not JSON", ["{p:\n"]],
  ["an unknown header field", [`${JSON.stringify({ p: "a", n: 1, mode: 511 })}\n`, "x", END]],
  ["a negative size", [header("a", -1), END]],
  ["a size that is not an integer", [header("a", 1.5), "x", END]],
  ["a duplicate path", [header("a", 1), "x", header("a", 1), "y", END]],
  ["a path under a file", [header("a", 1), "x", header("a/b", 1), "y", END]],
  ["too many files", [header("a", 0), header("b", 0), header("c", 0), END]],
  ["too many bytes", [header("a", 6), "123456", header("b", 6), "123456", END]],
  ["a short last file", [header("a", 10), "123"]],
  ["no end frame", [header("a", 1), "x"]],
  ["bytes after the end frame", [END, header("a", 1), "x"]],
])("the receiver refuses %s", async (_name, parts) => {
  const parent = tempDir();
  const dest = path.join(parent, "out");
  const result = await receiveExport(stream(...parts), dest, small);
  expect(result.complete).toBe(false);
  expect(result.error).toBeString();
  expect(result.files).toBeLessThanOrEqual(small.files);
  expect(result.bytes).toBeLessThanOrEqual(small.bytes);
  // Nothing lands outside the new folder, and every entry in it is a file or a folder.
  expect(fs.readdirSync(parent)).toEqual(["out"]);
  expect(tree(dest).filter((entry) => entry.endsWith("(not a file)"))).toEqual([]);
});

test("the receiver needs a new folder, and never writes through a symlink", async () => {
  const parent = tempDir();
  const target = tempDir();
  fs.symlinkSync(target, path.join(parent, "link"));
  fs.mkdirSync(path.join(parent, "old"));
  for (const name of ["link", "old"]) {
    const dest = path.join(parent, name);
    const received = receiveExport(stream(header("a", 1), "x", END), dest);
    await received.then(
      () => expect.unreachable("an existing folder must be refused"),
      (error: unknown) => expect(String(error)).toContain("EEXIST")
    );
  }
  expect(fs.readdirSync(target)).toEqual([]);
  expect(fs.readdirSync(path.join(parent, "old"))).toEqual([]);
});
