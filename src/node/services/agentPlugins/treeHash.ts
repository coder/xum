import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
  /**
   * The most bytes all kept files may hold together; past it the walk throws KeptBytesLimitError.
   * A review that large fails its size cap anyway, so the walk stops before it holds the quota.
   */
  maxKeptBytes?: number;
  /** Skip the top-level `.git` entry: a staged clone keeps it until promotion. */
  skipRootGit?: boolean;
}

export class KeptBytesLimitError extends Error {}

const treeChanged = () =>
  new Error(
    "Installed plugin files changed during component review. Refresh the component inventory."
  );

function sameStat(
  a: Stats,
  b: Stats,
  fields: ReadonlyArray<"dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">
): boolean {
  return fields.every((field) => a[field] === b[field]);
}

async function hashWalkedFile(
  rootReal: string,
  file: string,
  stat: Stats,
  keep: ((chunk: Buffer) => void) | undefined
): Promise<string> {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStat(opened, stat, ["dev", "ino", "size"])) throw treeChanged();
    await ensurePathContained(rootReal, file);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size));
    for (let offset = 0; offset < stat.size; ) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) throw treeChanged();
      const chunk = buffer.subarray(0, Math.min(bytesRead, stat.size - offset));
      hash.update(chunk);
      keep?.(Buffer.from(chunk));
      offset += chunk.length;
    }
    if (!sameStat(await handle.stat(), stat, ["size", "mtimeMs", "ctimeMs"])) throw treeChanged();
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

class PluginTreeWalk {
  readonly records: PluginTreeRecord[] = [];
  private entries = 0;
  private bytes = 0;
  private keptBytes = 0;

  constructor(
    readonly rootReal: string,
    private readonly quota: PluginTreeQuota,
    private readonly options: PluginTreeWalkOptions
  ) {}

  async run(): Promise<void> {
    const skipped =
      this.options.skipRootGit === true ? path.join(this.rootReal, ".git") : undefined;
    const pending = [this.rootReal];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      pending.push(...(await this.visit(current, skipped)));
    }
  }

  private async visit(current: string, skipped: string | undefined): Promise<string[]> {
    const stat = await fs.lstat(current);
    const relative = path.relative(this.rootReal, current).split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(current);
      this.records.push({ kind: "symlink", path: relative, mode: stat.mode, target });
      return [];
    }
    await ensurePathContained(this.rootReal, current);
    if (stat.isDirectory()) {
      this.records.push({ kind: "directory", path: relative, mode: stat.mode });
      return this.children(current, skipped);
    }
    if (!stat.isFile())
      throw new Error(`Installed plugin contains an unsupported file: ${relative}`);
    await this.visitFile(current, relative, stat);
    return [];
  }

  private async children(current: string, skipped: string | undefined): Promise<string[]> {
    const children: string[] = [];
    for await (const entry of await fs.opendir(current)) {
      const child = path.join(current, entry.name);
      if (child === skipped) continue;
      if (++this.entries > this.quota.maxFiles)
        throw new Error("Installed plugin exceeds the component review file limit.");
      children.push(child);
    }
    return children;
  }

  private async visitFile(current: string, relative: string, stat: Stats): Promise<void> {
    this.bytes += stat.size;
    if (this.bytes > this.quota.maxBytes)
      throw new Error("Installed plugin exceeds the component review size limit.");
    const kept = this.claimKeptBytes(stat.size) ? ([] as Buffer[]) : undefined;
    const hash = await hashWalkedFile(this.rootReal, current, stat, kept && ((c) => kept.push(c)));
    const file = { kind: "file", path: relative, mode: stat.mode, hash } as const;
    this.records.push(kept !== undefined ? { ...file, bytes: Buffer.concat(kept) } : file);
  }

  private claimKeptBytes(size: number): boolean {
    if (this.options.keepBytesUpTo === undefined || size > this.options.keepBytesUpTo) return false;
    this.keptBytes += size;
    if (this.keptBytes > (this.options.maxKeptBytes ?? Infinity)) throw new KeptBytesLimitError();
    return true;
  }
}

async function walkPluginTree(
  root: string,
  quota: PluginTreeQuota,
  options: PluginTreeWalkOptions
): Promise<{ rootReal: string; records: PluginTreeRecord[] }> {
  const rootReal = await fs.realpath(root);
  if (!(await fs.lstat(rootReal)).isDirectory()) throw treeChanged();
  const walk = new PluginTreeWalk(rootReal, quota, options);
  await walk.run();
  if ((await fs.realpath(root)) !== rootReal) throw treeChanged();
  return { rootReal, records: walk.records };
}

export function pluginTreeRecordContent(record: PluginTreeRecord): string {
  return record.kind === "file" ? record.hash : record.kind === "symlink" ? record.target : "";
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
      pluginTreeRecordContent(record),
    ])
    .sort(([a], [b]) => byPath(a, b));
  return createHash("sha256")
    .update(JSON.stringify([rootReal, hashed]))
    .digest("hex");
}
