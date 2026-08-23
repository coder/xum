import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as jsonc from "jsonc-parser";
import { EventEmitter } from "events";
import writeFileAtomic from "write-file-atomic";
import { resolveXumEnvironmentValue } from "@/common/compat/legacyMux";
import { log } from "@/node/services/log";
import type { WorkspaceMetadata, FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isSecretReferenceValue, type Secret, type SecretsConfig } from "@/common/types/secrets";
import type {
  Workspace,
  ProjectConfig,
  ProjectsConfig,
  UpdateChannel,
} from "@/common/types/project";
import type {
  AppConfigMigrations,
  AppConfigOnDisk,
  BaseProviderConfig as ProviderConfig,
  ModelFallbacks,
  ProvidersConfig as CanonicalProvidersConfig,
} from "@/common/config/schemas";
import { DEFAULT_MODEL_FALLBACKS, sanitizeModelFallbacks } from "@/common/utils/ai/modelFallbacks";
import { DEFAULT_TASK_SETTINGS, normalizeTaskSettings } from "@/common/types/tasks";
import { normalizeUserPreferences } from "@/common/config/schemas/userPreferences";
import { SettingsBackupSchema } from "@/common/config/schemas/settingsBackup";
import { isLayoutPresetsConfigEmpty, normalizeLayoutPresetsConfig } from "@/common/types/uiLayouts";
import {
  deriveLegacySubagentAiDefaultsProjection,
  mergeLegacySubagentAiDefaults,
  normalizeAgentAiDefaults,
} from "@/common/types/agentAiDefaults";
import {
  isWorktreeRuntime,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import { SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { isIncompatibleRuntimeConfig } from "@/common/utils/runtimeCompatibility";
import { LEGACY_MUX_PRODUCT_NAME, LEGACY_MUX_PRODUCT_SLUG } from "@/common/compat/legacyMux";
import { getXumHome } from "@/common/constants/paths";
import { XUM_PRODUCT_NAME, XUM_PRODUCT_SLUG } from "@/common/constants/product";
import { GATEWAY_PROVIDERS } from "@/common/constants/providers";
import {
  DEFAULT_CODER_ARCHIVE_BEHAVIOR,
  isCoderWorkspaceArchiveBehavior,
  type CoderWorkspaceArchiveBehavior,
} from "@/common/config/coderArchiveBehavior";
import {
  DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
  isWorktreeArchiveBehavior,
  type WorktreeArchiveBehavior,
} from "@/common/config/worktreeArchiveBehavior";
import { PlatformPaths } from "@/common/utils/paths";
import {
  HEARTBEAT_CONTEXT_MODE_VALUES,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  isHeartbeatTrigger,
  isHeartbeatWhenBusy,
  isValidHeartbeatScheduleUpdatedAt,
} from "@/constants/heartbeat";
import { normalizeGoalDefaults } from "@/constants/goals";
import {
  isValidModelFormat,
  normalizeSelectedModel,
  normalizeToCanonical,
} from "@/common/utils/ai/models";
import { ensurePrivateDirSync } from "@/node/utils/fs";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { isProviderAutoRouteEligible } from "@/node/utils/providerRequirements";
import { getContainerName as getDockerContainerName } from "@/node/runtime/DockerRuntime";
import { deriveProjectHierarchy } from "@/common/utils/subProjects";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";

// Re-export project/provider types from dedicated schema/types files (for preload usage)
export type { Workspace, ProjectConfig, ProjectsConfig, ProviderConfig, CanonicalProvidersConfig };
export type ProvidersConfig = CanonicalProvidersConfig | Record<string, ProviderConfig>;

function isValidHeartbeatIntervalMs(intervalMs: unknown): intervalMs is number {
  return (
    typeof intervalMs === "number" &&
    Number.isInteger(intervalMs) &&
    intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
    intervalMs <= HEARTBEAT_MAX_INTERVAL_MS
  );
}

function isWorkspaceHeartbeatContextMode(
  value: unknown
): value is NonNullable<NonNullable<WorkspaceMetadata["heartbeat"]>["contextMode"]> {
  return (
    typeof value === "string" &&
    HEARTBEAT_CONTEXT_MODE_VALUES.some((candidate) => candidate === value)
  );
}

function normalizeWorkspaceMetadataHeartbeat(
  heartbeat: Workspace["heartbeat"] | undefined,
  config: ProjectsConfig
): WorkspaceMetadata["heartbeat"] | undefined {
  if (!heartbeat) {
    return undefined;
  }

  const persisted = heartbeat as Partial<NonNullable<Workspace["heartbeat"]>>;
  const defaultIntervalMs = isValidHeartbeatIntervalMs(config.heartbeatDefaultIntervalMs)
    ? config.heartbeatDefaultIntervalMs
    : HEARTBEAT_DEFAULT_INTERVAL_MS;
  const message = typeof persisted.message === "string" ? persisted.message : undefined;
  const contextMode = isWorkspaceHeartbeatContextMode(persisted.contextMode)
    ? persisted.contextMode
    : undefined;
  // Copy schedule fields through so metadata consumers (frontend modal, HeartbeatService's
  // metadata-event handler) see persisted values instead of silently falling back to the
  // read-time defaults. Invalid values are dropped (self-healing), which resolves to the
  // same defaults resolveHeartbeatSchedulePolicy would apply.
  const trigger = isHeartbeatTrigger(persisted.trigger) ? persisted.trigger : undefined;
  const whenBusy = isHeartbeatWhenBusy(persisted.whenBusy) ? persisted.whenBusy : undefined;
  const scheduleUpdatedAt = isValidHeartbeatScheduleUpdatedAt(persisted.scheduleUpdatedAt)
    ? persisted.scheduleUpdatedAt
    : undefined;

  return {
    enabled: persisted.enabled === true,
    intervalMs: isValidHeartbeatIntervalMs(persisted.intervalMs)
      ? persisted.intervalMs
      : defaultIntervalMs,
    ...(message != null ? { message } : {}),
    ...(contextMode != null ? { contextMode } : {}),
    ...(trigger != null ? { trigger } : {}),
    ...(whenBusy != null ? { whenBusy } : {}),
    ...(scheduleUpdatedAt != null ? { scheduleUpdatedAt } : {}),
  };
}

function parseOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export interface LegacyTaskVariantGroup {
  groupId: string;
  index: number;
  total: number;
  kind: "variants";
  label?: string;
}

export interface LegacyTaskVariantWorkspace {
  id: string;
  projectPath: string;
  parentWorkspaceId?: string;
  agentId?: string;
  agentType?: string;
  title?: string;
  createdAt?: string;
  taskStatus?: Workspace["taskStatus"];
  bestOf: LegacyTaskVariantGroup;
}

function parseLegacyTaskVariantGroup(value: unknown): LegacyTaskVariantGroup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const groupId = parseOptionalNonEmptyString(record.groupId);
  const label = parseOptionalNonEmptyString(record.label);
  const index = record.index;
  const total = record.total;
  if (
    record.kind !== "variants" ||
    !groupId ||
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(total) ||
    (total as number) < 2 ||
    (index as number) >= (total as number)
  ) {
    return undefined;
  }

  return {
    groupId,
    index: index as number,
    total: total as number,
    kind: "variants",
    ...(label ? { label } : {}),
  };
}

function isLegacyTaskVariantGroup(value: unknown): boolean {
  return parseLegacyTaskVariantGroup(value) != null;
}

function normalizeWorkspaceBestOf(value: unknown): WorkspaceMetadata["bestOf"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  // Variants were coupled to one-off sibling lanes. Persistent sub-agents need stable identities,
  // so legacy variant children intentionally load as ordinary children instead of retaining a
  // grouping that current code can no longer continue coherently.
  if (isLegacyTaskVariantGroup(record)) {
    return undefined;
  }

  const groupId = parseOptionalNonEmptyString(record.groupId);
  const index = record.index;
  const total = record.total;
  if (
    !groupId ||
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    !Number.isInteger(total) ||
    (total as number) < 2 ||
    (index as number) >= (total as number)
  ) {
    return undefined;
  }

  return { groupId, index: index as number, total: total as number };
}

function parseOptionalEnvBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}
function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseUpdateChannel(value: unknown): UpdateChannel | undefined {
  if (value === "stable" || value === "nightly") {
    return value;
  }

  return undefined;
}

function parseCoderWorkspaceArchiveBehavior(
  value: unknown
): CoderWorkspaceArchiveBehavior | undefined {
  return isCoderWorkspaceArchiveBehavior(value) ? value : undefined;
}

function parseWorktreeArchiveBehavior(value: unknown): WorktreeArchiveBehavior | undefined {
  return isWorktreeArchiveBehavior(value) ? value : undefined;
}

/**
 * Whether a process with `pid` currently exists. Signal 0 performs only the
 * existence/permission check; EPERM means the process exists but belongs to
 * another user (still alive for lock-liveness purposes).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function resolveDeleteWorktreeOnArchive(deleteWorktreeOnArchive: unknown): boolean {
  return parseOptionalBoolean(deleteWorktreeOnArchive) ?? false;
}

function resolveWorktreeArchiveBehavior(
  worktreeArchiveBehavior: unknown,
  deleteWorktreeOnArchive: unknown
): WorktreeArchiveBehavior {
  const parsedBehavior = parseWorktreeArchiveBehavior(worktreeArchiveBehavior);
  if (parsedBehavior !== undefined) {
    return parsedBehavior;
  }

  return resolveDeleteWorktreeOnArchive(deleteWorktreeOnArchive)
    ? "delete"
    : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
}

function getLegacyDeleteWorktreeOnArchiveValue(
  worktreeArchiveBehavior: WorktreeArchiveBehavior
): boolean {
  return worktreeArchiveBehavior === "delete";
}

function resolveWorktreeArchiveBehaviorForSave(
  config: Pick<ProjectsConfig, "worktreeArchiveBehavior" | "deleteWorktreeOnArchive">
): WorktreeArchiveBehavior {
  const parsedBehavior = parseWorktreeArchiveBehavior(config.worktreeArchiveBehavior);
  if (parsedBehavior != null) {
    return parsedBehavior;
  }

  return resolveDeleteWorktreeOnArchive(config.deleteWorktreeOnArchive)
    ? "delete"
    : DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR;
}

function resolveCoderWorkspaceArchiveBehavior(
  coderWorkspaceArchiveBehavior: unknown,
  stopCoderWorkspaceOnArchive: unknown
): CoderWorkspaceArchiveBehavior {
  const parsedBehavior = parseCoderWorkspaceArchiveBehavior(coderWorkspaceArchiveBehavior);
  if (parsedBehavior !== undefined) {
    return parsedBehavior;
  }

  return parseOptionalBoolean(stopCoderWorkspaceOnArchive) === false
    ? "keep"
    : DEFAULT_CODER_ARCHIVE_BEHAVIOR;
}

function getLegacyStopCoderWorkspaceOnArchiveValue(
  coderWorkspaceArchiveBehavior: CoderWorkspaceArchiveBehavior
): false | undefined {
  return coderWorkspaceArchiveBehavior === "keep" ? false : undefined;
}

function resolveCoderWorkspaceArchiveBehaviorForSave(
  config: Pick<ProjectsConfig, "coderWorkspaceArchiveBehavior" | "stopCoderWorkspaceOnArchive">
): CoderWorkspaceArchiveBehavior {
  const parsedBehavior = parseCoderWorkspaceArchiveBehavior(config.coderWorkspaceArchiveBehavior);
  if (parsedBehavior != null) {
    return parsedBehavior;
  }

  if (config.stopCoderWorkspaceOnArchive === false) {
    return "keep";
  }

  return DEFAULT_CODER_ARCHIVE_BEHAVIOR;
}

function parseOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}
function parseOptionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeRouteOverridesRecord(value: unknown): Record<string, string> | undefined {
  const parsed = parseOptionalStringRecord(value);
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, route] of Object.entries(parsed)) {
    out[normalizeToCanonical(key)] = route;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize the per-model minimum thinking level map. Keys are canonicalized and
 * values that aren't valid thinking levels are dropped, keeping a malformed config
 * from bricking startup (self-healing on load).
 */
function normalizeMinThinkingLevelByModel(
  value: unknown
): Record<string, ThinkingLevel> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const out: Record<string, ThinkingLevel> = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    const coerced = coerceThinkingLevel(level);
    if (coerced !== undefined) {
      // Gateway-preserving key: explicit coder:<instance>/<model> floors
      // must not collapse into (and clobber) the direct provider's entry.
      out[normalizeSelectedModel(key)] = coerced;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeModelFallbacks(value: unknown): ModelFallbacks | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  // Lenient-on-read: sanitizeModelFallbacks canonicalizes keys, drops
  // self-fallbacks/duplicates/empty chains, and caps chain length, so malformed
  // entries self-heal instead of breaking config load or sends.
  const sanitizedEntries: ModelFallbacks = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const candidate = entry as { enabled?: unknown; triggers?: unknown; models?: unknown };
    if (!Array.isArray(candidate.models)) {
      continue;
    }
    sanitizedEntries[key] = {
      ...(typeof candidate.enabled === "boolean" ? { enabled: candidate.enabled } : {}),
      ...(Array.isArray(candidate.triggers)
        ? {
            triggers: candidate.triggers.filter((t): t is "model_refusal" => t === "model_refusal"),
          }
        : {}),
      models: candidate.models.filter((m): m is string => typeof m === "string"),
    };
  }

  const sanitized = sanitizeModelFallbacks(sanitizedEntries);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function normalizeOptionalModelString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  // Reject malformed mux-gateway strings ("mux-gateway:provider" without "/model").
  if (trimmed.startsWith("mux-gateway:") && !trimmed.includes("/")) {
    return undefined;
  }

  const normalized = normalizeSelectedModel(trimmed);
  if (!isValidModelFormat(normalized)) {
    return undefined;
  }

  return normalized;
}

function normalizeOptionalModelStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const normalized = normalizeOptionalModelString(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function normalizeAiDefaultsModelStrings<
  T extends Record<string, { modelString?: string; subagent?: { modelString?: string } }>,
>(value: T): T {
  let modified = false;
  const normalizedEntries = Object.entries(value).map(([id, entry]) => {
    const normalizedModelString = normalizeOptionalModelString(entry.modelString);
    const normalizedSubagentModelString = entry.subagent
      ? normalizeOptionalModelString(entry.subagent.modelString)
      : undefined;
    const subagentChanged =
      entry.subagent != null && normalizedSubagentModelString !== entry.subagent.modelString;
    if (normalizedModelString !== entry.modelString || subagentChanged) {
      modified = true;
      return [
        id,
        {
          ...entry,
          modelString: normalizedModelString,
          ...(entry.subagent
            ? { subagent: { ...entry.subagent, modelString: normalizedSubagentModelString } }
            : {}),
        },
      ];
    }

    return [id, entry];
  });

  return modified ? (Object.fromEntries(normalizedEntries) as T) : value;
}

function normalizeConfigMigrations(value: unknown): AppConfigMigrations {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  // Pass through every true-valued flag, including ones this version does not
  // know about. Migration flags from newer app versions must survive a
  // downgrade-to-here + save, otherwise their one-time migrations re-run after
  // re-upgrade (e.g. re-seeding defaults a user deleted).
  const migrations: AppConfigMigrations = {};
  for (const [flag, flagValue] of Object.entries(record)) {
    if (flagValue === true) {
      migrations[flag] = true;
    }
  }
  return migrations;
}

function parseOptionalPort(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < 0 || value > 65535) {
    return undefined;
  }

  return value;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value <= 0) {
    return undefined;
  }

  return value;
}

function parseOptionalThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return coerceThinkingLevel(value);
}

function parseOptionalHeartbeatIntervalMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return undefined;
  }

  if (value < HEARTBEAT_MIN_INTERVAL_MS || value > HEARTBEAT_MAX_INTERVAL_MS) {
    return undefined;
  }

  return value;
}

function normalizeRuntimeEnablementId(value: unknown): RuntimeEnablementId | undefined {
  const trimmed = parseOptionalNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (RUNTIME_ENABLEMENT_IDS.includes(normalized as RuntimeEnablementId)) {
    return normalized as RuntimeEnablementId;
  }

  return undefined;
}

function normalizeRuntimeEnablementOverrides(
  value: unknown
): Partial<Record<RuntimeEnablementId, false>> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const overrides: Partial<Record<RuntimeEnablementId, false>> = {};

  for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
    // Default ON: store `false` only so config.json stays minimal.
    if (record[runtimeId] === false) {
      overrides[runtimeId] = false;
    }
  }

  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function normalizeProjectKind(value: unknown): "user" | "system" | undefined {
  if (value === "user" || value === "system") {
    return value;
  }

  return undefined;
}

function normalizePersistedWorkspace(
  workspace: ProjectConfig["workspaces"][number]
): ProjectConfig["workspaces"][number] {
  const persisted = workspace as ProjectConfig["workspaces"][number] &
    Record<string, unknown> & {
      workflowSchedule?: unknown;
    };
  const hasLegacyWorkflowSchedule = Object.hasOwn(persisted, "workflowSchedule");
  const hasBestOf = Object.hasOwn(persisted, "bestOf");
  if (!hasLegacyWorkflowSchedule && !hasBestOf) {
    return workspace;
  }

  const nextWorkspace = { ...persisted };
  delete nextWorkspace.workflowSchedule;

  if (hasBestOf) {
    const bestOf = normalizeWorkspaceBestOf(persisted.bestOf);
    if (bestOf) {
      nextWorkspace.bestOf = bestOf;
    } else {
      delete nextWorkspace.bestOf;
    }
  }

  return nextWorkspace;
}

function normalizeProjectRuntimeSettings(projectConfig: ProjectConfig): ProjectConfig {
  // Per-project runtime overrides are optional; keep config.json sparse by persisting only explicit
  // overrides (false enablement + explicit default runtime selections).
  if (!projectConfig || typeof projectConfig !== "object") {
    return { workspaces: [] };
  }

  const record = projectConfig as ProjectConfig & {
    runtimeEnablement?: unknown;
    defaultRuntime?: unknown;
    runtimeOverridesEnabled?: unknown;
    projectKind?: unknown;
    customInstructions?: unknown;
  };
  const runtimeEnablement = normalizeRuntimeEnablementOverrides(record.runtimeEnablement);
  const defaultRuntime = normalizeRuntimeEnablementId(record.defaultRuntime);
  const runtimeOverridesEnabled = record.runtimeOverridesEnabled === true ? true : undefined;

  const next = { ...record };
  delete (next as ProjectConfig & { sections?: unknown }).sections;
  if (runtimeEnablement) {
    next.runtimeEnablement = runtimeEnablement;
  } else {
    delete next.runtimeEnablement;
  }

  if (runtimeOverridesEnabled) {
    next.runtimeOverridesEnabled = runtimeOverridesEnabled;
  } else {
    delete next.runtimeOverridesEnabled;
  }

  if (defaultRuntime) {
    next.defaultRuntime = defaultRuntime;
  } else {
    delete next.defaultRuntime;
  }

  const workspaces = Array.isArray(record.workspaces) ? record.workspaces : [];
  next.workspaces = workspaces.map(normalizePersistedWorkspace);

  const projectKind = normalizeProjectKind(record.projectKind);
  if (projectKind !== undefined) {
    next.projectKind = projectKind;
  } else {
    delete next.projectKind;
  }

  // config.json is hand-editable: a non-string customInstructions would fail
  // the projects.list output schema (z.string()) and brick the whole project
  // list, so discard malformed values here where both load and save pass.
  if (typeof record.customInstructions === "string" && record.customInstructions.trim()) {
    next.customInstructions = record.customInstructions;
  } else {
    delete next.customInstructions;
  }

  // Legacy named workflow schedules are intentionally dropped while workflow
  // scheduling is disabled during the explicit script_path migration.
  delete (next as ProjectConfig & { workflowSchedules?: unknown }).workflowSchedules;

  return next;
}
/**
 * The built-in Chat with Mux workspace (removed in #3123) lived in a hidden
 * `<xumHome>/system/Mux` project. Real upgraded installs still carry that
 * shipped path/title; later xum-branded leftovers use system/Xum and
 * "Chat with Xum". The removal shipped no config migration, so upgraded
 * installs kept the entry: invisible in the UI (system projects are filtered
 * out) but still swept by config-driven background jobs like
 * AgentStatusService, which sent its stale transcript to the LLM on every
 * launch. Drop both generations on load. Older builds recreate the entry on
 * downgrade; this cleanup re-runs on the next upgrade. The workspace's session
 * data is preserved for downgrades: cleanupOrphanSessionDirs exempts the
 * stable mux-chat id from orphan reaping.
 */
const LEGACY_SYSTEM_CHAT_PROJECT_NAMES = new Set<string>([
  LEGACY_MUX_PRODUCT_NAME,
  XUM_PRODUCT_NAME,
]);
const LEGACY_SYSTEM_CHAT_TITLES = new Set<string>([
  `Chat with ${LEGACY_MUX_PRODUCT_NAME}`,
  `Chat with ${XUM_PRODUCT_NAME}`,
]);
const LEGACY_SYSTEM_CHAT_NAMES = new Set<string>([
  `chat-with-${LEGACY_MUX_PRODUCT_SLUG}`,
  `chat-with-${XUM_PRODUCT_SLUG}`,
]);
const LEGACY_SYSTEM_CHAT_AGENT_IDS = new Set<string>([LEGACY_MUX_PRODUCT_SLUG, XUM_PRODUCT_SLUG]);

function removeLegacyMuxChatEntries(projects: Map<string, ProjectConfig>): boolean {
  // Match by path shape (basename Mux or Xum under "system") rather than the
  // current root dir so stale entries from other roots (e.g. a ~/.xum entry
  // seen by a ~/.xum-dev build) are cleaned too.
  const isSystemMuxPath = (candidate: string): boolean =>
    LEGACY_SYSTEM_CHAT_PROJECT_NAMES.has(path.basename(candidate)) &&
    path.basename(path.dirname(candidate)) === "system";

  let modified = false;
  for (const [projectPath, projectConfig] of projects) {
    const projectIsSystemMux = isSystemMuxPath(projectPath);

    const remaining = projectConfig.workspaces.filter((workspace) => {
      if (workspace.id !== "mux-chat") {
        return true;
      }
      // The subproject merge below may have already relocated the entry into
      // an ancestor project (e.g. ~/.xum registered as a project) on an
      // earlier load, stamping subProjectPath with the original system/Mux
      // (or later system/Xum) path. Match the entry in either location.
      // typeof guard: config JSON is unvalidated at runtime, and a corrupted
      // non-string subProjectPath would make path.basename throw, collapsing
      // the whole config load to empty defaults.
      const legacyProjectPath = projectIsSystemMux
        ? projectPath
        : typeof workspace.subProjectPath === "string" && isSystemMuxPath(workspace.subProjectPath)
          ? workspace.subProjectPath
          : null;
      if (legacyProjectPath === null) {
        return true;
      }
      // Keep unrelated workspaces whose generated id happens to be "mux-chat";
      // only entries carrying the built-in workspace's markers are legacy.
      const looksLikeLegacyMuxChat =
        (workspace.agentId != null && LEGACY_SYSTEM_CHAT_AGENT_IDS.has(workspace.agentId)) ||
        workspace.path === legacyProjectPath ||
        (workspace.name != null && LEGACY_SYSTEM_CHAT_NAMES.has(workspace.name)) ||
        (workspace.title != null && LEGACY_SYSTEM_CHAT_TITLES.has(workspace.title));
      return !looksLikeLegacyMuxChat;
    });

    const removedEntries = remaining.length !== projectConfig.workspaces.length;
    if (removedEntries) {
      projectConfig.workspaces = remaining;
      modified = true;
    }

    // Delete the system Mux/Xum project once empty. The already-empty +
    // projectKind check covers the shell left behind when the subproject
    // merge relocated its only workspace into a parent project.
    if (
      projectIsSystemMux &&
      remaining.length === 0 &&
      (removedEntries || projectConfig.projectKind === "system")
    ) {
      projects.delete(projectPath);
      modified = true;
    }
  }
  return modified;
}

interface ConfigLoadFailureState {
  /** Signature (content + error + backup detail) of the last logged load failure, for log dedupe. */
  failureSignature: string | null;
  /**
   * Content hash of corrupt config bytes whose sidecar backup was verified on disk during
   * the most recent failed load (re-checked every failed load, never trusted across loads).
   */
  backupSignature: string | null;
}

// Process-scoped, keyed by config file path: production creates short-lived Config
// instances (e.g. runtimeFactory per runtime check), so instance-local dedupe would
// re-log the same corrupt-config error once per instance.
const configLoadFailureStates = new Map<string, ConfigLoadFailureState>();

function configLoadFailureState(configFile: string): ConfigLoadFailureState {
  let state = configLoadFailureStates.get(configFile);
  if (!state) {
    state = { failureSignature: null, backupSignature: null };
    configLoadFailureStates.set(configFile, state);
  }
  return state;
}

/**
 * Config - Centralized configuration management
 *
 * Encapsulates all config paths and operations, making them dependency-injectable
 * and testable. Pass a custom rootDir for tests to avoid polluting ~/.xum
 */
export class Config {
  readonly rootDir: string;
  readonly sessionsDir: string;
  readonly srcDir: string;
  private readonly configFile: string;
  private readonly providersFile: string;
  private readonly secretsFile: string;
  private readonly emitter = new EventEmitter();
  /**
   * Legacy variant grouping is hidden from the current runtime but retained here so unrelated
   * config writes remain downgrade-safe. Entries are keyed by stable child workspace ID.
   */
  private readonly legacyTaskVariantGroups = new Map<string, LegacyTaskVariantWorkspace>();
  private readonly legacyTaskVariantMetadataOnlyIds = new Set<string>();
  /** Serializes editConfig calls; see editConfig for why. */
  private editConfigQueue: Promise<void> = Promise.resolve();
  /** One-shot guard for the queued load-time migration persist; see loadConfigOrDefault. */
  private migrationPersist: Promise<void> | null = null;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? getXumHome();
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.srcDir = path.join(this.rootDir, "src");
    this.configFile = path.join(this.rootDir, "config.json");
    this.providersFile = path.join(this.rootDir, "providers.jsonc");
    this.secretsFile = path.join(this.rootDir, "secrets.json");
  }

  private rememberLegacyTaskVariantWorkspace(
    projectPath: string,
    value: unknown,
    source: "config" | "metadata" = "config"
  ): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return;
    }

    const record = value as Record<string, unknown>;
    const id = parseOptionalNonEmptyString(record.id);
    const bestOf = parseLegacyTaskVariantGroup(record.bestOf);
    if (!id || !bestOf) {
      return;
    }

    const taskStatus = record.taskStatus;
    const parsedTaskStatus =
      taskStatus === "queued" ||
      taskStatus === "starting" ||
      taskStatus === "running" ||
      taskStatus === "awaiting_report" ||
      taskStatus === "interrupted" ||
      taskStatus === "reported"
        ? taskStatus
        : undefined;

    if (source === "metadata") {
      this.legacyTaskVariantMetadataOnlyIds.add(id);
    } else {
      this.legacyTaskVariantMetadataOnlyIds.delete(id);
    }
    this.legacyTaskVariantGroups.set(id, {
      id,
      projectPath: stripTrailingSlashes(projectPath),
      parentWorkspaceId: parseOptionalNonEmptyString(record.parentWorkspaceId),
      agentId: parseOptionalNonEmptyString(record.agentId),
      agentType: parseOptionalNonEmptyString(record.agentType),
      title: parseOptionalNonEmptyString(record.title),
      createdAt: parseOptionalNonEmptyString(record.createdAt),
      taskStatus: parsedTaskStatus,
      bestOf,
    });
  }

  getLegacyTaskVariantGroup(workspaceId: string): LegacyTaskVariantGroup | undefined {
    const bestOf = this.legacyTaskVariantGroups.get(workspaceId)?.bestOf;
    return bestOf ? { ...bestOf } : undefined;
  }

  listLegacyTaskVariantWorkspaces(parentWorkspaceId: string): LegacyTaskVariantWorkspace[] {
    return Array.from(this.legacyTaskVariantGroups.values())
      .filter((workspace) => workspace.parentWorkspaceId === parentWorkspaceId)
      .map((workspace) => ({ ...workspace, bestOf: { ...workspace.bestOf } }));
  }

  onConfigChanged(callback: () => void): () => void {
    this.emitter.on("configChanged", callback);
    return () => {
      this.emitter.off("configChanged", callback);
    };
  }

  private notifyConfigChanged(): void {
    this.emitter.emit("configChanged");
  }

  /**
   * Derive routePriority from currently-configured gateway providers.
   * Returns a priority array when at least one gateway is configured,
   * undefined otherwise — letting callers fall back to their own defaults.
   */
  private seedRoutePriorityFromProviders(): string[] | undefined {
    const providersConfig = this.loadProvidersConfig() ?? {};
    const priority: string[] = [];

    for (const gw of GATEWAY_PROVIDERS) {
      if (isProviderAutoRouteEligible(gw, providersConfig[gw] ?? {})) {
        priority.push(gw);
      }
    }
    priority.push("direct");

    return priority.length > 1 ? priority : undefined;
  }

  private handleConfigLoadFailure(rawBytes: Buffer | undefined, error: unknown): void {
    const state = configLoadFailureState(this.configFile);
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Backup confirmation is keyed on content alone: the same corrupt bytes need only one
    // sidecar regardless of which error message they produced.
    const contentSignature =
      rawBytes !== undefined ? crypto.createHash("sha256").update(rawBytes).digest("hex") : null;

    // Re-verify preservation against the disk on every failed load rather than trusting a
    // cached confirmation: a sidecar deleted or truncated since the last load must re-block
    // the edit gate (and be re-created) or a defaults write would destroy the only copy.
    let backupStatus = "No backup was created because the file contents could not be read.";
    // The actionable part of backupStatus (verified sidecar path, or the failure error);
    // folded into the log-dedupe signature so any change in remediation logs again.
    let backupDetail = "<unreadable>";
    let backupConfirmed = false;
    if (rawBytes !== undefined) {
      try {
        const configDir = path.dirname(this.configFile);
        const corruptPrefix = `${path.basename(this.configFile)}.corrupt-`;
        // Reuse a byte-identical sidecar only if it can also be secured: one from an older
        // build may be world-readable, so tighten it to 0600 before trusting it as the
        // backup. Skip candidates that are unreadable or untightenable (e.g. owned by
        // another user) and keep scanning; a later usable duplicate must still be found
        // even when creating a fresh sidecar would fail (read-only dir, full disk).
        let reusedPath: string | null = null;
        for (const entry of fs.readdirSync(configDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.startsWith(corruptPrefix)) {
            continue;
          }
          const candidatePath = path.join(configDir, entry.name);
          try {
            if (fs.readFileSync(candidatePath).equals(rawBytes)) {
              fs.chmodSync(candidatePath, 0o600);
              reusedPath = candidatePath;
              break;
            }
          } catch {
            // Unusable candidate; keep scanning.
          }
        }
        if (reusedPath) {
          backupStatus = `Backup skipped because identical bytes already exist at ${reusedPath}.`;
          backupDetail = reusedPath;
        } else {
          // Write the bytes that actually failed parsing (not a re-read of the file, which
          // another process may have replaced), leaving the corrupt source in place so
          // throwOnError cleanup guards continue to reject it. "wx" creates exclusively;
          // on a same-millisecond collision retry with a suffix instead of overwriting an
          // earlier snapshot. Mode 0600 because config.json can hold credentials (e.g.
          // muxGovernorToken) that the source file's permissions may protect.
          const basePath = `${this.configFile}.corrupt-${Date.now()}`;
          let backupPath = basePath;
          for (let suffix = 1; ; suffix++) {
            try {
              fs.writeFileSync(backupPath, rawBytes, { flag: "wx", mode: 0o600 });
              break;
            } catch (writeError) {
              if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
                throw writeError;
              }
              backupPath = `${basePath}-${suffix}`;
            }
          }
          // The creation mode is reduced by the process umask (a 0777 umask yields an
          // owner-unreadable file); chmod is not, so pin the final mode explicitly.
          fs.chmodSync(backupPath, 0o600);
          backupStatus = `The original bytes were backed up to ${backupPath}.`;
          backupDetail = backupPath;
        }
        backupConfirmed = true;
      } catch (backupError) {
        const backupErrorMessage =
          backupError instanceof Error ? backupError.message : String(backupError);
        backupStatus = `Backup failed (${backupErrorMessage}); it will be retried on the next load, and settings changes will not overwrite config.json until a backup succeeds.`;
        // Node fs errors embed the attempted (timestamped) sidecar path in the message, so
        // dedupe on the stable errno code where present or repeated ENOSPC/EACCES failures
        // would log on every load.
        const backupErrorCode = (backupError as NodeJS.ErrnoException).code;
        backupDetail = `failed: ${backupErrorCode ?? backupErrorMessage}`;
      }
    }
    // Until a sidecar is confirmed for these exact bytes, enqueueConfigEdit refuses to
    // overwrite the corrupt source.
    state.backupSignature = backupConfirmed ? contentSignature : null;

    // Dedupe on content + error + actionable backup detail: repeated loads of the same
    // state stay silent, while any change in remediation (backup gained or lost, sidecar
    // verified at a different path, a different backup error) replaces stale guidance.
    const logSignature = crypto
      .createHash("sha256")
      .update(rawBytes ?? "<config unreadable>")
      .update("\0")
      .update(errorMessage)
      .update("\0")
      .update(backupDetail)
      .digest("hex");
    if (logSignature === state.failureSignature) {
      return;
    }
    state.failureSignature = logSignature;

    const guidance =
      rawBytes === undefined
        ? `Check that ${this.configFile} is a regular file readable by this user.`
        : `Fix the reported problem in ${this.configFile} or restore it from the backup.`;
    log.error(
      `Failed to load config file ${this.configFile}: ${errorMessage}. ${backupStatus} ${guidance} Xum will continue with default settings and may rewrite config.json with defaults at any time, including at startup, so use the backup to recover your original settings.`
    );
  }

  loadConfigOrDefault(options?: { throwOnError?: boolean }): ProjectsConfig {
    // Read as a Buffer and hand the same snapshot to the failure handler: backing up via a
    // second read could preserve a concurrent writer's replacement instead of the bytes that
    // actually failed parsing.
    let rawBytes: Buffer | undefined;
    try {
      if (fs.existsSync(this.configFile)) {
        rawBytes = fs.readFileSync(this.configFile);
        const parsedValue: unknown = JSON.parse(rawBytes.toString("utf-8"));
        if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
          throw new Error("Config root must be a JSON object");
        }
        const parsed = parsedValue as Partial<AppConfigOnDisk> & Record<string, unknown>;
        let configModified = false;
        let shouldInvalidateSessionUsageCaches = false;

        const normalizeNestedModelStrings = (value: unknown): boolean => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
          }

          let modified = false;
          for (const entry of Object.values(value as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              continue;
            }

            const modelString = (entry as { modelString?: unknown }).modelString;
            if (typeof modelString !== "string") {
              continue;
            }

            const normalized = normalizeSelectedModel(modelString.trim());
            if (normalized !== modelString) {
              (entry as { modelString?: string }).modelString = normalized;
              modified = true;
            }
          }

          return modified;
        };

        const normalizeLegacyGatewayModel = (value: string): string | undefined => {
          const trimmed = value.trim();
          if (!trimmed) {
            return undefined;
          }

          const legacyModelString = trimmed.includes(":") ? trimmed : trimmed.replace("/", ":");
          const canonicalModel = normalizeToCanonical(legacyModelString);
          return isValidModelFormat(canonicalModel) ? canonicalModel : undefined;
        };

        // Migrate legacy gateway settings to the new route-based system.
        // Legacy keys are intentionally preserved on disk for downgrade compatibility —
        // older versions still read muxGatewayEnabled / muxGatewayModels directly.
        if (
          (parsed.muxGatewayModels != null || parsed.muxGatewayEnabled != null) &&
          !Array.isArray(parsed.routePriority)
        ) {
          let nextPriority = this.seedRoutePriorityFromProviders() ?? ["direct"];
          if (parsed.muxGatewayEnabled === false) {
            nextPriority = nextPriority.filter((route) => route !== "mux-gateway");
            if (nextPriority.length === 0) {
              nextPriority = ["direct"];
            }
          }
          parsed.routePriority = nextPriority;
          configModified = true;

          if (parsed.muxGatewayEnabled !== false) {
            const legacyModels = parseOptionalStringArray(parsed.muxGatewayModels) ?? [];
            if (legacyModels.length > 0) {
              const mergedRouteOverrides =
                normalizeRouteOverridesRecord(parsed.routeOverrides) ?? {};
              let routeOverridesModified = false;

              for (const legacyModel of legacyModels) {
                const canonicalModel = normalizeLegacyGatewayModel(legacyModel);
                if (!canonicalModel || Object.hasOwn(mergedRouteOverrides, canonicalModel)) {
                  continue;
                }

                mergedRouteOverrides[canonicalModel] = "mux-gateway";
                routeOverridesModified = true;
              }

              if (routeOverridesModified) {
                parsed.routeOverrides = mergedRouteOverrides;
                shouldInvalidateSessionUsageCaches = true;
              }
            }
          }
        }

        // Seed routePriority only when the field does not exist yet.
        // Once routePriority is an array, it becomes user-owned state, so
        // read-time backfill is intentionally skipped here. Credential-driven
        // gateway additions/removals are handled at write time by
        // providerService.syncGatewayLifecycle().
        if (!Array.isArray(parsed.routePriority)) {
          const seeded = this.seedRoutePriorityFromProviders();
          if (seeded) {
            parsed.routePriority = seeded;
            configModified = true;
          }
        }

        if (
          Array.isArray(parsed.routePriority) &&
          parsed.routePriority.includes("mux-gateway") &&
          parsed.muxGatewayEnabled === false
        ) {
          // Once routePriority exists, it is the authoritative routing signal. Clear a stale
          // legacy disable flag so downgrade-compat data cannot veto an explicitly enabled gateway.
          delete parsed.muxGatewayEnabled;
          configModified = true;
        }

        // Normalize persisted model preferences while preserving explicit gateway selections.
        if (typeof parsed.defaultModel === "string") {
          const normalized = normalizeSelectedModel(parsed.defaultModel.trim());
          if (normalized !== parsed.defaultModel) {
            parsed.defaultModel = normalized;
            configModified = true;
            shouldInvalidateSessionUsageCaches = true;
          }
        }

        if (Array.isArray(parsed.hiddenModels)) {
          const sourceHiddenModels = parsed.hiddenModels.filter(
            (model): model is string => typeof model === "string"
          );
          const normalizedHiddenModels = sourceHiddenModels.map((model) =>
            normalizeSelectedModel(model.trim())
          );

          if (
            sourceHiddenModels.length !== parsed.hiddenModels.length ||
            !areStringArraysEqual(sourceHiddenModels, normalizedHiddenModels)
          ) {
            parsed.hiddenModels = normalizedHiddenModels;
            configModified = true;
            shouldInvalidateSessionUsageCaches = true;
          }
        }

        if (normalizeNestedModelStrings(parsed.agentAiDefaults)) {
          configModified = true;
          shouldInvalidateSessionUsageCaches = true;
        }
        if (normalizeNestedModelStrings(parsed.subagentAiDefaults)) {
          configModified = true;
          shouldInvalidateSessionUsageCaches = true;
        }

        // Config is stored as array of [path, config] pairs.
        // Older/newer files may omit `projects`; treat missing/invalid values as an empty map
        // so top-level settings (provider/runtime/server preferences) still load.
        const rawPairs = Array.isArray(parsed.projects) ? parsed.projects : [];
        // Migrate: normalize project paths by stripping trailing slashes
        // This fixes configs created with paths like "/home/user/project/"
        // Also filter out any malformed entries (null/undefined paths)
        // Rebuild config-backed entries from the current on-disk snapshot. Metadata-only entries
        // survive until the legacy metadata migration writes them into config.json below.
        for (const workspaceId of this.legacyTaskVariantGroups.keys()) {
          if (!this.legacyTaskVariantMetadataOnlyIds.has(workspaceId)) {
            this.legacyTaskVariantGroups.delete(workspaceId);
          }
        }
        const normalizedPairs = rawPairs
          .filter(([projectPath]) => {
            if (!projectPath || typeof projectPath !== "string") {
              log.warn("Filtering out project with invalid path", { projectPath });
              return false;
            }
            return true;
          })
          .map(([projectPath, projectConfig]) => {
            if (Array.isArray(projectConfig?.workspaces)) {
              for (const workspace of projectConfig.workspaces) {
                this.rememberLegacyTaskVariantWorkspace(projectPath, workspace);
              }
            }
            const normalizedProjectConfig = normalizeProjectRuntimeSettings(projectConfig);
            return [stripTrailingSlashes(projectPath), normalizedProjectConfig] as [
              string,
              ProjectConfig,
            ];
          });
        const projectsMap = deriveProjectHierarchy(new Map<string, ProjectConfig>(normalizedPairs));

        // Run before the subproject merge below so a hierarchy edge case
        // cannot relocate a legacy workspace into a parent project first.
        if (removeLegacyMuxChatEntries(projectsMap)) {
          configModified = true;
        }

        for (const [projectPath, projectConfig] of projectsMap) {
          const parentProjectPath = projectConfig.parentProjectPath;
          if (!parentProjectPath || projectConfig.workspaces.length === 0) {
            continue;
          }
          const parentProject = projectsMap.get(parentProjectPath);
          if (!parentProject) {
            continue;
          }
          parentProject.workspaces.push(
            ...projectConfig.workspaces.map((workspace) => ({
              ...workspace,
              subProjectPath: workspace.subProjectPath ?? projectPath,
            }))
          );
          projectConfig.workspaces = [];
          configModified = true;
        }

        // Persistent sub-agents must survive a downgrade too. On first load of this behavior,
        // rewrite the previous false/missing default before TaskService startup can create durable
        // children; older builds will then keep their reported histories. The migration marker
        // makes this a one-time default change rather than permanently overriding explicit config.
        const retentionMigrations = normalizeConfigMigrations(parsed.migrations);
        if (retentionMigrations.persistentSubagentsDefaulted !== true) {
          parsed.taskSettings = {
            ...(parsed.taskSettings ?? {}),
            preserveSubagentsUntilArchive: true,
          };
          parsed.migrations = {
            ...retentionMigrations,
            persistentSubagentsDefaulted: true,
          };
          configModified = true;
        }
        if (parsed.taskSettings?.preserveSubagentsUntilArchive !== true) {
          parsed.taskSettings = {
            ...(parsed.taskSettings ?? {}),
            preserveSubagentsUntilArchive: true,
          };
          configModified = true;
        }
        const taskSettings = normalizeTaskSettings(parsed.taskSettings);

        const muxGatewayEnabled = parseOptionalBoolean(parsed.muxGatewayEnabled);
        const muxGatewayModels = parseOptionalStringArray(parsed.muxGatewayModels);
        const routePriority = parseOptionalStringArray(parsed.routePriority);
        const routeOverrides = normalizeRouteOverridesRecord(parsed.routeOverrides);
        const minThinkingLevelByModel = normalizeMinThinkingLevelByModel(
          parsed.minThinkingLevelByModel
        );
        // One-time seed of the default refusal-fallback chains (e.g. Fable 5 →
        // Opus). Guarded by migrations.defaultModelFallbacksSeeded so the
        // seed is applied exactly once: users who later edit or delete the
        // default chains are not overridden on subsequent loads/updates.
        const migrationsBeforeSeed = normalizeConfigMigrations(parsed.migrations);
        if (migrationsBeforeSeed.defaultModelFallbacksSeeded !== true) {
          // Gap-check against the RAW on-disk map with canonicalized keys, not
          // the sanitized map: a hand-edited entry whose chain sanitizes away
          // (e.g. {enabled:false, models:[]}) is still user intent and must not
          // be overwritten. Merging into the raw map also keeps unrelated
          // chains byte-identical on disk (lenient-on-read preserved).
          const rawFallbacks =
            typeof parsed.modelFallbacks === "object" &&
            parsed.modelFallbacks !== null &&
            !Array.isArray(parsed.modelFallbacks)
              ? (parsed.modelFallbacks as Record<string, unknown>)
              : {};
          const existingCanonicalKeys = new Set(
            Object.keys(rawFallbacks).map((key) => normalizeToCanonical(key).trim())
          );
          const missingDefaults = Object.fromEntries(
            Object.entries(DEFAULT_MODEL_FALLBACKS).filter(
              ([sourceModel]) => !existingCanonicalKeys.has(sourceModel)
            )
          );
          if (Object.keys(missingDefaults).length > 0) {
            // Write through the raw-record view: user entries are deliberately
            // kept unvalidated on disk (normalizeModelFallbacks sanitizes on
            // every read), so the merged map is not a ModelFallbacks yet.
            const rawParsed: Record<string, unknown> = parsed;
            rawParsed.modelFallbacks = { ...rawFallbacks, ...missingDefaults };
          }
          parsed.migrations = {
            ...migrationsBeforeSeed,
            defaultModelFallbacksSeeded: true,
          };
          configModified = true;
        }

        const modelFallbacks = normalizeModelFallbacks(parsed.modelFallbacks);

        const defaultModel = normalizeOptionalModelString(parsed.defaultModel);
        const advisorModelString = parseOptionalNonEmptyString(parsed.advisorModelString);
        const advisorThinkingLevel = parseOptionalThinkingLevel(parsed.advisorThinkingLevel);
        const advisorMaxUsesPerTurn =
          parsed.advisorMaxUsesPerTurn === null
            ? null
            : parseOptionalPositiveInteger(parsed.advisorMaxUsesPerTurn);
        const advisorMaxOutputTokens =
          parsed.advisorMaxOutputTokens === null
            ? null
            : parseOptionalPositiveInteger(parsed.advisorMaxOutputTokens);
        const hiddenModels = normalizeOptionalModelStringArray(parsed.hiddenModels);
        // Legacy root subagentAiDefaults (written by older builds and by the
        // save-time downgrade projection) folds into the canonical nested
        // `subagent` profile here; nothing outside this load and the save
        // projection may read or write the legacy root map.
        const agentAiDefaults = mergeLegacySubagentAiDefaults(
          normalizeAgentAiDefaults(parsed.agentAiDefaults),
          parsed.subagentAiDefaults
        );

        if (shouldInvalidateSessionUsageCaches) {
          // Invalidate stale usage caches only when model id formats changed.
          try {
            if (fs.existsSync(this.sessionsDir)) {
              for (const sessionEntry of fs.readdirSync(this.sessionsDir, {
                withFileTypes: true,
              })) {
                if (!sessionEntry.isDirectory()) {
                  continue;
                }

                const usagePath = path.join(
                  this.getSessionDir(sessionEntry.name),
                  "session-usage.json"
                );
                if (fs.existsSync(usagePath)) {
                  fs.rmSync(usagePath, { force: true });
                }
              }
            }
          } catch (error) {
            // Best-effort cleanup; never fail startup on cache invalidation issues.
            log.warn("Failed to invalidate session usage cache during config migration", { error });
          }
        }

        if (configModified && this.migrationPersist == null) {
          // Persist load-time migrations through the serialized editConfig queue instead of
          // writing `parsed` synchronously here: a sync write bypasses the queue, so a
          // concurrent editConfig write landing between this load's read and the write-back
          // would be clobbered with stale data (same lost-update class that resurrected
          // removed workspaces via the old public saveConfig). Migrations are idempotent and
          // re-applied on every load, so the identity transform re-reads disk, re-runs them,
          // and persists the migrated form under the queue. One-shot guard: while a persist
          // is in flight, the loads it performs internally must not re-schedule.
          this.migrationPersist = this.enqueueConfigEdit((migratedConfig) => migratedConfig)
            .catch((error: unknown) => {
              // Keep startup resilient even if persisting migration fails.
              log.warn("Failed to persist migrated config", { error });
            })
            .finally(() => {
              this.migrationPersist = null;
            });
        }

        const coderWorkspaceArchiveBehavior = resolveCoderWorkspaceArchiveBehavior(
          parsed.coderWorkspaceArchiveBehavior,
          parsed.stopCoderWorkspaceOnArchive
        );
        const worktreeArchiveBehavior = resolveWorktreeArchiveBehavior(
          parsed.worktreeArchiveBehavior,
          parsed.deleteWorktreeOnArchive
        );
        const deleteWorktreeOnArchive =
          getLegacyDeleteWorktreeOnArchiveValue(worktreeArchiveBehavior);
        const stopCoderWorkspaceOnArchive = getLegacyStopCoderWorkspaceOnArchiveValue(
          coderWorkspaceArchiveBehavior
        );
        const updateChannel = parseUpdateChannel(parsed.updateChannel);

        const runtimeEnablement = normalizeRuntimeEnablementOverrides(parsed.runtimeEnablement);
        const defaultRuntime = normalizeRuntimeEnablementId(parsed.defaultRuntime);

        const userPreferences = normalizeUserPreferences(parsed.userPreferences);
        const migrations = normalizeConfigMigrations(parsed.migrations);
        if (parsed.userPreferences !== undefined) {
          migrations.userPreferencesInitialized = true;
        }

        const layoutPresetsRaw = normalizeLayoutPresetsConfig(parsed.layoutPresets);
        const layoutPresets = isLayoutPresetsConfigEmpty(layoutPresetsRaw)
          ? undefined
          : layoutPresetsRaw;

        // Also forget the confirmed backup: after a healthy load the user may prune sidecars,
        // so a later re-corruption must re-verify the backup on disk.
        configLoadFailureStates.delete(this.configFile);
        return {
          projects: projectsMap,
          apiServerBindHost: parseOptionalNonEmptyString(parsed.apiServerBindHost),
          apiServerServeWebUi: parseOptionalBoolean(parsed.apiServerServeWebUi) ? true : undefined,
          apiServerPort: parseOptionalPort(parsed.apiServerPort),
          mdnsAdvertisementEnabled: parseOptionalBoolean(parsed.mdnsAdvertisementEnabled),
          mdnsServiceName: parseOptionalNonEmptyString(parsed.mdnsServiceName),
          serverSshHost: parsed.serverSshHost,
          serverAuthGithubOwner: parseOptionalNonEmptyString(parsed.serverAuthGithubOwner),
          defaultProjectDir: parseOptionalNonEmptyString(parsed.defaultProjectDir),
          viewedSplashScreens: parsed.viewedSplashScreens,
          userPreferences,
          layoutPresets,
          taskSettings,
          chatTranscriptFullWidth: parseOptionalBoolean(parsed.chatTranscriptFullWidth),
          muxGatewayEnabled,
          llmDebugLogs: parseOptionalBoolean(parsed.llmDebugLogs),
          heartbeatDefaultPrompt: parseOptionalNonEmptyString(parsed.heartbeatDefaultPrompt),
          heartbeatDefaultIntervalMs: parseOptionalHeartbeatIntervalMs(
            parsed.heartbeatDefaultIntervalMs
          ),
          goalDefaults: normalizeGoalDefaults(parsed.goalDefaults),
          muxGatewayModels,
          routePriority,
          routeOverrides,
          minThinkingLevelByModel,
          modelFallbacks,
          defaultModel,
          advisorModelString,
          advisorThinkingLevel,
          advisorMaxUsesPerTurn,
          advisorMaxOutputTokens,
          hiddenModels,
          agentAiDefaults,
          migrations,
          useSSH2Transport: parseOptionalBoolean(parsed.useSSH2Transport),
          muxGovernorUrl: parseOptionalNonEmptyString(parsed.muxGovernorUrl),
          muxGovernorToken: parseOptionalNonEmptyString(parsed.muxGovernorToken),
          coderWorkspaceArchiveBehavior,
          worktreeArchiveBehavior,
          deleteWorktreeOnArchive,
          stopCoderWorkspaceOnArchive,
          terminalDefaultShell: parseOptionalNonEmptyString(parsed.terminalDefaultShell),
          updateChannel,
          defaultRuntime,
          runtimeEnablement,
          // Validated here rather than trusted: a hand-edited or older-build value that fails the
          // schema would otherwise reach the IPC output validator and fail the whole settings
          // read, so one bad field would report a load failure for every setting on the screen.
          settingsBackup: SettingsBackupSchema.optional()
            .catch(undefined)
            .parse(parsed.settingsBackup),
          legacyOnePasswordAccountName: parseOptionalNonEmptyString(parsed.onePasswordAccountName),
        };
      } else {
        configLoadFailureStates.delete(this.configFile);
      }
    } catch (error) {
      this.handleConfigLoadFailure(rawBytes, error);
      if (options?.throwOnError) {
        throw error;
      }
    }

    // Return default config
    return {
      projects: new Map(),
      taskSettings: DEFAULT_TASK_SETTINGS,
      agentAiDefaults: {},
      routePriority: this.seedRoutePriorityFromProviders(),
      coderWorkspaceArchiveBehavior: DEFAULT_CODER_ARCHIVE_BEHAVIOR,
      worktreeArchiveBehavior: DEFAULT_WORKTREE_ARCHIVE_BEHAVIOR,
      deleteWorktreeOnArchive: false,
      // Fresh installs get the default refusal-fallback chains immediately; the
      // migration flag rides along so the first save locks in seed-once
      // semantics (later loads never re-apply the defaults).
      modelFallbacks: { ...DEFAULT_MODEL_FALLBACKS },
      migrations: {
        defaultModelFallbacksSeeded: true,
        persistentSubagentsDefaulted: true,
      },
    };
  }

  /**
   * Write the full config snapshot to disk (atomic write, log-and-swallow errors).
   *
   * PRIVATE on purpose: this is editConfig's write primitive only. Direct external
   * callers used to write stale full snapshots outside the editConfig queue, which
   * caused lost-update races — e.g. a snapshot read before a concurrent
   * removeWorkspace() and written after it resurrected the removed workspace entry
   * as a permanent sidebar ghost. All mutations must go through editConfig so each
   * write is derived from a fresh serialized read.
   */
  private async saveConfig(config: ProjectsConfig): Promise<void> {
    try {
      if (!fs.existsSync(this.rootDir)) {
        ensurePrivateDirSync(this.rootDir);
      }

      const data: Partial<Record<keyof AppConfigOnDisk, unknown>> & {
        projects: Array<[string, ProjectConfig]>;
      } = {
        projects: Array.from(config.projects.entries()).map(([projectPath, projectConfig]) => {
          const normalizedProjectConfig = normalizeProjectRuntimeSettings(projectConfig);
          const persistedProjectConfig = {
            ...normalizedProjectConfig,
            workspaces: normalizedProjectConfig.workspaces.map((workspace) => ({ ...workspace })),
          };
          for (const workspace of persistedProjectConfig.workspaces) {
            const workspaceId = parseOptionalNonEmptyString(workspace.id);
            const legacy = workspaceId ? this.legacyTaskVariantGroups.get(workspaceId) : undefined;
            if (legacy && workspace.bestOf == null) {
              // Keep downgrade-only metadata on disk without exposing it to current runtime types,
              // UI grouping, or provider-facing task schemas.
              // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
              (workspace as unknown as Record<string, unknown>).bestOf = { ...legacy.bestOf };
            }
          }
          return [projectPath, persistedProjectConfig] as [string, ProjectConfig];
        }),
        taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
      };

      const muxGatewayEnabled = parseOptionalBoolean(config.muxGatewayEnabled);
      if (muxGatewayEnabled !== undefined) {
        data.muxGatewayEnabled = muxGatewayEnabled;
      }

      const chatTranscriptFullWidth = parseOptionalBoolean(config.chatTranscriptFullWidth);
      if (chatTranscriptFullWidth === true) {
        data.chatTranscriptFullWidth = true;
      }

      const llmDebugLogs = parseOptionalBoolean(config.llmDebugLogs);
      if (llmDebugLogs !== undefined) {
        data.llmDebugLogs = llmDebugLogs;
      }

      const heartbeatDefaultPrompt = parseOptionalNonEmptyString(config.heartbeatDefaultPrompt);
      if (heartbeatDefaultPrompt) {
        data.heartbeatDefaultPrompt = heartbeatDefaultPrompt;
      }

      const heartbeatDefaultIntervalMs = parseOptionalHeartbeatIntervalMs(
        config.heartbeatDefaultIntervalMs
      );
      if (heartbeatDefaultIntervalMs !== undefined) {
        data.heartbeatDefaultIntervalMs = heartbeatDefaultIntervalMs;
      }

      if (config.goalDefaults) {
        data.goalDefaults = normalizeGoalDefaults(config.goalDefaults);
      }

      const muxGatewayModels = parseOptionalStringArray(config.muxGatewayModels);
      if (muxGatewayModels !== undefined) {
        data.muxGatewayModels = muxGatewayModels;
      }

      const defaultModel = normalizeOptionalModelString(config.defaultModel);
      if (defaultModel !== undefined) {
        data.defaultModel = defaultModel;
      }

      const advisorModelString = parseOptionalNonEmptyString(config.advisorModelString);
      if (advisorModelString !== undefined) {
        data.advisorModelString = advisorModelString;
      }

      const advisorThinkingLevel = parseOptionalThinkingLevel(config.advisorThinkingLevel);
      if (advisorThinkingLevel !== undefined) {
        data.advisorThinkingLevel = advisorThinkingLevel;
      }

      if (config.advisorMaxUsesPerTurn === null) {
        data.advisorMaxUsesPerTurn = null;
      } else {
        const advisorMaxUsesPerTurn = parseOptionalPositiveInteger(config.advisorMaxUsesPerTurn);
        if (advisorMaxUsesPerTurn !== undefined) {
          data.advisorMaxUsesPerTurn = advisorMaxUsesPerTurn;
        }
      }

      if (config.advisorMaxOutputTokens === null) {
        data.advisorMaxOutputTokens = null;
      } else {
        const advisorMaxOutputTokens = parseOptionalPositiveInteger(config.advisorMaxOutputTokens);
        if (advisorMaxOutputTokens !== undefined) {
          data.advisorMaxOutputTokens = advisorMaxOutputTokens;
        }
      }

      const hiddenModels = normalizeOptionalModelStringArray(config.hiddenModels);
      if (hiddenModels !== undefined) {
        data.hiddenModels = hiddenModels;
      }

      const routePriority = parseOptionalStringArray(config.routePriority);
      if (routePriority !== undefined) {
        data.routePriority = routePriority;
      }

      const routeOverrides = normalizeRouteOverridesRecord(config.routeOverrides);
      if (routeOverrides !== undefined) {
        data.routeOverrides = routeOverrides;
      }

      const minThinkingLevelByModel = normalizeMinThinkingLevelByModel(
        config.minThinkingLevelByModel
      );
      if (minThinkingLevelByModel !== undefined) {
        data.minThinkingLevelByModel = minThinkingLevelByModel;
      }

      const modelFallbacks = normalizeModelFallbacks(config.modelFallbacks);
      if (modelFallbacks !== undefined) {
        data.modelFallbacks = modelFallbacks;
      }

      const apiServerBindHost = parseOptionalNonEmptyString(config.apiServerBindHost);
      if (apiServerBindHost) {
        data.apiServerBindHost = apiServerBindHost;
      }

      const apiServerServeWebUi = parseOptionalBoolean(config.apiServerServeWebUi);
      if (apiServerServeWebUi) {
        data.apiServerServeWebUi = true;
      }

      const apiServerPort = parseOptionalPort(config.apiServerPort);
      if (apiServerPort !== undefined) {
        data.apiServerPort = apiServerPort;
      }

      const mdnsAdvertisementEnabled = parseOptionalBoolean(config.mdnsAdvertisementEnabled);
      if (mdnsAdvertisementEnabled !== undefined) {
        data.mdnsAdvertisementEnabled = mdnsAdvertisementEnabled;
      }

      const mdnsServiceName = parseOptionalNonEmptyString(config.mdnsServiceName);
      if (mdnsServiceName) {
        data.mdnsServiceName = mdnsServiceName;
      }

      if (config.serverSshHost) {
        data.serverSshHost = config.serverSshHost;
      }
      const serverAuthGithubOwner = parseOptionalNonEmptyString(config.serverAuthGithubOwner);
      if (serverAuthGithubOwner) {
        data.serverAuthGithubOwner = serverAuthGithubOwner;
      }
      const defaultProjectDir = parseOptionalNonEmptyString(config.defaultProjectDir);
      if (defaultProjectDir) {
        data.defaultProjectDir = defaultProjectDir;
      }
      const userPreferences = normalizeUserPreferences(config.userPreferences);
      if (userPreferences) {
        data.userPreferences = userPreferences;
      }

      if (config.layoutPresets) {
        const normalized = normalizeLayoutPresetsConfig(config.layoutPresets);
        if (!isLayoutPresetsConfigEmpty(normalized)) {
          data.layoutPresets = normalized;
        }
      }
      if (config.viewedSplashScreens) {
        data.viewedSplashScreens = config.viewedSplashScreens;
      }
      if (config.agentAiDefaults && Object.keys(config.agentAiDefaults).length > 0) {
        const normalizedAgentAiDefaults = normalizeAiDefaultsModelStrings(config.agentAiDefaults);
        data.agentAiDefaults = normalizedAgentAiDefaults;

        // Downgrade-compatibility projection only: older builds resolve
        // delegated runs from the legacy root map. Never read back at runtime;
        // load folds it into the nested `subagent` profile.
        const legacySubagent = deriveLegacySubagentAiDefaultsProjection(normalizedAgentAiDefaults);
        if (Object.keys(legacySubagent).length > 0) {
          data.subagentAiDefaults = legacySubagent;
        }
      }

      const migrations = normalizeConfigMigrations(config.migrations);
      // Any true flag (known or from a newer version) must persist; the spread
      // below writes them all, so gate only on presence.
      if (
        Object.keys(migrations).length > 0 ||
        config.userPreferences !== undefined ||
        config.agentAiDefaults?.exec != null
      ) {
        data.migrations = {
          ...migrations,
          ...(config.userPreferences !== undefined ? { userPreferencesInitialized: true } : {}),
          // Written for downgrade compatibility so older builds do not re-run
          // their exec split migration against the projected legacy map.
          ...(config.agentAiDefaults?.exec != null ? { execSubagentDefaultsSplit: true } : {}),
        };
      }

      if (config.useSSH2Transport !== undefined) {
        data.useSSH2Transport = config.useSSH2Transport;
      }

      const muxGovernorUrl = parseOptionalNonEmptyString(config.muxGovernorUrl);
      if (muxGovernorUrl) {
        data.muxGovernorUrl = muxGovernorUrl;
      }

      const muxGovernorToken = parseOptionalNonEmptyString(config.muxGovernorToken);
      if (muxGovernorToken) {
        data.muxGovernorToken = muxGovernorToken;
      }

      const coderWorkspaceArchiveBehavior = resolveCoderWorkspaceArchiveBehaviorForSave(config);
      data.coderWorkspaceArchiveBehavior = coderWorkspaceArchiveBehavior;

      const worktreeArchiveBehavior = resolveWorktreeArchiveBehaviorForSave(config);
      data.worktreeArchiveBehavior = worktreeArchiveBehavior;

      const stopCoderWorkspaceOnArchive = getLegacyStopCoderWorkspaceOnArchiveValue(
        coderWorkspaceArchiveBehavior
      );
      if (stopCoderWorkspaceOnArchive !== undefined) {
        data.stopCoderWorkspaceOnArchive = stopCoderWorkspaceOnArchive;
      }

      data.deleteWorktreeOnArchive = getLegacyDeleteWorktreeOnArchiveValue(worktreeArchiveBehavior);

      const terminalDefaultShell = parseOptionalNonEmptyString(config.terminalDefaultShell);
      if (terminalDefaultShell) {
        data.terminalDefaultShell = terminalDefaultShell;
      }

      const updateChannel = parseUpdateChannel(config.updateChannel);
      if (updateChannel) {
        data.updateChannel = updateChannel;
      }

      const runtimeEnablement = normalizeRuntimeEnablementOverrides(config.runtimeEnablement);
      if (runtimeEnablement) {
        data.runtimeEnablement = runtimeEnablement;
      }

      const defaultRuntime = normalizeRuntimeEnablementId(config.defaultRuntime);
      if (defaultRuntime !== undefined) {
        data.defaultRuntime = defaultRuntime;
      }

      if (config.settingsBackup) {
        data.settingsBackup = config.settingsBackup;
      }

      // Round-trip the legacy 1Password account name so unrelated saves don't
      // delete it from config.json; downgrades depend on it to reinitialize.
      const legacyOnePasswordAccountName = parseOptionalNonEmptyString(
        config.legacyOnePasswordAccountName
      );
      if (legacyOnePasswordAccountName) {
        data.onePasswordAccountName = legacyOnePasswordAccountName;
      }

      const persistedWorkspaceIds = new Set<string>();
      for (const [, project] of data.projects) {
        for (const workspace of project.workspaces) {
          const workspaceId = parseOptionalNonEmptyString(workspace.id);
          if (workspaceId) {
            persistedWorkspaceIds.add(workspaceId);
          }
        }
      }
      await writeFileAtomic(this.configFile, JSON.stringify(data, null, 2), "utf-8");
      for (const workspaceId of this.legacyTaskVariantGroups.keys()) {
        if (!persistedWorkspaceIds.has(workspaceId)) {
          // A load-time settings migration can save before getAllWorkspaceMetadata's queued
          // identity migration adds this legacy workspace ID. Keep metadata-only entries alive
          // until a later save can attach them to the migrated config record.
          if (!this.legacyTaskVariantMetadataOnlyIds.has(workspaceId)) {
            this.legacyTaskVariantGroups.delete(workspaceId);
          }
        } else {
          this.legacyTaskVariantMetadataOnlyIds.delete(workspaceId);
        }
      }
    } catch (error) {
      log.error("Error saving config:", error);
    }
  }

  /**
   * Edit config atomically using a transformation function
   * @param fn Function that takes current config and returns modified config
   *
   * Edits are serialized on an internal queue: each edit's read happens only
   * after the previous edit's write has landed. Without this, concurrent edits
   * (e.g. parallel task launches updating taskStatus) read the same snapshot
   * and the later write silently clobbers the earlier one.
   */
  async editConfig(fn: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    return this.enqueueConfigEdit(fn);
  }

  /**
   * Internal queue primitive shared by editConfig and the load-time migration persist.
   * The migration persist must not call the public editConfig: that method is commonly
   * spied/overridden in tests, and the internally scheduled write is an implementation
   * detail rather than a caller-initiated mutation.
   */
  private enqueueConfigEdit(fn: (config: ProjectsConfig) => ProjectsConfig): Promise<void> {
    const run = this.editConfigQueue.then(async () => {
      const config = this.loadConfigOrDefault();
      const newConfig = fn(config);
      // If that load failed, writing would replace the corrupt file with defaults. Only
      // proceed when the bytes on disk right now are the ones with a confirmed sidecar:
      // no confirmed backup, a concurrent replacement since the load, or an unreadable
      // file all reject the edit so callers do not treat the mutation as durable (unlike
      // saveConfig's log-and-swallow of unexpected I/O errors, this skip is deliberate).
      // A missing file is safe to overwrite. This cannot fully close the cross-process
      // race (that needs file locking, which editConfig has never had); it binds the
      // approval to the current bytes and shrinks the window to the atomic write itself.
      const failureState = configLoadFailureStates.get(this.configFile);
      if (failureState) {
        const rejectEdit = (reason: string): never => {
          const message = `Skipping config write to ${this.configFile}: ${reason}`;
          log.error(message);
          throw new Error(message);
        };
        if (failureState.backupSignature === null) {
          rejectEdit(
            "the existing corrupt config has no confirmed backup yet. Fix the reported backup failure or move the corrupt file aside, then retry."
          );
        }
        let currentSignature: string | null = null;
        try {
          const currentBytes = fs.readFileSync(this.configFile);
          currentSignature = crypto.createHash("sha256").update(currentBytes).digest("hex");
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
            rejectEdit(
              `the file could not be re-read before writing (${readError instanceof Error ? readError.message : String(readError)}). Retry the settings change.`
            );
          }
        }
        if (currentSignature !== null && currentSignature !== failureState.backupSignature) {
          rejectEdit(
            "the file changed after this edit loaded it and the new content has no confirmed backup. Retry the settings change."
          );
        }
      }
      await this.saveConfig(newConfig);
      // Backend-initiated config edits (for example gateway auth changes) use this signal
      // so frontend subscribers can refresh derived state without polling.
      this.notifyConfigChanged();
    });
    // Keep the queue alive when an edit fails; the failure still propagates to this caller.
    this.editConfigQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  getUpdateChannel(): UpdateChannel {
    const config = this.loadConfigOrDefault();
    return config.updateChannel === "nightly" ? "nightly" : "stable";
  }

  getLlmDebugLogsEnabled(): boolean {
    return this.loadConfigOrDefault().llmDebugLogs === true;
  }

  async setUpdateChannel(channel: UpdateChannel): Promise<void> {
    await this.editConfig((config) => {
      config.updateChannel = channel;
      return config;
    });
  }

  /**
   * mDNS advertisement enablement.
   *
   * - true: attempt to advertise (will warn if the API server is loopback-only)
   * - false: never advertise
   * - undefined: "auto" (advertise only when the API server is LAN-reachable)
   */
  getMdnsAdvertisementEnabled(): boolean | undefined {
    const envOverride = parseOptionalEnvBoolean(
      resolveXumEnvironmentValue("MDNS_ADVERTISE", process.env)
    );
    if (envOverride !== undefined) {
      return envOverride;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsAdvertisementEnabled;
  }

  /** Optional DNS-SD service instance name override. */
  getMdnsServiceName(): string | undefined {
    const envName = parseOptionalNonEmptyString(
      resolveXumEnvironmentValue("MDNS_SERVICE_NAME", process.env)
    );
    if (envName) {
      return envName;
    }

    const config = this.loadConfigOrDefault();
    return config.mdnsServiceName;
  }

  /**
   * Get the configured SSH hostname for this server (used for editor deep links in browser mode).
   */
  getServerSshHost(): string | undefined {
    const config = this.loadConfigOrDefault();
    return config.serverSshHost;
  }

  /**
   * Get the configured GitHub username allowed to authenticate server/browser mode.
   */
  getServerAuthGithubOwner(): string | undefined {
    const envOwner = parseOptionalNonEmptyString(
      resolveXumEnvironmentValue("SERVER_AUTH_GITHUB_OWNER", process.env)
    );
    if (envOwner) {
      return envOwner;
    }

    const config = this.loadConfigOrDefault();
    return config.serverAuthGithubOwner;
  }
  private getProjectName(projectPath: string): string {
    return PlatformPaths.getProjectName(projectPath);
  }

  /**
   * Generate a stable unique workspace ID.
   * Uses 10 random hex characters for readability while maintaining uniqueness.
   *
   * Example: "a1b2c3d4e5"
   */
  generateStableId(): string {
    // Generate 5 random bytes and convert to 10 hex chars
    return crypto.randomBytes(5).toString("hex");
  }

  /**
   * DEPRECATED: Generate legacy workspace ID from project and workspace paths.
   * This method is used only for legacy workspace migration to look up old workspaces.
   * New workspaces use generateStableId() which returns a random stable ID.
   *
   * DO NOT use this method or its format to construct workspace IDs anywhere in the codebase.
   * Workspace IDs are backend implementation details and must only come from backend operations.
   */
  generateLegacyId(projectPath: string, workspacePath: string): string {
    const projectBasename = this.getProjectName(projectPath);
    const workspaceBasename = PlatformPaths.basename(workspacePath);
    return `${projectBasename}-${workspaceBasename}`;
  }

  /**
   * Get the workspace directory path for a given directory name.
   * The directory name is the workspace name (branch name).
   */

  /**
   * Add paths to WorkspaceMetadata to create FrontendWorkspaceMetadata.
   * Helper to avoid duplicating path computation logic.
   */
  private async addPathsToMetadata(
    metadata: WorkspaceMetadata,
    workspacePath: string,
    _projectPath: string
  ): Promise<FrontendWorkspaceMetadata> {
    const result: FrontendWorkspaceMetadata = {
      ...metadata,
      namedWorkspacePath: workspacePath,
    };

    // Check for incompatible runtime configs (from newer xum versions)
    if (isIncompatibleRuntimeConfig(metadata.runtimeConfig)) {
      result.incompatibleRuntime =
        `This workspace was created with a newer version of ${XUM_PRODUCT_NAME}. ` +
        `Please upgrade ${XUM_PRODUCT_NAME} to use this workspace.`;
    }

    // Mark worktree workspaces with missing checkout directories as transcript-only.
    // Queued/starting agent tasks can briefly exist without a provisioned checkout, so keep
    // those workspaces interactive until the checkout is created.
    const workspacePathExists = await fs.promises
      .access(workspacePath)
      .then(() => true)
      .catch(() => false);
    if (
      isWorktreeRuntime(metadata.runtimeConfig) &&
      metadata.taskStatus !== "queued" &&
      metadata.taskStatus !== "starting" &&
      !workspacePathExists
    ) {
      result.transcriptOnly = true;
    }

    return result;
  }

  /**
   * Find a workspace by ID.
   * @returns Stored config project key plus a separate attribution project path, or null
   */
  findWorkspace(workspaceId: string): {
    workspacePath: string;
    projectPath: string;
    attributionProjectPath?: string;
    projects?: Workspace["projects"];
    workspaceName?: string;
    parentWorkspaceId?: string;
    pendingAutoTitle?: boolean;
  } | null {
    const config = this.loadConfigOrDefault();

    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        const attributionProjectPath = workspace.projects?.[0]?.projectPath ?? projectPath;

        // NEW FORMAT: Check config first (primary source of truth after migration)
        if (workspace.id === workspaceId) {
          return {
            workspacePath: workspace.path,
            // Keep the stored config bucket key so mutation callers can round-trip into
            // config.projects.get(projectPath), even for multi-project workspaces under _multi.
            projectPath,
            attributionProjectPath,
            projects: workspace.projects,
            workspaceName: workspace.name,
            parentWorkspaceId: workspace.parentWorkspaceId,
            pendingAutoTitle: workspace.pendingAutoTitle,
          };
        }

        // LEGACY FORMAT: Fall back to metadata.json and legacy ID for unmigrated workspaces
        if (!workspace.id) {
          // Extract workspace basename (could be stable ID or legacy name)
          const workspaceBasename =
            workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

          // Try loading metadata with basename as ID (works for old workspaces)
          const metadataPath = path.join(this.getSessionDir(workspaceBasename), "metadata.json");
          if (fs.existsSync(metadataPath)) {
            try {
              const data = fs.readFileSync(metadataPath, "utf-8");
              const metadata = JSON.parse(data) as WorkspaceMetadata;
              this.rememberLegacyTaskVariantWorkspace(projectPath, metadata, "metadata");
              if (metadata.id === workspaceId) {
                return {
                  workspacePath: workspace.path,
                  projectPath,
                  attributionProjectPath,
                  projects: metadata.projects ?? workspace.projects,
                  workspaceName: undefined,
                  parentWorkspaceId: undefined,
                };
              }
            } catch {
              // Ignore parse errors, try legacy ID
            }
          }

          // Try legacy ID format as last resort
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          if (legacyId === workspaceId) {
            return {
              workspacePath: workspace.path,
              projectPath,
              attributionProjectPath,
              projects: workspace.projects,
              workspaceName: undefined,
              parentWorkspaceId: undefined,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Workspace Path Architecture:
   *
   * Workspace paths are computed on-demand from projectPath + workspace name using
   * config.getWorkspacePath(projectPath, directoryName). This ensures a single source of truth.
   *
   * - Worktree directory name: uses workspace.name (the branch name)
   * - Workspace ID: stable random identifier for identity and sessions (not used for directories)
   *
   * Backend: Uses getWorkspacePath(metadata.projectPath, metadata.name) for workspace directory paths
   * Frontend: Gets enriched metadata with paths via IPC (FrontendWorkspaceMetadata)
   *
   * WorkspaceMetadata.workspacePath is deprecated and will be removed. Use computed
   * paths from getWorkspacePath() or getWorkspacePaths() instead.
   */

  /**
   * Get the session directory for a specific workspace
   */
  getSessionDir(workspaceId: string): string {
    return path.join(this.sessionsDir, workspaceId);
  }

  /**
   * Get all workspace metadata by loading config and metadata files.
   *
   * Returns FrontendWorkspaceMetadata with paths already computed.
   * This eliminates the need for separate "enrichment" - paths are computed
   * once during the loop when we already have all the necessary data.
   *
   * NEW BEHAVIOR: Config is the primary source of truth
   * - If workspace has id/name/createdAt in config, use those directly
   * - If workspace only has path, fall back to reading metadata.json
   * - Migrate old workspaces by copying metadata from files to config
   *
   * This centralizes workspace metadata in config.json and eliminates the need
   * for scattered metadata.json files (kept for backward compat with older versions).
   *
   * GUARANTEE: Every workspace returned will have a createdAt timestamp.
   * If missing from config or legacy metadata, a new timestamp is assigned and
   * saved to config for subsequent loads.
   */
  async getAllWorkspaceMetadata(): Promise<FrontendWorkspaceMetadata[]> {
    const config = this.loadConfigOrDefault();
    const workspaceMetadata: FrontendWorkspaceMetadata[] = [];
    // Read-time migrations recorded here are re-applied to a FRESH config snapshot inside
    // editConfig below. Persisting the local `config` snapshot directly (the old
    // saveConfig(config) call) raced concurrent removeWorkspace() edits and resurrected
    // removed workspace entries (lost-update). Each `apply` only fills still-missing fields
    // (??=), so re-application onto fresh state is idempotent and never clobbers newer data.
    const pendingWorkspaceMigrations: Array<{
      projectPath: string;
      /** Entry id as persisted on disk BEFORE this load's in-memory migrations. */
      persistedWorkspaceId: string | undefined;
      workspacePath: string;
      apply: (entry: Workspace) => void;
    }> = [];

    for (const [projectPath, projectConfig] of config.projects) {
      // Validate project path is not empty (defensive check for corrupted config)
      if (!projectPath) {
        log.warn("Skipping project with empty path in config", {
          workspaceCount: projectConfig.workspaces?.length ?? 0,
        });
        continue;
      }

      const projectName = this.getProjectName(projectPath);

      for (const workspace of projectConfig.workspaces) {
        // Extract workspace basename from path (could be stable ID or legacy name)
        const workspaceBasename =
          workspace.path.split("/").pop() ?? workspace.path.split("\\").pop() ?? "unknown";

        // Captured BEFORE any in-memory migration mutates workspace.id: the queued
        // replay must retarget by persisted identity, never by path alone — paths are
        // reusable after deletion, and applying a stale migration to a replacement
        // workspace at the same path would leak the old workspace's settings into it.
        const persistedWorkspaceId = workspace.id;
        const recordWorkspaceMigration = (
          migrationProjectPath: string,
          workspacePath: string,
          apply: (entry: Workspace) => void
        ) => {
          pendingWorkspaceMigrations.push({
            projectPath: migrationProjectPath,
            persistedWorkspaceId,
            workspacePath,
            apply,
          });
        };

        const workspaceProjects = workspace.projects?.length ? workspace.projects : undefined;
        const primaryWorkspaceProject = workspaceProjects?.[0];
        const resolvedProjectPath =
          workspace.kind === "scratch"
            ? workspace.path
            : (primaryWorkspaceProject?.projectPath ?? projectPath);
        const resolvedProjectName =
          workspace.kind === "scratch"
            ? SCRATCH_PROJECT_NAME
            : workspaceProjects
              ? workspaceProjects.map((projectRef) => projectRef.projectName).join("+")
              : projectName;

        try {
          // NEW FORMAT: If workspace has metadata in config, use it directly
          if (workspace.id && workspace.name) {
            const metadata: WorkspaceMetadata = {
              kind: workspace.kind,
              id: workspace.id,
              name: workspace.name,
              title: workspace.title,
              pendingAutoTitle: workspace.pendingAutoTitle,
              forkFamilyBaseName: workspace.forkFamilyBaseName,
              projectName: resolvedProjectName,
              projectPath: resolvedProjectPath,
              // GUARANTEE: All workspaces must have createdAt (assign now if missing)
              createdAt: workspace.createdAt ?? new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig (apply default if missing)
              runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              heartbeat: normalizeWorkspaceMetadataHeartbeat(workspace.heartbeat, config),
              goalDefaults: workspace.goalDefaults,
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              agentId: workspace.agentId,
              tags: workspace.tags,
              workflowTask: workspace.workflowTask,
              bestOf: normalizeWorkspaceBestOf(workspace.bestOf),
              taskStatus: workspace.taskStatus,
              taskPendingGuidance: workspace.taskPendingGuidance,
              taskLaunchError: workspace.taskLaunchError,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              taskIsolation: workspace.taskIsolation,
              taskSticky: workspace.taskSticky,
              taskExecutionId: workspace.taskExecutionId,
              taskExecutionStatus: workspace.taskExecutionStatus,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              pinnedAt: workspace.pinnedAt,
              projects: workspaceProjects,
              subProjectPath: workspace.subProjectPath,
            };

            // Migrate missing createdAt to config for next load
            if (!workspace.createdAt) {
              workspace.createdAt = metadata.createdAt;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.createdAt ??= metadata.createdAt;
              });
            }

            // Migrate missing runtimeConfig to config for next load
            if (!workspace.aiSettingsByAgent) {
              const derived = workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined;
              if (derived) {
                workspace.aiSettingsByAgent = derived;
                recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                  entry.aiSettingsByAgent ??= derived;
                });
              }
            }

            if (!workspace.runtimeConfig) {
              workspace.runtimeConfig = metadata.runtimeConfig;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.runtimeConfig ??= metadata.runtimeConfig;
              });
            }

            if (!workspace.projects && metadata.projects) {
              workspace.projects = metadata.projects;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.projects ??= metadata.projects;
              });
            }

            // Populate containerName for Docker workspaces (computed from project path and workspace name)
            if (
              metadata.runtimeConfig?.type === "docker" &&
              !metadata.runtimeConfig.containerName
            ) {
              metadata.runtimeConfig = {
                ...metadata.runtimeConfig,
                containerName: getDockerContainerName(metadata.projectPath, metadata.name),
              };
            }

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
            continue; // Skip metadata file lookup
          }

          // LEGACY FORMAT: Fall back to reading metadata.json
          // Try legacy ID format first (project-workspace) - used by E2E tests and old workspaces
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          const metadataPath = path.join(this.getSessionDir(legacyId), "metadata.json");
          let metadataFound = false;

          if (fs.existsSync(metadataPath)) {
            const data = fs.readFileSync(metadataPath, "utf-8");
            const metadata = JSON.parse(data) as WorkspaceMetadata;
            this.rememberLegacyTaskVariantWorkspace(projectPath, metadata, "metadata");

            // Ensure required fields are present
            if (!metadata.name) metadata.name = workspaceBasename;
            if (!metadata.projectPath) metadata.projectPath = resolvedProjectPath;
            if (!metadata.projectName) metadata.projectName = resolvedProjectName;
            metadata.projects ??= workspaceProjects;

            // GUARANTEE: All workspaces must have createdAt
            metadata.createdAt ??= new Date().toISOString();

            // GUARANTEE: All workspaces must have runtimeConfig
            metadata.runtimeConfig ??= DEFAULT_RUNTIME_CONFIG;

            // Preserve any config-only fields that may not exist in legacy metadata.json
            metadata.kind ??= workspace.kind;
            metadata.aiSettingsByAgent ??=
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined);
            metadata.aiSettings ??= workspace.aiSettings;
            metadata.heartbeat ??= workspace.heartbeat;

            // Preserve tree/task metadata when present in config (metadata.json won't have it)
            metadata.parentWorkspaceId ??= workspace.parentWorkspaceId;
            metadata.agentType ??= workspace.agentType;
            metadata.agentId ??= workspace.agentId;
            metadata.workflowTask ??= workspace.workflowTask;
            metadata.bestOf = isLegacyTaskVariantGroup(metadata.bestOf)
              ? undefined
              : (normalizeWorkspaceBestOf(metadata.bestOf) ??
                normalizeWorkspaceBestOf(workspace.bestOf));
            metadata.taskStatus ??= workspace.taskStatus;
            metadata.taskPendingGuidance ??= workspace.taskPendingGuidance;
            metadata.taskLaunchError ??= workspace.taskLaunchError;
            metadata.reportedAt ??= workspace.reportedAt;
            metadata.taskModelString ??= workspace.taskModelString;
            metadata.taskThinkingLevel ??= workspace.taskThinkingLevel;
            metadata.taskPrompt ??= workspace.taskPrompt;
            metadata.taskTrunkBranch ??= workspace.taskTrunkBranch;
            // Preserve archived timestamps from config
            metadata.archivedAt ??= workspace.archivedAt;
            metadata.unarchivedAt ??= workspace.unarchivedAt;
            // Preserve sub-project assignment from config.
            metadata.subProjectPath ??= workspace.subProjectPath;
            metadata.forkFamilyBaseName ??= workspace.forkFamilyBaseName;
            metadata.tags ??= workspace.tags;

            // Persisted config identity fields win over metadata.json values. The queued
            // migration below uses ??= (it must never clobber concurrent edits), so any
            // field already present in config keeps its persisted value — returning a
            // different value here would hand the UI an ID that findWorkspace cannot
            // resolve until the next reload.
            metadata.id = workspace.id ?? metadata.id;
            metadata.name = workspace.name ?? metadata.name;
            metadata.createdAt = workspace.createdAt ?? metadata.createdAt;
            metadata.runtimeConfig = workspace.runtimeConfig ?? metadata.runtimeConfig;

            if (!workspace.aiSettingsByAgent && metadata.aiSettingsByAgent) {
              workspace.aiSettingsByAgent = metadata.aiSettingsByAgent;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.aiSettingsByAgent ??= metadata.aiSettingsByAgent;
              });
            }

            if (!workspace.heartbeat && metadata.heartbeat) {
              workspace.heartbeat = metadata.heartbeat;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.heartbeat ??= metadata.heartbeat;
              });
            }

            // Migrate to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            workspace.forkFamilyBaseName = metadata.forkFamilyBaseName;
            recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
              entry.id ??= metadata.id;
              entry.name ??= metadata.name;
              entry.createdAt ??= metadata.createdAt;
              entry.runtimeConfig ??= metadata.runtimeConfig;
              entry.forkFamilyBaseName ??= metadata.forkFamilyBaseName;
            });

            if (!workspace.projects && metadata.projects) {
              workspace.projects = metadata.projects;
              recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
                entry.projects ??= metadata.projects;
              });
            }

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
            metadataFound = true;
          }

          // No metadata found anywhere - create basic metadata
          if (!metadataFound) {
            const legacyId = this.generateLegacyId(projectPath, workspace.path);
            const metadata: WorkspaceMetadata = {
              kind: workspace.kind,
              // Prefer already-persisted identity fields: the queued ??= migration below
              // keeps existing config values, so returning a generated legacyId for a
              // partially-migrated entry that already has an id would expose an ID that
              // findWorkspace cannot resolve until the next reload.
              id: workspace.id ?? legacyId,
              name: workspace.name ?? workspaceBasename,
              projectName: resolvedProjectName,
              projectPath: resolvedProjectPath,
              // GUARANTEE: All workspaces must have createdAt
              createdAt: workspace.createdAt ?? new Date().toISOString(),
              // GUARANTEE: All workspaces must have runtimeConfig
              runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
              aiSettings: workspace.aiSettings,
              heartbeat: workspace.heartbeat,
              goalDefaults: workspace.goalDefaults,
              aiSettingsByAgent:
                workspace.aiSettingsByAgent ??
                (workspace.aiSettings
                  ? {
                      plan: workspace.aiSettings,
                      exec: workspace.aiSettings,
                    }
                  : undefined),
              parentWorkspaceId: workspace.parentWorkspaceId,
              agentType: workspace.agentType,
              agentId: workspace.agentId,
              tags: workspace.tags,
              workflowTask: workspace.workflowTask,
              bestOf: normalizeWorkspaceBestOf(workspace.bestOf),
              taskStatus: workspace.taskStatus,
              taskPendingGuidance: workspace.taskPendingGuidance,
              taskLaunchError: workspace.taskLaunchError,
              reportedAt: workspace.reportedAt,
              taskModelString: workspace.taskModelString,
              taskThinkingLevel: workspace.taskThinkingLevel,
              taskPrompt: workspace.taskPrompt,
              taskTrunkBranch: workspace.taskTrunkBranch,
              taskIsolation: workspace.taskIsolation,
              taskSticky: workspace.taskSticky,
              taskExecutionId: workspace.taskExecutionId,
              taskExecutionStatus: workspace.taskExecutionStatus,
              archivedAt: workspace.archivedAt,
              unarchivedAt: workspace.unarchivedAt,
              pinnedAt: workspace.pinnedAt,
              projects: workspaceProjects,
              subProjectPath: workspace.subProjectPath,
            };

            // Save to config for next load
            workspace.id = metadata.id;
            workspace.name = metadata.name;
            workspace.createdAt = metadata.createdAt;
            workspace.runtimeConfig = metadata.runtimeConfig;
            recordWorkspaceMigration(projectPath, workspace.path, (entry) => {
              entry.id ??= metadata.id;
              entry.name ??= metadata.name;
              entry.createdAt ??= metadata.createdAt;
              entry.runtimeConfig ??= metadata.runtimeConfig;
            });

            workspaceMetadata.push(
              await this.addPathsToMetadata(metadata, workspace.path, projectPath)
            );
          }
        } catch (error) {
          log.error(`Failed to load/migrate workspace metadata:`, error);
          // Fallback to basic metadata if migration fails
          const legacyId = this.generateLegacyId(projectPath, workspace.path);
          const metadata: WorkspaceMetadata = {
            kind: workspace.kind,
            // Same invariant as the branches above: never return an ID/name that
            // diverges from a value already persisted in config.
            id: workspace.id ?? legacyId,
            name: workspace.name ?? workspaceBasename,
            projectName: resolvedProjectName,
            projectPath: resolvedProjectPath,
            // GUARANTEE: All workspaces must have createdAt (even in error cases)
            createdAt: workspace.createdAt ?? new Date().toISOString(),
            // GUARANTEE: All workspaces must have runtimeConfig (even in error cases)
            runtimeConfig: workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
            aiSettings: workspace.aiSettings,
            heartbeat: workspace.heartbeat,
            goalDefaults: workspace.goalDefaults,
            aiSettingsByAgent:
              workspace.aiSettingsByAgent ??
              (workspace.aiSettings
                ? {
                    plan: workspace.aiSettings,
                    exec: workspace.aiSettings,
                  }
                : undefined),
            parentWorkspaceId: workspace.parentWorkspaceId,
            agentType: workspace.agentType,
            agentId: workspace.agentId,
            tags: workspace.tags,
            workflowTask: workspace.workflowTask,
            bestOf: workspace.bestOf,
            taskStatus: workspace.taskStatus,
            taskPendingGuidance: workspace.taskPendingGuidance,
            taskLaunchError: workspace.taskLaunchError,
            reportedAt: workspace.reportedAt,
            taskModelString: workspace.taskModelString,
            taskThinkingLevel: workspace.taskThinkingLevel,
            taskPrompt: workspace.taskPrompt,
            taskTrunkBranch: workspace.taskTrunkBranch,
            taskIsolation: workspace.taskIsolation,
            taskSticky: workspace.taskSticky,
            taskExecutionId: workspace.taskExecutionId,
            taskExecutionStatus: workspace.taskExecutionStatus,
            projects: workspaceProjects,
            subProjectPath: workspace.subProjectPath,
          };

          workspaceMetadata.push(
            await this.addPathsToMetadata(metadata, workspace.path, projectPath)
          );
        }
      }
    }

    // Persist migrated workspace fields under the editConfig queue, re-resolving each
    // entry from the fresh snapshot. Entries removed concurrently are skipped so this
    // write can never resurrect them. Matching is by persisted identity: entries with
    // an id must match by id, and only id-less legacy entries may match by path — a
    // path match with a different id is a replacement workspace that must not inherit
    // the removed workspace's migrated settings.
    if (pendingWorkspaceMigrations.length > 0) {
      await this.editConfig((freshConfig) => {
        for (const migration of pendingWorkspaceMigrations) {
          const project = freshConfig.projects.get(migration.projectPath);
          const entry = migration.persistedWorkspaceId
            ? project?.workspaces.find(
                (candidate) => candidate.id === migration.persistedWorkspaceId
              )
            : project?.workspaces.find(
                (candidate) => candidate.path === migration.workspacePath && !candidate.id
              );
          if (!entry) continue; // workspace removed concurrently — do not resurrect
          migration.apply(entry);
        }
        return freshConfig;
      });
    }

    return workspaceMetadata;
  }

  /**
   * Add a workspace to config.json (single source of truth for workspace metadata).
   * Creates project entry if it doesn't exist.
   *
   * @param projectPath Absolute path to the project
   * @param metadata Workspace metadata to save
   */
  async addWorkspace(
    projectPath: string,
    metadata: WorkspaceMetadata & { namedWorkspacePath?: string }
  ): Promise<void> {
    await this.editConfig((config) => {
      let project = config.projects.get(projectPath);

      if (!project) {
        project = { workspaces: [] };
        config.projects.set(projectPath, project);
      }

      // Check if workspace already exists (by ID)
      const existingIndex = project.workspaces.findIndex((w) => w.id === metadata.id);

      // Use provided namedWorkspacePath if available (runtime-aware),
      // otherwise fall back to worktree-style path for legacy compatibility
      const projectName = this.getProjectName(projectPath);
      const workspacePath =
        metadata.namedWorkspacePath ?? path.join(this.srcDir, projectName, metadata.name);
      const workspaceEntry: Workspace = {
        path: workspacePath,
        kind: metadata.kind,
        id: metadata.id,
        name: metadata.name,
        title: metadata.title,
        pendingAutoTitle: metadata.pendingAutoTitle,
        forkFamilyBaseName: metadata.forkFamilyBaseName,
        createdAt: metadata.createdAt,
        aiSettingsByAgent: metadata.aiSettingsByAgent,
        runtimeConfig: metadata.runtimeConfig,
        aiSettings: metadata.aiSettings,
        heartbeat: metadata.heartbeat,
        goalDefaults: metadata.goalDefaults,
        parentWorkspaceId: metadata.parentWorkspaceId,
        agentType: metadata.agentType,
        agentId: metadata.agentId,
        tags: metadata.tags,
        workflowTask: metadata.workflowTask,
        bestOf: normalizeWorkspaceBestOf(metadata.bestOf),
        taskStatus: metadata.taskStatus,
        taskPendingGuidance: metadata.taskPendingGuidance,
        taskLaunchError: metadata.taskLaunchError,
        reportedAt: metadata.reportedAt,
        taskModelString: metadata.taskModelString,
        taskThinkingLevel: metadata.taskThinkingLevel,
        taskPrompt: metadata.taskPrompt,
        taskTrunkBranch: metadata.taskTrunkBranch,
        taskIsolation: metadata.taskIsolation,
        taskSticky: metadata.taskSticky,
        taskExecutionId: metadata.taskExecutionId,
        taskExecutionStatus: metadata.taskExecutionStatus,
        archivedAt: metadata.archivedAt,
        unarchivedAt: metadata.unarchivedAt,
        pinnedAt: metadata.pinnedAt,
        projects: metadata.projects,
        subProjectPath: metadata.subProjectPath,
      };

      if (existingIndex >= 0) {
        // Update existing workspace
        project.workspaces[existingIndex] = workspaceEntry;
      } else {
        // Add new workspace
        project.workspaces.push(workspaceEntry);
      }

      return config;
    });
  }

  /**
   * Remove a workspace from config.json
   *
   * @param workspaceId ID of the workspace to remove
   */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.editConfig((config) => {
      let workspaceFound = false;

      for (const [_projectPath, project] of config.projects) {
        const index = project.workspaces.findIndex((w) => w.id === workspaceId);
        if (index !== -1) {
          project.workspaces.splice(index, 1);
          workspaceFound = true;
          // We don't break here in case duplicates exist (though they shouldn't)
        }
      }

      if (!workspaceFound) {
        log.warn(`Workspace ${workspaceId} not found in config during removal`);
      }

      return config;
    });
  }

  /**
   * Update workspace metadata fields (e.g., regenerate missing title/branch)
   * Used to fix incomplete metadata after errors or restarts
   */
  async updateWorkspaceMetadata(
    workspaceId: string,
    updates: Partial<Pick<WorkspaceMetadata, "name" | "runtimeConfig">>
  ): Promise<void> {
    await this.editConfig((config) => {
      for (const [_projectPath, projectConfig] of config.projects) {
        const workspace = projectConfig.workspaces.find((w) => w.id === workspaceId);
        if (workspace) {
          if (updates.name !== undefined) workspace.name = updates.name;
          if (updates.runtimeConfig !== undefined) workspace.runtimeConfig = updates.runtimeConfig;
          return config;
        }
      }
      throw new Error(`Workspace ${workspaceId} not found in config`);
    });
  }

  /**
   * Load providers configuration from JSONC file
   * Supports comments in JSONC format
   */
  loadProvidersConfig(): ProvidersConfig | null {
    try {
      if (fs.existsSync(this.providersFile)) {
        const data = fs.readFileSync(this.providersFile, "utf-8");
        return jsonc.parse(data) as ProvidersConfig;
      }
    } catch (error) {
      log.error("Error loading providers config:", error);
    }

    return null;
  }

  /**
   * Return a content fingerprint (sha256) of providers.jsonc, or null if
   * the file doesn't exist or can't be read. Used by callers to
   * distinguish between watcher events triggered by their own saves
   * versus genuine external edits.
   *
   * We hash the file contents rather than comparing mtime: filesystems
   * with coarse timestamp granularity (FAT, some network mounts) can
   * bucket two distinct writes into the same `mtimeMs`, which would let
   * a real external edit be silently suppressed. If two writes happen
   * to produce byte-identical content, suppressing the refresh is a
   * no-op anyway, so content equality is the safest possible self-
   * write signal.
   */
  getProvidersFileFingerprint(): string | null {
    try {
      const contents = fs.readFileSync(this.providersFile);
      return crypto.createHash("sha256").update(contents).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Watch providers.jsonc for external edits. Fires callback (debounced 300 ms)
   * on any create/modify/delete event. Returns a cleanup function.
   *
   * We watch the parent directory rather than the file directly so that
   * creates (first-time manual edit) are also detected on all platforms.
   */
  watchProvidersFile(callback: () => void): () => void {
    const filename = path.basename(this.providersFile);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const fire = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        callback();
      }, 300);
    };

    // Anything inside this block can fail in restricted environments:
    //   - ensurePrivateDirSync: read-only filesystem, unwritable MUX_ROOT
    //   - fs.watch: ENOENT, network filesystems (NFS/SMB), watch-limit
    //     exhaustion (ENOSPC on Linux), unsupported virtualized mounts.
    // We degrade gracefully in every case: log once, return a no-op
    // cleanup, and let the rest of provider config keep working. The UI
    // just won't auto-refresh on manual edits in that environment (same
    // as the pre-PR behaviour).
    let watcher: fs.FSWatcher;
    try {
      // The xum home directory may not exist on a fresh install. Create it
      // so fs.watch doesn't throw ENOENT; the directory being empty is fine.
      if (!fs.existsSync(this.rootDir)) {
        ensurePrivateDirSync(this.rootDir);
      }

      // persistent: false so the watcher doesn't prevent the process (or
      // Jest) from exiting when nothing else is keeping the event loop alive.
      watcher = fs.watch(this.rootDir, { persistent: false }, (_eventType, changedFilename) => {
        // changedFilename can be null on some platforms/kernels (notably
        // older macOS FSEvents). When we can't tell which file changed,
        // assume providers.jsonc might have and let the consumer re-fetch
        // — better an extra refresh than a missed one, since this is the
        // exact scenario the feature is meant to fix.
        if (changedFilename != null && changedFilename !== filename) return;
        fire();
      });

      // Without an 'error' listener, FSWatcher errors emit on the global
      // 'uncaughtException' path and can terminate the process (e.g. if the
      // xum home directory is removed or unmounted after startup). Handle
      // it locally: degrade to "no live refresh" the same way we do when
      // setup itself fails. The watcher is dead after an error, so we
      // close it defensively and clear any pending debounce so the
      // cleanup function returned below remains a safe no-op.
      watcher.on("error", (error) => {
        log.warn(
          `providers.jsonc watcher error (${this.rootDir}); live refresh disabled until restart:`,
          error
        );
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        try {
          watcher.close();
        } catch {
          // Watcher may already be torn down by the OS — nothing to do.
        }
      });
    } catch (error) {
      log.warn(
        `Could not watch providers.jsonc for external edits (${this.rootDir}); manual edits will require a restart to take effect:`,
        error
      );
      const noop = (): void => {
        // Nothing to clean up — watcher setup never completed.
      };
      return noop;
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  }

  /**
   * Advisory cross-process lock for providers.jsonc read-modify-write cycles.
   *
   * Multiple xum processes (desktop app, `xum run`, `xum workflow`) share
   * providers.jsonc, and OAuth credential rotation requires compare-and-set
   * semantics across them. Exclusive directory creation is atomic on all
   * platforms, so `<providersFile>.lock/` serves as the mutex. Locks orphaned
   * by crashed processes are broken after a staleness timeout.
   */
  async withProvidersFileLock<T>(fn: () => Promise<T> | T): Promise<T> {
    // Guards sub-second file mutations, so contention resolves quickly.
    return this.withDirLock(`${this.providersFile}.lock`, 5_000, 10_000, fn);
  }

  /**
   * Cross-process serialization of Coder OAuth token refreshes.
   *
   * Coder rotates refresh tokens on every use, so two processes refreshing
   * the same credential race destructively: the loser's `invalid_grant` can
   * arrive — and its compare-and-clear delete the credential — while the
   * winner's rotation is still in flight and not yet on disk, after which the
   * winner's persist CAS fails too and BOTH processes discard the only valid
   * token. Serializing the whole refresh round-trip (re-read + token request
   * + persist) closes that window: a loser re-reads inside the lock and
   * adopts the winner's rotation without ever sending a doomed request.
   *
   * Timing: the guarded section includes one bounded token request (30s cap,
   * see TOKEN_REQUEST_TIMEOUT_MS in coderOauthService.ts), so acquisition
   * waits up to 45s and orphaned locks are broken after 60s.
   */
  async withCoderOauthRefreshLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-refresh.lock`, 45_000, 60_000, fn);
  }

  /**
   * Cross-process serialization of Coder OAuth desktop-login commits
   * (persist -> finish/rollback; see commitDesktopLogin in
   * coderOauthService.ts).
   *
   * A login's rollback snapshot (`previousSection`) must only ever capture a
   * COMMITTED section. Login flows are process-local, but the persisted
   * section is shared across processes: without this lock, a flow in process
   * B could snapshot process A's persisted-but-uncommitted login; if both
   * were then cancelled, A's rollback would skip (B's auth is current) and
   * revoke A's tokens, after which B's rollback would restore that
   * already-revoked auth over the original login.
   *
   * Timing: the guarded section is a handful of providers-file mutations and
   * no network I/O (revocation runs after release), so acquisition waits up
   * to 15s and orphaned locks are broken after 20s.
   */
  async withCoderOauthLoginCommitLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.withDirLock(`${this.providersFile}.coder-login.lock`, 15_000, 20_000, fn);
  }

  /**
   * Atomically install a generation-marked lock directory at `lockPath`: the
   * owner marker (content = holder PID, see tryBreakStaleDirLock) is written
   * into a staged sibling directory which is then rename(2)d into place.
   * Acquisition and marker creation are therefore a single atomic step — a
   * live acquisition is never observable as an EMPTY lock directory, so an
   * empty directory is always a crash remnant (the unlink→rmdir window of
   * release/stale-break) that breakers may reclaim immediately. Without this,
   * a crash between mkdir and marker write would look live until the mtime
   * TTL, and every acquisition timeout is shorter than its TTL — the first
   * operation after such a crash would always time out.
   *
   * On POSIX, rename onto an existing EMPTY directory atomically replaces it
   * (instant orphan recovery); onto a non-empty one it fails ENOTEMPTY. On
   * Windows, rename onto any existing directory fails — contenders recover
   * empty orphans via tryBreakStaleDirLock instead.
   *
   * Returns the installed marker path, or null when the lock is held
   * (contended). Unexpected filesystem errors (EACCES, EROFS, ...) are
   * rethrown after the stage directory is cleaned up.
   */
  private tryInstallDirLock(lockPath: string): string | null {
    const stagePath = `${lockPath}.stage-${crypto.randomBytes(8).toString("hex")}`;
    const markerName = `owner-${crypto.randomBytes(16).toString("hex")}`;
    fs.mkdirSync(stagePath);
    try {
      fs.writeFileSync(path.join(stagePath, markerName), String(process.pid));
      fs.renameSync(stagePath, lockPath);
    } catch (error) {
      try {
        fs.rmSync(stagePath, { recursive: true, force: true });
      } catch {
        // Best effort; abandoned stages are swept by cleanupAbandonedStageDirs.
      }
      const code = (error as NodeJS.ErrnoException).code;
      // POSIX rename refuses a non-empty target with ENOTEMPTY (some
      // platforms report EEXIST); Windows refuses any existing target with
      // EPERM/EEXIST.
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") {
        return null;
      }
      throw error;
    }
    return path.join(lockPath, markerName);
  }

  /**
   * Remove stage directories abandoned by a crash between staging and the
   * rename in tryInstallDirLock. TTL-gated on mtime so a concurrent
   * acquisition's in-flight stage (a microseconds-wide window) is never
   * destroyed under a live process.
   */
  private cleanupAbandonedStageDirs(lockPath: string, ttlMs: number): void {
    const parent = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.stage-`;
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const stagePath = path.join(parent, entry);
      try {
        if (Date.now() - fs.statSync(stagePath).mtimeMs > ttlMs) {
          fs.rmSync(stagePath, { recursive: true, force: true });
        }
      } catch {
        // Best effort (already removed, or racing its own install).
      }
    }
  }

  /**
   * Shared advisory directory lock: acquisition atomically installs the lock
   * directory together with its generation marker (see tryInstallDirLock);
   * locks orphaned by crashed processes are broken once they are older than
   * `staleLockMs` AND their owner process is gone
   * (see tryBreakStaleDirLock — live-but-stalled holders are never broken;
   * contenders instead fail acquisition at the bounded timeout).
   *
   * Ownership generations: a holder that runs past `staleLockMs` (suspended
   * process, stalled event loop) can be stale-broken and the lock reacquired
   * before its release runs — an unconditional removal would then delete the
   * successor's lock and let a third process into the critical section. Each
   * acquisition therefore writes a generation-unique marker file and release
   * only removes that generation (see tryBreakStaleDirLock for the breaker's
   * matching conditional cleanup).
   */
  private async withDirLock<T>(
    lockPath: string,
    acquireTimeoutMs: number,
    staleLockMs: number,
    fn: () => Promise<T> | T
  ): Promise<T> {
    const RETRY_DELAY_MS = 25;
    const deadline = Date.now() + acquireTimeoutMs;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }
    this.cleanupAbandonedStageDirs(lockPath, staleLockMs);

    let ownerFile: string;
    for (;;) {
      // tryInstallDirLock rethrows permanent filesystem errors (EACCES,
      // EROFS, ...) — they would fail on every retry, so callers surface an
      // error instead of spinning until the deadline.
      const installed = this.tryInstallDirLock(lockPath);
      if (installed != null) {
        ownerFile = installed;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring providers config lock at ${lockPath}`);
      }
      // Held by another process (or a crashed one): break stale locks, then
      // retry — immediately after a break/vanish, with a delay for a live
      // holder.
      if (this.tryBreakStaleDirLock(lockPath, staleLockMs)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(ownerFile);
        try {
          fs.rmdirSync(lockPath);
        } catch (error) {
          // ENOENT/ENOTEMPTY: a breaker finished the removal or a successor
          // generation already acquired the path — leave it to them.
          log.debug("Failed to release providers config lock:", error);
        }
      } catch {
        // Marker already gone: this holder outlived staleLockMs and was
        // stale-broken; a successor may hold the lock now — keep it.
      }
    }
  }

  /**
   * Try to take an exclusive cross-process lease on the stored Coder OAuth
   * dynamic client. The client's registration has a single redirect_uris
   * slot, so only one login flow — across every Xum process sharing this
   * providers file — may reuse (and RFC 7592-update) it at a time; callers
   * that fail to acquire the lease must register a fresh client instead.
   *
   * Non-blocking: returns a release function on success, or null when another
   * live flow holds the lease. Unlike withProvidersFileLock (which guards
   * sub-second file mutations), this lease spans a whole login flow — the
   * redirect URI must stay registered until the user finishes authorizing —
   * so staleness is judged against `ttlMs` (the flow timeout). A crashed
   * holder's lease is broken after that (only once its process is provably
   * gone, see tryBreakStaleDirLock), and in the interim other flows degrade
   * gracefully to fresh client registrations.
   *
   * Ownership safety: a lease that crosses the staleness boundary can be
   * broken and reacquired by another process at any instant, so neither
   * release nor stale-breaking may check-then-recursively-remove (the check
   * and the rm would race the handover). Instead each acquisition writes a
   * generation-unique marker FILE inside the lease directory, and every
   * destructive step is conditional at the filesystem layer: unlink can only
   * remove the specific generation's marker (a successor's marker has a
   * different name), and the non-recursive rmdir only removes an EMPTY
   * directory — never a directory a successor generation re-marked.
   */
  tryAcquireCoderOauthClientLease(ttlMs: number): (() => void) | null {
    const leasePath = `${this.providersFile}.coder-client.lock`;

    if (!fs.existsSync(this.rootDir)) {
      ensurePrivateDirSync(this.rootDir);
    }

    this.cleanupAbandonedStageDirs(leasePath, ttlMs);

    for (let attempt = 0; attempt < 2; attempt++) {
      let ownerFile: string;
      try {
        const installed = this.tryInstallDirLock(leasePath);
        if (installed == null) {
          // Contended: held by another flow (or a crash remnant).
          if (!this.tryBreakStaleDirLock(leasePath, ttlMs)) {
            return null; // Held by a live flow.
          }
          continue; // Stale lease broken (or it vanished); retry once.
        }
        ownerFile = installed;
      } catch (error) {
        // Filesystem errors mean the lease was never installed. The lease is
        // an optimization with a documented degradation path — callers fall
        // back to registering a fresh client — so prefer a working login
        // over surfacing an acquisition error.
        log.debug("Failed to install Coder OAuth client lease:", error);
        return null;
      }

      return () => {
        try {
          fs.unlinkSync(ownerFile);
        } catch {
          return; // Stale-broken and reacquired by another flow; keep it.
        }
        try {
          fs.rmdirSync(leasePath);
        } catch (error) {
          // A release racing the staleness boundary can lose the directory to
          // a concurrent breaker after the unlink above: ENOENT means the
          // breaker finished the removal, ENOTEMPTY means a successor already
          // acquired a new generation — both correctly leave it untouched.
          log.debug("Failed to release Coder OAuth client lease:", error);
        }
      };
    }
    return null;
  }

  /**
   * Break a marker-based directory lock/lease left behind by a crashed (or
   * stalled-past-staleness) holder. Shared by withDirLock and
   * tryAcquireCoderOauthClientLease, whose generation-marker layout matches.
   * Returns true when the caller should retry acquisition (the lock was
   * stale or vanished mid-check), false when it is held by a live owner.
   */
  private tryBreakStaleDirLock(leasePath: string, ttlMs: number): boolean {
    let entries: string[];
    try {
      entries = fs.readdirSync(leasePath);
    } catch {
      return true; // Released between the failed mkdir and now; retry.
    }
    const isStale = (mtimeMs: number) => Date.now() - mtimeMs > ttlMs;

    if (entries.length === 0) {
      // Acquisition installs the marker atomically with the directory
      // (staged rename — see tryInstallDirLock), so an empty lock directory
      // is never a live acquisition: it can only be a crash remnant from the
      // unlink→rmdir window of release/stale-break. Reclaim it immediately —
      // waiting out the mtime TTL would make every acquisition timeout (all
      // shorter than their TTLs) fire first, so the first operation after
      // such a crash would always fail despite being deterministically
      // recoverable. The non-recursive rmdir keeps the race with a concurrent
      // installer safe: it cannot destroy a renamed-in full generation.
      try {
        fs.rmdirSync(leasePath);
      } catch {
        // ENOTEMPTY (a generation was renamed into place) or ENOENT (another
        // breaker won); the retried install/staleness check sorts either out.
      }
      return true;
    }

    // Staleness binds to the OBSERVED generation's marker: marker names are
    // generation-unique, so if the lease changes hands after this check the
    // unlink below ENOENTs and the rmdir ENOTEMPTYs — a live successor lease
    // is never destroyed (the reason breaking must not use recursive rm).
    for (const entry of entries) {
      const entryPath = path.join(leasePath, entry);
      // The marker carries the owner's PID, checked FIRST:
      // - Owner provably ALIVE: never break, however old the marker. A live
      //   process that merely outlived the TTL (suspended laptop, stalled
      //   event loop) may still be mid-critical-section; breaking would let a
      //   second process in, and for the refresh lock the resumed original
      //   could then race the successor over the same rotating refresh token
      //   — both sides clearing/revoking the only valid credential.
      //   Contenders instead fail bounded (withDirLock times out, the client
      //   lease falls back to a fresh registration).
      // - Owner provably DEAD: reclaim immediately, however fresh the marker.
      //   A dead process cannot be mid-critical-section, and every
      //   acquisition timeout is shorter than its staleness TTL — waiting for
      //   the TTL would make the first operation after a crash always time
      //   out even though the orphan is deterministically recoverable.
      // - Owner unknown (unreadable/partial marker): fall back to the mtime
      //   TTL, the only remaining staleness signal.
      // Residual risk: a recycled PID belonging to an unrelated live process
      // keeps an orphaned lock alive until that process exits — rare, and
      // strictly safer than destroying a live holder's lock.
      let ownerPid: number | null = null;
      try {
        const content = fs.readFileSync(entryPath, "utf8").trim();
        ownerPid = /^\d+$/.test(content) ? Number(content) : null;
      } catch {
        continue; // Vanished mid-check; the conditional cleanup below is safe.
      }
      if (ownerPid !== null) {
        if (isProcessAlive(ownerPid)) {
          return false;
        }
      } else {
        try {
          if (!isStale(fs.statSync(entryPath).mtimeMs)) {
            return false;
          }
        } catch {
          continue; // Vanished mid-check; the conditional cleanup below is safe.
        }
      }
      try {
        fs.unlinkSync(entryPath);
      } catch {
        // Already removed by a concurrent breaker or by its owner's release.
      }
    }
    try {
      fs.rmdirSync(leasePath);
    } catch {
      // ENOTEMPTY (a generation appeared) or ENOENT (another breaker won);
      // the retried mkdir/staleness check sorts either out.
    }
    return true;
  }

  /**
   * Save providers configuration to JSONC file
   * @param config The providers configuration to save
   */
  saveProvidersConfig(config: ProvidersConfig): void {
    try {
      if (!fs.existsSync(this.rootDir)) {
        ensurePrivateDirSync(this.rootDir);
      }

      // Format with 2-space indentation for readability
      const jsonString = JSON.stringify(config, null, 2);

      // Add a comment header to the file
      const contentWithComments = `// Providers configuration for xum
// Configure your AI providers here
// Example:
// {
//   "anthropic": {
//     "apiKey": "sk-ant-..."
//   },
//   "openai": {
//     "apiKey": "sk-..."
//   },
//   "xai": {
//     "apiKey": "sk-xai-..."
//   },
//   "ollama": {
//     "baseUrl": "http://localhost:11434/api"  // Optional - only needed for remote/custom URL
//   }
// }
${jsonString}`;

      writeFileAtomic.sync(this.providersFile, contentWithComments, {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (error) {
      log.error("Error saving providers config:", error);
      throw error; // Re-throw to let caller handle
    }
  }

  private static readonly GLOBAL_SECRETS_KEY = "__global__";

  private static normalizeSecretsProjectPath(projectPath: string): string {
    return stripTrailingSlashes(projectPath);
  }

  private static isSecretValue(value: unknown): value is Secret["value"] {
    if (typeof value === "string") {
      return true;
    }

    return isSecretReferenceValue(value);
  }

  private static isSecret(value: unknown): value is Secret {
    return (
      typeof value === "object" &&
      value !== null &&
      "key" in value &&
      "value" in value &&
      typeof (value as { key?: unknown }).key === "string" &&
      Config.isSecretValue((value as { value?: unknown }).value)
    );
  }

  private static parseSecretsArray(value: unknown): Secret[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const sanitizedSecrets: Secret[] = [];

    for (const entry of value) {
      // Filter invalid entries to avoid crashes when iterating secrets.
      if (!Config.isSecret(entry)) {
        continue;
      }

      // Preserve key/value when persisted data includes malformed injectAll values.
      // This keeps existing secrets usable while ignoring invalid inject-all flags.
      const entryWithInjectAll = entry as Secret & { injectAll?: unknown };
      if (typeof entryWithInjectAll.injectAll === "boolean") {
        sanitizedSecrets.push({
          key: entryWithInjectAll.key,
          value: entryWithInjectAll.value,
          injectAll: entryWithInjectAll.injectAll,
        });
        continue;
      }

      sanitizedSecrets.push({
        key: entryWithInjectAll.key,
        value: entryWithInjectAll.value,
      });
    }

    return sanitizedSecrets;
  }

  /**
   * Merge an updated secrets list with raw on-disk entries, preserving entries
   * whose value shapes this build no longer understands (e.g. legacy 1Password
   * `{ op: ... }` references) so a downgrade can still read them. Supported
   * entries are fully represented in the UI, so `next` is authoritative for
   * them; a preserved legacy entry is dropped only when the update reuses its
   * key (the new value intentionally replaces it).
   */
  private static mergeSecretsPreservingUnsupported(
    rawEntries: unknown[],
    next: Secret[]
  ): unknown[] {
    const nextKeys = new Set(next.map((secret) => secret.key));
    const preserved: unknown[] = [];

    for (const entry of rawEntries) {
      if (Config.isSecret(entry)) {
        continue;
      }

      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { key?: unknown }).key === "string" &&
        !nextKeys.has((entry as { key: string }).key)
      ) {
        preserved.push(entry);
      }
    }

    return [...next, ...preserved];
  }

  private static mergeSecretsByKey(primary: Secret[], secondary: Secret[]): Secret[] {
    // Merge-by-key (last writer wins).
    const mergedByKey = new Map<string, Secret>();
    for (const secret of primary) {
      mergedByKey.set(secret.key, secret);
    }
    for (const secret of secondary) {
      mergedByKey.set(secret.key, secret);
    }
    return Array.from(mergedByKey.values());
  }

  private static normalizeSecretsConfig(raw: unknown): SecretsConfig {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }

    const record = raw as Record<string, unknown>;
    const normalized: SecretsConfig = {};

    for (const [rawKey, rawValue] of Object.entries(record)) {
      let key = rawKey;
      if (rawKey !== Config.GLOBAL_SECRETS_KEY) {
        const normalizedKey = Config.normalizeSecretsProjectPath(rawKey);
        key = normalizedKey || rawKey;
      }

      const secrets = Config.parseSecretsArray(rawValue);

      if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
        normalized[key] = secrets;
        continue;
      }

      normalized[key] = Config.mergeSecretsByKey(normalized[key], secrets);
    }

    return normalized;
  }

  /**
   * Load secrets configuration from JSON file
   * Returns empty config if file doesn't exist
   */
  loadSecretsConfig(): SecretsConfig {
    try {
      if (fs.existsSync(this.secretsFile)) {
        const data = fs.readFileSync(this.secretsFile, "utf-8");
        const parsed = JSON.parse(data) as unknown;
        return Config.normalizeSecretsConfig(parsed);
      }
    } catch (error) {
      log.error("Error loading secrets config:", error);
    }

    return {};
  }

  /**
   * Load the secrets file without filtering entry shapes. Used by the update
   * paths so unsupported legacy entries survive round-trips to disk instead of
   * being silently deleted when an unrelated secret is saved.
   */
  private loadRawSecretsConfig(): Record<string, unknown> {
    try {
      if (fs.existsSync(this.secretsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.secretsFile, "utf-8")) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { ...(parsed as Record<string, unknown>) };
        }
      }
    } catch (error) {
      log.error("Error loading secrets config:", error);
    }

    return {};
  }

  /**
   * Replace one bucket of the secrets file (global sentinel or a normalized
   * project path) while leaving every other bucket byte-for-byte intact and
   * preserving unsupported legacy entries within the target bucket.
   */
  private async updateSecretsBucket(bucketKey: string, secrets: Secret[]): Promise<void> {
    const raw = this.loadRawSecretsConfig();

    // Project paths may be persisted with trailing slashes; fold every raw key
    // that maps to this bucket so preserved entries aren't left in a shadowed
    // duplicate bucket.
    const rawBucketEntries: unknown[] = [];
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const mappedKey =
        rawKey === Config.GLOBAL_SECRETS_KEY
          ? rawKey
          : Config.normalizeSecretsProjectPath(rawKey) || rawKey;
      if (mappedKey !== bucketKey) {
        continue;
      }

      if (Array.isArray(rawValue)) {
        // Array.isArray narrows unknown to any[]; retype to unknown[] for safe handling.
        rawBucketEntries.push(...(rawValue as unknown[]));
      }
      delete raw[rawKey];
    }

    raw[bucketKey] = Config.mergeSecretsPreservingUnsupported(rawBucketEntries, secrets);
    await this.saveSecretsConfig(raw);
  }

  /**
   * Save secrets configuration to JSON file
   * @param config The secrets configuration to save
   */
  async saveSecretsConfig(config: SecretsConfig | Record<string, unknown>): Promise<void> {
    try {
      if (!fs.existsSync(this.rootDir)) {
        ensurePrivateDirSync(this.rootDir);
      }

      await writeFileAtomic(this.secretsFile, JSON.stringify(config, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
    } catch (error) {
      log.error("Error saving secrets config:", error);
      throw error;
    }
  }

  /**
   * Get global secrets (not project-scoped).
   *
   * Stored in <xumHome>/secrets.json under a sentinel key for backwards compatibility.
   */
  getGlobalSecrets(): Secret[] {
    const config = this.loadSecretsConfig();
    return config[Config.GLOBAL_SECRETS_KEY] ?? [];
  }

  /** Update global secrets (not project-scoped). */
  async updateGlobalSecrets(secrets: Secret[]): Promise<void> {
    await this.updateSecretsBucket(Config.GLOBAL_SECRETS_KEY, secrets);
  }

  /**
   * Get effective secrets for a project.
   *
   * Project secrets define which env vars are injected into this project/workspace.
   * Global secrets can be injected for all projects when `injectAll` is enabled,
   * and are also used as a shared value store for `{ secret: "GLOBAL_KEY" }` references.
   */
  getEffectiveSecrets(projectPath: string): Secret[] {
    const normalizedProjectPath = Config.normalizeSecretsProjectPath(projectPath) || projectPath;
    const config = this.loadSecretsConfig();
    const globalSecrets = config[Config.GLOBAL_SECRETS_KEY] ?? [];
    const projectSecrets = config[normalizedProjectPath] ?? [];

    // Keep global reference resolution synchronous so getEffectiveSecrets remains fast and side-effect free.
    const globalRawByKey = new Map<string, Secret["value"]>();
    for (const globalSecret of config[Config.GLOBAL_SECRETS_KEY] ?? []) {
      if (!globalSecret || typeof globalSecret.key !== "string") {
        continue;
      }

      globalRawByKey.set(globalSecret.key, globalSecret.value);
    }

    const globalResolved = new Map<string, Secret["value"] | undefined>();
    const globalResolving = new Set<string>();

    const resolveGlobalKey = (key: string): Secret["value"] | undefined => {
      if (globalResolved.has(key)) {
        return globalResolved.get(key);
      }

      if (globalResolving.has(key)) {
        globalResolved.set(key, undefined);
        return undefined;
      }

      globalResolving.add(key);
      try {
        const raw = globalRawByKey.get(key);

        if (typeof raw === "string") {
          globalResolved.set(key, raw);
          return raw;
        }

        if (isSecretReferenceValue(raw)) {
          const target = raw.secret.trim();
          if (!target) {
            globalResolved.set(key, undefined);
            return undefined;
          }

          const value = resolveGlobalKey(target);
          globalResolved.set(key, value);
          return value;
        }

        globalResolved.set(key, undefined);
        return undefined;
      } finally {
        globalResolving.delete(key);
      }
    };

    const globalSecretsByKey = new Map<string, Secret["value"]>();
    for (const key of globalRawByKey.keys()) {
      const value = resolveGlobalKey(key);
      if (value !== undefined) {
        globalSecretsByKey.set(key, value);
      }
    }

    // Normalize duplicate global keys with last-writer semantics before evaluating injectAll.
    // This keeps inject behavior aligned with value resolution when the same key appears
    // multiple times in persisted data.
    const finalGlobalSecretsByKey = new Map<string, Secret>();
    for (const secret of globalSecrets) {
      finalGlobalSecretsByKey.set(secret.key, secret);
    }

    const injectedGlobalSecrets: Secret[] = [];
    for (const secret of finalGlobalSecretsByKey.values()) {
      if (secret.injectAll !== true) {
        continue;
      }

      const resolvedValue = globalSecretsByKey.get(secret.key);
      // Allow empty-string global secrets by checking for undefined explicitly.
      if (resolvedValue !== undefined) {
        injectedGlobalSecrets.push({ key: secret.key, value: resolvedValue });
      }
    }

    const resolvedProjectSecrets = projectSecrets.map((secret) => {
      if (!isSecretReferenceValue(secret.value)) {
        return secret;
      }

      const targetKey = secret.value.secret.trim();
      if (!targetKey) {
        return secret;
      }

      // Allow empty-string global secrets by checking for undefined explicitly.
      const resolvedGlobalValue = globalSecretsByKey.get(targetKey);
      if (resolvedGlobalValue !== undefined) {
        return {
          ...secret,
          value: resolvedGlobalValue,
        };
      }

      return secret;
    });

    const projectKeys = new Set(resolvedProjectSecrets.map((secret) => secret.key));
    const nonOverriddenGlobalSecrets = injectedGlobalSecrets.filter(
      (secret) => !projectKeys.has(secret.key)
    );

    return [...nonOverriddenGlobalSecrets, ...resolvedProjectSecrets];
  }

  /**
   * Get globally injected secrets visible to a project.
   *
   * This is a read-only view used by project settings to explain inherited environment.
   * Project-defined keys are excluded because project secrets override injected globals.
   */
  getInjectedGlobalSecrets(projectPath: string): Secret[] {
    const projectSecrets = this.getProjectSecrets(projectPath);
    const projectKeys = new Set(projectSecrets.map((secret) => secret.key));

    return this.getEffectiveSecrets(projectPath).filter((secret) => !projectKeys.has(secret.key));
  }

  /**
   * Get secrets for a specific project.
   *
   * Note: this is project-only (does not include global secrets).
   */
  getProjectSecrets(projectPath: string): Secret[] {
    const normalizedProjectPath = Config.normalizeSecretsProjectPath(projectPath) || projectPath;
    const config = this.loadSecretsConfig();
    return config[normalizedProjectPath] ?? [];
  }

  /**
   * Update secrets for a specific project
   * @param projectPath The path to the project
   * @param secrets The secrets to save for the project
   */
  async updateProjectSecrets(projectPath: string, secrets: Secret[]): Promise<void> {
    const normalizedProjectPath = Config.normalizeSecretsProjectPath(projectPath) || projectPath;
    await this.updateSecretsBucket(normalizedProjectPath, secrets);
  }
}

// Default instance for application use
export const defaultConfig = new Config();
