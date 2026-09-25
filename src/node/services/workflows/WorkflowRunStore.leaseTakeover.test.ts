/* eslint-disable @typescript-eslint/await-thenable */
/**
 * Reproducers for coder/xum #4452 gap 1 (red by design, evidence only).
 *
 * Two WorkflowRunStore instances on one session dir stand in for two backends sharing a Xum root.
 * A pauses INSIDE its owner-checked section (after withExpectedLeaseOwner read the lease, before
 * the journal write) while holding `events.jsonl.lock` and `lease.json.lock`. A stalled holder
 * never refreshes those mkdir locks, so "time passing" is simulated deterministically by
 * backdating their mtimes past the reclaim window (max(1s, staleLeaseMs)); lease staleness is
 * driven through the explicit `nowMs` arguments. No real waits.
 *
 * The red tests assert the SAFE outcome, so they fail on current code.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";

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

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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
    eventsLockDir: path.join(runDir, "events.jsonl.lock"),
    leaseLockDir: path.join(runDir, "lease.json.lock"),
  };
}

/**
 * One-shot pause on the store's first `getRunUnlocked` call. In appendNextEvent that call is the
 * first thing appendNextEventUnlocked does, i.e. after withWorkflowMutationLock took the events
 * lock and withExpectedLeaseOwner took the lease lock and checked the owner.
 */
function pauseInsideOwnerCheckedSection(store: WorkflowRunStore) {
  const entered = createDeferred();
  const release = createDeferred();
  // Private seam, reached the same way other store/service tests reach internals.
  const internals = store as unknown as {
    getRunUnlocked: (runId: string) => Promise<WorkflowRunRecord>;
  };
  const original = internals.getRunUnlocked.bind(store);
  internals.getRunUnlocked = async (runId: string): Promise<WorkflowRunRecord> => {
    internals.getRunUnlocked = original;
    entered.resolve();
    await release.promise;
    return await original(runId);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

/** A stalled holder never refreshes its mkdir locks: age them past the reclaim window. */
async function ageLockDirs(...lockDirs: string[]) {
  const staleSeconds = (Date.now() - 5_000) / 1_000;
  for (const lockDir of lockDirs) {
    await fs.utimes(lockDir, staleSeconds, staleSeconds);
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
    const { storeA, eventsLockDir, leaseLockDir } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseInsideOwnerCheckedSection(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;
    // A holds both locks while inside the owner-checked section.
    expect(await pathExists(eventsLockDir)).toBe(true);
    expect(await pathExists(leaseLockDir)).toBe(true);
    pause.release();
    await writeA;

    expect(logMessages(await storeA.getRun(RUN_ID))).toEqual(["A write"]);
    expect(await pathExists(eventsLockDir)).toBe(false);
    expect(await pathExists(leaseLockDir)).toBe(false);
  });

  test("control: a second backend cannot take over while the holder's locks are fresh", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-fresh-locks");
    const { storeA, storeB } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseInsideOwnerCheckedSection(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;
    // The lease itself is stale by B's clock, but A's fresh lease lock refuses B.
    await expect(storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS)).resolves.toBe(false);
    pause.release();
    await writeA;

    expect(logMessages(await storeA.getRun(RUN_ID))).toEqual(["A write"]);
  });

  test("RED on main: a stalled holder's write is rejected after another backend took the run", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-late-write");
    const { storeA, storeB, eventsLockDir, leaseLockDir } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pause = pauseInsideOwnerCheckedSection(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A late write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pause.entered;

    // A stalls past the reclaim window: B reclaims both locks, takes the lease and appends.
    await ageLockDirs(eventsLockDir, leaseLockDir);
    await expect(storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS)).resolves.toBe(true);
    await storeB.appendNextEvent(RUN_ID, logEvent("B write"), { expectedLeaseOwnerId: OWNER_B });

    pause.release();
    const writeAOutcome = await settle(writeA);
    const journal = logMessages(await storeB.getRun(RUN_ID));

    // SAFE outcome: B owns the run, so A's already-owner-checked write must not land.
    expect({ writeAOutcome, journal }).toEqual({
      writeAOutcome: "rejected",
      journal: ["B write"],
    });
  });

  test("RED on main: a stalled holder's finally does not delete the new holder's locks", async () => {
    using tmp = new DisposableTempDir("workflow-4452-gap1-lock-delete");
    const { storeA, storeB, eventsLockDir, leaseLockDir } = await createBackends(tmp.path);
    await expect(storeA.acquireLease(RUN_ID, OWNER_A, LEASE_ACQUIRED_AT_MS)).resolves.toBe(true);

    const pauseA = pauseInsideOwnerCheckedSection(storeA);
    const writeA = storeA.appendNextEvent(RUN_ID, logEvent("A late write"), {
      expectedLeaseOwnerId: OWNER_A,
    });
    await pauseA.entered;

    await ageLockDirs(eventsLockDir, leaseLockDir);
    await expect(storeB.acquireLease(RUN_ID, OWNER_B, AFTER_LEASE_STALE_MS)).resolves.toBe(true);
    // B is now inside ITS owner-checked section, holding fresh events and lease locks.
    const pauseB = pauseInsideOwnerCheckedSection(storeB);
    const writeB = storeB.appendNextEvent(RUN_ID, logEvent("B write"), {
      expectedLeaseOwnerId: OWNER_B,
    });
    await pauseB.entered;

    pauseA.release();
    const writeAOutcome = await settle(writeA);
    // B has not left its critical section, so both lock directories are B's and must survive.
    const bLocksWhileBHolds = {
      eventsLock: await pathExists(eventsLockDir),
      leaseLock: await pathExists(leaseLockDir),
    };
    pauseB.release();
    await writeB;

    expect({ writeAOutcome, bLocksWhileBHolds }).toEqual({
      writeAOutcome: "rejected",
      bLocksWhileBHolds: { eventsLock: true, leaseLock: true },
    });
  });
});
