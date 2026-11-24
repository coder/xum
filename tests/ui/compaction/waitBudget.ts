// Jest does not stop a test body when its timeout fires. It starts the next test while the body
// keeps waiting, and the body's `finally` then disposes the shared DOM under that next test: a
// timed-out "auto-compacts after context_exceeded" turned the next test into an unrelated
// "Workspace still in setup" failure. So every long wait in a test draws on one budget that
// starts with the test and ends before the test's limit. The failure is then the body's own
// assertion, and its `finally` finishes inside the test.

/** How long before its limit a test's waits must end, so that its `finally` has room to run. */
const CLEANUP_MARGIN_MS = 15_000;

/**
 * Starts the wait budget of a test whose limit is `testLimitMs` (call it first in the test, so the
 * harness setup counts) and returns what is left of it: at least 1 ms, so a spent budget still
 * gives its wait a timeout that fails at once.
 */
export function startWaitBudget(testLimitMs: number, now: () => number = Date.now): () => number {
  const deadline = now() + testLimitMs - CLEANUP_MARGIN_MS;
  return () => Math.max(deadline - now(), 1);
}
