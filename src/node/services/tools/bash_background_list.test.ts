import { describe, it, expect, afterEach } from "bun:test";
import { createBashBackgroundListTool } from "./bash_background_list";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { BashBackgroundListResult } from "@/common/types/tools";
import { randomUUID } from "crypto";
import { TestTempDir, createTestToolConfig as createBaseToolConfig } from "./testHelpers";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";

// Unique workspace IDs per run (#7256): spawn records live in the shared
// /tmp/mux-bashes/<workspaceId>, and the loop-test runner runs several test files at once. A fixed
// "test-workspace" let one file's cleanup delete another file's records, as #5591 fixed for
// backgroundProcessManager.test.ts.
const RUN_ID = randomUUID().slice(0, 12);
const TEST_WS = `test-workspace-${RUN_ID}`;
const WS_A = `workspace-a-${RUN_ID}`;
const WS_B = `workspace-b-${RUN_ID}`;
const createTestToolConfig = (
  tempDir: string,
  options?: Parameters<typeof createBaseToolConfig>[1]
): ReturnType<typeof createBaseToolConfig> =>
  createBaseToolConfig(tempDir, { workspaceId: TEST_WS, ...options });

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

// Create test runtime
function createTestRuntime(): Runtime {
  return new LocalRuntime(process.cwd());
}

// Workspace IDs used in tests - need cleanup after each test
const TEST_WORKSPACES = [TEST_WS, WS_A, WS_B];

describe("bash_background_list tool", () => {
  afterEach(async () => {
    // Clean up output directories from /tmp/mux-bashes/ to prevent test pollution
    for (const ws of TEST_WORKSPACES) {
      await fs.rm(`/tmp/mux-bashes/${ws}`, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error when workspaceId not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const manager = new BackgroundProcessManager(tempDir.path);
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;
    delete config.workspaceId; // Explicitly remove workspaceId

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Workspace ID not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return empty list when no processes", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const manager = new BackgroundProcessManager(tempDir.path);
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes).toEqual([]);
    }

    tempDir[Symbol.dispose]();
  });

  it("should list spawned processes with correct fields", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 10", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      const proc = result.processes[0];
      expect(proc.process_id).toBe(spawnResult.processId);
      expect(proc.status).toBe("running");
      expect(proc.script).toBe("sleep 10");
      expect(proc.uptime_ms).toBeGreaterThanOrEqual(0);
      expect(proc.exitCode).toBeUndefined();
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should include display_name in listed processes", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process with display_name
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 10", {
      cwd: process.cwd(),
      displayName: "Dev Server",
    });

    if (!spawnResult.success) {
      throw new Error(`Failed to spawn process: ${spawnResult.error}`);
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      expect(result.processes[0].display_name).toBe("Dev Server");
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should only list processes for the current workspace", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();

    const config = createTestToolConfig(process.cwd(), {
      workspaceId: WS_A,
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn processes in different workspaces
    const spawnA = await manager.spawn(runtime, WS_A, "sleep 10", {
      cwd: process.cwd(),
      displayName: "test-a",
    });
    const spawnB = await manager.spawn(runtime, WS_B, "sleep 10", {
      cwd: process.cwd(),
      displayName: "test-b",
    });

    if (!spawnA.success || !spawnB.success) {
      throw new Error("Failed to spawn processes");
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      expect(result.processes[0].process_id).toBe(spawnA.processId);
    }

    // Cleanup
    await manager.cleanup(WS_A);
    await manager.cleanup(WS_B);
    tempDir[Symbol.dispose]();
  });
});
