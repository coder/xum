/**
 * Workspace metadata tag keys for workspace-turn ("workspace" agent) tasks.
 *
 * When a workspace task creates a fresh workspace, the backend stamps these
 * tags onto the new workspace so the task can be correlated back to its
 * originating handle/owner/turn. The `handle` tag in particular is read by the
 * frontend (`TaskToolCall`) to keep stale task tool results clickable after the
 * result's explicit workspaceId falls out of view, so its key must stay in sync
 * across the node/browser boundary. Centralizing the keys here keeps that
 * contract a single source of truth instead of duplicating the literals.
 */
export const WORKSPACE_TURN_TASK_TAGS = {
  /** Workspace-turn task handle id (`wst_...`) that created the workspace. */
  handle: "mux.taskHandleId",
  /** Workspace id that owns the task. */
  ownerWorkspaceId: "mux.taskOwnerWorkspaceId",
  /** Turn id associated with the task. */
  turn: "mux.taskTurnId",
} as const;

Object.freeze(WORKSPACE_TURN_TASK_TAGS);
