import {
  getUserPreferences,
  updateUserPreferences,
  useUserPreferences,
} from "@/browser/stores/AppConfigStore";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import type { CoderWorkspaceConfig } from "@/common/orpc/schemas/coder";
import { CODER_RUNTIME_PLACEHOLDER, RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";

export type RuntimeOptionDefaults = Partial<Record<RuntimeMode, unknown>>;

const NO_RUNTIME_OPTION_DEFAULTS: RuntimeOptionDefaults = {};

function selectRuntimeOptionDefaults(
  preferences: UserPreferences,
  projectPath: string
): RuntimeOptionDefaults | undefined {
  return preferences.workspaceCreation?.byProject?.[projectPath]?.lastRuntimeConfig;
}

/** The project's remembered runtime options; creation and Settings edit the same value. */
export function useRuntimeOptionDefaults(projectPath: string | null): RuntimeOptionDefaults {
  return (
    useUserPreferences((preferences) =>
      projectPath === null ? undefined : selectRuntimeOptionDefaults(preferences, projectPath)
    ) ?? NO_RUNTIME_OPTION_DEFAULTS
  );
}

export function readRuntimeOptionDefaults(projectPath: string): RuntimeOptionDefaults {
  return (
    selectRuntimeOptionDefaults(getUserPreferences(), projectPath) ?? NO_RUNTIME_OPTION_DEFAULTS
  );
}

// Changed leaves only (removed keys as null): resent unchanged fields would undo others' edits.
function changedLeaves(prev: unknown, next: Record<string, unknown>): Record<string, unknown> {
  const before = isOptionRecord(prev) ? prev : {};
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    const value = next[key];
    if (value !== before[key]) {
      patch[key] = isOptionRecord(value) ? changedLeaves(before[key], value) : (value ?? null);
    }
  }
  return patch;
}

export function updateRuntimeOptionDefaults(
  projectPath: string,
  update: (prev: RuntimeOptionDefaults) => RuntimeOptionDefaults
): void {
  const prev = readRuntimeOptionDefaults(projectPath);
  const byProject = { [projectPath]: { lastRuntimeConfig: changedLeaves(prev, update(prev)) } };
  updateUserPreferences({ workspaceCreation: { byProject } });
}

export interface SshOptionDefaults {
  host: string;
  coderEnabled: boolean;
  coderConfig: CoderWorkspaceConfig | null;
}

interface RuntimeOptionFieldMap {
  ssh: "host";
  docker: "image";
  devcontainer: "configPath";
}

export type RuntimeOptionFieldMode = keyof RuntimeOptionFieldMap;

export type RuntimeOptionField<TMode extends RuntimeOptionFieldMode> = RuntimeOptionFieldMap[TMode];

const isOptionRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const readOptionValue = (
  defaults: RuntimeOptionDefaults,
  mode: RuntimeMode,
  field: string
): unknown => {
  const modeConfig = defaults[mode];
  if (!isOptionRecord(modeConfig)) {
    return undefined;
  }

  return modeConfig[field];
};

const writeOptionValue = (
  prev: RuntimeOptionDefaults,
  mode: RuntimeMode,
  field: string,
  value: unknown
): RuntimeOptionDefaults => {
  const existing = prev[mode];
  const existingObj = isOptionRecord(existing) ? existing : {};

  return { ...prev, [mode]: { ...existingObj, [field]: value } };
};

const isCoderWorkspaceConfig = (value: unknown): value is CoderWorkspaceConfig => {
  return isOptionRecord(value);
};

export function readOptionField<TMode extends RuntimeOptionFieldMode>(
  defaults: RuntimeOptionDefaults,
  mode: TMode,
  field: RuntimeOptionField<TMode>,
  fallback: string
): string {
  const value = readOptionValue(defaults, mode, field);
  return typeof value === "string" ? value : fallback;
}

export function writeOptionField<TMode extends RuntimeOptionFieldMode>(
  prev: RuntimeOptionDefaults,
  mode: TMode,
  field: RuntimeOptionField<TMode>,
  value: string
): RuntimeOptionDefaults {
  return writeOptionValue(prev, mode, field, value);
}

export function readSshOptionDefaults(
  defaults: RuntimeOptionDefaults,
  fallbackHost: string
): SshOptionDefaults {
  const coderConfigValue = readOptionValue(defaults, RUNTIME_MODE.SSH, "coderConfig");

  return {
    host: readOptionField(defaults, RUNTIME_MODE.SSH, "host", fallbackHost),
    coderEnabled: readOptionValue(defaults, RUNTIME_MODE.SSH, "coderEnabled") === true,
    coderConfig: isCoderWorkspaceConfig(coderConfigValue) ? coderConfigValue : null,
  };
}

export function writeSshOptionDefaults(
  prev: RuntimeOptionDefaults,
  next: SshOptionDefaults
): RuntimeOptionDefaults {
  let updated = writeOptionValue(prev, RUNTIME_MODE.SSH, "coderEnabled", next.coderEnabled);

  if (next.host.trim().length > 0 && next.host !== CODER_RUNTIME_PLACEHOLDER) {
    updated = writeOptionField(updated, RUNTIME_MODE.SSH, "host", next.host);
  }

  if (next.coderConfig !== null) {
    updated = writeOptionValue(updated, RUNTIME_MODE.SSH, "coderConfig", next.coderConfig);
  }

  return updated;
}

/**
 * Settings-specific writer: updates Coder defaults while preserving mode memory.
 * Mode memory (coderEnabled) is owned by the creation flow's runtime selection;
 * settings edits should never change it.
 */
export function writeSshCoderDefaultsPreservingMode(
  prev: RuntimeOptionDefaults,
  nextCoderConfig: CoderWorkspaceConfig | null
): RuntimeOptionDefaults {
  const latest = readSshOptionDefaults(prev, "");
  return writeSshOptionDefaults(prev, {
    ...latest,
    coderEnabled: latest.coderEnabled,
    coderConfig: nextCoderConfig,
  });
}
