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
 * - A Cursor command hook runs plugin files, so its trust also names the plugin commit whose files
 *   the user reviewed (`reviewedSha`, D30). An update this build applies moves the binding to
 *   the new commit (it reviewed the changed files). An update an older build applied did not, so
 *   the binding no longer matches the registry's `lockedSha` and the hook needs review again.
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

const TrustEntrySchema = z.object({
  hash: z.string(),
  state: z.enum(["trusted", "disabled"]),
  reviewedSha: z.string().optional(),
});
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
  lockedSha: true,
});

interface InstallIdentity {
  installedAt: string;
  lockedSha: string;
}

/** The registry's install of this instance; undefined when no managed install owns it. */
async function readInstallIdentity(
  xumHome: string,
  instanceId: string
): Promise<InstallIdentity | undefined> {
  const registryFile = path.join(xumHome, PLUGIN_REGISTRY_FILE_NAME);
  const { rawEntries } = await readPluginRegistryDocument(registryFile, "lenient");
  for (const raw of rawEntries) {
    const entry = RegistryIdentitySchema.safeParse(raw);
    if (!entry.success) continue;
    // Same identity as the install service: the lexical install path.
    if (computePluginInstanceId(path.join(xumHome, "plugins", entry.data.name)) === instanceId) {
      return { installedAt: entry.data.installedAt, lockedSha: entry.data.lockedSha };
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
  const identity = await readInstallIdentity(xumHome, instanceId);
  if (identity === undefined) return {};
  const trust = await readTrustFile(getPluginHookTrustPath(xumHome, instanceId), identity);
  return trust === "newer-version" ? {} : trust;
}

/** Far above any real record; a larger file is malformed state. */
const MAX_TRUST_FILE_BYTES = 1024 * 1024;

/**
 * The record for this install, `{}` when missing or for another install, "unreadable" when it
 * exists but cannot be read or parsed, and "newer-version" for a file a newer Xum wrote: reads
 * trust none of it, writes must keep it. A `reviewedSha` other than `identity.lockedSha` is
 * dropped: the plugin moved to a commit nobody reviewed on this build.
 */
async function readTrustFile(
  file: string,
  identity: InstallIdentity
): Promise<PluginHookTrustRecord | "newer-version" | "unreadable"> {
  const raw = await readBoundedStateFile(file, MAX_TRUST_FILE_BYTES, TRUST_FILE_LABEL);
  if (raw === undefined) return (await stateFileExists(file)) ? "unreadable" : {};
  const json = parseStateJson(raw);
  const parsed = TrustRecordSchema.safeParse(json);
  // Trust recorded for an earlier install under this name never carries over.
  if (parsed.success) {
    return parsed.data.installedAt === identity.installedAt
      ? validEntries(parsed.data.hooks, file, identity.lockedSha)
      : {};
  }
  if (isNewerVersionFor(json, identity.installedAt)) return "newer-version";
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
function validEntries(
  hooks: Record<string, unknown>,
  file: string,
  lockedSha: string
): PluginHookTrustRecord {
  const valid: PluginHookTrustRecord = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(hooks)) {
    const entry = TrustEntrySchema.safeParse(value);
    if (!entry.success) {
      dropped++;
      continue;
    }
    const { reviewedSha, ...decision } = entry.data;
    valid[key] = reviewedSha === lockedSha ? entry.data : decision;
  }
  if (dropped > 0)
    log.warn("Plugin hook trust file has malformed entries; skipping them", { file, dropped });
  return valid;
}

export function reviewStateOf(
  record: PluginHookTrustRecord,
  hook: Pick<PluginHookDefinition, "key" | "hash" | "handler">
): PluginHookReviewState {
  const entry = record[hook.key];
  if (entry === undefined) return "new";
  if (entry.hash !== hook.hash) return "changed";
  // Trust of a command hook without a current binding (an older build updated the plugin, or the
  // trust predates the binding) covers files nobody reviewed: fail closed (Codex P1).
  if (
    entry.state === "trusted" &&
    hook.handler.type === "cursor-command" &&
    entry.reviewedSha === undefined
  ) {
    return "changed";
  }
  return entry.state;
}

/** The runtime gate: trusted, and still the exact definition (and files) the user trusted. */
export function isPluginHookTrusted(
  record: PluginHookTrustRecord,
  hook: Pick<PluginHookDefinition, "key" | "hash" | "handler">
): boolean {
  return reviewStateOf(record, hook) === "trusted";
}

const writeLocks = new Map<string, AsyncMutex>();

/**
 * Record (or clear, with `state: null`) the user's decision for one hook definition.
 * `reviewedSha`: the commit whose files the user reviewed, for a Cursor command hook's trust.
 */
export async function setPluginHookTrust(
  xumHome: string,
  instanceId: string,
  decision: {
    key: string;
    hash: string;
    state: PluginHookTrustState | null;
    reviewedSha?: string;
  }
): Promise<void> {
  await editTrustFile(xumHome, instanceId, (hooks) => {
    if (decision.state === null) delete hooks[decision.key];
    else {
      hooks[decision.key] = {
        hash: decision.hash,
        state: decision.state,
        ...(decision.reviewedSha !== undefined ? { reviewedSha: decision.reviewedSha } : {}),
      };
    }
    return true;
  });
}

/**
 * After an update this build applied from `fromSha` (the user reviewed its changed files): the
 * trust bound to `fromSha` moves to the registry's new `lockedSha`. Call it after the registry
 * names the new commit. A crash before it leaves the bindings stale, which only asks for review.
 */
export async function rebindPluginHookTrust(
  xumHome: string,
  instanceId: string,
  fromSha: string
): Promise<void> {
  await editTrustFile(
    xumHome,
    instanceId,
    (hooks, lockedSha) => {
      let moved = false;
      for (const [key, entry] of Object.entries(hooks)) {
        if (entry.reviewedSha !== fromSha) continue;
        hooks[key] = { ...entry, reviewedSha: lockedSha };
        moved = true;
      }
      // Most updates move nothing (no Cursor hook trusted): they write no trust file.
      return moved;
    },
    fromSha
  );
}

/**
 * Read, edit and write this install's record under the file's lock. `readAt` is the commit whose
 * bindings the read keeps (default: the registry's `lockedSha`). `edit` returns whether it
 * changed anything; nothing is written when it did not.
 */
async function editTrustFile(
  xumHome: string,
  instanceId: string,
  edit: (hooks: PluginHookTrustRecord, lockedSha: string) => boolean,
  readAt?: string
): Promise<void> {
  const file = getPluginHookTrustPath(xumHome, instanceId);
  let lock = writeLocks.get(file);
  if (lock === undefined) {
    lock = new AsyncMutex();
    writeLocks.set(file, lock);
  }
  await using _guard = await lock.acquire();
  const identity = await readInstallIdentity(xumHome, instanceId);
  if (identity === undefined) throw new Error("This plugin is not installed.");
  const trust = await readTrustFile(file, { ...identity, lockedSha: readAt ?? identity.lockedSha });
  // After a downgrade: rewriting the file as version 1 would drop every decision it holds.
  if (trust === "newer-version") {
    throw new Error("A newer Xum version saved this plugin's hook trust. Update Xum to change it.");
  }
  // An unreadable file holds no decision Xum can keep: the write replaces it (self-healing).
  const hooks = trust === "unreadable" ? {} : { ...trust };
  if (!edit(hooks, identity.lockedSha)) return;
  await writeStateFile(
    path.join(xumHome, TRUST_DIR),
    file,
    JSON.stringify({ version: 1, installedAt: identity.installedAt, hooks }, null, 2),
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
