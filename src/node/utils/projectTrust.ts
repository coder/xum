import type { Config } from "@/node/config";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

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

  const projects = config.loadConfigOrDefault().projects;
  const normalizedProjectPath = stripTrailingSlashes(projectPath);
  const project = projects.get(normalizedProjectPath);
  const trustOwnerPath = project?.parentProjectPath ?? normalizedProjectPath;
  return projects.get(trustOwnerPath)?.trusted ?? false;
}
