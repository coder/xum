import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createFileEditReplaceStringTool } from "./file_edit_replace_string";
import type {
  FileEditReplaceStringToolArgs,
  FileEditReplaceStringToolResult,
} from "@/common/types/tools";
import type { ToolExecutionOptions } from "ai";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getTestDeps } from "./testHelpers";

// Mock ToolCallOptions for testing
const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

// Test helpers
const setupFile = async (filePath: string, content: string): Promise<void> => {
  await fs.writeFile(filePath, content);
};

const readFile = async (filePath: string): Promise<string> => {
  return await fs.readFile(filePath, "utf-8");
};

const executeStringReplace = async (
  tool: ReturnType<typeof createFileEditReplaceStringTool>,
  args: FileEditReplaceStringToolArgs
): Promise<FileEditReplaceStringToolResult> => {
  return (await tool.execute!(args, mockToolCallOptions)) as FileEditReplaceStringToolResult;
};

describe("file_edit_replace_string tool", () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "fileEditReplace-test-"));
    testFilePath = path.join(testDir, "test.txt");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should apply a single edit successfully", async () => {
    await setupFile(testFilePath, "Hello world\nThis is a test\nGoodbye world");
    const tool = createFileEditReplaceStringTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
    });

    const payload: FileEditReplaceStringToolArgs = {
      path: "test.txt", // Use relative path
      old_string: "Hello world",
      new_string: "Hello universe",
    };

    const result = await executeStringReplace(tool, payload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.edits_applied).toBe(1);
    }

    expect(await readFile(testFilePath)).toBe("Hello universe\nThis is a test\nGoodbye world");
  });

  it("matches LF args against a CRLF file and preserves CRLF", async () => {
    await setupFile(testFilePath, "Hello world\r\nThis is a test\r\nGoodbye world\r\n");
    const tool = createFileEditReplaceStringTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
    });

    const payload: FileEditReplaceStringToolArgs = {
      path: "test.txt",
      old_string: "Hello world\nThis is a test\n",
      new_string: "Hello universe\nThis is a CRLF test\n",
    };

    const result = await executeStringReplace(tool, payload);

    expect(result.success).toBe(true);
    expect(await readFile(testFilePath)).toBe(
      "Hello universe\r\nThis is a CRLF test\r\nGoodbye world\r\n"
    );
  });

  it("does not modify the file when old_string is missing", async () => {
    const original = "Hello world\n";
    await setupFile(testFilePath, original);
    const tool = createFileEditReplaceStringTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
    });

    const payload: FileEditReplaceStringToolArgs = {
      path: "test.txt",
      old_string: "Goodbye world\n",
      new_string: "replaced\n",
    };

    const result = await executeStringReplace(tool, payload);

    expect(result.success).toBe(false);
    expect(await readFile(testFilePath)).toBe(original);
  });

  it("does not modify the file when old_string is ambiguous", async () => {
    const original = "repeat\nrepeat\n";
    await setupFile(testFilePath, original);
    const tool = createFileEditReplaceStringTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: "/tmp" }),
      runtimeTempDir: "/tmp",
    });

    const payload: FileEditReplaceStringToolArgs = {
      path: "test.txt",
      old_string: "repeat",
      new_string: "REPLACED",
    };

    const result = await executeStringReplace(tool, payload);

    expect(result.success).toBe(false);
    expect(await readFile(testFilePath)).toBe(original);
  });
});
