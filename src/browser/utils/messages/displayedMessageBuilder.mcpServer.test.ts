import { describe, expect, test } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

const SNAPSHOT: MCPToolCallDisplay = {
  connection: { key: "notion-work", transport: "http", origin: "https://mcp.notion.com" },
  identity: { name: "Notion MCP", version: "1.2.0" },
  source: "connection",
  iconRef: "0123456789abcdef0123456789abcdef",
};

function toolRows(parts: Parameters<typeof createMuxMessage>[4]) {
  const displayed = buildDisplayedMessagesForMessage({
    message: createMuxMessage("m1", "assistant", "", undefined, parts),
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  return displayed.filter((m) => m.type === "tool");
}

describe("buildDisplayedMessagesForMessage MCP identity forwarding", () => {
  test("forwards the host snapshot from top-level and nested parts and leaves plain parts alone", () => {
    const rows = toolRows([
      {
        type: "dynamic-tool",
        toolCallId: "plain",
        toolName: "mcp__local_docs__search",
        state: "output-available",
        input: {},
        output: { content: [] },
      },
      {
        type: "dynamic-tool",
        toolCallId: "branded",
        toolName: "mcp__notion__notion_fetch",
        state: "output-available",
        input: { id: "x" },
        output: { content: [] },
        mcpServer: SNAPSHOT,
      },
      {
        type: "dynamic-tool",
        toolCallId: "nested-parent",
        toolName: "code_execution",
        state: "output-available",
        input: { code: "return 1;" },
        output: { success: true, result: 1, toolCalls: [], consoleOutput: [], duration_ms: 1 },
        nestedCalls: [
          {
            toolCallId: "nested-1",
            toolName: "mcp__notion__notion_ai_search",
            input: { query: "q" },
            output: { content: [] },
            state: "output-available",
            mcpServer: SNAPSHOT,
          },
          {
            toolCallId: "nested-2",
            toolName: "bash",
            input: { script: "ls" },
            output: {},
            state: "output-available",
          },
        ],
      },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toHaveProperty("mcpServer");
    expect(rows[1].mcpServer).toEqual(SNAPSHOT);
    expect(rows[2].nestedCalls?.[0]?.mcpServer).toEqual(SNAPSHOT);
    expect(rows[2].nestedCalls?.[1]?.mcpServer).toBeUndefined();
  });
});
