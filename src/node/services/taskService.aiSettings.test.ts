import * as path from "path";
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fsPromises from "fs/promises";
import * as os from "os";
import { Config, type ProjectsConfig, type Workspace as WorkspaceConfigEntry } from "@/node/config";
import { HistoryService } from "@/node/services/historyService";
import { readSubagentReportArtifact } from "@/node/services/subagentReportArtifacts";
import { findWorkspaceEntry } from "@/node/services/taskUtils";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import {
  formatReawakenChangedMessage,
  formatReawakenCommitRefusedMessage,
} from "@/constants/taskMessages";
import type { TaskService } from "@/node/services/taskService";
import { isActiveWorkspaceTurnTaskStatus, TaskHandleStore } from "@/node/services/taskHandleStore";
import { log } from "@/node/services/log";
import * as resolveNodeAgentAiSettingsModule from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import { Ok, Err, type Result } from "@/common/types/result";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { SendMessageError } from "@/common/types/errors";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { WorkspaceHost } from "@/node/services/taskWorkspaceSeam";
import { InitStateManager as RealInitStateManager } from "@/node/services/initStateManager";
import assert from "node:assert";
import {
  createAIServiceMocks,
  createTestConfig,
  createTestProject,
  createWorkspaceServiceMocks,
  findWorkspaceInConfig,
  saveLocalParentWorkspace,
  saveWorkspaces,
  stubStableIds,
  testTaskSettings,
  workspaceTurnManagerFor,
  workspaceTurnManagerInternals,
  writeCustomAgentDefinition,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
  waitForWorkspaceTaskStatus,
} from "@/node/services/taskService.shared.testHarness";

describe("TaskService", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
  });
  afterEach(async () => {
    await removeTaskServiceTestRoot(rootDir);
  });

  async function workspaceGoalFileExists(config: Config, workspaceId: string): Promise<boolean> {
    try {
      await fsPromises.access(path.join(config.sessionsDir, workspaceId, "goal.json"));
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  test("inherits parent model + thinking when target agent has no global defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with inherited model", {
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with inherited model",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("inherits parent workspace model + thinking when create args omit model and thinking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run task inheriting parent settings"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task inheriting parent settings",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("inherits the parent's pro reasoning mode into task sends and child settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task inheriting pro mode");
    expect(created.success).toBe(true);
    if (!created.success) return;

    // The child's kickoff send must carry the parent's pro mode (the send path
    // re-gates per model, so this is safe even for non-GPT-5.6 task models).
    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task inheriting pro mode",
      {
        model: "openai:gpt-5.6-sol",
        agentId: "explore",
        thinkingLevel: "high",
        reasoningMode: "pro",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    // Persisted child settings carry it too, so queued/restart resumes
    // (which rebuild options from the record) keep pro mode.
    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
  }, 20_000);

  test("inherits the exec base's configured pro default when spawning an agent without its own", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Parent runs standard; the pro must come from the configured exec
          // default via Explore's base chain, matching Settings/ACP display.
          aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: testTaskSettings(),
        agentAiDefaults: { exec: { reasoningMode: "pro" } },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run explore with base pro");
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run explore with base pro",
      expect.objectContaining({ agentId: "explore", reasoningMode: "pro" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("falls back to the parent's active-agent pro mode when spawning another agent type", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // Pro was toggled while the exec agent was active; the spawned
          // explore agent has no per-agent bucket of its own, so inheritance
          // must fall back to the parent's active-agent settings.
          agentId: "exec",
          aiSettingsByAgent: {
            exec: { model: "openai:gpt-5.6-sol", thinkingLevel: "high", reasoningMode: "pro" },
          },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run explore with parent pro mode"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run explore with parent pro mode",
      expect.objectContaining({ agentId: "explore", reasoningMode: "pro" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("keeps a mapped alias's native max thinking level when spawning a task", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // A configured alias mapped to GPT-5.6: without the providers config
          // threaded into the task-path clamp, "max" would be downgraded to
          // "high" against the default four-level ladder.
          aiSettings: { model: "openai:team-sol", thinkingLevel: "max" },
        },
      ],
      testTaskSettings()
    );

    const providersConfig: ProvidersConfigMap = {
      openai: {
        apiKeySet: true,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "team-sol", mappedToModel: "openai:gpt-5.6-sol" }],
      },
    };
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const aiMocks = createAIServiceMocks(config, {
      getProvidersConfig: mock(() => providersConfig),
    });
    const { taskService } = createTaskServiceHarness(config, {
      aiService: aiMocks.aiService,
      workspaceService,
    });

    const created = await createAgentTask(taskService, parentId, "run with mapped alias max");
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run with mapped alias max",
      expect.objectContaining({ model: "openai:team-sol", thinkingLevel: "max" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("resolves a numeric thinking override against the inherited model's policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          // opus-4-6 allows [off, low, medium, high, xhigh]; index 9 clamps to the highest (xhigh).
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "off" },
        },
      ],
      testTaskSettings()
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run with numeric thinking", {
      thinkingLevel: 9,
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run with numeric thinking",
      {
        model: "anthropic:claude-opus-4-6",
        agentId: "explore",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry?.taskModelString).toBe("anthropic:claude-opus-4-6");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("agentAiDefaults outrank workspace aiSettingsByAgent for same agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "high" },
          aiSettingsByAgent: {
            explore: { model: "openai:gpt-5.2-pro", thinkingLevel: "medium" },
          },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          explore: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run task with same-agent conflicts"
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with same-agent conflicts",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "explore",
        thinkingLevel: "off",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "anthropic:claude-haiku-4-5",
      thinkingLevel: "off",
    });
    expect(childEntry?.taskModelString).toBe("anthropic:claude-haiku-4-5");
    expect(childEntry?.taskThinkingLevel).toBe("off");
  }, 20_000);

  test("follows a custom agent's declared base chain for the reasoning default", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    // Custom agent declaring base: plan; the reasoning default must follow the
    // DECLARED chain (plan), not the hardcoded exec fallback.
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "researcher.md"),
      `---\nname: Researcher\ndescription: Plan-derived custom agent for tests\nbase: plan\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "openai:gpt-5.6-sol", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: testTaskSettings(),
        agentAiDefaults: {
          plan: { reasoningMode: "pro" },
          exec: { reasoningMode: "standard" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run researcher with plan pro", {
      agentType: "researcher",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run researcher with plan pro",
      expect.objectContaining({ agentId: "researcher", reasoningMode: "pro" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("does not inherit base-chain defaults when target agent has no global defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    // Custom agent definition stored in the project workspace (.mux/agents).
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "custom.md"),
      `---\nname: Custom\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with custom agent", {
      agentType: "custom",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with custom agent",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "custom",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );

    const postCfg = config.loadConfigOrDefault();
    const childEntry = Array.from(postCfg.projects.values())
      .flatMap((p) => p.workspaces)
      .find((w) => w.id === created.data.taskId);
    expect(childEntry).toBeTruthy();
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("explicit task args outrank agentAiDefaults on task create", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");

    const projectPath = await createTestProject(rootDir, "repo", { initGit: false });

    // Custom agent definition stored in the project workspace (.mux/agents).
    const agentsDir = path.join(projectPath, ".mux", "agents");
    await fsPromises.mkdir(agentsDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentsDir, "custom.md"),
      `---\nname: Custom\ndescription: Exec-derived custom agent for tests\nbase: exec\nsubagent:\n  runnable: true\n---\n\nTest agent body.\n`,
      "utf-8"
    );

    const parentId = "1111111111";
    await saveWorkspaces(
      config,
      projectPath,
      [
        {
          path: projectPath,
          id: parentId,
          name: "parent",
          createdAt: new Date().toISOString(),
          runtimeConfig: { type: "local" },
          aiSettings: { model: "anthropic:claude-opus-4-6", thinkingLevel: "high" },
        },
      ],
      {
        taskSettings: { maxParallelAgentTasks: 3, maxTaskNestingDepth: 3 },
        agentAiDefaults: {
          custom: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
        },
      }
    );

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with custom agent", {
      agentType: "custom",
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "off",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with custom agent",
      {
        model: "openai:gpt-4o-mini",
        agentId: "custom",
        thinkingLevel: "off",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("agent definition ai defaults outrank parent inheritance when spawning a sub-agent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath, [
      "ai:",
      "  model: openai:gpt-5.2",
      "  thinkingLevel: medium",
    ]);

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with pinned agent", {
      agentType: "custom",
      parentRuntimeAiSettings: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with pinned agent",
      {
        model: "openai:gpt-5.2",
        agentId: "custom",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "medium" });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("explicit task args outrank agent definition ai defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    await writeCustomAgentDefinition(projectPath, [
      "ai:",
      "  model: openai:gpt-5.2",
      "  thinkingLevel: medium",
    ]);

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with explicit model", {
      agentType: "custom",
      modelString: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with explicit model",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "custom",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("configured agent defaults outrank agent definition ai defaults", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        custom: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });
    await writeCustomAgentDefinition(projectPath, [
      "ai:",
      "  model: openai:gpt-5.2",
      "  thinkingLevel: medium",
    ]);

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with configured agent", {
      agentType: "custom",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with configured agent",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "custom",
        thinkingLevel: "off",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("agent definition ai.model abbreviations resolve and missing fields inherit per field", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    // Model-only ai block using a documented abbreviation; thinkingLevel must
    // still inherit from the parent (field-wise, not all-or-nothing).
    await writeCustomAgentDefinition(projectPath, ["ai:", "  model: haiku"]);

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(taskService, parentId, "run task with alias model", {
      agentType: "custom",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run task with alias model",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "custom",
        thinkingLevel: "high",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("task-created child workspaces do not inherit the parent's goal file", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["goalchild1"], "goalchild2");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const historyService = new HistoryService(config);
    const extensionMetadata = new ExtensionMetadataService(
      path.join(rootDir, "task-goal-extensionMetadata.json")
    );
    const workspaceGoalService = new WorkspaceGoalService(
      config,
      historyService,
      extensionMetadata
    );
    const result = await workspaceGoalService.setGoal({
      workspaceId: parentId,
      objective: "Parent owns the goal",
      budgetCents: 100,
    });
    expect(result.success).toBe(true);
    expect(await workspaceGoalFileExists(config, parentId)).toBe(true);

    const { workspaceService } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });
    const created = await createAgentTask(
      taskService,
      parentId,
      "child should not inherit a goal",
      {
        agentType: "exec",
        title: "No child goal",
      }
    );

    expect(created.success).toBe(true);
    assert(created.success);
    expect(await workspaceGoalFileExists(config, created.data.taskId)).toBe(false);
  }, 20_000);

  test("parent runtime AI settings outrank persisted parent workspace settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: "openai:gpt-5.2", thinkingLevel: "medium" },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with parent runtime fallback",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { modelString: "openai:gpt-5.3-codex" },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with parent runtime fallback",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("subagentAiDefaults outrank parent runtime AI settings", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "anthropic:claude-haiku-4-5", thinkingLevel: "off" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with configured default",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with configured default",
      {
        model: "anthropic:claude-haiku-4-5",
        agentId: "exec",
        thinkingLevel: "off",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe("anthropic:claude-haiku-4-5");
    expect(childEntry?.taskThinkingLevel).toBe("off");
  }, 20_000);

  test("parent runtime thinking hint is clamped by the resolved model policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const resolvedModel = "openai:gpt-5.5-pro";
    const requestedThinkingLevel: ThinkingLevel = "off";
    const expectedThinkingLevel = enforceThinkingPolicy(resolvedModel, requestedThinkingLevel);
    expect(expectedThinkingLevel).not.toBe(requestedThinkingLevel);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: resolvedModel, thinkingLevel: "high" },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with parent runtime thinking fallback",
      {
        agentType: "exec",
        parentRuntimeAiSettings: { thinkingLevel: requestedThinkingLevel },
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with parent runtime thinking fallback",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe(resolvedModel);
    expect(childEntry?.taskThinkingLevel).toBe(expectedThinkingLevel);
  }, 20_000);

  test("exec subagent inherits the calling chat Exec selection while parent is in Plan", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "anthropic:claude-fable-5-1" } },
    });
    await config.editConfig((cfg) => {
      const parent = cfg.projects.get(projectPath)!.workspaces[0];
      parent.agentId = "plan";
      parent.aiSettingsByAgent = {
        exec: { model: "openai:gpt-6-astra", thinkingLevel: "high" },
        plan: { model: "openai:gpt-5-pro", thinkingLevel: "medium" },
      };
      return cfg;
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const initStateManager = new RealInitStateManager(config);
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    });
    const created = await createAgentTask(taskService, parentId, "inherit saved Exec", {
      agentType: "exec",
      parentRuntimeAiSettings: { modelString: "openai:gpt-5-pro", thinkingLevel: "medium" },
    });
    assert(created.success);
    await initStateManager.waitForInit(created.data.taskId);
    expect(findWorkspaceInConfig(config, created.data.taskId)?.taskModelString).toBe(
      "openai:gpt-6-astra"
    );
    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "inherit saved Exec",
      expect.objectContaining({
        model: "openai:gpt-6-astra",
        agentId: "exec",
        thinkingLevel: "high",
      }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const child = findWorkspaceInConfig(config, created.data.taskId);
    expect(child?.taskModelString).toBe("openai:gpt-6-astra");
    expect(child?.aiSettings).toEqual({
      model: "openai:gpt-6-astra",
      thinkingLevel: "high",
      reasoningMode: "standard",
    });
  }, 20_000);

  test.each([
    { name: "legacy Exec", agentId: " ExEc ", expectedParent: true },
    { name: "legacy agentType Exec", agentType: "exec", expectedParent: true },
    { name: "legacy Plan", agentId: "plan", expectedParent: false },
    { name: "unknown mode", expectedParent: false },
    {
      name: "Plan beats stale Exec alias",
      agentId: "plan",
      agentType: "exec",
      expectedParent: false,
    },
    {
      name: "empty identity does not use legacy alias",
      agentId: "",
      agentType: "exec",
      expectedParent: false,
    },
    {
      name: "authentic equal Plan and Exec buckets",
      agentId: "plan",
      equalBuckets: true,
      expectedParent: true,
    },
  ])("Exec inheritance provenance: $name", async (scenario) => {
    const config = await createTestConfig(rootDir);
    const globalModel = "openai:gpt-5.2";
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: globalModel, thinkingLevel: "medium" } },
    });
    await config.editConfig((cfg) => {
      const parent = cfg.projects.get(projectPath)!.workspaces[0];
      parent.agentId = scenario.agentId;
      parent.agentType = scenario.agentType;
      if (scenario.equalBuckets) {
        assert(parent.aiSettings);
        parent.aiSettingsByAgent = { exec: parent.aiSettings, plan: parent.aiSettings };
      }
      return cfg;
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const initStateManager = new RealInitStateManager(config);
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    });
    const created = await createAgentTask(taskService, parentId, "check provenance", {
      agentType: "exec",
    });
    assert(created.success);
    await initStateManager.waitForInit(created.data.taskId);
    const expected = scenario.expectedParent ? "anthropic:claude-opus-4-6" : globalModel;
    expect(findWorkspaceInConfig(config, created.data.taskId)?.aiSettings?.model).toBe(expected);
    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "check provenance",
      expect.objectContaining({ model: expected }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  });

  test("grouped Exec children keep creation-time settings through queueing and reload; reactivation re-resolves", async () => {
    const config = await createTestConfig(rootDir);
    const model = "openai:gpt-5.2";
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "anthropic:claude-opus-4-6" } },
    });
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces[0].aiSettingsByAgent = {
        exec: { model, thinkingLevel: "high" },
      };
      cfg.taskSettings = testTaskSettings(1, 3);
      return cfg;
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const initStateManager = new RealInitStateManager(config);
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    });
    const created = await taskService.createMany(
      ["first", "queued"].map((prompt) => ({
        parentWorkspaceId: parentId,
        kind: "agent" as const,
        agentId: "exec",
        prompt,
        title: prompt,
      }))
    );
    assert(created.success);
    const [first, queued] = created.data;
    expect(created.data.map((child) => child.status)).toEqual(["starting", "queued"]);
    await waitForWorkspaceTaskStatus(config, first.taskId, "running");
    await initStateManager.waitForInit(first.taskId);
    for (const child of created.data) {
      expect(findWorkspaceInConfig(config, child.taskId)?.taskModelString).toBe(model);
    }
    await config.editConfig((cfg) => {
      const workspaces = cfg.projects.get(projectPath)!.workspaces;
      workspaces[0].aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.3-codex", thinkingLevel: "medium" },
      };
      cfg.agentAiDefaults = { exec: { modelString: "anthropic:claude-haiku-4-5" } };
      workspaces.find((workspace) => workspace.id === first.taskId)!.taskStatus = "reported";
      return cfg;
    });
    const reloaded = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    }).taskService;
    await reloaded.maybeStartQueuedTasks();
    await waitForWorkspaceTaskStatus(config, queued.taskId, "running");
    await initStateManager.waitForInit(queued.taskId);
    expect(sendMessage).toHaveBeenCalledWith(
      queued.taskId,
      "queued",
      expect.objectContaining({ model, thinkingLevel: "high" }),
      expect.anything()
    );
    await config.editConfig((cfg) => {
      cfg.projects
        .get(projectPath)!
        .workspaces.find((workspace) => workspace.id === queued.taskId)!.taskStatus = "reported";
      return cfg;
    });
    const reactivated = await reloaded.sendMessageToDescendantAgentTask(
      parentId,
      first.taskId,
      "continue",
      "tool-end"
    );
    expect(reactivated).toMatchObject({ success: true, data: { delivery: "reactivated" } });
    // An ancestor reawakening re-resolves from current settings: the parent chat's Exec
    // selection now outranks the base Exec default and the child's creation-time value.
    expect(sendMessage).toHaveBeenLastCalledWith(
      first.taskId,
      expect.any(String),
      expect.objectContaining({
        model: "openai:gpt-5.3-codex",
        thinkingLevel: "medium",
        skipAiSettingsPersistence: true,
      }),
      expect.anything()
    );
    // This mock never accepts the turn, so nothing was committed.
    expect(findWorkspaceInConfig(config, first.taskId)?.aiSettings?.model).toBe(model);
    expect(findWorkspaceInConfig(config, first.taskId)?.taskModelString).toBe(model);
  }, 20_000);

  describe("reawakened sub-agents follow current AI settings", () => {
    const SPAWN_MODEL = "openai:gpt-5.2";
    const MODEL_B = "openai:gpt-5.3-codex";
    const MODEL_C = "anthropic:claude-haiku-4-5";

    type AcceptingSend = ReturnType<typeof createAcceptingSendMessage>;

    /** Accepts the turn like a real send: runs onAccepted, converting its throw to Err. */
    function createAcceptingSendMessage(beforeAccept?: () => Promise<void>) {
      return mock(async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
        const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
        await beforeAccept?.();
        try {
          await internal?.onAccepted?.();
        } catch (error) {
          return Err({
            type: "unknown",
            raw: error instanceof Error ? error.message : String(error),
          });
        }
        return Ok(undefined);
      });
    }

    function lastSendOptions(sendMessage: ReturnType<typeof mock>): Record<string, unknown> {
      const options: unknown = sendMessage.mock.calls.at(-1)?.[2];
      assert(options != null && typeof options === "object", "expected a dispatched send");
      return options as Record<string, unknown>;
    }

    async function editEntry(
      config: Config,
      workspaceId: string,
      mutate: (workspace: WorkspaceConfigEntry, cfg: ProjectsConfig) => void
    ): Promise<void> {
      await config.editConfig((cfg) => {
        for (const project of cfg.projects.values()) {
          const workspace = project.workspaces.find((entry) => entry.id === workspaceId);
          if (workspace) mutate(workspace, cfg);
        }
        return cfg;
      });
    }

    async function setDelegatedExec(
      config: Config,
      subagent: { modelString?: string; thinkingLevel?: ThinkingLevel }
    ): Promise<void> {
      await config.editConfig((cfg) => {
        const exec = cfg.agentAiDefaults?.exec ?? {};
        cfg.agentAiDefaults = { ...cfg.agentAiDefaults, exec: { ...exec, subagent } };
        return cfg;
      });
    }

    async function spawnReportedChild(
      options: {
        spawn?: Partial<Parameters<TaskService["create"]>[0]>;
        sendMessage?: AcceptingSend;
        beforeSpawn?: (projectPath: string) => Promise<void>;
      } = {}
    ) {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
        agentAiDefaults: { exec: { modelString: SPAWN_MODEL, thinkingLevel: "high" } },
      });
      await options.beforeSpawn?.(projectPath);
      const sendMessage = options.sendMessage ?? createAcceptingSendMessage();
      const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
      const initStateManager = new RealInitStateManager(config);
      const harness = createTaskServiceHarness(config, { workspaceService, initStateManager });
      const created = await createAgentTask(harness.taskService, parentId, "child", {
        agentType: "exec",
        ...options.spawn,
      });
      assert(created.success, created.success ? "" : created.error);
      const childId = created.data.taskId;
      await initStateManager.waitForInit(childId);
      await editEntry(config, childId, (workspace) => {
        workspace.taskStatus = "reported";
      });
      sendMessage.mockClear();
      return {
        ...harness,
        config,
        parentId,
        projectPath,
        childId,
        sendMessage,
        workspaceService,
        initStateManager,
      };
    }

    function reawaken(taskService: TaskService, parentId: string, childId: string) {
      return taskService.sendMessageToDescendantAgentTask(
        parentId,
        childId,
        "continue",
        "tool-end"
      );
    }

    test("creation stores explicit task arguments as pins (always an object)", async () => {
      const { config, taskService, parentId, childId, initStateManager } =
        await spawnReportedChild();
      expect(findWorkspaceInConfig(config, childId)?.taskAiPins).toEqual({});

      const explicit = await createAgentTask(taskService, parentId, "pinned", {
        agentType: "exec",
        modelString: MODEL_B,
        thinkingLevel: "low",
      });
      assert(explicit.success);
      await initStateManager.waitForInit(explicit.data.taskId);
      expect(findWorkspaceInConfig(config, explicit.data.taskId)?.taskAiPins).toEqual({
        model: MODEL_B,
        thinkingLevel: "low",
      });

      const many = await taskService.createMany([
        {
          parentWorkspaceId: parentId,
          kind: "agent" as const,
          agentId: "exec",
          prompt: "workflow step",
          title: "step",
          modelString: MODEL_C,
        },
      ]);
      assert(many.success);
      expect(findWorkspaceInConfig(config, many.data[0].taskId)?.taskAiPins).toEqual({
        model: MODEL_C,
      });
    }, 20_000);

    test.each([
      {
        name: "Delegated override",
        apply: (config: Config) => setDelegatedExec(config, { modelString: MODEL_B }),
        expected: MODEL_B,
      },
      {
        name: "direct parent's Exec selection",
        apply: (config: Config, parentId: string) =>
          editEntry(config, parentId, (workspace) => {
            workspace.aiSettingsByAgent = { exec: { model: MODEL_C, thinkingLevel: "high" } };
          }),
        expected: MODEL_C,
      },
      {
        name: "base Exec default (masked by the parent's Exec selection)",
        apply: async (config: Config, parentId: string) => {
          await config.editConfig((cfg) => {
            cfg.agentAiDefaults = { ...cfg.agentAiDefaults, exec: { modelString: MODEL_B } };
            return cfg;
          });
          await editEntry(config, parentId, (workspace) => {
            workspace.aiSettingsByAgent = { exec: { model: MODEL_C, thinkingLevel: "high" } };
          });
        },
        expected: MODEL_C,
      },
    ])(
      "an ancestor reawakening follows the current $name",
      async (row) => {
        const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
        expect(findWorkspaceInConfig(config, childId)?.taskModelString).toBe(SPAWN_MODEL);
        await row.apply(config, parentId);

        const result = await reawaken(taskService, parentId, childId);
        expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
        expect(lastSendOptions(sendMessage)).toMatchObject({
          model: row.expected,
          skipAiSettingsPersistence: true,
        });
        const child = findWorkspaceInConfig(config, childId);
        expect(child?.taskModelString).toBe(row.expected);
        expect(child?.aiSettings?.model).toBe(row.expected);
        expect(child?.aiSettingsByAgent?.exec?.model).toBe(row.expected);
        expect(child?.taskExecutionStatus).toBe("running");
      },
      20_000
    );

    test.each([false, true])(
      "a declared definition ancestor's Settings reach an Exec-derived child (archived=%s)",
      async (archived) => {
        const { config, taskService, parentId, childId, sendMessage, workspaceService } =
          await spawnReportedChild({
            spawn: { agentType: "custom", agentId: "custom" },
            beforeSpawn: (projectPath) => writeCustomAgentDefinition(projectPath),
          });
        if (archived) {
          // Reawakening restores an archived child: its definition layers must still apply.
          await editEntry(config, childId, (workspace) => {
            workspace.archivedAt = new Date(Date.now() - 60_000).toISOString();
          });
          spyOn(workspaceService, "unarchiveWhileTaskTreeLocked").mockImplementation(
            async (workspaceId: string) => {
              await editEntry(config, workspaceId, (workspace) => {
                workspace.unarchivedAt = new Date().toISOString();
              });
              return Ok(undefined);
            }
          );
        }
        await config.editConfig((cfg) => {
          cfg.agentAiDefaults = { ...cfg.agentAiDefaults, exec: { modelString: MODEL_B } };
          return cfg;
        });

        const result = await reawaken(taskService, parentId, childId);
        expect(result.success).toBe(true);
        // Only the definition chain (custom -> exec) makes Exec's base model apply here.
        expect(lastSendOptions(sendMessage)).toMatchObject({ model: MODEL_B });
        expect(findWorkspaceInConfig(config, childId)?.taskModelString).toBe(MODEL_B);
      },
      20_000
    );

    test("explicit task arguments stay pinned per field", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild({
        spawn: { modelString: SPAWN_MODEL },
      });
      await setDelegatedExec(config, { modelString: MODEL_B, thinkingLevel: "xhigh" });

      expect((await reawaken(taskService, parentId, childId)).success).toBe(true);
      expect(lastSendOptions(sendMessage)).toMatchObject({
        model: SPAWN_MODEL,
        thinkingLevel: "xhigh",
      });
      expect(findWorkspaceInConfig(config, childId)?.taskAiPins).toEqual({ model: SPAWN_MODEL });
    }, 20_000);

    test("legacy children without taskAiPins keep creation-time settings", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
      await editEntry(config, childId, (workspace) => {
        delete workspace.taskAiPins;
      });
      await setDelegatedExec(config, { modelString: MODEL_B });

      expect((await reawaken(taskService, parentId, childId)).success).toBe(true);
      const options = lastSendOptions(sendMessage);
      expect(options.model).toBe(SPAWN_MODEL);
      expect(options.skipAiSettingsPersistence).toBeUndefined();
      expect(findWorkspaceInConfig(config, childId)?.taskModelString).toBe(SPAWN_MODEL);
    }, 20_000);

    test("bash-monitor wakes stay frozen and read no definitions", async () => {
      const { config, taskService, childId } = await spawnReportedChild();
      await setDelegatedExec(config, { modelString: MODEL_B });
      const loader = spyOn(resolveNodeAgentAiSettingsModule, "loadAgentDefinitionAiLayers");
      const wakeSend = createAcceptingSendMessage();
      try {
        const result = await taskService.reactivateInactiveAgentTaskFromBashMonitorWake(
          childId,
          "background process finished",
          wakeSend as unknown as Parameters<
            TaskService["reactivateInactiveAgentTaskFromBashMonitorWake"]
          >[2]
        );
        expect(result).toEqual(Ok(undefined));
        expect(lastSendOptions(wakeSend).model).toBe(SPAWN_MODEL);
        expect(loader).not.toHaveBeenCalled();
        const child = findWorkspaceInConfig(config, childId);
        expect(child?.taskModelString).toBe(SPAWN_MODEL);
        // The normal reactivation lifecycle still ran.
        expect(child?.taskExecutionStatus).toBe("running");
      } finally {
        loader.mockRestore();
      }
    }, 20_000);

    test("guidance to a live child reads no definitions and keeps its model", async () => {
      const { config, taskService, parentId, childId } = await spawnReportedChild();
      await editEntry(config, childId, (workspace) => {
        workspace.taskStatus = "running";
      });
      await setDelegatedExec(config, { modelString: MODEL_B });
      const loader = spyOn(resolveNodeAgentAiSettingsModule, "loadAgentDefinitionAiLayers");
      try {
        await reawaken(taskService, parentId, childId);
        expect(loader).not.toHaveBeenCalled();
        expect(findWorkspaceInConfig(config, childId)?.taskModelString).toBe(SPAWN_MODEL);
      } finally {
        loader.mockRestore();
      }
    }, 20_000);

    test("changes landing while definitions load are planned from fresh config", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
      let signalLoadStarted!: () => void;
      const loadStarted = new Promise<void>((resolve) => (signalLoadStarted = resolve));
      let releaseLoad!: () => void;
      const loadReleased = new Promise<void>((resolve) => (releaseLoad = resolve));
      const loader = spyOn(
        resolveNodeAgentAiSettingsModule,
        "loadAgentDefinitionAiLayers"
      ).mockImplementation(async () => {
        signalLoadStarted();
        await loadReleased;
        return { ancestors: [] };
      });
      try {
        const pending = reawaken(taskService, parentId, childId);
        await loadStarted;
        await setDelegatedExec(config, { modelString: MODEL_B });
        await editEntry(config, childId, (workspace) => {
          workspace.taskAiPins = { thinkingLevel: "xhigh" };
        });
        releaseLoad();
        expect((await pending).success).toBe(true);
        expect(lastSendOptions(sendMessage)).toMatchObject({
          model: MODEL_B,
          thinkingLevel: "xhigh",
        });
      } finally {
        loader.mockRestore();
      }
    }, 20_000);

    test.each(["unavailable", "timeout", "not-prepared"] as const)(
      "definition layers %s: still follows Settings and pins",
      async (mode) => {
        const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
        await setDelegatedExec(config, { modelString: MODEL_B });
        await editEntry(config, childId, (workspace) => {
          workspace.taskAiPins = { thinkingLevel: "xhigh" };
        });
        const originalLoader = resolveNodeAgentAiSettingsModule.loadAgentDefinitionAiLayers;
        const seenSignals: Array<AbortSignal | undefined> = [];
        const restores: Array<() => void> = [];
        if (mode === "unavailable") {
          const loader = spyOn(
            resolveNodeAgentAiSettingsModule,
            "loadAgentDefinitionAiLayers"
          ).mockResolvedValue(null);
          restores.push(() => loader.mockRestore());
        } else if (mode === "timeout") {
          // An already-expired timeout: the real loader must settle to null promptly.
          const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() =>
            AbortSignal.abort(new Error("timed out"))
          );
          const loader = spyOn(
            resolveNodeAgentAiSettingsModule,
            "loadAgentDefinitionAiLayers"
          ).mockImplementation(async (agentId, context, options) => {
            seenSignals.push(options?.abortSignal);
            const layers = await originalLoader(agentId, context, options);
            expect(layers).toBeNull();
            return layers;
          });
          restores.push(
            () => timeout.mockRestore(),
            () => loader.mockRestore()
          );
        } else {
          const prepare = spyOn(
            taskService as unknown as { prepareReawakenAi(taskId: string): Promise<unknown> },
            "prepareReawakenAi"
          ).mockResolvedValue(undefined);
          restores.push(() => prepare.mockRestore());
        }
        try {
          expect((await reawaken(taskService, parentId, childId)).success).toBe(true);
          expect(lastSendOptions(sendMessage)).toMatchObject({
            model: MODEL_B,
            thinkingLevel: "xhigh",
          });
          if (mode === "timeout") {
            expect(seenSignals).toHaveLength(1);
            expect(seenSignals[0]?.aborted).toBe(true);
          }
        } finally {
          for (const restore of restores) restore();
        }
      },
      20_000
    );

    test("a reload between spawn and reawakening still re-resolves and keeps pins", async () => {
      const { config, parentId, childId, sendMessage, workspaceService, initStateManager } =
        await spawnReportedChild({ spawn: { thinkingLevel: "xhigh" } });
      await setDelegatedExec(config, { modelString: MODEL_B, thinkingLevel: "high" });
      const reloaded = createTaskServiceHarness(config, { workspaceService, initStateManager });

      expect((await reawaken(reloaded.taskService, parentId, childId)).success).toBe(true);
      expect(lastSendOptions(sendMessage)).toMatchObject({
        model: MODEL_B,
        thinkingLevel: "xhigh",
      });
      expect(findWorkspaceInConfig(config, childId)?.taskAiPins).toEqual({
        thinkingLevel: "xhigh",
      });
    }, 20_000);

    test("a stale prepared context refuses retryably without any writes", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
      await setDelegatedExec(config, { modelString: MODEL_B });
      const before = JSON.stringify(findWorkspaceInConfig(config, childId));
      const prepare = spyOn(
        taskService as unknown as { prepareReawakenAi(taskId: string): Promise<unknown> },
        "prepareReawakenAi"
      ).mockResolvedValue({ taskId: childId, agentId: "exec", contextKey: "moved", layers: null });
      try {
        const result = await reawaken(taskService, parentId, childId);
        expect(result.success).toBe(false);
        if (result.success) return;
        // Pre-acceptance refusal: nothing was written, so resending the message is safe.
        expect(result.error).toEqual({
          code: "send_failed",
          message: formatReawakenChangedMessage(childId),
        });
        expect(sendMessage).not.toHaveBeenCalled();
        expect(JSON.stringify(findWorkspaceInConfig(config, childId))).toBe(before);
      } finally {
        prepare.mockRestore();
      }
    }, 20_000);

    test.each([
      {
        name: "a manual pin",
        commitRefusal: true,
        mutate: (config: Config, childId: string) =>
          editEntry(config, childId, (workspace) => {
            workspace.taskAiPins = { model: MODEL_C };
          }),
        survived: (child: WorkspaceConfigEntry | undefined) =>
          expect(child?.taskAiPins).toEqual({ model: MODEL_C }),
      },
      {
        name: "an agentAiDefaults change",
        commitRefusal: true,
        mutate: (config: Config) => setDelegatedExec(config, { modelString: MODEL_C }),
        survived: (_child: WorkspaceConfigEntry | undefined, config: Config) =>
          expect(config.loadConfigOrDefault().agentAiDefaults?.exec?.subagent?.modelString).toBe(
            MODEL_C
          ),
      },
      {
        name: "a child bucket change",
        commitRefusal: true,
        mutate: (config: Config, childId: string) =>
          editEntry(config, childId, (workspace) => {
            workspace.aiSettingsByAgent = { exec: { model: MODEL_C, thinkingLevel: "low" } };
          }),
        survived: (child: WorkspaceConfigEntry | undefined) =>
          expect(child?.aiSettingsByAgent?.exec).toEqual({ model: MODEL_C, thinkingLevel: "low" }),
      },
      {
        name: "the entry's deletion",
        commitRefusal: false,
        mutate: (config: Config, childId: string) =>
          config.editConfig((cfg) => {
            for (const project of cfg.projects.values()) {
              project.workspaces = project.workspaces.filter((entry) => entry.id !== childId);
            }
            return cfg;
          }),
        survived: (child: WorkspaceConfigEntry | undefined) => expect(child).toBeUndefined(),
      },
    ])(
      "$name between resolution and acceptance refuses with no claim or settings",
      async (row) => {
        const target: { config?: Config; childId?: string; armed: boolean } = { armed: false };
        const sendMessage = createAcceptingSendMessage(async () => {
          if (!target.armed || target.config == null || target.childId == null) return;
          // Lands after TaskService planned the snapshot, before acceptance commits it.
          await row.mutate(target.config, target.childId);
        });
        const fixture = await spawnReportedChild({ sendMessage });
        const { config, childId } = fixture;
        target.config = config;
        target.childId = childId;
        await setDelegatedExec(config, { modelString: MODEL_B });
        const before = findWorkspaceInConfig(config, childId);
        target.armed = true;

        const result = await reawaken(fixture.taskService, fixture.parentId, childId);
        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.error.code).toBe("send_failed");
        if (row.commitRefusal) {
          // Commit-point refusal: the prompt row is already durable, so the parent gets the
          // retryable no-resend message rather than the pre-acceptance "send again" one.
          const message = "message" in result.error ? result.error.message : "";
          expect(message).toContain(formatReawakenCommitRefusedMessage(childId));
          expect(message).not.toContain(formatReawakenChangedMessage(childId));
        }
        const child = findWorkspaceInConfig(config, childId);
        row.survived(child, config);
        if (child == null) return;
        // Neither the planned settings nor the claim were written.
        expect(child.taskModelString).toBe(SPAWN_MODEL);
        expect(child.aiSettings).toEqual(before?.aiSettings);
        expect(isActiveWorkspaceTurnTaskStatus(child.taskExecutionStatus)).toBe(false);
      },
      20_000
    );

    test("a send refused before acceptance leaves the AI-settings snapshot unchanged", async () => {
      let refuse = false;
      const refusingSend = mock(
        (): Promise<Result<void, SendMessageError>> =>
          Promise.resolve(
            refuse ? Err({ type: "unknown", raw: "requireIdle: busy" }) : Ok(undefined)
          )
      );
      const { config, taskService, parentId, childId } = await spawnReportedChild({
        sendMessage: refusingSend as unknown as AcceptingSend,
      });
      await setDelegatedExec(config, { modelString: MODEL_B });
      refuse = true;
      const result = await reawaken(taskService, parentId, childId);
      expect(result.success).toBe(false);
      const child = findWorkspaceInConfig(config, childId);
      expect(child?.taskModelString).toBe(SPAWN_MODEL);
      expect(child?.aiSettings?.model).toBe(SPAWN_MODEL);
    }, 20_000);

    test("a post-commit failure keeps the snapshot and settles the claimed mirror", async () => {
      const { config, taskService, parentId, childId } = await spawnReportedChild();
      await setDelegatedExec(config, { modelString: MODEL_B });
      const host = taskService as unknown as {
        editWorkspaceEntry: (...args: unknown[]) => Promise<boolean>;
      };
      const originalEdit = host.editWorkspaceEntry.bind(taskService);
      let committed = false;
      let failedAfterCommit = false;
      const edit = spyOn(host, "editWorkspaceEntry").mockImplementation(async (...args) => {
        if (committed && !failedAfterCommit) {
          // The taskPrompt cleanup right after the claim-and-settings write.
          failedAfterCommit = true;
          throw new Error("disk full");
        }
        const updated = await originalEdit(...args);
        const child = findWorkspaceInConfig(config, childId);
        committed ||= child?.taskModelString === MODEL_B && child.taskExecutionStatus === "running";
        return updated;
      });
      try {
        const result = await reawaken(taskService, parentId, childId);
        expect(failedAfterCommit).toBe(true);
        expect(result.success).toBe(false);
        const child = findWorkspaceInConfig(config, childId);
        expect(child?.taskModelString).toBe(MODEL_B);
        expect(child?.taskExecutionStatus).not.toBe("running");
      } finally {
        edit.mockRestore();
      }
    }, 20_000);

    test("a snapshot for another agent identity is refused before any write", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
      const before = JSON.stringify(findWorkspaceInConfig(config, childId));
      const result = await workspaceTurnManagerFor(taskService).createWorkspaceTurn({
        ownerWorkspaceId: parentId,
        prompt: "continue",
        title: "Sub-agent",
        workspace: { mode: "existing", workspaceId: childId },
        allowAgentWorkspace: true,
        agentTaskAi: {
          snapshot: {
            agentId: "plan",
            taskModelString: MODEL_B,
            canonicalModel: MODEL_B,
            thinkingLevel: "high",
            reasoningMode: "standard",
          },
          inputsKey: "inputs",
          contextKey: "context",
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain(formatReawakenChangedMessage(childId));
      expect(sendMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(findWorkspaceInConfig(config, childId))).toBe(before);
    }, 20_000);

    test("a metadata publication failure after the commit does not fail the turn", async () => {
      const { config, taskService, parentId, childId } = await spawnReportedChild();
      await setDelegatedExec(config, { modelString: MODEL_B });
      const host = taskService as unknown as {
        emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
      };
      const originalEmit = host.emitWorkspaceMetadata.bind(taskService);
      let rejectedAfterCommit = false;
      const emit = spyOn(host, "emitWorkspaceMetadata").mockImplementation(async (workspaceId) => {
        const child = findWorkspaceInConfig(config, childId);
        if (workspaceId === childId && child?.taskModelString === MODEL_B) {
          rejectedAfterCommit = true;
          throw new Error("metadata bus closed");
        }
        return originalEmit(workspaceId);
      });
      const warn = spyOn(log, "warn");
      try {
        const result = await reawaken(taskService, parentId, childId);
        expect(result.success).toBe(true);
        expect(rejectedAfterCommit).toBe(true);
        expect(findWorkspaceInConfig(config, childId)?.taskExecutionStatus).toBe("running");
        expect(warn.mock.calls.some((call) => String(call[0]).includes("publish reawakened"))).toBe(
          true
        );
      } finally {
        emit.mockRestore();
        warn.mockRestore();
      }
    }, 20_000);

    /**
     * Copies the durable state (config, sessions, handle store) of a frozen run into an
     * isolated root and starts a fresh instance there WITHOUT cleanup, like a crash.
     */
    async function restartFromCrashCut(parentId: string, childId: string) {
      const crashRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-taskService-cut-"));
      await fsPromises.cp(rootDir, crashRoot, { recursive: true });
      const restartedConfig = new Config(crashRoot);
      const cutChild = findWorkspaceInConfig(restartedConfig, childId);
      const recoverySend = createAcceptingSendMessage();
      const { workspaceService, resumeStream } = createWorkspaceServiceMocks({
        sendMessage: recoverySend,
      });
      const restarted = createTaskServiceHarness(restartedConfig, { workspaceService });
      await restarted.taskService.initialize();
      const executionId = cutChild?.taskExecutionId;
      assert(executionId != null, "the cut must leave an execution mirror behind");
      const handle = await new TaskHandleStore(restartedConfig).getWorkspaceTurn(
        parentId,
        executionId
      );
      return {
        crashRoot,
        cutChild,
        handle,
        recoveredChild: findWorkspaceInConfig(restartedConfig, childId),
        childSends: recoverySend.mock.calls.filter((call) => call[0] === childId),
        childResumes: resumeStream.mock.calls.filter((call) => call[0] === childId),
      };
    }

    test("a crash cut after the commit settles the claimed execution with the new snapshot", async () => {
      let armed = false;
      let signalCut!: () => void;
      const cutReached = new Promise<void>((resolve) => (signalCut = resolve));
      const fixture = await spawnReportedChild();
      const { config, childId } = fixture;
      const host = fixture.taskService as unknown as {
        editWorkspaceEntry: (...args: unknown[]) => Promise<boolean>;
      };
      const originalEdit = host.editWorkspaceEntry.bind(fixture.taskService);
      const edit = spyOn(host, "editWorkspaceEntry").mockImplementation(async (...args) => {
        const child = findWorkspaceInConfig(config, childId);
        if (armed && child?.taskModelString === MODEL_B) {
          // The claim-and-settings write is durable: freeze here, before any later step.
          signalCut();
          await new Promise(() => undefined);
        }
        return originalEdit(...args);
      });
      await setDelegatedExec(config, { modelString: MODEL_B });
      armed = true;
      void reawaken(fixture.taskService, fixture.parentId, childId);
      await cutReached;
      edit.mockRestore();

      const cut = await restartFromCrashCut(fixture.parentId, childId);
      try {
        // The cut captured the committed claim and settings together.
        expect(cut.cutChild?.taskModelString).toBe(MODEL_B);
        expect(cut.cutChild?.aiSettings?.model).toBe(MODEL_B);
        expect(cut.cutChild?.taskExecutionStatus).toBe("running");
        // Startup settles the interrupted continuation instead of replaying it (child
        // sessions skip startup auto-retry); the committed snapshot stays the new one.
        expect(cut.handle).toMatchObject({
          status: "interrupted",
          error: "Workspace turn interrupted after restart",
          modelString: MODEL_B,
        });
        expect(cut.childSends).toHaveLength(0);
        expect(cut.childResumes).toHaveLength(0);
        expect(cut.recoveredChild?.taskExecutionStatus).toBe("interrupted");
        expect(cut.recoveredChild?.taskModelString).toBe(MODEL_B);
        expect(cut.recoveredChild?.aiSettings?.model).toBe(MODEL_B);
        expect(cut.recoveredChild?.aiSettingsByAgent?.exec?.model).toBe(MODEL_B);
      } finally {
        await fsPromises.rm(cut.crashRoot, { recursive: true, force: true });
      }
    }, 20_000);

    test("a crash cut before the commit settles interrupted with the old snapshot and no replay", async () => {
      let armed = false;
      let signalCut!: () => void;
      const cutReached = new Promise<void>((resolve) => (signalCut = resolve));
      // Freezes inside the send before onAccepted: the reservation already wrote an
      // active mirror, but the claim-and-settings commit never ran.
      const sendMessage = createAcceptingSendMessage(async () => {
        if (!armed) return;
        signalCut();
        await new Promise(() => undefined);
      });
      const fixture = await spawnReportedChild({ sendMessage });
      const { config, childId } = fixture;
      const before = findWorkspaceInConfig(config, childId);
      assert(before != null, "spawned child must exist");
      await setDelegatedExec(config, { modelString: MODEL_B, thinkingLevel: "low" });
      armed = true;
      void reawaken(fixture.taskService, fixture.parentId, childId);
      await cutReached;

      const cut = await restartFromCrashCut(fixture.parentId, childId);
      try {
        expect(isActiveWorkspaceTurnTaskStatus(cut.cutChild?.taskExecutionStatus)).toBe(true);
        expect(cut.cutChild?.taskModelString).toBe(SPAWN_MODEL);
        expect(cut.handle).toMatchObject({
          status: "interrupted",
          error: "Workspace turn interrupted after restart",
        });
        expect(cut.childSends).toHaveLength(0);
        expect(cut.childResumes).toHaveLength(0);
        expect(isActiveWorkspaceTurnTaskStatus(cut.recoveredChild?.taskExecutionStatus)).toBe(
          false
        );
        expect(cut.recoveredChild?.taskModelString).toBe(before.taskModelString);
        expect(cut.recoveredChild?.taskThinkingLevel).toBe(before.taskThinkingLevel);
        expect(cut.recoveredChild?.aiSettings).toEqual(before.aiSettings);
        expect(cut.recoveredChild?.aiSettingsByAgent).toEqual(before.aiSettingsByAgent);
      } finally {
        await fsPromises.rm(cut.crashRoot, { recursive: true, force: true });
      }
    }, 20_000);

    interface AttemptLedger {
      beginOwnedTaskAttempt(
        taskId: string,
        source: string,
        identity: { attemptId: string | undefined; receiptEligible: boolean }
      ): unknown;
      settleOwnedTaskAttempt(taskId: string, attempt: unknown, source: string): void;
      ownedAttemptByTaskId: Map<string, unknown>;
      attemptSettlementByTaskId: Map<string, { attempt: unknown; source: string }>;
    }

    /** Queued admission: returns at once and hands onAccepted to the test once armed. */
    function createDeferredAcceptSendMessage() {
      const deferred: { armed: boolean; accept?: () => Promise<void> | void } = { armed: false };
      const sendMessage = mock(
        async (...args: unknown[]): Promise<Result<void, SendMessageError>> => {
          const internal = args[3] as { onAccepted?: () => Promise<void> | void } | undefined;
          if (deferred.armed) {
            deferred.accept = internal?.onAccepted;
            return Ok(undefined);
          }
          await internal?.onAccepted?.();
          return Ok(undefined);
        }
      );
      return { sendMessage: sendMessage as unknown as AcceptingSend, deferred };
    }

    /** A busy child admits the reawakening queued: the handle is upserted to running at acceptance. */
    function admitQueued(workspaceService: WorkspaceHost, childId: string) {
      return spyOn(workspaceService, "isBusyForMessage").mockImplementation(
        (workspaceId: string) => workspaceId === childId
      );
    }

    test.each(["no settlement", "settled meanwhile", "successor meanwhile"] as const)(
      "a handle-upsert rejection after a queued commit keeps the snapshot and settles the mirror (%s)",
      async (variant) => {
        const { config, taskService, parentId, childId, workspaceService } =
          await spawnReportedChild();
        await setDelegatedExec(config, { modelString: MODEL_B });
        const busy = admitQueued(workspaceService, childId);
        const ledger = taskService as unknown as AttemptLedger;
        const previousAttempt = ledger.ownedAttemptByTaskId.get(childId);
        const store = workspaceTurnManagerInternals(taskService).taskHandleStore;
        const originalUpsert = store.upsertWorkspaceTurn.bind(store);
        let reactivationAttempt: unknown;
        let successor: unknown;
        const upsert = spyOn(store, "upsertWorkspaceTurn").mockImplementation(async (record) => {
          const child = findWorkspaceInConfig(config, childId);
          if (
            reactivationAttempt == null &&
            record.status === "running" &&
            child?.taskModelString === MODEL_B &&
            child.taskExecutionStatus === "running"
          ) {
            // The claim-and-settings write is committed; the next acceptance step fails.
            reactivationAttempt = ledger.ownedAttemptByTaskId.get(childId);
            if (variant === "settled meanwhile") {
              ledger.settleOwnedTaskAttempt(childId, reactivationAttempt, "test-settlement");
            } else if (variant === "successor meanwhile") {
              successor = ledger.beginOwnedTaskAttempt(childId, "test-successor", {
                attemptId: undefined,
                receiptEligible: false,
              });
            }
            throw new Error("handle store disk full");
          }
          return originalUpsert(record);
        });
        try {
          const result = await reawaken(taskService, parentId, childId);
          expect(reactivationAttempt).toBeDefined();
          expect(result).toMatchObject({ success: false, error: { code: "send_failed" } });
          const child = findWorkspaceInConfig(config, childId);
          expect(child?.taskModelString).toBe(MODEL_B);
          expect(child?.aiSettings?.model).toBe(MODEL_B);
          // Existing settlement settled the claimed mirror to a terminal status.
          expect(child?.taskExecutionStatus).toBeDefined();
          expect(isActiveWorkspaceTurnTaskStatus(child?.taskExecutionStatus)).toBe(false);
          const owned = ledger.ownedAttemptByTaskId.get(childId);
          if (variant === "no settlement") {
            // A published attempt is never rolled back (#4308): the refused reactivation's
            // attempt stays owned until a Stop settles it.
            expect(reactivationAttempt).not.toBe(previousAttempt);
            expect(owned).toBe(reactivationAttempt);
          } else if (variant === "settled meanwhile") {
            expect(owned).toBe(reactivationAttempt);
            expect(ledger.attemptSettlementByTaskId.get(childId)?.attempt).toBe(
              reactivationAttempt
            );
          } else {
            expect(owned).toBe(successor);
          }
        } finally {
          upsert.mockRestore();
          busy.mockRestore();
        }
      },
      20_000
    );

    test("a queued acceptance commits only when its deferred onAccepted runs", async () => {
      const { sendMessage, deferred } = createDeferredAcceptSendMessage();
      const { config, taskService, parentId, childId, workspaceService } = await spawnReportedChild(
        { sendMessage }
      );
      const before = findWorkspaceInConfig(config, childId);
      await setDelegatedExec(config, { modelString: MODEL_B, thinkingLevel: "xhigh" });
      const busy = admitQueued(workspaceService, childId);
      deferred.armed = true;
      try {
        const result = await reawaken(taskService, parentId, childId);
        expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
        assert(deferred.accept != null, "the queued send must defer its acceptance");
        const queued = findWorkspaceInConfig(config, childId);
        expect(queued?.taskExecutionStatus).toBe("queued");
        expect(queued?.taskModelString).toBe(before?.taskModelString);
        expect(queued?.taskThinkingLevel).toBe(before?.taskThinkingLevel);
        expect(queued?.aiSettings).toEqual(before?.aiSettings);
        expect(queued?.aiSettingsByAgent).toEqual(before?.aiSettingsByAgent);

        await deferred.accept();
        const accepted = findWorkspaceInConfig(config, childId);
        expect(accepted?.taskExecutionStatus).toBe("running");
        expect(accepted?.taskModelString).toBe(MODEL_B);
        expect(accepted?.taskThinkingLevel).toBe("xhigh");
        expect(accepted?.aiSettingsByAgent?.exec).toMatchObject({
          model: MODEL_B,
          thinkingLevel: "xhigh",
        });
      } finally {
        busy.mockRestore();
      }
    }, 20_000);

    test("the commit lands claim and settings in one write and publishes metadata once after it", async () => {
      const { sendMessage, deferred } = createDeferredAcceptSendMessage();
      const { config, taskService, parentId, childId, workspaceService } = await spawnReportedChild(
        { sendMessage }
      );
      await setDelegatedExec(config, { modelString: MODEL_B });
      const busy = admitQueued(workspaceService, childId);
      deferred.armed = true;
      const host = taskService as unknown as {
        editWorkspaceEntry: (...args: unknown[]) => Promise<boolean>;
        emitWorkspaceMetadata: (workspaceId: string) => Promise<void>;
      };
      const originalEdit = host.editWorkspaceEntry.bind(taskService);
      const originalEmit = host.emitWorkspaceMetadata.bind(taskService);
      const events: Array<{ kind: "edit" | "emit"; model?: string; status?: string }> = [];
      const observe = (kind: "edit" | "emit") => {
        const child = findWorkspaceInConfig(config, childId);
        events.push({ kind, model: child?.taskModelString, status: child?.taskExecutionStatus });
      };
      try {
        expect((await reawaken(taskService, parentId, childId)).success).toBe(true);
        assert(deferred.accept != null, "the queued send must defer its acceptance");
        observe("edit");
        const edit = spyOn(host, "editWorkspaceEntry").mockImplementation(async (...args) => {
          const updated = await originalEdit(...args);
          if (args[0] === childId) observe("edit");
          return updated;
        });
        const emit = spyOn(host, "emitWorkspaceMetadata").mockImplementation(
          async (workspaceId) => {
            if (workspaceId === childId) observe("emit");
            return originalEmit(workspaceId);
          }
        );
        try {
          await deferred.accept();
        } finally {
          edit.mockRestore();
          emit.mockRestore();
        }
      } finally {
        busy.mockRestore();
      }
      // Queued on the old model until acceptance.
      expect(events[0]).toEqual({ kind: "edit", model: SPAWN_MODEL, status: "queued" });
      // The first write showing the new settings also shows the running claim: one write.
      const commitIndex = events.findIndex(
        (event) => event.kind === "edit" && event.model === MODEL_B
      );
      expect(commitIndex).toBeGreaterThan(0);
      expect(events[commitIndex].status).toBe("running");
      expect(
        events
          .slice(0, commitIndex)
          .every((event) => event.model === SPAWN_MODEL && event.status === "queued")
      ).toBe(true);
      // Published exactly once for this acceptance, after the commit.
      const emits = events.filter((event) => event.kind === "emit");
      expect(emits).toEqual([{ kind: "emit", model: MODEL_B, status: "running" }]);
      expect(events.indexOf(emits[0])).toBeGreaterThan(commitIndex);
    }, 20_000);

    test("a grandparent's reawakening resolves from the child's direct parent Exec bucket", async () => {
      const config = await createTestConfig(rootDir);
      const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
        agentAiDefaults: { exec: { modelString: SPAWN_MODEL, thinkingLevel: "high" } },
      });
      const sendMessage = createAcceptingSendMessage();
      const { workspaceService } = createWorkspaceServiceMocks({ sendMessage });
      const initStateManager = new RealInitStateManager(config);
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService,
        initStateManager,
      });
      const child = await createAgentTask(taskService, parentId, "child", { agentType: "exec" });
      assert(child.success, child.success ? "" : child.error);
      await initStateManager.waitForInit(child.data.taskId);
      const grandchild = await createAgentTask(taskService, child.data.taskId, "grandchild", {
        agentType: "exec",
      });
      assert(grandchild.success, grandchild.success ? "" : grandchild.error);
      const grandchildId = grandchild.data.taskId;
      await initStateManager.waitForInit(grandchildId);
      await editEntry(config, grandchildId, (workspace) => {
        workspace.taskStatus = "reported";
      });
      // The root (trigger) and the direct parent carry different Exec selections.
      await editEntry(config, parentId, (workspace) => {
        workspace.aiSettingsByAgent = { exec: { model: MODEL_B, thinkingLevel: "high" } };
      });
      await editEntry(config, child.data.taskId, (workspace) => {
        workspace.aiSettingsByAgent = { exec: { model: MODEL_C, thinkingLevel: "high" } };
      });
      sendMessage.mockClear();

      const result = await reawaken(taskService, parentId, grandchildId);
      expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
      expect(lastSendOptions(sendMessage)).toMatchObject({ model: MODEL_C });
      expect(findWorkspaceInConfig(config, grandchildId)?.taskModelString).toBe(MODEL_C);
    }, 20_000);

    test("recovery prompts and report metadata inside a reawakened execution use the committed values", async () => {
      const { config, taskService, parentId, childId, sendMessage } = await spawnReportedChild();
      await setDelegatedExec(config, { modelString: MODEL_B, thinkingLevel: "xhigh" });
      expect((await reawaken(taskService, parentId, childId)).success).toBe(true);
      expect(findWorkspaceInConfig(config, childId)).toMatchObject({
        taskModelString: MODEL_B,
        taskThinkingLevel: "xhigh",
      });
      // Settings drift after the commit must not reach this execution.
      await setDelegatedExec(config, { modelString: MODEL_C, thinkingLevel: "medium" });
      await editEntry(config, childId, (workspace) => {
        workspace.taskStatus = "awaiting_report";
      });
      sendMessage.mockClear();
      const internal = taskService as unknown as {
        promptTaskForRequiredCompletionTool(
          workspaceId: string,
          options: { expectedAttemptId: null }
        ): Promise<boolean>;
        finalizeAgentTaskReport(
          childWorkspaceId: string,
          childEntry: ReturnType<typeof findWorkspaceEntry>,
          report: { reportMarkdown: string },
          attempt: unknown
        ): Promise<unknown>;
        ownedAttemptByTaskId: Map<string, unknown>;
      };

      expect(
        await internal.promptTaskForRequiredCompletionTool(childId, { expectedAttemptId: null })
      ).toBe(true);
      const recovery = sendMessage.mock.calls.filter((call) => call[0] === childId);
      expect(recovery).toHaveLength(1);
      expect(recovery[0][2]).toMatchObject({ model: MODEL_B, thinkingLevel: "xhigh" });

      await internal.finalizeAgentTaskReport(
        childId,
        findWorkspaceEntry(config.loadConfigOrDefault(), childId),
        { reportMarkdown: "done" },
        internal.ownedAttemptByTaskId.get(childId)
      );
      const report = await readSubagentReportArtifact(
        path.join(config.sessionsDir, parentId),
        childId
      );
      expect(report).toMatchObject({ model: MODEL_B, thinkingLevel: "xhigh" });
    }, 20_000);

    test("sibling-family reactivation keeps the frozen settings and reads no definitions", async () => {
      const { config, taskService, parentId, childId, sendMessage, initStateManager } =
        await spawnReportedChild();
      const sibling = await createAgentTask(taskService, parentId, "sibling", {
        agentType: "exec",
      });
      assert(sibling.success, sibling.success ? "" : sibling.error);
      await initStateManager.waitForInit(sibling.data.taskId);
      await setDelegatedExec(config, { modelString: MODEL_B });
      sendMessage.mockClear();
      const loader = spyOn(resolveNodeAgentAiSettingsModule, "loadAgentDefinitionAiLayers");
      try {
        const result = await taskService.sendMessageToSiblingAgentTask(
          sibling.data.taskId,
          childId,
          "the fixture moved",
          "tool-end"
        );
        expect(result).toMatchObject({ success: true, data: { delivery: "reactivated" } });
        const childSends = sendMessage.mock.calls.filter((call) => call[0] === childId);
        expect(childSends).toHaveLength(1);
        const options = childSends[0][2] as Record<string, unknown>;
        expect(options.model).toBe(SPAWN_MODEL);
        expect(options.skipAiSettingsPersistence).toBeUndefined();
        expect(loader).not.toHaveBeenCalled();
        const child = findWorkspaceInConfig(config, childId);
        expect(child?.taskModelString).toBe(SPAWN_MODEL);
        // The normal reactivation lifecycle still ran.
        expect(child?.taskExecutionStatus).toBe("running");
      } finally {
        loader.mockRestore();
      }
    }, 20_000);
  });

  test("nested Exec delegation inherits the immediate child rather than the root chat", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: { exec: { modelString: "anthropic:claude-opus-4-6" } },
    });
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces[0].aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "high" },
      };
      return cfg;
    });
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const initStateManager = new RealInitStateManager(config);
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    });
    const child = await createAgentTask(taskService, parentId, "child", {
      agentType: "exec",
      modelString: "openai:gpt-5.3-codex",
    });
    assert(child.success);
    await initStateManager.waitForInit(child.data.taskId);
    const grandchild = await createAgentTask(taskService, child.data.taskId, "grandchild", {
      agentType: "exec",
    });
    assert(grandchild.success);
    await initStateManager.waitForInit(grandchild.data.taskId);
    expect(sendMessage).toHaveBeenCalledWith(
      grandchild.data.taskId,
      "grandchild",
      expect.objectContaining({ model: "openai:gpt-5.3-codex" }),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    expect(findWorkspaceInConfig(config, grandchild.data.taskId)?.taskModelString).toBe(
      "openai:gpt-5.3-codex"
    );
  }, 20_000);

  test.each([false, true])(
    "Exec inheritance preserves omitted Standard reasoning (legacy: %s)",
    async (legacy) => {
      const config = await createTestConfig(rootDir);
      const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir, {
        agentAiDefaults: { exec: { modelString: "openai:gpt-5.6-sol", reasoningMode: "pro" } },
      });
      await config.editConfig((cfg) => {
        const parent = cfg.projects.get(projectPath)!.workspaces[0];
        parent.agentId = "exec";
        const settings = { model: "openai:gpt-5.6-sol", thinkingLevel: "high" as const };
        if (legacy) parent.aiSettings = settings;
        else parent.aiSettingsByAgent = { exec: settings };
        return cfg;
      });
      const initStateManager = new RealInitStateManager(config);
      const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
      const { taskService } = createTaskServiceHarness(config, {
        workspaceService,
        initStateManager,
      });
      const created = await createAgentTask(taskService, parentId, "inherit Standard", {
        agentType: "exec",
      });
      assert(created.success);
      await initStateManager.waitForInit(created.data.taskId);
      expect(findWorkspaceInConfig(config, created.data.taskId)?.aiSettings?.reasoningMode).toBe(
        "standard"
      );
      expect(sendMessage).toHaveBeenCalledWith(
        created.data.taskId,
        "inherit Standard",
        expect.objectContaining({ reasoningMode: "standard" }),
        expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
      );
    }
  );

  test("explicit Exec overrides equal to global defaults still beat the calling chat", async () => {
    const config = await createTestConfig(rootDir);
    const { parentId, projectPath } = await saveLocalParentWorkspace(config, rootDir);
    const profile = {
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high" as const,
      reasoningMode: "standard" as const,
    };
    await config.updateAgentAiDefaults({ exec: { ...profile, subagent: profile } });
    await config.editConfig((cfg) => {
      cfg.projects.get(projectPath)!.workspaces[0].aiSettingsByAgent = {
        exec: { model: "openai:gpt-5.2", thinkingLevel: "medium", reasoningMode: "pro" },
      };
      return cfg;
    });
    const initStateManager = new RealInitStateManager(config);
    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService,
      initStateManager,
    });
    const created = await createAgentTask(taskService, parentId, "keep explicit overrides", {
      agentType: "exec",
    });
    assert(created.success);
    await initStateManager.waitForInit(created.data.taskId);
    const expected = {
      model: profile.modelString,
      thinkingLevel: profile.thinkingLevel,
      reasoningMode: profile.reasoningMode,
    };
    expect(findWorkspaceInConfig(config, created.data.taskId)?.aiSettings).toEqual(expected);
    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "keep explicit overrides",
      expect.objectContaining(expected),
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  });

  test("exec subagent uses subagentAiDefaults exec when present", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.2", thinkingLevel: "medium" },
      },
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with subagent defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with subagent defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);

  test("explicit task args outrank subagentAiDefaults exec on task create", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with explicit args",
      {
        agentType: "exec",
        modelString: "openai:gpt-5.2",
        thinkingLevel: "medium",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with explicit args",
      {
        model: "openai:gpt-5.2",
        agentId: "exec",
        thinkingLevel: "medium",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.2");
    expect(childEntry?.taskThinkingLevel).toBe("medium");
  }, 20_000);

  test("exec subagent falls back to agentAiDefaults exec when subagent default is absent", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with agent defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with agent defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("exec subagent partial override combines subagent model with agent thinking", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      agentAiDefaults: {
        exec: { modelString: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      },
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with partial defaults",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with partial defaults",
      {
        model: "openai:gpt-5.3-codex",
        agentId: "exec",
        thinkingLevel: "xhigh",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("subagent thinking defaults are clamped by the resolved model policy", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const resolvedModel = "openai:gpt-5.5-pro";
    const requestedThinkingLevel: ThinkingLevel = "off";
    const expectedThinkingLevel = enforceThinkingPolicy(resolvedModel, requestedThinkingLevel);
    expect(expectedThinkingLevel).not.toBe(requestedThinkingLevel);

    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      parentAiSettings: { model: resolvedModel, thinkingLevel: "high" },
      subagentAiDefaults: {
        exec: { thinkingLevel: requestedThinkingLevel },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with clamped default thinking",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with clamped default thinking",
      {
        model: resolvedModel,
        agentId: "exec",
        thinkingLevel: expectedThinkingLevel,
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.taskModelString).toBe(resolvedModel);
    expect(childEntry?.taskThinkingLevel).toBe(expectedThinkingLevel);
  }, 20_000);

  test("thinking policy is enforced after resolving the final subagent model", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "google:gemini-3-pro" },
      },
    });

    const { workspaceService, sendMessage } = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, { workspaceService });

    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task with clamped thinking",
      {
        agentType: "exec",
        thinkingLevel: "off",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    expect(sendMessage).toHaveBeenCalledWith(
      created.data.taskId,
      "run exec task with clamped thinking",
      {
        model: "google:gemini-3-pro",
        agentId: "exec",
        // Floor-aware clamp (matching what the send path enforces at request
        // time): "off" is unsupported and below the model's medium floor, so
        // it lands on the nearest allowed level.
        thinkingLevel: "high",
        experiments: undefined,
      },
      expect.objectContaining({ acceptanceOrigin: "automatic", agentInitiated: true })
    );
  }, 20_000);

  test("Task.create persists workflow task metadata for report validation", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["taskflow01"]);
    const { parentId } = await saveLocalParentWorkspace(config, rootDir);
    const { taskService } = createTaskServiceHarness(config);

    const outputSchema = {
      type: "object",
      required: ["claims"],
      properties: { claims: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    };

    const result = await createAgentTask(taskService, parentId, "extract claims", {
      workflowTask: {
        runId: "wfr_123",
        stepId: "claims",
        outputSchema,
      },
    });

    expect(result.success).toBe(true);
    const task = findWorkspaceInConfig(config, "taskflow01");
    expect(task?.workflowTask).toEqual({
      runId: "wfr_123",
      stepId: "claims",
      outputSchema,
    });
  });

  test("TaskService extracts persisted agent_report payloads from tool output", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const reportReader = taskService as unknown as {
      findAgentReportArgsInParts(parts: readonly unknown[]): {
        reportMarkdown: string;
        title?: string;
        structuredOutput?: unknown;
      } | null;
    };

    const report = reportReader.findAgentReportArgsInParts([
      {
        type: "dynamic-tool",
        toolName: "agent_report",
        state: "output-available",
        input: { reportMarkdown: "ignored because output report is authoritative", title: null },
        output: {
          success: true,
          report: {
            reportMarkdown: "# Done",
            title: "Done",
            structuredOutput: { claims: ["durable"] },
          },
        },
      },
    ]);

    expect(report).toEqual({
      reportMarkdown: "# Done",
      title: "Done",
      structuredOutput: { claims: ["durable"] },
    });
  });

  test("TaskService preserves schema-shaped workflow agent_report args verbatim", async () => {
    const config = await createTestConfig(rootDir);
    const { taskService } = createTaskServiceHarness(config);
    const reportReader = taskService as unknown as {
      findAgentReportArgsInParts(
        parts: readonly unknown[],
        options?: { acceptSchemaShapedWorkflowReport?: boolean }
      ): {
        reportMarkdown: string;
        title?: string;
        structuredOutput?: unknown;
      } | null;
    };

    const schemaOutput = { reportMarkdown: "# Done", structuredOutput: null, title: null };
    const report = reportReader.findAgentReportArgsInParts(
      [
        {
          type: "dynamic-tool",
          toolName: "agent_report",
          state: "output-available",
          input: schemaOutput,
          output: { success: true },
        },
      ],
      { acceptSchemaShapedWorkflowReport: true }
    );

    expect(report).toEqual({
      reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
      structuredOutput: schemaOutput,
    });
  });

  test("created task metadata is not recomputed after defaults change", async () => {
    const config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
    const { parentId } = await saveLocalParentWorkspace(config, rootDir, {
      subagentAiDefaults: {
        exec: { modelString: "openai:gpt-5.3-codex", thinkingLevel: "xhigh" },
      },
    });

    const { taskService } = createTaskServiceHarness(config);
    const created = await createAgentTask(
      taskService,
      parentId,
      "run exec task before defaults change",
      {
        agentType: "exec",
      }
    );
    expect(created.success).toBe(true);
    if (!created.success) return;

    await config.editConfig((cfg) => ({
      ...cfg,
      agentAiDefaults: {
        ...cfg.agentAiDefaults,
        exec: {
          ...cfg.agentAiDefaults?.exec,
          subagent: { modelString: "openai:gpt-5.2", thinkingLevel: "medium" },
        },
      },
    }));

    const childEntry = findWorkspaceInConfig(config, created.data.taskId);
    expect(childEntry?.aiSettings).toEqual({
      model: "openai:gpt-5.3-codex",
      thinkingLevel: "xhigh",
    });
    expect(childEntry?.taskModelString).toBe("openai:gpt-5.3-codex");
    expect(childEntry?.taskThinkingLevel).toBe("xhigh");
  }, 20_000);
});
