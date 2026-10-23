import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import type { ProcessFileLock, ProcessFileLockOptions } from "@/node/utils/concurrency/fileLock";
import type {
  CrossProcessLockOptions,
  CrossProcessLockState,
} from "@/node/utils/main/crossProcessLock";
import type { WorkspaceUseKind, WorkspaceUseLease } from "@/node/services/workspaceUseLeases";

/**
 * Every lock that guards a session write, as one service (phase 4 of the
 * agent-loop refactor), so tests and the in-memory turn can swap the lock
 * medium with a layer. Each member has the signature of today's function, and
 * callers keep their paths, timeouts and labels: moving a call changes no lock
 * rule (sessionLocks.callOptions.test.ts checks the options).
 */
export interface SessionLocks {
  /** The one in-process FIFO for each workspace. Node: workspaceFileLocks. */
  readonly workspaceFiles: Pick<MutexMap<string>, "withLock">;
  /** A cross-process lock file. Node: acquireProcessFileLock. */
  acquireProcessFileLock(options: ProcessFileLockOptions): Promise<ProcessFileLock>;
  /** A cross-process lock record. Node: acquireCrossProcessLock. */
  acquireCrossProcessLock(options: CrossProcessLockOptions): Promise<() => Promise<void>>;
  /** A read-only probe of a lock record: absent, dead or held. Node: inspectCrossProcessLock. */
  inspectCrossProcessLock(lockPath: string): Promise<CrossProcessLockState>;
  /** The use leases of one backend. Node: workspaceUseLeasesFor (one object per Config). */
  useLeasesFor(config: { readonly rootDir: string }): {
    hold(workspaceId: string, kind: WorkspaceUseKind): Promise<WorkspaceUseLease>;
    isHeld(workspaceId: string, kind: WorkspaceUseKind): Promise<boolean>;
  };
}

export {
  CrossProcessLockTimeoutError,
  WorkspaceMutationInProgressError,
} from "@/node/utils/concurrency/lockErrors";
