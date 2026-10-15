import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import type { MuxMessage } from "@/common/types/message";

/**
 * MCP CallToolResult -> AI SDK tool-result output for the model.
 *
 * Mirrors @ai-sdk/mcp's mcpToModelOutput so model-visible tool results stay
 * identical across the SDK swap.
 */
export function mcpToModelOutput({
  output,
}: {
  output: unknown;
}): ReturnType<NonNullable<Tool["toModelOutput"]>> {
  const result = output as {
    type?: string;
    value?: Array<Record<string, unknown> & { type?: string }>;
    content?: Array<Record<string, unknown> & { type?: string }>;
  };
  // mcpServerManager's wrapMCPTools runs transformMCPResult over execute
  // results first — the single conversion layer for MCP binary content
  // (image/audio/blob resources, size guard included) — producing Xum's
  // canonical { type: "content", value: [text | media] } shape. Map its
  // media parts to model-output file parts here.
  if (
    result &&
    typeof result === "object" &&
    result.type === "content" &&
    Array.isArray(result.value)
  ) {
    return {
      type: "content",
      value: result.value.map((part) => {
        if (
          part.type === "media" &&
          typeof part.data === "string" &&
          typeof part.mediaType === "string"
        ) {
          return {
            type: "file" as const,
            mediaType: part.mediaType,
            data: { type: "data" as const, data: part.data },
          };
        }
        if (part.type === "text" && typeof part.text === "string") {
          return { type: "text" as const, text: part.text };
        }
        return { type: "text" as const, text: JSON.stringify(part) };
      }),
    };
  }
  if (!result || typeof result !== "object" || !Array.isArray(result.content)) {
    return { type: "json", value: result as never };
  }
  // Untransformed MCP results (no binary payloads; see transformMCPResult):
  // text and text-resource parts only in practice.
  const convertedContent = result.content.map((part) => {
    if (part.type === "text" && typeof part.text === "string") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "resource" && part.resource && typeof part.resource === "object") {
      const resource = part.resource as { uri?: string; text?: string };
      if (typeof resource.text === "string") {
        return { type: "text" as const, text: resource.text };
      }
    }
    return { type: "text" as const, text: JSON.stringify(part) };
  });
  return { type: "content", value: convertedContent };
}

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
