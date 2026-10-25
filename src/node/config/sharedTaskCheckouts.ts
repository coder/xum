import type { ProjectConfig, Workspace } from "@/common/types/project";

/**
 * Shared tasks borrow their nearest non-shared ancestor's checkout, so their path follows the
 * owner's current path. taskTrunkBranch keeps its spawn-time value because a workspace rename does
 * not always rename the branch (SSH moves only the directory). Returns whether any path changed so
 * load can persist the repair for older builds.
 */
export function deriveSharedTaskCheckouts(projects: Map<string, ProjectConfig>): boolean {
  const workspacesById = new Map<string, Workspace>();
  for (const projectConfig of projects.values()) {
    for (const workspace of projectConfig.workspaces) {
      if (workspace.id) {
        workspacesById.set(workspace.id, workspace);
      }
    }
  }

  let changed = false;
  for (const projectConfig of projects.values()) {
    for (const workspace of projectConfig.workspaces) {
      if (workspace.taskIsolation !== "none" || !workspace.parentWorkspaceId) {
        continue;
      }
      const ownerPath = findCheckoutOwner(workspace, workspacesById)?.path;
      // Paths are not schema-validated; ignore invalid persisted owner values.
      if (typeof ownerPath !== "string" || ownerPath.length === 0 || ownerPath === workspace.path) {
        continue;
      }
      workspace.path = ownerPath;
      changed = true;
    }
  }
  return changed;
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
