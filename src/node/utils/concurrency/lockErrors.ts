/**
 * The error classes of the session locks, in a pure module (no I/O), so the
 * SessionLocks service and its test layers can throw them without importing
 * the lock modules. Callers test them with instanceof, so there must be one
 * class each: crossProcessLock.ts and workspaceUseLeases.ts re-export these.
 */

/** Thrown when the acquire budget elapses; the message names the blocking holder. */
export class CrossProcessLockTimeoutError extends Error {}

/** Thrown by hold() while a live mutator holds the workspace's mutation gate. */
export class WorkspaceMutationInProgressError extends Error {}
