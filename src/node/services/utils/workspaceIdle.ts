import assert from "node:assert/strict";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";

type IdleHost = Pick<
  WorkspaceHost,
  "waitForIdleAndNoQueuedMessages" | "onWorkspaceTurnSettled" | "onQueuedMessageChanged"
>;

/**
 * Wait until `workspaceId` has no active, preparing or queued turn (per `isBusy`), or until
 * `signal` aborts. Shared by task_await workspace_ids and the redirected-turn follower.
 *
 * The session's own idle wait (waitForIdleAndNoQueuedMessages) covers every idle transition,
 * including abandoned auto-retries. It returns at once when no session exists, so `isBusy` is
 * rechecked; while still busy, the next turn-settled or queue-changed event re-runs the wait.
 * Events are counted from a subscription taken before the first check, so a transition between
 * a check and the wait is never missed.
 *
 * `waitForNextTurn` first waits for a turn to settle in the workspace, e.g. to retry a failed
 * read only after the workspace has done more work.
 */
export async function waitForWorkspaceIdle(params: {
  host: IdleHost;
  workspaceId: string;
  isBusy: () => boolean;
  signal: AbortSignal;
  waitForNextTurn?: boolean;
}): Promise<"idle" | "aborted"> {
  assert(params.workspaceId.length > 0, "waitForWorkspaceIdle requires workspaceId");
  let settledCount = 0;
  let eventCount = 0;
  let wake: (() => void) | null = null;
  const onSettled = (workspaceId: string) => {
    if (workspaceId !== params.workspaceId) return;
    settledCount++;
    eventCount++;
    wake?.();
  };
  const onQueue = (workspaceId: string) => {
    if (workspaceId !== params.workspaceId) return;
    eventCount++;
    wake?.();
  };
  const onAbort = () => wake?.();
  const disposers = [
    params.host.onWorkspaceTurnSettled(onSettled),
    params.host.onQueuedMessageChanged(onQueue),
  ];
  params.signal.addEventListener("abort", onAbort);
  // Resolves once `done()` holds, re-checking after every event or abort.
  const until = async (done: () => boolean) => {
    while (!done() && !params.signal.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (done() || params.signal.aborted) resolve();
      });
      wake = null;
    }
  };
  try {
    if (params.waitForNextTurn === true) {
      await until(() => settledCount > 0);
    }
    for (;;) {
      if (params.signal.aborted) return "aborted";
      const eventsBefore = eventCount;
      const session = { idle: false };
      void params.host
        // The signal releases the session's listeners when this wait stops early.
        .waitForIdleAndNoQueuedMessages(params.workspaceId, params.signal)
        // A closing session (or the abort) also ends this wait; the checks below decide.
        .catch(() => undefined)
        .then(() => {
          session.idle = true;
          wake?.();
        });
      await until(() => session.idle || eventCount !== eventsBefore);
      if (params.signal.aborted) return "aborted";
      if (!params.isBusy()) return "idle";
      // Still busy (no session yet, or a successor already started): wait for the next event,
      // or for this session wait if an event woke us first. Work can end through the session
      // alone (an abandoned auto-retry), so its resolution must still wake us. A session wait
      // that already resolved is not waited on again, so a workspace without a session does
      // not spin.
      const busyAt = eventCount;
      const sessionPending = !session.idle;
      await until(() => eventCount !== busyAt || (sessionPending && session.idle));
    }
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    for (const dispose of disposers) dispose();
  }
}
