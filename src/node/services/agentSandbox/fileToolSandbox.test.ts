import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { XumToolScope } from "@/common/types/toolScope";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { createAgentSkillDeleteTool } from "@/node/services/tools/agent_skill_delete";
import { createAgentSkillWriteTool } from "@/node/services/tools/agent_skill_write";
import { TestTempDir, createTestToolConfig, writeSkill } from "@/node/services/tools/testHelpers";
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
