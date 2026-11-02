import assert from "node:assert/strict";
import type { StreamEndEvent } from "@/common/types/stream";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import { log } from "@/node/services/log";
import type {
  AdmittedSend,
  AttemptFence,
  OwnedTaskAttempt,
  StreamEndDecision,
  StreamEndTaskOrigin,
} from "@/node/services/taskService";
import { findWorkspaceEntry, rowSupersedes } from "@/node/services/taskUtils";
import type { QueueCutAttributionSnapshot, WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";

/**
 * A child stream end cut by a host-selected continuation (see StreamEndLedger's
 * deferredTaskStreamEnds).
 */
export interface TaskStreamEndDeferral {
  sourceMessageId: string;
  sourceTurnGeneration: symbol;
  continuationEntryId: string;
  executionId: string | undefined;
  stopEpoch: number;
  /**
   * The cut stream's attempt: a row another writer re-admitted since drops the deferral, and
   * its recovery is CAS'd on this attempt (#4414).
   */
  attemptId: AttemptFence;
}

/**
 * Everything the stream-end ledger reads from TaskService. Each entry is a call-time closure over
 * TaskService, never a captured value or bound method: tests swap TaskService fields and patch
 * its methods after construction. Stop and attempt state stays with its owners and is reached
 * only through these closures.
 */
export interface StreamEndLedgerDeps {
  config: () => Pick<Config, "loadConfigOrDefault">;
  workspaceService: () => Pick<
    WorkspaceHost,
    | "getActiveTurnGeneration"
    | "drainQueuedMessagesIfIdle"
    | "disposeQueueCut"
    | "getQueueCutReceipt"
  >;
  workspaceGoalService: () =>
    | Pick<WorkspaceGoalService, "streamAccountingReceiptOutcome">
    | undefined;
  workspaceEventLocks: () => Pick<MutexMap<string>, "withLock">;
  /** TaskService.handleStreamEnd (stays on TaskService). */
  handleStreamEnd: (
    event: StreamEndEvent,
    queueCutSnapshot: QueueCutAttributionSnapshot,
    taskOrigin: StreamEndTaskOrigin
  ) => Promise<"deferred" | undefined>;
  /** TaskService.recoverTaskFromIncompleteStreamEnd (stays on TaskService). */
  recoverTaskFromIncompleteStreamEnd: (
    workspaceId: string,
    status: WorkspaceConfigEntry["taskStatus"],
    streamAttemptId: AttemptFence
  ) => Promise<void>;
  /** TaskService.getWorkspaceStopEpoch. */
  getWorkspaceStopEpoch: (workspaceId: string) => number;
  /** TaskService.getAgentTaskExecutionId. */
  getAgentTaskExecutionId: (taskId: string) => string | null;
  /** TaskStopLatch.recheckWorkspaceStopRelease. */
  recheckWorkspaceStopRelease: (workspaceId: string) => void;
  /** AttemptLedger.attemptAdmissionOpen. */
  attemptAdmissionOpen: (taskId: string, attemptId: string) => boolean;
  /** AttemptLedger.addAttemptSettlementListener. */
  addAttemptSettlementListener: (taskId: string, listener: () => void) => void;
  /** AttemptLedger.removeAttemptSettlementListener. */
  removeAttemptSettlementListener: (taskId: string, listener: () => void) => void;
  /** AttemptLedger.sendsOf: the task's admitted send obligations. */
  sendsOf: (taskId: string) => ReadonlySet<AdmittedSend>;
}

/**
 * Stream-end decisions (see StreamEndDecision) of this process's owned attempts and the child
 * stream ends deferred by a host-selected continuation, with the stream-end handler runs that
 * resolve them. handleStreamEnd and the stream-end listener stay on TaskService.
 */
export class StreamEndLedger {
  /**
   * Child stream ends cut by a host-selected continuation (queued input or context-budget
   * hand-over) whose successor has not yet streamed or been withdrawn. Keyed by task; settled
   * from the recorded successor outcome (QueueCutReceipt), never from an idle probe, and cleared
   * on terminal transitions. In-memory only: after a restart a running task with no stream is
   * handled by startup recovery.
   */
  private readonly deferredTaskStreamEnds = new Map<string, TaskStreamEndDeferral>();
  /** Per task, the stream-end decisions of this process's owned attempts (see StreamEndDecision). */
  readonly streamEndDecisionsByTaskId = new Map<string, StreamEndDecision[]>();

  constructor(private readonly deps: StreamEndLedgerDeps) {}

  /**
   * Run handleStreamEnd under the workspace event lock, owning the stream's decision: resolved
   * `nonreport` on every return that neither published nor failed, `indeterminate` on a throw —
   * unless the handler deferred the stream (child goal arbitration waiting on its accounting),
   * which transfers the still-pending decision to deferChildStreamEnd.
   */
  runStreamEndHandler(
    event: StreamEndEvent,
    queueCutSnapshot: QueueCutAttributionSnapshot,
    taskOrigin: StreamEndTaskOrigin,
    decision: StreamEndDecision | undefined
  ): void {
    void this.deps
      .workspaceEventLocks()
      .withLock(event.workspaceId, async () => {
        let deferred = false;
        try {
          deferred =
            (await this.deps.handleStreamEnd(event, queueCutSnapshot, taskOrigin)) === "deferred";
        } catch (error: unknown) {
          // Unknown outcome: never let held follow-ups run as if the attempt continued.
          this.resolveStreamEndDecision(event.workspaceId, decision, "indeterminate");
          throw error;
        } finally {
          // Every return path that neither published nor failed left the attempt continuing.
          if (!deferred) this.resolveStreamEndDecision(event.workspaceId, decision, "nonreport");
        }
        if (deferred) this.deferChildStreamEnd(event, queueCutSnapshot, taskOrigin, decision);
      })
      .catch((error: unknown) => {
        log.error("TaskService.handleStreamEnd failed", { error });
      });
  }

  /**
   * A child stream whose goal accounting had not settled when arbitration needed it (see
   * arbitrateChildGoalAtStreamEnd): accounting completion is authoritative, so nothing is decided
   * from unsettled state and the task is not finalized. The stream's pending decision (held
   * follow-ups keep waiting) moves here; outside the event lock this waits — unbounded — for the
   * retained receipt to settle, or for the attempt to close / be superseded / be stopped (or its
   * row to stop reading running), then re-runs the original stream end (same event, attempt,
   * turn and stop fences) under the lock.
   */
  private deferChildStreamEnd(
    event: StreamEndEvent,
    queueCutSnapshot: QueueCutAttributionSnapshot,
    taskOrigin: StreamEndTaskOrigin,
    decision: StreamEndDecision | undefined
  ): void {
    const goalService = this.deps.workspaceGoalService();
    assert(goalService != null, "deferChildStreamEnd requires the goal service");
    const taskId = event.workspaceId;
    const attemptId = taskOrigin.ownedAttempt?.attemptId ?? taskOrigin.unownedAttemptId;
    const cancelled = Promise.withResolvers<void>();
    const listener = () => {
      if (
        attemptId == null ||
        !this.deps.attemptAdmissionOpen(taskId, attemptId) ||
        taskOrigin.stopEpoch !== this.deps.getWorkspaceStopEpoch(taskId) ||
        taskOrigin.executionId !== this.deps.getAgentTaskExecutionId(taskId) ||
        // arbitrateChildGoalAtStreamEnd's status gate (its owed-pause gate needs no mirror: the
        // pause marker is written only with a terminal status): a row that no longer reads
        // running (a report adopted from disk, an archive) can never take a goal turn, so the
        // accounting decides nothing and the re-run takes the same branch now as after it (#6994).
        findWorkspaceEntry(this.deps.config().loadConfigOrDefault(), taskId)?.workspace
          .taskStatus !== "running"
      ) {
        cancelled.resolve();
      }
    };
    this.deps.addAttemptSettlementListener(taskId, listener);
    listener();
    log.info("[task-goal] stream accounting unsettled; deferring the child stream end", {
      taskId,
      messageId: event.messageId,
    });
    void Promise.race([
      goalService.streamAccountingReceiptOutcome(taskId, event.messageId),
      cancelled.promise,
    ])
      .finally(() => this.deps.removeAttemptSettlementListener(taskId, listener))
      .then(() => {
        // #7003: this stream deferred while its row read running, and nothing moves a running row
        // to a completed report under the same attempt but a publication (ours resolved the
        // decision already) or another backend's. So that attempt reported: the re-run's
        // `reported` branch must not leave the decision `nonreport`, or a held follow-up would
        // start a new turn of a reported attempt.
        this.resolveDecisionOfReportedAttempt(taskId, attemptId, decision);
        this.runStreamEndHandler(event, queueCutSnapshot, taskOrigin, decision);
      })
      .catch((error: unknown) => {
        log.error("TaskService: deferred child stream end failed", { taskId, error });
        this.resolveStreamEndDecision(taskId, decision, "indeterminate");
      });
  }

  /**
   * Register the pending decision for the ended stream of `attempt` (owned) or, when this process
   * owns none, of the persisted `unownedAttemptId`. Synchronous, event tick only.
   */
  registerStreamEndDecision(
    taskId: string,
    messageId: string,
    attempt: OwnedTaskAttempt | undefined,
    unownedAttemptId: string | undefined
  ): StreamEndDecision | undefined {
    const attemptId = attempt != null ? attempt.attemptId : unownedAttemptId;
    if (attemptId == null) return undefined;
    const decision: StreamEndDecision = {
      attempt,
      attemptId,
      messageId,
      outcome: "pending",
      turn: this.deps.workspaceService().getActiveTurnGeneration(taskId),
    };
    const decisions = this.streamEndDecisionsByTaskId.get(taskId) ?? [];
    decisions.push(decision);
    this.streamEndDecisionsByTaskId.set(taskId, decisions);
    return decision;
  }

  /** The decision a send bound to `attemptId` must honor: the pending one, else the latest. */
  findStreamEndDecision(taskId: string, attemptId: string): StreamEndDecision | undefined {
    let latest: StreamEndDecision | undefined;
    for (const decision of this.streamEndDecisionsByTaskId.get(taskId) ?? []) {
      if (decision.attemptId !== attemptId) continue;
      if (decision.outcome === "pending") return decision;
      latest = decision;
    }
    return latest;
  }

  /**
   * The handler's own pending decision for exactly `attempt` — or, for an unowned stream
   * (`attempt` undefined), the unowned decision for `unownedAttemptId` — none once resolved or
   * replaced.
   */
  findPendingStreamEndDecision(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    unownedAttemptId?: string
  ): StreamEndDecision | undefined {
    const attemptId = attempt != null ? attempt.attemptId : unownedAttemptId;
    if (attemptId == null) return undefined;
    const decision = this.findStreamEndDecision(taskId, attemptId);
    return decision?.outcome === "pending" && decision.attempt === attempt ? decision : undefined;
  }

  /**
   * Resolve exactly once (later calls, including the handler's finally, are no-ops), drop the
   * decision when nothing is left to read it, and wake the workspace's idle drain so a held entry
   * either dispatches (nonreport) or is refused and handed back (published/indeterminate) now
   * rather than at the next unrelated drain. Returns whether this call resolved it.
   */
  resolveStreamEndDecision(
    taskId: string,
    decision: StreamEndDecision | undefined,
    outcome: Exclude<StreamEndDecision["outcome"], "pending">
  ): boolean {
    if (decision?.outcome !== "pending") return false;
    decision.outcome = outcome;
    // A stream that published (or may have published) the report ends the attempt WITH a report:
    // it can never produce a no-report receipt, even after this decision is pruned below.
    if (outcome !== "nonreport" && decision.attempt != null) {
      decision.attempt.receiptEligible = false;
    }
    log.debug("[task-attempt] stream-end decision resolved", {
      taskId,
      attemptId: decision.attemptId,
      messageId: decision.messageId,
      outcome,
    });
    this.pruneStreamEndDecisions(taskId);
    // A stop record of this attempt waits for the decision (recheckWorkspaceStopRelease).
    this.deps.recheckWorkspaceStopRelease(taskId);
    this.deps.workspaceService().drainQueuedMessagesIfIdle(taskId);
    return true;
  }

  /**
   * Drop resolved decisions no pending/enqueued obligation of their attempt can still read — a
   * terminal one only once its reporting turn settled too (a later reader can still arrive while
   * that turn is live; see StreamEndDecision).
   */
  pruneStreamEndDecisions(taskId: string): void {
    const decisions = this.streamEndDecisionsByTaskId.get(taskId);
    if (decisions == null) return;
    const readers = new Set<string>();
    for (const send of this.deps.sendsOf(taskId)) {
      if (send.state === "pending" || send.state === "enqueued") readers.add(send.attemptId);
    }
    const kept = decisions.filter(
      (decision) =>
        decision.outcome === "pending" ||
        readers.has(decision.attemptId) ||
        (decision.outcome !== "nonreport" && decision.turn != null)
    );
    if (kept.length === 0) this.streamEndDecisionsByTaskId.delete(taskId);
    else if (kept.length !== decisions.length) this.streamEndDecisionsByTaskId.set(taskId, kept);
  }

  /**
   * Settle a deferred cut from the recorded successor outcome. Runs under the task's
   * workspaceEventLock (from handleStreamEnd, the queue-change listener, stream-abort and error
   * handlers). Only `canceled`/`prestream-failed` (recover once) and `streaming` (transfer) settle
   * it; `pending`/`admitted` keep waiting. A task whose execution or stop epoch moved on, or that
   * left `running`, drops the deferral without recovery.
   */
  async reconcileDeferredTaskStreamEnd(workspaceId: string): Promise<boolean> {
    const deferral = this.deferredTaskStreamEnds.get(workspaceId);
    if (deferral == null) return false;
    const entry = findWorkspaceEntry(this.deps.config().loadConfigOrDefault(), workspaceId);
    if (
      entry?.workspace.parentWorkspaceId == null ||
      entry.workspace.taskStatus !== "running" ||
      rowSupersedes(entry.workspace, deferral.attemptId) ||
      entry.workspace.taskExecutionId !== deferral.executionId ||
      this.deps.getWorkspaceStopEpoch(workspaceId) !== deferral.stopEpoch
    ) {
      this.deferredTaskStreamEnds.delete(workspaceId);
      this.deps.workspaceService().disposeQueueCut(workspaceId, deferral.continuationEntryId);
      return false;
    }
    const receipt = this.deps
      .workspaceService()
      .getQueueCutReceipt(workspaceId, deferral.continuationEntryId);
    if (receipt == null || receipt.successor === "streaming") {
      this.deferredTaskStreamEnds.delete(workspaceId);
      return false;
    }
    if (receipt.successor !== "canceled" && receipt.successor !== "prestream-failed") {
      return false;
    }
    this.deferredTaskStreamEnds.delete(workspaceId);
    if (!this.deps.workspaceService().disposeQueueCut(workspaceId, deferral.continuationEntryId)) {
      return true;
    }
    log.debug("Deferred task stream end recovering: continuation withdrawn", {
      workspaceId,
      sourceMessageId: deferral.sourceMessageId,
      continuationEntryId: deferral.continuationEntryId,
      successor: receipt.successor,
    });
    // Recovery acts for the cut stream's attempt only (its writes and prompt are CAS'd on it).
    await this.deps.recoverTaskFromIncompleteStreamEnd(
      workspaceId,
      entry.workspace.taskStatus,
      deferral.attemptId
    );
    return true;
  }

  /**
   * The row reads a completed report for `attemptId` (#7003): that attempt reported, possibly on
   * another backend. Its pending stream-end decision (`decision`, else the attempt's) resolves
   * `indeterminate`, as publication's not-durable branch does: held follow-ups are refused and
   * handed back, never run as a new turn of a reported attempt. Returns whether the row reads so.
   */
  resolveDecisionOfReportedAttempt(
    taskId: string,
    attemptId: string | undefined,
    decision?: StreamEndDecision
  ): boolean {
    if (attemptId == null) return false;
    const workspace = findWorkspaceEntry(
      this.deps.config().loadConfigOrDefault(),
      taskId
    )?.workspace;
    if (workspace?.taskAttemptId !== attemptId || !hasCompletedAgentReport(workspace)) return false;
    this.resolveStreamEndDecision(
      taskId,
      decision ?? this.findStreamEndDecision(taskId, attemptId),
      "indeterminate"
    );
    return true;
  }

  /**
   * Owner settlement of `turnGeneration` (TaskService.recordWorkspaceTurnSettled): a terminal
   * decision held for this turn's late readers is kept now only by actual readers.
   */
  settleTurn(workspaceId: string, turnGeneration: symbol): void {
    let decisionTurnSettled = false;
    for (const decision of this.streamEndDecisionsByTaskId.get(workspaceId) ?? []) {
      if (decision.turn !== turnGeneration) continue;
      decision.turn = undefined;
      decisionTurnSettled = true;
    }
    if (decisionTurnSettled) this.pruneStreamEndDecisions(workspaceId);
  }

  /** Supersession (TaskService.recordWorkspaceTurnSuperseded): rebind decisions to `next`. */
  rebindTurn(workspaceId: string, previous: symbol, next: symbol): void {
    for (const decision of this.streamEndDecisionsByTaskId.get(workspaceId) ?? []) {
      if (decision.turn === previous) decision.turn = next;
    }
  }

  /** A new attempt begins (AttemptLedger.beginOwnedTaskAttempt): drop the task's decisions. */
  discardStreamEndDecisions(taskId: string): void {
    this.streamEndDecisionsByTaskId.delete(taskId);
  }

  hasDeferral(taskId: string): boolean {
    return this.deferredTaskStreamEnds.has(taskId);
  }

  deferralOf(taskId: string): TaskStreamEndDeferral | undefined {
    return this.deferredTaskStreamEnds.get(taskId);
  }

  recordDeferral(taskId: string, deferral: TaskStreamEndDeferral): void {
    this.deferredTaskStreamEnds.set(taskId, deferral);
  }

  forgetDeferral(taskId: string): void {
    this.deferredTaskStreamEnds.delete(taskId);
  }
}
