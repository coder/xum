import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import type { MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import { mcpToModelOutput } from "@/node/services/mcpClient";

type ModelOutput = ReturnType<NonNullable<Tool["toModelOutput"]>>;

/** convertToModelMessages' own conversion for a tool without `toModelOutput`. */
function defaultModelOutput(output: unknown): ModelOutput {
  return typeof output === "string"
    ? { type: "text", value: output }
    : { type: "json", value: output as never };
}

/**
 * The MCP conversion for one persisted call. Persisted output is unvalidated (`z.unknown()`):
 * a malformed result that mcpToModelOutput cannot read falls back to the default JSON form,
 * so one bad history line cannot fail every later request.
 */
function replayMcpModelOutput(output: unknown): ModelOutput {
  try {
    return mcpToModelOutput({ output });
  } catch (error) {
    log.warn("[MCP] Persisted tool result is not readable as MCP content; replaying as JSON", {
      error,
    });
    return defaultModelOutput(output);
  }
}

/**
 * Request build: the tools convertToModelMessages must convert like the in-turn step did. Every
 * MCP tool converts its result with mcpToModelOutput in-turn (mcpClient), but persisted history
 * keeps the raw result, and convertToModelMessages without a tool JSON-encodes it. That rewrote
 * the tool_result bytes at the next turn: the prompt cache missed from there, and Anthropic
 * rejected every later thinking block of the turn.
 *
 * A persisted MCP call carries `mcpServer` (the display snapshot every MCP tool wrapper
 * publishes). The conversion applies per call, not per name: history can hold an ordinary call
 * under the same name (a CLI extra tool, an older config), and that one keeps the JSON form.
 */
export function mcpReplayTools(messages: readonly MuxMessage[]): ToolSet {
  const tools: ToolSet = {};
  for (const [name, mcpCallIds] of mcpCallIdsByToolName(messages)) {
    // Only `toModelOutput` is read by convertToModelMessages; the schema is a placeholder.
    tools[name] = tool({
      inputSchema: jsonSchema({ type: "object" }),
      toModelOutput: ({ toolCallId, output }) =>
        mcpCallIds.has(toolCallId) ? replayMcpModelOutput(output) : defaultModelOutput(output),
    });
  }
  return tools;
}

/** The tool call IDs of persisted MCP calls (parts with `mcpServer`), by tool name. */
function mcpCallIdsByToolName(messages: readonly MuxMessage[]): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || part.mcpServer == null) continue;
      const ids = byName.get(part.toolName) ?? new Set<string>();
      ids.add(part.toolCallId);
      byName.set(part.toolName, ids);
    }
  }
  return byName;
}
