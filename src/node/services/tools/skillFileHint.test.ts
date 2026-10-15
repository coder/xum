import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { BashToolResult, FileReadToolResult } from "@/common/types/tools";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { createAgentSkillReadFileTool } from "./agent_skill_read_file";
import { createBashTool } from "./bash";
import { createFileReadTool } from "./file_read";
import {
  createTestToolConfig,
  mockToolCallOptions,
  TestTempDir,
  writeGlobalSkill,
  writeProjectSkill,
} from "./testHelpers";

// One paragraph on one line, longer than the 1024-byte line cut of file_read and bash.
const LONG_LINE = `${"word ".repeat(400)}END`;

async function setup(tmp: TestTempDir) {
  await writeProjectSkill(tmp.path, "demo", {
    body: `Intro\n${LONG_LINE}`,
    files: { "playbooks/long.md": `# Playbook\n${LONG_LINE}\n` },
  });
  const skillDir = path.join(tmp.path, ".xum", "skills", "demo");
  await fs.writeFile(path.join(tmp.path, "plain.md"), `# Plain\n${LONG_LINE}\n`);
  const config: ToolConfiguration = createTestToolConfig(tmp.path, {
    workspaceId: "regular-workspace",
    xumScope: {
      type: "project",
      xumHome: tmp.path,
      projectRoot: tmp.path,
      projectStorageAuthority: "host-local",
    },
  });
  return { config, skillDir };
}

async function fileRead(config: ToolConfiguration, filePath: string) {
  const tool = createFileReadTool(config);
  const result = (await tool.execute!(
    { path: filePath },
    mockToolCallOptions
  )) as FileReadToolResult;
  if (!result.success) throw new Error(result.error);
  return result;
}

async function bashNote(config: ToolConfiguration, script: string) {
  const tool = createBashTool(config);
  const result = (await tool.execute!(
    { script, timeout_secs: 10, run_in_background: false, display_name: "read" },
    mockToolCallOptions
  )) as BashToolResult;
  expect(result.success).toBe(true);
  return "note" in result ? (result.note ?? "") : "";
}

describe("skill file hint", () => {
  it("file_read names the agent_skill_read_file call for a cut skill file, and that call returns it whole", async () => {
    using tmp = new TestTempDir("skill-file-hint-inside");
    const { config, skillDir } = await setup(tmp);

    const result = await fileRead(config, path.join(skillDir, "playbooks", "long.md"));

    // file_read output itself is unchanged: the line is still cut.
    expect(result.content).toContain("... [truncated]");
    expect(result.note).toContain(
      'agent_skill_read_file (name: "demo", filePath: "playbooks/long.md")'
    );

    const whole = await createAgentSkillReadFileTool(config).execute!(
      { name: "demo", filePath: "playbooks/long.md" },
      mockToolCallOptions
    );
    expect(whole).toMatchObject({ success: true, content: `1\t# Playbook\n2\t${LONG_LINE}\n3\t` });
  });

  it("file_read adds no note outside skill directories, or when no line is cut", async () => {
    using tmp = new TestTempDir("skill-file-hint-outside");
    const { config, skillDir } = await setup(tmp);
    await fs.writeFile(path.join(skillDir, "short.md"), "short\n");
    // A SKILL.md that no skill root discovers does not make a skill directory.
    await writeProjectSkill(path.join(tmp.path, "undiscovered"), "fake", {
      files: { "long.md": LONG_LINE },
    });

    for (const filePath of [
      path.join(tmp.path, "plain.md"),
      path.join(skillDir, "short.md"),
      path.join(tmp.path, "undiscovered", ".xum", "skills", "fake", "long.md"),
    ]) {
      const result = await fileRead(config, filePath);
      expect(result.note).toBeUndefined();
    }
  });

  it("file_read names no call that would read another skill's file", async () => {
    using tmp = new TestTempDir("skill-file-hint-shadowed");
    const { config } = await setup(tmp);
    // The project skill "demo" shadows this global one: agent_skill_read_file
    // with "demo" reads the project copy, so pointing there would be wrong.
    await writeGlobalSkill(tmp.path, "demo", { files: { "playbooks/long.md": LONG_LINE } });

    const result = await fileRead(
      config,
      path.join(tmp.path, "skills", "demo", "playbooks", "long.md")
    );
    expect(result.note).toBeUndefined();
  });

  it("file_read names the skill a `..` path lands in", async () => {
    using tmp = new TestTempDir("skill-file-hint-dotdot");
    const { config, skillDir } = await setup(tmp);
    await writeProjectSkill(tmp.path, "other", { files: { "long.md": LONG_LINE } });

    const result = await fileRead(config, `${skillDir}/playbooks/../../other/long.md`);
    expect(result.note).toContain('agent_skill_read_file (name: "other", filePath: "long.md")');
  });

  it("file_read adds no note for paths that only look inside a skill directory", async () => {
    using tmp = new TestTempDir("skill-file-hint-lookalike");
    const { config, skillDir } = await setup(tmp);
    await fs.symlink(path.join(tmp.path, "plain.md"), path.join(skillDir, "linked.md"));

    for (const filePath of [
      // `..` leaves the skill directory before any lookup.
      `${skillDir}/playbooks/../../../../plain.md`,
      // The link sits in the skill directory, but its target does not.
      path.join(skillDir, "linked.md"),
    ]) {
      const result = await fileRead(config, filePath);
      expect(result.content).toContain("... [truncated]");
      expect(result.note).toBeUndefined();
    }
  });

  it("bash names the agent_skill_read_file call when it cannot show a skill file", async () => {
    using tmp = new TestTempDir("skill-file-hint-bash");
    const { config, skillDir } = await setup(tmp);

    const inside = await bashNote(config, `head -c 6000 '${skillDir}/SKILL.md'; echo done`);
    expect(inside).toContain("per-line limit");
    expect(inside).toContain('agent_skill_read_file (name: "demo", filePath: "SKILL.md")');
    const whole = await createAgentSkillReadFileTool(config).execute!(
      { name: "demo", filePath: "SKILL.md" },
      mockToolCallOptions
    );
    expect(whole).toMatchObject({ success: true });
    expect((whole as { content: string }).content).toContain(`\t${LONG_LINE}`);

    const outside = await bashNote(config, `head -c 6000 ${tmp.path}/plain.md`);
    expect(outside).toContain("per-line limit");
    expect(outside).not.toContain("agent_skill_read_file");
  });
});
