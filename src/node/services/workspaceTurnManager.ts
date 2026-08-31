import type { TaskService } from "@/node/services/taskService";

type WorkspaceTurnManagerHost = Pick<
  TaskService,
  | "createWorkspaceTurn"
  | "waitForWorkspaceTurn"
  | "interruptWorkspaceTurn"
  | "getWorkspaceTurnSnapshot"
  | "listWorkspaceTurnTasks"
  | "archiveOwnedWorkspaceTurnWorkspace"
  | "unarchiveOwnedWorkspaceTurnWorkspace"
  | "markWorkspaceTurnTerminalAttentionConsumed"
>;

export class WorkspaceTurnManager {
  constructor(private readonly host: WorkspaceTurnManagerHost) {}

  createWorkspaceTurn(
    ...args: Parameters<WorkspaceTurnManagerHost["createWorkspaceTurn"]>
  ): ReturnType<WorkspaceTurnManagerHost["createWorkspaceTurn"]> {
    return this.host.createWorkspaceTurn(...args);
  }

  waitForWorkspaceTurn(
    ...args: Parameters<WorkspaceTurnManagerHost["waitForWorkspaceTurn"]>
  ): ReturnType<WorkspaceTurnManagerHost["waitForWorkspaceTurn"]> {
    return this.host.waitForWorkspaceTurn(...args);
  }

  interruptWorkspaceTurn(
    ...args: Parameters<WorkspaceTurnManagerHost["interruptWorkspaceTurn"]>
  ): ReturnType<WorkspaceTurnManagerHost["interruptWorkspaceTurn"]> {
    return this.host.interruptWorkspaceTurn(...args);
  }

  getWorkspaceTurnSnapshot(
    ...args: Parameters<WorkspaceTurnManagerHost["getWorkspaceTurnSnapshot"]>
  ): ReturnType<WorkspaceTurnManagerHost["getWorkspaceTurnSnapshot"]> {
    return this.host.getWorkspaceTurnSnapshot(...args);
  }

  listWorkspaceTurnTasks(
    ...args: Parameters<WorkspaceTurnManagerHost["listWorkspaceTurnTasks"]>
  ): ReturnType<WorkspaceTurnManagerHost["listWorkspaceTurnTasks"]> {
    return this.host.listWorkspaceTurnTasks(...args);
  }

  archiveOwnedWorkspaceTurnWorkspace(
    ...args: Parameters<WorkspaceTurnManagerHost["archiveOwnedWorkspaceTurnWorkspace"]>
  ): ReturnType<WorkspaceTurnManagerHost["archiveOwnedWorkspaceTurnWorkspace"]> {
    return this.host.archiveOwnedWorkspaceTurnWorkspace(...args);
  }

  unarchiveOwnedWorkspaceTurnWorkspace(
    ...args: Parameters<WorkspaceTurnManagerHost["unarchiveOwnedWorkspaceTurnWorkspace"]>
  ): ReturnType<WorkspaceTurnManagerHost["unarchiveOwnedWorkspaceTurnWorkspace"]> {
    return this.host.unarchiveOwnedWorkspaceTurnWorkspace(...args);
  }

  markWorkspaceTurnTerminalAttentionConsumed(
    ...args: Parameters<WorkspaceTurnManagerHost["markWorkspaceTurnTerminalAttentionConsumed"]>
  ): ReturnType<WorkspaceTurnManagerHost["markWorkspaceTurnTerminalAttentionConsumed"]> {
    return this.host.markWorkspaceTurnTerminalAttentionConsumed(...args);
  }
}
