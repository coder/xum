import assert from "node:assert/strict";
import type { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import { log } from "@/node/services/log";
import { isWorkspaceTurnTaskId } from "@/node/services/taskHandleStore";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import {
  TerminalAttentionStore,
  type TerminalAttentionNotification,
  type TerminalAttentionOutcome,
} from "@/node/services/terminalAttentionStore";
import type { WorkspaceTurnManager } from "@/node/services/workspaceTurnManager";

// Level-triggered backstop for workflow terminal wakes: the sweep re-derives owed wakes from
// durable state (run records + settled markers), so lost terminal callbacks, deferred
// (transiently unreadable) evaluations, and crashes all recover here without any per-failure
// retry bookkeeping.
export const WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Everything the notifier reads from TaskService. Each entry is a call-time closure over
 * TaskService, never a captured value or bound method: tests swap TaskService fields and patch
 * its methods (the harness wraps drainTerminalAttention) after construction.
 */
export interface TerminalAttentionNotifierDeps {
  terminalAttentionStore: () => Pick<
    TerminalAttentionStore,
    "enqueueIfAbsent" | "markSuperseded" | "listPendingOwnerWorkspaceIds"
  >;
  config: () => Pick<Config, "editConfig">;
  aiService: () => Pick<AIService, "isStreaming">;
  workspaceService: () => Pick<
    WorkspaceHost,
    "getActiveTurnGeneration" | "waitForIdleAndNoQueuedMessages"
  >;
  turnManager: () => Pick<WorkspaceTurnManager, "markWorkspaceTurnBackgroundWorkNotifyOnTerminal">;
  /** TaskService.drainTerminalAttention, which stays on TaskService. */
  drain: (ownerWorkspaceId: string) => Promise<void>;
}

/**
 * Scheduling and bookkeeping for terminal attention (workspace-turn / sub-agent / workflow
 * terminal wake-ups): the durable notify_on_terminal policy writes, the per-owner drain chains,
 * the idle waits, the fresh sub-agent edges and the wake-group send backoff. The drain itself
 * stays on TaskService and runs through deps.drain.
 */
export class TerminalAttentionNotifier {
  // In-flight durable persistence of notify_on_terminal policy for backgrounded foreground waits.
  // Awaited at the start of handleStreamEnd so a just-detached wait is treated as non-blocking.
  private readonly pendingNotifyOnTerminalPersists = new Set<Promise<void>>();
  // In-flight terminal attention drains (workspace-turn / sub-agent terminal wake-ups). Tracked so
  // tests and shutdown can await them; drains are idempotent and re-triggered on owner idle events.
  readonly pendingTerminalAttentionDrainsByOwner = new Map<string, Promise<void>>();
  readonly pendingTerminalAttentionDrains = new Set<Promise<void>>();
  private readonly pendingTerminalAttentionIdleWaitsByOwner = new Map<string, Promise<void>>();
  // Sub-agent terminal notifications this process just enqueued while their owner was streaming,
  // mapped to that owner turn's generation (owner -> notification ID -> turn). The next drain takes
  // the whole map, so each report can cut at most one busy turn, and only the turn that was live
  // at its delivery (see cutBusyOwnerTurnForSubagentAttention).
  private readonly freshSubagentAttentionTurnByOwner = new Map<string, Map<string, symbol>>();
  // Owner -> wake-group key -> epoch ms before which the drain skips selecting the group. A
  // group whose send was rejected for group-specific reasons (for example an unresolvable
  // strictly pinned agent) would otherwise be re-selected newest-first by every drain and
  // sweep, starving older deliverable groups. In-memory only: a restart retries every group,
  // and entries expire on read.
  private readonly workflowWakeGroupSendBackoffUntilMs = new Map<string, Map<string, number>>();

  constructor(private readonly deps: TerminalAttentionNotifierDeps) {}

  /**
   * Persist `notify_on_terminal` on a backgrounded handle (agent task config or
   * workspace-turn record). Tracked per workspace so `handleStreamEnd` can await
   * any in-flight persistence before it reads config to decide blocking work.
   */
  /**
   * Durably mark a still-active task/handle as `notify_on_terminal`. Used when a foreground wait
   * detaches because it exceeded its foreground wait budget (timeout) and the work continues in the
   * background: like queued-message detachment, the work must not re-force the owner to await it.
   * Awaited so callers (e.g. the task tool) can rely on the policy before returning pending results.
   */
  async markBackgroundWorkNotifyOnTerminal(
    taskId: string,
    ownerWorkspaceId: string
  ): Promise<void> {
    await this.persistNotifyOnTerminalPolicy(taskId, ownerWorkspaceId);
  }

  scheduleNotifyOnTerminalPersist(taskId: string, ownerWorkspaceId: string | undefined): void {
    const promise = this.persistNotifyOnTerminalPolicy(taskId, ownerWorkspaceId)
      .catch((error: unknown) => {
        log.error("Failed to persist notify_on_terminal policy for backgrounded wait", {
          taskId,
          error,
        });
      })
      .finally(() => {
        this.pendingNotifyOnTerminalPersists.delete(promise);
      });
    this.pendingNotifyOnTerminalPersists.add(promise);
  }

  /** The notify_on_terminal writes still in flight, for handleStreamEnd to await. */
  inFlightNotifyOnTerminalPersists(): Array<Promise<void>> {
    return [...this.pendingNotifyOnTerminalPersists];
  }

  private async persistNotifyOnTerminalPolicy(
    taskId: string,
    ownerWorkspaceId: string | undefined
  ): Promise<void> {
    if (isWorkspaceTurnTaskId(taskId)) {
      if (ownerWorkspaceId != null) {
        await this.deps
          .turnManager()
          .markWorkspaceTurnBackgroundWorkNotifyOnTerminal(taskId, ownerWorkspaceId);
      }
      return;
    }
    await this.deps.config().editConfig((config) => {
      const found = findWorkspaceEntry(config, taskId);
      if (found != null && found.workspace.taskAttentionPolicy !== "notify_on_terminal") {
        found.workspace.taskAttentionPolicy = "notify_on_terminal";
      }
      return config;
    });
  }

  /**
   * Level-triggered retry for outbox (sub-agent / workspace-turn) attention: pending records
   * are the durable "wake owed" state, but unlike workflow runs they have no periodic
   * re-derivation of their own, so a drain that failed transiently (for example an unreadable
   * history for caller restrictions) would otherwise leave them stuck until restart. Startup
   * and the sweep interval both re-poke their owners; drains are idempotent and no-op when
   * nothing is deliverable.
   */
  async schedulePendingTerminalAttentionOwnerDrains(): Promise<number> {
    const ownerWorkspaceIds = await this.deps
      .terminalAttentionStore()
      .listPendingOwnerWorkspaceIds();
    for (const ownerWorkspaceId of ownerWorkspaceIds) {
      this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
    }
    return ownerWorkspaceIds.length;
  }

  async suppressTerminalAttention(params: {
    ownerWorkspaceId: string;
    sourceKind: TerminalAttentionNotification["sourceKind"];
    sourceId: string;
  }): Promise<void> {
    await this.deps.terminalAttentionStore().enqueueIfAbsent({
      ...params,
      terminalOutcome: "interrupted",
    });
    await this.deps
      .terminalAttentionStore()
      .markSuperseded(
        params.ownerWorkspaceId,
        TerminalAttentionStore.notificationId(params.sourceKind, params.sourceId)
      );
  }

  async enqueueTerminalAttention(params: {
    ownerWorkspaceId: string;
    sourceKind: TerminalAttentionNotification["sourceKind"];
    terminalOutcome: TerminalAttentionOutcome;
    sourceId: string;
    generationId?: string;
  }): Promise<void> {
    const created = await this.deps.terminalAttentionStore().enqueueIfAbsent(params);
    if (created == null) {
      return;
    }
    const liveTurn = this.deps.aiService().isStreaming(created.ownerWorkspaceId)
      ? this.deps.workspaceService().getActiveTurnGeneration(created.ownerWorkspaceId)
      : undefined;
    if (created.sourceKind === "agent_task" && liveTurn != null) {
      let fresh = this.freshSubagentAttentionTurnByOwner.get(created.ownerWorkspaceId);
      if (fresh == null) {
        fresh = new Map();
        this.freshSubagentAttentionTurnByOwner.set(created.ownerWorkspaceId, fresh);
      }
      fresh.set(created.id, liveTurn);
    }
    this.scheduleTerminalAttentionDrain(params.ownerWorkspaceId);
  }

  /**
   * Take and clear the owner's fresh sub-agent edges (see freshSubagentAttentionTurnByOwner).
   * Synchronous, so the drain consumes them before its first await.
   */
  takeFreshTurns(ownerWorkspaceId: string): Map<string, symbol> {
    const freshSubagentAttentionTurns =
      this.freshSubagentAttentionTurnByOwner.get(ownerWorkspaceId) ?? new Map<string, symbol>();
    this.freshSubagentAttentionTurnByOwner.delete(ownerWorkspaceId);
    return freshSubagentAttentionTurns;
  }

  scheduleTerminalAttentionDrain(ownerWorkspaceId: string): void {
    const previous = this.pendingTerminalAttentionDrainsByOwner.get(ownerWorkspaceId);
    const promise = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.deps.drain(ownerWorkspaceId))
      .catch((error: unknown) => {
        log.error("Terminal attention drain failed", { ownerWorkspaceId, error });
      })
      .finally(() => {
        this.pendingTerminalAttentionDrains.delete(promise);
        if (this.pendingTerminalAttentionDrainsByOwner.get(ownerWorkspaceId) === promise) {
          this.pendingTerminalAttentionDrainsByOwner.delete(ownerWorkspaceId);
        }
      });
    this.pendingTerminalAttentionDrainsByOwner.set(ownerWorkspaceId, promise);
    this.pendingTerminalAttentionDrains.add(promise);
  }

  scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId: string): void {
    // One idle wait per owner: each wait subscribes to the owner session's chat-event, and every
    // report deferred by a busy owner lands here. The drain it schedules reads every pending
    // notification from the store, so one wait delivers all of them, in store order.
    if (this.pendingTerminalAttentionIdleWaitsByOwner.has(ownerWorkspaceId)) return;
    const promise = this.deps
      .workspaceService()
      .waitForIdleAndNoQueuedMessages(ownerWorkspaceId)
      .catch((error: unknown) => {
        log.debug("Terminal attention idle wait failed; retrying drain anyway", {
          ownerWorkspaceId,
          error,
        });
      })
      .then(() => {
        // Release the slot before scheduling: that drain can find the owner busy again and must
        // be able to install the next idle wait.
        if (this.pendingTerminalAttentionIdleWaitsByOwner.get(ownerWorkspaceId) === promise) {
          this.pendingTerminalAttentionIdleWaitsByOwner.delete(ownerWorkspaceId);
        }
        this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
      })
      .finally(() => {
        this.pendingTerminalAttentionDrains.delete(promise);
      });
    this.pendingTerminalAttentionIdleWaitsByOwner.set(ownerWorkspaceId, promise);
    this.pendingTerminalAttentionDrains.add(promise);
  }

  /** Track other terminal-attention work (deferred messages, reconciles) with the drains. */
  trackDrain(promise: Promise<void>): void {
    this.pendingTerminalAttentionDrains.add(promise);
  }

  untrackDrain(promise: Promise<void>): void {
    this.pendingTerminalAttentionDrains.delete(promise);
  }

  /**
   * Whether the owner's send batch under `key` is still backed off (see
   * backOffTerminalWakeSends). An expired entry is deleted on this read, and the owner's map
   * with it once empty.
   */
  isWakeSendBackedOff(ownerWorkspaceId: string, key: string): boolean {
    const ownerBackoff = this.workflowWakeGroupSendBackoffUntilMs.get(ownerWorkspaceId);
    const backoffUntil = ownerBackoff?.get(key);
    if (backoffUntil == null) {
      return false;
    }
    if (backoffUntil > Date.now()) {
      return true;
    }
    ownerBackoff?.delete(key);
    if (ownerBackoff?.size === 0) {
      this.workflowWakeGroupSendBackoffUntilMs.delete(ownerWorkspaceId);
    }
    return false;
  }

  /**
   * Back the given terminal-wake send batches off until the sweep cadence retries them and
   * re-poke the drain so the remaining batches get their send this cycle instead of starving
   * behind the failed one.
   */
  backOffTerminalWakeSends(ownerWorkspaceId: string, keys: readonly string[]): void {
    assert(keys.length > 0, "backOffTerminalWakeSends requires keys");
    let ownerBackoff = this.workflowWakeGroupSendBackoffUntilMs.get(ownerWorkspaceId);
    if (ownerBackoff == null) {
      ownerBackoff = new Map();
      this.workflowWakeGroupSendBackoffUntilMs.set(ownerWorkspaceId, ownerBackoff);
    }
    const retryAt = Date.now() + WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS;
    for (const key of keys) {
      ownerBackoff.set(key, retryAt);
    }
    this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
  }
}
