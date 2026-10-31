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
import { hasErrorCode } from "@/node/services/tools/skillFileUtils";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { PluginHookDefinition } from "./codexHooks";
import { computePluginInstanceId } from "./mcpConfig";
import {
  isNewerVersionFor,
  parseStateJson,
  readBoundedStateFile,
  removeStateFile,
  writeStateFile,
} from "./pluginStateFiles";
import { PLUGIN_REGISTRY_FILE_NAME, readPluginRegistryDocument } from "./registry";

const TRUST_DIR = "plugin-hook-trust";
const TRUST_STORE_LABEL = "Plugin hook trust store";
const TRUST_FILE_LABEL = { file: "Plugin hook trust file", failClosed: "trusting no hooks" };

const TrustEntrySchema = z.object({ hash: z.string(), state: z.enum(["trusted", "disabled"]) });
/** Entries are checked one by one (readTrustFile), so one malformed entry drops only itself. */
const TrustRecordSchema = z.object({
  version: z.literal(1),
  installedAt: z.string(),
  hooks: z.record(z.string(), z.unknown()),
});
export type PluginHookTrustRecord = Record<string, z.infer<typeof TrustEntrySchema>>;
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
  const trust = await readPluginHookTrustChecked(xumHome, instanceId);
  return trust === "unreadable" ? {} : trust;
}

/**
 * readPluginHookTrust, but "unreadable" when the trust file exists and Xum cannot read or parse
 * it: the Cursor runner then skips the call with a notice (Xum's failure, not the hook's). It
 * still trusts nothing.
 */
export async function readPluginHookTrustChecked(
  xumHome: string,
  instanceId: string
): Promise<PluginHookTrustRecord | "unreadable"> {
  const installedAt = await readInstalledAt(xumHome, instanceId);
  if (installedAt === undefined) return {};
  const trust = await readTrustFile(getPluginHookTrustPath(xumHome, instanceId), installedAt);
  return trust === "newer-version" ? {} : trust;
}

/** Far above any real record; a larger file is malformed state. */
const MAX_TRUST_FILE_BYTES = 1024 * 1024;

/**
 * The record for this install, `{}` when missing or for another install, "unreadable" when it
 * exists but cannot be read or parsed, and "newer-version" for a file a newer Xum wrote: reads
 * trust none of it, writes must keep it.
 */
async function readTrustFile(
  file: string,
  installedAt: string
): Promise<PluginHookTrustRecord | "newer-version" | "unreadable"> {
  const raw = await readBoundedStateFile(file, MAX_TRUST_FILE_BYTES, TRUST_FILE_LABEL);
  if (raw === undefined) return (await stateFileExists(file)) ? "unreadable" : {};
  const json = parseStateJson(raw);
  const parsed = TrustRecordSchema.safeParse(json);
  // Trust recorded for an earlier install under this name never carries over.
  if (parsed.success) {
    return parsed.data.installedAt === installedAt ? validEntries(parsed.data.hooks, file) : {};
  }
  if (isNewerVersionFor(json, installedAt)) return "newer-version";
  log.warn("Plugin hook trust file is malformed; trusting no hooks", { file });
  return "unreadable";
}

/** Whether anything sits at the path; an lstat error other than ENOENT counts as present. */
async function stateFileExists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

/**
 * The well-formed entries. A malformed one is dropped alone: if it voided the whole file, the next
 * rewrite would drop every valid decision (self-healing, see AGENTS.md).
 */
function validEntries(hooks: Record<string, unknown>, file: string): PluginHookTrustRecord {
  const valid: PluginHookTrustRecord = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(hooks)) {
    const entry = TrustEntrySchema.safeParse(value);
    if (entry.success) valid[key] = entry.data;
    else dropped++;
  }
  if (dropped > 0)
    log.warn("Plugin hook trust file has malformed entries; skipping them", { file, dropped });
  return valid;
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
  // An unreadable file holds no decision Xum can keep: the write replaces it (self-healing).
  const hooks = trust === "unreadable" ? {} : { ...trust };
  if (decision.state === null) delete hooks[decision.key];
  else hooks[decision.key] = { hash: decision.hash, state: decision.state };
  await writeStateFile(
    path.join(xumHome, TRUST_DIR),
    file,
    JSON.stringify({ version: 1, installedAt, hooks }, null, 2),
    TRUST_STORE_LABEL
  );
}

/** Uninstall: a later install under the same name must not inherit trust. */
export async function removePluginHookTrust(xumHome: string, instanceId: string): Promise<void> {
  await removeStateFile(
    path.join(xumHome, TRUST_DIR),
    getPluginHookTrustPath(xumHome, instanceId),
    TRUST_STORE_LABEL
  );
}
