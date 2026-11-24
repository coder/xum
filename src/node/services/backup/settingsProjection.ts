import { z } from "zod";
import {
  AgentAiDefaultsEntrySchema,
  AgentAiSubagentProfileSchema,
  AppConfigOnDiskSchema,
} from "@/common/config/schemas/appConfigOnDisk";
import { AgentIdSchema } from "@/common/schemas/ids";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  AutoModelRoutingConfigSchema,
  normalizeAutoModelRoutingConfig,
} from "@/common/types/autoModelRouting";
import type { ProjectsConfig } from "@/common/types/project";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { normalizeIsolationChoice } from "@/common/types/isolation";
import {
  applyPersistedDefaultIsolation,
  normalizeAiDefaultsModelStrings,
  normalizeEvaluationDefaults,
  normalizeMinThinkingLevelByModel,
  normalizeModelFallbacks,
  normalizeOptionalModelString,
  normalizeOptionalModelStringArray,
  normalizeRuntimeEnablementOverrides,
  parseOptionalHeartbeatIntervalMs,
  resolvePersistedDefaultIsolation,
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
 * - agent sandbox policy: agentSandbox. A repository-controlled value could loosen the sandbox
 *   every later agent command runs in;
 * - destructive archive policies: coderWorkspaceArchiveBehavior and worktreeArchiveBehavior
 *   (with their legacy deleteWorktreeOnArchive and stopCoderWorkspaceOnArchive spellings). A
 *   repository-controlled "delete" would make every later archive remove worktrees and Coder
 *   workspaces, and unpushed work with them, with no prompt naming the policy;
 * - agent-executed text: heartbeatDefaultPrompt. A repository-controlled prompt would run
 *   unattended in every workspace whose heartbeat has no message of its own;
 * - spend, concurrency and diagnostic limits: taskSettings (parallel agent tasks and nesting
 *   depth), goalDefaults (goal budget and turn caps) and llmDebugLogs (records raw provider
 *   requests to disk). A restore shows no per-key approval, so a repository-controlled value
 *   would silently raise a limit the user set or start recording prompts;
 * - not yet reviewed for portability: toolSearchEnabled, bashAiProxyEnabled,
 *   agentHeartbeatsEnabled;
 * - save-time projections and internal state: defaultRuntime (the legacy mirror config derives
 *   from defaultIsolation), subagentAiDefaults, preferredCompactionModel
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
  "heartbeatDefaultIntervalMs",
  "chatTranscriptFullWidth",
  "runtimeEnablement",
  "defaultIsolation",
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
   * build's export (a thinking level or runtime this build predates) or a damaged document.
   * Reported rather than failing the restore, which would strand every other backed-up file
   * behind an upgrade.
   */
  unsupported: string[];
}

/**
 * The canonical in-memory value of each setting, using the same normalization Config applies
 * on save and load. Export, read, merge, and the post-write check all go through this table, so
 * a schema-valid but non-canonical document (a padded model string, an unsanitized fallback
 * chain) compares equal to what config.json holds after the write. Unset resolves to what a
 * loaded config holds when the key is absent: `undefined` for optional settings, the default
 * for settings load always fills in.
 */
const NORMALIZE: { [K in BackedUpSettingsKey]: (value: unknown) => ProjectsConfig[K] } = {
  agentAiDefaults: (value) => normalizeAiDefaultsModelStrings(normalizeAgentAiDefaults(value)),
  defaultModel: normalizeOptionalModelString,
  hiddenModels: normalizeOptionalModelStringArray,
  minThinkingLevelByModel: normalizeMinThinkingLevelByModel,
  modelFallbacks: normalizeModelFallbacks,
  autoModelRouting: (value) => (value == null ? undefined : normalizeAutoModelRoutingConfig(value)),
  evaluationDefaults: normalizeEvaluationDefaults,
  heartbeatDefaultIntervalMs: parseOptionalHeartbeatIntervalMs,
  chatTranscriptFullWidth: (value) => value === true,
  runtimeEnablement: normalizeRuntimeEnablementOverrides,
  defaultIsolation: normalizeIsolationChoice,
};

function isEmptySpelling(value: unknown): boolean {
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

const acceptedBy = (normalize: (value: unknown) => unknown) => (value: unknown) =>
  isEmptySpelling(value) || normalize(value) !== undefined;

const ModelStringSchema = z.string().refine(acceptedBy(normalizeOptionalModelString));

/**
 * Where the on-disk schema accepts values load-time normalization rejects (any string is a model
 * string, at the top level and inside each agent's defaults; any id is a runtime), the field schema is tightened to what the normalizer accepts. Otherwise a damaged or
 * newer-build value would pass the schema, normalize to unset, and reset the target's setting,
 * when the contract is to keep the local value and report the key as unsupported. Empty
 * spellings (`""`, `[]`, `{}`) still canonicalize to unset.
 */
const FIELD_SCHEMA_OVERRIDES: Partial<Record<BackedUpSettingsKey, z.ZodType>> = {
  agentAiDefaults: z.record(
    AgentIdSchema,
    AgentAiDefaultsEntrySchema.extend({
      modelString: ModelStringSchema.optional(),
      subagent: AgentAiSubagentProfileSchema.extend({
        modelString: ModelStringSchema.optional(),
      }).optional(),
    })
  ),
  defaultModel: ModelStringSchema,
  hiddenModels: z.array(ModelStringSchema),
  modelFallbacks: AppConfigOnDiskSchema.shape.modelFallbacks
    .unwrap()
    .refine(acceptedBy(normalizeModelFallbacks)),
  runtimeEnablement: AppConfigOnDiskSchema.shape.runtimeEnablement
    .unwrap()
    .refine(acceptedBy(normalizeRuntimeEnablementOverrides)),
  // The on-disk shape degrades anything to absent and load heals each field to its default.
  autoModelRouting: AutoModelRoutingConfigSchema,
};

/**
 * Per-key schemas rather than one picked object: the on-disk schema is passthrough, which would
 * carry any key of a repository-controlled document into the config, and each key accepts null.
 */
function fieldSchema(key: BackedUpSettingsKey): z.ZodType {
  return (FIELD_SCHEMA_OVERRIDES[key] ?? AppConfigOnDiskSchema.shape[key]).nullable();
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

/** Reads and canonicalizes the `settings` block of a preferences document. */
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
    const parsed = fieldSchema(key).safeParse(block[key]);
    if (parsed.success) {
      setSetting(settings, key, NORMALIZE[key](parsed.data));
    } else {
      unsupported.push(key);
    }
  }
  return { settings, unsupported };
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
  if ("defaultIsolation" in settings) {
    // Load and save resolve the default from defaultIsolation, falling back to the legacy
    // defaultRuntime mirror, so a stale mirror would bring back a default the backup cleared.
    applyPersistedDefaultIsolation(
      merged,
      resolvePersistedDefaultIsolation({ defaultIsolation: merged.defaultIsolation })
    );
  }
  if (settings.hiddenModels != null) {
    // As Config.updateModelPreferences does: the restored list is now the user's, so the
    // default seeding must not claim it.
    merged.migrations = { ...current.migrations, hiddenModelsInitialized: true };
  }
  return merged;
}
