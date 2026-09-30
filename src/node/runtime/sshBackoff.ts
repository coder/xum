/**
 * Shared SSH retry policy for transports that maintain their own connection pools.
 * Keeping the constants in one place prevents OpenSSH and ssh2 reliability from drifting.
 */
export const SSH_BACKOFF_SCHEDULE_SECONDS = [1, 2, 4, 7, 10] as const;

export const DEFAULT_SSH_MAX_WAIT_MS = 2 * 60 * 1000;

export interface BaseSshAcquireConnectionOptions {
  /** Timeout for the connection health check or connect attempt. */
  timeoutMs?: number;

  /**
   * Max time to wait (ms) for a host to become healthy.
   *
   * - Omit to use the default (waits through backoff).
   * - Set to 0 to fail fast.
   */
  maxWaitMs?: number;

  /** Optional abort signal to cancel any waiting. */
  abortSignal?: AbortSignal;

  /** Called when acquireConnection is waiting due to backoff. */
  onWait?: (waitMs: number) => void;
}

/** Add ±20% jitter to prevent thundering herd when multiple clients recover simultaneously. */
export function withSshBackoffJitter(seconds: number): number {
  const jitterFactor = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
  return seconds * jitterFactor;
}
