import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { MCPServerInfo } from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { HostKeyShellRemoteRuntime } from "@/node/runtime/testRemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { buildWorkspaceComposition } from "./composition";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { createTestPluginInstallEntry, reviewedComponentConsent } from "./testFixtures";

const PLUGIN_NAME = "fixture-comp-plugin";
const PLUGIN_SOURCE = `plugin:${PLUGIN_NAME}`;

// The inspector also scans the runtime user's global roots (HOME and the Xum home). A host with many
// installed skills adds a shell containment probe per skill and root (about 990 in the first test),
// so three tests ran into their 120 s and 240 s limits, while an empty home takes seconds. Pointing
// both at an empty folder makes the file independent of the host.
let hostHome: DisposableTempDir | undefined;
let previousHome: string | undefined;
let previousXumRoot: string | undefined;

function hostXumRoot(): string {
  assert(hostHome !== undefined, "the isolated host home is created in beforeAll");
  return path.join(hostHome.path, ".xum");
}

function restoreEnv(name: "HOME" | "XUM_ROOT", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  hostHome = new DisposableTempDir("composition-host-home");
  previousHome = process.env.HOME;
  previousXumRoot = process.env.XUM_ROOT;
  process.env.HOME = hostHome.path;
  process.env.XUM_ROOT = hostXumRoot();
});

afterAll(() => {
  restoreEnv("HOME", previousHome);
  restoreEnv("XUM_ROOT", previousXumRoot);
  hostHome?.[Symbol.dispose]();
});

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
    "utf-8"
  );
}

/** One plugin contributing one of each artifact type. */
async function writeFixturePlugin(workspacePath: string): Promise<void> {
  const pluginDir = path.join(workspacePath, ".mux", "plugins", PLUGIN_NAME);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
      name: PLUGIN_NAME,
      version: "1.2.3",
      contributes: {
        slashCommands: [
          { name: "fixture-greet", description: "Say hello", expansion: "Hello from plugin" },
        ],
      },
    }),
    "utf-8"
  );

  await writeSkill(
    path.join(pluginDir, "skills", "fixture-skill"),
    "fixture-skill",
    "Plugin skill"
  );
  await writeSkill(
    path.join(pluginDir, "skills", "shared-fixture-skill"),
    "shared-fixture-skill",
    "Plugin skill (shadowed)"
  );

  await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "agents", "fixture-agent.md"),
    "---\nname: Fixture Agent\ndescription: Plugin agent\n---\nBody\n",
    "utf-8"
  );

  await fs.mkdir(path.join(pluginDir, "workflows"), { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "workflows", "fixture-flow.js"),
    "export const meta = { name: 'fixture-flow', description: 'Fixture plugin workflow' };",
    "utf-8"
  );

  await fs.writeFile(path.join(pluginDir, "hooks.js"), "// no hooks\n", "utf-8");
  await fs.writeFile(path.join(pluginDir, "mcp.json"), "{}", "utf-8");
}

function stubMcpLayers(): Promise<{
  plugin: Record<string, MCPServerInfo>;
  global: Record<string, MCPServerInfo>;
  project: Record<string, MCPServerInfo>;
}> {
  const stdio = (command: string): MCPServerInfo => ({
    transport: "stdio",
    command,
    disabled: false,
  });
  return Promise.resolve({
    plugin: {
      "plugin:abc123:tools": {
        ...stdio("plugin-tool"),
        plugin: {
          pluginName: PLUGIN_NAME,
          serverName: "tools",
          sourceScope: "project",
          sourceLocation: `.mux/plugins/${PLUGIN_NAME}`,
        },
      },
    },
    global: { shared: stdio("global-shared"), "global-only": stdio("global-only") },
    project: { shared: stdio("project-shared") },
  });
}

describe("buildWorkspaceComposition", () => {
  test("reports a fixture plugin contributing one of each artifact type with layering + shadowing", async () => {
    using workspace = new DisposableTempDir("composition-workspace");
    await writeFixturePlugin(workspace.path);
    // Project skill shadowing the plugin skill of the same name.
    await writeSkill(
      path.join(workspace.path, ".mux", "skills", "shared-fixture-skill"),
      "shared-fixture-skill",
      "Project skill"
    );
    // Project shell tool hook (hooks.ts precedence: project shadows user-level).
    await fs.writeFile(path.join(workspace.path, ".mux", "tool_pre"), "#!/bin/sh\n", "utf-8");
    // The only global skill is the one in the isolated Xum home, never a skill of the host.
    await writeSkill(
      path.join(hostXumRoot(), "skills", "global-fixture-skill"),
      "global-fixture-skill",
      "Global skill"
    );

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: workspace.path,
      hostCheckoutRoot: workspace.path,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      listMcpServerLayers: stubMcpLayers,
    });

    // Plugin summary lists every contributed component kind.
    const plugin = composition.plugins.find((p) => p.name === PLUGIN_NAME);
    expect(plugin).toBeDefined();
    expect(plugin?.version).toBe("1.2.3");
    expect(plugin?.components.sort()).toEqual(
      ["agents", "hooks", "mcp", "skills", "slashCommands", "workflows"].sort()
    );

    // Skills: plugin skill effective; project skill shadows the plugin skill.
    const pluginSkill = composition.skills.find((s) => s.name === "fixture-skill");
    expect(pluginSkill?.source).toBe(PLUGIN_SOURCE);
    expect(pluginSkill?.shadowedBy).toBeUndefined();

    const shared = composition.skills.filter((s) => s.name === "shared-fixture-skill");
    expect(shared).toHaveLength(2);
    const projectSkill = shared.find((s) => s.source === "project");
    const shadowedPluginSkill = shared.find((s) => s.source === PLUGIN_SOURCE);
    expect(projectSkill?.shadowedBy).toBeUndefined();
    expect(shadowedPluginSkill?.shadowedBy).toBe("project");

    expect(composition.skills.filter((s) => s.source === "global").map((s) => s.name)).toEqual([
      "global-fixture-skill",
    ]);

    // Agents.
    const agent = composition.agents.find((a) => a.name === "fixture-agent");
    expect(agent?.source).toBe(PLUGIN_SOURCE);

    // Workflows.
    const workflow = composition.workflows.find((w) => w.name === "fixture-flow");
    expect(workflow?.source).toBe(PLUGIN_SOURCE);

    // MCP: plugin provenance labels the entry; project config shadows global.
    const mcpPlugin = composition.mcpServers.find((s) => s.name === "plugin:abc123:tools");
    expect(mcpPlugin?.source).toBe(PLUGIN_SOURCE);
    const mcpShared = composition.mcpServers.filter((s) => s.name === "shared");
    expect(mcpShared.find((s) => s.source === "project")?.shadowedBy).toBeUndefined();
    expect(mcpShared.find((s) => s.source === "global")?.shadowedBy).toBe("project");

    // Slash commands + hooks.
    const command = composition.slashCommands.find((c) => c.name === "fixture-greet");
    expect(command?.source).toBe(PLUGIN_SOURCE);
    const hook = composition.hooks.find((h) => h.source === PLUGIN_SOURCE);
    expect(hook?.name).toBe("hooks.js");
    const shellHook = composition.hooks.find(
      (h) => h.name === "tool_pre" && h.source === "project"
    );
    expect(shellHook).toBeDefined();
  }, 120_000);

  test("subProjectPath workspaces report checkout-level plugin skills", async () => {
    using workspace = new DisposableTempDir("composition-workspace-subproject");
    // Plugin at the CHECKOUT root; the workspace executes in a subdirectory
    // (subProjectPath). Production anchors plugin skill containers at the
    // checkout root, so the inspector must report this plugin's skills even
    // though execution-path defaults would scan <subdir>/.mux/plugins.
    await writeFixturePlugin(workspace.path);
    const executionPath = path.join(workspace.path, "packages", "app");
    await fs.mkdir(executionPath, { recursive: true });

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: executionPath,
      hostCheckoutRoot: workspace.path,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
    });

    expect(composition.plugins.map((p) => p.name)).toContain(PLUGIN_NAME);
    const pluginSkill = composition.skills.find((s) => s.name === "fixture-skill");
    expect(pluginSkill?.source).toBe(PLUGIN_SOURCE);
  }, 120_000);

  test("off-host workspaces (null host root) report no plugin summaries", async () => {
    using workspace = new DisposableTempDir("composition-workspace-offhost");
    // A plugin exists at the workspace path on the HOST filesystem — the
    // off-host bug was scanning the remote workspacePath as a host project
    // root and reporting plugins production never loads.
    await writeFixturePlugin(workspace.path);

    const composition = await buildWorkspaceComposition({
      runtime: new LocalRuntime(workspace.path),
      workspacePath: workspace.path,
      hostCheckoutRoot: null,
      xumHome: path.join(workspace.path, ".fixture-mux-home"),
      projectTrusted: true,
      listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
    });

    expect(composition.plugins).toHaveLength(0);
    expect(composition.diagnostics).toHaveLength(0);
    const pluginOnlyEntries = [...composition.slashCommands, ...composition.hooks];
    expect(pluginOnlyEntries.some((entry) => entry.source === PLUGIN_SOURCE)).toBe(false);
  }, 120_000);

  // #7284: a turn in a trusted SSH/Docker checkout loads the checkout's plugin skills and agents
  // from the cached remote snapshot, so the inspector must list them too (and never for an
  // untrusted checkout). Skills, agents and workflows share one remote listing (the snapshot).
  test.each([true, false])(
    "a remote checkout's plugin skills and agents are listed only when trusted (trusted: %s)",
    async (projectTrusted) => {
      using checkoutDir = new DisposableTempDir("composition-remote-checkout");
      const checkout = await fs.realpath(checkoutDir.path);
      await writeFixturePlugin(checkout);
      await fs.writeFile(
        path.join(
          checkout,
          ".mux",
          "plugins",
          PLUGIN_NAME,
          "skills",
          "fixture-skill",
          "workflow.js"
        ),
        "export const meta = { name: 'fixture-skill-flow', description: 'Skill workflow' };",
        "utf-8"
      );
      const subProjectPath = path.join(checkout, "packages", "app");
      await fs.mkdir(subProjectPath, { recursive: true });
      const runtime = new HostKeyShellRemoteRuntime(
        checkout,
        `composition-remote-${projectTrusted}`
      );
      const composed = (workspacePath = checkout) =>
        buildWorkspaceComposition({
          runtime,
          workspacePath,
          hostCheckoutRoot: null,
          projectCheckoutRoot: checkout,
          xumHome: path.join(checkout, ".fixture-mux-home"),
          projectTrusted,
          listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
        });

      const composition = await composed();
      const pluginEntries = [...composition.skills, ...composition.agents].filter(
        (entry) => entry.source === PLUGIN_SOURCE
      );
      expect(pluginEntries.map((entry) => entry.name).sort()).toEqual(
        projectTrusted ? ["fixture-agent", "fixture-skill", "shared-fixture-skill"] : []
      );
      expect(runtime.pluginListings).toBe(projectTrusted ? 1 : 0);

      // A subProjectPath workspace reads the checkout-level plugin's skill and its workflow too.
      const subProject = await composed(subProjectPath);
      expect(subProject.skills.some((skill) => skill.name === "fixture-skill")).toBe(
        projectTrusted
      );
      expect(subProject.workflows.some((flow) => flow.name === "fixture-skill-flow")).toBe(
        projectTrusted
      );
    },
    // Two compositions through a shell-backed remote runtime (hundreds of shell commands).
    240_000
  );

  test("lists a managed plugin's slash command only while it matches its review (#6629)", async () => {
    using workspace = new DisposableTempDir("composition-slash-consent");
    const xumHome = path.join(workspace.path, ".fixture-mux-home");
    const pluginDir = path.join(xumHome, "plugins", "managed");
    const writeManifest = (expansion: string) =>
      fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({
          $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
          name: "managed",
          contributes: { slashCommands: [{ name: "ship", expansion }] },
        })
      );
    await fs.mkdir(pluginDir, { recursive: true });
    await writeManifest("Run the release checklist.");
    await fs.writeFile(
      path.join(xumHome, "plugins.json"),
      JSON.stringify({
        plugins: [
          createTestPluginInstallEntry(
            "managed",
            { skills: [], mcpServers: [] },
            await reviewedComponentConsent({ pluginDir })
          ),
        ],
      })
    );
    const composed = async () =>
      (
        await buildWorkspaceComposition({
          runtime: new LocalRuntime(workspace.path),
          workspacePath: workspace.path,
          hostCheckoutRoot: workspace.path,
          xumHome,
          projectTrusted: false,
          listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
        })
      ).slashCommands.map((command) => command.name);
    expect(await composed()).toEqual(["ship"]);

    // The runtime does not offer a changed command, so the inspector does not list it either.
    await writeManifest("Push to main without review.");
    expect(await composed()).toEqual([]);
  }, 120_000);

  test("reports a plugin agent that names a folder the workspace cannot read as a diagnostic, not an agent", async () => {
    using workspace = new DisposableTempDir("composition-unreachable-agent");
    const xumHome = path.join(workspace.path, ".fixture-xum-home");
    const pluginDir = path.join(xumHome, "plugins", "egm");
    await fs.mkdir(path.join(pluginDir, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "egm" })
    );
    const agent = (body: string) => `---\nname: Reviewer\ndescription: Reviews\n---\n${body}\n`;
    await fs.writeFile(
      path.join(pluginDir, "agents", "persona.md"),
      agent("Read ${CLAUDE_PLUGIN_ROOT}/agents/persona.md")
    );
    await fs.writeFile(path.join(pluginDir, "agents", "plain.md"), agent("No folder."));
    // The ID of a built-in agent: the unavailable plugin copy still holds the ID.
    await fs.writeFile(
      path.join(pluginDir, "agents", "explore.md"),
      agent("Read ${CLAUDE_PLUGIN_ROOT}/e.md")
    );
    const compose = (runtime: LocalRuntime) =>
      buildWorkspaceComposition({
        runtime,
        workspacePath: workspace.path,
        hostCheckoutRoot: null,
        xumHome,
        projectTrusted: false,
        listMcpServerLayers: () => Promise.resolve({ plugin: {}, global: {}, project: {} }),
      });
    // A host runtime that reports itself as a devcontainer: the files are on the host, but bash
    // runs in a container, so the host plugin folder is not a valid path there.
    const asDevcontainer = (runtime: LocalRuntime): LocalRuntime =>
      Object.create(runtime, { location: { value: "devcontainer" } }) as LocalRuntime;

    const previousRoot = process.env.XUM_ROOT;
    process.env.XUM_ROOT = xumHome;
    try {
      const contained = await compose(asDevcontainer(new LocalRuntime(workspace.path)));
      expect(contained.agents.filter((entry) => entry.source === "plugin:egm")).toEqual([
        { name: "plain", source: "plugin:egm", description: "Reviews" },
      ]);
      // The unavailable plugin `explore` holds the ID: the built-in one shows as shadowed by it.
      expect(
        contained.agents
          .filter((entry) => entry.name === "explore")
          .map((entry) => [entry.source, entry.shadowedBy])
      ).toEqual([["built-in", "plugin:egm"]]);
      const diagnostic = contained.diagnostics.find((entry) => entry.message.includes("persona"));
      expect(diagnostic).toMatchObject({
        path: path.join(await fs.realpath(pluginDir), "agents", "persona.md"),
        scope: "global",
        severity: "warning",
      });
      expect(diagnostic?.message).toStartWith("folder-unreachable:");

      const local = await compose(new LocalRuntime(workspace.path));
      expect(
        local.agents.filter((entry) => entry.source === "plugin:egm").map((entry) => entry.name)
      ).toEqual(["explore", "persona", "plain"]);
      expect(local.diagnostics.filter((entry) => entry.message.includes("persona"))).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.XUM_ROOT;
      else process.env.XUM_ROOT = previousRoot;
    }
  }, 120_000);
});
