/**
 * Trust store for Codex-format plugin hooks. Codex records trust against each hook's current
 * hash, so a new or changed hook is skipped until the user trusts it, and installing a plugin
 * trusts none of its hooks. Xum stores one file per plugin instance:
 *
 *   <xumHome>/plugin-hook-trust/<instanceId>.json   { version: 1, installedAt, hooks: { <key>: { hash, state } } }
 *
 * - Bound to one installation: `installedAt` must equal the registry entry's. Every install
 *   writes a new one (older Xum builds too) and updates keep it, so a reinstall under the same
 *   name and path never inherits trust, even when an older build uninstalled the plugin without
 *   deleting this file.
 * - Keyed by the hook's location (`key`) with the trusted `hash`, so the UI can tell a changed
 *   hook (same key, other hash) from a new one. A record applies only while the hash matches.
 * - Not under `plugin-data/<instanceId>`: that directory is the plugin's own writable PLUGIN_DATA,
 *   and a plugin must never trust its own hooks.
 * - Runners read this file at each hook call (not at turn start), so a revoke stops the next call.
 * - Fail closed: a missing, unreadable or malformed file trusts nothing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { AgentPluginInstallEntrySchema } from "@/common/config/schemas/agentPluginInstalls";
import type { PluginHookReviewState } from "@/common/orpc/schemas/agentPlugins";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import type { PluginHookDefinition } from "./codexHooks";
import { isPlainObject } from "./manifest";
import { computePluginInstanceId } from "./mcpConfig";
import { PLUGIN_REGISTRY_FILE_NAME, readPluginRegistryDocument } from "./registry";

const TRUST_DIR = "plugin-hook-trust";

const TrustRecordSchema = z.object({
  version: z.literal(1),
  installedAt: z.string(),
  hooks: z.record(
    z.string(),
    z.object({ hash: z.string(), state: z.enum(["trusted", "disabled"]) })
  ),
});
export type PluginHookTrustRecord = z.infer<typeof TrustRecordSchema>["hooks"];
export type PluginHookTrustState = PluginHookTrustRecord[string]["state"];

export function getPluginHookTrustPath(xumHome: string, instanceId: string): string {
  // instanceId is a hex digest (computePluginInstanceId); never a path segment from a plugin.
  if (!/^[0-9a-f]+$/.test(instanceId)) throw new Error(`Invalid plugin instance id: ${instanceId}`);
  return path.join(xumHome, TRUST_DIR, `${instanceId}.json`);
}

const RegistryIdentitySchema = AgentPluginInstallEntrySchema.pick({
  name: true,
  installedAt: true,
});

/** The registry's `installedAt` for this instance; undefined when no managed install owns it. */
async function readInstalledAt(xumHome: string, instanceId: string): Promise<string | undefined> {
  const registryFile = path.join(xumHome, PLUGIN_REGISTRY_FILE_NAME);
  const { rawEntries } = await readPluginRegistryDocument(registryFile, "lenient");
  for (const raw of rawEntries) {
    const entry = RegistryIdentitySchema.safeParse(raw);
    if (!entry.success) continue;
    // Same identity as the install service: the lexical install path.
    if (computePluginInstanceId(path.join(xumHome, "plugins", entry.data.name)) === instanceId) {
      return entry.data.installedAt;
    }
  }
  return undefined;
}

export async function readPluginHookTrust(
  xumHome: string,
  instanceId: string
): Promise<PluginHookTrustRecord> {
  const installedAt = await readInstalledAt(xumHome, instanceId);
  if (installedAt === undefined) return {};
  const trust = await readTrustFile(getPluginHookTrustPath(xumHome, instanceId), installedAt);
  return trust === "newer-version" ? {} : trust;
}

/** Far above any real record; a larger file is malformed state. */
const MAX_TRUST_FILE_BYTES = 1024 * 1024;

/**
 * The record for this install, `{}` when missing, malformed or for another install, and
 * "newer-version" for a file a newer Xum wrote: reads trust none of it, writes must keep it.
 */
async function readTrustFile(
  file: string,
  installedAt: string
): Promise<PluginHookTrustRecord | "newer-version"> {
  const raw = await readBoundedTrustFile(file);
  if (raw === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const parsed = TrustRecordSchema.safeParse(json);
  // Trust recorded for an earlier install under this name never carries over.
  if (parsed.success) return parsed.data.installedAt === installedAt ? parsed.data.hooks : {};
  if (isNewerVersionFor(json, installedAt)) return "newer-version";
  log.warn("Plugin hook trust file is malformed; trusting no hooks", { file });
  return {};
}

/** The file's text, or undefined (logged) when it is missing, unreadable or not bounded. */
async function readBoundedTrustFile(file: string): Promise<string | undefined> {
  try {
    // O_NONBLOCK + fstat: a FIFO (or a symlink to one) must not hang the read, which can hold
    // the plugin mutation lock. Only a bounded regular file is read.
    await using handle = await fs.open(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0)
    );
    const stat = await handle.stat();
    // The size from fstat can grow before the read: read at most one byte past the limit, so the
    // limit holds while reading too (Codex PRRT_kwDOPxxmWM6rPrVQ).
    const buffer = Buffer.alloc(MAX_TRUST_FILE_BYTES + 1);
    const bytesRead = stat.isFile() ? await readUntilFull(handle, buffer) : Infinity;
    if (bytesRead > MAX_TRUST_FILE_BYTES) {
      log.warn("Plugin hook trust file is not a bounded regular file; trusting no hooks", { file });
      return undefined;
    }
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      log.warn("Plugin hook trust file is unreadable; trusting no hooks", { file, error });
    }
    return undefined;
  }
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
 * earlier install (a downgrade, then a reinstall) must not block trust changes (Codex
 * PRRT_kwDOPxxmWM6reh5V). A non-finite or fractional version is malformed (PRRT_kwDOPxxmWM6rPrVO).
 */
function isNewerVersionFor(json: unknown, installedAt: string): boolean {
  if (!isPlainObject(json)) return false;
  const { version } = json;
  const otherInstall = typeof json.installedAt === "string" && json.installedAt !== installedAt;
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version > 1 && !otherInstall
  );
}

export function reviewStateOf(
  record: PluginHookTrustRecord,
  hook: Pick<PluginHookDefinition, "key" | "hash">
): PluginHookReviewState {
  const entry = record[hook.key];
  if (entry === undefined) return "new";
  return entry.hash === hook.hash ? entry.state : "changed";
}

/** The runtime gate: trusted, and still the exact definition the user trusted. */
export function isPluginHookTrusted(
  record: PluginHookTrustRecord,
  hook: Pick<PluginHookDefinition, "key" | "hash">
): boolean {
  return reviewStateOf(record, hook) === "trusted";
}

const writeLocks = new Map<string, AsyncMutex>();

/** Record (or clear, with `state: null`) the user's decision for one hook definition. */
export async function setPluginHookTrust(
  xumHome: string,
  instanceId: string,
  decision: { key: string; hash: string; state: PluginHookTrustState | null }
): Promise<void> {
  const file = getPluginHookTrustPath(xumHome, instanceId);
  let lock = writeLocks.get(file);
  if (lock === undefined) {
    lock = new AsyncMutex();
    writeLocks.set(file, lock);
  }
  await using _guard = await lock.acquire();
  const installedAt = await readInstalledAt(xumHome, instanceId);
  if (installedAt === undefined) throw new Error("This plugin is not installed.");
  const trust = await readTrustFile(file, installedAt);
  // After a downgrade: rewriting the file as version 1 would drop every decision it holds.
  if (trust === "newer-version") {
    throw new Error("A newer Xum version saved this plugin's hook trust. Update Xum to change it.");
  }
  const hooks = { ...trust };
  if (decision.state === null) delete hooks[decision.key];
  else hooks[decision.key] = { hash: decision.hash, state: decision.state };
  await ensureTrustRoot(xumHome);
  // A wrong-kind entry (a directory, a FIFO) read as no trust above. The atomic rename cannot
  // replace a directory, so remove it first: corrupted state must not block every decision.
  // A symlink is removed too: writeFileAtomic resolves it and would overwrite its target, an
  // arbitrary file of this user.
  const existing = await fs.lstat(file).catch(() => null);
  if (existing !== null && !existing.isFile()) {
    await fs.rm(file, { recursive: true, force: true });
  }
  // An explicit mode: writeFileAtomic otherwise keeps the old file's mode, and a trust file with
  // mode 000 would stay unreadable, so it would trust nothing forever (PRRT_kwDOPxxmWM6sGAiR).
  await writeFileAtomic(file, JSON.stringify({ version: 1, installedAt, hooks }, null, 2), {
    mode: 0o600,
  });
}

/**
 * The trust-store root, as a directory. A regular file (or another wrong-kind entry) there is
 * corrupted state: it is removed, so it cannot fail every trust change with ENOTDIR (Codex
 * PRRT_kwDOPxxmWM6rb4Tq).
 */
async function ensureTrustRoot(xumHome: string): Promise<void> {
  await removeWrongKindRoot(xumHome);
  await fs.mkdir(path.join(xumHome, TRUST_DIR), { recursive: true });
}

/**
 * Remove the trust-store root when it is not a real directory. `lstat`: a symlink, also one to a
 * directory, is removed as a link, so no write or delete reaches outside the store (Codex
 * PRRT_kwDOPxxmWM6sRsEy). `rm` without `recursive` never follows it to its target.
 */
async function removeWrongKindRoot(xumHome: string): Promise<void> {
  const root = path.join(xumHome, TRUST_DIR);
  const existing = await fs.lstat(root).catch(() => null);
  if (existing !== null && !existing.isDirectory()) await fs.rm(root, { force: true });
}

/** Uninstall: a later install under the same name must not inherit trust. */
export async function removePluginHookTrust(xumHome: string, instanceId: string): Promise<void> {
  // A wrong-kind root holds no trust: it is corrupted state, and leaving it would fail the rm
  // below with ENOTDIR.
  await removeWrongKindRoot(xumHome);
  // recursive: a directory here is malformed state and must not block the uninstall.
  await fs.rm(getPluginHookTrustPath(xumHome, instanceId), { force: true, recursive: true });
}
