import assert from "@/common/utils/assert";

/**
 * The stream `xum run` is waiting on: the turn it sent itself, or the goal driver's
 * continuation. The session's own stream-end hook can dispatch a goal continuation
 * before the driver arms its wait, so a stream that starts while nothing is awaited
 * gets a wait armed on the spot, and the driver's next prepareForContinuation reuses
 * it instead of missing that stream's start (#5509 review).
 */
export class CliStreamWaits {
  private completion: Promise<void> = Promise.resolve();
  private started: Promise<void> = Promise.resolve();
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((error: Error) => void) | null = null;
  private resolveStarted: (() => void) | null = null;
  private ended = false;
  private unrequestedArmed = false;

  /** Arms a wait for the next stream. */
  arm(): void {
    this.ended = false;
    this.unrequestedArmed = false;
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // An automatic turn can fail while no driver awaits it (the run is finishing);
    // that must not surface as an unhandled rejection. Awaiters still see the error.
    this.completion.catch(() => undefined);
  }

  /** Goal driver: arms for its continuation, or reuses a wait an automatic turn armed first. */
  prepareForContinuation(): void {
    if (this.unrequestedArmed) {
      this.unrequestedArmed = false;
      return;
    }
    this.arm();
  }

  onStreamStart(): void {
    if (this.resolveCompletion == null) {
      this.arm();
      this.unrequestedArmed = true;
    }
    this.resolveStarted?.();
  }

  onStreamEnd(): void {
    this.ended = true;
    this.resolveCompletion?.();
    this.resetHandlers();
  }

  onStreamFailed(error: Error): void {
    this.rejectCompletion?.(error);
    this.resetHandlers();
  }

  async waitForCompletion(): Promise<void> {
    await this.completion;
    if (!this.ended) {
      throw new Error("Stream completion promise resolved unexpectedly without stream end");
    }
  }

  async waitForStreamStarted(timeoutMs?: number): Promise<void> {
    assert(timeoutMs == null || timeoutMs > 0, "stream-start timeout must be positive");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const streamFailedOrEndedBeforeStart = this.completion.then(() => {
      throw new Error("Goal continuation stream ended before it started");
    });
    const waits: Array<Promise<void>> = [this.started, streamFailedOrEndedBeforeStart];
    if (timeoutMs != null) {
      waits.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Timed out waiting for goal continuation stream to start"));
          }, timeoutMs);
          timer.unref?.();
        })
      );
    }
    try {
      await Promise.race(waits);
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  }

  private resetHandlers(): void {
    this.resolveCompletion = null;
    this.rejectCompletion = null;
    this.resolveStarted = null;
  }
}
