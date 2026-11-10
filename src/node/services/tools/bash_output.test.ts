import * as fs from "fs";
import * as path from "path";

import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { createBashOutputTool } from "./bash_output";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { waitForCondition } from "@/node/services/testDispatchHelpers";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { BashOutputToolResult } from "@/common/types/tools";
import { randomUUID } from "crypto";
import {
  TestTempDir,
  createTestToolConfig as createBaseToolConfig,
  readExitCodeWhenWritten,
} from "./testHelpers";
import type { ToolExecutionOptions } from "ai";

// Unique workspace IDs per run (#7256): spawn records live in the shared
// /tmp/mux-bashes/<workspaceId>, and the loop-test runner runs several test files at once. A fixed
// "test-workspace" let one file's cleanup delete another file's records, as #5591 fixed for
// backgroundProcessManager.test.ts.
const RUN_ID = randomUUID().slice(0, 12);

// These tests spawn real shell processes, and every spawn, read and stop runs shell commands. They
// take seconds on an idle machine, and CPU contention (a loaded CI runner or developer host)
// stretches that past Bun's 5 s default for tests that are not broken.
setDefaultTimeout(30_000);
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

describe("bash_output tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error when workspaceId not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;
    delete config.workspaceId;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Workspace ID not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return incremental output from process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs incrementally: line2 waits for a gate file, so no read can
    // see it early or miss it because the host was slow.
    const gate = path.join(tempDir.path, "line2-gate");
    const spawnResult = await manager.spawn(
      runtime,
      TEST_WS,
      `echo 'line1'; while [ ! -e ${shellQuote(gate)} ]; do sleep 0.02; done; echo 'line2'`,
      { cwd: process.cwd(), displayName: "test" }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // The process waits for the gate, so a failure before the gate opens must still stop it.
    try {
      // Wait for the first output to reach the log
      const outputPath = path.join(spawnResult.outputDir, "output.log");
      await waitForCondition(
        async () =>
          (await fs.promises.readFile(outputPath, "utf-8").catch(() => "")).includes("line1"),
        { timeoutMs: 20_000, intervalMs: 25 }
      );

      // First call - should get some output
      const result1 = (await tool.execute!(
        { process_id: spawnResult.processId, timeout_secs: 0 },
        mockToolCallOptions
      )) as BashOutputToolResult;

      expect(result1.success).toBe(true);
      if (result1.success) {
        expect(result1.output).toContain("line1");
      }

      // Let the process print line2 and exit
      await fs.promises.writeFile(gate, "");
      expect(await readExitCodeWhenWritten(spawnResult.outputDir)).toBe("0");

      // Second call - should ONLY get new output (incremental)
      const result2 = (await tool.execute!(
        { process_id: spawnResult.processId, timeout_secs: 0 },
        mockToolCallOptions
      )) as BashOutputToolResult;

      expect(result2.success).toBe(true);
      if (result2.success) {
        // Should contain line2 but NOT line1 (already read)
        expect(result2.output).toContain("line2");
        expect(result2.output).not.toContain("line1");
      }
    } finally {
      await manager.cleanup(TEST_WS);
      tempDir[Symbol.dispose]();
    }
  }, 60_000);

  it("should filter output with regex", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs multiple lines
    const spawnResult = await manager.spawn(
      runtime,
      TEST_WS,
      "echo 'ERROR: something failed'; echo 'INFO: everything ok'; echo 'ERROR: another error'",
      { cwd: process.cwd(), displayName: "test" }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // The wrapper writes the exit code after the output: wait for it, not a fixed delay.
    expect(await readExitCodeWhenWritten(spawnResult.outputDir)).toBe("0");

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "ERROR", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Should only contain ERROR lines
      expect(result.output).toContain("ERROR");
      expect(result.output).not.toContain("INFO");
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should return error for invalid regex filter", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const spawnResult = await manager.spawn(runtime, TEST_WS, "echo 'test'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((r) => setTimeout(r, 100));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "[invalid(", timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid filter regex");
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should not return output from other workspace's processes", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();

    const config = createTestToolConfig(process.cwd(), {
      workspaceId: WS_A,
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in different workspace
    const spawnResult = await manager.spawn(runtime, WS_B, "echo 'test'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    // Cleanup
    await manager.cleanup(WS_B);
    tempDir[Symbol.dispose]();
  });

  it("should include process status and exit code", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that exits quickly
    const spawnResult = await manager.spawn(runtime, TEST_WS, "echo 'done'", {
      cwd: process.cwd(),
      displayName: "test",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    expect(await readExitCodeWhenWritten(spawnResult.outputDir)).toBe("0");

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(0);
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should block and wait for output when timeout_secs > 0", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Use unique process ID to avoid leftover state from previous runs
    const processId = `delayed-output-${Date.now()}`;
    const signalPath = path.join(tempDir.path, `${processId}.signal`);

    // Spawn a process that blocks until we create a signal file, then outputs.
    // This avoids flakiness from the spawn call itself taking a non-trivial amount of time.
    const spawnResult = await manager.spawn(
      runtime,
      TEST_WS,
      `while [ ! -f "${signalPath}" ]; do sleep 0.1; done; echo 'delayed output'`,
      { cwd: process.cwd(), displayName: processId }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with timeout=3 should wait and return output (waiting for signal file)
    const start = Date.now();
    const resultPromise = tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 3 },
      mockToolCallOptions
    ) as Promise<BashOutputToolResult>;

    // Ensure bash_output is actually waiting before we trigger output.
    await new Promise((r) => setTimeout(r, 300));
    await fs.promises.writeFile(signalPath, "go");

    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("delayed output");
      expect(elapsed).toBeGreaterThan(250);
      expect(elapsed).toBeLessThan(3500);
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should return early when process exits during wait", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Use unique process ID to avoid leftover state from previous runs
    const processId = `quick-exit-${Date.now()}`;

    // Spawn a process that exits quickly
    const spawnResult = await manager.spawn(runtime, TEST_WS, "echo 'quick exit'", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    expect(await readExitCodeWhenWritten(spawnResult.outputDir)).toBe("0");

    const tool = createBashOutputTool(config);

    // Call with long timeout - should return quickly since process already exited
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 10 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("quick exit");
      expect(result.status).toBe("exited");
      // Must not wait out the 10 s timeout. An idle host returns in 100 to 200 ms. A busy host
      // took about a second (cause not traced: getOutput polls every 100 ms), so 500 ms failed.
      expect(elapsed).toBeLessThan(2_000);
    }

    // Cleanup
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  }, 60_000);

  it("should wait full timeout duration when no output and process running", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `long-sleep-${Date.now()}`;

    // Spawn a process that sleeps for a long time with no output
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 30", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with short timeout - should wait full duration then return empty
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 1 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe(""); // No output
      expect(result.status).toBe("running"); // Process still running
      // Should have waited close to 1 second
      expect(elapsed).toBeGreaterThan(900);
      expect(elapsed).toBeLessThan(1500);
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should return immediately with timeout_secs: 0 even when no output", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `no-wait-${Date.now()}`;

    // Spawn a process that sleeps (no immediate output)
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 30", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Call with timeout=0 - should return immediately
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 0 },
      mockToolCallOptions
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("");
      expect(result.status).toBe("running");
      expect(elapsed).toBeLessThan(200); // Should return almost immediately
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should return early with 'interrupted' status when abortSignal is triggered", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `abort-test-${Date.now()}`;

    // Spawn a long-running process with no output
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 60", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);
    const abortController = new AbortController();

    // Abort after 200ms
    setTimeout(() => abortController.abort(), 200);

    // Call with a long timeout - should be interrupted by abort signal. The 10 s wait sits well
    // below the 30 s file limit, so a broken abort fails the status check below, not the limit.
    const start = Date.now();
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 10 },
      { ...mockToolCallOptions, abortSignal: abortController.signal }
    )) as BashOutputToolResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("interrupted");
      expect(result.output).toBe("(waiting interrupted)");
      // Should have returned quickly after abort, not waiting the full 10s
      expect(elapsed).toBeLessThan(1000);
      expect(elapsed).toBeGreaterThan(150); // At least waited until abort
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });

  it("should return early with 'interrupted' status when message is queued", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const processId = `queued-msg-test-${Date.now()}`;

    // Spawn a long-running process with no output
    const spawnResult = await manager.spawn(runtime, TEST_WS, "sleep 60", {
      cwd: process.cwd(),
      displayName: processId,
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Change the live queue decision only after this output wait has sampled it.
    let queued = false;
    const waiting = Promise.withResolvers<void>();
    config.hasQueuedMessages = () => {
      waiting.resolve();
      return queued;
    };

    // Call with a long timeout - should be interrupted by queued message (10 s: see the abort test)
    const start = Date.now();
    const resultPromise = tool.execute!(
      { process_id: spawnResult.processId, timeout_secs: 10 },
      mockToolCallOptions
    ) as Promise<BashOutputToolResult>;
    await waiting.promise;
    queued = true;
    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("interrupted");
      expect(result.output).toBe("(waiting interrupted)");
      // Should have returned quickly after queued message, not waiting the full 10s
      expect(elapsed).toBeLessThan(1000);
    }

    // Cleanup
    await manager.terminate(spawnResult.processId, { monitorDisposition: "discard" });
    await manager.cleanup(TEST_WS);
    tempDir[Symbol.dispose]();
  });
});
