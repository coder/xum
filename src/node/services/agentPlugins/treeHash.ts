import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "@/common/utils/assert";
import { ensurePathContained } from "@/node/services/tools/skillFileUtils";

/**
 * One entry of a plugin tree. `path` is relative to the plugin folder, with forward slashes, so a
 * record compares equal between two copies of one tree in different folders (the file review).
 */
export type PluginTreeRecord =
  | { kind: "file"; path: string; mode: number; hash: string; bytes?: Buffer }
  | { kind: "symlink"; path: string; mode: number; target: string }
  | { kind: "directory"; path: string; mode: number };

interface PluginTreeQuota {
  maxBytes: number;
  maxFiles: number;
}

interface PluginTreeWalkOptions {
  /**
   * Keep the bytes of each regular file of at most this size. They come from the read that hashes
   * the file, so a review shows exactly the hashed bytes and never opens the file a second time.
   */
  keepBytesUpTo?: number;
  /** Skip the top-level `.git` entry: a staged clone keeps it until promotion. */
  skipRootGit?: boolean;
}

/**
 * Walks the tree without following any symlink: a link contributes its link text, and a regular
 * file is read only through an O_NOFOLLOW handle whose identity matches the lstat of the walk.
 * The records include the root folder itself (path "").
 */
async function walkPluginTree(
  root: string,
  quota: PluginTreeQuota,
  options: PluginTreeWalkOptions
): Promise<{ rootReal: string; records: PluginTreeRecord[] }> {
  const changed = () =>
    new Error(
      "Installed plugin files changed during component review. Refresh the component inventory."
    );
  const rootReal = await fs.realpath(root);
  if (!(await fs.lstat(rootReal)).isDirectory()) throw changed();
  const pending = [rootReal];
  const records: PluginTreeRecord[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined, "walkPluginTree: queue underflow");
    const stat = await fs.lstat(current);
    const relative = path.relative(rootReal, current).split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      records.push({
        kind: "symlink",
        path: relative,
        mode: stat.mode,
        target: await fs.readlink(current),
      });
      continue;
    }
    await ensurePathContained(rootReal, current);
    if (stat.isDirectory()) {
      const directory = await fs.opendir(current);
      for await (const entry of directory) {
        if (options.skipRootGit === true && current === rootReal && entry.name === ".git") continue;
        if (++entries > quota.maxFiles)
          throw new Error("Installed plugin exceeds the component review file limit.");
        pending.push(path.join(current, entry.name));
      }
      records.push({ kind: "directory", path: relative, mode: stat.mode });
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > quota.maxBytes)
        throw new Error("Installed plugin exceeds the component review size limit.");
      const handle = await fs.open(
        current,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
      );
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        )
          throw changed();
        await ensurePathContained(rootReal, current);
        const hash = createHash("sha256");
        const kept: Buffer[] | undefined =
          options.keepBytesUpTo !== undefined && stat.size <= options.keepBytesUpTo
            ? []
            : undefined;
        let offset = 0;
        while (offset < stat.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset
          );
          if (bytesRead === 0) throw changed();
          hash.update(buffer.subarray(0, bytesRead));
          kept?.push(Buffer.from(buffer.subarray(0, bytesRead)));
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw changed();
        records.push({
          kind: "file",
          path: relative,
          mode: stat.mode,
          hash: hash.digest("hex"),
          ...(kept !== undefined ? { bytes: Buffer.concat(kept) } : {}),
        });
      } finally {
        await handle.close();
      }
    } else {
      throw new Error(`Installed plugin contains an unsupported file: ${relative}`);
    }
  }
  if ((await fs.realpath(root)) !== rootReal) throw changed();
  return { rootReal, records };
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every entry of the plugin tree except the folder itself, sorted by path. */
export async function listPluginTreeRecords(
  root: string,
  quota: PluginTreeQuota,
  options: PluginTreeWalkOptions = {}
): Promise<PluginTreeRecord[]> {
  const { records } = await walkPluginTree(root, quota, options);
  return records.filter((record) => record.path !== "").sort((a, b) => byPath(a.path, b.path));
}

/**
 * Consent covers the complete installed tree, not just preview descriptors:
 * SKILL.md bodies, referenced files and MCP executables can change behind an unchanged Git SHA.
 * Symlinks contribute their target text; contained targets are hashed at their physical paths.
 */
export async function hashPluginTree(root: string, quota: PluginTreeQuota): Promise<string> {
  const { rootReal, records } = await walkPluginTree(root, quota, {});
  // Native separators and their sort order, so the value stays what it was before the records
  // switched to forward slashes (it differs only on Windows).
  const hashed = records
    .map((record): [string, number, string] => [
      record.path.split("/").join(path.sep),
      record.mode,
      record.kind === "file" ? record.hash : record.kind === "symlink" ? record.target : "",
    ])
    .sort(([a], [b]) => byPath(a, b));
  return createHash("sha256")
    .update(JSON.stringify([rootReal, hashed]))
    .digest("hex");
}
