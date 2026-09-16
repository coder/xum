import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { rejects } from "node:assert/strict";
import { promises as fs } from "fs";
import * as jsonc from "jsonc-parser";
import * as atomicWrite from "write-file-atomic";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import type { AgentPluginsMcpProvider } from "./agentPlugins/mcpConfig";
import * as path from "path";
import * as os from "os";
import { Config } from "@/node/config";
import { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager } from "./mcpServerManager";
import { DISABLE_PROJECT_AUTOMATION_ENV } from "@/node/utils/projectAutomation";
import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { WorkspaceMetadata } from "@/common/types/workspace";

describe("MCPConfigService", () => {
  let tempDir: string;
  let config: Config;
  let configService: MCPConfigService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    config = new Config(tempDir);
    configService = new MCPConfigService(config);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("resolveWorkspaceAgentPluginsContext preserves the off-host null sentinel", async () => {
    // null suppresses plugin discovery entirely; coercing it to undefined would
    // fall back to project-level discovery and offer repo-controlled plugins for
    // workspaces that execute off-host.
    const cases: Array<{
      runtimeConfig: WorkspaceMetadata["runtimeConfig"];
      namedWorkspacePath?: string;
      expectedNull: boolean;
    }> = [
      {
        runtimeConfig: { type: "ssh", host: "example", srcBaseDir: "/remote/src" },
        namedWorkspacePath: "/remote/src/proj/ws1",
        expectedNull: true,
      },
      {
        runtimeConfig: { type: "worktree", srcBaseDir: tempDir },
        namedWorkspacePath: undefined,
        expectedNull: false,
      },
    ];
    for (const testCase of cases) {
      const projectPath = path.join(tempDir, "proj");
      // namedWorkspacePath is persisted alongside metadata for SSH workspaces (see WorkspaceMetadataForRuntime).
      const metadata: WorkspaceMetadata & { namedWorkspacePath?: string } = {
        id: "ws1234567890",
        name: "ws1",
        projectName: "proj",
        projectPath,
        runtimeConfig: testCase.runtimeConfig,
        namedWorkspacePath: testCase.namedWorkspacePath,
      };
      const service = new MCPConfigService(config, {
        workspaceMetadataProvider: {
          getWorkspaceMetadata: () => Promise.resolve({ success: true as const, data: metadata }),
        },
      });
      const resolved = await service.resolveWorkspaceAgentPluginsContext(
        "ws1234567890",
        projectPath
      );
      if (testCase.expectedNull) {
        expect(resolved).toBeNull();
      } else {
        expect(resolved).toMatchObject({ projectKey: projectPath });
      }
    }
  });

  test("writes global config to <rootDir>/mcp.jsonc", async () => {
    const result = await configService.addServer("test", {
      transport: "stdio",
      command: "echo hi",
    });
    expect(result).toEqual({ success: true, data: undefined });

    const globalPath = path.join(config.rootDir, "mcp.jsonc");
    const raw = await fs.readFile(globalPath, "utf-8");

    // Basic smoke check: file exists and contains our server name.
    expect(raw).toContain('"test"');
  });

  test("listServers merges repo overrides on top of global (override wins by name)", async () => {
    await configService.addServer("shared", {
      transport: "stdio",
      command: "global-shared",
    });

    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      `// repo override\n{\n  "servers": {\n    "shared": "repo-shared",\n    "repo-only": { "command": "repo-only", "disabled": true }\n  }\n}\n`,
      "utf-8"
    );

    const merged = await configService.listServers(projectPath, true);

    expect(merged).toEqual({
      shared: { transport: "stdio", command: "repo-shared", disabled: false },
      "global-only": { transport: "stdio", command: "global-only", disabled: false },
      "repo-only": { transport: "stdio", command: "repo-only", disabled: true },
    });
  });

  test("prefers canonical repo overrides when both project paths exist", async () => {
    const projectPath = path.join(tempDir, "repo-canonical");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      JSON.stringify({ servers: { selected: "legacy", "legacy-only": "legacy-only" } }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { selected: "canonical" } }),
      "utf-8"
    );

    expect(await configService.listServers(projectPath, true)).toEqual({
      selected: { transport: "stdio", command: "canonical", disabled: false },
    });
  });

  test("listServers ignores repo overrides for untrusted projects", async () => {
    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo-untrusted");
    await fs.mkdir(path.join(projectPath, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".mux", "mcp.jsonc"),
      JSON.stringify(
        {
          servers: {
            "repo-only": "repo-only",
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    expect(await configService.listServers(projectPath, false)).toEqual({
      "global-only": { transport: "stdio", command: "global-only", disabled: false },
    });
  });

  test("project-automation kill-switch ignores repo overrides even when trusted", async () => {
    await configService.addServer("global-only", {
      transport: "stdio",
      command: "global-only",
    });

    const projectPath = path.join(tempDir, "repo-automation-disabled");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { "repo-only": "repo-only" } }),
      "utf-8"
    );

    const prev = process.env[DISABLE_PROJECT_AUTOMATION_ENV];
    process.env[DISABLE_PROJECT_AUTOMATION_ENV] = "1";
    try {
      // Trust stays (delegation depends on it) but repo-configured MCP
      // servers must not load: they would run dataset code with provider
      // credentials in the environment.
      expect(await configService.listServers(projectPath, true)).toEqual({
        "global-only": { transport: "stdio", command: "global-only", disabled: false },
      });
    } finally {
      if (prev === undefined) {
        delete process.env[DISABLE_PROJECT_AUTOMATION_ENV];
      } else {
        process.env[DISABLE_PROJECT_AUTOMATION_ENV] = prev;
      }
    }
  });
  test("API mutations enforce policy and emit telemetry", async () => {
    const capture = mock(() => undefined);
    const apiService = new MCPConfigService(config, {
      policyService: {
        isEnforced: () => true,
        isMcpTransportAllowed: (transport: string) => transport === "stdio",
      },
      telemetryService: { capture },
    });
    expect(
      await apiService.addForApi({ name: "remote", transport: "http", url: "https://x" })
    ).toEqual({ success: false, error: "MCP transport is disabled by policy" });
    await apiService.addForApi({ name: "local", command: "node server.js" });
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mcp_server_config_changed" })
    );
  });
});

describe("MCP server disable filtering", () => {
  let tempDir: string;
  let config: Config;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("disabled servers are filtered from manager.listServers", async () => {
    // Add two servers
    await configService.addServer("enabled-server", {
      transport: "stdio",
      command: "cmd1",
    });
    await configService.addServer("disabled-server", {
      transport: "stdio",
      command: "cmd2",
    });

    // Disable one
    await configService.setServerEnabled("disabled-server", false);

    // Config service returns both (with disabled flag)
    const allServers = await configService.listServers(tempDir);
    expect(allServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
      "disabled-server": { transport: "stdio", command: "cmd2", disabled: true },
    });

    // Server manager filters to enabled only
    const enabledServers = await serverManager.listServers(tempDir);
    expect(enabledServers).toEqual({
      "enabled-server": { transport: "stdio", command: "cmd1", disabled: false },
    });
  });

  // --- Agent Plugins provider (agent-plugins experiment) ---

  const PLUGIN_SERVER = {
    transport: "stdio" as const,
    command: "bunx",
    args: ["-y", "some-server"],
    disabled: true,
    plugin: {
      pluginName: "demo",
      serverName: "srv",
      sourceScope: "global" as const,
      sourceLocation: ".mux/plugins/demo",
    },
  };

  test("listServers merges Agent Plugins servers at the lowest precedence", async () => {
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () =>
        Promise.resolve({
          "plugin:abc:srv": PLUGIN_SERVER,
          // A hostile plugin key colliding with a user server must lose.
          collides: { ...PLUGIN_SERVER, command: "plugin-command" },
        }),
    });
    await withProvider.addServer("collides", { transport: "stdio", command: "user-command" });

    const servers = await withProvider.listServers();

    expect(servers["plugin:abc:srv"]).toEqual(PLUGIN_SERVER);
    expect(servers.collides).toEqual({
      transport: "stdio",
      command: "user-command",
      disabled: false,
      toolAllowlist: undefined,
    });
  });

  test("canonical plugin keys are reserved in user config layers and definition mutations", async () => {
    // A user server occupying a canonical `plugin:<16-hex>:<name>` key would
    // shadow the plugin server (user layers win on collision) yet lose its
    // workspace overrides to that plugin's uninstall, which prunes such keys
    // by shape. Hand-edited config entries are ignored (not started, not
    // shadowing); the add flow rejects the name outright.
    const reservedKey = "plugin:0123456789abcdef:srv";
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.resolve({ [reservedKey]: PLUGIN_SERVER }),
    });

    const added = await withProvider.addServer(reservedKey, { transport: "stdio", command: "x" });
    expect(added.success).toBe(false);
    if (!added.success) {
      expect(added.error).toContain("reserved");
    }

    // Hand-edited global + project entries on the reserved key.
    await fs.writeFile(
      path.join(config.rootDir, "mcp.jsonc"),
      JSON.stringify({ servers: { [reservedKey]: "user-global", ordinary: "user-ordinary" } }),
      "utf-8"
    );
    const projectPath = path.join(tempDir, "repo-reserved");
    await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, ".xum", "mcp.jsonc"),
      JSON.stringify({ servers: { [reservedKey]: "user-project" } }),
      "utf-8"
    );

    const globalPath = path.join(config.rootDir, "mcp.jsonc");
    const original = await fs.readFile(globalPath, "utf-8");
    expect((await withProvider.setToolAllowlist(reservedKey, [])).success).toBe(false);
    expect(await fs.readFile(globalPath, "utf-8")).toBe(original);
    expect((await withProvider.removeServer(reservedKey)).success).toBe(false);
    expect(await fs.readFile(globalPath, "utf-8")).toBe(original);

    const servers = await withProvider.listServers(projectPath, true);
    // The plugin server keeps its reserved key; the user entries neither
    // shadow it nor appear under their own name. Ordinary names still load.
    expect(servers[reservedKey]).toEqual(PLUGIN_SERVER);
    expect(servers.ordinary).toMatchObject({ command: "user-ordinary" });
  });

  test("listServers resolves the Agent Plugins context: default, explicit, and null", async () => {
    const seenArgs: Array<{ projectRoot?: string; projectKey?: string; trusted: boolean }> = [];
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: (args) => {
        seenArgs.push(args);
        return Promise.resolve({});
      },
    });

    // Default: scan under projectPath, keyed by projectPath (project-level flows).
    await withProvider.listServers();
    await withProvider.listServers("/proj", false);
    await withProvider.listServers("/proj", true);
    // Explicit context: workspace flows scan the active worktree, keyed by the project.
    await withProvider.listServers("/proj", true, {
      agentPlugins: { projectRoot: "/worktrees/ws-1", projectKey: "/proj" },
    });
    // Null: off-host workspace — provider must not be consulted at all.
    await withProvider.listServers("/proj", true, { agentPlugins: null });

    expect(seenArgs).toEqual([
      { projectRoot: undefined, projectKey: undefined, trusted: false },
      { projectRoot: "/proj", projectKey: "/proj", trusted: false },
      { projectRoot: "/proj", projectKey: "/proj", trusted: true },
      { projectRoot: "/worktrees/ws-1", projectKey: "/proj", trusted: true },
    ]);
  });

  test("a throwing Agent Plugins provider never breaks listServers", async () => {
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.reject(new Error("boom")),
    });
    await withProvider.addServer("still-there", { transport: "stdio", command: "cmd" });

    const servers = await withProvider.listServers();

    expect(Object.keys(servers)).toEqual(["still-there"]);
  });

  test("plugin enablement is persisted without editable server definitions", async () => {
    const key = "plugin:0123456789abcdef:srv";
    const withProvider = new MCPConfigService(config, {
      agentPluginsMcpProvider: () => Promise.resolve({ [key]: PLUGIN_SERVER }),
    });

    expect(await withProvider.setServerEnabled(key, true)).toEqual({
      success: true,
      data: undefined,
    });
    expect((await withProvider.removeServer(key)).success).toBe(false);
    expect((await withProvider.setToolAllowlist(key, [])).success).toBe(false);

    const saved = jsonc.parse(
      await fs.readFile(path.join(config.rootDir, "mcp.jsonc"), "utf-8")
    ) as Record<string, unknown>;
    expect(saved).toEqual({ enabledPluginServers: [key] });
  });

  describe("global plugin enablement", () => {
    const prefix = "plugin:0123456789abcdef:";
    const key = `${prefix}srv`;
    const siblingKey = `${prefix}second`;
    const otherKey = "plugin:fedcba9876543210:other";
    let configPath: string;
    let service: MCPConfigService;

    function createService(
      provider: AgentPluginsMcpProvider = () => Promise.resolve({ [key]: PLUGIN_SERVER })
    ) {
      return new MCPConfigService(config, { agentPluginsMcpProvider: provider });
    }

    async function readDocument(): Promise<Record<string, unknown>> {
      return jsonc.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    }

    beforeEach(() => {
      configPath = path.join(config.rootDir, "mcp.jsonc");
      service = createService();
    });

    // Track the actual filesystem boundary, not promise-pending observations. The
    // async context distinguishes a sibling's first read even if it runs before
    // lock acquisition; spying fs.promises matches the service's fs import.
    function observeTransactions(
      hooks: {
        afterRead?: (label: string, bytes: string) => Promise<void>;
        lockAttempt?: (label: string) => void;
      } = {}
    ) {
      const context = new AsyncLocalStorage<string>();
      const events: string[] = [];
      const readFile = fs.readFile;
      const readSpy = spyOn(fs, "readFile").mockImplementation(
        new Proxy(readFile, {
          async apply(target, _thisArg, args: Parameters<typeof readFile>) {
            const label = context.getStore();
            const tracked = args[0] === configPath && label !== undefined;
            if (tracked) events.push(`${label}:read`);
            const bytes = await target(...args);
            if (tracked) await hooks.afterRead?.(label, bytes.toString());
            return bytes;
          },
        })
      );
      const writeFile = atomicWrite.default;
      const writeSpy = spyOn(atomicWrite, "default").mockImplementation(
        new Proxy(writeFile, {
          async apply(target, _thisArg, args: Parameters<typeof writeFile>) {
            const result = await target(...args);
            const label = context.getStore();
            if (args[0] === configPath && label !== undefined) events.push(`${label}:write`);
            return result;
          },
        })
      );
      const acquire = crossProcessLock.acquireCrossProcessLock;
      const lockSpy = spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation(
        async (options) => {
          const label = context.getStore();
          const tracked =
            options.lockPath === path.join(config.rootDir, "mcp-config.lock") &&
            label !== undefined;
          if (tracked) {
            events.push(`${label}:attempt`);
            hooks.lockAttempt?.(label);
          }
          const release = await acquire(options);
          if (tracked) events.push(`${label}:acquired`);
          return async () => {
            await release();
            if (tracked) events.push(`${label}:released`);
          };
        }
      );
      return {
        events,
        run<T>(label: string, action: () => T): T {
          return context.run(label, action);
        },
        restore() {
          readSpy.mockRestore();
          writeSpy.mockRestore();
          lockSpy.mockRestore();
          context.disable();
        },
      };
    }

    async function reachBarrier(barrier: Promise<void>, operation: Promise<unknown>) {
      // A broken implementation that exits before the boundary must fail
      // promptly rather than strand cleanup behind an unreachable barrier.
      await Promise.race([
        barrier,
        operation.then(() => {
          throw new Error("Mutation completed before reaching the transaction barrier");
        }),
      ]);
    }

    test.each([undefined, "{}", '{"unknown": {"keep": true}}'])(
      "enablement survives a new service without a servers property (%s)",
      async (initial) => {
        if (initial !== undefined) await fs.writeFile(configPath, initial);
        expect(await service.setServerEnabled(key, true)).toEqual({
          success: true,
          data: undefined,
        });
        expect(await readDocument()).toEqual({
          ...(initial === undefined ? {} : (jsonc.parse(initial) as Record<string, unknown>)),
          enabledPluginServers: [key],
        });
        expect((await createService().listServers())[key]).toEqual({
          ...PLUGIN_SERVER,
          disabled: false,
        });
      }
    );

    test("disable removes only its key and removes the property when empty", async () => {
      await fs.writeFile(configPath, JSON.stringify({ enabledPluginServers: [key, otherKey] }));
      expect((await service.setServerEnabled(key, false)).success).toBe(true);
      expect(await readDocument()).toEqual({ enabledPluginServers: [otherKey] });
      expect((await createService().listServers())[key].disabled).toBe(true);

      const otherService = createService(() => Promise.resolve({ [otherKey]: PLUGIN_SERVER }));
      expect((await otherService.setServerEnabled(otherKey, false)).success).toBe(true);
      expect(await readDocument()).toEqual({});
    });

    test("ordinary add preserves a plugin enabled through the public API", async () => {
      expect((await service.setServerEnabled(key, true)).success).toBe(true);
      expect((await service.addServer("ordinary", { command: "echo ordinary" })).success).toBe(
        true
      );
      expect(await readDocument()).toEqual({
        servers: { ordinary: "echo ordinary" },
        enabledPluginServers: [key],
      });
      expect((await createService().listServers())[key].disabled).toBe(false);
    });

    test.each(["add", "remove", "allowlist", "toggle"] as const)(
      "ordinary %s preserves canonical enablement entries including duplicates",
      async (operation) => {
        await fs.writeFile(
          configPath,
          JSON.stringify({
            servers: { ordinary: "echo ordinary", remove: "echo remove" },
            enabledPluginServers: [
              key,
              42,
              null,
              {},
              "",
              "ordinary",
              "plugin:custom",
              key,
              otherKey,
            ],
          })
        );
        const result =
          operation === "add"
            ? await service.addServer("added", { command: "echo added" })
            : operation === "remove"
              ? await service.removeServer("remove")
              : operation === "allowlist"
                ? await service.setToolAllowlist("ordinary", ["tool"])
                : await service.setServerEnabled("ordinary", false);
        expect(result.success).toBe(true);
        expect((await readDocument()).enabledPluginServers).toEqual([key, key, otherKey]);
        expect((await createService().listServers())[key].disabled).toBe(false);
      }
    );

    test("only canonical discovered global plugin keys receive defaults, without mutating provider data", async () => {
      const projectKey = `${prefix}project`;
      const missingKey = `${prefix}missing`;
      const noProvenanceKey = `${prefix}no-provenance`;
      const pluginServers = {
        [key]: PLUGIN_SERVER,
        [projectKey]: {
          ...PLUGIN_SERVER,
          plugin: { ...PLUGIN_SERVER.plugin, sourceScope: "project" as const },
        },
        "plugin:custom": PLUGIN_SERVER,
        [noProvenanceKey]: { transport: "stdio" as const, command: "echo user", disabled: true },
      };
      const before = structuredClone(pluginServers);
      await fs.writeFile(
        configPath,
        JSON.stringify({
          servers: { ordinary: { command: "echo ordinary", disabled: true } },
          enabledPluginServers: [
            key,
            projectKey,
            missingKey,
            noProvenanceKey,
            "plugin:custom",
            "ordinary",
            1,
            null,
            {},
          ],
        })
      );
      const withProvider = createService(() => Promise.resolve(pluginServers));
      const listed = await withProvider.listServers();
      expect(listed[key].disabled).toBe(false);
      for (const name of [projectKey, noProvenanceKey, "plugin:custom", "ordinary"]) {
        expect(listed[name].disabled).toBe(true);
      }
      expect(listed[missingKey]).toBeUndefined();
      expect(pluginServers).toEqual(before);
      expect((await withProvider.listServerLayers()).plugin[key].disabled).toBe(false);
      expect(pluginServers).toEqual(before);
    });

    test.each(["plugin:custom", `${prefix}missing`, `${prefix}project`])(
      "toggle rejects a non-global or undiscovered plugin (%s) without a write",
      async (name) => {
        const raw = '{"servers": {}, "unknown": "keep"}\n';
        await fs.writeFile(configPath, raw);
        const withProvider = createService(() =>
          Promise.resolve({
            [key]: PLUGIN_SERVER,
            "plugin:custom": PLUGIN_SERVER,
            [`${prefix}project`]: {
              ...PLUGIN_SERVER,
              plugin: { ...PLUGIN_SERVER.plugin, sourceScope: "project" },
            },
          })
        );
        for (const enabled of [true, false]) {
          expect((await withProvider.setServerEnabled(name, enabled)).success).toBe(false);
          expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
        }
      }
    );

    test("project enablement lists are ignored and workspace overrides still win", async () => {
      const projectPath = path.join(tempDir, "project");
      await fs.mkdir(path.join(projectPath, ".xum"), { recursive: true });
      await fs.writeFile(
        path.join(projectPath, ".xum", "mcp.jsonc"),
        JSON.stringify({ enabledPluginServers: [key] })
      );
      expect((await service.listServers(projectPath, true))[key].disabled).toBe(true);

      const manager = new MCPServerManager(service);
      try {
        expect(await manager.listServers(projectPath)).toEqual({});
        expect(await manager.listServers(projectPath, { enabledServers: [key] })).toMatchObject({
          [key]: { disabled: false },
        });
        expect((await service.setServerEnabled(key, true)).success).toBe(true);
        expect(await manager.listServers(projectPath)).toMatchObject({
          [key]: { disabled: false },
        });
        expect(await manager.listServers(projectPath, { disabledServers: [key] })).toEqual({});
      } finally {
        manager.dispose();
      }
    });

    test.each([
      ["empty", ""],
      ["whitespace-only", " \n\t\r\n"],
      ["line-comment-only", "// Local MCP preferences\n"],
      ["block-comment-only", "/* Keep this local note. */\n"],
    ])("%s MCP documents allow toggles and consent pruning", async (_name, raw) => {
      await fs.writeFile(configPath, raw);
      expect((await service.listServers())[key]?.disabled).toBe(true);
      await service.pruneEnabledPluginServers(prefix);
      expect((await service.setServerEnabled(key, false)).success).toBe(true);
      expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
      expect((await service.setServerEnabled(key, true)).success).toBe(true);
      expect((await service.listServers())[key]?.disabled).toBe(false);
      expect(await readDocument()).toEqual({ enabledPluginServers: [key] });
      if (raw.trim()) expect(await fs.readFile(configPath, "utf-8")).toContain(raw.trim());
      await service.pruneEnabledPluginServers(prefix);
      expect((await service.listServers())[key]?.disabled).toBe(true);
      expect(await readDocument()).toEqual({});
      if (raw.trim()) expect(await fs.readFile(configPath, "utf-8")).toContain(raw.trim());
    });

    test("toggle and prune preserve comments, unknown fields, and raw server definitions", async () => {
      const untouched = `  // Server definitions belong to their owner.\n  "servers": {"ordinary": {"command":"echo original", "future":42}},\n  "unknown": {"enabledPluginServers": ["nested"], "keep": true}`;
      await fs.writeFile(configPath, `// user's config\n{\n${untouched}\n}\n`);
      for (const enabled of [true, false, true]) {
        expect((await service.setServerEnabled(key, enabled)).success).toBe(true);
        const raw = await fs.readFile(configPath, "utf-8");
        expect(raw).toStartWith("// user's config\n");
        expect(raw).toContain(untouched);
        expect((await readDocument()).servers).toEqual({
          ordinary: { command: "echo original", future: 42 },
        });
      }
      await service.pruneEnabledPluginServers(prefix);
      const raw = await fs.readFile(configPath, "utf-8");
      expect(raw).toStartWith("// user's config\n");
      expect(raw).toContain(untouched);
      expect(await readDocument()).not.toHaveProperty("enabledPluginServers");
    });

    const invalidDocuments = [
      ["unterminated comment", "/* not a complete comment"],
      ["invalid content after comments", "// valid comment\nnot-json"],
      ["invalid syntax", `{"enabledPluginServers":["${key}"], "broken": }`],
      ["duplicate property", `{"enabledPluginServers":[], "enabledPluginServers":["${key}"]}`],
      [
        "escaped duplicate property",
        `{"enabledPluginServers":[], "enabledPlugin\\u0053ervers":["${key}"]}`,
      ],
      ["array root", `[{"enabledPluginServers":["${key}"]}]`],
      ["null root", "null"],
      ["scalar root", "42"],
      ["string list", `{"enabledPluginServers":"${key}"}`],
      ["object list", `{"enabledPluginServers":{"${key}":true}}`],
      ["null list", '{"enabledPluginServers":null}'],
    ];

    test.each(invalidDocuments)(
      "%s fails closed for listing, toggle, and prune without changing bytes",
      async (_description, raw) => {
        await fs.writeFile(configPath, raw);
        expect((await service.listServers())[key].disabled).toBe(true);
        for (const enabled of [true, false]) {
          expect((await service.setServerEnabled(key, enabled)).success).toBe(false);
          expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
        }
        await rejects(service.pruneEnabledPluginServers(prefix));
        expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
      }
    );

    test("malformed enablement metadata does not hide ordinary servers from listings", async () => {
      for (const fields of [
        `"enabledPluginServers":["${key}"], "broken":`,
        `"enabledPluginServers":[], "enabledPluginServers":["${key}"]`,
        `"enabledPluginServers":"${key}"`,
      ]) {
        await fs.writeFile(configPath, `{"servers":{"ordinary":"echo ordinary"},${fields}}`);
        const listed = await service.listServers();
        expect(listed.ordinary).toEqual({
          transport: "stdio",
          command: "echo ordinary",
          disabled: false,
        });
        expect(listed[key].disabled).toBe(true);
      }
    });

    test("prune removes only the requested prefix and never creates a missing config", async () => {
      await service.pruneEnabledPluginServers(prefix);
      expect(await fs.exists(configPath)).toBe(false);
      await fs.writeFile(
        configPath,
        JSON.stringify({ enabledPluginServers: [key, siblingKey, otherKey] })
      );
      await service.pruneEnabledPluginServers(prefix);
      expect(await readDocument()).toEqual({ enabledPluginServers: [otherKey] });
    });

    test.each(["toggle", "prune"] as const)(
      "atomic-write failure keeps bytes unchanged (%s)",
      async (operation) => {
        const raw = JSON.stringify({ enabledPluginServers: [key], unknown: "keep" });
        await fs.writeFile(configPath, raw);
        const original = atomicWrite.default;
        const writeSpy = spyOn(atomicWrite, "default").mockImplementation(
          new Proxy(original, {
            apply(target, _thisArg, args: Parameters<typeof original>) {
              if (args[0] === configPath)
                return Promise.reject(new Error("injected atomic-write failure"));
              return target(...args);
            },
          })
        );
        try {
          if (operation === "toggle") {
            const result = await service.setServerEnabled(key, false);
            expect(result.success).toBe(false);
            if (!result.success) expect(result.error).toContain("injected atomic-write failure");
          } else {
            await rejects(
              service.pruneEnabledPluginServers(prefix),
              /injected atomic-write failure/
            );
          }
          expect(writeSpy).toHaveBeenCalled();
          expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
          expect((await service.listServers())[key].disabled).toBe(false);
        } finally {
          writeSpy.mockRestore();
        }
      }
    );

    test("held real lock makes every public mutation return Err rather than throw", async () => {
      const raw = JSON.stringify({
        servers: { ordinary: "echo ordinary" },
        enabledPluginServers: [key],
      });
      await fs.writeFile(configPath, raw);
      const lockPath = path.join(config.rootDir, "mcp-config.lock");
      const acquire = crossProcessLock.acquireCrossProcessLock;
      const release = await acquire({
        lockPath,
        acquireTimeoutMs: 1000,
        staleMs: 60_000,
        timeoutMessage: "holder failed",
      });
      const acquireSpy = spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation(
        (options) => acquire({ ...options, acquireTimeoutMs: 1 })
      );
      try {
        const mutations = [
          () => service.addServer("added", { command: "echo added" }),
          () => service.removeServer("ordinary"),
          () => service.setServerEnabled("ordinary", false),
          () => service.setServerEnabled(key, false),
          () => service.setToolAllowlist("ordinary", []),
        ];
        for (const mutate of mutations) {
          const result = await mutate();
          expect(result.success).toBe(false);
          if (!result.success) expect(result.error).not.toBe("");
          expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
        }
        expect(acquireSpy).toHaveBeenCalledTimes(mutations.length);
        for (const [options] of acquireSpy.mock.calls) {
          expect(options).toMatchObject({ lockPath, acquireTimeoutMs: 60_000 });
        }
      } finally {
        acquireSpy.mockRestore();
        await release();
      }
    });

    test("same-instance toggle, add, and remove are noninterleaving transactions", async () => {
      await fs.writeFile(configPath, JSON.stringify({ servers: { y: "echo y" } }));
      const captured = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let held = false;
      const observation = observeTransactions({
        afterRead: async (label) => {
          if (label === "toggle" && !held) {
            held = true;
            captured.resolve();
            await resume.promise;
          }
        },
      });
      const pending = [
        observation.run("toggle", () => service.setServerEnabled(key, true)),
        observation.run("add", () => service.addServer("x", { command: "echo x" })),
        observation.run("remove", () => service.removeServer("y")),
      ];
      try {
        await reachBarrier(captured.promise, pending[0]);
        resume.resolve();
        expect(await Promise.all(pending)).toEqual([
          { success: true, data: undefined },
          { success: true, data: undefined },
          { success: true, data: undefined },
        ]);
        const owners = observation.events.map((event) => event.split(":")[0]);
        expect(owners.filter((owner, index) => owner !== owners[index - 1])).toEqual([
          "toggle",
          "add",
          "remove",
        ]);
        for (const owner of ["toggle", "add", "remove"]) {
          for (const phase of ["attempt", "acquired", "read", "write", "released"]) {
            expect(observation.events).toContain(`${owner}:${phase}`);
          }
          expect(observation.events.indexOf(`${owner}:acquired`)).toBeLessThan(
            observation.events.indexOf(`${owner}:read`)
          );
          expect(observation.events.indexOf(`${owner}:write`)).toBeLessThan(
            observation.events.indexOf(`${owner}:released`)
          );
        }
        expect(await readDocument()).toEqual({
          servers: { x: "echo x" },
          enabledPluginServers: [key],
        });
      } finally {
        resume.resolve();
        await Promise.allSettled(pending);
        observation.restore();
      }
    });

    test("another instance prunes only after the in-lock plugin discovery and toggle write", async () => {
      await fs.writeFile(configPath, JSON.stringify({ enabledPluginServers: [otherKey] }));
      const discovered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pruneAttempted = Promise.withResolvers<void>();
      const observation = observeTransactions({
        lockAttempt: (label) => {
          if (label === "B") pruneAttempted.resolve();
        },
      });
      let held = false;
      const a = createService(async () => {
        const discoveredServers = { [key]: PLUGIN_SERVER };
        if (!held) {
          held = true;
          observation.events.push("A:provider");
          discovered.resolve();
          await resume.promise;
        }
        return discoveredServers;
      });
      const b = createService();
      const toggle = observation.run("A", () => a.setServerEnabled(key, true));
      const pending: Array<Promise<unknown>> = [toggle];
      try {
        await reachBarrier(discovered.promise, toggle);
        const prune = observation.run("B", async () => {
          await b.pruneEnabledPluginServers(prefix);
        });
        pending.push(prune);
        await reachBarrier(pruneAttempted.promise, prune);
        resume.resolve();
        expect(await toggle).toEqual({ success: true, data: undefined });
        await prune;
        for (const event of [
          "A:acquired",
          "A:provider",
          "A:write",
          "B:attempt",
          "B:read",
          "B:write",
        ]) {
          expect(observation.events).toContain(event);
        }
        expect(observation.events.indexOf("A:acquired")).toBeLessThan(
          observation.events.indexOf("A:provider")
        );
        expect(observation.events.indexOf("B:attempt")).toBeLessThan(
          observation.events.indexOf("A:write")
        );
        expect(observation.events.indexOf("A:write")).toBeLessThan(
          observation.events.indexOf("B:read")
        );
        expect(await readDocument()).toEqual({ enabledPluginServers: [otherKey] });
      } finally {
        resume.resolve();
        await Promise.allSettled(pending);
        observation.restore();
      }
    });

    test("a captured ordinary read cannot resurrect a prefix pruned by another instance", async () => {
      await fs.writeFile(
        configPath,
        JSON.stringify({ servers: {}, enabledPluginServers: [key, otherKey] })
      );
      const captured = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const pruneAttempted = Promise.withResolvers<void>();
      let snapshot: string | undefined;
      const observation = observeTransactions({
        afterRead: async (label, bytes) => {
          if (label === "A" && snapshot === undefined) {
            // The barrier is AFTER the real read, so A holds genuinely stale
            // bytes if a missing transaction lock lets B prune first.
            snapshot = bytes;
            captured.resolve();
            await resume.promise;
          }
        },
        lockAttempt: (label) => {
          if (label === "B") pruneAttempted.resolve();
        },
      });
      const a = createService();
      const b = createService();
      const add = observation.run("A", () => a.addServer("x", { command: "echo x" }));
      const pending: Array<Promise<unknown>> = [add];
      try {
        await reachBarrier(captured.promise, add);
        expect(snapshot).toBeDefined();
        expect((jsonc.parse(snapshot!) as Record<string, unknown>).enabledPluginServers).toEqual([
          key,
          otherKey,
        ]);
        const prune = observation.run("B", async () => {
          await b.pruneEnabledPluginServers(prefix);
        });
        pending.push(prune);
        await reachBarrier(pruneAttempted.promise, prune);
        resume.resolve();
        expect(await add).toEqual({ success: true, data: undefined });
        await prune;
        for (const event of ["A:acquired", "A:read", "A:write", "B:attempt", "B:read", "B:write"]) {
          expect(observation.events).toContain(event);
        }
        expect(observation.events.indexOf("A:acquired")).toBeLessThan(
          observation.events.indexOf("A:read")
        );
        expect(observation.events.indexOf("B:attempt")).toBeLessThan(
          observation.events.indexOf("A:write")
        );
        expect(observation.events.indexOf("A:write")).toBeLessThan(
          observation.events.indexOf("B:read")
        );
        expect(await readDocument()).toEqual({
          servers: { x: "echo x" },
          enabledPluginServers: [otherKey],
        });
      } finally {
        resume.resolve();
        await Promise.allSettled(pending);
        observation.restore();
      }
    });

    test("a plugin removed after listing cannot be enabled from that stale discovery", async () => {
      const raw = '{"unknown": "keep"}\n';
      await fs.writeFile(configPath, raw);
      let discovered: Record<string, MCPServerInfo> = { [key]: PLUGIN_SERVER };
      const withProvider = createService(() => Promise.resolve(discovered));
      expect((await withProvider.listServers())[key]).toEqual(PLUGIN_SERVER);
      discovered = {};
      expect((await withProvider.setServerEnabled(key, true)).success).toBe(false);
      expect(await fs.readFile(configPath, "utf-8")).toBe(raw);
    });
  });
});

describe("Workspace MCP overrides filtering", () => {
  let tempDir: string;
  let configService: MCPConfigService;
  let serverManager: MCPServerManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
    const config = new Config(tempDir);

    configService = new MCPConfigService(config);
    serverManager = new MCPServerManager(configService);

    // Set up multiple servers for testing
    await configService.addServer("server-a", { transport: "stdio", command: "cmd-a" });
    await configService.addServer("server-b", { transport: "stdio", command: "cmd-b" });
    await configService.addServer("server-c", { transport: "stdio", command: "cmd-c" });
  });

  afterEach(async () => {
    serverManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("listServers with no overrides returns all enabled servers", async () => {
    const servers = await serverManager.listServers(tempDir);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with empty overrides returns all enabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {};
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("listServers with disabledServers filters out disabled servers", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-a", "server-c"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
    });
  });

  test("listServers with disabledServers removes servers not in config (no error)", async () => {
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["non-existent-server"],
    };
    const servers = await serverManager.listServers(tempDir, overrides);
    expect(servers).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("enabledServers overrides project-level disabled", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Without override, server-a should be disabled
    const serversWithoutOverride = await serverManager.listServers(tempDir);
    expect(serversWithoutOverride).toEqual({
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });

    // With enabledServers override, server-a should be re-enabled
    const overrides: WorkspaceMCPOverrides = {
      enabledServers: ["server-a"],
    };
    const serversWithOverride = await serverManager.listServers(tempDir, overrides);
    expect(serversWithOverride).toEqual({
      "server-a": { transport: "stdio", command: "cmd-a", disabled: false },
      "server-b": { transport: "stdio", command: "cmd-b", disabled: false },
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });

  test("project-disabled and workspace-disabled work together", async () => {
    // Disable server-a at project level
    await configService.setServerEnabled("server-a", false);

    // Disable server-b at workspace level
    const overrides: WorkspaceMCPOverrides = {
      disabledServers: ["server-b"],
    };

    const servers = await serverManager.listServers(tempDir, overrides);
    // Only server-c should remain
    expect(servers).toEqual({
      "server-c": { transport: "stdio", command: "cmd-c", disabled: false },
    });
  });
});
