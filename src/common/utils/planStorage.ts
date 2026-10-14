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
 * Where an SSH or Coder workspace keeps its plan on the host (#5174):
 * {xumHome}/plans/installation-{installationId}/{remoteProjectId}/{workspaceName}.md.
 *
 * Every Xum installation that uses one SSH host shares its ~/.mux, and each one's name guards
 * see only its own config, so plans/{projectName}/{workspaceName}.md (getPlanFilePath) was one
 * file for two installations' workspaces. The installation UUID (installationIdentity.ts) splits
 * the tree per installation; the remote project id (createRemoteProjectId, the key of the remote
 * checkout) splits it per local project path, so same-basename projects no longer share a
 * directory there either.
 */
export function getInstallationScopedPlanFilePath(
  workspaceName: string,
  remoteProjectId: string,
  installationId: string,
  xumHome: string
): string {
  return `${xumHome}/plans/installation-${installationId}/${remoteProjectId}/${workspaceName}.md`;
}

/** Whether this runtime keeps plans in the installation-scoped tree on a shared SSH host. */
export function usesInstallationScopedPlans(runtimeConfig: RuntimeConfig): boolean {
  // Coder workspaces are SSH runtimes too. Docker and devcontainer plans live inside their own
  // container, local plans in this installation's own home: neither is shared.
  return isSSHRuntime(runtimeConfig);
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
 * Split an SSH destination (`host`, `user@host`) into user and host. The host stays as spelled:
 * ssh_config `Host` patterns match it case-sensitively, and OpenSSH keeps brackets (`[::1]` is
 * not `::1` to it), so normalizing either would merge endpoints ssh can route apart.
 */
function parseSSHEndpoint(destination: string): { user?: string; host: string } {
  const trimmed = destination.trim();
  // lastIndexOf: an `@` in the user part is legal, never in the host part.
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0) return { host: atIndex === 0 ? trimmed.slice(1) : trimmed };
  return { user: trimmed.slice(0, atIndex), host: trimmed.slice(atIndex + 1) };
}

/**
 * Where a runtime keeps its plan files: the local home for local and worktree runtimes, the home
 * on the SSH endpoint the runtime connects to. Docker and devcontainer plans live inside their own
 * container and are never shared (undefined).
 */
function planStorageOf(
  runtimeConfig: RuntimeConfig
): { kind: "local" } | { kind: "ssh"; host: string; user?: string; port?: number } | undefined {
  if (isDockerRuntime(runtimeConfig) || isDevcontainerRuntime(runtimeConfig)) return undefined;
  if (!isSSHRuntime(runtimeConfig)) return { kind: "local" };
  // The endpoint runtimeFactory connects to (#5043): a Coder workspace's host is a placeholder,
  // and its SSH host is derived from the Coder workspace name.
  const endpoint = parseSSHEndpoint(
    resolveCoderSSHHost(runtimeConfig.host, runtimeConfig.coder?.workspaceName)
  );
  return { kind: "ssh", ...endpoint, port: runtimeConfig.port };
}

/**
 * Whether two workspaces may keep their plans in the same place, for "does another workspace use
 * this plan path". It compares SSH endpoints, not destination spellings (#5180): `box` and
 * `me@box` are one remote home. It errs towards sharing, which keeps a plan or refuses a name:
 * an unset SSH user or port is whatever the SSH config (or the local user name) says, so it may be
 * the other workspace's. That also covers an ssh_config `User` override without reading
 * ssh_config here.
 *
 * Known gap: no ssh_config `HostName` resolution, so an alias (`Host box-alias` → `HostName box`)
 * and its target, or a short name and its FQDN, still count as different storage.
 */
export function sharesPlanStorage(a: RuntimeConfig, b: RuntimeConfig): boolean {
  const storageA = planStorageOf(a);
  const storageB = planStorageOf(b);
  if (storageA === undefined || storageB === undefined) return false;
  if (storageA.kind === "local" || storageB.kind === "local")
    return storageA.kind === storageB.kind;
  const unsetOrEqual = <T>(x: T | undefined, y: T | undefined) =>
    x === undefined || y === undefined || x === y;
  return (
    storageA.host === storageB.host &&
    unsetOrEqual(storageA.user, storageB.user) &&
    unsetOrEqual(storageA.port, storageB.port)
  );
}

/**
 * Whether two workspaces keep their plans in one directory on shared plan storage, so a workspace
 * name in it is taken for both. Name checks and the removal's "another workspace uses this plan
 * path" guard use this one predicate so they cannot disagree.
 *
 * Local plans live in plans/<projectName>/, which same-basename projects share (#5139). SSH plans
 * live in plans/installation-<id>/<remote project id>/ (getInstallationScopedPlanFilePath, #5174):
 * the remote project id hashes the local project path, so there only workspaces of one project
 * path share a directory (another installation's live in its own tree, which no guard sees).
 */
export function sharesPlanDirectory(
  a: { projectName: string; projectPath: string; runtimeConfig: RuntimeConfig },
  b: { projectName: string; projectPath: string; runtimeConfig: RuntimeConfig }
): boolean {
  if (!sharesPlanStorage(a.runtimeConfig, b.runtimeConfig)) return false;
  if (
    usesInstallationScopedPlans(a.runtimeConfig) &&
    usesInstallationScopedPlans(b.runtimeConfig)
  ) {
    // The path createRemoteProjectId hashes (backslashes normalized); trailing slashes are
    // stripped from config paths, but compare without them so a stray one cannot split a
    // directory and let a name through.
    const key = (projectPath: string) => projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return key(a.projectPath) === key(b.projectPath);
  }
  // Case-insensitive: on the default macOS and Windows filesystems `App` and `app` are one
  // directory. On a case-sensitive one this only errs towards sharing, which refuses a name or
  // keeps a plan, never overwrites one.
  return a.projectName.toLowerCase() === b.projectName.toLowerCase();
}
