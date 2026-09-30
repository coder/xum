import type {
  LanguageModelV4Content,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  TOOL_PAYLOAD_DEPTH_REJECTION,
  jsonTextExceedsDepth,
} from "@/common/utils/tools/toolPayloadDepth";
import { log } from "@/node/services/log";

/**
 * Rejects tool calls whose raw JSON input nests deeper than
 * MAX_TOOL_PAYLOAD_JSON_DEPTH before the AI SDK parses them.
 *
 * Why here and not in a tool-call repair/refine hook or the fullStream
 * consumer: the SDK's parseToolCall re-parses the raw text in its outer catch
 * (`safeParseJSON({ text: toolCall.input })`) even for an invalid call, then
 * `cloneModelMessages` recursively clones the resulting deep object at step
 * finish and overflows the stack (RangeError, surfaced to the user as a bogus
 * `context_exceeded`). Only the provider-facing middleware sees the text
 * first. The substituted text is intentionally invalid JSON so the call is
 * stamped `invalid` (never executed, regardless of schema permissiveness) and
 * the model receives the normal invalid-input tool error.
 */
export function createToolInputDepthGuardMiddleware(): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      return { ...result, content: result.content.map(rejectDeepToolCallInput) };
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              controller.enqueue(rejectDeepToolCallInput(part));
            },
          })
        ),
      };
    },
  };
}

function rejectDeepToolCallInput<Part extends LanguageModelV4StreamPart | LanguageModelV4Content>(
  part: Part
): Part {
  if (part.type !== "tool-call" || !jsonTextExceedsDepth(part.input)) return part;
  log.warn("Rejected tool call: input JSON nesting depth exceeds the bound", {
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    inputLength: part.input.length,
  });
  return { ...part, input: TOOL_PAYLOAD_DEPTH_REJECTION };
}
