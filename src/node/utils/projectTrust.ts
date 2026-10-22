import type { Config } from "@/node/config";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type { Runtime } from "@/node/runtime/Runtime";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { projectAutomationDisabled } from "@/node/utils/projectAutomation";

/**
 * Workspace-scoped trust. Scratch workspaces are app-owned (created trusted
 * under the _scratch system bucket), but their metadata.projectPath is the
 * per-chat workdir rather than a config key, so a plain path lookup would
 * wrongly report them untrusted.
 */
export function isWorkspaceProjectTrusted(
  config: Config,
  metadata: Pick<WorkspaceMetadata, "kind" | "projectPath">
): boolean {
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
  metadata: Pick<WorkspaceMetadata, "kind" | "projectPath">
): boolean {
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
 * #6426: a project's Agent Plugins container paths under `root`, or undefined when its plugins
 * must not load (see projectPluginsAllowed).
 */
export function projectPluginContainerPaths(
  runtime: Runtime,
  root: string,
  projectPluginsTrusted: boolean | undefined
): string[] | undefined {
  if (!projectPluginsAllowed(projectPluginsTrusted)) return undefined;
  return [
    ...listProjectMetadataRelativePaths("plugins").map((relativePath) =>
      runtime.normalizePath(relativePath, root)
    ),
    runtime.normalizePath(".agents/plugins", root),
  ];
}
