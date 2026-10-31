import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import {
  computeAgentPluginContainers,
  discoverAgentPluginAt,
  discoverAgentPlugins,
  ensurePluginPathContained,
  journalDerivedDiscoveryGate,
  pluginSkillFolderNames,
  readPluginFileWithinRootCapped,
  setAgentPluginDiscoveryGate,
} from "./discovery";
import { bumpContainerMutationEpoch, MUTATION_EPOCH_FILE, STAGING_DIR_NAME } from "./journals";
import { resolvePluginHookGrants } from "./hookSandbox";
import { loadPluginCodexHooks } from "./codexHooks";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import { createTestPluginInstallEntry } from "./testFixtures";
import { listPluginSkillScripts } from "./workflowFiles";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";

async function writePlugin(
  containerPath: string,
  dirName: string,
  options?: {
    manifest?: unknown;
    rawManifest?: string;
    skills?: string[];
    mcpJson?: string;
    agents?: string[];
    workflows?: string[];
  }
): Promise<string> {
  const pluginDir = path.join(containerPath, dirName);
  await fs.mkdir(pluginDir, { recursive: true });

  const manifest = options?.manifest ?? {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: dirName,
  };
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    options?.rawManifest ?? JSON.stringify(manifest),
    "utf8"
  );

  for (const skillName of options?.skills ?? []) {
    const skillDir = path.join(pluginDir, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Test skill\n---\nBody\n`,
      "utf8"
    );
  }

  if (options?.mcpJson !== undefined) {
    await fs.writeFile(path.join(pluginDir, "mcp.json"), options.mcpJson, "utf8");
  }

  for (const agentId of options?.agents ?? []) {
    const agentsDir = path.join(pluginDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(agentsDir, `${agentId}.md`),
      `---\nname: ${agentId}\ndescription: Test agent\n---\nBody\n`,
      "utf8"
    );
  }

  for (const workflowFile of options?.workflows ?? []) {
    const workflowsDir = path.join(pluginDir, "workflows");
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(path.join(workflowsDir, workflowFile), "export {};\n", "utf8");
  }

  return pluginDir;
}

describe("discoverAgentPlugins", () => {
  test("discovers a valid plugin with skills and mcp.json component paths", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "hello-plugin", { skills: ["greet"], mcpJson: "{}" });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.name).toBe("hello-plugin");
    expect(plugin.scope).toBe("global");
    expect(plugin.rootPath).toBe(await fs.realpath(path.join(container, "hello-plugin")));
    expect(plugin.skillsDirs).toEqual([{ dir: path.join(plugin.rootPath, "skills") }]);
    expect(plugin.mcpConfigPath).toBe(path.join(plugin.rootPath, "mcp.json"));
    expect(result.diagnostics).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")(
    "coalesces Windows case aliases with managed imports",
    async () => {
      using tmp = new DisposableTempDir("plugin-discovery-windows-case");
      const xumHome = path.join(tmp.path, "MixedCase");
      const owner = path.join(xumHome, "plugins");
      await writePlugin(owner, "managed");
      const selection = { skills: ["allowed"], mcpServers: [] };
      const registryPath = path.join(xumHome, "plugins.json");
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const result = await discoverAgentPlugins([
        { path: owner.toUpperCase(), scope: "project" },
        { path: owner, scope: "global", registryPath },
      ]);
      expect(result.diagnostics).toEqual([]);
      expect(result.plugins.map((plugin) => plugin.scope)).toEqual(["project", "global"]);
      for (const plugin of result.plugins) {
        expect(plugin.importedComponents).toEqual(selection);
      }
    }
  );

  test.each([".xum", ".mux"])(
    "overlapping %s containers keep the first scope but read the later registry association once",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-discovery-overlap");
      const xumHome = path.join(home.path, metadataDir);
      const managed = path.join(xumHome, "plugins");
      const registryPath = path.join(xumHome, "plugins.json");
      await writePlugin(managed, "managed");
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const reads = spyOn(fs, "readFile");
      try {
        const { plugins } = await discoverAgentPlugins(
          computeAgentPluginContainers({ xumHome, projectRoot: home.path, projectTrusted: true })
        );
        const matches = plugins.filter((plugin) => plugin.containerPath === managed);
        expect(matches).toHaveLength(1);
        expect(matches[0].scope).toBe("project");
        expect(matches[0].importedComponents).toEqual(selection);
        expect(reads.mock.calls.filter(([file]) => file === registryPath)).toHaveLength(1);
      } finally {
        reads.mockRestore();
      }
    }
  );

  test.each([".xum", ".mux"])(
    "canonical %s container aliases retain selection and the first lexical identity",
    async (metadataDir) => {
      using home = new DisposableTempDir("plugin-discovery-alias");
      const xumHome = path.join(home.path, "managed");
      const owner = path.join(xumHome, "plugins");
      const alias = path.join(home.path, metadataDir, "plugins");
      const registryPath = path.join(xumHome, "plugins.json");
      await writePlugin(owner, "managed");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        registryPath,
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      const containers = [
        { path: alias, scope: "project" as const },
        { path: owner, scope: "global" as const, registryPath },
      ];
      const manifestPath = await fs.realpath(path.join(owner, "managed", "plugin.json"));
      const reads = spyOn(fs, "readFile");
      // Manifests are read through an opened handle (readPluginFileWithinRootCapped).
      const opens = spyOn(fs, "open");
      try {
        const { plugins } = await discoverAgentPlugins(containers);
        expect(plugins).toHaveLength(2);
        expect(plugins[0]).toMatchObject({
          scope: "project",
          containerPath: alias,
          rootPath: await fs.realpath(path.join(owner, "managed")),
          importedComponents: selection,
        });
        expect(plugins[1]).toMatchObject({
          scope: "global",
          containerPath: owner,
          importedComponents: selection,
        });
        expect(plugins[0].rootPath).toBe(plugins[1].rootPath);
        // Each view names its own approved copies, by its lexical path (like its MCP keys).
        expect(plugins.map((plugin) => plugin.approvedCopies?.instancePath)).toEqual([
          path.join(alias, "managed"),
          path.join(owner, "managed"),
        ]);
        expect(reads.mock.calls.filter(([file]) => file === registryPath)).toHaveLength(1);
        expect(opens.mock.calls.filter(([file]) => file === manifestPath)).toHaveLength(1);
      } finally {
        reads.mockRestore();
        opens.mockRestore();
      }
      await fs.writeFile(registryPath, "{");
      const corrupt = await discoverAgentPlugins(containers);
      expect(corrupt.plugins).toHaveLength(2);
      expect(corrupt.plugins.map((plugin) => plugin.importedComponents)).toEqual([
        { skills: [], mcpServers: [] },
        { skills: [], mcpServers: [] },
      ]);

      const globalFirst = await discoverAgentPlugins([...containers].reverse());
      expect(globalFirst.plugins).toHaveLength(2);
      expect(globalFirst.plugins[0]).toMatchObject({ scope: "global", containerPath: owner });
    }
  );

  test.each(["initial", "post-scan"])(
    "canonical aliases share %s gate suppression",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-alias-gate");
      const owner = path.join(tmp.path, "managed", "plugins");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(owner, "transient-plugin");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      setAgentPluginDiscoveryGate(() =>
        Promise.resolve({
          suppressed: phase === "initial" ? [owner] : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? [owner] : []),
        })
      );
      try {
        const result = await discoverAgentPlugins([
          { path: alias, scope: "project" },
          {
            path: owner,
            scope: "global",
            registryPath: path.join(tmp.path, "managed", "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({ path: alias, scope: "project" });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "project-only alias consults its absent lexical registry owner for %s suppression",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-project-owner-gate");
      const physicalHome = path.join(tmp.path, "physical");
      const configuredHome = path.join(tmp.path, "configured");
      const owner = path.join(configuredHome, "plugins");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(path.join(physicalHome, "plugins"), "transient-plugin");
      await fs.symlink(physicalHome, configuredHome, "dir");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(owner, alias, "dir");
      setAgentPluginDiscoveryGate((paths) => {
        // Mirrors installService's lexical owner lookup: neither the project
        // alias nor the canonical path is sufficient to wait for recovery.
        const flagged = paths.filter((candidate) => candidate === owner);
        return Promise.resolve({
          suppressed: phase === "initial" ? flagged : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? flagged : []),
        });
      });
      try {
        const result = await discoverAgentPlugins([
          {
            path: alias,
            scope: "project",
            registryPath: path.join(configuredHome, "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({ path: alias, scope: "project" });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "pinned registry-owner journals suppress %s reads when both home and container are symlinks",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-owner-journal");
      const ownerHome = path.join(tmp.path, "owner");
      const configuredHome = path.join(tmp.path, "configured");
      const otherHome = path.join(tmp.path, "other");
      const physicalContainer = path.join(tmp.path, "storage", "plugins");
      await writePlugin(physicalContainer, "managed");
      await fs.mkdir(ownerHome);
      await fs.mkdir(otherHome);
      await fs.symlink(physicalContainer, path.join(ownerHome, "plugins"), "dir");
      await fs.symlink(ownerHome, configuredHome, "dir");
      const staging = path.join(ownerHome, STAGING_DIR_NAME);
      await fs.mkdir(staging);
      const journal = path.join(staging, "promotion-demo.json");
      if (phase === "initial") await fs.writeFile(journal, "{}");
      setAgentPluginDiscoveryGate(async (paths) => {
        // Neither the now-retargeted configured home nor the container's
        // physical parent owns the journal. The pinned owner path still does.
        await fs.unlink(configuredHome);
        await fs.symlink(otherHome, configuredHome, "dir");
        const session = await journalDerivedDiscoveryGate(paths);
        if (phase === "post-scan") await fs.writeFile(journal, "{}");
        return session;
      });
      try {
        const result = await discoverAgentPlugins([
          {
            path: path.join(configuredHome, "plugins"),
            scope: "global",
            registryPath: path.join(configuredHome, "plugins.json"),
          },
        ]);
        expect(result.plugins).toEqual([]);
        expect(result.diagnostics).toHaveLength(1);
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test.each(["initial", "post-scan"])(
    "%s suppression retains baseline legacy shadowing",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-gated-shadowing");
      const canonical = path.join(tmp.path, ".xum", "plugins");
      const legacy = path.join(tmp.path, ".mux", "plugins");
      await writePlugin(canonical, "shared");
      await writePlugin(legacy, "shared");
      setAgentPluginDiscoveryGate(() =>
        Promise.resolve({
          suppressed: phase === "initial" ? [canonical] : [],
          confirm: () => Promise.resolve(phase === "post-scan" ? [canonical] : []),
        })
      );
      try {
        const result = await discoverAgentPlugins([
          { path: canonical, scope: "project" },
          { path: legacy, scope: "project" },
        ]);
        expect(result.plugins.map((plugin) => plugin.containerPath)).toEqual(
          phase === "initial" ? [legacy] : []
        );
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("a canonical target parent's unrelated journal cannot suppress the lexical owner", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-unrelated-journal");
    const ownerHome = path.join(tmp.path, "configured");
    const physicalContainer = path.join(tmp.path, "storage", "version-A");
    await writePlugin(physicalContainer, "managed");
    await fs.mkdir(ownerHome);
    await fs.symlink(physicalContainer, path.join(ownerHome, "plugins"), "dir");
    const unrelatedStaging = path.join(tmp.path, "storage", STAGING_DIR_NAME);
    await fs.mkdir(unrelatedStaging);
    await fs.writeFile(path.join(unrelatedStaging, "promotion-other.json"), "{}");
    const result = await discoverAgentPlugins([
      {
        path: path.join(ownerHome, "plugins"),
        scope: "global",
        registryPath: path.join(ownerHome, "plugins.json"),
      },
    ]);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["managed"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("ownership-only descriptors restrict scanned aliases without adding logical views", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-ownership-only");
    const home = path.join(tmp.path, "managed-home");
    const owner = path.join(home, "plugins");
    const alias = path.join(tmp.path, "project-alias");
    await writePlugin(owner, "managed");
    await fs.symlink(owner, alias, "dir");
    const selection = { skills: [], mcpServers: [] };
    const registryPath = path.join(home, "plugins.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
    );
    const options = { managedHome: home };
    const reads = spyOn(fs, "readdir");
    try {
      const empty = await discoverAgentPlugins([], options);
      expect(empty.plugins).toEqual([]);
      expect(reads.mock.calls.some(([input]) => input === owner)).toBe(false);
      const scanned = await discoverAgentPlugins([{ path: alias, scope: "project" }], options);
      expect(scanned.plugins).toHaveLength(1);
      expect(scanned.plugins.map((plugin) => [plugin.containerPath, plugin.scope])).toEqual([
        [alias, "project"],
      ]);
      expect(scanned.plugins[0].importedComponents).toEqual(selection);
    } finally {
      reads.mockRestore();
    }
  });

  test.each(["gate", "post-scan", "home-only"])(
    "fresh owner validation after %s retarget keeps pinned policies and rejects unowned aliases",
    async (phase) => {
      using tmp = new DisposableTempDir("plugin-discovery-fresh-owner");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      const homeC = path.join(tmp.path, "C");
      const configured = path.join(tmp.path, "configured");
      const aliasB = path.join(tmp.path, "new-alias");
      const denied = { skills: [], mcpServers: [] };
      const healthy = { skills: ["allowed"], mcpServers: [] };
      for (const [home, name, selection] of [
        [homeA, "managed", denied],
        [homeB, "unselected", denied],
        [homeC, "healthy", healthy],
      ] as const) {
        await writePlugin(path.join(home, "plugins"), name);
        await fs.writeFile(
          path.join(home, "plugins.json"),
          JSON.stringify({ plugins: [createTestPluginInstallEntry(name, selection)] })
        );
      }
      await fs.symlink(homeA, configured, "dir");
      await fs.symlink(path.join(homeB, "plugins"), aliasB, "dir");
      const owner = path.join(configured, "plugins");
      const retarget = async () => {
        if (phase === "home-only") {
          const sharedHome = path.join(tmp.path, "shared-home");
          await fs.mkdir(sharedHome);
          await fs.symlink(path.join(homeA, "plugins"), path.join(sharedHome, "plugins"), "dir");
          await fs.unlink(configured);
          await fs.symlink(sharedHome, configured, "dir");
        } else {
          await fs.unlink(configured);
          await fs.symlink(homeB, configured, "dir");
        }
      };
      setAgentPluginDiscoveryGate(async () => {
        if (phase !== "post-scan") await retarget();
        return {
          suppressed: [],
          confirm: async () => {
            if (phase === "post-scan") await retarget();
            return [];
          },
        };
      });
      try {
        const result = await discoverAgentPlugins(
          [
            { path: owner, scope: "project" },
            { path: aliasB, scope: "project" },
            {
              path: path.join(homeC, "plugins"),
              scope: "global",
              registryPath: path.join(homeC, "plugins.json"),
            },
          ],
          {
            managedHome: configured,
          }
        );
        expect(result.plugins.map((plugin) => plugin.name)).toEqual(["managed", "healthy"]);
        expect(result.plugins.map((plugin) => [plugin.name, plugin.scope])).toEqual([
          ["managed", "project"],
          ["healthy", "global"],
        ]);
        expect(result.plugins.map((plugin) => plugin.importedComponents)).toEqual([
          denied,
          healthy,
        ]);
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("losing the pinned registry home cannot turn its surviving target into import-all", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-lost-pinned-owner");
    const physical = path.join(tmp.path, "storage", "version-A");
    const home = path.join(tmp.path, "owner-home");
    const owner = path.join(home, "plugins");
    await writePlugin(physical, "managed");
    await fs.mkdir(home);
    await fs.symlink(physical, owner, "dir");
    const registryPath = path.join(home, "plugins.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        plugins: [createTestPluginInstallEntry("managed", { skills: [], mcpServers: [] })],
      })
    );
    setAgentPluginDiscoveryGate(async () => {
      await fs.rm(home, { recursive: true });
      return { suppressed: [], confirm: () => Promise.resolve([]) };
    });
    try {
      const result = await discoverAgentPlugins([{ path: physical, scope: "project" }], {
        managedHome: home,
      });
      expect(result.plugins).toEqual([]);
    } finally {
      setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
    }
  });

  test.each(["appeared", "removed", "unreadable"])(
    "an owner that %s during setup cannot release an unmarked candidate",
    async (change) => {
      using tmp = new DisposableTempDir("plugin-discovery-owner-availability");
      const configured = path.join(tmp.path, "configured");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      await fs.mkdir(homeA);
      await writePlugin(path.join(homeB, "plugins"), "managed");
      await fs.writeFile(
        path.join(homeB, "plugins.json"),
        JSON.stringify({
          plugins: [createTestPluginInstallEntry("managed", { skills: [], mcpServers: [] })],
        })
      );
      await fs.symlink(change === "appeared" ? homeA : homeB, configured, "dir");
      const unrelated = path.join(tmp.path, "unmarked", "plugins");
      await writePlugin(unrelated, "unmarked");
      const resolution = spyOn(fs, "realpath");
      setAgentPluginDiscoveryGate(async () => {
        if (change === "unreadable")
          resolution.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
        else {
          await fs.unlink(configured);
          if (change === "appeared") await fs.symlink(homeB, configured, "dir");
        }
        return { suppressed: [], confirm: () => Promise.resolve([]) };
      });
      try {
        const result = await discoverAgentPlugins(
          [
            { path: path.join(homeB, "plugins"), scope: "project" },
            { path: unrelated, scope: "project" },
          ],
          {
            managedHome: configured,
          }
        );
        if (change === "appeared") {
          expect(result.plugins).toEqual([]);
        } else {
          // The coherent pre-existing owner retains its pinned restrictive policy.
          expect(result.plugins.map((plugin) => plugin.importedComponents)).toEqual([
            { skills: [], mcpServers: [] },
          ]);
        }
      } finally {
        resolution.mockRestore();
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("an owner retarget cannot expose an unmarked target or suppress another known owner", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-duplicate-retarget");
    const homeA = path.join(tmp.path, "A");
    const homeB = path.join(tmp.path, "B");
    const homeC = path.join(tmp.path, "C");
    const configuredHome = path.join(tmp.path, "configured");
    await writePlugin(path.join(homeA, "plugins"), "managed");
    await writePlugin(path.join(homeB, "plugins"), "managed");
    await writePlugin(path.join(homeC, "plugins"), "healthy");
    const denied = { skills: [], mcpServers: [] };
    const healthy = { skills: ["allowed"], mcpServers: [] };
    for (const [home, entry] of [
      [homeB, createTestPluginInstallEntry("managed", denied)],
      [homeC, createTestPluginInstallEntry("healthy", healthy)],
    ] as const) {
      await fs.writeFile(path.join(home, "plugins.json"), JSON.stringify({ plugins: [entry] }));
    }
    await fs.symlink(homeA, configuredHome, "dir");
    const owner = path.join(configuredHome, "plugins");
    const discover = () =>
      discoverAgentPlugins([
        { path: owner, scope: "project" },
        { path: owner, scope: "global", registryPath: path.join(configuredHome, "plugins.json") },
        { path: path.join(homeB, "plugins"), scope: "project" },
        {
          path: path.join(homeC, "plugins"),
          scope: "global",
          registryPath: path.join(homeC, "plugins.json"),
        },
      ]);
    const resolve = fs.realpath;
    const resolution = spyOn(fs, "realpath").mockReturnValueOnce(
      (async () => {
        const canonical = await resolve(owner);
        await fs.unlink(configuredHome);
        await fs.symlink(homeB, configuredHome, "dir");
        return canonical;
      })()
    );
    try {
      const result = await discover();
      expect(result.plugins.map((plugin) => plugin.name)).toEqual(["healthy"]);
      expect(result.plugins[0].importedComponents).toEqual(healthy);
    } finally {
      resolution.mockRestore();
    }
    const stable = await discover();
    expect(stable.plugins.map((plugin) => plugin.name)).toEqual(["managed", "managed", "healthy"]);
    expect(stable.plugins[0].importedComponents).toEqual(denied);
    expect(stable.plugins.filter((plugin) => plugin.name === "managed")).toHaveLength(2);
    for (const plugin of stable.plugins) {
      expect(plugin.importedComponents).toEqual(plugin.name === "managed" ? denied : healthy);
    }
  });

  test("logical views retain original interleaved order while physical containers coalesce", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-registration-order");
    const projectA = path.join(tmp.path, "project-A");
    const projectB = path.join(tmp.path, "project-B");
    const globalA = path.join(tmp.path, "global-A");
    const globalB = path.join(tmp.path, "global-B");
    await writePlugin(projectA, "first");
    await writePlugin(projectB, "second");
    await fs.symlink(projectA, globalA, "dir");
    await fs.symlink(projectB, globalB, "dir");
    const result = await discoverAgentPlugins([
      { path: projectA, scope: "project" },
      { path: projectB, scope: "project" },
      { path: globalA, scope: "global" },
      { path: globalB, scope: "global" },
      { path: projectA, scope: "global" },
    ]);
    expect(result.plugins).toHaveLength(4);
    expect(result.plugins.map((plugin) => [plugin.containerPath, plugin.scope])).toEqual([
      [projectA, "project"],
      [projectB, "project"],
      [globalA, "global"],
      [globalB, "global"],
    ]);
  });

  test("shadowed legacy views do not hide their distinct global registration or leak diagnostics", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-shadowed-view");
    const canonical = path.join(tmp.path, ".xum", "plugins");
    const legacy = path.join(tmp.path, ".mux", "plugins");
    const global = path.join(tmp.path, "configured", "plugins");
    await writePlugin(canonical, "shared");
    await writePlugin(canonical, "invalid", { rawManifest: "{" });
    await writePlugin(legacy, "shared");
    await writePlugin(legacy, "invalid");
    await fs.mkdir(path.dirname(global));
    await fs.symlink(legacy, global, "dir");
    const result = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
      { path: global, scope: "global" },
    ]);
    expect(
      result.plugins.map((plugin) => [plugin.name, plugin.scope, plugin.containerPath])
    ).toEqual([
      ["shared", "project", canonical],
      ["invalid", "global", global],
      ["shared", "global", global],
    ]);
    expect(result.diagnostics).toHaveLength(1);
    await fs.writeFile(path.join(legacy, "shared", "plugin.json"), "{");
    const shadowed = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
    ]);
    expect(shadowed.diagnostics).toHaveLength(1);
  });

  test("unresolvable container identity fails closed without hiding other containers", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-identity-error");
    const inaccessible = path.join(tmp.path, "inaccessible");
    const healthy = path.join(tmp.path, "healthy");
    await writePlugin(inaccessible, "unsafe-fallback");
    await writePlugin(healthy, "healthy");
    const resolution = spyOn(fs, "realpath").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );
    try {
      const result = await discoverAgentPlugins([
        { path: inaccessible, scope: "project" },
        { path: healthy, scope: "project" },
      ]);
      expect(result.plugins.map((plugin) => plugin.name)).toEqual(["healthy"]);
      expect(
        result.diagnostics.some(
          (diagnostic) => diagnostic.path === inaccessible && diagnostic.severity === "error"
        )
      ).toBe(true);
    } finally {
      resolution.mockRestore();
    }
  });

  test.each(["project alias", "configured home"])(
    "container and registry reads stay pinned when the %s retargets after resolution",
    async (retarget) => {
      using tmp = new DisposableTempDir("plugin-discovery-pinned-alias");
      const homeA = path.join(tmp.path, "A");
      const homeB = path.join(tmp.path, "B");
      const configuredHome = path.join(tmp.path, "configured");
      const alias = path.join(tmp.path, "project", ".xum", "plugins");
      await writePlugin(path.join(homeA, "plugins"), "managed", { skills: ["allowed"] });
      await writePlugin(path.join(homeB, "plugins"), "managed", { skills: ["blocked"] });
      const selection = { skills: ["allowed"], mcpServers: [] };
      await fs.writeFile(
        path.join(homeA, "plugins.json"),
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed", selection)] })
      );
      await fs.writeFile(
        path.join(homeB, "plugins.json"),
        JSON.stringify({ plugins: [createTestPluginInstallEntry("managed")] })
      );
      await fs.symlink(homeA, configuredHome, "dir");
      await fs.mkdir(path.dirname(alias), { recursive: true });
      await fs.symlink(path.join(homeA, "plugins"), alias, "dir");
      const owner = {
        path: path.join(configuredHome, "plugins"),
        scope: "global" as const,
        registryPath: path.join(configuredHome, "plugins.json"),
      };
      setAgentPluginDiscoveryGate(async () => {
        const link = retarget === "project alias" ? alias : configuredHome;
        await fs.unlink(link);
        await fs.symlink(
          retarget === "project alias" ? path.join(homeB, "plugins") : homeB,
          link,
          "dir"
        );
        return { suppressed: [], confirm: () => Promise.resolve([]) };
      });
      try {
        const result = await discoverAgentPlugins(
          retarget === "project alias" ? [{ path: alias, scope: "project" }, owner] : [owner]
        );
        expect(result.plugins).toHaveLength(retarget === "project alias" ? 2 : 1);
        expect(result.plugins[0]).toMatchObject({
          rootPath: await fs.realpath(path.join(homeA, "plugins", "managed")),
          importedComponents: selection,
          containerPath: retarget === "project alias" ? alias : owner.path,
        });
      } finally {
        setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
      }
    }
  );

  test("a failed marked owner cannot leave an earlier readable alias unmanaged", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-owner-error");
    const owner = path.join(tmp.path, "managed", "plugins");
    const alias = path.join(tmp.path, "alias");
    await writePlugin(owner, "managed");
    await fs.symlink(owner, alias, "dir");
    const identity = await fs.realpath(alias);
    const resolution = spyOn(fs, "realpath")
      .mockResolvedValueOnce(identity)
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    try {
      const result = await discoverAgentPlugins([
        { path: alias, scope: "project" },
        {
          path: owner,
          scope: "global",
          registryPath: path.join(tmp.path, "managed", "plugins.json"),
        },
      ]);
      expect(result.plugins).toEqual([]);
      expect(result.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
    } finally {
      resolution.mockRestore();
    }
  });

  test("a registry parent resolving to a different container cannot grant imports", async () => {
    using tmp = new DisposableTempDir("plugin-discovery-owner-binding");
    const container = path.join(tmp.path, "A", "plugins");
    await writePlugin(container, "managed");
    await writePlugin(path.join(tmp.path, "B", "plugins"), "managed");
    const result = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath: path.join(tmp.path, "B", "plugins.json") },
    ]);
    expect(result.plugins).toEqual([]);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.path === container && diagnostic.severity === "error"
      )
    ).toBe(true);
  });

  test("unidentified registry rows isolate unknown directories without suppressing healthy imports", async () => {
    using tmp = new DisposableTempDir("agent-plugins-row-recovery");
    const container = path.join(tmp.path, "plugins");
    const registryPath = path.join(tmp.path, "plugins.json");
    for (const name of ["selected", "legacy", "unassociated"]) await writePlugin(container, name);
    const selection = { skills: ["greet"], mcpServers: [] };
    const healthy = [
      createTestPluginInstallEntry("selected", selection),
      createTestPluginInstallEntry("legacy"),
    ];
    for (const unidentified of [
      null,
      1,
      "lost",
      {},
      [],
      { name: 1 },
      { name: "" },
      { name: "../demo" },
      { name: "con" },
    ]) {
      for (const rows of [
        [...healthy, unidentified],
        [unidentified, ...healthy],
      ]) {
        await fs.writeFile(registryPath, JSON.stringify({ plugins: rows }));
        const { plugins } = await discoverAgentPlugins([
          { path: container, scope: "global", registryPath },
        ]);
        expect(plugins).toHaveLength(3);
        expect(plugins.find((plugin) => plugin.name === "selected")?.importedComponents).toEqual(
          selection
        );
        expect(
          plugins.find((plugin) => plugin.name === "legacy")?.importedComponents
        ).toBeUndefined();
        expect(
          plugins.find((plugin) => plugin.name === "unassociated")?.importedComponents
        ).toEqual({
          skills: [],
          mcpServers: [],
        });
      }
    }
    await fs.writeFile(registryPath, JSON.stringify({ plugins: healthy }));
    const { plugins } = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath },
    ]);
    expect(
      plugins.find((plugin) => plugin.name === "unassociated")?.importedComponents
    ).toBeUndefined();
  });

  test("truncated named registry rows cannot turn a managed plugin into legacy import-all", async () => {
    using tmp = new DisposableTempDir("agent-plugins-truncated-registry");
    const container = path.join(tmp.path, "plugins");
    const registryPath = path.join(tmp.path, "plugins.json");
    await writePlugin(container, "demo");
    await writePlugin(container, "unassociated");
    await fs.writeFile(registryPath, JSON.stringify({ plugins: [{ name: "demo" }] }));
    const { plugins } = await discoverAgentPlugins([
      { path: container, scope: "global", registryPath },
    ]);
    expect(plugins).toHaveLength(2);
    expect(plugins[0].importedComponents).toEqual({ skills: [], mcpServers: [] });
    expect(plugins[1].importedComponents).toBeUndefined();
  });

  test.each([
    "{",
    JSON.stringify({
      plugins: [createTestPluginInstallEntry("shared", { skills: [], mcpServers: [] })],
    }),
  ])("ignores an unmanaged global container's sibling registry (%s)", async (unmanagedRegistry) => {
    using tmp = new DisposableTempDir("agent-plugins-registry-scope");
    const xumHome = path.join(tmp.path, "xum");
    const managed = path.join(xumHome, "plugins");
    const universal = path.join(tmp.path, ".agents", "plugins");
    for (const container of [managed, universal]) {
      await writePlugin(container, "shared", { skills: ["greet"], mcpJson: "{}" });
    }
    const selection = { skills: ["greet"], mcpServers: [] };
    await fs.writeFile(
      path.join(xumHome, "plugins.json"),
      JSON.stringify({ plugins: [createTestPluginInstallEntry("shared", selection)] })
    );
    await fs.writeFile(path.join(path.dirname(universal), "plugins.json"), unmanagedRegistry);
    const containers = computeAgentPluginContainers({ xumHome, projectTrusted: false }).map(
      (container) => ({ ...container, path: container.path === managed ? managed : universal })
    );
    const { plugins } = await discoverAgentPlugins(containers);
    expect(plugins).toHaveLength(2);
    expect(plugins.find((plugin) => plugin.containerPath === managed)?.importedComponents).toEqual(
      selection
    );
    expect(
      plugins.find((plugin) => plugin.containerPath === universal)?.importedComponents
    ).toBeUndefined();

    await fs.writeFile(path.join(xumHome, "plugins.json"), "{");
    const corrupted = await discoverAgentPlugins(containers);
    expect(corrupted.plugins).toHaveLength(2);
    expect(
      corrupted.plugins.find((plugin) => plugin.containerPath === managed)?.importedComponents
    ).toEqual({
      skills: [],
      mcpServers: [],
    });
    expect(
      corrupted.plugins.find((plugin) => plugin.containerPath === universal)?.importedComponents
    ).toBeUndefined();
  });

  test("discovers agents/ and workflows/ component directories", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "full-plugin", {
      agents: ["reviewer"],
      workflows: ["release.js"],
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.agentsDir).toBe(path.join(plugin.rootPath, "agents"));
    expect(plugin.workflowsDir).toBe(path.join(plugin.rootPath, "workflows"));
    expect(result.diagnostics).toEqual([]);
  });

  test("contributes path overrides relocate component resolution", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "custom-plugin", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "custom-plugin",
        contributes: { skills: "lib/skills", workflows: "scripts" },
      },
    });
    await fs.mkdir(path.join(pluginDir, "lib", "skills"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "scripts"), { recursive: true });
    // The conventional locations exist too, but the override must win.
    await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.skillsDirs).toEqual([{ dir: path.join(plugin.rootPath, "lib", "skills") }]);
    expect(plugin.workflowsDir).toBe(path.join(plugin.rootPath, "scripts"));
    expect(plugin.agentsDir).toBeUndefined();
  });

  test("a Codex skills array resolves every contained root; a missing or escaping one is skipped", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "multi");
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    for (const dir of ["core", "extra", "skills"]) {
      await fs.mkdir(path.join(pluginDir, dir), { recursive: true });
    }
    await fs.symlink(tmp.path, path.join(pluginDir, "outside"));
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "multi",
        skills: ["./core/", "./missing", "./outside", "./extra", "./core"],
      }),
      "utf8"
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const plugin = result.plugins[0];
    // Declared roots replace the default skills/ (as in Codex), in declared order.
    expect(plugin.skillsDirs).toEqual([
      { dir: path.join(plugin.rootPath, "core") },
      { dir: path.join(plugin.rootPath, "extra") },
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("outside/ resolves outside the plugin root");
  });

  test("a skills path that holds SKILL.md is one skill named after the declared folder", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "solo", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "solo",
        contributes: { skills: ["one-skill", "alias", ".", "skills"] },
      },
      skills: ["nested"],
    });
    for (const dir of ["one-skill", path.join("impl", "real")]) {
      await fs.mkdir(path.join(pluginDir, dir), { recursive: true });
      await fs.writeFile(path.join(pluginDir, dir, "SKILL.md"), "---\nname: x\n---\n", "utf8");
    }
    // A contained symlink keeps the name the author wrote, not the target's.
    await fs.symlink(path.join("impl", "real"), path.join(pluginDir, "alias"));
    await fs.writeFile(path.join(pluginDir, "SKILL.md"), "---\nname: solo\n---\n", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const plugin = result.plugins[0];
    expect(plugin.skillsDirs).toEqual([
      { dir: path.join(plugin.rootPath, "one-skill"), single: true, name: "one-skill" },
      { dir: path.join(plugin.rootPath, "impl", "real"), single: true, name: "alias" },
      // The plugin root has no folder name of its own: it takes the plugin name.
      { dir: plugin.rootPath, single: true, name: "solo" },
      // A folder without SKILL.md still holds skill folders.
      { dir: path.join(plugin.rootPath, "skills") },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a symlink to the plugin root keeps its declared skill name", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "solo", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "solo",
        contributes: { skills: ["alias"] },
      },
    });
    await fs.writeFile(path.join(pluginDir, "SKILL.md"), "---\nname: alias\n---\n", "utf8");
    await fs.symlink(".", path.join(pluginDir, "alias"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins[0].skillsDirs).toEqual([
      { dir: result.plugins[0].rootPath, single: true, name: "alias" },
    ]);
  });

  test.each([".", "./"])(
    "a Codex skills path %p names the plugin root as one skill",
    async (skills) => {
      using tmp = new DisposableTempDir("agent-plugins");
      const container = path.join(tmp.path, "plugins");
      const pluginDir = path.join(container, "solo");
      await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "solo", skills })
      );
      await fs.writeFile(path.join(pluginDir, "SKILL.md"), "---\nname: solo\n---\n", "utf8");

      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

      expect(result.plugins[0].skillsDirs).toEqual([
        { dir: result.plugins[0].rootPath, single: true, name: "solo" },
      ]);
    }
  );

  test("the default skills/ holds skill folders even when it has a SKILL.md", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "implicit", { skills: ["nested"] });
    await fs.writeFile(path.join(pluginDir, "skills", "SKILL.md"), "---\nname: x\n---\n", "utf8");
    // The same folder declared in the manifest is one skill.
    const declaredDir = await writePlugin(container, "declared", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "declared",
        contributes: { skills: "skills" },
      },
      skills: ["nested"],
    });
    await fs.writeFile(path.join(declaredDir, "skills", "SKILL.md"), "---\nname: x\n---\n", "utf8");

    const { plugins } = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const skillsDirs = (name: string) => plugins.find((p) => p.name === name)?.skillsDirs;
    const root = (name: string) => plugins.find((p) => p.name === name)?.rootPath ?? "";
    expect(skillsDirs("implicit")).toEqual([{ dir: path.join(root("implicit"), "skills") }]);
    expect(skillsDirs("declared")).toEqual([
      { dir: path.join(root("declared"), "skills"), single: true, name: "skills" },
    ]);
  });

  test("discovers a manifest-only plugin without components", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "bare-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "project" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDirs).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  test("silently skips entries without plugin.json (e.g. Codex marketplace dirs)", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(path.join(container, "not-a-plugin"), { recursive: true });
    await fs.writeFile(path.join(container, "not-a-plugin", "marketplace.json"), "{}", "utf8");
    // Loose file directly in the container is also skipped.
    await fs.writeFile(path.join(container, "marketplace.json"), "{}", "utf8");
    await writePlugin(container, "real-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["real-plugin"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("discovers a Codex package with only .codex-plugin/plugin.json and .mcp.json", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "figma");
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(pluginDir, ".mcp.json"), "{}", "utf8");
    // Shape copied from openai/plugins: no $schema, OpenAI fields at the top level.
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "figma",
        skills: "./skills/",
        apps: "./.app.json",
        hooks: "./hooks.json",
        interface: { displayName: "Figma", shortDescription: "Design", developerName: "Figma" },
      }),
      "utf8"
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.diagnostics).toEqual([]);
    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.name).toBe("figma");
    expect(plugin.skillsDirs).toEqual([{ dir: path.join(plugin.rootPath, "skills") }]);
    expect(plugin.mcpConfigPath).toBe(path.join(plugin.rootPath, ".mcp.json"));
    // Parsed and exposed only: no hook component resolves from the legacy key.
    expect(plugin.hooksPath).toBeUndefined();
    expect(plugin.openai).toEqual({
      apps: "./.app.json",
      hooks: ["./hooks.json"],
      interface: { displayName: "Figma", shortDescription: "Design", developerName: "Figma" },
    });
  });

  test("a .codex-plugin manifest linked into .git is refused (#6161)", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "leaky");
    await fs.mkdir(path.join(pluginDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, ".git", "manifest.json"),
      JSON.stringify({ name: "leaky", description: "SECRET-from-git" }),
      "utf8"
    );
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"));
    await fs.symlink("../.git/manifest.json", path.join(pluginDir, ".codex-plugin", "plugin.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(".git directory");
    expect(JSON.stringify(result)).not.toContain("SECRET-from-git");
  });

  test("a Codex-fallback package gets no Xum hooks, agents, workflows, slash commands or grants", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "hostile");
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    for (const dir of ["skills", "agents", "workflows", "hooks"]) {
      await fs.mkdir(path.join(pluginDir, dir), { recursive: true });
    }
    await fs.writeFile(path.join(pluginDir, "hooks.js"), "export default {};", "utf8");
    await fs.writeFile(path.join(pluginDir, "hooks", "alt.js"), "export default {};", "utf8");
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "hostile",
        skills: ["./skills/"],
        extensions: { mux: { hooks: { tools: ["bash"] } } },
        contributes: {
          hooks: "hooks/alt.js",
          slashCommands: [{ name: "x", expansion: "y" }],
        },
      }),
      "utf8"
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.codexFallback).toBe(true);
    expect(plugin.skillsDirs).toEqual([{ dir: path.join(plugin.rootPath, "skills") }]);
    expect(plugin.hooksPath).toBeUndefined();
    expect(plugin.agentsDir).toBeUndefined();
    expect(plugin.workflowsDir).toBeUndefined();
    expect(plugin.manifest.contributes?.slashCommands).toBeUndefined();
    expect(resolvePluginHookGrants(plugin.manifest).bridgeTools.allow).toEqual([]);
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "'contributes' is not supported in .codex-plugin/plugin.json; ignoring",
      "'extensions.mux' is not supported in .codex-plugin/plugin.json; ignoring",
    ]);
  });

  test("a root plugin.json without com.openai takes it from the .codex-plugin overlay", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "overlay");
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    const overlay = { name: "other-name", apps: "./.app.json", hooks: "./hooks.js" };
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify(overlay),
      "utf8"
    );
    await fs.writeFile(path.join(pluginDir, "hooks.js"), "export default {};", "utf8");

    const first = await discoverAgentPlugins([{ path: container, scope: "global" }]);
    // Root identity and components stay canonical; only com.openai comes from the overlay.
    expect(first.plugins[0]).toMatchObject({
      name: "overlay",
      openai: { apps: "./.app.json", hooks: ["./hooks.js"] },
      hooksPath: path.join(first.plugins[0].rootPath, "hooks.js"),
    });

    // An inline root com.openai object replaces the overlay entirely.
    await writePlugin(container, "overlay", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "overlay",
        extensions: { "com.openai": { onboardingSkill: "./skills/a/SKILL.md" } },
      },
    });
    const second = await discoverAgentPlugins([{ path: container, scope: "global" }]);
    expect(second.plugins[0].openai).toEqual({ onboardingSkill: "./skills/a/SKILL.md" });
  });

  test("the overlay's interface, review and publication metadata reach the typed view", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "overlay-meta");
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    // OpenAI's Codex layout: `interface` at the top level, review and publication under
    // extensions.com.openai (https://developers.openai.com/plugins/deploy/submission).
    const review = { tests: [{ prompt: "Open my file" }] };
    const publication = { countries: ["US"], release_notes: "First release" };
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "overlay-meta",
        interface: { displayName: "Meta", shortDescription: "Docs", developerName: "Acme" },
        extensions: { "com.openai": { review, publication } },
      }),
      "utf8"
    );

    const { plugins, diagnostics } = await discoverAgentPlugins([
      { path: container, scope: "global" },
    ]);

    expect(diagnostics).toEqual([]);
    expect(plugins[0].openai).toEqual({
      interface: { displayName: "Meta", shortDescription: "Docs", developerName: "Acme" },
      review,
      publication,
    });
  });

  test("a manifest swapped for an outside link after its size check is not read", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await fs.realpath(await writePlugin(container, "swapped"));
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "outside-name" }),
      "utf8"
    );
    const manifestPath = path.join(pluginDir, "plugin.json");
    // A local process replaces the manifest between discovery's size check and its read.
    const realStat = fs.stat;
    let swapped = false;
    const stats = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      const result = await realStat(...args);
      if (!swapped && args[0] === manifestPath) {
        swapped = true;
        await fs.rm(manifestPath);
        await fs.symlink(outside, manifestPath);
      }
      return result;
    }) as typeof fs.stat);
    try {
      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);
      expect(swapped).toBe(true);
      expect(result.plugins).toEqual([]);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({ path: manifestPath, severity: "error" });
    } finally {
      stats.mockRestore();
    }
  });

  test("root plugin.json and mcp.json win over the Codex fallbacks", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "root-plugin", { mcpJson: "{}" });
    await fs.mkdir(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "codex-name" }),
      "utf8"
    );
    await fs.writeFile(path.join(pluginDir, ".mcp.json"), "{}", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["root-plugin"]);
    expect(result.plugins[0].mcpConfigPath).toBe(path.join(result.plugins[0].rootPath, "mcp.json"));
  });

  test("a symlinked .mcp.json keeps the Codex dialect; a root mcp.json does not", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const linked = await writePlugin(container, "linked");
    await fs.mkdir(path.join(linked, "config"));
    await fs.writeFile(path.join(linked, "config", "server.json"), "{}", "utf8");
    await fs.symlink("config/server.json", path.join(linked, ".mcp.json"));
    await writePlugin(container, "portable", { mcpJson: "{}" });

    const { plugins } = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const byName = new Map(plugins.map((p) => [p.name, p]));
    expect(byName.get("linked")?.mcpConfigPath).toBe(
      path.join(byName.get("linked")!.rootPath, "config", "server.json")
    );
    expect(byName.get("linked")?.mcpConfigDialect).toBe("codex");
    expect(byName.get("portable")?.mcpConfigDialect).toBeUndefined();
  });

  test("falls back to .mcp.json for a root-manifest plugin without mcp.json", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dot-mcp");
    await fs.writeFile(path.join(pluginDir, ".mcp.json"), "{}", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins[0].mcpConfigPath).toBe(
      path.join(result.plugins[0].rootPath, ".mcp.json")
    );
  });

  test("refuses a .codex-plugin/plugin.json symlink that escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ name: "escaper" }), "utf8");
    const codexDir = path.join(container, "escaper", ".codex-plugin");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.symlink(outside, path.join(codexDir, "plugin.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("invalid com.openai fields are dropped with warnings, never fatal", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "bad-openai", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "bad-openai",
        extensions: { "com.openai": { apps: "../escape.json", onboardingSkill: 3 } },
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["bad-openai"]);
    expect(result.plugins[0].openai).toEqual({});
    expect(result.diagnostics.map((d) => d.severity)).toEqual(["warning", "warning"]);
  });

  test("a broken sibling plugin never affects a valid one", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "a-broken", { rawManifest: "{ not json" });
    await writePlugin(container, "b-invalid", {
      manifest: { $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "Bad--Name" },
    });
    await writePlugin(container, "c-valid");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["c-valid"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  test("reports unsupported $schema distinctly from invalid manifests", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "future-plugin", {
      manifest: {
        $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
        name: "future-plugin",
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toStartWith(
      "Unsupported Agent Plugins version (plugin.json): "
    );
  });

  test("loads plugins with unknown top-level manifest fields and reports a warning", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "extra-plugin", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "extra-plugin",
        commands: ["x"],
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["extra-plugin"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe("warning");
    expect(result.diagnostics[0].message).toContain("commands");
  });

  test("rejects a plugin whose plugin.json symlink escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "escaper" }),
      "utf8"
    );
    const pluginDir = path.join(container, "escaper");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.symlink(outside, path.join(pluginDir, "plugin.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("skills symlink escaping the root invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outsideSkills = path.join(tmp.path, "outside-skills");
    await fs.mkdir(outsideSkills, { recursive: true });
    const pluginDir = await writePlugin(container, "escaping-skills", { mcpJson: "{}" });
    await fs.symlink(outsideSkills, path.join(pluginDir, "skills"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDirs).toBeUndefined();
    // MCP component is unaffected (§6.2 narrowest-scope invalidation).
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("skills/");
  });

  test("mcp.json of the wrong filesystem kind invalidates only the MCP component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dir-mcp", { skills: ["greet"] });
    await fs.mkdir(path.join(pluginDir, "mcp.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.plugins[0].skillsDirs).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("mcp.json");
  });

  test("skills location that is a file invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "file-skills", { mcpJson: "{}" });
    await fs.writeFile(path.join(pluginDir, "skills"), "not a dir", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDirs).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
  });

  test("resolves hooks.js as a component path when present", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "hooky");
    await fs.writeFile(path.join(pluginDir, "hooks.js"), "({})", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBe(path.join(pluginDir, "hooks.js"));
    expect(result.diagnostics).toEqual([]);
  });

  test("hooks.js of the wrong filesystem kind invalidates only the hooks component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dir-hooks", { mcpJson: "{}" });
    await fs.mkdir(path.join(pluginDir, "hooks.js"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("hooks.js");
  });

  test("an oversized hooks.js invalidates only the hooks component", async () => {
    // The hook source is read and hashed every send and evaluated in the
    // main process: a repo pouring its checkout quota into hooks.js must not
    // gain a post-install stall primitive. The same discovery cap governs
    // the consent preview, so preview and runtime exclude identically.
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "big-hooks", { mcpJson: "{}" });
    await fs.writeFile(
      path.join(pluginDir, "hooks.js"),
      `// ${"x".repeat(2 * 1024 * 1024)}\n({})`,
      "utf8"
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].hooksPath).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("too large");
  });

  test("a symlinked plugin directory anchors containment at its realpath", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(container, { recursive: true });
    const actual = path.join(tmp.path, "elsewhere", "linked-plugin");
    await fs.mkdir(actual, { recursive: true });
    await fs.writeFile(
      path.join(actual, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "linked-plugin" }),
      "utf8"
    );
    await fs.symlink(actual, path.join(container, "linked-plugin"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].rootPath).toBe(await fs.realpath(actual));
    expect(result.diagnostics).toEqual([]);
  });

  test("canonical project plugins suppress same-named legacy copies", async () => {
    using tmp = new DisposableTempDir("agent-plugins-precedence");
    const canonical = path.join(tmp.path, ".xum", "plugins");
    const legacy = path.join(tmp.path, ".mux", "plugins");
    await writePlugin(canonical, "shared-plugin", { skills: ["canonical-skill"] });
    await writePlugin(legacy, "shared-plugin", { skills: ["legacy-skill"] });
    await writePlugin(legacy, "legacy-only");

    const result = await discoverAgentPlugins([
      { path: canonical, scope: "project" },
      { path: legacy, scope: "project" },
    ]);

    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["shared-plugin", "legacy-only"]);
    expect(result.plugins[0]?.containerPath).toBe(canonical);
  });

  test("missing containers yield no plugins and no diagnostics", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const result = await discoverAgentPlugins([
      { path: path.join(tmp.path, "does-not-exist"), scope: "global" },
    ]);
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("throws on relative container paths", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      discoverAgentPlugins([{ path: "relative/plugins", scope: "global" }])
    ).rejects.toThrow("must be absolute");
  });

  test("dedupes repeated container paths and orders plugins alphabetically per container", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "zeta");
    await writePlugin(container, "alpha");

    const result = await discoverAgentPlugins([
      { path: container, scope: "global" },
      { path: container, scope: "global" },
    ]);

    expect(result.plugins.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });

  test("discards a container's results when the gate's post-scan confirm flags it", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "transient-plugin");

    // A mutation that overlaps the scan is only visible AFTER the scan read
    // the container: pre-scan suppression stays empty and confirm flags it.
    setAgentPluginDiscoveryGate((containerPaths) =>
      Promise.resolve({
        suppressed: [],
        confirm: () => Promise.resolve(containerPaths),
      })
    );
    try {
      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);
      expect(result.plugins).toEqual([]);
      expect(result.diagnostics.some((d) => d.message.includes("overlapped this scan"))).toBe(true);
    } finally {
      setAgentPluginDiscoveryGate(journalDerivedDiscoveryGate);
    }
  });
});

describe("journalDerivedDiscoveryGate", () => {
  test("suppresses a container whose staging root holds a journal at session creation", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, "promotion-demo.json"), "{}", "utf8");

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([container]);
  });

  test("suppresses a container while its mutation epoch is unreadable", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });
    // A directory at the epoch path is a deterministic non-ENOENT read
    // failure without relying on permission behavior of the test user.
    await fs.mkdir(path.join(stagingRoot, MUTATION_EPOCH_FILE));

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([container]);
    expect(await session.confirm()).toEqual([container]);
  });

  test("confirm flags a mutation whose whole journal lifetime fit inside the scan window", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const stagingRoot = path.join(tmp.path, STAGING_DIR_NAME);
    await fs.mkdir(container, { recursive: true });
    await fs.mkdir(stagingRoot, { recursive: true });

    const session = await journalDerivedDiscoveryGate([container]);
    expect(session.suppressed).toEqual([]);

    // Nothing changed: a quiet container stays accepted (also covers the
    // stable "epoch file never written" state on both reads).
    expect(await session.confirm()).toEqual([]);

    // Full transaction between the session's two reads: journal written,
    // container mutated, epoch bumped (the install service bumps BEFORE
    // deleting any journal), journal consumed. The journal file alone can no
    // longer betray the mutation — only the epoch can.
    const journalPath = path.join(stagingRoot, "promotion-demo.json");
    await fs.writeFile(journalPath, "{}", "utf8");
    await bumpContainerMutationEpoch(stagingRoot);
    await fs.rm(journalPath);
    expect(await session.confirm()).toEqual([container]);

    // A journal still in flight at confirm time is flagged as well.
    const session2 = await journalDerivedDiscoveryGate([container]);
    await fs.writeFile(journalPath, "{}", "utf8");
    expect(await session2.confirm()).toEqual([container]);
  });
});

describe("computeAgentPluginContainers", () => {
  test("includes project containers only for trusted projects with absolute roots", () => {
    const trusted = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "/repo",
      projectTrusted: true,
    });
    expect(trusted.filter((c) => c.scope === "project").map((c) => c.path)).toEqual([
      path.join("/repo", ".xum", "plugins"),
      path.join("/repo", ".mux", "plugins"),
      path.join("/repo", ".agents", "plugins"),
    ]);

    const untrusted = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "/repo",
      projectTrusted: false,
    });
    expect(untrusted.every((c) => c.scope === "global")).toBe(true);

    const relative = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectRoot: "repo",
      projectTrusted: true,
    });
    expect(relative.every((c) => c.scope === "global")).toBe(true);
  });

  test("excludes project containers when project automation is disabled", () => {
    const previous = process.env.MUX_DISABLE_PROJECT_AUTOMATION;
    process.env.MUX_DISABLE_PROJECT_AUTOMATION = "1";
    try {
      const containers = computeAgentPluginContainers({
        xumHome: "/home/u/.mux",
        projectRoot: "/repo",
        projectTrusted: true,
      });
      // Dataset-controlled plugin containers must be inert under the
      // benchmark kill-switch even when the project is trusted; global
      // containers stay active.
      expect(containers.length).toBeGreaterThan(0);
      expect(containers.every((c) => c.scope === "global")).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.MUX_DISABLE_PROJECT_AUTOMATION;
      } else {
        process.env.MUX_DISABLE_PROJECT_AUTOMATION = previous;
      }
    }
  });

  test("always includes the xumHome global container", () => {
    const containers = computeAgentPluginContainers({
      xumHome: "/home/u/.mux",
      projectTrusted: false,
    });
    expect(containers.some((c) => c.path === path.join("/home/u/.mux", "plugins"))).toBe(true);
  });
});

describe("plugin .git containment (#6161)", () => {
  test("the contained reader refuses a link into .git; .gitignore-like names still read", async () => {
    using tmp = new DisposableTempDir("plugin-git-link");
    const root = await fs.realpath(tmp.path);
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "url = https://user:SECRET@host\n");
    await fs.symlink(".git/config", path.join(root, "hooks.js"));
    await fs.symlink(".git", path.join(root, "linked-git"));
    await fs.writeFile(path.join(root, ".gitignore"), "dist\n");
    await fs.mkdir(path.join(root, ".github"));
    await fs.writeFile(path.join(root, ".github", "notes.md"), "ok\n");
    const read = (relative: string) =>
      readPluginFileWithinRootCapped({
        filePath: path.join(root, relative),
        pluginRoot: root,
        maxBytes: 1024,
        label: "hooks.js",
      });
    for (const relative of ["hooks.js", ".git/config", "linked-git/config", ".GIT/config"]) {
      const error: unknown = await read(relative).catch((caught: unknown) => caught);
      // ".GIT" exists only on case-insensitive filesystems; elsewhere it is missing.
      if (relative === ".GIT/config" && error instanceof Error && error.message.includes("ENOENT"))
        continue;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(".git directory");
      expect(String(error)).not.toContain("SECRET");
    }
    expect((await read(".gitignore")).content).toBe("dist\n");
    expect((await read(".github/notes.md")).content).toBe("ok\n");
    expect(await ensurePluginPathContained(root, path.join(root, ".gitignore"))).toBe(
      path.join(root, ".gitignore")
    );
  });
});

describe("Claude Code plugin discovery", () => {
  /** Write files (relative path → content) under a new plugin folder. */
  async function writeTree(pluginDir: string, files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(pluginDir, relative)), { recursive: true });
      await fs.writeFile(path.join(pluginDir, relative), content, "utf8");
    }
  }
  const claudeManifest = (manifest: unknown) => ({
    ".claude-plugin/plugin.json": JSON.stringify(manifest),
  });

  test("maps the Claude manifest: skills add to skills/, one agents folder, ignored keys warn", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "review-kit");
    await writeTree(pluginDir, {
      ...claudeManifest({
        $schema: "https://json.schemastore.org/claude-code-plugin.json",
        name: "review-kit",
        version: "1.4.0",
        description: "Review tools",
        author: { name: "Example", email: "dev@example.com", team: "x" },
        metadata: { catalogId: "c" },
        skills: ["./extra-skills/"],
        agents: ["./custom-agents/reviewer.md", "./custom-agents/tester.md"],
        mcpServers: "./config/servers.json",
        lspServers: "./.lsp.json",
        userConfig: { token: { type: "string" } },
        contributes: { slashCommands: [{ name: "x", expansion: "y" }] },
        extensions: { mux: { hooks: { tools: ["bash"] } } },
      }),
      "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n",
      "extra-skills/b/SKILL.md": "---\nname: b\ndescription: B\n---\n",
      "custom-agents/reviewer.md": "---\nname: reviewer\ndescription: R\n---\n",
      "config/servers.json": "{}",
      ".mcp.json": "{}",
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.claudeFallback).toBe(true);
    expect(plugin.manifest).toMatchObject({
      name: "review-kit",
      version: "1.4.0",
      description: "Review tools",
      author: { name: "Example", email: "dev@example.com" },
    });
    expect(plugin.manifest.extensions).toBeUndefined();
    expect(plugin.manifest.contributes?.slashCommands).toBeUndefined();
    expect(resolvePluginHookGrants(plugin.manifest).bridgeTools.allow).toEqual([]);
    expect(plugin.skillsDirs).toEqual([
      { dir: path.join(plugin.rootPath, "skills") },
      { dir: path.join(plugin.rootPath, "extra-skills") },
    ]);
    expect(plugin.agentsDir).toBe(path.join(plugin.rootPath, "custom-agents"));
    expect(plugin.mcpConfigPath).toBe(path.join(plugin.rootPath, "config", "servers.json"));
    expect(plugin.mcpConfigDialect).toBe("claude");
    expect(result.diagnostics.map((d) => d.severity)).not.toContain("error");
    const messages = result.diagnostics.map((d) => d.message).join("\n");
    for (const key of ["author.team", "lspServers", "userConfig", "contributes", "extensions"]) {
      expect(messages).toContain(`'${key}'`);
    }
    // Keys Claude Code itself ignores at load time do not warn.
    expect(messages).not.toContain("'metadata'");
    expect(messages).not.toContain("'$schema'");
  });

  test("agents spread over two folders, or an empty list, load no agents (never agents/)", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const agent = "---\nname: c\ndescription: C\n---\n";
    await writeTree(path.join(container, "spread"), {
      ...claudeManifest({ name: "spread", agents: ["./one/a.md", "./two/b.md"] }),
      "one/a.md": agent,
      "two/b.md": agent,
      "agents/c.md": agent,
    });
    // A Claude `agents` value replaces the default scan, so an empty list declares none.
    await writeTree(path.join(container, "none"), {
      ...claudeManifest({ name: "none", agents: [] }),
      "agents/c.md": agent,
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((plugin) => [plugin.name, plugin.agentsDir])).toEqual([
      ["none", undefined],
      ["spread", undefined],
    ]);
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(
      "'agents' must list .md files in one folder below the plugin root; loading no agents"
    );
  });

  test("a Claude name with capitals or underscores loads in the Agent Plugins grammar", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    for (const [dirName, name] of [
      ["snake", "my_plugin"],
      ["camel", "MyPlugin"],
      // No safe mapping: "--" stays invalid, so the validator refuses the plugin.
      ["double", "my__plugin"],
    ]) {
      await writeTree(path.join(container, dirName), claudeManifest({ name }));
    }

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((plugin) => [plugin.dirName, plugin.name])).toEqual([
      ["camel", "myplugin"],
      ["snake", "my-plugin"],
    ]);
    const messages = result.diagnostics.map((d) => `${d.severity}: ${d.message}`).join("\n");
    expect(messages).toContain("Plugin name 'my_plugin' is not an Agent Plugins name");
    expect(messages).toContain("error: Invalid plugin manifest");
  });

  test("a Claude package gets agents/ but no hooks.js and no workflows/", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "gated");
    await writeTree(pluginDir, {
      ...claudeManifest({ name: "gated" }),
      "hooks.js": "export default {};",
      "workflows/run.js": "export {};",
      "agents/helper.md": "---\nname: helper\ndescription: H\n---\n",
      // Claude Code reads only .mcp.json, so a Claude package never falls back to mcp.json.
      "mcp.json": "{}",
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.hooksPath).toBeUndefined();
    expect(plugin.workflowsDir).toBeUndefined();
    expect(plugin.agentsDir).toBe(path.join(plugin.rootPath, "agents"));
    expect(plugin.mcpConfigPath).toBeUndefined();
  });

  test("a skill file swapped for an outside link after its check does not take a command's name", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writeTree(path.join(container, "kit"), {
      ...claudeManifest({ name: "kit" }),
      "commands/deploy.md": "x",
      "skills/deploy/SKILL.md": "not a skill\n",
    });
    const outside = path.join(tmp.path, "outside.md");
    await fs.writeFile(outside, "---\nname: deploy\ndescription: D\n---\n", "utf8");
    const skillFile = path.join(
      await fs.realpath(path.join(container, "kit")),
      "skills",
      "deploy",
      "SKILL.md"
    );
    // A local process replaces SKILL.md between the probe's stat and its read.
    const realStat = fs.stat;
    let swapped = false;
    const stats = spyOn(fs, "stat").mockImplementation((async (
      ...args: Parameters<typeof fs.stat>
    ) => {
      const result = await realStat(...args);
      if (!swapped && args[0] === skillFile) {
        swapped = true;
        await fs.rm(skillFile);
        await fs.symlink(outside, skillFile);
      }
      return result;
    }) as typeof fs.stat);
    try {
      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);
      expect(swapped).toBe(true);
      // The outside file is never read as the skill, so the command keeps its name.
      expect(result.plugins[0]?.skillsDirs).toContainEqual({
        dir: path.join(result.plugins[0].rootPath, "commands"),
        single: true,
        name: "deploy",
        command: true,
      });
      expect(result.diagnostics.map((d) => d.message).join("\n")).not.toContain(
        "'deploy.md' is ignored"
      );
    } finally {
      stats.mockRestore();
    }
  });

  test("commands become command roots after the skills roots; bad and taken names warn", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "cmds");
    await writeTree(pluginDir, {
      // A manifest `commands` list replaces commands/ (the Claude rule).
      ...claudeManifest({ name: "cmds", commands: ["./extra/", "./one/solo.md"] }),
      "commands/ignored.md": "x",
      "extra/deploy.md": "x",
      "extra/Bad_Name.md": "x",
      "extra/notes.txt": "x",
      "extra/greet.md": "x",
      "one/solo.md": "x",
      "skills/greet/SKILL.md": "---\nname: greet\ndescription: G\n---\n",
    });
    const objectMap = path.join(container, "map");
    await writeTree(objectMap, {
      ...claudeManifest({ name: "map", commands: { about: { content: "x" } } }),
      "commands/default.md": "x",
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const [cmds, map] = result.plugins;
    const extra = path.join(cmds.rootPath, "extra");
    expect(cmds.skillsDirs).toEqual([
      { dir: path.join(cmds.rootPath, "skills") },
      { dir: extra, single: true, name: "deploy", command: true },
      { dir: path.join(cmds.rootPath, "one"), single: true, name: "solo", command: true },
    ]);
    // An ignored object map still replaces commands/.
    expect(map.skillsDirs).toBeUndefined();
    const messages = result.diagnostics.map((d) => d.message).join("\n");
    expect(messages).toContain("'Bad_Name.md' has no valid skill name");
    expect(messages).toContain("'greet.md' is ignored");
    expect(messages).toContain("object map in 'commands'");
  });

  test("an agents list that leaves out a file in its folder loads no agents", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writeTree(path.join(container, "partial"), {
      ...claudeManifest({ name: "partial", agents: ["./custom/reviewer.md"] }),
      "custom/reviewer.md": "---\nname: reviewer\ndescription: R\n---\n",
      "custom/internal.md": "---\nname: internal\ndescription: I\n---\n",
    });
    await writeTree(path.join(container, "complete"), {
      ...claudeManifest({ name: "complete", agents: ["./custom/reviewer.md"] }),
      "custom/reviewer.md": "---\nname: reviewer\ndescription: R\n---\n",
      "custom/notes.txt": "not an agent",
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const byName = new Map(result.plugins.map((plugin) => [plugin.name, plugin]));
    expect(byName.get("partial")?.agentsDir).toBeUndefined();
    const complete = byName.get("complete");
    expect(complete?.agentsDir).toBe(path.join(complete?.rootPath ?? "", "custom"));
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain("internal.md");
  });

  test("a root SKILL.md is the one skill only without skills/ and a skills key", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const skill = "---\nname: solo\ndescription: S\n---\n";
    await writeTree(path.join(container, "solo"), {
      ...claudeManifest({ name: "solo" }),
      "SKILL.md": skill,
    });
    await writeTree(path.join(container, "has-dir"), {
      ...claudeManifest({ name: "has-dir" }),
      "SKILL.md": skill,
      "skills/a/SKILL.md": "---\nname: a\ndescription: A\n---\n",
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const byName = new Map(result.plugins.map((plugin) => [plugin.name, plugin]));
    const solo = byName.get("solo");
    expect(solo?.skillsDirs).toEqual([{ dir: solo?.rootPath ?? "", single: true, name: "solo" }]);
    const hasDir = byName.get("has-dir");
    expect(hasDir?.skillsDirs).toEqual([{ dir: path.join(hasDir?.rootPath ?? "", "skills") }]);
  });

  test("a command keeps its declared name through a symlink and survives a broken skill", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = path.join(container, "cmds");
    await writeTree(pluginDir, {
      ...claudeManifest({
        name: "cmds",
        commands: ["./commands/review.md", "./commands/deploy.md"],
      }),
      "shared/prompt.md": "Review $ARGUMENTS",
      "commands/deploy.md": "Deploy",
      // An empty skill folder and a SKILL.md without frontmatter never load as skills.
      "skills/review/SKILL.md": "no frontmatter",
    });
    await fs.mkdir(path.join(pluginDir, "skills", "deploy"), { recursive: true });
    await fs.symlink(
      path.join("..", "shared", "prompt.md"),
      path.join(pluginDir, "commands", "review.md")
    );

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    const plugin = result.plugins[0];
    const commands = path.join(plugin.rootPath, "commands");
    expect(plugin.skillsDirs).toEqual([
      { dir: path.join(plugin.rootPath, "skills") },
      { dir: commands, single: true, name: "review", command: true },
      { dir: commands, single: true, name: "deploy", command: true },
    ]);
  });

  test("plugin.json beats .codex-plugin/plugin.json, which beats .claude-plugin/plugin.json", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const claude = claudeManifest({ name: "from-claude" });
    const codex = { ".codex-plugin/plugin.json": JSON.stringify({ name: "from-codex" }) };
    const root = {
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "from-root" }),
    };
    await writeTree(path.join(container, "a"), { ...claude, ...codex, ...root });
    await writeTree(path.join(container, "b"), { ...claude, ...codex });
    await writeTree(path.join(container, "c"), claude);

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => [p.dirName, p.name, p.claudeFallback === true])).toEqual([
      ["a", "from-root", false],
      ["b", "from-codex", false],
      ["c", "from-claude", true],
    ]);
  });

  test("a root plugin.json without $schema yields to a Codex or Claude manifest", async () => {
    // DietrichGebert/ponytail ships `{"name":"ponytail"}` at the root for another harness, next
    // to its .codex-plugin and .claude-plugin manifests.
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const claude = claudeManifest({ name: "from-claude" });
    const codex = { ".codex-plugin/plugin.json": JSON.stringify({ name: "from-codex" }) };
    const foreignRoot = { "plugin.json": JSON.stringify({ name: "from-root" }) };
    await writeTree(path.join(container, "a"), { ...claude, ...codex, ...foreignRoot });
    await writeTree(path.join(container, "b"), { ...claude, ...foreignRoot });
    // Alone, the root manifest is still reported, so an author who forgot $schema learns why.
    await writeTree(path.join(container, "c"), foreignRoot);

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => [p.dirName, p.name, p.claudeFallback === true])).toEqual([
      ["a", "from-codex", false],
      ["b", "from-claude", true],
    ]);
    expect(
      result.diagnostics.map(({ path: diagnosticPath, severity, message }) => ({
        diagnosticPath,
        severity,
        message,
      }))
    ).toEqual([
      {
        diagnosticPath: path.join(container, "c", "plugin.json"),
        severity: "error",
        message:
          "Invalid plugin manifest (plugin.json): '$schema' is required and must be a string",
      },
    ]);
  });

  test("a manifest error names the file from the repository root when given the plugin folder", async () => {
    // Settings installs a repository's `.codex-plugin` folder as the plugin root: its
    // plugin.json must read as `.codex-plugin/plugin.json`, the path the user knows.
    using tmp = new DisposableTempDir("agent-plugins");
    const pluginDir = path.join(tmp.path, "staged");
    await writeTree(pluginDir, { "plugin.json": JSON.stringify({ name: "multi-harness" }) });

    const result = await discoverAgentPluginAt({
      pluginDir,
      scope: "global",
      shownRoot: ".codex-plugin",
    });

    expect(result.plugin).toBeNull();
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      "Invalid plugin manifest (.codex-plugin/plugin.json): '$schema' is required and must be a string",
    ]);
  });

  test("a manifest read error names the file from the repository root too", async () => {
    // Read, size and containment errors come before validation (Codex review, #7422).
    using tmp = new DisposableTempDir("agent-plugins");
    const pluginDir = path.join(tmp.path, "staged");
    await writeTree(pluginDir, { "plugin.json": "{ not json" });

    const result = await discoverAgentPluginAt({
      pluginDir,
      scope: "global",
      shownRoot: ".codex-plugin",
    });

    expect(result.plugin).toBeNull();
    const messages = result.diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^Failed to read \.codex-plugin\/plugin\.json: /);
  });

  test("an invalid Codex manifest error names .codex-plugin/plugin.json", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    // "--" has no safe name mapping, so the validator refuses the manifest.
    await writeTree(path.join(container, "bad"), {
      ".codex-plugin/plugin.json": JSON.stringify({ name: "my--plugin" }),
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics.map((d) => [d.severity, d.path])).toEqual([
      ["error", path.join(container, "bad", ".codex-plugin", "plugin.json")],
    ]);
    expect(result.diagnostics[0].message).toStartWith(
      "Invalid plugin manifest (.codex-plugin/plugin.json): "
    );
  });
});

describe("Cursor plugin discovery", () => {
  async function writeTree(pluginDir: string, files: Record<string, string>): Promise<void> {
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(pluginDir, relative)), { recursive: true });
      await fs.writeFile(path.join(pluginDir, relative), content, "utf8");
    }
  }
  const cursorManifest = (manifest: unknown) => ({
    ".cursor-plugin/plugin.json": JSON.stringify(manifest),
  });
  const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\n`;
  const rule = (description: string) => `---\ndescription: ${description}\n---\nBody\n`;

  /** Disposing the result removes the plugin folder, so checks that read it run before that. */
  async function discoverKit(files: Record<string, string>) {
    const tmp = new DisposableTempDir("cursor-plugins");
    try {
      const container = path.join(tmp.path, "plugins");
      await writeTree(path.join(container, "kit"), files);
      const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);
      expect(result.plugins).toHaveLength(1);
      const plugin = result.plugins[0];
      return {
        plugin,
        messages: result.diagnostics.map((d) => d.message),
        relative: (dir: string) => path.relative(plugin.rootPath, dir),
        [Symbol.dispose]: () => tmp[Symbol.dispose](),
      };
    } catch (error) {
      tmp[Symbol.dispose]();
      throw error;
    }
  }

  const ruleSkills = (plugin: { skillsDirs?: Array<{ name?: string; rule?: string }> }) =>
    (plugin.skillsDirs ?? []).flatMap((root) =>
      root.rule !== undefined ? [[root.name, root.rule]] : []
    );

  test("a folder with only a Cursor manifest and skills/ loads with its skills", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "skills/alpha/SKILL.md": skill("alpha"),
    });
    const { plugin, relative } = kit;
    expect(plugin.cursorFallback).toBe(true);
    expect(plugin.name).toBe("kit");
    expect(plugin.skillsDirs?.map((root) => relative(root.dir))).toEqual(["skills"]);
    expect(plugin.notApplied).toEqual([]);
  });

  test("a root plugin.json with $schema loads before a Cursor manifest", async () => {
    using kit = await discoverKit({
      "plugin.json": JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "from-root" }),
      ...cursorManifest({ name: "from-cursor" }),
    });
    const { plugin } = kit;
    expect([plugin.name, plugin.cursorFallback]).toEqual(["from-root", undefined]);
  });

  test("a schema-less root plugin.json yields to a Cursor manifest (D21)", async () => {
    using kit = await discoverKit({
      "plugin.json": JSON.stringify({ name: "from-root" }),
      ...cursorManifest({ name: "from-cursor" }),
    });
    const { plugin } = kit;
    expect([plugin.name, plugin.cursorFallback]).toEqual(["from-cursor", true]);
  });

  test("hooks.js, workflows/, skill scripts and com.openai of a Cursor folder do not load", async () => {
    using kit = await discoverKit({
      ...cursorManifest({
        name: "kit",
        contributes: { hooks: "hooks.js", workflows: "workflows" },
        extensions: { mux: { hooks: { tools: ["bash"] } } },
      }),
      "hooks.js": "export default {};\n",
      "workflows/run.js": "export {};\n",
      "skills/alpha/SKILL.md": skill("alpha"),
      "skills/alpha/workflow.js": "export {};\n",
    });
    const { plugin } = kit;
    expect(plugin.hooksPath).toBeUndefined();
    expect(plugin.workflowsDir).toBeUndefined();
    expect(plugin.manifest.extensions).toBeUndefined();
    expect(plugin.manifest.contributes?.hooks).toBeUndefined();
    expect(resolvePluginHookGrants(plugin.manifest).bridgeTools.allow).toEqual([]);
    expect(await listPluginSkillScripts(plugin)).toEqual([]);
  });

  test("variables, category and a commands/ folder are listed as not applied", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit", variables: { TOKEN: {} }, category: "developer-tools" }),
      "commands/review.md": "Review\n",
    });
    const { plugin } = kit;
    expect(plugin.notApplied).toEqual([
      { part: "field", name: "variables", reason: "not applied in Xum" },
      { part: "field", name: "category", reason: "not applied in Xum" },
      { part: "command", name: "commands/", reason: "not applied in Xum" },
    ]);
    expect(plugin.skillsDirs).toBeUndefined();
  });

  test("hooks/hooks.json produces no Codex hooks and one not-applied hook entry", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      // Cursor's `stop` and a Codex-shaped `Stop`: the Codex loader must read neither.
      "hooks/hooks.json": JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "./hooks/stop.sh" }],
          Stop: [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }] }],
        },
      }),
    });
    const { plugin } = kit;
    expect(await loadPluginCodexHooks(plugin)).toEqual({ hooks: [], warnings: [] });
    expect(plugin.notApplied).toEqual([
      {
        part: "hook",
        name: "hooks/hooks.json",
        reason: "Cursor hooks run in a later Xum build",
      },
    ]);
  });

  test("mcp.json produces no MCP config and one not-applied MCP entry", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit", mcpServers: "./mcp.json" }),
      "mcp.json": JSON.stringify({ mcpServers: { x: { url: "https://x.example/mcp" } } }),
    });
    const { plugin } = kit;
    expect(plugin.mcpConfigPath).toBeUndefined();
    expect(plugin.mcpConfigDialect).toBeUndefined();
    expect(plugin.notApplied).toEqual([
      {
        part: "mcp",
        name: "mcp.json",
        reason: "MCP servers of Cursor plugins load in a later Xum build",
      },
    ]);
  });

  test("a manifest rules folder replaces the default rules/", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit", rules: "./my-rules/" }),
      "my-rules/mine.mdc": rule("Mine"),
      "rules/default.mdc": rule("Default"),
    });
    const { plugin, relative } = kit;
    expect(ruleSkills(plugin)).toEqual([["mine", "mine.mdc"]]);
    expect(plugin.skillsDirs?.map((root) => relative(root.dir))).toEqual(["my-rules"]);
  });

  test("rules ending in .mdc, .md and .markdown load as rule skills; other files do not", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/a.mdc": rule("A"),
      "rules/b.md": rule("B"),
      "rules/c.markdown": rule("C"),
      "rules/notes.txt": "not a rule\n",
    });
    const { plugin } = kit;
    expect(ruleSkills(plugin)).toEqual([
      ["a", "a.mdc"],
      ["b", "b.md"],
      ["c", "c.markdown"],
    ]);
  });

  test("a rule without a valid skill name is dropped with a warning", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/Bad_Name.mdc": rule("Bad"),
    });
    const { plugin, messages } = kit;
    expect(ruleSkills(plugin)).toEqual([]);
    expect(messages).toContain(
      "Rule 'Bad_Name.mdc' has no valid skill name (kebab-case); ignoring it"
    );
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "Bad_Name.mdc", reason: "not a valid skill name" },
    ]);
  });

  test("of two rules with one name, the first in byte order wins", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/x.mdc": rule("From mdc"),
      "rules/x.md": rule("From md"),
    });
    const { plugin, messages } = kit;
    expect(ruleSkills(plugin)).toEqual([["x", "x.md"]]);
    expect(messages).toContain("Rule 'x.mdc' is ignored: a skill or rule named 'x' comes first");
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "x.mdc", reason: "a skill or rule of the same name comes first" },
    ]);
  });

  test("a skill wins over a rule of the same name", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "skills/review/SKILL.md": skill("review"),
      "rules/review.mdc": rule("Review rule"),
    });
    const { plugin } = kit;
    expect(ruleSkills(plugin)).toEqual([]);
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "review.mdc", reason: "a skill or rule of the same name comes first" },
    ]);
  });

  test("a rule that does not convert to a skill is listed and does not take its name", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/x.md": "---\n: [\n---\nBroken\n",
      "rules/x.mdc": rule("Valid"),
    });
    const { plugin, messages } = kit;
    expect(ruleSkills(plugin)).toEqual([["x", "x.mdc"]]);
    expect(messages).toContain("Rule 'x.md' has invalid frontmatter; ignoring it");
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "x.md", reason: "invalid frontmatter" },
    ]);
  });

  test("rules refused at conversion are listed with their own reasons", async () => {
    // Forty aliases of one anchor in `globs` grow the rewritten frontmatter past the file's own
    // size, so a file just under the SKILL.md cap is over it once rewritten.
    const frontmatter = `---\nx: &x "${"a".repeat(200)}"\nglobs: [${Array(40).fill("*x").join(", ")}]\n---\n`;
    const overCap = `${frontmatter}${"p".repeat(MAX_FILE_SIZE - 100 - frontmatter.length)}`;
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/broken.mdc": "---\n: [\n---\nBroken\n",
      "rules/huge.mdc": overCap,
      "rules/ok.mdc": rule("Valid"),
    });
    const { plugin } = kit;
    expect(ruleSkills(plugin)).toEqual([["ok", "ok.mdc"]]);
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "broken.mdc", reason: "invalid frontmatter" },
      { part: "rule", name: "huge.mdc", reason: "too large once rewritten as a skill" },
    ]);
  });

  test("refused rules count toward the rule cap", async () => {
    const broken = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `rules/r${String(index).padStart(3, "0")}.mdc`,
        "---\n: [\n---\nBroken\n",
      ])
    );
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      ...broken,
      "rules/valid.mdc": rule("Valid"),
    });
    const { plugin, messages } = kit;
    expect(ruleSkills(plugin)).toEqual([]);
    expect(plugin.notApplied).toHaveLength(256);
    expect(messages).toContain("More than 256 rules; ignoring the rest");
  });

  test("a rule that links to an earlier rule's file is refused without a second read", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "rules/a.mdc": rule("A"),
    });
    await fs.symlink("a.mdc", path.join(kit.plugin.rootPath, "rules", "b.mdc"));
    const rediscovered = await discoverAgentPlugins([
      { path: kit.plugin.containerPath, scope: "global" },
    ]);
    const [plugin] = rediscovered.plugins;
    expect(ruleSkills(plugin)).toEqual([["a", "a.mdc"]]);
    expect(plugin.notApplied).toEqual([
      { part: "rule", name: "b.mdc", reason: "the same file as an earlier rule" },
    ]);
  });

  test("a root SKILL.md is one skill only without skills/ and a skills field", async () => {
    using rootSkill = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "SKILL.md": skill("kit"),
    });
    expect(rootSkill.plugin.skillsDirs).toEqual([
      { dir: rootSkill.plugin.rootPath, single: true, name: "kit" },
    ]);
    using withFolder = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "SKILL.md": skill("kit"),
      "skills/alpha/SKILL.md": skill("alpha"),
    });
    expect(withFolder.plugin.skillsDirs?.map((root) => withFolder.relative(root.dir))).toEqual([
      "skills",
    ]);
  });

  test.each([
    ["prompts.chat", "prompts-chat"],
    ["foo.-bar", "foo-bar"],
    ["a.-.b", "a-b"],
  ])("a %s plugin's root skill is named %s", async (pluginName, skillName) => {
    using kit = await discoverKit({
      ...cursorManifest({ name: pluginName }),
      "SKILL.md": skill(skillName),
    });
    expect(kit.plugin.skillsDirs).toEqual([
      { dir: kit.plugin.rootPath, single: true, name: skillName },
    ]);
  });

  test("a skills entry that is not a folder leaves the root skill on", async () => {
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "SKILL.md": skill("kit"),
      skills: "not a folder\n",
    });
    expect(kit.plugin.skillsDirs).toEqual([
      { dir: kit.plugin.rootPath, single: true, name: "kit" },
    ]);
  });

  test("agents in .mdc and .markdown files are listed; .md agents load", async () => {
    const agent = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`;
    using kit = await discoverKit({
      ...cursorManifest({ name: "kit" }),
      "agents/ok.md": agent("ok"),
      "agents/rules.mdc": agent("rules"),
      "agents/long.markdown": agent("long"),
    });
    const { plugin, relative } = kit;
    expect(plugin.agentsDir === undefined ? undefined : relative(plugin.agentsDir)).toBe("agents");
    expect(plugin.notApplied).toEqual([
      { part: "agent", name: "long.markdown", reason: "only .md agent files are applied in Xum" },
      { part: "agent", name: "rules.mdc", reason: "only .md agent files are applied in Xum" },
    ]);
  });

  test("other package kinds list nothing as not applied", async () => {
    using kit = await discoverKit({
      ".claude-plugin/plugin.json": JSON.stringify({ name: "kit", category: "tools" }),
      "rules/a.mdc": rule("A"),
    });
    const { plugin } = kit;
    expect(plugin.claudeFallback).toBe(true);
    expect(plugin.notApplied).toEqual([]);
    expect(ruleSkills(plugin)).toEqual([]);
  });
});

describe("generatedFrom marker (skills-only packages)", () => {
  const SKILL = "---\nname: s\ndescription: S\n---\n";
  /** A plugin with every component kind; `marker` adds extensions.mux.generatedFrom. */
  async function writeFullPlugin(pluginDir: string, marker: unknown): Promise<void> {
    const files: Record<string, string> = {
      "plugin.json": JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "kit",
        contributes: { slashCommands: [{ name: "go", expansion: "Go" }] },
        extensions: {
          mux: {
            hooks: { tools: ["bash"] },
            ...(marker !== undefined ? { generatedFrom: marker } : {}),
          },
          "com.openai": { hooks: ["custom-hooks.json"] },
        },
      }),
      "skills/s/SKILL.md": SKILL,
      "hooks.js": "export default {};",
      "hooks/hooks.json": JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
      }),
      "custom-hooks.json": JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "y" }] }] },
      }),
      "agents/a.md": "---\nname: a\ndescription: A\n---\n",
      "workflows/w.js": "export default async () => {};",
      "mcp.json": "{}",
    };
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(pluginDir, relative)), { recursive: true });
      await fs.writeFile(path.join(pluginDir, relative), content, "utf8");
    }
  }

  test("a spoofed marker only removes capabilities: skills load, nothing else does", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    for (const [dirName, marker] of [
      ["plain", undefined],
      ["marked", { kind: "skills" }],
      // An unknown or malformed marker is skills-only too.
      ["unknown", { kind: "something-new" }],
      ["malformed", "yes"],
    ] as const) {
      const pluginDir = path.join(tmp.path, dirName);
      await writeFullPlugin(pluginDir, marker);
      const { plugin } = await discoverAgentPluginAt({ pluginDir, scope: "global" });
      if (plugin === null) throw new Error(`${dirName}: not a plugin`);
      const hooks = await loadPluginCodexHooks(plugin);
      const surface = {
        skills: plugin.skillsDirs?.map((root) => path.relative(plugin.rootPath, root.dir)),
        hooksJs: plugin.hooksPath !== undefined,
        agents: plugin.agentsDir !== undefined,
        workflows: plugin.workflowsDir !== undefined,
        mcp: plugin.mcpConfigPath !== undefined,
        codexHooks: hooks.hooks.length > 0,
        slashCommands: plugin.manifest.contributes?.slashCommands !== undefined,
        openai: plugin.openai !== undefined,
        hookTools: resolvePluginHookGrants(plugin.manifest).bridgeTools.allow.length > 0,
      };
      const loaded = marker === undefined;
      expect({ dirName, ...surface }).toEqual({
        dirName,
        skills: ["skills"],
        hooksJs: loaded,
        agents: loaded,
        workflows: loaded,
        mcp: loaded,
        codexHooks: loaded,
        slashCommands: loaded,
        openai: loaded,
        hookTools: loaded,
      });
      expect(plugin.skillsOnly).toBe(loaded ? undefined : true);
    }
  });
});

describe("generatedFrom marker (Claude marketplace packages)", () => {
  const SKILL = "---\nname: s\ndescription: S\n---\n";
  /** One tree with every component kind; `marker` adds extensions.mux.generatedFrom. */
  async function writePlugin(pluginDir: string, marker: unknown): Promise<void> {
    const files: Record<string, string> = {
      "plugin.json": JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "kit",
        contributes: {
          slashCommands: [{ name: "go", expansion: "Go" }],
          hooks: "hooks.js",
          workflows: "workflows",
          mcp: ".mcp.json",
        },
        extensions: {
          mux: {
            hooks: { tools: ["bash"] },
            ...(marker !== undefined ? { generatedFrom: marker } : {}),
          },
          "com.openai": { hooks: ["hooks/hooks.json"] },
        },
      }),
      "skills/s/SKILL.md": SKILL,
      "skills/s/workflow.js": "export default async () => {};",
      "commands/c.md": "Run c\n",
      "hooks.js": "export default {};",
      "hooks/hooks.json": JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "mcp_tool", server: "x", tool: "y" }] }] },
      }),
      "agents/a.md": "---\nname: a\ndescription: A\n---\n",
      "workflows/w.js": "export default async () => {};",
      ".mcp.json": JSON.stringify({ mcpServers: {} }),
    };
    for (const [relative, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(pluginDir, relative)), { recursive: true });
      await fs.writeFile(path.join(pluginDir, relative), content, "utf8");
    }
  }

  async function surfaceOf(pluginDir: string) {
    const { plugin } = await discoverAgentPluginAt({ pluginDir, scope: "global" });
    if (plugin === null) throw new Error(`${pluginDir}: not a plugin`);
    const hooks = await loadPluginCodexHooks(plugin);
    return {
      skills: plugin.skillsDirs?.map((root) => path.relative(plugin.rootPath, root.dir)),
      hooksJs: plugin.hooksPath !== undefined,
      agents: plugin.agentsDir !== undefined,
      workflows: plugin.workflowsDir !== undefined,
      mcp: plugin.mcpConfigPath !== undefined,
      runnableHooks: hooks.hooks.filter((hook) => hook.status === "runnable").length,
      listedHooks: hooks.hooks.length,
      slashCommands: plugin.manifest.contributes?.slashCommands !== undefined,
      openai: plugin.openai !== undefined,
      hookTools: resolvePluginHookGrants(plugin.manifest).bridgeTools.allow.length > 0,
      claude: plugin.claudeFallback === true,
      skillsOnly: plugin.skillsOnly === true,
      // Skill workflow.js files offered for review (and so runnable once approved).
      skillScripts: (await listPluginSkillScripts(plugin)).length,
    };
  }

  test("a claude-marketplace marker gets the Claude package set and gains nothing over plain", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    await writePlugin(path.join(tmp.path, "plain"), undefined);
    await writePlugin(path.join(tmp.path, "marked"), {
      kind: "claude-marketplace",
      entry: "kit",
      commands: ["commands"],
    });
    const plain = await surfaceOf(path.join(tmp.path, "plain"));
    const marked = await surfaceOf(path.join(tmp.path, "marked"));
    expect(plain).toMatchObject({
      hooksJs: true,
      workflows: true,
      runnableHooks: 1,
      slashCommands: true,
      openai: true,
      hookTools: true,
      skillScripts: 1,
    });
    expect(marked).toEqual({
      // Commands load as user-only skills: prompt files, which plain can ship as skills too.
      skills: ["skills", "commands"],
      hooksJs: false,
      agents: plain.agents,
      workflows: false,
      mcp: plain.mcp,
      // hooks.json is listed and never runs.
      runnableHooks: 0,
      listedHooks: 1,
      slashCommands: false,
      openai: false,
      hookTools: false,
      claude: true,
      skillsOnly: false,
      // A Claude package runs no Xum code: no skill workflow.js either.
      skillScripts: 0,
    });
  });

  test("a malformed claude-marketplace marker is skills-only", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    for (const [dirName, marker] of [
      ["no-entry", { kind: "claude-marketplace" }],
      ["bad-entry", { kind: "claude-marketplace", entry: "Not A Name" }],
      ["escaping-commands", { kind: "claude-marketplace", entry: "kit", commands: ["../x"] }],
      ["commands-not-list", { kind: "claude-marketplace", entry: "kit", commands: "commands" }],
    ] as const) {
      await writePlugin(path.join(tmp.path, dirName), marker);
      expect({ dirName, ...(await surfaceOf(path.join(tmp.path, dirName))) }).toMatchObject({
        dirName,
        skills: ["skills"],
        agents: false,
        mcp: false,
        listedHooks: 0,
        claude: false,
        skillsOnly: true,
      });
    }
  });
});

// On a case-insensitive filesystem (the macOS default), a `Foo-Bar` folder answers the lookup of
// `foo-bar`, so its snake_case twin must not be offered although no entry is named `foo-bar`.
test("a snake_case plugin skill folder yields to any kebab-case path that is a directory", async () => {
  const caseInsensitive = (folder: string) => Promise.resolve(folder.toLowerCase() === "foo-bar");
  expect(
    await pluginSkillFolderNames(["Foo-Bar", "foo_bar", "other_skill"], caseInsensitive)
  ).toEqual([
    { folder: "Foo-Bar", name: "Foo-Bar" },
    { folder: "other_skill", name: "other-skill" },
  ]);
});
