import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { createMemoryHost } from "@/node/services/hostFiles/memoryHostFiles.testHarness";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { readFileString, writeFileString } from "@/node/utils/runtime/helpers";
import { LocalRuntime } from "./LocalRuntime";
import { RuntimeError, isRuntimePathAbsentError, type Runtime } from "./Runtime";

interface RuntimeUnderTest extends Disposable {
  runtime: Runtime;
  /** An existing, empty folder. */
  root: string;
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
        [Symbol.dispose]: () => undefined,
      };
    },
  ],
])("the file contract on %s", (_name, create) => {
  test("a written file reads back, and the write creates its parent folders", async () => {
    using under = create();
    const file = path.join(under.root, "a", "b", "note.txt");
    await writeFileString(under.runtime, file, "hello\n");
    expect(await readFileString(under.runtime, file)).toBe("hello\n");
  });

  test("stat gives the size of a file and marks a folder", async () => {
    using under = create();
    const file = path.join(under.root, "note.txt");
    await writeFileString(under.runtime, file, "four");
    expect(await under.runtime.stat(file)).toMatchObject({ size: 4, isDirectory: false });
    expect(await under.runtime.stat(under.root)).toMatchObject({ isDirectory: true });
  });

  test("stat and readFile of a missing path fail as an absent path", async () => {
    using under = create();
    const missing = path.join(under.root, "missing.txt");
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
    const dir = path.join(under.root, "x", "y");
    await under.runtime.ensureDir(dir);
    await under.runtime.ensureDir(dir);
    expect(await under.runtime.stat(dir)).toMatchObject({ isDirectory: true });
  });

  test("normalizePath resolves a relative path and '.' against the base", () => {
    using under = create();
    expect(under.runtime.normalizePath("c/d", "/a/b")).toBe("/a/b/c/d");
    expect(under.runtime.normalizePath(".", "/a/b")).toBe("/a/b");
  });
});

describe("FakeRuntime", () => {
  test("has no location, so tools take their host branch", () => {
    const runtime: Runtime = createMemoryHost().runtime;
    expect(runtime.location).toBeUndefined();
  });

  test("shares its volume with the memory HostFiles", async () => {
    const host = createMemoryHost();
    const file = path.join(host.paths.userHome(), "ws", "README.md");
    await writeFileString(host.runtime, "~/ws/README.md", "# hi\n");
    expect(await host.files.promises.readFile(file, "utf-8")).toBe("# hi\n");
  });

  test("the stream temp-dir cleanup deletes the folder and exits 0, and idle waits for it", async () => {
    const host = createMemoryHost();
    const tempRoot = await host.runtime.tempDir();
    await host.runtime.ensureDir(path.join(tempRoot, "stream-1", "inner"));
    const exec = await host.runtime.exec("rm -rf 'stream-1'", { cwd: tempRoot, timeout: 10 });
    expect(await exec.exitCode).toBe(0);
    await host.runtime.idle();
    const gone = await host.runtime
      .stat(path.join(tempRoot, "stream-1"))
      .catch((error: unknown) => error);
    expect(isRuntimePathAbsentError(gone)).toBe(true);
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
