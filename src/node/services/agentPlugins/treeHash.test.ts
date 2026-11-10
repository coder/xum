/* eslint-disable @typescript-eslint/await-thenable -- bun:test types `await expect(...).rejects.toThrow()` as void */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  KeptBytesLimitError,
  hashPluginTree,
  listPluginTreeRecords,
  type PluginTreeRecord,
} from "./treeHash";

const quota = { maxBytes: 10 * 1024 * 1024, maxFiles: 1_000 };
const options = { keepBytesUpTo: 64 * 1024, skipRootGit: true };

async function writeFixture(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "hooks"), { recursive: true });
  await fs.mkdir(path.join(dir, "skills", "a"), { recursive: true });
  await fs.writeFile(path.join(dir, "hooks", "stop.sh"), "#!/bin/bash\nsource lib.sh\n");
  await fs.chmod(path.join(dir, "hooks", "stop.sh"), 0o755);
  await fs.writeFile(path.join(dir, "hooks", "lib.sh"), "echo lib\n");
  await fs.writeFile(path.join(dir, "skills", "a", "SKILL.md"), "---\nname: a\n---\nBody\n");
  await fs.symlink("../../hooks/lib.sh", path.join(dir, "skills", "a", "lib.sh"));
}

describe("plugin tree records", () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    first = await fs.mkdtemp(path.join(os.tmpdir(), "xum-tree-a-"));
    second = await fs.mkdtemp(path.join(os.tmpdir(), "xum-tree-b-"));
    await writeFixture(first);
    await writeFixture(second);
  });

  afterEach(async () => {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  });

  async function differingPaths(): Promise<string[]> {
    const byPath = (records: PluginTreeRecord[]) =>
      new Map(records.map((record) => [record.path, record]));
    const a = byPath(await listPluginTreeRecords(first, quota, options));
    const b = byPath(await listPluginTreeRecords(second, quota, options));
    return [...new Set([...a.keys(), ...b.keys()])].filter(
      (key) => !Bun.deepEquals(a.get(key), b.get(key))
    );
  }

  test("one tree in two folders gives equal records", async () => {
    const records = await listPluginTreeRecords(first, quota, options);
    expect(records).toEqual(await listPluginTreeRecords(second, quota, options));
    expect(records.map((record) => [record.path, record.kind])).toEqual([
      ["hooks", "directory"],
      ["hooks/lib.sh", "file"],
      ["hooks/stop.sh", "file"],
      ["skills", "directory"],
      ["skills/a", "directory"],
      ["skills/a/SKILL.md", "file"],
      ["skills/a/lib.sh", "symlink"],
    ]);
  });

  test.each([
    ["bytes", () => fs.writeFile(path.join(second, "hooks", "lib.sh"), "echo changed\n")],
    ["mode", () => fs.chmod(path.join(second, "hooks", "lib.sh"), 0o700)],
    [
      "link text",
      async () => {
        await fs.rm(path.join(second, "skills", "a", "lib.sh"));
        await fs.symlink("../../hooks/stop.sh", path.join(second, "skills", "a", "lib.sh"));
      },
    ],
  ])("a change to one entry's %s changes only that record", async (field, change) => {
    await change();
    expect(await differingPaths()).toEqual([
      field === "link text" ? "skills/a/lib.sh" : "hooks/lib.sh",
    ]);
  });

  test("a symlink record carries its link text, never its target's bytes", async () => {
    const records = await listPluginTreeRecords(first, quota, options);
    expect(records.find((record) => record.path === "skills/a/lib.sh")).toEqual({
      kind: "symlink",
      path: "skills/a/lib.sh",
      mode: expect.any(Number) as number,
      target: "../../hooks/lib.sh",
    });
  });

  test("bytes are kept only for files within keepBytesUpTo, and are the file's bytes", async () => {
    await fs.writeFile(path.join(first, "at-bound.bin"), Buffer.alloc(64 * 1024, 1));
    await fs.writeFile(path.join(first, "over-bound.bin"), Buffer.alloc(64 * 1024 + 1, 2));
    const records = await listPluginTreeRecords(first, quota, options);
    const bytesOf = (name: string) => {
      const record = records.find((entry) => entry.path === name);
      return record?.kind === "file" ? record.bytes : undefined;
    };
    expect(bytesOf("at-bound.bin")).toEqual(Buffer.alloc(64 * 1024, 1));
    expect(bytesOf("over-bound.bin")).toBeUndefined();
    expect(bytesOf("hooks/lib.sh")?.toString("utf8")).toBe("echo lib\n");
    const withoutBytes = await listPluginTreeRecords(first, quota, { skipRootGit: true });
    expect(withoutBytes.some((record) => record.kind === "file" && "bytes" in record)).toBe(false);
  });

  test("kept bytes past maxKeptBytes end the walk instead of filling memory", async () => {
    // The fixture keeps 56 bytes: stop.sh 26, lib.sh 9 and SKILL.md 21.
    await expect(
      listPluginTreeRecords(first, quota, { ...options, maxKeptBytes: 55 })
    ).rejects.toBeInstanceOf(KeptBytesLimitError);
    expect(await listPluginTreeRecords(first, quota, { ...options, maxKeptBytes: 56 })).toEqual(
      await listPluginTreeRecords(first, quota, options)
    );
  });

  test("skipRootGit drops only the top-level .git entry", async () => {
    await fs.mkdir(path.join(first, ".git", "objects"), { recursive: true });
    await fs.writeFile(path.join(first, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.mkdir(path.join(first, "skills", "a", ".git"));
    const paths = async (skipRootGit: boolean) =>
      (await listPluginTreeRecords(first, quota, { skipRootGit })).map((record) => record.path);
    expect((await paths(true)).filter((entry) => entry.startsWith(".git"))).toEqual([]);
    expect(await paths(true)).toContain("skills/a/.git");
    const gitPaths = (await paths(false)).filter((entry) => entry.split("/").includes(".git"));
    expect(gitPaths).toEqual([".git", ".git/HEAD", ".git/objects", "skills/a/.git"]);
  });

  test("skipRootGit skips the .git entry before the quota counts it", async () => {
    await fs.mkdir(path.join(first, ".git"));
    const tight = { maxBytes: quota.maxBytes, maxFiles: 7 };
    expect(await listPluginTreeRecords(first, tight, { skipRootGit: true })).toHaveLength(7);
    await expect(listPluginTreeRecords(first, tight)).rejects.toThrow("file limit");
  });

  test("two hashes of one folder are equal", async () => {
    expect(await hashPluginTree(first, quota)).toBe(await hashPluginTree(first, quota));
  });
});
