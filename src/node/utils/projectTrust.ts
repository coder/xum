import type { Config, SecretsStore } from "@/node/config";
import type { Secret } from "@/common/types/secrets";
import type { ProjectConfig, ProjectsConfig } from "@/common/types/project";
import { isWorkspaceDirTrustedBy } from "@/common/utils/sshDirectoryTrust";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { isSshSharedProjectDirRuntime, type RuntimeConfig } from "@/common/types/runtime";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type { Runtime } from "@/node/runtime/Runtime";

/**
 * The workspace fields that decide workspace-scoped trust. runtimeConfig is a required key
 * (possibly undefined) so every caller that builds this shape must say which runtime it has.
 */
export type WorkspaceTrustSubject = Pick<WorkspaceMetadata, "kind" | "projectPath"> & {
  runtimeConfig: RuntimeConfig | undefined;
};

/**
 * Whether the directory a workspace runs in is covered by trust, on a config the caller already
 * loaded. SSH+None runs in an existing host directory (projectDir) that is not the local project
 * and that collaborators may control, so project trust alone cannot vouch for it: the user must
 * also trust that exact directory for the project (trustedSshDirectories on the trust owner).
 * Every other runtime runs in a checkout the project owns, so this is true for it. Workspace
 * trust is project trust AND this.
 */
export function isWorkspaceDirTrusted(
  projects: ProjectsConfig["projects"],
  projectPath: string | null | undefined,
  runtimeConfig: RuntimeConfig | undefined
): boolean {
  if (!isSshSharedProjectDirRuntime(runtimeConfig)) return true;
  if (!projectPath) return false;
  return isWorkspaceDirTrustedBy(
    trustOwnerConfig(projects, projectPath)?.trustedSshDirectories,
    runtimeConfig
  );
}

/**
 * The project secrets to put in a workspace's process env (bash tool, init, MCP servers).
 * Secrets were configured for the local project, but an SSH+None workspace runs commands in a
 * host directory: until the user trusts that directory, a collaborator-controlled script there
 * (a test runner, a git hook) must not read GH_TOKEN and the like, so it gets no project secrets.
 * The config is loaded only for SSH+None.
 */
export function secretsForWorkspace(
  secretsStore: Pick<SecretsStore, "getEffectiveSecrets">,
  config: Pick<Config, "loadConfigOrDefault">,
  projectPath: string,
  runtimeConfig: RuntimeConfig | undefined
): Secret[] {
  if (
    isSshSharedProjectDirRuntime(runtimeConfig) &&
    !isWorkspaceDirTrusted(config.loadConfigOrDefault().projects, projectPath, runtimeConfig)
  ) {
    return [];
  }
  return secretsStore.getEffectiveSecrets(projectPath);
}

/**
 * Workspace-scoped trust. Scratch workspaces are app-owned (created trusted
 * under the _scratch system bucket), but their metadata.projectPath is the
 * per-chat workdir rather than a config key, so a plain path lookup would
 * wrongly report them untrusted.
 */
export function isWorkspaceProjectTrusted(
  config: Config,
  metadata: WorkspaceTrustSubject
): boolean {
  return isWorkspaceProjectTrustedIn(config.loadConfigOrDefault().projects, metadata);
}

/**
 * Repo-controlled configuration should only run or load after the user has
 * explicitly trusted the project.
 */
export function isProjectTrusted(config: Config, projectPath?: string | null): boolean {
  if (!projectPath) {
    return false;
  }
  return isProjectTrustedIn(config.loadConfigOrDefault().projects, projectPath);
}

/**
 * isWorkspaceProjectTrusted on a config the caller already loaded: no config read or stat
 * (#6426, for per-agent lookups in a turn).
 */
export function isWorkspaceProjectTrustedIn(
  projects: ProjectsConfig["projects"],
  metadata: WorkspaceTrustSubject
): boolean {
  if (!isWorkspaceDirTrusted(projects, metadata.projectPath, metadata.runtimeConfig)) {
    return false;
  }
  return metadata.kind === "scratch" || isProjectTrustedIn(projects, metadata.projectPath);
}

/** isProjectTrusted on a config the caller already loaded. */
export function isProjectTrustedIn(
  projects: ProjectsConfig["projects"],
  projectPath?: string | null
): boolean {
  if (!projectPath) {
    return false;
  }
  return trustOwnerConfig(projects, projectPath)?.trusted ?? false;
}

/** The trust owner's config: a sub-project's parent, else the project itself. */
function trustOwnerConfig(
  projects: ProjectsConfig["projects"],
  projectPath: string
): ProjectConfig | undefined {
  const normalizedProjectPath = stripTrailingSlashes(projectPath);
  const project = projects.get(normalizedProjectPath);
  return projects.get(project?.parentProjectPath ?? normalizedProjectPath);
}

/** The path whose config holds trust for `projectPath`: a sub-project's parent, else itself. */
export function trustOwnerPathIn(
  projects: ProjectsConfig["projects"],
  projectPath: string
): string {
  const normalizedProjectPath = stripTrailingSlashes(projectPath);
  return projects.get(normalizedProjectPath)?.parentProjectPath ?? normalizedProjectPath;
}

/**
 * #6426: a project's own Agent Plugins are one trust unit. Their skills and agents load only in a
 * trusted project, as their MCP servers, hooks and slash commands do (computeAgentPluginContainers),
 * and never under the project-automation kill switch. Missing trust means untrusted.
 */
export function projectPluginsAllowed(projectPluginsTrusted: boolean | undefined): boolean {
  return projectPluginsTrusted === true && !projectAutomationDisabled();
}

/**
 * #6426: the plugin container dirs of a project (`.xum/plugins`, `.mux/plugins`,
 * `.agents/plugins` under `projectSearchRoot`), or none when projectPluginsAllowed is false.
 */
export function projectPluginContainerPaths(
  runtime: Pick<Runtime, "normalizePath">,
  projectSearchRoot: string,
  projectPluginsTrusted: boolean | undefined
): string[] {
  if (!projectPluginsAllowed(projectPluginsTrusted)) return [];
  return [
    ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
      runtime.normalizePath(relativePath, projectSearchRoot)
    ),
    runtime.normalizePath(".agents/plugins", projectSearchRoot),
  ];
}
