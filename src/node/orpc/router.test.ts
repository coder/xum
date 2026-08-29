/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, local/no-sync-fs-methods */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ORPCError, createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { Config } from "@/node/config";
import { ProjectService } from "@/node/services/projectService";
import type { ORPCContext } from "./context";
import { router } from "./router";

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
