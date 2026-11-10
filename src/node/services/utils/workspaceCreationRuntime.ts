import type { Runtime } from "@/node/runtime/Runtime";
import { isSshSharedProjectDirRuntime, type RuntimeConfig } from "@/common/types/runtime";

/**
 * Why workspace creation must refuse this runtime config before any per-workspace state exists,
 * or null when it may proceed.
 */
export function creationRuntimeConfigError(
  runtimeConfig: RuntimeConfig,
  normalizedTrunkBranch: string
): string | null {
  // SSH+None runs in an existing directory on the host, so it needs that directory's path.
  if (isSshSharedProjectDirRuntime(runtimeConfig) && !runtimeConfig.projectDir?.trim()) {
    return "Enter the project directory on the SSH host: workspaces without isolation run in it directly";
  }
  // Project-dir runtimes (local, SSH+None) check out no branch, so they need no trunk branch;
  // worktree/SSH runtimes require it.
  const isProjectDirRuntime =
    runtimeConfig.type === "local" || isSshSharedProjectDirRuntime(runtimeConfig);
  if (!isProjectDirRuntime && normalizedTrunkBranch.length === 0) {
    return "Trunk branch is required for worktree and SSH runtimes";
  }
  return null;
}

/**
 * The SSH+None config whose projectDir creation should resolve on the host (~ expanded, made
 * absolute) before persisting it, like srcBaseDir; null for every other runtime, and when the
 * runtime cannot be reached yet (deferredRuntimeAccess, e.g. Coder before its workspace exists).
 */
export function sshProjectDirConfigToResolve(
  runtimeConfig: RuntimeConfig,
  runtime: Pick<Runtime, "createFlags">
): (Extract<RuntimeConfig, { type: "ssh" }> & { projectDir: string }) | null {
  if (
    !isSshSharedProjectDirRuntime(runtimeConfig) ||
    runtimeConfig.projectDir == null ||
    runtime.createFlags?.deferredRuntimeAccess
  ) {
    return null;
  }
  return { ...runtimeConfig, projectDir: runtimeConfig.projectDir };
}
