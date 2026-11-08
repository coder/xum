import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import type { BashMonitorWakeDisplayRecord, MuxMessageMetadata } from "@/common/types/message";
import assert from "@/common/utils/assert";
import { BASH_MONITOR_WAKE_HEADINGS } from "@/common/utils/machineTurnPrompts";
import type {
  BashMonitorLostSummary,
  BashMonitorRegistryRecord,
  BashMonitorTerminalSummary,
} from "@/node/services/bashMonitorRegistryStore";
import { log } from "@/node/services/log";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isErrnoWithCode } from "@/node/utils/fs";

const WATERMARK_FILE = "bash-monitor-watermark.json";
const LEGACY_WAKE_DIR = "bash-monitor-wakes";
const WATERMARK_VERSION = 1;
const RECONCILE_RETRY_BASE_MS = 50;
const RECONCILE_RETRY_MAX_MS = 2_000;
/**
 * A wake is a synthetic user-role message, so it carries only text that Xum or the agent wrote.
 * Process output can hold contributor-controlled text (check names, branch names, log lines), and
 * a user turn would give it the user's authority; the agent reads output with task_await, which
 * returns it as a tool result.
 */
const BASH_MONITOR_OUTPUT_NOT_COPIED =
  "Xum does not copy process output into this message. A task_await read returns it as a tool result.";

/** Every read shares one cursor per process, so a read that did not mark output shown can pass it. */
export const BASH_MONITOR_READ_PAST_NOTE =
  "An earlier filtered read, or a read from another workspace, already moved the read cursor past the matched output, so task_await cannot return it.";

export type BashMonitorPendingWakeKind = "match" | "monitor-lost" | "settled";

interface BashMonitorMatchSnapshot {
  throughOffset: number;
}

export interface BashMonitorProcessSnapshot {
  processId: string;
  taskId: string;
  ownerWorkspaceId: string;
  displayName?: string;
  filter: string;
  filterExclude: boolean;
  script: string;
  createdAt: string;
  match?: BashMonitorMatchSnapshot;
  terminal?: BashMonitorTerminalSummary;
  lost?: BashMonitorLostSummary;
  retired: boolean;
}

export type BashMonitorWakeDeliveryState =
  | { status: "blocked"; readSettled: Promise<void> }
  | {
      status: "settled";
      shownThroughOffset: number;
      terminalStatusShown: boolean;
      taskAwaitable?: boolean;
      /** Where the next read of the process output starts (shared by every reader). */
      readCursorOffset?: number;
      /** End of the output the monitor has scanned. */
      outputThroughOffset?: number;
    };

export interface BashMonitorWakeReconcilerProcessManager {
  /** Synchronous so a caller can snapshot the process frontier in the tick it decides to act. */
  pullMonitorWakeSignals(ownerWorkspaceId: string): readonly BashMonitorProcessSnapshot[];
  getMonitorWakeDeliveryState(
    processId: string,
    originNotAfterMs: number
  ): Promise<BashMonitorWakeDeliveryState | undefined>;
  acknowledgeMonitorWake(
    processId: string,
    originNotAfterMs: number,
    matchedThroughOffset?: number,
    terminalSettledAt?: string
  ): Promise<void> | void;
  dropRetiredMonitor(processId: string, createdAt: string): Promise<void> | void;
}

export interface BashMonitorWakeReconcilerRegistry {
  listAll(ownerWorkspaceId: string): Promise<readonly BashMonitorRegistryRecord[]>;
  remove(ownerWorkspaceId: string, processId: string, createdAt: string): Promise<void> | void;
  recordTerminal(
    ownerWorkspaceId: string,
    processId: string,
    createdAt: string,
    terminal: BashMonitorTerminalSummary
  ): Promise<void> | void;
}

export type BashMonitorWakeDispatchOutcome = "in-flight" | "deferred";

export interface BashMonitorWakeDispatch {
  ownerWorkspaceId: string;
  prompt: string;
  muxMetadata: Extract<MuxMessageMetadata, { type: "bash-monitor-wake" }>;
  cancelSignal: AbortSignal;
  onAccepted(): Promise<void>;
  onDeferred(): Promise<void>;
}

export interface BashMonitorWakeReconcilerSnapshot {
  ownerWorkspaceId: string;
  pendingWakeKinds: ReadonlyMap<string, BashMonitorPendingWakeKind>;
}

export interface BashMonitorFullHistoryClearToken {
  ownerWorkspaceId: string;
}

interface WatermarkEntry {
  processId: string;
  createdAt: string;
  matchedThroughOffset?: number;
  terminalSettledAt?: string;
  lost?: true;
}

/** What a wake may say about a lost monitor: no process output and no runtime error text. */
type WakeLostSummary = Pick<BashMonitorLostSummary, "reason" | "failedOperations" | "failedAt">;

/**
 * The input of buildPrompt. It has no field that holds process output or runtime error text, so
 * putting such text back into a wake fails to compile.
 */
interface DerivedSignal {
  key: string;
  ownerWorkspaceId: string;
  processId: string;
  taskId: string;
  displayName?: string;
  filter: string;
  filterExclude: boolean;
  script: string;
  createdAt: string;
  kind: BashMonitorPendingWakeKind;
  matchOffset?: number;
  /** Output bytes past the shared read cursor, when the process is still in memory. */
  unreadBytes?: number;
  /** The read cursor passed the matched output that no owner read marked shown. */
  matchedOutputReadPast: boolean;
  terminal?: BashMonitorTerminalSummary;
  lost?: WakeLostSummary;
  taskAwaitable: boolean;
  deadRegistryRow: boolean;
  retired: boolean;
}

interface DispatchState {
  id: string;
  signature: string;
  controller: AbortController;
  signals: readonly DerivedSignal[];
  /** Row durable and consumption at least owed. */
  accepted: boolean;
  /** onWake returned: the send is streaming or has exited and can no longer be withdrawn. */
  settled: boolean;
}

/** Identity a persisted wake row carries per process, see buildMetadata. */
export type DeliveredWakeRecord = Pick<BashMonitorWakeDisplayRecord, "processId" | "wakeUpdatedAt">;

interface ReconcileState {
  requested: boolean;
  scheduled: boolean;
  promise?: Promise<void>;
  dispatch?: DispatchState;
  /** Signals of an accepted wake whose consumption I/O has not succeeded; applied before any dispatch. */
  owedAcceptance?: readonly DerivedSignal[];
  /** Frontier a committed stop still has to retire; applied before any dispatch. */
  owedRetirement?: readonly BashMonitorProcessSnapshot[];
  retirementCompletions?: Set<() => void>;
  /** Outstanding wake keys already looked up in the transcript (see deliveredSignals). */
  transcriptChecked?: ReadonlySet<string>;
}

function signalKey(processId: string, createdAt: string): string {
  return processId + "\u0000" + createdAt;
}

/** Identifies one wake of a process; changes whenever the process has new attention to report. */
function wakeUpdatedAt(signal: DerivedSignal): string {
  return (
    signal.lost?.failedAt ??
    signal.terminal?.settledAt ??
    (signal.matchOffset != null ? signal.createdAt + ":" + signal.matchOffset : signal.createdAt)
  );
}

function wakeKey(processId: string, updatedAt: string): string {
  return processId + "\u0000" + updatedAt;
}

function normalizedTerminalStatus(
  terminal: BashMonitorTerminalSummary
): "exited" | "killed" | "failed" {
  return terminal.status === "timed_out" ? "killed" : terminal.status;
}

function describeTerminal(terminal: BashMonitorTerminalSummary): string {
  switch (terminal.status) {
    case "exited":
      return `exited (code ${terminal.exitCode ?? "unknown"})`;
    case "killed":
    case "timed_out":
      return "killed (timeout or terminate)";
    case "failed":
      return "failed";
  }
}

function taskAwaitCall(taskIds: readonly string[], extraArgs = ""): string {
  const ids = [...new Set(taskIds)].map((id) => JSON.stringify(id)).join(", ");
  return `task_await({ task_ids: [${ids}], timeout_secs: 0${extraArgs} })`;
}

function outputReadable(signal: DerivedSignal): boolean {
  return signal.taskAwaitable && signal.lost?.failedOperations?.includes("readOutput") !== true;
}

/** Facts Xum computed about the shared read cursor: numbers and fixed text, never output. */
function describeReadState(signal: DerivedSignal): string {
  if (!outputReadable(signal)) return "";
  const parts: string[] = [];
  if (signal.unreadBytes != null) parts.push(`Unread output: ${signal.unreadBytes} bytes`);
  if (signal.matchedOutputReadPast) parts.push(`Note: ${BASH_MONITOR_READ_PAST_NOTE}`);
  if (signal.unreadBytes != null && signal.unreadBytes > BASH_MAX_TOTAL_BYTES) {
    const filterArgs =
      `, filter: ${JSON.stringify(signal.filter)}` +
      (signal.filterExclude ? ", filter_exclude: true" : "");
    parts.push(
      `A read returns at most ${BASH_MAX_TOTAL_BYTES} bytes. To read only the lines this monitor matches, use \`${taskAwaitCall([signal.taskId], filterArgs)}\`. A filtered read drops the other lines for good.`
    );
  }
  return parts.map((part) => `\n${part}`).join("");
}

function buildPrompt(signals: readonly DerivedSignal[]): string {
  assert(signals.length > 0, "buildPrompt requires at least one signal");
  const matchSignals = signals.filter((signal) => signal.kind !== "monitor-lost");
  const lostSignals = signals.filter((signal) => signal.kind === "monitor-lost");
  const runtimeLostSignals = lostSignals.filter(
    (signal) => signal.lost?.reason === "runtime-failure"
  );
  const restartLostSignals = lostSignals.filter((signal) => signal.lost == null);
  const sections = signals.map((signal) => {
    const displayName = signal.displayName ?? signal.processId;
    const monitorLine = `Monitor: /${signal.filter}/${signal.filterExclude ? " (inverted)" : ""}`;
    const readState = describeReadState(signal);
    if (signal.kind === "monitor-lost") {
      const script = signal.script
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      if (signal.lost?.reason === "runtime-failure") {
        const failedOperations =
          signal.lost.failedOperations != null && signal.lost.failedOperations.length > 0
            ? `\nFailed operations: ${signal.lost.failedOperations.join(", ")}`
            : "";
        const taskIdSuffix = signal.taskAwaitable
          ? signal.lost.failedOperations?.includes("readOutput") === true
            ? " (output is not currently readable)"
            : ""
          : " (no longer awaitable; the process exited or this process ID was reused)";
        return `Process: ${displayName}\nTask ID: ${signal.taskId}${taskIdSuffix}\n${monitorLine}\nStatus: The monitor failed at runtime and will produce no further wakes; the process may still be running.${failedOperations}${readState}\nScript:\n${script}`;
      }
      return `Process: ${displayName}\nTask ID: ${signal.taskId} (no longer awaitable — process was terminated)\n${monitorLine}\nStatus: Xum restarted. This background process was terminated (or orphaned if Xum crashed) and its monitor is no longer active; it will produce no further wakes.\nScript:\n${script}`;
    }
    if (signal.terminal != null) {
      const taskIdSuffix = signal.taskAwaitable
        ? ""
        : " (no longer awaitable — Xum restarted since it settled)";
      return `Process: ${displayName}\nTask ID: ${signal.taskId}${taskIdSuffix}\n${monitorLine}\nStatus: ${describeTerminal(signal.terminal)}${readState}`;
    }
    return `Process: ${displayName}\nTask ID: ${signal.taskId}\n${monitorLine}${readState}`;
  });
  const terminalOnly = (signal: DerivedSignal): boolean =>
    signal.terminal != null && signal.matchOffset == null;
  const header =
    lostSignals.length === 0
      ? matchSignals.every(terminalOnly)
        ? BASH_MONITOR_WAKE_HEADINGS.exited
        : BASH_MONITOR_WAKE_HEADINGS.matched
      : restartLostSignals.length === signals.length
        ? BASH_MONITOR_WAKE_HEADINGS.lost
        : runtimeLostSignals.length === signals.length
          ? BASH_MONITOR_WAKE_HEADINGS.failed
          : restartLostSignals.length > 0
            ? BASH_MONITOR_WAKE_HEADINGS.mixed
            : BASH_MONITOR_WAKE_HEADINGS.mixedRuntimeFailure;
  const closingParts = [
    "This is a condition-driven wake-up. Continue from this event.",
    BASH_MONITOR_OUTPUT_NOT_COPIED,
  ];
  const liveMatches = matchSignals.filter((signal) => signal.terminal == null);
  if (liveMatches.length > 0) {
    closingParts.push(
      `Read the new output with \`${taskAwaitCall(liveMatches.map((signal) => signal.taskId))}\`.`
    );
  }
  const settled = matchSignals.filter((signal) => signal.terminal != null);
  if (settled.length > 0) {
    closingParts.push("The settled process(es) produce no further wakes.");
    const awaitable = settled.filter((signal) => signal.taskAwaitable);
    if (awaitable.length > 0) {
      closingParts.push(
        `Read the final output and status with \`${taskAwaitCall(awaitable.map((signal) => signal.taskId))}\`.`
      );
    }
    if (awaitable.length < settled.length)
      closingParts.push("Task IDs marked no longer awaitable have no retrievable output.");
  }
  if (runtimeLostSignals.length > 0) {
    const awaitable = runtimeLostSignals.filter(outputReadable);
    if (awaitable.length > 0) {
      closingParts.push(
        `Use \`${taskAwaitCall(awaitable.map((signal) => signal.taskId))}\` to inspect current output. A failed monitor cannot be re-attached to a running process; terminate and relaunch only if condition-driven wakes are still needed.`
      );
    }
  }
  if (restartLostSignals.length > 0) {
    closingParts.push(
      "Monitors lost after restart produce no further wakes and their task IDs are not awaitable. Relaunch the script with the bash tool only if the work is still needed."
    );
  }
  return `${header}\n\n${sections.join("\n\n---\n\n")}\n\n${closingParts.join(" ")}`;
}

function buildMetadata(
  signals: readonly DerivedSignal[]
): Extract<MuxMessageMetadata, { type: "bash-monitor-wake" }> {
  return {
    type: "bash-monitor-wake",
    records: signals.map((signal) => ({
      processId: signal.processId,
      wakeUpdatedAt: wakeUpdatedAt(signal),
      kind: signal.kind === "monitor-lost" ? "monitor-lost" : "match",
      displayName: signal.displayName ?? signal.processId,
      filter: signal.filter,
      filterExclude: signal.filterExclude,
      ...(signal.kind === "monitor-lost"
        ? { lostReason: signal.lost?.reason ?? ("restart" as const) }
        : {}),
      ...(signal.terminal != null
        ? {
            terminal: {
              status: normalizedTerminalStatus(signal.terminal),
              ...(signal.terminal.exitCode != null ? { exitCode: signal.terminal.exitCode } : {}),
            },
          }
        : {}),
    })),
  };
}

export class BashMonitorWakeReconciler {
  private readonly locks = new MutexMap<string>();
  private readonly states = new Map<string, ReconcileState>();
  private readonly legacyCleanupAttempted = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly defunctWorkspaces = new Set<string>();
  /** Processes created before this instance can carry acceptances that lived only in a previous one. */
  private readonly constructedAtMs = Date.now();

  constructor(
    private readonly args: {
      sessionsDir: string;
      processManager: BashMonitorWakeReconcilerProcessManager;
      registry: BashMonitorWakeReconcilerRegistry;
      /**
       * Wake identities the owner's transcript carries in rows stamped at or after `sinceMs`, the
       * creation time of the oldest process being checked (-Infinity when an age is unparseable).
       * A rejection holds dispatch.
       */
      deliveredWakes(
        ownerWorkspaceId: string,
        sinceMs: number
      ): Promise<readonly DeliveredWakeRecord[]>;
      onWake(
        dispatch: BashMonitorWakeDispatch
      ): Promise<BashMonitorWakeDispatchOutcome> | BashMonitorWakeDispatchOutcome;
    }
  ) {}

  scheduleReconcile(ownerWorkspaceId: string): void {
    if (this.defunctWorkspaces.has(ownerWorkspaceId)) return;
    const state = this.state(ownerWorkspaceId);
    state.requested = true;
    if (state.promise != null || state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      this.reconcile(ownerWorkspaceId).catch(() => undefined);
    });
  }

  reconcile(ownerWorkspaceId: string): Promise<void> {
    if (this.defunctWorkspaces.has(ownerWorkspaceId)) return Promise.resolve();
    const state = this.state(ownerWorkspaceId);
    state.requested = true;
    if (state.promise != null) return state.promise;
    const promise = this.runReconcileLoop(ownerWorkspaceId, state)
      .then(() => this.resetRetry(ownerWorkspaceId))
      .catch((error: unknown) => {
        this.scheduleRetry(ownerWorkspaceId);
        throw error;
      })
      .finally(() => {
        if (state.promise === promise) state.promise = undefined;
        if (state.requested) this.scheduleReconcile(ownerWorkspaceId);
      });
    state.promise = promise;
    return promise;
  }

  async snapshot(ownerWorkspaceId: string): Promise<BashMonitorWakeReconcilerSnapshot> {
    return this.locks.withLock(ownerWorkspaceId, async () => {
      const { signals } = await this.collect(ownerWorkspaceId, true);
      return {
        ownerWorkspaceId,
        pendingWakeKinds: new Map(signals.map((signal) => [signal.processId, signal.kind])),
      };
    });
  }

  pendingWakeKind(
    snapshot: BashMonitorWakeReconcilerSnapshot,
    processId: string
  ): BashMonitorPendingWakeKind | undefined {
    return snapshot.pendingWakeKinds.get(processId);
  }

  async discardProcess(
    ownerWorkspaceId: string,
    processId: string,
    createdAt: string
  ): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, () => {
      const state = this.state(ownerWorkspaceId);
      // An accepted wake's row is already durable; only a user Stop withdraws it (it joins the send
      // and verifies the abandon marker), so a discarded process leaves it to stream.
      if (
        state.dispatch?.accepted === false &&
        state.dispatch.signals.some(
          (signal) => signal.processId === processId && signal.createdAt === createdAt
        )
      ) {
        state.dispatch.controller.abort();
        state.dispatch = undefined;
      }
      return Promise.resolve();
    });
  }
  async beginFullHistoryClear(ownerWorkspaceId: string): Promise<BashMonitorFullHistoryClearToken> {
    await this.consumeCurrent(ownerWorkspaceId);
    return { ownerWorkspaceId };
  }

  async finishFullHistoryClear(token: BashMonitorFullHistoryClearToken): Promise<void> {
    await this.consumeCurrent(token.ownerWorkspaceId);
  }

  async dispose(ownerWorkspaceId: string): Promise<void> {
    this.defunctWorkspaces.add(ownerWorkspaceId);
    this.resetRetry(ownerWorkspaceId);
    await this.locks.withLock(ownerWorkspaceId, () => {
      const state = this.states.get(ownerWorkspaceId);
      state?.dispatch?.controller.abort();
      this.states.delete(ownerWorkspaceId);
      return Promise.resolve();
    });
  }

  revive(ownerWorkspaceId: string): void {
    this.defunctWorkspaces.delete(ownerWorkspaceId);
  }

  private scheduleRetry(ownerWorkspaceId: string): void {
    if (this.defunctWorkspaces.has(ownerWorkspaceId) || this.retryTimers.has(ownerWorkspaceId)) {
      return;
    }
    const attempt = (this.retryAttempts.get(ownerWorkspaceId) ?? 0) + 1;
    this.retryAttempts.set(ownerWorkspaceId, attempt);
    const delay = Math.min(
      RECONCILE_RETRY_MAX_MS,
      RECONCILE_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 6)
    );
    const timer = setTimeout(() => {
      this.retryTimers.delete(ownerWorkspaceId);
      this.scheduleReconcile(ownerWorkspaceId);
    }, delay);
    timer.unref();
    this.retryTimers.set(ownerWorkspaceId, timer);
  }

  private resetRetry(ownerWorkspaceId: string): void {
    const timer = this.retryTimers.get(ownerWorkspaceId);
    if (timer != null) clearTimeout(timer);
    this.retryTimers.delete(ownerWorkspaceId);
    this.retryAttempts.delete(ownerWorkspaceId);
  }
  private state(ownerWorkspaceId: string): ReconcileState {
    let state = this.states.get(ownerWorkspaceId);
    if (state == null) {
      state = { requested: false, scheduled: false };
      this.states.set(ownerWorkspaceId, state);
    }
    return state;
  }

  private async runReconcileLoop(ownerWorkspaceId: string, state: ReconcileState): Promise<void> {
    do {
      state.requested = false;
      await this.reconcileOnce(ownerWorkspaceId);
    } while (state.requested);
  }

  private async reconcileOnce(ownerWorkspaceId: string): Promise<void> {
    const dispatch = await this.locks.withLock(ownerWorkspaceId, async () => {
      // Consumption that failed on transient I/O is retried here first (a throw lands in the
      // reconcile retry backoff): an accepted wake's signals are never redelivered over the row
      // the transcript already carries, and dismissed attention never dispatches when the stop's
      // own idle transition reconciles.
      const state = this.state(ownerWorkspaceId);
      await this.acceptOwed(ownerWorkspaceId, state);
      await this.retireOwed(ownerWorkspaceId, state);
      const collected = await this.collect(ownerWorkspaceId, true);
      for (const readSettled of collected.deferredReads) {
        void readSettled.finally(() => this.scheduleReconcile(ownerWorkspaceId));
      }
      const delivered = await this.deliveredSignals(ownerWorkspaceId, state, collected.signals);
      const consumed = [...collected.autoConsumed, ...delivered];
      await this.advanceWatermarks(ownerWorkspaceId, collected.watermarks, consumed);
      await this.cleanup(consumed);

      const signals = collected.signals.filter((signal) => !delivered.includes(signal));
      if (signals.length === 0) {
        state.dispatch?.controller.abort();
        state.dispatch = undefined;
        return undefined;
      }

      const signature = JSON.stringify(
        signals.map((signal) => [
          signal.key,
          signal.kind,
          signal.matchOffset,
          signal.terminal?.settledAt,
          signal.matchedOutputReadPast,
        ])
      );
      if (state.dispatch?.signature === signature && !state.dispatch.controller.signal.aborted) {
        return undefined;
      }
      state.dispatch?.controller.abort();
      const next: DispatchState = {
        id: randomUUID(),
        signature,
        controller: new AbortController(),
        signals,
        accepted: false,
        settled: false,
      };
      state.dispatch = next;
      return next;
    });
    if (dispatch == null) return;

    try {
      const outcome = await this.args.onWake({
        ownerWorkspaceId,
        prompt: buildPrompt(dispatch.signals),
        muxMetadata: buildMetadata(dispatch.signals),
        cancelSignal: dispatch.controller.signal,
        onAccepted: async () => this.accept(ownerWorkspaceId, dispatch),
        onDeferred: async () => this.defer(ownerWorkspaceId, dispatch),
      });
      if (outcome === "deferred") await this.defer(ownerWorkspaceId, dispatch);
      else await this.settle(ownerWorkspaceId, dispatch);
    } catch (error) {
      await this.locks.withLock(ownerWorkspaceId, () => {
        const state = this.state(ownerWorkspaceId);
        if (state.dispatch === dispatch) state.dispatch = undefined;
        return Promise.resolve();
      });
      throw error;
    }
  }

  private async defer(ownerWorkspaceId: string, dispatch: DispatchState): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, () => {
      const state = this.state(ownerWorkspaceId);
      if (state.dispatch === dispatch && !dispatch.accepted) state.dispatch = undefined;
      return Promise.resolve();
    });
  }
  private async settle(ownerWorkspaceId: string, dispatch: DispatchState): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, () => {
      dispatch.settled = true;
      this.release(ownerWorkspaceId, dispatch);
      return Promise.resolve();
    });
    if (dispatch.accepted) this.scheduleReconcile(ownerWorkspaceId);
  }
  private async accept(ownerWorkspaceId: string, dispatch: DispatchState): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, async () => {
      if (dispatch.accepted || dispatch.controller.signal.aborted) return;
      dispatch.accepted = true;
      const state = this.state(ownerWorkspaceId);
      // The accepted row is durable, so its consumption stays owed when this I/O fails: the next
      // reconcile retries it ahead of any dispatch instead of failing the turn or redelivering.
      state.owedAcceptance = [...(state.owedAcceptance ?? []), ...dispatch.signals];
      try {
        await this.acceptOwed(ownerWorkspaceId, state);
      } catch (error) {
        log.warn("Bash monitor wake acceptance I/O failed; retrying before the next dispatch", {
          ownerWorkspaceId,
          error,
        });
      } finally {
        this.release(ownerWorkspaceId, dispatch);
      }
    });
    if (dispatch.settled) this.scheduleReconcile(ownerWorkspaceId);
  }
  /**
   * Under the lock. An accepted wake keeps its slot until its send settles (onWake returned), so
   * a Stop landing anywhere before the stream starts can still withdraw it through abortDispatch.
   */
  private release(ownerWorkspaceId: string, dispatch: DispatchState): void {
    const state = this.states.get(ownerWorkspaceId);
    if (state?.dispatch === dispatch && dispatch.accepted && dispatch.settled) {
      state.dispatch = undefined;
    }
  }

  private async acceptOwed(ownerWorkspaceId: string, state: ReconcileState): Promise<void> {
    if (state.owedAcceptance == null) return;
    const watermarks = await this.readWatermarks(ownerWorkspaceId);
    await this.advanceWatermarks(ownerWorkspaceId, watermarks, state.owedAcceptance);
    await this.cleanup(state.owedAcceptance);
    state.owedAcceptance = undefined;
  }

  /**
   * Outstanding signals whose wake row the transcript already carries. An acceptance whose
   * consumption I/O kept failing until the app exited leaves the durable row as the only record
   * of delivery; on the next run the signal derives as outstanding again and is consumed here
   * instead of redelivered. Only processes older than this instance can be in that position (a
   * failed acceptance from this instance stays owed in memory), so live monitors never trigger a
   * history scan per match. Only this reconciler's own accepts add wake rows, so each outstanding
   * key is looked up once and the result holds until the key leaves the outstanding set.
   */
  private async deliveredSignals(
    ownerWorkspaceId: string,
    state: ReconcileState,
    signals: readonly DerivedSignal[]
  ): Promise<DerivedSignal[]> {
    const keyOf = (signal: DerivedSignal) => wakeKey(signal.processId, wakeUpdatedAt(signal));
    const checked = state.transcriptChecked ?? new Set<string>();
    let delivered: DerivedSignal[] = [];
    // Persisted ages are unvalidated strings: compare parsed times and, like startup recovery,
    // count an unparseable age as recovered rather than let it sort past the instance stamp.
    const createdAtMs = (signal: DerivedSignal) => Date.parse(signal.createdAt);
    const recovered = signals.filter((signal) => {
      const ms = createdAtMs(signal);
      return !Number.isFinite(ms) || ms < this.constructedAtMs;
    });
    if (recovered.some((signal) => !checked.has(keyOf(signal)))) {
      const ages = recovered.map(createdAtMs);
      const sinceMs = ages.every(Number.isFinite) ? Math.min(...ages) : -Infinity;
      const rows = await this.args.deliveredWakes(ownerWorkspaceId, sinceMs);
      const inTranscript = new Set(
        rows.flatMap((row) =>
          row.processId != null && row.wakeUpdatedAt != null
            ? [wakeKey(row.processId, row.wakeUpdatedAt)]
            : []
        )
      );
      delivered = recovered.filter((signal) => inTranscript.has(keyOf(signal)));
    }
    state.transcriptChecked = new Set(
      recovered.filter((signal) => !delivered.includes(signal)).map(keyOf)
    );
    return delivered;
  }

  private abortDispatch(ownerWorkspaceId: string): void {
    const state = this.state(ownerWorkspaceId);
    state.dispatch?.controller.abort();
    state.dispatch = undefined;
  }

  /**
   * Withdraws the in-flight wake and consumes every signal outstanding on entry. When `commit` is
   * given, the durable consumption waits for it under the lock and is skipped when it resolves
   * false, leaving the withdrawn signals owed to the next reconcile.
   */
  async consumeCurrent(
    ownerWorkspaceId: string,
    commit?: () => Promise<boolean>,
    onSettled?: () => void
  ): Promise<void> {
    // Withdraw before taking the lock: an acceptance in progress holds it across watermark,
    // registry, and process-acknowledgement I/O, and a hard Stop must cancel the admission
    // without waiting behind that. The lock slot is reserved synchronously too, ahead of any
    // reconcile the stop's own stream abort triggers.
    this.abortDispatch(ownerWorkspaceId);
    // Snapshot the process frontier on entry as well, in the same tick: output that arrives while
    // the stop waits for the lock or settles is new and stays owed to the idle agent, so the
    // retirement itself can run after the commit, or on a later reconcile if its I/O fails.
    const frontier = this.args.processManager.pullMonitorWakeSignals(ownerWorkspaceId);
    const committed = await this.locks.withLock(ownerWorkspaceId, async () => {
      this.abortDispatch(ownerWorkspaceId);
      if (commit != null && !(await commit())) {
        onSettled?.();
        return false;
      }
      const state = this.state(ownerWorkspaceId);
      const owed = new Map(
        (state.owedRetirement ?? []).map((s) => [signalKey(s.processId, s.createdAt), s] as const)
      );
      for (const s of frontier) owed.set(signalKey(s.processId, s.createdAt), s);
      state.owedRetirement = [...owed.values()];
      if (onSettled) (state.retirementCompletions ??= new Set()).add(onSettled);
      await this.retireOwed(ownerWorkspaceId, state);
      return true;
    });
    if (!committed) this.scheduleReconcile(ownerWorkspaceId);
  }

  private async retireOwed(ownerWorkspaceId: string, state: ReconcileState): Promise<void> {
    if (state.owedRetirement == null) return;
    const collected = await this.collect(ownerWorkspaceId, false, state.owedRetirement);
    const consumed = [...collected.signals, ...collected.autoConsumed];
    await this.advanceWatermarks(ownerWorkspaceId, collected.watermarks, consumed);
    await this.cleanup(consumed);
    state.owedRetirement = undefined;
    // Failed I/O retains the original obligation and its receipts for the existing retry.
    const completions = state.retirementCompletions;
    state.retirementCompletions = undefined;
    for (const complete of completions ?? []) complete();
  }

  /**
   * Live monitors merged with their registry rows, plus registry rows whose process is gone. The
   * live set is pulled after the registry read so a monitor armed during the read is never taken
   * for a dead row. With `asOf`, a frontier snapshotted earlier, registry state is bounded to that
   * moment: terminal and lost records land only after the monitor settled or stopped in memory, so
   * a snapshot without terminal was still running and one not retired had not failed, and a row
   * live now but absent from the snapshot was armed since. Whatever arose since stays owed.
   */
  private async candidates(
    ownerWorkspaceId: string,
    asOf?: readonly BashMonitorProcessSnapshot[]
  ): Promise<Array<{ snapshot: BashMonitorProcessSnapshot; deadRegistryRow: boolean }>> {
    const registryRows = await this.args.registry.listAll(ownerWorkspaceId);
    const current = this.args.processManager.pullMonitorWakeSignals(ownerWorkspaceId);
    const live = asOf ?? current;
    const registryByKey = new Map(
      registryRows.map((record) => [signalKey(record.processId, record.createdAt), record] as const)
    );
    const liveKeys = new Set(
      live.map((snapshot) => signalKey(snapshot.processId, snapshot.createdAt))
    );
    const armedSince = new Set(
      asOf == null
        ? []
        : current
            .map((snapshot) => signalKey(snapshot.processId, snapshot.createdAt))
            .filter((key) => !liveKeys.has(key))
    );
    return [
      ...live.map((snapshot) => {
        const record = registryByKey.get(signalKey(snapshot.processId, snapshot.createdAt));
        return {
          snapshot: {
            ...snapshot,
            ...(asOf == null && snapshot.terminal == null && record?.terminal != null
              ? { terminal: record.terminal }
              : {}),
            ...(record?.lost != null && (asOf == null || snapshot.retired)
              ? { lost: record.lost }
              : {}),
          },
          deadRegistryRow: false,
        };
      }),
      ...registryRows
        .filter((record) => {
          const key = signalKey(record.processId, record.createdAt);
          return !liveKeys.has(key) && !armedSince.has(key);
        })
        .map((record) => ({
          snapshot: this.fromRegistry(record, ownerWorkspaceId),
          deadRegistryRow: true,
        })),
    ];
  }

  private async collect(
    ownerWorkspaceId: string,
    applyFrontier: boolean,
    liveAsOf?: readonly BashMonitorProcessSnapshot[]
  ): Promise<{
    signals: DerivedSignal[];
    autoConsumed: DerivedSignal[];
    deferredReads: Array<Promise<void>>;
    watermarks: Map<string, WatermarkEntry>;
  }> {
    await this.deleteLegacyWakeDirOnce(ownerWorkspaceId);
    const [candidates, watermarks] = await Promise.all([
      this.candidates(ownerWorkspaceId, liveAsOf),
      this.readWatermarks(ownerWorkspaceId),
    ]);
    const activeKeys = new Set(
      candidates.map(({ snapshot }) => signalKey(snapshot.processId, snapshot.createdAt))
    );
    let pruned = false;
    for (const key of watermarks.keys()) {
      if (!activeKeys.has(key)) {
        watermarks.delete(key);
        pruned = true;
      }
    }
    if (pruned) await this.writeWatermarks(ownerWorkspaceId, watermarks);

    const signals: DerivedSignal[] = [];
    const autoConsumed: DerivedSignal[] = [];
    const deferredReads: Array<Promise<void>> = [];
    for (const candidate of candidates) {
      const derived = await this.derive(
        candidate.snapshot,
        candidate.deadRegistryRow,
        watermarks,
        applyFrontier
      );
      if (derived == null) continue;
      if (derived.deferredRead != null) deferredReads.push(derived.deferredRead);
      else if (derived.outstanding) signals.push(derived.signal);
      else if (derived.consume) autoConsumed.push(derived.signal);
    }
    signals.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.processId.localeCompare(b.processId)
    );
    return { signals, autoConsumed, deferredReads, watermarks };
  }

  private async derive(
    snapshot: BashMonitorProcessSnapshot,
    deadRegistryRow: boolean,
    watermarks: ReadonlyMap<string, WatermarkEntry>,
    applyFrontier: boolean
  ): Promise<
    | {
        signal: DerivedSignal;
        outstanding: boolean;
        consume: boolean;
        deferredRead?: Promise<void>;
      }
    | undefined
  > {
    const key = signalKey(snapshot.processId, snapshot.createdAt);
    const watermark = watermarks.get(key);
    const matchNew =
      snapshot.match != null &&
      snapshot.match.throughOffset > (watermark?.matchedThroughOffset ?? -1);
    const terminalNew =
      snapshot.terminal != null && snapshot.terminal.settledAt !== watermark?.terminalSettledAt;
    const optedOutMatchLost =
      deadRegistryRow &&
      snapshot.terminal?.wakeOnExit === false &&
      snapshot.terminal.matchedThroughOffset != null &&
      snapshot.terminal.matchedThroughOffset > (watermark?.matchedThroughOffset ?? -1);
    const lostNew =
      watermark?.lost !== true &&
      (snapshot.lost != null ||
        optedOutMatchLost ||
        (deadRegistryRow && snapshot.terminal == null && snapshot.lost == null));
    if (!matchNew && !terminalNew && !lostNew) {
      if (deadRegistryRow || snapshot.retired) {
        return {
          signal: this.toSignal(snapshot, deadRegistryRow, false),
          outstanding: false,
          consume: true,
        };
      }
      return undefined;
    }

    const deliveryState = applyFrontier
      ? await this.args.processManager.getMonitorWakeDeliveryState(
          snapshot.processId,
          Date.parse(snapshot.createdAt)
        )
      : undefined;
    if (deliveryState?.status === "blocked") {
      return {
        signal: this.toSignal(snapshot, deadRegistryRow, true),
        outstanding: false,
        consume: false,
        deferredRead: deliveryState.readSettled,
      };
    }
    const matchShown =
      matchNew &&
      deliveryState?.status === "settled" &&
      snapshot.match != null &&
      deliveryState.shownThroughOffset >= snapshot.match.throughOffset;
    const terminalShown =
      terminalNew &&
      ((deliveryState?.status === "settled" && deliveryState.terminalStatusShown) ||
        snapshot.terminal?.terminalStatusShown === true);
    const terminalWake = terminalNew && snapshot.terminal?.wakeOnExit === true && !terminalShown;
    const lostWake = lostNew;
    const matchWake = matchNew && !matchShown;
    const signal = this.toSignal(
      snapshot,
      deadRegistryRow,
      deliveryState?.status === "settled"
        ? (deliveryState.taskAwaitable ?? true)
        : !deadRegistryRow,
      deliveryState?.status === "settled" ? deliveryState : undefined
    );
    signal.kind = lostWake ? "monitor-lost" : matchWake ? "match" : "settled";
    const outstanding = lostWake || matchWake || terminalWake;
    return { signal, outstanding, consume: !outstanding };
  }

  private toSignal(
    snapshot: BashMonitorProcessSnapshot,
    deadRegistryRow: boolean,
    taskAwaitable: boolean,
    readState?: Extract<BashMonitorWakeDeliveryState, { status: "settled" }>
  ): DerivedSignal {
    const matchOffset =
      snapshot.lost?.failedMatch?.matchedThroughOffset != null ||
      snapshot.match != null ||
      snapshot.terminal?.matchedThroughOffset != null
        ? Math.max(
            snapshot.lost?.failedMatch?.matchedThroughOffset ?? -1,
            snapshot.match?.throughOffset ?? -1,
            snapshot.terminal?.matchedThroughOffset ?? -1
          )
        : undefined;
    const readCursor = readState?.readCursorOffset;
    return {
      key: signalKey(snapshot.processId, snapshot.createdAt),
      ownerWorkspaceId: snapshot.ownerWorkspaceId,
      processId: snapshot.processId,
      taskId: snapshot.taskId,
      ...(snapshot.displayName != null ? { displayName: snapshot.displayName } : {}),
      filter: snapshot.filter,
      filterExclude: snapshot.filterExclude,
      script: snapshot.script,
      createdAt: snapshot.createdAt,
      kind: "match",
      ...(matchOffset != null ? { matchOffset } : {}),
      ...(readCursor != null && readState?.outputThroughOffset != null
        ? { unreadBytes: Math.max(0, readState.outputThroughOffset - readCursor) }
        : {}),
      // Definite case only: the whole latest match lies behind the cursor. When only part of it
      // does, the next read still returns the latest matched line.
      matchedOutputReadPast:
        matchOffset != null &&
        readCursor != null &&
        readState != null &&
        readState.shownThroughOffset < matchOffset &&
        matchOffset <= readCursor,
      ...(snapshot.terminal?.wakeOnExit === true ? { terminal: snapshot.terminal } : {}),
      ...(snapshot.lost != null
        ? {
            lost: {
              reason: snapshot.lost.reason,
              ...(snapshot.lost.failedOperations != null
                ? { failedOperations: snapshot.lost.failedOperations }
                : {}),
              failedAt: snapshot.lost.failedAt,
            },
          }
        : {}),
      taskAwaitable,
      deadRegistryRow,
      retired: snapshot.retired,
    };
  }

  private fromRegistry(
    record: BashMonitorRegistryRecord,
    ownerWorkspaceId: string
  ): BashMonitorProcessSnapshot {
    return {
      processId: record.processId,
      taskId: record.taskId,
      ownerWorkspaceId,
      ...(record.displayName != null ? { displayName: record.displayName } : {}),
      filter: record.filter,
      filterExclude: record.filterExclude,
      script: record.script,
      createdAt: record.createdAt,
      ...(record.terminal != null ? { terminal: record.terminal } : {}),
      ...(record.lost != null ? { lost: record.lost } : {}),
      retired: true,
    };
  }

  private async advanceWatermarks(
    ownerWorkspaceId: string,
    watermarks: Map<string, WatermarkEntry>,
    signals: readonly DerivedSignal[]
  ): Promise<void> {
    if (signals.length === 0) return;
    for (const signal of signals) {
      const previous = watermarks.get(signal.key);
      watermarks.set(signal.key, {
        processId: signal.processId,
        createdAt: signal.createdAt,
        ...(signal.matchOffset != null
          ? {
              matchedThroughOffset: Math.max(
                signal.matchOffset,
                previous?.matchedThroughOffset ?? -1
              ),
            }
          : previous?.matchedThroughOffset != null
            ? { matchedThroughOffset: previous.matchedThroughOffset }
            : {}),
        ...(signal.terminal != null
          ? { terminalSettledAt: signal.terminal.settledAt }
          : previous?.terminalSettledAt != null
            ? { terminalSettledAt: previous.terminalSettledAt }
            : {}),
        ...(signal.kind === "monitor-lost" || previous?.lost === true ? { lost: true } : {}),
      });
    }
    await this.writeWatermarks(ownerWorkspaceId, watermarks);
  }

  private async cleanup(signals: readonly DerivedSignal[]): Promise<void> {
    for (const signal of signals) {
      if (!signal.deadRegistryRow) {
        await this.args.processManager.acknowledgeMonitorWake(
          signal.processId,
          Date.parse(signal.createdAt),
          signal.matchOffset,
          signal.terminal?.settledAt
        );
      }
      if (signal.deadRegistryRow || signal.retired) {
        await this.args.registry.remove(
          signal.ownerWorkspaceId,
          signal.processId,
          signal.createdAt
        );
      }
      if (signal.retired) {
        await this.args.processManager.dropRetiredMonitor(signal.processId, signal.createdAt);
      }
    }
  }

  private watermarkPath(ownerWorkspaceId: string): string {
    return path.join(this.args.sessionsDir, ownerWorkspaceId, WATERMARK_FILE);
  }

  private async readWatermarks(ownerWorkspaceId: string): Promise<Map<string, WatermarkEntry>> {
    try {
      const parsed: unknown = JSON.parse(
        await fsPromises.readFile(this.watermarkPath(ownerWorkspaceId), "utf8")
      );
      if (parsed == null || typeof parsed !== "object") return new Map();
      const candidate = parsed as { version?: unknown; entries?: unknown };
      if (candidate.version !== WATERMARK_VERSION || !Array.isArray(candidate.entries)) {
        return new Map();
      }
      const entries = new Map<string, WatermarkEntry>();
      for (const value of candidate.entries) {
        if (value == null || typeof value !== "object") continue;
        const entry = value as Partial<WatermarkEntry>;
        if (typeof entry.processId !== "string" || typeof entry.createdAt !== "string") continue;
        const normalized: WatermarkEntry = {
          processId: entry.processId,
          createdAt: entry.createdAt,
          ...(typeof entry.matchedThroughOffset === "number"
            ? { matchedThroughOffset: entry.matchedThroughOffset }
            : {}),
          ...(typeof entry.terminalSettledAt === "string"
            ? { terminalSettledAt: entry.terminalSettledAt }
            : {}),
          ...(entry.lost === true ? { lost: true } : {}),
        };
        entries.set(signalKey(normalized.processId, normalized.createdAt), normalized);
      }
      return entries;
    } catch (error) {
      if (isErrnoWithCode(error, "ENOENT") || error instanceof SyntaxError) return new Map();
      throw error;
    }
  }

  private async writeWatermarks(
    ownerWorkspaceId: string,
    watermarks: ReadonlyMap<string, WatermarkEntry>
  ): Promise<void> {
    const file = this.watermarkPath(ownerWorkspaceId);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    const temp = file + "." + process.pid + "." + randomUUID() + ".tmp";
    await fsPromises.writeFile(
      temp,
      JSON.stringify({ version: WATERMARK_VERSION, entries: [...watermarks.values()] }, null, 2),
      "utf8"
    );
    try {
      await fsPromises.rename(temp, file);
    } finally {
      await fsPromises.rm(temp, { force: true });
    }
  }

  private async deleteLegacyWakeDirOnce(ownerWorkspaceId: string): Promise<void> {
    if (this.legacyCleanupAttempted.has(ownerWorkspaceId)) return;
    this.legacyCleanupAttempted.add(ownerWorkspaceId);
    try {
      await fsPromises.rm(path.join(this.args.sessionsDir, ownerWorkspaceId, LEGACY_WAKE_DIR), {
        recursive: true,
        force: true,
      });
    } catch {
      // Best-effort compatibility cleanup must not block live wake delivery.
    }
  }
}
