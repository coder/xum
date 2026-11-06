import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { Result } from "@/common/types/result";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/manifest";
import { AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 } from "@/node/services/agentPlugins/mcpConfig";
import { execFileAsync } from "@/node/utils/disposableExec";
import { shouldRunIntegrationTests } from "../testUtils";
import { cleanupTempGitRepo, createTempGitRepo } from "./helpers";
import { cleanupTestEnvironment, createTestEnvironment, type TestEnvironment } from "./setup";

function unwrap<T>(result: Result<T, string>): T {
  if (!result.success) throw new Error(result.error);
  return result.data;
}

// Exercise the public boundary with a real local Git remote, without providers or MCP launches.
(shouldRunIntegrationTests() ? describe : describe.skip)("selective agent plugin imports", () => {
  let env: TestEnvironment;
  let remote: string;

  async function commitComponents(names: string[]): Promise<void> {
    await fs.writeFile(
      path.join(remote, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "selective-ipc" })
    );
    for (const name of names) {
      const directory = path.join(remote, "skills", name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: Local integration fixture\n---\nUse the ${name} skill.\n`
      );
    }
    await fs.writeFile(
      path.join(remote, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
        mcpServers: Object.fromEntries(
          names.map((name) => [name, { type: "stdio", command: "node", args: ["server.js"] }])
        ),
      })
    );
    using add = execFileAsync("git", ["-C", remote, "add", "."]);
    await add.result;
    using commit = execFileAsync("git", ["-C", remote, "commit", "-m", "Update fixture inventory"]);
    await commit.result;
  }

  beforeAll(async () => {
    env = await createTestEnvironment();
    remote = await createTempGitRepo();
    await commitComponents(["selective-first", "selective-second"]);
  });

  afterAll(async () => {
    if (env) await cleanupTestEnvironment(env);
    if (remote) await cleanupTempGitRepo(remote);
  });

  it("imports a subset, replaces offline, and requires new consent after an update", async () => {
    const result = unwrap(
      await env.orpc.agentPlugins.preview({ input: pathToFileURL(remote).href })
    );
    if (result.kind !== "plugin") throw new Error("expected a plugin preview");
    const preview = result.preview;
    const selection = { skills: ["selective-first"], mcpServers: ["selective-first"] };
    const invalid = await env.orpc.agentPlugins.install({
      source: preview.source,
      method: preview.method,
      expectedSha: preview.lockedSha,
      expectedConsentDigest: preview.consentDigest,
      importedComponents: { ...selection, skills: ["unknown"] },
    });
    expect(invalid.success).toBe(false);
    expect(
      unwrap(await env.orpc.agentPlugins.list()).some((plugin) => plugin.name === "selective-ipc")
    ).toBe(false);

    const installed = unwrap(
      await env.orpc.agentPlugins.install({
        source: preview.source,
        method: preview.method,
        expectedSha: preview.lockedSha,
        expectedConsentDigest: preview.consentDigest,
        importedComponents: selection,
      })
    );
    expect(installed.importedComponents).toEqual(selection);
    const name = installed.name;
    const inventory = unwrap(await env.orpc.agentPlugins.getComponents({ name }));
    expect(inventory.skills.map((skill) => skill.name).sort()).toEqual([
      "selective-first",
      "selective-second",
    ]);
    expect(inventory.importedComponents).toEqual(selection);

    const { skills } = await env.orpc.agentSkills.list({ projectPath: remote });
    expect(skills.some((skill) => skill.name === "selective-first")).toBe(true);
    expect(skills.some((skill) => skill.name === "selective-second")).toBe(false);
    await expect(
      env.orpc.agentSkills.get({ projectPath: remote, skillName: "selective-second" })
    ).rejects.toThrow();
    const serversBefore = await env.orpc.projects.mcp.list({ projectPath: remote });
    const pluginServers = Object.values(serversBefore).filter((server) => server.plugin);
    expect(pluginServers.map((server) => server.plugin?.serverName)).toEqual(["selective-first"]);
    expect(pluginServers[0].disabled).toBe(true);

    expect(
      (
        await env.orpc.agentPlugins.setComponents({
          name,
          expectedLockedSha: "outdated",
          expectedContentHash: inventory.contentHash,
          expectedImportedComponents: selection,
          importedComponents: { skills: ["selective-second"], mcpServers: ["selective-second"] },
        })
      ).success
    ).toBe(false);
    expect(unwrap(await env.orpc.agentPlugins.getComponents({ name })).importedComponents).toEqual(
      selection
    );

    // No remote is available: selections must use the installed tree, not clone or fetch.
    const offlineRemote = `${remote}-offline`;
    await fs.rename(remote, offlineRemote);
    try {
      const addition = {
        name,
        expectedLockedSha: inventory.lockedSha,
        expectedContentHash: inventory.contentHash,
        expectedImportedComponents: selection,
        importedComponents: {
          skills: ["selective-second", "selective-second"],
          mcpServers: ["selective-second"],
        },
      };
      const added = unwrap(await env.orpc.agentPlugins.setComponents(addition));
      expect(added.importedComponents?.skills.sort()).toEqual(["selective-second"]);
      expect(
        unwrap(
          await env.orpc.agentPlugins.setComponents({
            ...addition,
            expectedImportedComponents: added.importedComponents ?? null,
          })
        )
      ).toEqual(added);
    } finally {
      await fs.rename(offlineRemote, remote);
    }
    const serversAfter = await env.orpc.projects.mcp.list({ projectPath: remote });
    expect(
      Object.values(serversAfter)
        .filter((server) => server.plugin)
        .map((server) => server.plugin?.serverName)
    ).toEqual(["selective-second"]);
    expect(Object.values(serversAfter).find((server) => server.plugin)?.disabled).toBe(true);
    await expect(
      env.orpc.agentSkills.get({ projectPath: remote, skillName: "selective-first" })
    ).rejects.toThrow();
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).skills.some(
        (skill) => skill.name === "selective-second"
      )
    ).toBe(true);

    await commitComponents(["selective-first", "selective-second", "selective-third"]);
    const review = unwrap(await env.orpc.agentPlugins.previewUpdate({ name }));
    expect(review.changes.length).toBeGreaterThan(0);
    expect((await env.orpc.agentPlugins.update({ name })).success).toBe(false);
    const updated = unwrap(
      await env.orpc.agentPlugins.update({
        name,
        consent: { fromSha: review.fromSha, toSha: review.toSha },
      })
    );
    expect(updated.importedComponents?.skills).not.toContain("selective-third");
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).skills.some(
        (skill) => skill.name === "selective-third"
      )
    ).toBe(false);
    expect(
      (
        await env.orpc.agentPlugins.setComponents({
          name,
          expectedLockedSha: inventory.lockedSha,
          expectedContentHash: inventory.contentHash,
          expectedImportedComponents: selection,
          importedComponents: { skills: ["selective-third"], mcpServers: [] },
        })
      ).success
    ).toBe(false);
    unwrap(
      await env.orpc.agentPlugins.setComponents({
        name,
        expectedLockedSha: updated.lockedSha,
        expectedContentHash: unwrap(await env.orpc.agentPlugins.getComponents({ name }))
          .contentHash,
        expectedImportedComponents: updated.importedComponents ?? null,
        importedComponents: { skills: ["selective-third"], mcpServers: [] },
      })
    );
    expect(
      (await env.orpc.agentSkills.list({ projectPath: remote })).skills.some(
        (skill) => skill.name === "selective-third"
      )
    ).toBe(true);
    expect(
      Object.values(await env.orpc.projects.mcp.list({ projectPath: remote })).some(
        (server) => server.plugin?.serverName === "selective-third"
      )
    ).toBe(false);
  }, 60_000);
});

(shouldRunIntegrationTests() ? describe : describe.skip)(
  "agent plugin install method choice",
  () => {
    let env: TestEnvironment;
    let remote: string;

    beforeAll(async () => {
      env = await createTestEnvironment();
      remote = await createTempGitRepo();
      const files: Record<string, string> = {
        "plugin.json": JSON.stringify({ name: "method-ipc" }),
        ".codex-plugin/plugin.json": JSON.stringify({ name: "method-ipc" }),
        ".claude-plugin/plugin.json": JSON.stringify({
          name: "method-ipc",
          agents: ["./.claude-plugin/agents/reviewer.md"],
        }),
        ".claude-plugin/agents/reviewer.md":
          "---\nname: reviewer\ndescription: Reviews a design\n---\nReview it.\n",
        "skills/greet/SKILL.md": "---\nname: greet\ndescription: Greets\n---\nHello.\n",
      };
      for (const [relative, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(remote, relative)), { recursive: true });
        await fs.writeFile(path.join(remote, relative), content);
      }
      using add = execFileAsync("git", ["-C", remote, "add", "."]);
      await add.result;
      using commit = execFileAsync("git", ["-C", remote, "commit", "-m", "Add manifests"]);
      await commit.result;
    });

    afterAll(async () => {
      if (env) await cleanupTestEnvironment(env);
      if (remote) await cleanupTempGitRepo(remote);
    });

    it("offers each manifest, installs the chosen one and saves it in the registry row", async () => {
      const offered = unwrap(
        await env.orpc.agentPlugins.preview({ input: pathToFileURL(remote).href })
      );
      if (offered.kind !== "plugin") throw new Error("expected a plugin preview");
      expect(offered.preview.methods).toEqual([
        { kind: "agent-plugin" },
        { kind: "claude-plugin" },
      ]);
      expect(offered.preview.method).toEqual({ kind: "agent-plugin" });
      const none = { hooksCanRun: 0, hooksListed: 0, mcpServers: 0 };
      expect(offered.preview.methodSummaries).toEqual([
        {
          method: "agent-plugin",
          manifestPath: ".codex-plugin/plugin.json",
          counts: { skills: 1, agents: 0, ...none },
        },
        {
          method: "claude-plugin",
          manifestPath: ".claude-plugin/plugin.json",
          counts: { skills: 1, agents: 1, ...none },
        },
      ]);

      const picked = unwrap(
        await env.orpc.agentPlugins.preview({
          input: pathToFileURL(remote).href,
          method: { kind: "claude-plugin" },
        })
      );
      if (picked.kind !== "plugin") throw new Error("expected a plugin preview");
      const preview = picked.preview;
      expect(preview.agents).toEqual(["reviewer.md"]);
      unwrap(
        await env.orpc.agentPlugins.install({
          source: preview.source,
          method: preview.method,
          expectedSha: preview.lockedSha,
          expectedConsentDigest: preview.consentDigest,
        })
      );

      const registry = JSON.parse(
        await fs.readFile(path.join(env.config.rootDir, "plugins.json"), "utf8")
      ) as {
        plugins: {
          name: string;
          installMethod?: string;
          componentConsent?: { agents: Record<string, string> };
        }[];
      };
      const row = registry.plugins.find((entry) => entry.name === "method-ipc");
      expect(row?.installMethod).toBe("claude-plugin");
      // The Claude manifest's agent was reviewed at install: the Codex manifest has no agents.
      expect(Object.keys(row?.componentConsent?.agents ?? {})).toEqual(["reviewer"]);

      const listed = unwrap(await env.orpc.agentPlugins.list()).find(
        (item) => item.name === "method-ipc"
      );
      expect(listed).toMatchObject({
        installMethod: "claude-plugin",
        manifestPath: ".claude-plugin/plugin.json",
        otherMethods: [{ method: "agent-plugin", agents: 0 }],
      });
    }, 60_000);
  }
);
