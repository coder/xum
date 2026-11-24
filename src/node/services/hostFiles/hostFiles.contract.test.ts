import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeFsPromises from "node:fs/promises";
import * as hostFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describeHostFilesContract } from "./hostFiles.contract.testHarness";
import { createMemoryHost } from "./memoryHostFiles.testHarness";
import { nodeHostFiles, nodeHostPaths } from "./nodeHostFiles";

describeHostFilesContract("node", () => ({
  files: nodeHostFiles,
  paths: nodeHostPaths,
  symlink: (target, link) => hostFs.symlink(target, link),
}));
describeHostFilesContract("memory", createMemoryHost);

test("two memory hosts share no file", async () => {
  const first = createMemoryHost();
  const second = createMemoryHost();
  const file = path.join(first.paths.tmpDir(), "only-in-first");
  await first.files.promises.writeFile(file, "x");
  const code = await second.files.promises.readFile(file).then(
    () => "read",
    (error: NodeJS.ErrnoException) => error.code
  );
  expect(code).toBe("ENOENT");
});

// Existing tests spy on the node:fs/promises and node:os namespaces. They keep working on the
// moved callers only if the Node layers read each binding when it is called.
describe("the Node layers read their bindings at call time", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a spy on the node:fs/promises namespace reaches files.promises", async () => {
    const readFile = spyOn(nodeFsPromises, "readFile").mockRejectedValueOnce(new Error("injected"));
    const error = await nodeHostFiles.promises.readFile(os.tmpdir()).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toEqual(new Error("injected"));
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  test("a spy on os.homedir and os.tmpdir reaches HostPaths", () => {
    spyOn(os, "homedir").mockReturnValue("/spied/home");
    spyOn(os, "tmpdir").mockReturnValue("/spied/tmp");
    expect([nodeHostPaths.userHome(), nodeHostPaths.tmpDir()]).toEqual([
      "/spied/home",
      "/spied/tmp",
    ]);
  });

  test("xumHome reads XUM_ROOT at each call", () => {
    const previous = process.env.XUM_ROOT;
    try {
      process.env.XUM_ROOT = "/first/root";
      const first = nodeHostPaths.xumHome();
      process.env.XUM_ROOT = "/second/root";
      expect([first, nodeHostPaths.xumHome()]).toEqual(["/first/root", "/second/root"]);
    } finally {
      if (previous === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previous;
    }
  });
});
