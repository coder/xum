export const TASK_TERMINATION_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
export const TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS = 20 * 1000;
export const TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS = 2 * 60 * 1000;
export const WORKTREE_DELETE_GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Bounds backup Git calls that can hang on a blackholed remote, while leaving room for a
 * slow initial clone.
 */
export const BACKUP_GIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Bounds the app Effect runtime's scope close, the last step of
 * `ServiceContainer.dispose()`. Must stay well inside the 5 s quit budgets that
 * `desktop/main.ts` and `cli/server.ts` race the whole dispose against.
 */
export const APP_RUNTIME_DISPOSE_TIMEOUT_MS = 2 * 1000;
