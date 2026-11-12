/* eslint-disable @typescript-eslint/await-thenable -- bun:test async matchers return thenables the rule cannot see */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { readRecordFile, realRecordPath, writeRecordFile } from "./backgroundRecordFiles";

describe("background record files", () => {
  let root: string;
  let target: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bg-records-"));
    target = path.join(root, "target");
    await fs.writeFile(target, "TARGET\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("refuse a symlink in place of a record", async () => {
    const link = await realRecordPath(root, path.join(root, "meta.json"));
    await fs.symlink(target, link);

    await expect(readRecordFile(link)).rejects.toThrow();
    await expect(writeRecordFile(link, "{}")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("TARGET\n");
  });

  test.skipIf(process.platform !== "darwin")(
    "refuse a symlink in place of a folder above the record",
    async () => {
      const elsewhere = path.join(root, "elsewhere");
      await fs.mkdir(elsewhere);
      await fs.symlink(elsewhere, path.join(root, "bash_1"));
      const record = await realRecordPath(root, path.join(root, "bash_1", "meta.json"));

      await expect(writeRecordFile(record, "{}")).rejects.toThrow();
      expect(await fs.readdir(elsewhere)).toEqual([]);
    }
  );
});
