// A plugin agent that Xum loads but refuses to spawn is named by its reason, not reported as an
// unknown agentId (plugin install methods RFC, A4). The agent definition service tests cover how
// each refusal arises; these tests cover how TaskService.create and createMany report it.
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "@/node/config";
import type { TaskService } from "@/node/services/taskService";
import * as agentDefinitionsService from "@/node/services/agentDefinitions/agentDefinitionsService";
import {
  PluginAgentRefusalError,
  type PluginAgentRefusalReason,
} from "@/node/services/agentDefinitions/pluginAgentRefusal";
import {
  createTestConfig,
  createWorkspaceServiceMocks,
  saveLocalParentWorkspace,
  stubStableIds,
} from "@/node/services/taskService.testHarness";
import {
  createAgentTask,
  createTaskServiceHarness,
  createTaskServiceTestRoot,
  removeTaskServiceTestRoot,
} from "@/node/services/taskService.shared.testHarness";

function workspaceIds(config: Config): string[] {
  return Array.from(config.loadConfigOrDefault().projects.values()).flatMap((project) =>
    project.workspaces.map((workspace) => workspace.id ?? "")
  );
}

/** The ways to spawn by ID: each reports its own `Task.<method>:` prefix. */
const SPAWNS = [
  {
    method: "create",
    spawn: (taskService: TaskService, parentId: string, agentId: string) =>
      createAgentTask(taskService, parentId, "go", { agentType: agentId }),
  },
  {
    method: "createMany",
    spawn: (taskService: TaskService, parentId: string, agentId: string) =>
      taskService.createMany([
        { parentWorkspaceId: parentId, kind: "agent", agentId, prompt: "go", title: "Test task" },
      ]),
  },
] as const;

describe("TaskService spawn refusals of plugin agents", () => {
  let rootDir: string;
  let config: Config;
  beforeEach(async () => {
    rootDir = await createTaskServiceTestRoot();
    config = await createTestConfig(rootDir);
    stubStableIds(config, ["aaaaaaaaaa"], "bbbbbbbbbb");
  });
  afterEach(async () => {
    mock.restore();
    await removeTaskServiceTestRoot(rootDir);
  });

  async function setup() {
    const parent = await saveLocalParentWorkspace(config, rootDir);
    const host = createWorkspaceServiceMocks();
    const { taskService } = createTaskServiceHarness(config, {
      workspaceService: host.workspaceService,
    });
    return { ...parent, taskService };
  }

  async function writeProjectPlugin(
    projectPath: string,
    agents: Record<string, string>
  ): Promise<void> {
    const pluginDir = path.join(projectPath, ".xum", "plugins", "egm");
    await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "egm",
      })
    );
    for (const [file, content] of Object.entries(agents)) {
      await fs.writeFile(path.join(pluginDir, "agents", file), content);
    }
  }

  for (const { method, spawn } of SPAWNS) {
    describe(`Task.${method}`, () => {
      test("names ambiguous-file when two files of one plugin claim the ID", async () => {
        const { parentId, projectPath, taskService } = await setup();
        const agent = "---\nname: Helper\ndescription: Helps\n---\nBody\n";
        await writeProjectPlugin(projectPath, { "Helper.md": agent, "helper.md": agent });

        const created = await spawn(taskService, parentId, "helper");

        expect(created.success).toBe(false);
        if (created.success) return;
        expect(created.error).toContain(
          `Task.${method}: ambiguous-file: plugin agent helper of egm`
        );
        expect(created.error).toContain("Helper.md, helper.md");
        expect(created.error).not.toContain("unknown agentId");
        expect(workspaceIds(config)).toEqual([parentId]);
      });

      test("names invalid-definition when the agent file does not parse", async () => {
        const { parentId, projectPath, taskService } = await setup();
        await writeProjectPlugin(projectPath, { "broken.md": "No frontmatter here.\n" });

        const created = await spawn(taskService, parentId, "broken");

        expect(created.success).toBe(false);
        if (created.success) return;
        expect(created.error).toContain(
          `Task.${method}: invalid-definition: plugin agent broken of egm`
        );
        expect(created.error).not.toContain("unknown agentId");
        expect(workspaceIds(config)).toEqual([parentId]);
      });

      for (const [reason, detail] of [
        ["not-reviewed", ""],
        ["folder-unreachable", "remote"],
      ] as const satisfies ReadonlyArray<readonly [PluginAgentRefusalReason, string]>) {
        // These need a managed plugin (a registry in the real Xum home) or a remote parent, so
        // the definition read is replaced by the refusal that the definition service tests prove.
        test(`names ${reason} when the definition read refuses the agent`, async () => {
          const { parentId, taskService } = await setup();
          const refusal = new PluginAgentRefusalError(reason, "design_critic", "egm", detail);
          const frontmatterRead = spyOn(
            agentDefinitionsService,
            "resolveAgentFrontmatter"
          ).mockRejectedValue(refusal);
          const definitionRead = spyOn(
            agentDefinitionsService,
            "resolveAgentDefinition"
          ).mockRejectedValue(refusal);

          const created = await spawn(taskService, parentId, "design_critic");

          // The spawn read opts in to the refusal of an unreachable plugin folder (R9).
          const spawnRead = method === "create" ? frontmatterRead : definitionRead;
          expect(spawnRead.mock.calls[0]?.[3]).toMatchObject({
            refuseUnreachablePluginFolder: true,
          });

          expect(created.success).toBe(false);
          if (created.success) return;
          expect(created.error).toBe(`Task.${method}: ${reason}: ${refusal.message}`);
          expect(workspaceIds(config)).toEqual([parentId]);
        });
      }

      test("keeps an unavailable plugin agent out of the runnable agentIds of an error hint", async () => {
        const { parentId, taskService } = await setup();
        const listed = {
          scope: "global" as const,
          uiSelectable: false,
          subagentRunnable: true,
          name: "Listed",
        };
        // `explore` is runnable on its own: only its unavailability keeps it out of the hint.
        spyOn(agentDefinitionsService, "discoverAgentDefinitions").mockResolvedValue([
          {
            ...listed,
            id: "explore",
            unavailableReason: "folder-unreachable: needs its folder",
            unavailablePath: "/plugins/egm/agents/explore.md",
          },
          { ...listed, id: "exec" },
        ]);

        const created = await spawn(taskService, parentId, "nosuchagent");

        expect(created.success).toBe(false);
        if (created.success) return;
        expect(created.error).toContain("unknown agentId (nosuchagent). Runnable agentIds: exec");
        expect(created.error).not.toContain("explore");
      });

      test("still says unknown agentId for an agent no scope has", async () => {
        const { parentId, projectPath, taskService } = await setup();
        await writeProjectPlugin(projectPath, {
          "other.md": "---\nname: Other\ndescription: Other\n---\nBody\n",
        });

        const created = await spawn(taskService, parentId, "nosuchagent");

        expect(created.success).toBe(false);
        if (created.success) return;
        expect(created.error).toContain(`Task.${method}: unknown agentId (nosuchagent)`);
      });
    });
  }
});
