import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, spyOn, test } from "bun:test";

import type { MCPStdioServerInfo } from "@/common/types/mcp";
import assert from "@/common/utils/assert";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DisposableTempDir } from "@/node/services/tempDir";
import { Config } from "@/node/config";
import { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { log } from "@/node/services/log";
import { readPluginMcpPolicy } from "./registry";
import type { ComponentConsent } from "./componentConsent";
import { createTestPluginInstallEntry, reviewedComponentConsent } from "./testFixtures";
import type { AgentPluginInfo } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";
import {
  AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
  buildPluginServerKey,
  computePluginInstanceId,
  createAgentPluginsMcpProvider,
  getPluginDataPath,
  loadPluginMcpServers,
  resolveAgentPluginsMcpContext,
} from "./mcpConfig";

/** Create a plugin dir on disk and return its AgentPluginInfo. */
async function makePlugin(
  baseDir: string,
  name: string,
  mcpJson: unknown,
  options?: { scope?: "project" | "global"; fileName?: string }
): Promise<AgentPluginInfo> {
  const pluginDir = path.join(baseDir, name);
  await fs.mkdir(pluginDir, { recursive: true });
  const rootPath = await fs.realpath(pluginDir);
  const mcpConfigPath = path.join(rootPath, options?.fileName ?? "mcp.json");
  await fs.writeFile(
    mcpConfigPath,
    typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson),
    "utf8"
  );
  return {
    name,
    scope: options?.scope ?? "global",
    rootPath,
    containerPath: baseDir,
    dirName: name,
    manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name },
    notApplied: [],
    mcpConfigPath,
    ...(options?.fileName === ".mcp.json" ? { mcpConfigDialect: "codex" as const } : {}),
  };
}

function mcpDoc(servers: Record<string, unknown>): unknown {
  return { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0, mcpServers: servers };
}

const STDIO_ENTRY = { type: "stdio", command: "bunx", args: ["-y", "some-server"] };

describe("loadPluginMcpServers", () => {
  test("normalizes a stdio entry: default-disabled, expanded args/env, reserved env last, default cwd", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "demo",
      mcpDoc({
        everything: {
          type: "stdio",
          command: "bunx",
          args: ["--data", "${PLUGIN_DATA}/d", "${PLUGIN_ROOT}"],
          env: { CONFIG: "${PLUGIN_ROOT}/config.json", PLAIN: "x" },
        },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const instanceId = computePluginInstanceId(plugin.rootPath);
    const dataPath = getPluginDataPath(tmp.path, instanceId);
    const key = buildPluginServerKey(instanceId, "everything");
    expect(Object.keys(servers)).toEqual([key]);

    const info = servers[key] as MCPStdioServerInfo;
    expect(info.transport).toBe("stdio");
    expect(info.disabled).toBe(true);
    expect(info.command).toBe("bunx");
    expect(info.args).toEqual(["--data", `${dataPath}/d`, plugin.rootPath]);
    expect(info.env).toEqual({
      CONFIG: `${plugin.rootPath}/config.json`,
      PLAIN: "x",
      PLUGIN_ROOT: plugin.rootPath,
      PLUGIN_DATA: dataPath,
    });
    // Reserved variables are appended last so configured env cannot shadow them.
    expect(Object.keys(info.env ?? {}).slice(-2)).toEqual(["PLUGIN_ROOT", "PLUGIN_DATA"]);
    expect(info.cwd).toBe(plugin.rootPath);
    const { consentFingerprint, ...provenance } = info.plugin ?? {};
    expect(consentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance).toEqual({
      pluginName: "demo",
      serverName: "everything",
      sourceScope: "global",
      // Last two container segments + plugin dir (makePlugin's container is tmp.path).
      sourceLocation: path.join(
        path.basename(path.dirname(tmp.path)),
        path.basename(tmp.path),
        "demo"
      ),
    });
  });

  test("maps streamable-http to http and sse to sse; headerless remote entries load", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "remote",
      mcpDoc({
        deploy: { type: "streamable-http", url: "https://deploy.example.com/mcp" },
        legacy: { type: "sse", url: "https://legacy.example.com/sse", headers: {} },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const values = Object.values(servers);
    expect(values.map((s) => s.transport).sort()).toEqual(["http", "sse"]);
  });

  test("accepts entry extensions, maps usable OAuth settings and names the rest once", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "openai-auth",
      mcpDoc({
        local: { ...STDIO_ENTRY, extensions: { "com.example": { anything: true } } },
        discovery: {
          type: "streamable-http",
          url: "https://a.example.com/mcp",
          extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } } },
        },
        provided: {
          type: "streamable-http",
          url: "https://b.example.com/mcp",
          extensions: {
            "com.openai": {
              auth: {
                type: "oauth",
                client: { mode: "provided", clientId: "docs-client" },
                tokenUrl: "https://b.example.com/token",
                authorizationUrl: "http://b.example.com/authorize",
                baseScopes: ["docs:read"],
              },
            },
          },
        },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(Object.keys(servers)).toHaveLength(3);
    expect(diagnostics.every((d) => d.severity === "warning")).toBe(true);
    // The non-https endpoint is dropped; the valid unused settings are named once.
    const messages = diagnostics.map((d) => d.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(
      /'provided'.*authorizationUrl' must be an https \(or loopback http\) URL/
    );
    expect(messages[1]).toMatch(
      /'provided'.*ignores: tokenUrl \(discovery supplies the endpoints\)$/
    );
    const provided = Object.values(servers).find((s) => s.plugin?.serverName === "provided");
    expect(provided?.transport === "http" && provided.oauth).toEqual({
      clientId: "docs-client",
      baseScopes: ["docs:read"],
    });
  });

  test("maps the Codex .mcp.json dialect and never echoes the client secret", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const secret = "824c9cd33b8de28213447789c7517ad720138be5";
    // Shapes copied from openai/plugins (notion, github): no $schema, type "http".
    const plugin = await makePlugin(
      tmp.path,
      "codex",
      {
        mcpServers: {
          notion: {
            type: "http",
            url: "https://mcp.notion.com/mcp",
            oauth_resource: "https://mcp.notion.com",
          },
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            oauth: { client_id: "Iv23li", client_secret: secret, callback_port: 12799 },
          },
        },
      },
      { fileName: ".mcp.json" }
    );
    const warn = spyOn(log, "warn");
    try {
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      const infos = Object.values(servers);
      expect(infos.map((s) => (s.transport === "http" ? s.oauth : s))).toEqual([
        { resource: "https://mcp.notion.com" },
        {
          clientId: "Iv23li",
          // Only where to re-read it: the value stays in the consented file.
          clientSecretSource: {
            pluginRoot: plugin.rootPath,
            mcpConfigPath: plugin.mcpConfigPath!,
            serverName: "github",
          },
        },
      ]);
      expect(diagnostics.map((d) => d.message)).toEqual([
        // The real file name, not mcp.json.
        ".mcp.json server 'github': Xum's MCP OAuth ignores: oauth.callback_port",
      ]);
      const everything = JSON.stringify([servers, diagnostics, warn.mock.calls]);
      expect(everything).not.toContain(secret);
    } finally {
      warn.mockRestore();
    }
  });

  test("a server named __proto__ is skipped: its consent could not be stored (#6534)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    // JSON.parse makes `__proto__` an own key, as reading the file does.
    const config = JSON.parse(
      '{"__proto__": {"command": "node"}, "local": {"command": "node"}}'
    ) as Record<string, unknown>;
    const plugin = await makePlugin(tmp.path, "proto", config, { fileName: ".mcp.json" });
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(Object.values(servers).map((s) => s.plugin?.serverName)).toEqual(["local"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("server '__proto__'");
  });

  test("the Codex dialect infers stdio from a command and accepts a flat server map", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "flat",
      {
        local: { command: "node", args: ["server.js"] },
        // Codex's plugin parser infers streamable HTTP from a url without a type.
        remote: { url: "https://a.example.com/mcp" },
      },
      { fileName: ".mcp.json" }
    );
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(diagnostics).toEqual([]);
    expect(Object.values(servers).map((s) => [s.plugin?.serverName, s.transport])).toEqual([
      ["local", "stdio"],
      ["remote", "http"],
    ]);
  });

  test("the Claude dialect expands and exports ${CLAUDE_PLUGIN_*} and maps a root-anchored command", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin: AgentPluginInfo = {
      ...(await makePlugin(
        tmp.path,
        "claude",
        {
          local: {
            command: "${CLAUDE_PLUGIN_ROOT}/bin/tool",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "${CLAUDE_PLUGIN_DATA}/d", "${PLUGIN_ROOT}"],
            env: { CONFIG: "${CLAUDE_PLUGIN_ROOT}/config.json" },
            cwd: "${CLAUDE_PLUGIN_DATA}/work",
          },
        },
        { fileName: ".mcp.json" }
      )),
      mcpConfigDialect: "claude",
    };
    await fs.mkdir(path.join(plugin.rootPath, "bin"));
    await fs.writeFile(path.join(plugin.rootPath, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const dataPath = getPluginDataPath(tmp.path, computePluginInstanceId(plugin.rootPath));
    const info = Object.values(servers)[0] as MCPStdioServerInfo;
    expect(info.command).toBe(path.join(plugin.rootPath, "bin", "tool"));
    expect(info.args).toEqual([`${plugin.rootPath}/server.js`, `${dataPath}/d`, plugin.rootPath]);
    expect(info.cwd).toBe(path.join(dataPath, "work"));
    expect(info.env).toEqual({
      CONFIG: `${plugin.rootPath}/config.json`,
      PLUGIN_ROOT: plugin.rootPath,
      PLUGIN_DATA: dataPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
      CLAUDE_PLUGIN_DATA: dataPath,
    });
  });

  test("the Claude dialect refuses every other command form and its reserved env names", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    // An executable next to the plugin: a parent path must not reach it.
    await fs.writeFile(path.join(tmp.path, "outside"), "#!/bin/sh\n", { mode: 0o755 });
    const servers = {
      absolute: { command: "/usr/bin/env" },
      parent: { command: "../outside" },
      rootParent: { command: "${CLAUDE_PLUGIN_ROOT}/../outside" },
      quoted: { command: '"${CLAUDE_PLUGIN_ROOT}"/bin/tool' },
      bareRoot: { command: "${CLAUDE_PLUGIN_ROOT}/" },
      reservedEnv: { command: "node", env: { CLAUDE_PLUGIN_ROOT: "/elsewhere" } },
    };
    const claude: AgentPluginInfo = {
      ...(await makePlugin(tmp.path, "claude", servers, { fileName: ".mcp.json" })),
      mcpConfigDialect: "claude",
    };
    // The Codex dialect has no Claude names: the same command is refused there.
    const codex = await makePlugin(
      tmp.path,
      "codex",
      { local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool" } },
      { fileName: ".mcp.json" }
    );
    await fs.mkdir(path.join(codex.rootPath, "bin"));
    await fs.writeFile(path.join(codex.rootPath, "bin", "tool"), "#!/bin/sh\n", { mode: 0o755 });

    const claudeResult = await loadPluginMcpServers(claude, { xumHome: tmp.path });
    const codexResult = await loadPluginMcpServers(codex, { xumHome: tmp.path });

    expect(claudeResult.servers).toEqual({});
    expect(claudeResult.diagnostics.map((d) => d.message.split(":")[0])).toEqual(
      Object.keys(servers).map((name) => `.mcp.json server '${name}'`)
    );
    expect(codexResult.servers).toEqual({});
    expect(codexResult.diagnostics[0].message).toContain("executable token");
  });

  test("the Claude dialect skips a url entry without a type instead of inferring one", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const servers = {
      untyped: { url: "https://mcp.example.com/mcp" },
      typed: { type: "http", url: "https://mcp.example.com/mcp" },
    };
    const plugin: AgentPluginInfo = {
      ...(await makePlugin(tmp.path, "claude", servers, { fileName: ".mcp.json" })),
      mcpConfigDialect: "claude",
    };

    const { servers: loaded, diagnostics } = await loadPluginMcpServers(plugin, {
      xumHome: tmp.path,
    });

    // Claude Code skips the untyped entry as a configuration error; Xum does the same.
    expect(Object.values(loaded).map((s) => s.plugin?.serverName)).toEqual(["typed"]);
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        "warning",
        ".mcp.json server 'untyped': a 'url' entry needs a 'type' ('http' or 'sse') in a Claude .mcp.json; skipping this server",
      ],
    ]);
  });

  async function makeCursorPlugin(
    baseDir: string,
    name: string,
    servers: Record<string, unknown>
  ): Promise<AgentPluginInfo> {
    return {
      ...(await makePlugin(baseDir, name, { mcpServers: servers })),
      mcpConfigDialect: "cursor",
    };
  }

  const loadedNames = (servers: Record<string, { plugin?: { serverName: string } }>) =>
    Object.values(servers).map((s) => s.plugin?.serverName);

  test("the Cursor dialect expands both plugin roots and maps a root-anchored command", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makeCursorPlugin(tmp.path, "cursor", {
      cursorRoot: {
        command: "${CURSOR_PLUGIN_ROOT}/bin/server",
        args: ["${CURSOR_PLUGIN_ROOT}/server.mjs", "${CLAUDE_PLUGIN_ROOT}/lib"],
        env: { CONFIG: "${CURSOR_PLUGIN_ROOT}/config.json", LIB: "${CLAUDE_PLUGIN_ROOT}/lib" },
        cwd: "${CURSOR_PLUGIN_ROOT}/work",
      },
      claudeRoot: { command: "${CLAUDE_PLUGIN_ROOT}/bin/server", cwd: "${CLAUDE_PLUGIN_ROOT}" },
    });
    await fs.mkdir(path.join(plugin.rootPath, "bin"));
    await fs.mkdir(path.join(plugin.rootPath, "work"));
    await fs.writeFile(path.join(plugin.rootPath, "bin", "server"), "#!/bin/sh\n", {
      mode: 0o755,
    });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const dataPath = getPluginDataPath(tmp.path, computePluginInstanceId(plugin.rootPath));
    const [cursorRoot, claudeRoot] = Object.values(servers) as MCPStdioServerInfo[];
    expect(cursorRoot.command).toBe(path.join(plugin.rootPath, "bin", "server"));
    expect(cursorRoot.args).toEqual([`${plugin.rootPath}/server.mjs`, `${plugin.rootPath}/lib`]);
    expect(cursorRoot.cwd).toBe(path.join(plugin.rootPath, "work"));
    // Cursor documents only the two roots: no data folder alias is exported.
    expect(cursorRoot.env).toEqual({
      CONFIG: `${plugin.rootPath}/config.json`,
      LIB: `${plugin.rootPath}/lib`,
      PLUGIN_ROOT: plugin.rootPath,
      PLUGIN_DATA: dataPath,
      CURSOR_PLUGIN_ROOT: plugin.rootPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
    });
    expect(claudeRoot.command).toBe(path.join(plugin.rootPath, "bin", "server"));
    expect(claudeRoot.cwd).toBe(plugin.rootPath);
  });

  test("a Cursor cwd at a data folder name fails the cwd form check; Claude maps it", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const servers = {
      stateful: { command: "node", cwd: "${CLAUDE_PLUGIN_DATA}/state" },
      cursorData: { command: "node", cwd: "${CURSOR_PLUGIN_DATA}" },
    };
    const cursor = await makeCursorPlugin(tmp.path, "cursor", servers);
    const claude: AgentPluginInfo = {
      ...(await makePlugin(tmp.path, "claude", servers, { fileName: ".mcp.json" })),
      mcpConfigDialect: "claude",
    };

    const cursorResult = await loadPluginMcpServers(cursor, { xumHome: tmp.path });
    const claudeResult = await loadPluginMcpServers(claude, { xumHome: tmp.path });

    expect(cursorResult.servers).toEqual({});
    expect(cursorResult.diagnostics.map((d) => [d.severity, d.message])).toEqual(
      ["stateful", "cursorData"].map((name) => [
        "error",
        `mcp.json server '${name}': 'cwd' must be './…', '\${PLUGIN_ROOT}[/…]', or '\${PLUGIN_DATA}[/…]'; skipping this server`,
      ])
    );
    const claudeData = getPluginDataPath(tmp.path, computePluginInstanceId(claude.rootPath));
    expect(claudeResult.diagnostics.map((d) => d.message)).toEqual([
      ".mcp.json server 'cursorData': 'cwd' must be './…', '${PLUGIN_ROOT}[/…]', or '${PLUGIN_DATA}[/…]'; skipping this server",
    ]);
    expect((Object.values(claudeResult.servers)[0] as MCPStdioServerInfo).cwd).toBe(
      path.join(claudeData, "state")
    );
  });

  test("a Cursor server with a value Xum cannot fill is skipped as needing values", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makeCursorPlugin(tmp.path, "cursor", {
      token: { command: "npx", env: { TOKEN: "${BREVO_MCP_TOKEN}" } },
      // D29: only the two roots expand, so a Cursor data folder name is a user value.
      data: { command: "npx", args: ["${CURSOR_PLUGIN_DATA}/cache"] },
      workspace: { command: "npx", cwd: "${WORKSPACE_DIR}/x" },
      header: {
        type: "http",
        url: "https://x.example/mcp",
        headers: { Authorization: "Bearer ${CLIENT_SECRET:-}" },
      },
      // The url check would refuse it for its braces; the placeholder is the reason to report.
      host: { type: "http", url: "https://${VANTA_MCP_HOST}/mcp" },
      // A default can hold a secret: only the name is reported.
      fallback: { type: "http", url: "https://x.example/${PATH_SEGMENT:-s3cret-default}" },
      // Cursor reads ${env:NAME} from its environment; Xum never does.
      hostEnv: { command: "npx", env: { TOKEN: "${env:GITHUB_TOKEN}" } },
      plain: { type: "http", url: "https://attio.example/mcp" },
    });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(loadedNames(servers)).toEqual(["plain"]);
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        "warning",
        "mcp.json server 'token': needs values not supported in Xum (${BREVO_MCP_TOKEN}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'data': needs values not supported in Xum (${CURSOR_PLUGIN_DATA}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'workspace': needs values not supported in Xum (${WORKSPACE_DIR}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'header': needs values not supported in Xum (${CLIENT_SECRET}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'host': needs values not supported in Xum (${VANTA_MCP_HOST}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'fallback': needs values not supported in Xum (${PATH_SEGMENT}); skipping this server",
      ],
      [
        "warning",
        "mcp.json server 'hostEnv': needs values not supported in Xum (${env:GITHUB_TOKEN}); skipping this server",
      ],
    ]);
  });

  test("the Cursor dialect infers streamable HTTP from a url and ignores auth and placement", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makeCursorPlugin(tmp.path, "cursor", {
      gong: { url: "https://x.example/mcp" },
      x: {
        type: "http",
        url: "https://api.x.example/mcp",
        auth: { CLIENT_ID: "fixed-client", scopes: ["tweet.read"] },
      },
      trello: { type: "http", url: "https://mcp.trello.example/v1", placement: "server" },
      gopuff: {
        type: "http",
        url: "https://mcp.gopuff.example/mcp",
        auth: { CLIENT_ID: "fixed-client" },
        placement: "server",
      },
    });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(Object.values(servers).map((s) => [s.plugin?.serverName, s.transport])).toEqual([
      ["gong", "http"],
      ["x", "http"],
      ["trello", "http"],
      ["gopuff", "http"],
    ]);
    // Not translated: sign-in uses discovery and dynamic client registration.
    expect(Object.values(servers).map((s) => s.transport !== "stdio" && s.oauth)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([
      ["warning", "mcp.json server 'x': auth not applied in Xum"],
      ["warning", "mcp.json server 'trello': placement not applied in Xum"],
      ["warning", "mcp.json server 'gopuff': auth not applied in Xum"],
      ["warning", "mcp.json server 'gopuff': placement not applied in Xum"],
    ]);
  });

  test("only the Cursor dialect accepts a placement field", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const codex = await makePlugin(
      tmp.path,
      "codex",
      { trello: { type: "http", url: "https://mcp.trello.example/v1", placement: "server" } },
      { fileName: ".mcp.json" }
    );

    const { servers, diagnostics } = await loadPluginMcpServers(codex, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        "error",
        ".mcp.json server 'trello': unknown field 'placement' in remote server entry; skipping this server",
      ],
    ]);
  });

  test("only the Cursor dialect reserves the Cursor plugin root names", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const cursor = await makeCursorPlugin(tmp.path, "cursor", {
      forwardCursorRoot: { command: "node", env_vars: ["CURSOR_PLUGIN_ROOT"] },
      forwardClaudeRoot: { command: "node", env_vars: ["CLAUDE_PLUGIN_ROOT"] },
      setClaudeRoot: { command: "node", env: { CLAUDE_PLUGIN_ROOT: "/elsewhere" } },
    });
    const codex = await makePlugin(
      tmp.path,
      "codex",
      {
        forwardCursorRoot: { command: "node", env_vars: ["CURSOR_PLUGIN_ROOT"] },
        setClaudeRoot: { command: "node", env: { CLAUDE_PLUGIN_ROOT: "/elsewhere" } },
      },
      { fileName: ".mcp.json" }
    );

    const cursorResult = await loadPluginMcpServers(cursor, { xumHome: tmp.path });
    const codexResult = await loadPluginMcpServers(codex, { xumHome: tmp.path });

    expect(cursorResult.servers).toEqual({});
    expect(cursorResult.diagnostics.map((d) => [d.severity, d.message])).toEqual([
      [
        "error",
        "mcp.json server 'forwardCursorRoot': 'env_vars[0]' must not name reserved variable 'CURSOR_PLUGIN_ROOT'; skipping this server",
      ],
      [
        "error",
        "mcp.json server 'forwardClaudeRoot': 'env_vars[0]' must not name reserved variable 'CLAUDE_PLUGIN_ROOT'; skipping this server",
      ],
      [
        "error",
        "mcp.json server 'setClaudeRoot': 'env' must not contain reserved variable 'CLAUDE_PLUGIN_ROOT'; skipping this server",
      ],
    ]);
    expect(codexResult.diagnostics).toEqual([]);
    expect(loadedNames(codexResult.servers)).toEqual(["forwardCursorRoot", "setClaudeRoot"]);
  });

  test("the Codex dialect forwards only the host variables that env_vars names", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "env-vars",
      {
        mcpServers: {
          // Codex accepts a bare name or { name, source } (codex-rs config mcp_types.rs).
          named: {
            command: "node",
            // Codex's `source` is an Option<String>: null means unset, like an omitted source.
            env_vars: [
              "API_TOKEN",
              { name: "REGION", source: "local" },
              { name: "ZONE", source: null },
            ],
          },
          // Codex reads null as an absent optional list (serde Option), on any transport.
          nullList: { command: "node", env_vars: null },
          nullRemote: { url: "https://b.example.com/mcp", env_vars: null },
          notList: { command: "node", env_vars: "API_TOKEN" },
          // Codex refuses source "remote" for a plugin that runs in the local environment.
          remoteSource: { command: "node", env_vars: [{ name: "X", source: "remote" }] },
          reserved: { command: "node", env_vars: ["PLUGIN_DATA"] },
          badName: { command: "node", env_vars: ["A=B"] },
          // Codex rejects env_vars on a streamable HTTP server.
          http: { url: "https://a.example.com/mcp", env_vars: ["API_TOKEN"] },
        },
      },
      { fileName: ".mcp.json" }
    );
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    const infos = Object.values(servers);
    expect(
      infos.map((s) => [s.plugin?.serverName, s.transport === "stdio" ? s.forwardEnv : s.url])
    ).toEqual([
      ["named", ["API_TOKEN", "REGION", "ZONE"]],
      ["nullList", undefined],
      ["nullRemote", "https://b.example.com/mcp"],
    ]);
    // Only names: no host value is read at load time.
    expect(Object.keys((infos[0] as MCPStdioServerInfo).env ?? {})).toEqual([
      "PLUGIN_ROOT",
      "PLUGIN_DATA",
    ]);
    expect(diagnostics.map((d) => [d.severity, /server '(\w+)'/.exec(d.message)?.[1]])).toEqual([
      ["error", "notList"],
      ["error", "remoteSource"],
      ["error", "reserved"],
      ["error", "badName"],
      ["error", "http"],
    ]);
  });

  test("a Codex stdio server says that its OAuth settings and loader variables are unused or risky", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "stdio-notes",
      {
        mcpServers: {
          // Xum reads OAuth only for remote servers (#6646): say so, with or without env_vars.
          withEnv: {
            command: "node",
            env_vars: ["API_TOKEN"],
            oauth: { client_id: "c" },
            scopes: ["read"],
          },
          withoutEnv: { command: "node", oauth_resource: "https://r.example.com" },
          // These names change how the server process loads code: flag them in the review.
          loaders: {
            command: "node",
            env_vars: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "API_TOKEN"],
          },
          plain: { command: "node", env_vars: ["API_TOKEN"] },
        },
      },
      { fileName: ".mcp.json" }
    );
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(Object.values(servers).map((s) => s.plugin?.serverName)).toEqual([
      "withEnv",
      "withoutEnv",
      "loaders",
      "plain",
    ]);
    const notes = diagnostics.map((d) => [d.severity, /server '(\w+)'/.exec(d.message)?.[1]]);
    expect(notes).toEqual([
      ["warning", "withEnv"],
      ["warning", "withoutEnv"],
      ["warning", "loaders"],
    ]);
    expect(diagnostics[0].message).toContain("oauth, scopes");
    expect(diagnostics[1].message).toContain("oauth_resource");
    expect(diagnostics[2].message).toContain("LD_PRELOAD, DYLD_INSERT_LIBRARIES, NODE_OPTIONS");
    expect(diagnostics[2].message).not.toContain("API_TOKEN");
  });

  test("refuses = in env keys and flags every loader variable (#6713)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "env-keys",
      {
        mcpServers: {
          // A key with = would set PLUGIN_DATA once the env block is joined.
          equalsKey: { command: "node", env: { "PLUGIN_DATA=/x": "y" } },
          // An empty key is no variable name either (PRRT_kwDOPxxmWM6s3uZs).
          emptyKey: { command: "node", env: { "": "y" } },
          // stdio servers start through bash -c, which runs the file BASH_ENV names. ENV is read
          // only by interactive shells, so it is no loader here (PRRT_kwDOPxxmWM6s3uZ2).
          loaders: {
            command: "node",
            env_vars: ["BASH_ENV", "ENV", "LD_AUDIT", "NODE_PATH", "PYTHONPATH", "API_TOKEN"],
          },
        },
      },
      { fileName: ".mcp.json" }
    );
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(Object.values(servers).map((s) => s.plugin?.serverName)).toEqual(["loaders"]);
    expect(diagnostics.map((d) => [d.severity, /server '(\w+)'/.exec(d.message)?.[1]])).toEqual([
      ["error", "equalsKey"],
      ["error", "emptyKey"],
      ["warning", "loaders"],
    ]);
    expect(diagnostics[2].message).toContain("BASH_ENV, LD_AUDIT, NODE_PATH, PYTHONPATH");
    expect(diagnostics[2].message).not.toContain("API_TOKEN");
  });

  test("on Windows, reserved and duplicate env names compare without case", async () => {
    // Windows env names are case-insensitive (#6646): plugin_data would shadow PLUGIN_DATA.
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    assert(original !== undefined, "process.platform must be an own property");
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "win-env",
      {
        mcpServers: {
          forwardReserved: { command: "node", env_vars: ["plugin_data"] },
          envReserved: { command: "node", env: { Plugin_Root: "x" } },
          duplicates: { command: "node", env_vars: ["API_TOKEN", "api_token"] },
          // node_options is NODE_OPTIONS on Windows, so the review must name it.
          loader: { command: "node", env_vars: ["node_options"] },
        },
      },
      { fileName: ".mcp.json" }
    );
    const load = async (platform: NodeJS.Platform) => {
      Object.defineProperty(process, "platform", { ...original, value: platform });
      try {
        return await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    };
    const windows = await load("win32");
    expect(
      Object.values(windows.servers).map((s) => [
        s.plugin?.serverName,
        s.transport === "stdio" ? s.forwardEnv : undefined,
      ])
    ).toEqual([
      ["duplicates", ["API_TOKEN"]],
      ["loader", ["node_options"]],
    ]);
    expect(
      windows.diagnostics.map((d) => [d.severity, /server '(\w+)'/.exec(d.message)?.[1]])
    ).toEqual([
      ["error", "forwardReserved"],
      ["error", "envReserved"],
      ["warning", "loader"],
    ]);
    // Elsewhere names are case-sensitive, so these are ordinary variables.
    const linux = await load("linux");
    expect(
      Object.values(linux.servers).map((s) => [
        s.plugin?.serverName,
        s.transport === "stdio" ? s.forwardEnv : undefined,
      ])
    ).toEqual([
      ["forwardReserved", ["plugin_data"]],
      ["envReserved", undefined],
      ["duplicates", ["API_TOKEN", "api_token"]],
      ["loader", ["node_options"]],
    ]);
    // There node_options is not NODE_OPTIONS: no loader warning.
    expect(linux.diagnostics.some((d) => d.message.includes("server 'loader'"))).toBe(false);
  });

  test("the Codex dialect maps streamable_http spellings and resolves a relative cwd", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    // `cwd: "."` is openai/plugins openai-developers/.mcp.json verbatim.
    const plugin = await makePlugin(
      tmp.path,
      "codex-forms",
      {
        mcpServers: {
          local: { cwd: ".", command: "node", args: ["./mcp/server.mjs"] },
          nested: { cwd: "sub", command: "node" },
          escape: { cwd: "../outside", command: "node" },
          underscore: { type: "streamable_http", url: "https://a.example.com/mcp" },
          dash: { type: "streamable-http", url: "https://b.example.com/mcp" },
        },
      },
      { fileName: ".mcp.json" }
    );
    await fs.mkdir(path.join(plugin.rootPath, "sub"));
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    const byName = new Map(Object.values(servers).map((s) => [s.plugin?.serverName, s]));
    expect((byName.get("local") as MCPStdioServerInfo).cwd).toBe(plugin.rootPath);
    expect((byName.get("nested") as MCPStdioServerInfo).cwd).toBe(
      path.join(plugin.rootPath, "sub")
    );
    expect(byName.get("underscore")?.transport).toBe("http");
    expect(byName.get("dash")?.transport).toBe("http");
    // The containment check still applies to a rewritten cwd.
    expect(byName.has("escape")).toBe(false);
    expect(diagnostics.map((d) => d.message).join("\n")).toContain("escapes its containment root");
  });

  test("a root mcp.json stays strict: no Codex dialect", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const missingSchema = await makePlugin(tmp.path, "no-schema", {
      mcpServers: { a: { type: "streamable-http", url: "https://a.example.com" } },
    });
    expect((await loadPluginMcpServers(missingSchema, { xumHome: tmp.path })).servers).toEqual({});

    const dialect = await makePlugin(
      tmp.path,
      "dialect",
      mcpDoc({
        http: { type: "http", url: "https://a.example.com" },
        oauth: { type: "streamable-http", url: "https://a.example.com", oauth: {} },
        untyped: { url: "https://a.example.com" },
        envVars: { ...STDIO_ENTRY, env_vars: ["API_TOKEN"] },
      })
    );
    const { servers, diagnostics } = await loadPluginMcpServers(dialect, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics.map((d) => d.severity)).toEqual(["error", "error", "error", "error"]);
  });

  test("skips remote entries with configured headers (redirect conformance) with a warning", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "remote-headers",
      mcpDoc({
        withHeaders: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Tenant": "t" },
        },
        plain: { type: "streamable-http", url: "https://y.example.com/mcp" },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(Object.values(servers)).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("warning");
    expect(diagnostics[0].message).toContain("headers");
  });

  test("disables MCP for the plugin on invalid JSON / bad top-level / $schema mismatch", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");

    const cases: Array<{ doc: unknown; messagePart: string }> = [
      { doc: "{ not json", messagePart: "could not be parsed" },
      { doc: [1, 2], messagePart: "must be a JSON object" },
      {
        doc: { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0, mcpServers: {}, extra: 1 },
        messagePart: "unknown top-level field 'extra'",
      },
      { doc: { mcpServers: {} }, messagePart: "'$schema'" },
      {
        doc: {
          $schema: "https://agent-plugins.org/schemas/9.0.0/mcp.schema.json",
          mcpServers: {},
        },
        messagePart: "'$schema'",
      },
      { doc: { $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0 }, messagePart: "'mcpServers'" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(tmp.path, `bad-${index}`, testCase.doc);
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe("error");
      expect(diagnostics[0].message).toContain(testCase.messagePart);
    }
  });

  test("a malformed .mcp.json never reports its secret in a diagnostic or log (#6297)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    // An unquoted value: the JSON parser quotes it in its error message.
    const plugin = await makePlugin(
      tmp.path,
      "malformed-codex",
      '{"gh": {"type": "http", "url": "https://x", "oauth": {"client_id": "c", "client_secret": s3cr3tValue}}}',
      { fileName: ".mcp.json" }
    );
    const warn = spyOn(log, "warn");
    try {
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics.map((d) => d.severity)).toEqual(["error"]);
      expect(JSON.stringify(diagnostics)).not.toContain("s3cr3tValue");
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cr3tValue");
    } finally {
      warn.mockRestore();
    }
  });

  test("disables MCP for the plugin on an oversized mcp.json", async () => {
    // Server summaries built from mcp.json reach the install consent
    // preview's IPC/render path: an unbounded document must disable MCP for
    // this plugin instead of shipping megabytes of text to the renderer.
    using tmp = new DisposableTempDir("plugin-mcp");
    const oversized = JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA_ID_1_0_0,
      mcpServers: {
        big: { type: "stdio", command: "bunx", args: ["x".repeat(512 * 1024)] },
      },
    });
    const plugin = await makePlugin(tmp.path, "oversized", oversized);
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toContain("too large");
  });

  test("disables MCP when mcp.json is a symlink escaping the plugin root", async () => {
    // A managed update can replace a consented regular mcp.json with an
    // absolute symlink to attacker-chosen content outside the plugin root
    // (staged validation only rejects links into the managed container). The
    // consuming read must refuse to follow it: this document defines
    // spawnable commands, so following the link would let outside config be
    // parsed and its command spawned during the promotion race.
    using tmp = new DisposableTempDir("plugin-mcp");
    const outside = path.join(tmp.path, "outside-mcp.json");
    await fs.writeFile(
      outside,
      JSON.stringify(mcpDoc({ evil: { type: "stdio", command: "sh" } })),
      "utf8"
    );
    const plugin = await makePlugin(tmp.path, "symlinked", mcpDoc({}));
    await fs.rm(plugin.mcpConfigPath!);
    await fs.symlink(outside, plugin.mcpConfigPath!);
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe("error");
    expect(diagnostics[0].message).toContain("outside containment root");
  });

  test("an empty mcpServers object is valid", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(tmp.path, "empty", mcpDoc({}));
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
    expect(servers).toEqual({});
    expect(diagnostics).toEqual([]);
  });

  test("skips invalid entries individually while loading valid siblings (§7.2.2)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "mixed",
      mcpDoc({
        notObject: "nope",
        unknownType: { type: "websocket", url: "wss://x" },
        unknownField: { ...STDIO_ENTRY, extra: true },
        wrongVariantField: { type: "stdio", command: "x", url: "https://x" },
        good: STDIO_ENTRY,
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const instanceId = computePluginInstanceId(plugin.rootPath);
    expect(Object.keys(servers)).toEqual([buildPluginServerKey(instanceId, "good")]);
    expect(diagnostics).toHaveLength(4);
  });

  test("rejects non-token commands: shell strings, absolute/parent/backslash paths", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const command of ["/usr/bin/env", "bin/tool", "../tool", "bin\\tool", ""]) {
      const plugin = await makePlugin(
        tmp.path,
        `cmd-${Buffer.from(command).toString("hex")}`,
        mcpDoc({ srv: { type: "stdio", command } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("executable token");
    }
  });

  test("resolves './'-relative commands inside the plugin root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "rel-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin/tool" } })
    );
    await fs.mkdir(path.join(plugin.rootPath, "bin"), { recursive: true });
    // mode 0o755: normalization verifies the execute bit on POSIX.
    await fs.writeFile(path.join(plugin.rootPath, "bin", "tool"), "#!/bin/sh\n", {
      encoding: "utf8",
      mode: 0o755,
    });

    const { servers } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const info = Object.values(servers)[0] as MCPStdioServerInfo;
    expect(info.command).toBe(path.join(plugin.rootPath, "bin", "tool"));
  });

  test("invalidates entries whose './'-relative command is missing or symlink-escapes the root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");

    const missing = await makePlugin(
      tmp.path,
      "missing-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin/nope" } })
    );
    const missingResult = await loadPluginMcpServers(missing, { xumHome: tmp.path });
    expect(missingResult.servers).toEqual({});
    expect(missingResult.diagnostics[0].message).toContain("does not exist");

    const outside = path.join(tmp.path, "outside-tool");
    await fs.writeFile(outside, "#!/bin/sh\n", "utf8");
    const escaping = await makePlugin(
      tmp.path,
      "escaping-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./tool" } })
    );
    await fs.symlink(outside, path.join(escaping.rootPath, "tool"));
    const escapeResult = await loadPluginMcpServers(escaping, { xumHome: tmp.path });
    expect(escapeResult.servers).toEqual({});
    expect(escapeResult.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("rejects a './'-relative command that resolves to a directory (exec would fail)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "dir-cmd",
      mcpDoc({ srv: { type: "stdio", command: "./bin" } })
    );
    await fs.mkdir(path.join(plugin.rootPath, "bin"), { recursive: true });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("must be a file");
  });

  test("rejects bare commands containing whitespace or control characters", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const [index, command] of ["node --version", " ", "no\tde", "no\nde"].entries()) {
      const plugin = await makePlugin(
        tmp.path,
        `ws-cmd-${index}`,
        mcpDoc({ srv: { type: "stdio", command } })
      );

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("single executable token");
    }
  });

  test.skipIf(process.platform === "win32")(
    "rejects a './'-relative command without the execute bit",
    async () => {
      using tmp = new DisposableTempDir("plugin-mcp");
      const plugin = await makePlugin(
        tmp.path,
        "noexec-cmd",
        mcpDoc({ srv: { type: "stdio", command: "./tool" } })
      );
      await fs.writeFile(path.join(plugin.rootPath, "tool"), "#!/bin/sh\n", {
        encoding: "utf8",
        mode: 0o644,
      });

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain("not executable");
    }
  );

  test("rejects NUL bytes in args, env entries, cwd, and relative commands", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const cases: Array<{ entry: Record<string, unknown>; expect: string }> = [
      { entry: { type: "stdio", command: "x", args: ["a\0b"] }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", env: { KEY: "a\0b" } }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", env: { "K\0EY": "v" } }, expect: "NUL" },
      { entry: { type: "stdio", command: "x", cwd: "./a\0b" }, expect: "NUL" },
      { entry: { type: "stdio", command: "./a\0b" }, expect: "single executable token" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(tmp.path, `nul-${index}`, mcpDoc({ srv: testCase.entry }));

      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(testCase.expect);
    }
  });

  test("rejects entries with reserved env keys (PLUGIN_ROOT / PLUGIN_DATA)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    for (const key of ["PLUGIN_ROOT", "PLUGIN_DATA"]) {
      const plugin = await makePlugin(
        tmp.path,
        `reserved-${key.toLowerCase()}`,
        mcpDoc({ srv: { type: "stdio", command: "x", env: { [key]: "/y" } } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(key);
    }
  });

  test("accepts every valid cwd form", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "cwd-forms",
      mcpDoc({
        rel: { type: "stdio", command: "x", cwd: "./sub" },
        rootExact: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}" },
        rootSub: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/sub" },
        dataExact: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}" },
        dataSub: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/nested" },
      })
    );
    await fs.mkdir(path.join(plugin.rootPath, "sub"), { recursive: true });

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(diagnostics).toEqual([]);
    const instanceId = computePluginInstanceId(plugin.rootPath);
    const dataPath = getPluginDataPath(tmp.path, instanceId);
    const cwdOf = (name: string) =>
      (servers[buildPluginServerKey(instanceId, name)] as MCPStdioServerInfo).cwd;
    expect(cwdOf("rel")).toBe(path.join(plugin.rootPath, "sub"));
    expect(cwdOf("rootExact")).toBe(plugin.rootPath);
    expect(cwdOf("rootSub")).toBe(path.join(plugin.rootPath, "sub"));
    expect(cwdOf("dataExact")).toBe(dataPath);
    expect(cwdOf("dataSub")).toBe(path.join(dataPath, "nested"));
  });

  test("rejects invalid cwd forms, post-resolution escapes, and missing plugin-root cwds", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const cases: Array<{ cwd: string; messagePart: string }> = [
      { cwd: "sub", messagePart: "'cwd' must be" },
      { cwd: "/abs", messagePart: "'cwd' must be" },
      { cwd: "../up", messagePart: "'cwd' must be" },
      { cwd: "./..", messagePart: "escapes" },
      { cwd: "./sub/../../up", messagePart: "escapes" },
      { cwd: "${PLUGIN_ROOT}/../up", messagePart: "escapes" },
      { cwd: "${PLUGIN_DATA}/..", messagePart: "escapes" },
      // Plugin-root cwds are shipped content: launch only creates PLUGIN_DATA
      // dirs and exec() rejects a missing cwd, so these entries are invalid.
      { cwd: "./missing", messagePart: "does not exist" },
      { cwd: "${PLUGIN_ROOT}/missing", messagePart: "does not exist" },
    ];
    for (const [index, testCase] of cases.entries()) {
      const plugin = await makePlugin(
        tmp.path,
        `bad-cwd-${index}`,
        mcpDoc({ srv: { type: "stdio", command: "x", cwd: testCase.cwd } })
      );
      const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });
      expect(servers).toEqual({});
      expect(diagnostics[0].message).toContain(testCase.messagePart);
    }
  });

  test("rejects a cwd that resolves to a file (exec would fail with ENOTDIR)", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "cwd-file",
      mcpDoc({
        rel: { type: "stdio", command: "x", cwd: "./afile" },
        rooted: { type: "stdio", command: "x", cwd: "${PLUGIN_ROOT}/afile" },
      })
    );
    await fs.writeFile(path.join(plugin.rootPath, "afile"), "not a dir", "utf8");

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.message.includes("must be a directory"))).toBe(true);
  });

  test("rejects a data-anchored cwd whose existing target is a file", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "data-cwd-file",
      mcpDoc({ srv: { type: "stdio", command: "x", cwd: "${PLUGIN_DATA}/blob" } })
    );
    const dataPath = getPluginDataPath(tmp.path, computePluginInstanceId(plugin.rootPath));
    await fs.mkdir(dataPath, { recursive: true });
    await fs.writeFile(path.join(dataPath, "blob"), "not a dir", "utf8");

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("must be a directory");
  });

  test("rejects a cwd that symlink-escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const outsideDir = path.join(tmp.path, "outside-dir");
    await fs.mkdir(outsideDir, { recursive: true });
    const plugin = await makePlugin(
      tmp.path,
      "cwd-symlink",
      mcpDoc({ srv: { type: "stdio", command: "x", cwd: "./link" } })
    );
    await fs.symlink(outsideDir, path.join(plugin.rootPath, "link"));

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics[0].message).toContain("escapes");
  });

  test("validates remote URLs: userinfo, fragment, non-loopback http rejected; loopback http accepted", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "urls",
      mcpDoc({
        userinfo: { type: "streamable-http", url: "https://user:pw@x.example.com/mcp" },
        fragment: { type: "streamable-http", url: "https://x.example.com/mcp#frag" },
        plainHttp: { type: "streamable-http", url: "http://x.example.com/mcp" },
        relative: { type: "streamable-http", url: "/mcp" },
        ftp: { type: "streamable-http", url: "ftp://x.example.com/mcp" },
        localhostHttp: { type: "streamable-http", url: "http://localhost:3000/mcp" },
        loopbackIp: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
        loopbackV6: { type: "streamable-http", url: "http://[::1]:3000/mcp" },
      })
    );

    const { servers } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    const instanceId = computePluginInstanceId(plugin.rootPath);
    const loaded = Object.keys(servers).sort();
    expect(loaded).toEqual(
      ["localhostHttp", "loopbackIp", "loopbackV6"]
        .map((name) => buildPluginServerKey(instanceId, name))
        .sort()
    );
  });

  test("rejects duplicate case-insensitive header names and invalid header fields", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(
      tmp.path,
      "headers",
      mcpDoc({
        dupes: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Tenant": "a", "x-tenant": "b" },
        },
        badName: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "Bad Name": "a" },
        },
        badValue: {
          type: "streamable-http",
          url: "https://x.example.com/mcp",
          headers: { "X-Ok": "a\r\nInjected: b" },
        },
      })
    );

    const { servers, diagnostics } = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    expect(servers).toEqual({});
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  test("server keys and PLUGIN_DATA are stable across manifest renames and content changes", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const plugin = await makePlugin(tmp.path, "stable", mcpDoc({ srv: STDIO_ENTRY }));

    const first = await loadPluginMcpServers(plugin, { xumHome: tmp.path });

    // Simulate a manifest rename + version bump: same root path.
    const renamed: AgentPluginInfo = {
      ...plugin,
      name: "renamed-plugin",
      manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "renamed-plugin", version: "2.0" },
    };
    const second = await loadPluginMcpServers(renamed, { xumHome: tmp.path });

    expect(Object.keys(second.servers)).toEqual(Object.keys(first.servers));
    expect(Object.keys(first.servers)).toHaveLength(1);
    const firstInfo = Object.values(first.servers)[0] as MCPStdioServerInfo;
    const secondInfo = Object.values(second.servers)[0] as MCPStdioServerInfo;
    expect(secondInfo.env?.PLUGIN_DATA).toBe(firstInfo.env?.PLUGIN_DATA);
  });

  test("duplicate plugin names in different roots get distinct keys and data dirs", async () => {
    using tmp = new DisposableTempDir("plugin-mcp");
    const a = await makePlugin(path.join(tmp.path, "a"), "same-name", mcpDoc({ srv: STDIO_ENTRY }));
    const b = await makePlugin(path.join(tmp.path, "b"), "same-name", mcpDoc({ srv: STDIO_ENTRY }));

    const resultA = await loadPluginMcpServers(a, { xumHome: tmp.path });
    const resultB = await loadPluginMcpServers(b, { xumHome: tmp.path });

    const keyA = Object.keys(resultA.servers)[0];
    const keyB = Object.keys(resultB.servers)[0];
    expect(keyA).not.toBe(keyB);
    const dataA = (Object.values(resultA.servers)[0] as MCPStdioServerInfo).env?.PLUGIN_DATA;
    const dataB = (Object.values(resultB.servers)[0] as MCPStdioServerInfo).env?.PLUGIN_DATA;
    expect(dataA).not.toBe(dataB);
    // Displayed provenance must also distinguish the two installations.
    const locA = (Object.values(resultA.servers)[0] as MCPStdioServerInfo).plugin?.sourceLocation;
    const locB = (Object.values(resultB.servers)[0] as MCPStdioServerInfo).plugin?.sourceLocation;
    expect(locA).not.toBe(locB);
  });
});

async function withHomeDir(homeDir: string, callback: () => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const homedirSpy = spyOn(os, "homedir");

  homedirSpy.mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    await callback();
  } finally {
    homedirSpy.mockRestore();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

async function writeDiscoverablePlugin(
  containerPath: string,
  name: string,
  mcpJson: unknown
): Promise<void> {
  const pluginDir = path.join(containerPath, name);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name }),
    "utf8"
  );
  await fs.writeFile(
    path.join(pluginDir, "mcp.json"),
    typeof mcpJson === "string" ? mcpJson : JSON.stringify(mcpJson),
    "utf8"
  );
}

describe("createAgentPluginsMcpProvider", () => {
  test.each([
    [".xum", false],
    [".mux", false],
    [".xum", true],
    [".mux", true],
  ] as const)(
    "overlapping %s project containers cannot bypass managed MCP imports via overrides (aliased home: %s)",
    async (metadataDir, aliasHome) => {
      using home = new DisposableTempDir("plugin-mcp-container-overlap");
      await withHomeDir(home.path, async () => {
        const physicalHome = path.join(home.path, metadataDir);
        const xumHome = aliasHome ? path.join(home.path, "configured-home") : physicalHome;
        await fs.mkdir(physicalHome, { recursive: true });
        if (aliasHome) await fs.symlink(physicalHome, xumHome, "dir");
        await writeDiscoverablePlugin(
          path.join(xumHome, "plugins"),
          "managed",
          mcpDoc({
            allowed: STDIO_ENTRY,
            blocked: STDIO_ENTRY,
          })
        );
        await writeDiscoverablePlugin(
          path.join(home.path, ".agents", "plugins"),
          "project-only",
          mcpDoc({ unmanaged: STDIO_ENTRY })
        );
        const provider = createAgentPluginsMcpProvider({ xumHome });
        const context = { projectRoot: home.path, projectKey: home.path };
        const unfiltered = await provider({ ...context, trusted: true });
        const keyFor = (name: string) => {
          const key = Object.entries(unfiltered).find(
            ([, info]) => info.plugin?.serverName === name
          )?.[0];
          if (key === undefined) throw new Error(`Fixture server ${name} missing`);
          return key;
        };
        const overrides = { enabledServers: Object.keys(unfiltered) };
        const registryPath = path.join(xumHome, "plugins.json");
        await fs.writeFile(
          registryPath,
          JSON.stringify({
            plugins: [
              createTestPluginInstallEntry(
                "managed",
                { skills: [], mcpServers: ["allowed"] },
                await reviewedComponentConsent({
                  pluginDir: path.join(xumHome, "plugins", "managed"),
                })
              ),
            ],
          })
        );
        const manager = new MCPServerManager(
          new MCPConfigService(new Config(xumHome), { agentPluginsMcpProvider: provider }),
          {
            pluginInvalidation: {
              keyPrefix: "plugin:",
              readToken: () => Promise.resolve(undefined),
              readComponentPolicy: () => readPluginMcpPolicy(registryPath),
            },
          }
        );
        try {
          const servers = await manager.listServers(home.path, overrides, true, context);
          const globalKey = buildPluginServerKey(
            computePluginInstanceId(path.join(xumHome, "plugins", "managed")),
            "allowed"
          );
          expect(Object.keys(servers).sort()).toEqual(
            [keyFor("allowed"), keyFor("unmanaged"), ...(aliasHome ? [globalKey] : [])].sort()
          );
          const loaded = await provider({ ...context, trusted: true });
          const physicalProvider = createAgentPluginsMcpProvider({
            xumHome: physicalHome,
          });
          const physicalKeys = Object.keys(await physicalProvider({ ...context, trusted: true }));
          expect(Object.keys(loaded).sort()).toEqual(
            [...physicalKeys, ...(aliasHome ? [globalKey] : [])].sort()
          );
          expect(loaded[globalKey]?.plugin?.sourceScope).toBe(aliasHome ? "global" : undefined);
          expect(
            Object.values(loaded).some((server) => server.plugin?.serverName === "blocked")
          ).toBe(false);
          const global = await provider({ trusted: false });
          expect(global[globalKey]?.plugin?.serverName).toBe("allowed");
          expect(loaded[keyFor("allowed")]?.plugin?.sourceScope).toBe("project");
          expect(loaded[keyFor("blocked")]).toBeUndefined();
          for (const info of Object.values(loaded).filter(
            (info) => info.plugin?.serverName === "allowed"
          )) {
            expect(info.plugin?.componentPolicy).toEqual({
              registryPath: path.join(physicalHome, "plugins.json"),
              name: "managed",
            });
          }
          await fs.unlink(registryPath);
          expect(
            Object.keys(await manager.listServers(home.path, overrides, true, context))
          ).toEqual([keyFor("unmanaged")]);
          await fs.writeFile(registryPath, "{");
          expect(
            Object.keys(await manager.listServers(home.path, overrides, true, context))
          ).toEqual([keyFor("unmanaged")]);
        } finally {
          manager.dispose();
        }
      });
    }
  );

  test("a managed server loads only as the definition the user reviewed (#6498)", async () => {
    using home = new DisposableTempDir("plugin-mcp-consent");
    await withHomeDir(home.path, async () => {
      const xumHome = path.join(home.path, ".xum");
      const container = path.join(xumHome, "plugins");
      await writeDiscoverablePlugin(container, "managed", mcpDoc({ srv: STDIO_ENTRY }));
      await writeDiscoverablePlugin(
        path.join(home.path, ".agents", "plugins"),
        "unmanaged",
        mcpDoc({ free: STDIO_ENTRY })
      );
      const registryPath = path.join(xumHome, "plugins.json");
      const saveConsent = (componentConsent?: ComponentConsent) =>
        fs.writeFile(
          registryPath,
          JSON.stringify({
            plugins: [
              createTestPluginInstallEntry(
                "managed",
                { skills: [], mcpServers: ["srv"] },
                componentConsent
              ),
            ],
          })
        );
      const provider = createAgentPluginsMcpProvider({ xumHome });
      // The provider drops a managed server whose registration the policy does not allow.
      const loaded = async () =>
        Object.values(await provider({ trusted: false }))
          .map((info) => info.plugin?.serverName)
          .sort();
      await saveConsent();
      const reviewed = await reviewedComponentConsent({
        pluginDir: path.join(container, "managed"),
      });

      // An install from before #6498 has no records: its imported server does not start.
      expect(await loaded()).toEqual(["free"]);
      // A record for another definition under the same name is no consent either.
      await saveConsent({
        skills: {},
        mcpServers: { srv: "0".repeat(64) },
        workflows: {},
        agents: {},
        slashCommands: {},
      });
      expect(await loaded()).toEqual(["free"]);
      await saveConsent(reviewed);
      expect(await loaded()).toEqual(["free", "srv"]);
      // A change the parser sees (here: args) under the reviewed name needs a new review.
      await writeDiscoverablePlugin(
        container,
        "managed",
        mcpDoc({ srv: { ...STDIO_ENTRY, args: ["-y", "another-server"] } })
      );
      expect(await loaded()).toEqual(["free"]);
    });
  });

  test("an escaped project alias does not discard its distinct valid global MCP registration", async () => {
    using home = new DisposableTempDir("plugin-provider-outward-home");
    using project = new DisposableTempDir("plugin-provider-outward-project");
    await withHomeDir(home.path, async () => {
      const xumHome = path.join(home.path, "configured");
      const owner = path.join(xumHome, "plugins");
      await writeDiscoverablePlugin(
        owner,
        "managed",
        mcpDoc({ allowed: STDIO_ENTRY, blocked: STDIO_ENTRY })
      );
      await fs.writeFile(
        path.join(xumHome, "plugins.json"),
        JSON.stringify({
          plugins: [
            createTestPluginInstallEntry(
              "managed",
              { skills: [], mcpServers: ["allowed"] },
              await reviewedComponentConsent({ pluginDir: path.join(owner, "managed") })
            ),
          ],
        })
      );
      const projectAlias = path.join(project.path, ".xum", "plugins");
      await fs.mkdir(path.dirname(projectAlias));
      await fs.symlink(owner, projectAlias, "dir");
      const provider = createAgentPluginsMcpProvider({ xumHome });
      const globalKey = buildPluginServerKey(
        computePluginInstanceId(path.join(owner, "managed")),
        "allowed"
      );
      const manager = new MCPServerManager(
        new MCPConfigService(new Config(xumHome), { agentPluginsMcpProvider: provider })
      );
      try {
        const result = await manager.listServers(
          project.path,
          { enabledServers: [globalKey] },
          true,
          { projectRoot: project.path, projectKey: project.path }
        );
        expect(Object.keys(result)).toEqual([globalKey]);
        expect(result[globalKey].plugin?.sourceScope).toBe("global");
      } finally {
        manager.dispose();
      }
    });
  });

  test("discovers global plugin servers and gates project containers on trust", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    using project = new DisposableTempDir("plugin-provider-project");
    await withHomeDir(home.path, async () => {
      await writeDiscoverablePlugin(
        path.join(xumHome.path, "plugins"),
        "global-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(home.path, ".agents", "plugins"),
        "universal-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(project.path, ".mux", "plugins"),
        "project-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
      });

      const pluginNamesOf = (servers: Record<string, { plugin?: { pluginName: string } }>) =>
        Object.values(servers)
          .map((s) => s.plugin?.pluginName)
          .sort();

      // Untrusted project: only global containers contribute.
      const untrusted = await provider({ projectRoot: project.path, trusted: false });
      expect(pluginNamesOf(untrusted)).toEqual(["global-plugin", "universal-plugin"]);

      // Trusted project: project containers contribute too.
      const trusted = await provider({ projectRoot: project.path, trusted: true });
      expect(pluginNamesOf(trusted)).toEqual([
        "global-plugin",
        "project-plugin",
        "universal-plugin",
      ]);

      // No project at all: global only.
      const globalOnly = await provider({ trusted: false });
      expect(pluginNamesOf(globalOnly)).toEqual(["global-plugin", "universal-plugin"]);
    });
  });

  test("global plugin identity survives symlink retargeting (versioned installs)", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    await withHomeDir(home.path, async () => {
      // Versioned install layout: plugins/demo is a symlink an updater
      // retargets from v1 to v2. The realpath changes; identity must not.
      const versions = path.join(xumHome.path, "versions");
      await writeDiscoverablePlugin(versions, "v1", mcpDoc({ srv: STDIO_ENTRY }));
      await writeDiscoverablePlugin(versions, "v2", mcpDoc({ srv: STDIO_ENTRY }));
      const container = path.join(xumHome.path, "plugins");
      await fs.mkdir(container, { recursive: true });
      const link = path.join(container, "demo");
      await fs.symlink(path.join(versions, "v1"), link);

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
      });

      const before = Object.keys(await provider({ trusted: false })).sort();
      expect(before).toHaveLength(1);

      await fs.unlink(link);
      await fs.symlink(path.join(versions, "v2"), link);

      const after = Object.keys(await provider({ trusted: false })).sort();
      expect(after).toEqual(before);
    });
  });

  test("a plugin with broken mcp.json never affects sibling plugins", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    await withHomeDir(home.path, async () => {
      const container = path.join(xumHome.path, "plugins");
      await writeDiscoverablePlugin(container, "broken", "{ not json");
      await writeDiscoverablePlugin(container, "healthy", mcpDoc({ srv: STDIO_ENTRY }));

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
      });
      const servers = await provider({ trusted: false });

      expect(Object.values(servers).map((s) => s.plugin?.pluginName)).toEqual(["healthy"]);
    });
  });

  test("project plugin keys are stable across checkouts of the same project", async () => {
    using home = new DisposableTempDir("plugin-provider-home");
    using xumHome = new DisposableTempDir("plugin-provider-mux");
    using projectDir = new DisposableTempDir("plugin-provider-checkout-a");
    using worktreeDir = new DisposableTempDir("plugin-provider-checkout-b");
    await withHomeDir(home.path, async () => {
      // The worktree has already migrated to .xum while the project checkout
      // still uses .mux; both locations must retain one persisted identity.
      await writeDiscoverablePlugin(
        path.join(projectDir.path, ".mux", "plugins"),
        "shared-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );
      await writeDiscoverablePlugin(
        path.join(worktreeDir.path, ".xum", "plugins"),
        "shared-plugin",
        mcpDoc({ srv: STDIO_ENTRY })
      );

      const provider = createAgentPluginsMcpProvider({
        xumHome: xumHome.path,
      });

      // Engine flow: scans the worktree, keys by the project identity.
      const fromWorktree = await provider({
        projectRoot: worktreeDir.path,
        projectKey: projectDir.path,
        trusted: true,
      });
      // UI flow (Settings / workspace modal): scans the project checkout.
      const fromProject = await provider({
        projectRoot: projectDir.path,
        projectKey: projectDir.path,
        trusted: true,
      });

      expect(Object.keys(fromWorktree)).toHaveLength(1);
      expect(Object.keys(fromWorktree)).toEqual(Object.keys(fromProject));

      // PLUGIN_DATA is shared too, but PLUGIN_ROOT follows the scanned checkout.
      const worktreeInfo = Object.values(fromWorktree)[0] as MCPStdioServerInfo;
      const projectInfo = Object.values(fromProject)[0] as MCPStdioServerInfo;
      expect(worktreeInfo.env?.PLUGIN_DATA).toBe(projectInfo.env?.PLUGIN_DATA ?? "");
      expect(worktreeInfo.env?.PLUGIN_ROOT).toBe(
        path.join(await fs.realpath(worktreeDir.path), ".xum", "plugins", "shared-plugin")
      );
      expect(projectInfo.env?.PLUGIN_ROOT).toBe(
        path.join(await fs.realpath(projectDir.path), ".mux", "plugins", "shared-plugin")
      );

      // A different project identity yields different keys even for the same rel path.
      const otherProject = await provider({
        projectRoot: projectDir.path,
        projectKey: "/some/other/project",
        trusted: true,
      });
      expect(Object.keys(otherProject)).not.toEqual(Object.keys(fromProject));
    });
  });
});

describe("resolveAgentPluginsMcpContext", () => {
  const projectPath = "/home/user/projects/my-app";
  const workspacePath = "/home/user/.mux/src/my-app/feature-branch";

  function createMetadata(
    runtimeConfig: WorkspaceMetadata["runtimeConfig"],
    extra?: Partial<WorkspaceMetadata>
  ): WorkspaceMetadata {
    return {
      id: "workspace-id",
      name: "feature-branch",
      projectName: "my-app",
      projectPath,
      runtimeConfig,
      ...extra,
    };
  }

  test("scans the active checkout keyed by the project for host runtimes", () => {
    for (const runtimeConfig of [
      { type: "local" } as const,
      { type: "worktree", srcBaseDir: "/home/user/.mux/src" } as const,
    ]) {
      expect(resolveAgentPluginsMcpContext(createMetadata(runtimeConfig), workspacePath)).toEqual({
        projectRoot: workspacePath,
        projectKey: projectPath,
      });
    }
  });

  test("returns null for workspaces that exec off-host", () => {
    const offHostConfigs: Array<WorkspaceMetadata["runtimeConfig"]> = [
      { type: "ssh", host: "remote", srcBaseDir: "/home/remote/.mux/src" },
      { type: "docker", image: "ubuntu:22.04" },
      // Devcontainer checkouts are host paths, but exec runs inside the container.
      { type: "devcontainer", configPath: ".devcontainer/devcontainer.json" },
    ];
    for (const runtimeConfig of offHostConfigs) {
      expect(
        resolveAgentPluginsMcpContext(createMetadata(runtimeConfig), workspacePath)
      ).toBeNull();
    }

    // Multi-project fan-out execs per-project; the shared root is not a checkout.
    expect(
      resolveAgentPluginsMcpContext(
        createMetadata(
          { type: "local" },
          {
            projects: [
              { projectPath: "/proj/a", projectName: "a" },
              { projectPath: "/proj/b", projectName: "b" },
            ],
          }
        ),
        workspacePath
      )
    ).toBeNull();
  });
});

test("MCP discovery rechecks selection after loading component files", async () => {
  using tmp = new DisposableTempDir("plugin-mcp-discovery-policy");
  await withHomeDir(tmp.path, async () => {
    const xumHome = path.join(tmp.path, ".xum");
    await writeDiscoverablePlugin(
      path.join(xumHome, "plugins"),
      "demo",
      mcpDoc({ removed: STDIO_ENTRY })
    );
    const registry = path.join(xumHome, "plugins.json");
    await fs.writeFile(
      registry,
      JSON.stringify({ plugins: [createTestPluginInstallEntry("demo")] })
    );
    const original = fs.open;
    const open = spyOn(fs, "open").mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (String(args[0]).endsWith("mcp.json")) {
          await fs.writeFile(
            `${registry}.tmp`,
            JSON.stringify({
              plugins: [createTestPluginInstallEntry("demo", { skills: [], mcpServers: [] })],
            })
          );
          await fs.rename(`${registry}.tmp`, registry);
        }
        return handle;
      }
    );
    try {
      const provider = createAgentPluginsMcpProvider({ xumHome });
      expect(await provider({ trusted: false })).toEqual({});
    } finally {
      open.mockRestore();
    }
  });
});
