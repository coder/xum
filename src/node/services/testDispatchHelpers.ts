import { IdleDispatcher } from "./idleDispatcher";
import type { WorkspaceGoalService } from "./workspaceGoalService";

/**
 * Shared test helpers for dispatch / event-loop coordination across the
 * goal-service, idle-dispatcher, and workspace-service test files.
 *
 * Coder-agents-review P3 DEREM-41: prior to extraction, an identical
 * `drainPendingDispatches()` definition lived in three test files
 * (`workspaceGoalService.test.ts`, `idleDispatcher.test.ts`,
 * `workspaceService.test.ts`). Centralising it here keeps the helper in one
 * place so a future fourth caller does not introduce a fourth copy.
 *
 * NOT exported as `index.ts` to keep import paths explicit.
 */

/**
 * Drain pending microtasks/timer callbacks. Used as a deterministic-ish
 * barrier when asserting "nothing else happens" — we cannot prove the absence
 * of an event without giving any racing dispatchers a chance to fire. Encoded
 * as a named helper instead of inline `setTimeout` so the intent is explicit
 * (per AGENTS.md "Avoid timing-based coordination when deterministic signals
 * exist"; this is the case where one does not).
 */
export async function drainPendingDispatches(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/**
 * Poll `condition` until it returns truthy, throwing if it never does within
 * `timeoutMs`. Used in dispatch tests where the production path emits work
 * via microtasks + timers and the test needs a deterministic "wait for X"
 * barrier without coupling to internal scheduler details.
 *
 * Coder-agents-review nit DEREM-48: previously duplicated byte-for-byte in
 * `workspaceGoalService.test.ts` and `idleDispatcher.test.ts`.
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

/**
 * Register a no-op continuation consumer on a test `WorkspaceGoalService`
 * instance so paths that require an active continuation bridge (e.g. the
 * idle dispatcher / kickoff send-options lookup) can run end-to-end. Used by
 * goal-service, agent-session, and task-service tests that need to exercise
 * production-like behavior without standing up the full ServiceContainer.
 *
 * Previously this helper also flipped the (now-removed) GOALS experiment
 * flag; goals are GA, so the bridge registration alone is sufficient.
 */
export function registerNoopContinuationBridgeForTest(
  service: WorkspaceGoalService,
  dispatcher: IdleDispatcher = new IdleDispatcher()
): () => void {
  return service.registerGoalContinuationConsumer(dispatcher, {
    hasActiveDescendantTasks: () => false,
    getRuntimeState: () => ({ isRuntimeCompatible: true }),
    executeGoalContinuation: () => Promise.resolve(true),
  });
}
