/**
 * Deterministic repros of counterexamples found by the TLA+ model in formal/workflow-runs/
 * (WorkflowRuns.tla; run formal/workflow-runs/check.sh). Each `test.failing` is a crash that
 * leaves a workflow run no recovery path can finish (the model's Terminates property); its
 * passing control moves the crash point past the write the bug needs. A fixed finding's repro
 * is a plain `test`.
 *
 * Run: bun test ./src/node/services/workflows/WorkflowRunner.workflowRunsFormalRepro.test.ts
 *
 * W8 and W10 use a real process exit at the crash point (workflowRunsFormalRepro.testHarness.ts,
 * one `bun` process per backend lifetime), and so does W7 (the restart is a WorkflowService in this
 * process on the same store).
 */
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  PENDING_RUN_ID,
  PENDING_WORKSPACE_ID,
  pendingRunBackend,
  pendingRunScript,
} from "./workflowRunsFormalRepro.testHarness";

const FIXTURE = path.join(import.meta.dir, "workflowRunsFormalRepro.testHarness.ts");

async function runFixture(args: string[]): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout.split("\n").find((l) => l.startsWith("FIXTURE_RESULT "));
  if (exitCode !== 0 || line == null) {
    throw new Error(`fixture ${args[0]} failed (${exitCode}): ${stderr.slice(-4000)}`);
  }
  return JSON.parse(line.slice("FIXTURE_RESULT ".length)) as Record<string, unknown>;
}

/** The first of two resumes that completed the run, else the last one (for the diff). */
function lastFinishedOr(
  first: Record<string, unknown>,
  second: Record<string, unknown>
): Record<string, unknown> {
  return [first, second].find((resumed) => resumed.runStatus === "completed") ?? second;
}

const FINISHED = {
  result: { reportMarkdown: "Final: report from replacement01" },
  runStatus: "completed",
  journal: "replacement01",
  journalStatus: "completed",
};

describe("formal/workflow-runs: crash during a workflow step (cross-process)", () => {
  let root: DisposableTempDir;

  beforeEach(() => {
    root = new DisposableTempDir("workflow-runs-formal-repro");
  });
  afterEach(() => {
    root[Symbol.dispose]();
  });

  // W8 (MC_norecord): onTaskReserved writes the started checkpoint before commitReservations
  // publishes the child's row. A crash in between leaves a started step naming a task that never
  // existed. The resuming runner tombstones the ID on the parent's row
  // (TaskService.tombstoneUnpublishedReservation) and runs the step fresh.
  test("a crash between the started checkpoint and the commit is resolved by a fresh child", async () => {
    const crashed = await runFixture(["reserve-crash", root.path]);
    expect(crashed).toMatchObject({ childId: "priorchild01" });
    expect(crashed.row).toBeUndefined();

    const first = await runFixture(["resume", root.path]);
    const second = await runFixture(["resume", root.path]);
    // Target: the next backend replaces the never-published child and finishes the run.
    expect(lastFinishedOr(first, second)).toMatchObject(FINISHED);
  }, 60_000);

  // Why W8 needs the tombstone (MC_two_stall_naive vs MC_two_stall_fixed): the reserving backend
  // may be stalled, not dead. The resume replaces its unpublished child and finishes the run;
  // when the stalled backend then reaches its commit, the tombstone makes that commit refuse, so
  // the step never gets a second child.
  test("a stalled backend's late commit is refused after the tombstone", async () => {
    const stalledChild = Bun.spawn([process.execPath, FIXTURE, "reserve-stall", root.path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stalledOutput = Promise.all([
      new Response(stalledChild.stdout).text(),
      new Response(stalledChild.stderr).text(),
      stalledChild.exited,
    ]);
    let resumed: Record<string, unknown>;
    try {
      const stalledMarker = path.join(root.path, "stalled");
      for (let i = 0; i < 3000 && !(await Bun.file(stalledMarker).exists()); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await Bun.file(stalledMarker).text()).toBe("priorchild01");
      resumed = await runFixture(["resume", root.path]);
    } finally {
      await Bun.write(path.join(root.path, "release"), "");
    }
    const [stdout, stderr, exitCode] = await stalledOutput;
    const line = stdout.split("\n").find((l) => l.startsWith("FIXTURE_RESULT "));
    if (exitCode !== 0 || line == null) {
      throw new Error(`fixture reserve-stall failed (${exitCode}): ${stderr.slice(-4000)}`);
    }
    const late = JSON.parse(line.slice("FIXTURE_RESULT ".length)) as Record<string, unknown>;
    // Target: the stalled commit refuses and never publishes the abandoned child.
    expect(late).toMatchObject({ created: false });
    expect(String(late.error)).toContain("tombstoned");
    expect(late.row).toBeUndefined();
    // ...while the resume's fresh child finished the run.
    expect(resumed).toMatchObject(FINISHED);
  }, 60_000);

  test("control: a crash after the commit and a Stop is replaced and finishes", async () => {
    await runFixture(["reserve-stop", root.path]);
    const resumed = await runFixture(["resume", root.path]);
    expect(resumed).toMatchObject(FINISHED);
  }, 60_000);

  // W10 (MC_prepass): interruptRunTree writes "interrupted" (WorkflowService.ts:332) before it
  // terminates the run's children (:339). After a crash in between, the restarted backend's
  // startup prepass interrupts the orphaned child because its run is inactive
  // (interruptTaskRecoveryForInactiveWorkflowOwner, taskService.ts:4507) but writes no settlement
  // receipt (only an owning process can, persistOwnedAttemptSettlement). Without a receipt a
  // prior-process attempt classifies as indeterminate (readUnownedSettlementProof), so resuming
  // the interrupted run never gets past that step, and a Stop of the interrupted child is a no-op.
  test.failing(
    "a crash between the interrupted status and terminating the children is never resolved",
    async () => {
      const crashed = await runFixture(["interrupt-crash", root.path]);
      expect(crashed).toMatchObject({ row: { taskStatus: "running" } });

      const first = await runFixture(["resume", root.path, "recover"]);
      expect(first).toMatchObject({ priorRowAfterRecovery: { taskStatus: "interrupted" } });
      const second = await runFixture(["resume", root.path]);
      // Target: resuming the interrupted run replaces the ended child and finishes the run.
      expect(lastFinishedOr(first, second)).toMatchObject(FINISHED);
    },
    60_000
  );

  test("control: a child stopped before the interrupted status is replaced and finishes", async () => {
    await runFixture(["interrupt-stop", root.path]);
    const resumed = await runFixture(["resume", root.path, "recover"]);
    expect(resumed).toMatchObject(FINISHED);
  }, 60_000);
});

async function waitForStatus(sessionDir: string, status: string): Promise<string> {
  const store = new WorkflowRunStore({ sessionDir });
  let current = "";
  for (let i = 0; i < 200; i++) {
    current = (await store.getRun(PENDING_RUN_ID)).status;
    if (current === status) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return current;
}

describe("formal/workflow-runs: crash while starting a workflow run", () => {
  // W7 (MC_pending): createRun writes a pending run; the first "running" status comes later
  // (startWorkflowInBackground at WorkflowService.ts:561, the runner at WorkflowRunner.ts:686 for
  // a foreground start). Crash recovery resumed only running/backgrounded runs, so a run whose
  // backend died in between stayed pending forever: listed as active, never started, with no
  // lease and no runner. Recovery now adopts a pending run once its starter process is provably
  // gone; the backend that dies here is a real process.
  test("a crash before the first running status no longer leaves the run pending forever", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-pending");
    const crashed = await runFixture(["start-crash", tmp.path, "onRunCreated"]);
    expect(crashed.status).toBe("pending");
    expect(
      (await new WorkflowRunStore({ sessionDir: tmp.path }).getRun(PENDING_RUN_ID)).status
    ).toBe("pending");

    const restarted = pendingRunBackend(tmp.path, "runner-restarted");
    const resumed = await restarted.resumeCrashedRuns({
      workspaceId: PENDING_WORKSPACE_ID,
      projectTrusted: true,
    });
    // Target: crash recovery picks the orphaned run up.
    expect(resumed).toEqual([PENDING_RUN_ID]);
    expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
  }, 60_000);

  test("control: a crash after the running status is recovered and completes", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-running");
    const crashed = await runFixture(["start-crash", tmp.path, "onBackgroundRunCreated"]);
    expect(crashed.status).toBe("running");

    const restarted = pendingRunBackend(tmp.path, "runner-restarted");
    const resumed = await restarted.resumeCrashedRuns({
      workspaceId: PENDING_WORKSPACE_ID,
      projectTrusted: true,
    });
    expect(resumed).toEqual([PENDING_RUN_ID]);
    expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
  }, 60_000);

  // A start that fails before the first running status leaves a pending run that a later backend
  // (once this process is gone) would adopt; the caller saw the failure, so the start settles it
  // as interrupted.
  test("control: a start that fails before running is interrupted, not adopted", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-failed-start");
    const starting = pendingRunBackend(tmp.path, "runner-starting");
    let thrown: unknown;
    try {
      await starting.startWorkflowInBackground({
        script: pendingRunScript(),
        workspaceId: PENDING_WORKSPACE_ID,
        projectTrusted: true,
        args: {},
        onRunCreated: () => {
          throw new Error("provenance write failed");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);

    const resumed = await pendingRunBackend(tmp.path, "runner-recovering").resumeCrashedRuns({
      workspaceId: PENDING_WORKSPACE_ID,
      projectTrusted: true,
    });
    expect(resumed).toEqual([]);
    expect(
      (await new WorkflowRunStore({ sessionDir: tmp.path }).getRun(PENDING_RUN_ID)).status
    ).toBe("interrupted");
  });

  // The failed-start cleanup must not interrupt a runner that took the lease meanwhile (an explicit
  // workflow_resume of the pending run while the start was failing).
  test("control: a failed start leaves a run whose lease another runner holds alone", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-failed-start-leased");
    const store = new WorkflowRunStore({ sessionDir: tmp.path });
    let thrown: unknown;
    try {
      await pendingRunBackend(tmp.path, "runner-starting").startWorkflowInBackground({
        script: pendingRunScript(),
        workspaceId: PENDING_WORKSPACE_ID,
        projectTrusted: true,
        args: {},
        onRunCreated: async () => {
          expect(await store.acquireLease(PENDING_RUN_ID, "runner-resuming")).toBe(true);
          throw new Error("provenance write failed");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((await store.getRun(PENDING_RUN_ID)).status).toBe("pending");
  });

  // A scan that finds the starter alive checks again later: the starter can still crash before its
  // first running status, and nothing else re-runs the scan.
  test("control: a pending run whose starter crashes after a scan is adopted on retry", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-starter-dies-later");
    const child = Bun.spawn([process.execPath, FIXTURE, "start-park", tmp.path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      let stdout = "";
      while (!stdout.includes("FIXTURE_RESULT ")) {
        const chunk = await reader.read();
        if (chunk.done)
          throw new Error(`start-park exited: ${await new Response(child.stderr).text()}`);
        stdout += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();

      // Short lease timings so the retry comes after ~100 ms.
      const recovering = pendingRunBackend(tmp.path, "runner-recovering", 200);
      const resumed = await recovering.resumeCrashedRuns({
        workspaceId: PENDING_WORKSPACE_ID,
        projectTrusted: true,
      });
      expect(resumed).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
  }, 60_000);

  // The recovery must not race a starter that is alive: a start parked between createRun and its
  // first running status in this process keeps the run pending, and recovery leaves it alone.
  test("control: a pending run whose start is still in progress is not adopted", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-live-start");
    const reachedCreated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const starting = pendingRunBackend(tmp.path, "runner-starting").startWorkflowInBackground({
      script: pendingRunScript(),
      workspaceId: PENDING_WORKSPACE_ID,
      projectTrusted: true,
      args: {},
      onRunCreated: () => {
        reachedCreated.resolve();
        return release.promise;
      },
    });
    await reachedCreated.promise;

    const recovering = pendingRunBackend(tmp.path, "runner-recovering");
    const resumed = await recovering.resumeCrashedRuns({
      workspaceId: PENDING_WORKSPACE_ID,
      projectTrusted: true,
    });
    expect(resumed).toEqual([]);
    expect(
      (await new WorkflowRunStore({ sessionDir: tmp.path }).getRun(PENDING_RUN_ID)).status
    ).toBe("pending");

    release.resolve();
    expect(await starting).toMatchObject({ runId: PENDING_RUN_ID, status: "running" });
    expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
  });
});
