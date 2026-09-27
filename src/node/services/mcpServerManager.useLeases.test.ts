import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Config } from "@/node/config";
import type { MCPConfigService } from "@/node/services/mcpConfigService";
import { MCPServerManager } from "@/node/services/mcpServerManager";
import { FakeMcpServers } from "@/node/services/mcpServerManager.testHarness";
import { DisposableTempDir } from "@/node/services/tempDir";
import { workspaceUseLeasesFor } from "@/node/services/workspaceUseLeases";

// #4857: a stdio MCP server runs in the workspace's checkout for as long as its process lives
// (lazy start, idle eviction after about ten minutes). Another backend on the same Xum root must
// see it, so its rename or removal refuses instead of moving the checkout under the server.

const workspaceId = "ws-mcp-lease";
const command = "node server.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("MCPServerManager workspace use leases", () => {
  const servers = new FakeMcpServers();
  let tmp: DisposableTempDir;
  let config: Config;
  let otherBackend: Config;
  let manager: MCPServerManager;

  beforeEach(() => {
    tmp = new DisposableTempDir("mcp-use-lease");
    config = new Config(tmp.path);
    otherBackend = new Config(tmp.path);
    const configService = {
      listServers: mock(() =>
        Promise.resolve({ srv: { transport: "stdio" as const, command, disabled: false } })
      ),
      acquireGlobalPluginEnablementFence: () => Promise.resolve(() => Promise.resolve()),
      configGeneration: 0,
    };
    manager = new MCPServerManager(configService as unknown as MCPConfigService, { config });
  });

  afterEach(() => {
    servers.reset();
    manager.dispose();
    tmp[Symbol.dispose]();
  });

  const heldCount = () => workspaceUseLeasesFor(config).heldCount(workspaceId, "mcp");

  const start = () =>
    manager.getToolsForWorkspace({
      workspaceId,
      projectPath: tmp.path,
      runtime: servers.runtime,
      workspacePath: tmp.path,
    });

  /** The other backend's structural mutation gate over the workspace. */
  async function otherBackendMutation(): Promise<string> {
    try {
      const release = await workspaceUseLeasesFor(otherBackend).acquireMutationGate([workspaceId], {
        hasRunningBackgroundProcesses: () => Promise.resolve(false),
      });
      await release();
      return "allowed";
    } catch (error) {
      return String(error);
    }
  }

  test("a running server refuses the other backend's mutation until its process exits", async () => {
    servers.serve(command);
    const started = await start();
    expect(started.stats.startedServerCount).toBe(1);
    expect(heldCount()).toBe(1);
    const refused = await otherBackendMutation();
    expect(refused).toContain("in use by another Xum process");
    expect(refused).toContain("mcp");

    await manager.stopServers(workspaceId);
    await waitFor(() => heldCount() === 0);
    expect(await otherBackendMutation()).toBe("allowed");
  });

  test("a server whose process exits on its own releases its lease", async () => {
    servers.serve(command);
    await start();
    expect(heldCount()).toBe(1);

    await servers.crash(command);
    await waitFor(() => heldCount() === 0);
  });

  test("a failed startup releases its lease", async () => {
    servers.serve(command, { connect: () => Promise.reject(new Error("handshake failed")) });
    const started = await start();
    expect(started.stats.failedServerNames).toEqual(["srv"]);

    await waitFor(() => heldCount() === 0);
    expect(await otherBackendMutation()).toBe("allowed");
  });

  test("a startup abandoned at its deadline releases its lease", async () => {
    servers.serve(command, { hang: true });
    const started = await servers.expireStartupDeadline(() => start());
    expect(started.stats.failedServerNames).toEqual(["srv"]);

    await waitFor(() => heldCount() === 0);
  });

  test("no server starts while the other backend mutates the workspace", async () => {
    servers.serve(command);
    const release = await workspaceUseLeasesFor(otherBackend).acquireMutationGate([workspaceId], {
      hasRunningBackgroundProcesses: () => Promise.resolve(false),
    });
    try {
      const started = await start();
      expect(started.stats.failedServerNames).toEqual(["srv"]);
      expect(servers.exec).not.toHaveBeenCalled();
      expect(heldCount()).toBe(0);
    } finally {
      await release();
    }
  });
});
