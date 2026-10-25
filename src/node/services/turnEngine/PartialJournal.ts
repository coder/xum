/**
 * PartialJournal: the one owner of the partial.json and chat.jsonl writes that a
 * StreamManager turn makes (turn-engine layer 3a).
 *
 * Shape: a plain class that StreamManager constructs with its own HistoryService,
 * EffectRunner and HostClock, like the hand-built services that derive their clock
 * with `hostClockFor`. It is not a Context.Service tag: no other service consumes it,
 * and tests must keep spying on the HistoryService instance they pass to
 * StreamManager. The per-turn state stays a plain record on WorkspaceStreamInfo
 * (which extends PartialJournalState), because whitebox fixtures hand-build stream
 * infos with these fields. Only this class reads or writes them.
 *
 * Invariants:
 * - At most one writePartial is in flight per turn; a flush waits for it first.
 * - A scheduled (debounced) flush runs at most once per throttle window, on the
 *   runner's clock, and dies with the turn's resource scope.
 * - Once retired (final message written, terminal error partial written, or stream
 *   resources closed), no flush writes partial.json again.
 */
import { Duration, Effect, Fiber, type Scope } from "effect";

import type { MuxMessage } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import type { EffectRunner } from "@/node/services/di/effectRunner";
import type { HistoryService } from "@/node/services/historyService";
import { log, type Logger } from "@/node/services/log";
import type { HostClock } from "@/node/utils/hostClock";
import type { PartialJournalState } from "@/node/services/turnEngine/turnState";
export type { PartialJournalState } from "@/node/services/turnEngine/turnState";

/** One turn's partial: its workspace, its journal state and its current snapshot. */
export interface PartialTarget {
  readonly workspaceId: string;
  readonly state: PartialJournalState;
  /** Builds the snapshot at write time, after any in-flight write finished. */
  readonly snapshot: () => MuxMessage;
}

export interface PartialJournalDeps {
  readonly historyService: HistoryService;
  readonly runner: EffectRunner;
  readonly clock: HostClock;
  readonly throttleMs: number;
}

export class PartialJournal {
  constructor(private readonly deps: PartialJournalDeps) {}

  /** A turn that has never written: the first schedule writes immediately. */
  static initialState(): PartialJournalState {
    return { lastPartialWriteTime: 0, partialWritePromise: undefined };
  }

  /**
   * Write the current partial message to disk (throttled by mtime)
   * Ensures writes happen during rapid streaming (crash-resilient)
   */
  async schedule(target: PartialTarget, resourceScope: Scope.Closeable | undefined): Promise<void> {
    const { state } = target;
    const timeSinceLastWrite = this.deps.clock.nowMs() - state.lastPartialWriteTime;

    // If enough time has passed, write immediately
    if (timeSinceLastWrite >= this.deps.throttleMs) {
      await this.flush(target);
      return;
    }

    // Otherwise, schedule a delayed flush (fire-and-forget for scheduled
    // writes). Re-arming replaces the previous debounce fiber, mirroring the
    // previous clearTimeout.
    this.interruptScheduled(state);

    const remainingTime = this.deps.throttleMs - timeSinceLastWrite;
    const delayedFlush = Effect.sleep(Duration.millis(remainingTime)).pipe(
      // Clear the self-reference before flushing so flush's re-arm
      // cancellation cannot interrupt the very fiber performing the flush.
      Effect.flatMap(() =>
        Effect.sync(() => {
          state.partialWriteFiber = undefined;
        })
      ),
      // Async thunk: flush errors are contained inside flush, so this
      // mirrors the previous `void this.flushPartialWrite(...)` callback.
      Effect.flatMap(() => Effect.promise(async () => this.flush(target)))
    );

    // Fork into the stream's resource scope so a pending flush is interrupted
    // with the stream — a debounced write must never fire after the stream
    // ends and resurrect partial.json. runFork/forkIn execute synchronously up
    // to the sleep, so the debounce delay is registered before this method
    // returns (same observable ordering as the previous setTimeout call).
    state.partialWriteFiber = resourceScope
      ? this.deps.runner.runSync(Effect.forkIn(delayedFlush, resourceScope))
      : // Whitebox test fixtures register stream infos without a resource scope.
        this.deps.runner.runFork(delayedFlush);
  }

  /**
   * Flush any pending partial write and write immediately
   * Serializes writes to prevent races - waits for any in-flight write before starting new one
   */
  async flush(
    target: PartialTarget,
    /**
     * The stream's terminal snapshot (the error partial). It is written through this same
     * tracked write, and it retires later flushes: a cancel racing the error path would
     * otherwise write a pre-error snapshot after it and drop the error (#5344).
     */
    terminalPartial?: MuxMessage
  ): Promise<void> {
    const { state } = target;
    // Wait for any in-flight write to complete first (serialization)
    await this.awaitPending(state);

    // Cancel any scheduled debounce flush — we're writing now
    this.interruptScheduled(state);

    // The final message owns chat.jsonl now; re-creating partial.json here (a
    // cancel racing the completion path) would be committed over it on next load.
    if (state.partialRetired) {
      return;
    }
    // Retire synchronously, before the write starts, so a flush that resumes during it is a no-op.
    if (terminalPartial) state.partialRetired = true;

    // Start new write and track the promise
    state.partialWritePromise = (async () => {
      try {
        await this.deps.historyService.writePartial(
          target.workspaceId,
          terminalPartial ?? target.snapshot()
        );
        state.lastPartialWriteTime = this.deps.clock.nowMs();
      } catch (error) {
        log.error("Failed to write partial message:", error);
      } finally {
        // Clear promise when write completes
        state.partialWritePromise = undefined;
      }
    })();

    // Wait for this write to complete
    await state.partialWritePromise;
  }

  /**
   * Interrupt a scheduled (not yet flushed) partial-write debounce fiber, if
   * any. The interrupt is fire-and-forget: the signal lands synchronously for
   * a fiber sleeping on Effect's clock (house pattern: retryManager), which
   * mirrors the previous clearTimeout semantics.
   */
  interruptScheduled(state: PartialJournalState): void {
    const fiber = state.partialWriteFiber;
    if (fiber == null) {
      return;
    }
    state.partialWriteFiber = undefined;
    this.deps.runner.runFork(Fiber.interrupt(fiber));
  }

  async awaitPending(state: PartialJournalState): Promise<void> {
    if (state.partialWritePromise) {
      await state.partialWritePromise;
    }
  }

  /** No flush writes partial.json for this turn after this. */
  retire(state: PartialJournalState): void {
    state.partialRetired = true;
  }

  /** Before a retried attempt: no scheduled or in-flight write, and the next write is immediate. */
  async resetForRetry(state: PartialJournalState): Promise<void> {
    this.interruptScheduled(state);
    await this.awaitPending(state);
    state.partialWritePromise = undefined;
    state.lastPartialWriteTime = 0;
  }

  /** Clears partial.json before a retried attempt that does not keep its parts. */
  async deleteForRetry(workspaceId: string): Promise<Result<void>> {
    return this.deps.historyService.deletePartial(workspaceId);
  }

  /**
   * The aborted turn's usage-stamped partial. Untracked, as before the journal:
   * the abort path has already waited for the in-flight write.
   */
  async writeAbortPartial(workspaceId: string, message: MuxMessage): Promise<void> {
    await this.deps.historyService.writePartial(workspaceId, message);
  }

  /**
   * Ends an aborted turn's partial: commit it to chat.jsonl, or with abandon delete it
   * (only when it is still this message's).
   */
  async settleAbort(
    workspaceId: string,
    messageId: string,
    abandon: boolean
  ): Promise<Result<unknown>> {
    return abandon
      ? this.deps.historyService.deletePartialIfMessageIdMatches(workspaceId, messageId)
      : this.deps.historyService.commitPartial(workspaceId, messageId);
  }

  /**
   * Writes a completed turn's final message, then removes its partial. Retires the
   * partial first.
   */
  async commitFinal(
    workspaceId: string,
    state: PartialJournalState,
    finalMessage: MuxMessage,
    workspaceLog: Logger
  ): Promise<void> {
    // Retire partial writes first: a cancel (user stop, shutdown) landing
    // between here and COMPLETED must not flush partial.json back to disk.
    this.retire(state);

    // CRITICAL: Persist the final message to chat.jsonl BEFORE deleting
    // partial.json (same order as commitPartial). Deleting first left a window
    // (a crash, or an updateHistory failure such as the history-lock timeout)
    // with an empty placeholder row and no partial: the completed reply was
    // lost for good. partial.json already holds the final parts (flushed
    // above), so on failure keep it for commitPartial recovery.
    const updateResult = await this.deps.historyService.updateHistory(workspaceId, finalMessage);
    if (!updateResult.success) {
      workspaceLog.warn("Failed to update history on stream end; keeping partial", {
        error: updateResult.error,
      });
      // The provider finished this turn: keep the final message as the partial, marked
      // finalized, so startup recovery commits it instead of treating the turn as
      // interrupted and auto-retrying an extra continuation (#5322). Only this stream's
      // own partial. If this write fails too, the partial stays unmarked: today's
      // interrupted-turn recovery, which loses nothing.
      const markResult = await this.deps.historyService.updatePartialIfMessageIdMatches(
        workspaceId,
        finalMessage.id,
        () => ({
          ...finalMessage,
          metadata: { ...finalMessage.metadata, streamFinalized: true },
        })
      );
      if (!markResult.success || !markResult.data) {
        workspaceLog.warn("Failed to mark the kept partial finalized", {
          error: markResult.success ? "partial belongs to another message" : markResult.error,
        });
      }
      return;
    }
    // On successful completion, partial.json becomes stale and must be removed.
    // Only this stream's own partial: the row just written covers nothing else
    // (row first, then the partial delete: the crash-safe order).
    const deleteResult = await this.deps.historyService.deletePartialIfMessageIdMatches(
      workspaceId,
      finalMessage.id
    );
    if (!deleteResult.success) {
      workspaceLog.warn("Failed to delete partial on stream end", { error: deleteResult.error });
    }
  }
}
