import assert from "node:assert/strict";
import * as path from "node:path";
import { isTerminalWorkflowRunStatus, type WorkflowRunStatus } from "@/common/types/workflow";
import { log } from "@/node/services/log";
import { terminalAttentionOutcome } from "@/node/services/taskWorkspaceSeam";
import { TerminalAttentionStore } from "@/node/services/terminalAttentionStore";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";

/**
 * Call-time closures into TaskService: tests swap TaskService fields at runtime, so the owner
 * must read them when it runs instead of capturing them at construction.
 */
export interface WorkflowRunAttentionDeps {
  sessionsDir: () => string;
  terminalAttentionStore: () => TerminalAttentionStore;
}

/**
 * Owns TaskService's in-memory workflow terminal wake queue and the per-run settlement chain
 * that writes the durable settled markers. The drain and the sweep stay on TaskService and
 * reach the queue through the accessors below.
 */
export class WorkflowRunAttention {
  // Terminal settlements of the same run must not overlap: settlement is multi-step (stable
  // refresh, generation marker, post-write mismatch delete), so an older generation reaching
  // its mismatch delete after a newer settlement's stable refresh would remove the newer
  // generation's valid marker and let a downgraded build re-deliver a consumed result.
  private readonly workflowRunSettlementByRun = new Map<string, Promise<void>>();
  // Owed workflow terminal wakes (owner -> runIds believed terminal and not yet settled). An
  // in-memory work queue over durable state, not a delivery record: entries are (re)derived
  // from run records + settled markers at startup and on the periodic sweep and added by live
  // terminal callbacks, so losing the map merely delays a wake until the next sweep.
  readonly pendingWorkflowRunAttention = new Map<string, Set<string>>();

  constructor(private readonly deps: WorkflowRunAttentionDeps) {}

  /** Snapshot of the owner's queued run IDs, in insertion order. */
  queuedRunIds(ownerWorkspaceId: string): string[] {
    return Array.from(this.pendingWorkflowRunAttention.get(ownerWorkspaceId) ?? []);
  }

  /** Forget every queued run of the owner (the sweep re-derives them from durable state). */
  dropOwner(ownerWorkspaceId: string): void {
    this.pendingWorkflowRunAttention.delete(ownerWorkspaceId);
  }

  /** Forget one queued run of the owner without writing any marker. */
  dropRun(ownerWorkspaceId: string, runId: string): void {
    this.pendingWorkflowRunAttention.get(ownerWorkspaceId)?.delete(runId);
  }

  /** Returns true when the run was newly queued for this owner. */
  queueWorkflowRunAttention(ownerWorkspaceId: string, runId: string): boolean {
    let runIds = this.pendingWorkflowRunAttention.get(ownerWorkspaceId);
    if (runIds == null) {
      runIds = new Set();
      this.pendingWorkflowRunAttention.set(ownerWorkspaceId, runIds);
    }
    if (runIds.has(runId)) {
      return false;
    }
    runIds.add(runId);
    return true;
  }

  /**
   * Durable "this terminal generation needs no further wake" marker, keyed by the run's
   * terminal updatedAt: a later resume produces a new generation and thereby re-arms
   * attention without any reset bookkeeping. Write-once and best-effort by design: if the
   * write fails or never happens, the next drain evaluation re-derives the same answer from
   * run + history evidence and merely re-attempts the marker.
   */
  async markWorkflowRunTerminalAttentionSettled(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
    runUpdatedAt: string;
    settledAs: "delivered" | "superseded";
  }): Promise<void> {
    assert(
      params.ownerWorkspaceId.length > 0,
      "markWorkflowRunTerminalAttentionSettled requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "markWorkflowRunTerminalAttentionSettled requires runId");
    if (!isTerminalWorkflowRunStatus(params.status)) {
      return;
    }
    const key = `${params.ownerWorkspaceId}\u0000${params.runId}`;
    const previous = this.workflowRunSettlementByRun.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.settleWorkflowRunTerminalAttention(params));
    const tracked = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.workflowRunSettlementByRun.get(key) === tracked) {
          this.workflowRunSettlementByRun.delete(key);
        }
      });
    this.workflowRunSettlementByRun.set(key, tracked);
    return await run;
  }

  private async settleWorkflowRunTerminalAttention(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
    runUpdatedAt: string;
    settledAs: "delivered" | "superseded";
  }): Promise<void> {
    try {
      // Downgrade compatibility: the previous build dedupes its startup re-derivation on the
      // stable un-suffixed workflow_run id, so settling only the generation marker would let
      // a downgraded build re-create a pending wake for a result the user already consumed.
      // Stable-first ordering keeps the generation marker (this build's authority) retryable:
      // if either write fails, the queue entry survives and the next drain re-settles both.
      // The refresh (not write-once) matters: a stale previous-generation stable marker can
      // survive its best-effort restart-time clear, and a downgraded build would read it as
      // consumption of THIS generation's result. The recorded generation also gives the
      // sweep's upgrade fallback exact evidence immune to wall-clock corrections.
      await this.deps.terminalAttentionStore().recordSettled(
        {
          ownerWorkspaceId: params.ownerWorkspaceId,
          sourceKind: "workflow_run",
          sourceId: params.runId,
          generationId: params.runUpdatedAt,
          terminalOutcome: terminalAttentionOutcome(params.status),
          status: params.settledAs,
        },
        { wholeSourceRefresh: true }
      );
      await this.deps.terminalAttentionStore().recordSettled({
        ownerWorkspaceId: params.ownerWorkspaceId,
        sourceKind: "workflow_run",
        sourceId: params.runId,
        generationId: params.runUpdatedAt,
        terminalOutcome: terminalAttentionOutcome(params.status),
        status: params.settledAs,
      });
    } catch (error: unknown) {
      // Contain marker I/O here so no caller fails on bookkeeping: workflow_resume and
      // task_await must still return the run's durable result, and the drain must move on to
      // its other candidates. Keep the queue entry so the next drain re-evaluates from run +
      // history evidence and re-attempts the marker; at worst a truthful wake re-delivers.
      log.warn("Failed to record workflow terminal settlement marker", {
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
        settledAs: params.settledAs,
        error,
      });
      return;
    }
    // Post-write revalidation: a wake-turn workflow_resume can restart the run while this
    // settlement's snapshot was in flight, so the restart-time stable clear can land BEFORE
    // the stable write above re-creates the marker. That marker postdates the newer
    // generation's updatedAt, so the sweep's upgrade fallback (and a downgraded build's
    // whole-run dedupe) would permanently suppress the newer result, and the by-run-id queue
    // delete below would drop its owed wake. Reading the run AFTER the writes closes the
    // write-side race: any restart after this read re-clears the stable marker itself and
    // its terminal callback re-queues behind this deletion.
    let currentRunUpdatedAt: string | null;
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.deps.sessionsDir(), params.ownerWorkspaceId),
      });
      currentRunUpdatedAt = (await runStore.getRun(params.runId)).updatedAt;
    } catch {
      currentRunUpdatedAt = null;
    }
    if (currentRunUpdatedAt !== params.runUpdatedAt) {
      // The settled snapshot is no longer the run's newest generation (or the run is
      // unreadable): the stable whole-run marker must not outlive the snapshot. The
      // generation marker stays; it truthfully settles only this snapshot.
      await this.clearWorkflowRunDowngradeSettlement({
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
      });
      if (currentRunUpdatedAt != null) {
        // The queue entry now represents the newer generation's owed wake: leave it for the
        // drain the terminal callback scheduled (the sweep backstops a lost poke).
        return;
      }
      // Unreadable run: fall through to the delete. With no stable marker surviving, the
      // sweep re-derives any owed newer generation from durable state.
    }
    this.pendingWorkflowRunAttention.get(params.ownerWorkspaceId)?.delete(params.runId);
  }

  /**
   * Downgrade-compat bookkeeping only: settlement dual-writes a stable un-suffixed marker for
   * the previous build's whole-run dedupe (see markWorkflowRunTerminalAttentionSettled), and a
   * restarted run invalidates it. Without this delete, downgrading after a resume would leave
   * the old build refusing to enqueue the run's newer result behind the stale stable marker.
   * This build reads the stable marker only as recency-gated upgrade evidence behind
   * generation markers (see sweepWorkflowRunTerminalAttention), so the delete stays
   * best-effort and must never fail the status transition.
   */
  async clearWorkflowRunDowngradeSettlement(params: {
    ownerWorkspaceId: string;
    runId: string;
  }): Promise<void> {
    assert(
      params.ownerWorkspaceId.length > 0,
      "clearWorkflowRunDowngradeSettlement requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "clearWorkflowRunDowngradeSettlement requires runId");
    try {
      await this.deps
        .terminalAttentionStore()
        .delete(
          params.ownerWorkspaceId,
          TerminalAttentionStore.notificationId("workflow_run", params.runId)
        );
    } catch (error: unknown) {
      log.warn("Failed to clear stale workflow downgrade settlement marker", {
        ownerWorkspaceId: params.ownerWorkspaceId,
        runId: params.runId,
        error,
      });
    }
  }
}
