import { describe, expect, test } from "bun:test";
import { tool, type Tool, type ToolSet } from "ai";
import { z } from "zod";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import {
  ToolCallDisplayRegistry,
  type ExecutionScope,
} from "@/node/services/toolCallDisplayRegistry";
import { getExecutionScope, withExecutionScope } from "./withExecutionScope";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("createDeferred failed to initialize promise controls");
  }
  return { promise, resolve };
}

async function callExecute(tool: Tool, args: unknown, options: unknown): Promise<unknown> {
  const execute = (tool as Record<string, unknown>).execute;
  if (typeof execute !== "function") {
    throw new Error("Expected an execute handler");
  }
  return await (execute as (a: unknown, o: unknown) => unknown)(args, options);
}

const scopeA: ExecutionScope = { workspaceId: "ws", messageId: "m-a", token: "t-a" };
const scopeB: ExecutionScope = { workspaceId: "ws", messageId: "m-b", token: "t-b" };

function snapshot(name: string): MCPToolCallDisplay {
  return {
    connection: { key: "notion", transport: "stdio" },
    identity: { name, version: "1" },
    source: "connection",
  };
}

function baseOptions(toolCallId: string) {
  return { toolCallId, messages: [], abortSignal: new AbortController().signal };
}

describe("withExecutionScope", () => {
  test("binds the host scope into execute options and preserves the caller's options", async () => {
    let seen: unknown;
    const tools: ToolSet = {
      echo: tool({
        description: "echo",
        inputSchema: z.object({ v: z.string() }),
        execute: (args, options) => {
          seen = options;
          return { echoed: args.v };
        },
      }),
    };
    const wrapped = withExecutionScope(tools, scopeA);
    const options = baseOptions("call-1");
    const result = await callExecute(wrapped.echo, { v: "hi" }, options);

    expect(result).toStrictEqual({ echoed: "hi" });
    expect(getExecutionScope(seen)).toBe(scopeA);
    const seenOptions = seen as Record<string, unknown>;
    expect(seenOptions.toolCallId).toBe("call-1");
    expect(seenOptions.messages).toBe(options.messages);
    expect(seenOptions.abortSignal).toBe(options.abortSignal);
    // The caller's options object is not mutated.
    expect(getExecutionScope(options)).toBeUndefined();
    expect(wrapped.echo.description).toBe("echo");
  });

  test("a caller-supplied scope in options cannot override the host scope", async () => {
    let seen: unknown;
    const tools: ToolSet = {
      echo: tool({
        inputSchema: z.object({}),
        execute: (_args, options) => {
          seen = options;
          return "ok";
        },
      }),
    };
    const wrapped = withExecutionScope(tools, scopeA);
    await callExecute(wrapped.echo, {}, { ...baseOptions("call-1"), muxExecutionScope: scopeB });
    expect(getExecutionScope(seen)).toBe(scopeA);
  });

  test("leaves tools without execute untouched and never mutates the originals", async () => {
    const providerTool = tool({ inputSchema: z.object({}) });
    let seen: unknown;
    const executable = tool({
      inputSchema: z.object({}),
      execute: (_args, options) => {
        seen = options;
        return "ok";
      },
    });
    const wrapped = withExecutionScope({ providerTool, executable }, scopeA);
    expect(wrapped.providerTool).toBe(providerTool);
    expect(wrapped.executable).not.toBe(executable);
    await callExecute(executable, {}, baseOptions("call-1"));
    expect(getExecutionScope(seen)).toBeUndefined();
  });

  test("propagates errors from the wrapped execute", async () => {
    const tools: ToolSet = {
      boom: tool({
        inputSchema: z.object({}),
        execute: (): string => {
          throw new Error("boom");
        },
      }),
    };
    const wrapped = withExecutionScope(tools, scopeA);
    let caught: unknown;
    try {
      await callExecute(wrapped.boom, {}, baseOptions("call-1"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("boom");
  });

  test("a queued invocation from run A entering after run B started still writes as A", async () => {
    const registry = new ToolCallDisplayRegistry({ now: () => 0 });
    const gate = createDeferred<void>();
    const writes: Array<{ scope: ExecutionScope | undefined; toolCallId: string }> = [];
    // Simulates the MCP wrapper: publish the snapshot under the originating scope.
    const tools: ToolSet = {
      mcp: tool({
        inputSchema: z.object({}),
        execute: async (_args, options) => {
          await gate.promise;
          const scope = getExecutionScope(options);
          writes.push({ scope, toolCallId: options.toolCallId });
          if (scope) {
            registry.set(scope, options.toolCallId, snapshot(scope.messageId));
          }
          return "ok";
        },
      }),
    };

    registry.open(scopeA);
    const turnA = withExecutionScope(tools, scopeA);
    const queuedA = callExecute(turnA.mcp, {}, baseOptions("call-1"));

    // Run A is aborted while its invocation is still queued; run B starts and
    // reuses the same tool call id.
    registry.close(scopeA);
    registry.open(scopeB);
    const turnB = withExecutionScope(tools, scopeB);
    const runningB = callExecute(turnB.mcp, {}, baseOptions("call-1"));

    gate.resolve();
    await Promise.all([queuedA, runningB]);

    expect(writes.map((w) => w.scope)).toStrictEqual([scopeA, scopeB]);
    expect(writes.every((w) => w.toolCallId === "call-1")).toBe(true);
    // A's late write was ignored; B's consumer sees only B's snapshot and A's consumer sees nothing.
    expect(registry.take(scopeB, "call-1")).toStrictEqual(snapshot("m-b"));
    expect(registry.take(scopeA, "call-1")).toBeUndefined();
  });

  test("getExecutionScope only returns well-formed scopes", () => {
    expect(getExecutionScope(undefined)).toBeUndefined();
    expect(getExecutionScope("scope")).toBeUndefined();
    expect(getExecutionScope({})).toBeUndefined();
    expect(getExecutionScope({ muxExecutionScope: "ws:m:t" })).toBeUndefined();
    expect(
      getExecutionScope({ muxExecutionScope: { workspaceId: "ws", messageId: "m" } })
    ).toBeUndefined();
    expect(getExecutionScope({ muxExecutionScope: scopeA })).toBe(scopeA);
  });
});
