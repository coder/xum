import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import type { ProjectsConfig } from "@/common/types/project";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";

export function isWorkspaceTrustedForSharedExecution(
  metadata: WorkspaceMetadata,
  projectsConfig: ProjectsConfig["projects"]
): boolean {
  // Scratch chats are app-owned and created trusted under the _scratch system
  // bucket; their metadata.projectPath is the per-chat workdir, which is never
  // a config key, so the path lookup below would wrongly report untrusted.
  if (metadata.kind === "scratch") {
    return true;
  }

  if (!isMultiProject(metadata)) {
    return projectsConfig.get(stripTrailingSlashes(metadata.projectPath))?.trusted ?? false;
  }

  // Multi-project workspaces share a single runtime/container, so one untrusted repo must disable
  // trusted behavior for the whole execution environment.
  return getProjects(metadata).every(
    (project) => projectsConfig.get(stripTrailingSlashes(project.projectPath))?.trusted ?? false
  );
}
