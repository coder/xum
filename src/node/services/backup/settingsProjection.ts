import type { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { AppConfigOnDiskSchema } from "@/common/config/schemas/appConfigOnDisk";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import { normalizeAutoModelRoutingConfig } from "@/common/types/autoModelRouting";
import type { ProjectsConfig } from "@/common/types/project";
import { isEvaluationProvider } from "@/common/utils/ai/evaluationModels";
import { isPlainObject } from "@/common/utils/isPlainObject";
import {
  normalizeAiDefaultsModelStrings,
  normalizeEvaluationDefaults,
  normalizeMinThinkingLevelByModel,
  normalizeModelFallbacks,
  normalizeOptionalModelString,
  normalizeOptionalModelStringArray,
} from "@/node/config";

/**
 * The top-level config.json settings a backup carries. Everything else stays local, so an
 * addition fails closed until it is listed here:
 * - bound to the machine or its network: apiServerBindHost, apiServerPort, apiServerServeWebUi,
 *   mdnsAdvertisementEnabled, mdnsServiceName, serverSshHost, serverAuthGithubOwner,
 *   defaultProjectDir, terminalDefaultShell, updateChannel, useSSH2Transport, keepScreenAwake,
 *   agentResourceLimits, agentResourceLimitsEnabled;
 * - derived from providers.jsonc credentials, which are never exported: routePriority,
 *   routeOverrides;
 * - agent sandbox and workspace isolation policy: agentSandbox, defaultIsolation and
 *   runtimeEnablement. A repository-controlled value could loosen the sandbox every later agent
 *   command runs in, or move new workspaces from a worktree into the project directory itself;
 * - destructive archive policies: coderWorkspaceArchiveBehavior and worktreeArchiveBehavior
 *   (with their legacy deleteWorktreeOnArchive and stopCoderWorkspaceOnArchive spellings). A
 *   repository-controlled "delete" would make every later archive remove worktrees and Coder
 *   workspaces, and unpushed work with them, with no prompt naming the policy;
 * - agent-executed text: heartbeatDefaultPrompt. A repository-controlled prompt would run
 *   unattended in every workspace whose heartbeat has no message of its own;
 * - spend, concurrency and diagnostic limits: taskSettings (parallel agent tasks and nesting
 *   depth), goalDefaults (goal budget and turn caps), heartbeatDefaultIntervalMs (how often
 *   enabled heartbeats run unattended turns), llmDebugLogs (records raw provider requests
 *   to disk) and the per-agent cacheTtl inside agentAiDefaults (a one-hour prompt cache
 *   bills cache writes at a higher rate on every later turn). A restore shows no per-key approval, so a repository-controlled value
 *   would silently raise a limit the user set or start recording prompts;
 * - not yet reviewed for portability: toolSearchEnabled, bashAiProxyEnabled,
 *   agentHeartbeatsEnabled;
 * - save-time projections and internal state: defaultRuntime (the legacy mirror of
 *   defaultIsolation), subagentAiDefaults, preferredCompactionModel
 *   (unused), projects (the project bundle), viewedSplashScreens, migrations, writeId,
 *   settingsBackup, onePasswordAccountName, legacyOnePasswordAccountName, and the retired
 *   advisor settings (inert downgrade data).
 * userPreferences has its own projection, projectBackupPreferences.
 */
const BACKED_UP_SETTINGS_KEYS = [
  "agentAiDefaults",
  "defaultModel",
  "hiddenModels",
  "minThinkingLevelByModel",
  "modelFallbacks",
  // The per-agent Auto flags in agentAiDefaults mean nothing without the tiers they route to.
  "autoModelRouting",
  "evaluationDefaults",
  "chatTranscriptFullWidth",
] as const satisfies ReadonlyArray<keyof ProjectsConfig & keyof typeof AppConfigOnDiskSchema.shape>;

type BackedUpSettingsKey = (typeof BACKED_UP_SETTINGS_KEYS)[number];

/**
 * A backup's settings block. Every key an export writes is present, so a value the user reset
 * to its default (cleared agent overrides, deleted fallback chains) round-trips as that default
 * rather than as a gap the restore would fill from the target. `null` is the JSON spelling of
 * an unset value. A key that is absent, as in
 * a block an older build wrote, keeps the local value.
 */
export type BackupSettings = {
  [K in BackedUpSettingsKey]?: NonNullable<ProjectsConfig[K]> | null;
};

export interface BackupSettingsRead {
  /** The keys this build can apply; undefined when the document carries no settings block. */
  settings: BackupSettings | undefined;
  /**
   * Keys whose values fail this build's schema, so a restore keeps the local value: a newer
   * build's export (a thinking level or Auto tier field this build predates) or a damaged document.
   * Reported rather than failing the restore, which would strand every other backed-up file
   * behind an upgrade.
   */
  unsupported: string[];
}

/**
 * The canonical in-memory value of each setting, using the same normalization Config applies
 * on save and load. Export, read, merge, and the post-write check all go through this table, so
 * what a restore writes compares equal to what config.json holds after the write. Unset resolves to what a
 * loaded config holds when the key is absent: `undefined` for optional settings, the default
 * for settings load always fills in.
 */
const NORMALIZE: { [K in BackedUpSettingsKey]: (value: unknown) => ProjectsConfig[K] } = {
  agentAiDefaults: (value) =>
    withoutCacheTtl(normalizeAiDefaultsModelStrings(normalizeAgentAiDefaults(value))),
  defaultModel: normalizeOptionalModelString,
  hiddenModels: normalizeOptionalModelStringArray,
  minThinkingLevelByModel: normalizeMinThinkingLevelByModel,
  modelFallbacks: normalizeModelFallbacks,
  autoModelRouting: (value) => (value == null ? undefined : normalizeAutoModelRoutingConfig(value)),
  evaluationDefaults: normalizeEvaluationDefaults,
  chatTranscriptFullWidth: (value) => value === true,
};

/**
 * Drops each agent's cacheTtl, and an entry that set nothing else, so a backup neither carries
 * nor applies it. Other values pass through for the schema to judge.
 */
function withoutCacheTtl<T>(value: T): T {
  if (!isPlainObject(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [agentId, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || !("cacheTtl" in entry)) {
      kept[agentId] = entry;
      continue;
    }
    const { cacheTtl: _local, ...rest } = entry;
    // Normalized entries spell unset fields as undefined properties.
    if (Object.values(rest).some((field) => field !== undefined)) kept[agentId] = rest;
  }
  return kept as T;
}

/** The local per-agent cacheTtl values, laid over restored agent defaults. */
function keepLocalCacheTtl(
  restored: ProjectsConfig["agentAiDefaults"],
  local: ProjectsConfig["agentAiDefaults"]
): ProjectsConfig["agentAiDefaults"] {
  const merged = { ...restored };
  for (const [agentId, entry] of Object.entries(local ?? {})) {
    if (entry.cacheTtl !== undefined) {
      merged[agentId] = { ...merged[agentId], cacheTtl: entry.cacheTtl };
    }
  }
  return merged;
}

/**
 * Load-time normalization heals what it cannot read: it drops invalid entries, caps chains,
 * strips unknown fields and fills defaults. Applying a healed copy of a damaged or newer-build
 * value would silently replace the target's setting, so a value is accepted only when
 * normalization keeps it exactly as written; anything else keeps the local value and is
 * reported. Exports are always canonical, and `null` is the only spelling of unset.
 */
function isCanonical(key: BackedUpSettingsKey, value: unknown): boolean {
  const normalized = NORMALIZE[key](value);
  return normalized !== undefined && isDeepStrictEqual(copyJson(normalized), value);
}

/**
 * Per-key on-disk schemas rather than one picked object: the on-disk schema is passthrough,
 * which would carry any key of a repository-controlled document into the config. Where
 * normalization keeps values lookups can never match, the schema is tightened: a per-model
 * floor needs a model-string key, a fallback chain model-string sources and targets, and the
 * evaluator a model on an evaluation provider. (Auto routing's schema already checks its models.)
 */
const isModelString = (model: string) => normalizeOptionalModelString(model) === model;

// The evaluator also needs a provider this build can build an evaluation model for; a newer
// build's provider would otherwise replace a working local evaluator with one that fails.
const isEvaluatorModel = (model: string) =>
  isModelString(model) && isEvaluationProvider(model.slice(0, model.indexOf(":")));

const FIELD_SCHEMA_OVERRIDES: Partial<Record<BackedUpSettingsKey, z.ZodType>> = {
  minThinkingLevelByModel: AppConfigOnDiskSchema.shape.minThinkingLevelByModel
    .unwrap()
    .refine((value) => Object.keys(value).every(isModelString)),
  modelFallbacks: AppConfigOnDiskSchema.shape.modelFallbacks
    .unwrap()
    .refine((value) =>
      Object.entries(value).every(
        ([source, chain]) => isModelString(source) && chain.models.every(isModelString)
      )
    ),
  evaluationDefaults: AppConfigOnDiskSchema.shape.evaluationDefaults
    .unwrap()
    .refine((value) => value.model === undefined || isEvaluatorModel(value.model)),
};

/**
 * The payload's per-file size cap still lets a repository-controlled block hold hundreds of
 * thousands of entries in one list or map, which preview, restore and every model picker would
 * then carry. No real setting comes near this; a larger value keeps the local one and is reported.
 */
const MAX_SETTING_ENTRIES = 2000;

function entryCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return isPlainObject(value) ? Object.keys(value).length : 0;
}

function isSupported(key: BackedUpSettingsKey, value: unknown): boolean {
  const schema = FIELD_SCHEMA_OVERRIDES[key] ?? AppConfigOnDiskSchema.shape[key];
  // A per-agent cacheTtl is ignored, even one this build cannot parse, not a reason to reject
  // the agent defaults around it.
  const portable = key === "agentAiDefaults" ? withoutCacheTtl(value) : value;
  return (
    entryCount(portable) <= MAX_SETTING_ENTRIES &&
    schema.safeParse(portable).success &&
    isCanonical(key, portable)
  );
}

function setSetting<K extends BackedUpSettingsKey>(
  target: BackupSettings,
  key: K,
  value: ProjectsConfig[K]
): void {
  target[key] = (value ?? null) as BackupSettings[K];
}

function assignSetting<K extends BackedUpSettingsKey>(
  target: ProjectsConfig,
  key: K,
  value: unknown
): void {
  target[key] = NORMALIZE[key](value);
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function projectBackupSettings(config: ProjectsConfig): BackupSettings {
  const projected: BackupSettings = {};
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    setSetting(projected, key, NORMALIZE[key](config[key]));
  }
  return copyJson(projected);
}

const MAX_REPORTED_UNKNOWN_KEYS = 20;
const MAX_REPORTED_KEY_CHARS = 80;

/**
 * A key this build has never heard of is most likely a newer build's portable setting, so the
 * user should hear the restore kept the local value. Keys this build knows and keeps local (an
 * older export's heartbeat prompt) stay silent. The block is repository-controlled, so the list
 * is bounded: preview and restore return it over IPC and the Backup section renders each name.
 */
function unknownSettingsKeys(block: Record<string, unknown>): string[] {
  const unknown = Object.keys(block).filter((key) => !(key in AppConfigOnDiskSchema.shape));
  const named = unknown
    .slice(0, MAX_REPORTED_UNKNOWN_KEYS)
    .map((key) =>
      key.length > MAX_REPORTED_KEY_CHARS ? `${key.slice(0, MAX_REPORTED_KEY_CHARS)}…` : key
    );
  const more = unknown.length - named.length;
  return more > 0 ? [...named, `${more} more unknown settings`] : named;
}

/** Reads the `settings` block of a preferences document. */
export function readBackupSettings(document: unknown): BackupSettingsRead {
  if (!isPlainObject(document) || document.settings === undefined) {
    return { settings: undefined, unsupported: [] };
  }
  const block = document.settings;
  if (!isPlainObject(block)) {
    return { settings: undefined, unsupported: ["settings (not an object)"] };
  }
  const settings: BackupSettings = {};
  const unsupported: string[] = [];
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    if (!(key in block)) continue;
    const value = block[key];
    if (value === null || isSupported(key, value)) {
      setSetting(settings, key, NORMALIZE[key](value));
    } else {
      unsupported.push(key);
    }
  }
  return { settings, unsupported: [...unsupported, ...unknownSettingsKeys(block)] };
}

/** Each key the block carries replaces the local value; keys it lacks keep the local value. */
export function mergeBackupSettings(
  current: ProjectsConfig,
  settings: BackupSettings
): ProjectsConfig {
  const merged: ProjectsConfig = { ...current };
  for (const key of BACKED_UP_SETTINGS_KEYS) {
    if (key in settings) assignSetting(merged, key, settings[key]);
  }
  if ("agentAiDefaults" in settings) {
    merged.agentAiDefaults = keepLocalCacheTtl(merged.agentAiDefaults, current.agentAiDefaults);
  }
  if (settings.hiddenModels != null) {
    // As Config.updateModelPreferences does: the restored list is now the user's, so the
    // default seeding must not claim it.
    merged.migrations = { ...current.migrations, hiddenModelsInitialized: true };
  }
  return merged;
}
