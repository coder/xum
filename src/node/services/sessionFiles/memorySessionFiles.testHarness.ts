/**
 * SessionFilesMemory: SessionFiles on a memfs volume, for tests that must not touch the disk.
 *
 * memfs gives every member the history code calls. Three gaps would let a test pass on memory and
 * fail on the host, so this layer fixes them in the memfs Superblock (`vol._core`) of its own
 * volume. The Superblock is where the sync, callback and promise APIs (and writeFileAtomic, which
 * gets the memfs fs) all end, so one fix covers every path:
 *
 * 1. unlink of a directory throws EPERM in memfs. Linux gives EISDIR, so on Linux the fix throws
 *    EISDIR (other hosts keep EPERM, which is what they give).
 * 2. rename of a directory onto a non-empty directory replaces it in memfs. The host refuses with
 *    ENOTEMPTY.
 * 3. sameStamps (historyAppendProvenance.ts) compares dev, ino, size, mtimeNs and ctimeNs. memfs
 *    hands out a released inode number again, keeps ctime on rename, and has ms times, so a quick
 *    rewrite can keep every stamp. The fix never reuses an inode number, sets ctime on rename, and
 *    runs each node's times through a per-volume clock that moves at least 1 ms (1e6 ns) on every
 *    change. Moving the times, not a stat shim, keeps every stat path (stat, lstat, fstat, handle
 *    stat) consistent with no wrapper around each.
 */
import { Layer } from "effect";
import { createFsFromVolume, Volume } from "memfs";
import type * as nodeFsPromises from "node:fs/promises";
import { SessionFilesTag } from "@/node/services/di/tags";
import { ensurePrivateDir } from "@/node/utils/fs";
import writeFileAtomic, {
  fsyncParentDirectory,
  type WriteFileAtomicFs,
} from "@/node/utils/writeFileAtomic";
import type { SessionFiles } from "./sessionFiles";

/** The parts of a memfs 4.80.0 node and Superblock that the fixes use. */
interface MemNode {
  mtime: Date;
  ctime: Date;
}
interface MemCore {
  ino: number;
  inodes: Record<number, MemNode>;
  newInoNumber(): number;
  createNode(mode: number): MemNode;
  unlink(filename: string): void;
  rename(oldPath: string, newPath: string): void;
  getLinkOrThrow(filename: string): { getNode(): MemNode };
}

export type MemFs = ReturnType<typeof createFsFromVolume>;

function systemError(code: string, text: string, syscall: string, target: string): Error {
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${target}'`), {
    code,
    syscall,
    path: target,
  });
}

/* eslint-disable local/no-sync-fs-methods -- these sync calls read the memfs volume in memory,
   inside Superblock methods that are synchronous themselves. */
function fixSuperblock(core: MemCore, fs: MemFs): void {
  const isDirectory = (target: string) =>
    fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true;

  // Fix 1.
  const unlink = core.unlink.bind(core);
  core.unlink = (filename) => {
    if (process.platform === "linux" && isDirectory(filename))
      throw systemError("EISDIR", "illegal operation on a directory", "unlink", filename);
    unlink(filename);
  };

  // Fix 2, and the ctime part of fix 3.
  const rename = core.rename.bind(core);
  core.rename = (oldPath, newPath) => {
    // rename(2) onto the same file does nothing on the host: no ENOTEMPTY and no ctime change.
    // Inode numbers are unique here (fix 3), so the ino tells the same file.
    const target = fs.lstatSync(newPath, { throwIfNoEntry: false });
    if (
      target !== undefined &&
      fs.lstatSync(oldPath, { throwIfNoEntry: false })?.ino === target.ino
    )
      return;
    if (isDirectory(oldPath) && isDirectory(newPath) && fs.readdirSync(newPath).length > 0)
      throw systemError("ENOTEMPTY", "directory not empty", "rename", `${oldPath}' -> '${newPath}`);
    rename(oldPath, newPath);
    core.getLinkOrThrow(newPath).getNode().ctime = new Date();
  };

  // Fix 3: inode numbers only count up (memfs pops released ones first).
  core.newInoNumber = () => (core.ino += 1);

  // Fix 3: memfs sets a node time to "now" on each change; every such time goes through the clock.
  let last = 0;
  const tick = (date: Date) => {
    last = Math.max(date.getTime(), last + 1);
    return new Date(last);
  };
  const withClock = (node: MemNode) => {
    let mtime = tick(node.mtime);
    let ctime = tick(node.ctime);
    Object.defineProperty(node, "ctime", {
      get: () => ctime,
      set: (date: Date) => (ctime = tick(date)),
    });
    Object.defineProperty(node, "mtime", {
      get: () => mtime,
      set: (date: Date) => {
        mtime = tick(date);
        node.ctime = date;
      },
    });
  };
  Object.values(core.inodes).forEach(withClock);
  const createNode = core.createNode.bind(core);
  core.createNode = (mode) => {
    const node = createNode(mode);
    withClock(node);
    return node;
  };
}
/* eslint-enable local/no-sync-fs-methods */

/** A fresh memfs volume with the three fixes above (also the base of the HostFiles memory layer). */
export function createFixedMemfs(): MemFs {
  const volume = new Volume();
  const fs = createFsFromVolume(volume);
  fixSuperblock(volume._core as unknown as MemCore, fs);
  return fs;
}

/** Each build's memfs fs, so a contract hook can reach what SessionFiles does not expose. */
const volumes = new WeakMap<SessionFiles, MemFs>();

/** The contract's symlink hook for the memory layer (SessionFiles has no symlink member). */
export async function symlinkInMemory(files: SessionFiles, target: string, link: string) {
  const fs = volumes.get(files);
  if (fs === undefined) throw new Error("not a SessionFilesMemory instance");
  await fs.promises.symlink(target, link);
}

// Layer.sync runs the function at each build of the layer, so each build gets a fresh volume and
// no module-level instance exists.
export const SessionFilesMemory = Layer.sync(SessionFilesTag, () => {
  const fs = createFixedMemfs();
  // memfs declares its own types for the same node:fs signatures.
  const atomicFs = fs as unknown as WriteFileAtomicFs;
  const privateDirFs = fs.promises as unknown as Pick<typeof nodeFsPromises, "mkdir" | "chmod">;
  const host = fs as unknown as Omit<
    SessionFiles,
    "writeFileAtomic" | "fsyncParentDirectory" | "ensurePrivateDir"
  >;
  const files: SessionFiles = {
    promises: host.promises,
    constants: host.constants,
    fsyncSync: host.fsyncSync,
    renameSync: host.renameSync,
    rmdirSync: host.rmdirSync,
    rmSync: host.rmSync,
    unlinkSync: host.unlinkSync,
    writeSync: host.writeSync,
    writeFileAtomic: (target, data, options) =>
      writeFileAtomic(target, data, { ...options, fs: atomicFs }),
    fsyncParentDirectory: (target) => fsyncParentDirectory(target, atomicFs),
    ensurePrivateDir: (dirPath) => ensurePrivateDir(dirPath, privateDirFs),
  };
  volumes.set(files, fs);
  return files;
});
