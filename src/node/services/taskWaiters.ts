import assert from "node:assert/strict";
import type { ThinkingLevel } from "@/common/types/thinking";
import { log } from "@/node/services/log";
import type { BackgroundableForegroundWaiter } from "@/node/services/taskWorkspaceSeam";

export const COMPLETED_REPORT_CACHE_MAX_ENTRIES = 128;

export class ForegroundWaitBackgroundedError extends Error {
  constructor() {
    super("Foreground wait sent to background due to queued message");
    this.name = "ForegroundWaitBackgroundedError";
  }
}

/** The report a pending waiter resolves with. */
export interface PendingTaskWaiterReport {
  reportMarkdown: string;
  title?: string;
  structuredOutput?: unknown;
  planFilePath?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface PendingTaskWaiter extends BackgroundableForegroundWaiter {
  resolve: (report: PendingTaskWaiterReport) => void;
}

export interface PendingTaskStartWaiter {
  start: () => void;
  cleanup: () => void;
}

export interface CompletedAgentReportCacheEntry {
  reportMarkdown: string;
  planFilePath?: string;
  structuredOutput?: unknown;
  title?: string;
  // Final settings the child reported with (post plan-to-exec handoff), not the launch snapshot.
  model?: string;
  thinkingLevel?: ThinkingLevel;
  // Ancestor workspace IDs captured when the report was cached.
  // Used to keep descendant-scope checks working even if the task workspace is cleaned up.
  ancestorWorkspaceIds: string[];
  // Ancestors for which the task report must only be consumed through a workflow run.
  workflowOwnedAncestorWorkspaceIds?: string[];
}

// Report waiters and start waiters share one list-per-task bookkeeping: append in arrival order,
// and drop the key once its last waiter leaves so `has(taskId)` means "someone is waiting".
function appendToListMap<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key) ?? [];
  list.push(item);
  map.set(key, list);
}

function removeFromListMap<T>(map: Map<string, T[]>, key: string, item: T): void {
  const current = map.get(key);
  if (current) {
    const next = current.filter((w) => w !== item);
    if (next.length === 0) {
      map.delete(key);
    } else {
      map.set(key, next);
    }
  }
}

export interface TaskWaitersDeps {
  /** Durably mark a backgrounded wait's handle `notify_on_terminal` (TaskService owns persistence). */
  scheduleNotifyOnTerminalPersist: (taskId: string, ownerWorkspaceId: string | undefined) => void;
  /** Whether the workspace has a queued message with the given dispatch mode. */
  hasQueuedMessages: (workspaceId: string, dispatchMode: "tool-end") => boolean;
}

/**
 * In-memory waiter state of TaskService: report waiters, start waiters (timeouts armed once a
 * queued task runs), foreground-await counts, backgroundable foreground waiters, the
 * user-backgrounded marks and the bounded completed-report cache. Nothing here is persisted.
 */
export class TaskWaiters {
  readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  // Tasks whose launch failed, or whose reservation was canceled or failed, but whose write
  // ending the row rejected (#4747, #5028): the row still says queued/starting and nothing will
  // move it to running, so waiters arm their timeout at once. A later move to running, a
  // recorded launch failure or the workspace's removal clears the mark.
  readonly unpersistedLaunchFailureTaskIds = new Set<string>();
  // Tracks workspaces currently blocked in a foreground wait (e.g. a task tool call awaiting
  // agent_report). Used to avoid scheduler deadlocks when maxParallelAgentTasks is low and tasks
  // spawn nested tasks in the foreground.
  private readonly foregroundAwaitCountByWorkspaceId = new Map<string, number>();
  readonly backgroundableForegroundWaitersByWorkspaceId = new Map<
    string,
    Set<BackgroundableForegroundWaiter>
  >();

  private readonly userBackgroundedTaskIds = new Set<string>();

  // Cache completed reports so callers can retrieve them without re-reading disk.
  // Bounded by max entries; disk persistence is the source of truth for restart-safety.
  readonly completedReportsByTaskId = new Map<string, CompletedAgentReportCacheEntry>();

  constructor(private readonly deps: TaskWaitersDeps) {}

  private markTaskQueueBackgrounded(taskId: string): void {
    this.userBackgroundedTaskIds.add(taskId);
  }

  markTaskForegroundRelevant(taskId: string): void {
    this.userBackgroundedTaskIds.delete(taskId);
  }

  isTaskQueueBackgrounded(taskId: string): boolean {
    return this.userBackgroundedTaskIds.has(taskId);
  }

  isForegroundAwaiting(workspaceId: string): boolean {
    const count = this.foregroundAwaitCountByWorkspaceId.get(workspaceId);
    return typeof count === "number" && count > 0;
  }

  startForegroundAwait(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "startForegroundAwait: workspaceId must be non-empty");

    const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
    assert(
      Number.isInteger(current) && current >= 0,
      "startForegroundAwait: expected non-negative integer counter"
    );

    this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current + 1);

    return () => {
      const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
      assert(
        Number.isInteger(current) && current > 0,
        "startForegroundAwait cleanup: expected positive integer counter"
      );
      if (current <= 1) {
        this.foregroundAwaitCountByWorkspaceId.delete(workspaceId);
      } else {
        this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current - 1);
      }
    };
  }

  registerBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    let set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) {
      set = new Set();
      this.backgroundableForegroundWaitersByWorkspaceId.set(workspaceId, set);
    }
    set.add(waiter);
  }

  unregisterBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) {
      this.backgroundableForegroundWaitersByWorkspaceId.delete(workspaceId);
    }
  }

  /**
   * Reject all foreground task waiters for a workspace that opted into backgrounding
   * when a new message is queued. Returns the number of waiters signaled.
   * Safe to call repeatedly — already-cleaned-up waiters are skipped.
   */
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set || set.size === 0) return 0;

    const waiters = [...set];
    let count = 0;
    for (const waiter of waiters) {
      try {
        this.markTaskQueueBackgrounded(waiter.taskId);
        // A foreground wait detached by a queued message becomes durably non-blocking:
        // persist notify_on_terminal so future stream-ends and restarts do not re-force the
        // await. The in-memory mark above covers the immediate next stream-end while this
        // persistence settles. Tracked so handleStreamEnd can await it before reading config.
        this.deps.scheduleNotifyOnTerminalPersist(waiter.taskId, waiter.requestingWorkspaceId);
        waiter.reject(new ForegroundWaitBackgroundedError());
        count++;
      } catch {
        // waiter already resolved/rejected — ignore
      }
    }
    return count;
  }

  /**
   * Background any registered foreground waits for the requesting workspace when a
   * tool-end message is already queued. Shared by both wait-registration paths
   * (workspace-turn and task await): the auto-backgrounding signal is edge-triggered
   * on enqueue, so a message queued before the waiter registered must be re-checked
   * here. No-op when backgrounding is disabled or no requesting workspace is set.
   */
  backgroundForegroundWaitIfQueued(
    shouldBackgroundOnQueuedMessage: boolean,
    requestingWorkspaceId: string | undefined
  ): void {
    if (
      shouldBackgroundOnQueuedMessage &&
      requestingWorkspaceId &&
      this.deps.hasQueuedMessages(requestingWorkspaceId, "tool-end")
    ) {
      this.backgroundForegroundWaitsForWorkspace(requestingWorkspaceId);
    }
  }

  addPendingWaiter(taskId: string, waiter: PendingTaskWaiter): void {
    appendToListMap(this.pendingWaitersByTaskId, taskId, waiter);
  }

  removePendingWaiter(taskId: string, waiter: PendingTaskWaiter): void {
    removeFromListMap(this.pendingWaitersByTaskId, taskId, waiter);
  }

  hasPendingWaiters(taskId: string): boolean {
    return (this.pendingWaitersByTaskId.get(taskId)?.length ?? 0) > 0;
  }

  /** Drains and resolves the task's report waiters. Returns whether any waiter was pending. */
  resolvePendingWaiters(taskId: string, report: PendingTaskWaiterReport): boolean {
    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return false;
    }

    this.pendingWaitersByTaskId.delete(taskId);
    for (const waiter of waiters) {
      try {
        waiter.cleanup();
        waiter.resolve(report);
      } catch {
        // ignore
      }
    }

    return true;
  }

  rejectWaiters(taskId: string, error: Error): void {
    this.markTaskForegroundRelevant(taskId);

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      try {
        waiter.reject(error);
      } catch (rejectError: unknown) {
        log.error("Task waiter reject callback failed", { taskId, error: rejectError });
      }
    }
  }

  addPendingStartWaiter(taskId: string, waiter: PendingTaskStartWaiter): void {
    appendToListMap(this.pendingStartWaitersByTaskId, taskId, waiter);
  }

  removePendingStartWaiter(taskId: string, waiter: PendingTaskStartWaiter): void {
    removeFromListMap(this.pendingStartWaitersByTaskId, taskId, waiter);
  }

  /**
   * A write that would have ended a queued/starting task rejected, and nothing will move the row
   * to running (#4747, #5028). Fail closed: waiters are not rejected with the unpersisted outcome,
   * whose owner is unknown when the updater never ran. Their timeout is armed instead, now and for
   * waiters that attach later, so they settle at their timeout.
   */
  armWaitersOfUnendedTask(taskId: string): void {
    this.unpersistedLaunchFailureTaskIds.add(taskId);
    this.startPendingStartWaiters(taskId);
  }

  isLaunchFailureUnpersisted(taskId: string): boolean {
    return this.unpersistedLaunchFailureTaskIds.has(taskId);
  }

  clearUnpersistedLaunchFailure(taskId: string): void {
    this.unpersistedLaunchFailureTaskIds.delete(taskId);
  }

  /** Arms the report timeout of every waiter that attached while the task was queued/starting. */
  startPendingStartWaiters(workspaceId: string): void {
    const waiters = this.pendingStartWaitersByTaskId.get(workspaceId);
    if (!waiters || waiters.length === 0) return;
    this.pendingStartWaitersByTaskId.delete(workspaceId);
    for (const waiter of waiters) {
      try {
        waiter.start();
      } catch (error: unknown) {
        log.error("Task start waiter callback failed", { workspaceId, error });
      }
    }
  }

  getCompletedReport(taskId: string): CompletedAgentReportCacheEntry | undefined {
    return this.completedReportsByTaskId.get(taskId);
  }

  hasCompletedReport(taskId: string): boolean {
    return this.completedReportsByTaskId.has(taskId);
  }

  /** Caches a completed report, evicting the oldest entries past the cache bound. */
  cacheCompletedReport(taskId: string, entry: CompletedAgentReportCacheEntry): void {
    this.completedReportsByTaskId.set(taskId, entry);
    this.enforceCompletedReportCacheLimit();
  }

  deleteCompletedReport(taskId: string): void {
    this.completedReportsByTaskId.delete(taskId);
  }

  private enforceCompletedReportCacheLimit(): void {
    while (this.completedReportsByTaskId.size > COMPLETED_REPORT_CACHE_MAX_ENTRIES) {
      const first = this.completedReportsByTaskId.keys().next();
      if (first.done) break;
      this.completedReportsByTaskId.delete(first.value);
    }
  }
}
