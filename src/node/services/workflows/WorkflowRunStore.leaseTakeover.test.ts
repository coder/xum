/* eslint-disable @typescript-eslint/await-thenable */
/**
 * coder/xum #4452 gap 1: a runner stalled inside its owner-check-then-write section must keep its
 * locks, so no other backend can take the run and write before the stalled write lands.
 *
 * Two WorkflowRunStore instances on one session dir stand in for two backends sharing a Xum root.
 * A pauses INSIDE its owner-checked section (after withExpectedLeaseOwner read the lease, before
 * the journal write) while holding the events and lease locks. Store instances in one process
 * share the in-process queue in front of crossProcessLock, so the cross-process path is exercised
 * separately: a direct acquireCrossProcessLock on the store's lock paths stands in for another
 * process (this process's live record reads as live to it, exactly as to a sibling process).
 * Lease staleness is driven through the explicit `nowMs` arguments. No real waits.
 *
 * Before the fix, the mkdir locks were reclaimed once their mtime aged past max(1s,
 * staleLeaseMs) and every finally removed them unconditionally: B took the run while A was
 * stalled, A's late write landed after B's, and A's finally deleted B's locks.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  acquireCrossProcessLock,
  CrossProcessLockTimeoutError,
} from "@/node/utils/main/crossProcessLock";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { pauseNextOwnerCheckedWrite } from "./workflowRunStore.testHarness";

const RUN_ID = "wfr_4452_gap1";
const STALE_LEASE_MS = 50;
// Production-shaped unique owner IDs (WorkflowService.generateWorkflowRunnerOwnerId shape).
const OWNER_A = `workflow-runner:workspace-1:${RUN_ID}:aaaaaaaaaaaaaaaa`;
const OWNER_B = `workflow-runner:workspace-1:${RUN_ID}:bbbbbbbbbbbbbbbb`;
const LEASE_ACQUIRED_AT_MS = 1_000;
const AFTER_LEASE_STALE_MS = LEASE_ACQUIRED_AT_MS + STALE_LEASE_MS + 1;

const definition = {
  name: "deep-research",
  description: "Research a topic",
  scope: "built-in" as const,
  executable: true,
};

/** Two stores on the same session dir: two backends sharing one Xum root. */
async function createBackends(sessionDir: string) {
  const storeA = new WorkflowRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
  const storeB = new WorkflowRunStore({ sessionDir, staleLeaseMs: STALE_LEASE_MS });
  await storeA.createRun({
    id: RUN_ID,
    workspaceId: "workspace-1",
    workflow: definition,
    source: "export default async function workflow() { return 'ok'; }\n",
    args: {},
    now: "2026-05-29T00:00:00.000Z",
  });
  const runDir = path.join(sessionDir, "workflows", RUN_ID);
  return {
    storeA,
    storeB,
    eventsLock: path.join(runDir, "events.jsonl.xlock"),
    leaseLock: path.join(runDir, "lease.json.xlock"),
  };
}

/**
 * Another process trying the lock once: true when it would have got it. A granted probe releases
 * at once.
 */
async function crossProcessContenderGetsLock(lockPath: string): Promise<boolean> {
  try {
    const release = await acquireCrossProcessLock({
      lockPath,
      acquireTimeoutMs: 0,
      staleMs: 1_000,
      timeoutMessage: "held",
    });
    await release();
    return true;
  } catch (error) {
    if (error instanceof CrossProcessLockTimeoutError) {
      return false;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function settle(promise: Promise<unknown>): Promise<"resolved" | "rejected"> {
  try {
    await promise;
    return "resolved";
  } catch {
    return "rejected";
  }
}

function logMessages(run: WorkflowRunRecord): string[] {
  return run.events.flatMap((event) => (event.type === "log" ? [event.message] : []));
}

function logEvent(message: string) {
  return { type: "log" as const, at: "2026-05-29T00:00:02.000Z", message };
}

describe("WorkflowRunStore lease takeover under a stalled lock holder (#4452 gap 1)", () => {
  test("control: without a takeover the paused holder's write lands and its locks are removed", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-control");
    const { storeA, eventsLock, leaseLock } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseNextOwnerCheckedWrite(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;
    // A holds both locks while inside the owner-checked section.
    expect(await pathExists(eventsLock)).toBe(true);
    expect(await pathExists(leaseLock)).toBe(true);
    pause.release();
    await writeA;

    expect(logMessages(await storeA.getRun(RUN_ID))).toEqual(["A write"]);
    expect(await pathExists(eventsLock)).toBe(false);
    expect(await pathExists(leaseLock)).toBe(false);
  });

  test("a stalled holder keeps its locks however old they look: neither another store nor another process can take them", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-stalled-holder");
    const { storeA, storeB, eventsLock, leaseLock } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseNextOwnerCheckedWrite(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;
    // The pre-fix trigger: lock files older than the reclaim window. Age is no longer evidence.
    const longAgo = (Date.now() - 60_000) / 1_000;
    await fs.utimes(eventsLock, longAgo, longAgo);
    await fs.utimes(leaseLock, longAgo, longAgo);

    // The lease itself is stale by B's clock, but A is alive inside its critical section.
    const takeover = {
      storeBAcquiresLease: await storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS),
      otherProcessGetsEventsLock: await crossProcessContenderGetsLock(eventsLock),
      otherProcessGetsLeaseLock: await crossProcessContenderGetsLock(leaseLock),
    };
    pause.release();
    await writeA;

    expect(takeover).toEqual({
      storeBAcquiresLease: false,
      otherProcessGetsEventsLock: false,
      otherProcessGetsLeaseLock: false,
    });
    expect(logMessages(await storeA.getRun(RUN_ID))).toEqual(["A write"]);
  });

  test("after the stalled holder finishes, B takes over and A's later write is rejected", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-late-write");
    const { storeA, storeB, eventsLock, leaseLock } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseNextOwnerCheckedWrite(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;
    const bAcquiresWhileAHolds = await storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS);
    pause.release();
    await writeA;

    // A left its critical section; its lease is stale by B's clock, so B takes over.
    await expect(storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS)).resolves.toBe(true);
    await storeB.appendNextEvent(RUN_ID, logEvent("B write"), { expectedLeaseOwnerId: OWNER_B });
    const lateWriteA = await settle(
      storeA.appendNextEvent(RUN_ID, logEvent("A late write"), { expectedLeaseOwnerId: OWNER_A })
    );

    expect({
      bAcquiresWhileAHolds,
      lateWriteA,
      journal: logMessages(await storeB.getRun(RUN_ID)),
      locksLeft: [await pathExists(eventsLock), await pathExists(leaseLock)],
    }).toEqual({
      bAcquiresWhileAHolds: false,
      lateWriteA: "rejected",
      journal: ["A write", "B write"],
      locksLeft: [false, false],
    });
  });

  test("a write queued behind the stalled holder runs after it, and the holder's release leaves the next holder's lock alone", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-lock-handoff");
    const { storeA, storeB, eventsLock } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pauseA = pauseNextOwnerCheckedWrite(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pauseA.entered;
    // An unfenced journal write from the other store (e.g. a Stop's status) queues on the events
    // lock; it must not enter while A holds it.
    const pauseB = pauseNextOwnerCheckedWrite(storeB);
    let bEntered = false;
    const bEnteredSignal = pauseB.entered.then(() => {
      bEntered = true;
    });
    const writeB = storeB.appendNextEvent(RUN_ID, logEvent("B write"));
    // Negative check: give B ample time to (wrongly) get in.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const bEnteredWhileAHolds = bEntered;

    pauseA.release();
    await writeA;
    await bEnteredSignal;
    // B is inside its critical section now: its lock must still be there and still exclude.
    const bLockWhileBHolds = {
      exists: await pathExists(eventsLock),
      otherProcessGetsIt: await crossProcessContenderGetsLock(eventsLock),
    };
    pauseB.release();
    await writeB;

    expect({
      bEnteredWhileAHolds,
      bLockWhileBHolds,
      journal: logMessages(await storeB.getRun(RUN_ID)),
    }).toEqual({
      bEnteredWhileAHolds: false,
      bLockWhileBHolds: { exists: true, otherProcessGetsIt: false },
      journal: ["A write", "B write"],
    });
  });
  test("a writer behind a hung holder times out without taking the lock, and a later writer proceeds", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-bounded-wait");
    const { storeA, eventsLock, leaseLock } = await createBackends(tmp.path);
    const impatient = new WorkflowRunStore({
      sessionDir: tmp.path,
      staleLeaseMs: STALE_LEASE_MS,
      mutationLockWaitTimeoutMs: 50,
    });
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseNextOwnerCheckedWrite(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;

    // Same timeout error the mkdir locks raised; each waiter only leaves the queue.
    for (const attempt of [1, 2, 3]) {
      await expect(
        impatient.appendNextEvent(RUN_ID, logEvent(`timed-out write ${attempt}`))
      ).rejects.toThrow("Timed out acquiring workflow mutation lock");
    }
    const holderLocksAfterTimeout = {
      events: await pathExists(eventsLock),
      lease: await pathExists(leaseLock),
      otherProcessGetsEvents: await crossProcessContenderGetsLock(eventsLock),
    };

    pause.release();
    await writeA;
    await impatient.appendNextEvent(RUN_ID, logEvent("later write"));

    expect({
      holderLocksAfterTimeout,
      journal: logMessages(await storeA.getRun(RUN_ID)),
    }).toEqual({
      holderLocksAfterTimeout: { events: true, lease: true, otherProcessGetsEvents: false },
      // The abandoned places never ran their writes.
      journal: ["A write", "later write"],
    });
  });
});
