/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, local/no-sync-fs-methods */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Config } from "@/node/config";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { WorkflowRunStore } from "./WorkflowRunStore";
import {
  listWorkflowScripts,
  startWorkflowRun,
  type WorkflowServiceContext,
} from "./WorkflowService";
import { WorkflowArgsValidationError } from "./workflowArgs";

interface TestWorkspaceService {
  emitWorkflowRunActivity: ReturnType<typeof mock>;
  waitForWorkspaceIdle: ReturnType<typeof mock>;
  prepareManualWorkflowInvocation: ReturnType<typeof mock>;
  appendWorkflowRunInvocation: ReturnType<typeof mock>;
  isWorkflowInvocationCurrent: ReturnType<typeof mock>;
  getWorkflowContinuationSendOptions: ReturnType<typeof mock>;
  sendMessage: ReturnType<typeof mock>;
}

describe("WorkflowService request orchestration", () => {
  let temp: DisposableTempDir;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    temp = new DisposableTempDir("workflow-service-context");
    config = new Config(temp.path);
    projectPath = path.join(temp.path, "project");
    fs.mkdirSync(path.join(projectPath, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "workflows", "demo.js"),
      'export const meta = { description: "Demo workflow" };\n' +
        "export default function workflow({ args }) { return { reportMarkdown: args.topic }; }\n"
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, { workspaces: [], trusted: true });
      return current;
    });
  });

  afterEach(() => temp[Symbol.dispose]());

  function createContext(
    options: {
      enabled?: boolean;
      workspacePath?: string;
      subProjectPath?: string;
    } = {}
  ): {
    context: WorkflowServiceContext;
    workspaceService: TestWorkspaceService;
    waitForInit: ReturnType<typeof mock>;
  } {
    const workspacePath = options.workspacePath ?? projectPath;
    const workspaceService: TestWorkspaceService = {
      emitWorkflowRunActivity: mock(async () => undefined),
      waitForWorkspaceIdle: mock(async () => undefined),
      prepareManualWorkflowInvocation: mock(async () => undefined),
      appendWorkflowRunInvocation: mock(async () => true),
      isWorkflowInvocationCurrent: mock(async () => false),
      getWorkflowContinuationSendOptions: mock(async () => null),
      sendMessage: mock(async () => ({ success: true, data: undefined })),
    };
    const waitForInit = mock(async () => undefined);
    const context = {
      workflowRuntimeFactory: new QuickJSRuntimeFactory(),
      config,
      aiService: {
        waitForInit,
        resolveXumToolScopeForWorkspace: mock((_metadata, _runtime, executionPath) => ({
          type: "project",
          xumHome: temp.path,
          projectRoot: executionPath,
          projectStorageAuthority: "host-local",
          checkoutRoot: workspacePath,
        })),
        getWorkspaceMetadata: mock(async () => ({
          success: true,
          data: {
            id: "workspace-1",
            name: "workspace-1",
            projectPath,
            namedWorkspacePath: workspacePath,
            ...(options.subProjectPath != null ? { subProjectPath: options.subProjectPath } : {}),
            runtimeConfig: { type: "local", srcBaseDir: temp.path },
          },
        })),
      },
      workspaceService,
      taskService: {},
      experimentsService: {
        isExperimentEnabled: mock(() => options.enabled ?? true),
      },
    } as unknown as WorkflowServiceContext;
    return { context, workspaceService, waitForInit };
  }

  test("starts workflows from the active subproject and inherits parent skill workflows", async () => {
    const subProjectPath = path.join(projectPath, "packages", "app");
    const skillDir = path.join(projectPath, ".mux", "skills", "parent-flow");
    fs.mkdirSync(path.join(subProjectPath, "workflows"), { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(subProjectPath, "workflows", "demo.js"),
      'export default function workflow({ args }) { return { reportMarkdown: "subproject:" + args.topic }; }\n'
    );
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: parent-flow\ndescription: Parent workflow\n---\nRun it.\n"
    );
    fs.writeFileSync(
      path.join(skillDir, "workflow.js"),
      'export default function workflow({ args }) { return { reportMarkdown: "parent:" + args.topic }; }\n'
    );
    const { context } = createContext({ subProjectPath });

    const scripts = await listWorkflowScripts(context, "workspace-1");
    expect(scripts).toContainEqual(
      expect.objectContaining({ scriptPath: "skill://parent-flow/workflow.js" })
    );
    expect(
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "./workflows/demo.js",
        args: { topic: "direct" },
      })
    ).toMatchObject({ status: "completed", result: { reportMarkdown: "subproject:direct" } });
    expect(
      await startWorkflowRun(context, {
        workspaceId: "workspace-1",
        scriptPath: "skill://parent-flow/workflow.js",
        args: { topic: "direct" },
      })
    ).toMatchObject({ status: "completed", result: { reportMarkdown: "parent:direct" } });
  });

  test("waits for idle and persists slash invocation inputs before starting", async () => {
    const workspacePath = path.join(temp.path, "checkout");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const activeProjectPath = path.join(workspacePath, "packages", "api");
    fs.mkdirSync(path.join(activeProjectPath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(activeProjectPath, ".mux", "workflows", "needs-project.js"),
      "const s = mux.schema;\n" +
        "export const meta = { argsSchema: s.object({ projectPath: s.string(), input: s.string() }) };\n" +
        "export default function workflow({ args }) { return { reportMarkdown: args.projectPath }; }\n"
    );
    const { context, workspaceService } = createContext({ workspacePath, subProjectPath });
    let releaseIdle: (() => void) | undefined;
    workspaceService.waitForWorkspaceIdle = mock(
      () => new Promise<void>((resolve) => (releaseIdle = resolve))
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });

    const start = startWorkflowRun(context, {
      workspaceId: "workspace-1",
      scriptPath: "./.mux/workflows/needs-project.js",
      runInBackground: true,
      args: { input: "hello" },
      rawCommand: "/workflow needs-project hello",
    });
    await waitFor(() => workspaceService.waitForWorkspaceIdle.mock.calls.length === 1);
    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(await runStore.listRuns()).toEqual([]);

    releaseIdle?.();
    const result = await start;
    const run = await runStore.getRun(result.runId);
    expect(result).toMatchObject({ status: "running", invocationMessagePersisted: true });
    expect(run.args).toEqual({ projectPath: activeProjectPath, input: "hello" });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        rawCommand: "/workflow needs-project hello",
        args: { input: "hello" },
        status: "running",
      })
    );
  });

  test("preserves workflow argument validation errors without coercing null", async () => {
    const workflows = [
      {
        name: "required.js",
        source:
          "const s = mux.schema;\n" +
          "export const meta = { argsSchema: s.object({ topic: s.string() }) };\n" +
          "export default function workflow() { return {}; }\n",
        args: {},
        message: "Workflow argument topic is required",
      },
      {
        name: "null.js",
        source:
          "const s = mux.schema;\n" +
          "export const meta = { argsSchema: s.object({ quick: s.optional(s.boolean()) }) };\n" +
          "export default function workflow() { return {}; }\n",
        args: null,
        message: "Workflow args must be an object for object argsSchema",
      },
      {
        name: "malformed.js",
        source:
          'export const meta = { argsSchema: { type: "object", properties: { topic: "bad" } } };\n' +
          "export default function workflow() { return {}; }\n",
        args: { topic: "hello" },
        message: "Workflow args property topic must be an object schema",
      },
    ];
    const { context } = createContext();

    for (const workflow of workflows) {
      fs.writeFileSync(path.join(projectPath, "workflows", workflow.name), workflow.source);
      try {
        await startWorkflowRun(context, {
          workspaceId: "workspace-1",
          scriptPath: "./workflows/" + workflow.name,
          args: workflow.args,
        });
        expect.unreachable("invalid workflow args must fail");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowArgsValidationError);
        expect(error).toHaveProperty("message", workflow.message);
      }
    }
  });

  test("rejects disabled dynamic workflows before workspace initialization", async () => {
    const { context, waitForInit } = createContext({ enabled: false });
    try {
      await startWorkflowRun(context, { workspaceId: "workspace-1", scriptPath: "demo" });
      expect.unreachable("disabled workflows must fail");
    } catch (error) {
      expect(error).toHaveProperty("message", "Dynamic workflows are disabled");
    }
    expect(waitForInit).not.toHaveBeenCalled();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
