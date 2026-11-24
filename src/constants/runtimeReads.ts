/**
 * Exec timeout for the one retry of a remote read or stat (#4830). It must stay
 * short: the SSH pools wait through their backoff up to the exec deadline, so
 * reusing readFile's 300 s would hang a persistent outage for minutes instead
 * of failing fast and retryably.
 */
export const READ_RETRY_TIMEOUT_SECS = 10;
