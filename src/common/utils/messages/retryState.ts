import assert from "@/common/utils/assert";
import type { SendMessageError } from "@/common/types/errors";

export interface RetryState<TError = SendMessageError> {
  attempt: number;
  retryStartTime: number;
  lastError?: TError;
}

const INITIAL_DELAY = 1000; // 1 second
const MAX_DELAY = 60000; // 60 seconds

/**
 * Utility functions for managing retry state.
 *
 * These functions encapsulate retry state transitions to prevent bugs
 * like bypassing exponential backoff.
 */

/**
 * Calculate exponential backoff delay with capped maximum.
 *
 * Formula: min(INITIAL_DELAY * 2^attempt, MAX_DELAY)
 * Examples: 1s → 2s → 4s → 8s → 16s → 32s → 60s (capped)
 */
export function calculateBackoffDelay(attempt: number): number {
  assert(Number.isInteger(attempt) && attempt >= 0, "calculateBackoffDelay: attempt must be >= 0");

  const exponentialDelay = INITIAL_DELAY * 2 ** attempt;
  return Math.min(exponentialDelay, MAX_DELAY);
}

/**
 * Upper bound for honoring a provider's Retry-After. Per-minute rate limits ask for seconds to a
 * minute. A Retry-After of many minutes or hours usually marks a quota window: a countdown that
 * long would look like a hang, and the user is better served by retrying (or stopping) on their
 * own. Past the bound Xum retries anyway, reads the provider's fresh Retry-After from that
 * response, and waits again, so a long window costs one request per bound.
 */
export const MAX_RETRY_AFTER_DELAY_MS = 5 * 60_000;

/**
 * Delay before auto-retry attempt `attempt`: the exponential backoff, or the provider's
 * Retry-After when that is longer (bounded by MAX_RETRY_AFTER_DELAY_MS). Never shorter than the
 * backoff, so a provider asking for 0 s cannot make Xum hammer it.
 */
export function calculateRetryDelay(attempt: number, retryAfterMs?: number): number {
  const backoff = calculateBackoffDelay(attempt);
  if (retryAfterMs == null) return backoff;
  assert(
    Number.isFinite(retryAfterMs) && retryAfterMs >= 0,
    "calculateRetryDelay: retryAfterMs must be a finite non-negative number"
  );
  return Math.max(backoff, Math.min(retryAfterMs, MAX_RETRY_AFTER_DELAY_MS));
}

/**
 * Create a fresh retry state (for new stream starts).
 *
 * Use this when a stream starts successfully - resets backoff completely.
 */
export function createFreshRetryState<TError = SendMessageError>(): RetryState<TError> {
  return {
    attempt: 0,
    retryStartTime: Date.now(),
  };
}

/**
 * Create retry state after a failed attempt.
 *
 * Increments attempt counter and records the error for display.
 *
 * @param previousAttempt - Previous attempt count
 * @param error - Error that caused the failure
 */
export function createFailedRetryState<TError>(
  previousAttempt: number,
  error: TError
): RetryState<TError> {
  assert(
    Number.isInteger(previousAttempt) && previousAttempt >= 0,
    "createFailedRetryState: previousAttempt must be >= 0"
  );

  return {
    attempt: previousAttempt + 1,
    retryStartTime: Date.now(),
    lastError: error,
  };
}
