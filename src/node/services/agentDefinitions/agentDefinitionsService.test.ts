import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import { Config } from "@/node/config";
import { AgentIdSchema } from "@/common/orpc/schemas";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  getAgentAiSettingsBases,
  resolveConfiguredAiDefaults,
} from "@/browser/utils/workspaceModeAi";
import { resolveAgentCacheTtl } from "@/common/utils/ai/resolveAgentAiSettings";
import { applyToolPolicyToNames } from "@/common/utils/tools/toolPolicy";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { RemoteRuntime, type SpawnResult } from "@/node/runtime/RemoteRuntime";
import { RuntimeError, type Runtime } from "@/node/runtime/Runtime";
import { HostKeyShellRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { discoverAgentSkills } from "@/node/services/agentSkills/agentSkillsService";
import { log } from "@/node/services/log";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import { DisposableTempDir } from "@/node/services/tempDir";
import {
  AgentDefinitionRequestCache,
  discoverAgentDefinitions,
  listAgentDefinitions,
  type AgentDefinitionsContext,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentDefinition,
  resolveAgentFrontmatter,
} from "./agentDefinitionsService";
import { resolveToolPolicyForAgent } from "./resolveToolPolicy";
import { resolveAgentInheritanceChain } from "./resolveAgentInheritanceChain";
import { resolveChainAgentCacheTtl } from "./resolveNodeAgentAiSettings";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";
import type { RuntimeFactory } from "@/node/services/runtimeFactory/runtimeFactoryService";
import { fakeRuntimeFactory } from "@/node/services/runtimeFactory/fakeRuntimeFactory.testHarness";
import {
  createMemoryHost,
  MEMORY_USER_HOME,
} from "@/node/services/hostFiles/memoryHostFiles.testHarness";

/** The Node layer, except that its host-local runtimes read `~/` as `home`: shows which runtime a scan used. */
function runtimeFactoryWithHome(home: string): RuntimeFactory {
  return {
    ...runtimeFactory,
    createLocalRuntime: (workspacePath) => {
      const local = runtimeFactory.createLocalRuntime(workspacePath);
      return Object.assign(Object.create(local) as Runtime, {
        resolvePath: (target: string) =>
          local.resolvePath(target.startsWith("~/") ? path.join(home, target.slice(2)) : target),
      });
    },
  };
}

async function writeAgent(root: string, id: string, name: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const content = `---
name: ${name}
policy:
  base: exec
---
Body
`;
  await fs.writeFile(path.join(root, `${id}.md`), content, "utf-8");
}

class RemotePathMappedRuntime extends RemoteRuntime {
  private readonly localRuntime: LocalRuntime;
  private readonly localBase: string;
  private readonly remoteBase: string;
  private readonly xumHomeOverride: string | null;

  constructor(localBase: string, remoteBase: string, options?: { xumHome?: string }) {
    super();
    this.localRuntime = new LocalRuntime(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
    this.xumHomeOverride = options?.xumHome ?? null;
  }

  protected readonly commandPrefix = "TestRemoteRuntime";

  protected spawnRemoteProcess(): Promise<SpawnResult> {
    throw new Error("spawnRemoteProcess should not be called in RemotePathMappedRuntime tests");
  }

  protected getBasePath(): string {
    return this.remoteBase;
  }

  protected quoteForRemote(targetPath: string): string {
    return `'${targetPath.replaceAll("'", "'\\''")}'`;
  }

  protected cdCommand(cwd: string): string {
    return `cd ${this.quoteForRemote(cwd)}`;
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");
    if (normalizedRuntimePath === this.remoteBase) return this.localBase;
    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }
    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);
    if (resolvedLocalPath === this.localBase) return this.remoteBase;
    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }
    return localPath.replaceAll("\\", "/");
  }

  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    const translatedCommand = command
      .split(this.remoteBase)
      .join(this.localBase.replaceAll("\\", "/"));
    return this.localRuntime.exec(translatedCommand, {
      ...options,
      cwd: this.toLocalPath(options.cwd),
    });
  }

  override getXumHome(): string {
    return this.xumHomeOverride ?? super.getXumHome();
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await this.localRuntime.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override getWorkspacePath(projectPath: string, workspaceName: string): string {
    return path.posix.join(this.remoteBase, path.basename(projectPath), workspaceName);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return this.localRuntime.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return this.localRuntime.readFile(this.toLocalPath(filePath), abortSignal);
  }

  override writeFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["writeFile"]> {
    return this.localRuntime.writeFile(this.toLocalPath(filePath), abortSignal);
  }

  override ensureDir(dirPath: string): ReturnType<LocalRuntime["ensureDir"]> {
    return this.localRuntime.ensureDir(this.toLocalPath(dirPath));
  }

  override createWorkspace(
    _params: Parameters<LocalRuntime["createWorkspace"]>[0]
  ): ReturnType<LocalRuntime["createWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override initWorkspace(
    _params: Parameters<LocalRuntime["initWorkspace"]>[0]
  ): ReturnType<LocalRuntime["initWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override renameWorkspace(
    _projectPath: string,
    _oldName: string,
    _newName: string,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["renameWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override deleteWorkspace(
    _projectPath: string,
    _workspaceName: string,
    _force: boolean,
    _abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["deleteWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }

  override forkWorkspace(
    _params: Parameters<LocalRuntime["forkWorkspace"]>[0]
  ): ReturnType<LocalRuntime["forkWorkspace"]> {
    return Promise.resolve({ success: false, error: "not implemented in test runtime" });
  }
}

class TrackingRemotePathMappedRuntime extends RemotePathMappedRuntime {
  readonly statCalls: string[] = [];

  override stat(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<RemotePathMappedRuntime["stat"]> {
    this.statCalls.push(filePath);
    return super.stat(filePath, abortSignal);
  }
}

// Project-only listing does not use workspace initialization or AI services.
function projectListContext(config: Config): AgentDefinitionsContext {
  return {
    config,
    aiService: {
      getWorkspaceMetadata: () => {
        throw new Error("Unexpected workspace lookup");
      },
      runtimeFactory,
    },
    initStateManager: {
      waitForInit: () => {
        throw new Error("Unexpected workspace initialization");
      },
    },
  };
}

describe("agentDefinitionsService", () => {
  test("Settings lists each agent's own ai layer apart from its base-merged aiDefaults", async () => {
    using project = new DisposableTempDir("agent-list-own-ai");
    using home = new DisposableTempDir("agent-list-own-ai-home");
    const projectRoot = path.join(project.path, ".xum", "agents");
    await fs.mkdir(projectRoot, { recursive: true });
    const write = (id: string, frontmatter: string) =>
      fs.writeFile(
        path.join(projectRoot, `${id}.md`),
        `---\nname: ${id}\n${frontmatter}---\nBody.`
      );
    await write("explore", "base: explore\nai:\n  thinkingLevel: high\n");
    await write("scout", "base: explore\n");

    const agents = await listAgentDefinitions(projectListContext(new Config(home.path)), {
      projectPath: project.path,
    });
    const byId = (id: string) => agents.find((agent) => agent.id === id);

    // A same-ID hop refines the built-in explore (cacheTtl 5m) inside its own layer.
    expect(byId("explore")?.aiLayers?.targetDefinitionAiDefaults).toEqual({
      cacheTtl: "5m",
      thinkingLevel: "high",
    });
    // Scout inherits explore's frontmatter, which stays out of its own layer.
    expect(byId("scout")?.aiDefaults).toEqual({ cacheTtl: "5m", thinkingLevel: "high" });
    expect(byId("scout")?.aiLayers).toEqual({
      ancestors: [
        { agentId: "explore", definitionAiDefaults: { cacheTtl: "5m", thinkingLevel: "high" } },
        { agentId: "exec" },
      ],
    });
  });

  test("Settings lists the base layers a run resolves, which listed bases cannot show", async () => {
    using project = new DisposableTempDir("agent-list-ancestor-ai");
    using home = new DisposableTempDir("agent-list-ancestor-ai-home");
    const write = async (root: string, id: string, frontmatter: string) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, `${id}.md`), `---\nname: ${id}\n${frontmatter}---\nBody.`);
    };
    const projectRoot = path.join(project.path, ".xum", "agents");
    const globalRoot = path.join(home.path, "agents");
    await write(globalRoot, "refined", "base: exec\n");
    await write(projectRoot, "refined", "base: refined\n");
    await write(globalRoot, "helper", "base: exec\n");
    await write(projectRoot, "bar", "base: helper\n");
    await write(projectRoot, "exec", "base: exec\nai:\n  cacheTtl: 1h\n");

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = home.path;
    try {
      const agents = await listAgentDefinitions(projectListContext(new Config(home.path)), {
        projectPath: project.path,
      });
      const byId = (id: string) => agents.find((agent) => agent.id === id);

      // The project refinement lists `base: refined`, yet runs reach the global agent's base.
      expect(byId("refined")?.base).toBe("refined");
      expect(byId("refined")?.aiLayers?.ancestors).toEqual([{ agentId: "exec" }]);
      // The listed exec is the project's, but a global agent's base resolves past project agents.
      expect(byId("exec")?.aiLayers?.targetDefinitionAiDefaults).toEqual({ cacheTtl: "1h" });
      expect(byId("bar")?.aiLayers?.ancestors).toEqual([
        { agentId: "helper" },
        { agentId: "exec" },
      ]);
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  test("Settings keeps an agent ID that comes back further down the chain at its later hop", async () => {
    using project = new DisposableTempDir("agent-list-repeated-id");
    using home = new DisposableTempDir("agent-list-repeated-id-home");
    const write = async (root: string, id: string, frontmatter: string) => {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, `${id}.md`), `---\nname: ${id}\n${frontmatter}---\nBody.`);
    };
    await write(path.join(project.path, ".xum", "agents"), "explore", "base: helper\n");
    await write(path.join(home.path, "agents"), "helper", "base: explore\nai:\n  cacheTtl: 1h\n");

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = home.path;
    try {
      const agents = await listAgentDefinitions(projectListContext(new Config(home.path)), {
        projectPath: project.path,
      });
      const aiLayers = agents.find((agent) => agent.id === "explore")?.aiLayers;

      // The global helper's base skips the project explore and reaches the built-in one (5m),
      // which ranks below helper instead of joining the project explore's own layer.
      expect(aiLayers).toEqual({
        ancestors: [
          { agentId: "helper", definitionAiDefaults: { cacheTtl: "1h" } },
          { agentId: "explore", definitionAiDefaults: { cacheTtl: "5m" } },
          { agentId: "exec" },
        ],
      });
      expect(resolveAgentCacheTtl({ targetAgentId: "explore", ...aiLayers })?.value).toBe("1h");

      // A run reads the same chain from the checkout.
      const runtime = new LocalRuntime(project.path);
      const agentId = AgentIdSchema.parse("explore");
      const agentDefinition = await readAgentDefinition(runtime, project.path, agentId, {
        runtimeFactory,
      });
      const chain = await resolveAgentInheritanceChain({
        runtime,
        workspacePath: project.path,
        agentId,
        agentDefinition,
        workspaceId: "ws",
        runtimeFactory,
      });
      expect(resolveChainAgentCacheTtl("explore", undefined, chain)).toBe("1h");
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  test.each([true, false])(
    "Settings lists project overrides and filters disabled agents (disabled=%s)",
    async (disabled) => {
      using project = new DisposableTempDir("agent-list-project");
      using home = new DisposableTempDir("agent-list-home");
      const projectRoot = path.join(project.path, ".xum", "agents");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, "reviewer.md"),
        `---\nname: Reviewer\ndisabled: ${disabled}\n---\nReview changes.`
      );
      await fs.writeFile(
        path.join(projectRoot, "exec.md"),
        "---\nname: Project Exec\nai:\n  model: private:project-exec\n---\nProject execution."
      );
      const config = new Config(home.path);
      const context = projectListContext(config);
      const list = (includeDisabled = false) =>
        listAgentDefinitions(context, { projectPath: project.path, includeDisabled });
      const all = await list(true);
      expect(all.find((agent) => agent.id === "reviewer")).toMatchObject({
        name: "Reviewer",
        scope: "project",
      });
      expect(all.find((agent) => agent.id === "exec")).toMatchObject({
        name: "Project Exec",
        scope: "project",
        aiDefaults: { model: "private:project-exec" },
      });
      expect((await list()).some((agent) => agent.id === "reviewer")).toBe(!disabled);
      for (const enabled of [true, false]) {
        await config.editConfig((cfg) => {
          cfg.agentAiDefaults = { reviewer: { enabled } };
          return cfg;
        });
        expect((await list()).some((agent) => agent.id === "reviewer")).toBe(enabled);
      }
    }
  );

  describe("ai.settingsBase (Cursor model: fast)", () => {
    /** Lists the agents of a project whose Xum home holds an unmanaged plugin `kit`. */
    async function listWithPluginAgent(
      agentFile: string,
      agentAiDefaults?: AgentAiDefaults,
      projectAgents: Record<string, string> = {}
    ) {
      using project = new DisposableTempDir("agent-list-settings-base");
      using home = new DisposableTempDir("agent-list-settings-base-home");
      const projectRoot = path.join(project.path, ".xum", "agents");
      await fs.mkdir(projectRoot, { recursive: true });
      for (const [id, frontmatter] of Object.entries(projectAgents)) {
        await fs.writeFile(
          path.join(projectRoot, `${id}.md`),
          `---\nname: ${id}\n${frontmatter}---\nBody.`
        );
      }
      const agentsDir = path.join(home.path, "plugins", "kit", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(
        path.join(home.path, "plugins", "kit", "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "kit",
        })
      );
      await fs.writeFile(path.join(agentsDir, "ci-watcher.md"), agentFile);
      const config = new Config(home.path);
      if (agentAiDefaults != null) {
        await config.editConfig((cfg) => ({ ...cfg, agentAiDefaults }));
      }
      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = home.path;
      try {
        return await listAgentDefinitions(projectListContext(config), {
          projectPath: project.path,
        });
      } finally {
        if (previousRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = previousRoot;
      }
    }

    const CURSOR_CI_WATCHER =
      "---\nname: ci-watcher\ndescription: Watch CI\nmodel: fast\nis_background: true\n---\nWatch CI.\n";

    test("a Cursor fast agent lists Explore's layers, its settings base and its background hint", async () => {
      const agents = await listWithPluginAgent(CURSOR_CI_WATCHER);
      const watcher = agents.find((agent) => agent.id === "ci-watcher");
      expect(watcher?.pluginName).toBe("kit");
      expect(watcher?.base).toBe("exec");
      expect(watcher?.aiSettingsBase).toBe("explore");
      expect(watcher?.backgroundHint).toBe(true);
      expect(watcher?.aiLayers?.ancestors.map((layer) => layer.agentId)).toEqual([
        "explore",
        "exec",
      ]);
    });

    test("keeps the settings base when Explore is disabled", async () => {
      const agents = await listWithPluginAgent(CURSOR_CI_WATCHER, { explore: { enabled: false } });
      expect(agents.some((agent) => agent.id === "explore")).toBe(false);
      expect(agents.find((agent) => agent.id === "ci-watcher")?.aiSettingsBase).toBe("explore");
    });

    test("leaves out a settings base that names a missing agent", async () => {
      const agents = await listWithPluginAgent(
        "---\nname: ci-watcher\nbase: exec\nai:\n  settingsBase: missing-agent\n---\nWatch CI.\n"
      );
      const watcher = agents.find((agent) => agent.id === "ci-watcher");
      expect(watcher).toBeDefined();
      expect(watcher?.aiSettingsBase).toBeUndefined();
      expect(watcher?.backgroundHint).toBeUndefined();
      expect(watcher?.aiLayers?.ancestors[0]?.agentId).toBe("exec");
    });

    test("leaves out a nested settings base, so the renderer walk follows base as a run does", async () => {
      const agentAiDefaults: AgentAiDefaults = {
        helper: { modelString: "custom:m-helper" },
        explore: { modelString: "custom:m-explore" },
        exec: { modelString: "custom:m-exec" },
      };
      const warn = spyOn(log, "warn");
      try {
        const agents = await listWithPluginAgent(
          "---\nname: ci-watcher\nbase: exec\nai:\n  settingsBase: helper\n---\nWatch CI.\n",
          agentAiDefaults,
          { helper: "base: exec\nai:\n  settingsBase: explore\n" }
        );
        const watcher = agents.find((agent) => agent.id === "ci-watcher");
        expect(watcher?.aiSettingsBase).toBeUndefined();
        expect(watcher?.aiLayers?.ancestors.map((layer) => layer.agentId)).toEqual(["exec"]);
        expect(agents.find((agent) => agent.id === "helper")?.aiSettingsBase).toBe("explore");
        expect(
          resolveConfiguredAiDefaults(
            "ci-watcher",
            agentAiDefaults,
            getAgentAiSettingsBases(agents)
          ).modelString
        ).toBe("custom:m-exec");
        expect(warn).toHaveBeenCalledWith("settingsBase ignored", {
          agentId: "ci-watcher",
          settingsBase: "helper",
          reason: "nested",
        });
      } finally {
        warn.mockRestore();
      }
    });

    test("leaves out both settings bases of a loop made only of settingsBase links", async () => {
      const agents = await listWithPluginAgent(CURSOR_CI_WATCHER, undefined, {
        a: "base: exec\nai:\n  settingsBase: b\n",
        b: "base: exec\nai:\n  settingsBase: a\n",
      });
      for (const id of ["a", "b"]) {
        const agent = agents.find((listed) => listed.id === id);
        expect(agent).toBeDefined();
        expect(agent?.aiSettingsBase).toBeUndefined();
      }
    });
  });

  test("project agents override global agents", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");
    await writeAgent(globalAgentsRoot, "bar", "Bar (global)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agents = await discoverAgentDefinitions(runtime, project.path, { roots, runtimeFactory });

    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.name).toBe("Foo (project)");

    const bar = agents.find((a) => a.id === "bar");
    expect(bar).toBeDefined();
    expect(bar!.scope).toBe("global");
  });

  test("dedupeById: false keeps precedence order within same-ID groups despite name sorting", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(project.path, "global-agents");
    // Same ID, different display names, chosen so a per-row name sort would
    // place the lower-precedence global row ("Alpha") BEFORE the project
    // winner ("Zulu"). Composition consumers treat the first row per ID as
    // effective, so precedence must survive the sort.
    await writeAgent(projectAgentsRoot, "dup", "Zulu (project)");
    await writeAgent(globalAgentsRoot, "dup", "Alpha (global)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);
    const agents = await discoverAgentDefinitions(runtime, project.path, {
      roots,
      dedupeById: false,
      runtimeFactory,
    });

    const dupRows = agents.filter((agent) => agent.id === "dup");
    expect(dupRows.map((agent) => agent.scope)).toEqual(["project", "global"]);
    // Same-ID rows stay adjacent (grouped) rather than scattered by name.
    const dupIndices = agents.flatMap((agent, index) => (agent.id === "dup" ? [index] : []));
    expect(dupIndices[1]).toBe(dupIndices[0] + 1);
  });

  test("readAgentDefinition resolves project before global", async () => {
    using project = new DisposableTempDir("agent-defs-project");
    using global = new DisposableTempDir("agent-defs-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await writeAgent(globalAgentsRoot, "foo", "Foo (global)");
    await writeAgent(projectAgentsRoot, "foo", "Foo (project)");

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const agentId = AgentIdSchema.parse("foo");
    const pkg = await readAgentDefinition(runtime, project.path, agentId, {
      roots,
      runtimeFactory,
    });

    expect(pkg.scope).toBe("project");
    expect(pkg.frontmatter.name).toBe("Foo (project)");
  });

  test("SSH workspaces discover host-global agents while keeping project overrides on the remote workspace", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-project");
    using global = new DisposableTempDir("agent-defs-ssh-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");

    await writeAgent(globalAgentsRoot, "host-only", "Host Only");
    await writeAgent(globalAgentsRoot, "shared", "Shared (global)");
    await writeAgent(projectAgentsRoot, "shared", "Shared (project)");

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, {
      roots,
      runtimeFactory,
    });

    const hostOnly = agents.find((agent) => agent.id === "host-only");
    expect(hostOnly).toBeDefined();
    expect(hostOnly?.scope).toBe("global");
    expect(hostOnly?.name).toBe("Host Only");

    const shared = agents.find((agent) => agent.id === "shared");
    expect(shared).toBeDefined();
    expect(shared?.scope).toBe("project");
    expect(shared?.name).toBe("Shared (project)");

    const hostOnlyPkg = await readAgentDefinition(runtime, remoteWorkspacePath, "host-only", {
      roots,
      runtimeFactory,
    });
    expect(hostOnlyPkg.scope).toBe("global");
    expect(hostOnlyPkg.frontmatter.name).toBe("Host Only");
  });

  test("SSH workspaces resolve inherited agent bodies across host-global and remote project roots", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-body-project");
    using global = new DisposableTempDir("agent-defs-ssh-body-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "base.md"),
      `---\nname: Base\n---\nGlobal instructions.\n`,
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectAgentsRoot, "child.md"),
      `---\nname: Child\nbase: base\n---\nProject instructions.\n`,
      "utf-8"
    );

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new RemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const body = await resolveAgentBody(runtime, remoteWorkspacePath, "child", {
      roots,
      runtimeFactory,
    });
    expect(body).toContain("Global instructions.");
    expect(body).toContain("Project instructions.");
  });

  test("docker-like remote runtimes keep global agent reads on the runtime filesystem", async () => {
    using runtimeBase = new DisposableTempDir("agent-defs-docker-global-runtime");

    const remoteRuntimeRoot = "/var";
    const remoteWorkspacePath = "/var/workspace";
    const runtimeWorkspaceRoot = path.join(runtimeBase.path, "workspace");
    const runtimeGlobalAgentsRoot = path.join(runtimeBase.path, "global-agents");
    await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
    await writeAgent(runtimeGlobalAgentsRoot, "docker-global", "Docker Global");

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: path.posix.join(remoteRuntimeRoot, "global-agents"),
    };
    const runtime = new RemotePathMappedRuntime(runtimeBase.path, remoteRuntimeRoot, {
      xumHome: "/var/mux",
    });

    const agents = await discoverAgentDefinitions(runtime, remoteWorkspacePath, {
      roots,
      runtimeFactory,
    });

    expect(agents.find((agent) => agent.id === "docker-global")).toMatchObject({
      id: "docker-global",
      name: "Docker Global",
      scope: "global",
    });

    const pkg = await readAgentDefinition(runtime, remoteWorkspacePath, "docker-global", {
      roots,
      runtimeFactory,
    });
    expect(pkg.scope).toBe("global");
    expect(pkg.frontmatter.name).toBe("Docker Global");
  });

  test("known global-scope resolution skips remote project probes during inheritance", async () => {
    using project = new DisposableTempDir("agent-defs-ssh-frontmatter-project");
    using global = new DisposableTempDir("agent-defs-ssh-frontmatter-global");

    const remoteWorkspacePath = "/remote/workspace";
    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = path.join(global.path, "agents");
    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "asklike.md"),
      `---\nname: Ask Like\nbase: exec\n---\nAsk-like body.\n`,
      "utf-8"
    );

    const roots = {
      projectRoots: [path.posix.join(remoteWorkspacePath, ".mux", "agents")],
      globalRoot: globalAgentsRoot,
    };
    const runtime = new TrackingRemotePathMappedRuntime(project.path, remoteWorkspacePath);

    const descriptors = await discoverAgentDefinitions(runtime, remoteWorkspacePath, {
      roots,
      runtimeFactory,
    });
    const askLike = descriptors.find((descriptor) => descriptor.id === "asklike");
    expect(askLike).toBeDefined();
    expect(askLike?.scope).toBe("global");

    const frontmatter = await resolveAgentFrontmatter(runtime, remoteWorkspacePath, "asklike", {
      roots,
      skipScopesAbove: getSkipScopesAboveForKnownScope(askLike!.scope),
      runtimeFactory,
    });

    expect(frontmatter.name).toBe("Ask Like");
    expect(runtime.statCalls.some((filePath) => filePath.endsWith("/.mux/agents/exec.md"))).toBe(
      false
    );
  });

  test("resolveAgentBody appends by default (new default), replaces when prompt.append is false", async () => {
    using tempDir = new DisposableTempDir("agent-body-test");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    // Create base agent
    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - .*
---
Base instructions.
`,
      "utf-8"
    );

    // Create child agent that appends (default behavior)
    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
---
Child additions.
`,
      "utf-8"
    );

    // Create another child that explicitly replaces
    await fs.writeFile(
      path.join(agentsRoot, "replacer.md"),
      `---
name: Replacer
base: base
prompt:
  append: false
---
Replaced body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    // Child without explicit prompt settings should append (new default)
    const childBody = await resolveAgentBody(runtime, tempDir.path, "child", {
      roots,
      runtimeFactory,
    });
    expect(childBody).toContain("Base instructions.");
    expect(childBody).toContain("Child additions.");

    // Child with prompt.append: false should replace (explicit opt-out)
    const replacerBody = await resolveAgentBody(runtime, tempDir.path, "replacer", {
      roots,
      runtimeFactory,
    });
    expect(replacerBody).toBe("Replaced body.\n");
    expect(replacerBody).not.toContain("Base instructions");
  });

  test("project plan agents can replace the built-in plan prompt body without losing inherited frontmatter", async () => {
    using tempDir = new DisposableTempDir("agent-plan-guidance");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "custom-plan.md"),
      `---
name: Custom Plan
base: plan
prompt:
  append: false
---
Custom planning instructions.
`,
      "utf-8"
    );

    const runtime = new LocalRuntime(tempDir.path);

    const customPlanBody = await resolveAgentBody(runtime, tempDir.path, "custom-plan", {
      runtimeFactory,
    });
    expect(customPlanBody).toBe("Custom planning instructions.\n");

    const customPlanFrontmatter = await resolveAgentFrontmatter(
      runtime,
      tempDir.path,
      "custom-plan",
      { runtimeFactory }
    );
    expect(customPlanFrontmatter.subagent?.runnable).toBe(false);
    expect(customPlanFrontmatter.subagent?.workflow_runnable).toBe(true);
    expect(customPlanFrontmatter.tools?.require).toEqual(["propose_plan"]);
  });

  test("built-in explore replaces exec prompt body while inheriting frontmatter", async () => {
    using tempDir = new DisposableTempDir("agent-explore-guidance");
    const runtime = new LocalRuntime(tempDir.path);

    const [exploreBody, execBody] = await Promise.all([
      resolveAgentBody(runtime, tempDir.path, "explore", { runtimeFactory }),
      resolveAgentBody(runtime, tempDir.path, "exec", { runtimeFactory }),
    ]);
    expect(exploreBody.trim().length).toBeGreaterThan(0);
    expect(execBody.trim().length).toBeGreaterThan(0);
    expect(exploreBody).not.toContain(execBody.trim());

    const exploreFrontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "explore", {
      runtimeFactory,
    });
    expect(exploreFrontmatter.tools?.add).toContain(".*");
    expect(exploreFrontmatter.tools?.remove).toContain("file_edit_.*");
    expect(exploreFrontmatter.subagent?.runnable).toBe(true);

    const toolPolicy = resolveToolPolicyForAgent({
      agents: [{ tools: exploreFrontmatter.tools }],
      isSubagent: true,
      disableTaskToolsForDepth: false,
    });
    expect(
      applyToolPolicyToNames(
        [
          "task",
          "task_apply_git_patch",
          "task_await",
          "task_list",
          "task_stop",
          "task_remove",
          "workflow_run",
        ],
        toolPolicy
      )
    ).toEqual(["task_await", "workflow_run"]);
  });
  test("same-name override: project agent with base: self extends built-in/global, not itself", async () => {
    using project = new DisposableTempDir("agent-same-name");
    using global = new DisposableTempDir("agent-same-name-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    // Global "foo" agent (simulates built-in or global config)
    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo
tools:
  add:
    - .*
---
Global foo instructions.
`,
      "utf-8"
    );

    // Project-local "foo" agent that extends the global one via base: foo
    // This should NOT cause a circular dependency (would previously infinite loop)
    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo
base: foo
---
Project-specific additions.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Verify project agent is discovered
    const agents = await discoverAgentDefinitions(runtime, project.path, { roots, runtimeFactory });
    const foo = agents.find((a) => a.id === "foo");
    expect(foo).toBeDefined();
    expect(foo!.scope).toBe("project");
    expect(foo!.base).toBe("foo"); // Points to itself by name

    // Verify body resolution correctly inherits from global (not self)
    const body = await resolveAgentBody(runtime, project.path, "foo", { roots, runtimeFactory });
    expect(body).toContain("Global foo instructions.");
    expect(body).toContain("Project-specific additions.");
  });

  test("readAgentDefinition with skipScopesAbove skips higher-priority scopes", async () => {
    using project = new DisposableTempDir("agent-skip-scope");
    using global = new DisposableTempDir("agent-skip-scope-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "test.md"),
      `---
name: Test Global
---
Global body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "test.md"),
      `---
name: Test Project
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    // Without skip: project takes precedence
    const normalPkg = await readAgentDefinition(runtime, project.path, "test", {
      roots,
      runtimeFactory,
    });
    expect(normalPkg.scope).toBe("project");
    expect(normalPkg.frontmatter.name).toBe("Test Project");

    // With skipScopesAbove: "project" → skip project, return global
    const skippedPkg = await readAgentDefinition(runtime, project.path, "test", {
      roots,
      skipScopesAbove: "project",
      runtimeFactory,
    });
    expect(skippedPkg.scope).toBe("global");
    expect(skippedPkg.frontmatter.name).toBe("Test Global");
  });

  test("resolveAgentFrontmatter inherits omitted fields from base chain (same-name override)", async () => {
    using project = new DisposableTempDir("agent-frontmatter-project");
    using global = new DisposableTempDir("agent-frontmatter-global");

    const projectAgentsRoot = path.join(project.path, ".mux", "agents");
    const globalAgentsRoot = global.path;

    await fs.mkdir(projectAgentsRoot, { recursive: true });
    await fs.mkdir(globalAgentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(globalAgentsRoot, "foo.md"),
      `---
name: Foo Base
description: Base description
ui:
  hidden: true
  color: red
subagent:
  runnable: true
  workflow_runnable: true
  append_prompt: Base subagent prompt
  skip_init_hook: true
ai:
  model: base-model
  thinkingLevel: high
tools:
  add:
    - baseAdd
  remove:
    - baseRemove
---
Base body.
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(projectAgentsRoot, "foo.md"),
      `---
name: Foo Project
base: foo
ui:
  color: blue
---
Project body.
`,
      "utf-8"
    );

    const roots = { projectRoots: [projectAgentsRoot], globalRoot: globalAgentsRoot };
    const runtime = new LocalRuntime(project.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, project.path, "foo", {
      roots,
      runtimeFactory,
    });

    expect(frontmatter.description).toBe("Base description");
    expect(frontmatter.ui?.hidden).toBe(true);
    expect(frontmatter.ui?.color).toBe("blue");
    expect(frontmatter.subagent?.runnable).toBe(true);
    expect(frontmatter.subagent?.workflow_runnable).toBe(true);
    expect(frontmatter.subagent?.append_prompt).toBe("Base subagent prompt");
    expect(frontmatter.subagent?.skip_init_hook).toBe(true);
    expect(frontmatter.ai?.model).toBe("base-model");
    expect(frontmatter.ai?.thinkingLevel).toBe("high");
    expect(frontmatter.tools?.add).toEqual(["baseAdd"]);
    expect(frontmatter.tools?.remove).toEqual(["baseRemove"]);
  });

  test.each([true, false])(
    "resolves body and inherited metadata in one read per layer (append=%s)",
    async (append) => {
      using tempDir = new DisposableTempDir("agent-definition-snapshot");
      const root = path.join(tempDir.path, "agents");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "base.md"),
        "---\nname: Base\ndisabled: true\nai:\n  model: private:base\n---\nBase protocol."
      );
      await fs.writeFile(
        path.join(root, "child.md"),
        `---\nname: Child\nbase: base\nprompt:\n  append: ${append}\n---\nChild instructions.`
      );
      const runtime = new LocalRuntime(tempDir.path);
      const read = spyOn(runtime, "readFile");
      try {
        const resolved = await resolveAgentDefinition(runtime, tempDir.path, "child", {
          roots: { projectRoots: [], globalRoot: root },
          runtimeFactory,
        });
        expect(resolved).toMatchObject({
          id: "child",
          scope: "global",
          frontmatter: { disabled: true, ai: { model: "private:base" } },
        });
        expect(resolved.body).toBe(
          append ? "Base protocol.\n\nChild instructions." : "Child instructions."
        );
        expect(read.mock.calls.map(([file]) => file)).toEqual([
          path.join(root, "child.md"),
          path.join(root, "base.md"),
        ]);
      } finally {
        read.mockRestore();
      }
    }
  );

  test("resolveAgentFrontmatter preserves explicit falsy overrides", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-falsy");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
ui:
  hidden: true
subagent:
  runnable: true
  workflow_runnable: true
  skip_init_hook: true
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
ui:
  hidden: false
subagent:
  runnable: false
  workflow_runnable: false
  skip_init_hook: false
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", {
      roots,
      runtimeFactory,
    });

    expect(frontmatter.ui?.hidden).toBe(false);
    expect(frontmatter.subagent?.runnable).toBe(false);
    expect(frontmatter.subagent?.workflow_runnable).toBe(false);
    expect(frontmatter.subagent?.skip_init_hook).toBe(false);
  });

  test("resolveAgentFrontmatter concatenates add/remove and overrides require with child value", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-tools");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "base.md"),
      `---
name: Base
tools:
  add:
    - a
  remove:
    - b
  require:
    - propose_plan
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "child.md"),
      `---
name: Child
base: base
tools:
  add:
    - c
  remove:
    - d
  require:
    - agent_report
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    const frontmatter = await resolveAgentFrontmatter(runtime, tempDir.path, "child", {
      roots,
      runtimeFactory,
    });

    expect(frontmatter.tools?.add).toEqual(["a", "c"]);
    expect(frontmatter.tools?.remove).toEqual(["b", "d"]);
    expect(frontmatter.tools?.require).toEqual(["agent_report"]);
  });

  test("resolveAgentFrontmatter detects cycles", async () => {
    using tempDir = new DisposableTempDir("agent-frontmatter-cycle");
    const agentsRoot = path.join(tempDir.path, ".mux", "agents");
    await fs.mkdir(agentsRoot, { recursive: true });

    await fs.writeFile(
      path.join(agentsRoot, "a.md"),
      `---
name: A
base: b
---
`,
      "utf-8"
    );

    await fs.writeFile(
      path.join(agentsRoot, "b.md"),
      `---
name: B
base: a
---
`,
      "utf-8"
    );

    const roots = { projectRoots: [agentsRoot], globalRoot: agentsRoot };
    const runtime = new LocalRuntime(tempDir.path);

    expect(
      resolveAgentFrontmatter(runtime, tempDir.path, "a", { roots, runtimeFactory })
    ).rejects.toThrow("Circular agent inheritance detected");
  });

  describe("agent plugin contributions", () => {
    async function writePluginWithAgent(
      containerPath: string,
      pluginName: string,
      agentId: string,
      agentName: string
    ): Promise<void> {
      const pluginDir = path.join(containerPath, pluginName);
      await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: pluginName,
        }),
        "utf-8"
      );
      await writeAgent(path.join(pluginDir, "agents"), agentId, agentName);
    }

    test("plugin agents are discovered with plugin attribution at lowest project precedence", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const projectAgentsRoot = path.join(project.path, ".mux", "agents");
      const pluginContainer = path.join(project.path, ".mux", "plugins");

      await writePluginWithAgent(pluginContainer, "my-plugin", "helper", "Helper (plugin)");
      await writePluginWithAgent(pluginContainer, "my-plugin", "shared", "Shared (plugin)");
      await writeAgent(projectAgentsRoot, "shared", "Shared (project)");

      const roots = {
        projectRoots: [projectAgentsRoot],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const agents = await discoverAgentDefinitions(runtime, project.path, {
        roots,
        runtimeFactory,
      });

      const helper = agents.find((a) => a.id === "helper");
      expect(helper).toBeDefined();
      expect(helper?.scope).toBe("project");
      expect(helper?.pluginName).toBe("my-plugin");

      // The project agent shadows the plugin agent of the same id.
      const shared = agents.filter((a) => a.id === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]?.name).toBe("Shared (project)");
      expect(shared[0]?.pluginName).toBeUndefined();
    });

    test("resolves plugin containers through the host-local runtime of the RuntimeFactory it was given", async () => {
      using home = new DisposableTempDir("agent-defs-plugin-factory");
      await writePluginWithAgent(
        path.join(home.path, "plugins"),
        "probe",
        "factory-probe",
        "Probe"
      );
      const roots = {
        projectRoots: [],
        globalRoot: path.join(home.path, "agents"),
        // Tilde form: only the factory's host-local runtime maps it into the temp home.
        globalPluginRoots: ["~/plugins"],
      };

      const agents = await discoverAgentDefinitions(new LocalRuntime(home.path), home.path, {
        roots,
        runtimeFactory: runtimeFactoryWithHome(home.path),
      });

      expect(agents.find((a) => a.id === "factory-probe")?.pluginName).toBe("probe");
    });

    // #6426: project plugin agents load only in a trusted project, in the listing and in a
    // read by id (an agentId, a base). Plain project agents do not change.
    test.each([false, true])(
      "project plugin agents are listed and read only in a trusted project (trusted: %s)",
      async (projectPluginsTrusted) => {
        using project = new DisposableTempDir("agent-defs-plugin-trust");
        await writeAgent(path.join(project.path, ".xum", "agents"), "plain-project", "Plain");
        await writePluginWithAgent(
          path.join(project.path, ".xum", "plugins"),
          "repo-plugin",
          "repo-agent",
          "Repo (plugin)"
        );
        const runtime = new LocalRuntime(project.path);

        const ids = (
          await discoverAgentDefinitions(runtime, project.path, {
            projectPluginsTrusted,
            runtimeFactory,
          })
        ).map((agent) => agent.id);
        expect(ids).toContain("plain-project");
        expect(ids.includes("repo-agent")).toBe(projectPluginsTrusted);

        // One request cache serves both trust values without mixing them.
        const cache = new AgentDefinitionRequestCache();
        const read = (trusted: boolean) =>
          readAgentDefinition(runtime, project.path, AgentIdSchema.parse("repo-agent"), {
            cache,
            projectPluginsTrusted: trusted,
            runtimeFactory,
          }).then((pkg) => pkg.frontmatter.name);
        if (projectPluginsTrusted) expect(await read(true)).toBe("Repo (plugin)");
        else {
          // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
          await expect(read(false)).rejects.toThrow("Agent definition not found");
          expect(await read(true)).toBe("Repo (plugin)");
        }
      }
    );

    // #7216: the project-automation kill switch wins over trust, in the listing and in a read.
    test("project plugin agents stay hidden in a trusted project under the kill switch", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-kill-switch");
      await writePluginWithAgent(
        path.join(project.path, ".xum", "plugins"),
        "repo-plugin",
        "repo-agent",
        "Repo (plugin)"
      );
      const runtime = new LocalRuntime(project.path);
      const trusted = { projectPluginsTrusted: true, runtimeFactory } as const;
      const previous = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
      try {
        const agents = await discoverAgentDefinitions(runtime, project.path, trusted);
        expect(agents.some((agent) => agent.id === "repo-agent")).toBe(false);
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
        await expect(
          readAgentDefinition(runtime, project.path, AgentIdSchema.parse("repo-agent"), trusted)
        ).rejects.toThrow("Agent definition not found");
      } finally {
        if (previous === undefined) delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
        else process.env[DISABLE_PROJECT_AUTOMATION_ENV] = previous;
      }
    });

    test("dedupeById: false returns shadowed plugin agents in precedence order", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const projectAgentsRoot = path.join(project.path, ".mux", "agents");
      const pluginContainer = path.join(project.path, ".mux", "plugins");

      await writePluginWithAgent(pluginContainer, "my-plugin", "shared", "Shared");
      await writeAgent(projectAgentsRoot, "shared", "Shared");

      const roots = {
        projectRoots: [projectAgentsRoot],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const agents = await discoverAgentDefinitions(runtime, project.path, {
        roots,
        dedupeById: false,
        runtimeFactory,
      });

      const shared = agents.filter((a) => a.id === "shared");
      expect(shared).toHaveLength(2);
      // Precedence order within the same name: project first, plugin second.
      expect(shared[0]?.pluginName).toBeUndefined();
      expect(shared[1]?.pluginName).toBe("my-plugin");
    });

    test("a Claude Code / Cursor format plugin agent spawns with Exec's tools; project agents keep Xum defaults", async () => {
      using project = new DisposableTempDir("agent-defs-foreign-plugin-project");
      using global = new DisposableTempDir("agent-defs-foreign-plugin-global");

      const projectAgentsRoot = path.join(project.path, ".mux", "agents");
      const pluginContainer = path.join(project.path, ".mux", "plugins");
      // Upstream pstack's agents/poteto-agent.md frontmatter, verbatim keys.
      const foreign = `---\nname: poteto-agent\ndescription: Delegate subagent\nis_background: true\n---\nYou are a delegate.\n`;
      await writePluginWithAgent(pluginContainer, "pstack", "placeholder", "Placeholder");
      await fs.writeFile(
        path.join(pluginContainer, "pstack", "agents", "poteto-agent.md"),
        foreign,
        "utf-8"
      );
      await fs.mkdir(projectAgentsRoot, { recursive: true });
      await fs.writeFile(path.join(projectAgentsRoot, "local-foreign.md"), foreign, "utf-8");

      const roots = {
        projectRoots: [projectAgentsRoot],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const agents = await discoverAgentDefinitions(runtime, project.path, {
        roots,
        runtimeFactory,
      });
      const plugin = agents.find((a) => a.id === "poteto-agent");
      expect(plugin).toMatchObject({ subagentRunnable: true, uiSelectable: false, base: "exec" });
      const local = agents.find((a) => a.id === "local-foreign");
      expect(local).toMatchObject({ subagentRunnable: false, uiSelectable: true });
      expect(local?.base).toBeUndefined();

      const resolvePolicy = async (agentId: string) => {
        const agentDefinition = await readAgentDefinition(
          runtime,
          project.path,
          AgentIdSchema.parse(agentId),
          { roots, runtimeFactory }
        );
        const chain = await resolveAgentInheritanceChain({
          runtime,
          workspacePath: project.path,
          agentId: AgentIdSchema.parse(agentId),
          agentDefinition,
          workspaceId: "ws",
          runtimeFactory,
        });
        return {
          body: await resolveAgentBody(runtime, project.path, AgentIdSchema.parse(agentId), {
            roots,
            runtimeFactory,
          }),
          policy: resolveToolPolicyForAgent({
            agents: chain,
            isSubagent: true,
            disableTaskToolsForDepth: false,
          }),
        };
      };
      const sampleTools = ["bash", "file_read", "file_edit_insert", "task", "web_fetch"];
      const pluginAgent = await resolvePolicy("poteto-agent");
      const exec = await resolvePolicy("exec");
      expect(applyToolPolicyToNames(sampleTools, pluginAgent.policy)).toEqual(sampleTools);
      expect(applyToolPolicyToNames(sampleTools, pluginAgent.policy)).toEqual(
        applyToolPolicyToNames(sampleTools, exec.policy)
      );
      // The plugin body is the whole system prompt, as in Claude Code and Cursor:
      // it replaces Exec's body instead of appending to it.
      expect(pluginAgent.body.trim()).toBe("You are a delegate.");
      // The project copy of the same file stays toolless.
      expect(
        applyToolPolicyToNames(sampleTools, (await resolvePolicy("local-foreign")).policy)
      ).toEqual([]);
    });

    test("Claude Code tools/disallowedTools lists narrow plugin agents; unresolvable or mixed lists skip the agent", async () => {
      using project = new DisposableTempDir("agent-defs-claude-tools-project");
      using global = new DisposableTempDir("agent-defs-claude-tools-global");

      const pluginContainer = path.join(project.path, ".mux", "plugins");
      await writePluginWithAgent(pluginContainer, "pstack", "placeholder", "Placeholder");
      const agentFiles: Record<string, string> = {
        // Claude Code allowlist: only the named tools.
        reviewer: "name: reviewer\ndescription: d\ntools: Read, Grep, Bash",
        // Claude Code denylist: every inherited tool except file writes and spawning.
        "no-writes": "name: no-writes\ndescription: d\ndisallowedTools: [Write, Edit, Agent]",
        // Nothing resolves: Claude Code refuses to launch it, so Xum skips it.
        unresolved: "name: unresolved\ndescription: d\ntools: Grep, Glob",
        // A Xum-format file with a Claude denylist: Xum cannot honor both, so it skips it.
        mixed: "name: mixed\nbase: exec\nsubagent:\n  runnable: true\ndisallowedTools: [Bash]",
      };
      for (const [id, frontmatter] of Object.entries(agentFiles)) {
        await fs.writeFile(
          path.join(pluginContainer, "pstack", "agents", `${id}.md`),
          `---\n${frontmatter}\n---\nBody\n`,
          "utf-8"
        );
      }

      const roots = {
        projectRoots: [],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);
      const warn = spyOn(log, "warn");
      let ids: string[];
      try {
        ids = (
          await discoverAgentDefinitions(runtime, project.path, { roots, runtimeFactory })
        ).map((a) => a.id);
        for (const skipped of ["unresolved", "mixed"]) {
          expect(
            warn.mock.calls.some(([message]) => String(message).includes(`'${skipped}'`))
          ).toBe(true);
        }
      } finally {
        warn.mockRestore();
      }
      expect(ids).toContain("reviewer");
      expect(ids).toContain("no-writes");
      expect(ids).not.toContain("unresolved");
      expect(ids).not.toContain("mixed");

      const toolsOf = async (agentId: string) => {
        const id = AgentIdSchema.parse(agentId);
        const agentDefinition = await readAgentDefinition(runtime, project.path, id, {
          roots,
          runtimeFactory,
        });
        const chain = await resolveAgentInheritanceChain({
          runtime,
          workspacePath: project.path,
          agentId: id,
          agentDefinition,
          workspaceId: "ws",
          runtimeFactory,
        });
        const policy = resolveToolPolicyForAgent({
          agents: chain,
          isSubagent: true,
          disableTaskToolsForDepth: false,
        });
        return applyToolPolicyToNames(sampleTools, policy);
      };
      const sampleTools = [
        "agent_report",
        "bash",
        "bash_output",
        "file_read",
        "file_edit_insert",
        "file_edit_replace_string",
        "task",
        "task_await",
        "task_apply_git_patch",
        "workflow_run",
        "web_fetch",
        "todo_write",
        "memory",
        "github_create_issue",
      ];
      // agent_report stays: every non-plan sub-agent reports through it.
      expect(await toolsOf("reviewer")).toEqual([
        "agent_report",
        "bash",
        "bash_output",
        "file_read",
      ]);
      const exec = await toolsOf("exec");
      expect(await toolsOf("no-writes")).toEqual(
        // Workflows spawn sub-agents too, so denying Agent removes them.
        exec.filter((tool) => !/^(file_edit_|task|workflow_)/.test(tool))
      );
    });

    test("remote runtimes list global host plugin agents but not project plugin agents", async () => {
      using hostHome = new DisposableTempDir("agent-defs-remote-plugin-host-home");
      using checkout = new DisposableTempDir("agent-defs-remote-plugin-checkout");
      await writePluginWithAgent(
        path.join(hostHome.path, "plugins"),
        "host-plugin",
        "host-helper",
        "Host Helper"
      );
      await writePluginWithAgent(
        path.join(checkout.path, ".xum", "plugins"),
        "checkout-plugin",
        "checkout-helper",
        "Checkout Helper"
      );
      // Identity mapping: the checkout path also exists on the host, so a regression
      // that scans project plugin containers with the host runtime would find it.
      const runtime = new RemotePathMappedRuntime(checkout.path, checkout.path);

      const previousRoot = process.env.XUM_ROOT;
      process.env.XUM_ROOT = hostHome.path;
      try {
        const agents = await discoverAgentDefinitions(runtime, checkout.path, { runtimeFactory });
        expect(agents.find((agent) => agent.id === "host-helper")).toMatchObject({
          scope: "global",
          pluginName: "host-plugin",
        });
        expect(agents.some((agent) => agent.id === "checkout-helper")).toBe(false);

        const pkg = await readAgentDefinition(runtime, checkout.path, "host-helper", {
          runtimeFactory,
        });
        expect(pkg.scope).toBe("global");
        expect(pkg.frontmatter.name).toBe("Host Helper");
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test types `rejects` as void
        await expect(
          readAgentDefinition(runtime, checkout.path, "checkout-helper", { runtimeFactory })
        ).rejects.toThrow("Agent definition not found");
      } finally {
        if (previousRoot === undefined) delete process.env.XUM_ROOT;
        else process.env.XUM_ROOT = previousRoot;
      }
    });

    test("a trusted remote checkout's plugin agents load from one cached listing (#6426)", async () => {
      using checkoutDir = new DisposableTempDir("agent-defs-remote-checkout-plugins");
      const checkout = await fs.realpath(checkoutDir.path);
      const container = path.join(checkout, ".xum", "plugins");
      await writePluginWithAgent(container, "kit", "remote-helper", "Remote Helper");
      // An agent file that is a link (here to a file outside its plugin) is not listed.
      await writeAgent(path.join(checkout, "outside"), "escaped", "Escaped");
      await fs.symlink(
        path.join(checkout, "outside", "escaped.md"),
        path.join(container, "kit", "agents", "escaped.md")
      );
      const runtime = new HostKeyShellRemoteRuntime(checkout, "agents-remote-plugins");

      const agents = await discoverAgentDefinitions(runtime, checkout, {
        projectPluginsTrusted: true,
        runtimeFactory,
      });
      expect(agents.find((agent) => agent.id === "remote-helper")).toMatchObject({
        scope: "project",
        pluginName: "kit",
      });
      expect(agents.some((agent) => agent.id === "escaped")).toBe(false);
      const pkg = await readAgentDefinition(runtime, checkout, "remote-helper", {
        projectPluginsTrusted: true,
        runtimeFactory,
      });
      expect(pkg.frontmatter.name).toBe("Remote Helper");
      // The listing and the read by id share one remote listing.
      expect(runtime.pluginListings).toBe(1);
      // A warm turn lists skills and agents from the same snapshot: no remote command touches the
      // plugin folders (plain .xum/skills and .xum/agents roots keep their own reads).
      const before = runtime.commands.length;
      await discoverAgentSkills(runtime, checkout, { projectPluginsTrusted: true, runtimeFactory });
      await discoverAgentDefinitions(runtime, checkout, {
        projectPluginsTrusted: true,
        runtimeFactory,
      });
      const warm = runtime.commands.slice(before);
      expect(warm.some((command) => command.includes(container))).toBe(false);
      expect(runtime.pluginListings).toBe(1);

      // Untrusted: no remote plugin agents and no listing.
      const untrusted = new HostKeyShellRemoteRuntime(checkout, "agents-remote-untrusted");
      const plain = await discoverAgentDefinitions(untrusted, checkout, { runtimeFactory });
      expect(plain.some((agent) => agent.id === "remote-helper")).toBe(false);
      expect(untrusted.pluginListings).toBe(0);
    });

    test("readAgentDefinition falls back to a plugin agent when no project/global agent exists", async () => {
      using project = new DisposableTempDir("agent-defs-plugin-project");
      using global = new DisposableTempDir("agent-defs-plugin-global");

      const pluginContainer = path.join(project.path, ".mux", "plugins");
      await writePluginWithAgent(pluginContainer, "my-plugin", "helper", "Helper (plugin)");

      const roots = {
        projectRoots: [path.join(project.path, ".mux", "agents")],
        globalRoot: global.path,
        projectPluginRoots: [pluginContainer],
      };
      const runtime = new LocalRuntime(project.path);

      const pkg = await readAgentDefinition(runtime, project.path, "helper", {
        roots,
        runtimeFactory,
      });
      expect(pkg.scope).toBe("project");
      expect(pkg.frontmatter.name).toBe("Helper (plugin)");
    });
  });
});

// #4438: on SSH runtimes a transport failure says nothing about an agent file.
// It must never let a lower scope, a truncated base chain or a skipped root win.
describe("transport failures", () => {
  const networkError = () => new RuntimeError("ssh: Connection refused", "network");
  const agent = (body: string, base?: string) =>
    `---\nname: ${body}\n${base ? `base: ${base}\n` : ""}---\n${body}`;

  async function scopedAgents(tempDir: string) {
    const projectRoot = path.join(tempDir, "project-agents");
    const globalRoot = path.join(tempDir, "global-agents");
    await fs.mkdir(projectRoot);
    await fs.mkdir(globalRoot);
    await fs.writeFile(path.join(globalRoot, "reviewer.md"), agent("Global"));
    return { projectRoot, globalRoot, roots: { projectRoots: [projectRoot], globalRoot } };
  }

  test("a project agent that fails in transport does not fall back to global", async () => {
    using tempDir = new DisposableTempDir("agent-transport-scope");
    const { projectRoot, roots } = await scopedAgents(tempDir.path);
    await fs.writeFile(path.join(projectRoot, "reviewer.md"), agent("Project"));
    const runtime = new LocalRuntime(tempDir.path);
    const stat = runtime.stat.bind(runtime);
    spyOn(runtime, "stat").mockImplementation((filePath, signal) =>
      filePath.startsWith(projectRoot) ? Promise.reject(networkError()) : stat(filePath, signal)
    );

    const read = readAgentDefinition(runtime, tempDir.path, "reviewer", { roots, runtimeFactory });
    expect(await read.catch((error: unknown) => error)).toMatchObject({ type: "network" });
    // A skipped root in discovery is the same fallback.
    spyOn(runtime, "resolvePath").mockRejectedValue(networkError());
    const discovered = discoverAgentDefinitions(runtime, tempDir.path, { roots, runtimeFactory });
    expect(await discovered.catch((error: unknown) => error)).toMatchObject({ type: "network" });
  });

  test("a missing project agent still falls back to global", async () => {
    using tempDir = new DisposableTempDir("agent-transport-control");
    const { roots } = await scopedAgents(tempDir.path);
    const runtime = new LocalRuntime(tempDir.path);

    const resolved = await readAgentDefinition(runtime, tempDir.path, "reviewer", {
      roots,
      runtimeFactory,
    });
    expect(resolved.scope).toBe("global");
  });

  test("a base agent that fails in transport does not truncate the chain", async () => {
    using tempDir = new DisposableTempDir("agent-transport-base");
    const agentsDir = path.join(tempDir.path, ".xum", "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(path.join(agentsDir, "child.md"), agent("Child", "parent"));
    await fs.writeFile(path.join(agentsDir, "parent.md"), agent("Parent"));
    const runtime = new LocalRuntime(tempDir.path);
    const child = await readAgentDefinition(runtime, tempDir.path, "child", { runtimeFactory });
    const stat = runtime.stat.bind(runtime);
    spyOn(runtime, "stat").mockImplementation((filePath, signal) =>
      filePath.endsWith("parent.md") ? Promise.reject(networkError()) : stat(filePath, signal)
    );

    const chain = resolveAgentInheritanceChain({
      runtime,
      workspacePath: tempDir.path,
      agentId: "child",
      agentDefinition: child,
      workspaceId: "ws",
      runtimeFactory,
    });
    expect(await chain.catch((error: unknown) => error)).toMatchObject({ type: "network" });
  });
});

// #4827: a permission error is not a missing agent file either.
test("an unreadable project agent or base neither falls back nor truncates the chain", async () => {
  using tempDir = new DisposableTempDir("agent-unreadable");
  const agentsDir = path.join(tempDir.path, ".xum", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  const agent = (name: string, base?: string) =>
    `---\nname: ${name}\n${base ? `base: ${base}\n` : ""}---\n${name}`;
  await fs.writeFile(path.join(agentsDir, "child.md"), agent("Child", "exec"));
  await fs.writeFile(path.join(agentsDir, "exec.md"), agent("Project exec"));
  const runtime = new LocalRuntime(tempDir.path);
  const child = await readAgentDefinition(runtime, tempDir.path, "child", { runtimeFactory });
  const stat = runtime.stat.bind(runtime);
  spyOn(runtime, "stat").mockImplementation((filePath, signal) =>
    filePath.endsWith("exec.md")
      ? Promise.reject(
          new RuntimeError(
            `Failed to stat ${filePath}: stat: ${filePath}: Permission denied`,
            "file_io"
          )
        )
      : stat(filePath, signal)
  );

  // Before #4827 this silently resolved the built-in exec.
  const read = readAgentDefinition(runtime, tempDir.path, "exec", { runtimeFactory });
  expect(await read.catch((error: unknown) => error)).toMatchObject({ type: "file_io" });
  const chain = resolveAgentInheritanceChain({
    runtime,
    workspacePath: tempDir.path,
    agentId: "child",
    agentDefinition: child,
    workspaceId: "ws",
    runtimeFactory,
  });
  expect(await chain.catch((error: unknown) => error)).toMatchObject({ type: "file_io" });
});

describe("agentDefinitionsService host filesystem", () => {
  test("lists, contains and reads agents on the host filesystem of its RuntimeFactory", async () => {
    // Phase 5: the reads beside the runtime (listing, plugin discovery, containment and the
    // plugin agent read) go through the factory's HostFiles. These agents exist only on the
    // memory host, so the Node filesystem finds neither.
    const host = createMemoryHost();
    const write = async (filePath: string, text: string): Promise<void> => {
      await host.files.promises.mkdir(path.dirname(filePath), { recursive: true });
      await host.files.promises.writeFile(filePath, text);
    };
    await write("/ws/.xum/agents/helper.md", "---\nname: Helper\n---\nHelp.\n");
    const plugin = path.join(MEMORY_USER_HOME, ".agents", "plugins", "kit");
    await write(
      path.join(plugin, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "kit",
      })
    );
    await write(path.join(plugin, "agents", "reviewer.md"), "---\nname: Reviewer\n---\nReview.\n");
    const options = { runtimeFactory: fakeRuntimeFactory(host) };

    const agents = await discoverAgentDefinitions(host.runtime, "/ws", options);
    const reviewer = await readAgentDefinition(
      host.runtime,
      "/ws",
      AgentIdSchema.parse("reviewer"),
      options
    );

    const found = agents.map((agent) => `${agent.id}:${agent.scope}`);
    expect(found).toContain("helper:project");
    expect(found).toContain("reviewer:global");
    expect(reviewer.body).toContain("Review.");
  });
});
