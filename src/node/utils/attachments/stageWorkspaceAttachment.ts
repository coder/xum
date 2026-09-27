import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import {
  MAX_STAGED_ATTACHMENT_SIZE_BYTES,
  STAGED_ATTACHMENT_DIR,
  STAGED_ATTACHMENT_DIRS,
  STAGED_ATTACHMENT_MIRROR_DIR_NAME,
} from "@/common/constants/stagedAttachments";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { getSupportedStagedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import type { Runtime } from "@/node/runtime/Runtime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { log } from "@/node/services/log";
import { ensurePrivateDir, isErrnoWithCode } from "@/node/utils/fs";
import { ensureGitInfoExclude } from "@/node/utils/git/ensureGitInfoExclude";

export interface StagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  stagedPath: string;
}

export interface DownloadedStagedWorkspaceAttachment {
  filename: string;
  mediaType: string;
  sizeBytes: number;
  dataBase64: string;
}

export async function stageWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  /** Host session dir; receives the durable mirror copy (see STAGED_ATTACHMENT_MIRROR_DIR_NAME). */
  sessionDir: string;
  filename: string;
  mediaType?: string | null;
  sizeBytes: number;
  dataBase64: string;
}): Promise<Result<StagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    assert(path.isAbsolute(input.sessionDir), "sessionDir must be absolute");
    const mediaType = getSupportedStagedAttachmentMediaType({
      mediaType: input.mediaType,
      filename: input.filename,
    });
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
      return Err("Attachment size is invalid.");
    }
    if (input.sizeBytes > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const bytes = Buffer.from(input.dataBase64, "base64");
    if (bytes.byteLength !== input.sizeBytes) {
      return Err("Attachment size did not match the uploaded data.");
    }
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const filename = sanitizeStagedFilename(input.filename);
    const excludeResult = await ensureGitInfoExclude({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    if (excludeResult.status === "failed") {
      return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
    }

    const stagedDir = `${STAGED_ATTACHMENT_DIR}/${randomUUID()}`;
    const stagedPath = `${stagedDir}/${filename}`;
    const mirrorPath = resolveStagedAttachmentMirrorPath(input.sessionDir, stagedPath);
    assert(mirrorPath != null, "freshly staged paths must map to a mirror path");
    // Mirror first: "staged" must imply durable, and a failed checkout write can clean up the
    // host-local mirror file without a runtime round trip.
    // Staging can run before the first chat write creates the session dir; keep it private like
    // HistoryService does instead of letting the mirror create it world-readable.
    await ensurePrivateDir(input.sessionDir);
    await fsPromises.mkdir(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(mirrorPath, bytes, { flag: "wx" });
    try {
      await input.runtime.ensureDir(`${input.workspacePath}/${stagedDir}`);
      await writeBytes(input.runtime, `${input.workspacePath}/${stagedPath}`, bytes);
    } catch (error) {
      await fsPromises.rm(path.dirname(mirrorPath), { recursive: true, force: true });
      throw error;
    }

    return Ok({ filename, mediaType, sizeBytes: bytes.byteLength, stagedPath });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function readStagedWorkspaceAttachment(input: {
  runtime: Runtime;
  workspacePath: string;
  sessionDir: string;
  stagedPath: string;
}): Promise<Result<DownloadedStagedWorkspaceAttachment, string>> {
  try {
    assert(input.workspacePath.trim().length > 0, "workspacePath is required");
    const stagedPath = normalizeReadableStagedPath(input.stagedPath);
    if (stagedPath == null) {
      return Err("Invalid staged attachment path.");
    }

    // Checkout first keeps today's semantics (download what the workspace holds); the mirror
    // covers checkouts that lost the git-excluded copy. Legacy uploads have no mirror entry.
    let bytes: Buffer;
    try {
      bytes = await readStreamToBuffer(
        input.runtime.readFile(`${input.workspacePath}/${stagedPath}`)
      );
    } catch (checkoutError) {
      const mirrorBytes = await readStagedAttachmentMirrorFile(input.sessionDir, stagedPath);
      if (mirrorBytes == null) {
        throw checkoutError;
      }
      bytes = mirrorBytes;
    }
    if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return Err(
        `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
      );
    }

    const filename = stagedPath.split("/").pop() ?? "attachment";
    return Ok({
      filename,
      mediaType: getSupportedStagedAttachmentMediaType({ filename }),
      sizeBytes: bytes.byteLength,
      dataBase64: bytes.toString("base64"),
    });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

export async function copyStagedWorkspaceAttachments(input: {
  sourceRuntime: Runtime;
  targetRuntime: Runtime;
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
  stagedPaths?: readonly string[];
}): Promise<Result<void, string>> {
  try {
    assert(input.sourceWorkspacePath.trim().length > 0, "sourceWorkspacePath is required");
    assert(input.targetWorkspacePath.trim().length > 0, "targetWorkspacePath is required");

    const stagedPaths = input.stagedPaths
      ? Ok(normalizeStagedAttachmentPaths(input.stagedPaths))
      : await listStagedAttachmentPaths(input.sourceRuntime, input.sourceWorkspacePath);
    if (!stagedPaths.success) {
      return stagedPaths;
    }
    if (stagedPaths.data.length === 0) {
      return Ok(undefined);
    }

    for (const relativeDir of STAGED_ATTACHMENT_DIRS) {
      const excludeResult = await ensureGitInfoExclude({
        runtime: input.targetRuntime,
        workspacePath: input.targetWorkspacePath,
        relativeDir,
      });
      if (excludeResult.status === "failed") {
        return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
      }
    }

    const shouldSkipUnreadableSource = input.stagedPaths != null;
    for (const stagedPath of stagedPaths.data) {
      let bytes: Buffer;
      try {
        bytes = await readStreamToBuffer(
          input.sourceRuntime.readFile(`${input.sourceWorkspacePath}/${stagedPath}`)
        );
      } catch (error) {
        // Fork history can contain stale generated attachment notices after users clean up
        // staged files manually. Preserve the fork rather than failing the whole workspace copy.
        if (shouldSkipUnreadableSource) {
          continue;
        }
        throw error;
      }
      if (bytes.byteLength > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
        return Err(
          `Attachments larger than ${MAX_STAGED_ATTACHMENT_SIZE_BYTES.toLocaleString()} bytes cannot be staged.`
        );
      }
      await input.targetRuntime.ensureDir(
        `${input.targetWorkspacePath}/${stagedPath.split("/").slice(0, -1).join("/")}`
      );
      await writeBytes(input.targetRuntime, `${input.targetWorkspacePath}/${stagedPath}`, bytes);
    }

    return Ok(undefined);
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

/**
 * Recreate checkout copies of mirrored staged attachments after a snapshot restore recreated the
 * checkout (#3947). Every mirror entry is restored, not only paths the chat references: an upload
 * can live only in a renderer-persisted draft that is sent after unarchive. Host-local filesystem
 * only: snapshot restores exist solely for worktree runtimes. Entries staging could not have
 * produced are skipped rather than failing the unarchive, one entry is held in memory at a time,
 * and existing files are never overwritten.
 */
export async function rehydrateStagedWorkspaceAttachments(input: {
  runtime: Runtime;
  workspacePath: string;
  sessionDir: string;
}): Promise<Result<{ restored: string[]; skipped: string[] }, string>> {
  try {
    assert(path.isAbsolute(input.workspacePath), "workspacePath must be an absolute host path");
    const restored: string[] = [];
    const skipped: string[] = [];
    const candidates: string[] = [];
    for (const stagedPath of await listStagedAttachmentMirrorPaths(input.sessionDir)) {
      if (resolveStagedAttachmentMirrorPath(input.sessionDir, stagedPath) == null) {
        skipped.push(stagedPath);
      } else {
        candidates.push(stagedPath);
      }
    }
    if (candidates.length === 0) {
      return Ok({ restored, skipped });
    }

    const excludeResult = await ensureGitInfoExclude({
      runtime: input.runtime,
      workspacePath: input.workspacePath,
      relativeDir: STAGED_ATTACHMENT_DIR,
    });
    if (excludeResult.status === "failed") {
      return Err(`Could not mark staged attachments as ignored: ${excludeResult.error}`);
    }

    // The recreated checkout is repo-controlled: a tracked `.xum` symlink would redirect writes
    // outside it, so every directory on the way down must be a real directory.
    const stagingRoot = await ensureRealDirectoryChain(
      input.workspacePath,
      STAGED_ATTACHMENT_DIR.split("/")
    );
    if (stagingRoot == null) {
      return Err(`Refusing to restore attachments: ${STAGED_ATTACHMENT_DIR} is not a directory.`);
    }
    for (const stagedPath of candidates) {
      const [id, filename] = stagedPath.slice(STAGED_ATTACHMENT_DIR.length + 1).split("/");
      try {
        const bytes = await readStagedAttachmentMirrorFile(input.sessionDir, stagedPath);
        const entryDir = bytes == null ? null : await ensureRealDirectoryChain(stagingRoot, [id]);
        if (bytes == null || entryDir == null) {
          skipped.push(stagedPath);
          continue;
        }
        // wx: never overwrite, and O_EXCL refuses a symlinked leaf.
        await fsPromises.writeFile(path.join(entryDir, filename), bytes, { flag: "wx" });
        restored.push(stagedPath);
      } catch (error) {
        if (!isErrnoWithCode(error, "EEXIST")) {
          log.debug("Skipping unrestorable staged attachment mirror entry", {
            stagedPath,
            error: getErrorMessage(error),
          });
        }
        skipped.push(stagedPath);
      }
    }
    return Ok({ restored, skipped });
  } catch (error) {
    return Err(getErrorMessage(error));
  }
}

/**
 * Copy referenced mirror entries into a fork's session dir. The mirror is supplementary to the
 * checkout copy the fork already made, so a missing or unreadable entry is skipped instead of
 * rolling back the fork.
 */
export async function copyStagedAttachmentMirrorEntries(input: {
  sourceSessionDir: string;
  targetSessionDir: string;
  stagedPaths: readonly string[];
}): Promise<void> {
  for (const stagedPath of input.stagedPaths) {
    const targetPath = resolveStagedAttachmentMirrorPath(input.targetSessionDir, stagedPath);
    if (targetPath == null) {
      continue;
    }
    try {
      const bytes = await readStagedAttachmentMirrorFile(input.sourceSessionDir, stagedPath);
      if (bytes == null) {
        continue;
      }
      await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
      await fsPromises.writeFile(targetPath, bytes, { flag: "w" });
    } catch (error) {
      log.warn("Skipping staged attachment mirror entry during fork", {
        stagedPath,
        error: getErrorMessage(error),
      });
    }
  }
}

export function extractStagedAttachmentPathsFromText(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /`(?<path>\.(?:xum|mux)\/user-attachments\/[^`]+)`/gu;
  for (const match of text.matchAll(pattern)) {
    const stagedPath = match.groups?.path ? normalizeReadableStagedPath(match.groups.path) : null;
    if (stagedPath != null) {
      paths.add(stagedPath);
    }
  }
  return [...paths];
}

export function sanitizeStagedFilename(filename: string): string {
  const rawBase = filename.split(/[\\/]/u).pop()?.trim() ?? "";
  const withoutControls = Array.from(rawBase)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");
  const safeChars = withoutControls.replace(/[^A-Za-z0-9._ -]/gu, "-").replace(/^\.+/u, "");
  const fallback = safeChars.trim().length === 0 ? "attachment" : safeChars;
  if (fallback.length <= 120) {
    return fallback;
  }

  const extensionIndex = fallback.lastIndexOf(".");
  const extension = extensionIndex > 0 ? fallback.slice(extensionIndex) : "";
  if (extension.length === 0 || extension.length >= 120) {
    return fallback.slice(0, 120).replace(/\.+$/u, "") || "attachment";
  }
  const stem = fallback
    .slice(0, extensionIndex)
    .slice(0, 120 - extension.length)
    .replace(/\.+$/u, "");
  return `${stem || "attachment"}${extension}`.slice(0, 120);
}

function normalizeReadableStagedPath(stagedPath: string): string | null {
  const normalized = stagedPath.replace(/\\/gu, "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.includes("//") ||
    segments.includes("..") ||
    !STAGED_ATTACHMENT_DIRS.some((dir) => normalized.startsWith(`${dir}/`)) ||
    (segments.at(-1)?.length ?? 0) === 0
  ) {
    return null;
  }
  return normalized;
}

const STAGED_ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Map a canonical staged path (`<STAGED_ATTACHMENT_DIR>/<uuid>/<filename>`) to its mirror file.
 * Returns null for anything staging could not have produced: legacy `.mux` paths (never
 * mirrored), non-UUID directories, nested segments, or names that sanitizing would change.
 */
function resolveStagedAttachmentMirrorPath(sessionDir: string, stagedPath: string): string | null {
  const normalized = normalizeReadableStagedPath(stagedPath);
  if (!normalized?.startsWith(`${STAGED_ATTACHMENT_DIR}/`)) {
    return null;
  }
  const segments = normalized.slice(STAGED_ATTACHMENT_DIR.length + 1).split("/");
  if (segments.length !== 2) {
    return null;
  }
  const [id, filename] = segments;
  if (!STAGED_ATTACHMENT_ID_PATTERN.test(id) || sanitizeStagedFilename(filename) !== filename) {
    return null;
  }
  return path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME, id, filename);
}

/** Read a mirror entry, or null when it is absent, not a regular file, or over the size cap. */
async function readStagedAttachmentMirrorFile(
  sessionDir: string,
  stagedPath: string
): Promise<Buffer | null> {
  const mirrorPath = resolveStagedAttachmentMirrorPath(sessionDir, stagedPath);
  if (mirrorPath == null) {
    return null;
  }
  try {
    const stat = await fsPromises.lstat(mirrorPath);
    if (!stat.isFile() || stat.size > MAX_STAGED_ATTACHMENT_SIZE_BYTES) {
      return null;
    }
    return await fsPromises.readFile(mirrorPath);
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT") || isErrnoWithCode(error, "ENOTDIR")) {
      return null;
    }
    throw error;
  }
}

/** List mirror entries as canonical staged paths (`<dir>/<id>/<name>`); unvalidated. */
async function listStagedAttachmentMirrorPaths(sessionDir: string): Promise<string[]> {
  const mirrorRoot = path.join(sessionDir, STAGED_ATTACHMENT_MIRROR_DIR_NAME);
  let ids: string[];
  try {
    ids = await fsPromises.readdir(mirrorRoot);
  } catch (error) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const stagedPaths: string[] = [];
  for (const id of ids.sort()) {
    const entryDir = path.join(mirrorRoot, id);
    let names: string[];
    try {
      names = (await fsPromises.lstat(entryDir)).isDirectory()
        ? await fsPromises.readdir(entryDir)
        : [];
    } catch (error) {
      // One damaged entry (EACCES, EIO, ...) must not hide its valid siblings.
      log.debug("Skipping unreadable staged attachment mirror entry", {
        entryDir,
        error: getErrorMessage(error),
      });
      names = [];
    }
    if (names.length === 0) {
      // Reported as skipped: it fails resolveStagedAttachmentMirrorPath's two-segment shape.
      stagedPaths.push(`${STAGED_ATTACHMENT_DIR}/${id}`);
      continue;
    }
    for (const name of names.sort()) {
      stagedPaths.push(`${STAGED_ATTACHMENT_DIR}/${id}/${name}`);
    }
  }
  return stagedPaths;
}

/** Create/verify `root/segments...` as real directories (no symlinks); null if one is not. */
async function ensureRealDirectoryChain(
  root: string,
  segments: readonly string[]
): Promise<string | null> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fsPromises.mkdir(current);
    } catch (error) {
      if (!isErrnoWithCode(error, "EEXIST")) {
        throw error;
      }
    }
    const stat = await fsPromises.lstat(current);
    if (!stat.isDirectory()) {
      return null;
    }
  }
  return current;
}

function normalizeStagedAttachmentPaths(stagedPaths: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const stagedPath of stagedPaths) {
    const readablePath = normalizeReadableStagedPath(stagedPath);
    if (readablePath != null) {
      normalized.add(readablePath);
    }
  }
  return [...normalized];
}

async function listStagedAttachmentPaths(
  runtime: Runtime,
  workspacePath: string
): Promise<Result<string[], string>> {
  const findCommands = STAGED_ATTACHMENT_DIRS.map(
    (dir) => `if [ -d ${shellQuote(dir)} ]; then find ${shellQuote(dir)} -type f -print; fi`
  );
  const result = await execBuffered(runtime, findCommands.join("; "), {
    cwd: workspacePath,
    timeout: 30,
  });
  if (result.exitCode !== 0) {
    return Err(result.stderr.trim() || "Failed to list staged attachments.");
  }

  const stagedPaths: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const stagedPath = normalizeReadableStagedPath(line.trim());
    if (stagedPath != null) {
      stagedPaths.push(stagedPath);
    }
  }
  return Ok(stagedPaths);
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function writeBytes(runtime: Runtime, path: string, bytes: Uint8Array): Promise<void> {
  const writer = runtime.writeFile(path).getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (error) {
    writer.releaseLock();
    throw error;
  }
}
