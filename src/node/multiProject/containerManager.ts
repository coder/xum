import assert from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";

export interface ProjectWorkspaceEntry {
  projectName: string;
  workspacePath: string;
}

export class ContainerManager {
  constructor(private readonly srcBaseDir: string) {}

  private get containerBase(): string {
    return path.join(this.srcBaseDir, "_workspaces");
  }

  getContainerPath(workspaceName: string): string {
    return path.join(this.containerBase, workspaceName);
  }

  /** The container entry (a symlink to the project's checkout) execution reaches a project by. */
  getProjectEntryPath(workspaceName: string, projectName: string): string {
    return path.join(this.getContainerPath(workspaceName), projectName);
  }

  async createContainer(
    workspaceName: string,
    projectWorkspaces: ProjectWorkspaceEntry[]
  ): Promise<string> {
    // Assert no duplicate project names — would cause symlink collisions.
    const names = projectWorkspaces.map((projectWorkspace) => projectWorkspace.projectName);
    const uniqueNames = new Set(names);
    assert(
      uniqueNames.size === names.length,
      `Duplicate project names in multi-project workspace: ${names.join(", ")}`
    );

    for (const projectWorkspace of projectWorkspaces) {
      const projectName = projectWorkspace.projectName;
      // Check both basename implementations so separators are rejected on every platform.
      const normalizedPosixName = path.posix.basename(projectName);
      const normalizedWindowsName = path.win32.basename(projectName);
      assert(
        normalizedPosixName === projectName &&
          normalizedWindowsName === projectName &&
          !projectName.includes("..") &&
          projectName.length > 0,
        `Invalid project name "${projectName}": must be a simple name without path separators`
      );
    }

    const containerPath = this.getContainerPath(workspaceName);
    await fs.mkdir(this.containerBase, { recursive: true });
    // Do not use recursive mkdir here: callers need EEXIST to mean a prior workspace already
    // owns this container name so cleanup never deletes someone else's container.
    await fs.mkdir(containerPath);

    for (const projectWorkspace of projectWorkspaces) {
      const linkPath = this.getProjectEntryPath(workspaceName, projectWorkspace.projectName);
      // Validate target exists before symlinking.
      await fs.access(projectWorkspace.workspacePath);
      await fs.symlink(projectWorkspace.workspacePath, linkPath);
    }

    return containerPath;
  }

  async removeContainer(workspaceName: string): Promise<void> {
    const containerPath = this.getContainerPath(workspaceName);
    // force: true keeps this idempotent (no error if already removed).
    await fs.rm(containerPath, { recursive: true, force: true });
  }
}
