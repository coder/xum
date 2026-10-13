import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, spyOn } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";

import { AgentSkillReadToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS } from "@/common/constants/toolLimits";
const GLOBAL_WORKSPACE_ID = "workspace-global";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import { WorktreeRuntime } from "@/node/runtime/WorktreeRuntime";
import { execBuffered } from "@/node/utils/runtime/helpers";
import { createAgentSkillReadTool } from "./agent_skill_read";
import { createTestToolConfig, TestTempDir, TrueRemotePathMappedRuntime } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

async function writeProjectSkill(
  workspacePath: string,
  name: string,
  options?: {
    description?: string;
    body?: string;
  }
): Promise<void> {
  const skillDir = path.join(workspacePath, ".mux", "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? "test"}\n---\n${options?.body ?? "Body"}\n`,
    "utf-8"
  );
}

async function writeGlobalSkill(
  muxRoot: string,
  name: string,
  options?: {
    description?: string;
    body?: string;
  }
): Promise<void> {
  const skillDir = path.join(muxRoot, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${options?.description ?? "test"}\n---\n${options?.body ?? "Body"}\n`,
    "utf-8"
  );
}

function restoreMuxRoot(previousMuxRoot: string | undefined): void {
  if (previousMuxRoot === undefined) {
    delete process.env.MUX_ROOT;
    return;
  }

  process.env.MUX_ROOT = previousMuxRoot;
}

class RemotePathMappedRuntime extends LocalRuntime {
  private readonly localBase: string;
  private readonly remoteBase: string;

  constructor(localBase: string, remoteBase: string) {
    super(localBase);
    this.localBase = path.resolve(localBase);
    this.remoteBase = remoteBase === "/" ? remoteBase : remoteBase.replace(/\/+$/u, "");
  }

  private toLocalPath(runtimePath: string): string {
    const normalizedRuntimePath = runtimePath.replaceAll("\\", "/");

    if (normalizedRuntimePath === this.remoteBase) {
      return this.localBase;
    }

    if (normalizedRuntimePath.startsWith(`${this.remoteBase}/`)) {
      const suffix = normalizedRuntimePath.slice(this.remoteBase.length + 1);
      return path.join(this.localBase, ...suffix.split("/"));
    }

    return runtimePath;
  }

  private toRemotePath(localPath: string): string {
    const resolvedLocalPath = path.resolve(localPath);

    if (resolvedLocalPath === this.localBase) {
      return this.remoteBase;
    }

    const localPrefix = `${this.localBase}${path.sep}`;
    if (resolvedLocalPath.startsWith(localPrefix)) {
      const suffix = resolvedLocalPath.slice(localPrefix.length).split(path.sep).join("/");
      return `${this.remoteBase}/${suffix}`;
    }

    return localPath.replaceAll("\\", "/");
  }

  override normalizePath(targetPath: string, basePath: string): string {
    const normalizedBasePath = this.toRemotePath(basePath);
    return path.posix.resolve(normalizedBasePath, targetPath.replaceAll("\\", "/"));
  }

  override async resolvePath(filePath: string): Promise<string> {
    const resolvedLocalPath = await super.resolvePath(this.toLocalPath(filePath));
    return this.toRemotePath(resolvedLocalPath);
  }

  override stat(filePath: string, abortSignal?: AbortSignal): ReturnType<LocalRuntime["stat"]> {
    return super.stat(this.toLocalPath(filePath), abortSignal);
  }

  override readFile(
    filePath: string,
    abortSignal?: AbortSignal
  ): ReturnType<LocalRuntime["readFile"]> {
    return super.readFile(this.toLocalPath(filePath), abortSignal);
  }
}

describe("agent_skill_read", () => {
  it("allows reading built-in skills", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global-scope");
    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });

    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "xum-docs" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("built-in");
      expect(result.skill.frontmatter.name).toBe("xum-docs");
      // Bundled in the app: no fake path, but a reason the model can act on.
      expect(result.skillDir).toBeUndefined();
      expect(result.skillDirUnavailable).toMatch(/built-in/i);
    }
  });

  it("allows reading global skills on disk in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global");
    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = tempDir.path;

    try {
      await writeGlobalSkill(tempDir.path, "foo");

      const baseConfig = createTestToolConfig(tempDir.path, {
        workspaceId: GLOBAL_WORKSPACE_ID,
      });
      const tool = createAgentSkillReadTool(baseConfig);

      const raw: unknown = await Promise.resolve(
        tool.execute!({ name: "foo" }, mockToolCallOptions)
      );

      const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
      expect(parsed.success).toBe(true);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const result = parsed.data;
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.skill.scope).toBe("global");
        expect(result.skill.frontmatter.name).toBe("foo");
      }
    } finally {
      restoreMuxRoot(previousMuxRoot);
    }
  });

  it("prefers global skills over workspace-local shadows in global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-global-shadowing");

    await writeProjectSkill(tempDir.path, "shadowed-skill", {
      description: "workspace-local shadow",
      body: "Local body",
    });
    await writeGlobalSkill(tempDir.path, "shadowed-skill", {
      description: "global winner",
      body: "Global body",
    });

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: GLOBAL_WORKSPACE_ID,
    });
    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "shadowed-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("global");
      expect(result.skill.frontmatter.description).toBe("global winner");
      expect(result.skill.body.trim()).toBe("Global body");
    }
  });

  it("allows reading project skills on disk outside global-scope workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project");
    await writeProjectSkill(tempDir.path, "project-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: tempDir.path,
        projectStorageAuthority: "host-local",
      },
    });
    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "project-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.scope).toBe("project");
      expect(result.skill.frontmatter.name).toBe("project-skill");
    }
  });

  it("rejects project skill when skill directory symlink escapes project root", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project-escape");

    const projectRoot = path.join(tempDir.path, "project");
    const skillsDir = path.join(projectRoot, ".mux", "skills");
    await fs.mkdir(skillsDir, { recursive: true });

    // Create external skill directory OUTSIDE project root.
    const externalDir = path.join(tempDir.path, "external", "leaky-skill");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "SKILL.md"),
      "---\nname: leaky-skill\ndescription: should not be readable\n---\nSecret body\n",
      "utf-8"
    );

    await fs.symlink(
      externalDir,
      path.join(skillsDir, "leaky-skill"),
      process.platform === "win32" ? "junction" : "dir"
    );

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    const tool = createAgentSkillReadTool(baseConfig);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "leaky-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);

    const result = parsed.data;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("reads project skill via xumScope when cwd differs (remote-like split root)", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-project-split-root");
    const hostProjectRoot = tempDir.path;
    const remoteStyleCwd = "/remote/workspace/path";

    await writeProjectSkill(hostProjectRoot, "my-skill");

    const baseConfig = createTestToolConfig(tempDir.path, {
      workspaceId: "regular-workspace",
      xumScope: {
        type: "project",
        xumHome: tempDir.path,
        projectRoot: hostProjectRoot,
        projectStorageAuthority: "host-local",
      },
    });
    const config = { ...baseConfig, cwd: remoteStyleCwd };

    const tool = createAgentSkillReadTool(config);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "my-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.directoryName).toBe("my-skill");
      expect(result.skill.scope).toBe("project");
    }
  });

  it("preserves active runtime in split-root project context (SSH/Docker)", async () => {
    const remoteWorkspacePath = "/remote/workspace";
    using tempDir = new TestTempDir("test-agent-skill-read-split-root-runtime-preserved");
    const hostProjectRoot = tempDir.path;

    const remoteSkillDir = path.join(tempDir.path, "remote-skills", "test-skill");
    await fs.mkdir(remoteSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(remoteSkillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: remote skill\n---\nRemote body",
      "utf-8"
    );

    const remoteRuntime = new RemotePathMappedRuntime(
      path.join(tempDir.path, "remote-skills"),
      "/remote/workspace/.mux/skills"
    );

    const baseConfig = createTestToolConfig(tempDir.path, {
      runtime: remoteRuntime,
      xumScope: {
        type: "project",
        xumHome: path.join(tempDir.path, "mux-home"),
        projectRoot: hostProjectRoot,
        projectStorageAuthority: "runtime",
      },
    });
    const config = { ...baseConfig, cwd: remoteWorkspacePath };

    const tool = createAgentSkillReadTool(config);

    const raw: unknown = await Promise.resolve(
      tool.execute!({ name: "test-skill" }, mockToolCallOptions)
    );

    const parsed = AgentSkillReadToolResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const result = parsed.data;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skill.body).toContain("Remote body");
    }
  });

  function skillIndexLines(availableSkills: AgentSkillDescriptor[]): string[] {
    using tempDir = new TestTempDir("test-agent-skill-read-index");
    const tool = createAgentSkillReadTool({
      ...createTestToolConfig(tempDir.path),
      availableSkills,
    });
    // The ai SDK types `description` as string | dynamic-function; the factory always
    // builds a static string.
    const description = typeof tool.description === "string" ? tool.description : "";
    return description.split("\n");
  }

  it("appends whenToUse guidance only for skills that carry it in the description index", () => {
    const lines = skillIndexLines([
      {
        name: "with-guidance",
        description: "Skill carrying extra guidance",
        scope: "global",
        whenToUse: "only when triaging incoming issues",
      },
      {
        name: "without-guidance",
        description: "Skill without extra guidance",
        scope: "global",
      },
    ]);
    const withLine = lines.find((line) => line.startsWith("- with-guidance:"));
    const withoutLine = lines.find((line) => line.startsWith("- without-guidance:"));

    expect(withLine).toContain("only when triaging incoming issues");
    expect(withoutLine).toBeDefined();
    expect(withoutLine).not.toContain("When to use:");
  });

  it("keeps each index description on one line within the length cap", () => {
    const lines = skillIndexLines([
      {
        name: "long",
        description: "x".repeat(AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS + 50),
        scope: "global",
      },
      { name: "short", description: "Short description", scope: "global" },
      { name: "multi-line", description: "First line\n  second   line", scope: "global" },
    ]);
    const descriptionOf = (name: string) =>
      lines
        .find((line) => line.startsWith(`- ${name}: `))
        ?.slice(`- ${name}: `.length)
        .replace(/ \(scope: global\)$/, "");

    const long = descriptionOf("long");
    expect(long).toHaveLength(AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS);
    expect(long?.endsWith("…")).toBe(true);
    expect(descriptionOf("short")).toBe("Short description");
    expect(descriptionOf("multi-line")).toBe("First line second line");
  });

  it("does not split a surrogate pair at the length cap", () => {
    // Providers reject a request body whose strings hold a lone surrogate, and the index sits in
    // every request's tool block.
    const prefix = "x".repeat(AGENT_SKILL_INDEX_DESCRIPTION_MAX_CHARS - 2);
    const lines = skillIndexLines([
      { name: "emoji", description: `${prefix}\u{1F642} and more`, scope: "global" },
    ]);

    // The pair straddles the cut, so it is dropped whole instead of keeping its high half.
    expect(lines).toContain(`- emoji: ${prefix}… (scope: global)`);
  });
});

describe("agent_skill_read skill directory", () => {
  const PLUGIN_MANIFEST = JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "demo-plugin",
    version: "1.0.0",
    description: "demo",
  });

  // A skill that ships a script: the body names it only through placeholders,
  // never through an install path.
  async function writeScriptSkill(skillDir: string, name: string, marker: string) {
    await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "scripts", "hello.sh"), `echo ${marker}\n`, "utf-8");
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${name}\ndescription: test\n---\nRun:\nsh \${CLAUDE_SKILL_DIR}/scripts/hello.sh\n`,
      "utf-8"
    );
  }

  async function readSkill(config: ReturnType<typeof createTestToolConfig>, name: string) {
    const raw: unknown = await Promise.resolve(
      createAgentSkillReadTool(config).execute!({ name }, mockToolCallOptions)
    );
    const parsed = AgentSkillReadToolResultSchema.parse(raw);
    if (!parsed.success) throw new Error(parsed.error);
    return parsed;
  }

  /** Run the body's `sh ...` line the way the model would: through bash in the workspace. */
  async function runBodyCommand(runtime: Runtime, cwd: string, body: string): Promise<string> {
    const command = body.split("\n").find((line) => line.startsWith("sh "));
    if (command == null) throw new Error(`no command in body: ${body}`);
    const result = await execBuffered(runtime, command, { cwd, timeout: 10 });
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  }

  for (const runtimeKind of ["local", "worktree"] as const) {
    it(`runs bundled scripts of every on-disk scope in a ${runtimeKind} workspace`, async () => {
      using tempDir = new TestTempDir(`test-agent-skill-read-dir-${runtimeKind}`);
      // realpath: discovery canonicalizes roots, and macOS tmp dirs are symlinks.
      const root = await fs.realpath(tempDir.path);
      const projectRoot = path.join(root, "project");
      const xumHome = path.join(root, "xum-home");
      const home = path.join(root, "home");
      const pluginRoot = path.join(projectRoot, ".xum", "plugins", "demo-plugin");

      const skills = {
        "project-skill": path.join(projectRoot, ".xum", "skills", "project-skill"),
        "global-skill": path.join(xumHome, "skills", "global-skill"),
        "universal-skill": path.join(home, ".agents", "skills", "universal-skill"),
        "plugin-skill": path.join(pluginRoot, "skills", "plugin-skill"),
      };
      for (const [name, dir] of Object.entries(skills)) {
        await writeScriptSkill(dir, name, `ran-${name}`);
      }
      await fs.writeFile(path.join(pluginRoot, "plugin.json"), PLUGIN_MANIFEST, "utf-8");

      const runtime: Runtime =
        runtimeKind === "local"
          ? new LocalRuntime(projectRoot)
          : new WorktreeRuntime(path.join(root, "src"));
      const config = createTestToolConfig(projectRoot, {
        runtime,
        xumScope: {
          type: "project",
          xumHome,
          projectRoot,
          projectStorageAuthority: "host-local",
        },
      });

      const homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        for (const [name, dir] of Object.entries(skills)) {
          const result = await readSkill(config, name);
          expect(result.skillDir).toBe(dir);
          expect(result.skillDirUnavailable).toBeUndefined();
          expect(result.pluginRoot).toBe(name === "plugin-skill" ? pluginRoot : undefined);
          expect(await runBodyCommand(runtime, projectRoot, result.skill.body)).toBe(`ran-${name}`);
        }
      } finally {
        homedirSpy.mockRestore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
  }

  it("reports no skill directory for a global host plugin skill in a remote workspace", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-remote-plugin");
    const root = await fs.realpath(tempDir.path);
    // The Xum host's home holds the plugin; the remote checkout does not.
    const hostXumHome = path.join(root, "host-xum-home");
    await writeScriptSkill(
      path.join(hostXumHome, "plugins", "demo-plugin", "skills", "host-plugin-skill"),
      "host-plugin-skill",
      "ran-host-plugin-skill"
    );
    await fs.writeFile(
      path.join(hostXumHome, "plugins", "demo-plugin", "plugin.json"),
      PLUGIN_MANIFEST,
      "utf-8"
    );
    const remoteBase = path.join(root, "remote");
    await fs.mkdir(path.join(remoteBase, "workspace"), { recursive: true });
    const runtime = new TrueRemotePathMappedRuntime(remoteBase, "/remote");
    const config = {
      ...createTestToolConfig(root, {
        runtime,
        xumScope: {
          type: "project",
          xumHome: hostXumHome,
          projectRoot: "/remote/workspace",
          projectStorageAuthority: "runtime",
        },
      }),
      cwd: "/remote/workspace",
    };

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = hostXumHome;
    try {
      const result = await readSkill(config, "host-plugin-skill");
      expect(result.skill.scope).toBe("global");
      // The host path would not exist where bash runs: none is offered, and the
      // reason points the model at agent_skill_read_file instead.
      expect(result.skillDir).toBeUndefined();
      expect(result.pluginRoot).toBeUndefined();
      expect(result.skillDirUnavailable).toContain("agent_skill_read_file");
      expect(result.skill.body).toContain("sh ${CLAUDE_SKILL_DIR}/scripts/hello.sh");
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} only for plugin skills, never ${PLUGIN_ROOT}", async () => {
    using tempDir = new TestTempDir("test-agent-skill-read-plugin-root");
    const projectRoot = await fs.realpath(tempDir.path);
    const pluginRoot = path.join(projectRoot, ".xum", "plugins", "demo-plugin");
    // ${PLUGIN_ROOT} is Agent Plugins MCP-config syntax; skills that document it keep it literal.
    const body = "shared: ${CLAUDE_PLUGIN_ROOT}/shared/x.sh mcp: ${PLUGIN_ROOT}";
    for (const dir of [
      path.join(pluginRoot, "skills", "plugin-skill"),
      path.join(projectRoot, ".xum", "skills", "project-skill"),
    ]) {
      await fs.mkdir(dir, { recursive: true });
      const name = path.basename(dir);
      await fs.writeFile(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: test\n---\n${body}\n`,
        "utf-8"
      );
    }
    await fs.writeFile(path.join(pluginRoot, "plugin.json"), PLUGIN_MANIFEST, "utf-8");
    const config = createTestToolConfig(projectRoot, {
      xumScope: {
        type: "project",
        xumHome: path.join(projectRoot, "xum-home"),
        projectRoot,
        projectStorageAuthority: "host-local",
      },
    });

    expect((await readSkill(config, "plugin-skill")).skill.body.trim()).toBe(
      `shared: ${pluginRoot}/shared/x.sh mcp: \${PLUGIN_ROOT}`
    );
    // Not a plugin skill: Claude Code leaves the placeholder literal too.
    expect((await readSkill(config, "project-skill")).skill.body.trim()).toBe(body);
  });
});
