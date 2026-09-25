/**
 * Cross-process fixture for WorkflowRunner.replacementRestart.test.ts (G2). Each invocation is one
 * backend process on the Xum root given as argv[3]:
 *   end <root> <reported|no-report>  process 1: reserve the step's child (journal names it), then
 *                                    either stop it idle (receipt) or publish its report
 *   resume <root>                    process 2: resume the workflow run and print what it did
 * Launch is stubbed (no model); reservation, receipts, classification, claim and the single-use
 * publishing commit are the real TaskService code.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { spyOn } from "bun:test";
import { Config, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { upsertSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
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
import { WorkflowRunStore } from "./WorkflowRunStore";
import { WorkflowRunner } from "./WorkflowRunner";
import {
  WorkflowTaskServiceAdapter,
  type WorkflowTaskServiceAdapterOptions,
} from "./WorkflowTaskServiceAdapter";
import { hashWorkflowStepInput } from "./workflowReplayKey";

export const FIXTURE_RUN_ID = "wfr_replacement_restart";
export const FIXTURE_PARENT_ID = "parentrestart1";
export const FIXTURE_STEP_ID = "summarize";
const SOURCE = `export default function workflow({ agent }) {
  const summary = agent("Summarize durable workflows", { id: "${FIXTURE_STEP_ID}" });
  return { reportMarkdown: "Final: " + summary };
}
`;
const stepSpec = { id: FIXTURE_STEP_ID, prompt: "Summarize durable workflows", markdownOnly: true };

function stack(config: Config): TaskService {
  const { taskService } = createTaskServiceStack(config);
  spyOn(
    taskService as unknown as { startReservedAgentTask: () => Promise<void> },
    "startReservedAgentTask"
  ).mockImplementation(() => Promise.resolve());
  return taskService;
}

const sessionDir = (config: Config) => path.join(config.sessionsDir, FIXTURE_PARENT_ID);

/** The refusal a terminally failed child persists (failAgentTaskTerminally, onRefusal: "fail"). */
const FIXTURE_REFUSAL = { errorType: "model_refusal", errorMessage: "fixture: the model refused" };

interface TerminalFailureInternals {
  failAgentTaskTerminally: (
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    options: { expectedAttemptId: string | null }
  ) => Promise<void>;
}

async function end(root: string, outcome: "reported" | "no-report" | "refused") {
  const config = new Config(root);
  await fs.mkdir(config.srcDir, { recursive: true });
  const projectPath = await createTestProject(root, "repo", { initGit: false });
  await saveWorkspaces(
    config,
    projectPath,
    [
      projectWorkspace(projectPath, "parent", FIXTURE_PARENT_ID, {
        runtimeConfig: { type: "local" },
      }),
    ],
    testTaskSettings(4, 3)
  );
  stubStableIds(config, ["priorchild01"]);
  const taskService = stack(config);
  const store = new WorkflowRunStore({ sessionDir: sessionDir(config) });
  await store.createRun({
    id: FIXTURE_RUN_ID,
    workspaceId: FIXTURE_PARENT_ID,
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
  await store.appendStatus(FIXTURE_RUN_ID, "running", new Date().toISOString());
  const created = await taskService.createMany(
    [
      {
        parentWorkspaceId: FIXTURE_PARENT_ID,
        kind: "agent",
        agentId: "exec",
        prompt: stepSpec.prompt,
        title: FIXTURE_STEP_ID,
        workflowTask: { runId: FIXTURE_RUN_ID, stepId: FIXTURE_STEP_ID },
      },
    ],
    {
      // The runner's lease-fenced checkpoint: the journal names the child before it is published.
      onTaskReserved: async (_index, result) => {
        await store.recordStepStarted(FIXTURE_RUN_ID, {
          stepId: FIXTURE_STEP_ID,
          inputHash: hashWorkflowStepInput(FIXTURE_STEP_ID, stepSpec),
          taskId: result.taskId,
          startedAt: new Date().toISOString(),
        });
      },
    }
  );
  if (!created.success) throw new Error(`reservation failed: ${created.error}`);
  const childId = created.data[0].taskId;
  if (outcome === "no-report") {
    const stopped = await taskService.stopDescendantAgentTask(FIXTURE_PARENT_ID, childId);
    if (!stopped.success) throw new Error(`stop failed: ${stopped.error}`);
    for (let i = 0; i < 400 && taskService.isWorkspaceStopInProgress(childId); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } else if (outcome === "refused") {
    // The real terminal-failure path: interrupted row, settlement receipt, failure artifact.
    const row = findWorkspaceInConfig(config, childId);
    if (row == null) throw new Error("reserved child row missing");
    await (taskService as unknown as TerminalFailureInternals).failAgentTaskTerminally(
      childId,
      { projectPath, workspace: row },
      FIXTURE_REFUSAL,
      { expectedAttemptId: row.taskAttemptId ?? null }
    );
  } else {
    await upsertSubagentReportArtifact({
      workspaceId: FIXTURE_PARENT_ID,
      workspaceSessionDir: sessionDir(config),
      childTaskId: childId,
      parentWorkspaceId: FIXTURE_PARENT_ID,
      ancestorWorkspaceIds: [FIXTURE_PARENT_ID],
      reportMarkdown: "the prior child's report",
    });
  }
  return { childId, row: findWorkspaceInConfig(config, childId) };
}

async function resume(root: string) {
  const config = new Config(root);
  stubStableIds(config, ["replacement01"]);
  const taskService = stack(config);
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
      parentWorkspaceId: FIXTURE_PARENT_ID,
      workflowRunId: FIXTURE_RUN_ID,
      defaultAgentId: "exec",
    }),
    runnerId: `workflow-runner:${FIXTURE_PARENT_ID}:${FIXTURE_RUN_ID}:process2`,
  });
  let result: unknown;
  let error: string | undefined;
  try {
    result = await runner.run(FIXTURE_RUN_ID);
  } catch (caught: unknown) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const children: string[] = [];
  for (const project of config.loadConfigOrDefault().projects.values()) {
    for (const ws of project.workspaces) {
      if (ws.workflowTask?.stepId === FIXTURE_STEP_ID && ws.id != null) children.push(ws.id);
    }
  }
  const run = await store.getRun(FIXTURE_RUN_ID);
  const lastStep = run.steps.filter((step) => step.stepId === FIXTURE_STEP_ID).at(-1);
  return {
    result,
    error,
    runStatus: run.status,
    children: children.sort(),
    journal: lastStep?.taskId,
    journalStatus: lastStep?.status,
    priorRetiredBy: findWorkspaceInConfig(config, "priorchild01")?.taskAttemptRetiredBy,
  };
}

const [phase, root, outcome] = process.argv.slice(2);
try {
  const output =
    phase === "end"
      ? await end(root, outcome === "reported" || outcome === "refused" ? outcome : "no-report")
      : await resume(root);
  process.stdout.write(`FIXTURE_RESULT ${JSON.stringify(output)}\n`);
  process.exit(0);
} catch (error: unknown) {
  process.stderr.write(
    `FIXTURE_ERROR ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
}
