import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { createServer } from "http";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  MCP_PROMPT_MAX_ARGUMENTS,
  MCP_PROMPT_MAX_DESCRIPTION_CHARS,
  MCP_PROMPT_MAX_TEXT_BYTES,
  MCP_PROMPT_TRUNCATION_MARKER,
} from "@/common/constants/toolLimits";
import {
  acquirePluginMutationLock,
  MUTATION_EPOCH_UNREADABLE_TOKEN,
} from "@/node/services/agentPlugins/journals";
import { readPluginMcpPolicy } from "./agentPlugins/registry";
import { createTestPluginInstallEntry } from "./agentPlugins/testFixtures";
import type { MCPServerInfo } from "@/common/types/mcp";
import * as mcpSdk from "@/node/services/mcpClient";
import {
  MCPServerManager,
  flattenMcpPrompt,
  isClosedClientError,
  prepareStdioLaunch,
  runMCPToolWithDeadline,
  wrapMCPTools,
  type MCPWorkspaceRequestOptions,
  type MCPServerManagerOptions,
} from "./mcpServerManager";
import { MCPConfigService } from "./mcpConfigService";
import { Config } from "@/node/config";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TelemetryService } from "./telemetryService";
import type { Runtime } from "@/node/runtime/Runtime";
import * as crossProcessLock from "@/node/utils/main/crossProcessLock";
import * as runtimeFactory from "@/node/runtime/runtimeFactory";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { DisposableTempDir } from "@/node/services/tempDir";
import { jsonSchema, type Tool } from "ai";
import {
  MCP_IDLE_CHECK_INTERVAL_MS,
  MCP_IDLE_TIMEOUT_MS,
  MCP_LAUNCH_INITIATION_FENCE_MS,
  MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS,
  MCP_STARTUP_CONCURRENCY,
  MCP_STDIO_LAUNCH_FENCE_MS,
} from "@/constants/mcp";
import { FakeMcpServers, MCP_STARTUP_TIMEOUT_MS } from "./mcpServerManager.testHarness";

const PROJECT_PATH = "/tmp/project";
const WORKSPACE_PATH = "/tmp/workspace";

/** Poll a synchronous predicate until it holds (bounded), yielding real time between checks. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  // performance.now(), not Date.now(): tests freeze the system clock with setSystemTime
  // (e.g. after expireStartupDeadline), which would otherwise make this wait unbounded.
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
// Fake stdio/remote MCP servers behind the real startup path; TEST_RUNTIME
// spawns their processes, so workspace requests can start servers for real.
const servers = new FakeMcpServers();
const TEST_RUNTIME = servers.runtime;

function workspaceRequest(workspaceId: string, options: Record<string, unknown> = {}) {
  return {
    workspaceId,
    projectPath: PROJECT_PATH,
    runtime: TEST_RUNTIME,
    workspacePath: WORKSPACE_PATH,
    ...options,
  };
}

function stdioConfig(command: string, disabled = false) {
  return { transport: "stdio" as const, command, disabled };
}

function testTool(result: unknown = { ok: true }): Tool {
  return { execute: mock(() => Promise.resolve(result)) } as unknown as Tool;
}

/**
 * A timed-out server backs off one startup timeout before its first retry.
 * Bun freezes the clock under setSystemTime, so jump relative to the current
 * reading; afterEach restores real time.
 */
function elapseTimedOutRetryBackoff(): void {
  setSystemTime(new Date(Date.now() + MCP_STARTUP_TIMEOUT_MS));
}

function cachedStats(overrides: Record<string, unknown> = {}) {
  return {
    enabledServerCount: 1,
    startedServerCount: 0,
    failedServerCount: 1,
    autoFallbackCount: 0,
    failedServerNames: ["slow"],
    hasStdio: false,
    hasHttp: false,
    hasSse: false,
    transportMode: "none" as const,
    ...overrides,
  };
}

describe("MCPServerManager", () => {
  let configService: {
    listServers: ReturnType<typeof mock>;
    acquireGlobalPluginEnablementFence: MCPConfigService["acquireGlobalPluginEnablementFence"];
    configGeneration: number;
  };

  let manager: MCPServerManager;

  beforeEach(() => {
    configService = {
      listServers: mock(() => Promise.resolve({})),
      acquireGlobalPluginEnablementFence: () => Promise.resolve(() => Promise.resolve()),
      configGeneration: 0,
    };

    manager = new MCPServerManager(configService as unknown as MCPConfigService);
  });

  afterEach(() => {
    servers.reset();
    manager.dispose();
    setSystemTime();
  });
  test("testForApi resolves global defaults and emits categorized telemetry", async () => {
    using tmp = new DisposableTempDir("mcp-api-test");
    const config = new Config(tmp.path);
    const captured: Array<Parameters<TelemetryService["capture"]>[0]> = [];
    const capture = mock((payload: Parameters<TelemetryService["capture"]>[0]) => {
      captured.push(payload);
    });
    const apiManager = new MCPServerManager(new MCPConfigService(config), {
      config,
      telemetryService: { capture },
    });
    const testServer = spyOn(apiManager, "test").mockResolvedValue({
      success: false,
      error: "ECONNREFUSED",
    });
    try {
      await apiManager.testForApi({ command: "node server.js" });
      expect(testServer).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: tmp.path, trusted: false, projectSecrets: {} })
      );
      expect(captured[0]).toMatchObject({
        event: "mcp_server_tested",
        properties: { error_category: "connect", transport: "stdio" },
      });
    } finally {
      apiManager.dispose();
    }
  });

  test("testForApi resolves project trust from config before delegating", async () => {
    for (const trusted of [true, false]) {
      using tmp = new DisposableTempDir(`mcp-api-trust-${trusted}`);
      const config = new Config(tmp.path);
      const projectPath = path.join(tmp.path, "project");
      await fs.mkdir(projectPath, { recursive: true });
      await config.editConfig((cfg) => {
        cfg.projects.set(projectPath, { trusted, workspaces: [] });
        return cfg;
      });
      const apiConfigService = new MCPConfigService(config);
      const listServers = spyOn(apiConfigService, "listServers").mockResolvedValue({
        "repo-local": { transport: "stdio", command: "echo repo-local", disabled: false },
      });
      const apiManager = new MCPServerManager(apiConfigService, { config });
      const testServer = spyOn(apiManager, "test").mockResolvedValue({
        success: true,
        tools: ["repo_tool"],
      });
      try {
        const result = await apiManager.testForApi(
          { projectPath, name: "repo-local" },
          { includeAgentPlugins: false }
        );
        expect(result).toMatchObject({ success: true, tools: ["repo_tool"] });
        expect(listServers).toHaveBeenCalledWith(projectPath, trusted, expect.anything());
        expect(testServer).toHaveBeenCalledWith(
          expect.objectContaining({ projectPath, trusted, name: "repo-local" })
        );
      } finally {
        apiManager.dispose();
      }
    }
  });

  /** Observables of one fake connection to a component server. */
  interface ComponentClient {
    command: string;
    execute: AsyncMock;
    getPrompt: AsyncMock;
    close: AsyncMock;
  }
  const asyncMock = (impl: (...args: unknown[]) => Promise<unknown>) => mock(impl);
  type AsyncMock = ReturnType<typeof asyncMock>;

  /**
   * Construct a manager and capture its idle sweep, which production reaches
   * only through a one-minute interval armed in the constructor, so tests can
   * run it on demand.
   */
  function constructWithIdleSweep(create: () => MCPServerManager): {
    instance: MCPServerManager;
    sweepIdle: () => void;
  } {
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    let instance: MCPServerManager;
    let sweep: unknown;
    try {
      instance = create();
      sweep = setIntervalSpy.mock.calls.find(
        ([, delay]) => delay === MCP_IDLE_CHECK_INTERVAL_MS
      )?.[0];
    } finally {
      setIntervalSpy.mockRestore();
    }
    if (typeof sweep !== "function") throw new Error("idle sweep interval was not armed");
    return { instance, sweepIdle: sweep as () => void };
  }

  async function componentFixture(home: string) {
    await fs.mkdir(path.join(home, "plugins"), { recursive: true });
    const registryPath = path.join(home, "plugins.json");
    const write = async (names: string[]) => {
      const release = await acquirePluginMutationLock(home, { timeoutMs: 5000 });
      try {
        await fs.writeFile(
          `${registryPath}.tmp`,
          JSON.stringify({
            plugins: [createTestPluginInstallEntry("demo", { skills: [], mcpServers: names })],
          })
        );
        await fs.rename(`${registryPath}.tmp`, registryPath);
      } finally {
        await release();
      }
    };
    await write(["remove", "keep"]);
    const configs: Record<string, MCPServerInfo> = { ordinary: stdioConfig("ordinary") };
    for (const name of ["remove", "keep", "added"]) {
      configs[`plugin:instance:${name}`] = {
        ...stdioConfig(name),
        env: { PLUGIN_DATA: path.join(home, "data", name) },
        plugin: {
          pluginName: "demo",
          serverName: name,
          sourceScope: "global",
          sourceLocation: "plugins/demo",
          componentPolicy: { registryPath, name: "demo" },
        },
      };
    }
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const read = mock(() => readPluginMcpPolicy(registryPath));
    // Every connection to a fake component server records fresh observable
    // mocks (its echo tool, review prompt and close). `onConnect` runs before
    // the connection resolves: it may reshape those mocks, gate the startup,
    // or make the connection hang.
    const connections: ComponentClient[] = [];
    const serve = (
      command: string,
      onConnect?: (
        client: ComponentClient,
        attempt: number
      ) => void | { hang: true } | Promise<void | { hang: true }>
    ) =>
      servers.serve(command, async (attempt) => {
        const client: ComponentClient = {
          command,
          execute: asyncMock(() => Promise.resolve({ ok: true })),
          getPrompt: asyncMock(() =>
            Promise.resolve({
              messages: [{ role: "user", content: { type: "text", text: "review" } }],
            })
          ),
          close: asyncMock(() => Promise.resolve(undefined)),
        };
        connections.push(client);
        const override = await onConnect?.(client, attempt);
        return {
          tools: { echo: { execute: client.execute } as unknown as Tool },
          prompts: [{ name: "review" }],
          getPrompt: client.getPrompt,
          close: client.close,
          ...override,
        };
      });
    for (const command of ["ordinary", "remove", "keep", "added"]) serve(command);
    /** Connections to `command`'s server, oldest first. */
    const clients = (command: string) => connections.filter((c) => c.command === command);
    const makeManager = () => {
      // WORKAROUND for pre-existing production behavior (#4513):
      // the real component try-lock is the exclusive, timeout-0 plugin
      // mutation lock, exclusive even in-process and held through each launch,
      // so sibling managed launches in one process fail closed ("unavailable
      // ...; retry"). The old startSingleServer stub hid this. Queue this
      // manager's own admissions; other holders still hit the fail-closed path.
      let admissions = Promise.resolve();
      const invalidation: NonNullable<MCPServerManagerOptions["pluginInvalidation"]> = {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(undefined),
        readComponentPolicy: read,
        tryAcquireComponentPolicyLock: async (options) => {
          const previous = admissions;
          const turn = Promise.withResolvers<void>();
          admissions = turn.promise;
          await previous;
          try {
            const release = await acquirePluginMutationLock(home, { timeoutMs: 0, ...options });
            return async () => {
              try {
                await release();
              } finally {
                turn.resolve();
              }
            };
          } catch (error) {
            turn.resolve();
            throw error;
          }
        },
      };
      const { instance, sweepIdle } = constructWithIdleSweep(
        () =>
          new MCPServerManager(configService as unknown as MCPConfigService, {
            pluginInvalidation: invalidation,
          })
      );
      return { instance, invalidation, sweepIdle };
    };
    manager.dispose();
    const local = makeManager();
    manager = local.instance;
    return {
      ...local,
      registryPath,
      write,
      configs,
      read,
      makeManager,
      serve,
      connections,
      clients,
      /** The first connection to `command`'s server. */
      client: (command: string) => clients(command)[0],
    };
  }

  /** Name of the tool `result` routes to `serverName`. */
  const toolFor = (result: { toolServerNames: Record<string, string> }, serverName: string) => {
    const toolName = Object.keys(result.toolServerNames).find(
      (key) => result.toolServerNames[key] === serverName
    );
    expect(toolName).toBeDefined();
    return toolName!;
  };

  /**
   * Make the next instance `target` starts for `name` reject close while
   * `failing()` holds (its fake client close still runs and is counted).
   */
  const failNextInstanceClose = (
    target: MCPServerManager,
    name: string,
    failing: () => boolean,
    message = `${name} close failed`
  ) => {
    type Start = (
      serverName: string,
      ...rest: unknown[]
    ) => Promise<{ close: () => Promise<void> } | null>;
    const internals = target as unknown as { startSingleServer: Start };
    const start = internals.startSingleServer.bind(target);
    let wrapped = false;
    // Private call: real instances swallow client close errors (they only log
    // them), so a failed retirement is reachable only by wrapping an instance.
    internals.startSingleServer = async (serverName, ...rest) => {
      const instance = await start(serverName, ...rest);
      if (serverName === name && instance !== null && !wrapped) {
        wrapped = true;
        const close = instance.close;
        instance.close = async () => {
          await close();
          if (failing()) throw new Error(message);
        };
      }
      return instance;
    };
  };

  test.each([false, true])(
    "component removal preserves sibling identity (leased: %s)",
    async (leased) => {
      using tmp = new DisposableTempDir("mcp-components");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("components");
      const before = await manager.getToolsForWorkspace(request);
      const removed = f.client("remove");
      if (leased) manager.acquireLease(request.workspaceId);
      await f.write(["keep"]);
      await manager.reconcilePluginComponents();
      const after = await manager.getToolsForWorkspace(request);
      expect(Object.values(after.toolServerNames).sort()).toEqual([
        "ordinary",
        "plugin:instance:keep",
      ]);
      expect(after.stats.enabledServerCount).toBe(2);
      expect(after.stats.failedServerNames).not.toContain("plugin:instance:remove");
      // Retained siblings keep serving through their original connections.
      for (const [serverName, command] of [
        ["ordinary", "ordinary"],
        ["plugin:instance:keep", "keep"],
      ]) {
        await after.tools[toolFor(after, serverName)].execute!(
          {},
          { toolCallId: "retained", messages: [], context: {} }
        );
        expect(f.clients(command)).toHaveLength(1);
        expect(f.client(command).execute).toHaveBeenCalledTimes(1);
        expect(f.client(command).close).not.toHaveBeenCalled();
      }
      const toolName = toolFor(before, "plugin:instance:remove");
      expect(
        before.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
      ).rejects.toThrow(/disabled|unavailable/);
      expect(
        manager.getPrompt(request.workspaceId, "plugin:instance:remove", "review", {})
      ).rejects.toThrow();
      expect(removed.execute).not.toHaveBeenCalled();
      if (leased) {
        expect(removed.close).not.toHaveBeenCalled();
        manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
      expect(removed.close).toHaveBeenCalledTimes(1);
      expect(f.connections).toHaveLength(3);
      // The removal left no enabled or timed-out retry candidate behind.
      elapseTimedOutRetryBackoff();
      await manager.getToolsForWorkspace(request);
      expect(f.connections).toHaveLength(3);
    }
  );

  test.each([false, true])(
    "component cleanup failures remain retryable without blocking retained clients (readd: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-component-cleanup-retry");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("cleanup-retry");
      const key = "plugin:instance:remove";
      let failClose = true;
      failNextInstanceClose(manager, key, () => failClose, "removed client close failed");
      const served = await manager.getToolsForWorkspace(request);
      const removed = f.client("remove");
      await f.write(["keep"]);
      const error: unknown = await manager
        .reconcilePluginComponents()
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("removed client close failed");
      const after = await manager.getToolsForWorkspace(request);
      expect(Object.values(after.toolServerNames).sort()).toEqual([
        "ordinary",
        "plugin:instance:keep",
      ]);
      // The failed retirement stayed owned: the next serve retried its close.
      expect(removed.close.mock.calls.length).toBeGreaterThan(1);
      const heldError: unknown = await Promise.resolve(
        served.tools[toolFor(served, key)].execute!(
          {},
          { toolCallId: "removed", messages: [], context: {} }
        )
      ).catch((error: unknown) => error);
      expect(heldError).toBeInstanceOf(Error);
      expect(removed.execute).not.toHaveBeenCalled();
      if (readd) {
        await f.write(["keep", "remove"]);
        const readded = await manager.getToolsForWorkspace(request);
        // The readd connects a replacement instead of reviving the retired client.
        expect(f.clients("remove")).toHaveLength(2);
        await readded.tools[toolFor(readded, key)].execute!(
          {},
          { toolCallId: "readded", messages: [], context: {} }
        );
        expect(f.clients("remove")[1].execute).toHaveBeenCalledTimes(1);
        expect(removed.execute).not.toHaveBeenCalled();
      }
      failClose = false;
      const attempts = removed.close.mock.calls.length;
      await manager.getToolsForWorkspace(request);
      expect(removed.close).toHaveBeenCalledTimes(attempts + 1);
      // Retirement finished: nothing is left for a later cleanup to close.
      await manager.reconcilePluginComponents();
      expect(removed.close).toHaveBeenCalledTimes(attempts + 1);
      for (const command of ["ordinary", "keep"]) {
        expect(f.clients(command)).toHaveLength(1);
        expect(f.client(command).close).not.toHaveBeenCalled();
      }
      if (readd) expect(f.clients("remove")[1].close).not.toHaveBeenCalled();
    }
  );

  test.each([false, true])(
    "prefix stops include retired leased clients without reviving removals (readd: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-retired-prefix");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("retired-prefix");
      const key = "plugin:instance:remove";
      const first = await manager.getToolsForWorkspace(request);
      const removed = f.client("remove");
      manager.acquireLease(request.workspaceId);
      try {
        await f.write(["keep"]);
        await manager.getToolsForWorkspace(request);
        if (readd) {
          await f.write(["keep", "remove"]);
          await manager.getToolsForWorkspace(request);
        }
        // Leased: the removed client is retired, not yet closed.
        expect(removed.close).not.toHaveBeenCalled();
        await manager.stopServersWithKeyPrefix(key);
        expect(removed.close).toHaveBeenCalledTimes(1);
        for (const command of ["ordinary", "keep"]) {
          expect(f.clients(command)).toHaveLength(1);
          expect(f.client(command).close).not.toHaveBeenCalled();
        }
        // Only a readded server is scheduled to restart on next use.
        const next = await manager.getToolsForWorkspace(request);
        expect(Object.values(next.toolServerNames).includes(key)).toBe(readd);
        expect(f.clients("remove")).toHaveLength(readd ? 3 : 1);
        if (!readd) {
          const error: unknown = await Promise.resolve(
            first.tools[toolFor(first, key)].execute!(
              {},
              { toolCallId: "stopped", messages: [], context: {} }
            )
          ).catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(removed.execute).not.toHaveBeenCalled();
        }
      } finally {
        manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
      // The stop consumed the retirement: release closes nothing twice.
      expect(removed.close).toHaveBeenCalledTimes(1);
    }
  );

  test("idle cleanup retries retired-only failures without another MCP request", async () => {
    using tmp = new DisposableTempDir("mcp-retired-idle");
    const f = await componentFixture(tmp.path);
    delete f.configs.ordinary;
    const request = workspaceRequest("retired-idle");
    let fail = true;
    failNextInstanceClose(manager, "plugin:instance:remove", () => fail);
    await manager.getToolsForWorkspace(request);
    const removed = f.client("remove");
    await f.write([]);
    await manager.reconcilePluginComponents().catch(() => undefined);
    // No live instance remains; only the failed retirement is still owned.
    expect(f.client("keep").close).toHaveBeenCalledTimes(1);
    expect(removed.close).toHaveBeenCalledTimes(1);
    for (const shouldFail of [true, false]) {
      fail = shouldFail;
      const attempts = removed.close.mock.calls.length;
      // The sweep reads the clock synchronously: make the workspace look idle.
      setSystemTime(new Date(Date.now() + MCP_IDLE_TIMEOUT_MS + 60_000));
      f.sweepIdle();
      setSystemTime();
      await waitFor(() => removed.close.mock.calls.length > attempts);
      expect(removed.close).toHaveBeenCalledTimes(attempts + 1);
    }
    // Retirement finished: nothing is left for a later cleanup to close.
    const attempts = removed.close.mock.calls.length;
    await manager.reconcilePluginComponents();
    expect(removed.close).toHaveBeenCalledTimes(attempts);
  });

  test.each(["stdio", "http", "sse", "auto"] as const)(
    "named Test connection rechecks current policy before %s launch",
    async (transport) => {
      using tmp = new DisposableTempDir("mcp-named-test-policy");
      const f = await componentFixture(tmp.path);
      const key = "plugin:instance:remove";
      const plugin = f.configs[key].plugin;
      f.configs[key] =
        transport === "stdio"
          ? {
              ...stdioConfig("removed"),
              plugin,
              env: { PLUGIN_DATA: path.join(tmp.path, "data") },
            }
          : { transport, url: "https://mcp.example.test/removed", disabled: false, plugin };
      configService.listServers.mockImplementation(async () => {
        const snapshot = { ...f.configs };
        await f.write(["keep"]);
        return snapshot;
      });
      const exec = mock(() => Promise.reject(new Error("launch reached")));
      const runtime = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
        exec,
      } as unknown as Runtime);
      const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
        Promise.reject(new Error("connection reached"))
      );
      try {
        const named = await manager.test({ projectPath: tmp.path, name: key });
        expect(named.success).toBe(false);
        if (named.success) throw new Error("Expected revoked named test to fail");
        expect(named.error).toMatch(/disabled|unavailable/);
        expect(exec).not.toHaveBeenCalled();
        expect(client).not.toHaveBeenCalled();
        f.read.mockClear();
        // Explicit user drafts are not managed descriptors, even when their name matches.
        await manager.test({
          projectPath: tmp.path,
          name: key,
          ...(transport === "stdio"
            ? { command: "draft" }
            : { transport, url: "https://mcp.example.test/draft" }),
        });
        expect(transport === "stdio" ? exec : client).toHaveBeenCalledTimes(1);
        expect(f.read).not.toHaveBeenCalled();
        exec.mockClear();
        client.mockClear();
        delete f.configs[key].plugin!.componentPolicy;
        await manager.test({ projectPath: tmp.path, name: key });
        expect(transport === "stdio" ? exec : client).toHaveBeenCalledTimes(1);
        expect(f.read).not.toHaveBeenCalled();
      } finally {
        runtime.mockRestore();
        client.mockRestore();
      }
    }
  );

  /** Leave only `key` configured, so a serve's launch fences belong to it alone. */
  const onlyServer = (configs: Record<string, MCPServerInfo>, key: string, info = configs[key]) => {
    for (const name of Object.keys(configs)) delete configs[name];
    configs[key] = info;
  };

  test.each(["stdio", "http", "sse", "auto"] as const)(
    "normal %s startup rechecks components after waiting for the override fence",
    async (transport) => {
      using tmp = new DisposableTempDir("mcp-start-component-fence");
      const f = await componentFixture(tmp.path);
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      let removeAtFence = false;
      let overrideHeld = false;
      f.invalidation.acquireOverridesLock = async () => {
        if (removeAtFence) await f.write(["keep"]);
        overrideHeld = true;
        return () => {
          overrideHeld = false;
          return Promise.resolve();
        };
      };
      await manager.getToolsForWorkspace(workspaceRequest("startup-baseline"));
      removeAtFence = true;
      const key = "plugin:instance:remove";
      const url = "https://mcp.example.test";
      servers.serve(url);
      onlyServer(
        f.configs,
        key,
        transport === "stdio"
          ? f.configs[key]
          : { transport, url, disabled: false, plugin: f.configs[key].plugin }
      );
      servers.exec.mockClear();
      const served = await manager.getToolsForWorkspace(workspaceRequest("startup-fence"));
      // The removal committed while the launch waited for the fence: it never
      // spawns or connects, and the retried serve no longer enables it.
      expect(Object.keys(served.tools)).toEqual([]);
      expect(servers.exec).not.toHaveBeenCalled();
      expect(servers.connectCount(url)).toBe(0);
      expect(overrideHeld).toBe(false);
    }
  );

  test.each([false, true])(
    "normal startup fails closed on component writer contention (overrides tracked: %s)",
    async (trackOverrides) => {
      using tmp = new DisposableTempDir("mcp-start-component-contention");
      const f = await componentFixture(tmp.path);
      let overrideHeld = false;
      if (trackOverrides) {
        f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
        f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
        f.invalidation.acquireOverridesLock = () => {
          overrideHeld = true;
          return Promise.resolve(() => {
            overrideHeld = false;
            return Promise.resolve();
          });
        };
      }
      await manager.getToolsForWorkspace(workspaceRequest("contention-baseline"));
      const key = "plugin:instance:remove";
      onlyServer(f.configs, key);
      servers.exec.mockClear();
      const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
      try {
        const served = await manager.getToolsForWorkspace(workspaceRequest("contention"));
        expect(served.stats.failedServerNames).toEqual([key]);
        expect(servers.exec).not.toHaveBeenCalled();
        // Uninstall can now prune overrides without waiting on this startup.
        expect(overrideHeld).toBe(false);
      } finally {
        await release();
      }
      await f.write(["keep"]);
      const served = await manager.getToolsForWorkspace(workspaceRequest("contention-removed"));
      expect(served.stats.failedServerNames).toEqual([]);
      expect(servers.exec).not.toHaveBeenCalled();
    }
  );

  test("normal auto startup rechecks components before its SSE fallback", async () => {
    using tmp = new DisposableTempDir("mcp-fallback-component-fence");
    const f = await componentFixture(tmp.path);
    f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
    f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    const url = "https://mcp.example.test";
    // Streamable HTTP is refused, so auto falls back to SSE on the same URL.
    servers.serve(url, {
      connect: () =>
        Promise.reject(Object.assign(new Error("HTTP not supported"), { status: 404 })),
    });
    f.invalidation.acquireOverridesLock = async () => {
      if (servers.connectCount(url) > 0) await f.write(["keep"]);
      return () => Promise.resolve();
    };
    await manager.getToolsForWorkspace(workspaceRequest("fallback-baseline"));
    const key = "plugin:instance:remove";
    onlyServer(f.configs, key, {
      transport: "auto",
      url,
      disabled: false,
      plugin: f.configs[key].plugin,
    });
    const served = await manager.getToolsForWorkspace(workspaceRequest("fallback"));
    // The HTTP attempt connected; the SSE fallback was refused at its fence.
    expect(servers.connectCount(url)).toBe(1);
    expect(Object.keys(served.tools)).toEqual([]);
  });

  test("component policy rejects a held tool in a second manager without local notification", async () => {
    using tmp = new DisposableTempDir("mcp-components-sibling");
    const f = await componentFixture(tmp.path);
    const sibling = f.makeManager();
    try {
      const request = workspaceRequest("sibling");
      const served = await sibling.instance.getToolsForWorkspace(request);
      const removed = f.client("remove");
      const toolName = toolFor(served, "plugin:instance:remove");
      await f.write(["keep"]);
      await manager.reconcilePluginComponents();
      expect(removed.close).not.toHaveBeenCalled();
      expect(
        served.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
      ).rejects.toThrow(/disabled|unavailable/);
      expect(removed.execute).not.toHaveBeenCalled();
      expect(removed.close).toHaveBeenCalledTimes(1);
      for (const client of f.connections.filter((c) => c !== removed))
        expect(client.close).not.toHaveBeenCalled();
    } finally {
      sibling.instance.dispose();
    }
  });

  test("component mixed equal-count selection and rapid readd do not restart retained clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-mixed");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("mixed");
    await manager.getToolsForWorkspace(request);
    const retained = [f.client("ordinary"), f.client("keep")];
    await f.write(["keep", "added"]);
    const after = await manager.getToolsForWorkspace(request);
    expect(Object.values(after.toolServerNames).sort()).toEqual([
      "ordinary",
      "plugin:instance:added",
      "plugin:instance:keep",
    ]);
    expect(f.connections).toHaveLength(4);
    await f.write([]);
    await f.write(["keep", "added"]);
    await manager.reconcilePluginComponents();
    await manager.getToolsForWorkspace(request);
    expect(f.connections).toHaveLength(4);
    for (const client of retained) expect(client.close).not.toHaveBeenCalled();
  });

  test("component readd under an active lease closes only the retired client on release", async () => {
    using tmp = new DisposableTempDir("mcp-components-leased-readd");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("leased-readd");
    await manager.getToolsForWorkspace(request);
    manager.acquireLease(request.workspaceId);
    const key = "plugin:instance:remove";
    const old = f.client("remove");
    await f.write(["keep"]);
    await manager.getToolsForWorkspace(request);
    await f.write(["keep", "remove"]);
    const result = await manager.getToolsForWorkspace(request);
    expect(Object.values(result.toolServerNames)).toContain(key);
    // The readd connects a replacement instead of reviving the retired client.
    expect(f.clients("remove")).toHaveLength(2);
    const replacement = f.clients("remove")[1];
    expect(old.close).not.toHaveBeenCalled();
    manager.releaseLease(request.workspaceId);
    await manager.reconcilePluginComponents();
    expect(old.close).toHaveBeenCalledTimes(1);
    for (const client of f.connections.filter((c) => c !== old))
      expect(client.close).not.toHaveBeenCalled();
    // The replacement stays the live instance.
    const served = await manager.getToolsForWorkspace(request);
    await served.tools[toolFor(served, key)].execute!(
      {},
      { toolCallId: "replacement", messages: [], context: {} }
    );
    expect(replacement.execute).toHaveBeenCalledTimes(1);
    expect(old.execute).not.toHaveBeenCalled();
    expect(f.clients("remove")).toHaveLength(2);
  });

  test("component cleanup permits an already admitted leased invocation to finish", async () => {
    using tmp = new DisposableTempDir("mcp-components-admitted");
    const f = await componentFixture(tmp.path);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const request = workspaceRequest("admitted");
    const first = await manager.getToolsForWorkspace(request);
    const removed = f.client("remove");
    removed.execute.mockImplementation(() => {
      entered.resolve();
      return finish.promise;
    });
    const toolName = toolFor(first, "plugin:instance:remove");
    manager.acquireLease(request.workspaceId);
    const pending: unknown = first.tools[toolName].execute!(
      {},
      { toolCallId: "admitted", messages: [], context: {} }
    );
    await entered.promise;
    await f.write(["keep"]);
    await manager.reconcilePluginComponents();
    finish.resolve("finished");
    expect(await pending).toBe("finished");
    manager.releaseLease(request.workspaceId);
    await manager.reconcilePluginComponents();
    expect(removed.close).toHaveBeenCalledTimes(1);
  });

  test("component authorization reads current policy after a slow override fence", async () => {
    using tmp = new DisposableTempDir("mcp-components-final-gate");
    const f = await componentFixture(tmp.path);
    let removeAtFence = false;
    const invalidation = f.invalidation;
    invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    invalidation.readOverridesEpoch = () => Promise.resolve("stable");
    invalidation.acquireOverridesLock = async () => {
      if (removeAtFence) await f.write(["keep"]);
      return () => Promise.resolve();
    };
    const request = workspaceRequest("final-gate");
    const first = await manager.getToolsForWorkspace(request);
    removeAtFence = true;
    const toolName = toolFor(first, "plugin:instance:remove");
    expect(
      first.tools[toolName].execute!({}, { toolCallId: "held", messages: [], context: {} })
    ).rejects.toThrow(/disabled|unavailable/);
    expect(f.client("remove").execute).not.toHaveBeenCalled();
  });

  test.each(["tool", "prompt", "test"] as const)(
    "managed %s admission fails closed without its writer fence",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-missing-fence");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("missing-fence");
      const served = await manager.getToolsForWorkspace(request);
      delete f.invalidation.tryAcquireComponentPolicyLock;
      const key = "plugin:instance:remove";
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === key
      )!;
      const exec = mock(() => Promise.reject(new Error("launch reached")));
      const runtime = spyOn(runtimeFactory, "createRuntime").mockReturnValue({
        exec,
      } as unknown as Runtime);
      try {
        if (operation === "test") {
          const result = await manager.test({ projectPath: tmp.path, name: key });
          expect(result.success).toBe(false);
          if (result.success) throw new Error("Expected missing fence to deny the test");
          expect(result.error).toMatch(/unavailable/);
          expect(exec).not.toHaveBeenCalled();
        } else {
          const pending: unknown =
            operation === "tool"
              ? served.tools[toolName].execute!(
                  {},
                  { toolCallId: "missing-fence", messages: [], context: {} }
                )
              : manager.getPrompt(request.workspaceId, key, "review", {});
          expect(Promise.resolve(pending)).rejects.toThrow(/unavailable/);
          const client = f.client("remove");
          expect(client.execute).not.toHaveBeenCalled();
          expect(client.getPrompt).not.toHaveBeenCalled();
        }
        const ordinary = Object.keys(served.toolServerNames).find(
          (name) => served.toolServerNames[name] === "ordinary"
        )!;
        await served.tools[ordinary].execute!(
          {},
          { toolCallId: "ordinary", messages: [], context: {} }
        );
        expect(f.client("ordinary").execute).toHaveBeenCalledTimes(1);
      } finally {
        runtime.mockRestore();
      }
    }
  );

  test.each(["tool", "prompt"] as const)(
    "%s admission holds the writer lock before opening the final policy inode",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-inode");
      const f = await componentFixture(tmp.path);
      const overrides = new WorkspaceMcpOverridesService(new Config(tmp.path));
      let overrideHeld = false;
      let pluginHeld = false;
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      f.invalidation.acquireOverridesLock = async (options) => {
        const release = await overrides.acquireExclusiveLock(options);
        overrideHeld = true;
        return async () => {
          await release();
          overrideHeld = false;
        };
      };
      f.invalidation.tryAcquireComponentPolicyLock = async (options) => {
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0, ...options });
        pluginHeld = true;
        return async () => {
          await release();
          pluginHeld = false;
        };
      };
      const dispatched = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const request = workspaceRequest("inode");
      const served = await manager.getToolsForWorkspace(request);
      const dispatch = () => {
        expect(pluginHeld).toBe(true);
        expect(overrideHeld).toBe(true);
        dispatched.resolve();
        return finish.promise;
      };
      f.client("remove").execute.mockImplementation(() => dispatch().then(() => "ok"));
      f.client("remove").getPrompt.mockImplementation(() =>
        dispatch().then(() => ({
          messages: [{ role: "user", content: { type: "text", text: "ok" } }],
        }))
      );
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === "plugin:instance:remove"
      )!;
      const opened = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const readFile = fs.readFile;
      let intercept = true;
      const readSpy = spyOn(fs, "readFile").mockImplementation((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        if (intercept && overrideHeld && args[0] === f.registryPath) {
          intercept = false;
          const handle = await fs.open(f.registryPath, "r");
          try {
            opened.resolve();
            await resume.promise;
            return await handle.readFile("utf8");
          } finally {
            await handle.close();
          }
        }
        return readFile(...args);
      }) as typeof fs.readFile);
      const pending = Promise.resolve(
        operation === "tool"
          ? served.tools[toolName].execute!({}, { toolCallId: "inode", messages: [], context: {} })
          : manager.getPrompt(request.workspaceId, "plugin:instance:remove", "review", {})
      );
      const settled = pending.catch((error: unknown) => error);
      let writer: Promise<void> | undefined;
      try {
        await opened.promise;
        expect(pluginHeld).toBe(true);
        expect(acquirePluginMutationLock(tmp.path, { timeoutMs: 0 })).rejects.toThrow();
        writer = f.write(["keep"]);
        resume.resolve();
        await dispatched.promise;
        await writer;
        const releaseOverride = await overrides.acquireExclusiveLock({ timeoutMs: 1000 });
        await releaseOverride();
        expect(pluginHeld).toBe(false);
        expect(overrideHeld).toBe(false);
        finish.resolve();
        if (operation === "tool") expect(await settled).toBe("ok");
        else expect(await settled).toBeInstanceOf(Error);
      } finally {
        resume.resolve();
        finish.resolve();
        await settled;
        await writer;
        readSpy.mockRestore();
      }
    }
  );

  test.each(["tool", "prompt"] as const)(
    "%s contention releases overrides so a plugin writer can prune",
    async (operation) => {
      using tmp = new DisposableTempDir("mcp-components-writer-wins");
      const f = await componentFixture(tmp.path);
      const key = "plugin:0123456789abcdef:remove";
      f.configs[key] = f.configs["plugin:instance:remove"];
      delete f.configs["plugin:instance:remove"];
      const config = new Config(tmp.path);
      const workspacePath = path.join(tmp.path, "checkout");
      const workspaceId = "writer-wins";
      await fs.mkdir(workspacePath);
      await config.editConfig((current) => {
        current.projects.set(workspacePath, {
          workspaces: [
            {
              path: workspacePath,
              id: workspaceId,
              name: workspaceId,
              runtimeConfig: { type: "local" },
            },
          ],
        });
        return current;
      });
      const overrides = new WorkspaceMcpOverridesService(config);
      await overrides.setOverridesForWorkspace(workspaceId, {
        enabledServers: [key, "ordinary"],
      });
      let releaseWriter: (() => Promise<void>) | undefined;
      let prune: ReturnType<typeof overrides.prunePluginOverrideKeysForWorkspaces> | undefined;
      let overrideReleases = 0;
      f.invalidation.readOverridesEpoch = () => Promise.resolve("stable");
      f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
      f.invalidation.acquireOverridesLock = (options) => overrides.acquireExclusiveLock(options);
      const request = workspaceRequest(workspaceId);
      const served = await manager.getToolsForWorkspace(request);
      const toolName = toolFor(served, key);
      // Only the invocation below races the installer; startup launched cleanly.
      f.invalidation.acquireOverridesLock = async (options) => {
        const release = await overrides.acquireExclusiveLock(options);
        // The installer wins the plugin lock after preflight; pruning then waits
        // for the invocation's override fence, the former O -> P -> O cycle.
        releaseWriter = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        prune = overrides.prunePluginOverrideKeysForWorkspaces(
          [workspaceId],
          "plugin:0123456789abcdef:"
        );
        return async () => {
          overrideReleases++;
          await release();
        };
      };
      try {
        const pending: unknown =
          operation === "tool"
            ? served.tools[toolName].execute!(
                {},
                { toolCallId: "writer", messages: [], context: {} }
              )
            : manager.getPrompt(workspaceId, key, "review", {});
        expect(Promise.resolve(pending)).rejects.toThrow(/unavailable.*retry/);
        expect(overrideReleases).toBe(1);
        expect(await prune).toEqual([]);
        expect(
          (await overrides.getOverridesForWorkspace(workspaceId)).overrides.enabledServers
        ).toEqual(["ordinary"]);
        const client = f.client("remove");
        expect(client.execute).not.toHaveBeenCalled();
        expect(client.getPrompt).not.toHaveBeenCalled();
      } finally {
        await releaseWriter?.();
        await prune;
      }
    }
  );

  test.each(
    (["tool", "prompt"] as const).flatMap((operation) =>
      (["read-error", "read-abort", "read-timeout", "late-acquisition"] as const).map(
        (failure) => ({ operation, failure })
      )
    )
  )(
    "$operation component fence releases exactly once on $failure without late dispatch",
    async ({ operation, failure }) => {
      using tmp = new DisposableTempDir("mcp-components-release");
      const f = await componentFixture(tmp.path);
      const request = workspaceRequest("release");
      const served = await manager.getToolsForWorkspace(request);
      const key = "plugin:instance:remove";
      const toolName = Object.keys(served.toolServerNames).find(
        (name) => served.toolServerNames[name] === key
      )!;
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const resumeAcquisition = Promise.withResolvers<void>();
      const resumeRead = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let inFence = false;
      let releaseCount = 0;
      const now = spyOn(Date, "now");
      f.invalidation.tryAcquireComponentPolicyLock = async () => {
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        inFence = true;
        if (failure === "late-acquisition") {
          entered.resolve();
          await resumeAcquisition.promise;
        }
        return async () => {
          releaseCount++;
          await release();
          released.resolve();
        };
      };
      f.read.mockImplementation(async () => {
        if (inFence) {
          entered.resolve();
          if (failure === "read-error") throw new Error("final policy read failed");
          if (failure === "read-timeout") now.mockReturnValue(Date.now() + 60_000);
          if (failure === "read-abort" || failure === "read-timeout") await resumeRead.promise;
        }
        return readPluginMcpPolicy(f.registryPath);
      });
      const pending = Promise.resolve(
        operation === "tool"
          ? served.tools[toolName].execute!(
              {},
              { toolCallId: "release", messages: [], context: {}, abortSignal: controller.signal }
            )
          : manager.getPrompt(request.workspaceId, key, "review", {}, { signal: controller.signal })
      );
      const rejected = pending.catch((error: unknown) => error);
      try {
        await entered.promise;
        if (failure === "read-abort" || failure === "late-acquisition") controller.abort();
        expect(await rejected).toBeInstanceOf(Error);
        resumeAcquisition.resolve();
        await released.promise;
        resumeRead.resolve();
        expect(releaseCount).toBe(1);
        const release = await acquirePluginMutationLock(tmp.path, { timeoutMs: 0 });
        await release();
        const client = f.client("remove");
        expect(client.execute).not.toHaveBeenCalled();
        expect(client.getPrompt).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
        resumeAcquisition.resolve();
        resumeRead.resolve();
        await rejected;
      }
    }
  );

  test("unavailable component reader fails closed only for managed clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-reader");
    const f = await componentFixture(tmp.path);
    const request = workspaceRequest("reader");
    await manager.getToolsForWorkspace(request);
    f.read.mockImplementation(() => Promise.reject(new Error("home unavailable")));
    const result = await manager.getToolsForWorkspace(request);
    expect(Object.values(result.toolServerNames)).toEqual(["ordinary"]);
    expect(f.client("ordinary").close).not.toHaveBeenCalled();
  });

  test("component removal drops failed startup retry candidates", async () => {
    using tmp = new DisposableTempDir("mcp-components-retries");
    const f = await componentFixture(tmp.path);
    const removed = "plugin:instance:remove";
    f.serve("remove", (_client, attempt) => (attempt === 1 ? { hang: true } : undefined));
    const request = workspaceRequest("retries");
    const first = await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(first.stats.failedServerNames).toContain(removed);
    await f.write(["keep"]);
    await manager.reconcilePluginComponents();
    // Private read: retries re-filter by enabled servers, so a stale timed-out
    // candidate has no public effect; this pins the removal's own cleanup
    // (no other test catches dropping that filter).
    const entry = (
      manager as unknown as { workspaceServers: Map<string, { timedOutServerNames: string[] }> }
    ).workspaceServers.get(request.workspaceId);
    // Only the removed name: a queued sibling admission can also reach the
    // fake-timer deadline, and a timed-out allowed server stays retryable.
    expect(entry?.timedOutServerNames).not.toContain(removed);
    elapseTimedOutRetryBackoff();
    const result = await manager.getToolsForWorkspace(request);
    expect(result.stats.failedServerNames).not.toContain(removed);
    // The removed server's timed-out startup is never retried.
    expect(servers.connectCount("remove")).toBe(1);
    // A readd starts it fresh, with no stale retry backoff carried over.
    await f.write(["keep", "remove"]);
    const readded = await manager.getToolsForWorkspace(request);
    expect(Object.values(readded.toolServerNames)).toContain(removed);
    expect(servers.connectCount("remove")).toBe(2);
  });

  test("component owner retarget denies old tools without affecting unrelated clients", async () => {
    using tmp = new DisposableTempDir("mcp-components-owner");
    const f = await componentFixture(path.join(tmp.path, "old"));
    const next = path.join(tmp.path, "new");
    await fs.mkdir(path.join(next, "plugins"), { recursive: true });
    await fs.writeFile(path.join(next, "plugins.json"), await fs.readFile(f.registryPath));
    const request = workspaceRequest("owner");
    const first = await manager.getToolsForWorkspace(request);
    f.read.mockImplementation(() => readPluginMcpPolicy(path.join(next, "plugins.json")));
    const toolName = toolFor(first, "plugin:instance:remove");
    expect(
      first.tools[toolName].execute!({}, { toolCallId: "owner", messages: [], context: {} })
    ).rejects.toThrow(/disabled|unavailable/);
    expect(f.client("ordinary").close).not.toHaveBeenCalled();
  });

  test("component policy read count is bounded independently of server count", async () => {
    using tmp = new DisposableTempDir("mcp-components-read-budget");
    const f = await componentFixture(tmp.path);
    const names = Array.from({ length: 32 }, (_, index) => `server${index}`);
    for (const name of names) {
      f.configs[`plugin:many:${name}`] = {
        ...stdioConfig(name),
        env: { PLUGIN_DATA: path.join(tmp.path, "data", name) },
        plugin: { ...f.configs["plugin:instance:keep"].plugin!, serverName: name },
      };
      f.serve(name);
    }
    await f.write(["keep", ...names]);
    const request = workspaceRequest("read-budget");
    await manager.getToolsForWorkspace(request);
    f.read.mockClear();
    const served = await manager.getToolsForWorkspace(request);
    expect(Object.keys(served.tools)).toHaveLength(34);
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(4);
    f.read.mockClear();
    await served.tools.ordinary_echo.execute!(
      {},
      { toolCallId: "budget", messages: [], context: {} }
    );
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(4);
  });

  test("component policy churn exhausts the bounded stable scan", async () => {
    using tmp = new DisposableTempDir("mcp-components-churn");
    const f = await componentFixture(tmp.path);
    let reads = 0;
    f.read.mockImplementation(() =>
      Promise.resolve({
        registryPath: f.registryPath,
        imports: { demo: [String(reads++)] },
      })
    );
    const error: unknown = await manager
      .getToolsForWorkspace(workspaceRequest("churn"))
      .catch((error: unknown) => error);
    expect(String(error)).toMatch(/kept racing/);
    expect(reads).toBeLessThanOrEqual(18);
  });

  test.each(["missing", "unreadable"])(
    "%s component policy never downgrades managed servers",
    async (failure) => {
      using tmp = new DisposableTempDir("mcp-components-policy");
      const f = await componentFixture(tmp.path);
      f.configs.unmanaged = {
        ...stdioConfig("unmanaged"),
        env: { PLUGIN_DATA: path.join(tmp.path, "data", "unmanaged") },
        plugin: {
          pluginName: "demo",
          serverName: "remove",
          sourceScope: "global",
          sourceLocation: ".agents/plugins/demo",
        },
      };
      f.serve("unmanaged");
      const request = workspaceRequest("policy");
      await manager.getToolsForWorkspace(request);
      if (failure === "missing") await fs.unlink(f.registryPath);
      else {
        await fs.unlink(f.registryPath);
        await fs.mkdir(f.registryPath);
      }
      // Discovery can now report the orphan as unmanaged; remembered provenance must win.
      delete f.configs["plugin:instance:remove"].plugin!.componentPolicy;
      const after = await manager.getToolsForWorkspace(request);
      expect(Object.values(after.toolServerNames).sort()).toEqual(["ordinary", "unmanaged"]);
      for (const command of ["ordinary", "unmanaged"]) {
        expect(f.clients(command)).toHaveLength(1);
        expect(f.client(command).close).not.toHaveBeenCalled();
      }
    }
  );

  test.each(["initial", "additional", "retry", "restart", "retired-only", "readd"] as const)(
    "failed component startup retirement stays owned after %s publication",
    async (mode) => {
      using tmp = new DisposableTempDir("mcp-startup-retirement");
      const f = await componentFixture(tmp.path);
      const key = "plugin:instance:remove";
      const request = workspaceRequest("startup-retirement");
      if (mode === "retired-only") {
        delete f.configs.ordinary;
        await f.write(["remove"]);
      } else if (mode === "additional") {
        await f.write(["keep"]);
        await manager.getToolsForWorkspace(request);
        await f.write(["keep", "remove"]);
      } else if (mode === "retry") {
        f.serve("remove", () => ({ hang: true }));
        await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
        elapseTimedOutRetryBackoff();
      } else if (mode === "restart") {
        await manager.getToolsForWorkspace(request);
        await servers.crash("remove");
        manager.acquireLease(request.workspaceId);
      }
      // The next startup of the removed server pauses mid-connection, and the
      // instance it publishes fails to close while `failClose` holds.
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      let failClose = true;
      let failedClient: ComponentClient | undefined;
      f.serve("remove", async (client, attempt) => {
        if (attempt !== 1) return;
        failedClient = client;
        entered.resolve();
        await resume.promise;
      });
      failNextInstanceClose(manager, key, () => failClose, "startup close failed");
      const pending = manager.getToolsForWorkspace(request);
      pending.catch(() => undefined);
      try {
        await entered.promise;
        // A managed launch try-locks the plugin writer's lock and fails closed
        // while f.write holds it; let "keep" finish launching first so only
        // the removed server races the write.
        if (mode !== "retired-only") await waitFor(() => f.clients("keep").length > 0);
        await f.write(mode === "retired-only" ? [] : ["keep"]);
        resume.resolve();
        const served = await pending;
        const retained = f.connections.filter((client) => client.command !== "remove");
        expect(failedClient).toBeDefined();
        expect(failedClient!.close.mock.calls.length).toBeGreaterThan(0);
        expect(Object.values(served.toolServerNames)).not.toContain(key);
        expect(served.stats.startedServerCount).toBe(mode === "retired-only" ? 0 : 2);
        expect(served.stats.enabledServerCount).toBe(mode === "retired-only" ? 0 : 2);
        expect(served.stats.failedServerNames).not.toContain(key);
        for (const client of retained) {
          expect(f.clients(client.command)).toHaveLength(1);
          expect(client.close).not.toHaveBeenCalled();
        }
        if (mode === "readd") {
          await f.write(["keep", "remove"]);
          const readded = await manager.getToolsForWorkspace(request);
          expect(Object.values(readded.toolServerNames)).toContain(key);
          // The readd connects a replacement instead of reviving the failed client.
          expect(servers.connectCount("remove")).toBe(2);
        }
        failClose = false;
        const attempts = failedClient!.close.mock.calls.length;
        if (mode === "retired-only") {
          // The sweep reads the clock synchronously: make the workspace look idle.
          setSystemTime(new Date(Date.now() + MCP_IDLE_TIMEOUT_MS + 60_000));
          f.sweepIdle();
          setSystemTime();
          await waitFor(() => failedClient!.close.mock.calls.length > attempts);
        } else if (mode === "additional" || mode === "restart") {
          await manager.stopServersWithKeyPrefix(key);
        } else {
          await manager.reconcilePluginComponents();
        }
        // The failed retirement stayed owned until this retry closed it.
        expect(failedClient!.close).toHaveBeenCalledTimes(attempts + 1);
        await manager.reconcilePluginComponents();
        expect(failedClient!.close).toHaveBeenCalledTimes(attempts + 1);
        for (const client of retained) expect(client.close).not.toHaveBeenCalled();
      } finally {
        failClose = false;
        resume.resolve();
        await pending.catch(() => undefined);
        if (mode === "restart") manager.releaseLease(request.workspaceId);
        await manager.reconcilePluginComponents();
      }
    }
  );

  test.each([false, true])(
    "component removal fences pending startup (readd during cleanup: %s)",
    async (readd) => {
      using tmp = new DisposableTempDir("mcp-components-start");
      const f = await componentFixture(tmp.path);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      f.serve("remove", async (client, attempt) => {
        if (attempt !== 1) return;
        entered.resolve();
        await finish.promise;
        if (readd)
          client.close.mockImplementation(async () => {
            await f.write(["keep", "remove"]);
          });
      });
      const request = workspaceRequest("startup");
      const pending = manager.getToolsForWorkspace(request);
      await entered.promise;
      await f.write(["keep"]);
      finish.resolve();
      const after = await pending;
      expect(f.client("remove").close).toHaveBeenCalledTimes(1);
      expect(Object.values(after.toolServerNames).includes("plugin:instance:remove")).toBe(readd);
      // A readd serves a replacement instead of the fenced instance.
      expect(f.clients("remove")).toHaveLength(readd ? 2 : 1);
      // No timed-out retry candidate was left behind.
      const starts = f.connections.length;
      elapseTimedOutRetryBackoff();
      await manager.getToolsForWorkspace(request);
      expect(f.connections).toHaveLength(starts);
    }
  );

  test("cross-process plugin mutation token retires cached plugin instances before serving", async () => {
    // A sibling process's update/uninstall recycles only its OWN manager;
    // this manager must notice the bumped on-disk mutation token and retire
    // matching cached instances instead of serving stale-tree servers forever.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-cross-process";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close });

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(1);

    // Unchanged token: the cached instance is served untouched.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(close).toHaveBeenCalledTimes(0);

    // The sibling's mutation bumps the token: retire and restart.
    token = "epoch-2";
    const close2 = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close: close2 });
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(third.tools)).toHaveLength(1);
    expect(close2).toHaveBeenCalledTimes(0);
  });

  test("a mutation landing during startup is caught by the post-publication token recheck", async () => {
    // A sibling mutation beginning AFTER the preflight token read is
    // invisible to the in-process epoch and to the installer's discovery
    // bracket; the serve must re-read the token after publication, retire the
    // just-published stale instance, and rebuild from the new tree. The
    // sweep also clears the cross-process-stale override cache.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-startup-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // Seed the token on a DIFFERENT workspace (first serve only records it),
    // so the raced serve below takes the full startup path.
    servers.serve("node server.js");
    await manager.getToolsForWorkspace(workspaceRequest("ws-token-seed"));

    // Seed a stale cached override entry a sibling's prune cannot reach.
    await manager.applyWorkspaceOverrides(workspaceId, { enabledServers: [pluginKey] });

    // Serve the raced workspace: the mutation lands DURING startup — the
    // connection flips the token as a side effect, after the preflight
    // already read the old value.
    const close = mock(() => Promise.resolve(undefined));
    const close2 = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", (attempt) => {
      if (attempt === 1) token = "epoch-2"; // Sibling mutation mid-startup.
      return { tools: { echo: testTool() }, close: attempt === 1 ? close : close2 };
    });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // The stale-tree instance was retired post-publication; the rebuild's
    // instance (new tree) is served.
    expect(close).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(0);
    expect(servers.connectCount("node server.js")).toBe(2);
    expect(Object.keys(result.tools)).toHaveLength(1);

    // With no disk reader wired, the sweep scrubbed the plugin key from the
    // seeded stale override cache: once the server is project-disabled, a
    // serve without overrides of its own is not re-enabled by that cache.
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    const disabled = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(disabled.tools)).toHaveLength(0);
  });

  test("concurrent serves await an in-flight cross-process sweep before returning", async () => {
    // The observed token must publish only AFTER the sweep completes: a
    // concurrent serve that merely compared the token could otherwise return
    // an instance the sweep has not yet retired.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-sweep-order";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // First serve: cache an instance whose close is GATED, so the sweep
    // triggered by the token bump blocks mid-retire.
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = mock(() => closeGate);
    const staleEcho = testTool("stale");
    servers.serve("node server.js", { tools: { echo: staleEcho }, close });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    token = "epoch-2";
    const restarted = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool("fresh") }, close: restarted });
    let firstDone = false;
    let secondDone = false;
    const first = manager.getToolsForWorkspace(workspaceRequest(workspaceId)).then((result) => {
      firstDone = true;
      return result;
    });
    const second = manager.getToolsForWorkspace(workspaceRequest(workspaceId)).then((result) => {
      secondDone = true;
      return result;
    });
    // Both serves are queued behind the gated sweep: neither may resolve.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(close).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    releaseClose();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    // Neither serve returned the stale instance. The first restarted the tree.
    // The concurrent second serve currently skips that in-flight restart and
    // returns no tools (#4539; main's startServers stub hid this); any tool it
    // returns must reach the restarted server. Require its tool once fixed.
    expect(Object.keys(firstResult.tools)).toHaveLength(1);
    for (const served of [firstResult, secondResult]) {
      for (const tool of Object.values(served.tools)) {
        expect(await tool.execute!({}, {} as never)).toBe("fresh");
      }
    }
    expect(staleEcho.execute).not.toHaveBeenCalled();
    expect(restarted).toHaveBeenCalledTimes(0);
  });

  test("serves loop until a startup is bracketed by an unchanged mutation token", async () => {
    // A single post-publication rebuild is not enough: a second sibling
    // mutation starting after the rebuild's preflight would let the rebuild
    // publish an instance from ITS replaced tree and serve it indefinitely.
    // The serve must repeat until one startup sees the same token on both
    // sides.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-token-loop";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    // Seed the token on a different workspace (first serve only records it).
    servers.serve("node server.js");
    await manager.getToolsForWorkspace(workspaceRequest("ws-token-seed"));

    // Two consecutive startups each race a fresh sibling mutation; the third
    // runs clean.
    const closes = [
      mock(() => Promise.resolve(undefined)),
      mock(() => Promise.resolve(undefined)),
      mock(() => Promise.resolve(undefined)),
    ];
    servers.serve("node server.js", (attempt) => {
      if (attempt <= 2) {
        token = `epoch-${attempt + 1}`; // Sibling mutation mid-startup.
      }
      return { tools: { echo: testTool() }, close: closes[attempt - 1] };
    });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Both raced instances were retired; only the bracketed third serve's
    // instance survives.
    expect(servers.connectCount("node server.js")).toBe(3);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(closes[2]).toHaveBeenCalledTimes(0);
    expect(Object.keys(result.tools)).toHaveLength(1);
  });

  test("prompt listing retries when a plugin mutation lands during startup", async () => {
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-prompt-list-token-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    servers.serve("node server.js");
    await manager.getToolsForWorkspace(workspaceRequest("ws-prompt-token-seed"));

    const staleClose = mock(() => Promise.resolve(undefined));
    const freshClose = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", (attempt) => {
      if (attempt === 1) {
        token = "epoch-2";
      }
      return {
        prompts: [{ name: "review", description: attempt === 1 ? "stale" : "fresh" }],
        close: attempt === 1 ? staleClose : freshClose,
      };
    });

    const prompts = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("node server.js")).toBe(2);
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(freshClose).toHaveBeenCalledTimes(0);
    const review = prompts.find((prompt) => prompt.promptName === "review");
    expect(review?.description).toBe("fresh");
  });

  test("prompt invocation retries when a plugin mutation lands during prompts/get", async () => {
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: { keyPrefix: "plugin:", readToken: () => Promise.resolve(token) },
    });

    const workspaceId = "ws-prompt-get-token-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );
    const staleClose = mock(() => Promise.resolve(undefined));
    const freshClose = mock(() => Promise.resolve(undefined));
    const staleGetPrompt = mock(() => {
      token = "epoch-2";
      return Promise.resolve({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "stale" } }],
      });
    });
    const freshGetPrompt = mock(() =>
      Promise.resolve({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "fresh" } }],
      })
    );
    servers.serve("node server.js", (attempt) => ({
      getPrompt: attempt === 1 ? staleGetPrompt : freshGetPrompt,
      close: attempt === 1 ? staleClose : freshClose,
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const prompt = await manager.getPrompt(workspaceId, pluginKey, "review", {});
    expect(prompt.text).toBe("fresh");
    expect(staleGetPrompt).toHaveBeenCalledTimes(1);
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(freshGetPrompt).toHaveBeenCalledTimes(1);
    expect(freshClose).toHaveBeenCalledTimes(0);
  });

  test("an unreadable mutation epoch fails closed only for plugin servers", async () => {
    // Unreadability is a STABLE state: transition into it sweeps once and
    // suppresses plugin configs, while unrelated MCP servers remain usable.
    // Repeated serves cannot exhaust the mutation bracket, and transition
    // back to a readable epoch enables plugins again.
    manager.dispose();
    let token = "epoch-1";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
      },
    });

    const workspaceId = "ws-unreadable-epoch";
    const pluginKey = "plugin:abc123:echo";
    using pluginData = new DisposableTempDir("mcp-unreadable-epoch-data");
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: {
          ...stdioConfig("node plugin.js"),
          env: { PLUGIN_DATA: pluginData.path },
          plugin: {
            pluginName: "demo",
            serverName: "echo",
            sourceScope: "global" as const,
            sourceLocation: ".xum/plugins/demo",
          },
        },
        regular: stdioConfig("node regular.js"),
      })
    );
    const pluginClose = mock(() => Promise.resolve(undefined));
    servers.serve("node plugin.js", { tools: { echo: testTool() }, close: pluginClose });
    servers.serve("node regular.js", { tools: { echo: testTool() } });

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(2);

    token = MUTATION_EPOCH_UNREADABLE_TOKEN;
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(pluginClose).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.tools)).toHaveLength(1);

    // Stable unreadability: no repeated sweep or retry exhaustion.
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(pluginClose).toHaveBeenCalledTimes(1);
    expect(Object.keys(third.tools)).toHaveLength(1);

    token = "epoch-2";
    const recovered = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(recovered.tools)).toHaveLength(2);
  });

  test("cross-process sweep refreshes cached override snapshots from disk", async () => {
    // A sibling's uninstall prunes plugin keys from workspace override FILES.
    // Cached copies — the per-call overlay cache AND recorded request options
    // (which getPrompt()'s refresh reuses) — must converge to disk, or a
    // pre-prune enable would restart a same-name reinstall's server without
    // new consent.
    manager.dispose();
    let token = "epoch-1";
    let diskOverrides: Record<string, unknown> = { enabledServers: ["plugin:abc123:echo"] };
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });

    const workspaceId = "ws-disk-refresh";
    const pluginKey = "plugin:abc123:echo";
    // Project-level disabled: only the workspace override enables the server.
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close });

    // First serve: the caller's snapshot enables the plugin server.
    const staleCallerOptions = workspaceRequest(workspaceId, {
      overrides: { enabledServers: [pluginKey] },
    });
    const first = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(Object.keys(first.tools)).toHaveLength(1);

    // Sibling uninstall: the override file is pruned on disk, then the epoch
    // bumps.
    diskOverrides = {};
    token = "epoch-2";

    // Same STALE caller snapshot: the preflight sweep must reload disk state
    // before the overlay captures this call's overrides, so the pruned
    // (empty) overrides win and no replacement server starts.
    const second = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(second.tools)).toHaveLength(0);
    // The pruned serve derived an EMPTY start set, not merely discarded a
    // started instance.
    expect(servers.connectCount("node server.js")).toBe(1);

    // Both caches converged to disk: getPrompt()'s refresh (recorded
    // options) can no longer resurrect the pre-prune enable, and a serve
    // carrying no overrides of its own is not overlaid with the stale enable.
    await manager.stopServers(workspaceId, { retainRestartOptions: true });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, pluginKey, "review", {})).rejects.toThrow();
    const overlaid = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(overlaid.tools)).toHaveLength(0);
    expect(servers.connectCount("node server.js")).toBe(1);
  });

  test("a cold workspace's first serve loads disk overrides instead of trusting the caller snapshot", async () => {
    // Two processes, one home: the caller read its snapshot BEFORE a sibling
    // uninstall + same-name reinstall pruned the enable from the override
    // file. This manager never served the workspace (no cached snapshot for
    // the sweep to refresh) and its first token observation records the
    // already-advanced epoch, so the bracket sees nothing to retire — disk
    // must win on the first serve, or the stale enable overrides the
    // replacement server's default-disabled state.
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-post-mutation"),
        readWorkspaceOverrides: () => Promise.resolve({}), // pruned on disk
      },
    });

    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    servers.serve("node server.js", { tools: { echo: testTool() } });

    const staleCallerOptions = workspaceRequest("ws-cold-first-serve", {
      overrides: { enabledServers: [pluginKey] },
    });
    const result = await manager.getToolsForWorkspace(staleCallerOptions);
    expect(servers.connectCount("node server.js")).toBe(0);
    expect(Object.keys(result.tools)).toHaveLength(0);
  });

  test("a settings save landing during the first-serve disk read wins over the read result", async () => {
    // The first serve's disk read races a successful MCP settings save: the
    // save persists to disk, then publishes into the override cache — but a
    // read started BEFORE the save can resolve with the older state
    // afterwards. The continuation must recheck the cache: recording the
    // stale read would expose a just-disabled server for this send, and the
    // save's repair path only patches recorded options, which do not exist
    // yet on a first serve.
    manager.dispose();
    let readStarted: () => void = () => undefined;
    const readStartedPromise = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let resolveRead: (value: Record<string, unknown>) => void = () => undefined;
    const pendingRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveRead = resolve;
    });
    let reads = 0;
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => {
          reads += 1;
          if (reads > 1) return Promise.resolve({}); // Disk after the save.
          readStarted();
          return pendingRead;
        },
      },
    });

    const workspaceId = "ws-first-serve-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js", true) })
    );
    servers.serve("node server.js", { tools: { echo: testTool() } });

    const serve = manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { enabledServers: [pluginKey] } })
    );
    // Deterministic interleaving: the serve is parked on the disk read when
    // the save publishes, then the read resolves with the pre-save state.
    await readStartedPromise;
    await manager.applyWorkspaceOverrides(workspaceId, {});
    resolveRead({ enabledServers: [pluginKey] });

    const result = await serve;
    expect(servers.connectCount("node server.js")).toBe(0);
    expect(Object.keys(result.tools)).toHaveLength(0);
    // The serve recorded (and reports) the save's overrides, not the stale read.
    expect(result.overridesUsed).toEqual({});
  });

  test("stopServersWithKeyPrefix invalidates instances published by an in-flight startup, then retries them", async () => {
    const workspaceId = "ws-swap-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // Hold the connection mid-flight so a plugin swap can land while the
    // instance exists but is not yet published.
    const connecting = Promise.withResolvers<void>();
    const startupGate = Promise.withResolvers<void>();
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", {
      tools: { echo: testTool() },
      connect: () => {
        connecting.resolve();
        return startupGate.promise;
      },
      close,
    });

    const toolsPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await connecting.promise;

    // The updater's recycle runs while startup is in flight: the scan sees
    // nothing (not yet published), so the epoch record must catch it.
    await manager.stopServersWithKeyPrefix("plugin:abc123:");

    startupGate.resolve();
    const result = await toolsPromise;

    // The stale instance was closed instead of published.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    expect(result.stats.startedServerCount).toBe(0);

    // The entry was published under the UNCHANGED config signature, so the
    // next call hits the cached path — the removed server must carry a retry
    // marker there, or the updated plugin's tools stay unavailable forever.
    const close2 = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close: close2 });

    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Restarted from the (new) tree via the retry path — not served from the
    // reduced cached map, and not torn down again.
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(close2).toHaveBeenCalledTimes(0);
    expect(Object.keys(second.tools)).toHaveLength(1);

    // The retry marker cleared: the restarted instance is now served cached.
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(Object.keys(third.tools)).toHaveLength(1);
  });

  test("invalidation landing between the final epoch scan and cache publication never publishes the stale instance", async () => {
    const workspaceId = "ws-publish-race";
    const pluginKey = "plugin:abc123:echo";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({ [pluginKey]: stdioConfig("node server.js") })
    );

    // Schedule the invalidation for the first microtask turn AFTER the
    // caller's continuation resumes from the final (stable-clock) scan: two
    // hops, because the caller's continuation is queued behind the first when
    // the scan resolves. Publication is synchronous with the final clock
    // check, so the stop must find the PUBLISHED entry and close it; any await
    // inserted between check and publish lets the stop run first, miss the
    // unpublished instance, and the stale instance is published.
    // Private call: no public callback runs between the final scan and publish.
    const scans = manager as unknown as {
      closeInvalidatedInstances: (...args: unknown[]) => Promise<string[]>;
    };
    const scan = scans.closeInvalidatedInstances.bind(manager);
    let stopPromise: Promise<void> | undefined;
    let armed = true;
    scans.closeInvalidatedInstances = async (...args: unknown[]) => {
      const removed = await scan(...args);
      if (armed) {
        armed = false;
        queueMicrotask(() =>
          queueMicrotask(() => {
            stopPromise = manager.stopServersWithKeyPrefix("plugin:abc123:");
          })
        );
      }
      return removed;
    };
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // The stale-tree instance was closed and carries a retry marker, so the
    // next call restarts it from the new tree.
    expect(close).toHaveBeenCalledTimes(1);
    servers.serve("node server.js", { tools: { echo: testTool() } });
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(Object.keys(second.tools)).toHaveLength(1);
  });

  test("invalidation landing during the epoch scan forces a rescan before publication", async () => {
    const workspaceId = "ws-scan-race";
    const pluginKey = "plugin:abc123:echo";
    const triggerKey = "plugin:zzz:trigger";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: stdioConfig("node server.js"),
        [triggerKey]: stdioConfig("node trigger.js"),
      })
    );

    // The trigger's tree is swapped mid-startup, so the pre-publication scan
    // closes it — AFTER it already checked the (sorted-first) echo key. The
    // trigger's close invalidates the echo prefix: that epoch record lands
    // after the scan read it, and its own published-map scan runs before
    // publication — the exact window where both mechanisms used to miss.
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    servers.serve("node server.js", { tools: { echo: testTool() }, close });
    servers.serve("node trigger.js", {
      connect: () => manager.stopServersWithKeyPrefix("plugin:zzz:"),
      close: () => {
        stopPromise = manager.stopServersWithKeyPrefix("plugin:abc123:");
        return Promise.resolve();
      },
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // The stale-tree instance was closed, never published, and carries a
    // retry marker so the next call restarts it from the new tree.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);

    servers.serve("node server.js", { tools: { echo: testTool() } });
    servers.serve("node trigger.js");
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(Object.keys(second.tools)).toHaveLength(1);
  });

  test("workspace removal landing during the invalidation scan never publishes the started servers", async () => {
    const workspaceId = "ws-removal-race";
    const pluginKey = "plugin:abc123:echo";
    const triggerKey = "plugin:zzz:trigger";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: stdioConfig("node server.js"),
        [triggerKey]: stdioConfig("node trigger.js"),
      })
    );

    // Same trigger as the invalidation race above, but its close (during the
    // pre-publication scan) is a removal-style stopServers(workspaceId): it
    // bumps the stop epoch AFTER the pre-publication epoch check ran and
    // finds no cache entry to close (publication hasn't happened) —
    // publishing anyway would resurrect MCP processes for a removed workspace
    // until idle cleanup.
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    servers.serve("node server.js", { tools: { echo: testTool() }, close });
    servers.serve("node trigger.js", {
      connect: () => manager.stopServersWithKeyPrefix("plugin:zzz:"),
      close: () => {
        stopPromise = manager.stopServers(workspaceId);
        return Promise.resolve();
      },
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // Publication was skipped and the late clients were closed.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);

    // Nothing was cached for the removed workspace: its next use starts afresh.
    servers.serve("node server.js");
    servers.serve("node trigger.js");
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(servers.connectCount("node trigger.js")).toBe(1);
  });

  test("workspace removal landing during a timed-out retry never merges into the detached entry", async () => {
    const workspaceId = "ws-retry-removal-race";
    const pluginKey = "plugin:abc123:echo";
    const triggerKey = "plugin:zzz:trigger";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: stdioConfig("node server.js"),
        [triggerKey]: stdioConfig("node trigger.js"),
      })
    );

    // First call: both servers time out, so the cached entry carries retry
    // markers and no live instance.
    servers.serve("node server.js", { hang: true });
    servers.serve("node trigger.js", { hang: true });
    const request = workspaceRequest(workspaceId);
    const timedOut = await servers.expireStartupDeadline(
      () => manager.getToolsForWorkspace(request),
      2
    );
    expect(timedOut.stats.failedServerNames.sort()).toEqual([pluginKey, triggerKey]);

    // Second call retries both. The trigger's close during the retry's
    // invalidation scan is a removal-style stopServers(workspaceId): it
    // deletes the cache entry, so the merge callback must NOT attach these
    // clients to the detached entry (they would have no owner to ever clean
    // them up).
    const close = mock(() => Promise.resolve(undefined));
    let stopPromise: Promise<void> | undefined;
    servers.serve("node server.js", { tools: { echo: testTool() }, close });
    servers.serve("node trigger.js", {
      connect: () => manager.stopServersWithKeyPrefix("plugin:zzz:"),
      close: () => {
        stopPromise = manager.stopServers(workspaceId);
        return Promise.resolve();
      },
    });

    elapseTimedOutRetryBackoff();
    const result = await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(stopPromise).toBeDefined();
    await stopPromise;

    // The retried client was closed, nothing was merged into the detached
    // entry, and the removed workspace stays uncached.
    expect(close).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.tools)).toEqual([]);
    servers.serve("node server.js");
    servers.serve("node trigger.js");
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("node server.js")).toBe(1);
    expect(servers.connectCount("node trigger.js")).toBe(1);
  });

  test("stopServersWithKeyPrefix closes only matching instances and retries them on next use", async () => {
    const workspaceId = "ws-selective-stop";
    const pluginKey = "plugin:abc123:echo";
    const userServer = "user-server";
    configService.listServers.mockImplementation(() =>
      Promise.resolve({
        [pluginKey]: stdioConfig("node server.js"),
        [userServer]: stdioConfig("npx user-server"),
      })
    );

    const pluginClose = mock(() => Promise.resolve(undefined));
    const userClose = mock(() => Promise.resolve(undefined));
    servers.serve("node server.js", { tools: { echo: testTool() }, close: pluginClose });
    servers.serve("npx user-server", { tools: { toolu: testTool() }, close: userClose });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Simulate a live agent stream holding the workspace's servers.
    manager.acquireLease(workspaceId);
    try {
      await manager.stopServersWithKeyPrefix("plugin:abc123:");

      // Only the plugin instance was closed; the unrelated healthy client
      // survives underneath the live lease.
      expect(pluginClose).toHaveBeenCalledTimes(1);
      expect(userClose).toHaveBeenCalledTimes(0);

      // The stopped plugin server is queued for restart on next use, beside
      // the still-cached user client.
      const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
      expect(servers.connectCount("node server.js")).toBe(2);
      expect(servers.connectCount("npx user-server")).toBe(1);
      expect(Object.keys(next.tools)).toHaveLength(2);
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  /**
   * Replace the suite's manager with one whose idle sweep — reached only by
   * a one-minute interval armed in the constructor — the test runs on demand.
   */
  function useManagerWithIdleSweep(): () => void {
    manager.dispose();
    const constructed = constructWithIdleSweep(
      () => new MCPServerManager(configService as unknown as MCPConfigService)
    );
    manager = constructed.instance;
    return constructed.sweepIdle;
  }

  test("the idle sweep stops an unleased workspace's idle servers", async () => {
    const workspaceId = "ws-idle";
    const sweepIdleServers = useManagerWithIdleSweep();
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd") }));
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("cmd", { close });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    setSystemTime(new Date(Date.now() + MCP_IDLE_TIMEOUT_MS + 60_000));
    sweepIdleServers();

    expect(close).toHaveBeenCalledTimes(1);
    // Evicted: the next use starts the server again.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd")).toBe(2);
  });

  test("the idle sweep keeps a leased workspace's idle servers running", async () => {
    const workspaceId = "ws-leased";
    const sweepIdleServers = useManagerWithIdleSweep();
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd") }));
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("cmd", { close });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);

    // The workspace looks idle even though acquireLease() updated activity.
    setSystemTime(new Date(Date.now() + MCP_IDLE_TIMEOUT_MS + 60_000));
    sweepIdleServers();

    expect(close).toHaveBeenCalledTimes(0);
    // Still cached: the next use reuses the running server.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd")).toBe(1);
    manager.releaseLease(workspaceId);
  });

  test("a startup that never finishes fails as a timeout and is retried after its backoff", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({ "stuck-server": stdioConfig("never") })
    );
    servers.serve("never", { hang: true });
    const request = workspaceRequest("ws-stuck-startup");

    const result = await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));

    expect(servers.connectCount("never")).toBe(1);
    expect(result.stats.failedServerNames).toEqual(["stuck-server"]);
    // Surfaced as a startup timeout: retried once its backoff elapses.
    elapseTimedOutRetryBackoff();
    servers.serve("never", { tools: { ping: testTool() } });
    const retried = await manager.getToolsForWorkspace(request);
    expect(Object.keys(retried.tools)).toHaveLength(1);
  });

  /**
   * Hold every setTimeout armed with one of `delays` until the test fires it,
   * so a startup deadline expires exactly when the startup is parked where
   * the test wants it (expireStartupDeadline only fires once a connect hangs).
   * Other timers run for real.
   */
  function holdTimers(delays: number[]): { fire: (delay: number) => void } & Disposable {
    const realSetTimeout = globalThis.setTimeout;
    const held: Array<{ delay: number; run: () => void }> = [];
    const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === undefined || !delays.includes(delay)) {
        return realSetTimeout(callback, delay, ...args);
      }
      held.push({ delay, run: () => callback(...args) });
      // A real (never-firing) handle, so production can unref/clear it.
      return realSetTimeout(() => undefined, 2 ** 31 - 1);
    }) as typeof setTimeout);
    return {
      fire: (delay) => {
        const due = held.filter((timer) => timer.delay === delay);
        if (due.length === 0) throw new Error(`holdTimers: no ${delay} ms timer armed`);
        for (const timer of due) {
          held.splice(held.indexOf(timer), 1);
          timer.run();
        }
      },
      [Symbol.dispose]: () => spy.mockRestore(),
    };
  }

  /** Mirrors mcpServerManager's fail-safe wait for a timed-out startup's abort cleanup. */
  const STARTUP_CLEANUP_WAIT_MS = MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS;

  test("a startup timeout waits for its abort cleanup before surfacing", async () => {
    using timers = holdTimers([MCP_STARTUP_TIMEOUT_MS, STARTUP_CLEANUP_WAIT_MS]);
    configService.listServers = mock(() =>
      Promise.resolve({ "cleanup-server": stdioConfig("never") })
    );
    // Startup stalls on tools/list after connecting, so the deadline's abort
    // must close the connected client before the timeout surfaces.
    const listing = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<undefined>();
    const closing = Promise.withResolvers<void>();
    const close = mock(() => {
      closing.resolve();
      return cleanup.promise;
    });
    servers.serve("never", {
      listTools: () => {
        listing.resolve();
        return new Promise<never>(() => undefined);
      },
      close,
    });
    const request = workspaceRequest("ws-cleanup-wait");
    let settled = false;
    const serve = manager.getToolsForWorkspace(request).finally(() => {
      settled = true;
    });

    await listing.promise;
    timers.fire(MCP_STARTUP_TIMEOUT_MS);
    // The abort cleanup has started; drain queued continuations so a timeout
    // that did not wait for it would already have settled the serve.
    await closing.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    cleanup.resolve(undefined);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual(["cleanup-server"]);
    // Surfaced as a startup timeout: retried once its backoff elapses.
    elapseTimedOutRetryBackoff();
    servers.serve("never", { tools: { ping: testTool() } });
    const retried = await manager.getToolsForWorkspace(request);
    expect(Object.keys(retried.tools)).toHaveLength(1);
  });

  test("a startup timeout still surfaces when its abort cleanup hangs", async () => {
    using timers = holdTimers([MCP_STARTUP_TIMEOUT_MS, STARTUP_CLEANUP_WAIT_MS]);
    configService.listServers = mock(() =>
      Promise.resolve({ "cleanup-hang-server": stdioConfig("never") })
    );
    const listing = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const close = mock(() => {
      closing.resolve();
      return new Promise<never>(() => undefined);
    });
    servers.serve("never", {
      listTools: () => {
        listing.resolve();
        return new Promise<never>(() => undefined);
      },
      close,
    });
    const request = workspaceRequest("ws-cleanup-hang");
    let settled = false;
    const serve = manager.getToolsForWorkspace(request).finally(() => {
      settled = true;
    });

    await listing.promise;
    timers.fire(MCP_STARTUP_TIMEOUT_MS);
    // The abort cleanup has started (and never settles); drain queued
    // continuations so only the fail-safe deadline can settle the serve.
    await closing.promise;
    await new Promise((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    // The cleanup never settles; the fail-safe deadline surfaces the timeout.
    timers.fire(STARTUP_CLEANUP_WAIT_MS);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual(["cleanup-hang-server"]);
    elapseTimedOutRetryBackoff();
    servers.serve("never", { tools: { ping: testTool() } });
    const retried = await manager.getToolsForWorkspace(request);
    expect(Object.keys(retried.tools)).toHaveLength(1);
  });

  test("slow server startups overlap instead of stacking serially", async () => {
    const names = ["a", "b", "c"];
    configService.listServers = mock(() =>
      Promise.resolve(Object.fromEntries(names.map((name) => [name, stdioConfig(`cmd-${name}`)])))
    );
    const gates = names.map(() => Promise.withResolvers<void>());
    let connecting = 0;
    names.forEach((name, index) => {
      servers.serve(`cmd-${name}`, {
        tools: { t: testTool() },
        connect: () => {
          connecting += 1;
          return gates[index].promise;
        },
      });
    });

    const serve = manager.getToolsForWorkspace(workspaceRequest("ws-overlap"));
    // Startups overlap: at least two are in flight at once (the startup semaphore may
    // queue the rest, so do not require every slot).
    await waitFor(() => connecting >= 2);
    // Finish in reverse order: concurrent completion order must not perturb
    // the served tool order.
    for (const gate of [...gates].reverse()) {
      gate.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const result = await serve;

    expect(Object.keys(result.tools)).toEqual(["a_t", "b_t", "c_t"]);
  });

  test("only startup timeouts, not other startup failures, are retried", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({
        "slow-server": stdioConfig("slow"),
        "broken-server": stdioConfig("broken"),
      })
    );
    servers.serve("slow", { hang: true });
    servers.serve("broken", {
      connect: () => Promise.reject(new Error("invalid MCP server config")),
    });
    const request = workspaceRequest("ws-timeout-classification");

    const result = await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(result.stats.failedServerNames.sort()).toEqual(["broken-server", "slow-server"]);

    // Once the backoff elapses only the timed-out server is retried.
    elapseTimedOutRetryBackoff();
    servers.serve("slow");
    servers.serve("broken");
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("slow")).toBe(1);
    expect(servers.connectCount("broken")).toBe(0);
  });

  test("a stdio process spawned after its startup aborted has its streams closed", async () => {
    using timers = holdTimers([MCP_STARTUP_TIMEOUT_MS]);
    configService.listServers = mock(() =>
      Promise.resolve({ "stdio-aborted-after-exec": stdioConfig("never") })
    );
    const execStarted = Promise.withResolvers<void>();
    const spawned = Promise.withResolvers<void>();
    const stdinClose = mock(() => Promise.resolve(undefined));
    const stdoutCancel = mock(() => Promise.resolve(undefined));
    const stderrCancel = mock(() => Promise.resolve(undefined));
    // runtime.exec() hands back a process spawned after the startup aborted.
    const exec = mock(async (_command: string) => {
      execStarted.resolve();
      await spawned.promise;
      return {
        stdin: new WritableStream<Uint8Array>({ close: stdinClose }),
        stdout: new ReadableStream<Uint8Array>({ cancel: stdoutCancel }),
        stderr: new ReadableStream<Uint8Array>({ cancel: stderrCancel }),
        exitCode: Promise.resolve(0),
        duration: Promise.resolve(0),
      };
    });
    const request = workspaceRequest("ws-abort-after-exec", {
      runtime: { exec } as unknown as Runtime,
    });

    const serve = manager.getToolsForWorkspace(request);
    await execStarted.promise;
    timers.fire(MCP_STARTUP_TIMEOUT_MS);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual(["stdio-aborted-after-exec"]);

    spawned.resolve();
    await waitFor(() => stderrCancel.mock.calls.length > 0);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(stdinClose).toHaveBeenCalledTimes(1);
    expect(stdoutCancel).toHaveBeenCalledTimes(1);
    expect(stderrCancel).toHaveBeenCalledTimes(1);
  });

  test("stdio spawn holds the override writer's lock and refuses a launch once the epoch moved", async () => {
    // The read-only pre-start check leaves a gap between its read and the
    // spawn; the exec that runs the repository-configured command is fenced
    // like a tool dispatch: a sibling's revocation either commits before the
    // fenced read (launch refused) or waits until the process exists.
    manager.dispose();
    let epoch = "epoch-1";
    let lockHeld = false;
    let gateLock: Promise<void> = Promise.resolve();
    const acquireOverridesLock = mock(async () => {
      await gateLock;
      lockHeld = true;
      return () => {
        lockHeld = false;
        return Promise.resolve();
      };
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve({}),
        acquireOverridesLock,
      },
    });
    // Establish the epoch baseline (first preflight).
    configService.listServers = mock(() => Promise.resolve({}));
    await manager.getToolsForWorkspace(workspaceRequest("ws-spawn-fence-baseline"));

    configService.listServers = mock(() => Promise.resolve({ fenced: stdioConfig("fenced-cmd") }));
    servers.serve("fenced-cmd", { tools: { ping: testTool() } });
    const heldAtExec: boolean[] = [];
    const runtime = {
      exec: (...args: Parameters<typeof servers.exec>) => {
        heldAtExec.push(lockHeld);
        return servers.exec(...args);
      },
    } as unknown as Runtime;

    const started = await manager.getToolsForWorkspace(
      workspaceRequest("ws-spawn-fence", { runtime })
    );
    expect(Object.keys(started.tools)).toHaveLength(1);
    expect(heldAtExec).toEqual([true]);
    expect(lockHeld).toBe(false);

    // A sibling revocation holding the writer's lock commits its epoch before
    // releasing: the fenced read sees it and nothing is spawned.
    const sibling = Promise.withResolvers<void>();
    gateLock = sibling.promise;
    const locksBefore = acquireOverridesLock.mock.calls.length;
    const racing = manager.getToolsForWorkspace(
      workspaceRequest("ws-spawn-fence-race", { runtime })
    );
    await waitFor(() => acquireOverridesLock.mock.calls.length > locksBefore);
    epoch = "epoch-2";
    gateLock = Promise.resolve();
    sibling.resolve();
    const raced = await racing;
    expect(heldAtExec).toEqual([true]);
    expect(raced.stats.failedServerNames).toEqual(["fenced"]);
    expect(lockHeld).toBe(false);
  });

  /**
   * Instrument a component fixture's invalidation with the override writer's
   * lock and report whether each lock is held, then serve it from a manager
   * with the real startup path.
   */
  async function launchFenceFixture(home: string) {
    const f = await componentFixture(home);
    const held = { overrides: false, component: false };
    const acquireComponentLock = f.invalidation.tryAcquireComponentPolicyLock!;
    f.invalidation.tryAcquireComponentPolicyLock = async (options) => {
      const release = await acquireComponentLock(options);
      held.component = true;
      return async () => {
        await release();
        held.component = false;
      };
    };
    f.invalidation.readOverridesEpoch = () => Promise.resolve("epoch-1");
    f.invalidation.readWorkspaceOverrides = () => Promise.resolve({});
    f.invalidation.acquireOverridesLock = () => {
      held.overrides = true;
      return Promise.resolve(() => {
        held.overrides = false;
        return Promise.resolve();
      });
    };
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: f.invalidation,
    });
    // Establish the epoch baseline (first preflight) with nothing to start.
    configService.listServers = mock(() => Promise.resolve({}));
    await manager.getToolsForWorkspace(workspaceRequest("ws-launch-fence-baseline"));
    return { ...f, held };
  }

  test("a remote launch fence releases the writer's lock at its initiation deadline while the handshake is pending", async () => {
    // Every settings save and prune would otherwise queue behind an
    // endpoint-controlled handshake for the whole startup deadline.
    using tmp = new DisposableTempDir("mcp-component-launch-lifetime");
    const f = await launchFenceFixture(tmp.path);
    using timers = holdTimers([MCP_LAUNCH_INITIATION_FENCE_MS]);
    const serverKey = "plugin:instance:remove";
    const url = "https://remove.example/mcp";
    configService.listServers = mock(() =>
      Promise.resolve({
        [serverKey]: { transport: "http" as const, url, plugin: f.configs[serverKey].plugin },
      })
    );
    const handshake = Promise.withResolvers<void>();
    let heldAtLaunch: boolean | undefined;
    servers.serve(url, {
      tools: { echo: testTool() },
      connect: () => {
        heldAtLaunch = f.held.overrides && f.held.component;
        return handshake.promise;
      },
    });

    const serve = manager.getToolsForWorkspace(workspaceRequest("ws-remote-fence"));
    await waitFor(() => heldAtLaunch !== undefined);
    expect(heldAtLaunch).toBe(true);
    // The handshake is still pending at the initiation deadline: release.
    timers.fire(MCP_LAUNCH_INITIATION_FENCE_MS);
    await waitFor(() => !f.held.overrides && !f.held.component);
    // A real component writer can commit while the admitted handshake is pending.
    await f.write(["keep"]);
    expect(f.held.component).toBe(false);
    handshake.resolve();
    const result = await serve;
    expect(servers.connectCount(url)).toBe(1);
    // The component the writer removed meanwhile is not served.
    expect(result.tools).toEqual({});
  });

  test("a stdio launch still awaiting its exec at the fence deadline is aborted, not released", async () => {
    // Releasing would let an SSH exec still acquiring its connection send the
    // repository-configured command after a sibling's revocation committed.
    using tmp = new DisposableTempDir("mcp-component-launch-lifetime");
    const f = await launchFenceFixture(tmp.path);
    using timers = holdTimers([MCP_STDIO_LAUNCH_FENCE_MS]);
    const serverKey = "plugin:instance:remove";
    configService.listServers = mock(() => Promise.resolve({ [serverKey]: f.configs[serverKey] }));
    servers.serve("remove", { tools: { echo: testTool() } });
    let launchSignal: AbortSignal | undefined;
    let heldWhilePending: boolean | undefined;
    let stallExec = true;
    const runtime = {
      exec: (...args: Parameters<typeof servers.exec>) => {
        const signal = args[1].abortSignal;
        launchSignal = signal;
        heldWhilePending = f.held.overrides && f.held.component;
        if (!stallExec) return servers.exec(...args);
        // Mirrors RemoteRuntime.exec: settles only through the abort.
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), {
            once: true,
          });
        });
      },
    } as unknown as Runtime;
    const request = workspaceRequest("ws-stdio-fence", { runtime });

    const serve = manager.getToolsForWorkspace(request);
    await waitFor(() => launchSignal !== undefined);
    timers.fire(MCP_STDIO_LAUNCH_FENCE_MS);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual([serverKey]);
    expect(heldWhilePending).toBe(true);
    expect(launchSignal?.aborted).toBe(true);
    expect(f.held.overrides).toBe(false);
    expect(f.held.component).toBe(false);

    // Failed as a startup timeout, so it is retried after the backoff; a
    // launch that hands back its stream in time is unaffected and released.
    stallExec = false;
    elapseTimedOutRetryBackoff();
    const retried = await manager.getToolsForWorkspace(request);
    expect(Object.keys(retried.tools)).toHaveLength(1);
    expect(heldWhilePending).toBe(true);
    expect(launchSignal?.aborted).toBe(false);
    expect(f.held.overrides).toBe(false);
    expect(f.held.component).toBe(false);
  });

  test("a stdio client connecting after its startup aborted is closed", async () => {
    using timers = holdTimers([MCP_STARTUP_TIMEOUT_MS]);
    configService.listServers = mock(() =>
      Promise.resolve({ "stdio-late-client-cleanup": stdioConfig("never") })
    );
    const connecting = Promise.withResolvers<void>();
    const handshake = Promise.withResolvers<void>();
    const lateClientClose = mock(() => Promise.resolve(undefined));
    servers.serve("never", {
      connect: () => {
        connecting.resolve();
        return handshake.promise;
      },
      close: lateClientClose,
    });

    const serve = manager.getToolsForWorkspace(workspaceRequest("ws-stdio-late-client"));
    await connecting.promise;
    timers.fire(MCP_STARTUP_TIMEOUT_MS);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual(["stdio-late-client-cleanup"]);
    expect(lateClientClose).toHaveBeenCalledTimes(0);

    // The client finishes connecting only after the abort: closed, not adopted.
    handshake.resolve();
    await waitFor(() => lateClientClose.mock.calls.length > 0);
    expect(lateClientClose).toHaveBeenCalledTimes(1);
  });

  test("an HTTP client connecting after its startup aborted is closed", async () => {
    using timers = holdTimers([MCP_STARTUP_TIMEOUT_MS]);
    const url = "https://example.com/mcp";
    configService.listServers = mock(() =>
      Promise.resolve({ "http-late-client-cleanup": { transport: "http" as const, url } })
    );
    const connecting = Promise.withResolvers<void>();
    const handshake = Promise.withResolvers<void>();
    const lateClientClose = mock(() => Promise.resolve(undefined));
    servers.serve(url, {
      connect: () => {
        connecting.resolve();
        return handshake.promise;
      },
      close: lateClientClose,
    });

    const serve = manager.getToolsForWorkspace(workspaceRequest("ws-http-late-client"));
    await connecting.promise;
    timers.fire(MCP_STARTUP_TIMEOUT_MS);
    const result = await serve;
    expect(result.stats.failedServerNames).toEqual(["http-late-client-cleanup"]);
    expect(lateClientClose).toHaveBeenCalledTimes(0);

    handshake.resolve();
    await waitFor(() => lateClientClose.mock.calls.length > 0);
    expect(lateClientClose).toHaveBeenCalledTimes(1);
  });

  /** Era priors passed to each createMCPClient call, as recorded by the harness's spy. */
  const connectPriors = () =>
    (mcpSdk.createMCPClient as unknown as ReturnType<typeof mock>).mock.calls.map(
      ([config]) => (config as mcpSdk.MCPClientConfig).prior
    );

  test("a stdio server that crashes on the era probe is respawned as legacy", async () => {
    // Fragile legacy stdio servers can exit on the server/discover probe.
    // The manager must respawn the process once and reconnect with a legacy
    // era verdict so the server still comes up.
    const command = "node crash-on-probe.js";
    configService.listServers = mock(() => Promise.resolve({ crashy: stdioConfig(command) }));
    servers.serve(command, (attempt) =>
      attempt === 1
        ? { connect: () => Promise.reject(new Error("Connection closed")) }
        : { tools: { crashy_tool: testTool() } }
    );

    const result = await manager.getToolsForWorkspace(workspaceRequest("ws-probe-crash"));

    expect(servers.exec).toHaveBeenCalledTimes(2);
    expect(connectPriors()).toEqual([undefined, { kind: "legacy" }]);
    expect(Object.keys(result.tools)).toEqual(["crashy_crashy_tool"]);
  });

  test("a rejected cached legacy verdict triggers a fresh era probe", async () => {
    // A server cached as legacy can be upgraded in place to a 2026-only
    // implementation that rejects the initialize handshake. The manager must
    // drop the cached verdict and re-probe instead of failing every startup
    // until the verdict TTL expires.
    const command = "node upgraded-server.js";
    configService.listServers = mock(() => Promise.resolve({ upgraded: stdioConfig(command) }));
    const tools = { upgraded_tool: testTool() };
    servers.serve(command, (attempt) => {
      // Call 1: fresh probe -> legacy verdict cached.
      if (attempt === 1) return { tools, era: "legacy" };
      // Call 2: cached legacy verdict -> the upgraded server rejects the
      // initialize handshake.
      if (attempt === 2) {
        return {
          connect: () =>
            Promise.reject(new Error("initialize rejected: unsupported protocol version")),
        };
      }
      // Call 3: fresh re-probe -> modern.
      return { tools, era: "modern" };
    });
    const request = workspaceRequest("ws-legacy-verdict-rejected");

    const first = await manager.getToolsForWorkspace(request);
    expect(Object.keys(first.tools)).toEqual(["upgraded_upgraded_tool"]);

    // The process exits, so the next serve restarts it under the cached verdict.
    await servers.crash(command);
    const second = await manager.getToolsForWorkspace(request);
    expect(connectPriors()).toEqual([undefined, { kind: "legacy" }, undefined]);
    expect(Object.keys(second.tools)).toEqual(["upgraded_upgraded_tool"]);
  });

  test("getToolsForWorkspace tracks failed server names in stats", async () => {
    const workspaceId = "ws-failed-names";
    configService.listServers = mock(() =>
      Promise.resolve({
        "healthy-server": stdioConfig("ok"),
        "broken-server": stdioConfig("bad"),
      })
    );

    servers.serve("ok");
    servers.serve("bad", { connect: () => Promise.reject(new Error("invalid MCP server config")) });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.stats.failedServerCount).toBe(1);
    expect(result.stats.failedServerNames).toContain("broken-server");
  });

  test("getToolsForWorkspace suffixes MCP tools that collide with built-in tool names", async () => {
    const workspaceId = "ws-builtin-collision";
    configService.listServers = mock(() => Promise.resolve({ mcp: stdioConfig("cmd") }));
    servers.serve("cmd", { tools: { prompt_get: testTool(), other_tool: testTool() } });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    const names = Object.keys(result.tools);
    // "mcp" + "prompt_get" normalizes to the built-in mcp_prompt_get name.
    expect(names).not.toContain("mcp_prompt_get");
    expect(names.some((name) => name.startsWith("mcp_prompt_get_"))).toBe(true);
    expect(names).toContain("mcp_other_tool");
  });

  test("getToolsForWorkspace drops prompts whose argument names cannot round-trip", async () => {
    const workspaceId = "ws-oversized-arg-name";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", {
      prompts: [
        { name: "usable", arguments: [{ name: "pr", required: true }] },
        { name: "stuck", arguments: [{ name: "a".repeat(5_000), required: true }] },
        {
          name: "partial",
          arguments: [
            { name: "ok", required: true },
            { name: "b".repeat(5_000), required: false },
          ],
        },
      ],
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Both oversized-name prompts are dropped, not rewritten: composer slash
    // invocation maps tokens positionally, so a stripped argument would
    // silently misassign the remaining tokens.
    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["usable"]);
  });

  test("getToolsForWorkspace drops oversized prompt names and clamps descriptions at refresh", async () => {
    const workspaceId = "ws-oversized-prompt-fields";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", {
      prompts: [
        { name: "n".repeat(1024 * 1024) },
        {
          name: "wordy",
          description: "d".repeat(1024 * 1024),
          arguments: [{ name: "pr", description: "a".repeat(1024 * 1024), required: true }],
        },
      ],
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["wordy"]);
    const wordy = result.promptDescriptors[0];
    expect(wordy?.description?.length).toBe(MCP_PROMPT_MAX_DESCRIPTION_CHARS);
    expect(wordy?.arguments?.[0]?.description?.length).toBe(MCP_PROMPT_MAX_DESCRIPTION_CHARS);
  });

  test("getToolsForWorkspace advertises no prompts for a server whose name cannot round-trip", async () => {
    const workspaceId = "ws-oversized-server-name";
    const hugeName = "s".repeat(1024 * 1024);
    configService.listServers = mock(() =>
      Promise.resolve({ [hugeName]: stdioConfig("cmd-huge"), coder: stdioConfig("cmd") })
    );
    servers.serve("cmd-huge", { prompts: [{ name: "hidden" }] });
    servers.serve("cmd", { prompts: [{ name: "visible" }] });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // The oversized server name would otherwise prefix every prompt key and
    // rerun Unicode/regex normalization over it per prompt.
    expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual([
      "visible",
    ]);
  });

  test("prompt catalogs are normalized once at refresh, off the per-send rebuild path", async () => {
    const workspaceId = "ws-hostile-arg-count";
    let rawElementReads = 0;
    const hostileArguments = new Proxy(
      Array.from({ length: 100_000 }, (_, index) => ({
        name: `arg_${index}`,
        required: index === 90_000,
      })),
      {
        get(target, property, receiver): unknown {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rawElementReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    let refreshCalls = 0;
    const oneShotRefresh = mock(() => {
      refreshCalls += 1;
      return refreshCalls === 1
        ? Promise.resolve([
            { name: "hostile", arguments: hostileArguments },
            {
              name: "usable",
              arguments: Array.from({ length: MCP_PROMPT_MAX_ARGUMENTS }, (_, index) => ({
                name: `arg_${index}`,
                required: index === 0,
              })),
            },
          ])
        : new Promise<never>(() => undefined);
    });
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { listPrompts: oneShotRefresh });

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The over-cap prompt is dropped by the length gate without reading a
    // single element, and no per-send path revisits the raw array.
    expect(rawElementReads).toBe(0);
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(rawElementReads).toBe(0);
    expect(second.promptDescriptors).toBe(first.promptDescriptors);
    for (const result of [first, second]) {
      expect(result.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual([
        "usable",
      ]);
      expect(result.promptDescriptors[0]?.arguments).toHaveLength(MCP_PROMPT_MAX_ARGUMENTS);
    }
  });

  test("getToolsForWorkspace returns prompt descriptors alongside tools", async () => {
    const workspaceId = "ws-tool-prompts";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", {
      prompts: [
        {
          name: "review",
          description: "Review a PR",
          arguments: [{ name: "pr", required: true }],
        },
      ],
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.promptDescriptors).toHaveLength(1);
    expect(result.promptDescriptors[0]).toMatchObject({
      serverName: "coder",
      promptName: "review",
      description: "Review a PR",
      arguments: [{ name: "pr", required: true }],
    });
  });

  test("a client closed during catalog refresh is excluded from the returned tools", async () => {
    const workspaceId = "closed-during-refresh";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd") }));
    // The process exits while the serve awaits the startup prompt-catalog
    // refresh, after the instance was published as healthy.
    const listPrompts = mock(async () => {
      await servers.crash("cmd");
      return [];
    });
    servers.serve("cmd", { tools: { work: testTool() }, listPrompts });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(listPrompts).toHaveBeenCalledTimes(1);
    expect(result.tools).toEqual({});
    expect(result.toolServerNames).toEqual({});
  });

  test("a closed client observed by a background tools/list refresh is excluded from that response", async () => {
    const workspaceId = "closed-during-background-refresh";
    const url = "https://mcp.example.test/refresh";
    configService.listServers = mock(() =>
      Promise.resolve({ server: { transport: "http" as const, url, disabled: false } })
    );
    // tools/list call 1 is the startup fetch; call 2 is the cached serve's
    // background refresh, whose request surfaces the transport as closed
    // (the client's onUncaughtError) before the serve collects its tools.
    const listTools = mock((): Promise<Record<string, Tool>> => {
      if (listTools.mock.calls.length > 1) {
        // Read at call time: the harness installs its createMCPClient spy on serve().
        const connects = mcpSdk.createMCPClient as unknown as {
          mock: { calls: Array<[mcpSdk.MCPClientConfig]> };
        };
        connects.mock.calls.at(-1)![0].onUncaughtError?.(new Error("Connection closed"));
      }
      return Promise.resolve({ work: testTool() });
    });
    servers.serve(url, { era: "modern", listTools });
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toEqual(["server_work"]);
    const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(next.tools).toEqual({});
    expect(next.toolServerNames).toEqual({});
  });

  test("getToolsForWorkspace serves the cached tool catalog and refreshes it in the background", async () => {
    const workspaceId = "ws-tools-stale-while-revalidate";
    configService.listServers = mock(() => Promise.resolve({ modern: stdioConfig("cmd") }));
    const heldRefresh = Promise.withResolvers<void>();
    // tools/list: call 1 is the startup fetch, call 2 the first (held)
    // background refresh that grows the catalog.
    const listTools = mock(async (): Promise<Record<string, Tool>> => {
      const call = listTools.mock.calls.length;
      if (call === 1) return { alpha: testTool() };
      if (call === 2) await heldRefresh.promise;
      return { alpha: testTool(), beta: testTool() };
    });
    servers.serve("cmd", { era: "modern", listTools });

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toEqual(["modern_alpha"]);
    expect(listTools).toHaveBeenCalledTimes(1);

    // The refresh is held open: an awaited tools/list would hang this send.
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(second.tools)).toEqual(["modern_alpha"]);
    expect(listTools).toHaveBeenCalledTimes(2);

    // Deduped per instance while the first refresh is still in flight.
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(third.tools)).toEqual(["modern_alpha"]);
    expect(listTools).toHaveBeenCalledTimes(2);

    heldRefresh.resolve();
    await Bun.sleep(0);

    const fourth = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(fourth.tools).sort()).toEqual(["modern_alpha", "modern_beta"]);
    expect(listTools).toHaveBeenCalledTimes(3);
  });

  test("timed-out server retries back off exponentially and reset on a config change", async () => {
    const workspaceId = "ws-timeout-retry-backoff";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({ flaky: { transport: "stdio" as const, command, disabled: false } })
    );
    servers.serve("cmd-1", { hang: true });
    const request = workspaceRequest(workspaceId);

    // The initial startup timeout is the first failure: serves inside the
    // base window (one startup timeout) do not pay a second timeout.
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    const firstTimeoutAt = Date.now();
    expect(servers.connectCount("cmd-1")).toBe(1);
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-1")).toBe(1);
    setSystemTime(new Date(firstTimeoutAt + 59_999));
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-1")).toBe(1);
    setSystemTime(new Date(firstTimeoutAt + 60_000));
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-1")).toBe(2);

    // One retry timeout: the window doubles.
    const secondTimeoutAt = Date.now();
    setSystemTime(new Date(secondTimeoutAt + 119_999));
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-1")).toBe(2);
    setSystemTime(new Date(secondTimeoutAt + 120_000));
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-1")).toBe(3);

    // A config change restarts the server and clears its backoff, so the
    // schedule restarts from the base window.
    command = "cmd-2";
    servers.serve("cmd-2", { hang: true });
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-2")).toBe(1);
    const restartTimeoutAt = Date.now();
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-2")).toBe(1);
    setSystemTime(new Date(restartTimeoutAt + 60_000));
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-2")).toBe(2);
    expect(servers.connectCount("cmd-1")).toBe(3);
  });

  test("timed-out retry backoff is measured from the attempt's own completion, not the batch's", async () => {
    const workspaceId = "ws-timeout-retry-attempt-time";
    // Hanging servers fill every startup slot, so "slow" starts only after
    // their first-wave timeouts and settles the batch 45 s later.
    const hanging = Array.from(
      { length: MCP_STARTUP_CONCURRENCY },
      (_, index) => `flaky-${index + 1}`
    );
    configService.listServers = mock(() =>
      Promise.resolve({
        ...Object.fromEntries(hanging.map((name) => [name, stdioConfig(name)])),
        slow: stdioConfig("cmd-slow"),
      })
    );
    for (const name of hanging) servers.serve(name, { hang: true });
    let slowStartedAt = 0;
    servers.serve("cmd-slow", {
      connect: () => {
        slowStartedAt = Date.now();
        setSystemTime(new Date(slowStartedAt + 45_000));
        return Promise.resolve();
      },
    });
    const request = workspaceRequest(workspaceId);
    const startedAt = Date.now();
    await servers.expireStartupDeadline(
      () => manager.getToolsForWorkspace(request),
      MCP_STARTUP_CONCURRENCY
    );
    const settledAt = Date.now();
    // The fixture shape itself: the timeouts finished a wave before the batch.
    expect(slowStartedAt - startedAt).toBeGreaterThanOrEqual(MCP_STARTUP_TIMEOUT_MS);
    expect(settledAt).toBe(slowStartedAt + 45_000);

    // Their first window ends one startup timeout after they timed out,
    // 15 s after the batch settled.
    for (const name of hanging) servers.serve(name);
    setSystemTime(new Date(settledAt + 14_999));
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("flaky-1")).toBe(0);
    setSystemTime(new Date(settledAt + 15_000));
    await manager.getToolsForWorkspace(request);
    for (const name of hanging) expect(servers.connectCount(name)).toBe(1);
    expect(servers.connectCount("cmd-slow")).toBe(1);
  });

  test("a closed companion's full restart keeps a backed-off server on its schedule", async () => {
    const workspaceId = "ws-timeout-backoff-closed-companion";
    configService.listServers = mock(() =>
      Promise.resolve({ healthy: stdioConfig("cmd-h"), flaky: stdioConfig("cmd-f") })
    );
    servers.serve("cmd-h");
    servers.serve("cmd-f", { hang: true });
    const request = workspaceRequest(workspaceId);

    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-f")).toBe(1);

    // The healthy client dies with no lease held, forcing a full restart of
    // the entry. The backed-off server must not be started again with it.
    await servers.crash("cmd-h");
    const restarted = await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-h")).toBe(2);
    expect(servers.connectCount("cmd-f")).toBe(1);
    expect(restarted.stats.failedServerNames).toEqual(["flaky"]);
    expect(restarted.stats.startedServerCount).toBe(1);

    // Its window continues from the original timeout rather than restarting.
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-f")).toBe(1);
    elapseTimedOutRetryBackoff();
    servers.serve("cmd-f", { tools: { ping: testTool() } });
    const retried = await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-f")).toBe(1);
    expect(servers.connectCount("cmd-h")).toBe(2);
    expect(Object.keys(retried.tools)).toEqual(["flaky_ping"]);
  });

  test("a closed companion's restart after the window elapsed continues the schedule", async () => {
    const workspaceId = "ws-timeout-backoff-closed-companion-elapsed";
    configService.listServers = mock(() =>
      Promise.resolve({ healthy: stdioConfig("cmd-h"), flaky: stdioConfig("cmd-f") })
    );
    servers.serve("cmd-h");
    servers.serve("cmd-f", { hang: true });
    const request = workspaceRequest(workspaceId);
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-f")).toBe(1);

    // The window has elapsed when the companion dies, so the full restart
    // includes the flaky server; its second timeout is failure number two.
    setSystemTime(new Date(Date.now() + MCP_STARTUP_TIMEOUT_MS));
    await servers.crash("cmd-h");
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    expect(servers.connectCount("cmd-h")).toBe(2);
    expect(servers.connectCount("cmd-f")).toBe(2);

    // Second window is 120 s, not the 60 s base again.
    const secondTimeoutAt = Date.now();
    setSystemTime(new Date(secondTimeoutAt + 119_999));
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-f")).toBe(2);
    setSystemTime(new Date(secondTimeoutAt + 120_000));
    servers.serve("cmd-f");
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("cmd-f")).toBe(1);
    expect(servers.connectCount("cmd-h")).toBe(2);
  });

  test("getToolsForWorkspace re-polls legacy and modern prompt catalogs each stream", async () => {
    const workspaceId = "ws-prompt-freshness";
    configService.listServers = mock(() =>
      Promise.resolve({ legacy: stdioConfig("cmd-legacy"), modern: stdioConfig("cmd-modern") })
    );
    const promptLister = (label: string) => {
      let fetches = 0;
      return mock(() => {
        fetches += 1;
        return Promise.resolve([{ name: `${label}-v${fetches}` }]);
      });
    };
    const legacyPrompts = promptLister("legacy");
    const modernPrompts = promptLister("modern");
    servers.serve("cmd-legacy", { era: "legacy", listPrompts: legacyPrompts });
    servers.serve("cmd-modern", { era: "modern", listPrompts: modernPrompts });

    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Let the second send's background refresh land before the third send.
    await Bun.sleep(0);
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(legacyPrompts).toHaveBeenCalledTimes(3);
    expect(modernPrompts).toHaveBeenCalledTimes(3);
    expect(first.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v1",
      "modern-v1",
    ]);
    expect(second.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v1",
      "modern-v1",
    ]);
    expect(third.promptDescriptors.map((descriptor) => descriptor.promptName).sort()).toEqual([
      "legacy-v2",
      "modern-v2",
    ]);
  });

  test("an older prompt refresh completing late never overwrites a newer catalog", async () => {
    const workspaceId = "ws-refresh-race";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    let calls = 0;
    let resolveStale!: (prompts: Array<{ name: string }>) => void;
    const listPrompts = mock(() => {
      calls += 1;
      // Call 1 seeds the cache, call 2 is held stale, and call 3 wins through
      // direct discovery. Later calls hang.
      if (calls === 1) return Promise.resolve([{ name: "initial" }]);
      if (calls === 2)
        return new Promise<Array<{ name: string }>>((resolve) => {
          resolveStale = resolve;
        });
      if (calls === 3) return Promise.resolve([{ name: "newer" }]);
      return new Promise<Array<{ name: string }>>(() => undefined);
    });
    servers.serve("cmd", { listPrompts });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const discovered = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(discovered.map((descriptor) => descriptor.promptName)).toEqual(["newer"]);

    resolveStale([{ name: "stale" }]);
    await Bun.sleep(0);

    const final = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(final.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["newer"]);
  });

  test("getToolsForWorkspace does not block sends on a hung prompt refresh", async () => {
    const workspaceId = "ws-hung-prompt-refresh";
    configService.listServers = mock(() => Promise.resolve({ hung: stdioConfig("cmd") }));
    const neverSettles = mock(() =>
      neverSettles.mock.calls.length === 1
        ? Promise.resolve([{ name: "cached" }])
        : new Promise<Array<{ name: string }>>(() => undefined)
    );
    servers.serve("cmd", { listPrompts: neverSettles });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(second.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["cached"]);
    expect(third.promptDescriptors.map((descriptor) => descriptor.promptName)).toEqual(["cached"]);
    expect(neverSettles).toHaveBeenCalledTimes(2);
  });

  test("getToolsForWorkspace retries timed-out servers from cached workspace state", async () => {
    const workspaceId = "ws-timeout-retry";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );
    servers.serve("cmd-a", { tools: { toolA: testTool() } });
    servers.serve("cmd-b", { hang: true });

    const initial = await servers.expireStartupDeadline(() =>
      manager.getToolsForWorkspace(workspaceRequest(workspaceId))
    );

    expect(initial.stats.failedServerCount).toBe(1);
    expect(initial.stats.failedServerNames).toEqual(["serverB"]);
    expect(initial.stats.startedServerCount).toBe(1);
    expect(Object.keys(initial.tools)).toEqual(["servera_toola"]);

    elapseTimedOutRetryBackoff();
    servers.serve("cmd-b", { tools: { toolB: testTool() } });
    const retried = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Only the timed-out server is retried; the healthy client is reused.
    expect(servers.connectCount("cmd-a")).toBe(1);
    expect(servers.connectCount("cmd-b")).toBe(1);
    expect(retried.stats.failedServerCount).toBe(0);
    expect(retried.stats.failedServerNames).toEqual([]);
    expect(retried.stats.startedServerCount).toBe(2);
    const retriedToolNames = Object.keys(retried.tools);
    expect(retriedToolNames).toContain("servera_toola");
    expect(retriedToolNames).toContain("serverb_toolb");

    // The retry cleared the timeout: later serves neither retry nor report it.
    elapseTimedOutRetryBackoff();
    const settled = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd-b")).toBe(1);
    expect(settled.stats.failedServerNames).toEqual([]);
  });

  test("getToolsForWorkspace does not overlap timed-out retries for concurrent cached requests", async () => {
    const workspaceId = "ws-timeout-retry-concurrent";
    configService.listServers = mock(() =>
      Promise.resolve({
        slow: stdioConfig("cmd-slow"),
      })
    );
    servers.serve("cmd-slow", { hang: true });
    await servers.expireStartupDeadline(() =>
      manager.getToolsForWorkspace(workspaceRequest(workspaceId))
    );
    elapseTimedOutRetryBackoff();

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<void>();
    servers.serve("cmd-slow", {
      tools: { tool: testTool() },
      connect: () => {
        retryStarted.resolve();
        return retryFinished.promise;
      },
    });

    const firstPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await retryStarted.promise;

    // A concurrent request settles on the cached state instead of stacking a
    // second startup attempt behind the in-flight retry.
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd-slow")).toBe(1);
    expect(second.stats.failedServerNames).toEqual(["slow"]);

    retryFinished.resolve();
    const first = await firstPromise;

    expect(servers.connectCount("cmd-slow")).toBe(1);
    expect(first.stats.failedServerCount).toBe(0);
    expect(Object.keys(first.tools)).toEqual(["slow_tool"]);

    // The retried client is cached and its retry marker released.
    const cached = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd-slow")).toBe(1);
    expect(cached.stats.failedServerCount).toBe(0);
    expect(Object.keys(cached.tools)).toEqual(["slow_tool"]);
  });

  test("getToolsForWorkspace closes timed-out retry results when cache entry is replaced mid-retry", async () => {
    const workspaceId = "ws-timeout-retry-replaced";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        slow: { transport: "stdio", command, disabled: false },
      })
    );
    servers.serve("cmd-1", { hang: true });
    await servers.expireStartupDeadline(() =>
      manager.getToolsForWorkspace(workspaceRequest(workspaceId))
    );
    elapseTimedOutRetryBackoff();

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<void>();
    const retriedClose = mock(() => Promise.resolve(undefined));
    const replacementClose = mock(() => Promise.resolve(undefined));
    servers.serve("cmd-1", {
      tools: { retry: testTool() },
      close: retriedClose,
      connect: () => {
        retryStarted.resolve();
        return retryFinished.promise;
      },
    });
    servers.serve("cmd-2", { tools: { active: testTool() }, close: replacementClose });

    const retryPromise = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await retryStarted.promise;

    command = "cmd-2";
    const replacementResult = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(Object.keys(replacementResult.tools)).toEqual(["slow_active"]);

    retryFinished.resolve();
    const retriedResult = await retryPromise;

    expect(servers.connectCount("cmd-1")).toBe(1);
    expect(servers.connectCount("cmd-2")).toBe(1);
    expect(retriedClose).toHaveBeenCalledTimes(1);
    expect(replacementClose).toHaveBeenCalledTimes(0);
    expect(Object.keys(retriedResult.tools)).toEqual(["slow_active"]);

    // The replacement stays the cached client; the stale retry never lands.
    const cached = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(cached.tools)).toEqual(["slow_active"]);
    expect(servers.connectCount("cmd-2")).toBe(1);
    expect(replacementClose).toHaveBeenCalledTimes(0);
  });

  test.each([false, true])(
    "additive config preserves existing clients (leased: %s)",
    async (leased) => {
      const workspaceId = "ws-additive";
      const pluginKey = "plugin_example_selected";
      const configs = {
        ordinary: stdioConfig("ordinary"),
        plugin_existing: stdioConfig("existing"),
      };
      configService.listServers = mock(() => Promise.resolve({ ...configs }));
      const serveEcho = (command: string) => {
        // Modern clients get background tools/list refreshes on cached serves.
        // Each server's tool answers with its own command, so a swapped retained
        // client is observable through the served tools.
        const listTools = mock(() => Promise.resolve({ echo: testTool(command) }));
        const close = mock(() => Promise.resolve(undefined));
        servers.serve(command, { era: "modern", listTools, prompts: [{ name: "review" }], close });
        return { listTools, close };
      };
      const ordinary = serveEcho("ordinary");
      const existing = serveEcho("existing");
      serveEcho("selected");
      const request = workspaceRequest(workspaceId, {
        overrides: { enabledServers: [pluginKey] },
      });
      const first = await manager.getToolsForWorkspace(request);
      expect(servers.connectCount("ordinary")).toBe(1);
      expect(servers.connectCount("existing")).toBe(1);
      expect(servers.connectCount("selected")).toBe(0);
      expect(ordinary.listTools).toHaveBeenCalledTimes(1);
      if (leased) manager.acquireLease(workspaceId);
      try {
        // An old enable override only takes effect once the selected server exists.
        Object.assign(configs, { [pluginKey]: stdioConfig("selected", true) });
        const result = await manager.getToolsForWorkspace(request);
        // Only the addition starts; the existing clients are retained as-is.
        expect(servers.connectCount("selected")).toBe(1);
        expect(servers.connectCount("ordinary")).toBe(1);
        expect(servers.connectCount("existing")).toBe(1);
        expect(ordinary.close).not.toHaveBeenCalled();
        expect(existing.close).not.toHaveBeenCalled();
        expect(Object.keys(first.tools).sort()).toEqual(["ordinary_echo", "plugin_existing_echo"]);
        expect(await result.tools.plugin_existing_echo.execute!({}, {} as never)).toBe("existing");
        expect(await result.tools.ordinary_echo.execute!({}, {} as never)).toBe("ordinary");
        expect(await result.tools[`${pluginKey}_echo`].execute!({}, {} as never)).toBe("selected");
        expect(result.stats.startedServerCount).toBe(3);
        expect(result.promptDescriptors.map((prompt) => prompt.serverName).sort()).toEqual(
          ["ordinary", "plugin_existing", pluginKey].sort()
        );
        // The retained client got one background catalog refresh on top of
        // its startup tools/list.
        expect(ordinary.listTools).toHaveBeenCalledTimes(2);
        await manager.getToolsForWorkspace(request);
        expect(servers.connectCount("selected")).toBe(1);
        expect(servers.connectCount("ordinary")).toBe(1);
        expect(servers.connectCount("existing")).toBe(1);
      } finally {
        if (leased) manager.releaseLease(workspaceId);
      }
    }
  );

  test("additive startup preserves a concurrent timeout retry's state", async () => {
    const request = workspaceRequest("ws-additive-retry");
    const configs = { stable: stdioConfig("stable"), slow: stdioConfig("slow") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stableClose = mock(() => Promise.resolve(undefined));
    servers.serve("stable", { tools: { echo: testTool() }, close: stableClose });
    servers.serve("slow", { hang: true });
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    elapseTimedOutRetryBackoff();

    const retryStarted = Promise.withResolvers<void>();
    const retryFinished = Promise.withResolvers<void>();
    servers.serve("slow", {
      tools: { echo: testTool() },
      connect: () => {
        retryStarted.resolve();
        return retryFinished.promise;
      },
    });
    const retry = manager.getToolsForWorkspace(request);
    await retryStarted.promise;
    // "addedBroken" has no fake server, so its startup fails outright (a
    // failed stdio connect is respawned once as legacy: two connections).
    Object.assign(configs, {
      addedSlow: stdioConfig("addedSlow"),
      addedBroken: stdioConfig("addedBroken"),
    });
    servers.serve("addedSlow", { hang: true });
    await servers.expireStartupDeadline(() => manager.getToolsForWorkspace(request));
    retryFinished.resolve();
    const result = await retry;
    expect(result.stats.enabledServerCount).toBe(4);
    expect(result.stats.failedServerNames.sort()).toEqual(["addedBroken", "addedSlow"]);
    expect(Object.keys(result.tools).sort()).toEqual(["slow_echo", "stable_echo"]);
    expect(stableClose).not.toHaveBeenCalled();
    // Each server was started once: the initial start, the retry, and the
    // additive startup never overlapped.
    expect(servers.connectCount("stable")).toBe(1);
    expect(servers.connectCount("slow")).toBe(1);
    expect(servers.connectCount("addedSlow")).toBe(1);
    expect(servers.connectCount("addedBroken")).toBe(2);

    // The addition's timeout survived the retry's publication: it is retried
    // after its window, while the hard failure is not.
    servers.serve("addedSlow");
    elapseTimedOutRetryBackoff();
    await manager.getToolsForWorkspace(request);
    expect(servers.connectCount("addedSlow")).toBe(1);
    expect(servers.connectCount("addedBroken")).toBe(2);
    expect(servers.connectCount("slow")).toBe(1);
    expect(servers.connectCount("stable")).toBe(1);
  });

  test("additive startup preserves a leased closed-client recovery", async () => {
    const request = workspaceRequest("ws-additive-recovery");
    const configs = { stable: stdioConfig("stable"), dead: stdioConfig("dead") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stableClose = mock(() => Promise.resolve(undefined));
    const deadClose = mock(() => Promise.resolve(undefined));
    servers.serve("stable", { close: stableClose });
    servers.serve("dead", { close: deadClose });
    servers.serve("added", { tools: { echo: testTool() } });
    await manager.getToolsForWorkspace(request);
    manager.acquireLease(request.workspaceId);
    try {
      const recoveryStarted = Promise.withResolvers<void>();
      const recoveryFinished = Promise.withResolvers<void>();
      await servers.crash("dead");
      servers.serve("dead", {
        tools: { echo: testTool() },
        connect: () => {
          recoveryStarted.resolve();
          return recoveryFinished.promise;
        },
      });
      const recovery = manager.getToolsForWorkspace(request);
      await recoveryStarted.promise;
      Object.assign(configs, { added: stdioConfig("added") });
      await manager.getToolsForWorkspace(request);
      recoveryFinished.resolve();
      const result = await recovery;
      expect(Object.keys(result.tools).sort()).toEqual(["added_echo", "dead_echo"]);
      expect(result.stats.startedServerCount).toBe(3);
      expect(result.stats.enabledServerCount).toBe(3);
      expect(stableClose).not.toHaveBeenCalled();
      expect(deadClose).toHaveBeenCalledTimes(1);
      expect(servers.connectCount("stable")).toBe(1);
      expect(servers.connectCount("dead")).toBe(1);
      expect(servers.connectCount("added")).toBe(1);
    } finally {
      manager.releaseLease(request.workspaceId);
    }
  });

  test("additive requests serialize and do not roll back a newer config snapshot", async () => {
    const request = workspaceRequest("ws-additive-concurrent");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stableClose = mock(() => Promise.resolve(undefined));
    servers.serve("stable", { close: stableClose });
    await manager.getToolsForWorkspace(request);
    const startupEntered = Promise.withResolvers<void>();
    const startupFinished = Promise.withResolvers<void>();
    servers.serve("added", {
      connect: async () => {
        startupEntered.resolve();
        await startupFinished.promise;
      },
    });
    servers.serve("newest");
    Object.assign(configs, { added: stdioConfig("added"), newest: stdioConfig("newest") });
    const newer = manager.getToolsForWorkspace(request);
    await startupEntered.promise;
    // Park an older config read until the larger selection has published.
    const oldReadEntered = Promise.withResolvers<void>();
    const oldReadFinished = Promise.withResolvers<{
      stable: ReturnType<typeof stdioConfig>;
      added: ReturnType<typeof stdioConfig>;
    }>();
    configService.listServers.mockImplementationOnce(() => {
      oldReadEntered.resolve();
      return oldReadFinished.promise;
    });
    // The older request's re-read (taken because a newer publication landed
    // during its config read) must keep the caller's abort signal: an
    // interrupted turn cancels the disk re-read on every recursion level.
    // Private call: a recursion level forwards readSignal only to its disk
    // override re-read, which it takes only under a concurrent invalidation
    // (a different race), and listServers never receives the signal.
    const internals = manager as unknown as {
      ensureWorkspaceServers: (...args: unknown[]) => Promise<unknown>;
    };
    const originalEnsure = internals.ensureWorkspaceServers.bind(manager);
    const readSignals: unknown[] = [];
    internals.ensureWorkspaceServers = (...args: unknown[]) => {
      readSignals.push(args[2]);
      return originalEnsure(...args);
    };
    const olderSignal = new AbortController().signal;
    const older = manager.getToolsForWorkspace(request, { signal: olderSignal });
    await oldReadEntered.promise;
    startupFinished.resolve();
    await newer;
    oldReadFinished.resolve({ stable: configs.stable, added: stdioConfig("added") });
    await older;
    internals.ensureWorkspaceServers = originalEnsure;
    expect(readSignals.length).toBeGreaterThanOrEqual(2);
    expect(readSignals.every((signal) => signal === olderSignal)).toBe(true);
    // Only the newer request started anything; the older one never restarted
    // or re-started servers from its smaller snapshot.
    for (const key of ["stable", "added", "newest"]) expect(servers.connectCount(key)).toBe(1);
    expect(stableClose).not.toHaveBeenCalled();
    expect((await manager.getToolsForWorkspace(request)).stats.startedServerCount).toBe(3);
  });

  test.each(["startup", "publication"])(
    "additive startup discards clients removed during %s",
    async (phase) => {
      const request = workspaceRequest("ws-additive-removed");
      // Publication runs no server callback, so the publication variant arms
      // the stop on the component-policy read that publication performs
      // after startup (plugin component wiring; non-plugin servers stay allowed).
      let stopOnPolicyRead = false;
      let stopped: Promise<void> | undefined;
      if (phase === "publication") {
        manager.dispose();
        manager = new MCPServerManager(configService as unknown as MCPConfigService, {
          pluginInvalidation: {
            keyPrefix: "plugin:",
            readToken: () => Promise.resolve("epoch-1"),
            readComponentPolicy: () => {
              if (stopOnPolicyRead) {
                stopOnPolicyRead = false;
                stopped = manager.stopServers(request.workspaceId);
              }
              return Promise.resolve({ registryPath: "", imports: null });
            },
          },
        });
      }
      const configs = { stable: stdioConfig("stable") };
      configService.listServers = mock(() => Promise.resolve({ ...configs }));
      const stableClose = mock(() => Promise.resolve(undefined));
      const addedClose = mock(() => Promise.resolve(undefined));
      servers.serve("stable", { close: stableClose });
      await manager.getToolsForWorkspace(request);
      Object.assign(configs, { added: stdioConfig("added") });
      servers.serve("added", (attempt) => ({
        tools: { echo: testTool() },
        close: addedClose,
        connect: async () => {
          if (attempt > 1) return;
          if (phase === "startup") await manager.stopServers(request.workspaceId);
          // The tools/list that follows is still startup; arm for publication.
          else stopOnPolicyRead = true;
        },
      }));
      const result = await manager.getToolsForWorkspace(request);
      await stopped;
      expect(Object.keys(result.tools)).toEqual([]);
      expect(stableClose).toHaveBeenCalledTimes(1);
      expect(addedClose).toHaveBeenCalledTimes(1);
      // Nothing was published for the removed workspace: the next request
      // starts both servers afresh instead of serving the discarded clients.
      const next = await manager.getToolsForWorkspace(request);
      expect(next.stats.startedServerCount).toBe(2);
      expect(servers.connectCount("stable")).toBe(2);
      expect(servers.connectCount("added")).toBe(2);
    }
  );

  test("additive startup retries invalidated additions without closing unrelated clients", async () => {
    const request = workspaceRequest("ws-additive-invalidated");
    const pluginKey = "plugin:added:echo";
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const stableClose = mock(() => Promise.resolve(undefined));
    const addedClose = mock(() => Promise.resolve(undefined));
    servers.serve("stable", { close: stableClose });
    await manager.getToolsForWorkspace(request);
    Object.assign(configs, { [pluginKey]: stdioConfig("added") });
    // The plugin tree is swapped while the addition is starting.
    servers.serve("added", (attempt) => ({
      close: addedClose,
      connect: async () => {
        if (attempt === 1) await manager.stopServersWithKeyPrefix("plugin:added:");
      },
    }));
    const result = await manager.getToolsForWorkspace(request);
    expect(result.stats.startedServerCount).toBe(1);
    expect(stableClose).not.toHaveBeenCalled();
    expect(addedClose).toHaveBeenCalledTimes(1);
    // The next request retries only the invalidated addition.
    expect((await manager.getToolsForWorkspace(request)).stats.startedServerCount).toBe(2);
    expect(servers.connectCount("added")).toBe(2);
    expect(servers.connectCount("stable")).toBe(1);
  });

  test("additive startup repairs prompt enablement after a concurrent disable", async () => {
    const request = workspaceRequest("ws-additive-disable");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    servers.serve("stable", { prompts: [{ name: "status" }] });
    await manager.getToolsForWorkspace(request);
    Object.assign(configs, { added: stdioConfig("added") });
    const listPrompts = mock(() => Promise.resolve([{ name: "review" }]));
    servers.serve("added", {
      listPrompts,
      connect: () =>
        manager.applyWorkspaceOverrides(request.workspaceId, { disabledServers: ["added"] }),
    });
    const result = await manager.getToolsForWorkspace(request);
    expect(result.promptDescriptors.map((prompt) => prompt.serverName)).toEqual(["stable"]);
    expect(listPrompts).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(request.workspaceId, "added", "review", {})).rejects.toThrow(
      "is disabled"
    );
  });

  test("additive publication cannot bypass allowlists in a pending cached request", async () => {
    const request = workspaceRequest("ws-additive-allowlist");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const refreshStarted = Promise.withResolvers<void>();
    const refreshFinished = Promise.withResolvers<void>();
    // Call 1 is startup; call 2 is the cached request's background refresh.
    const listTools = mock(async () => {
      if (listTools.mock.calls.length === 2) {
        refreshStarted.resolve();
        await refreshFinished.promise;
      }
      return {};
    });
    servers.serve("stable", { era: "modern", listTools });
    await manager.getToolsForWorkspace(request);
    const pending = manager.getToolsForWorkspace(request);
    await refreshStarted.promise;
    try {
      Object.assign(configs, { added: { ...stdioConfig("added"), toolAllowlist: ["visible"] } });
      servers.serve("added", { tools: { visible: testTool(), hidden: testTool() } });
      const result = await manager.getToolsForWorkspace(request);
      expect(Object.keys(result.tools)).toEqual(["added_visible"]);
    } finally {
      refreshFinished.resolve();
    }
    const older = await pending;
    expect(older.tools.added_hidden).toBeUndefined();
    expect((await manager.getToolsForWorkspace(request)).tools.added_visible).toBeDefined();
  });

  test.each(["reconfigured", "removed"])(
    "additive detection rejects a %s existing server",
    async (change) => {
      const request = workspaceRequest("ws-not-additive");
      let configs: Record<string, ReturnType<typeof stdioConfig>> = {
        stable: stdioConfig("stable"),
        changed: stdioConfig("before"),
      };
      configService.listServers = mock(() => Promise.resolve(configs));
      const stableClose = mock(() => Promise.resolve(undefined));
      const beforeClose = mock(() => Promise.resolve(undefined));
      servers.serve("stable", { close: stableClose });
      servers.serve("before", { close: beforeClose });
      servers.serve("added");
      servers.serve("after");
      await manager.getToolsForWorkspace(request);
      configs = {
        stable: stdioConfig("stable"),
        added: stdioConfig("added"),
        ...(change === "reconfigured" ? { changed: stdioConfig("after") } : {}),
      };
      await manager.getToolsForWorkspace(request);
      // Not additive: every original client is closed and the unchanged one restarts too.
      expect(stableClose).toHaveBeenCalledTimes(1);
      expect(beforeClose).toHaveBeenCalledTimes(1);
      expect(servers.connectCount("stable")).toBe(2);
    }
  );

  test("additive startup does not duplicate or wait for a retained background prompt refresh", async () => {
    const request = workspaceRequest("ws-additive-prompt-refresh");
    const configs = { stable: stdioConfig("stable") };
    configService.listServers = mock(() => Promise.resolve({ ...configs }));
    const refreshStarted = Promise.withResolvers<void>();
    const refreshFinished = Promise.withResolvers<unknown[]>();
    // Call 1 is the publication fetch; call 2 is the cached request's background refresh.
    const listPrompts = mock(() => {
      if (listPrompts.mock.calls.length !== 2) return Promise.resolve([{ name: "status" }]);
      refreshStarted.resolve();
      return refreshFinished.promise;
    });
    servers.serve("stable", { listPrompts });
    await manager.getToolsForWorkspace(request);
    await manager.getToolsForWorkspace(request);
    await refreshStarted.promise;
    try {
      Object.assign(configs, { added: stdioConfig("added") });
      servers.serve("added", { prompts: [{ name: "review" }] });
      const result = await manager.getToolsForWorkspace(request);
      expect(result.promptDescriptors.map((prompt) => prompt.serverName).sort()).toEqual([
        "added",
        "stable",
      ]);
      expect(listPrompts).toHaveBeenCalledTimes(2);
    } finally {
      refreshFinished.resolve([{ name: "updated" }]);
    }
  });

  test("getToolsForWorkspace defers restarts while leased and applies them on next request", async () => {
    const workspaceId = "ws-defer";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
      })
    );

    const close = mock(() => Promise.resolve(undefined));
    servers.serve("cmd-1", { tools: { tool: testTool() }, close });
    servers.serve("cmd-2", { tools: { tool: testTool() } });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    manager.acquireLease(workspaceId);

    // Change signature while leased.
    command = "cmd-2";

    const leased = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(servers.connectCount("cmd-2")).toBe(0);
    expect(leased.stats.startedServerCount).toBe(1);

    manager.releaseLease(workspaceId);

    // No automatic restart on lease release (avoids closing clients out from under a
    // subsequent stream that already captured the tool objects).
    expect(close).toHaveBeenCalledTimes(0);

    // Next request (no lease) applies the pending restart.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(servers.connectCount("cmd-2")).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("blocks prompt invocation on servers reconfigured while leased", async () => {
    const workspaceId = "ws-stale-prompt";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
        stable: stdioConfig("cmd-stable"),
      })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });
    servers.serve("cmd-2", { getPrompt });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);
    command = "cmd-2";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
        "was reconfigured"
      );
      expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({
        text: "hi",
      });
      // The stale client was never invoked and no replacement started under the lease.
      expect(getPrompt).toHaveBeenCalledTimes(1);
      expect(servers.connectCount("cmd-2")).toBe(0);
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  test("prompt paths skip cached tool catalog refreshes", async () => {
    const workspaceId = "ws-skip-tool-refresh";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    // Modern connections refresh tools/list in the background on cached serves.
    const listTools = mock(() => Promise.resolve({}));
    servers.serve("cmd-1", { era: "modern", getPrompt, listTools });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const startupListCount = listTools.mock.calls.length;
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const toolPathRefreshCount = listTools.mock.calls.length;
    expect(toolPathRefreshCount).toBeGreaterThan(startupListCount);

    // A hung tools/list on any server must not stall prompt listing or invocation.
    await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(listTools).toHaveBeenCalledTimes(toolPathRefreshCount);
  });

  test("blocks prompt invocation when trust is revoked during secret resolution", async () => {
    const workspaceId = "ws-secrets-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    manager.setSecretsResolver(() => {
      manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      return Promise.resolve({});
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when trust is revoked during a same-signature refresh", async () => {
    const workspaceId = "ws-cached-trust";
    // Arm after cold start so revocation lands inside the prompt refresh's
    // config derivation, where the same-signature fast path returns cached servers.
    let revokeOnNextTrustedList = false;
    configService.listServers = mock((_projectPath: string, trusted: boolean) => {
      if (revokeOnNextTrustedList && trusted) {
        revokeOnNextTrustedList = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      );
    });

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    revokeOnNextTrustedList = true;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("background prompt refresh never targets servers revoked by a concurrent mutation", async () => {
    const workspaceId = "ws-refresh-after-repair";
    // Revocation lands inside the cached send's config derivation, after the
    // trust overlay was read but before enablement repair runs.
    let revokeOnNextTrustedList = false;
    configService.listServers = mock((_projectPath: string, trusted: boolean) => {
      if (revokeOnNextTrustedList && trusted) {
        revokeOnNextTrustedList = false;
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      );
    });
    const revokedRefresh = mock(() => Promise.resolve([]));
    const stableRefresh = mock(() => Promise.resolve([]));
    servers.serve("cmd-1", { listPrompts: revokedRefresh });
    servers.serve("cmd-stable", { listPrompts: stableRefresh });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    expect(revokedRefresh).toHaveBeenCalledTimes(1);

    revokeOnNextTrustedList = true;
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    await Bun.sleep(0);

    expect(revokedRefresh).toHaveBeenCalledTimes(1);
    expect(stableRefresh).toHaveBeenCalledTimes(2);
  });

  test("cold-start prompt refresh never targets servers revoked while startup was in flight", async () => {
    const workspaceId = "ws-cold-refresh-after-repair";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    const revokedRefresh = mock(() => Promise.resolve([]));
    const stableRefresh = mock(() => Promise.resolve([]));
    servers.serve("cmd-1", {
      listPrompts: revokedRefresh,
      // Revocation lands while startup is still in flight, before the cold
      // path caches the entry and refreshes prompts.
      connect: () => {
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
        return Promise.resolve();
      },
    });
    servers.serve("cmd-stable", { listPrompts: stableRefresh });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    expect(revokedRefresh).not.toHaveBeenCalled();
    expect(stableRefresh).toHaveBeenCalledTimes(1);
  });

  test("applies overrides recorded before the first workspace request (cold mutation)", async () => {
    const workspaceId = "ws-cold-overrides";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });

    // workspace.mcp.set lands while the manager is cold (no recorded options,
    // no cache entry), then a caller that read pre-mutation persisted
    // overrides starts the workspace with a stale snapshot.
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(result.stats.enabledServerCount).toBe(1);
    expect(servers.connectCount("cmd-1")).toBe(0);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("excludes a server from prompt discovery when trust is revoked right after the refresh", async () => {
    const workspaceId = "ws-post-refresh-discovery-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    servers.serve("cmd-1", { prompts: [{ name: "review" }] });
    servers.serve("cmd-stable", { prompts: [{ name: "status" }] });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    // Revoke in the gap after the discovery refresh resolves: the secret
    // re-resolution is the refresh bracket's last await (resolution 1 runs
    // before the refresh, resolution 2 right after it).
    let resolutions = 0;
    manager.setSecretsResolver(() => {
      resolutions += 1;
      if (resolutions === 2) {
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve({});
    });

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("overlays a trust revocation recorded before a cold workspace's first request", async () => {
    const workspaceId = "ws-cold-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    servers.serve("cmd-1", { prompts: [{ name: "review" }] });
    servers.serve("cmd-stable", { prompts: [{ name: "status" }] });

    // Revocation lands while the workspace is cold (no recorded options), so
    // only the retained per-project trust can correct the stale snapshot the
    // stream captured before the revocation.
    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
    expect(servers.connectCount("cmd-1")).toBe(0);
  });

  test("closes late-started servers instead of caching them for a removed workspace", async () => {
    const workspaceId = "ws-removed-mid-startup";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const close = mock(() => Promise.resolve());
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", {
      tools: { echo: testTool() },
      getPrompt,
      close,
      // Workspace removal lands while startup is in flight: abort-abandoned
      // discovery keeps the startup running, and removal's stopServers finds
      // no cache entry to close.
      connect: () => manager.stopServers(workspaceId),
    });

    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(Object.keys(result.tools)).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    // Nothing was cached: a prompt request finds no connected instance.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is not connected"
    );
    expect(getPrompt).not.toHaveBeenCalled();
    // No (empty) entry was cached either: the next serve starts the server afresh.
    servers.serve("cmd-1", { tools: { echo: testTool() } });
    const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd-1")).toBe(1);
    expect(Object.keys(next.tools)).toEqual(["server_echo"]);
  });

  test("prompt discovery refreshes with resolver-provided secrets and retries on mid-flight rotation", async () => {
    // The secret feeds a header, so each distinct token changes the start
    // signature and reconnects the server: connection N reveals which token
    // the Nth startup used.
    const url = "https://example.com/mcp";
    configService.listServers = mock(() =>
      Promise.resolve({
        coder: { transport: "http", url, headers: { Authorization: { secret: "TOKEN" } } },
      })
    );
    servers.serve(url, (attempt) => ({ prompts: [{ name: `status-${attempt}` }] }));
    // Connection 1 uses the recorded token.
    await manager.getToolsForWorkspace(
      workspaceRequest("workspace", { projectSecrets: { TOKEN: "recorded" } })
    );
    // First resolution returns the pre-rotation token; every later one returns
    // the rotated token, so the post-refresh recheck must force one retry.
    let resolveCount = 0;
    manager.setSecretsResolver(() => {
      resolveCount += 1;
      return Promise.resolve({ TOKEN: resolveCount === 1 ? "old" : "new" });
    });

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));

    // Connection 2 used the resolver's "old" token; the rotation forced
    // connection 3 with "new", whose catalog is the one returned.
    expect(servers.connectCount(url)).toBe(3);
    expect(servers.headersSent(url).map((headers) => headers?.Authorization)).toEqual([
      "recorded",
      "old",
      "new",
    ]);
    expect(descriptors.map((descriptor) => descriptor.promptName)).toEqual(["status-3"]);
  });

  test("forgotten project trust no longer overrides a re-registered project's snapshot", async () => {
    const workspaceId = "ws-forgotten-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    servers.serve("cmd-1", { prompts: [{ name: "review" }] });
    servers.serve("cmd-stable", { prompts: [{ name: "status" }] });

    // A trust grant retained past project removal must not resurrect on the
    // same path's next registration, which starts untrusted.
    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: true }]);
    manager.forgetProjectTrust(PROJECT_PATH);

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: false })
    );
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
    expect(servers.connectCount("cmd-1")).toBe(0);
  });

  test("excludes servers reconfigured while leased from prompt discovery", async () => {
    const workspaceId = "ws-stale-prompt-discovery";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { transport: "stdio", command, disabled: false },
        stable: stdioConfig("cmd-stable"),
      })
    );

    const staleRefresh = mock(() => Promise.resolve([{ name: "review" }]));
    const stableRefresh = mock(() => Promise.resolve([{ name: "status" }]));
    servers.serve("cmd-1", { listPrompts: staleRefresh });
    servers.serve("cmd-stable", { listPrompts: stableRefresh });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    manager.acquireLease(workspaceId);
    command = "cmd-2";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    try {
      staleRefresh.mockClear();
      stableRefresh.mockClear();
      const descriptors = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
      expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
      // The stale instance still points at the old endpoint; discovery must
      // not send prompts/list there with potentially obsolete credentials.
      expect(staleRefresh).not.toHaveBeenCalled();
      expect(stableRefresh).toHaveBeenCalledTimes(1);
    } finally {
      manager.releaseLease(workspaceId);
    }
  });

  test("excludes a server when trust is revoked while its prompt catalog refresh is pending", async () => {
    const workspaceId = "ws-refresh-window-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    // Revoke inside discovery's prompts/list: the pre-mutation enabled-instance
    // copy was already taken when the mutation lands. Two guards drop the
    // now-disabled server's descriptors (the trust change's enablement repair
    // and the post-refresh counter recheck); this fails only if both are lost.
    // Armed only after the warm-up serve: its own awaited prompts/list would otherwise
    // revoke trust before prompt discovery starts.
    let revokeOnFirstRefresh = false;
    const revokingRefresh = (list: Array<{ name: string }>) =>
      mock(() => {
        if (revokeOnFirstRefresh) {
          revokeOnFirstRefresh = false;
          manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
        }
        return Promise.resolve(list);
      });
    servers.serve("cmd-1", { listPrompts: revokingRefresh([{ name: "review" }]) });
    servers.serve("cmd-stable", { listPrompts: revokingRefresh([{ name: "status" }]) });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    revokeOnFirstRefresh = true;

    const descriptors = await manager.getPromptsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true })
    );
    // The revocation landed inside discovery's own refresh.
    expect(revokeOnFirstRefresh).toBe(false);
    expect(descriptors.map((descriptor) => descriptor.serverName)).toEqual(["stable"]);
  });

  test("prompt discovery forwards the abort signal to prompt refreshes", async () => {
    const workspaceId = "ws-discovery-signal";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const refreshPrompts = mock((_options?: { signal?: AbortSignal }) => Promise.resolve([]));
    servers.serve("cmd-1", { listPrompts: refreshPrompts });

    const controller = new AbortController();
    await manager.getPromptsForWorkspace(workspaceRequest(workspaceId), {
      signal: controller.signal,
    });
    expect(refreshPrompts).toHaveBeenCalledWith({ signal: controller.signal });

    controller.abort();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getPromptsForWorkspace(workspaceRequest(workspaceId), { signal: controller.signal })
    ).rejects.toThrow("aborted");
  });

  test("blocks prompt invocation when trust is revoked right after the prompt refresh", async () => {
    const workspaceId = "ws-post-refresh-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));

    // Revoke in the gap after the prompt refresh resolves but before the
    // enablement check runs: the secret re-resolution is the refresh
    // bracket's last await (resolution 1 runs before it, resolution 2 after).
    let resolutions = 0;
    manager.setSecretsResolver(() => {
      resolutions += 1;
      if (resolutions === 2) {
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
      }
      return Promise.resolve({});
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation on a server disabled during cold startup", async () => {
    const workspaceId = "ws-mid-startup-disable";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: stdioConfig("cmd-1"),
        stable: stdioConfig("cmd-stable"),
      })
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", (attempt) => ({
      getPrompt,
      // Settings mutation lands while the revival startup is in flight.
      connect: async () => {
        if (attempt === 2) {
          await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
        }
      },
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Idle reap: stop the servers but retain recorded request options.
    await manager.stopServers(workspaceId, { retainRestartOptions: true });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when a global disable lands during cold startup", async () => {
    const workspaceId = "ws-mid-startup-global-disable";
    let globallyDisabled = false;
    configService.listServers = mock(() =>
      Promise.resolve(
        globallyDisabled
          ? { stable: stdioConfig("cmd-stable") }
          : { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", (attempt) => ({
      getPrompt,
      connect: () => {
        if (attempt === 2) {
          // Global mcp.setEnabled(false) completes while the revival startup
          // is in flight: it bumps the config generation but never replaces
          // the recorded per-workspace request options.
          globallyDisabled = true;
          configService.configGeneration += 1;
        }
        return Promise.resolve();
      },
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Idle reap: stop the servers but retain recorded request options.
    await manager.stopServers(workspaceId, { retainRestartOptions: true });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("blocks prompt invocation when a server's config is edited during cold startup", async () => {
    const workspaceId = "ws-mid-startup-config-edit";
    let command = "cmd-1";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig(command), stable: stdioConfig("cmd-stable") })
    );

    const promptReturning = (text: string) =>
      mock(() =>
        Promise.resolve({ messages: [{ role: "user", content: { type: "text", text } }] })
      );
    servers.serve("cmd-1", { getPrompt: promptReturning("stale") });
    servers.serve("cmd-2", { getPrompt: promptReturning("hi") });
    servers.serve("cmd-stable", (attempt) => ({
      connect: () => {
        if (attempt === 2) {
          // Settings edits the server command while the revival startup is
          // in flight: the enabled set is unchanged, so only the start-config
          // signature reveals that the just-started instance is stale.
          command = "cmd-2";
          configService.configGeneration += 1;
        }
        return Promise.resolve();
      },
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Idle reap: stop the servers but retain recorded request options.
    await manager.stopServers(workspaceId, { retainRestartOptions: true });

    // Served by the edited command's server, not the stale instance.
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(servers.connectCount("cmd-2")).toBe(1);
  });

  test("blocks prompt invocation when project trust is revoked during cold startup", async () => {
    const workspaceId = "ws-mid-startup-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );

    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", (attempt) => ({
      getPrompt,
      connect: () => {
        if (attempt === 2) {
          manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
        }
        return Promise.resolve();
      },
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { trusted: true }));
    // Idle reap: stop the servers but retain recorded request options.
    await manager.stopServers(workspaceId, { retainRestartOptions: true });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
  });

  test("a serve reports the validated server inventory it derived enablement from", async () => {
    // Trust (like global config) can change independently of the override
    // snapshot: a caller comparing only `overridesUsed` with its own snapshot
    // would keep advertising the withdrawn repo-local server in the prompt.
    const workspaceId = "ws-servers-used";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    servers.serve("cmd-1", {
      tools: { echo: testTool() },
      connect: () => {
        manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
        return Promise.resolve();
      },
    });
    servers.serve("cmd-stable", { tools: { echo: testTool() } });

    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true, overrides: {}, overridesAuthoritative: true })
    );
    expect(result.overridesUsed).toEqual({});
    expect(Object.keys(result.serversUsed ?? {})).toEqual(["stable"]);
    expect(Object.keys(result.tools)).toEqual(["stable_echo"]);
  });

  test("getToolsForWorkspace restarts when cached instances are marked closed", async () => {
    const workspaceId = "ws-closed";
    configService.listServers = mock(() =>
      Promise.resolve({
        server: stdioConfig("cmd"),
      })
    );

    const close1 = mock(() => Promise.resolve(undefined));
    const close2 = mock(() => Promise.resolve(undefined));

    servers.serve("cmd", (attempt) => ({
      tools: { echo: testTool() },
      close: attempt === 1 ? close1 : close2,
    }));

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    // The server process exits, so the cached instance is marked closed.
    await servers.crash("cmd");

    const restarted = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(servers.connectCount("cmd")).toBe(2);
    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).not.toHaveBeenCalled();
    expect(Object.keys(restarted.tools)).toEqual(["server_echo"]);
  });

  test("getToolsForWorkspace does not close healthy instances when restarting closed ones while leased", async () => {
    const workspaceId = "ws-closed-partial";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    const closeA1 = mock(() => Promise.resolve(undefined));
    const closeA2 = mock(() => Promise.resolve(undefined));
    const closeB1 = mock(() => Promise.resolve(undefined));
    servers.serve("cmd-a", (attempt) => ({ close: attempt === 1 ? closeA1 : closeA2 }));
    servers.serve("cmd-b", { close: closeB1 });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Simulate an active stream lease.
    manager.acquireLease(workspaceId);

    await servers.crash("cmd-a");

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Restart should only close (and reconnect) the dead instance.
    expect(closeA1).toHaveBeenCalledTimes(1);
    expect(closeA2).toHaveBeenCalledTimes(0);
    expect(closeB1).toHaveBeenCalledTimes(0);
    expect(servers.connectCount("cmd-a")).toBe(2);
    expect(servers.connectCount("cmd-b")).toBe(1);
    manager.releaseLease(workspaceId);
  });

  test("getToolsForWorkspace does not return tools from newly-disabled servers while leased", async () => {
    const workspaceId = "ws-disable-while-leased";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    servers.serve("cmd-a", { tools: { tool: testTool() } });
    servers.serve("cmd-b", { tools: { tool: testTool() } });

    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    manager.acquireLease(workspaceId);

    const toolsResult = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverB"] } })
    );

    // Tool names are normalized to provider-safe keys (lowercase + underscore-delimited).
    expect(Object.keys(toolsResult.tools)).toContain("servera_tool");
    expect(Object.keys(toolsResult.tools)).not.toContain("serverb_tool");
  });

  test("the leased deferred-restart path serves without waiting on a hung tool refresh", async () => {
    const workspaceId = "ws-leased-hung-tool-refresh";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
        serverC: stdioConfig("cmd-c"),
      })
    );
    // Modern-era connections refresh tools/list in the background on cached
    // serves; B answers its startup listing, then every refresh hangs.
    const listToolsB = mock(
      (): Promise<Record<string, Tool>> =>
        listToolsB.mock.calls.length === 1
          ? Promise.resolve({ tool: testTool() })
          : new Promise(() => undefined)
    );
    servers.serve("cmd-a", { era: "modern", tools: { tool: testTool() } });
    servers.serve("cmd-b", { era: "modern", listTools: listToolsB });
    servers.serve("cmd-c", { tools: { tool: testTool() } });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(listToolsB).toHaveBeenCalledTimes(1);
    manager.acquireLease(workspaceId);

    // Signature change while leased → deferred restart path. B's refresh
    // never settles; the serve must still return the held catalogs, filtered
    // to the newly enabled set.
    const served = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverC"] } })
    );
    // Startup listing plus the one (hung) background refresh.
    expect(listToolsB).toHaveBeenCalledTimes(2);
    expect(Object.keys(served.tools).sort()).toEqual(["servera_tool", "serverb_tool"]);
  });

  test("getToolsForWorkspace filters disabled-server failures from leased stats", async () => {
    const workspaceId = "ws-disable-failed-while-leased";
    configService.listServers = mock(() =>
      Promise.resolve({
        serverA: stdioConfig("cmd-a"),
        serverB: stdioConfig("cmd-b"),
      })
    );

    servers.serve("cmd-a", { tools: { tool: testTool() } });
    servers.serve("cmd-b", { connect: () => Promise.reject(new Error("boom")) });

    const initial = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    expect(initial.stats.failedServerCount).toBe(1);
    const failedAttempts = servers.connectCount("cmd-b");

    manager.acquireLease(workspaceId);

    const leased = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["serverB"] } })
    );

    // No restart: neither server is contacted again.
    expect(servers.connectCount("cmd-a")).toBe(1);
    expect(servers.connectCount("cmd-b")).toBe(failedAttempts);
    expect(leased.stats.failedServerCount).toBe(0);
    expect(Object.keys(leased.tools)).toEqual(["servera_tool"]);
  });

  test("getToolsForWorkspace only exposes repo-defined servers for trusted projects", async () => {
    configService.listServers = mock((_projectPath: string, trusted?: boolean) =>
      Promise.resolve(
        trusted
          ? {
              global: stdioConfig("global-cmd"),
              repo: stdioConfig("repo-cmd"),
            }
          : {
              global: stdioConfig("global-cmd"),
            }
      )
    );

    servers.serve("global-cmd", { tools: { tool: testTool() } });
    servers.serve("repo-cmd", { tools: { tool: testTool() } });

    const untrustedResult = await manager.getToolsForWorkspace(
      workspaceRequest("ws-untrusted-mcp", { trusted: false })
    );
    // The repo-defined server is never launched for the untrusted project.
    expect(servers.connectCount("repo-cmd")).toBe(0);

    const trustedResult = await manager.getToolsForWorkspace(
      workspaceRequest("ws-trusted-mcp", { trusted: true })
    );

    expect(configService.listServers).toHaveBeenNthCalledWith(1, PROJECT_PATH, false, {
      agentPlugins: undefined,
    });
    expect(configService.listServers).toHaveBeenNthCalledWith(2, PROJECT_PATH, true, {
      agentPlugins: undefined,
    });
    expect(Object.keys(untrustedResult.tools)).toEqual(["global_tool"]);
    expect(Object.keys(trustedResult.tools).sort()).toEqual(["global_tool", "repo_tool"]);
    expect(servers.connectCount("global-cmd")).toBe(2);
    expect(servers.connectCount("repo-cmd")).toBe(1);
  });
  test("prompt discovery retries when an ordinary serve replaces the entry during prompts/list", async () => {
    // A direct edit of the override document is picked up by a concurrent
    // send's serve, which replaces the published entry without moving either
    // mutation counter. Descriptors must come from the current entry.
    let command = "cmd";
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig(command) }));
    const request = workspaceRequest("workspace");
    // While prompts/list is in flight, a concurrent send's serve with the same
    // authorization picks up a reconfigured server (no generation bump) and
    // replaces the published entry.
    const staleListPrompts = mock(async () => {
      command = "cmd-2";
      await manager.getToolsForWorkspace(request);
      return [{ name: "stale" }];
    });
    servers.serve("cmd", { listPrompts: staleListPrompts });
    servers.serve("cmd-2", { prompts: [{ name: "fresh" }] });

    const descriptors = await manager.getPromptsForWorkspace(request);
    expect(descriptors.map((d) => d.promptName)).toEqual(["fresh"]);
    expect(staleListPrompts).toHaveBeenCalledTimes(1);
  });

  test("lists namespaced prompt descriptors from connected instances", async () => {
    configService.listServers = mock(() => Promise.resolve({ "Coder Server": stdioConfig("cmd") }));
    servers.serve("cmd", {
      prompts: [
        {
          name: "Code Review",
          description: "Review code",
          arguments: [{ name: "path", required: true }],
        },
      ],
    });

    const listed = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.stableKey).toMatch(/^mcp__coder_server__code_review_[0-9a-f]{8}$/);
    expect(listed[0]).toEqual({
      commandKey: "mcp__coder_server__code_review",
      stableKey: listed[0]?.stableKey ?? "",
      serverName: "Coder Server",
      promptName: "Code Review",
      description: "Review code",
      arguments: [{ name: "path", required: true }],
    });
  });

  test("forwards prompt arguments and flattens supported content", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        description: "Expanded review",
        messages: [
          { role: "user", content: { type: "text", text: "Review src" } },
          {
            role: "assistant",
            content: {
              type: "resource",
              resource: { uri: "file:///guide", text: "Use the guide" },
            },
          },
          {
            role: "assistant",
            content: { type: "image", data: "abc", mimeType: "image/png" },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    expect(await manager.getPrompt("workspace", "coder", "review", { path: "src" })).toEqual({
      description: "Expanded review",
      text: "Review src\n\n[assistant]\nUse the guide\n\n[assistant]\n[Image content omitted]",
    });
    expect(getPrompt).toHaveBeenCalledWith("review", { path: "src" }, undefined);
  });

  test("rejects empty and whitespace-only prompt expansions", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [{ role: "user", content: { type: "text", text: "   \n\n  " } }],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "review", {})).rejects.toThrow(
      "MCP prompt 'coder/review' returned no text content"
    );
  });

  test("suffixes every member of a colliding prompt key group, independent of order", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    // Discovery re-polls prompts/list on every call, so each call below
    // observes the catalog set just before it.
    let catalog: Array<{ name: string }> = [];
    servers.serve("cmd", { listPrompts: () => Promise.resolve(catalog) });
    const collectKeys = async (promptNames: string[]) => {
      catalog = promptNames.map((name) => ({ name }));
      const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
      return new Map(descriptors.map((d) => [d.promptName, d.commandKey]));
    };

    const keys = await collectKeys(["Code-Review", "code_review", "status"]);
    const reversedKeys = await collectKeys(["code_review", "Code-Review", "status"]);

    expect(keys.get("Code-Review")).toMatch(/^mcp__coder__code_review_[0-9a-f]{8}$/);
    expect(keys.get("code_review")).toMatch(/^mcp__coder__code_review_[0-9a-f]{8}$/);
    expect(keys.get("Code-Review")).not.toBe(keys.get("code_review"));
    expect(reversedKeys).toEqual(keys);
    expect(keys.get("status")).toBe("mcp__coder__status");

    catalog = [{ name: "code_review" }];
    const soloDescriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    expect(soloDescriptors[0]?.commandKey).toBe("mcp__coder__code_review");
    expect(soloDescriptors[0]?.stableKey).toBe(keys.get("code_review") ?? "");
    // One server connection served every catalog.
    expect(servers.connectCount("cmd")).toBe(1);
  });

  test("excludes disabled servers from prompt discovery and getPrompt", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({ enabled: stdioConfig("cmd-e"), disabled: stdioConfig("cmd-d") })
    );
    const disabledGetPrompt = mock(() => Promise.resolve({ messages: [] }));
    servers.serve("cmd-e", { prompts: [{ name: "status" }] });
    servers.serve("cmd-d", { prompts: [{ name: "review" }], getPrompt: disabledGetPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    // Disabling while leased keeps the disabled client cached (deferred restart).
    manager.acquireLease("workspace");
    await manager.getToolsForWorkspace(
      workspaceRequest("workspace", { overrides: { disabledServers: ["disabled"] } })
    );

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest("workspace"));
    expect(descriptors.map((d) => d.commandKey)).toEqual(["mcp__enabled__status"]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "disabled", "review", {})).rejects.toThrow(
      "disabled"
    );
    expect(disabledGetPrompt).not.toHaveBeenCalled();
    manager.releaseLease("workspace");
  });

  test("getPrompt revives reaped servers from the last workspace request options", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    const close = mock(() => Promise.resolve(undefined));
    servers.serve("cmd", { getPrompt, close });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    // Reaped (like idle cleanup): the servers stop, the request options stay.
    await manager.stopServers("workspace", { retainRestartOptions: true });
    expect(close).toHaveBeenCalledTimes(1);

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({
      text: "Status",
    });
    expect(servers.connectCount("cmd")).toBe(2);
  });

  test("getPrompt fails when the server is gone and no restart options are cached", () => {
    expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow("not connected");
  });

  test("serializes config-change restarts across concurrent workspace requests", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd-a") }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    servers.serve("cmd-a");
    servers.serve("cmd-b", { connect: () => startGate });

    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    expect(servers.connectCount("cmd-a")).toBe(1);

    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd-b") }));
    const first = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const second = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    releaseStart();
    await Promise.all([first, second]);

    // One restart onto the new config, shared by both requests.
    expect(servers.connectCount("cmd-a")).toBe(1);
    expect(servers.connectCount("cmd-b")).toBe(1);
  });

  test("serializes cold-start server startup across concurrent workspace requests", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    servers.serve("cmd", { connect: () => startGate });

    const first = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const second = manager.getToolsForWorkspace(workspaceRequest("workspace"));
    releaseStart();
    await Promise.all([first, second]);

    expect(servers.connectCount("cmd")).toBe(1);
  });

  test("getPrompt re-evaluates current config before invoking a cached prompt", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });

    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });

    configService.listServers = mock(() => Promise.resolve({}));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow("disabled");
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("getPrompt caps expansion bytes for non-ASCII content shared with the composer path", async () => {
    // 64k "€" chars encode to ~192KB UTF-8, triple the nominal cap.
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "€".repeat(64 * 1024) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    const result = await manager.getPrompt("workspace", "coder", "status", {});

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      MCP_PROMPT_MAX_TEXT_BYTES + MCP_PROMPT_TRUNCATION_MARKER.length
    );
    expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
    expect(result.text).not.toContain("\uFFFD");
  });

  test("getPrompt rejects an oversized whitespace-only expansion instead of passing the marker off as content", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: " ".repeat(2 * MCP_PROMPT_MAX_TEXT_BYTES) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow(
      "returned no text content"
    );
  });

  test("getPrompt never encodes more than the byte budget for a huge expansion", async () => {
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: "a".repeat(10 * 1024 * 1024) },
          },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    const fromSpy = spyOn(Buffer, "from");

    try {
      const result = await manager.getPrompt("workspace", "coder", "status", {});

      expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
      // The transient encoding copy is bounded by the budget, not input size.
      for (const call of fromSpy.mock.calls) {
        const input = call[0];
        if (typeof input === "string") {
          expect(input.length).toBeLessThanOrEqual(MCP_PROMPT_MAX_TEXT_BYTES);
        }
      }
    } finally {
      fromSpy.mockRestore();
    }
  });

  test("getPrompt emits a single truncation marker when flattening also truncated", async () => {
    const block = "a".repeat(40 * 1024);
    const getPrompt = mock(() =>
      Promise.resolve({
        messages: [
          { role: "user" as const, content: { type: "text" as const, text: block } },
          { role: "user" as const, content: { type: "text" as const, text: block } },
        ],
      })
    );
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));

    const result = await manager.getPrompt("workspace", "coder", "status", {});

    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      MCP_PROMPT_MAX_TEXT_BYTES + MCP_PROMPT_TRUNCATION_MARKER.length
    );
    expect(result.text.split("[Prompt text truncated]")).toHaveLength(2);
    expect(result.text).toEndWith(MCP_PROMPT_TRUNCATION_MARKER);
  });

  test("applyProjectTrust flips recorded trust so getPrompt refreshes untrusted", async () => {
    const request = workspaceRequest("workspace", { trusted: true });
    const otherRequest = workspaceRequest("other-workspace", {
      projectPath: "/tmp/other-project",
      trusted: true,
    });
    // `coder` is project-local: listed only for trusted projects.
    configService.listServers = mock((_projectPath: string, trusted?: boolean) =>
      Promise.resolve(trusted ? { coder: stdioConfig("cmd") } : {})
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    servers.serve("cmd", { getPrompt });
    await manager.getToolsForWorkspace(request);
    await manager.getToolsForWorkspace(otherRequest);
    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });

    manager.applyProjectTrust([
      { projectPath: `${PROJECT_PATH}/`, trusted: false },
      { projectPath: "/tmp/other-project", trusted: true },
    ]);
    configService.listServers.mockClear();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt("workspace", "coder", "status", {})).rejects.toThrow("disabled");
    expect(configService.listServers).toHaveBeenCalledWith(PROJECT_PATH, false, expect.anything());
    expect(configService.listServers).not.toHaveBeenCalledWith(
      PROJECT_PATH,
      true,
      expect.anything()
    );
    // The other project's (unchanged) trust still serves its prompt.
    expect(await manager.getPrompt("other-workspace", "coder", "status", {})).toEqual({
      text: "Status",
    });
    expect(getPrompt).toHaveBeenCalledTimes(2);
  });

  const SECRET_URL = "https://mcp.test/secret-headers";
  type FakeServerGetPrompt = (...args: unknown[]) => Promise<unknown>;

  /** Serve an http server whose Authorization header comes from project secret TOKEN. */
  function serveSecretHeaderServer(getPrompt: FakeServerGetPrompt) {
    configService.listServers = mock(() =>
      Promise.resolve({
        coder: {
          transport: "http" as const,
          url: SECRET_URL,
          headers: { Authorization: { secret: "TOKEN" } },
          disabled: false,
        },
      })
    );
    servers.serve(SECRET_URL, { getPrompt });
  }

  /**
   * Authorization header of every connection attempt to SECRET_URL, read from
   * the harness's createMCPClient spy (installed by servers.serve).
   */
  function authorizationHeadersSent(): unknown[] {
    const connects = mcpSdk.createMCPClient as unknown as {
      mock: { calls: Array<[mcpSdk.MCPClientConfig]> };
    };
    return connects.mock.calls.flatMap(([config]) => {
      const transport = config.transport as { url?: string; headers?: Record<string, string> };
      return transport.url === SECRET_URL ? [transport.headers?.Authorization] : [];
    });
  }

  test("getPrompt refreshes with resolver-provided secrets instead of the recorded snapshot", async () => {
    const request = workspaceRequest("workspace", { projectSecrets: { TOKEN: "old" } });
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    serveSecretHeaderServer(getPrompt);
    await manager.getToolsForWorkspace(request);
    expect(authorizationHeadersSent()).toEqual(["old"]);
    manager.setSecretsResolver(() => Promise.resolve({ TOKEN: "new" }));

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });

    // The rotated credential changed the signature: reconnected with it.
    expect(authorizationHeadersSent()).toEqual(["old", "new"]);
  });

  test("getPrompt falls back to the recorded secrets snapshot when the resolver fails", async () => {
    const request = workspaceRequest("workspace", { projectSecrets: { TOKEN: "old" } });
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    serveSecretHeaderServer(getPrompt);
    await manager.getToolsForWorkspace(request);
    const failingResolver = mock(() => Promise.reject(new Error("config unavailable")));
    manager.setSecretsResolver(failingResolver);

    expect(await manager.getPrompt("workspace", "coder", "status", {})).toEqual({ text: "Status" });
    // The fallback branch ran: the resolver was consulted and failed.
    expect(failingResolver).toHaveBeenCalled();
    // The recorded snapshot still matches the live client: no reconnect.
    expect(authorizationHeadersSent()).toEqual(["old"]);
  });

  test("getPrompt rejects promptly when aborted during refresh startup", async () => {
    configService.listServers = mock(() => Promise.resolve({ coder: stdioConfig("cmd") }));
    servers.serve("cmd");
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    await manager.stopServers("workspace", { retainRestartOptions: true });
    // The revival's startup never finishes on its own.
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const startupEntered = Promise.withResolvers<void>();
    servers.serve("cmd", {
      connect: () => {
        startupEntered.resolve();
        return startupGate;
      },
    });
    const controller = new AbortController();
    const promptPromise = manager.getPrompt(
      "workspace",
      "coder",
      "status",
      {},
      { signal: controller.signal }
    );
    promptPromise.catch(() => undefined);
    // Abort only once the revival is hung inside its startup.
    await startupEntered.promise;
    controller.abort();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(promptPromise).rejects.toThrow("was aborted");
    // The abort does not cancel the revival itself: let it finish, and wait for it
    // through a serve queued behind it, so no startup outlives this test.
    releaseStartup();
    await manager.getToolsForWorkspace(workspaceRequest("workspace"));
    expect(servers.connectCount("cmd")).toBe(1);
  });

  test("flattens audio and binary resources as omission markers", () => {
    expect(
      flattenMcpPrompt({
        messages: [
          {
            role: "user",
            content: { type: "audio", data: "abc", mimeType: "audio/wav" },
          },
          {
            role: "user",
            content: { type: "resource", resource: { uri: "file:///blob", blob: "abc" } },
          },
        ],
      })
    ).toBe("[Audio content omitted]\n\n[Resource content omitted]");
  });

  test("flattenMcpPrompt accumulates only a bounded prefix of oversized expansions", () => {
    const block = "a".repeat(40 * 1024);
    const flattened = flattenMcpPrompt({
      messages: [
        { role: "user", content: { type: "text", text: block } },
        { role: "assistant", content: { type: "text", text: block } },
        { role: "user", content: { type: "text", text: block } },
      ],
    });

    expect(flattened.endsWith(MCP_PROMPT_TRUNCATION_MARKER)).toBe(true);
    // Pre-marker text must exceed the byte cap so the tool-level truncation
    // always fires and replaces the marker at a clean boundary.
    const preMarker = flattened.length - MCP_PROMPT_TRUNCATION_MARKER.length;
    expect(preMarker).toBeGreaterThan(MCP_PROMPT_MAX_TEXT_BYTES);
    expect(preMarker).toBeLessThanOrEqual(MCP_PROMPT_MAX_TEXT_BYTES + 2);
    expect(flattened.startsWith(block)).toBe(true);
    expect(flattened).toContain("[assistant]\n");
  });

  test("test() includes oauthChallenge when server responds 401 + WWW-Authenticate Bearer", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((_req, res) => {
      res.statusCode = 401;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
      );
      res.end("Unauthorized");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind OAuth challenge test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/`;
      resourceMetadataUrl = `${baseUrl}.well-known/oauth-protected-resource`;

      const result = await manager.test({
        projectPath: PROJECT_PATH,
        transport: "http",
        url: baseUrl,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected test() to fail");
      }

      expect(result.oauthChallenge).toEqual({
        scope: "mcp.read",
        resourceMetadataUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("test() includes oauthChallenge when auth is only advertised on POST", async () => {
    let baseUrl = "";
    let resourceMetadataUrl = "";

    const server = createServer((req, res) => {
      if (req.method === "POST") {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer scope="mcp.read" resource_metadata="${resourceMetadataUrl}"`
        );
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            error: "invalid_token",
            error_description: "Authentication failed.",
          })
        );
        return;
      }

      res.statusCode = 405;
      res.setHeader("Allow", "POST, DELETE");
      res.end("Method Not Allowed");
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to bind POST-only OAuth challenge test server");
      }

      baseUrl = `http://127.0.0.1:${address.port}/mcp`;
      resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      const result = await manager.test({
        projectPath: PROJECT_PATH,
        transport: "auto",
        url: baseUrl,
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("Expected test() to fail");
      }

      expect(result.oauthChallenge).toEqual({
        scope: "mcp.read",
        resourceMetadataUrl,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("tool execution failure with closed-client error marks instance isClosed for restart", async () => {
    const workspaceId = "ws-tool-closed";
    configService.listServers = mock(() =>
      Promise.resolve({
        "test-server": stdioConfig("cmd"),
      })
    );

    const closedError = new Error("Attempted to send a request from a closed client");
    const dummyTool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const close = mock(() => Promise.resolve(undefined));
    servers.serve("cmd", { tools: { failTool: dummyTool }, close });

    const result1 = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(servers.connectCount("cmd")).toBe(1);

    const firstTool = Object.values(result1.tools)[0];
    expect(firstTool).toBeDefined();
    if (!firstTool?.execute) {
      throw new Error("Expected wrapped MCP tool to include execute");
    }

    let firstToolError: unknown;
    try {
      await firstTool.execute({}, {} as never);
    } catch (error) {
      firstToolError = error;
    }
    expect(firstToolError).toBe(closedError);
    // The process never exited: only the closed-client error marks it dead.
    expect(close).not.toHaveBeenCalled();

    // The next serve retires the marked instance and reconnects.
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(close).toHaveBeenCalledTimes(1);
    expect(servers.connectCount("cmd")).toBe(2);
  });

  // --- Agent Plugins (agent-plugins experiment) ---

  const PLUGIN_KEY = "plugin:abcdef0123456789:everything";

  function pluginStdioConfig(overrides: Record<string, unknown> = {}) {
    return {
      [PLUGIN_KEY]: {
        transport: "stdio" as const,
        command: "bunx",
        args: ["-y", "some-server"],
        env: { PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: "/tmp/mux-test-plugin-data" },
        cwd: "/plugins/demo",
        disabled: true,
        plugin: {
          pluginName: "demo",
          serverName: "everything",
          sourceScope: "global" as const,
          sourceLocation: ".mux/plugins/demo",
        },
        ...overrides,
      },
    };
  }

  /** The exec command pluginStdioConfig() launches (argv mode shell-quotes each word). */
  const PLUGIN_COMMAND = "'bunx' '-y' 'some-server'";

  /** pluginStdioConfig() with PLUGIN_DATA in a real temp dir (the launch creates it). */
  function launchablePluginConfig(pluginData: string) {
    return pluginStdioConfig({ env: { PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: pluginData } });
  }

  test("default-disabled plugin servers start only with a workspace enabledServers override", async () => {
    using pluginData = new DisposableTempDir("mcp-plugin-data");
    configService.listServers = mock(() =>
      Promise.resolve(launchablePluginConfig(pluginData.path))
    );
    servers.serve(PLUGIN_COMMAND);

    const withoutOverride = await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-off"));
    expect(withoutOverride.stats.enabledServerCount).toBe(0);
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(0);

    const withOverride = await manager.getToolsForWorkspace(
      workspaceRequest("ws-plugin-on", { overrides: { enabledServers: [PLUGIN_KEY] } })
    );
    expect(withOverride.stats.enabledServerCount).toBe(1);
    expect(withOverride.stats.startedServerCount).toBe(1);
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
  });

  test("forgetWorkspaceOverrides drops the cached snapshot so the caller's fresh read wins again", async () => {
    using pluginData = new DisposableTempDir("mcp-plugin-data");
    configService.listServers = mock(() =>
      Promise.resolve(launchablePluginConfig(pluginData.path))
    );
    servers.serve(PLUGIN_COMMAND);
    const workspaceId = "ws-forget";
    // A published snapshot overlays whatever the caller read from disk.
    await manager.applyWorkspaceOverrides(workspaceId, { enabledServers: [PLUGIN_KEY] });
    const overlaid = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(overlaid.stats.enabledServerCount).toBe(1);

    // After eviction the caller's (disk-authoritative) read is used as-is.
    manager.forgetWorkspaceOverrides(workspaceId);
    const fresh = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(fresh.stats.enabledServerCount).toBe(0);
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
  });

  test("forgetWorkspaceOverrides also distrusts recorded options: the next serve re-reads disk", async () => {
    manager.dispose();
    let diskOverrides: Record<string, unknown> = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    using pluginData = new DisposableTempDir("mcp-plugin-data");
    configService.listServers = mock(() =>
      Promise.resolve(launchablePluginConfig(pluginData.path))
    );
    servers.serve(PLUGIN_COMMAND, { prompts: [{ name: "status" }] });
    const workspaceId = "ws-forget-recorded";

    // First serve records options (with the disk-read enable) — one disk read.
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(first.stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // Prompt discovery (no fresh caller read) serves from the recorded
    // snapshot without touching disk.
    diskOverrides = {};
    const second = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(second.map((d) => d.promptName)).toEqual(["status"]);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // After eviction the same recorded-options serve must re-read disk and
    // observe the disable — no chat send required.
    manager.forgetWorkspaceOverrides(workspaceId);
    const third = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);
    expect(third).toEqual([]);
  });

  test("getPrompt re-reads disk so a direct document edit disabling the server is honored", async () => {
    // A direct edit of `.xum/mcp.local.jsonc` (own or inherited parent
    // document) bumps no epoch and publishes nothing; the recorded options
    // still say "enabled". Prompt dispatch must not trust them blindly.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    servers.serve("cmd-stable", { getPrompt });
    const workspaceId = "ws-prompt-direct-edit";
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });

    // Direct edit: disk now disables the server; nothing else moved.
    diskOverrides = { disabledServers: ["server"] };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "server", "review", {})).rejects.toThrow(
      "is disabled"
    );
    expect(await manager.getPrompt(workspaceId, "stable", "review", {})).toEqual({ text: "hi" });
    expect(getPrompt).toHaveBeenCalledTimes(2);
  });

  test("a direct disk revocation is honored even when an equivalent serve replaces the recorded options mid-gate", async () => {
    // While the gate awaits its disk read, an overlapping serve whose snapshot
    // predates the edit records a fresh but EQUIVALENT options object. The
    // invalidation must still be taken (equivalence, not identity) or the
    // revoked tool would dispatch.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    let onDiskRead: (() => void) | undefined;
    const readWorkspaceOverrides = mock(() => {
      onDiskRead?.();
      return Promise.resolve(diskOverrides);
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    const workspaceId = "ws-equivalent-replacement-revocation";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const request = workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true });
    const result = await manager.getToolsForWorkspace(request);
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) throw new Error("Expected served tool to include execute");
    manager.acquireLease(workspaceId);

    // Direct edit revokes the server on disk; the gate's read observes it,
    // but an equivalent pre-edit snapshot is recorded at that very moment.
    diskOverrides = { disabledServers: ["server"] };
    onDiskRead = () => {
      onDiskRead = undefined;
      // Private call: the equivalent object must be recorded synchronously
      // inside the gate's disk read; every public serve awaits its epoch
      // preflight before recording, so none can land at that exact point.
      (
        manager as unknown as { lastWorkspaceRequestOptions: Map<string, unknown> }
      ).lastWorkspaceRequestOptions.set(workspaceId, { ...request });
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
    manager.releaseLease(workspaceId);
  });

  test("served tool objects fail at call time once their server is disabled", async () => {
    // Tools leave the manager before the stream starts; a publication landing
    // in that window (or mid-stream) cannot retract the objects, so every
    // invocation re-checks the CURRENT enablement — including while the
    // publication's asynchronous enablement repair is still in flight.
    const workspaceId = "ws-call-time-gate";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    servers.serve("cmd-stable", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    const stableTool = result.tools.stable_ping;
    if (!serverTool?.execute || !stableTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Publication whose listServers is slow: an invocation racing it must
    // not pass on the old set — the latest recorded overrides already revoke
    // the server, so the call is rejected without waiting for the repair.
    let releaseListServers!: () => void;
    configService.listServers = mock(
      () =>
        new Promise((resolve) => {
          releaseListServers = () =>
            resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") });
        })
    );
    const publication = manager.applyWorkspaceOverrides(workspaceId, {
      disabledServers: ["server"],
    });
    const racing: Promise<unknown> = Promise.resolve(serverTool.execute({}, {} as never));
    racing.catch(() => undefined); // asserted below; keep the rejection handled meanwhile
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executeTool).toHaveBeenCalledTimes(1);
    releaseListServers();
    await publication;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow(
      "was disabled for this workspace after the request was prepared"
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow(
      "was disabled for this workspace after the request was prepared"
    );
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Servers that stay enabled are unaffected.
    await stableTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);

    // A narrowed workspace tool allowlist revokes individual tools of a server
    // that stays enabled.
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    await manager.applyWorkspaceOverrides(workspaceId, { toolAllowlist: { stable: ["other"] } });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(stableTool.execute({}, {} as never)).rejects.toThrow("tool 'stable/ping'");
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  test("overlapping serves of one workspace with the same authorization both succeed", async () => {
    // Prompt discovery while a send assembles: each records its own options
    // object; the first to finish must not be failed closed as if a
    // publication had revoked it.
    const workspaceId = "ws-overlapping-serves";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    servers.serve("cmd-1", { connect: () => started, tools: { ping: testTool() } });
    const first = manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseStart();
    const [a, b] = await Promise.all([first, second]);
    expect(Object.keys(a.tools)).toEqual(["server_ping"]);
    expect(Object.keys(b.tools)).toEqual(["server_ping"]);
    expect(servers.connectCount("cmd-1")).toBe(1);

    // A real authorization change is still detected: different overrides.
    const third = manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["server"] } })
    );
    expect(Object.keys((await third).tools)).toEqual([]);
  });

  test("tools handed to the model are filtered with the inventory repaired mid-startup", async () => {
    // A project tool allowlist narrowed while startup awaits must filter the
    // served tools, not only be enforced by the call-time gate after the
    // model already selected a removed tool.
    const workspaceId = "ws-repaired-inventory";
    let allowlist: string[] | undefined;
    configService.listServers = mock(() =>
      Promise.resolve({
        server: { ...stdioConfig("cmd-1"), ...(allowlist ? { toolAllowlist: allowlist } : {}) },
      })
    );
    servers.serve("cmd-1", {
      // Settings narrows the allowlist while the server starts.
      connect: () => {
        allowlist = ["other"];
        configService.configGeneration += 1;
        return Promise.resolve();
      },
      tools: { ping: testTool(), other: testTool() },
    });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(Object.keys(result.tools)).toEqual(["server_other"]);
  });

  test("served tool objects honor a global tool allowlist narrowed after the serve", async () => {
    // Settings narrowing a server's global/project toolAllowlist replaces no
    // recorded options and changes nothing on the workspace's override disk —
    // it only bumps the config generation. The gate must not decide on the
    // allowlist captured with the tool object: it re-derives the inventory
    // when the generation moved and applies the CURRENT allowlist.
    const workspaceId = "ws-call-time-global-allowlist";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool, other: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const pingTool = result.tools.server_ping;
    const otherTool = result.tools.server_other;
    if (!pingTool?.execute || !otherTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    await pingTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Global allowlist narrowed to `other` without any serve in between.
    configService.listServers = mock(() =>
      Promise.resolve({ server: { ...stdioConfig("cmd-1"), toolAllowlist: ["other"] } })
    );
    configService.configGeneration += 1;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(pingTool.execute({}, {} as never)).rejects.toThrow("tool 'server/ping'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    await otherTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);

    // Globally disabling the server is caught the same way.
    configService.listServers = mock(() => Promise.resolve({}));
    configService.configGeneration += 1;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(otherTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(2);
  });

  test("served tool objects re-derive enablement from disk when the workspace was invalidated", async () => {
    // Descendant/off-host publications and cross-process epoch changes only
    // set the invalidation marker (no overrides to repair the entry with), so
    // the gate must not trust the leased entry's enablement: it re-serves from
    // disk and rejects when disk revokes the server (or cannot answer).
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    const workspaceId = "ws-call-time-invalidated";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    // The stream holds its lease while tools are invoked.
    manager.acquireLease(workspaceId);

    // Invalidation while disk still enables the server: re-derived, allowed.
    // (The re-serve recorded a fresh options object with the SAME
    // authorization state; the gate compares by equivalence, so it dispatches
    // without another round: one read beyond the serve's.)
    manager.forgetWorkspaceOverrides(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Invalidation after a parent save that disables the server on disk.
    diskOverrides = { disabledServers: ["server"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Invalidation that disk cannot resolve: fail closed at call time too.
    diskOverrides = undefined;
    manager.forgetWorkspaceOverrides(workspaceId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    manager.releaseLease(workspaceId);
  });

  test("served tool objects observe a sibling process's override write before executing", async () => {
    // Backend B saves overrides that revoke the server: only the on-disk epoch
    // moves. Without a new serve in this process no marker would ever exist,
    // so the call-time gate runs the same cross-process preflight as a serve.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    const workspaceId = "ws-call-time-sibling";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Sibling process: disk now disables the server and the epoch moved.
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);

    // …and re-enables it.
    diskOverrides = {};
    epoch = "epoch-3";
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    manager.releaseLease(workspaceId);
  });

  test("served tool calls hold the override writer's lock from the final epoch read through dispatch", async () => {
    // A sibling process's revocation that commits between the bracket's
    // postflight epoch read and the invocation leaves no process-local marker.
    // Under the writer's lock the write either committed before the fenced
    // epoch read (observed → re-derived → revoked) or waits until the call has
    // been dispatched; the tool's own execution never runs under the lock.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let lockHeld = false;
    let acquisitions = 0;
    let releases = 0;
    let gateLock: Promise<void> = Promise.resolve();
    const acquireOverridesLock = mock(async () => {
      acquisitions += 1;
      await gateLock;
      lockHeld = true;
      return () => {
        lockHeld = false;
        releases += 1;
        return Promise.resolve();
      };
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
        acquireOverridesLock,
      },
    });
    const workspaceId = "ws-call-time-lock";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let heldAtDispatch: boolean | undefined;
    let finishTool!: () => void;
    const executeTool = mock(() => {
      heldAtDispatch = lockHeld;
      return new Promise((resolve) => {
        finishTool = () => resolve({ content: [{ type: "text", text: "ok" }] });
      });
    });
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);
    // The server launch itself is fenced by the same lock (and released).
    expect(lockHeld).toBe(false);
    const acquisitionsAtServe = acquisitions;
    const releasesAtServe = releases;

    // Dispatch happens under the lock; the lock is released once the call has
    // started, not when the tool finishes.
    const call = serverTool.execute({}, {} as never) as Promise<unknown>;
    await waitFor(() => executeTool.mock.calls.length === 1);
    expect(heldAtDispatch).toBe(true);
    await waitFor(() => releases === releasesAtServe + 1);
    expect(acquisitions).toBe(acquisitionsAtServe + 1);
    finishTool();
    await call;

    // Sibling revocation racing the handoff: it holds the writer's lock while
    // the gate (already past its bracket) waits for it, commits disk + epoch,
    // then releases. The fenced epoch read observes the change and the call
    // is re-derived from disk instead of dispatched on stale authorization.
    let releaseSibling!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const racing = serverTool.execute({}, {} as never) as Promise<unknown>;
    await waitFor(() => acquisitions === acquisitionsAtServe + 2);
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    releaseSibling();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);

    // A lock that cannot be acquired before the tool call's deadline/abort
    // fails the call closed and never leaves a late acquisition held.
    gateLock = new Promise<void>(() => undefined);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).toHaveBeenCalledTimes(1);
    manager.releaseLease(workspaceId);
  });

  test("an aborted prompt request releases the writer's lock while its fenced epoch read stalls", async () => {
    // The outer abort race returns to the caller, but the losing callback
    // still holds the override writer's lock: a stalled home filesystem must
    // not keep every settings save and prune blocked behind an epoch read
    // nobody waits for.
    manager.dispose();
    let lockHeld = false;
    let epochReads = 0;
    // Armed after the serve: the server launch takes the same fenced read.
    let stallFencedReads = false;
    const controller = new AbortController();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => {
          epochReads += 1;
          // Only the prompt's fenced read (taken under the lock) stalls.
          if (lockHeld && stallFencedReads) {
            controller.abort();
            return new Promise<string>(() => undefined);
          }
          return Promise.resolve("epoch-1");
        },
        readWorkspaceOverrides: () => Promise.resolve({}),
        acquireOverridesLock: () => {
          lockHeld = true;
          return Promise.resolve(() => {
            lockHeld = false;
            return Promise.resolve();
          });
        },
      },
    });
    const workspaceId = "ws-prompt-fence-abort";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("cmd-1", { getPrompt });
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    stallFencedReads = true;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getPrompt(workspaceId, "server", "review", {}, { signal: controller.signal })
    ).rejects.toThrow("aborted");
    await waitFor(() => !lockHeld);
    expect(getPrompt).not.toHaveBeenCalled();
    expect(epochReads).toBeGreaterThan(0);
  });

  test("a sibling override write landing before server startup fails the serve closed instead of launching", async () => {
    // The writer bumps the epoch right after persisting the document (before
    // its publication budget). A serve that derived its enabled set before
    // that write must not launch a server whose revocation is already
    // durable — the postflight would only close it after its command ran.
    manager.dispose();
    let epoch = "epoch-1";
    const readWorkspaceOverrides = mock(() => {
      // The sibling's write commits while this serve's disk read is in flight.
      epoch = "epoch-2";
      return Promise.resolve({} as Record<string, unknown>);
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    servers.serve("cmd-1");
    const workspaceId = "ws-startup-fence";
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }))
    ).rejects.toThrow("changed in another process");
    // Not even spawned: the revocation was durable before launch.
    expect(servers.exec).not.toHaveBeenCalled();

    // The next serve's preflight adopts the new epoch and re-derives from disk.
    readWorkspaceOverrides.mockImplementation(() => Promise.resolve({}));
    const served = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(served.stats.enabledServerCount).toBe(1);
    expect(servers.connectCount("cmd-1")).toBe(1);
  });

  test("prompt dispatch holds the override writer's lock from the final epoch read through invocation start", async () => {
    // Same fence as served tool calls: a sibling process persists a disabling
    // save, spends its publication budget updating caches, and only then
    // bumps the epoch — a postflight alone can observe the old token and hand
    // out content from the now-disabled server.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let lockHeld = false;
    let acquisitions = 0;
    let gateLock: Promise<void> = Promise.resolve();
    const acquireOverridesLock = mock(async () => {
      acquisitions += 1;
      await gateLock;
      lockHeld = true;
      return () => {
        lockHeld = false;
        return Promise.resolve();
      };
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
        acquireOverridesLock,
      },
    });
    const workspaceId = "ws-prompt-lock";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    let heldAtDispatch: boolean | undefined;
    const getPrompt = mock(() => {
      heldAtDispatch = lockHeld;
      return Promise.resolve({
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      });
    });
    servers.serve("cmd-1", { getPrompt });
    await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );

    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(heldAtDispatch).toBe(true);
    expect(lockHeld).toBe(false);
    const acquisitionsAfterFirst = acquisitions;

    // Sibling revocation racing the handoff: it holds the writer's lock while
    // this request (already past its authoritative re-read) waits for it,
    // commits disk + epoch, then releases. The fenced epoch read sees the
    // change and no content is handed out from the disabled server.
    let releaseSibling!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const racing = manager.getPrompt(workspaceId, "server", "review", {});
    racing.catch(() => undefined);
    await waitFor(() => acquisitions === acquisitionsAfterFirst + 1);
    diskOverrides = { disabledServers: ["server"] };
    epoch = "epoch-2";
    gateLock = Promise.resolve();
    releaseSibling();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racing).rejects.toThrow("server 'server'");
    expect(getPrompt).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(false);

    // A same-process global disable landing while the request waits for the
    // lock advances only the config generation (no provenance change, no
    // epoch bump): the dispatch must re-derive from the current config
    // instead of trusting the pre-wait enabled set.
    diskOverrides = {};
    epoch = "epoch-3";
    expect(await manager.getPrompt(workspaceId, "server", "review", {})).toEqual({ text: "hi" });
    expect(getPrompt).toHaveBeenCalledTimes(2);
    let releaseSettings!: () => void;
    gateLock = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const acquisitionsBefore = acquisitions;
    const racingGlobal = manager.getPrompt(workspaceId, "server", "review", {});
    racingGlobal.catch(() => undefined);
    await waitFor(() => acquisitions === acquisitionsBefore + 1);
    configService.listServers = mock(() => Promise.resolve({}));
    configService.configGeneration += 1;
    gateLock = Promise.resolve();
    releaseSettings();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(racingGlobal).rejects.toThrow("server 'server'");
    expect(getPrompt).toHaveBeenCalledTimes(2);
    expect(lockHeld).toBe(false);
  });

  test("served tools of a project-local server are rejected once project trust is revoked", async () => {
    // applyProjectTrust repairs the live entry's enabled set like an override
    // publication: the gate must not keep dispatching a server the user just
    // distrusted from an already-prepared stream.
    const workspaceId = "ws-call-time-trust";
    configService.listServers = mock((_projectPath: string, trusted: boolean) =>
      Promise.resolve(
        trusted
          ? { server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") }
          : { stable: stdioConfig("cmd-stable") }
      )
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    servers.serve("cmd-stable", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { trusted: true, overrides: {}, overridesAuthoritative: true })
    );
    const projectTool = result.tools.server_ping;
    const globalTool = result.tools.stable_ping;
    if (!projectTool?.execute || !globalTool?.execute) {
      throw new Error("Expected served tools to include execute");
    }
    manager.acquireLease(workspaceId);
    await projectTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    manager.applyProjectTrust([{ projectPath: PROJECT_PATH, trusted: false }]);
    // The racing call waits for the repair registered by the trust change.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(projectTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Servers that do not depend on trust keep working.
    await globalTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    manager.releaseLease(workspaceId);
  });

  test("a serve's disk re-read is cancelled with the caller's signal", async () => {
    manager.dispose();
    const readWorkspaceOverrides = mock(
      (_workspaceId: string, options?: { signal?: AbortSignal }) =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        })
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    servers.serve("cmd-1");
    const controller = new AbortController();
    // A cold serve re-reads disk through the reader; without the signal the
    // remote read would run to its own (minutes-long) timeout.
    const pending = manager.getToolsForWorkspace(
      workspaceRequest("ws-read-signal", { overrides: {}, overridesAuthoritative: true }),
      { signal: controller.signal }
    );
    await waitFor(() => readWorkspaceOverrides.mock.calls.length === 1);
    expect(readWorkspaceOverrides.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    // The aborted read is not a verdict: the serve fails closed.
    const result = await pending;
    expect(result.tools).toEqual({});
    expect(result.overridesUsed).toBeUndefined();
  });

  test("served tool objects re-read the effective overrides on every call (direct document edit)", async () => {
    // A direct edit of the workspace's own or an inherited parent document
    // moves neither the epoch nor any process-local state; the gate compares
    // disk with the recorded overrides before each call.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugins-1"),
        readOverridesEpoch: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    const workspaceId = "ws-call-time-direct-edit";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: true })
    );
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    manager.acquireLease(workspaceId);
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(1);

    // Direct edit: disk disables the server; no epoch bump, no publication.
    diskOverrides = { disabledServers: ["server"] };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).toHaveBeenCalledTimes(1);
    // Unreadable document: fail closed too.
    diskOverrides = undefined;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    // Edited back: allowed again.
    diskOverrides = {};
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(2);
    // A read that THROWS (unreachable parent checkout, config error) is not a
    // verdict either: fail closed rather than fall through to the cached set.
    readWorkspaceOverrides.mockImplementationOnce(() =>
      Promise.reject(new Error("parent checkout unreachable"))
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("could not be re-read");
    expect(executeTool).toHaveBeenCalledTimes(2);
    // Disk answers again: re-derived and allowed.
    await serverTool.execute({}, {} as never);
    expect(executeTool).toHaveBeenCalledTimes(3);
    // The re-read honors the tool call's abort signal (Escape) instead of
    // running to completion first.
    readWorkspaceOverrides.mockImplementationOnce(() => new Promise(() => undefined));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).toHaveBeenCalledTimes(3);
    manager.releaseLease(workspaceId);
  });

  test("served tool calls do not hang on a publication repair the publisher gave up on", async () => {
    // The publisher bounds applyWorkspaceOverrides and evicts on timeout; the
    // stalled repair must neither block nor authorize calls after that.
    const workspaceId = "ws-stalled-repair-gate";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    // Only the publication's config read stalls (later reads answer again).
    let listServersCalls = 0;
    configService.listServers = mock(() =>
      ++listServersCalls === 1
        ? new Promise(() => undefined)
        : Promise.resolve({ server: stdioConfig("cmd-1") })
    );
    const stalled = manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    // The bounded publisher gives up and evicts.
    manager.forgetWorkspaceOverrides(workspaceId);
    const startedAt = Date.now();
    // No disk reader in this fixture: the invalidation cannot be resolved, so
    // the call fails closed — promptly, without waiting on the stalled repair.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(executeTool).not.toHaveBeenCalled();
    void stalled;
    // A stalled repair still pending (no eviction yet) must not hold a call
    // past Escape: the wait is abort-aware.
    const stalled2 = manager.applyWorkspaceOverrides(workspaceId, { disabledServers: [] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      serverTool.execute({}, { abortSignal: AbortSignal.abort() } as never)
    ).rejects.toThrow("aborted");
    expect(executeTool).not.toHaveBeenCalled();
    void stalled2;
  });

  test("a publication whose repair fails invalidates the workspace instead of leaving stale enablement", async () => {
    // Recorded overrides say "disabled" while the entry keeps the old enabled
    // set; a per-call disk comparison finds disk equal to the recorded value,
    // so nothing else would ever repair the entry. Fail closed until re-derived.
    const workspaceId = "ws-repair-failure";
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    configService.listServers = mock(() => Promise.reject(new Error("config unreadable")));
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["server"] });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("a publication starting during a call's revalidation is honored before dispatch", async () => {
    // The disabling save lands after the gate's first pending-repair lookup:
    // its recorded options are installed but its repair is still pending.
    // The gate must not dispatch on the pre-publication enabled set.
    const workspaceId = "ws-gate-late-publication";
    // The publication starts inside the call's revalidation bracket (its
    // cross-process token read), with a repair that never completes (stalled
    // config read).
    let publishOnTokenRead = false;
    let publication: Promise<void> | undefined;
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => {
          if (publishOnTokenRead) {
            configService.listServers = mock(() => new Promise(() => undefined));
            publication ??= manager.applyWorkspaceOverrides(workspaceId, {
              disabledServers: ["server"],
            });
          }
          return Promise.resolve("epoch-1");
        },
      },
    });
    configService.listServers = mock(() => Promise.resolve({ server: stdioConfig("cmd-1") }));
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }
    publishOnTokenRead = true;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(publication).toBeDefined();
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("a superseded publication repair cannot restore an older enabled set", async () => {
    // Publication #1 (enables) stalls in listServers past the publisher's
    // bound; publication #2 completes after the server left the config. #1's
    // late completion must not overwrite the live entry's enablement. #2
    // names no override for the server, so the call-time gate can refuse it
    // only through that enablement (an override disable would mask it).
    const workspaceId = "ws-stale-repair";
    configService.listServers = mock(() =>
      Promise.resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") })
    );
    const executeTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const dummyTool = {
      description: "test",
      inputSchema: { type: "object", properties: {} },
      execute: executeTool,
    } as unknown as Tool;
    servers.serve("cmd-1", { tools: { ping: dummyTool } });
    servers.serve("cmd-stable", { tools: { ping: dummyTool } });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const serverTool = result.tools.server_ping;
    if (!serverTool?.execute) {
      throw new Error("Expected served tool to include execute");
    }

    let releaseFirst!: () => void;
    configService.listServers = mock(
      () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ server: stdioConfig("cmd-1"), stable: stdioConfig("cmd-stable") });
        })
    );
    const first = manager.applyWorkspaceOverrides(workspaceId, { enabledServers: ["server"] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    configService.listServers = mock(() => Promise.resolve({ stable: stdioConfig("cmd-stable") }));
    await manager.applyWorkspaceOverrides(workspaceId, {});
    releaseFirst();
    await first;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(serverTool.execute({}, {} as never)).rejects.toThrow("server 'server'");
    expect(executeTool).not.toHaveBeenCalled();
  });

  test("an invalidated workspace whose overrides stay unreadable fails closed until disk answers", async () => {
    using tmp = new DisposableTempDir("mcp-fail-closed-plugin");
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    // A globally ENABLED ordinary server plus a default-disabled plugin server.
    configService.listServers = mock(() =>
      Promise.resolve({
        ordinary: stdioConfig("node ordinary.js"),
        ...launchablePluginConfig(tmp.path),
      })
    );
    servers.serve("node ordinary.js");
    servers.serve(PLUGIN_COMMAND);
    const workspaceId = "ws-fail-closed";
    // The caller's snapshot: the parent had enabled the plugin server; ordinary runs by default.
    const callerSnapshot = workspaceRequest(workspaceId, {
      overrides: { enabledServers: [PLUGIN_KEY] },
    });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect((await manager.getToolsForWorkspace(callerSnapshot)).stats.enabledServerCount).toBe(2);

    // Parent save (revoking the plugin enable) evicted us; disk is unreadable
    // during the re-read.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    const during = await manager.getToolsForWorkspace(callerSnapshot);
    // Fail closed: neither the recorded plugin enable nor the globally enabled
    // ordinary server is served from a snapshot disk cannot vouch for.
    expect(during.stats.enabledServerCount).toBe(0);

    // Disk recovers: the invalidation survived, the revocation is observed,
    // and ordinary enablement resumes from the authoritative read.
    diskOverrides = {};
    const after = await manager.getToolsForWorkspace(callerSnapshot);
    expect(after.stats.enabledServerCount).toBe(1);
  });

  test("a plugin-epoch refresh that cannot read disk keeps an invalidated workspace failing closed", async () => {
    using tmp = new DisposableTempDir("mcp-refresh-invalidated-plugin");
    manager.dispose();
    let token = "epoch-1";
    let diskOverrides: Record<string, unknown> | undefined = { enabledServers: [PLUGIN_KEY] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({
        ordinary: stdioConfig("node ordinary.js"),
        ...launchablePluginConfig(tmp.path),
      })
    );
    servers.serve("node ordinary.js");
    servers.serve(PLUGIN_COMMAND);
    const workspaceId = "ws-refresh-invalidated";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(
      (
        await manager.getToolsForWorkspace(
          workspaceRequest(workspaceId, { overrides: { enabledServers: [PLUGIN_KEY] } })
        )
      ).stats.enabledServerCount
    ).toBe(2);

    // Parent save evicted us while disk is unreadable; then a sibling
    // process's plugin mutation bumps the epoch. The refresh sweep's fallback
    // (scrubbed recorded snapshot) must not repopulate the overlay cache for
    // the invalidated workspace — that snapshot is what is being distrusted.
    // A caller holding exactly that scrubbed document (read after the
    // sibling's prune) would otherwise match the repopulated cache and be
    // served on the fast path without the pending disk re-read.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    token = "epoch-2";
    const prunedSnapshot = workspaceRequest(workspaceId, { overrides: { enabledServers: [] } });
    const during = await manager.getToolsForWorkspace(prunedSnapshot);
    expect(during.stats.enabledServerCount).toBe(0);

    // Disk recovers to a state the scrubbed snapshot does not match (the
    // parent re-enabled the plugin): the invalidation survived the sweep, so
    // this serve re-reads disk instead of matching a repopulated cache.
    const readsBeforeRecovery = readWorkspaceOverrides.mock.calls.length;
    diskOverrides = { enabledServers: [PLUGIN_KEY] };
    const after = await manager.getToolsForWorkspace(prunedSnapshot);
    expect(readWorkspaceOverrides.mock.calls.length).toBeGreaterThan(readsBeforeRecovery);
    expect(after.stats.enabledServerCount).toBe(2);
  });

  test("an authoritative publication retires the invalidation and the fail-closed state", async () => {
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-publication-wins";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The caller's snapshot of what disk said at that serve.
    const callerSnapshot = workspaceRequest(workspaceId, { overrides: {} });

    // Evicted, then disk unreadable: fails closed.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = undefined;
    expect((await manager.getToolsForWorkspace(callerSnapshot)).stats.enabledServerCount).toBe(0);
    // A later parent save resolves the child authoritatively and publishes it:
    // MCP must come back without waiting for another disk read.
    await manager.applyWorkspaceOverrides(workspaceId, {});
    const reads = readWorkspaceOverrides.mock.calls.length;
    expect((await manager.getToolsForWorkspace(callerSnapshot)).stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides.mock.calls.length).toBe(reads);
  });

  test("a server revoked mid-startup is not served by the completing serve", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({
        ordinary: stdioConfig("node ordinary.js"),
        other: stdioConfig("node other.js"),
      })
    );
    const workspaceId = "ws-revoked-mid-startup";
    servers.serve("node other.js", { tools: { echo: testTool() } });
    servers.serve("node ordinary.js", {
      tools: { echo: testTool() },
      // A parent save publishes a disable while these servers are starting.
      connect: () =>
        manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["ordinary"] }),
    });
    const result = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(result.tools)).toEqual(["other_echo"]);
  });

  test("a global eviction landing during a cold serve's first read fails that serve closed", async () => {
    manager.dispose();
    let release: (value: Record<string, unknown>) => void = () => undefined;
    const readWorkspaceOverrides = mock(
      () => new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const inFlight = manager.getToolsForWorkspace(workspaceRequest("ws-cold-global"));
    while (readWorkspaceOverrides.mock.calls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The cold workspace is in neither map, so a global eviction cannot name it…
    manager.forgetAllWorkspaceOverrides();
    release({});
    // …yet its pre-eviction read must not be served…
    expect((await inFlight).stats.enabledServerCount).toBe(0);
    // …and the recorded (stale) options must not satisfy the next serve either:
    // it re-reads disk.
    const next = manager.getToolsForWorkspace(
      workspaceRequest("ws-cold-global", { overrides: {} })
    );
    while (readWorkspaceOverrides.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    release({});
    expect((await next).stats.enabledServerCount).toBe(1);
  });

  test("a forget landing during an in-flight disk read is not retired by that read", async () => {
    manager.dispose();
    let release: (value: Record<string, unknown>) => void = () => undefined;
    let reads = 0;
    const readWorkspaceOverrides = mock(() => {
      reads += 1;
      if (reads === 1) return Promise.resolve({});
      if (reads === 2)
        return new Promise<Record<string, unknown>>((resolve) => (release = resolve));
      return Promise.resolve({ disabledServers: ["ordinary"] });
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-forget-race";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    const callerSnapshot = workspaceRequest(workspaceId, { overrides: {} });

    manager.forgetWorkspaceOverrides(workspaceId);
    const inFlight = manager.getToolsForWorkspace(callerSnapshot);
    while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    // A newer parent save invalidates again while the (older) read is pending…
    manager.forgetWorkspaceOverrides(workspaceId);
    release({}); // …and the older read completes with pre-save state.
    // The superseded read is not served: this serve fails closed.
    expect((await inFlight).stats.enabledServerCount).toBe(0);

    // The newer invalidation must still force a disk read, which now sees the disable.
    const next = await manager.getToolsForWorkspace(callerSnapshot);
    expect(reads).toBe(3);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("a forget landing after a serve selected its options fails that serve closed", async () => {
    // The serve already recorded its options and is awaiting server startup
    // when a parent save evicts the workspace. The recorded options are the
    // same object, and the config generation is unchanged, so the enablement
    // repair sees nothing to redo — the invalidation marker alone must gate
    // the return, or the revoked server's tools reach this stream.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    // Startup (after the serve recorded its options) waits on this gate.
    const startup = Promise.withResolvers<void>();
    servers.serve("node ordinary.js", {
      tools: { echo: testTool() },
      prompts: [{ name: "status" }],
      connect: () => startup.promise,
    });
    const workspaceId = "ws-forget-mid-startup";
    const inFlight = manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await waitFor(() => servers.connectCount("node ordinary.js") === 1);
    // Parent save revokes the server on disk and evicts us mid-startup.
    diskOverrides = { disabledServers: ["ordinary"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    startup.resolve();
    const served = await inFlight;
    expect(Object.keys(served.tools)).toHaveLength(0);
    expect(served.promptDescriptors).toHaveLength(0);

    // The marker survived: the next serve re-reads disk and observes the disable.
    const next = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("getPrompt does not dispatch through a stale entry when the workspace is invalidated mid-serve", async () => {
    // getPrompt's dispatch-time ensureWorkspaceServers fails closed via
    // serveResult, but does not rewrite the cached entry — the prompt path
    // must consume that verdict rather than consult the stale entry.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    const configured = { ordinary: stdioConfig("node ordinary.js") };
    configService.listServers = mock(() => Promise.resolve(configured));
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    servers.serve("node ordinary.js", { prompts: [{ name: "status" }], getPrompt });
    const workspaceId = "ws-prompt-forget-mid-serve";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // Sanity: the prompt dispatches normally.
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    // getPrompt reads config once in its stabilization loop, then again in the
    // dispatch-time serve: gate that second read.
    let listServersCalls = 0;
    let gatedListServersCalls = 0;
    let releaseListServers: () => void = () => undefined;
    configService.listServers = mock(() => {
      listServersCalls += 1;
      if (listServersCalls < 2) return Promise.resolve(configured);
      gatedListServersCalls += 1;
      return new Promise<typeof configured>((resolve) => {
        releaseListServers = () => resolve(configured);
      });
    });
    const prompt = manager.getPrompt(workspaceId, "ordinary", "status", {});
    while (gatedListServersCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Parent save revokes the server on disk and evicts this workspace while
    // the dispatch-time serve is mid-flight.
    diskOverrides = { disabledServers: ["ordinary"] };
    manager.forgetWorkspaceOverrides(workspaceId);
    releaseListServers();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(prompt).rejects.toThrow(/unavailable|disabled/);
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("a plugin-epoch refresh never restores a snapshot over a publication that landed mid-read", async () => {
    manager.dispose();
    let token = "epoch-1";
    let release: (value: Record<string, unknown>) => void = () => undefined;
    let gateRead = false;
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => {
      if (!gateRead) return Promise.resolve(diskOverrides);
      gateRead = false; // gate exactly one read (the sweep's)
      return new Promise<Record<string, unknown>>((resolve) => (release = resolve));
    });
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve(token),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-refresh-vs-publication";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The caller still holds the pre-save snapshot throughout.
    const staleSnapshot = workspaceRequest(workspaceId, { overrides: {} });

    // Sibling plugin mutation: the epoch sweep re-reads this workspace's
    // overrides; the read is in flight…
    gateRead = true;
    token = "epoch-2";
    const sweep = manager.getToolsForWorkspace(staleSnapshot);
    while (readWorkspaceOverrides.mock.calls.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // …when a parent save publishes a disable authoritatively (disk first).
    diskOverrides = { disabledServers: ["ordinary"] };
    await manager.applyWorkspaceOverrides(workspaceId, { disabledServers: ["ordinary"] });
    // The read completes with pre-save state; it must not win. (The serve's
    // stale `{}` snapshot then disagrees with the cache and is revalidated
    // against disk, which agrees with the publication.)
    release({});
    expect((await sweep).stats.enabledServerCount).toBe(0);
    // Had the sweep committed its read, the cache would hold `{}` again and
    // the stale snapshot would match it on the fast path.
    const next = await manager.getToolsForWorkspace(staleSnapshot);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("a publication landing between the final repair and the return fails that serve closed", async () => {
    // The repair derives enablement and resolves; the caller resumes one
    // microtask later. A publication squeezed into that gap replaced the
    // recorded options (its own listServers still pending) — the entry's
    // enabled set is stale for this serve and must not be filtered through.
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const workspaceId = "ws-publish-after-repair";
    let publishOnPromptRefresh = false;
    let publication: Promise<void> | undefined;
    servers.serve("node ordinary.js", {
      tools: { echo: testTool() },
      // A warm serve spawns its background prompt refresh after its final
      // enablement repair and before its return gate; prompts/list is issued
      // synchronously, so the publication's synchronous part (recorded
      // options replaced, marker retired) lands exactly in that gap.
      listPrompts: () => {
        if (publishOnPromptRefresh) {
          publication ??= manager.applyWorkspaceOverrides(workspaceId, {
            disabledServers: ["ordinary"],
          });
        }
        return Promise.resolve([]);
      },
    });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    publishOnPromptRefresh = true;
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(publication).toBeDefined();
    expect(Object.keys(served.tools)).toHaveLength(0);
    await publication;

    // The publication's own completion repaired the entry for later serves.
    const next = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(next.tools)).toHaveLength(0);
    expect(next.stats.enabledServerCount).toBe(0);
  });

  test("getPrompt does not dispatch when a publication lands between the final serve and dispatch", async () => {
    const configured = { ordinary: stdioConfig("node ordinary.js") };
    configService.listServers = mock(() => Promise.resolve(configured));
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    servers.serve("node ordinary.js", { prompts: [{ name: "status" }], getPrompt });
    const workspaceId = "ws-prompt-publish-gap";
    let publishOnDispatchLock = false;
    let publication: Promise<void> | undefined;
    const publicationRead = Promise.withResolvers<void>();
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readOverridesEpoch: () => Promise.resolve("overrides-1"),
        readWorkspaceOverrides: () => Promise.resolve({}),
        // Acquired right after the dispatch-time serve passed its gate: a
        // parent publication's synchronous part (recorded options replaced,
        // marker retired; its own listServers still pending) lands before
        // getPrompt dispatches.
        acquireOverridesLock: () => {
          if (publishOnDispatchLock && publication === undefined) {
            configService.listServers = mock(() => publicationRead.promise.then(() => configured));
            publication = manager.applyWorkspaceOverrides(workspaceId, {
              disabledServers: ["ordinary"],
            });
          }
          return Promise.resolve(() => Promise.resolve());
        },
      },
    });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    publishOnDispatchLock = true;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "ordinary", "status", {})).rejects.toThrow(
      /unavailable/
    );
    expect(publication).toBeDefined();
    expect(getPrompt).toHaveBeenCalledTimes(1);
    publicationRead.resolve();
    await publication;
  });

  test("a serve whose enablement repair fails after a publication fails closed", async () => {
    const configured = { ordinary: stdioConfig("node ordinary.js") };
    configService.listServers = mock(() => Promise.resolve(configured));
    servers.serve("node ordinary.js", { tools: { echo: testTool() } });
    const workspaceId = "ws-repair-fails";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    let publication: Promise<void> | undefined;
    let releasePublication: () => void = () => undefined;
    let configReads = 0;
    configService.listServers = mock(() => {
      configReads += 1;
      if (configReads === 1) {
        // The next serve's own config read: a publication replaces the
        // recorded options meanwhile…
        publication = manager.applyWorkspaceOverrides(workspaceId, {
          disabledServers: ["ordinary"],
        });
        return Promise.resolve(configured);
      }
      if (configReads === 2) {
        // …its own listServers stays pending until after the serve returns…
        return new Promise<typeof configured>((resolve) => {
          releasePublication = () => resolve(configured);
        });
      }
      // …and the serve's enablement re-derivation fails.
      return Promise.reject(new Error("config unreadable"));
    });
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    // The stale enabled set must not be filtered through as if re-derived.
    expect(Object.keys(served.tools)).toHaveLength(0);
    releasePublication();
    await publication;
  });

  test("a publication landing during the epoch postflight fails that serve closed", async () => {
    manager.dispose();
    let tokenReads = 0;
    let publication: Promise<void> | undefined;
    const workspaceId = "ws-publish-during-postflight";
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => {
          // Per serve: preflight (odd) then postflight (even). The second
          // serve's postflight is call 4 — publish while it is awaited.
          if (++tokenReads === 4) {
            publication = manager.applyWorkspaceOverrides(workspaceId, {
              disabledServers: ["ordinary"],
            });
          }
          return Promise.resolve("epoch-1");
        },
        readWorkspaceOverrides: () => Promise.resolve({}),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js", { tools: { echo: testTool() } });
    const first = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(Object.keys(first.tools)).toHaveLength(1);

    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(publication).toBeDefined();
    expect(Object.keys(second.tools)).toHaveLength(0);
    await publication;
    const third = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(third.stats.enabledServerCount).toBe(0);
  });

  test("getToolsForWorkspace fails closed for a non-empty serve without enablement provenance", async () => {
    // A recursive serve that lost its provenance (or any path that cannot
    // vouch for what enablement was derived from) must not hand out tools.
    // Private call: every public serve path attaches provenance, so only a
    // stubbed internal serve can pin this defense-in-depth wrapper check.
    spyOn(
      manager as unknown as { ensureWorkspaceServers: (...args: unknown[]) => Promise<unknown> },
      "ensureWorkspaceServers"
    ).mockImplementation(() =>
      Promise.resolve({
        tools: { ordinary_echo: testTool() },
        toolServerNames: { ordinary_echo: "ordinary" },
        stats: cachedStats(),
        promptDescriptors: [],
      })
    );
    const served = await manager.getToolsForWorkspace(workspaceRequest("ws-no-provenance"));
    expect(Object.keys(served.tools)).toHaveLength(0);
  });

  test("getPrompt does not dispatch when a forget lands between the final serve and dispatch", async () => {
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] })
    );
    servers.serve("node ordinary.js", { prompts: [{ name: "status" }], getPrompt });
    const workspaceId = "ws-prompt-forget-gap";
    let forgetOnDispatchLock = false;
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readOverridesEpoch: () => Promise.resolve("overrides-1"),
        readWorkspaceOverrides: () => Promise.resolve({}),
        // Acquired right after the dispatch-time serve passed its gate. A
        // forget leaves the recorded options in place and only sets the marker.
        // Injects exactly one forget (then disarms), so a regression that
        // retries after it cannot stay blocked on fresh invalidations.
        acquireOverridesLock: () => {
          if (forgetOnDispatchLock) {
            forgetOnDispatchLock = false;
            manager.forgetWorkspaceOverrides(workspaceId);
          }
          return Promise.resolve(() => Promise.resolve());
        },
      },
    });
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getPrompt(workspaceId, "ordinary", "status", {});
    expect(getPrompt).toHaveBeenCalledTimes(1);

    forgetOnDispatchLock = true;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(workspaceId, "ordinary", "status", {})).rejects.toThrow(
      /unavailable/
    );
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  test("an invalidation is retired only once the fresh options are the recorded ones", async () => {
    // Retiring the marker inside the disk read would leave a window in which
    // an overlapping serve sees no marker while the stale pre-read options are
    // still recorded — and installs them as current.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-retire-after-install";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));

    // Private read: retirement and recording share one synchronous block, so
    // no public caller can interleave there; observe the marker map and the
    // recorded options at the instant the marker goes away.
    const internals = manager as unknown as {
      overridesInvalidationGenerations: Map<string, number>;
      lastWorkspaceRequestOptions: Map<string, MCPWorkspaceRequestOptions>;
    };
    const generations = internals.overridesInvalidationGenerations;
    const recordedAtRetirement: unknown[] = [];
    const realDelete = generations.delete.bind(generations);
    generations.delete = (key: string) => {
      recordedAtRetirement.push(internals.lastWorkspaceRequestOptions.get(workspaceId)?.overrides);
      return realDelete(key);
    };

    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = { disabledServers: ["ordinary"] };
    const served = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(served.stats.enabledServerCount).toBe(0);
    // Whenever the marker went away, the recorded options already held the
    // fresh disk state — never the stale pre-read snapshot.
    expect(recordedAtRetirement.length).toBeGreaterThan(0);
    for (const overrides of recordedAtRetirement) {
      expect(overrides).toEqual({ disabledServers: ["ordinary"] });
    }
  });

  test("a stale caller snapshot cannot replace overrides recovered after an invalidation", async () => {
    // After the recovery serve records fresh disk state and retires the
    // marker, a request still carrying the pre-save caller snapshot takes the
    // fast path — the recovered overrides must be cached so they overlay it.
    manager.dispose();
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-stale-snapshot-after-recovery";
    const staleSnapshot = workspaceRequest(workspaceId); // pre-save: nothing disabled
    expect((await manager.getToolsForWorkspace(staleSnapshot)).stats.enabledServerCount).toBe(1);

    // Parent save disables the server on disk and evicts us; recovery re-reads.
    manager.forgetWorkspaceOverrides(workspaceId);
    diskOverrides = { disabledServers: ["ordinary"] };
    const recovery = workspaceRequest(workspaceId, { overrides: {} });
    expect((await manager.getToolsForWorkspace(recovery)).stats.enabledServerCount).toBe(0);

    // A request that still holds the pre-save snapshot must not win.
    const late = await manager.getToolsForWorkspace(staleSnapshot);
    expect(late.stats.enabledServerCount).toBe(0);
  });

  test("a non-authoritative caller snapshot fails the serve closed unless disk vouches for it", async () => {
    // "No overrides" is not "no servers": a globally enabled server disabled
    // only by a document the caller could not read would otherwise start.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = undefined; // disk not authoritative either
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-untrusted-snapshot";
    // Establish recorded options first (an authoritative serve).
    diskOverrides = {};
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);

    // A request whose snapshot could not be established: even with recorded
    // options present, disk is re-read; when it cannot vouch either → closed.
    diskOverrides = undefined;
    const untrusted = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(untrusted.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Disk recovers and disables the server: the authoritative read wins over
    // the caller's (empty) snapshot.
    diskOverrides = { disabledServers: ["ordinary"] };
    const recovered = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(recovered.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(3);
  });

  test("prompt discovery honors a fail-closed serve instead of querying the published entry", async () => {
    // An invalidation landing while startup is in flight makes the serve fail
    // closed, yet the started instances are published (the next verifiable
    // serve reuses them). Discovery must neither run prompts/list against them
    // nor advertise their prompts on the strength of that entry alone.
    manager.dispose();
    const diskOverrides: Record<string, unknown> | undefined = undefined; // disk cannot vouch
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const workspaceId = "ws-prompts-fail-closed";
    const refreshPrompts = mock(() => Promise.resolve([{ name: "review" }]));
    servers.serve("node ordinary.js", {
      listPrompts: refreshPrompts,
      // A parent save's eviction lands mid-startup.
      connect: () => {
        manager.forgetWorkspaceOverrides(workspaceId);
        return Promise.resolve();
      },
    });

    const descriptors = await manager.getPromptsForWorkspace(workspaceRequest(workspaceId));
    expect(descriptors).toEqual([]);
    expect(refreshPrompts).not.toHaveBeenCalled();
  });

  test("a distrusted re-read draws on the caller's remaining read budget, never a fresh one", async () => {
    // The caller's own read timed out on an unreachable ancestor: a second
    // full-length attempt here would double the request's wait and leave
    // another uncancellable remote probe behind. The re-read gets only what
    // remains of the caller's deadline (nothing → fail closed without a
    // read), and the deadline is request-scoped: recorded options must not
    // carry it into later prompt dispatch re-reads.
    manager.dispose();
    const readWorkspaceOverrides = mock(
      (_workspaceId: string, _options?: { timeoutMs?: number; signal?: AbortSignal }) =>
        Promise.resolve({} as Record<string, unknown> | undefined)
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "hi" } }] })
    );
    servers.serve("node ordinary.js", { getPrompt });
    const workspaceId = "ws-shared-read-budget";

    // Budget exhausted by the caller's read: no second attempt, fail closed.
    const exhausted = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, {
        overrides: {},
        overridesAuthoritative: false,
        overridesReadDeadlineAt: Date.now() - 1,
      })
    );
    expect(exhausted.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Budget partly left: the re-read is bounded by the remainder.
    const partial = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, {
        overrides: {},
        overridesAuthoritative: false,
        overridesReadDeadlineAt: Date.now() + 5_000,
      })
    );
    expect(partial.stats.enabledServerCount).toBe(1);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);
    const remainder = readWorkspaceOverrides.mock.calls[0][1]?.timeoutMs;
    expect(remainder).toBeDefined();
    expect(remainder!).toBeLessThanOrEqual(5_000);
    expect(remainder!).toBeGreaterThan(0);

    // Prompt dispatch re-reads from the RECORDED options: the send's deadline
    // (long expired by then) must not be what bounds them.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await manager.getPrompt(workspaceId, "ordinary", "review", {})).toEqual({ text: "hi" });
    const promptRead = readWorkspaceOverrides.mock.calls.at(-1);
    expect(promptRead).toBeDefined();
    expect(promptRead![1]?.timeoutMs).toBeUndefined();
  });

  test("a cached publication that disagrees with an authoritative caller read is revalidated against disk", async () => {
    // A direct edit of the JSONC file bumps no epoch and publishes nothing;
    // the caller's later authoritative read sees it, the cache does not. Disk
    // decides — and the cache still repairs a caller snapshot that PREDATES a
    // save, because disk agrees with the cache in that case.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-cache-vs-fresh-caller";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // in-process publication: enabled
    // Caller agrees with the cache: served from it, no disk read.
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }))).stats
        .enabledServerCount
    ).toBe(1);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Direct file edit revokes the server; the caller's fresh read reflects it.
    diskOverrides = { disabledServers: ["ordinary"] };
    const afterEdit = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: { disabledServers: ["ordinary"] } })
    );
    expect(afterEdit.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // A stale caller snapshot from before the edit still loses to disk: the
    // cache now holds the edit, so the snapshot disagrees and is re-read
    // (a cache left at `{}` would serve it on the fast path).
    const stale = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(stale.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(2);

    // Disagreement with an unreadable disk fails closed.
    diskOverrides = undefined;
    const unreadable = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {} })
    );
    expect(unreadable.stats.enabledServerCount).toBe(0);
  });

  test("prompt discovery honors a caller's distrust and disagreement over recorded options", async () => {
    // A warmed workspace has recorded options (server enabled). Its document
    // then becomes unreadable: the caller forwards overridesAuthoritative
    // false, and the prompt list must revalidate against disk rather than
    // keep advertising the stale enabled server's prompts.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js", { prompts: [{ name: "status" }] });
    const workspaceId = "ws-prompts-distrusted-caller";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(await manager.getPromptsForWorkspace(workspaceRequest(workspaceId))).toHaveLength(1);

    // Document unreadable for both the caller and the manager: closed.
    diskOverrides = undefined;
    expect(
      await manager.getPromptsForWorkspace(
        workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
      )
    ).toHaveLength(0);

    // Disk readable again and revoking; a fresh authoritative caller read that
    // disagrees with the recorded (enabled) options is revalidated too.
    diskOverrides = { disabledServers: ["ordinary"] };
    expect(
      await manager.getPromptsForWorkspace(
        workspaceRequest(workspaceId, { overrides: { disabledServers: ["ordinary"] } })
      )
    ).toHaveLength(0);
  });

  test("a cached publication does not serve a caller whose own read could not establish the document", async () => {
    // The cache holds an in-process publication (server enabled); the document
    // has since become unreadable. Neither the caller nor the cache can vouch
    // for the current authorization: re-read disk, fail closed if it cannot.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = undefined;
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("epoch-1"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-cached-distrusted-caller";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // cached: nothing disabled
    // An authoritative caller is served from the cache without a disk read.
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);
    expect(readWorkspaceOverrides).not.toHaveBeenCalled();

    // Distrusted caller, disk unreadable: closed, cache left untouched.
    const closed = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(closed.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);

    // Distrusted caller, disk readable and revoking: disk wins over the cache,
    // and the cache is revalidated with it.
    diskOverrides = { disabledServers: ["ordinary"] };
    const revoked = await manager.getToolsForWorkspace(
      workspaceRequest(workspaceId, { overrides: {}, overridesAuthoritative: false })
    );
    expect(revoked.stats.enabledServerCount).toBe(0);
    // The successful reread is recorded as authoritative: prompt discovery
    // replays the recorded options for an agreeing caller and must not
    // re-enter the disk read forever.
    const readsBefore = readWorkspaceOverrides.mock.calls.length;
    expect(await manager.getPromptsForWorkspace(workspaceRequest(workspaceId))).toEqual([]);
    expect(readWorkspaceOverrides.mock.calls.length).toBe(readsBefore);
    // The cache was revalidated with disk truth: a stale authoritative
    // snapshot now disagrees with it, is re-read, and loses.
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId, { overrides: {} }))).stats
        .enabledServerCount
    ).toBe(0);
    expect(readWorkspaceOverrides.mock.calls.length).toBe(readsBefore + 1);
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(0);
  });

  test("a sibling process's override write refreshes cached snapshots before the next serve", async () => {
    // Two backends share one home: backend A's save publishes only into A's
    // cache. B learns about it through the override epoch and must not let its
    // stale overlay supersede the fresh disk state.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const served = "ws-sibling-served";
    const coldCached = "ws-sibling-cold-cached";
    await manager.getToolsForWorkspace(workspaceRequest(served));
    // An earlier publication in THIS process cached an inheriting child that
    // was never served here.
    await manager.applyWorkspaceOverrides(coldCached, {});
    // Both caches say "nothing disabled"; recorded options exist for `served`,
    // whose caller keeps its pre-write snapshot.
    const callerSnapshot = workspaceRequest(served, { overrides: {} });
    expect((await manager.getToolsForWorkspace(callerSnapshot)).stats.enabledServerCount).toBe(1);
    const readsBefore = readWorkspaceOverrides.mock.calls.length;

    // Sibling backend disables the server on disk (for both workspaces) and
    // bumps the epoch.
    diskOverrides = { disabledServers: ["ordinary"] };
    epoch = "epoch-2";

    // Served workspace: the preflight sweep re-read its overrides from disk.
    const afterServed = await manager.getToolsForWorkspace(callerSnapshot);
    expect(afterServed.stats.enabledServerCount).toBe(0);
    expect(readWorkspaceOverrides.mock.calls.length).toBeGreaterThan(readsBefore);
    // Cold cached workspace: its overlay was evicted, so the serve re-reads disk
    // instead of trusting the stale (empty) overlay or the caller snapshot.
    const afterCold = await manager.getToolsForWorkspace(workspaceRequest(coldCached));
    expect(afterCold.stats.enabledServerCount).toBe(0);
  });

  test("cache state predating the first epoch observation is evicted, not trusted", async () => {
    // Backend B received an in-process publication for a never-served child;
    // backend A then revoked the server before B's first serve. The baseline
    // token cannot vouch for that cache entry.
    manager.dispose();
    const readWorkspaceOverrides = mock(() =>
      Promise.resolve<Record<string, unknown>>({ disabledServers: ["ordinary"] })
    );
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("epoch-already-advanced"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-cache-before-first-observation";
    await manager.applyWorkspaceOverrides(workspaceId, {}); // pre-revocation publication
    const served = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(readWorkspaceOverrides).toHaveBeenCalled();
    expect(served.stats.enabledServerCount).toBe(0);
  });

  test("a sibling override write landing mid-serve is caught by the postflight bracket", async () => {
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    let epochReads = 0;
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => {
          epochReads += 1;
          // Second serve: preflight is read 3, postflight is read 4 — the
          // sibling's write lands between them.
          if (epochReads === 4) {
            diskOverrides = { disabledServers: ["ordinary"] };
            epoch = "epoch-2";
          }
          return Promise.resolve(epoch);
        },
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-mid-serve-sibling-write";
    expect(
      (await manager.getToolsForWorkspace(workspaceRequest(workspaceId))).stats.enabledServerCount
    ).toBe(1);
    // The serve whose postflight observes the new epoch must not return the
    // pre-revocation result; it retries against disk.
    const second = await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    expect(second.stats.enabledServerCount).toBe(0);
  });

  test("the postflight compares against the operation's own baseline, not a baseline advanced by a concurrent serve", async () => {
    // getPrompt has passed its process-local gates and awaits prompts/get when
    // a sibling revokes the server; a concurrent serve's preflight observes the
    // new epoch, evicts, and advances the live baseline. The prompt operation's
    // postflight then reads an epoch equal to the live baseline — but not to
    // the one it ran under — and must not accept its pre-revocation result.
    manager.dispose();
    let epoch = "epoch-1";
    let diskOverrides: Record<string, unknown> = {};
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve(epoch),
        readWorkspaceOverrides: () => Promise.resolve(diskOverrides),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    let releasePrompt: () => void = () => undefined;
    let promptGated = false;
    const getPrompt = mock(
      () =>
        new Promise<{ messages: unknown[] }>((resolve) => {
          promptGated = true;
          releasePrompt = () =>
            resolve({ messages: [{ role: "user", content: { type: "text", text: "Status" } }] });
        })
    );
    servers.serve("node ordinary.js", { prompts: [{ name: "status" }], getPrompt });
    const workspaceId = "ws-prompt-baseline";
    const other = "ws-other-serve";
    await manager.getToolsForWorkspace(workspaceRequest(workspaceId));
    await manager.getToolsForWorkspace(workspaceRequest(other));

    const prompt = manager.getPrompt(workspaceId, "ordinary", "status", {});
    while (!promptGated) await new Promise((resolve) => setTimeout(resolve, 1));
    diskOverrides = { disabledServers: ["ordinary"] };
    epoch = "epoch-2";
    await manager.getToolsForWorkspace(workspaceRequest(other)); // advances the live baseline
    releasePrompt();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(prompt).rejects.toThrow(/disabled|unavailable/);
  });

  test("an unreadable override epoch fails serves closed instead of acting as a stable version", async () => {
    manager.dispose();
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("mcp-overrides-epoch-unreadable"),
        readWorkspaceOverrides: () => Promise.resolve({}),
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const workspaceId = "ws-epoch-unreadable";
    // Every serve — including the first — sees "unreadable" as a change it
    // cannot bound, and gives up rather than trusting anything (the request
    // builder then continues without MCP tools) — before any server process
    // is launched.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getToolsForWorkspace(workspaceRequest(workspaceId))).rejects.toThrow(
      /about to start/
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getToolsForWorkspace(workspaceRequest(workspaceId))).rejects.toThrow(
      /about to start/
    );
    expect(servers.exec).not.toHaveBeenCalled();
    expect(servers.connectCount("node ordinary.js")).toBe(0);
  });

  test("a cold off-host serve re-reads disk instead of trusting a snapshot older than the epoch baseline", async () => {
    // Backend B read an SSH workspace's overrides (request snapshot), backend A
    // then revoked the server and bumped the epoch, and only now does B reach
    // its first manager serve: the baseline it records is already A's token,
    // so neither eviction nor the postflight can catch the stale snapshot.
    manager.dispose();
    let diskOverrides: Record<string, unknown> | undefined = { disabledServers: ["ordinary"] };
    const readWorkspaceOverrides = mock(() => Promise.resolve(diskOverrides));
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("plugin-epoch"),
        readOverridesEpoch: () => Promise.resolve("epoch-after-sibling-revocation"),
        readWorkspaceOverrides,
      },
    });
    configService.listServers = mock(() =>
      Promise.resolve({ ordinary: stdioConfig("node ordinary.js") })
    );
    servers.serve("node ordinary.js");
    const remote = Object.create(RemoteRuntime.prototype) as Runtime;
    const served = await manager.getToolsForWorkspace(
      workspaceRequest("ws-cold-remote", { runtime: remote, overrides: {} })
    );
    expect(readWorkspaceOverrides).toHaveBeenCalledTimes(1);
    expect(served.stats.enabledServerCount).toBe(0);

    // When disk cannot vouch either, the cold serve fails closed rather than
    // falling back to the unbounded snapshot.
    diskOverrides = undefined;
    const unvouched = await manager.getToolsForWorkspace(
      workspaceRequest("ws-cold-remote-unreadable", { runtime: remote, overrides: {} })
    );
    expect(unvouched.stats.enabledServerCount).toBe(0);
  });

  test("plugin servers are excluded on off-host runtimes (remote and devcontainer)", async () => {
    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig()));

    // Runtime identity is all the gate needs; both classes exec off-host.
    // DevcontainerRuntime extends LocalBaseRuntime but execs inside the container.
    const offHostRuntimes: Array<[string, Runtime]> = [
      ["ws-plugin-remote", Object.create(RemoteRuntime.prototype) as Runtime],
      ["ws-plugin-devcontainer", Object.create(DevcontainerRuntime.prototype) as Runtime],
    ];
    for (const [workspaceId, runtime] of offHostRuntimes) {
      const result = await manager.getToolsForWorkspace(
        workspaceRequest(workspaceId, {
          runtime,
          overrides: { enabledServers: [PLUGIN_KEY] },
        })
      );

      expect(result.stats.enabledServerCount).toBe(0);
    }
  });

  for (const scenario of [
    {
      name: "workspace disable overrides a globally enabled plugin",
      globallyEnabled: true,
      overrides: { disabledServers: [PLUGIN_KEY] },
      expectedServers: [],
    },
    {
      name: "workspace enable overrides a globally disabled plugin",
      globallyEnabled: false,
      overrides: { enabledServers: [PLUGIN_KEY] },
      expectedServers: [PLUGIN_KEY],
    },
    {
      name: "globally enabled plugin starts without a workspace override",
      globallyEnabled: true,
      overrides: undefined,
      expectedServers: [PLUGIN_KEY],
    },
  ]) {
    test(scenario.name, async () => {
      using tmp = new DisposableTempDir("mcp-plugin-global-overrides");
      await fs.writeFile(
        path.join(tmp.path, "mcp.jsonc"),
        JSON.stringify({
          servers: {},
          enabledPluginServers: scenario.globallyEnabled ? [PLUGIN_KEY] : [],
        })
      );
      const pluginConfigService = new MCPConfigService(new Config(tmp.path), {
        agentPluginsMcpProvider: () =>
          Promise.resolve(launchablePluginConfig(path.join(tmp.path, "data"))),
      });
      manager.dispose();
      manager = new MCPServerManager(pluginConfigService);
      servers.serve(PLUGIN_COMMAND, { tools: { echo: testTool() } });

      // Establish the persisted default before testing workspace precedence.
      expect((await pluginConfigService.listServers())[PLUGIN_KEY]?.disabled).toBe(
        !scenario.globallyEnabled
      );
      const result = await manager.getToolsForWorkspace(
        workspaceRequest("ws-plugin-global-overrides", { overrides: scenario.overrides })
      );
      expect(result.stats.enabledServerCount).toBe(scenario.expectedServers.length);
      expect(result.stats.startedServerCount).toBe(scenario.expectedServers.length);
      expect(Object.values(result.toolServerNames)).toEqual(scenario.expectedServers);
      expect(servers.connectCount(PLUGIN_COMMAND)).toBe(scenario.expectedServers.length);
    });
  }

  for (const transport of ["stdio", "http", "sse", "auto"] as const) {
    for (const workspaceConsent of [false, true]) {
      for (const trackOverrides of [false, true]) {
        test(`cold ${transport} startup gates sibling revocation (workspace consent: ${workspaceConsent}, override fence: ${trackOverrides})`, async () => {
          using tmp = new DisposableTempDir("mcp-plugin-global-startup-revocation");
          const plugin = pluginStdioConfig()[PLUGIN_KEY].plugin;
          const definition: MCPServerInfo =
            transport === "stdio"
              ? {
                  ...pluginStdioConfig()[PLUGIN_KEY],
                  env: { PLUGIN_DATA: path.join(tmp.path, "data") },
                  cwd: tmp.path,
                }
              : { transport, url: "http://127.0.0.1:1", disabled: true, plugin };
          const deps = {
            agentPluginsMcpProvider: () => Promise.resolve({ [PLUGIN_KEY]: definition }),
          };
          const writer = new MCPConfigService(new Config(tmp.path), deps);
          const reader = new MCPConfigService(new Config(tmp.path), deps);
          expect((await writer.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
          const list = reader.listServers.bind(reader);
          const discovery = spyOn(reader, "listServers").mockImplementationOnce(async (...args) => {
            const snapshot = await list(...args);
            expect(snapshot[PLUGIN_KEY]?.disabled).toBe(false);
            expect((await writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
            return snapshot;
          });
          const exec = mock(() => Promise.reject(new Error("Reached exec")));
          const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
            Promise.reject(new Error("Reached connection"))
          );
          const overrides = workspaceConsent ? { enabledServers: [PLUGIN_KEY] } : {};
          manager.dispose();
          manager = new MCPServerManager(reader, {
            ...(trackOverrides
              ? {
                  pluginInvalidation: {
                    keyPrefix: "plugin:",
                    readToken: () => Promise.resolve("stable"),
                    readOverridesEpoch: () => Promise.resolve("stable"),
                    readWorkspaceOverrides: () => Promise.resolve(overrides),
                    acquireOverridesLock: () => Promise.resolve(() => Promise.resolve()),
                  },
                }
              : {}),
          });
          try {
            await manager.getToolsForWorkspace(
              workspaceRequest("global-startup", {
                runtime: { exec } as unknown as Runtime,
                overrides,
              })
            );
            expect(transport === "stdio" ? exec : client).toHaveBeenCalledTimes(
              workspaceConsent ? 1 : 0
            );
          } finally {
            discovery.mockRestore();
            client.mockRestore();
          }
        });
      }
    }
  }

  test("auto startup rechecks global consent before its SSE fallback", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-fallback-revocation");
    const deps = {
      agentPluginsMcpProvider: () =>
        Promise.resolve({
          [PLUGIN_KEY]: {
            transport: "auto" as const,
            url: "http://127.0.0.1:1",
            disabled: true,
            plugin: pluginStdioConfig()[PLUGIN_KEY].plugin,
          },
        }),
    };
    const writer = new MCPConfigService(new Config(tmp.path), deps);
    const reader = new MCPConfigService(new Config(tmp.path), deps);
    expect((await writer.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
    const acquire = reader.acquireGlobalPluginEnablementFence.bind(reader);
    let admissions = 0;
    const admission = spyOn(reader, "acquireGlobalPluginEnablementFence").mockImplementation(
      async (...args) => {
        if (++admissions === 2) {
          expect((await writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
        }
        return acquire(...args);
      }
    );
    const client = spyOn(mcpSdk, "createMCPClient").mockImplementation(() =>
      Promise.reject(Object.assign(new Error("HTTP not supported"), { status: 404 }))
    );
    manager.dispose();
    manager = new MCPServerManager(reader);
    try {
      await manager.getToolsForWorkspace(workspaceRequest("global-fallback"));
      expect(admissions).toBe(2);
      expect(client).toHaveBeenCalledTimes(1);
    } finally {
      admission.mockRestore();
      client.mockRestore();
    }
  });

  test("global consent stays locked through exec and releases on startup failure", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-exec-lock");
    const deps = {
      agentPluginsMcpProvider: () =>
        Promise.resolve(
          pluginStdioConfig({
            env: { PLUGIN_DATA: path.join(tmp.path, "data") },
            cwd: tmp.path,
          })
        ),
    };
    const config = new MCPConfigService(new Config(tmp.path), deps);
    expect((await config.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
    let writerBlocked = false;
    const exec = mock(async () => {
      // Probe the real writer lock at the execution boundary, rather than
      // assuming a prior discovery read still authorizes process creation.
      const release = await crossProcessLock
        .acquireCrossProcessLock({
          lockPath: path.join(tmp.path, "mcp-config.lock"),
          acquireTimeoutMs: 0,
          staleMs: 5 * 60_000,
          timeoutMessage: "writer blocked by startup",
        })
        .catch((error: unknown) => {
          writerBlocked =
            error instanceof Error && error.message.startsWith("writer blocked by startup");
          return undefined;
        });
      await release?.();
      throw new Error("Startup failed at exec");
    });
    manager.dispose();
    manager = new MCPServerManager(config);
    await manager.getToolsForWorkspace(
      workspaceRequest("global-exec-lock", { runtime: { exec } as unknown as Runtime })
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(writerBlocked).toBe(true);
    expect((await config.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
  });

  async function globalPluginInvocationFixture(
    rootDir: string,
    overrides?: MCPWorkspaceRequestOptions["overrides"],
    tool = testTool(),
    options?: MCPServerManagerOptions
  ) {
    const deps = {
      agentPluginsMcpProvider: () =>
        Promise.resolve(launchablePluginConfig(path.join(rootDir, "data"))),
    };
    const writer = new MCPConfigService(new Config(rootDir), deps);
    const reader = new MCPConfigService(new Config(rootDir), deps);
    expect(await writer.setServerEnabled(PLUGIN_KEY, true)).toEqual({
      success: true,
      data: undefined,
    });
    manager.dispose();
    manager = new MCPServerManager(reader, options);
    const getPrompt = mock(() =>
      Promise.resolve({ messages: [{ role: "user", content: { type: "text", text: "review" } }] })
    );
    servers.serve(PLUGIN_COMMAND, {
      tools: { echo: tool },
      prompts: [{ name: "review" }],
      getPrompt,
    });
    const served = await manager.getToolsForWorkspace(
      workspaceRequest("ws-global-revocation", { overrides })
    );
    const execute = Object.values(served.tools)[0]?.execute;
    if (!execute) throw new Error("Expected a globally enabled plugin tool");
    return {
      writer,
      reader,
      tool,
      getPrompt,
      invoke: (abortSignal?: AbortSignal) =>
        Promise.resolve(
          execute({}, { toolCallId: "held", messages: [], context: {}, abortSignal })
        ),
    };
  }

  test("a sibling backend's global plugin disable revokes an already served tool", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-revocation");
    const f = await globalPluginInvocationFixture(tmp.path);
    await f.invoke();
    expect(f.tool.execute).toHaveBeenCalledTimes(1);

    // The other service publishes no in-process notification to this manager,
    // and there is no new serve to refresh the tool already held by the request.
    expect(await f.writer.setServerEnabled(PLUGIN_KEY, false)).toEqual({
      success: true,
      data: undefined,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(f.invoke()).rejects.toThrow(/disabled|unavailable/);
    expect(f.tool.execute).toHaveBeenCalledTimes(1);
    expect((await f.writer.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
    await f.invoke();
    expect(f.tool.execute).toHaveBeenCalledTimes(2);
  });

  test("explicit workspace consent survives a sibling global plugin disable", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-override-consent");
    const f = await globalPluginInvocationFixture(tmp.path, { enabledServers: [PLUGIN_KEY] });
    expect((await f.writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
    await f.invoke();
    expect(f.tool.execute).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["malformed", "{"],
    ["invalid field", '{ "enabledPluginServers": true }'],
    ["duplicate field", `{"enabledPluginServers":[],"enabledPluginServers":["${PLUGIN_KEY}"]}`],
    ["missing", undefined],
    ["unreadable", null],
  ] as const)("held plugin tools fail closed on %s global consent", async (_name, document) => {
    using tmp = new DisposableTempDir("mcp-plugin-global-invalid-consent");
    const f = await globalPluginInvocationFixture(tmp.path);
    const configPath = path.join(tmp.path, "mcp.jsonc");
    if (document == null) {
      await fs.unlink(configPath);
      if (document === null) await fs.mkdir(configPath);
    } else {
      await fs.writeFile(configPath, document);
    }
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(f.invoke()).rejects.toThrow();
    expect(f.tool.execute).not.toHaveBeenCalled();
    if (document === null) await fs.rmdir(configPath);
    await fs.writeFile(configPath, JSON.stringify({ enabledPluginServers: [PLUGIN_KEY] }));
    await f.invoke();
    expect(f.tool.execute).toHaveBeenCalledTimes(1);
  });

  test("a held plugin invocation waits for the sibling global consent writer", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-consent-writer");
    const f = await globalPluginInvocationFixture(tmp.path);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const list = f.writer.listServers.bind(f.writer);
    const discovery = spyOn(f.writer, "listServers").mockImplementation(async (...args) => {
      entered.resolve();
      await finish.promise;
      return list(...args);
    });
    const disabling = f.writer.setServerEnabled(PLUGIN_KEY, false);
    try {
      // Discovery runs inside the real writer transaction. The tool must not
      // admit using the pre-transaction consent while this writer owns the lock.
      await Promise.race([
        entered.promise,
        disabling.then(() => Promise.reject(new Error("No writer barrier"))),
      ]);
      const invocation = f.invoke();
      invocation.catch(() => undefined);
      finish.resolve();
      expect((await disabling).success).toBe(true);
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(invocation).rejects.toThrow(/disabled/);
      expect(f.tool.execute).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await disabling;
      discovery.mockRestore();
    }
  });

  test("aborting a held plugin invocation cancels its wait for the global consent writer", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-consent-abort");
    const f = await globalPluginInvocationFixture(tmp.path);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const attempted = Promise.withResolvers<void>();
    const list = f.writer.listServers.bind(f.writer);
    const discovery = spyOn(f.writer, "listServers").mockImplementation(async (...args) => {
      entered.resolve();
      await finish.promise;
      return list(...args);
    });
    const acquire = f.reader.acquireGlobalPluginEnablementFence.bind(f.reader);
    const admission = spyOn(f.reader, "acquireGlobalPluginEnablementFence").mockImplementation(
      (...args) => {
        const pending = acquire(...args);
        attempted.resolve();
        return pending;
      }
    );
    const disabling = f.writer.setServerEnabled(PLUGIN_KEY, false);
    const controller = new AbortController();
    try {
      await Promise.race([
        entered.promise,
        disabling.then(() => Promise.reject(new Error("No writer barrier"))),
      ]);
      const invocation = f.invoke(controller.signal);
      invocation.catch(() => undefined);
      await Promise.race([
        attempted.promise,
        invocation.then(() => Promise.reject(new Error("No admission barrier"))),
      ]);
      controller.abort();
      // Rejection must not wait for the writer to release its lock.
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(invocation).rejects.toThrow(/aborted/);
      expect(f.tool.execute).not.toHaveBeenCalled();
      finish.resolve();
      expect((await disabling).success).toBe(true);
      expect((await f.writer.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
      await f.invoke();
      expect(f.tool.execute).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      finish.resolve();
      await disabling;
      admission.mockRestore();
      discovery.mockRestore();
    }
  });

  test("a late global consent acquisition releases after the held invocation is aborted", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-consent-late-acquire");
    const f = await globalPluginInvocationFixture(tmp.path);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const acquire = crossProcessLock.acquireCrossProcessLock;
    const acquisition = spyOn(crossProcessLock, "acquireCrossProcessLock").mockImplementation(
      async (options) => {
        const release = await acquire(options);
        if (options.lockPath !== path.join(tmp.path, "mcp-config.lock")) return release;
        entered.resolve();
        await finish.promise;
        return async () => {
          await release();
          released.resolve();
        };
      }
    );
    const controller = new AbortController();
    const invocation = f.invoke(controller.signal);
    invocation.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        invocation.then(() => Promise.reject(new Error("No acquisition barrier"))),
      ]);
      controller.abort();
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(invocation).rejects.toThrow(/aborted/);
      finish.resolve();
      await released.promise;
      expect(f.tool.execute).not.toHaveBeenCalled();
      expect((await f.writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
    } finally {
      controller.abort();
      finish.resolve();
      await invocation.catch(() => undefined);
      acquisition.mockRestore();
    }
  });

  test("global consent locks release after admission without waiting for tool completion", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-consent-admitted");
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string>();
    const tool = {
      ...testTool(),
      execute: mock(() => {
        entered.resolve();
        return finish.promise;
      }),
    };
    const f = await globalPluginInvocationFixture(tmp.path, undefined, tool);
    const invocation = f.invoke();
    try {
      await Promise.race([
        entered.promise,
        invocation.then(() => Promise.reject(new Error("No invocation barrier"))),
      ]);
      // The disable completes while the already-admitted call is still running.
      expect((await f.writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
      finish.resolve("completed");
      expect(await invocation).toBe("completed");
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
      await expect(f.invoke()).rejects.toThrow(/disabled/);
      expect(tool.execute).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve("cleanup");
      await invocation;
    }
  });

  test.each([false, true])(
    "prompt admission rechecks sibling global consent after refresh (workspace fence: %s)",
    async (workspaceFence) => {
      using tmp = new DisposableTempDir("mcp-plugin-global-prompt-consent");
      const f = await globalPluginInvocationFixture(tmp.path, undefined, undefined, {
        ...(workspaceFence
          ? {
              pluginInvalidation: {
                keyPrefix: "plugin:",
                readToken: () => Promise.resolve("stable"),
                readOverridesEpoch: () => Promise.resolve("stable"),
                readWorkspaceOverrides: () => Promise.resolve({}),
                acquireOverridesLock: () => Promise.resolve(() => Promise.resolve()),
              },
            }
          : {}),
      });
      expect(await manager.getPrompt("ws-global-revocation", PLUGIN_KEY, "review", {})).toEqual({
        text: "review",
      });
      const acquire = f.reader.acquireGlobalPluginEnablementFence.bind(f.reader);
      const admission = spyOn(f.reader, "acquireGlobalPluginEnablementFence").mockImplementation(
        async (...args) => {
          // The prompt refreshed its catalog, but the sibling disables before
          // admission opens the consent document. The catalog is not authority.
          expect((await f.writer.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
          return acquire(...args);
        }
      );
      try {
        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
        await expect(
          manager.getPrompt("ws-global-revocation", PLUGIN_KEY, "review", {})
        ).rejects.toThrow(/disabled/);
        expect(f.getPrompt).toHaveBeenCalledTimes(1);
      } finally {
        admission.mockRestore();
      }
    }
  );

  test("globally enabled plugins remain excluded on remote and devcontainer runtimes", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-off-host");
    await fs.writeFile(
      path.join(tmp.path, "mcp.jsonc"),
      JSON.stringify({ servers: {}, enabledPluginServers: [PLUGIN_KEY] })
    );
    const pluginConfigService = new MCPConfigService(new Config(tmp.path), {
      agentPluginsMcpProvider: () =>
        Promise.resolve(launchablePluginConfig(path.join(tmp.path, "data"))),
    });
    manager.dispose();
    manager = new MCPServerManager(pluginConfigService);

    expect((await pluginConfigService.listServers())[PLUGIN_KEY]?.disabled).toBe(false);
    const runtimes = [
      Object.create(RemoteRuntime.prototype) as Runtime,
      Object.create(DevcontainerRuntime.prototype) as Runtime,
    ];
    for (const [index, runtime] of runtimes.entries()) {
      // Omit the discovery hint so this exercises the runtime's own host-path gate.
      const result = await manager.getToolsForWorkspace(
        workspaceRequest(`ws-plugin-global-off-host-${index}`, { runtime })
      );
      expect(result.stats.enabledServerCount).toBe(0);
      expect(result.stats.startedServerCount).toBe(0);
      expect(result.tools).toEqual({});
    }
  });

  test("global plugin toggles start and retire instances on the next warm-manager serve", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-global-toggle");
    const pluginConfigService = new MCPConfigService(new Config(tmp.path), {
      agentPluginsMcpProvider: () =>
        Promise.resolve(launchablePluginConfig(path.join(tmp.path, "data"))),
    });
    manager.dispose();
    manager = new MCPServerManager(pluginConfigService);
    const close = mock(() => Promise.resolve(undefined));
    servers.serve(PLUGIN_COMMAND, { tools: { echo: testTool() }, close });
    const request = workspaceRequest("ws-plugin-global-toggle");

    const initiallyDisabled = await manager.getToolsForWorkspace(request);
    expect(initiallyDisabled.stats.enabledServerCount).toBe(0);
    expect(initiallyDisabled.tools).toEqual({});
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(0);

    // Changing only the global default must invalidate a warmed startup signature;
    // no workspace overrides or explicit stop/refresh calls should be necessary.
    expect((await pluginConfigService.setServerEnabled(PLUGIN_KEY, true)).success).toBe(true);
    const enabled = await manager.getToolsForWorkspace(request);
    expect(enabled.stats.enabledServerCount).toBe(1);
    expect(enabled.stats.startedServerCount).toBe(1);
    expect(Object.keys(enabled.tools)).toHaveLength(1);
    expect(Object.values(enabled.toolServerNames)).toEqual([PLUGIN_KEY]);
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
    expect(close).not.toHaveBeenCalled();

    const cached = await manager.getToolsForWorkspace(request);
    expect(Object.keys(cached.tools)).toEqual(Object.keys(enabled.tools));
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
    expect(close).not.toHaveBeenCalled();

    expect((await pluginConfigService.setServerEnabled(PLUGIN_KEY, false)).success).toBe(true);
    const disabled = await manager.getToolsForWorkspace(request);
    expect(disabled.stats.enabledServerCount).toBe(0);
    expect(disabled.stats.startedServerCount).toBe(0);
    expect(disabled.tools).toEqual({});
    expect(disabled.toolServerNames).toEqual({});
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("threads the agentPlugins context through to config listing", async () => {
    configService.listServers = mock(() => Promise.resolve({}));

    const context = { projectRoot: "/worktrees/ws-1", projectKey: PROJECT_PATH };
    await manager.getToolsForWorkspace(
      workspaceRequest("ws-plugin-ctx", { agentPlugins: context })
    );
    expect(configService.listServers).toHaveBeenLastCalledWith(PROJECT_PATH, false, {
      agentPlugins: context,
    });

    await manager.listServers(PROJECT_PATH, undefined, true, null);
    expect(configService.listServers).toHaveBeenLastCalledWith(PROJECT_PATH, true, {
      agentPlugins: null,
    });
  });

  test("stdio config signature includes args/env/cwd so plugin mcp.json edits recycle servers", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-signature");
    const env = { PLUGIN_ROOT: "/plugins/demo", PLUGIN_DATA: tmp.path };
    const changedCommand = `${PLUGIN_COMMAND} '--changed'`;
    servers.serve(PLUGIN_COMMAND);
    servers.serve(changedCommand);
    const overrides = { enabledServers: [PLUGIN_KEY] };

    configService.listServers = mock(() => Promise.resolve(pluginStdioConfig({ env })));
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);

    // Same command, changed args: signature must change and servers restart.
    configService.listServers = mock(() =>
      Promise.resolve(pluginStdioConfig({ env, args: ["-y", "some-server", "--changed"] }))
    );
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(servers.connectCount(changedCommand)).toBe(1);

    // Unchanged config: cached instances are reused.
    await manager.getToolsForWorkspace(workspaceRequest("ws-plugin-sig", { overrides }));
    expect(servers.connectCount(changedCommand)).toBe(1);
    expect(servers.connectCount(PLUGIN_COMMAND)).toBe(1);
  });
});

describe("prepareStdioLaunch", () => {
  test("keeps legacy raw shell-string behavior when args is unset", async () => {
    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx -y some-server",
      disabled: false,
    });
    expect(launch).toEqual({ command: "bunx -y some-server" });
  });

  test("argv mode quotes command and each arg against shell injection", async () => {
    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "/plugins/my plugin/bin/tool",
      args: ["a b", "$(rm -rf /)", "`tick`", "it's", ""],
      disabled: false,
    });
    expect(launch.command).toBe(
      "'/plugins/my plugin/bin/tool' 'a b' '$(rm -rf /)' '`tick`' 'it'\"'\"'s' ''"
    );
  });

  test("creates the PLUGIN_DATA directory for plugin servers before launch", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      cwd: tmp.path,
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
    expect(launch.cwd).toBe(tmp.path);
    expect(launch.env?.PLUGIN_DATA).toBe(dataPath);
    // Plugin-root cwd is shipped plugin content: never created by launch.
    expect(await fs.readdir(tmp.path)).toEqual(["plugin-data"]);
  });

  test("creates a nested PLUGIN_DATA cwd recursively before launch", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-nested");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");
    const nestedCwd = path.join(dataPath, "nested", "deep");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      cwd: nestedCwd,
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    // exec() requires an existing cwd; data-dir cwds are client-managed state.
    expect((await fs.stat(nestedCwd)).isDirectory()).toBe(true);
    expect(launch.cwd).toBe(nestedCwd);
  });

  test("quarantines a stray file occupying the PLUGIN_DATA path and still launches", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-corrupt");
    // Corrupt state: plugin-data (the PARENT of every instance dir) is a file.
    const dataRoot = path.join(tmp.path, "plugin-data");
    await fs.writeFile(dataRoot, "not a directory", "utf8");
    const dataPath = path.join(dataRoot, "abc123");

    const launch = await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
    expect(launch.env?.PLUGIN_DATA).toBe(dataPath);
    // The stray file is quarantined (renamed), not deleted.
    const quarantined = (await fs.readdir(tmp.path)).find((name) =>
      name.startsWith("plugin-data.corrupt-")
    );
    expect(quarantined).toBeDefined();
    expect(await fs.readFile(path.join(tmp.path, quarantined!), "utf8")).toBe("not a directory");
  });

  test("quarantines a file occupying the instance data dir itself", async () => {
    using tmp = new DisposableTempDir("mcp-plugin-data-corrupt-leaf");
    const dataPath = path.join(tmp.path, "plugin-data", "abc123");
    await fs.mkdir(path.dirname(dataPath), { recursive: true });
    await fs.writeFile(dataPath, "stale blob", "utf8");

    await prepareStdioLaunch({
      transport: "stdio",
      command: "bunx",
      args: [],
      env: { PLUGIN_ROOT: tmp.path, PLUGIN_DATA: dataPath },
      disabled: false,
      plugin: {
        pluginName: "demo",
        serverName: "srv",
        sourceScope: "global",
        sourceLocation: ".mux/plugins/demo",
      },
    });

    expect((await fs.stat(dataPath)).isDirectory()).toBe(true);
  });

  test("rejects plugin servers without an absolute PLUGIN_DATA env (defensive)", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      prepareStdioLaunch({
        transport: "stdio",
        command: "bunx",
        args: [],
        disabled: false,
        plugin: {
          pluginName: "demo",
          serverName: "srv",
          sourceScope: "global",
          sourceLocation: ".mux/plugins/demo",
        },
      })
    ).rejects.toThrow("PLUGIN_DATA");
  });
});

describe("isClosedClientError", () => {
  for (const message of [
    "Attempted to send a request from a closed client",
    "Connection closed",
    "MCP SSE Transport Error: Connection closed unexpectedly",
    "MCP SSE Transport Error: Not connected",
  ]) {
    test(`returns true for '${message}'`, () => {
      expect(isClosedClientError(new Error(message))).toBe(true);
    });
  }

  test("returns true for chained error with closed-client cause", () => {
    const cause = new Error("Connection closed");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(true);
  });

  test("returns false for chained error without closed-client cause", () => {
    const cause = new Error("ECONNREFUSED");
    const wrapper = new Error("Tool execution failed", { cause });
    expect(isClosedClientError(wrapper)).toBe(false);
  });

  test("returns false for unrelated errors and non-Error values", () => {
    for (const value of [
      new Error("timeout"),
      new Error("ECONNREFUSED"),
      null,
      undefined,
      "string error",
    ]) {
      expect(isClosedClientError(value)).toBe(false);
    }
  });
});

describe("wrapMCPTools", () => {
  for (const [message, expectedOnClosedCalls] of [
    ["Attempted to send a request from a closed client", 1],
    ["some other failure", 0],
  ] as const) {
    test(`calls onClosed ${expectedOnClosedCalls} times for '${message}'`, async () => {
      const onClosed = mock(() => undefined);
      const expectedError = new Error(message);
      const tool = {
        execute: mock(() => Promise.reject(expectedError)),
        parameters: {},
      } as unknown as Tool;

      const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

      let executeError: unknown;
      try {
        await wrapped.myTool.execute!({}, {} as never);
      } catch (error) {
        executeError = error;
      }

      expect(executeError).toBe(expectedError);
      expect(onClosed).toHaveBeenCalledTimes(expectedOnClosedCalls);
    });
  }

  test("wraps multiple tools and failure in one does not affect others", async () => {
    const onClosed = mock(() => undefined);
    const failTool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;
    const okTool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ failTool, okTool }, { onClosed });

    // failTool should throw and trigger onClosed
    try {
      await wrapped.failTool.execute!({}, {} as never);
      throw new Error("Expected failTool to throw");
    } catch (e) {
      expect((e as Error).message).toBe("Attempted to send a request from a closed client");
    }
    expect(onClosed).toHaveBeenCalledTimes(1);

    // okTool should still work fine
    const result: unknown = await wrapped.okTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("onClosed throwing does not mask original error", async () => {
    const onClosed = mock(() => {
      throw new Error("onClosed exploded");
    });
    const closedError = new Error("Attempted to send a request from a closed client");
    const tool = {
      execute: mock(() => Promise.reject(closedError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });
    try {
      await wrapped.myTool.execute!({}, {} as never);
      throw new Error("Expected to throw");
    } catch (e) {
      // Original error should be preserved, NOT the onClosed error
      expect(e).toBe(closedError);
    }
    // onClosed was still called (even though it threw)
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("calls onActivity before execute and still calls it on failure", async () => {
    const onActivity = mock(() => undefined);
    const onClosed = mock(() => undefined);
    const tool = {
      execute: mock(() =>
        Promise.reject(new Error("Attempted to send a request from a closed client"))
      ),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onActivity, onClosed });

    let didThrow = false;
    try {
      await wrapped.myTool.execute!({}, {} as never);
    } catch {
      didThrow = true;
    }

    expect(didThrow).toBe(true);
    expect(onActivity).toHaveBeenCalledTimes(1);
  });

  test("rejects with Interrupted when aborted during execution", async () => {
    const controller = new AbortController();
    const pending = Promise.withResolvers<unknown>();
    const tool = {
      execute: mock(() => pending.promise),
      parameters: {},
    } as unknown as Tool;

    const onClosed = mock(() => undefined);
    const wrapped = wrapMCPTools({ hangTool: tool }, { onClosed });

    const promise = wrapped.hangTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    controller.abort();

    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect((caught as Error).name).toBe("MCPDeadlineError");
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const executeMock = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
    const tool = {
      execute: executeMock,
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const promise = wrapped.myTool.execute!({}, {
      abortSignal: controller.signal,
    } as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(executeMock).not.toHaveBeenCalled();
  });

  test("does NOT call onClosed for upstream error containing 'timed out'", async () => {
    const onClosed = mock(() => undefined);
    const timeoutError = new Error("upstream request timed out");
    const tool = {
      execute: mock(() => Promise.reject(timeoutError)),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool }, { onClosed });

    const promise = wrapped.myTool.execute!({}, {} as never) as Promise<unknown>;
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream request timed out");
    expect(onClosed).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline rejects with MCPDeadlineError after timeout", async () => {
    const { promise } = Promise.withResolvers<unknown>();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(() => promise, {
        toolName: "slowTool",
        timeoutMs: 50,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("timed out");
    expect((caught as Error).message).toContain("slowTool");
    expect((caught as Error).name).toBe("MCPDeadlineError");
  });

  test("runMCPToolWithDeadline skips start when pre-aborted", async () => {
    const startFn = mock(() => Promise.resolve("should not run"));
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await runMCPToolWithDeadline(startFn, {
        toolName: "test",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Interrupted");
    expect(startFn).not.toHaveBeenCalled();
  });

  test("runMCPToolWithDeadline clears timeout when abort wins", async () => {
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout");
    try {
      const { promise } = Promise.withResolvers<unknown>();
      const controller = new AbortController();

      // Start the deadline race with a hung promise, then abort.
      const resultPromise = runMCPToolWithDeadline(() => promise, {
        toolName: "hangingTool",
        timeoutMs: 300_000,
        signal: controller.signal,
      });
      controller.abort();

      let caught: unknown;
      try {
        await resultPromise;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("Interrupted");
      // The timeout timer must be cleared eagerly when abort wins —
      // not left dangling for 5 minutes.
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test("passes through successful execution results", async () => {
    const tool = {
      execute: mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] })),
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ myTool: tool });
    const result: unknown = await wrapped.myTool.execute!({}, {} as never);
    expect(result).toBeTruthy();
  });

  test("skips wrapping tools without execute", () => {
    const tool = {
      parameters: {},
    } as unknown as Tool;

    const wrapped = wrapMCPTools({ noExec: tool });
    expect(wrapped.noExec).toBe(tool);
  });

  describe("argument sanitization", () => {
    const makeExecuteMock = () => mock((_args: unknown) => Promise.resolve({ content: [] }));

    // Mirrors how mcpClient builds MCP tools: jsonSchema() wrapping the
    // server-declared input schema.
    const makeTool = (executeMock: ReturnType<typeof makeExecuteMock>, required: string[] = []) =>
      ({
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            project_id: { type: "string" },
            assignee_id: { type: "string" },
            search: { type: "string" },
            labels: { type: "array" },
            milestone: { type: ["string", "null"] },
          },
          required,
          additionalProperties: false,
        }),
        execute: executeMock,
      }) as unknown as Tool;

    test("strips top-level empty strings for optional params before invoking the server", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock, ["project_id"]) });

      await wrapped.myTool.execute!(
        { project_id: "42332", assignee_id: "", search: "", labels: [], milestone: null },
        {} as never
      );

      expect(executeMock).toHaveBeenCalledTimes(1);
      // A server-declared nullable null and [] pass through; optional "" is dropped.
      expect(executeMock.mock.calls[0][0]).toEqual({
        project_id: "42332",
        labels: [],
        milestone: null,
      });
    });

    test("preserves empty string for schema-required params", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock, ["project_id"]) });

      await wrapped.myTool.execute!({ project_id: "", assignee_id: "" }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ project_id: "" });
    });

    test("passes args through unchanged when nothing needs stripping", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock) });

      const args = { project_id: "42332", search: "bug" };
      await wrapped.myTool.execute!(args, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual(args);
    });

    test("drops null for optional params whose schema does not accept null", async () => {
      // schemaSanitizer widens optional MCP properties to nullable for OpenAI
      // strict mode; the model then sends null for parameters it would have
      // omitted. That null is xum's artifact, so it never reaches the server.
      const executeMock = makeExecuteMock();
      const tool = {
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            title: { type: "string" },
            statusUpdateType: { type: "string", enum: ["onTrack", "atRisk"] },
            assigneeId: { type: ["string", "null"] },
            dueDate: { anyOf: [{ type: "string" }, { type: "null" }] },
            priority: { type: "integer" },
          },
          required: ["title", "priority"],
          additionalProperties: false,
        }),
        execute: executeMock,
      } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!(
        { title: "Fix", statusUpdateType: null, assigneeId: null, dueDate: null, priority: null },
        {} as never
      );

      expect(executeMock.mock.calls[0][0]).toEqual({
        title: "Fix",
        // Server-declared nullable: null passes through ("clear this field").
        assigneeId: null,
        dueDate: null,
        // Required: never dropped, even when null.
        priority: null,
      });
    });

    test("keeps null when the tool has no readable schema or the key is undeclared", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({
        noSchema: { execute: executeMock } as unknown as Tool,
        withSchema: makeTool(executeMock),
      });

      await wrapped.noSchema.execute!({ search: null }, {} as never);
      await wrapped.withSchema.execute!({ undeclared: null }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ search: null });
      expect(executeMock.mock.calls[1][0]).toEqual({ undeclared: null });
    });

    test("strips nested optional nulls and empty strings alongside the schema", async () => {
      const executeMock = makeExecuteMock();
      const tool = {
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            project: {
              type: "object",
              properties: { id: { type: "string" }, slug: { type: "string" } },
              required: ["id"],
            },
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, color: { type: "string" } },
                required: ["name"],
              },
            },
            meta: { type: "object" },
          },
          required: ["project"],
          additionalProperties: false,
        }),
        execute: executeMock,
      } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!(
        {
          project: { id: "", slug: null },
          labels: [
            { name: "bug", color: null },
            { name: "", color: "" },
          ],
          // Declared without properties: values below it are not touched.
          meta: { note: null, tag: "" },
        },
        {} as never
      );

      expect(executeMock.mock.calls[0][0]).toEqual({
        project: { id: "" },
        labels: [{ name: "bug" }, { name: "" }],
        meta: { note: null, tag: "" },
      });
    });

    test("strips empty strings when the tool has no readable schema", async () => {
      const executeMock = makeExecuteMock();
      const tool = { execute: executeMock } as unknown as Tool;
      const wrapped = wrapMCPTools({ myTool: tool });

      await wrapped.myTool.execute!({ project_id: "42332", search: "" }, {} as never);

      expect(executeMock.mock.calls[0][0]).toEqual({ project_id: "42332" });
    });

    test("leaves non-record args untouched", async () => {
      const executeMock = makeExecuteMock();
      const wrapped = wrapMCPTools({ myTool: makeTool(executeMock) });

      await wrapped.myTool.execute!(undefined, {} as never);

      expect(executeMock.mock.calls[0][0]).toBeUndefined();
    });
  });
});
