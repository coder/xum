/**
 * Cross-process fixture for WorkflowRunner.workflowRunsFormalRepro.test.ts (formal/workflow-runs).
 * Each invocation is one backend process on the Xum root given as argv[3]; a phase that models a
 * crash ends the process with process.exit at the crash point, so nothing after it runs:
 *   reserve-crash <root>    the step's started checkpoint is written (onTaskReserved), then the
 *                           backend dies before commitReservations publishes the child (W8)
 *   reserve-stop <root>     control: the child is published and stopped (receipt) before exit
 *   interrupt-crash <root>  the published child is mid-turn ("running"); interruptRunTree writes
 *                           "interrupted", then the backend dies before terminating it (W10)
 *   interrupt-stop <root>   control: the child is stopped (receipt) before "interrupted"
 *   resume <root> [recover] a fresh backend: optionally TaskService startup recovery, then a
 *                           workflow resume (interrupted runs allowed); prints what it did
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

const RUN_ID = "wfr_formal_repro";
const PARENT_ID = "parentformal1";
const STEP_ID = "summarize";
const SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "${STEP_ID}" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const stepSpec = { id: STEP_ID, prompt: "Summarize durable workflows", markdownOnly: true };

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

type Phase1 = "reserve-crash" | "reserve-stop" | "interrupt-crash" | "interrupt-stop";

async function phase1(root: string, phase: Phase1): Promise<never> {
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
      },
    }
  );
  if (!created.success) throw new Error(`reservation failed: ${created.error}`);
  const childId = created.data[0].taskId;

  if (phase === "reserve-stop" || phase === "interrupt-stop") {
    const stopped = await taskService.stopDescendantAgentTask(PARENT_ID, childId);
    if (!stopped.success) throw new Error(`stop failed: ${stopped.error}`);
    for (let i = 0; i < 400 && taskService.isWorkspaceStopInProgress(childId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } else {
    // interrupt-crash: the child's launch went through and its turn is streaming.
    await config.editConfig((cfg) => {
      const entry = findWorkspaceEntry(cfg, childId);
      if (entry == null) throw new Error("published child row missing");
      entry.workspace.taskStatus = "running";
      return cfg;
    });
  }
  if (phase === "interrupt-crash" || phase === "interrupt-stop") {
    // interruptRunTree's first durable write (WorkflowService.ts:332); interrupt-crash dies
    // before its taskAdapter.interruptRun (:339) terminates the child.
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
    create: (args) => taskService.create(args as Parameters<TaskService["create"]>[0]),
    createMany: (args, options) =>
      taskService.createMany(args as Parameters<TaskService["createMany"]>[0], options),
    readAttemptOutcome: (taskId, options) => taskService.readAttemptOutcome(taskId, options),
    claimRetiredAttempt: (taskId, attemptId, claimant) =>
      taskService.claimRetiredAttempt(taskId, attemptId, claimant),
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

const [phase, root, flag] = process.argv.slice(2);
try {
  if (phase === "resume") {
    emit(await resume(root, flag === "recover"));
    process.exit(0);
  }
  if (
    phase !== "reserve-crash" &&
    phase !== "reserve-stop" &&
    phase !== "interrupt-crash" &&
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
