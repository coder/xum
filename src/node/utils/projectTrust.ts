import type { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
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
 * SSH+None runs in an existing host directory (projectDir) that collaborators may control.
 * Project trust is keyed to the local project path, and nothing binds it to that directory's
 * contents (changing projectDir prompts nothing), so trust never covers it: repo-controlled
 * automation from it (init hook, tool hooks, project agents/skills/plugins/MCP) stays off.
 */
export function workspaceDirOutsideProjectTrust(runtimeConfig: RuntimeConfig | undefined): boolean {
  return isSshSharedProjectDirRuntime(runtimeConfig);
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
  if (workspaceDirOutsideProjectTrust(metadata.runtimeConfig)) {
    return false;
  }
  if (metadata.kind === "scratch") {
    return true;
  }
  return isProjectTrusted(config, metadata.projectPath);
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
  if (workspaceDirOutsideProjectTrust(metadata.runtimeConfig)) {
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
  const normalizedProjectPath = stripTrailingSlashes(projectPath);
  const project = projects.get(normalizedProjectPath);
  const trustOwnerPath = project?.parentProjectPath ?? normalizedProjectPath;
  return projects.get(trustOwnerPath)?.trusted ?? false;
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
