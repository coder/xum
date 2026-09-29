import type { RuntimeConfig } from "@/common/types/runtime";
import { isDevcontainerRuntime, isDockerRuntime, isSSHRuntime } from "@/common/types/runtime";
import { resolveCoderSSHHost } from "@/constants/coder";

/**
 * Default xum home directory for plan storage.
 * Uses tilde prefix for portability across local runtimes. Docker retains its
 * established /var/mux contract and passes that path explicitly.
 */
const DEFAULT_XUM_HOME = "~/.xum";

/**
 * Get the plan file path for a workspace.
 * Returns a path that works with the specified runtime's xum home directory.
 *
 * Plan files are stored at: {xumHome}/plans/{projectName}/{workspaceName}.md
 *
 * Workspace names include a random suffix (e.g., "sidebar-a1b2") making them
 * globally unique with high probability. The project folder is for organization
 * and discoverability, not uniqueness.
 *
 * @param workspaceName - Human-readable workspace name with suffix (e.g., "fix-plan-a1b2")
 * @param projectName - Project name extracted from the project path
 * @param xumHome - Xum home directory (default: ~/.xum; Docker uses /var/mux)
 */
export function getPlanFilePath(
  workspaceName: string,
  projectName: string,
  xumHome = DEFAULT_XUM_HOME
): string {
  return `${xumHome}/plans/${projectName}/${workspaceName}.md`;
}

/**
 * Get the legacy plan file path (stored by workspace ID).
 * Used for migration: when reading, check new path first, then fall back to legacy.
 * Rooted in the active runtime home so SSH (`~/.mux`) and Docker (`/var/mux`)
 * do not look at the local canonical `~/.xum` tree.
 *
 * @param workspaceId - Stable workspace identifier (e.g., "a1b2c3d4e5")
 * @param xumHome - Runtime xum home (local ~/.xum, SSH ~/.mux, Docker /var/mux)
 */
export function getLegacyPlanFilePath(workspaceId: string, xumHome: string): string {
  return `${xumHome}/plans/${workspaceId}.md`;
}

/**
 * Where a runtime keeps its plan files: the local home for local and worktree runtimes, the home
 * on the SSH endpoint the runtime connects to. Docker and devcontainer plans live inside their own
 * container and are never shared (undefined).
 */
function planStorageOf(
  runtimeConfig: RuntimeConfig
): { kind: "local" } | { kind: "ssh"; host: string; port?: number } | undefined {
  if (isDockerRuntime(runtimeConfig) || isDevcontainerRuntime(runtimeConfig)) return undefined;
  if (!isSSHRuntime(runtimeConfig)) return { kind: "local" };
  // The endpoint runtimeFactory connects to (#5043): a Coder workspace's host is a placeholder,
  // and its SSH host is derived from the Coder workspace name.
  return {
    kind: "ssh",
    host: resolveCoderSSHHost(runtimeConfig.host, runtimeConfig.coder?.workspaceName),
    port: runtimeConfig.port,
  };
}

/**
 * Whether two workspaces may keep their plans in the same place, for "does another workspace use
 * this plan path". It errs towards sharing, which keeps a plan: an unset SSH port is whatever the
 * SSH config says, so it may be the other workspace's port.
 */
export function sharesPlanStorage(a: RuntimeConfig, b: RuntimeConfig): boolean {
  const storageA = planStorageOf(a);
  const storageB = planStorageOf(b);
  if (storageA === undefined || storageB === undefined) return false;
  if (storageA.kind === "local" || storageB.kind === "local")
    return storageA.kind === storageB.kind;
  return (
    storageA.host === storageB.host &&
    (storageA.port === undefined || storageB.port === undefined || storageA.port === storageB.port)
  );
}

/**
 * Whether two workspaces keep their plans in one directory: plans/<projectName>/ on shared plan
 * storage. Plans key on the project basename, so same-basename projects share that directory, and a
 * workspace name in it is taken for all of them (#5139). Name checks and the removal's
 * "another workspace uses this plan path" guard use this one predicate so they cannot disagree.
 */
export function sharesPlanDirectory(
  a: { projectName: string; runtimeConfig: RuntimeConfig },
  b: { projectName: string; runtimeConfig: RuntimeConfig }
): boolean {
  // Case-insensitive: on the default macOS and Windows filesystems `App` and `app` are one
  // directory. On a case-sensitive one this only errs towards sharing, which refuses a name or
  // keeps a plan, never overwrites one.
  return (
    a.projectName.toLowerCase() === b.projectName.toLowerCase() &&
    sharesPlanStorage(a.runtimeConfig, b.runtimeConfig)
  );
}
