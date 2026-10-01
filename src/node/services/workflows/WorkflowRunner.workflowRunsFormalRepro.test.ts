/**
 * Deterministic repros of counterexamples found by the TLA+ model in formal/workflow-runs/
 * (WorkflowRuns.tla; run formal/workflow-runs/check.sh). Each `test.failing` is a crash that
 * leaves a workflow run no recovery path can finish (the model's Terminates property); its
 * passing control moves the crash point past the write the bug needs.
 *
 * Run: bun test ./src/node/services/workflows/WorkflowRunner.workflowRunsFormalRepro.test.ts
 *
 * W8 and W10 use a real process exit at the crash point (workflowRunsFormalRepro.testHarness.ts,
 * one `bun` process per backend lifetime). W7 models the dead backend as a WorkflowService whose
 * start is parked forever at the crash point; a second service on the same store is the restart.
 */
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import { DisposableTempDir } from "@/node/services/tempDir";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowService } from "./WorkflowService";
import type { WorkflowArchiveAdmissionGuard } from "./workflowArchiveAdmission";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

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
  // publishes the child's row (taskService.ts:6451). A crash in between leaves a started step
  // naming a task that never existed. classifyPriorAttempt treats that "no task record" as
  // unresolved (WorkflowRunner.ts:3171-3172), so every resume interrupts the run again: no row
  // exists to stop or delete, and retry_from_checkpoint does not apply to an interrupted run.
  test.failing(
    "a crash between the started checkpoint and the commit is never resolved",
    async () => {
      const crashed = await runFixture(["reserve-crash", root.path]);
      expect(crashed).toMatchObject({ childId: "priorchild01" });
      expect(crashed.row).toBeUndefined();

      const first = await runFixture(["resume", root.path]);
      const second = await runFixture(["resume", root.path]);
      // Target: the next backend replaces the never-published child and finishes the run.
      expect(lastFinishedOr(first, second)).toMatchObject(FINISHED);
    },
    60_000
  );

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

/** Archive gate of a workspace that is neither archived nor being archived. */
const ADMIT_ALL: WorkflowArchiveAdmissionGuard = { getWorkflowArchiveRefusal: () => null };
const WORKSPACE_ID = "workspace-formal";
const SOURCE = `export default function workflow() {\n  return { reportMarkdown: "done" };\n}\n`;

function script(): ResolvedWorkflowScript {
  return {
    requestedScriptPath: "./workflows/demo.js",
    canonicalScriptPath: "./workflows/demo.js",
    source: SOURCE,
    sourceHash: "sha256:test",
    sourceKind: "workspace-file",
    resolvedPath: "/workspace/workflows/demo.js",
  };
}

function backend(sessionDir: string, runnerId: string): WorkflowService {
  return new WorkflowService({
    archiveAdmission: ADMIT_ALL,
    runStore: new WorkflowRunStore({ sessionDir }),
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      runAgent() {
        return Promise.reject(new Error("No agent steps expected"));
      },
    },
    generateRunId: () => "wfr_formal_pending",
    runnerId,
  });
}

/**
 * Backend 1 starts a background workflow and dies at `crashAt` (the callback never returns, so
 * nothing after it runs). Returns the run as the restarted backend first reads it.
 */
async function startAndCrash(
  sessionDir: string,
  crashAt: "onRunCreated" | "onBackgroundRunCreated"
): Promise<WorkflowRunRecord> {
  const parked = new Promise<never>(() => undefined);
  const reachedCrashPoint = Promise.withResolvers<void>();
  void backend(sessionDir, "runner-crashed")
    .startWorkflowInBackground({
      script: script(),
      workspaceId: WORKSPACE_ID,
      projectTrusted: true,
      args: {},
      [crashAt]: () => {
        reachedCrashPoint.resolve();
        return parked;
      },
    })
    .catch(() => undefined);
  await reachedCrashPoint.promise;
  return await new WorkflowRunStore({ sessionDir }).getRun("wfr_formal_pending");
}

async function waitForStatus(sessionDir: string, status: string): Promise<string> {
  const store = new WorkflowRunStore({ sessionDir });
  let current = "";
  for (let i = 0; i < 200; i++) {
    current = (await store.getRun("wfr_formal_pending")).status;
    if (current === status) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return current;
}

describe("formal/workflow-runs: crash while starting a workflow run", () => {
  // W7 (MC_pending): createRun writes a pending run; the first "running" status comes later
  // (startWorkflowInBackground at WorkflowService.ts:561, the runner at WorkflowRunner.ts:686 for
  // a foreground start). Crash recovery resumes only running/backgrounded runs
  // (WorkflowService.ts:243, 678), so a run whose backend died in between stays pending forever:
  // listed as active, never started, with no lease and no runner.
  test.failing(
    "a crash before the first running status leaves the run pending forever",
    async () => {
      using tmp = new DisposableTempDir("workflow-runs-formal-pending");
      const crashed = await startAndCrash(tmp.path, "onRunCreated");
      expect(crashed.status).toBe("pending");

      const restarted = backend(tmp.path, "runner-restarted");
      const resumed = await restarted.resumeCrashedRuns({
        workspaceId: WORKSPACE_ID,
        projectTrusted: true,
      });
      // Target: crash recovery picks the orphaned run up.
      expect(resumed).toEqual(["wfr_formal_pending"]);
      expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
    }
  );

  test("control: a crash after the running status is recovered and completes", async () => {
    using tmp = new DisposableTempDir("workflow-runs-formal-running");
    const crashed = await startAndCrash(tmp.path, "onBackgroundRunCreated");
    expect(crashed.status).toBe("running");

    const restarted = backend(tmp.path, "runner-restarted");
    const resumed = await restarted.resumeCrashedRuns({
      workspaceId: WORKSPACE_ID,
      projectTrusted: true,
    });
    expect(resumed).toEqual(["wfr_formal_pending"]);
    expect(await waitForStatus(tmp.path, "completed")).toBe("completed");
  });
});
