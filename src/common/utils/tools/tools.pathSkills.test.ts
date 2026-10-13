import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { PATH_SKILLS_RESULT_FIELD } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createPathSkillActivation } from "@/node/services/agentSkills/pathSkillActivation";
import type { InitStateManager } from "@/node/services/initStateManager";

import { getToolsForModel, type ToolConfiguration } from "./tools";

type ToolExecuteFn = (args: unknown, options: unknown) => Promise<unknown>;

const SKILLS: AgentSkillDescriptor[] = [
  { name: "ts-rules", description: "TypeScript rules", scope: "project", paths: ["**/*.ts"] },
  // disable-model-invocation: true normalizes to advertise: false and must never auto-surface.
  {
    name: "manual-ts",
    description: "Manual TS rules",
    scope: "project",
    paths: ["**/*.ts"],
    advertise: false,
  },
  { name: "general", description: "General", scope: "project" },
];

const initStateManager = { waitForInit: () => Promise.resolve() } as unknown as InitStateManager;

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "path-skills-"));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.writeFile(path.join(workspace, "src", "foo.ts"), "export const foo = 1;\n");
  await fs.writeFile(path.join(workspace, "src", "bar.ts"), "export const bar = 2;\n");
  await fs.writeFile(path.join(workspace, "README.md"), "# readme\n");
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function buildTools(
  messages: MuxMessage[] = [],
  extraConfig: Partial<ToolConfiguration> = {}
): Promise<Record<string, ToolExecuteFn>> {
  const runtime = new LocalRuntime(workspace);
  const tools = await getToolsForModel(
    "noop:model",
    {
      cwd: workspace,
      runtime,
      runtimeTempDir: os.tmpdir(),
      availableSkills: SKILLS,
      pathSkillActivation: createPathSkillActivation({
        skills: SKILLS,
        messages,
        cwd: workspace,
        runtime,
      }),
      ...extraConfig,
    },
    "ws-1",
    initStateManager
  );
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, tool.execute as ToolExecuteFn])
  );
}

let callCounter = 0;
async function call(
  execute: ToolExecuteFn,
  args: Record<string, unknown>,
  toolCallId = `call-${++callCounter}`
): Promise<Record<string, unknown>> {
  return (await execute(args, { toolCallId, messages: [] })) as Record<string, unknown>;
}

function surfacedNames(result: Record<string, unknown>): string[] | undefined {
  const field = result[PATH_SKILLS_RESULT_FIELD] as { skills: Array<{ name: string }> } | undefined;
  return field?.skills.map((skill) => skill.name);
}

describe("getToolsForModel - path-scoped skill activation", () => {
  test("file_read surfaces a matching model-invocable skill once per context window", async () => {
    const tools = await buildTools();

    const readme = await call(tools.file_read, { path: "README.md" });
    expect(readme.success).toBe(true);
    expect(surfacedNames(readme)).toBeUndefined();

    // A failed read consumes nothing.
    const missing = await call(tools.file_read, { path: "src/missing.ts" });
    expect(missing.success).toBe(false);
    expect(surfacedNames(missing)).toBeUndefined();

    // A code_execution-bridged read reaches the guest, not the model: no pointer.
    const bridged = await call(tools.file_read, { path: "src/foo.ts" }, "ptc-file_read-1");
    expect(surfacedNames(bridged)).toBeUndefined();

    const foo = await call(tools.file_read, { path: path.join(workspace, "src", "foo.ts") });
    expect(foo.success).toBe(true);
    expect(surfacedNames(foo)).toEqual(["ts-rules"]);

    const bar = await call(tools.file_read, { path: "src/bar.ts" });
    expect(surfacedNames(bar)).toBeUndefined();
  });

  test("file_edit_replace_string on a matching file surfaces the skill", async () => {
    const tools = await buildTools();
    const result = await call(tools.file_edit_replace_string, {
      path: "src/foo.ts",
      old_string: "foo = 1",
      new_string: "foo = 3",
    });
    expect(result.success).toBe(true);
    expect(surfacedNames(result)).toEqual(["ts-rules"]);
  });

  test("a skill the model reads earlier in the same turn is not pointed at again", async () => {
    const skillDir = path.join(workspace, ".xum", "skills", "ts-rules");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      '---\nname: ts-rules\ndescription: TypeScript rules\npaths: ["**/*.ts"]\n---\nUse strict types.\n'
    );
    // A project scope makes agent_skill_read resolve the workspace's own skills roots.
    const tools = await buildTools([], {
      xumScope: {
        type: "project",
        xumHome: workspace,
        projectRoot: workspace,
        projectStorageAuthority: "host-local",
      },
    });

    const read = await call(tools.agent_skill_read, { name: "ts-rules" });
    expect(read.success).toBe(true);
    expect(surfacedNames(await call(tools.file_read, { path: "src/foo.ts" }))).toBeUndefined();
  });

  test("a prior pointer, agent_skill_read or /skill snapshot in the window suppresses it; malformed rows do not throw", async () => {
    const toolPart = (toolName: string, input: unknown, output: unknown) =>
      ({
        type: "dynamic-tool",
        toolCallId: `${toolName}-prior`,
        toolName,
        state: "output-available",
        input,
        output,
      }) as unknown as MuxMessage["parts"][number];
    const malformed = [
      { id: "bad-1", role: "assistant", parts: "not-an-array" },
      { id: "bad-2", role: "assistant", parts: [null, 7, { type: "dynamic-tool", output: 3 }] },
    ] as unknown as MuxMessage[];

    const priorPointer = createMuxMessage("a1", "assistant", "", undefined, [
      toolPart(
        "file_read",
        { path: "src/old.ts" },
        { success: true, [PATH_SKILLS_RESULT_FIELD]: { skills: [{ name: "ts-rules" }] } }
      ),
    ]);
    const priorRead = createMuxMessage("a2", "assistant", "", undefined, [
      toolPart("agent_skill_read", { name: "ts-rules" }, { success: true }),
    ]);

    // A /ts-rules invocation materializes a snapshot row with the skill body.
    const priorSnapshot = createMuxMessage("u1", "user", "skill body", {
      synthetic: true,
      agentSkillSnapshot: { skillName: "ts-rules", scope: "project", sha256: "0" },
    });

    for (const history of [
      [...malformed, priorPointer],
      [...malformed, priorRead],
      [...malformed, priorSnapshot],
    ]) {
      const tools = await buildTools(history);
      expect(surfacedNames(await call(tools.file_read, { path: "src/foo.ts" }))).toBeUndefined();
    }

    // Malformed rows alone still allow activation.
    const tools = await buildTools(malformed);
    expect(surfacedNames(await call(tools.file_read, { path: "src/foo.ts" }))).toEqual([
      "ts-rules",
    ]);
  });
});
