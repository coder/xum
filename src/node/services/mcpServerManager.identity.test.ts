import { describe, expect, test } from "bun:test";
import { convertToModelMessages, dynamicTool, jsonSchema, type Tool } from "ai";
import type { MCPConnectionRef } from "@/common/types/mcp";
import { wrapMCPTools } from "./mcpServerManager";
import { ToolCallDisplayRegistry } from "./toolCallDisplayRegistry";
import { withExecutionScope } from "./tools/withExecutionScope";

const displayKey = "io.modelcontextprotocol/serverInfo";
const identity = { name: "server-display-only", version: "1.0" };

describe("MCP display metadata boundary", () => {
  test("excludes only standard display metadata from new output and provider replay", async () => {
    const raw = {
      content: [{ type: "text", text: "The tool answer" }],
      _meta: { [displayKey]: identity, unrelated: { cursor: "page-2" } },
    };
    const tools = wrapMCPTools({
      search: dynamicTool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: () => raw,
      }),
    });
    const output: unknown = await tools.search.execute!(
      {},
      { toolCallId: "call", messages: [], context: undefined }
    );
    expect(output).toEqual({
      content: raw.content,
      _meta: { unrelated: { cursor: "page-2" } },
    });
    // A display snapshot belongs on the part root, never inside output: the SDK
    // ignores host-only part fields, but replays every byte of a JSON output.
    const messages = [
      {
        id: "assistant",
        role: "assistant" as const,
        parts: [
          {
            type: "dynamic-tool" as const,
            toolName: "search",
            toolCallId: "call",
            state: "output-available" as const,
            input: {},
            output,
            mcpServer: { connection: { key: "configured", transport: "stdio" }, identity },
          },
        ],
      },
    ];
    const replay = JSON.stringify(await convertToModelMessages(messages));
    expect(replay).not.toContain(identity.name);
    expect(replay).toContain("The tool answer");
    expect(replay).toContain("page-2");
    expect(raw._meta[displayKey]).toEqual(identity);

    // No migration: conversion of pre-existing output retains its old payload.
    messages[0].parts[0].output = raw;
    expect(JSON.stringify(await convertToModelMessages(messages))).toContain(identity.name);
  });

  test.each([null, "not-an-object", { content: [] }, { _meta: ["invalid"] }])(
    "malformed or absent metadata does not fail the tool call: %j",
    async (raw) => {
      const tools = wrapMCPTools({
        search: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: () => raw }),
      });
      const result: unknown = await tools.search.execute!(
        {},
        { toolCallId: "call", messages: [], context: undefined }
      );
      expect(result).toBeDefined();
    }
  );
});

const connection: MCPConnectionRef = { key: "configured", transport: "stdio" };
const scope = { workspaceId: "workspace", messageId: "message", token: "turn" };

/** One wrapped tool under an open scope; `identity` undefined models a server without a handshake identity. */
function failingHarness(options: {
  execute: Tool["execute"];
  identity?: typeof identity;
  onClosed?: () => void;
}) {
  const registry = new ToolCallDisplayRegistry();
  registry.open(scope);
  const tools = withExecutionScope(
    wrapMCPTools(
      {
        probe: dynamicTool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: options.execute!,
        }),
      },
      {
        display: { connection, identity: options.identity, registry },
        onClosed: options.onClosed,
      }
    ),
    scope
  );
  return { registry, execute: tools.probe.execute! };
}

/** The rejection of `run`; fails the test when it settles successfully. */
async function rejectionOf(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

describe("MCP identity on failed tool calls", () => {
  test("a thrown execution keeps the handshake identity for the failed part and rethrows unchanged", async () => {
    const failure = new Error("upstream exploded");
    const h = failingHarness({ execute: () => Promise.reject(failure), identity });
    const caught = await rejectionOf(() =>
      h.execute({}, { toolCallId: "call", messages: [], context: undefined })
    );
    expect(caught).toBe(failure);
    expect(h.registry.take(scope, "call")).toEqual({ connection, identity, source: "connection" });
  });

  test("an interrupted call publishes its snapshot before the client is recycled", async () => {
    const abort = new AbortController();
    let seenDuringRecycle: unknown = "not called";
    const h = failingHarness({
      // Never settles on its own; only the deadline/abort path can end it.
      execute: () => new Promise(() => undefined),
      identity,
      onClosed: () => {
        seenDuringRecycle = h.registry.take(scope, "call");
      },
    });
    const pending: unknown = h.execute(
      {},
      { toolCallId: "call", messages: [], context: undefined, abortSignal: abort.signal }
    );
    abort.abort();
    expect(await rejectionOf(() => pending)).toMatchObject({ message: "Interrupted" });
    // The recycle callback already saw the snapshot; nothing was published twice.
    expect(seenDuringRecycle).toEqual({ connection, identity, source: "connection" });
    expect(h.registry.take(scope, "call")).toBeUndefined();
  });

  test("without a handshake identity or an open scope a failure publishes nothing", async () => {
    const unknownServer = failingHarness({ execute: () => Promise.reject(new Error("boom")) });
    expect(
      await rejectionOf(() =>
        unknownServer.execute({}, { toolCallId: "call", messages: [], context: undefined })
      )
    ).toMatchObject({ message: "boom" });
    expect(unknownServer.registry.take(scope, "call")).toBeUndefined();

    const closed = failingHarness({ execute: () => Promise.reject(new Error("boom")), identity });
    closed.registry.close(scope);
    expect(
      await rejectionOf(() =>
        closed.execute({}, { toolCallId: "call", messages: [], context: undefined })
      )
    ).toMatchObject({ message: "boom" });
    closed.registry.open(scope);
    expect(closed.registry.take(scope, "call")).toBeUndefined();
  });
});
