import assert from "node:assert/strict";
import * as path from "node:path";
import { getErrorMessage } from "@/common/utils/errors";
import type { TaskAttemptOutcome, TaskAttemptSettlement } from "@/common/types/tasks";
import type { Config } from "@/node/config";
import type { AgentTaskIndex } from "@/node/services/agentTaskIndex";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import {
  writeSubagentAttemptSettlementReceipt,
  type SubagentAttemptSettlementSource,
} from "@/node/services/subagentAttemptSettlements";
import type {
  AdmittedSend,
  AgentTaskReport,
  AttemptSettlementEntry,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamEndDecision,
} from "@/node/services/taskService";
import { coerceNonEmptyString, findWorkspaceEntry, rowSupersedes } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { assertTaskAttemptId } from "@/node/utils/taskAttemptId";

/**
 * Everything the attempt ledger reads from TaskService. Each entry is a call-time closure over
 * TaskService, never a captured value or bound method: tests swap TaskService fields and patch
 * its methods after construction. Methods tests spy on (closeAttemptAdmission,
 * decideSettlementReceipt, writeSettlementReceipt, inspectAttemptOutcome) and the other
 * TaskService facades are called back through TaskService so every call reaches the spy. Stop,
 * send and stream-end state stays with its owner and is reached only through these closures.
 */
export interface AttemptLedgerDeps {
  config: () => Pick<Config, "loadConfigOrDefault" | "sessionsDir">;
  aiService: () => Pick<AIService, "isStreaming">;
  workspaceService: () => Pick<WorkspaceHost, "getActiveTurnGeneration">;
  turnManager: () => Pick<WorkspaceTurnManager, "getLiveWorkspaceTurnRegistration">;
  workspaceEventLocks: () => Pick<MutexMap<string>, "withLock">;
  buildAgentTaskIndex: (config: ReturnType<Config["loadConfigOrDefault"]>) => AgentTaskIndex;
  listAncestorWorkspaceIdsUsingParentById: (
    parentById: Map<string, string>,
    taskId: string
  ) => string[];
  /** TaskStopLatch.stopRecordAttemptId. */
  stopRecordAttemptId: (taskId: string) => string | undefined;
  /** TaskStopLatch.hasStopRecord. */
  hasStopRecord: (taskId: string) => boolean;
  /** The task's live set of send obligations (TaskService.admittedSendsByTaskId). */
  admittedSends: (taskId: string) => ReadonlySet<AdmittedSend> | undefined;
  findStreamEndDecision: (taskId: string, attemptId: string) => StreamEndDecision | undefined;
  /** Drop every stream-end decision of the task (TaskService.streamEndDecisionsByTaskId). */
  discardStreamEndDecisions: (taskId: string) => void;
  inspectAttemptOutcome: (
    taskId: string,
    options?: { requestingWorkspaceId?: string }
  ) => Promise<TaskAttemptOutcome<AgentTaskReport>>;
  notifyAttemptSettlementListeners: (taskId: string) => void;
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
  decideSettlementReceipt: (
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    settlementSource: string
  ) => SettlementReceiptDecision;
  writeSettlementReceipt: (
    taskId: string,
    target: { attemptId: string; parentWorkspaceId: string; owners: string[] },
    source: SubagentAttemptSettlementSource
  ) => Promise<boolean>;
}

/**
 * Attempt identity and settlement state: the attempt this process owns per task, the
 * closure/settlement of exactly the attempt it names, the listeners waiting on either, the
 * failed reawakens still owed a settlement, and the settlement receipts written for owned
 * attempts. Stop records, send obligations and stream-end decisions stay with their owners and
 * are reached through the deps.
 */
export class AttemptLedger {
  /**
   * Attempt ownership ledger (see OwnedTaskAttempt); replaced before any new admission, dropped
   * once the attempt's report is durable (releaseReportedTaskAttempt).
   */
  readonly ownedAttemptByTaskId = new Map<string, OwnedTaskAttempt>();
  /**
   * Closure/settlement of exactly the attempt it names (AttemptSettlementEntry). A `closing` entry
   * is recorded synchronously by every producer before its first awaited write and refuses further
   * sends under that id; only the owner's settleOwnedTaskAttempt upgrades it to `settled`. Never
   * removed by a failed write — a new admission (fresh id) is the only way to reopen.
   */
  readonly attemptSettlementByTaskId = new Map<string, AttemptSettlementEntry>();
  readonly attemptSettlementListenersByTaskId = new Map<string, Set<() => void>>();
  /**
   * Failed reawakens whose closed attempt still awaits settlement (#4310): the owner snapshot
   * restoreInterruptedTaskAfterResumeFailure closed, settled by recheckResumeFailureSettlement.
   */
  readonly resumeFailureSettlementByTaskId = new Map<
    string,
    OwnedTaskAttempt & { attemptId: string }
  >();
  /**
   * The last attempt id THIS process published for each task (every local rotation, owned or
   * not). Not an authority on the current id — currentTaskAttemptId reads the persisted row, so
   * a rotation committed by another process is honored and a row that is missing or unreadable
   * yields no id at all. Never read to classify or authorize: an unreadable registry refuses
   * every send regardless of this map (see admitTaskWorkspaceTurn), since absence here is no
   * proof that a workspace is not a task.
   */
  readonly currentAttemptIdByTaskId = new Map<string, string>();

  constructor(private readonly deps: AttemptLedgerDeps) {}

  /** This process's owned attempt for the task, if any. */
  ownedAttempt(taskId: string): OwnedTaskAttempt | undefined {
    return this.ownedAttemptByTaskId.get(taskId);
  }

  hasOwnedAttempt(taskId: string): boolean {
    return this.ownedAttemptByTaskId.has(taskId);
  }

  /** The task's closure/settlement entry, if any. */
  attemptSettlement(taskId: string): AttemptSettlementEntry | undefined {
    return this.attemptSettlementByTaskId.get(taskId);
  }

  /** Track a failed reawaken's closed attempt until recheckResumeFailureSettlement settles it. */
  recordResumeFailureSettlement(
    taskId: string,
    attempt: OwnedTaskAttempt & { attemptId: string }
  ): void {
    this.resumeFailureSettlementByTaskId.set(taskId, attempt);
  }

  /**
   * A new attempt begins in this process (reservation commit, launch, reawakening, reactivation).
   * Replaces the owned identity and drops any settlement of the previous attempt SYNCHRONOUSLY,
   * before the admission that follows — current ownership always wins over a stale settlement.
   */
  beginOwnedTaskAttempt(
    taskId: string,
    source: string,
    identity: { attemptId: string | undefined; receiptEligible: boolean; abortSignal?: AbortSignal }
  ): OwnedTaskAttempt {
    assert(taskId.length > 0, "beginOwnedTaskAttempt: taskId must be non-empty");
    if (identity.attemptId != null) {
      assertTaskAttemptId(identity.attemptId, "beginOwnedTaskAttempt");
    }
    const attempt: OwnedTaskAttempt = {
      generation: (this.ownedAttemptByTaskId.get(taskId)?.generation ?? 0) + 1,
      source,
      attemptId: identity.attemptId,
      receiptEligible: identity.receiptEligible,
      ...(identity.abortSignal != null ? { abortSignal: identity.abortSignal } : {}),
    };
    this.ownedAttemptByTaskId.set(taskId, attempt);
    if (identity.attemptId != null) this.currentAttemptIdByTaskId.set(taskId, identity.attemptId);
    // A closure recorded for THIS id (between the rotating CAS and this block) stays: the fresh
    // admission that follows must observe it and refuse. Only another attempt's entry is stale.
    if (this.attemptSettlementByTaskId.get(taskId)?.attemptId !== identity.attemptId) {
      this.attemptSettlementByTaskId.delete(taskId);
    }
    // Predecessors' stream-end decisions have no reader left that they could authorize: a send
    // bound to a predecessor reads stale from the row's new id at its next gate.
    this.deps.discardStreamEndDecisions(taskId);
    return attempt;
  }

  /**
   * Linearization point of every settlement producer: close the attempt to further sends BEFORE
   * the producer's first awaited write, so no send can be admitted for an id whose settlement is
   * under way. Synchronous — the admission fence (admitTaskWorkspaceTurn) is synchronous too, so
   * the two can never interleave and no lock is needed. Never downgrades a `settled` entry and
   * never touches an entry naming another attempt. `ownedAttempt` (the producer's snapshot of
   * this process's owner) is recorded only when it holds exactly `attemptId`.
   */
  closeAttemptAdmission(
    taskId: string,
    attemptId: string | undefined,
    ownedAttempt: OwnedTaskAttempt | undefined,
    source: string
  ): void {
    const existing = this.attemptSettlementByTaskId.get(taskId);
    if (existing != null && existing.attemptId === attemptId) return;
    const attempt = ownedAttempt?.attemptId === attemptId ? ownedAttempt : undefined;
    this.attemptSettlementByTaskId.set(taskId, {
      attemptId,
      ...(attempt != null ? { attempt } : {}),
      phase: "closing",
      source,
    });
    this.deps.notifyAttemptSettlementListeners(taskId);
  }

  /**
   * Authoritative settlement by the attempt's owner (stop record released, launch failed,
   * terminal stream failure). `attempt` is the identity captured BEFORE the owner's awaited
   * write; a settlement for an attempt that is no longer current, or for no owned attempt at
   * all (legacy/prior-process execution), is never recorded — only announced.
   */
  settleOwnedTaskAttempt(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    source: string
  ): void {
    if (attempt != null && this.ownedAttemptByTaskId.get(taskId) === attempt) {
      this.attemptSettlementByTaskId.set(taskId, {
        attemptId: attempt.attemptId,
        attempt,
        phase: "settled",
        source,
      });
    } else {
      log.debug("Task attempt settlement without a current owned attempt", {
        taskId,
        source,
        owned: attempt?.generation,
      });
    }
    this.deps.notifyAttemptSettlementListeners(taskId);
  }

  /**
   * Only this process's CURRENT owned attempt, admitted with proven lineage under a persisted id,
   * may produce a cross-process receipt. Anything else (unowned or prior-process attempt, marked
   * lineage, pre-identity entry, an owner a reawakening or a durable report already replaced)
   * settles in memory only, exactly as before receipts existed. In-memory checks only: whether
   * the row still names the attempt is decided by one strict read (readSettlementReceiptRow).
   */
  ownsReceiptEligibleAttempt(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined
  ): attempt is OwnedTaskAttempt & { attemptId: string } {
    return (
      attempt?.attemptId != null &&
      attempt.receiptEligible &&
      this.ownedAttemptByTaskId.get(taskId) === attempt
    );
  }

  /**
   * The one strict config read a receipt decision rests on. `ours`: the row names `attemptId`,
   * with the owner dirs to write into (parent first). `elsewhere`: CONFIRMED gone, parentless or
   * naming another attempt (rowSupersedes) — a successor another writer admitted must never be
   * vouched for by its predecessor's settlement. `unreadable`: the config (or the parent chain)
   * could not be read, which is no evidence either way and must never be taken for `elsewhere`.
   */
  private readSettlementReceiptRow(
    taskId: string,
    attemptId: string
  ):
    | { kind: "ours"; parentWorkspaceId: string; owners: string[] }
    | { kind: "elsewhere" }
    | { kind: "unreadable"; error: string } {
    let parentWorkspaceId: string | undefined;
    let owners: string[];
    try {
      const cfg = this.deps.config().loadConfigOrDefault({ throwOnError: true });
      const row = findWorkspaceEntry(cfg, taskId)?.workspace;
      parentWorkspaceId = coerceNonEmptyString(row?.parentWorkspaceId);
      if (row == null || parentWorkspaceId == null || rowSupersedes(row, attemptId)) {
        log.info("[task-attempt] settlement receipt skipped: the row no longer names the attempt", {
          taskId,
          attemptId,
          current: row?.taskAttemptId,
        });
        return { kind: "elsewhere" };
      }
      owners = this.deps.listAncestorWorkspaceIdsUsingParentById(
        this.deps.buildAgentTaskIndex(cfg).parentById,
        taskId
      );
    } catch (error: unknown) {
      // An unreadable config, or a parent cycle in it.
      return { kind: "unreadable", error: getErrorMessage(error) };
    }
    // Inconsistent ancestry is malformed config, not a programming error: fail closed like an
    // unreadable read instead of throwing out of a settlement path. (Duplicate workspace ids no
    // longer cause it: the row lookup and the task index both take the first row, #4550.)
    if (owners[0] !== parentWorkspaceId) {
      return {
        kind: "unreadable",
        error: `inconsistent ancestry for ${taskId}: parent ${parentWorkspaceId}, first owner ${owners[0] ?? "none"}`,
      };
    }
    return { kind: "ours", parentWorkspaceId, owners };
  }

  /**
   * Durable settlement for producers that established that no execution can still publish a
   * report for `attempt` (idle stop, idle terminal failure, reservation canceled/failed, launch
   * failed before its send): the receipt first, then the in-memory settlement.
   */
  async persistOwnedAttemptSettlement(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    receiptSource: SubagentAttemptSettlementSource,
    settlementSource: string
  ): Promise<void> {
    const decision = this.deps.decideSettlementReceipt(taskId, attempt, settlementSource);
    if (decision.kind === "unreadable") return;
    if (
      decision.kind === "write" &&
      !(await this.deps.writeSettlementReceipt(taskId, decision, receiptSource))
    ) {
      return;
    }
    this.deps.settleOwnedTaskAttempt(taskId, attempt, settlementSource);
  }

  /**
   * THE no-report boundary every receipt producer must prove, evaluated synchronously in the tick
   * that decides the write (see decideSettlementReceipt): a receipt may claim that `attempt` can no
   * longer publish a report only when ALL of these hold at once —
   *  1. it is closed to admissions: a closure names it (closeAttemptAdmission, recorded by the
   *     producer before its first await), or a stop record latched for it since capture;
   *  2. no send obligation of THIS attempt exists in any state (pending, enqueued, admitted) —
   *     keyed by attempt id, so a successor's obligations neither block nor satisfy it;
   *  3. nothing is live for the task: no turn generation, workspace-turn registration or stream
   *     (task-level signals; any of them blocks, which is the safe direction);
   *  4. no stream-end decision of the attempt is pending, and none resolved as a report
   *     (published) or unknowable (indeterminate). Such a resolution also downgrades the
   *     attempt's receiptEligible (resolveStreamEndDecision), so it still counts once the
   *     decision itself was pruned.
   * False means no durable claim: the producer settles in memory only, exactly as before receipts.
   */
  attemptCannotStillReport(
    taskId: string,
    attempt: OwnedTaskAttempt & { attemptId: string }
  ): boolean {
    const attemptId = attempt.attemptId;
    const closed =
      this.isAttemptClosed(taskId, attemptId) ||
      this.deps.stopRecordAttemptId(taskId) === attemptId;
    if (!closed) return false;
    for (const send of this.deps.admittedSends(taskId) ?? []) {
      if (send.attemptId === attemptId) return false;
    }
    if (
      this.deps.workspaceService().getActiveTurnGeneration(taskId) != null ||
      this.deps.turnManager().getLiveWorkspaceTurnRegistration(taskId) != null ||
      this.deps.aiService().isStreaming(taskId)
    ) {
      return false;
    }
    const decision = this.deps.findStreamEndDecision(taskId, attemptId);
    return decision == null || decision.outcome === "nonreport";
  }

  /**
   * closeAttemptAdmission that never replaces a closure recorded for a DIFFERENT attempt: used
   * where the row's current attempt is unknown or may differ (another writer re-admitted it), so
   * replacing that closure could reopen the row's attempt to sends.
   */
  closeAttemptAdmissionUnlessOtherClosed(
    taskId: string,
    attemptId: string,
    attempt: OwnedTaskAttempt | undefined,
    source: string
  ): void {
    const existing = this.attemptSettlementByTaskId.get(taskId);
    if (existing != null && existing.attemptId !== attemptId) return;
    this.deps.closeAttemptAdmission(taskId, attemptId, attempt, source);
  }

  /**
   * The synchronous half of a receipt-bearing settlement, from one strict read:
   *  - `memory-only`: no receipt authority (ownsReceiptEligibleAttempt), the no-report boundary is
   *    not proven (attemptCannotStillReport), or the read CONFIRMED the row gone or naming another
   *    attempt — today's in-memory-only settlement follows;
   *  - `write`: the row names the attempt, which is closed to sends here (before any await) and
   *    must not be settled until writeSettlementReceipt succeeds;
   *  - `unreadable`: no evidence either way, so fail closed — the attempt is closed but never
   *    settled (cleanup-pending here, indeterminate after a restart) and gets no receipt; with the
   *    row unknown, a closure recorded for a different attempt is kept (it may be the row's).
   * A failed write, like `unreadable`, leaves the attempt `closing`: never settled without its
   * receipt, so no successor reads it as settled when a restart would not.
   */
  decideSettlementReceipt(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    settlementSource: string
  ): SettlementReceiptDecision {
    if (!this.ownsReceiptEligibleAttempt(taskId, attempt)) return { kind: "memory-only" };
    const attemptId = attempt.attemptId;
    if (!this.attemptCannotStillReport(taskId, attempt)) return { kind: "memory-only" };
    const row = this.readSettlementReceiptRow(taskId, attemptId);
    if (row.kind === "elsewhere") return { kind: "memory-only" };
    if (row.kind === "unreadable") {
      log.warn("[task-attempt] settlement receipt not written: config unreadable", {
        taskId,
        attemptId,
        error: row.error,
      });
      this.closeAttemptAdmissionUnlessOtherClosed(taskId, attemptId, attempt, settlementSource);
      return { kind: "unreadable" };
    }
    // Synchronous with the read: the row names this attempt, so any closure replaced here names
    // an attempt the row no longer does.
    this.deps.closeAttemptAdmission(taskId, attemptId, attempt, settlementSource);
    return {
      kind: "write",
      attemptId,
      parentWorkspaceId: row.parentWorkspaceId,
      owners: row.owners,
    };
  }

  /**
   * Write the receipt into every owner dir: outermost ancestor first, the parent LAST, stopping
   * at the first failure, so the parent's copy (the one lineage proof reads) exists only once
   * every other owner holds one too. True when all writes succeeded. Never throws.
   */
  async writeSettlementReceipt(
    taskId: string,
    target: { attemptId: string; parentWorkspaceId: string; owners: string[] },
    source: SubagentAttemptSettlementSource
  ): Promise<boolean> {
    const receipt = {
      taskId,
      attemptId: target.attemptId,
      parentWorkspaceId: target.parentWorkspaceId,
      source,
      settledAt: new Date().toISOString(),
    };
    for (const ownerWorkspaceId of [...target.owners].reverse()) {
      const result = await writeSubagentAttemptSettlementReceipt({
        ownerWorkspaceSessionDirs: [path.join(this.deps.config().sessionsDir, ownerWorkspaceId)],
        receipt,
      });
      if (!result.success) {
        log.warn("[task-attempt] settlement receipt write failed; attempt left closing", {
          taskId,
          attemptId: target.attemptId,
          ownerWorkspaceId,
          error: result.error,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * The ledger entries of an attempt whose report is durable are redundant: every reader
   * (inspectAttemptOutcome, waitForAgentReport) classifies a persisted report first, so neither
   * this attempt's ownership nor its settlement can decide an outcome again. Dropping them keeps
   * the per-task ledgers bounded by the tasks still able to end without a report, instead of by
   * every task ever attempted in this process.
   *
   * `attempt` is the identity captured at the stream-end event that carried the report (see the
   * stream-end listener), so the drop names the attempt the report belongs to — a task reawakened
   * (markInterruptedTaskRunning, not under the task's event lock) while that report waited for
   * the lock or for its writes owns a different identity and stays owned; an older report never
   * decides the new attempt's outcome. Called only after every ancestor artifact write succeeded:
   * a report that is not durable everywhere leaves the entries in place.
   *
   * Interrupted-without-report receipts are deliberately NOT dropped here or on stop: an ancestor
   * that has not yet read terminal-no-report still needs the receipt after config cleanup, and no
   * consumer acknowledgement exists yet to bound that retention.
   *
   * The released shape (reported row, no owner, no settlement entry) is itself read by
   * markInterruptedTaskRunning: a manual follow-up into such a child mints a fresh attempt rather
   * than being admitted under the completed id.
   */
  releaseReportedTaskAttempt(taskId: string, attempt: OwnedTaskAttempt | undefined): void {
    if (attempt == null || this.ownedAttemptByTaskId.get(taskId) !== attempt) return;
    this.ownedAttemptByTaskId.delete(taskId);
    if (this.attemptSettlementByTaskId.get(taskId)?.attempt === attempt) {
      this.attemptSettlementByTaskId.delete(taskId);
    }
  }

  notifyAttemptSettlementListeners(taskId: string): void {
    const listeners = this.attemptSettlementListenersByTaskId.get(taskId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  /** TaskStopLatch's waits register here (TaskStopLatchDeps.addAttemptSettlementListener). */
  addAttemptSettlementListener(taskId: string, listener: () => void): void {
    const listeners = this.attemptSettlementListenersByTaskId.get(taskId) ?? new Set();
    listeners.add(listener);
    this.attemptSettlementListenersByTaskId.set(taskId, listeners);
  }

  removeAttemptSettlementListener(taskId: string, listener: () => void): void {
    const listeners = this.attemptSettlementListenersByTaskId.get(taskId);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) this.attemptSettlementListenersByTaskId.delete(taskId);
  }

  /**
   * Publish a committed identity rotation to in-memory state: record the id this process
   * committed (currentAttemptIdByTaskId), and drop a closure recorded for a previous attempt (a
   * closure for the NEW id, recorded between the CAS and this call, stays). Tokens minted for an
   * older id are revoked by the persisted row itself at their next gate.
   */
  publishAttemptRotation(taskId: string, attemptId: string): void {
    assertTaskAttemptId(attemptId, "publishAttemptRotation");
    this.currentAttemptIdByTaskId.set(taskId, attemptId);
    if (this.attemptSettlementByTaskId.get(taskId)?.attemptId !== attemptId) {
      this.attemptSettlementByTaskId.delete(taskId);
    }
  }

  /** A closure or settlement is recorded for exactly this attempt id. */
  isAttemptClosed(taskId: string, attemptId: string): boolean {
    const entry = this.attemptSettlementByTaskId.get(taskId);
    return entry?.attemptId === attemptId;
  }

  /** Resolve once the task's settlement entry leaves `closing` (or the bound elapses). */
  async waitForAttemptClosureToSettle(taskId: string, timeoutMs: number): Promise<void> {
    const isClosing = () => this.attemptSettlementByTaskId.get(taskId)?.phase === "closing";
    if (!isClosing()) return;
    const deadline = Date.now() + timeoutMs;
    while (isClosing()) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const notified = Promise.withResolvers<void>();
      const listener = () => notified.resolve();
      const listeners = this.attemptSettlementListenersByTaskId.get(taskId) ?? new Set();
      listeners.add(listener);
      this.attemptSettlementListenersByTaskId.set(taskId, listeners);
      try {
        await raceWithAbortAndTimeout(notified.promise, { timeoutMs: remainingMs });
      } finally {
        this.removeAttemptSettlementListener(taskId, listener);
      }
    }
  }

  /**
   * Take the task's event lock for a short read while the caller's bound (deadline/abort) keeps
   * applying to the WAIT for the lock: a publication holding it must not pin a bounded caller.
   * Abandoned before entry → the late acquisition is a no-op that releases at once (nothing read,
   * no subscription installed). Once entered, the operation runs to completion (never detached).
   */
  private async runUnderEventLockBounded<T>(
    taskId: string,
    operation: () => Promise<T>,
    bound: { signal?: AbortSignal; deadline: number }
  ): Promise<{ kind: "ok"; value: T } | { kind: "timeout" } | { kind: "aborted" }> {
    let entered = false;
    let abandoned = false;
    const run = this.deps
      .workspaceEventLocks()
      .withLock(taskId, async (): Promise<T | undefined> => {
        if (abandoned) return undefined;
        entered = true;
        return await operation();
      });
    return await new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer != null) clearTimeout(timer);
        bound.signal?.removeEventListener("abort", onAbort);
      };
      const abandon = (result: { kind: "timeout" } | { kind: "aborted" }) => {
        if (entered || abandoned) return;
        abandoned = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => abandon({ kind: "aborted" });
      bound.signal?.addEventListener("abort", onAbort, { once: true });
      const remainingMs = bound.deadline - Date.now();
      if (bound.signal?.aborted) {
        abandon({ kind: "aborted" });
      } else if (remainingMs <= 0) {
        abandon({ kind: "timeout" });
      } else {
        timer = setTimeout(() => abandon({ kind: "timeout" }), remainingMs);
        timer.unref?.();
      }
      run.then(
        (value) => {
          cleanup();
          if (!abandoned) resolve({ kind: "ok", value: value as T });
        },
        (error: unknown) => {
          cleanup();
          if (!abandoned) reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
    });
  }

  /**
   * Bounded wait for the current attempt to settle: subscribe THEN re-read under the task's
   * event lock (a settlement landing between the two is observed by the re-read), release the
   * lock before awaiting, and re-read on every notification. The bound also covers waiting for
   * the lock itself (runUnderEventLockBounded). `indeterminate` returns at once — an unknown
   * owner never pins the caller. Timeout is a bounded outcome, abort rejects.
   */
  async waitForAttemptSettlement(
    taskId: string,
    options: { abortSignal?: AbortSignal; timeoutMs: number; requestingWorkspaceId?: string }
  ): Promise<TaskAttemptSettlement<AgentTaskReport>> {
    assert(taskId.length > 0, "waitForAttemptSettlement: taskId must be non-empty");
    assert(
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0,
      "waitForAttemptSettlement: timeoutMs invalid"
    );
    const deadline = Date.now() + options.timeoutMs;
    const bound = { signal: options.abortSignal, deadline };
    let notified = Promise.withResolvers<void>();
    const listener = () => notified.resolve();
    try {
      const first = await this.runUnderEventLockBounded(
        taskId,
        async () => {
          const listeners = this.attemptSettlementListenersByTaskId.get(taskId) ?? new Set();
          listeners.add(listener);
          this.attemptSettlementListenersByTaskId.set(taskId, listeners);
          return await this.deps.inspectAttemptOutcome(taskId, options);
        },
        bound
      );
      if (first.kind === "aborted") throw new Error("Interrupted");
      if (first.kind === "timeout") return { kind: "timeout" };
      let outcome = first.value;
      while (outcome.kind === "live" || outcome.kind === "cleanup-pending") {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) return { kind: "timeout" };
        const raced = await raceWithAbortAndTimeout(notified.promise, {
          signal: options.abortSignal,
          timeoutMs: remainingMs,
        });
        if (raced.kind === "aborted") throw new Error("Interrupted");
        if (raced.kind === "timeout") return { kind: "timeout" };
        // Re-arm before re-reading so a notification during the read is never lost.
        notified = Promise.withResolvers<void>();
        const reread = await this.runUnderEventLockBounded(
          taskId,
          () => this.deps.inspectAttemptOutcome(taskId, options),
          bound
        );
        if (reread.kind === "aborted") throw new Error("Interrupted");
        if (reread.kind === "timeout") return { kind: "timeout" };
        outcome = reread.value;
      }
      return outcome;
    } finally {
      this.removeAttemptSettlementListener(taskId, listener);
    }
  }

  /**
   * Settle a failed reawaken's closed attempt (restoreInterruptedTaskAfterResumeFailure) once the
   * shared no-report boundary holds (attemptCannotStillReport): never from the send's error alone.
   * The failed send's obligation is typically disposed only after the rollback returned (a refused
   * or no-work send), and an admitted preparation failure rolls back while its turn is still
   * live, so this is rechecked on the rollback, on every obligation disposal and on every turn
   * settlement. It drops out without settling when the attempt was superseded (a new owner) or
   * settled by another producer (Stop), and defers to an in-progress Stop, whose release settles.
   */
  recheckResumeFailureSettlement(taskId: string): void {
    const attempt = this.resumeFailureSettlementByTaskId.get(taskId);
    if (attempt == null) return;
    const closure = this.attemptSettlementByTaskId.get(taskId);
    if (
      this.ownedAttemptByTaskId.get(taskId) !== attempt ||
      closure?.attempt !== attempt ||
      closure.phase !== "closing"
    ) {
      this.resumeFailureSettlementByTaskId.delete(taskId);
      return;
    }
    if (this.deps.hasStopRecord(taskId)) return;
    if (!this.attemptCannotStillReport(taskId, attempt)) return;
    this.resumeFailureSettlementByTaskId.delete(taskId);
    this.persistOwnedAttemptSettlement(taskId, attempt, "idle-settled", "resume-failed").catch(
      (error: unknown) => {
        log.error("[task-attempt] failed reawaken settlement failed", { taskId, error });
      }
    );
  }
}
