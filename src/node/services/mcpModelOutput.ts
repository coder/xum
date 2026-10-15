import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import type { MuxMessage } from "@/common/types/message";
import { mcpToModelOutput } from "@/node/services/mcpClient";

/** Only `toModelOutput` is read by convertToModelMessages; the schema is a placeholder. */
const MCP_REPLAY_TOOL: Tool = tool({
  inputSchema: jsonSchema({ type: "object" }),
  toModelOutput: mcpToModelOutput,
});

/**
 * Request build: tools whose `toModelOutput` the rebuild must apply, by name. Every MCP tool
 * converts its result with mcpToModelOutput in-turn (mcpClient), but persisted history keeps
 * the raw result, and convertToModelMessages without a tool JSON-encodes it. That rewrote the
 * tool_result bytes at the next turn: the prompt cache missed from there, and Anthropic
 * rejected every later thinking block of the turn. A persisted MCP call carries `mcpServer`
 * (the display snapshot every MCP tool wrapper publishes). A call without it keeps the old
 * JSON form.
 */
export function mcpReplayTools(messages: readonly MuxMessage[]): ToolSet {
  const tools: ToolSet = {};
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.mcpServer != null) {
        tools[part.toolName] ??= MCP_REPLAY_TOOL;
      }
    }
  }
  return tools;
}
