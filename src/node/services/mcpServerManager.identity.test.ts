import { describe, expect, test } from "bun:test";
import { convertToModelMessages, dynamicTool, jsonSchema } from "ai";
import { wrapMCPTools } from "./mcpServerManager";

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
