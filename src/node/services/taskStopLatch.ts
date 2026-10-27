import type { Config } from "@/node/config";
import {
  TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS,
  TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import { isActiveWorkspaceTurnTaskStatus } from "@/node/services/taskHandleStore";
import type { SubagentAttemptSettlementSource } from "@/node/services/subagentAttemptSettlements";
import type {
  AdmittedSend,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamEndDecision,
  WorkspaceStopRecord,
} from "@/node/services/taskService";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import type { TerminalAttentionNotifier } from "@/node/services/terminalAttentionNotifier";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";

/**
 * Everything the stop latch reads from TaskService. Each entry is a call-time closure over
 * TaskService, never a captured value or bound method: tests swap TaskService fields and patch
 * its methods after construction. Attempt, send and stream-end state stays with its owners
 * (AttemptLedger, StreamEndLedger) and is reached only through these closures.
 */
export interface TaskStopLatchDeps {
  config: () => Pick<Config, "loadConfigOrDefault">;
  aiService: () => Pick<AIService, "stopStream">;
  workspaceService: () => Pick<WorkspaceHost, "getActiveTurnGeneration" | "clearQueue">;
  turnManager: () => Pick<
    WorkspaceTurnManager,
    | "getLiveWorkspaceTurnRegistration"
    | "captureQueueCutAttributionSnapshot"
    | "interruptWorkspaceTurn"
  >;
  terminalAttention: () => Pick<TerminalAttentionNotifier, "suppressTerminalAttention">;
  scheduleMaybeStartQueuedTasks: () => void;
  /** PeerSendParking.scheduleParkedPeerSendFlush. */
  scheduleParkedPeerSendFlush: (workspaceId: string) => void;
  notifyAttemptSettlementListeners: (taskId: string) => void;
  addAttemptSettlementListener: (taskId: string, listener: () => void) => void;
  removeAttemptSettlementListener: (taskId: string, listener: () => void) => void;
  /** This process's owned attempt for the task (AttemptLedger.ownedAttemptByTaskId). */
  ownedAttempt: (taskId: string) => OwnedTaskAttempt | undefined;
  currentTaskAttemptId: (taskId: string) => string | undefined;
  /** The task's live set of send obligations; its sends are captured by reference. */
  admittedSends: (taskId: string) => ReadonlySet<AdmittedSend> | undefined;
  ownsReceiptEligibleAttempt: (taskId: string, attempt: OwnedTaskAttempt | undefined) => boolean;
  findStreamEndDecision: (taskId: string, attemptId: string) => StreamEndDecision | undefined;
  decideSettlementReceipt: (
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    settlementSource: string
  ) => SettlementReceiptDecision;
  writeSettlementReceipt: (
    taskId: string,
    target: Extract<SettlementReceiptDecision, { kind: "write" }>,
    source: SubagentAttemptSettlementSource
  ) => Promise<boolean>;
  closeAttemptAdmission: (
    taskId: string,
    attemptId: string | undefined,
    ownedAttempt: OwnedTaskAttempt | undefined,
    source: string
  ) => void;
  settleOwnedTaskAttempt: (
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    source: string
  ) => void;
  recheckResumeFailureSettlement: (taskId: string) => void;
}

/**
 * The stop record's release conditions hold: no cleanup owed, a durable stop marker, no captured
 * turn or pending admission left, and the captured execution settled.
 */
function isWorkspaceStopRecordSettled(record: WorkspaceStopRecord): boolean {
  if (record.cleanupInFlight > 0) return false;
  return (
    record.stopPersisted &&
    record.capturedTurns.size === 0 &&
    record.pendingAdmissions.size === 0 &&
    record.executionSettled
  );
}

/**
 * Stop latch state: the per-workspace stop epochs, the refcounted stop-in-progress latches, the
 * queue rechecks a held latch owes and the stop records that decide when a latch may drop
 * (Phase A capture, Phase B cleanup, Phase C release). The attempt settlement a release records
 * stays on TaskService and runs through the deps.
 */
export class TaskStopLatch {
  /**
   * Monotonic per-workspace stop generation, bumped synchronously at every explicit stop
   * boundary (user Stop suppression, task_stop interruption, workspace-turn interruption).
   * Peer-send admission captures its endpoints' generations and refuses when any changed:
   * unlike the level-triggered suppression set and persisted statuses — which a quick user
   * resume clears between probe evaluations — a bump latches, so an intervening stop keeps
   * the in-flight send stale forever.
   */
  readonly workspaceStopEpochs = new Map<string, number>();
  /**
   * Level-triggered stop latches: workspace IDs whose stop cascade is currently between its
   * synchronous epoch bump and terminal status persistence. The epoch map alone cannot refuse
   * a send that ENTERS during that window — the post-bump generation becomes the send's clean
   * baseline while the endpoints' persisted statuses still read running — so peer-send
   * admission also rejects any endpoint chain holding an in-progress stop latch. Refcounted:
   * overlapping stops (a subtree stop racing a workspace-turn interrupt on the same workspace)
   * must not clear each other's latch.
   */
  readonly workspaceStopsInProgress = new Map<string, number>();
  /**
   * Latched workspace IDs whose held latch deferred a queued-task launch (own or parent latch;
   * see startReservedAgentTask). The launch record was handed back to "queued", and the queue is
   * rechecked exactly when that latch clears — not on every release (startup normalizes stopped
   * trees before any drain) and not on an unrelated scheduler trigger.
   */
  private readonly queueRechecksOwedByStopLatch = new Set<string>();
  /** Stop latches retained past their cascade because the stop could not be confirmed; released on authoritative terminal settlement. */
  /**
   * Ownership of every in-progress stop, keyed by workspace (see beginWorkspaceStop). The latch
   * a record guards drops only when BOTH hold: the captured owner settled authoritatively
   * (admitted turn generation ended; matching execution mirror settled) AND no cleanup issued
   * by the cascade is still in flight. Persisted statuses, stop results, and missing
   * registrations are not evidence — an accepted-but-preparing turn can still start.
   */
  readonly workspaceStopRecords = new Map<string, WorkspaceStopRecord>();

  constructor(private readonly deps: TaskStopLatchDeps) {}

  bumpWorkspaceStopEpoch(workspaceId: string): void {
    this.workspaceStopEpochs.set(workspaceId, (this.workspaceStopEpochs.get(workspaceId) ?? 0) + 1);
  }

  getWorkspaceStopEpoch(workspaceId: string): number {
    return this.workspaceStopEpochs.get(workspaceId) ?? 0;
  }

  /**
   * Hold a stop-in-progress latch for the given workspaces until the returned release runs.
   * Callers latch synchronously with the epoch bump and release only after the cascade has
   * persisted terminal state, so sends entering mid-stop are refused at admission.
   */
  latchWorkspaceStopsInProgress(workspaceIds: readonly string[]): () => void {
    for (const id of workspaceIds) {
      this.workspaceStopsInProgress.set(id, (this.workspaceStopsInProgress.get(id) ?? 0) + 1);
    }
    return () => {
      for (const id of workspaceIds) {
        const count = this.workspaceStopsInProgress.get(id) ?? 0;
        if (count <= 1) {
          this.workspaceStopsInProgress.delete(id);
          if (this.queueRechecksOwedByStopLatch.delete(id)) {
            this.deps.scheduleMaybeStartQueuedTasks();
          }
          this.deps.notifyAttemptSettlementListeners(id);
          // An interrupted delegated turn releases its registration while this latch is held.
          this.deps.scheduleParkedPeerSendFlush(id);
        } else {
          this.workspaceStopsInProgress.set(id, count - 1);
        }
      }
    };
  }

  isWorkspaceStopInProgress(workspaceId: string): boolean {
    return this.workspaceStopsInProgress.has(workspaceId);
  }

  /**
   * Stop-cascade launch barrier: true (and the queue recheck owed to the held latch recorded)
   * while the task's own or its parent's stop latch is held. The record stays/returns to
   * "queued"; the latch release rechecks the queue (see queueRechecksOwedByStopLatch).
   */
  deferLaunchWhileStopInProgress(taskId: string, parentWorkspaceId: string | undefined): boolean {
    let deferred = false;
    for (const id of [taskId, parentWorkspaceId]) {
      if (id != null && this.isWorkspaceStopInProgress(id)) {
        this.queueRechecksOwedByStopLatch.add(id);
        deferred = true;
      }
    }
    return deferred;
  }

  /**
   * Phase A of a stop cascade (synchronous, under the global mutex): bump the epoch, latch the
   * workspace and record what must settle before the latch may drop — the admitted turn
   * generation (owner of any preparing/streaming work) and the live execution mirror. Nothing
   * admitted after this point exists (admission barrier), so these captures are complete.
   * Overlapping cascades add their release to the same record instead of resetting ownership.
   */
  beginWorkspaceStop(workspaceId: string): WorkspaceStopRecord {
    this.bumpWorkspaceStopEpoch(workspaceId);
    const release = this.latchWorkspaceStopsInProgress([workspaceId]);
    const existing = this.workspaceStopRecords.get(workspaceId);
    if (existing != null) {
      // An overlapping cascade adds its release and plans its own cleanup; ownership of the
      // earlier cascade's counts is untouched.
      existing.releases.push(release);
      existing.cleanupInFlight += 1;
      return existing;
    }
    const capturedTurn = this.deps.workspaceService().getActiveTurnGeneration(workspaceId);
    const capturedExecutionId = this.deps
      .turnManager()
      .getLiveWorkspaceTurnRegistration(workspaceId)?.handleId;
    const ownedAttempt = this.deps.ownedAttempt(workspaceId);
    const attemptId = ownedAttempt?.attemptId ?? this.deps.currentTaskAttemptId(workspaceId);
    const record: WorkspaceStopRecord = {
      releases: [release],
      cleanupInFlight: 1,
      attemptId,
      capturedTurns: new Set(capturedTurn != null ? [capturedTurn] : []),
      pendingAdmissions: new Set(),
      capturedExecutionId,
      // A registration whose mirror already persisted terminally is settled (its settlement
      // callback ran before this capture and will not run again).
      executionSettled:
        capturedExecutionId == null ||
        this.isExecutionMirrorSettled(workspaceId, capturedExecutionId),
      stopPersisted: false,
      ownedAttempt,
      capturedStreamMessageId: this.deps
        .turnManager()
        .captureQueueCutAttributionSnapshot(workspaceId).activeStream?.messageId,
    };
    // Sends admitted against this attempt that have not claimed a turn yet are part of what
    // must settle: captured by reference so a later obligation of a successor attempt (or one
    // already superseded) can never enter this record.
    for (const send of this.deps.admittedSends(workspaceId) ?? []) {
      if (send.attemptId !== attemptId) continue;
      if (send.state !== "pending" && send.state !== "enqueued") continue;
      record.pendingAdmissions.add(send);
      send.capturedBy.add(record);
    }
    this.workspaceStopRecords.set(workspaceId, record);
    return record;
  }

  /**
   * Phase B (outside the global mutex): every descendant's clearQueue + stopStream, issued
   * exactly once while its latch is held and targeted at the execution captured in Phase A, raced
   * concurrently under a per-child and one aggregate deadline. A timeout abandons the WAIT only:
   * the original promise keeps its cleanup ownership and its later settlement rechecks release.
   * Must run for EVERY id latched in Phase A (each planned one cleanup), so callers pass the
   * full latched set even when Phase A failed midway.
   */
  async runWorkspaceStopCleanup(
    targets: readonly string[],
    options: {
      label: string;
      abandonPartial: boolean;
      clearQueue: boolean;
      /**
       * Live continuation handles captured in Phase A (see WorkspaceStopRecord.capturedExecutionId),
       * interrupted here so their mirror settles: the stream stop below is a `system` abort, which
       * never settles a workspace-turn handle (only a user abort does), so without this the record
       * would wait for an execution settlement that never comes and hold the latch until restart.
       */
      capturedExecutionsById?: ReadonlyMap<string, { ownerWorkspaceId: string; handleId: string }>;
      onTimeout?: (workspaceId: string) => void;
    }
  ): Promise<void> {
    const waits = targets.map(async (id) => {
      // Consumes the unit planned by beginWorkspaceStop; the finally below pays it back.
      const record = this.workspaceStopRecords.get(id);
      const expectedMessageId = record?.capturedStreamMessageId;
      const cleanup = (async () => {
        if (options.clearQueue) {
          // AgentSession stream-end cleanup auto-flushes queued messages, so a stopped
          // descendant must not keep pending input; issued once, never re-issued later. The
          // user's queued messages are handed back as held input, never silently dropped.
          try {
            const clearQueueResult = this.deps.workspaceService().clearQueue(id, {
              preserveUserInput: true,
            });
            if (!clearQueueResult.success) {
              log.debug(`${options.label}: clearQueue failed`, {
                taskId: id,
                error: clearQueueResult.error,
              });
            }
          } catch (error: unknown) {
            log.debug(`${options.label}: clearQueue threw`, { taskId: id, error });
          }
        }
        const execution = options.capturedExecutionsById?.get(id);
        if (execution != null) {
          await this.interruptCapturedExecution(id, execution, options.label);
        }
        // Success is NOT stop confirmation (an accepted-but-PREPARING turn has no registered
        // stream yet); only the owner's settlement recorded on the stop record confirms.
        const stopResult = await this.deps.aiService().stopStream(id, {
          abandonPartial: options.abandonPartial,
          ...(expectedMessageId != null ? { expectedMessageId } : {}),
        });
        if (!stopResult.success) {
          log.debug(`${options.label}: stopStream failed`, { taskId: id });
        }
      })();
      // Ownership stays with the original promise: only ITS settlement (however late) counts
      // the cleanup as finished, and even then it merely triggers a recheck.
      void cleanup
        .catch((error: unknown) => {
          log.debug(`${options.label}: cleanup threw`, { taskId: id, error });
        })
        .finally(() => {
          if (record != null) record.cleanupInFlight -= 1;
          this.recheckWorkspaceStopRelease(id);
        });
      const outcome = await raceWithAbortAndTimeout(cleanup, {
        timeoutMs: TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS,
      });
      if (outcome.kind !== "ok") {
        log.warn(`${options.label}: stopStream timed out; retaining stop latch`, { taskId: id });
        options.onTimeout?.(id);
      }
    });
    const aggregate = await raceWithAbortAndTimeout(Promise.allSettled(waits), {
      timeoutMs: TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS,
    });
    if (aggregate.kind !== "ok") {
      log.warn(`${options.label}: cleanup exceeded the aggregate deadline`, {
        taskIds: targets,
      });
    }
  }

  /**
   * Settle the continuation handle a stop record captured (a reawakened child executes under a
   * WorkspaceTurnManager handle): interruptWorkspaceTurn persists the handle and its execution
   * mirror terminal within one settlement boundary and drops the live registration, which is the
   * authoritative execution settlement the record waits on (releaseRetainedStopLatches). Same
   * pairing as the task_stop subtree stop (finishSubtreeStopCleanup): the owner's terminal wake
   * for a handle the stop itself interrupted is suppressed. A failure leaves the record waiting
   * (fail closed), exactly as an unsettled execution does today.
   */
  private async interruptCapturedExecution(
    taskId: string,
    execution: { ownerWorkspaceId: string; handleId: string },
    label: string
  ): Promise<void> {
    const interrupted = await this.deps
      .turnManager()
      .interruptWorkspaceTurn(execution.ownerWorkspaceId, execution.handleId, {
        scheduleQueueDrain: false,
      });
    if (!interrupted.success) {
      log.warn(`${label}: interruptWorkspaceTurn failed for the captured execution`, {
        taskId,
        handleId: execution.handleId,
        error: interrupted.error,
      });
      return;
    }
    await this.deps.terminalAttention().suppressTerminalAttention({
      ownerWorkspaceId: execution.ownerWorkspaceId,
      sourceKind: "workspace_turn",
      sourceId: execution.handleId,
    });
  }

  /**
   * Phase C: drop the latch iff the captured owner settled, a durable stop marker exists and no
   * cleanup is owed. Called from every settlement path; a late cleanup completion or a
   * persisted-status caller only triggers this recheck and never supplies evidence by itself.
   * A missing config entry is NOT evidence: a still-preparing session settles through its own
   * disposal (the coordinator publishes the captured generation's idle transition).
   */
  recheckWorkspaceStopRelease(workspaceId: string): void {
    const record = this.workspaceStopRecords.get(workspaceId);
    if (record == null) return;
    if (!isWorkspaceStopRecordSettled(record)) return;
    // Execution-settlement producer: the receipt is durable before the latch releases, so nothing
    // the latch holds back (a reawaken, a peer send, a queued launch) observes the stopped attempt
    // as released while its receipt could still be missing. The record stays registered (latched)
    // for the write; its completion rechecks, releasing the latch and recording the settlement in
    // one step as before. A failed write (or an unreadable config) still releases, with the
    // attempt left `closing` (fail closed) instead of pinning the latch until restart.
    if (record.receipt === "writing") return;
    if (this.isStopReceiptDecisionPending(workspaceId, record)) return;
    if (record.receipt == null && this.startStopSettlementReceipt(workspaceId, record)) return;
    this.releaseWorkspaceStopRecord(workspaceId, record);
  }

  /**
   * A receipt can be at stake: wait for the attempt's pending stream-end decision (its report
   * may still publish); resolveStreamEndDecision rechecks. Without a receipt at stake the
   * release keeps its previous timing.
   */
  private isStopReceiptDecisionPending(workspaceId: string, record: WorkspaceStopRecord): boolean {
    return (
      record.receipt == null &&
      record.attemptId != null &&
      this.deps.ownsReceiptEligibleAttempt(workspaceId, record.ownedAttempt) &&
      this.deps.findStreamEndDecision(workspaceId, record.attemptId)?.outcome === "pending"
    );
  }

  /**
   * Decide the stopped attempt's settlement receipt and start its write. Returns true while the
   * write is in flight (the release waits for its completion recheck). An unreadable config marks
   * the receipt failed and lets the release go ahead.
   */
  private startStopSettlementReceipt(workspaceId: string, record: WorkspaceStopRecord): boolean {
    const decision = this.deps.decideSettlementReceipt(
      workspaceId,
      record.ownedAttempt,
      "stop-settled"
    );
    if (decision.kind === "unreadable") record.receipt = "failed";
    if (decision.kind !== "write") return false;
    record.receipt = "writing";
    void this.deps
      .writeSettlementReceipt(workspaceId, decision, "execution-settled")
      .then(
        (written) => {
          record.receipt = written ? "written" : "failed";
        },
        (error: unknown) => {
          log.error("Stop release: settlement receipt write threw", { workspaceId, error });
          record.receipt = "failed";
        }
      )
      .finally(() => this.recheckWorkspaceStopRelease(workspaceId));
    return true;
  }

  /** Release step of recheckWorkspaceStopRelease: drop the latch and settle the stopped attempt. */
  private releaseWorkspaceStopRecord(workspaceId: string, record: WorkspaceStopRecord): void {
    this.workspaceStopRecords.delete(workspaceId);
    for (const release of record.releases) {
      release();
    }
    // Owner settled + cleanup finished + marker persisted: authoritative for the attempt captured
    // in Phase A. An unknown (legacy) attempt has none to settle — stopping it proves nothing,
    // but its id is closed to further sends until a new admission rotates it.
    if (record.ownedAttempt == null && record.attemptId != null) {
      this.deps.closeAttemptAdmission(workspaceId, record.attemptId, undefined, "stop-settled");
    }
    // A failed receipt write leaves the attempt `closing` (never settled without its receipt).
    if (record.receipt !== "failed") {
      this.deps.settleOwnedTaskAttempt(workspaceId, record.ownedAttempt, "stop-settled");
    }
    // A failed reawaken's settlement deferred to this Stop (#4310): drop or finish it now; no
    // later disposal or turn settlement is guaranteed to recheck it.
    this.deps.recheckResumeFailureSettlement(workspaceId);
  }

  /**
   * Authoritative execution settlement (WorkspaceTurnManager settled the MATCHING execution
   * mirror and removed its live registration). Records the evidence for the captured execution
   * and rechecks; persisted interrupted statuses from other callers reach only the recheck.
   */
  releaseRetainedStopLatches(workspaceId: string): void {
    const record = this.workspaceStopRecords.get(workspaceId);
    if (record == null) return;
    const liveHandleId = this.deps
      .turnManager()
      .getLiveWorkspaceTurnRegistration(workspaceId)?.handleId;
    if (
      record.capturedExecutionId != null &&
      (liveHandleId !== record.capturedExecutionId ||
        this.isExecutionMirrorSettled(workspaceId, record.capturedExecutionId))
    ) {
      record.executionSettled = true;
    }
    this.recheckWorkspaceStopRelease(workspaceId);
  }

  /** The persisted execution mirror for this handle is terminal (settled by its owner). */
  private isExecutionMirrorSettled(workspaceId: string, handleId: string): boolean {
    const workspace = findWorkspaceEntry(
      this.deps.config().loadConfigOrDefault(),
      workspaceId
    )?.workspace;
    return (
      workspace?.taskExecutionId === handleId &&
      !isActiveWorkspaceTurnTaskStatus(workspace.taskExecutionStatus)
    );
  }

  /** Phase A recorded a durable stop marker for this workspace (see WorkspaceStopRecord). */
  markWorkspaceStopPersisted(workspaceId: string): void {
    const record = this.workspaceStopRecords.get(workspaceId);
    if (record == null) return;
    record.stopPersisted = true;
    // A deferred child stream end cancels on this notification (the stop is in progress), so its
    // pending decision cannot hold the latch. Every caller runs after its durable status write, or
    // where no status is left to write (a removed row, or an already-terminal status that is the
    // marker), on every branch, including those that skip recordTaskInterrupted: a terminate whose
    // removal keeps the workspace (#6920), or a status already interrupted by an archive (#6967).
    this.deps.notifyAttemptSettlementListeners(workspaceId);
  }

  /**
   * Resolve once none of `workspaceIds` holds a Stop latch, or at `deadlineMs`. A Stop releases
   * its latch only after its settlement receipt is durable or failed (recheckWorkspaceStopRelease),
   * and the release notifies the attempt settlement listeners.
   */
  async waitForWorkspaceStopsToRelease(
    workspaceIds: readonly string[],
    deadlineMs: number
  ): Promise<void> {
    for (const id of workspaceIds) {
      while (this.isWorkspaceStopInProgress(id)) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          log.warn("Stop latch still held at the cleanup deadline; its receipt may be missing", {
            taskId: id,
          });
          return;
        }
        const released = Promise.withResolvers<void>();
        const listener = () => released.resolve();
        this.deps.addAttemptSettlementListener(id, listener);
        try {
          await raceWithAbortAndTimeout(released.promise, { timeoutMs: remainingMs });
        } finally {
          this.deps.removeAttemptSettlementListener(id, listener);
        }
      }
    }
  }

  /** noteWorkspaceRemoved: drop the removed workspace's stop generation (#5334). */
  forgetStopEpoch(workspaceId: string): void {
    this.workspaceStopEpochs.delete(workspaceId);
  }

  /** A stop cascade still holds a record for this workspace. */
  hasStopRecord(workspaceId: string): boolean {
    return this.workspaceStopRecords.has(workspaceId);
  }

  /** `record` is still the workspace's registered stop record (not yet released). */
  isCurrentStopRecord(workspaceId: string, record: WorkspaceStopRecord): boolean {
    return this.workspaceStopRecords.get(workspaceId) === record;
  }

  /** The attempt the workspace's registered stop record stops; undefined without a record. */
  stopRecordAttemptId(workspaceId: string): string | undefined {
    return this.workspaceStopRecords.get(workspaceId)?.attemptId;
  }

  /** TaskService.recordWorkspaceTurnSettled: release the settled turn from the stop record. */
  releaseCapturedTurn(workspaceId: string, turnGeneration: symbol): void {
    const record = this.workspaceStopRecords.get(workspaceId);
    if (!record?.capturedTurns.has(turnGeneration)) return;
    record.capturedTurns.delete(turnGeneration);
    this.recheckWorkspaceStopRelease(workspaceId);
  }

  /** TaskService.recordWorkspaceTurnSuperseded: the stop record waits on the successor turn. */
  rebindCapturedTurn(workspaceId: string, previous: symbol, next: symbol): void {
    const record = this.workspaceStopRecords.get(workspaceId);
    if (!record?.capturedTurns.has(previous)) return;
    record.capturedTurns.delete(previous);
    record.capturedTurns.add(next);
  }
}
