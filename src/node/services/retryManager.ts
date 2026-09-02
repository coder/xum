import { Duration, Effect, Fiber } from "effect";
import assert from "@/common/utils/assert";
import {
  calculateBackoffDelay,
  createFailedRetryState,
  createFreshRetryState,
  type RetryState,
} from "@/common/utils/messages/retryState";
import {
  isNonRetryableSendError,
  isNonRetryableStreamError,
} from "@/common/utils/messages/retryEligibility";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";

export interface RetryFailureError {
  type: string;
  message?: string;
}

// Status events emitted during auto-retry lifecycle
export interface AutoRetryScheduledEvent {
  type: "auto-retry-scheduled";
  attempt: number;
  delayMs: number;
  scheduledAt: number;
}
export interface AutoRetryStartingEvent {
  type: "auto-retry-starting";
  attempt: number;
}
export interface AutoRetryAbandonedEvent {
  type: "auto-retry-abandoned";
  reason: string;
}
export type RetryStatusEvent =
  | AutoRetryScheduledEvent
  | AutoRetryStartingEvent
  | AutoRetryAbandonedEvent;

export class RetryManager {
  private state: RetryState<RetryFailureError>;
  /**
   * The forked retry fiber: sleeps for the backoff delay (Effect's clock
   * registers a plain `setTimeout` under the hood), then emits
   * `auto-retry-starting` and runs the onRetry callback. Fiber interruption
   * replaces hand-rolled `clearTimeout` bookkeeping: interrupting a sleeping
   * fiber cancels its timer, and interrupting a fiber awaiting onRetry
   * discards the (now stale) settlement so late rejections cannot emit events.
   */
  private retryFiber: Fiber.Fiber<void> | null = null;
  /** True only while the backoff sleep is pending (scheduled, not yet fired). */
  private retryPending = false;
  private enabled = true;
  /**
   * Guard for re-entrant synchronous cancellation: a status callback may call
   * cancel()/setEnabled(false) while the retry fiber is executing
   * synchronously, and fiber interruption only lands at the next yield point.
   * The fiber therefore re-checks its generation after every callback it
   * invokes, mirroring interruption for purely synchronous re-entrancy.
   */
  private retryGeneration = 0;
  private pendingScheduledEvent: AutoRetryScheduledEvent | null = null;

  constructor(
    private readonly workspaceId: string,
    private readonly onRetry: () => Promise<void>,
    private readonly onStatusChange: (event: RetryStatusEvent) => void,
    /**
     * Runs the retry fiber fork and its interrupt. The global runtime by
     * default (direct construction in tests); AgentSession passes its stream
     * manager's runner, so the backoff sleep shares the stream's `Clock` — the
     * app runtime's in production, a `TestClock` in tests.
     */
    private readonly runner: EffectRunner = defaultEffectRunner
  ) {
    assert(this.workspaceId.trim().length > 0, "RetryManager: workspaceId must be non-empty");
    assert(typeof this.onRetry === "function", "RetryManager: onRetry must be a function");
    assert(
      typeof this.onStatusChange === "function",
      "RetryManager: onStatusChange must be a function"
    );

    this.state = createFreshRetryState<RetryFailureError>();
  }

  handleStreamFailure(error: RetryFailureError): void {
    assert(
      typeof error.type === "string" && error.type.length > 0,
      "RetryManager: error.type required"
    );

    if (!this.enabled) {
      return;
    }

    // Check non-retryable errors using extracted common utils.
    // Cancel any pending retry first — a retryable error may have scheduled
    // a timer, but a later non-retryable error supersedes it.
    if (isNonRetryableSendError(error) || isNonRetryableStreamError(error)) {
      this.interruptRetryFiber();
      this.pendingScheduledEvent = null;
      this.retryGeneration += 1;
      this.onStatusChange({ type: "auto-retry-abandoned", reason: error.type });
      return;
    }

    // If a retry is already pending, cancel it and reschedule with updated backoff.
    // This can happen when multiple error events arrive before the timer fires.
    this.interruptRetryFiber();

    this.state = createFailedRetryState(this.state.attempt, error);
    const delay = calculateBackoffDelay(this.state.attempt);
    this.retryGeneration += 1;
    const scheduledGeneration = this.retryGeneration;

    const scheduledEvent: AutoRetryScheduledEvent = {
      type: "auto-retry-scheduled",
      attempt: this.state.attempt,
      delayMs: delay,
      scheduledAt: Date.now(),
    };
    this.pendingScheduledEvent = scheduledEvent;
    this.onStatusChange(scheduledEvent);

    this.scheduleRetry(delay, scheduledGeneration);
  }

  /**
   * Fork the retry fiber. `runner.runFork` executes synchronously up to the
   * sleep, so the backoff timer is registered before this method returns —
   * the same observable ordering as the previous `setTimeout` call.
   *
   * The backoff policy itself stays the hand-rolled pure
   * `calculateBackoffDelay`: attempts are driven by external stream events
   * (not by retrying an effect), so an Effect `Schedule` would only re-encode
   * the same shared one-liner behind effectful stepping machinery.
   */
  private scheduleRetry(delayMs: number, scheduledGeneration: number): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Effect.gen generator bodies do not inherit `this`
    const self = this;
    this.retryPending = true;
    this.retryFiber = this.runner.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(delayMs));
        self.retryPending = false;
        self.pendingScheduledEvent = null;

        // Guard against stale wake-ups or stop requests that race with fiber
        // resumption (e.g. a cancel() issued re-entrantly while the scheduled
        // event was still being emitted, before this fiber was forked).
        if (!self.enabled || scheduledGeneration !== self.retryGeneration) {
          return;
        }

        self.onStatusChange({ type: "auto-retry-starting", attempt: self.state.attempt });

        // Re-check after status emission so a synchronous stop handler can cancel
        // before we attempt to resume the stream.
        if (!self.enabled || scheduledGeneration !== self.retryGeneration) {
          return;
        }

        yield* Effect.tryPromise({
          try: () => self.onRetry(),
          catch: (retryError) => retryError,
        }).pipe(
          Effect.catch((retryError) =>
            Effect.sync(() => {
              // Ignore stale retry callbacks from superseded/disabled generations.
              // Interruption already discards most stale settlements; this guard
              // covers synchronous re-entrancy that raced the interrupt.
              if (!self.enabled || scheduledGeneration !== self.retryGeneration) {
                return;
              }

              const reason =
                retryError instanceof Error && retryError.message.length > 0
                  ? retryError.message
                  : "retry_callback_failed";
              self.onStatusChange({ type: "auto-retry-abandoned", reason });
            })
          )
        );
      })
    );
  }

  handleStreamSuccess(): void {
    // Cancel any stale retry timer (e.g., if a manual retry succeeded
    // before the scheduled timer fired) and reset state.
    this.cancel();
  }

  /**
   * Interrupt any in-flight retry fiber without resetting state. Interruption
   * of a sleeping fiber clears its backoff timer synchronously; a fiber
   * already awaiting onRetry is discarded at settlement.
   */
  private interruptRetryFiber(): void {
    if (this.retryFiber !== null) {
      const fiber = this.retryFiber;
      this.retryFiber = null;
      this.retryPending = false;
      // Fire-and-forget: the interrupt signal lands synchronously; awaiting
      // full fiber exit is unnecessary (and impossible from sync callers).
      this.runner.runFork(Fiber.interrupt(fiber));
    }
  }

  cancel(): void {
    this.interruptRetryFiber();
    this.pendingScheduledEvent = null;
    this.retryGeneration += 1;
    this.state = createFreshRetryState<RetryFailureError>();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      // Cancel any pending/in-flight retry and notify the frontend so the UI
      // clears the retry status (e.g., "Retrying…" or countdown).
      // Check state.attempt rather than isRetryPending because the timer may
      // have already fired (retryTimer is null) while the onRetry callback is
      // still executing — the UI would otherwise remain stuck in retry state.
      const hadActiveRetry = this.isRetryPending || this.state.attempt > 0;
      this.cancel();
      if (hadActiveRetry) {
        this.onStatusChange({ type: "auto-retry-abandoned", reason: "disabled_by_user" });
      }
    }
  }

  get isRetryPending(): boolean {
    return this.retryPending;
  }

  getScheduledStatusSnapshot(): AutoRetryScheduledEvent | null {
    if (!this.pendingScheduledEvent) {
      return null;
    }

    // Return a copy so callers cannot mutate internal retry state.
    return { ...this.pendingScheduledEvent };
  }

  dispose(): void {
    this.cancel();
  }
}
