import * as fs from "fs";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { listProjectMetadataRelativePaths } from "@/common/compat/legacyMux";
import type {
  MCPConfig,
  MCPHeaderValue,
  MCPServerInfo,
  MCPServerTransport,
} from "@/common/types/mcp";
import { Ok, Err } from "@/common/types/result";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type {
  AgentPluginsMcpContext,
  AgentPluginsMcpProvider,
} from "@/node/services/agentPlugins/mcpConfig";
import { isCanonicalPluginServerKey } from "@/node/services/agentPlugins/mcpConfig";
import { log } from "@/node/services/log";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Canonical `plugin:<16-hex>:<server>` keys are RESERVED for Agent Plugin
 * servers: a plugin uninstall prunes workspace overrides for these keys by
 * shape, so an ordinary user-configured server occupying one would shadow
 * the plugin server (user layers win on key collision) yet lose its own
 * enablement/allowlist state during that plugin's uninstall. Reserved keys
 * found in user config are ignored at runtime — the on-disk entry is
 * preserved verbatim (loss-preserving rewrites) but never listed or started.
 */
function omitReservedPluginKeys(
  servers: Record<string, MCPServerInfo>,
  layer: "global" | "project"
): Record<string, MCPServerInfo> {
  const result: Record<string, MCPServerInfo> = {};
  for (const [name, info] of Object.entries(servers)) {
    if (isCanonicalPluginServerKey(name)) {
      log.debug(
        `[MCP] Ignoring ${layer} MCP server '${name}': the canonical plugin key namespace is reserved for Agent Plugin servers`
      );
      continue;
    }
    result[name] = info;
  }
  return result;
}

export class MCPConfigService {
  private readonly config: Config;
  /**
   * Agent Plugins (agent-plugins experiment): read-only extra server source
   * merged into listings. Plugin servers are never persisted — every mutation
   * below operates on the on-disk global config only, so `plugin:*` keys
   * naturally fail with "not found".
   */
  private readonly agentPluginsMcpProvider: AgentPluginsMcpProvider | null;

  constructor(config: Config, options?: { agentPluginsMcpProvider?: AgentPluginsMcpProvider }) {
    assert(
      typeof config.rootDir === "string" && config.rootDir.trim().length > 0,
      "MCPConfigService: config.rootDir must be a non-empty string"
    );

    this.config = config;
    this.agentPluginsMcpProvider = options?.agentPluginsMcpProvider ?? null;
  }

  private getGlobalConfigPath(): string {
    return path.join(this.config.rootDir, "mcp.jsonc");
  }

  private getRepoOverridePaths(projectPath: string): string[] {
    return listProjectMetadataRelativePaths("mcp.jsonc").map((relativePath) =>
      path.join(projectPath, relativePath)
    );
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureMuxRootDir(): Promise<void> {
    if (!(await this.pathExists(this.config.rootDir))) {
      await fs.promises.mkdir(this.config.rootDir, { recursive: true });
    }
  }

  /**
   * Normalize a raw config entry into a strongly-typed server definition.
   *
   * Supported raw formats:
   * - string: stdio command
   * - object w/ command: stdio
   * - object w/ url: http/sse/auto (defaults to auto)
   */
  private normalizeEntry(entry: unknown): MCPServerInfo {
    if (typeof entry === "string") {
      return { transport: "stdio", command: entry, disabled: false };
    }

    if (!entry || typeof entry !== "object") {
      // Fail closed for invalid shapes.
      return { transport: "stdio", command: "", disabled: true };
    }

    const obj = entry as Record<string, unknown>;
    const disabled = typeof obj.disabled === "boolean" ? obj.disabled : false;
    const toolAllowlist = Array.isArray(obj.toolAllowlist)
      ? obj.toolAllowlist.filter((v): v is string => typeof v === "string")
      : undefined;

    const transport =
      obj.transport === "stdio" ||
      obj.transport === "http" ||
      obj.transport === "sse" ||
      obj.transport === "auto"
        ? obj.transport
        : undefined;

    const command = typeof obj.command === "string" ? obj.command : undefined;
    const url = typeof obj.url === "string" ? obj.url : undefined;

    const headersRaw = obj.headers;
    let headers: Record<string, string | { secret: string }> | undefined;

    if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
      const next: Record<string, string | { secret: string }> = {};
      for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (typeof v === "string") {
          next[k] = v;
          continue;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const secret = (v as Record<string, unknown>).secret;
          if (typeof secret === "string") {
            next[k] = { secret };
          }
        }
      }
      if (Object.keys(next).length > 0) {
        headers = next;
      }
    }

    // If it has a url, prefer HTTP-based transports (default to auto).
    if (url) {
      const httpTransport = transport && transport !== "stdio" ? transport : "auto";
      return {
        transport: httpTransport,
        url,
        headers,
        disabled,
        toolAllowlist,
      };
    }

    // Otherwise, treat it as stdio.
    return {
      transport: "stdio",
      command: command ?? "",
      disabled,
      toolAllowlist,
    };
  }

  private async readConfigFile(filePath: string): Promise<MCPConfig> {
    try {
      const exists = await this.pathExists(filePath);
      if (!exists) {
        return { servers: {} };
      }

      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = jsonc.parse(raw) as { servers?: Record<string, unknown> } | undefined;

      if (!parsed || typeof parsed !== "object" || !parsed.servers) {
        return { servers: {} };
      }

      // Normalize all entries on read
      const servers: Record<string, MCPServerInfo> = {};
      for (const [name, entry] of Object.entries(parsed.servers)) {
        servers[name] = this.normalizeEntry(entry);
      }
      return { servers };
    } catch (error) {
      // Defensive: never crash on startup due to corrupt config.
      log.error("Failed to read MCP config", { filePath, error });
      return { servers: {} };
    }
  }

  private async getGlobalConfig(): Promise<MCPConfig> {
    return this.readConfigFile(this.getGlobalConfigPath());
  }

  private async getRepoOverrideConfig(projectPath: string): Promise<MCPConfig> {
    for (const filePath of this.getRepoOverridePaths(projectPath)) {
      if (await this.pathExists(filePath)) return this.readConfigFile(filePath);
    }
    return { servers: {} };
  }

  private async saveGlobalConfig(config: MCPConfig): Promise<void> {
    await this.ensureMuxRootDir();

    const filePath = this.getGlobalConfigPath();

    // Write minimal format:
    // - string for stdio servers without extra settings
    // - object when:
    //   - disabled/toolAllowlist set, or
    //   - non-stdio transport, or
    //   - headers present
    //
    // toolAllowlist: undefined = all tools (omit), [] = no tools, [...] = those tools
    const output: Record<string, unknown> = {};

    for (const [name, entry] of Object.entries(config.servers)) {
      const hasSettings = entry.disabled || entry.toolAllowlist !== undefined;

      if (entry.transport === "stdio") {
        if (!hasSettings) {
          output[name] = entry.command;
          continue;
        }

        const obj: Record<string, unknown> = {
          command: entry.command,
        };
        if (entry.disabled) obj.disabled = true;
        if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;
        output[name] = obj;
        continue;
      }

      const obj: Record<string, unknown> = {
        transport: entry.transport,
        url: entry.url,
      };
      if (entry.headers) obj.headers = entry.headers;
      if (entry.disabled) obj.disabled = true;
      if (entry.toolAllowlist !== undefined) obj.toolAllowlist = entry.toolAllowlist;

      output[name] = obj;
    }

    await writeFileAtomic(filePath, JSON.stringify({ servers: output }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    this.globalConfigGeneration += 1;
  }

  /**
   * Incremented after successful global config writes. Prompt paths compare it
   * across refreshes because global mutations do not replace workspace options.
   */
  private globalConfigGeneration = 0;

  get configGeneration(): number {
    return this.globalConfigGeneration;
  }

  /**
   * List configured servers.
   *
   * - When no projectPath is provided: returns global servers from <xumHome>/mcp.jsonc
   * - When projectPath is provided and trusted=false: returns only global servers
   * - When projectPath is provided and trusted=true: merges global + <projectPath>/.xum/mcp.jsonc
   * - Agent Plugins servers (when the experiment provider is wired) are merged
   *   at the lowest precedence: user config always wins on key collisions.
   *
   * `options.agentPlugins` controls plugin discovery: `null` disables it for
   * this call (workspace executes off-host: SSH/devcontainer), an explicit
   * context scans that host checkout, and omitting it defaults to scanning
   * under `projectPath` (project-level flows: Settings, workspace MCP modal).
   */
  async listServers(
    projectPath?: string,
    trusted = false,
    options?: { agentPlugins?: AgentPluginsMcpContext | null }
  ): Promise<Record<string, MCPServerInfo>> {
    const layers = await this.listServerLayers(projectPath, trusted, options);
    // Repo overrides win by server name over global config, which wins over plugin servers.
    return { ...layers.plugin, ...layers.global, ...layers.project };
  }

  /**
   * List configured servers split by config layer (plugin < global < project,
   * later layers win on key collision). Used by listServers and by the plugin
   * composition inspector, which needs shadowed entries too.
   */
  async listServerLayers(
    projectPath?: string,
    trusted = false,
    options?: { agentPlugins?: AgentPluginsMcpContext | null }
  ): Promise<{
    plugin: Record<string, MCPServerInfo>;
    global: Record<string, MCPServerInfo>;
    project: Record<string, MCPServerInfo>;
  }> {
    let pluginServers: Record<string, MCPServerInfo> = {};
    if (this.agentPluginsMcpProvider && options?.agentPlugins !== null) {
      const pluginContext = options?.agentPlugins ?? {
        projectRoot: projectPath,
        projectKey: projectPath,
      };
      try {
        pluginServers = await this.agentPluginsMcpProvider({ ...pluginContext, trusted });
      } catch (error) {
        // Plugin discovery failures must never break MCP config listing.
        log.warn("[MCP] Agent Plugins server discovery failed", { error });
      }
    }

    const globalCfg = await this.getGlobalConfig();
    const globalServers = omitReservedPluginKeys(globalCfg.servers, "global");

    if (!projectPath || !trusted) {
      if (projectPath && !trusted) {
        log.debug("[MCP] Skipping project-local MCP config for untrusted project", { projectPath });
      }
      return { plugin: pluginServers, global: globalServers, project: {} };
    }

    const repoCfg = await this.getRepoOverrideConfig(projectPath);
    return {
      plugin: pluginServers,
      global: globalServers,
      project: omitReservedPluginKeys(repoCfg.servers, "project"),
    };
  }

  async addServer(
    name: string,
    input: {
      transport?: MCPServerTransport;
      command?: string;
      url?: string;
      headers?: Record<string, MCPHeaderValue>;
    }
  ): Promise<Result<void>> {
    if (!name.trim()) {
      return Err("Server name is required");
    }
    if (isCanonicalPluginServerKey(name.trim())) {
      // See omitReservedPluginKeys: a user server on a canonical plugin key
      // would be stripped of its workspace overrides by that plugin's
      // uninstall.
      return Err("Server names of the form 'plugin:<id>:<name>' are reserved for Agent Plugins");
    }

    const transport: MCPServerTransport = input.transport ?? "stdio";

    if (transport === "stdio") {
      if (!input.command?.trim()) {
        return Err("Command is required");
      }
    } else {
      if (!input.url?.trim()) {
        return Err("URL is required");
      }
    }

    const cfg = await this.getGlobalConfig();
    const existing = cfg.servers[name];

    const base = {
      disabled: existing?.disabled ?? false,
      toolAllowlist: existing?.toolAllowlist,
    };

    const next: MCPServerInfo =
      transport === "stdio"
        ? {
            transport: "stdio",
            command: input.command!,
            ...base,
          }
        : {
            transport,
            url: input.url!,
            headers: input.headers,
            ...base,
          };

    cfg.servers[name] = next;

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to save MCP server", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async setServerEnabled(name: string, enabled: boolean): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }
    cfg.servers[name] = { ...entry, disabled: !enabled };
    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server enabled state", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async removeServer(name: string): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    if (!cfg.servers[name]) {
      return Err(`Server ${name} not found`);
    }
    delete cfg.servers[name];
    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to remove MCP server", { name, error });
      return Err(getErrorMessage(error));
    }
  }

  async setToolAllowlist(name: string, toolAllowlist: string[]): Promise<Result<void>> {
    const cfg = await this.getGlobalConfig();
    const entry = cfg.servers[name];
    if (!entry) {
      return Err(`Server ${name} not found`);
    }

    // [] = no tools allowed, [...tools] = those tools allowed
    cfg.servers[name] = {
      ...entry,
      toolAllowlist,
    };

    try {
      await this.saveGlobalConfig(cfg);
      return Ok(undefined);
    } catch (error) {
      log.error("Failed to update MCP server tool allowlist", { name, error });
      return Err(getErrorMessage(error));
    }
  }
}
