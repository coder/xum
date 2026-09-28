import { z } from "zod";
import {
  AgentAiDefaultsEntrySchema,
  AgentAiSubagentProfileSchema,
  AppConfigOnDiskSchema,
  GoalDefaultsSchema,
} from "@/common/config/schemas/appConfigOnDisk";
import { ADVISOR_DEFAULT_MAX_USES_PER_TURN } from "@/common/constants/advisor";
import { LayoutPresetsConfigSchema } from "@/common/orpc/schemas/uiLayouts";
import { AgentIdSchema } from "@/common/schemas/ids";
import {
  AutoModelRoutingConfigSchema,
  normalizeAutoModelRoutingConfig,
} from "@/common/types/autoModelRouting";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ProjectsConfig } from "@/common/types/project";
import { normalizeTaskSettings } from "@/common/types/tasks";
import { coerceOpenAIReasoningMode, coerceThinkingLevel } from "@/common/types/thinking";
import { isLayoutPresetsConfigEmpty, normalizeLayoutPresetsConfig } from "@/common/types/uiLayouts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { normalizeGoalDefaults } from "@/constants/goals";
import {
  normalizeAiDefaultsModelStrings,
  normalizeEvaluationDefaults,
  normalizeMinThinkingLevelByModel,
  normalizeModelFallbacks,
  normalizeOptionalModelString,
  normalizeOptionalModelStringArray,
  normalizeRuntimeEnablementId,
  normalizeRuntimeEnablementOverrides,
  parseOptionalHeartbeatIntervalMs,
  parseOptionalNonEmptyString,
  parseOptionalPositiveInteger,
} from "@/node/config";

/**
 * Where each top-level config key goes in a backup. Exhaustive over both the on-disk schema
 * and the loaded config, so a new key fails typecheck until it is classified here; only
 * "settings" keys travel in the settings block, and every other class stays local:
 * - preferences: userPreferences, which has its own projection, projectBackupPreferences;
 * - machine: bound to the machine or its network;
 * - secret: secrets and enrollment;
 * - credentials: derived from providers.jsonc credentials, which are never exported (see
 *   providerService.syncGatewayLifecycleEffect);
 * - destructive: archive policies (with their legacy spellings). A repository-controlled
 *   "delete" would make every later archive remove worktrees and Coder workspaces, and
 *   unpushed work with them, with no prompt naming the policy;
 * - agentExecuted: text agents act on. A repository-controlled heartbeat prompt would run
 *   unattended in every workspace whose heartbeat has no message of its own;
 * - internal: save-time projections and internal state.
 */
const CONFIG_KEY_BACKUP = {
  agentAiDefaults: "settings",
  defaultModel: "settings",
  hiddenModels: "settings",
  minThinkingLevelByModel: "settings",
  modelFallbacks: "settings",
  advisorModelString: "settings",
  advisorThinkingLevel: "settings",
  advisorReasoningMode: "settings",
  advisorMaxUsesPerTurn: "settings",
  advisorMaxOutputTokens: "settings",
  taskSettings: "settings",
  heartbeatDefaultIntervalMs: "settings",
  goalDefaults: "settings",
  chatTranscriptFullWidth: "settings",
  llmDebugLogs: "settings",
  runtimeEnablement: "settings",
  defaultRuntime: "settings",
  layoutPresets: "settings",
  autoModelRouting: "settings",
  evaluationDefaults: "settings",
  // Harmless where it has no effect: only the desktop app holds a sleep blocker.
  keepScreenAwake: "settings",
  userPreferences: "preferences",
  apiServerBindHost: "machine",
  apiServerPort: "machine",
  apiServerServeWebUi: "machine",
  mdnsAdvertisementEnabled: "machine",
  mdnsServiceName: "machine",
  serverSshHost: "machine",
  serverAuthGithubOwner: "machine",
  defaultProjectDir: "machine",
  terminalDefaultShell: "machine",
  updateChannel: "machine",
  useSSH2Transport: "machine",
  muxGovernorUrl: "secret",
  muxGovernorToken: "secret",
  routePriority: "credentials",
  routeOverrides: "credentials",
  muxGatewayEnabled: "credentials",
  muxGatewayModels: "credentials",
  coderWorkspaceArchiveBehavior: "destructive",
  worktreeArchiveBehavior: "destructive",
  deleteWorktreeOnArchive: "destructive",
  stopCoderWorkspaceOnArchive: "destructive",
  heartbeatDefaultPrompt: "agentExecuted",
  subagentAiDefaults: "internal",
  // Unused.
  preferredCompactionModel: "internal",
  // Carried by the project bundle.
  projects: "internal",
  viewedSplashScreens: "internal",
  migrations: "internal",
  writeId: "internal",
  settingsBackup: "internal",
  onePasswordAccountName: "internal",
  legacyOnePasswordAccountName: "internal",
} as const satisfies Record<
  keyof ProjectsConfig | keyof typeof AppConfigOnDiskSchema.shape,
  | "settings"
  | "preferences"
  | "machine"
  | "secret"
  | "credentials"
  | "destructive"
  | "agentExecuted"
  | "internal"
>;

type ConfigKey = keyof typeof CONFIG_KEY_BACKUP;

/** Fails typecheck when a key classified as a setting is missing on disk or in memory. */
type SubsetOf<T extends U, U> = T;

type BackedUpSettingsKey = SubsetOf<
  { [K in ConfigKey]: (typeof CONFIG_KEY_BACKUP)[K] extends "settings" ? K : never }[ConfigKey],
  keyof ProjectsConfig & keyof typeof AppConfigOnDiskSchema.shape
>;

const BACKED_UP_SETTINGS_KEYS = (Object.keys(CONFIG_KEY_BACKUP) as ConfigKey[]).filter(
  (key): key is BackedUpSettingsKey => CONFIG_KEY_BACKUP[key] === "settings"
);

/**
 * A backup's settings block. Every key an export writes is present, so a value the user reset
 * to its default (cleared agent overrides, deleted fallback chains) round-trips as that default
 * rather than as a gap the restore would fill from the target. `null` is the JSON spelling of
 * an unset value, except for advisorMaxUsesPerTurn, where the app itself uses null for
 * "unlimited" and an unset cap therefore exports as the default cap. A key that is absent, as in
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
  advisorModelString: parseOptionalNonEmptyString,
  advisorThinkingLevel: coerceThinkingLevel,
  advisorReasoningMode: coerceOpenAIReasoningMode,
  // null is how config.json spells an explicit "unlimited" cap and is kept as written.
  advisorMaxUsesPerTurn: (value) => (value === null ? null : parseOptionalPositiveInteger(value)),
  advisorMaxOutputTokens: (value) => (value === null ? null : parseOptionalPositiveInteger(value)),
  taskSettings: normalizeTaskSettings,
  heartbeatDefaultIntervalMs: parseOptionalHeartbeatIntervalMs,
  goalDefaults: (value) => normalizeGoalDefaults(GoalDefaultsSchema.safeParse(value).data),
  chatTranscriptFullWidth: (value) => value === true,
  llmDebugLogs: (value) => value === true,
  runtimeEnablement: normalizeRuntimeEnablementOverrides,
  defaultRuntime: normalizeRuntimeEnablementId,
  layoutPresets: (value) => {
    const normalized = normalizeLayoutPresetsConfig(value);
    return isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized;
  },
  autoModelRouting: (value) => (value == null ? undefined : normalizeAutoModelRoutingConfig(value)),
  evaluationDefaults: normalizeEvaluationDefaults,
  keepScreenAwake: (value) => value === true,
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
 * string, at the top level and inside each agent's defaults; any id is a runtime; any keybind is
 * a slot), the field schema is tightened to what the normalizer accepts. Otherwise a damaged or
 * newer-build value would pass the schema, normalize to unset, and reset the target's setting,
 * when the contract is to keep the local value and report the key as unsupported. Empty
 * spellings (`""`, `[]`, `{}`, no slots) still canonicalize to unset. layoutPresets is unknown on
 * disk; the strict schema the layouts API saves through is used.
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
  layoutPresets: LayoutPresetsConfigSchema.refine(
    (value) => normalizeLayoutPresetsConfig(value).slots.length === value.slots.length
  ),
  // The on-disk shape accepts any tier list (and `.catch` turns anything else into unset);
  // normalization would then heal a damaged or newer-build block into the default tiers.
  autoModelRouting: AutoModelRoutingConfigSchema.refine(
    (value) => new Set(value.tiers.map((tier) => tier.id)).size === value.tiers.length
  ),
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
  // The advisor reads null as "unlimited" and unset as the default cap, so an unset cap cannot
  // take the block's null spelling: a default source would switch the target to unlimited.
  if (config.advisorMaxUsesPerTurn === undefined) {
    projected.advisorMaxUsesPerTurn = ADVISOR_DEFAULT_MAX_USES_PER_TURN;
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
  if (settings.hiddenModels != null) {
    // As Config.updateModelPreferences does: the restored list is now the user's, so the
    // default seeding must not claim it.
    merged.migrations = { ...current.migrations, hiddenModelsInitialized: true };
  }
  return merged;
}
