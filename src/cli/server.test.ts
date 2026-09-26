/**
 * Integration tests for the oRPC server endpoints (HTTP and WebSocket).
 *
 * These tests verify that:
 * 1. HTTP endpoint (/orpc) handles RPC calls correctly
 * 2. WebSocket endpoint (/orpc/ws) handles RPC calls correctly
 * 3. Streaming (eventIterator) works over both transports
 *
 * Uses bun:test for proper module isolation.
 * Tests the actual createOrpcServer function from orpcServer.ts.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { WebSocket } from "ws";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import { createORPCClient } from "@orpc/client";
import type { BrowserWindow, WebContents } from "electron";

import { type AppRouter } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";
import { createConfigStores } from "@/node/config";
import { ServiceContainer } from "@/node/services/serviceContainer";
import type { RouterClient } from "@orpc/server";
import { createOrpcServer, type OrpcServer } from "@/node/orpc/server";
import type { ProjectConfig } from "@/common/types/project";
import { shouldExposeLaunchProject } from "@/cli/launchProject";

// --- Test Server Factory ---

interface TestServerHandle {
  server: OrpcServer;
  tempDir: string;
  close: () => Promise<void>;
}

/**
 * Create a test server using the actual createOrpcServer function.
 * Sets up services and config in a temp directory.
 */
async function createTestServer(): Promise<TestServerHandle> {
  // Create temp dir for config
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-server-test-"));
  const stores = createConfigStores(tempDir);

  // Mock BrowserWindow
  const mockWindow: BrowserWindow = {
    isDestroyed: () => false,
    setTitle: () => undefined,
    webContents: {
      send: () => undefined,
      openDevTools: () => undefined,
    } as unknown as WebContents,
  } as unknown as BrowserWindow;

  // Initialize services
  const services = new ServiceContainer(stores);
  await services.initialize();
  services.windowService.setMainWindow(mockWindow);

  // Build context
  const context: ORPCContext = services.toORPCContext();

  // Use the actual createOrpcServer function
  const server = await createOrpcServer({
    context,
    // port 0 = random available port
    onOrpcError: () => undefined, // Silence errors in tests
  });

  return {
    server,
    tempDir,
    close: async () => {
      await server.close();
      // Closing HTTP leaves service fibers and intervals alive; stop them before deleting config.
      await services.dispose();
      await services.shutdown();
      // Cleanup temp directory
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

// --- HTTP Client Factory ---

function createHttpClient(baseUrl: string): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    origin: baseUrl,
    url: "/orpc",
  });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
  return createORPCClient(link) as RouterClient<AppRouter>;
}

// --- WebSocket Client Factory ---

interface WebSocketClientHandle {
  client: RouterClient<AppRouter>;
  close: () => void;
}

async function createWebSocketClient(wsUrl: string): Promise<WebSocketClientHandle> {
  const ws = new WebSocket(wsUrl);

  // Wait for connection to open
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });

  // oRPC >=1.14 replaced the `websocket` option with a `connect` factory.
  const link = new WebSocketRPCLink({ connect: () => ws as unknown as globalThis.WebSocket });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed for tsgo typecheck
  const client = createORPCClient(link) as RouterClient<AppRouter>;

  return {
    client,
    close: () => ws.close(),
  };
}

function createProjectConfig(projectKind?: ProjectConfig["projectKind"]): ProjectConfig {
  return {
    workspaces: [],
    ...(projectKind === undefined ? {} : { projectKind }),
  };
}

describe("shouldExposeLaunchProject", () => {
  test("returns true when only system projects exist", () => {
    const projects: Array<[string, ProjectConfig]> = [
      ["/system-a", createProjectConfig("system")],
      ["/system-b", createProjectConfig("system")],
    ];

    expect(shouldExposeLaunchProject(projects)).toBe(true);
  });

  test("returns false when a user project already exists", () => {
    const scenarios: Array<{ name: string; projects: Array<[string, ProjectConfig]> }> = [
      {
        name: "legacy projects without projectKind still count as user projects",
        projects: [
          ["/system-a", createProjectConfig("system")],
          ["/legacy-user", createProjectConfig()],
        ],
      },
      {
        name: 'explicit "user" projects count as user projects',
        projects: [
          ["/system-a", createProjectConfig("system")],
          ["/user-project", createProjectConfig("user")],
        ],
      },
    ];

    for (const scenario of scenarios) {
      expect(shouldExposeLaunchProject(scenario.projects)).toBe(false);
    }
  });

  test("returns true when re-adding an existing project into a system-only seed", () => {
    const targetPath = "/existing-system-project";
    const projects: Array<[string, ProjectConfig]> = [
      [targetPath, createProjectConfig("system")],
      ["/system-b", createProjectConfig("system")],
    ];

    expect(shouldExposeLaunchProject(projects)).toBe(true);
  });
});

// --- Tests ---

describe("oRPC Server Endpoints", () => {
  let serverHandle: TestServerHandle;

  beforeAll(async () => {
    serverHandle = await createTestServer();
  });

  afterAll(async () => {
    await serverHandle.close();
  });

  describe("Health and Version endpoints", () => {
    test("GET /health returns ok status", async () => {
      const response = await fetch(`${serverHandle.server.baseUrl}/health`);
      expect(response.ok).toBe(true);
      const data = (await response.json()) as { status: string };
      expect(data).toEqual({ status: "ok" });
    });

    test("GET /version returns version info with server mode", async () => {
      const response = await fetch(`${serverHandle.server.baseUrl}/version`);
      expect(response.ok).toBe(true);
      const data = (await response.json()) as {
        mode: string;
        git_commit: string;
        git_describe: string;
      };
      expect(data.mode).toBe("server");
      // VERSION object should have these fields (from src/version.ts)
      expect(typeof data.git_commit).toBe("string");
      expect(typeof data.git_describe).toBe("string");
    });
  });

  describe("HTTP endpoint (/orpc)", () => {
    test("agentSkills.list and agentSkills.get work with projectPath", async () => {
      const client = createHttpClient(serverHandle.server.baseUrl);

      const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skills-project-"));
      const skillName = `test-skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        const skillDir = path.join(projectPath, ".mux", "skills", skillName);
        await fs.mkdir(skillDir, { recursive: true });

        const skillContent = `---\nname: ${skillName}\ndescription: Test skill\n---\n\nTest body\n`;
        await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");

        const descriptors = await client.agentSkills.list({ projectPath });
        expect(descriptors.some((d) => d.name === skillName && d.scope === "project")).toBe(true);

        const pkg = await client.agentSkills.get({ projectPath, skillName });
        expect(pkg.frontmatter.name).toBe(skillName);
        expect(pkg.scope).toBe("project");
        expect(pkg.body).toContain("Test body");
      } finally {
        await fs.rm(projectPath, { recursive: true, force: true });
      }
    });
  });

  // Every transport must carry unary calls and event-iterator subscriptions the same way.
  // The subscription is the real log feed the Output tab uses: its snapshot proves the
  // subscription is live, and clearing logs must arrive as a reset for the next epoch.
  const transports: Array<{
    name: string;
    connect: () => Promise<{ client: RouterClient<AppRouter>; close: () => void }>;
  }> = [
    {
      name: "HTTP (/orpc)",
      connect: () =>
        Promise.resolve({
          client: createHttpClient(serverHandle.server.baseUrl),
          close: () => undefined,
        }),
    },
    {
      name: "WebSocket (/orpc/ws)",
      connect: () => createWebSocketClient(serverHandle.server.wsUrl),
    },
  ];

  describe.each(transports)("$name", ({ connect }) => {
    test("sequential unary calls on one client round-trip their input", async () => {
      const { client, close } = await connect();
      try {
        expect(await client.general.ping("hello 🎉 world!")).toBe("Pong: hello 🎉 world!");
        expect(await client.general.ping("")).toBe("Pong: ");
      } finally {
        close();
      }
    });

    test("subscriptions stream live events until aborted", async () => {
      const { client, close } = await connect();
      const controller = new AbortController();
      try {
        const stream = await client.general.subscribeLogs(
          { level: "debug" },
          { signal: controller.signal }
        );
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        if (first.done || first.value.type !== "snapshot") {
          throw new Error(`expected a snapshot first, got ${JSON.stringify(first.value)}`);
        }

        expect((await client.general.clearLogs()).success).toBe(true);
        let next = await iterator.next();
        // Entries logged by the server between snapshot and clear may arrive first.
        while (!next.done && next.value.type === "append") next = await iterator.next();
        expect(next.value).toEqual({ type: "reset", epoch: first.value.epoch + 1 });

        controller.abort();
        await iterator.return?.();
      } finally {
        controller.abort();
        close();
      }
    });
  });
});
