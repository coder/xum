import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionFilesMemory, symlinkInMemory } from "./memorySessionFiles.testHarness";
import { nodeSessionFiles, SessionFilesNode } from "./nodeSessionFiles";
import {
  describeFaultCases,
  describeSessionFilesContract,
} from "./sessionFiles.contract.testHarness";

describeSessionFilesContract("node", SessionFilesNode);
describeSessionFilesContract("memory", SessionFilesMemory, symlinkInMemory);
describeFaultCases("node", SessionFilesNode);
describeFaultCases("memory", SessionFilesMemory);

// Existing tests fail or observe single history steps by spying on the fs namespaces. They keep
// working only if nodeSessionFiles reads each binding when it is called.
describe("nodeSessionFiles reads node:fs at call time", () => {
  afterEach(() => {
    mock.restore();
  });

  test("a spy on the node:fs/promises namespace reaches files.promises", async () => {
    const stat = spyOn(nodeFsPromises, "stat").mockRejectedValueOnce(new Error("injected"));
    const error = await nodeSessionFiles.promises.stat(os.tmpdir()).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toEqual(new Error("injected"));
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
