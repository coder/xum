import assert from "node:assert/strict";

import type { AssistantModelMessage, ModelMessage, ToolResultPart } from "ai";

import { stripEncryptedContent } from "@/node/utils/messages/stripEncryptedContent";

type AssistantContentPart = Exclude<AssistantModelMessage["content"], string>[number];

/**
 * Stringify arbitrary tool payloads for prompt text. This runs in a
 * request-building path, so it must self-heal instead of crashing: it never
 * throws and always returns a non-empty string (circular refs, BigInt, and
 * undefined all fall back to a primitive stringification or a placeholder).
 */
function safeStringifyForPrompt(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 0 ? value : '""';
  }
  if (value === undefined) {
    return "undefined";
  }
  try {
    const json = JSON.stringify(value);
    // JSON.stringify returns undefined for e.g. bare functions/symbols.
    if (typeof json === "string" && json.length > 0) {
      return json;
    }
  } catch {
    // Circular references, BigInt, throwing toJSON — fall through.
  }
  switch (typeof value) {
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "function":
      return String(value);
    default:
      // Objects that failed JSON.stringify would render as "[object Object]".
      return "[unserializable value]";
  }
}

function stringifyToolResultOutput(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
    case "content":
      // Provider-native web_search results can carry huge opaque
      // encryptedContent blobs. The persistence path strips them before
      // saving, but the live SDK transcript still has them — drop them here
      // too so the advisor prompt keeps only the useful URL/title fields.
      return safeStringifyForPrompt(stripEncryptedContent(output.value));
    default:
      // Unknown/future output shapes: self-heal with a generic stringification.
      return safeStringifyForPrompt(output);
  }
}

/**
 * Rewrite provider-executed (server-side) tool parts in a live transcript into
 * plain text parts so the transcript can be replayed against a *different*
 * provider.
 *
 * Why: the in-memory step messages captured from streamText keep
 * provider-executed tool calls/results (e.g. Anthropic web_search with
 * `srvtoolu_...` ids) as assistant-content parts with `providerExecuted: true`.
 * The OpenAI Responses input converter replays assistant tool-result parts as
 * `item_reference` items keyed by `providerOptions.openai.itemId ?? toolCallId`;
 * for foreign-origin parts there is no OpenAI itemId, so the raw foreign id
 * leaks and OpenAI rejects the request with `404 Item with id 'srvtoolu_...'
 * not found`. (The Coder AI gateway can further garble that error into
 * `AI_JSONParseError: Text: {` — if you see that symptom on an advisor call,
 * this is the likely cause.) The advisor consumer is tool-less, so flattening
 * the blocks to text preserves the content it needs while dropping the
 * provider-specific wire shape.
 *
 * Assistant `tool-result` parts are flattened unconditionally: in AI SDK v6
 * response messages they are provider-executed by construction (client tool
 * results live in `tool`-role messages), and provider-executed `tool-error`
 * parts are normalized into `tool-result` parts with error-json output before
 * they reach the transcript, so no separate error branch is needed. If an
 * assistant message ever carries an inline *client* tool pair, the paired
 * tool-call is flattened alongside its result so no orphaned call remains.
 *
 * Leak vectors reviewed and intentionally left untouched:
 * - Reasoning parts with foreign providerOptions: the OpenAI converter skips
 *   non-OpenAI reasoning parts with a warning; not a fatal leak.
 * - Text/file parts with providerOptions itemIds: only resolve to
 *   item_reference for same-provider OpenAI transcripts where the stored
 *   items exist; unknown namespaces are ignored cross-provider.
 * - Client tool call/result pairs (`tool`-role messages): replay as
 *   function_call/function_call_output, which providers accept with foreign
 *   call ids.
 *
 * Returns the original array (and original message objects) when nothing
 * changed so callers can cheaply detect no-ops.
 */
export function flattenProviderExecutedToolParts(messages: ModelMessage[]): ModelMessage[] {
  assert(Array.isArray(messages), "flattenProviderExecutedToolParts requires a message array");

  let didChange = false;

  const result = messages.map((message): ModelMessage => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }

    // Tool-call ids that have an inline tool-result in this assistant
    // message. Their calls must be flattened together with the results —
    // even when not flagged providerExecuted — or we'd leave a bare
    // tool-call with no matching result, which providers reject.
    const inlineResultCallIds = new Set(
      message.content.filter((part) => part.type === "tool-result").map((part) => part.toolCallId)
    );

    let changedMessage = false;
    const newContent = message.content.map((part): AssistantContentPart => {
      if (
        part.type === "tool-call" &&
        (part.providerExecuted === true || inlineResultCallIds.has(part.toolCallId))
      ) {
        changedMessage = true;
        // Build the text part fresh: drop providerOptions/toolCallId/
        // providerExecuted — provider-specific ids are exactly the leak.
        return {
          type: "text",
          text: `[Server tool call: ${part.toolName}] ${safeStringifyForPrompt(part.input)}`,
        };
      }
      if (part.type === "tool-result") {
        changedMessage = true;
        return {
          type: "text",
          text: `[Server tool result: ${part.toolName}] ${stringifyToolResultOutput(part.output)}`,
        };
      }
      return part;
    });

    if (!changedMessage) {
      return message;
    }
    didChange = true;
    return { ...message, content: newContent };
  });

  return didChange ? result : messages;
}
