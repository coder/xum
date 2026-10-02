import * as fs from "fs/promises";
import { constants as fsConstants, type Dirent } from "fs";
import * as path from "path";
import { assert } from "@/common/utils/assert";
import type { ArtifactEntry, ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactKind } from "@/common/utils/artifactKind";

/**
 * Host-filesystem access to a workspace's artifacts dir ($XUM_SCRATCH_DIR/artifacts).
 *
 * The dir is agent-writable, so everything here treats its contents as untrusted:
 * the dir itself must not be a symlink, reads are confined to it by real path, only
 * regular files are opened (a FIFO with no writer would block open() and pin a libuv
 * threadpool thread), and reads stop at a byte cap while reading (a stat-then-read
 * check races growing files).
 *
 * Known gap (tracked): a parent folder swapped for a symlink between realpath and open
 * is still followed; O_NOFOLLOW only covers the last component.
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

export async function listArtifactsInDir(
  artifactsDir: string
): Promise<{ entries: ArtifactEntry[]; truncated: boolean }> {
  const entries: ArtifactEntry[] = [];
  let truncated = false;
  let visits = 0;
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
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readBounded(absDir);
    } catch (error) {
      if (isMissing(error)) return;
      // The root's errors surface to the caller; an unreadable subfolder is skipped.
      if (depth > 0 && isUnreadable(error)) {
        truncated = true;
        return;
      }
      throw error;
    }
    // Sorted so nested folders are walked in a deterministic order.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      if (isHiddenName(dirent.name)) continue;
      const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      // Names reads would refuse (a backslash, a drive prefix) are not listed either.
      if (typeof parseArtifactRelativePath(relPath) === "string") continue;
      const absPath = path.join(absDir, dirent.name);
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
  entries.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path));
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
  maxBytes: number
): Promise<ArtifactReadOutcome> {
  assert(Number.isInteger(maxBytes) && maxBytes > 0, "maxBytes must be a positive integer");
  const segments = parseArtifactRelativePath(relPath);
  if (typeof segments === "string") return { success: false, error: segments };

  const notFound = { success: false as const, error: `Artifact not found: ${relPath}` };
  if (!(await isUsableArtifactsRoot(artifactsDir))) return notFound;
  let realDir: string;
  let realTarget: string;
  try {
    realDir = await fs.realpath(artifactsDir);
    const candidate = path.join(realDir, ...segments);
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
    // O_NOFOLLOW closes the swap-to-symlink window between realpath and open; O_NONBLOCK
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
    const kind = getArtifactKind(relPath);
    const meta = { path: relPath, kind, size: stat.size, modifiedMs: stat.mtimeMs };
    if (stat.size > maxBytes) {
      return { success: true, data: { status: "too_large", ...meta, maxBytes } };
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
    if (total > maxBytes) {
      return { success: true, data: { status: "too_large", ...meta, size: total, maxBytes } };
    }
    const bytes = Buffer.concat(chunks, total);
    const readMeta = { ...meta, size: total };
    if (kind === "image") {
      return {
        success: true,
        data: { status: "ok", ...readMeta, encoding: "base64", content: bytes.toString("base64") },
      };
    }
    if (bytes.includes(0)) return { success: true, data: { status: "binary", ...readMeta } };
    return {
      success: true,
      data: { status: "ok", ...readMeta, encoding: "utf8", content: bytes.toString("utf8") },
    };
  } finally {
    await handle.close();
  }
}
