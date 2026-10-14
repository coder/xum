import { describe, expect, spyOn, test } from "bun:test";
import fs from "fs";
import os from "os";
import * as path from "path";
import { publishCompactionFile } from "./continuousCompactionJournal";

// rename(2) is durable only once the parent directory entry is flushed (#5331, #5344). Windows
// cannot fsync directory handles, so it skips this step.
/* eslint-disable local/no-sync-fs-methods -- the spy classifies descriptors inline, as the
   writeFileAtomic durability tests do. */
describe.skipIf(process.platform === "win32")("publishCompactionFile", () => {
  test("flushes the parent directory after the final rename", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "compaction-publish-"));
    const target = path.join(dir, "journal.json");
    const fsync = fs.fsync;
    const targetPresentAtDirectoryFlush: boolean[] = [];
    const fsyncSpy = spyOn(fs, "fsync").mockImplementation(((
      fd: number,
      callback: fs.NoParamCallback
    ) => {
      if (fs.fstatSync(fd).isDirectory()) {
        targetPresentAtDirectoryFlush.push(fs.existsSync(target));
      }
      return fsync(fd, callback);
    }) as typeof fs.fsync);
    try {
      expect(await publishCompactionFile(target, "receipt", () => true)).toBe(true);
    } finally {
      fsyncSpy.mockRestore();
    }
    try {
      expect(await fs.promises.readFile(target, "utf8")).toBe("receipt");
      // Staging flushes the directory before the target exists; publication must flush it again
      // once the rename has landed.
      expect(targetPresentAtDirectoryFlush.at(-1)).toBe(true);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
/* eslint-enable local/no-sync-fs-methods */
