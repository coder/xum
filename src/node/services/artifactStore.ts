import * as fs from "fs/promises";
import { constants as fsConstants, type Dirent, type Stats } from "fs";
import * as path from "path";
import { assert } from "@/common/utils/assert";
import type { ArtifactEntry, ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind, isBinaryArtifactKind } from "@/common/utils/artifactKind";

/**
 * Host-filesystem access to a workspace's artifacts dir ($XUM_SCRATCH_DIR/artifacts).
 *
 * The dir is agent-writable, so everything here treats its contents as untrusted:
 * the dir itself must not be a symlink, reads are confined to it by real path, only
 * regular files are opened (a FIFO with no writer would block open() and pin a libuv
 * threadpool thread), and reads stop at a byte cap while reading (a stat-then-read
 * check races growing files).
 *
 * O_NOFOLLOW only covers the last component, so a parent folder swapped for a symlink
 * between realpath and open would still be followed: after open, the descriptor's real
 * path is checked against the dir (verifyOpenedInsideDir).
 *
 * A devcontainer writes its same-path scratch mount from inside the container while this host
 * reads it, so there the writer is across a trust boundary and pathname checks are not enough
 * (a swap can be undone before each re-check). Callers pass `requireDescriptorPaths` for such
 * dirs: listings then reach every folder through held descriptors and reads must verify the
 * opened descriptor, failing closed where that is impossible. Callers route these dirs through
 * the container instead on hosts without descriptor paths (artifactsOperations).
 */

/** Read granularity; small files never allocate the full cap. */
const READ_CHUNK_BYTES = 64 * 1024;

export const ARTIFACTS_DIR_NAME = "artifacts";
/** Bounds one listing IPC payload; the tab is a picker, not a file browser. */
export const MAX_ARTIFACT_LIST_ENTRIES = 500;
/** Nested folders are allowed, but a deep tree is almost certainly not meant as artifacts. */
export const MAX_ARTIFACT_LIST_DEPTH = 4;
/**
 * Directory entries (files, folders and skipped names) one listing may visit. The entry cap
 * alone does not bound the walk: thousands of empty folders would still all be read.
 */
export const MAX_ARTIFACT_LIST_VISITS = 5_000;

const PROC_SELF_FD = "/proc/self/fd";

export interface ArtifactDirAccessOptions {
  /** The dir is written from across a trust boundary (devcontainer mount): never fall back to pathname checks. */
  requireDescriptorPaths?: boolean;
}

/**
 * True when `/proc/self/fd/<fd>` names an open descriptor (Linux), so a path through it resolves
 * from the opened folder instead of re-resolving its (writable) parents. A routing hint only:
 * pinned operations still fail closed if the descriptor path does not work.
 */
export async function hostSupportsDescriptorPaths(): Promise<boolean> {
  try {
    return (await fs.stat(PROC_SELF_FD)).isDirectory();
  } catch {
    return false;
  }
}

function descriptorPath(handle: fs.FileHandle): string {
  return `${PROC_SELF_FD}/${handle.fd}`;
}

export function getArtifactsDir(scratchDir: string): string {
  assert(path.isAbsolute(scratchDir), "scratchDir must be absolute");
  return path.join(scratchDir, ARTIFACTS_DIR_NAME);
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A nested folder or file the walk may not read: skipped, so one bad subtree keeps the rest. */
function isUnreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ELOOP";
}

/** Hidden entries (dotfiles, .git, editor swap files) are never artifacts. */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * True when the artifacts dir exists as a real directory. A symlinked root (for example
 * `artifacts -> ~`) would let the tab browse anything the link points at, so it is refused.
 */
async function isUsableArtifactsRoot(artifactsDir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(artifactsDir);
    return stat.isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Real path of the artifacts dir, or null when it is missing or not a real directory.
 *
 * A devcontainer writes the same-path scratch mount from inside the container while this host
 * reads it, so `artifacts` can be swapped for a symlink between the lstat check and realpath,
 * and every later containment check would then compare against the link's target. The scratch
 * dir itself is the mount point, which the container cannot replace: the dir's real path must
 * be its parent's real path plus its own name.
 */
async function resolvePinnedArtifactsRoot(artifactsDir: string): Promise<string | null> {
  if (!(await isUsableArtifactsRoot(artifactsDir))) return null;
  const realDir = await fs.realpath(artifactsDir);
  const realParent = await fs.realpath(path.dirname(artifactsDir));
  return realDir === path.join(realParent, path.basename(artifactsDir)) ? realDir : null;
}

export async function listArtifactsInDir(
  artifactsDir: string,
  options?: ArtifactDirAccessOptions
): Promise<{ entries: ArtifactEntry[]; truncated: boolean }> {
  const entries: ArtifactEntry[] = [];
  let truncated = false;
  let visits = 0;
  // Pinned walk: each folder is opened once (O_NOFOLLOW, so a folder swapped for a symlink is
  // refused) and held while its entries are read, stat'ed and its subfolders opened, all through
  // its descriptor path. A folder swapped after the check therefore cannot redirect the walk.
  const pinned = await hostSupportsDescriptorPaths();
  if (!pinned && options?.requireDescriptorPaths === true) {
    throw new Error("Cannot list a container-written artifacts folder without descriptor paths");
  }
  if (!(await isUsableArtifactsRoot(artifactsDir))) return { entries, truncated };

  // Reads at most the rest of the visit budget from one folder. opendir streams entries, so a
  // huge folder is never materialized whole (readdir would load every entry before the cap).
  const readBounded = async (absDir: string): Promise<Dirent[]> => {
    const dirents: Dirent[] = [];
    // for await closes the handle on completion, break and throw.
    for await (const dirent of await fs.opendir(absDir)) {
      if (visits >= MAX_ARTIFACT_LIST_VISITS) {
        truncated = true;
        break;
      }
      visits += 1;
      dirents.push(dirent);
    }
    return dirents;
  };

  // Once the visit budget is spent, every further readBounded returns nothing, ending the walk.
  const walk = async (dirPath: string, relDir: string, depth: number): Promise<void> => {
    let handle: fs.FileHandle | undefined;
    try {
      let dirents;
      try {
        if (pinned) {
          handle = await fs.open(
            dirPath,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
          );
        }
        dirents = await readBounded(handle ? descriptorPath(handle) : dirPath);
      } catch (error) {
        if (isMissing(error)) return;
        // The root swapped for a symlink after the lstat check: refused like a symlinked root.
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ELOOP") return;
        // The root's errors surface to the caller; an unreadable subfolder is skipped.
        if (depth > 0 && isUnreadable(error)) {
          truncated = true;
          return;
        }
        throw error;
      }
      await walkEntries(handle ? descriptorPath(handle) : dirPath, dirents, relDir, depth);
    } finally {
      await handle?.close();
    }
  };

  const walkEntries = async (
    dirPath: string,
    dirents: Dirent[],
    relDir: string,
    depth: number
  ): Promise<void> => {
    // Sorted so nested folders are walked in a deterministic order.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name)) continue;
      const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      // Names reads would refuse (a backslash, a drive prefix) are not listed either.
      if (typeof parseArtifactRelativePath(relPath) === "string") continue;
      const absPath = path.join(dirPath, dirent.name);
      // Symlinks are skipped (not followed) so the listing can never reach outside the dir.
      if (dirent.isDirectory()) {
        if (depth >= MAX_ARTIFACT_LIST_DEPTH) {
          truncated = true;
          continue;
        }
        await walk(absPath, relPath, depth + 1);
      } else if (dirent.isFile()) {
        try {
          const stat = await fs.lstat(absPath);
          if (!stat.isFile()) continue;
          entries.push({
            path: relPath,
            kind: getArtifactKind(relPath),
            size: stat.size,
            modifiedMs: stat.mtimeMs,
          });
        } catch (error) {
          // Deleted between readdir and lstat: skip it.
          if (isMissing(error)) continue;
          if (isUnreadable(error)) {
            truncated = true;
            continue;
          }
          throw error;
        }
      }
    }
  };

  await walk(artifactsDir, "", 0);
  // Newest first, then cap: the cap must keep the newest files, not the alphabetically first.
  sortArtifactEntries(entries);
  if (entries.length > MAX_ARTIFACT_LIST_ENTRIES) {
    truncated = true;
    entries.length = MAX_ARTIFACT_LIST_ENTRIES;
  }
  return { entries, truncated };
}

/**
 * Validate a listing-relative path. Returns the POSIX segments, or an error string.
 * Hidden segments are refused too, matching the listing.
 */
export function parseArtifactRelativePath(relPath: string): string[] | string {
  if (relPath.length === 0) return "Artifact path is empty";
  if (relPath.includes("\0") || relPath.includes("\\")) return "Artifact path is invalid";
  if (relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath)) {
    return "Artifact path must be relative to the artifacts folder";
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || isHiddenName(segment)) {
      return "Artifact path is invalid";
    }
  }
  return segments;
}

export type ArtifactReadOutcome =
  | { success: true; data: ArtifactReadResult }
  | { success: false; error: string };

export async function readArtifactFromDir(
  artifactsDir: string,
  relPath: string,
  maxBytes: number,
  options?: ArtifactDirAccessOptions
): Promise<ArtifactReadOutcome> {
  assert(Number.isInteger(maxBytes) && maxBytes > 0, "maxBytes must be a positive integer");
  const segments = parseArtifactRelativePath(relPath);
  if (typeof segments === "string") return { success: false, error: segments };

  const notFound = { success: false as const, error: `Artifact not found: ${relPath}` };
  let realDir: string;
  let realTarget: string;
  let candidate: string;
  try {
    const pinnedDir = await resolvePinnedArtifactsRoot(artifactsDir);
    if (pinnedDir === null) return notFound;
    realDir = pinnedDir;
    candidate = path.join(realDir, ...segments);
    // Only regular files: refuses symlinked leaves (the listing never shows one), FIFOs,
    // sockets, devices and directories before anything is opened.
    if (!(await fs.lstat(candidate)).isFile()) return notFound;
    realTarget = await fs.realpath(candidate);
  } catch (error) {
    if (isMissing(error)) return notFound;
    throw error;
  }
  // Symlinked parent folders could still point elsewhere: confine by real path.
  if (!realTarget.startsWith(realDir + path.sep)) return notFound;

  let handle: fs.FileHandle;
  try {
    // O_NOFOLLOW closes the leaf's swap-to-symlink window between realpath and open; O_NONBLOCK
    // keeps a leaf swapped for a FIFO after the lstat check from blocking open().
    handle = await fs.open(
      realTarget,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (isMissing(error) || code === "ELOOP") return notFound;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return notFound;
    const requireDescriptorPath = options?.requireDescriptorPaths === true;
    if (
      !(await verifyOpenedInsideDir(
        handle,
        stat,
        realDir,
        candidate,
        realTarget,
        requireDescriptorPath
      ))
    ) {
      return notFound;
    }
    if (stat.size > maxBytes) {
      return {
        success: true,
        data: tooLargeArtifactResult(relPath, stat.size, stat.mtimeMs, maxBytes),
      };
    }

    // Read at most maxBytes + 1 so a file that grew after fstat is still caught.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    return {
      success: true,
      data: buildArtifactReadResult(relPath, Buffer.concat(chunks, total), stat.mtimeMs, maxBytes),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Close the parent-folder swap window: O_NOFOLLOW guards only the leaf, so a parent replaced
 * by a symlink after the realpath check is followed by open(). Check what was actually opened.
 *
 * Linux (and anything else with /proc/self/fd): the descriptor's own path must be the
 * checked target. Elsewhere: the target must still resolve to the same real path, and that
 * path's inode must be the opened one. That fallback can be raced by swapping the folder away
 * and back between the checks, so it is only for same-user writers: `requireDescriptorPath`
 * (a container-written dir) refuses the read when the descriptor path is unavailable.
 */
async function verifyOpenedInsideDir(
  handle: fs.FileHandle,
  openedStat: Stats,
  realDir: string,
  candidate: string,
  realTarget: string,
  requireDescriptorPath: boolean
): Promise<boolean> {
  let fdPath: string | undefined;
  try {
    fdPath = await fs.readlink(descriptorPath(handle));
  } catch {
    fdPath = undefined;
  }
  if (fdPath !== undefined) {
    return fdPath === realTarget && fdPath.startsWith(realDir + path.sep);
  }
  if (requireDescriptorPath) return false;
  try {
    if ((await fs.realpath(candidate)) !== realTarget) return false;
    const current = await fs.stat(realTarget);
    return current.dev === openedStat.dev && current.ino === openedStat.ino;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Result for a file over the read cap; the tab shows its path instead of a preview. */
export function tooLargeArtifactResult(
  relPath: string,
  size: number,
  modifiedMs: number,
  maxBytes: number
): ArtifactReadResult {
  return {
    status: "too_large",
    path: relPath,
    kind: getArtifactKind(relPath),
    size,
    modifiedMs,
    maxBytes,
  };
}

/**
 * Shape bytes read under the cap into the wire result, shared by host and runtime reads so
 * both return identical results. `bytes` may hold up to maxBytes + 1 bytes (the overflow
 * probe for files that grew while being read).
 */
export function buildArtifactReadResult(
  relPath: string,
  bytes: Buffer,
  modifiedMs: number,
  maxBytes: number
): ArtifactReadResult {
  if (bytes.length > maxBytes) {
    return tooLargeArtifactResult(relPath, bytes.length, modifiedMs, maxBytes);
  }
  const kind = getArtifactKind(relPath);
  const meta = { path: relPath, kind, size: bytes.length, modifiedMs };
  if (isBinaryArtifactKind(kind)) {
    return { status: "ok", ...meta, encoding: "base64", content: bytes.toString("base64") };
  }
  if (bytes.includes(0)) return { status: "binary", ...meta };
  return { status: "ok", ...meta, encoding: "utf8", content: bytes.toString("utf8") };
}

/** Newest first; ties by path, so host and runtime listings order identically. */
export function sortArtifactEntries(entries: ArtifactEntry[]): void {
  entries.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path));
}
