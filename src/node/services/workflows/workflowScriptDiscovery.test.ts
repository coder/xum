import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { TestTempDir } from "@/node/services/tools/testHelpers";
import { discoverWorkflowScripts } from "./workflowScriptDiscovery";
// The Node layer: these tests read through host runtimes.
import { nodeRuntimeFactory as runtimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";

async function writePluginWithWorkflow(workspacePath: string, pluginName: string): Promise<void> {
  const pluginDir = path.join(workspacePath, ".mux", "plugins", pluginName);
  await fs.mkdir(path.join(pluginDir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: pluginName,
    }),
    "utf-8"
  );
  await fs.writeFile(
    path.join(pluginDir, "workflows", "release.js"),
    "export const meta = { name: 'plugin-release', description: 'Release helper workflow' };",
    "utf-8"
  );
}

describe("discoverWorkflowScripts (agent plugins)", () => {
  // Generous timeout: discovery probes every built-in/global skill for a
  // workflow.js entry, which is slow on machines with many installed skills.
  test("enumerates plugin workflows/ contributions", async () => {
    using tempDir = new TestTempDir("workflow-discovery-plugin");
    await writePluginWithWorkflow(tempDir.path, "my-unique-fixture-plugin");

    const input = {
      runtime: new LocalRuntime(tempDir.path),
      workspacePath: tempDir.path,
      projectTrusted: true,
      runtimeFactory,
    };

    const discovered = await discoverWorkflowScripts(input);
    const pluginEntry = discovered.find(
      (workflow) => workflow.scriptPath === "plugin://my-unique-fixture-plugin/release.js"
    );
    expect(pluginEntry).toBeDefined();
    expect(pluginEntry?.descriptor.sourceKind).toBe("plugin");
    expect(pluginEntry?.descriptor.scope).toBe("project");
  }, 60_000);

  // #6426: a project plugin skill (and so its workflow.js) loads only in a trusted project.
  test.each([true, false])(
    "lists a project plugin skill's workflow only in a trusted project (trusted: %s)",
    async (projectTrusted) => {
      using tempDir = new TestTempDir("workflow-discovery-plugin-skill");
      await writePluginWithWorkflow(tempDir.path, "skill-fixture-plugin");
      const skillDir = path.join(
        tempDir.path,
        ".mux",
        "plugins",
        "skill-fixture-plugin",
        "skills",
        "plugin-skill-flow"
      );
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: plugin-skill-flow\ndescription: Plugin skill with a workflow\n---\nBody\n",
        "utf-8"
      );
      await fs.writeFile(
        path.join(skillDir, "workflow.js"),
        "export const meta = { name: 'plugin-skill-flow', description: 'Skill workflow' };",
        "utf-8"
      );

      const discovered = await discoverWorkflowScripts({
        runtime: new LocalRuntime(tempDir.path),
        workspacePath: tempDir.path,
        projectTrusted,
        runtimeFactory,
      });
      const names = discovered.map((workflow) => workflow.scriptPath);
      expect(names.some((name) => name.includes("plugin-skill-flow"))).toBe(projectTrusted);
    },
    60_000
  );
});
