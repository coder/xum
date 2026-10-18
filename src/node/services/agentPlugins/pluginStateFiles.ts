/**
 * Shared file rules of the per-install plugin state stores (pluginHookTrust.ts,
 * approvedCopies.ts): one JSON file per plugin instance under `<xumHome>/<store>/`. Reads are
 * bounded and never block, a wrong-kind or symlinked entry is replaced instead of followed, and
 * writes are atomic with an explicit mode.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { log } from "@/node/services/log";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import { isPlainObject } from "./manifest";

/** How a store names itself in logs, and what a failed read means for it. */
export interface StateFileLabel {
  /** E.g. "Plugin hook trust file". */
  file: string;
  /** E.g. "trusting no hooks". */
  failClosed: string;
}

/** The file's text, or undefined (logged) when it is missing, unreadable or not bounded. */
export async function readBoundedStateFile(
  file: string,
  maxBytes: number,
  label: StateFileLabel
): Promise<string | undefined> {
  try {
    // O_NONBLOCK + fstat: a FIFO (or a symlink to one) must not hang the read, which can hold
    // the plugin mutation lock. Only a bounded regular file is read.
    await using handle = await fs.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)
    );
    return await readOpenStateFile(handle, file, maxBytes, label);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      log.warn(`${label.file} is unreadable; ${label.failClosed}`, { file, error });
    }
    return undefined;
  }
}

/** The open file's text, or undefined (logged) when it is not a bounded regular file. */
async function readOpenStateFile(
  handle: fs.FileHandle,
  file: string,
  maxBytes: number,
  label: StateFileLabel
): Promise<string | undefined> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > maxBytes) {
    log.warn(`${label.file} is not a bounded regular file; ${label.failClosed}`, { file });
    return undefined;
  }
  // Sized to the file (runners read it on every hook call), plus one byte: the file can grow
  // after fstat, and a full buffer means it did. That read is refused, so the limit holds while
  // reading too (Codex PRRT_kwDOPxxmWM6rPrVQ). Xum's own writes rename a new file into place,
  // which never changes the open file.
  const buffer = Buffer.alloc(stat.size + 1);
  const bytesRead = await readUntilFull(handle, buffer);
  if (bytesRead > stat.size) {
    log.warn(`${label.file} grew while it was read; ${label.failClosed}`, { file });
    return undefined;
  }
  return buffer.toString("utf8", 0, bytesRead);
}

/**
 * Read until EOF or until `buffer` is full. One read() can return fewer bytes than asked on some
 * filesystems, and parsing that prefix would read a valid file as malformed (Codex
 * PRRT_kwDOPxxmWM6sRsEs).
 */
async function readUntilFull(handle: fs.FileHandle, buffer: Buffer): Promise<number> {
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/**
 * A record in a newer format that can belong to this install. A version-2 record from an
 * earlier install (a downgrade, then a reinstall) must not block writes (Codex
 * PRRT_kwDOPxxmWM6reh5V). A non-finite or fractional version is malformed (PRRT_kwDOPxxmWM6rPrVO).
 */
export function isNewerVersionFor(json: unknown, installedAt: string): boolean {
  if (!isPlainObject(json)) return false;
  const { version } = json;
  const otherInstall = typeof json.installedAt === "string" && json.installedAt !== installedAt;
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version > 1 && !otherInstall
  );
}

/**
 * The entry's lstat, or null when it cannot be read: the caller then writes (or removes) as if
 * nothing were there, and that operation reports a real failure.
 */
async function lstatOrNull(entry: string): Promise<Stats | null> {
  try {
    return await fs.lstat(entry);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      log.debug("Plugin state entry cannot be inspected", { entry, error });
    }
    return null;
  }
}

/** Parse JSON text; undefined when it is not JSON (the caller treats it as malformed). */
export function parseStateJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    log.debug("Plugin state file is not JSON", { error });
    return undefined;
  }
}

/**
 * Write one store file atomically. The store root becomes a directory first: a regular file (or
 * another wrong-kind entry) there is corrupted state and would fail every write with ENOTDIR
 * (Codex PRRT_kwDOPxxmWM6rb4Tq).
 */
export async function writeStateFile(
  root: string,
  file: string,
  text: string,
  storeLabel: string
): Promise<void> {
  await removeWrongKindStateRoot(root, storeLabel);
  await fs.mkdir(root, { recursive: true });
  // A wrong-kind entry (a directory, a FIFO) reads as no state. The atomic rename cannot
  // replace a directory, so remove it first: corrupted state must not block every write.
  // A symlink is removed too: writeFileAtomic resolves it and would overwrite its target, an
  // arbitrary file of this user.
  const existing = await lstatOrNull(file);
  if (existing !== null && !existing.isFile()) {
    await fs.rm(file, { recursive: true, force: true });
  }
  // An explicit mode: writeFileAtomic otherwise keeps the old file's mode, and a file with
  // mode 000 would stay unreadable, so it would read as no state forever (PRRT_kwDOPxxmWM6sGAiR).
  await writeFileAtomic(file, text, { mode: 0o600 });
}

/**
 * Remove a store root when it is not a real directory. `lstat`: a symlink, also one to a
 * directory, is removed as a link, so no write or delete reaches outside the store (Codex
 * PRRT_kwDOPxxmWM6sRsEy). `rm` without `recursive` never follows it to its target.
 */
export async function removeWrongKindStateRoot(root: string, storeLabel: string): Promise<void> {
  const existing = await lstatOrNull(root);
  if (existing === null || existing.isDirectory()) return;
  // A symlink set up on purpose is not followed either: writes must stay inside Xum home.
  // Its target is kept, but every record in it stops applying, so say so in the log.
  log.warn(`${storeLabel} is not a directory; replacing it`, {
    root,
    symlink: existing.isSymbolicLink(),
  });
  await fs.rm(root, { force: true });
}

/** Uninstall: a later install under the same name must not inherit this store's file. */
export async function removeStateFile(
  root: string,
  file: string,
  storeLabel: string
): Promise<void> {
  // A wrong-kind root holds no state: it is corrupted, and leaving it would fail the rm below
  // with ENOTDIR.
  await removeWrongKindStateRoot(root, storeLabel);
  // recursive: a directory here is malformed state and must not block the uninstall.
  await fs.rm(file, { force: true, recursive: true });
}
