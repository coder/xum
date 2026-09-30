import { describe, it, expect, afterEach } from "bun:test";
import { createBashBackgroundTerminateTool } from "./bash_background_terminate";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type {
  BashBackgroundTerminateArgs,
  BashBackgroundTerminateResult,
} from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";

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
const TEST_WORKSPACES = ["test-workspace", "workspace-a", "workspace-b"];

describe("bash_background_terminate tool", () => {
  afterEach(async () => {
    // Clean up output directories from /tmp/mux-bashes/ to prevent test pollution
    for (const ws of TEST_WORKSPACES) {
      await fs.rm(`/tmp/mux-bashes/${ws}`, { recursive: true, force: true }).catch(() => undefined);
    }
  });
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: "bg-test",
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const manager = new BackgroundProcessManager(tempDir.path);
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: "bg-nonexistent",
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
  });

  it("should terminate a running process", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a long-running process
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 10", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain(spawnResult.processId);
    }

    // Verify process is no longer running
    const bgProcess = await manager.getProcess(spawnResult.processId);
    expect(bgProcess?.status).not.toBe("running");

    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should be idempotent (double-terminate succeeds)", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 10", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    // First termination
    const result1 = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;
    expect(result1.success).toBe(true);

    // Second termination
    const result2 = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;
    expect(result2.success).toBe(true);

    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should not terminate processes from other workspaces", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const manager = new BackgroundProcessManager(tempDir.path);
    const runtime = createTestRuntime();

    // Config is for workspace-a
    const config = createTestToolConfig(process.cwd(), {
      workspaceId: "workspace-a",
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in workspace-b
    const spawnResult = await manager.spawn(runtime, "workspace-b", "sleep 10", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Try to terminate from workspace-a (should fail)
    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    // Process should still be running
    const proc = await manager.getProcess(spawnResult.processId);
    expect(proc?.status).toBe("running");

    // Cleanup
    await manager.cleanup("workspace-b");
    tempDir[Symbol.dispose]();
  });
});
