import type { ProjectConfig, Workspace } from "@/common/types/project";

/**
 * Shared tasks borrow their nearest non-shared ancestor's checkout. Deriving on load follows owner
 * renames and heals entries persisted before one without a migration; deriving on save keeps
 * config.json correct for older builds.
 */
export function deriveSharedTaskCheckouts(projects: Map<string, ProjectConfig>): void {
  const workspacesById = new Map<string, Workspace>();
  for (const projectConfig of projects.values()) {
    for (const workspace of projectConfig.workspaces) {
      if (workspace.id) {
        workspacesById.set(workspace.id, workspace);
      }
    }
  }

  for (const projectConfig of projects.values()) {
    for (const workspace of projectConfig.workspaces) {
      if (workspace.taskIsolation !== "none" || !workspace.parentWorkspaceId) {
        continue;
      }
      const owner = findCheckoutOwner(workspace, workspacesById);
      if (!owner) {
        continue;
      }
      // Path and name are not schema-validated; ignore invalid persisted owner values.
      if (typeof owner.path === "string" && owner.path.length > 0) {
        workspace.path = owner.path;
      }
      if (typeof owner.name === "string" && owner.name.length > 0) {
        workspace.taskTrunkBranch = owner.name;
      }
    }
  }
}

function findCheckoutOwner(
  workspace: Workspace,
  workspacesById: Map<string, Workspace>
): Workspace | undefined {
  const visited = new Set<Workspace>([workspace]);
  let current = workspace;
  while (current.taskIsolation === "none") {
    const parentId = current.parentWorkspaceId;
    const parent = parentId ? workspacesById.get(parentId) : undefined;
    if (!parent || visited.has(parent)) {
      return undefined;
    }
    visited.add(parent);
    current = parent;
  }
  return current;
}
