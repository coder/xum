import { randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import type { MuxMessageMetadata } from "@/common/types/message";
import { BASH_MONITOR_WAKE_HEADINGS } from "@/common/utils/machineTurnPrompts";
import type {
  BashMonitorRegistryRecord,
  BashMonitorTerminalSummary,
} from "@/node/services/bashMonitorRegistryStore";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { isErrnoWithCode } from "@/node/utils/fs";

const WATERMARK_FILE = "bash-monitor-watermark.json";
const LEGACY_WAKE_DIR = "bash-monitor-wakes";
const WATERMARK_VERSION = 1;

export type BashMonitorPendingWakeKind = "match" | "monitor-lost" | "settled";

export interface BashMonitorMatchSnapshot {
  throughOffset: number;
  lines: readonly string[];
  totalMatches: number;
  droppedLines?: number;
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
  retired: boolean;
}

export interface BashMonitorWakeFrontier {
  shownThroughOffset: number;
  terminalStatusShown: boolean;
  taskAwaitable: boolean;
}

export interface BashMonitorWakeReconcilerProcessManager {
  pullMonitorWakeSignals(ownerWorkspaceId: string): Promise<readonly BashMonitorProcessSnapshot[]>;
  getMonitorWakeFrontier(
    processId: string,
    originNotAfterMs: number
  ): Promise<BashMonitorWakeFrontier | undefined>;
  dropRetiredMonitor(processId: string): Promise<void> | void;
}

export interface BashMonitorWakeReconcilerRegistry {
  listAll(ownerWorkspaceId: string): Promise<readonly BashMonitorRegistryRecord[]>;
  remove(ownerWorkspaceId: string, processId: string): Promise<void>;
  recordTerminal(
    ownerWorkspaceId: string,
    processId: string,
    terminal: BashMonitorTerminalSummary
  ): Promise<void>;
}

export interface BashMonitorWakeDispatch {
  ownerWorkspaceId: string;
  prompt: string;
  muxMetadata: Extract<MuxMessageMetadata, { type: "bash-monitor-wake" }>;
  dedupeKey: string;
  cancelSignal: AbortSignal;
  onAccepted(): Promise<void>;
}

export interface BashMonitorWakeReconcilerSnapshot {
  ownerWorkspaceId: string;
  pendingWakeKinds: ReadonlyMap<string, BashMonitorPendingWakeKind>;
}

export interface BashMonitorFullHistoryClearToken {
  ownerWorkspaceId: string;
  clearId: string;
}

interface WatermarkEntry {
  processId: string;
  createdAt: string;
  matchedThroughOffset?: number;
  terminalSettledAt?: string;
  lost?: true;
}

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
  lines: readonly string[];
  matchOffset?: number;
  matchedOutputAlreadyShown: boolean;
  terminal?: BashMonitorTerminalSummary;
  taskAwaitable: boolean;
  deadRegistryRow: boolean;
  retired: boolean;
}

interface DispatchState {
  signature: string;
  controller: AbortController;
  signals: readonly DerivedSignal[];
  accepted: boolean;
}

interface ReconcileState {
  requested: boolean;
  scheduled: boolean;
  promise?: Promise<void>;
  dispatch?: DispatchState;
}

function signalKey(processId: string, createdAt: string): string {
  return processId + "\u0000" + createdAt;
}

function normalizedTerminalStatus(
  terminal: BashMonitorTerminalSummary
): "exited" | "killed" | "failed" {
  return terminal.status === "timed_out" ? "killed" : terminal.status;
}

function describeTerminal(terminal: BashMonitorTerminalSummary): string {
  switch (terminal.status) {
    case "exited":
      return "exited (code " + (terminal.exitCode ?? "unknown") + ")";
    case "killed":
      return "was killed";
    case "timed_out":
      return "timed out";
    case "failed":
      return "failed";
  }
}

function headingFor(signals: readonly DerivedSignal[]): string {
  const lost = signals.some((signal) => signal.kind === "monitor-lost");
  const matched = signals.some((signal) => signal.kind === "match");
  const failed = signals.some((signal) => signal.terminal?.status === "failed");
  if (lost && signals.every((signal) => signal.kind === "monitor-lost")) {
    return BASH_MONITOR_WAKE_HEADINGS.lost;
  }
  if (failed && !lost && !matched) return BASH_MONITOR_WAKE_HEADINGS.failed;
  if (lost) return BASH_MONITOR_WAKE_HEADINGS.mixed;
  if (failed) return BASH_MONITOR_WAKE_HEADINGS.mixedRuntimeFailure;
  if (!matched) return BASH_MONITOR_WAKE_HEADINGS.exited;
  return BASH_MONITOR_WAKE_HEADINGS.matched;
}

function buildPrompt(signals: readonly DerivedSignal[]): string {
  const sections = signals.map((signal) => {
    const parts = [
      "Process: " + (signal.displayName ?? signal.processId),
      "Task: " + signal.taskId,
      "Filter: " + (signal.filterExclude ? "exclude" : "match") + " /" + signal.filter + "/",
    ];
    if (signal.kind === "monitor-lost") {
      parts.push(
        "The monitor and process were lost when Xum restarted.",
        "Script: " + signal.script
      );
    } else {
      if (signal.lines.length > 0) {
        parts.push("Output:", ...signal.lines.map((line) => "  " + line));
      }
      if (signal.matchedOutputAlreadyShown) {
        parts.push("The matched output was already shown; only the settlement is new.");
      }
      if (signal.terminal != null) parts.push("Process " + describeTerminal(signal.terminal) + ".");
      parts.push(
        signal.taskAwaitable
          ? "Use task_await with " + signal.taskId + " only if more detail is needed."
          : "This process generation is no longer awaitable."
      );
    }
    return parts.join("\n");
  });
  return headingFor(signals) + "\n\n" + sections.join("\n\n---\n\n");
}

function buildMetadata(
  signals: readonly DerivedSignal[]
): Extract<MuxMessageMetadata, { type: "bash-monitor-wake" }> {
  return {
    type: "bash-monitor-wake",
    records: signals.map((signal) => ({
      processId: signal.processId,
      wakeUpdatedAt:
        signal.terminal?.settledAt ??
        (signal.matchOffset != null
          ? signal.createdAt + ":" + signal.matchOffset
          : signal.createdAt),
      kind: signal.kind === "monitor-lost" ? "monitor-lost" : "match",
      displayName: signal.displayName ?? signal.processId,
      filter: signal.filter,
      filterExclude: signal.filterExclude,
      ...(signal.kind === "monitor-lost" ? { lostReason: "restart" as const } : {}),
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

  constructor(
    private readonly args: {
      sessionsDir: string;
      processManager: BashMonitorWakeReconcilerProcessManager;
      registry: BashMonitorWakeReconcilerRegistry;
      onWake(dispatch: BashMonitorWakeDispatch): Promise<void> | void;
    }
  ) {}

  scheduleReconcile(ownerWorkspaceId: string): void {
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
    const state = this.state(ownerWorkspaceId);
    state.requested = true;
    if (state.promise != null) return state.promise;
    const promise = this.runReconcileLoop(ownerWorkspaceId, state).finally(() => {
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

  async beginFullHistoryClear(ownerWorkspaceId: string): Promise<BashMonitorFullHistoryClearToken> {
    this.abortDispatch(ownerWorkspaceId);
    await this.consumeCurrent(ownerWorkspaceId);
    return { ownerWorkspaceId, clearId: randomUUID() };
  }

  async finishFullHistoryClear(token: BashMonitorFullHistoryClearToken): Promise<void> {
    await this.consumeCurrent(token.ownerWorkspaceId);
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
      const collected = await this.collect(ownerWorkspaceId, true);
      await this.advanceWatermarks(ownerWorkspaceId, collected.watermarks, collected.autoConsumed);
      await this.cleanup(collected.autoConsumed);

      const state = this.state(ownerWorkspaceId);
      if (collected.signals.length === 0) {
        state.dispatch?.controller.abort();
        state.dispatch = undefined;
        return undefined;
      }

      const signature = JSON.stringify(
        collected.signals.map((signal) => [
          signal.key,
          signal.kind,
          signal.matchOffset,
          signal.terminal?.settledAt,
          signal.matchedOutputAlreadyShown,
        ])
      );
      if (state.dispatch?.signature === signature && !state.dispatch.controller.signal.aborted) {
        return undefined;
      }
      state.dispatch?.controller.abort();
      const next: DispatchState = {
        signature,
        controller: new AbortController(),
        signals: collected.signals,
        accepted: false,
      };
      state.dispatch = next;
      return next;
    });
    if (dispatch == null) return;

    try {
      await this.args.onWake({
        ownerWorkspaceId,
        prompt: buildPrompt(dispatch.signals),
        muxMetadata: buildMetadata(dispatch.signals),
        dedupeKey: "bash-monitor-wake:" + ownerWorkspaceId,
        cancelSignal: dispatch.controller.signal,
        onAccepted: async () => this.accept(ownerWorkspaceId, dispatch),
      });
    } catch (error) {
      await this.locks.withLock(ownerWorkspaceId, async () => {
        const state = this.state(ownerWorkspaceId);
        if (state.dispatch === dispatch) state.dispatch = undefined;
      });
      throw error;
    }
  }

  private async accept(ownerWorkspaceId: string, dispatch: DispatchState): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, async () => {
      if (dispatch.accepted || dispatch.controller.signal.aborted) return;
      dispatch.accepted = true;
      const watermarks = await this.readWatermarks(ownerWorkspaceId);
      await this.advanceWatermarks(ownerWorkspaceId, watermarks, dispatch.signals);
      await this.cleanup(dispatch.signals);
      const state = this.state(ownerWorkspaceId);
      if (state.dispatch === dispatch) state.dispatch = undefined;
    });
    this.scheduleReconcile(ownerWorkspaceId);
  }

  private abortDispatch(ownerWorkspaceId: string): void {
    const state = this.state(ownerWorkspaceId);
    state.dispatch?.controller.abort();
    state.dispatch = undefined;
  }

  private async consumeCurrent(ownerWorkspaceId: string): Promise<void> {
    await this.locks.withLock(ownerWorkspaceId, async () => {
      this.abortDispatch(ownerWorkspaceId);
      const collected = await this.collect(ownerWorkspaceId, false);
      const consumed = [...collected.signals, ...collected.autoConsumed];
      await this.advanceWatermarks(ownerWorkspaceId, collected.watermarks, consumed);
      await this.cleanup(consumed);
    });
  }

  private async collect(
    ownerWorkspaceId: string,
    applyFrontier: boolean
  ): Promise<{
    signals: DerivedSignal[];
    autoConsumed: DerivedSignal[];
    watermarks: Map<string, WatermarkEntry>;
  }> {
    await this.deleteLegacyWakeDir(ownerWorkspaceId);
    const [live, registryRows, watermarks] = await Promise.all([
      this.args.processManager.pullMonitorWakeSignals(ownerWorkspaceId),
      this.args.registry.listAll(ownerWorkspaceId),
      this.readWatermarks(ownerWorkspaceId),
    ]);
    const liveKeys = new Set(
      live.map((snapshot) => signalKey(snapshot.processId, snapshot.createdAt))
    );
    const candidates: Array<{ snapshot: BashMonitorProcessSnapshot; deadRegistryRow: boolean }> = [
      ...live.map((snapshot) => ({ snapshot, deadRegistryRow: false })),
      ...registryRows
        .filter((record) => !liveKeys.has(signalKey(record.processId, record.createdAt)))
        .map((record) => ({ snapshot: this.fromRegistry(record), deadRegistryRow: true })),
    ];
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
    for (const candidate of candidates) {
      const derived = await this.derive(
        candidate.snapshot,
        candidate.deadRegistryRow,
        watermarks,
        applyFrontier
      );
      if (derived == null) continue;
      if (derived.outstanding) signals.push(derived.signal);
      else if (derived.consume) autoConsumed.push(derived.signal);
    }
    signals.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.processId.localeCompare(b.processId)
    );
    return { signals, autoConsumed, watermarks };
  }

  private async derive(
    snapshot: BashMonitorProcessSnapshot,
    deadRegistryRow: boolean,
    watermarks: ReadonlyMap<string, WatermarkEntry>,
    applyFrontier: boolean
  ): Promise<{ signal: DerivedSignal; outstanding: boolean; consume: boolean } | undefined> {
    const key = signalKey(snapshot.processId, snapshot.createdAt);
    const watermark = watermarks.get(key);
    const matchNew =
      snapshot.match != null &&
      snapshot.match.throughOffset > (watermark?.matchedThroughOffset ?? -1);
    const terminalNew =
      snapshot.terminal != null && snapshot.terminal.settledAt !== watermark?.terminalSettledAt;
    const lostNew = deadRegistryRow && snapshot.terminal == null && watermark?.lost !== true;
    if (!matchNew && !terminalNew && !lostNew) {
      if (deadRegistryRow || snapshot.retired) {
        return {
          signal: this.toSignal(snapshot, deadRegistryRow, false, false),
          outstanding: false,
          consume: true,
        };
      }
      return undefined;
    }

    const frontier = applyFrontier
      ? await this.args.processManager.getMonitorWakeFrontier(
          snapshot.processId,
          Date.parse(snapshot.createdAt)
        )
      : undefined;
    const matchShown =
      matchNew &&
      frontier != null &&
      snapshot.match != null &&
      frontier.shownThroughOffset >= snapshot.match.throughOffset;
    const terminalShown =
      terminalNew &&
      (frontier?.terminalStatusShown === true || snapshot.terminal?.terminalStatusShown === true);
    const terminalWake = terminalNew && snapshot.terminal?.wakeOnExit === true && !terminalShown;
    const lostWake = lostNew;
    const matchWake = matchNew && !matchShown;
    const signal = this.toSignal(
      snapshot,
      deadRegistryRow,
      matchShown,
      frontier?.taskAwaitable ?? !deadRegistryRow
    );
    signal.kind = lostWake ? "monitor-lost" : matchWake ? "match" : "settled";
    const outstanding = lostWake || matchWake || terminalWake;
    return { signal, outstanding, consume: !outstanding };
  }

  private toSignal(
    snapshot: BashMonitorProcessSnapshot,
    deadRegistryRow: boolean,
    matchedOutputAlreadyShown: boolean,
    taskAwaitable: boolean
  ): DerivedSignal {
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
      lines: snapshot.match?.lines ?? [],
      ...(snapshot.match != null ? { matchOffset: snapshot.match.throughOffset } : {}),
      matchedOutputAlreadyShown,
      ...(snapshot.terminal != null ? { terminal: snapshot.terminal } : {}),
      taskAwaitable,
      deadRegistryRow,
      retired: snapshot.retired,
    };
  }

  private fromRegistry(record: BashMonitorRegistryRecord): BashMonitorProcessSnapshot {
    return {
      processId: record.processId,
      taskId: record.taskId,
      ownerWorkspaceId: record.ownerWorkspaceId,
      ...(record.displayName != null ? { displayName: record.displayName } : {}),
      filter: record.filter,
      filterExclude: record.filterExclude,
      script: record.script,
      createdAt: record.createdAt,
      ...(record.terminal != null ? { terminal: record.terminal } : {}),
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
      if (signal.deadRegistryRow || signal.retired) {
        await this.args.registry.remove(signal.ownerWorkspaceId, signal.processId);
      }
      if (signal.retired) {
        await this.args.processManager.dropRetiredMonitor(signal.processId);
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

  private async deleteLegacyWakeDir(ownerWorkspaceId: string): Promise<void> {
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
