/**
 * TurnRegistry owns each workspace's turn slot: the registered stream, the
 * pre-registration (pending) start, the start lock, the stream token, the
 * engine supervisor that fences shutdown on a turn's completion, and hard and
 * soft stop. StreamManager keeps its public methods as delegates and supplies
 * the partial flush, which still lives there, and the abort cleanup
 * (AttemptLoop.cleanupAbortedStream).
 */
import type { Scope } from "effect";
import { Effect } from "effect";
import assert from "@/common/utils/assert";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { StreamAbortReason } from "@/common/types/stream";
import { getErrorMessage } from "@/common/utils/errors";
import type { EffectRunner } from "@/node/services/di/effectRunner";
import { log } from "@/node/services/log";
import {
  type ActiveStreamInfo,
  type MockStreamLifecycle,
  type StopStreamOptions,
  type WorkspaceId,
  type WorkspaceStreamInfo,
  type StreamToken,
  StreamState,
} from "@/node/services/turnEngine/types";
import type { TurnEvents } from "@/node/services/turnEngine/TurnEvents";
import { linkAbortSignal } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { nodeClock } from "@/node/utils/hostClock";
export { StreamState, type StreamToken } from "@/node/services/turnEngine/types";

export interface PendingStreamStartHandle {
  readonly abortSignal: AbortSignal;
  readonly syntheticMessageId: string;
  /** Cancel this start before its provider request (startup abort settles it). */
  abort(reason: StreamAbortReason): void;
  finish(): void;
}

interface PendingStreamStart {
  abortController: AbortController;
  startTime: number;
  syntheticMessageId: string;
  abortDelivery?: Promise<void>;
  acpPromptId?: string;
}

export interface TurnRegistryDeps {
  readonly effectRunner: EffectRunner;
  /**
   * Supervised scope for the stream engine (the app runtime's `AppFiberScope`,
   * di/appFiberScope.ts). When set, every started stream is wrapped in a
   * supervisor fiber forked here (`superviseEngine`), so
   * `ServiceContainer.dispose()`/the CLI cleanup lists interrupt **and await**
   * in-flight streams — aborted as `"system"`, partial flushed and committed —
   * before the bridges and sessions are torn down. `undefined` (direct
   * construction in tests, `aiService.ts` compat path) keeps streams
   * unsupervised: they die with the process and are recovered from
   * partial.json on next load.
   */
  readonly engineScope?: Scope.Closeable;
  readonly turnEvents: Pick<TurnEvents<WorkspaceStreamInfo>, "emitStreamAbort">;
  /** Read at call time: StreamManager.setMockStreamLifecycle replaces it. */
  readonly mockStreamLifecycle: () => MockStreamLifecycle | undefined;
  readonly flushPartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
  readonly cleanupAbortedStream: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ) => Promise<void>;
}

export class TurnRegistry {
  readonly workspaceStreams = new Map<WorkspaceId, WorkspaceStreamInfo>();
  private readonly pendingStreamStarts = new Map<string, PendingStreamStart>();
  private readonly streamLocks = new Map<WorkspaceId, AsyncMutex>();

  constructor(private readonly deps: TurnRegistryDeps) {}

  getStartupAbortReason(signal?: AbortSignal): StreamAbortReason {
    const reason: unknown = signal?.reason;
    return reason === "user" || reason === "system" || reason === "startup" ? reason : "startup";
  }

  beginStreamStart(input: {
    workspaceId: string;
    abortSignal?: AbortSignal;
    acpPromptId?: string;
  }): PendingStreamStartHandle {
    const abortController = new AbortController();
    // Record time: wall clock until #7282 moves its consumers to HostClock.
    const startTime = nodeClock.nowMs();
    const syntheticMessageId =
      "starting-" + startTime + "-" + Math.random().toString(36).substring(2, 11);
    const unlinkAbortSignal = linkAbortSignal(input.abortSignal, abortController);

    this.pendingStreamStarts.set(input.workspaceId, {
      abortController,
      startTime,
      syntheticMessageId,
      acpPromptId: input.acpPromptId,
    });

    let finished = false;
    return {
      abortSignal: abortController.signal,
      syntheticMessageId,
      abort: (reason) => abortController.abort(reason),
      finish: () => {
        if (finished) return;
        finished = true;
        unlinkAbortSignal();
        const pending = this.pendingStreamStarts.get(input.workspaceId);
        if (pending?.abortController === abortController) {
          this.pendingStreamStarts.delete(input.workspaceId);
        }
      },
    };
  }

  /**
   * Atomically ensures stream safety by cancelling any existing stream
   * @param workspaceId The workspace to ensure stream safety for
   * @returns A unique stream token for the new stream
   */
  async ensureStreamSafety(workspaceId: WorkspaceId): Promise<StreamToken> {
    const existing = this.workspaceStreams.get(workspaceId);

    if (existing && existing.state !== StreamState.IDLE) {
      await this.cancelStreamSafely(workspaceId, existing, "system", undefined);
    }

    // Generate unique token for this stream (8 hex chars for context efficiency)
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Generate a unique stream token (8 hex characters)
   * Used by callers that need to prepare resources (like tools) before starting the stream
   * Uses 8 hex chars instead of UUID for context efficiency (shorter paths in agent output)
   */
  generateStreamToken(): StreamToken {
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  private async cancelStreamSafely(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // If stream already completed normally (emitted stream-end), wait for its
    // finally block to finish before returning. This happens when ensureStreamSafety
    // is called for a new stream after the previous one finished but before it was
    // removed from workspaceStreams.
    // Without this guard, we'd emit stream-abort after stream-end, causing the
    // frontend to incorrectly flip the message back to partial:true.
    // We must NOT delete workspaceStreams here — the finally block does that.
    // If we delete early, the finally block's delete could race with a new stream
    // being registered and delete the new stream's entry instead.
    if (streamInfo.state === StreamState.COMPLETED) {
      await streamInfo.processingPromise;
      return;
    }

    // Idempotent for concurrent cancellers (a user stop racing the shutdown
    // supervisor's "system" cancel): the latch is checked and assigned here,
    // synchronously, with no suspension before it — an await ahead of this
    // point would let both callers reach cleanupAbortedStream and emit two
    // stream-aborts. Later callers join the first cancel; its abortReason and
    // abandonPartial are the ones delivered.
    if (streamInfo.cancelPromise) {
      return streamInfo.cancelPromise;
    }
    streamInfo.cancelPromise = (async () => {
      streamInfo.state = StreamState.STOPPING;
      try {
        // A failed best-effort flush must not prevent the provider from being stopped.
        await this.deps.flushPartialWrite(workspaceId, streamInfo);
      } catch (error) {
        log.error("Failed to flush partial before cancellation", { error });
      } finally {
        streamInfo.abortController.abort();
        // Unlike checkSoftCancelStream, await cleanup (blocking).
        await this.deps.cleanupAbortedStream(workspaceId, streamInfo, abortReason, abandonPartial);
      }
    })();
    return streamInfo.cancelPromise;
  }

  // Checks if a soft interrupt is necessary, and performs one if so
  // Similar to cancelStreamSafely but performs cleanup without blocking
  async checkSoftCancelStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (!streamInfo.softInterrupt.pending) return;
    try {
      streamInfo.state = StreamState.STOPPING;

      // Flush any pending partial write immediately (preserves work on interruption)
      await this.deps.flushPartialWrite(workspaceId, streamInfo);
    } catch (error) {
      log.error("Failed to flush partial before soft cancellation", { error });
    } finally {
      streamInfo.abortController.abort();

      // Return back to the stream loop so we can wait for it to finish before
      // sending the stream abort event. Not awaited: cleanupAbortedStream waits
      // for processingPromise, i.e. for the loop this runs inside of.
      // Shares cancelStreamSafely's latch: a hard cancel that lands during the
      // flush above already owns the abort bookkeeping (keep its promise), and a
      // hard cancel arriving later joins this one — one stream-abort either way.
      const { abandonPartial, abortReason } = streamInfo.softInterrupt;
      streamInfo.cancelPromise ??= this.deps.cleanupAbortedStream(
        workspaceId,
        streamInfo,
        abortReason,
        abandonPartial
      );
    }
  }

  /**
   * Make the engine scope (`AppFiberScope`) supervise this stream: one fiber
   * per stream that lives exactly as long as the turn is unsettled (it waits on
   * `completionController.promise`) and, when interrupted by the scope closing
   * during shutdown, cancels the stream through the user-stop path
   * (`cancelStreamSafely`, abort reason `"system"`) and waits for the turn to
   * settle — i.e. for the partial to be flushed with usage, `stream-abort`
   * delivered after attempt-owned partial persistence, and `completion` resolved.
   * `closeScopeBounded` awaits that
   * finalizer, so dispose() proceeds to tear down bridges and sessions only once
   * every in-flight stream is durably settled. Supervision starts at
   * registration (before the awaited turn-envelope write), so a STARTING stream
   * is covered too: cancelling it takes the same hard-interrupt path a user stop
   * takes during that write.
   *
   * The fiber is the ownership unit only; the stream's AbortSignal stays the
   * sole cancellation transport (the loop, the AI SDK, soft interrupts and
   * `stopStream` all key off it), so interruption meets the stream at exactly
   * one point — this finalizer. A turn that settles on its own resolves the
   * promise and the fiber exits, which removes its finalizer from the scope
   * (no per-stream residue). A stream started after the scope closed is
   * interrupted synchronously by `forkIn` and thus aborted right away (pinned in
   * appFiberScope.test.ts); the pre-registration window (`pendingStreamStarts`)
   * is not supervised — nothing durable exists for it yet and `stopStream`
   * already aborts pending controllers.
   */
  superviseEngine(workspaceId: WorkspaceId, streamInfo: WorkspaceStreamInfo): void {
    if (this.deps.engineScope === undefined) {
      return;
    }
    assert(streamInfo.engineFiber === undefined, "stream engine already supervised");
    // Zero-arity thunk on purpose: Effect.promise allocates an internal
    // AbortController only when the thunk declares a `signal` parameter; the
    // stream's own controller must stay the only signal in play.
    const supervisor = Effect.promise(() => streamInfo.completionController.promise).pipe(
      Effect.onInterrupt(() =>
        // Finalizers already run uninterruptibly; explicit per house doctrine so
        // the cancel → settle sequence is visibly atomic under a second interrupt.
        Effect.uninterruptible(
          Effect.promise(async () => {
            const startedAt = performance.now();
            await this.cancelStreamSafely(workspaceId, streamInfo, "system");
            // The engine fence includes persistence and raw delivery, never session policy.
            await streamInfo.completionController.promise;
            // Per-stream cost inside the AppFiberScope close (shutdownStep style).
            log.debug("[shutdown] streamManager.abortStream", {
              workspaceId,
              messageId: streamInfo.messageId,
              ms: Math.round(performance.now() - startedAt),
            });
          })
        )
      ),
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.warn("[stream] engine supervisor defect", { workspaceId, error: defect });
        })
      ),
      Effect.asVoid
    );
    // startImmediately: the fiber reaches its (only) suspension point — the
    // promise wait — before forkIn registers it with the scope, so a scope that
    // is already closed interrupts it right here, synchronously.
    streamInfo.engineFiber = this.deps.effectRunner.runSync(
      Effect.forkIn(supervisor, this.deps.engineScope, { startImmediately: true })
    );
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(workspaceId: string, options?: StopStreamOptions): Promise<Result<void>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    // Capture every target before abort callbacks or raw startup delivery can reenter and
    // register a replacement. Never look up a new engine after an asynchronous stop step.
    const pending = this.pendingStreamStarts.get(workspaceId);
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    if (this.isStopOfReplacement(workspaceId, streamInfo, pending, options)) {
      return Ok(undefined);
    }
    const mockLifecycle = this.deps.mockStreamLifecycle();
    const isActuallyStreaming = mockLifecycle
      ? mockLifecycle.isStreaming(workspaceId)
      : this.isStreaming(workspaceId);

    try {
      const [startupDelivery, engineStop, mockStop] = this.startStops(
        typedWorkspaceId,
        { pending, streamInfo, mockLifecycle, isActuallyStreaming },
        options
      );
      const outcomes = await Promise.allSettled([startupDelivery, engineStop, mockStop]);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      return Ok(undefined);
    } catch (error) {
      return Err("Failed to stop stream: " + getErrorMessage(error));
    }
  }

  /** Start every stop for the captured targets; returns [startup delivery, engine, mock]. */
  private startStops(
    workspaceId: WorkspaceId,
    targets: {
      pending: PendingStreamStart | undefined;
      streamInfo: WorkspaceStreamInfo | undefined;
      mockLifecycle: MockStreamLifecycle | undefined;
      isActuallyStreaming: boolean;
    },
    options: StopStreamOptions | undefined
  ): [Promise<void> | undefined, Promise<void> | undefined, Promise<void> | undefined] {
    const { pending, streamInfo, mockLifecycle } = targets;
    // Invoke against the captured mock before pending abort can synchronously start another.
    const mockStop = mockLifecycle?.stop(workspaceId, options);
    const engineStop =
      !mockLifecycle && streamInfo ? this.stopEngine(workspaceId, streamInfo, options) : undefined;
    const startupDelivery = pending
      ? this.abortPendingStart(
          workspaceId,
          pending,
          !targets.isActuallyStreaming && !streamInfo,
          options
        )
      : this.emitMissingStreamAbort(workspaceId, !mockLifecycle && !streamInfo, options);
    return [startupDelivery, engineStop, mockStop];
  }

  /** With nothing to stop, report a bare stream-abort unless the caller opted out. */
  private emitMissingStreamAbort(
    workspaceId: WorkspaceId,
    nothingToStop: boolean,
    options: StopStreamOptions | undefined
  ): Promise<void> | undefined {
    if (!nothingToStop || options?.emitIfMissing === false) return undefined;
    return this.deps.turnEvents.emitStreamAbort(
      workspaceId,
      "",
      {},
      options?.abortReason ?? "startup",
      options?.abandonPartial
    );
  }

  /** A stop whose captured execution is not the workspace's current one must not cancel it. */
  private isStopOfReplacement(
    workspaceId: string,
    streamInfo: WorkspaceStreamInfo | undefined,
    pending: PendingStreamStart | undefined,
    options: StopStreamOptions | undefined
  ): boolean {
    if (options?.expectedMessageId == null) return false;
    const currentMessageId = streamInfo?.messageId ?? pending?.syntheticMessageId;
    if (currentMessageId == null || currentMessageId === options.expectedMessageId) return false;
    log.debug("stopStream: skipping stop of a replacement execution", {
      workspaceId,
      expectedMessageId: options.expectedMessageId,
      currentMessageId,
    });
    return true;
  }

  /** A soft stop latches the interrupt for the next boundary; a hard stop cancels now. */
  private stopEngine(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options: StopStreamOptions | undefined
  ): Promise<void> | undefined {
    const abortReason = options?.abortReason ?? "system";
    if (options?.soft) {
      streamInfo.softInterrupt = {
        pending: true,
        abandonPartial: options.abandonPartial ?? false,
        abortReason,
      };
      return undefined;
    }
    return this.cancelStreamSafely(workspaceId, streamInfo, abortReason, options?.abandonPartial);
  }

  /**
   * Abort a start that has not registered a stream. The first stop that finds no
   * stream delivers its stream-abort; later stops join that delivery.
   */
  private abortPendingStart(
    workspaceId: WorkspaceId,
    pending: PendingStreamStart,
    mayDeliverAbort: boolean,
    options: StopStreamOptions | undefined
  ): Promise<void> | undefined {
    if (mayDeliverAbort && !pending.abortDelivery) {
      const delivery = Promise.withResolvers<void>();
      pending.abortDelivery = delivery.promise;
      pending.abortController.abort(options?.abortReason ?? "startup");
      this.deps.turnEvents
        .emitStreamAbort(
          workspaceId,
          pending.syntheticMessageId,
          // Duration from the wall-clock pending.startTime.
          { duration: nodeClock.nowMs() - pending.startTime },
          this.getStartupAbortReason(pending.abortController.signal),
          options?.abandonPartial,
          pending.acpPromptId
        )
        .then(delivery.resolve, delivery.reject);
    } else {
      pending.abortController.abort(options?.abortReason ?? "startup");
    }
    return pending.abortDelivery;
  }

  /**
   * Gets the current stream state for a workspace
   */
  getStreamState(workspaceId: string): StreamState {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    return streamInfo?.state ?? StreamState.IDLE;
  }

  /**
   * Checks if a workspace currently has an active stream
   */
  isStreaming(workspaceId: string): boolean {
    const mockLifecycle = this.deps.mockStreamLifecycle();
    if (mockLifecycle) {
      return mockLifecycle.isStreaming(workspaceId);
    }
    const state = this.getStreamState(workspaceId);
    return state === StreamState.STARTING || state === StreamState.STREAMING;
  }

  /**
   * Gets all active workspace streams (for debugging/monitoring)
   */
  getActiveStreams(): string[] {
    return Array.from(this.workspaceStreams.keys()).map((id) => id as string);
  }

  /** Serialize idle recovery with stream startup, including terminal persistence. */
  async acquireStreamStartLock(workspaceId: string) {
    const id = workspaceId as WorkspaceId;
    let mutex = this.streamLocks.get(id);
    if (mutex == null) {
      mutex = new AsyncMutex();
      this.streamLocks.set(id, mutex);
    }
    return mutex.acquire();
  }

  /**
   * Gets the current stream info for a workspace if actively streaming.
   * Include finalizing streams when checking whether recovery can proceed.
   */
  getStreamInfo(workspaceId: string, includeFinalizing = false): ActiveStreamInfo | undefined {
    const mockLifecycle = this.deps.mockStreamLifecycle();
    if (mockLifecycle) {
      return mockLifecycle.getStreamInfo(workspaceId, includeFinalizing);
    }
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only return info if stream is actively running
    if (
      streamInfo &&
      (includeFinalizing ||
        streamInfo.state === StreamState.STARTING ||
        streamInfo.state === StreamState.STREAMING)
    ) {
      const {
        systemMessageTokens,
        anthropicThinkingReplay,
        anthropicThinkingReplayFromStep,
        muxMetadata,
      } = streamInfo.initialMetadata ?? {};
      return {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        historySequence: streamInfo.historySequence,
        startTime: streamInfo.startTime,
        toolCompletionTimestamps: streamInfo.toolCompletionTimestamps ?? new Map(),
        parts: streamInfo.parts,
        currentStepStartIndex: streamInfo.currentStepStartIndex,
        stepStartIndices: streamInfo.stepStartIndices.slice(),
        // Continuous compaction reads the running turn's receipt from here (#5996).
        initialMetadata: {
          systemMessageTokens,
          anthropicThinkingReplay,
          anthropicThinkingReplayFromStep,
        },
        // Correlation metadata for delegated work (e.g. workspace-turn
        // continuations); lets TaskService match a live continuation stream
        // to its still-open workspace-turn handle.
        muxMetadata,
      };
    }

    return undefined;
  }
}
