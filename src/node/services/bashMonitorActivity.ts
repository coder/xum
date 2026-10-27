/**
 * Activity emits for bash monitor counts: the last armed-monitor count broadcast per workspace
 * (so process churn that keeps the count skips the re-emit), and the workspaces where an armed
 * monitor was ever observed (so getActivityList keeps a zero-count tombstone for them).
 *
 * Moved out of WorkspaceService without logic changes. WorkspaceService's "change" listener
 * calls onProcessChange(), and getActivityList reads and records observations here.
 */
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import { log } from "@/node/services/log";

export interface BashMonitorActivityDeps {
  getActiveBashMonitorCount(workspaceId: string): number;
  /** ExtensionMetadataService.getSnapshot. */
  getSnapshot(
    workspaceId: string,
    options: { throwOnError: true }
  ): Promise<WorkspaceActivitySnapshot | null>;
  /** WorkspaceService.emitWorkspaceActivity: merges the live counts and broadcasts. */
  emitWorkspaceActivity(workspaceId: string, snapshot: WorkspaceActivitySnapshot | null): void;
}

export class BashMonitorActivity {
  // Last armed-monitor count successfully broadcast per workspace, so background process
  // churn that doesn't change the count (e.g. a monitorless bash exiting) skips the
  // activity re-emit. A missing entry means "unknown" (never successfully emitted), which
  // must never dedupe: renderers may have bootstrapped a non-zero count from
  // getActivityList(), so suppressing an unknown->0 transition would strand the sidebar.
  private readonly lastEmittedBashMonitorCounts = new Map<string, number>();
  // Workspaces where an armed monitor has ever been observed (by the change listener or
  // a getActivityList read). Deliberately never pruned and kept separate from the dedupe
  // map above: the dedupe entry is dropped while emits are in flight or failed, but the
  // tombstone decision in getActivityList must survive those windows, otherwise a
  // renderer that bootstrapped a non-zero count can never see the zero-count clear.
  private readonly bashMonitorSeenWorkspaces = new Set<string>();
  /** The background process manager's "change" listener body. */
  onProcessChange(workspaceId: string): void {
    const count = this.deps.getActiveBashMonitorCount(workspaceId);
    if (count > 0) {
      this.bashMonitorSeenWorkspaces.add(workspaceId);
    }
    if (this.lastEmittedBashMonitorCounts.get(workspaceId) === count) {
      return;
    }
    // Clear the entry synchronously BEFORE the async emit: while an emit is in flight
    // the last delivered count is unknown (the snapshot read may fail, and renderers
    // may observe transient counts via workspace.activity.list()). Deleting up front
    // means a concurrent change event — e.g. a stop racing a slow armed emit in a fast
    // 0 -> 1 -> 0 sequence — can never dedupe against a stale pre-emit value and drop
    // the clear. Cost: an occasional duplicate emit, which renderers apply idempotently.
    this.lastEmittedBashMonitorCounts.delete(workspaceId);
    void this.deps
      // Strict: emitting a suspect (partial-main) snapshot after a failed
      // sidecar reconcile would clear goal/status in the renderer; the
      // catch below already retains "unknown" and re-emits on next change.
      .getSnapshot(workspaceId, { throwOnError: true })
      .then((snapshot) => {
        this.deps.emitWorkspaceActivity(workspaceId, snapshot);
        // Record only after a successful emit. Re-read the count because the emit merges
        // the live value, which may have moved past the one that triggered this listener.
        this.lastEmittedBashMonitorCounts.set(
          workspaceId,
          this.deps.getActiveBashMonitorCount(workspaceId)
        );
      })
      .catch((error: unknown) => {
        // Leave the entry absent ("unknown") so the next change event always re-emits.
        log.debug("Failed to emit activity after background bash monitor change", {
          workspaceId,
          error,
        });
      });
  }

  constructor(private readonly deps: BashMonitorActivityDeps) {}

  /** Record an armed monitor that a renderer saw outside the change listener (getActivityList). */
  markSeen(workspaceId: string): void {
    this.bashMonitorSeenWorkspaces.add(workspaceId);
  }

  /** An armed monitor was observed in the workspace at some point (see bashMonitorSeenWorkspaces). */
  hasSeen(workspaceId: string): boolean {
    return this.bashMonitorSeenWorkspaces.has(workspaceId);
  }

  seenWorkspaceIds(): IterableIterator<string> {
    return this.bashMonitorSeenWorkspaces.values();
  }

  /** Forget a removed (or removed-then-revived) workspace (evictWorkspaceActivityCaches). */
  evictSeenWorkspace(workspaceId: string): void {
    this.bashMonitorSeenWorkspaces.delete(workspaceId);
  }
}
