import type { Secret } from "@/common/types/secrets";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { getProjects, isMultiProject } from "@/common/utils/multiProject";
import type { Config, SecretsStore } from "@/node/config";
import { secretsForWorkspace } from "@/node/utils/projectTrust";

export function mergeMultiProjectSecrets(
  metadata: WorkspaceMetadata,
  secretsStore: Pick<SecretsStore, "getEffectiveSecrets">
): Secret[] {
  const projects = getProjects(metadata);
  const primaryProject = projects.find((project) => project.projectPath === metadata.projectPath);
  const orderedProjects = primaryProject
    ? [
        primaryProject,
        ...projects.filter((project) => project.projectPath !== metadata.projectPath),
      ]
    : projects;

  const seen = new Set<string>();
  const merged: Secret[] = [];

  // Primary project secrets win on collisions so multi-project bash/AI keep single-project precedence.
  for (const project of orderedProjects) {
    const secrets = secretsStore.getEffectiveSecrets(project.projectPath);
    for (const secret of secrets) {
      if (seen.has(secret.key)) {
        continue;
      }
      seen.add(secret.key);
      merged.push(secret);
    }
  }

  return merged;
}

/**
 * The secrets a workspace's commands get: every project's for a multi-project workspace, and
 * none for an SSH+None workspace whose host directory is not trusted (`secretsForWorkspace`).
 */
export function workspaceSecrets(
  metadata: WorkspaceMetadata,
  secretsStore: Pick<SecretsStore, "getEffectiveSecrets">,
  config: Pick<Config, "loadConfigOrDefault">
): Secret[] {
  return isMultiProject(metadata)
    ? mergeMultiProjectSecrets(metadata, secretsStore)
    : secretsForWorkspace(secretsStore, config, metadata.projectPath, metadata.runtimeConfig);
}
