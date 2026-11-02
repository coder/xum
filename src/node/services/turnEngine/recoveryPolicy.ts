/**
 * Recovery policy for one turn-engine attempt.
 *
 * StreamManager.processStreamWithCleanup runs a turn as a loop of attempts. After
 * each attempt it must choose what comes next: finish, fail, swap models after a
 * refusal, or retry with a changed request. This module owns that choice as a
 * pure function, so every precedence rule is testable without a live stream. The
 * caller gathers the facts (AttemptOutcome, AttemptHistory) and runs the side
 * effects for the returned Decision; nothing here does I/O or reads a clock.
 */

/**
 * Empty-output completions get this many silent retries per turn before the
 * turn fails with EmptyStreamOutputError.
 */
export const MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS = 1;

/** Facts about one attempt, read from the stream state after it settled. */
export type AttemptOutcome =
  | {
      /** The provider stream closed without throwing. */
      _tag: "Finished";
      /** The abort signal fired; the canceller owns the terminal bookkeeping. */
      aborted: boolean;
      /** A soft interrupt is pending; never start a silent retry. */
      interruptPending: boolean;
      partCount: number;
      /** The SDK emitted its terminal finish event. */
      terminal: boolean;
      /** Refusal finish reason from the terminal event, or null. */
      refusal: string | null;
    }
  | {
      /** The provider stream (or its iterator) threw. */
      _tag: "Errored";
      aborted: boolean;
      interruptPending: boolean;
      /**
       * The error is a lost previousResponseId that a retry without it can
       * repair at this point of the stream (see planPreviousResponseIdRetry).
       */
      previousResponseIdRetryable: boolean;
      /**
       * The error rejects replayed reasoning that a retry without it can repair
       * at this point of the stream (see planReasoningReplayRetry).
       */
      reasoningReplayRetryable: boolean;
    };

/** Recovery already spent in this turn. */
export interface AttemptHistory {
  emptyRetries: number;
  retriedPreviousResponseId: boolean;
  retriedReasoningReplay: boolean;
}

export type RetryChange = "empty" | "dropPreviousResponseId" | "dropReasoningReplay";

export type Decision =
  | { _tag: "Complete" }
  /** The stream ended without a terminal event after visible output. */
  | { _tag: "Truncated" }
  /** The stream ended with no output and no retry is left. */
  | { _tag: "Empty" }
  | { _tag: "Retry"; change: RetryChange }
  /**
   * The model refused. The caller tries the configured fallback chain. If no
   * swap happens, the caller fails the turn as a refusal. The policy does not
   * pick the fallback model.
   */
  | { _tag: "Fallback"; refusal: string }
  | { _tag: "Fail" }
  /** The abort signal fired; the caller stops without terminal bookkeeping. */
  | { _tag: "Aborted" };

type Finished = Extract<AttemptOutcome, { _tag: "Finished" }>;
type Errored = Extract<AttemptOutcome, { _tag: "Errored" }>;

export function recoveryPolicy(outcome: AttemptOutcome, history: AttemptHistory): Decision {
  if (outcome.aborted) {
    return { _tag: "Aborted" };
  }
  return outcome._tag === "Errored"
    ? decideErrored(outcome, history)
    : decideFinished(outcome, history);
}

function decideErrored(outcome: Errored, history: AttemptHistory): Decision {
  // Retries are silent; a pending soft interrupt means the user wants the
  // turn to stop, so the error must surface instead.
  if (outcome.interruptPending) {
    return { _tag: "Fail" };
  }
  // previousResponseId recovery is tried before reasoning-replay recovery.
  // Each repair runs at most once per turn.
  if (outcome.previousResponseIdRetryable && !history.retriedPreviousResponseId) {
    return { _tag: "Retry", change: "dropPreviousResponseId" };
  }
  if (outcome.reasoningReplayRetryable && !history.retriedReasoningReplay) {
    return { _tag: "Retry", change: "dropReasoningReplay" };
  }
  return { _tag: "Fail" };
}

function decideFinished(outcome: Finished, history: AttemptHistory): Decision {
  // A refusal is a deliberate provider outcome, not a transport drop, so it
  // wins over the empty-output and truncation checks.
  if (outcome.refusal !== null) {
    return { _tag: "Fallback", refusal: outcome.refusal };
  }

  if (outcome.partCount === 0) {
    if (history.emptyRetries < MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS && !outcome.interruptPending) {
      return { _tag: "Retry", change: "empty" };
    }
    return { _tag: "Empty" };
  }

  if (!outcome.terminal) {
    return { _tag: "Truncated" };
  }

  return { _tag: "Complete" };
}
