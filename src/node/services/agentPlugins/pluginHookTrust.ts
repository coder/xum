/**
 * Trust store for Codex-format plugin hooks. Codex records trust against each hook's current
 * hash, so a new or changed hook is skipped until the user trusts it, and installing a plugin
 * trusts none of its hooks. Xum stores one file per plugin instance:
 *
 *   <xumHome>/plugin-hook-trust/<instanceId>.json   { version: 1, hooks: { <key>: { hash, state } } }
 *
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
import type { PluginHookReviewState } from "@/common/orpc/schemas/agentPlugins";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import writeFileAtomic from "@/node/utils/writeFileAtomic";
import type { PluginHookDefinition } from "./codexHooks";

const TRUST_DIR = "plugin-hook-trust";

const TrustRecordSchema = z.object({
  version: z.literal(1),
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

export async function readPluginHookTrust(
  xumHome: string,
  instanceId: string
): Promise<PluginHookTrustRecord> {
  const file = getPluginHookTrustPath(xumHome, instanceId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      log.warn("Plugin hook trust file is unreadable; trusting no hooks", { file, error });
    }
    return {};
  }
  try {
    const parsed = TrustRecordSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.hooks;
  } catch {
    // Malformed JSON: same as an invalid shape below.
  }
  log.warn("Plugin hook trust file is malformed; trusting no hooks", { file });
  return {};
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
  const hooks = { ...(await readPluginHookTrust(xumHome, instanceId)) };
  if (decision.state === null) delete hooks[decision.key];
  else hooks[decision.key] = { hash: decision.hash, state: decision.state };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ version: 1, hooks }, null, 2));
}

/** Uninstall: a later install under the same name must not inherit trust. */
export async function removePluginHookTrust(xumHome: string, instanceId: string): Promise<void> {
  await fs.rm(getPluginHookTrustPath(xumHome, instanceId), { force: true });
}
