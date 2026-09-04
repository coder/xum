import assert from "node:assert/strict";
import type { ProjectsConfig, Workspace } from "@/common/types/project";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { Config } from "@/node/config";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";

export interface DesktopTarget {
  ownerWorkspaceId: string;
  ownerName: string;
}

export class UnsupportedDesktopRuntimeError extends Error {}

/**
 * Delegation changes the operator, not the computer; checkout isolation is separate.
 * The gate covers input and durable admission together. Config task statuses are the
 * only ownership ledger, so completion/restart never depends on an in-memory lease.
 */
export class DesktopInputCoordinator {
  private readonly gates = new MutexMap<string>();

  constructor(private readonly config: Config) {}

  resolveTarget(workspaceId: string): DesktopTarget {
    return this.resolveFromConfig(this.config.loadConfigOrDefault(), workspaceId);
  }

  async withReservation<T>(
    ownerWorkspaceId: string,
    borrowerWorkspaceId: string,
    reserve: () => Promise<T>
  ): Promise<T> {
    assert(borrowerWorkspaceId.length > 0, "Desktop reservation requires a borrower ID");
    return this.gates.withLock(ownerWorkspaceId, async () => {
      const config = this.config.loadConfigOrDefault();
      const owner = this.resolveFromConfig(config, ownerWorkspaceId);
      if (owner.ownerWorkspaceId !== ownerWorkspaceId || ownerWorkspaceId === borrowerWorkspaceId) {
        throw new Error("Desktop reservation requires an unbound owner and a distinct borrower");
      }
      this.assertController(config, ownerWorkspaceId, borrowerWorkspaceId, false);
      return reserve();
    });
  }

  async withAdmission<T>(workspaceId: string, admit: () => Promise<T>): Promise<T> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    // Non-desktop/legacy tasks retain their existing admission behavior, including remote runtimes.
    if (entry?.workspace.taskDesktopOwnerWorkspaceId === undefined) return admit();
    const target = this.resolveTarget(workspaceId);
    return this.gates.withLock(target.ownerWorkspaceId, async () => {
      const config = this.config.loadConfigOrDefault();
      this.assertSameTarget(config, workspaceId, target.ownerWorkspaceId);
      this.assertController(config, target.ownerWorkspaceId, workspaceId, false);
      return admit();
    });
  }

  async withInput<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    const target = this.resolveTarget(workspaceId);
    return this.gates.withLock(target.ownerWorkspaceId, async () => {
      const config = this.config.loadConfigOrDefault();
      this.assertSameTarget(config, workspaceId, target.ownerWorkspaceId);
      this.assertController(config, target.ownerWorkspaceId, workspaceId, true);
      return run();
    });
  }

  private assertSameTarget(config: ProjectsConfig, workspaceId: string, ownerWorkspaceId: string) {
    if (this.resolveFromConfig(config, workspaceId).ownerWorkspaceId !== ownerWorkspaceId) {
      throw new Error(`Desktop target changed for workspace ${workspaceId}`);
    }
  }

  private assertController(
    config: ProjectsConfig,
    ownerWorkspaceId: string,
    workspaceId: string,
    requireActive: boolean
  ): void {
    const activeBorrowers: string[] = [];
    for (const project of config.projects.values()) {
      for (const workspace of project.workspaces) {
        if (
          workspace.taskDesktopOwnerWorkspaceId !== ownerWorkspaceId ||
          !this.isActive(workspace)
        ) {
          continue;
        }
        if (!workspace.id) throw new Error("Active desktop borrower is missing its workspace ID");
        this.resolveFromConfig(config, workspace.id);
        activeBorrowers.push(workspace.id);
      }
    }
    if (activeBorrowers.length > 1) {
      throw new Error(`Desktop ${ownerWorkspaceId} has multiple active borrowers`);
    }
    const activeBorrower = activeBorrowers[0];
    if (activeBorrower !== undefined && activeBorrower !== workspaceId) {
      throw new Error(
        `Desktop ${ownerWorkspaceId} is controlled by active borrower ${activeBorrower}`
      );
    }
    if (requireActive && workspaceId !== ownerWorkspaceId && activeBorrower !== workspaceId) {
      throw new Error(`Desktop borrower ${workspaceId} is not active`);
    }
  }

  private isActive(workspace: Workspace): boolean {
    return (
      workspace.taskStatus === "queued" ||
      workspace.taskStatus === "starting" ||
      workspace.taskStatus === "running" ||
      workspace.taskStatus === "awaiting_report" ||
      workspace.taskExecutionStatus === "queued" ||
      workspace.taskExecutionStatus === "starting" ||
      workspace.taskExecutionStatus === "running"
    );
  }

  private resolveFromConfig(config: ProjectsConfig, workspaceId: string): DesktopTarget {
    assert(workspaceId.length > 0, "Desktop target requires a workspace ID");
    const requester = this.requireWorkspace(config, workspaceId);
    const ownerWorkspaceId = requester.taskDesktopOwnerWorkspaceId ?? workspaceId;
    // Null/empty bindings are corruption, not an invitation to silently allocate another desktop.
    if (
      requester.taskDesktopOwnerWorkspaceId !== undefined &&
      (typeof requester.taskDesktopOwnerWorkspaceId !== "string" || ownerWorkspaceId.length === 0)
    ) {
      throw new Error(`Invalid desktop owner for workspace ${workspaceId}`);
    }
    const owner = this.requireWorkspace(config, ownerWorkspaceId);
    if (owner.taskDesktopOwnerWorkspaceId !== undefined) {
      throw new Error(`Desktop owner ${ownerWorkspaceId} must not itself be bound`);
    }
    if (requester.taskDesktopOwnerWorkspaceId !== undefined) {
      const visited = new Set([workspaceId]);
      let parentId = requester.parentWorkspaceId;
      let foundOwner = false;
      while (parentId !== undefined) {
        if (visited.has(parentId)) throw new Error(`Desktop ancestry cycle at ${parentId}`);
        visited.add(parentId);
        const parent = findWorkspaceEntry(config, parentId)?.workspace;
        if (!parent) throw new Error(`Desktop ancestor workspace not found: ${parentId}`);
        if (parentId === ownerWorkspaceId) foundOwner = true;
        parentId = parent.parentWorkspaceId;
      }
      if (!foundOwner) {
        throw new Error(`Desktop owner ${ownerWorkspaceId} is not an ancestor of ${workspaceId}`);
      }
    }
    return { ownerWorkspaceId, ownerName: owner.name ?? ownerWorkspaceId };
  }

  private requireWorkspace(config: ProjectsConfig, workspaceId: string): Workspace {
    const workspace = findWorkspaceEntry(config, workspaceId)?.workspace;
    if (!workspace) throw new Error(`Desktop workspace not found: ${workspaceId}`);
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      throw new Error(
        `Workspace is archived: ${workspaceId}. Unarchive it before using a desktop.`
      );
    }
    const runtime = workspace.runtimeConfig?.type;
    if (runtime !== undefined && runtime !== "local" && runtime !== "worktree") {
      throw new UnsupportedDesktopRuntimeError(
        `Unsupported desktop runtime for ${workspaceId}: ${runtime}`
      );
    }
    return workspace;
  }
}
