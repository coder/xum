import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { XumToolScope } from "@/common/types/toolScope";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createAgentSkillDeleteTool } from "@/node/services/tools/agent_skill_delete";
import { createAgentSkillWriteTool } from "@/node/services/tools/agent_skill_write";
import {
  TestTempDir,
  createTestToolConfig,
  stubSandboxHidingTokenPath,
  writeProjectSkill,
  writeSkill,
} from "@/node/services/tools/testHelpers";
import { createXumAgentsWriteTool } from "@/node/services/tools/xum_agents_write";

const callOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "call",
  messages: [],
  context: undefined,
};

/** A system workspace in `home` whose commands run in a stand-in sandbox over `home`. */
function sandboxedGlobalConfig(home: string, sandboxed: boolean) {
  const runtime = createRuntime({ type: "local", srcBaseDir: home });
  if (sandboxed) {
    runtime.agentSandboxPolicy = () => ({
      writeRoots: [home],
      gitCommonDirs: [],
      denyWrite: [],
      denyRead: [],
      allowRead: [home],
      network: "allowlist",
      allowedHosts: [],
      allowLocalBinding: true,
    });
  }
  const xumScope: XumToolScope = { type: "global", xumHome: home };
  return createTestToolConfig(home, { runtime, xumScope });
}

// Every workspace loads the global skills and AGENTS.md, also one without the sandbox.
describe("global skill and AGENTS.md writes from a sandboxed system workspace", () => {
  it("refuses a global skill write, and allows it without the sandbox", async () => {
    using home = new TestTempDir("global-write-sandbox");
    const skillFile = path.join(home.path, "skills", "demo", "SKILL.md");
    const content = "---\nname: demo\ndescription: demo\n---\nbody\n";
    const write = (sandboxed: boolean) =>
      createAgentSkillWriteTool(sandboxedGlobalConfig(home.path, sandboxed)).execute!(
        { name: "demo", content },
        callOptions
      ) as Promise<{ success: boolean; error?: string }>;

    const refused = await write(true);
    expect(refused.error).toContain("agent sandbox");
    expect(await fs.stat(skillFile).catch(() => null)).toBeNull();

    expect((await write(false)).success).toBe(true);
  });

  it("refuses a global skill delete", async () => {
    using home = new TestTempDir("global-write-sandbox");
    await writeSkill(path.join(home.path, "skills"), "demo");
    const tool = createAgentSkillDeleteTool(sandboxedGlobalConfig(home.path, true));

    const result = (await tool.execute!(
      { name: "demo", target: "skill", confirm: true },
      callOptions
    )) as { success: boolean; error?: string };

    expect(result.error).toContain("agent sandbox");
    expect(await fs.stat(path.join(home.path, "skills", "demo")).catch(() => null)).not.toBeNull();
  });

  it("refuses a global AGENTS.md write", async () => {
    using home = new TestTempDir("global-write-sandbox");
    const tool = createXumAgentsWriteTool(sandboxedGlobalConfig(home.path, true));

    const result = (await tool.execute!(
      { newContent: "# Rules\n", confirm: true },
      callOptions
    )) as { success: boolean; error?: string };

    expect(result.error).toContain("agent sandbox");
    expect(await fs.stat(path.join(home.path, "AGENTS.md")).catch(() => null)).toBeNull();
  });
});

// Codex review: a project secret such as GIT_CONFIG_GLOBAL can name a file in a skill folder,
// which the sandbox then keeps read-only, and git runs what that config names outside it.
describe("project skill writes and deletes from a sandboxed workspace", () => {
  it("changes a skill file only where a sandboxed command could", async () => {
    using tempDir = new TestTempDir("project-skill-sandbox");
    const projectRoot = path.join(await fs.realpath(tempDir.path), "project");
    await writeProjectSkill(projectRoot, "demo");
    const gitConfig = path.join(projectRoot, ".xum", "skills", "demo", "gitconfig");
    await fs.writeFile(gitConfig, "[user]\n");
    const runtime = new LocalRuntime(projectRoot);
    stubSandboxHidingTokenPath(runtime, projectRoot, [gitConfig]);
    const xumScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };
    const config = createTestToolConfig(projectRoot, { runtime, xumScope });
    const write = (filePath: string) =>
      createAgentSkillWriteTool(config).execute!(
        { name: "demo", filePath, content: "[core]\n\tfsmonitor = evil\n" },
        callOptions
      ) as Promise<{ success: boolean; error?: string }>;

    expect((await write("gitconfig")).error).toContain("agent sandbox");
    const deleted = (await createAgentSkillDeleteTool(config).execute!(
      { name: "demo", target: "file", filePath: "gitconfig", confirm: true },
      callOptions
    )) as { success: boolean; error?: string };
    expect(deleted.error).toContain("agent sandbox");
    expect(await fs.readFile(gitConfig, "utf-8")).toBe("[user]\n");

    expect((await write("notes.md")).success).toBe(true);
  });

  it("keeps both manifests when the legacy one is read-only", async () => {
    using tempDir = new TestTempDir("project-skill-sandbox-legacy");
    const projectRoot = path.join(await fs.realpath(tempDir.path), "project");
    await writeProjectSkill(projectRoot, "demo");
    await writeSkill(path.join(projectRoot, ".mux", "skills"), "demo");
    const legacyManifest = path.join(projectRoot, ".mux", "skills", "demo", "SKILL.md");
    const runtime = new LocalRuntime(projectRoot);
    stubSandboxHidingTokenPath(runtime, projectRoot, [legacyManifest]);
    const xumScope: XumToolScope = {
      type: "project",
      xumHome: tempDir.path,
      projectRoot,
      projectStorageAuthority: "host-local",
    };

    const deleted = (await createAgentSkillDeleteTool(
      createTestToolConfig(projectRoot, { runtime, xumScope })
    ).execute!(
      { name: "demo", target: "file", filePath: "SKILL.md", confirm: true },
      callOptions
    )) as { success: boolean; error?: string };

    expect(deleted.error).toContain("agent sandbox");
    expect(await fs.stat(legacyManifest).catch(() => null)).not.toBeNull();
    const manifest = path.join(projectRoot, ".xum", "skills", "demo", "SKILL.md");
    expect(await fs.stat(manifest).catch(() => null)).not.toBeNull();
  });
});
