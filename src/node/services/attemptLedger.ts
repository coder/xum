import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  SEND_ADMISSION_STALE_MESSAGE,
  TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE,
  TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE,
  TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE,
  WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
  pendingRemovalAdmissionMessage,
  retiredAttemptMessage,
} from "@/constants/agentMessaging";
import { Err, Ok, type Result } from "@/common/types/result";
import { getErrorMessage } from "@/common/utils/errors";
import type { TaskAttemptOutcome, TaskAttemptSettlement } from "@/common/types/tasks";
import type { Config, ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AgentTaskIndex } from "@/node/services/agentTaskIndex";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import {
  readSubagentAttemptSettlementReceiptStrict,
  writeSubagentAttemptSettlementReceipt,
  type SubagentAttemptSettlementReceiptReadResult,
  type SubagentAttemptSettlementSource,
} from "@/node/services/subagentAttemptSettlements";
import type {
  AdmittedSend,
  AgentTaskReport,
  AttemptSettlementEntry,
  OwnedTaskAttempt,
  SettlementReceiptDecision,
  StreamAttemptOrigin,
  StreamEndDecision,
  WorkspaceStopRecord,
} from "@/node/services/taskService";
import {
  coerceNonEmptyString,
  findWorkspaceEntry,
  markChildGoalPauseOwed,
  rowSupersedes,
} from "@/node/services/taskUtils";
import type {
  QueuedDispatchDecision,
  TaskTurnAdmission,
  TurnAcceptanceOrigin,
  TurnAdmissionToken,
  WorkspaceHost,
} from "@/node/services/taskWorkspaceSeam";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";
import type { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { assertTaskAttemptId, isTaskAttemptId } from "@/node/utils/taskAttemptId";

/**
 * Bound on waiting for an owned predecessor's in-flight settlement write before deciding a
 * successor's lineage (evaluateAttemptLineage), and on a failed direct launch's wait for the
 * owners its stop cascade captured before its rollback (TaskService.create). Elapsing the bound
 * is a decision — unproven lineage, deferred rollback — not an error; the write or the cascade
 * keeps its own ownership and completes on its own.
 */
export const ATTEMPT_CLOSURE_SETTLE_WAIT_MS = 5_000;

/** Lineage proof (evaluateAttemptLineage) from the predecessor's receipt in the parent's dir. */
function lineageProofFromReceipt(
  receipt: SubagentAttemptSettlementReceiptReadResult,
  parentWorkspaceId: string
): { proven: boolean; reason: string } {
  if (receipt.kind === "found") {
    // The strict reader binds task and attempt id to the path; the parent is bound here, to
    // the entry: a receipt naming another parent at this path was copied or misplaced, never
    // written by this task's owner (the same fail-closed outcome as an unreadable receipt).
    if (receipt.receipt.parentWorkspaceId !== parentWorkspaceId) {
      return {
        proven: false,
        reason: `settlement receipt names parent ${receipt.receipt.parentWorkspaceId}, expected ${parentWorkspaceId}`,
      };
    }
    return { proven: true, reason: "settlement receipt found" };
  }
  return {
    proven: false,
    reason:
      receipt.kind === "unreadable"
        ? `settlement receipt unreadable: ${receipt.error}`
        : "no settlement receipt for the predecessor attempt",
  };
}

/**
 * Row step of readUnownedSettlementProof: the row names an interrupted, proven attempt with a
 * parent, so the parent's receipt copy can prove it; else why it cannot.
 */
function unownedSettlementCandidate(
  row: WorkspaceConfigEntry | undefined
):
  | { kind: "candidate"; attemptId: string; parentWorkspaceId: string }
  | { kind: "unproven"; reason: string } {
  const unproven = (reason: string) => ({ kind: "unproven" as const, reason });
  if (row == null) return unproven("no task record");
  const attemptId = row.taskAttemptId;
  if (!isTaskAttemptId(attemptId)) return unproven("no attempt id (pre-identity entry)");
  if (row.taskStatus !== "interrupted") return unproven(`status ${row.taskStatus ?? "missing"}`);
  if (row.taskAttemptUnproven === true) return unproven("lineage marked unproven");
  const parentWorkspaceId = coerceNonEmptyString(row.parentWorkspaceId);
  if (parentWorkspaceId == null) return unproven("no parent");
  return { kind: "candidate", attemptId, parentWorkspaceId };
}

/** Receipt step of readUnownedSettlementProof: why the read receipt proves nothing, if it does not. */
function unownedSettlementReceiptGap(
  receipt: SubagentAttemptSettlementReceiptReadResult,
  attemptId: string,
  parentWorkspaceId: string
): string | undefined {
  if (receipt.kind === "not_found") return `no settlement receipt for ${attemptId}`;
  if (receipt.kind === "unreadable") {
    return `settlement receipt unreadable: ${receipt.error}`;
  }
  if (receipt.receipt.parentWorkspaceId !== parentWorkspaceId) {
    return `settlement receipt names parent ${receipt.receipt.parentWorkspaceId}`;
  }
  return undefined;
}

/**
 * Why a workflow claim on `attemptId` must be refused (see TaskService.claimRetiredAttempt), or
 * undefined when it may be granted (or re-stamped, for the same run/step before any replacement).
 */
function retiredAttemptClaimRefusal(
  row: WorkspaceConfigEntry,
  attemptId: string,
  claimant: { runId: string; stepId: string }
): string | undefined {
  if (row.taskAttemptId !== attemptId) {
    return `claim lost: the task now names attempt ${row.taskAttemptId ?? "none"}`;
  }
  if (row.taskStatus !== "interrupted") return `attempt is ${row.taskStatus ?? "running"}`;
  const task = row.workflowTask;
  if (task?.runId !== claimant.runId || task.stepId !== claimant.stepId) {
    return "the task does not belong to this workflow step";
  }
  const existing = row.taskAttemptRetiredBy;
  if (existing == null) return undefined;
  if (existing.replacementTaskId != null) {
    return `the retired attempt already has replacement ${existing.replacementTaskId}`;
  }
  if (
    existing.runId !== claimant.runId ||
    existing.stepId !== claimant.stepId ||
    existing.attemptId !== attemptId
  ) {
    return "the attempt was retired by another workflow step";
  }
  return undefined;
}

const NO_SENDS: ReadonlySet<AdmittedSend> = new Set();

/**
 * Everything the attempt ledger reads from TaskService. Each entry is a call-time closure over
 * TaskService, never a captured value or bound method: tests swap TaskService fields and patch
 * its methods after construction. Methods tests spy on (closeAttemptAdmission,
 * decideSettlementReceipt, writeSettlementReceipt, inspectAttemptOutcome) and the other
 * TaskService facades are called back through TaskService so every call reaches the spy. Stop
 * and stream-end state stays with its owner and is reached only through these closures.
 */
export interface AttemptLedgerDeps {
  config: () => Pick<Config, "loadConfigOrDefault" | "sessionsDir" | "editConfig">;
  aiService: () => Pick<AIService, "isStreaming" | "stopStream">;
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
  /** TaskStopLatch.isWorkspaceStopInProgress (through the TaskService facade). */
  isWorkspaceStopInProgress: (workspaceId: string) => boolean;
  /** TaskStopLatch.isCurrentStopRecord. */
  isCurrentStopRecord: (workspaceId: string, record: WorkspaceStopRecord) => boolean;
  /** TaskStopLatch.recheckWorkspaceStopRelease. */
  recheckWorkspaceStopRelease: (workspaceId: string) => void;
  /** TaskService.currentTaskAttemptId: the persisted attempt id of the task's row. */
  currentTaskAttemptId: (taskId: string, entry?: WorkspaceConfigEntry) => string | undefined;
  editWorkspaceEntry: (
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry, config: ProjectsConfig) => void,
    options?: { allowMissing?: boolean }
  ) => Promise<boolean>;
  settleChildGoalPause: (workspaceId: string) => Promise<void>;
  findStreamEndDecision: (taskId: string, attemptId: string) => StreamEndDecision | undefined;
  /** Drop the stream-end decisions no send obligation can still read (StreamEndLedger). */
  pruneStreamEndDecisions: (taskId: string) => void;
  /** Drop every stream-end decision of the task (StreamEndLedger). */
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
 * attempts. Send admission: the send obligations bound to an attempt (AdmittedSend), the
 * reawakenings in flight, lineage and unowned-settlement proofs, and the workflow claims that
 * retire an attempt or tombstone an unpublished reservation. Stop records and stream-end
 * decisions stay with their owners and are reached through the deps.
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
  /** Outstanding send obligations per task (see AdmittedSend); discharged entries are removed. */
  readonly admittedSendsByTaskId = new Map<string, Set<AdmittedSend>>();
  /**
   * Reawakenings (parent reactivation or manual resume) that published a fresh attempt and have
   * not yet handed it a send obligation (reactivation: until createWorkspaceTurn returns; manual
   * resume: until reawakenInterruptedTask returns to the send that admits it; a reactivation in
   * the remaining hand-off tick only makes that send, which names its attempt, read stale). With
   * pending admissions and the live turn it is the "another reawakening is live" evidence each
   * path rechecks under the mutex (see hasLiveReawakening): neither path holds the other's locks,
   * and rotating an attempt a live continuation runs under drops that continuation's report.
   */
  private readonly reawakeningsInFlight = new Map<string, string>();

  constructor(private readonly deps: AttemptLedgerDeps) {}

  /** The task's live set of send obligations (never a copy); empty when it has none. */
  sendsOf(taskId: string): ReadonlySet<AdmittedSend> {
    return this.admittedSendsByTaskId.get(taskId) ?? NO_SENDS;
  }

  /** A reawakening published `attemptId` and has not yet handed it a send (see the field). */
  beginReawakening(taskId: string, attemptId: string): void {
    this.reawakeningsInFlight.set(taskId, attemptId);
  }

  /** The reawakening of `attemptId` ended; a later reawakening's entry stays. */
  endReawakening(taskId: string, attemptId: string): void {
    if (this.reawakeningsInFlight.get(taskId) === attemptId) {
      this.reawakeningsInFlight.delete(taskId);
    }
  }

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
    for (const send of this.admittedSendsByTaskId.get(taskId) ?? []) {
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

  /**
   * Dequeue-gate consultation for an enqueued obligation (see TurnAdmissionToken.resolveDispatch):
   * held while its attempt's stream-end is undecided, refused once that stream turned out to be
   * the terminal report (or its outcome is unknowable), otherwise on to the ordinary gates.
   */
  private resolveEnqueuedSendDispatch(send: AdmittedSend): QueuedDispatchDecision {
    if (send.state !== "enqueued") return "proceed";
    const decision = this.deps.findStreamEndDecision(send.taskId, send.attemptId);
    switch (decision?.outcome) {
      case "pending":
        return "hold";
      case "published":
        return { refuse: TASK_REPORTED_QUEUED_SEND_UNSENT_MESSAGE };
      case "indeterminate":
        return { refuse: TASK_REPORT_OUTCOME_INDETERMINATE_UNSENT_MESSAGE };
      case "nonreport":
      case undefined:
        return "proceed";
    }
  }

  /**
   * Common send-authorization predicate (no ownership): the id is still the task's current
   * attempt, nothing closed it, no stop cascade holds the workspace and no workflow claim retired
   * it. Ownership is a separate question, checked only where it applies.
   */
  attemptAdmissionOpen(taskId: string, attemptId: string): boolean {
    const entry = findWorkspaceEntry(this.deps.config().loadConfigOrDefault(), taskId)?.workspace;
    if (this.deps.currentTaskAttemptId(taskId, entry) !== attemptId) return false;
    if (this.isAttemptClosed(taskId, attemptId)) return false;
    if (this.deps.isWorkspaceStopInProgress(taskId)) return false;
    return entry?.taskAttemptRetiredBy == null && entry?.pendingRemoval == null;
  }

  /**
   * Who a stream event belongs to, read in the event's own tick. The live turn's ADMITTED attempt
   * decides first: local ownership counts only when it names that same attempt. A process can
   * still hold a stale owned attempt A after another backend rotated the row to B and a local send
   * was admitted for B (unowned) — preferring the owner would treat B's stream as A's and discard
   * its report/recovery as superseded. Without an admitted obligation (legacy turns) the owner,
   * else the persisted id, applies as before.
   */
  resolveStreamAttemptAtEvent(taskId: string): StreamAttemptOrigin {
    const owned = this.ownedAttempt(taskId);
    const turn = this.deps.workspaceService().getActiveTurnGeneration(taskId);
    // The turn's DIRECT admission decides; an obligation rebound from a superseded predecessor
    // (inherited) shares the turn id but not its attempt, and counts only when the turn has no
    // direct admission (a successor started without its own obligation).
    let admitted: string | undefined;
    let inherited: string | undefined;
    if (turn != null) {
      for (const send of this.admittedSendsByTaskId.get(taskId) ?? []) {
        if (send.state !== "admitted" || send.turnId !== turn) continue;
        if (send.inherited !== true) {
          admitted = send.attemptId;
          break;
        }
        inherited ??= send.attemptId;
      }
    }
    admitted ??= inherited;
    if (owned != null && (admitted == null || owned.attemptId === admitted)) {
      return { ownedAttempt: owned, unownedAttemptId: undefined };
    }
    return {
      ownedAttempt: undefined,
      unownedAttemptId: admitted ?? this.deps.currentTaskAttemptId(taskId),
    };
  }
  /** Sends admitted against the task's current attempt that have not claimed a turn yet. */
  hasPendingAdmissions(taskId: string): boolean {
    const current = this.deps.currentTaskAttemptId(taskId);
    for (const send of this.admittedSendsByTaskId.get(taskId) ?? []) {
      if (send.attemptId !== current) continue;
      if (send.state === "pending" || send.state === "enqueued") return true;
    }
    return false;
  }

  /**
   * Another reawakening's attempt is live in this process: published and still launching, or
   * handed to work that has not ended (a pending/enqueued admission, the live turn, a stream).
   * Synchronous; both reawakening paths evaluate it under the mutex BEFORE their own publish, so
   * their own work is never counted. Evidence, not ownership: an owned attempt that nothing runs
   * (a reactivation whose launch was refused, a follow-up turn that ended) stays reawakenable.
   */
  hasLiveReawakening(taskId: string): boolean {
    if (
      this.reawakeningsInFlight.has(taskId) ||
      this.deps.workspaceService().getActiveTurnGeneration(taskId) != null ||
      this.deps.aiService().isStreaming(taskId)
    ) {
      return true;
    }
    // Only sends that can still start a turn: one bound to a closed, superseded or stopped
    // attempt reads stale at every later gate and is no continuation to protect.
    for (const send of this.admittedSendsByTaskId.get(taskId) ?? []) {
      if ((send.state === "pending" || send.state === "enqueued") && !send.token.admissionStale()) {
        return true;
      }
    }
    return false;
  }

  dischargeAdmittedSend(send: AdmittedSend): void {
    if (send.state === "discharged") return;
    send.state = "discharged";
    const sends = this.admittedSendsByTaskId.get(send.taskId);
    sends?.delete(send);
    if (sends?.size === 0) this.admittedSendsByTaskId.delete(send.taskId);
    for (const record of send.capturedBy) {
      record.pendingAdmissions.delete(send);
    }
    send.capturedBy.clear();
    this.deps.pruneStreamEndDecisions(send.taskId);
  }

  /**
   * Register one send obligation against `attemptId` and return its token. Every lifecycle event
   * updates the obligation object and the records that captured it by reference — never
   * whichever record currently occupies the task's slot.
   */
  private createAdmittedSend(
    taskId: string,
    attemptId: string,
    attempt: OwnedTaskAttempt | undefined
  ): AdmittedSend {
    assertTaskAttemptId(attemptId, "createAdmittedSend");
    const send: AdmittedSend = {
      taskId,
      attemptId,
      ...(attempt != null ? { attempt } : {}),
      state: "pending",
      capturedBy: new Set(),
      token: {
        resolveDispatch: () => this.resolveEnqueuedSendDispatch(send),
        admissionStale: () => this.isAdmittedSendStale(send),
        onEnqueued: () => {
          if (send.state === "pending") send.state = "enqueued";
        },
        onAdmitted: (turnId) => this.recordAdmittedSendTurn(send, turnId),
        onDisposed: (kind) => this.disposeSendBeforeAdmission(send, kind),
      },
    };
    const sends = this.admittedSendsByTaskId.get(taskId) ?? new Set<AdmittedSend>();
    sends.add(send);
    this.admittedSendsByTaskId.set(taskId, sends);
    return send;
  }

  /** TurnAdmissionToken.admissionStale for `send` (see createAdmittedSend). */
  private isAdmittedSendStale(send: AdmittedSend): boolean {
    const { taskId, attemptId } = send;
    // Admitted obligations belong to their turn: rotation, closure and stops no longer
    // concern the send itself (the turn is captured by the stop record instead).
    if (send.state === "admitted") return false;
    if (send.state === "discharged") return true;
    if (!this.attemptAdmissionOpen(taskId, attemptId)) return true;
    if (send.attempt != null && this.ownedAttempt(taskId) !== send.attempt) {
      return true;
    }
    // A send still in its preflight while the attempt's last stream is undecided, or was
    // decided a report (or unknowable): it must not start a turn under that attempt. The
    // queue's own gate handles enqueued entries (hold/refuse) before reaching here.
    if (send.state === "pending") {
      return this.streamEndBlocksNewTurn(taskId, attemptId);
    }
    return false;
  }

  /** The attempt's last stream is undecided, or was decided a report (or unknowable). */
  private streamEndBlocksNewTurn(taskId: string, attemptId: string): boolean {
    const decision = this.deps.findStreamEndDecision(taskId, attemptId);
    return decision != null && decision.outcome !== "nonreport";
  }

  /** TurnAdmissionToken.onAdmitted for `send`: bind it to `turnId` (see createAdmittedSend). */
  private recordAdmittedSendTurn(send: AdmittedSend, turnId: symbol): void {
    const { taskId, attemptId } = send;
    if (send.state === "admitted") {
      // The dequeued entry is adopted by a second sendMessage naming the same turn.
      if (send.turnId !== turnId) {
        log.warn("[task-attempt] admitted send re-admitted under another turn; keeping first", {
          taskId,
          attemptId,
        });
      }
      return;
    }
    if (send.state === "discharged") {
      log.warn("[task-attempt] disposed send reported admitted; ignoring", {
        taskId,
        attemptId,
      });
      return;
    }
    send.state = "admitted";
    send.turnId = turnId;
    // A record that captured this obligation while pending now waits on the turn instead,
    // and owes one more stopStream so the late turn is actually stopped: Phase B's single
    // stopStream targeted the execution captured at Phase A, not this one.
    for (const record of send.capturedBy) {
      record.pendingAdmissions.delete(send);
      record.capturedTurns.add(turnId);
      record.cleanupInFlight += 1;
      void this.deps
        .aiService()
        .stopStream(taskId, { abandonPartial: false })
        .catch((error: unknown) => {
          log.debug("[task-attempt] late-turn stopStream threw", { taskId, error });
        })
        .finally(() => {
          record.cleanupInFlight -= 1;
          this.deps.recheckWorkspaceStopRelease(taskId);
        });
    }
    send.capturedBy.clear();
  }

  /** TurnAdmissionToken.onDisposed for `send`: no turn will exist (see createAdmittedSend). */
  private disposeSendBeforeAdmission(
    send: AdmittedSend,
    kind: Parameters<TurnAdmissionToken["onDisposed"]>[0]
  ): void {
    const { taskId, attemptId } = send;
    if (send.state === "admitted" || send.state === "discharged") return;
    log.debug("[task-attempt] send obligation disposed before admission", {
      taskId,
      attemptId,
      kind,
    });
    const records = [...send.capturedBy];
    this.dischargeAdmittedSend(send);
    for (const record of records) {
      if (this.deps.isCurrentStopRecord(taskId, record)) {
        this.deps.recheckWorkspaceStopRelease(taskId);
      }
    }
    this.recheckResumeFailureSettlement(taskId);
  }

  /**
   * Admission fence for a send into a workspace (AgentTaskIntegration.admitTaskWorkspaceTurn),
   * evaluated synchronously at the session handoff. Not a task, or a pre-identity task entry →
   * no obligation (the next admission stamps an id). A task whose current attempt is retired,
   * stopping, or closed refuses; otherwise the send is bound to the current attempt — owned when
   * this process owns exactly that id, unowned otherwise (startup re-drives, prior-process
   * attempts). Ownership is never acquired here: a send authorizes work, not receipt authority.
   */
  admitTaskWorkspaceTurn(
    workspaceId: string,
    options: { acceptanceOrigin: TurnAcceptanceOrigin; expectedAttemptId?: string }
  ): TaskTurnAdmission {
    assert(workspaceId.length > 0, "admitTaskWorkspaceTurn: workspaceId must be non-empty");
    let entry: WorkspaceConfigEntry | undefined;
    try {
      entry = findWorkspaceEntry(
        this.deps.config().loadConfigOrDefault({ throwOnError: true }),
        workspaceId
      )?.workspace;
    } catch (error: unknown) {
      // Unreadable registry: the classification itself is indeterminate. Absence from this
      // process's identity map (currentAttemptIdByTaskId) is no proof of "not a task" — a task
      // loaded from disk and never rotated here has no entry — so EVERY send refuses here (fail
      // closed) rather than bypassing the attempt fence. That deliberately includes root/non-task
      // workspaces: without the registry nothing can tell them apart, and such a send could not
      // run anyway (lenient readers then see no workspaces, so its metadata cannot be resolved);
      // refusing here just fails it before anything is persisted. Sends resume once the registry
      // reads again.
      return {
        kind: "refused",
        message: `Workspace registry unreadable; send refused: ${getErrorMessage(error)}`,
      };
    }
    // A send decided for a specific attempt whose row is gone (unpublished, removed) is stale,
    // never an ordinary send into a workspace that is not a task.
    if (entry == null && options.expectedAttemptId != null) {
      return { kind: "refused", message: SEND_ADMISSION_STALE_MESSAGE };
    }
    // Checked before the task classification: another backend's removal of a root workspace
    // deletes its checkout too (#4478).
    if (entry?.pendingRemoval != null) {
      return { kind: "refused", message: pendingRemovalAdmissionMessage(entry.pendingRemoval) };
    }
    if (!entry?.parentWorkspaceId) return { kind: "not-a-task" };
    // The claim is monotonic and stronger than the id: a retired task refuses even when its id
    // is missing or malformed (fail closed on partial state), so check it before the id.
    if (entry.taskAttemptRetiredBy != null) {
      return { kind: "refused", message: retiredAttemptMessage(entry.taskAttemptRetiredBy) };
    }
    return this.admitSendToCurrentAttempt(workspaceId, entry, options);
  }
  /**
   * Attempt step of admitTaskWorkspaceTurn for a task entry that is not retired: refuse a send
   * the current attempt cannot take, else bind it to that attempt.
   */
  private admitSendToCurrentAttempt(
    workspaceId: string,
    entry: WorkspaceConfigEntry,
    options: { acceptanceOrigin: TurnAcceptanceOrigin; expectedAttemptId?: string }
  ): TaskTurnAdmission {
    const attemptId = this.deps.currentTaskAttemptId(workspaceId, entry);
    if (attemptId == null) {
      log.debug("[task-attempt] send into a pre-identity task entry carries no obligation", {
        workspaceId,
      });
      return { kind: "not-a-task" };
    }
    // A send decided for one attempt never binds to a successor another writer admitted since:
    // the decision is stale, not the row (see TaskWorkspaceSeam.admitTaskWorkspaceTurn).
    if (options.expectedAttemptId != null && attemptId !== options.expectedAttemptId) {
      log.info("[task-attempt] send refused: decided for a superseded attempt", {
        workspaceId,
        expectedAttemptId: options.expectedAttemptId,
        attemptId,
        acceptanceOrigin: options.acceptanceOrigin,
      });
      return { kind: "refused", message: SEND_ADMISSION_STALE_MESSAGE };
    }
    if (this.deps.isWorkspaceStopInProgress(workspaceId)) {
      return { kind: "refused", message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE };
    }
    if (this.isAttemptClosed(workspaceId, attemptId)) {
      log.info("[task-attempt] send refused: attempt settled", {
        workspaceId,
        attemptId,
        acceptanceOrigin: options.acceptanceOrigin,
      });
      return { kind: "refused", message: TASK_ATTEMPT_SETTLED_SEND_BLOCKED_MESSAGE };
    }
    const owned = this.ownedAttempt(workspaceId);
    const send = this.createAdmittedSend(
      workspaceId,
      attemptId,
      owned?.attemptId === attemptId ? owned : undefined
    );
    return { kind: "admitted", token: send.token };
  }

  /**
   * Lineage proof for a reawaken/reactivation of `entry`'s current attempt (P11): proven iff the
   * predecessor is settled by this process's owner (recorded `settled`) or by a durable receipt.
   * Anything else — no id, marked lineage, unsettled/closing owner, missing or unreadable receipt —
   * is unproven and makes the successor ineligible for receipts. Never throws.
   */
  async evaluateAttemptLineage(
    taskId: string,
    entry: WorkspaceConfigEntry
  ): Promise<{ proven: boolean; reason: string }> {
    const attemptId = entry.taskAttemptId;
    if (!isTaskAttemptId(attemptId)) {
      return { proven: false, reason: "predecessor has no attempt id (pre-upgrade entry)" };
    }
    if (entry.taskAttemptUnproven === true) {
      return { proven: false, reason: "lineage marked unproven" };
    }
    const owned = this.ownedAttempt(taskId);
    if (owned?.attemptId === attemptId) {
      if (!owned.receiptEligible) {
        return { proven: false, reason: "predecessor owned but not receipt-eligible" };
      }
      if (this.ownedAttemptSettlementPhase(taskId, owned) === "closing") {
        // The producer's awaited write is in flight; wait for its outcome (bounded, no lock).
        await this.waitForAttemptClosureToSettle(taskId, ATTEMPT_CLOSURE_SETTLE_WAIT_MS);
      }
      if (this.ownedAttemptSettlementPhase(taskId, owned) === "settled") {
        return { proven: true, reason: "predecessor settled by this process" };
      }
    }
    const parentWorkspaceId = coerceNonEmptyString(entry.parentWorkspaceId);
    if (parentWorkspaceId == null) return { proven: false, reason: "entry has no parent" };
    const receipt = await readSubagentAttemptSettlementReceiptStrict(
      path.join(this.deps.config().sessionsDir, parentWorkspaceId),
      taskId,
      attemptId
    );
    return lineageProofFromReceipt(receipt, parentWorkspaceId);
  }
  /** Phase of this process's settlement entry for `owned`; undefined when it records another. */
  private ownedAttemptSettlementPhase(
    taskId: string,
    owned: OwnedTaskAttempt
  ): AttemptSettlementEntry["phase"] | undefined {
    const settlement = this.attemptSettlement(taskId);
    return settlement?.attempt === owned ? settlement.phase : undefined;
  }

  /**
   * Cross-process evidence (G2) that the task's CURRENT attempt ended without a report, for an
   * attempt this process does not own (another backend, or this one before a restart). Called
   * only after the report artifact read positively found none: a receipt never outranks a report.
   *
   * Attempt identity: the receipt must name the row's current taskAttemptId. The workflow journal
   * names only the child task, and every task admission (launch, reawaken, re-drive) rotates the
   * id, so the current id is the only attempt that can still run; a receipt for an older attempt
   * says nothing about it. A plain send binds to the current id instead: another backend's turn
   * can therefore run under an attempt this receipt settled (#4545) — its late report still wins
   * unless a claim retired the attempt first (publishAgentTaskReport). Only the PARENT's receipt copy counts (the copy lineage reads; ancestor copies are fan-out
   * and never evidence on their own), and it must name that parent. Every read is strict, and
   * the row is re-read after the receipt so an admission landing in between is never missed.
   */
  async readUnownedSettlementProof(
    taskId: string
  ): Promise<{ kind: "proven"; attemptId: string } | { kind: "unproven"; reason: string }> {
    const unproven = (reason: string) => ({ kind: "unproven" as const, reason });
    const readRow = () =>
      findWorkspaceEntry(this.deps.config().loadConfigOrDefault({ throwOnError: true }), taskId)
        ?.workspace;
    let row: WorkspaceConfigEntry | undefined;
    try {
      row = readRow();
    } catch (error: unknown) {
      return unproven(`config unreadable: ${getErrorMessage(error)}`);
    }
    const candidate = unownedSettlementCandidate(row);
    if (candidate.kind === "unproven") return candidate;
    const { attemptId, parentWorkspaceId } = candidate;
    const receipt = await readSubagentAttemptSettlementReceiptStrict(
      path.join(this.deps.config().sessionsDir, parentWorkspaceId),
      taskId,
      attemptId
    );
    const receiptGap = unownedSettlementReceiptGap(receipt, attemptId, parentWorkspaceId);
    if (receiptGap != null) return unproven(receiptGap);
    let latest: WorkspaceConfigEntry | undefined;
    try {
      latest = readRow();
    } catch (error: unknown) {
      return unproven(`config unreadable: ${getErrorMessage(error)}`);
    }
    if (
      latest?.taskAttemptId !== attemptId ||
      latest.taskStatus !== "interrupted" ||
      latest.taskAttemptUnproven === true
    ) {
      return unproven("the attempt changed while its receipt was read");
    }
    return { kind: "proven", attemptId };
  }

  /**
   * Workflow claim that retires `attemptId` of `taskId` so exactly one replacement can be
   * published for it (G2). A pure compare-and-swap fence: the classifier (readAttemptOutcome)
   * decided the attempt ended without a report; the claim only makes that decision exclusive.
   * Granted while the row still names the attempt, is interrupted, belongs to this run/step and
   * has no replacement yet; an earlier claim of the same run/step is re-stamped with a fresh
   * nonce (a stale runner holding the old nonce can then no longer publish). Every admission
   * already refuses a retired attempt. Confirmed by a strict re-read, since a config edit that
   * fails to write is not always surfaced to its caller.
   *
   * A spent claim is never re-granted, even when its replacementTaskId names a row that is gone
   * (a replacement whose launch failed sanitization is unpublished). That is safe because the
   * workflow checkpoints the replacement (createMany's onTaskReserved) BEFORE the publishing
   * commit that sets replacementTaskId: once it is set, the journal already names the
   * replacement, so no runner classifies this attempt again. Recovery is retry-from-checkpoint's
   * fresh reservation (WorkflowRunner.replacementRace.test.ts).
   */
  async claimRetiredAttempt(
    taskId: string,
    attemptId: string,
    claimant: { runId: string; stepId: string; inputHash: string }
  ): Promise<Result<{ nonce: string }, string>> {
    assert(taskId.length > 0, "claimRetiredAttempt: taskId must be non-empty");
    assertTaskAttemptId(attemptId, "claimRetiredAttempt");
    assert(
      claimant.runId.length > 0 && claimant.stepId.length > 0,
      "claimRetiredAttempt: claimant"
    );
    return await this.deps.workspaceEventLocks().withLock(taskId, async () => {
      if (
        this.deps.isWorkspaceStopInProgress(taskId) ||
        this.deps.turnManager().getLiveWorkspaceTurnRegistration(taskId) != null ||
        this.deps.aiService().isStreaming(taskId) ||
        this.deps.workspaceService().getActiveTurnGeneration(taskId) != null
      ) {
        return Err("attempt is live");
      }
      const nonce = randomUUID();
      let refusal: string | undefined = "task record not found";
      try {
        await this.deps.editWorkspaceEntry(
          taskId,
          (ws) => {
            refusal = retiredAttemptClaimRefusal(ws, attemptId, claimant);
            if (refusal != null) return;
            markChildGoalPauseOwed(ws);
            ws.taskAttemptRetiredBy = {
              runId: claimant.runId,
              stepId: claimant.stepId,
              inputHash: claimant.inputHash,
              childTaskId: taskId,
              attemptId,
              mode: "no-report",
              at: new Date().toISOString(),
              nonce,
            };
          },
          { allowMissing: true }
        );
      } catch (error: unknown) {
        return Err(`claim write failed: ${getErrorMessage(error)}`);
      }
      if (refusal != null) return Err(refusal);
      let row: WorkspaceConfigEntry | undefined;
      try {
        row = findWorkspaceEntry(
          this.deps.config().loadConfigOrDefault({ throwOnError: true }),
          taskId
        )?.workspace;
      } catch (error: unknown) {
        return Err(`claim unconfirmed: config unreadable: ${getErrorMessage(error)}`);
      }
      if (row?.taskAttemptId !== attemptId || row.taskAttemptRetiredBy?.nonce !== nonce) {
        return Err("claim lost");
      }
      await this.deps.settleChildGoalPause(taskId);
      return Ok({ nonce });
    });
  }
  /**
   * A workflow step's started checkpoint is written in createMany's onTaskReserved, BEFORE
   * commitReservations publishes the child's row. A crash in between leaves a checkpoint naming a
   * task that never existed. Replacing it outright is unsafe: the reserving backend may only be
   * stalled (lease expired, process alive), and its late commit would then publish a second child
   * for the step, or re-run a step the replacement already recorded. So the replacing runner first
   * tombstones the ID on the parent's row; commitReservations checks the tombstone inside its own
   * config write and refuses, which makes "replace" and "late commit" mutually exclusive.
   *
   * Granted only while a strict read shows no row for the task (checked inside the same write) and
   * this process owns no attempt for it (an own reservation may still be before its commit).
   * Idempotent. Confirmed by a strict re-read, since a config edit that fails to write is not
   * always surfaced to its caller.
   */
  async tombstoneUnpublishedReservation(
    parentWorkspaceId: string,
    taskId: string
  ): Promise<Result<void, string>> {
    assert(parentWorkspaceId.length > 0, "tombstoneUnpublishedReservation: parentWorkspaceId");
    assert(taskId.length > 0, "tombstoneUnpublishedReservation: taskId");
    return await this.deps.workspaceEventLocks().withLock(taskId, async () => {
      if (this.hasOwnedAttempt(taskId)) {
        return Err("this process owns an attempt for the task");
      }
      let refusal: string | undefined;
      try {
        await this.deps.config().editConfig((config) => {
          refusal = undefined;
          if (findWorkspaceEntry(config, taskId) != null) {
            refusal = "the task was published";
            return config;
          }
          const parent = findWorkspaceEntry(config, parentWorkspaceId)?.workspace;
          if (parent == null) {
            refusal = "parent record not found";
            return config;
          }
          const tombstones = parent.taskReservationTombstones ?? [];
          if (!tombstones.includes(taskId)) {
            parent.taskReservationTombstones = [...tombstones, taskId];
          }
          return config;
        });
      } catch (error: unknown) {
        return Err(`tombstone write failed: ${getErrorMessage(error)}`);
      }
      if (refusal != null) return Err(refusal);
      let config: ProjectsConfig;
      try {
        config = this.deps.config().loadConfigOrDefault({ throwOnError: true });
      } catch (error: unknown) {
        return Err(`tombstone unconfirmed: config unreadable: ${getErrorMessage(error)}`);
      }
      if (
        findWorkspaceEntry(config, taskId) != null ||
        findWorkspaceEntry(
          config,
          parentWorkspaceId
        )?.workspace.taskReservationTombstones?.includes(taskId) !== true
      ) {
        return Err("tombstone lost");
      }
      return Ok(undefined);
    });
  }
}
