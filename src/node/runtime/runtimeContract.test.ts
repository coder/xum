import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { LocalRuntime } from "./LocalRuntime";
import { RuntimeError, isRuntimePathAbsentError, type ExecOptions, type Runtime } from "./Runtime";

interface RuntimeUnderTest extends Disposable {
  runtime: Runtime;
  /** An existing, empty folder. */
  root: string;
  /** The path rules of the runtime: the platform's for LocalRuntime, POSIX for the fake. */
  path: path.PlatformPath;
}

// The file members that loop tools use must behave alike on LocalRuntime and on FakeRuntime, so a
// tool test that swaps one for the other sees the same results.
describe.each<[string, () => RuntimeUnderTest]>([
  [
    "LocalRuntime",
    () => {
      const dir = new TestTempDir("runtime-contract");
      return {
        runtime: new LocalRuntime(dir.path),
        root: dir.path,
        path,
        [Symbol.dispose]: () => dir[Symbol.dispose](),
      };
    },
  ],
  [
    "FakeRuntime",
    () => {
      const host = createMemoryHost();
      return {
        runtime: host.runtime,
        root: host.paths.tmpDir(),
        path: path.posix,
        [Symbol.dispose]: () => undefined,
      };
    },
  ],
])("the file contract on %s", (_name, create) => {
  test("a written file reads back, and the write creates its parent folders", async () => {
    using under = create();
    const file = under.path.join(under.root, "a", "b", "note.txt");
    await writeFileString(under.runtime, file, "hello\n");
    expect(await readFileString(under.runtime, file)).toBe("hello\n");
  });

  test("stat gives the size of a file and marks a folder", async () => {
    using under = create();
    const file = under.path.join(under.root, "note.txt");
    await writeFileString(under.runtime, file, "four");
    expect(await under.runtime.stat(file)).toMatchObject({ size: 4, isDirectory: false });
    expect(await under.runtime.stat(under.root)).toMatchObject({ isDirectory: true });
  });

  test("stat and readFile of a missing path fail as an absent path", async () => {
    using under = create();
    const missing = under.path.join(under.root, "missing.txt");
    for (const attempt of [
      () => under.runtime.stat(missing),
      () => readFileString(under.runtime, missing),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).type).toBe("file_io");
      expect(isRuntimePathAbsentError(error)).toBe(true);
    }
  });

  test("ensureDir creates nested folders and accepts an existing one", async () => {
    using under = create();
    const dir = under.path.join(under.root, "x", "y");
    await under.runtime.ensureDir(dir);
    await under.runtime.ensureDir(dir);
    expect(await under.runtime.stat(dir)).toMatchObject({ isDirectory: true });
  });

  test("an abort after the first chunk, before the consumer reads the end, errors the stream", async () => {
    using under = create();
    const file = under.path.join(under.root, "abort.txt");
    await writeFileString(under.runtime, file, "data");
    const controller = new AbortController();
    const reader = under.runtime.readFile(file, controller.signal).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data");
    controller.abort();
    const end = await reader.read().catch((error: unknown) => error);
    expect((end as RuntimeError).message).toBe(`Read of ${file} aborted`);
  });

  test("an abort right after a read of a missing path starts wins over the missing path", async () => {
    using under = create();
    const missing = under.path.join(under.root, "missing.txt");
    const controller = new AbortController();
    const stream = under.runtime.readFile(missing, controller.signal);
    controller.abort();
    const read = await stream
      .getReader()
      .read()
      .catch((error: unknown) => error);
    expect((read as RuntimeError).message).toBe(`Read of ${missing} aborted`);
  });

  test("normalizePath resolves a relative path and '.' against the base", () => {
    using under = create();
    expect(under.runtime.normalizePath("c/d", "/a/b")).toBe(under.path.resolve("/a/b", "c/d"));
    expect(under.runtime.normalizePath(".", "/a/b")).toBe(under.path.resolve("/a/b"));
  });
});

describe("FakeRuntime", () => {
  test("has no location, so tools take their host branch", () => {
    const runtime: Runtime = createMemoryHost().runtime;
    expect(runtime.location).toBeUndefined();
  });

  test("shares its volume with the memory HostFiles", async () => {
    const host = createMemoryHost();
    const file = path.posix.join(host.paths.userHome(), "ws", "README.md");
    await writeFileString(host.runtime, "~/ws/README.md", "# hi\n");
    expect(await host.files.promises.readFile(file, "utf-8")).toBe("# hi\n");
  });

  // The paths of streamManager.ts: createTempDirForStream makes ~/.xum-tmp/<token>, and
  // cleanupStreamTempDir runs rm -rf '<token>' in its parent.
  test("the stream temp-dir cleanup deletes the folder and exits 0, and idle waits for it", async () => {
    const host = createMemoryHost();
    const streamDir = await host.runtime.resolvePath("~/.xum-tmp/stream-1");
    await host.runtime.ensureDir(path.posix.join(streamDir, "inner"));
    const exec = await host.runtime.exec("rm -rf 'stream-1'", {
      cwd: path.posix.dirname(streamDir),
      timeout: 10,
    });
    expect(await exec.exitCode).toBe(0);
    await host.runtime.idle();
    const gone = await host.runtime.stat(streamDir).catch((error: unknown) => error);
    expect(isRuntimePathAbsentError(gone)).toBe(true);
  });

  test("the cleanup rule refuses . and .., which name the temp root and the home", async () => {
    const host = createMemoryHost();
    const streamDir = await host.runtime.resolvePath("~/.xum-tmp/stream-1");
    await host.runtime.ensureDir(streamDir);
    for (const name of [".", ".."]) {
      const refusal = await host.runtime
        .exec(`rm -rf '${name}'`, { cwd: path.posix.dirname(streamDir) })
        .catch((error: unknown) => error);
      expect((refusal as RuntimeError).type).toBe("exec");
    }
    expect(await host.runtime.stat(streamDir)).toMatchObject({ isDirectory: true });
  });

  test("an option that the entry cannot honor is refused by name, and one that holds passes", async () => {
    const host = createMemoryHost({
      commands: { "git status": { stdout: "clean\n" }, "git fetch": () => ({ stdout: "" }) },
    });
    const run = (command: string, options: Omit<ExecOptions, "cwd">) =>
      host.runtime.exec(command, { cwd: "/", ...options }).then(
        (exec) => exec.exitCode,
        (error: Error) => error.message
      );
    // A fixed outcome settles at once and reads no environment.
    expect(await run("git status", { timeout: 10, env: { A: "1" } })).toBe(0);
    expect(await run("git status", { forcePTY: true })).toBe(
      "The scripted layer cannot honor the option forcePTY for: git status"
    );
    // A function entry can be slow and gets only the call.
    expect(await run("git fetch", { timeout: 10 })).toBe(
      "The scripted layer cannot honor the option timeout for: git fetch"
    );
    expect(await run("git fetch", { env: { A: "1" } })).toBe(
      "The scripted layer cannot honor the option env for: git fetch"
    );
  });

  test("readFile and ensureDir with an already aborted signal reject before they act", async () => {
    const host = createMemoryHost();
    await writeFileString(host.runtime, "/tmp/note.txt", "hi");
    const signal = AbortSignal.abort();
    const read = await readFileString(host.runtime, "/tmp/note.txt", signal).catch(
      (error: unknown) => error
    );
    expect([(read as RuntimeError).type, (read as RuntimeError).message]).toEqual([
      "file_io",
      "Read of /tmp/note.txt aborted",
    ]);
    const made = await host.runtime.ensureDir("/tmp/new", signal).catch((error: unknown) => error);
    expect((made as RuntimeError).type).toBe("file_io");
    expect(await host.files.promises.readdir("/tmp")).toEqual(["note.txt"]);
  });

  test("a read whose signal aborts after it started errors the stream", async () => {
    const host = createMemoryHost();
    await writeFileString(host.runtime, "/tmp/note.txt", "hi");
    const controller = new AbortController();
    const stream = host.runtime.readFile("/tmp/note.txt", controller.signal);
    controller.abort();
    const read = await new Response(stream).text().catch((error: unknown) => error);
    expect((read as RuntimeError).message).toBe("Read of /tmp/note.txt aborted");
  });

  test("a function entry refuses an abort signal, which it could outlive", async () => {
    const host = createMemoryHost({ commands: { "git fetch": () => ({ stdout: "" }) } });
    const refusal = await host.runtime
      .exec("git fetch", { cwd: "/", abortSignal: new AbortController().signal })
      .catch((error: Error) => error.message);
    expect(refusal).toBe("The scripted layer cannot honor the option abortSignal for: git fetch");
  });

  test("an exec whose signal is already aborted runs nothing", async () => {
    const host = createMemoryHost();
    const streamDir = await host.runtime.resolvePath("~/.xum-tmp/stream-1");
    await host.runtime.ensureDir(streamDir);
    const refusal = await host.runtime
      .exec("rm -rf 'stream-1'", {
        cwd: path.posix.dirname(streamDir),
        abortSignal: AbortSignal.abort(),
      })
      .catch((error: unknown) => error);
    expect((refusal as RuntimeError).type).toBe("exec");
    expect(await host.runtime.stat(streamDir)).toMatchObject({ isDirectory: true });
  });

  test("a write keeps each chunk as it was when written", async () => {
    const host = createMemoryHost();
    const writer = host.runtime.writeFile("/tmp/chunks.txt").getWriter();
    const scratch = new TextEncoder().encode("ab");
    await writer.write(scratch);
    scratch.set(new TextEncoder().encode("cd"));
    await writer.write(scratch);
    await writer.close();
    expect(await readFileString(host.runtime, "/tmp/chunks.txt")).toBe("abcd");
  });

  test("answers a scripted command and refuses any other with its name", async () => {
    const host = createMemoryHost({
      commands: { "git status": { stdout: "clean\n", exitCode: 1 } },
    });
    const exec = await host.runtime.exec("git status", { cwd: "/" });
    expect(await new Response(exec.stdout).text()).toBe("clean\n");
    expect(await exec.exitCode).toBe(1);

    const refusal = await host.runtime
      .exec("rm -rf 'x'", { cwd: "/" })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RuntimeError);
    expect((refusal as RuntimeError).type).toBe("exec");
    expect((refusal as RuntimeError).message).toContain("rm -rf 'x'");
    expect(host.runtime.execs).toEqual(["git status", "rm -rf 'x'"]);
  });
});
