import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import type { MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import { mcpToModelOutput } from "@/node/services/mcpClient";
import { replaceProviderUnreadyMcpMedia } from "@/node/utils/messages/toolResultAttachments";

type ModelOutput = ReturnType<NonNullable<Tool["toModelOutput"]>>;

/** Request-only envelope around one persisted MCP call's output (see prepareMcpReplay). */
interface McpReplayOutput {
  readonly mcpReplayOutput: unknown;
}

/** convertToModelMessages' own conversion for a tool without `toModelOutput`. */
function defaultModelOutput(output: unknown): ModelOutput {
  return typeof output === "string"
    ? { type: "text", value: output }
    : // A missing output (corrupted row) sends JSON null, as the SDK's own conversion does.
      { type: "json", value: (output ?? null) as never };
}

/**
 * The MCP conversion for one persisted call. Persisted output is unvalidated (`z.unknown()`):
 * a malformed result that mcpToModelOutput cannot read falls back to the default JSON form,
 * so one bad history line cannot fail every later request.
 */
function replayMcpModelOutput(output: unknown): ModelOutput {
  if (output === undefined) return defaultModelOutput(output);
  try {
    return mcpToModelOutput({ output: replaceProviderUnreadyMcpMedia(output) });
  } catch (error) {
    log.warn("[MCP] Persisted tool result is not readable as MCP content; replaying as JSON", {
      error,
    });
    return defaultModelOutput(output);
  }
}

/** The replay tool for one request: it converts exactly the outputs in `envelopes`. */
function createMcpReplayTool(envelopes: WeakSet<McpReplayOutput>): Tool {
  const isEnvelope = (output: unknown): output is McpReplayOutput =>
    typeof output === "object" && output !== null && envelopes.has(output as McpReplayOutput);
  // Only `toModelOutput` is read by convertToModelMessages; the schema is a placeholder.
  return tool({
    inputSchema: jsonSchema({ type: "object" }),
    toModelOutput: ({ output }) =>
      isEnvelope(output)
        ? replayMcpModelOutput(output.mcpReplayOutput)
        : defaultModelOutput(output),
  });
}

/**
 * Request build: convert MCP results the way their in-turn step did. Every MCP tool converts its
 * result with mcpToModelOutput in-turn (mcpClient), but persisted history keeps the raw result,
 * and convertToModelMessages without a tool JSON-encodes it. That rewrote the tool_result bytes
 * at the next turn: the prompt cache missed from there, and Anthropic rejected every later
 * thinking block of the turn.
 *
 * A persisted MCP call carries `mcpServer` (the display snapshot every MCP tool wrapper
 * publishes). The mark is the identity of each such part's envelope object, not its name, call
 * ID or a field: history can hold an ordinary call under the same name, a reused call ID, or an
 * output with any field, and those keep the JSON form. Returns the messages to convert and the
 * tools to pass to convertToModelMessages.
 */
export function prepareMcpReplay<M extends MuxMessage>(
  messages: readonly M[]
): { messages: M[]; tools: ToolSet } {
  const envelopes = new WeakSet<McpReplayOutput>();
  const replayTool = createMcpReplayTool(envelopes);
  const tools: ToolSet = {};
  const marked = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") return part;
      if (part.mcpServer == null) return part;
      changed = true;
      tools[part.toolName] = replayTool;
      const output: McpReplayOutput = { mcpReplayOutput: part.output };
      envelopes.add(output);
      return { ...part, output };
    });
    return changed ? { ...message, parts } : message;
  });
  return { messages: marked, tools };
}
