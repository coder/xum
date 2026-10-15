import { jsonSchema, tool, type Tool, type ToolSet } from "ai";

import type { MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import { mcpToModelOutput } from "@/node/services/mcpClient";

type ModelOutput = ReturnType<NonNullable<Tool["toModelOutput"]>>;

/** Request-only envelope that marks one persisted call's output as MCP (see prepareMcpReplay). */
interface McpReplayOutput {
  readonly mcpReplayOutput: unknown;
}

function isMcpReplayOutput(output: unknown): output is McpReplayOutput {
  return typeof output === "object" && output !== null && MCP_REPLAY_MARK in output;
}

/** Holds the envelope's key, so a tool's own output field cannot be mistaken for it. */
const MCP_REPLAY_MARK = "mcpReplayOutput" satisfies keyof McpReplayOutput;

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

/** Only `toModelOutput` is read by convertToModelMessages; the schema is a placeholder. */
const MCP_REPLAY_TOOL: Tool = tool({
  inputSchema: jsonSchema({ type: "object" }),
  toModelOutput: ({ output }) =>
    isMcpReplayOutput(output)
      ? replayMcpModelOutput(output.mcpReplayOutput)
      : defaultModelOutput(output),
});

/**
 * Request build: convert MCP results the way their in-turn step did. Every MCP tool converts its
 * result with mcpToModelOutput in-turn (mcpClient), but persisted history keeps the raw result,
 * and convertToModelMessages without a tool JSON-encodes it. That rewrote the tool_result bytes
 * at the next turn: the prompt cache missed from there, and Anthropic rejected every later
 * thinking block of the turn.
 *
 * A persisted MCP call carries `mcpServer` (the display snapshot every MCP tool wrapper
 * publishes). The mark goes on each such part's output, not on its name or call ID: history can
 * hold an ordinary call under the same name, or a reused call ID, and those keep the JSON form.
 * Returns the messages to convert and the tools to pass to convertToModelMessages.
 */
export function prepareMcpReplay<M extends MuxMessage>(
  messages: readonly M[]
): { messages: M[]; tools: ToolSet } {
  const tools: ToolSet = {};
  const marked = messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool" || part.state !== "output-available") return part;
      if (part.mcpServer == null) return part;
      changed = true;
      tools[part.toolName] = MCP_REPLAY_TOOL;
      const output: McpReplayOutput = { mcpReplayOutput: part.output };
      return { ...part, output };
    });
    return changed ? { ...message, parts } : message;
  });
  return { messages: marked, tools };
}
