import type { ProjectConfig, Workspace } from "@/common/types/project";

/**
 * Shared-checkout (isolation: "none") task workspaces do not own a checkout: they run in their
 * nearest non-shared ancestor's. Deriving path and trunk branch on read keeps them on the owner's
 * current checkout after an owner rename, and heals entries persisted before such a rename
 * without a migration. Saves derive again, so the write that moves an owner also persists its
 * children's new values for older builds and external readers of config.json.
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
      // Config JSON is unvalidated at runtime; never copy a corrupted owner value.
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
