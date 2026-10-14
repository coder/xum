import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { jsonSchema, tool, type Tool } from "ai";
import { z } from "zod";
import { withHooks } from "./withHooks";
import { eventSpine, type ToolExecuteContext } from "@/node/services/events/eventSpine";
import { MCP_TOOL_ORIGIN } from "@/node/services/agentPlugins/codexToolNames";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { sanitizeMCPToolsForOpenAI } from "@/common/utils/tools/schemaSanitizer";

describe("withHooks", () => {
  let tempDir: string;
  let runtime: LocalRuntime;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-withHooks-test-"));
    runtime = new LocalRuntime(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createTestTool(executeFn: (args: { input: string }) => Promise<{ output: string }>) {
    return tool({
      description: "Test tool",
      inputSchema: z.object({ input: z.string() }),
      execute: (args) => executeFn(args),
    });
  }

  test("hands an MCP tool's origin and input schema to tool.execute middleware", async () => {
    const baseTool = createTestTool((args) => Promise.resolve({ output: args.input }));
    Object.defineProperty(baseTool, MCP_TOOL_ORIGIN, {
      value: { serverName: "plugin:0123456789abcdef:scanner", toolName: "scan" },
      enumerable: true,
    });
    const seen: Array<Pick<ToolExecuteContext, "mcpOrigin"> & { schema: unknown }> = [];
    const unregister = eventSpine.useBefore(
      "tool.execute",
      (ctx) => {
        seen.push({ mcpOrigin: ctx.mcpOrigin, schema: ctx.inputJsonSchema?.() });
      },
      { workspaceId: "origin-ws" }
    );
    try {
      const wrapped = withHooks("plugin_x_scanner_scan", baseTool, {
        runtime,
        cwd: tempDir,
        runtimeTempDir: tempDir,
        workspaceId: "origin-ws",
      });
      await wrapped.execute!({ input: "hi" }, {} as never);
    } finally {
      unregister();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mcpOrigin).toEqual({
      serverName: "plugin:0123456789abcdef:scanner",
      toolName: "scan",
    });
    expect(seen[0]?.schema).toMatchObject({ properties: { input: { type: "string" } } });
  });

  test("executes tool directly when no hook exists", async () => {
    const baseTool = createTestTool((args) =>
      Promise.resolve({ output: `processed: ${args.input}` })
    );

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = await wrappedTool.execute!({ input: "hello" }, {} as never);
    expect(result).toEqual({ output: "processed: hello" });
  });

  test("executes tool through hook when hook exists", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "$MUX_EXEC"
read RESULT
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool((args) =>
      Promise.resolve({ output: `processed: ${args.input}` })
    );

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = await wrappedTool.execute!({ input: "world" }, {} as never);
    expect(result).toEqual({ output: "processed: world" });
  });

  test("returns error when hook blocks execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "Blocked: dangerous operation" >&2
exit 1
`
    );
    await fs.chmod(hookPath, 0o755);

    let toolCalled = false;
    const baseTool = createTestTool(() => {
      toolCalled = true;
      return Promise.resolve({ output: "should not run" });
    });

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      error?: string;
    };
    expect(toolCalled).toBe(false);
    expect(result.error).toContain("Blocked: dangerous operation");
  });

  test("appends hook_output when hook fails after execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "$MUX_EXEC"
read RESULT
echo "Lint failed: syntax error" >&2
exit 1
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "edit complete" }));

    const wrappedTool = withHooks("file_edit", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      output: string;
      hook_output?: string;
    };
    expect(result.output).toBe("edit complete");
    expect(result.hook_output).toContain("Lint failed: syntax error");
  });

  test("appends hook_output and hook_path when hook succeeds with output", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "$MUX_EXEC"
read RESULT
echo "Formatted: test.ts" >&2
exit 0
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "edit complete" }));

    const wrappedTool = withHooks("file_edit", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      output: string;
      hook_output?: string;
      hook_path?: string;
    };
    expect(result.output).toBe("edit complete");
    expect(result.hook_output).toContain("Formatted: test.ts");
    expect(result.hook_path).toBe(hookPath);
  });

  test("passes env to hook", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_hook");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
# Exit with error if SECRET is not set correctly
if [ "$MY_API_KEY" != "secret123" ]; then
  echo "SECRET not found" >&2
  exit 1
fi
echo "$MUX_EXEC"
read RESULT
`
    );
    await fs.chmod(hookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "ok" }));

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
      env: { MY_API_KEY: "secret123" },
    });

    const result = await wrappedTool.execute!({ input: "test" }, {} as never);
    expect(result).toEqual({ output: "ok" });
  });

  test("uses tool_pre hook to block execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const hookPath = path.join(hookDir, "tool_pre");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      hookPath,
      `#!/bin/bash
echo "Force push blocked" >&2
exit 1
`
    );
    await fs.chmod(hookPath, 0o755);

    let toolExecuted = false;
    const baseTool = createTestTool(() => {
      toolExecuted = true;
      return Promise.resolve({ output: "should not happen" });
    });

    const wrappedTool = withHooks("bash", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as unknown as {
      error: string;
    };
    expect(toolExecuted).toBe(false);
    expect(result.error).toContain("Force push blocked");
  });

  test("uses tool_post hook to add output after execution", async () => {
    const hookDir = path.join(tempDir, ".mux");
    const postHookPath = path.join(hookDir, "tool_post");
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      postHookPath,
      `#!/bin/bash
echo "Linting passed" >&2
exit 0
`
    );
    await fs.chmod(postHookPath, 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "edit done" }));

    const wrappedTool = withHooks("file_edit", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as {
      output: string;
      hook_output?: string;
    };
    expect(result.output).toBe("edit done");
    expect(result.hook_output).toContain("Linting passed");
  });

  test("tool_pre takes priority over tool_hook", async () => {
    const hookDir = path.join(tempDir, ".mux");
    await fs.mkdir(hookDir, { recursive: true });

    // Create both tool_pre and tool_hook
    await fs.writeFile(path.join(hookDir, "tool_pre"), "#!/bin/bash\nexit 0");
    await fs.chmod(path.join(hookDir, "tool_pre"), 0o755);

    // Legacy hook that would block if used
    await fs.writeFile(path.join(hookDir, "tool_hook"), "#!/bin/bash\nexit 1");
    await fs.chmod(path.join(hookDir, "tool_hook"), 0o755);

    const baseTool = createTestTool(() => Promise.resolve({ output: "success" }));

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    // Should succeed because tool_pre (exit 0) takes priority over tool_hook (exit 1)
    const result = await wrappedTool.execute!({ input: "test" }, {} as never);
    expect(result).toEqual({ output: "success" });
  });

  test("tool_pre + tool_post work together", async () => {
    const hookDir = path.join(tempDir, ".mux");
    await fs.mkdir(hookDir, { recursive: true });

    await fs.writeFile(path.join(hookDir, "tool_pre"), '#!/bin/bash\necho "pre ran" >&2\nexit 0');
    await fs.chmod(path.join(hookDir, "tool_pre"), 0o755);

    await fs.writeFile(
      path.join(hookDir, "tool_post"),
      '#!/bin/bash\necho "post ran: $MUX_TOOL_RESULT"'
    );
    await fs.chmod(path.join(hookDir, "tool_post"), 0o755);

    const baseTool = createTestTool(() =>
      Promise.resolve({ output: "done", value: 42 } as { output: string; value?: number })
    );

    const wrappedTool = withHooks("test_tool", baseTool, {
      runtime,
      cwd: tempDir,
      runtimeTempDir: tempDir,
      workspaceId: "test-ws",
    });

    const result = (await wrappedTool.execute!({ input: "test" }, {} as never)) as unknown as {
      value: number;
      hook_output?: string;
    };
    expect(result.value).toBe(42);
    expect(result.hook_output).toContain("post ran:");
    expect(result.hook_output).toContain('"value":42');
  });

  test("hook rewrites see the MCP tool's full schema, not the OpenAI-sanitized one", async () => {
    const schema = {
      type: "object" as const,
      properties: { name: { type: "string" as const, minLength: 1 } },
      required: ["name"],
    };
    const mcpTool = tool({
      description: "MCP tool",
      inputSchema: jsonSchema(schema),
      execute: () => Promise.resolve({ ok: true }),
    }) as Tool;
    const { scan: sanitized } = sanitizeMCPToolsForOpenAI({ scan: mcpTool });
    const seen: unknown[] = [];
    const unregister = eventSpine.useBefore("tool.execute", (ctx) => {
      seen.push(ctx.inputJsonSchema?.());
    });
    try {
      const wrapped = withHooks("scan", sanitized, {
        runtime,
        cwd: tempDir,
        runtimeTempDir: tempDir,
        workspaceId: "test-ws",
      });
      await wrapped.execute!({ name: "a" }, {} as never);
    } finally {
      unregister();
    }
    expect(seen).toEqual([schema]);
  });

  test("a post-block keeps the model-visible result: the hook's feedback replaces the output", async () => {
    // Codex PRRT_kwDOPxxmWM6r6NnK: the pipeline reports a post-block to nested callers, but an
    // ordinary tool call still returns the feedback exactly as before.
    const feedback = { error: "[plugin:guard] secrets stay out" };
    const unregister = eventSpine.use(
      "tool.execute",
      async (ctx, next) => {
        await next();
        ctx.result = feedback;
        ctx.postBlocked = true;
      },
      { workspaceId: "post-block-ws" }
    );
    try {
      const wrapped = withHooks(
        "test_tool",
        createTestTool(() => Promise.resolve({ output: "SECRET" })),
        { runtime, cwd: tempDir, runtimeTempDir: tempDir, workspaceId: "post-block-ws" }
      );
      const result: unknown = await wrapped.execute!({ input: "x" }, {} as never);
      expect(result).toEqual(feedback);
    } finally {
      unregister();
    }
  });
});
