import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { Config } from "@/node/config";
import type { Runtime } from "@/node/runtime/Runtime";
import type { MCPConfigService } from "./mcpConfigService";
import { MCPServerManager, type MCPServerManagerOptions } from "./mcpServerManager";
import {
  captureTaskCheckoutAuthorization,
  isTaskCheckoutAuthorizationCurrent,
  type TaskCheckoutAuthorization,
} from "./taskCheckoutAuthorization";
import { jsonSchema, type Tool } from "ai";

/**
 * The manager's checkout-preparation gate: the caller threads the authorization its deep override
 * read captured; the manager re-checks it SYNCHRONOUSLY against the fresh registry (the wired
 * config-only check — no checkout locks, no filesystem under the writer fences) at every
 * post-await point that hands out enablement: before recording a serve, before the cached
 * return, before starting servers, at the tools postflight, at prompt dispatch and at served-tool
 * dispatch. A request whose fresh check fails — or that captured nothing for a task row — fails
 * closed: no server process starts, no tool leaves.
 */
describe("MCPServerManager checkout-preparation gate", () => {
  let tempDir: string;
  let config: Config;
  let projectPath: string;
  const rootId = "prep-root";
  const sharedId = "prep-shared";
  let rootAuthorization: TaskCheckoutAuthorization;
  let sharedAuthorization: TaskCheckoutAuthorization;
  let manager: MCPServerManager;
  let started: string[];
  let readOverrides: ReturnType<typeof mock>;
  let isCurrent: ReturnType<typeof mock>;
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const TEST_RUNTIME = {} as Runtime;

  /** A cooperating writer archives the shared row's anchor: its authorization is gone. */
  async function archiveRoot(): Promise<void> {
    await config.editConfig((cfg) => {
      for (const project of cfg.projects.values()) {
        const root = project.workspaces.find((w) => w.id === rootId);
        if (root) root.archivedAt = new Date().toISOString();
      }
      return cfg;
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-mcp-prep-manager-"));
    config = new Config(tempDir);
    projectPath = path.join(tempDir, "project");
    await fs.mkdir(projectPath, { recursive: true });
    await config.editConfig((cfg) => {
      cfg.projects.set(projectPath, {
        workspaces: [
          { id: rootId, name: rootId, path: projectPath, runtimeConfig: { type: "local" } },
          {
            id: sharedId,
            name: sharedId,
            path: projectPath,
            runtimeConfig: { type: "local" },
            parentWorkspaceId: rootId,
            taskIsolation: "none",
            taskStatus: "running",
          },
        ],
      });
      return cfg;
    });
    const root = await captureTaskCheckoutAuthorization(config, rootId);
    const shared = await captureTaskCheckoutAuthorization(config, sharedId);
    if (!root.success || !shared.success) throw new Error("fixture rows must capture");
    rootAuthorization = root.data;
    sharedAuthorization = shared.data;
    started = [];
    readOverrides = mock(() => Promise.resolve({}));
    isCurrent = mock(
      (workspaceId: string, captured: TaskCheckoutAuthorization | undefined) =>
        isTaskCheckoutAuthorizationCurrent(config, workspaceId, captured).current
    );
    const configService = {
      listServers: mock(() =>
        Promise.resolve({ echo: { transport: "stdio" as const, command: "echo", disabled: false } })
      ),
      acquireGlobalPluginEnablementFence: () => Promise.resolve(() => Promise.resolve()),
      configGeneration: 0,
    };
    const invalidation: NonNullable<MCPServerManagerOptions["pluginInvalidation"]> = {
      keyPrefix: "plugin:",
      readToken: () => Promise.resolve(undefined),
      readWorkspaceOverrides: readOverrides,
      isPreparationAuthorizationCurrent: isCurrent,
    };
    manager = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: invalidation,
    });
    (manager as unknown as { startSingleServer: unknown }).startSingleServer = mock(
      (name: unknown) => {
        started.push(String(name));
        const echo: Tool = {
          description: "echo",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute: mock(() => Promise.resolve({ ok: true })),
        } as unknown as Tool;
        return Promise.resolve({
          name: String(name),
          resolvedTransport: "stdio" as const,
          autoFallbackUsed: false,
          tools: { echo },
          prompts: [{ name: "review" }],
          refreshPrompts: mock(() => Promise.resolve([{ name: "review" }])),
          getPrompt: mock(() =>
            Promise.resolve({
              messages: [{ role: "user", content: { type: "text", text: "review" } }],
            })
          ),
          isClosed: false,
          close: mock(() => Promise.resolve(undefined)),
        });
      }
    );
  });

  afterEach(async () => {
    manager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function request(options: Record<string, unknown> = {}) {
    return {
      workspaceId: sharedId,
      projectPath,
      runtime: TEST_RUNTIME,
      workspacePath: projectPath,
      trusted: true,
      overrides: {},
      preparation: sharedAuthorization,
      ...options,
    };
  }

  test("a request whose captured authorization matches the fresh registry is served", async () => {
    const result = await manager.getToolsForWorkspace(request());
    expect(Object.keys(result.tools)).toHaveLength(1);
    expect(started).toEqual(["echo"]);
    expect(isCurrent).toHaveBeenCalled();
  });

  test("a task-row request without a captured authorization fails closed (nothing captured is not an allow)", async () => {
    const result = await manager.getToolsForWorkspace(request({ preparation: undefined }));
    expect(result.tools).toEqual({});
    expect(result.overridesUsed).toBeUndefined();
    expect(started).toEqual([]);
  });

  test.each(["stale", "unreadable"] as const)(
    "a fresh check that no longer derives the captured authorization (%s) fails the serve closed before any server starts",
    async (kind) => {
      if (kind === "stale") await archiveRoot();
      else {
        isCurrent.mockImplementation(() => {
          throw new Error("registry unreadable");
        });
      }
      const result = await manager.getToolsForWorkspace(request());
      expect(result.tools).toEqual({});
      expect(result.overridesUsed).toBeUndefined();
      expect(started).toEqual([]);
    }
  );

  test("an authorization change landing during the serve's own disk re-read is caught before recording or starting", async () => {
    // Distrusted caller: the manager re-reads the overrides from disk (an await) and must
    // re-check the authorization AFTER that await, before the recorded options and server starts.
    readOverrides.mockImplementation(async () => {
      await archiveRoot();
      return {};
    });
    const result = await manager.getToolsForWorkspace(
      request({ overridesAuthoritative: false, overrides: undefined })
    );
    expect(result.tools).toEqual({});
    expect(started).toEqual([]);
  });

  test("a cached entry is not returned, and its served tools and prompts are refused, once the fresh check fails", async () => {
    const first = await manager.getToolsForWorkspace(request());
    expect(started).toEqual(["echo"]);
    const toolName = Object.keys(first.tools)[0];
    // Baseline: the served tool dispatches while the authorization holds.
    await first.tools[toolName].execute!({}, { toolCallId: "ok", messages: [], context: {} });
    await archiveRoot();
    const second = await manager.getToolsForWorkspace(request());
    expect(second.tools).toEqual({});
    expect(started).toEqual(["echo"]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      first.tools[toolName].execute!({}, { toolCallId: "stale", messages: [], context: {} })
    ).rejects.toThrow();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(manager.getPrompt(sharedId, "echo", "review", {})).rejects.toThrow();
  });

  test("a proof change landing after the launch fence's final epoch read (under the writer's lock) refuses the spawn: no process starts", async () => {
    // Real start chain (no startSingleServer mock): serve → startServers (semaphore) →
    // startStdioInstance → launchUnderOverrideFence (writer's lock → fenced epoch read → plugin
    // admission → exec). The cooperating writer edits the registry INSIDE that fenced epoch read,
    // i.e. after every earlier preparation check ran; the launch boundary must still refuse.
    const execs: string[] = [];
    const runtime = {
      exec: mock((command: string) => {
        execs.push(command);
        return Promise.reject(new Error("a repository-configured command must not execute"));
      }),
    } as unknown as Runtime;
    let writerLockHeld = false;
    const readOverridesEpoch = mock(async () => {
      if (writerLockHeld) await archiveRoot();
      return "epoch-1";
    });
    const acquireOverridesLock = mock(() => {
      writerLockHeld = true;
      return Promise.resolve(() => {
        writerLockHeld = false;
        return Promise.resolve();
      });
    });
    const configService = {
      listServers: mock(() =>
        Promise.resolve({ echo: { transport: "stdio" as const, command: "echo", disabled: false } })
      ),
      acquireGlobalPluginEnablementFence: () => Promise.resolve(() => Promise.resolve()),
      configGeneration: 0,
    };
    const fenced = new MCPServerManager(configService as unknown as MCPConfigService, {
      pluginInvalidation: {
        keyPrefix: "plugin:",
        readToken: () => Promise.resolve("token-1"),
        readWorkspaceOverrides: readOverrides,
        readOverridesEpoch,
        acquireOverridesLock,
        isPreparationAuthorizationCurrent: isCurrent,
      },
    });
    try {
      const result = await fenced.getToolsForWorkspace(request({ runtime }));
      // The writer's lock was taken and the fenced epoch read ran (the edit landed there)…
      expect(acquireOverridesLock).toHaveBeenCalled();
      expect(writerLockHeld).toBe(false);
      // …and nothing was spawned: the launch boundary re-derived the authority and refused.
      expect(execs).toEqual([]);
      expect(result.tools).toEqual({});
    } finally {
      fenced.dispose();
    }
  });

  test("a root workspace serves under its exemption, captured or re-proven fresh", async () => {
    const captured = await manager.getToolsForWorkspace(
      request({ workspaceId: rootId, preparation: rootAuthorization })
    );
    expect(Object.keys(captured.tools)).toHaveLength(1);
    manager.dispose();
    started.length = 0;
    // A root request that captured nothing still passes: the fresh registry proves the exemption.
    const reproven = await manager.getToolsForWorkspace(
      request({ workspaceId: `${rootId}`, preparation: undefined })
    );
    expect(Object.keys(reproven.tools)).toHaveLength(1);
  });
});
