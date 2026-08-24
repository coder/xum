/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ORPCError, createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { Config } from "@/node/config";
import { ProjectService } from "@/node/services/projectService";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ForegroundWaitBackgroundedError } from "@/node/services/taskService";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import type { ORPCContext } from "./context";
import { router } from "./router";

describe("router workspace goal validation", () => {
  test("goal routes do not touch goal files for unknown workspaces", async () => {
    const getGoal = mock(() => Promise.resolve({ goalId: "should-not-read" }));
    const clearGoal = mock(() => Promise.resolve({ goalId: "should-not-clear" }));
    const setGoal = mock(() =>
      Promise.resolve({ success: true, data: { goalId: "should-not-set" } })
    );
    const context = {
      workspaceService: {
        getInfo: mock(() => Promise.resolve(null)),
      },
      workspaceGoalService: {
        getGoal,
        clearGoal,
        setGoal,
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    const goalResult = await Promise.resolve(
      client.workspace.getGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(goalResult).toEqual({ goal: null });
    const clearResult = await Promise.resolve(
      client.workspace.clearGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(clearResult).toEqual({ cleared: false });
    const setResult = await Promise.resolve(
      client.workspace.setGoal({
        workspaceId: "../../tmp/not-a-workspace",
        objective: "do not write",
      })
    );
    expect(setResult).toEqual({
      success: false,
      error: { type: "invalid_transition", message: "Workspace not found." },
    });

    expect(getGoal).not.toHaveBeenCalled();
    expect(setGoal).not.toHaveBeenCalled();
    expect(clearGoal).not.toHaveBeenCalled();
  });
});

describe("router agent skill routes", () => {
  test("subproject workspaces inherit parent skills with nearest precedence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-skills-test-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const packagesRoot = path.join(checkoutRoot, "packages");
      const subProjectPath = path.join(packagesRoot, "app");
      const writeSkill = (root: string, name: string, description: string, body: string): void => {
        const skillDir = path.join(root, name);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
        );
      };

      fs.mkdirSync(subProjectPath, { recursive: true });
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "parent-only",
        "from checkout",
        "parent body"
      );
      writeSkill(
        path.join(checkoutRoot, ".mux", "skills"),
        "shared",
        "from checkout",
        "checkout body"
      );
      writeSkill(
        path.join(packagesRoot, ".agents", "skills"),
        "shared",
        "from packages",
        "packages body"
      );

      const outsideRoot = path.join(tempDir, "outside-skills");
      writeSkill(outsideRoot, "escaped", "outside checkout", "outside body");
      fs.symlinkSync(
        path.join(outsideRoot, "escaped"),
        path.join(checkoutRoot, ".mux", "skills", "escaped"),
        "dir"
      );

      const context = {
        config: new Config(tempDir),
        aiService: {
          waitForInit: mock(async () => undefined),
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: { type: "local", srcBaseDir: tempDir },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      const skills = await client.agentSkills.list({ workspaceId: "workspace-1" });
      expect(skills.find((skill) => skill.name === "parent-only")).toMatchObject({
        description: "from checkout",
        scope: "project",
      });
      expect(skills.find((skill) => skill.name === "shared")).toMatchObject({
        description: "from packages",
        scope: "project",
      });

      expect(skills.find((skill) => skill.name === "escaped")).toBeUndefined();
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "escaped" })
      ).rejects.toThrow("Agent skill not found");

      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "parent body\n" });
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "shared" })
      ).resolves.toMatchObject({ body: "packages body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("devcontainer workspaces read inherited skills from host-local storage", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-devcontainer-skills-"));
    try {
      const checkoutRoot = path.join(tempDir, "checkout");
      const subProjectPath = path.join(checkoutRoot, "packages", "app");
      const skillDir = path.join(checkoutRoot, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nHost parent body\n"
      );

      const context = {
        config: new Config(tempDir),
        aiService: {
          waitForInit: mock(async () => undefined),
          resolveXumToolScopeForWorkspace: mock(() => ({
            type: "project",
            xumHome: tempDir,
            projectRoot: subProjectPath,
            projectStorageAuthority: "host-local",
            checkoutRoot,
          })),
          getWorkspaceMetadata: mock(async () => ({
            success: true,
            data: {
              id: "workspace-1",
              name: "workspace-1",
              projectPath: checkoutRoot,
              namedWorkspacePath: checkoutRoot,
              subProjectPath,
              runtimeConfig: {
                type: "devcontainer",
                configPath: ".devcontainer/devcontainer.json",
              },
            },
          })),
        },
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(client.agentSkills.list({ workspaceId: "workspace-1" })).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
      await expect(
        client.agentSkills.get({ workspaceId: "workspace-1", skillName: "parent-only" })
      ).resolves.toMatchObject({ body: "Host parent body\n" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("project-path discovery inherits skills from a registered parent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-project-skills-test-"));
    try {
      const parentProjectPath = path.join(tempDir, "checkout");
      const subProjectPath = path.join(parentProjectPath, "packages", "app");
      const skillDir = path.join(parentProjectPath, ".mux", "skills", "parent-only");
      fs.mkdirSync(subProjectPath, { recursive: true });
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: parent-only\ndescription: Parent skill\n---\nParent body\n"
      );

      const config = new Config(tempDir);
      await config.editConfig((current) => {
        current.projects.set(parentProjectPath, { workspaces: [] });
        current.projects.set(subProjectPath, {
          workspaces: [],
          parentProjectPath,
        });
        return current;
      });
      const context = {
        config,
        experimentsService: {
          isExperimentEnabled: mock(() => false),
        },
      } as unknown as ORPCContext;
      const client = createRouterClient(router(), { context });

      await expect(
        client.agentSkills.list({ projectPath: subProjectPath })
      ).resolves.toContainEqual(
        expect.objectContaining({
          name: "parent-only",
          description: "Parent skill",
          scope: "project",
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForRouterCondition(
  description: string,
  predicate: () => boolean
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForRouterWorkflowStatus(
  client: {
    workflows: {
      getRun(input: { workspaceId: string; runId: string }): Promise<{ status: string } | null>;
    };
  },
  workspaceId: string,
  runId: string,
  status: string
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const run = await client.workflows.getRun({ workspaceId, runId });
    if (run?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const run = await client.workflows.getRun({ workspaceId, runId });
  throw new Error(`Timed out waiting for ${runId} to become ${status}; got ${run?.status}`);
}

describe("router workflow routes", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-workflows-test-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    fs.mkdirSync(path.join(projectPath, ".mux", "workflows"), { recursive: true });
    fs.mkdirSync(path.join(projectPath, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, "workflows", "demo.js"),
      `export const meta = { description: "Demo workflow" };\nexport default function workflow({ args }) { return { reportMarkdown: args.topic }; }\n`
    );
    await config.editConfig((current) => {
      current.projects.set(projectPath, { workspaces: [], trusted: true });
      return current;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(options: {
    enabled: boolean;
    workspacePath?: string;
    subProjectPath?: string;
    runtimeConfig?: { type: "devcontainer"; configPath: string };
  }): ORPCContext {
    const workspacePath = options.workspacePath ?? projectPath;
    return {
      workflowRuntimeFactory: new QuickJSRuntimeFactory(),
      config,
      aiService: {
        waitForInit: mock(async () => undefined),
        resolveXumToolScopeForWorkspace: mock((_metadata, _runtime, executionPath) => ({
          type: "project",
          xumHome: tempDir,
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
            runtimeConfig: options.runtimeConfig ?? { type: "local", srcBaseDir: tempDir },
          },
        })),
      },
      workspaceService: {
        emitWorkflowRunActivity: mock(async () => undefined),
        waitForWorkspaceIdle: mock(async () => undefined),
        prepareManualWorkflowInvocation: mock(async () => undefined),
        appendWorkflowRunInvocation: mock(async () => true),
        isWorkflowInvocationCurrent: mock(async () => false),
        getWorkflowContinuationSendOptions: mock(() => null),
        sendMessage: mock(async () => ({ success: true, data: undefined })),
      },
      taskService: {},
      experimentsService: {
        isExperimentEnabled: mock(() => options.enabled),
      },
    } as unknown as ORPCContext;
  }

  test("interrupts and resumes workflow runs through the API", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_resume",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "built-in",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source:
        "export default function workflow() { return { reportMarkdown: 'resumed via api' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });

    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.interrupt({ workspaceId: "workspace-1", runId: "wfr_api_resume" })
    ).resolves.toMatchObject({ id: "wfr_api_resume", status: "interrupted" });
    await expect(
      client.workflows.resume({ workspaceId: "workspace-1", runId: "wfr_api_resume" })
    ).resolves.toEqual({
      runId: "wfr_api_resume",
      status: "running",
      result: null,
    });
    await waitForRouterWorkflowStatus(client, "workspace-1", "wfr_api_resume", "completed");
  });

  test("retries a recoverable failed workflow through the API", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_retry",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "built-in",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source:
        "export default function workflow() { return { reportMarkdown: 'retried via api' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendEvent("wfr_api_retry", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_api_retry", "failed", "2026-05-29T00:00:00.751Z");
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    await expect(
      client.workflows.retryFromCheckpoint({ workspaceId: "workspace-1", runId: "wfr_api_retry" })
    ).resolves.toEqual({
      runId: "wfr_api_retry",
      status: "running",
      result: null,
    });
    await waitForRouterWorkflowStatus(client, "workspace-1", "wfr_api_retry", "completed");
  });

  test("continues current workflow invocations after checkpoint retry completes", async () => {
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    await runStore.createRun({
      id: "wfr_api_retry_continue",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "built-in",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source:
        "export default function workflow() { return { reportMarkdown: 'continued after retry' }; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    await runStore.appendEvent("wfr_api_retry_continue", {
      sequence: 1,
      type: "error",
      at: "2026-05-29T00:00:00.750Z",
      message: "Execution interrupted",
    });
    await runStore.appendStatus("wfr_api_retry_continue", "failed", "2026-05-29T00:00:00.751Z");
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      isWorkflowInvocationCurrent: ReturnType<typeof mock>;
      getWorkflowContinuationSendOptions: ReturnType<typeof mock>;
      sendMessage: ReturnType<typeof mock>;
    };
    workspaceService.isWorkflowInvocationCurrent = mock(async () => true);
    workspaceService.getWorkflowContinuationSendOptions = mock(() => ({
      model: "test:model",
      agentId: "exec",
    }));
    workspaceService.sendMessage = mock(async () => ({ success: true, data: undefined }));
    const client = createRouterClient(router(), { context });

    await expect(
      client.workflows.retryFromCheckpoint({
        workspaceId: "workspace-1",
        runId: "wfr_api_retry_continue",
      })
    ).resolves.toEqual({
      runId: "wfr_api_retry_continue",
      status: "running",
      result: null,
    });
    await waitForRouterCondition(
      "checkpoint retry continuation",
      () => workspaceService.sendMessage.mock.calls.length === 1
    );

    expect(workspaceService.sendMessage.mock.calls[0]?.[0]).toBe("workspace-1");
    expect(workspaceService.sendMessage.mock.calls[0]?.[1]).toContain("<mux_workflow_result>");
    expect(workspaceService.sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "test:model",
      agentId: "exec",
      skipAiSettingsPersistence: true,
      muxMetadata: {
        type: "workflow-result",
        rawCommand: "workflow_run ./workflows/demo.js",
        commandPrefix: "workflow_run",
        runId: "wfr_api_retry_continue",
        requestedModel: "test:model",
      },
    });
    expect(workspaceService.sendMessage.mock.calls[0]?.[3]).toMatchObject({
      skipAutoResumeReset: true,
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
      startStreamInBackground: true,
    });
  });

  test("starts a trusted project-local workflow through the API", async () => {
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./workflows/demo.js",
      args: { topic: "workflow routes" },
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toMatch(/^wfr_/);
    expect(result.result).toEqual({ reportMarkdown: "workflow routes" });

    await expect(
      client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId })
    ).resolves.toMatchObject({
      id: result.runId,
      workspaceId: "workspace-1",
      workflow: expect.objectContaining({ name: "demo" }),
      status: "completed",
    });
    await expect(client.workflows.listRuns({ workspaceId: "workspace-1" })).resolves.toEqual([
      expect.objectContaining({ id: result.runId, status: "completed" }),
    ]);
  });

  test("starts relative workflow scripts from the active subproject", async () => {
    const subProjectPath = path.join(projectPath, "packages", "app");
    fs.mkdirSync(path.join(subProjectPath, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(subProjectPath, "workflows", "demo.js"),
      `export const meta = { description: "Subproject workflow" };\nexport default function workflow({ args }) { return { reportMarkdown: "subproject:" + args.topic }; }\n`
    );
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, subProjectPath }),
    });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./workflows/demo.js",
      args: { topic: "workflow routes" },
    });

    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ reportMarkdown: "subproject:workflow routes" });
  });

  test("discovers and starts skill workflows inherited by a subproject", async () => {
    const subProjectPath = path.join(projectPath, "packages", "app");
    const skillDir = path.join(projectPath, ".mux", "skills", "parent-flow");
    fs.mkdirSync(subProjectPath, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: parent-flow\ndescription: Parent workflow\n---\nRun the parent workflow.\n"
    );
    fs.writeFileSync(
      path.join(skillDir, "workflow.js"),
      `export const meta = { description: "Parent workflow" };\nexport default function workflow({ args }) { return { reportMarkdown: "parent:" + args.topic }; }\n`
    );
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, subProjectPath }),
    });

    const scripts = await client.workflows.listScripts({ workspaceId: "workspace-1" });
    expect(scripts).toContainEqual(
      expect.objectContaining({
        descriptor: expect.objectContaining({ scope: "project" }),
        scriptPath: "skill://parent-flow/workflow.js",
      })
    );

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "skill://parent-flow/workflow.js",
      args: { topic: "workflow routes" },
    });
    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ reportMarkdown: "parent:workflow routes" });

    const devcontainerClient = createRouterClient(router(), {
      context: createContext({
        enabled: true,
        subProjectPath,
        runtimeConfig: {
          type: "devcontainer",
          configPath: ".devcontainer/devcontainer.json",
        },
      }),
    });
    await expect(
      devcontainerClient.workflows.listScripts({ workspaceId: "workspace-1" })
    ).resolves.toContainEqual(
      expect.objectContaining({ scriptPath: "skill://parent-flow/workflow.js" })
    );
    await expect(
      devcontainerClient.workflows.start({
        workspaceId: "workspace-1",
        scriptPath: "skill://parent-flow/workflow.js",
        args: { topic: "devcontainer" },
      })
    ).resolves.toMatchObject({
      status: "completed",
      result: { reportMarkdown: "parent:devcontainer" },
    });
  });

  test("persists workflow slash invocations before returning", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./workflows/demo.js",
      runInBackground: true,
      args: { input: "workflow routes" },
      rawCommand: "/demo workflow routes",
    });

    expect(result).toMatchObject({
      status: "running",
      invocationMessagePersisted: true,
    });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        rawCommand: "/demo workflow routes",
        scriptPath: "./workflows/demo.js",
        args: { input: "workflow routes" },
        runId: result.runId,
        status: "running",
      })
    );
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });

  test("fills projectPath defaults for slash workflow arg schemas", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "needs-project-path.js"),
      `const s = mux.schema;
export const meta = {
  description: "Needs project path",
  argsSchema: s.object({
    projectPath: s.string(),
    input: s.optional(s.string()),
  }),
};
export default function workflow({ args }) { return { reportMarkdown: args.projectPath + ":" + args.input }; }
`
    );
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./.mux/workflows/needs-project-path.js",
      runInBackground: true,
      args: { input: "hello" },
      rawCommand: "/workflow needs-project-path hello",
    });

    const run = await client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId });
    expect(run?.args).toEqual({ projectPath, input: "hello" });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { input: "hello" },
        rawCommand: "/workflow needs-project-path hello",
      })
    );
  });

  test("fills slash projectPath defaults from the active sub-project checkout", async () => {
    const workspacePath = path.join(tempDir, "workspace-checkout");
    const subProjectPath = path.join(projectPath, "packages", "api");
    const workspaceSubProjectPath = path.join(workspacePath, "packages", "api");
    fs.mkdirSync(path.join(workspaceSubProjectPath, ".mux", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceSubProjectPath, ".mux", "workflows", "needs-active-project.js"),
      `const s = mux.schema;
export const meta = {
  description: "Needs active project",
  argsSchema: s.object({ projectPath: s.string() }),
};
export default function workflow({ args }) { return { reportMarkdown: args.projectPath }; }
`
    );
    const client = createRouterClient(router(), {
      context: createContext({ enabled: true, workspacePath, subProjectPath }),
    });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./.mux/workflows/needs-active-project.js",
      runInBackground: true,
      args: {},
      rawCommand: "/workflow needs-active-project",
    });

    const run = await client.workflows.getRun({ workspaceId: "workspace-1", runId: result.runId });
    expect(run?.args).toEqual({ projectPath: workspaceSubProjectPath });
  });

  test("reports workflow argument validation as a bad request", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "needs-topic.js"),
      `const s = mux.schema;
export const meta = {
  description: "Needs topic",
  argsSchema: s.object({ topic: s.string() }),
};
export default function workflow({ args }) { return { reportMarkdown: args.topic }; }
`
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    let thrown: unknown;
    try {
      await client.workflows.start({
        workspaceId: "workspace-1",
        scriptPath: "./.mux/workflows/needs-topic.js",
        args: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as { code?: string }).code).toBe("BAD_REQUEST");
    expect(thrown).toHaveProperty("message", "Workflow argument topic is required");
  });

  test("preserves explicit null workflow args for object-schema validation", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "optional-args.js"),
      `const s = mux.schema;
export const meta = {
  description: "Optional args",
  argsSchema: s.object({ quick: s.optional(s.boolean()) }),
};
export default function workflow({ args }) { return { reportMarkdown: String(args.quick) }; }
`
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    let thrown: unknown;
    try {
      await client.workflows.start({
        workspaceId: "workspace-1",
        scriptPath: "./.mux/workflows/optional-args.js",
        args: null,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as { code?: string }).code).toBe("BAD_REQUEST");
    expect(thrown).toHaveProperty(
      "message",
      "Workflow args must be an object for object argsSchema"
    );
  });

  test("reports malformed workflow argument schemas as a bad request", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "bad-args-schema.js"),
      `export const meta = {
  description: "Bad args schema",
  argsSchema: { type: "object", properties: { topic: "bad" } },
};
export default function workflow() { return { reportMarkdown: "should not run" }; }
`
    );
    const client = createRouterClient(router(), { context: createContext({ enabled: true }) });

    let thrown: unknown;
    try {
      await client.workflows.start({
        workspaceId: "workspace-1",
        scriptPath: "./.mux/workflows/bad-args-schema.js",
        args: { topic: "hello" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as { code?: string }).code).toBe("BAD_REQUEST");
    expect(thrown).toHaveProperty(
      "message",
      "Workflow args property topic must be an object schema"
    );
  });

  test("waits for chat idle before starting slash workflow invocations", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      waitForWorkspaceIdle: ReturnType<typeof mock>;
      prepareManualWorkflowInvocation: ReturnType<typeof mock>;
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
    };
    let releaseIdle: (() => void) | undefined;
    workspaceService.waitForWorkspaceIdle = mock(
      () =>
        new Promise<void>((resolve) => {
          releaseIdle = resolve;
        })
    );
    const runStore = new WorkflowRunStore({ sessionDir: config.getSessionDir("workspace-1") });
    const client = createRouterClient(router(), { context });

    const startPromise = client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./workflows/demo.js",
      runInBackground: true,
      args: { topic: "queued until idle" },
      rawCommand: "/demo queued until idle",
    });

    await waitForRouterCondition(
      "slash workflow idle barrier",
      () => workspaceService.waitForWorkspaceIdle.mock.calls.length === 1
    );
    expect(workspaceService.waitForWorkspaceIdle).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ manualFollowUp: true })
    );
    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(await runStore.listRuns()).toEqual([]);
    expect(workspaceService.appendWorkflowRunInvocation).not.toHaveBeenCalled();

    releaseIdle?.();
    const result = await startPromise;

    expect(workspaceService.prepareManualWorkflowInvocation).toHaveBeenCalledWith("workspace-1");
    expect(result).toMatchObject({ status: "running", invocationMessagePersisted: true });
    expect(workspaceService.appendWorkflowRunInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        rawCommand: "/demo queued until idle",
        status: "running",
      })
    );
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });

  test("waits for foreground slash invocation persistence before terminal continuation", async () => {
    fs.writeFileSync(
      path.join(projectPath, ".mux", "workflows", "backgroundable.js"),
      "export const meta = { description: \"Backgroundable workflow\" };\nexport default function workflow({ agent }) { return agent('slow', { id: 'slow-step' }); }\n"
    );
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      appendWorkflowRunInvocation: ReturnType<typeof mock>;
      isWorkflowInvocationCurrent: ReturnType<typeof mock>;
      sendMessage: ReturnType<typeof mock>;
    };
    let releaseInvocationPersistence: (() => void) | undefined;
    workspaceService.appendWorkflowRunInvocation = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseInvocationPersistence = resolve;
      });
      return true;
    });
    workspaceService.isWorkflowInvocationCurrent = mock(async () => true);
    workspaceService.sendMessage = mock(async () => ({ success: true, data: {} }));

    let waitCalls = 0;
    context.taskService = {
      create: mock(async () => ({ success: true, data: { taskId: "task_slow" } })),
      waitForAgentReport: mock(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw new ForegroundWaitBackgroundedError();
        }
        return { reportMarkdown: "done", structuredOutput: {} };
      }),
    } as unknown as ORPCContext["taskService"];

    const client = createRouterClient(router(), { context });
    const startPromise = client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./.mux/workflows/backgroundable.js",
      args: { input: "slow" },
      rawCommand: "/backgroundable slow",
      continuationOptions: { model: "test:model", agentId: "exec" },
    });

    await waitForRouterCondition(
      "foreground invocation persistence to start",
      () => workspaceService.appendWorkflowRunInvocation.mock.calls.length === 1
    );
    await waitForRouterCondition(
      "background resume to finish its agent wait",
      () => waitCalls === 2
    );
    expect(workspaceService.sendMessage).not.toHaveBeenCalled();
    releaseInvocationPersistence?.();

    const result = await startPromise;
    expect(result).toMatchObject({ status: "backgrounded", invocationMessagePersisted: true });
    await waitForRouterCondition(
      "workflow terminal continuation to send after invocation persistence",
      () => workspaceService.sendMessage.mock.calls.length === 1
    );
    expect(workspaceService.sendMessage.mock.calls[0]?.[0]).toBe("workspace-1");
    expect(workspaceService.sendMessage.mock.calls[0]?.[1]).toContain("<mux_workflow_result>");
  });

  test("starts a workflow in the background when requested through the API", async () => {
    const context = createContext({ enabled: true });
    const workspaceService = context.workspaceService as unknown as {
      waitForWorkspaceIdle: ReturnType<typeof mock>;
      prepareManualWorkflowInvocation: ReturnType<typeof mock>;
    };
    const client = createRouterClient(router(), { context });

    const result = await client.workflows.start({
      workspaceId: "workspace-1",
      scriptPath: "./workflows/demo.js",
      runInBackground: true,
      args: { topic: "background workflow routes" },
    });

    expect(workspaceService.prepareManualWorkflowInvocation).not.toHaveBeenCalled();
    expect(workspaceService.waitForWorkspaceIdle).not.toHaveBeenCalled();
    expect(result.status).toBe("running");
    expect(result.runId).toMatch(/^wfr_/);
    expect(result.result).toBeNull();
    await waitForRouterWorkflowStatus(client, "workspace-1", result.runId, "completed");
  });
});

describe("router config.saveConfig", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    // saveConfig only touches Config and TaskService, so this partial context keeps the
    // router-level test focused on the config mutation under test.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Other services are not used by saveConfig.
    return {
      config,
      taskService: {
        maybeStartQueuedTasks: () => Promise.resolve(undefined),
      },
    } as ORPCContext;
  }

  test("persists canonical nested subagent agent defaults", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      agentAiDefaults: {
        foo: {
          modelString: "anthropic:claude-3-5-sonnet",
          thinkingLevel: "high",
          enabled: true,
          advisorEnabled: true,
          subagent: {
            modelString: "openai:gpt-5.6-sol",
            thinkingLevel: "xhigh",
            reasoningMode: "pro",
          },
        },
      },
    });

    const saved = config.loadConfigOrDefault();
    const output = await client.config.getConfig();

    expect(saved.agentAiDefaults?.foo).toEqual({
      modelString: "anthropic:claude-3-5-sonnet",
      thinkingLevel: "high",
      enabled: true,
      advisorEnabled: true,
      subagent: {
        modelString: "openai:gpt-5.6-sol",
        thinkingLevel: "xhigh",
        reasoningMode: "pro",
      },
    });
    expect(output.agentAiDefaults?.foo?.subagent?.reasoningMode).toBe("pro");
    expect("subagentAiDefaults" in output).toBe(false);
  });

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);

    await client.config.updateChatTranscriptFullWidth({ enabled: true });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });

  test("getConfig and saveConfig round trip user preferences", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      userPreferences: {
        appearance: { theme: "dark" },
        notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
      },
    });

    expect((await client.config.getConfig()).userPreferencesInitialized).toBe(true);
    expect((await client.config.getConfig()).userPreferences).toEqual({
      appearance: { theme: "dark" },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
    });
    expect(config.loadConfigOrDefault().userPreferences).toEqual({
      appearance: { theme: "dark" },
      notifications: { notifyOnResponseByWorkspace: { "ws-1": true } },
    });
  });

  test("saveConfig preserves task settings when user preference saves omit them", async () => {
    await config.editConfig((current) => ({
      ...current,
      taskSettings: {
        ...DEFAULT_TASK_SETTINGS,
        maxParallelAgentTasks: 7,
        preserveSubagentsUntilArchive: true,
      },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      userPreferences: { appearance: { theme: "dark" } },
    });

    expect(config.loadConfigOrDefault().taskSettings).toEqual({
      ...DEFAULT_TASK_SETTINGS,
      maxParallelAgentTasks: 7,
      preserveSubagentsUntilArchive: true,
    });
  });

  test("saveConfig clears user preferences when explicitly set to null", async () => {
    await config.editConfig((current) => ({
      ...current,
      userPreferences: { appearance: { theme: "flexoki-light" } },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      userPreferences: null,
    });

    expect((await client.config.getConfig()).userPreferencesInitialized).toBe(true);
    expect(config.loadConfigOrDefault().userPreferences).toBeUndefined();
  });

  test("saveConfig preserves existing user preferences when omitted", async () => {
    await config.editConfig((current) => ({
      ...current,
      userPreferences: { appearance: { theme: "flexoki-light" } },
    }));
    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      advisorModelString: null,
    });

    expect(config.loadConfigOrDefault().userPreferences).toEqual({
      appearance: { theme: "flexoki-light" },
    });
  });

  test("preserves optional task settings when a save omits them", async () => {
    await config.editConfig((current) => ({
      ...current,
      taskSettings: {
        ...DEFAULT_TASK_SETTINGS,
        preserveSubagentsUntilArchive: true,
        proposePlanImplementReplacesChatHistory: true,
      },
    }));

    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      // Simulate an older/unrelated settings client that only sends the originally required
      // task limits. Optional task flags must stay sticky, or the sub-agent preservation toggle
      // silently turns itself off before cleanup evaluates it.
      taskSettings: {
        maxParallelAgentTasks: 4,
        maxTaskNestingDepth: 5,
      },
      advisorModelString: null,
    });

    const saved = config.loadConfigOrDefault();
    const savedTaskSettings = saved.taskSettings;
    if (!savedTaskSettings) {
      throw new Error("Expected saved task settings");
    }

    expect(savedTaskSettings.maxParallelAgentTasks).toBe(4);
    expect(savedTaskSettings.maxTaskNestingDepth).toBe(5);
    expect(savedTaskSettings.preserveSubagentsUntilArchive).toBe(true);
    expect(savedTaskSettings.proposePlanImplementReplacesChatHistory).toBe(true);
  });
});

describe("projects.setCodeWorkspaceSyncPath", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-codews-test-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    fs.mkdirSync(projectPath, { recursive: true });
    await config.editConfig((current) => {
      current.projects.set(projectPath, { workspaces: [] });
      return current;
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createClient() {
    return createRouterClient(router(), {
      context: { config } as unknown as ORPCContext,
    });
  }

  test("rejects paths without the .code-workspace extension with a client-visible error", async () => {
    const client = createClient();
    let thrown: unknown;
    try {
      await client.projects.setCodeWorkspaceSyncPath({
        projectPath,
        codeWorkspaceSyncPath: "/tmp/notes.txt",
      });
    } catch (error) {
      thrown = error;
    }
    // Must be an ORPCError so the extension hint reaches the UI instead of
    // a generic "Internal server error".
    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as ORPCError<string, unknown>).message).toContain(".code-workspace");
    expect(
      config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath
    ).toBeUndefined();
  });

  test("stores the path and writes the workspace file immediately", async () => {
    const client = createClient();
    await client.projects.setCodeWorkspaceSyncPath({
      projectPath,
      codeWorkspaceSyncPath: "  proj.code-workspace  ",
    });

    expect(config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath).toBe(
      "proj.code-workspace"
    );
    const written = JSON.parse(
      fs.readFileSync(path.join(projectPath, "proj.code-workspace"), "utf-8")
    ) as { folders: Array<{ path: string }> };
    expect(written.folders).toEqual([{ path: projectPath }]);
  });

  test("surfaces sync failures on explicit save and rolls the setting back", async () => {
    // A malformed target must fail the save visibly instead of persisting a
    // broken integration that silently retries on every lifecycle event.
    fs.writeFileSync(path.join(projectPath, "broken.code-workspace"), "{ not valid jsonc");
    const client = createClient();

    let thrown: unknown;
    try {
      await client.projects.setCodeWorkspaceSyncPath({
        projectPath,
        codeWorkspaceSyncPath: "broken.code-workspace",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ORPCError);
    expect((thrown as ORPCError<string, unknown>).message).toContain("not valid JSONC");
    expect(
      config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath
    ).toBeUndefined();
  });

  test("clearing the setting removes it without deleting the existing file", async () => {
    const client = createClient();
    await client.projects.setCodeWorkspaceSyncPath({
      projectPath,
      codeWorkspaceSyncPath: "proj.code-workspace",
    });
    await client.projects.setCodeWorkspaceSyncPath({
      projectPath,
      codeWorkspaceSyncPath: null,
    });

    expect(
      config.loadConfigOrDefault().projects.get(projectPath)?.codeWorkspaceSyncPath
    ).toBeUndefined();
    expect(fs.existsSync(path.join(projectPath, "proj.code-workspace"))).toBe(true);
  });

  test("reassigning a workspace between sub-projects syncs both workspace files", async () => {
    const subProjectA = path.join(projectPath, "packages", "a");
    const subProjectB = path.join(projectPath, "packages", "b");
    fs.mkdirSync(subProjectA, { recursive: true });
    fs.mkdirSync(subProjectB, { recursive: true });
    const worktreePath = path.join(config.srcDir, "project", "feat-1");
    // Checkout must exist on disk or metadata is marked transcript-only.
    fs.mkdirSync(worktreePath, { recursive: true });
    await config.editConfig((current) => {
      current.projects.set(projectPath, {
        workspaces: [
          {
            path: worktreePath,
            id: "aaaaaaaaaa",
            name: "feat-1",
            runtimeConfig: { type: "worktree", srcBaseDir: config.srcDir },
            subProjectPath: subProjectA,
          },
        ],
      });
      current.projects.set(subProjectA, {
        workspaces: [],
        parentProjectPath: projectPath,
        codeWorkspaceSyncPath: "a.code-workspace",
      });
      current.projects.set(subProjectB, {
        workspaces: [],
        parentProjectPath: projectPath,
        codeWorkspaceSyncPath: "b.code-workspace",
      });
      return current;
    });
    const fileA = path.join(subProjectA, "a.code-workspace");
    const fileB = path.join(subProjectB, "b.code-workspace");
    // File A already lists the workspace, as a prior sync would have left it.
    fs.writeFileSync(fileA, JSON.stringify({ folders: [{ path: worktreePath }] }));

    const client = createRouterClient(router(), {
      context: {
        config,
        projectService: new ProjectService(config),
        workspaceService: { refreshAndEmitMetadata: async () => undefined },
      } as unknown as ORPCContext,
    });
    const result = await client.projects.subProjects.assignWorkspace({
      projectPath,
      workspaceId: "aaaaaaaaaa",
      subProjectPath: subProjectB,
    });

    expect(result.success).toBe(true);
    const foldersOf = (file: string) =>
      (JSON.parse(fs.readFileSync(file, "utf-8")) as { folders: Array<{ path: string }> }).folders;
    expect(foldersOf(fileA).map((f) => f.path)).not.toContain(worktreePath);
    expect(foldersOf(fileB).map((f) => f.path)).toContain(worktreePath);
  });
});
