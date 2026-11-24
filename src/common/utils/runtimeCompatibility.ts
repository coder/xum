/**
 * Runtime configuration compatibility checks.
 *
 * This module is intentionally in common/ to avoid circular dependencies
 * with runtime implementations (LocalRuntime, SSHRuntime, etc.).
 */

import { RuntimeModeSchema } from "@/common/orpc/schemas/runtime";
import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Check if a runtime config is from a newer version and incompatible.
 *
 * This handles downgrade compatibility: if a user upgrades to a version
 * with new runtime types, then downgrades, those workspaces should show
 * a clear error rather than crashing.
 *
 * Currently supported types:
 * - "local" without srcBaseDir: Project-dir runtime (uses project path directly)
 * - "local" with srcBaseDir: Legacy worktree config (for backward compat)
 * - "worktree": Explicit worktree runtime
 * - "ssh": Remote SSH runtime
 * - "docker": Docker container runtime
 */
export function isIncompatibleRuntimeConfig(config: RuntimeConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  // Unknown type from a future version
  return !RuntimeModeSchema.safeParse(config.type).success;
}
