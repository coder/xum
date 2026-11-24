import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalRuntime } from "./LocalRuntime";
import { RuntimeError } from "./Runtime";
import { readFileString } from "@/node/utils/runtime/helpers";
import { drainFifoReaders } from "../../../tests/ipc/fifoRelease";

/**
 * `readFile(path, signal, { requireRegularFile: true })` must acquire the file without parking a
 * libuv worker on a FIFO/socket open() and must classify the ACQUIRED descriptor (no stat→open
 * race). The default `readFile` keeps today's semantics (special files stream normally).
 * Real filesystem; every FIFO is released in afterEach so a RED run never strands the worker.
 */
const isPosix = process.platform !== "win32";
const d = isPosix ? describe : describe.skip;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function fdLinksTo(dir: string): number {
  // Linux only: how many descriptors of this process point into `dir`.
  if (!fsSync.existsSync("/proc/self/fd")) return -1;
  let n = 0;
  for (const fd of fsSync.readdirSync("/proc/self/fd")) {
    try {
      if (fsSync.readlinkSync(`/proc/self/fd/${fd}`).startsWith(dir)) n++;
    } catch {
      // fd closed between readdir and readlink
    }
  }
  return n;
}

d("LocalBaseRuntime.readFile requireRegularFile", () => {
  let dir: string;
  let fifos: string[];
  // Every read attempt this suite starts against a FIFO; afterEach drains each FIFO until these
  // have settled so a RED run cannot leave a parked reader behind.
  let attempts: Array<Promise<unknown>>;
  const runtime = new LocalRuntime(os.tmpdir());

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "xum-readfile-regular-"));
    fifos = [];
    attempts = [];
  });

  afterEach(async () => {
    for (const fifo of fifos) {
      const drain = await drainFifoReaders(fifo, attempts, 10_000);
      expect(drain.settled).toBe(true);
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  function mkfifo(name: string): string {
    const p = path.join(dir, name);
    execFileSync("mkfifo", [p]);
    fifos.push(p);
    return p;
  }

  it("rejects a FIFO without a writer promptly with a typed error and closes the descriptor", async () => {
    const fifo = mkfifo("plan.md");
    const before = fdLinksTo(dir);
    const attempt = readFileString(runtime, fifo, undefined, { requireRegularFile: true });
    attempts.push(attempt);
    const err = await withTimeout(
      attempt.then(
        () => undefined,
        (e: unknown) => e
      ),
      2000,
      "FIFO read"
    );
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).message).toContain("not a regular file");
    if (before >= 0) expect(fdLinksTo(dir)).toBe(before);
  });

  it("rejects a directory with the same typed error", async () => {
    const sub = path.join(dir, "subdir");
    await fs.mkdir(sub);
    const err = await readFileString(runtime, sub, undefined, { requireRegularFile: true }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).message).toContain("not a regular file");
  });

  it("reads regular files and symlinks to regular files exactly like the default path", async () => {
    const file = path.join(dir, "plan.md");
    const content = "# plan\n\nline two\n".repeat(200);
    await fs.writeFile(file, content);
    const link = path.join(dir, "link.md");
    await fs.symlink(file, link);
    expect(await readFileString(runtime, file, undefined, { requireRegularFile: true })).toBe(
      content
    );
    expect(await readFileString(runtime, link, undefined, { requireRegularFile: true })).toBe(
      content
    );
    expect(await readFileString(runtime, file)).toBe(content);
  });

  it("keeps the acquired inode when the path is swapped to a FIFO after acquisition", async () => {
    const file = path.join(dir, "plan.md");
    const content = "# original\n" + "x".repeat(200_000);
    await fs.writeFile(file, content);
    const stream = runtime.readFile(file, undefined, { requireRegularFile: true });
    const reader = stream.getReader();
    const first = await reader.read(); // acquisition + classification happened
    expect(first.done).toBe(false);
    await fs.rename(file, file + ".moved");
    mkfifo("plan.md");
    const chunks = [first.value!];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(content);
  });

  it("default readFile still streams a FIFO that has a writer (special-file semantics unchanged)", async () => {
    const fifo = mkfifo("stream.fifo");
    const writer = spawn("sh", ["-c", `printf 'hello fifo' > "$0"`, fifo], { stdio: "ignore" });
    // Attach before reading: the writer normally exits before the read settles and 'exit' does not replay.
    const writerExit = new Promise((r) => writer.once("exit", r));
    const attempt = readFileString(runtime, fifo);
    attempts.push(attempt);
    const text = await withTimeout(attempt, 5000, "default FIFO read");
    expect(text).toBe("hello fifo");
    await writerExit;
  });

  it("an abort before consumption surfaces the abort and leaks no descriptor", async () => {
    const file = path.join(dir, "plan.md");
    await fs.writeFile(file, "# plan\n");
    const before = fdLinksTo(dir);
    const controller = new AbortController();
    const stream = runtime.readFile(file, controller.signal, { requireRegularFile: true });
    controller.abort(new Error("stop"));
    const err = await readFromStream(stream).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RuntimeError);
    await new Promise((r) => setTimeout(r, 20));
    if (before >= 0) expect(fdLinksTo(dir)).toBe(before);
  });

  it("consumer cancel after acquisition closes the descriptor", async () => {
    const file = path.join(dir, "plan.md");
    await fs.writeFile(file, "y".repeat(300_000));
    const before = fdLinksTo(dir);
    const stream = runtime.readFile(file, undefined, { requireRegularFile: true });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("enough");
    await new Promise((r) => setTimeout(r, 20));
    if (before >= 0) expect(fdLinksTo(dir)).toBe(before);
  });
});

async function readFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
