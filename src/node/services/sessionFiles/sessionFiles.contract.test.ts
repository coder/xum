import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nodeSessionFiles, SessionFilesNode } from "./nodeSessionFiles";
import { describeSessionFilesContract } from "./sessionFiles.contract.testHarness";

describeSessionFilesContract("node", SessionFilesNode);

// Existing tests fail or observe single history steps by spying on the fs namespaces. They keep
// working only if nodeSessionFiles reads each binding when it is called.
describe("nodeSessionFiles reads node:fs at call time", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a spy on the node:fs/promises namespace reaches files.promises", async () => {
    const stat = spyOn(nodeFsPromises, "stat").mockRejectedValueOnce(new Error("injected"));
    await expect(nodeSessionFiles.promises.stat(os.tmpdir())).rejects.toThrow("injected");
    expect(stat).toHaveBeenCalledTimes(1);
  });

  test("a spy on the node:fs namespace reaches the sync members", () => {
    const fsync = spyOn(nodeFs, "fsyncSync").mockImplementation(() => undefined);
    const rename = spyOn(nodeFs, "renameSync").mockImplementation(() => undefined);
    nodeSessionFiles.fsyncSync(-1);
    nodeSessionFiles.renameSync(path.join(os.tmpdir(), "a"), path.join(os.tmpdir(), "b"));
    expect([fsync.mock.calls.length, rename.mock.calls.length]).toEqual([1, 1]);
  });
});
