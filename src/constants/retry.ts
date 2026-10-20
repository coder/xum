/**
 * Consecutive failures of the unrecognized-provider-error class ("api") with the same text after
 * which auto-retry stops (#4228): such an error is deterministic, and every retry resends the
 * same failing request. Transient classes (5xx, rate limits, network) retry without a bound,
 * because an outage repeats the same text too. With the auto-retry backoff this is about
 * 7 minutes.
 */
export const MAX_IDENTICAL_API_ERROR_FAILURES = 10;
