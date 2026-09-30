/**
 * Runtime configuration types for workspace execution environments
 */

import type { z } from "zod";
import type { RuntimeConfigSchema } from "../orpc/schemas";
import { RuntimeEnablementIdSchema, RuntimeModeSchema } from "../orpc/schemas";
import type { CoderWorkspaceConfig } from "../orpc/schemas/coder";

// Re-export CoderWorkspaceConfig type from schema (single source of truth)
export type { CoderWorkspaceConfig };

/** Runtime mode type - used in UI and runtime string parsing */
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

/** Runtime mode constants */
export const RUNTIME_MODE = {
  LOCAL: "local" as const,
  WORKTREE: "worktree" as const,
  SSH: "ssh" as const,
  DOCKER: "docker" as const,
  DEVCONTAINER: "devcontainer" as const,
} as const;

/**
 * Runtime modes whose sub-agent fork creates a *separate* checkout from the parent workspace.
 * For these, the task tool may offer `isolation: "none"` to skip the fork and run the sub-agent
 * directly in the parent's checkout (shared working tree), avoiding fork + init overhead for
 * read-only analysis or when isolation is handled via the prompt.
 *
 * - `local` already shares the project directory (forking is a no-op), so it never exposes the
 *   option — the parameter must not even appear in the tool schema for local runtimes.
 * - `docker`/`devcontainer` derive their runtime identity (container) from the workspace name in
 *   the runtime factory, so a differently-named workspace cannot currently resolve the parent's
 *   container. They are intentionally excluded until that identity override exists.
 */
export const SHARED_TASK_WORKSPACE_RUNTIME_MODES: readonly RuntimeMode[] = [
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.SSH,
];

/**
 * Whether sub-agents on this runtime mode can opt out of forking via `isolation: "none"` and share
 * the parent workspace's checkout instead. See {@link SHARED_TASK_WORKSPACE_RUNTIME_MODES}.
 */
export function runtimeModeSupportsSharedTaskWorkspace(mode: RuntimeMode | undefined): boolean {
  return mode != null && SHARED_TASK_WORKSPACE_RUNTIME_MODES.includes(mode);
}

/**
 * Runtime IDs that can be enabled/disabled in Settings → Runtimes.
 * Note: includes "coder" which is a UI-level choice (not a RuntimeMode).
 */
export const RUNTIME_ENABLEMENT_IDS = RuntimeEnablementIdSchema.options;

export type RuntimeEnablementId = z.infer<typeof RuntimeEnablementIdSchema>;

export type RuntimeEnablement = Record<RuntimeEnablementId, boolean>;

export const DEFAULT_RUNTIME_ENABLEMENT: RuntimeEnablement = {
  local: true,
  worktree: true,
  ssh: true,
  coder: true,
  docker: true,
  devcontainer: true,
};

/**
 * Normalize runtime enablement, defaulting missing/invalid keys to true.
 */
export function normalizeRuntimeEnablement(value: unknown): RuntimeEnablement {
  const normalized: RuntimeEnablement = { ...DEFAULT_RUNTIME_ENABLEMENT };

  if (!value || typeof value !== "object") {
    return normalized;
  }

  const record = value as Record<string, unknown>;
  for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
    const entry = record[runtimeId];
    if (typeof entry === "boolean") {
      normalized[runtimeId] = entry;
    }
  }

  return normalized;
}

/** Runtime string prefix for SSH mode (e.g., "ssh hostname") */
export const SSH_RUNTIME_PREFIX = "ssh ";

/** Runtime string prefix for Docker mode (e.g., "docker ubuntu:22.04") */
export const DOCKER_RUNTIME_PREFIX = "docker ";

/** Runtime string prefix for Devcontainer mode (e.g., "devcontainer .devcontainer/devcontainer.json") */
export const DEVCONTAINER_RUNTIME_PREFIX = "devcontainer ";

/** Placeholder host for Coder SSH runtimes (where host is derived from Coder config) */
export const CODER_RUNTIME_PLACEHOLDER = "coder://";

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Parsed runtime result - discriminated union based on mode.
 * SSH requires host, Docker requires image, others have no extra args.
 */
export type ParsedRuntime =
  | { mode: "local" }
  | { mode: "worktree" }
  | { mode: "ssh"; host: string; coder?: CoderWorkspaceConfig }
  | { mode: "docker"; image: string; shareCredentials?: boolean }
  | { mode: "devcontainer"; configPath: string; shareCredentials?: boolean };

/**
 * Parse runtime string from localStorage or UI input into structured result.
 * Format: "ssh <host>" -> { mode: "ssh", host: "<host>" }
 *         "docker <image>" -> { mode: "docker", image: "<image>" }
 *         "worktree" -> { mode: "worktree" }
 *         "local" -> { mode: "local" }
 *         undefined/null -> { mode: "worktree" } (default)
 *
 * Note: "ssh" or "docker" without arguments returns null (invalid).
 * Use this for UI state management (localStorage, form inputs).
 */
export function parseRuntimeModeAndHost(runtime: string | null | undefined): ParsedRuntime | null {
  if (!runtime) {
    return { mode: RUNTIME_MODE.WORKTREE };
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (lowerTrimmed === RUNTIME_MODE.LOCAL) {
    return { mode: RUNTIME_MODE.LOCAL };
  }

  if (lowerTrimmed === RUNTIME_MODE.WORKTREE) {
    return { mode: RUNTIME_MODE.WORKTREE };
  }

  // Check for "ssh <host>" format
  if (lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.substring(SSH_RUNTIME_PREFIX.length).trim();
    if (!host) return null; // "ssh " without host is invalid
    return { mode: RUNTIME_MODE.SSH, host };
  }

  // Plain "ssh" without host is invalid
  if (lowerTrimmed === RUNTIME_MODE.SSH) {
    return null;
  }

  // Check for "docker <image>" format
  if (lowerTrimmed.startsWith(DOCKER_RUNTIME_PREFIX)) {
    const image = trimmed.substring(DOCKER_RUNTIME_PREFIX.length).trim();
    if (!image) return null; // "docker " without image is invalid
    return { mode: RUNTIME_MODE.DOCKER, image };
  }

  // Plain "docker" without image is invalid
  if (lowerTrimmed === RUNTIME_MODE.DOCKER) {
    return null;
  }

  // Check for "devcontainer <configPath>" format (config path is optional)
  if (lowerTrimmed.startsWith(DEVCONTAINER_RUNTIME_PREFIX)) {
    const configPath = trimmed.substring(DEVCONTAINER_RUNTIME_PREFIX.length).trim();
    return { mode: RUNTIME_MODE.DEVCONTAINER, configPath };
  }

  if (lowerTrimmed === RUNTIME_MODE.DEVCONTAINER) {
    return { mode: RUNTIME_MODE.DEVCONTAINER, configPath: "" };
  }

  // Try to parse as a plain mode (local/worktree/devcontainer)
  const modeResult = RuntimeModeSchema.safeParse(lowerTrimmed);
  if (modeResult.success) {
    const mode = modeResult.data;
    if (mode === "local") return { mode: "local" };
    if (mode === "worktree") return { mode: "worktree" };
    if (mode === "devcontainer") return { mode: "devcontainer", configPath: "" };
    // ssh/docker without args handled above
  }

  // Unrecognized - return null
  return null;
}

/**
 * Build runtime string for storage/IPC from parsed runtime.
 * Returns: "ssh <host>" for SSH, "docker <image>" for Docker, "local" for local, undefined for worktree (default)
 */
export function buildRuntimeString(parsed: ParsedRuntime): string | undefined {
  switch (parsed.mode) {
    case RUNTIME_MODE.SSH:
      return `${SSH_RUNTIME_PREFIX}${parsed.host}`;
    case RUNTIME_MODE.DOCKER:
      return `${DOCKER_RUNTIME_PREFIX}${parsed.image}`;
    case RUNTIME_MODE.LOCAL:
      return "local";
    case RUNTIME_MODE.DEVCONTAINER: {
      const configPath = parsed.configPath.trim();
      return configPath.length > 0
        ? `${DEVCONTAINER_RUNTIME_PREFIX}${configPath}`
        : RUNTIME_MODE.DEVCONTAINER;
    }
    case RUNTIME_MODE.WORKTREE:
      // Worktree is default, no string needed
      return undefined;
  }
}

/**
 * Convert ParsedRuntime to RuntimeConfig for workspace creation.
 * This preserves all fields (like shareCredentials for Docker) that would be lost
 * in string serialization via buildRuntimeString + parseRuntimeString.
 */
export function buildRuntimeConfig(parsed: ParsedRuntime): RuntimeConfig | undefined {
  switch (parsed.mode) {
    case RUNTIME_MODE.SSH:
      return {
        type: RUNTIME_MODE.SSH,
        host: parsed.host.trim(),
        srcBaseDir: "~/mux", // Default remote base directory (tilde resolved by backend)
        coder: parsed.coder,
      };
    case RUNTIME_MODE.DOCKER:
      return {
        type: RUNTIME_MODE.DOCKER,
        image: parsed.image.trim(),
        shareCredentials: parsed.shareCredentials,
      };
    case RUNTIME_MODE.LOCAL:
      return { type: RUNTIME_MODE.LOCAL };
    case RUNTIME_MODE.DEVCONTAINER:
      return {
        type: RUNTIME_MODE.DEVCONTAINER,
        configPath: parsed.configPath.trim(),
        shareCredentials: parsed.shareCredentials,
      };
    case RUNTIME_MODE.WORKTREE:
      // Worktree uses system default config
      return undefined;
  }
}

/**
 * Type guard to check if a runtime config is SSH
 */
export function isSSHRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "ssh" }> {
  return config?.type === "ssh";
}

/**
 * Type guard to check if a runtime config is Docker
 */
export function isDockerRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "docker" }> {
  return config?.type === "docker";
}

/**
 * Type guard to check if a runtime config is Devcontainer
 */
export function isDevcontainerRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "devcontainer" }> {
  return config?.type === "devcontainer";
}

/**
 * Type guard to check if a runtime config uses worktree semantics.
 * This includes both explicit "worktree" type AND legacy "local" with srcBaseDir.
 */
export function isWorktreeRuntime(
  config: RuntimeConfig | undefined
): config is
  | Extract<RuntimeConfig, { type: "worktree" }>
  | Extract<RuntimeConfig, { type: "local"; srcBaseDir: string }> {
  if (!config) return false;
  if (config.type === "worktree") return true;
  // Legacy: "local" with srcBaseDir is treated as worktree. Any string counts, including a legacy
  // empty one, because createRuntime builds a WorktreeRuntime for it (#5118).
  if (config.type === "local" && hasSrcBaseDir(config)) return true;
  return false;
}

/**
 * Type guard to check if a runtime config is project-dir local (no isolation)
 */
export function isLocalProjectRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "local"; srcBaseDir?: never }> {
  if (!config) return false;
  // "local" without srcBaseDir is project-dir runtime (same string test as createRuntime, #5118)
  return config.type === "local" && !hasSrcBaseDir(config);
}

/**
 * Type guard to check if a runtime config has srcBaseDir (worktree-style runtimes).
 * This narrows the type to allow safe access to srcBaseDir.
 */
export function hasSrcBaseDir(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { srcBaseDir: string }> {
  if (!config) return false;
  return "srcBaseDir" in config && typeof config.srcBaseDir === "string";
}

/**
 * Helper to safely get srcBaseDir from a runtime config.
 * Returns undefined for project-dir local configs.
 */
export function getSrcBaseDir(config: RuntimeConfig | undefined): string | undefined {
  if (!config) return undefined;
  if (hasSrcBaseDir(config)) return config.srcBaseDir;
  return undefined;
}

/** Devcontainer config info for availability selection */
export interface DevcontainerConfigInfo {
  path: string;
  label: string;
}

/**
 * Runtime availability status - discriminated union that can carry mode-specific data.
 * Most runtimes use the simple available/unavailable shape; devcontainer carries extra
 * config info when available.
 */
export type RuntimeAvailabilityStatus =
  | { available: true }
  | { available: true; configs: DevcontainerConfigInfo[]; cliVersion?: string }
  | { available: false; reason: string };

/**
 * Helper to extract devcontainer configs from availability status.
 * Returns empty array if not a devcontainer availability or not available.
 */
export function getDevcontainerConfigs(
  status: RuntimeAvailabilityStatus
): DevcontainerConfigInfo[] {
  if (status.available && "configs" in status) {
    return status.configs;
  }
  return [];
}
