/**
 * Cross-process fixture for WorkflowRunner.workflowRunsFormalRepro.test.ts (formal/workflow-runs).
 * Each invocation is one backend process on the Xum root given as argv[3]; a phase that models a
 * crash ends the process with process.exit at the crash point, so nothing after it runs:
 *   reserve-crash <root>    the step's started checkpoint is written (onTaskReserved), then the
 *                           backend dies before commitReservations publishes the child (W8)
 *   reserve-stop <root>     control: the child is published and stopped (receipt) before exit
 *   reserve-stall <root>    a stalled (not dead) backend: after the started checkpoint it writes
 *                           <root>/stalled and waits for <root>/release before its commit, then
 *                           prints how createMany ended (the late commit after a tombstone)
 *   interrupt-crash <root> after|before
 *                           a real WorkflowService runs the workflow; while its child is mid-turn
 *                           ("running") WorkflowService.interruptRun interrupts the run, and the
 *                           backend dies right after (or right before) the run's "interrupted"
 *                           status write lands (W10)
 *   interrupt-nested-crash <root>
 *                           as interrupt-crash after, but the run's agent runs in a nested
 *                           workflow run; the backend dies right after the PARENT's status write
 *   interrupt-stop <root>   control: the child is stopped (receipt) before "interrupted"
 *   resume <root> [recover] a fresh backend: optionally TaskService startup recovery, then a
 *                           workflow resume (interrupted runs allowed); prints what it did
 *   start-crash <sessionDir> onRunCreated|onBackgroundRunCreated
 *                           startWorkflowInBackground dies at that callback: before the first
 *                           running status (W7) or, as a control, after it
 *   start-park <sessionDir>  startWorkflowInBackground parks in onRunCreated (a live starter)
 *                           until the test kills the process
 *   resume-nested <root>    a fresh backend: TaskService startup recovery, then a WorkflowService
 *                           resume of the parent run (which replays its nested run)
 * Launch is stubbed (no model); reservation, receipts, startup recovery, classification, claim
 * and the publishing commit are the real TaskService code (as in replacementRestart.testHarness).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { spyOn } from "bun:test";
import { Config } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { TaskService } from "@/node/services/taskService";
import {
  createTaskServiceStack,
  createTestProject,
  findWorkspaceInConfig,
  projectWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
} from "@/node/services/taskService.testHarness";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner } from "./WorkflowRunner";
import {
  WorkflowTaskServiceAdapter,
  type WorkflowTaskServiceAdapterOptions,
} from "./WorkflowTaskServiceAdapter";
import { hashWorkflowStepInput } from "./workflowReplayKey";
import { WorkflowService } from "./WorkflowService";
import type { WorkflowArchiveAdmissionGuard } from "./workflowArchiveAdmission";
import type { ResolvedWorkflowScript } from "./workflowScriptResolver";

const RUN_ID = "wfr_formal_repro";
const PARENT_ID = "parentformal1";
const STEP_ID = "summarize";
const SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "${STEP_ID}" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const stepSpec = { id: STEP_ID, prompt: "Summarize durable workflows", markdownOnly: true };
/** Past WorkflowRunStore's default staleLeaseMs (30 s). */
const STALE_LEASE_PASSED_MS = 31_000;

function stack(config: Config): TaskService {
  const { taskService } = createTaskServiceStack(config);
  spyOn(
    taskService as unknown as { startReservedAgentTask: () => Promise<void> },
    "startReservedAgentTask"
  ).mockImplementation(() => Promise.resolve());
  return taskService;
}

const sessionDir = (config: Config) => path.join(config.sessionsDir, PARENT_ID);

function emit(output: unknown): void {
  process.stdout.write(`FIXTURE_RESULT ${JSON.stringify(output)}\n`);
}

type Phase1 = "reserve-crash" | "reserve-stop" | "reserve-stall" | "interrupt-stop";

async function waitForFile(file: string): Promise<void> {
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function setUpRoot(root: string): Promise<Config> {
  const config = new Config(root);
  await fs.mkdir(config.srcDir, { recursive: true });
  const projectPath = await createTestProject(root, "repo", { initGit: false });
  await saveWorkspaces(
    config,
    projectPath,
    [projectWorkspace(projectPath, "parent", PARENT_ID, { runtimeConfig: { type: "local" } })],
    testTaskSettings(4, 3)
  );
  stubStableIds(config, ["priorchild01"]);
  return config;
}

function workflowTaskService(
  taskService: TaskService
): WorkflowTaskServiceAdapterOptions["taskService"] {
  return {
    create: (args) => taskService.create(args as Parameters<TaskService["create"]>[0]),
    createMany: (args, options) =>
      taskService.createMany(args as Parameters<TaskService["createMany"]>[0], options),
    readAttemptOutcome: (taskId, options) => taskService.readAttemptOutcome(taskId, options),
    claimRetiredAttempt: (taskId, attemptId, claimant) =>
      taskService.claimRetiredAttempt(taskId, attemptId, claimant),
    tombstoneUnpublishedReservation: (parentWorkspaceId, taskId) =>
      taskService.tombstoneUnpublishedReservation(parentWorkspaceId, taskId),
    waitForAgentReport: (taskId) => taskService.waitForAgentReport(taskId),
    terminateAllDescendantAgentTasks: (workspaceId, options) =>
      taskService.terminateAllDescendantAgentTasks(workspaceId, options),
  };
}

/** The top-level run's only step runs SOURCE as a nested workflow run. */
const NESTING_SOURCE = `export default function workflow({ workflow }) {
  const nested = workflow("./workflows/research.js", { id: "nested" });
  return { reportMarkdown: nested.reportMarkdown };
}
`;

function workflowScript(name: string, source: string): ResolvedWorkflowScript {
  return {
    requestedScriptPath: `./workflows/${name}`,
    canonicalScriptPath: `./workflows/${name}`,
    source,
    sourceHash: `sha256:${name}`,
    sourceKind: "workspace-file",
    resolvedPath: `/workspace/workflows/${name}`,
  };
}

function workflowService(
  store: WorkflowRunStore,
  taskService: WorkflowTaskServiceAdapterOptions["taskService"],
  processName: string,
  extra: Partial<ConstructorParameters<typeof WorkflowService>[0]> = {}
): WorkflowService {
  return new WorkflowService({
    archiveAdmission: { getWorkflowArchiveRefusal: () => null },
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapterFactory: (runId) =>
      new WorkflowTaskServiceAdapter({
        taskService,
        parentWorkspaceId: PARENT_ID,
        workflowRunId: runId,
        defaultAgentId: "exec",
      }),
    resolveWorkflowScript: (scriptPath) => {
      if (scriptPath !== "./workflows/research.js") throw new Error(`unknown script ${scriptPath}`);
      return Promise.resolve(workflowScript("research.js", SOURCE));
    },
    generateRunId: () => RUN_ID,
    runnerId: `workflow-runner:${PARENT_ID}:${processName}`,
    ...extra,
  });
}

/**
 * Resume the top-level run through WorkflowService (it replays the nested run) after startup
 * recovery, and report both runs.
 */
async function resumeNested(root: string) {
  const config = new Config(root);
  stubStableIds(config, ["replacement01"]);
  const taskService = stack(config);
  await taskService.recoverInterruptedTasks();
  const store = new WorkflowRunStore({ sessionDir: sessionDir(config) });
  const terminal = Promise.withResolvers<string>();
  const service = workflowService(
    store,
    {
      ...workflowTaskService(taskService),
      // Stands in for the replacement's model turn.
      waitForAgentReport: (taskId) => Promise.resolve({ reportMarkdown: `report from ${taskId}` }),
    },
    "process2",
    {
      notifyInterruptedBackgroundRunTerminal: true,
      onBackgroundRunTerminal: (event) => terminal.resolve(event.status),
      // See resume(): the dead backend's leases can still be fresh.
      clock: {
        nowMs: () => Date.now() + STALE_LEASE_PASSED_MS,
        nowIso: () => new Date(Date.now() + STALE_LEASE_PASSED_MS).toISOString(),
      },
    }
  );
  await service.resumeRunInBackground({
    workspaceId: PARENT_ID,
    runId: RUN_ID,
    projectTrusted: true,
  });
  const terminalStatus = await Promise.race([
    terminal.promise,
    new Promise<string>((resolve) => setTimeout(() => resolve("no terminal event"), 20_000)),
  ]);
  const run = await store.getRun(RUN_ID);
  const nestedRun = (await store.listRunStatusSnapshots()).find(
    (snapshot) => snapshot.parentWorkflow?.runId === RUN_ID
  );
  const nestedStep =
    nestedRun == null
      ? undefined
      : (await store.getRun(nestedRun.id)).steps.filter((step) => step.stepId === STEP_ID).at(-1);
  return {
    terminalStatus,
    runStatus: run.status,
    result: run.events.findLast((event) => event.type === "result")?.result,
    nestedRunStatus: nestedRun?.status,
    nestedJournal: nestedStep?.taskId,
    nestedJournalStatus: nestedStep?.status,
  };
}

/**
 * W10 through the production entry points: WorkflowService starts the run (its runner registers
 * at lease acquisition, as in the app), the child's turn is streaming, and interruptRun is
 * called. The backend dies right after the run's "interrupted" status is durable (`after`), or
 * right before that write (`before`). Whether the children are terminated by then is exactly
 * what the interrupt's order decides.
 */
async function interruptCrash(
  root: string,
  crashAt: "after" | "before",
  nested = false
): Promise<never> {
  const config = await setUpRoot(root);
  const taskService = stack(config);
  const store = new WorkflowRunStore({ sessionDir: sessionDir(config) });
  const appendStatus = store.appendStatus.bind(store);
  spyOn(store, "appendStatus").mockImplementation(async (runId, status, at, options) => {
    // Only the top-level run's write is the crash point (a nested run writes its own first).
    if (status !== "interrupted" || runId !== RUN_ID) {
      return await appendStatus(runId, status, at, options);
    }
    const crash = () => {
      emit({ row: findWorkspaceInConfig(config, "priorchild01") });
      process.exit(0);
    };
    if (crashAt === "before") crash();
    const written = await appendStatus(runId, status, at, options);
    crash();
    return written;
  });
  const service = workflowService(store, workflowTaskService(taskService), "process1");
  await service.startWorkflowInBackground({
    script: nested
      ? workflowScript("parent.js", NESTING_SOURCE)
      : workflowScript("research.js", SOURCE),
    workspaceId: PARENT_ID,
    projectTrusted: true,
    args: {},
  });
  // The child's launch went through and its turn is streaming (launch itself is stubbed).
  for (let i = 0; findWorkspaceInConfig(config, "priorchild01") == null; i++) {
    if (i > 2000) throw new Error("the workflow never reserved its child");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await config.editConfig((cfg) => {
    const entry = findWorkspaceEntry(cfg, "priorchild01");
    if (entry == null) throw new Error("published child row missing");
    entry.workspace.taskStatus = "running";
    return cfg;
  });
  await service.interruptRun({ workspaceId: PARENT_ID, runId: RUN_ID });
  throw new Error("interruptRun returned without writing the interrupted status");
}

async function phase1(root: string, phase: Phase1): Promise<never> {
  const config = await setUpRoot(root);
  const taskService = stack(config);
  const store = new WorkflowRunStore({ sessionDir: sessionDir(config) });
  await store.createRun({
    id: RUN_ID,
    workspaceId: PARENT_ID,
    workflow: {
      name: "deep-research",
      description: "Research",
      scope: "built-in",
      executable: true,
    },
    source: SOURCE,
    args: {},
    now: new Date().toISOString(),
  });
  await store.appendStatus(RUN_ID, "running", new Date().toISOString());
  const created = await taskService.createMany(
    [
      {
        parentWorkspaceId: PARENT_ID,
        kind: "agent",
        agentId: "exec",
        prompt: stepSpec.prompt,
        title: STEP_ID,
        workflowTask: { runId: RUN_ID, stepId: STEP_ID },
      },
    ],
    {
      // The runner's lease-fenced checkpoint (WorkflowRunner reserveAgentTasks): the journal
      // names the child before commitReservations publishes its task row.
      onTaskReserved: async (_index, result) => {
        await store.recordStepStarted(RUN_ID, {
          stepId: STEP_ID,
          inputHash: hashWorkflowStepInput(STEP_ID, stepSpec),
          taskId: result.taskId,
          startedAt: new Date().toISOString(),
        });
        if (phase === "reserve-crash") {
          // Crash point: the checkpoint is on disk, the commit never runs.
          emit({ childId: result.taskId, row: findWorkspaceInConfig(config, result.taskId) });
          process.exit(0);
        }
        if (phase === "reserve-stall") {
          // Stall point: the checkpoint is on disk; another backend acts before the commit.
          await fs.writeFile(path.join(root, "stalled"), result.taskId);
          await waitForFile(path.join(root, "release"));
        }
      },
    }
  );
  if (phase === "reserve-stall") {
    emit({
      created: created.success,
      error: created.success ? undefined : created.error,
      row: findWorkspaceInConfig(config, "priorchild01"),
    });
    process.exit(0);
  }
  if (!created.success) throw new Error(`reservation failed: ${created.error}`);
  const childId = created.data[0].taskId;

  const stopped = await taskService.stopDescendantAgentTask(PARENT_ID, childId);
  if (!stopped.success) throw new Error(`stop failed: ${stopped.error}`);
  for (let i = 0; i < 400 && taskService.isWorkspaceStopInProgress(childId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (phase === "interrupt-stop") {
    await store.appendStatus(RUN_ID, "interrupted", new Date().toISOString());
  }
  emit({ childId, row: findWorkspaceInConfig(config, childId) });
  process.exit(0);
}

async function resume(root: string, recover: boolean) {
  const config = new Config(root);
  stubStableIds(config, ["replacement01"]);
  const taskService = stack(config);
  if (recover) {
    // The restarted backend's startup recovery, before any client can act.
    await taskService.recoverInterruptedTasks();
  }
  const priorRowAfterRecovery = findWorkspaceInConfig(config, "priorchild01");
  const service: WorkflowTaskServiceAdapterOptions["taskService"] = {
    ...workflowTaskService(taskService),
    // Stands in for the replacement's model turn.
    waitForAgentReport: (taskId) => Promise.resolve({ reportMarkdown: `report from ${taskId}` }),
  };
  const store = new WorkflowRunStore({ sessionDir: sessionDir(config) });
  const runner = new WorkflowRunner({
    runStore: store,
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: new WorkflowTaskServiceAdapter({
      taskService: service,
      parentWorkspaceId: PARENT_ID,
      workflowRunId: RUN_ID,
      defaultAgentId: "exec",
    }),
    runnerId: `workflow-runner:${PARENT_ID}:${RUN_ID}:process2`,
    // A dead backend's lease can still be fresh (interrupt-crash dies holding it); read the
    // clock past its staleness, as a later restart would.
    clock: {
      nowMs: () => Date.now() + STALE_LEASE_PASSED_MS,
      nowIso: () => new Date(Date.now() + STALE_LEASE_PASSED_MS).toISOString(),
    },
  });
  let result: unknown;
  let error: string | undefined;
  try {
    result = await runner.run(RUN_ID, { allowResumeFromInterrupted: true });
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const run = await store.getRun(RUN_ID);
  const lastStep = run.steps.filter((step) => step.stepId === STEP_ID).at(-1);
  return {
    result,
    error,
    runStatus: run.status,
    journal: lastStep?.taskId,
    journalStatus: lastStep?.status,
    priorRowAfterRecovery: {
      taskStatus: priorRowAfterRecovery?.taskStatus,
      present: priorRowAfterRecovery != null,
    },
  };
}

/** Archive gate of a workspace that is neither archived nor being archived. */
const ADMIT_ALL: WorkflowArchiveAdmissionGuard = { getWorkflowArchiveRefusal: () => null };
export const PENDING_WORKSPACE_ID = "workspace-formal";
export const PENDING_RUN_ID = "wfr_formal_pending";
const PENDING_SOURCE = `export default function workflow() {\n  return { reportMarkdown: "done" };\n}\n`;

export function pendingRunScript(): ResolvedWorkflowScript {
  return {
    requestedScriptPath: "./workflows/demo.js",
    canonicalScriptPath: "./workflows/demo.js",
    source: PENDING_SOURCE,
    sourceHash: "sha256:test",
    sourceKind: "workspace-file",
    resolvedPath: "/workspace/workflows/demo.js",
  };
}

/** One backend's WorkflowService for the W7 scenario (no agent steps). */
export function pendingRunBackend(
  sessionDir: string,
  runnerId: string,
  staleLeaseMs?: number
): WorkflowService {
  return new WorkflowService({
    archiveAdmission: ADMIT_ALL,
    runStore: new WorkflowRunStore({ sessionDir, staleLeaseMs }),
    runtimeFactory: new QuickJSRuntimeFactory(),
    taskAdapter: {
      runAgent() {
        return Promise.reject(new Error("No agent steps expected"));
      },
    },
    generateRunId: () => PENDING_RUN_ID,
    runnerId,
  });
}

async function startCrash(
  dir: string,
  crashAt: "onRunCreated" | "onBackgroundRunCreated"
): Promise<never> {
  await pendingRunBackend(dir, "runner-crashed").startWorkflowInBackground({
    script: pendingRunScript(),
    workspaceId: PENDING_WORKSPACE_ID,
    projectTrusted: true,
    args: {},
    // Crash point: the process ends inside the callback, so nothing after it runs.
    [crashAt]: (event: { run: { status: string } }) => {
      emit({ status: event.run.status, pid: process.pid });
      process.exit(0);
    },
  });
  throw new Error(`start-crash: ${crashAt} was never called`);
}

async function startPark(dir: string): Promise<never> {
  // A pending promise alone does not keep the process alive.
  setInterval(() => undefined, 1_000);
  await pendingRunBackend(dir, "runner-parked").startWorkflowInBackground({
    script: pendingRunScript(),
    workspaceId: PENDING_WORKSPACE_ID,
    projectTrusted: true,
    args: {},
    onRunCreated: (event: { run: { status: string } }) => {
      emit({ status: event.run.status, pid: process.pid });
      return new Promise<never>(() => undefined);
    },
  });
  throw new Error("start-park: the parked start returned");
}

if (import.meta.main) {
  const [phase, root, flag] = process.argv.slice(2);
  try {
    if (phase === "resume") {
      emit(await resume(root, flag === "recover"));
      process.exit(0);
    }
    if (phase === "start-park") {
      await startPark(root);
    }
    if (phase === "start-crash") {
      if (flag !== "onRunCreated" && flag !== "onBackgroundRunCreated") {
        throw new Error(`unknown crash point ${flag}`);
      }
      await startCrash(root, flag);
    }
    if (phase === "resume-nested") {
      emit(await resumeNested(root));
      process.exit(0);
    }
    if (phase === "interrupt-crash") {
      if (flag !== "after" && flag !== "before") throw new Error(`unknown crash point ${flag}`);
      await interruptCrash(root, flag);
    }
    if (phase === "interrupt-nested-crash") {
      await interruptCrash(root, "after", true);
    }
    if (
      phase !== "reserve-crash" &&
      phase !== "reserve-stop" &&
      phase !== "reserve-stall" &&
      phase !== "interrupt-stop"
    ) {
      throw new Error(`unknown phase ${phase}`);
    }
    await phase1(root, phase);
  } catch (error: unknown) {
    process.stderr.write(
      `FIXTURE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(1);
  }
}
