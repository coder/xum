/**
 * Integration tests for code_execution tool with real tools
 *
 * These tests prove the full end-to-end flow: code_execution -> QuickJS sandbox -> real tools -> real filesystem.
 * Unlike unit tests, these use real LocalRuntime and actual file operations.
 *
 * Run with: bun test src/node/services/tools/code_execution.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createCodeExecutionTool } from "./code_execution";
import { createFileReadTool } from "./file_read";
import { createBashTool } from "./bash";
import { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import { ToolBridge } from "@/node/services/ptc/toolBridge";
import type { Tool, ToolExecutionOptions } from "ai";
import type { PTCEvent, PTCExecutionResult, PTCToolCallEndEvent } from "@/node/services/ptc/types";
import { createTestToolConfig, TestTempDir, getTestDeps } from "./testHelpers";
import { z } from "zod";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "integration-test-call",
  messages: [],
  context: undefined,
};

describe("code_execution integration tests", () => {
  const runtimeFactory = new QuickJSRuntimeFactory();
  let testDir: string;
  let toolConfig: ReturnType<typeof createTestToolConfig>;

  beforeEach(async () => {
    // Create a temp directory for each test
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ptc-integration-"));
    toolConfig = createTestToolConfig(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("file_read through sandbox", () => {
    it(
      "reads a real file via mux.file_read()",
      async () => {
        // Create a real file
        const testContent = "hello from integration test\nline two\nline three";
        await fs.writeFile(path.join(testDir, "test.txt"), testContent);

        // Create real file_read tool
        const fileReadTool = createFileReadTool(toolConfig);
        const tools: Record<string, Tool> = { file_read: fileReadTool };

        // Track events
        const events: PTCEvent[] = [];
        const codeExecutionTool = await createCodeExecutionTool(
          runtimeFactory,
          new ToolBridge(tools),
          (e) => events.push(e)
        );

        // Execute code that reads the file
        const code = `
        const result = mux.file_read({ path: "test.txt" });
        return result;
      `;

        const result = (await codeExecutionTool.execute!(
          { code },
          mockToolCallOptions
        )) as PTCExecutionResult;

        // Verify the result contains the file content
        expect(result).toBeDefined();
        expect(result.success).toBe(true);

        // The result should be the file_read response
        const fileReadResult = result.result as {
          success: boolean;
          content?: string;
          lines_read?: number;
        };
        expect(fileReadResult.success).toBe(true);
        expect(fileReadResult.content).toContain("hello from integration test");
        expect(fileReadResult.lines_read).toBe(3);

        // Verify tool call event was emitted
        const toolCallEndEvents = events.filter(
          (e): e is PTCToolCallEndEvent => e.type === "tool-call-end"
        );
        expect(toolCallEndEvents.length).toBe(1);
        expect(toolCallEndEvents[0].toolName).toBe("file_read");
        expect(toolCallEndEvents[0].error).toBeUndefined();
      },
      { timeout: 20_000 }
    );

    it(
      "handles file not found gracefully",
      async () => {
        const fileReadTool = createFileReadTool(toolConfig);
        const tools: Record<string, Tool> = { file_read: fileReadTool };

        const codeExecutionTool = await createCodeExecutionTool(
          runtimeFactory,
          new ToolBridge(tools)
        );

        const code = `
        const result = mux.file_read({ path: "nonexistent.txt" });
        return result;
      `;

        const result = (await codeExecutionTool.execute!(
          { code },
          mockToolCallOptions
        )) as PTCExecutionResult;

        expect(result.success).toBe(true);

        // file_read returns success: false for missing files, not an exception
        const fileReadResult = result.result as { success: boolean; error?: string };
        expect(fileReadResult.success).toBe(false);
        // Error contains ENOENT or stat failure message
        expect(fileReadResult.error).toMatch(/ENOENT|stat/i);
      },
      { timeout: 20_000 }
    );
  });

  describe("bash through sandbox", () => {
    it("executes a real bash command via mux.bash()", async () => {
      // Create real bash tool
      const tempDir = new TestTempDir("ptc-bash-integration");
      const bashConfig = {
        ...toolConfig,
        ...getTestDeps(),
        runtimeTempDir: tempDir.path,
      };
      const bashTool = createBashTool(bashConfig);
      const tools: Record<string, Tool> = { bash: bashTool };

      const events: PTCEvent[] = [];
      const codeExecutionTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        (e) => events.push(e)
      );

      // Execute a simple echo command
      const code = `
        const result = mux.bash({
          script: "echo 'hello from sandbox'",
          timeout_secs: 5,
          run_in_background: false,
          display_name: "test echo"
        });
        return result;
      `;

      const result = (await codeExecutionTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);

      const bashResult = result.result as { success: boolean; output?: string };
      expect(bashResult.success).toBe(true);
      expect(bashResult.output).toContain("hello from sandbox");

      // Verify event
      const toolCallEndEvents = events.filter(
        (e): e is PTCToolCallEndEvent => e.type === "tool-call-end"
      );
      expect(toolCallEndEvents.length).toBe(1);
      expect(toolCallEndEvents[0].toolName).toBe("bash");

      tempDir[Symbol.dispose]();
    });

    it("creates a file via bash and reads it via file_read", async () => {
      // This test proves multiple tools can work together in a single sandbox execution
      const tempDir = new TestTempDir("ptc-multi-tool-integration");
      const bashConfig = {
        ...toolConfig,
        ...getTestDeps(),
        runtimeTempDir: tempDir.path,
      };

      const bashTool = createBashTool(bashConfig);
      const fileReadTool = createFileReadTool(toolConfig);
      const tools: Record<string, Tool> = {
        bash: bashTool,
        file_read: fileReadTool,
      };

      const events: PTCEvent[] = [];
      const codeExecutionTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        (e) => events.push(e)
      );

      // Code that creates a file with bash, then reads it with file_read
      const code = `
        // Create a file using bash
        const bashResult = mux.bash({
          script: "echo 'created by sandbox' > sandbox_created.txt",
          timeout_secs: 5,
          run_in_background: false,
          display_name: "create file"
        });
        
        if (!bashResult.success) {
          return { error: "bash failed", bashResult };
        }
        
        // Read the file we just created
        const readResult = mux.file_read({ path: "sandbox_created.txt" });
        
        return {
          bashResult,
          readResult,
          fileWasCreated: readResult.success && readResult.content.includes("created by sandbox")
        };
      `;

      const result = (await codeExecutionTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);

      const combinedResult = result.result as {
        bashResult: { success: boolean };
        readResult: { success: boolean; content?: string };
        fileWasCreated: boolean;
      };
      expect(combinedResult.bashResult.success).toBe(true);
      expect(combinedResult.readResult.success).toBe(true);
      expect(combinedResult.fileWasCreated).toBe(true);

      // Verify both tool calls were recorded
      const toolCallEndEvents = events.filter(
        (e): e is PTCToolCallEndEvent => e.type === "tool-call-end"
      );
      expect(toolCallEndEvents.length).toBe(2);
      expect(toolCallEndEvents.map((e) => e.toolName).sort()).toEqual(["bash", "file_read"]);

      // Verify file actually exists on disk
      const fileExists = await fs
        .access(path.join(testDir, "sandbox_created.txt"))
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);

      tempDir[Symbol.dispose]();
    });
  });

  describe("error handling", () => {
    it("returns validation error for invalid tool arguments", async () => {
      const fileReadTool = createFileReadTool(toolConfig);
      const tools: Record<string, Tool> = { file_read: fileReadTool };

      const codeExecutionTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools)
      );

      // Call file_read without required path argument
      const code = `
        const result = mux.file_read({});
        return result;
      `;

      const result = (await codeExecutionTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;

      // Tool bridge validation throws, which causes sandbox execution to fail
      // The error is propagated to the PTCExecutionResult
      expect(result.success).toBe(false);
      expect(result.error).toContain("path");
    });

    it("handles tool execution exceptions gracefully", async () => {
      // Create a tool that throws
      const throwingTool: Tool = {
        description: "A tool that throws",
        inputSchema: z.object({}),
        execute: () => {
          throw new Error("Intentional test error");
        },
      };

      const tools: Record<string, Tool> = { throwing_tool: throwingTool };

      const events: PTCEvent[] = [];
      const codeExecutionTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        (e) => events.push(e)
      );

      const code = `
        const result = mux.throwing_tool({});
        return result;
      `;

      const result = (await codeExecutionTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;

      // Tool exception causes sandbox execution to fail
      // The error is propagated to the PTCExecutionResult
      expect(result.success).toBe(false);
      expect(result.error).toContain("Intentional test error");

      // Event should record failure
      const toolCallEndEvents = events.filter(
        (e): e is PTCToolCallEndEvent => e.type === "tool-call-end"
      );
      expect(toolCallEndEvents.length).toBe(1);
      expect(toolCallEndEvents[0].error).toContain("Intentional test error");
    });
  });

  describe("console logging", () => {
    it("captures console.log from sandbox code", async () => {
      const fileReadTool = createFileReadTool(toolConfig);
      const tools: Record<string, Tool> = { file_read: fileReadTool };

      const events: PTCEvent[] = [];
      const codeExecutionTool = await createCodeExecutionTool(
        runtimeFactory,
        new ToolBridge(tools),
        (e) => events.push(e)
      );

      const code = `
        console.log("debug message from sandbox");
        console.warn("warning message");
        console.error("error message");
        return "done";
      `;

      const result = (await codeExecutionTool.execute!(
        { code },
        mockToolCallOptions
      )) as PTCExecutionResult;

      expect(result.success).toBe(true);

      // Verify console events
      const consoleEvents = events.filter((e) => e.type === "console");
      expect(consoleEvents.length).toBe(3);
      expect(consoleEvents.map((e) => (e as { level: string }).level)).toEqual([
        "log",
        "warn",
        "error",
      ]);
    });
  });
});
