import type { MuxMessage } from "@/common/types/message";
import type { DynamicToolPart } from "@/common/types/toolParts";
import { ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS } from "@/constants/anthropicServerTools";
import { sanitizeStringForProviderOutput } from "@/common/utils/providerOutputSanitization";
import { stripEncryptedContent } from "./stripEncryptedContent";

/**
 * #5887 option A: Anthropic server tools that history replays natively
 * (`server_tool_use` + `web_search_tool_result`, in place, next to the signed thinking around
 * them) instead of as a client `tool_use`/`tool_result` pair. Preserved thinking binds each
 * thinking block to everything before it, so only the native blocks keep later thinking (and
 * the prompt cache) valid.
 *
 * Scope: successful `web_search` results. Error results and other server tools (web_fetch,
 * code_execution, ...) replay as a client pair, and the stream-time receipt
 * (`MuxMetadata.anthropicThinkingReplay`) keeps the thinking after them out.
 *
 * Stream time (the receipt trigger) and request time (the projection below) both use this
 * predicate, so they cannot disagree about a stored part.
 */
export function isNativeAnthropicReplayable(part: DynamicToolPart): boolean {
  if (part.providerExecuted !== true || part.toolName !== "web_search") return false;
  if (part.state !== "output-available") return false;
  // The SDK validates every native result against a schema that requires encryptedContent and
  // a string-or-null title: one missing field throws, and no request is sent at all.
  return Array.isArray(part.output) && part.output.every(isReplayableWebSearchResult);
}

function isReplayableWebSearchResult(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const result = item as Record<string, unknown>;
  return (
    result.type === "web_search_result" &&
    isVerbatimSafe(result.url) &&
    isVerbatimSafe(result.encryptedContent) &&
    (result.title === null || isVerbatimSafe(result.title)) &&
    // Present as a string or null: the SDK's replay schema rejects a missing pageAge.
    (result.pageAge === null || isVerbatimSafe(result.pageAge))
  );
}

/**
 * Native replay must send the result back exactly as the API returned it, but every request
 * still runs the generic provider-output sanitizer (applyToolOutputRedaction), in this build and
 * in older ones that read the same stored rows. So only fields that sanitizer leaves unchanged
 * (at most 12,000 chars, no control text) can replay natively, the ciphertext included. Any other
 * result replays as the client pair, and the receipt keeps the thinking after it out.
 */
function isVerbatimSafe(value: unknown): boolean {
  return typeof value === "string" && sanitizeStringForProviderOutput(value) === value;
}

/**
 * The form a completed provider-executed part is stored in. It keeps the flag (and its
 * ciphertext) only when history can replay it natively. Everything else is stored exactly as
 * before #5887: a client pair without ciphertext. Older builds read these rows too: their SDK
 * would throw on a flagged result it cannot validate, so the flag never outlives the check.
 *
 * Two more cases are stored demoted, and the stream-time receipt then keeps the thinking after
 * them out:
 * - `resultFollowsCall` false: other parts arrived between the call and its result. The API
 *   does this when Claude calls a client tool in the same parallel group: the response ends
 *   after both calls, and the server tool's result opens the next step. One stored part cannot
 *   replay the call and the result at their two positions, and moving them changes the prefix
 *   the later thinking is bound to.
 * - Ciphertext that would take the row's total above
 *   ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS (row size bound).
 *   `rowCiphertextChars` is what the row's other parts already keep (see rowCiphertextChars).
 */
export function toStoredServerToolPart(
  part: DynamicToolPart,
  options: { resultFollowsCall: boolean; rowCiphertextChars: number }
): DynamicToolPart {
  if (part.providerExecuted !== true || part.state !== "output-available") return part;
  const titled = withNullTitles(part);
  const native =
    options.resultFollowsCall &&
    isNativeAnthropicReplayable(titled) &&
    options.rowCiphertextChars + ciphertextChars(part.output) <=
      ANTHROPIC_NATIVE_SERVER_TOOL_MAX_ROW_CIPHERTEXT_CHARS;
  return native ? titled : demote(part);
}

/** Ciphertext the stored provider-executed parts of one row keep (only native parts keep any). */
export function rowCiphertextChars(parts: ReadonlyArray<MuxMessage["parts"][number]>): number {
  let total = 0;
  for (const part of parts) {
    if (
      part.type === "dynamic-tool" &&
      part.providerExecuted === true &&
      part.state === "output-available"
    ) {
      total += ciphertextChars(part.output);
    }
  }
  return total;
}

/** Total encryptedContent length of a replayable web_search output (an array of results). */
function ciphertextChars(output: unknown): number {
  if (!Array.isArray(output)) return 0;
  let total = 0;
  for (const item of output as Array<{ encryptedContent?: unknown }>) {
    if (typeof item.encryptedContent === "string") total += item.encryptedContent.length;
  }
  return total;
}

export interface AnthropicServerToolProjection {
  messages: MuxMessage[];
  /**
   * An assistant row has a demoted server tool with reasoning after it. That thinking is
   * bound to native blocks this request does not send, so the caller must send no Anthropic
   * thinking (the same strip as the replay receipt). It is a pure function of the rows, so
   * every request in the context segment decides the same way.
   */
  demotedBeforeThinking: boolean;
}

/**
 * Request-only projection (history on disk keeps the native identity and ciphertext).
 * `native` true: replayable parts stay provider-executed; every other provider-executed part
 * is demoted. `native` false (another provider's wire, or a request that must not send
 * Anthropic-native blocks): every provider-executed part is demoted. A demoted part replays as
 * the client pair Xum sent before #5887, without the ciphertext.
 */
export function projectAnthropicServerTools(
  messages: MuxMessage[],
  native: boolean
): AnthropicServerToolProjection {
  let demotedBeforeThinking = false;
  // Preserved thinking binds a thinking block to everything before it, earlier rows included,
  // so one demotion strips thinking that follows it anywhere later in the request.
  let demoted = false;
  const projected = messages.map((message) => {
    if (message.role !== "assistant") return message;
    // Most rows hold no server tool: return them as is, with no new parts array (perf).
    if (!message.parts.some(isProviderExecutedTool)) {
      if (demoted && message.parts.some((part) => part.type === "reasoning")) {
        demotedBeforeThinking = true;
      }
      return message;
    }
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type === "reasoning" && demoted) demotedBeforeThinking = true;
      if (part.type !== "dynamic-tool" || part.providerExecuted !== true) return part;
      if (native && isNativeAnthropicReplayable(part)) return part;
      changed = true;
      demoted = true;
      return demote(part);
    });
    return changed ? { ...message, parts } : message;
  });
  return { messages: projected, demotedBeforeThinking };
}

function isProviderExecutedTool(part: MuxMessage["parts"][number]): boolean {
  return part.type === "dynamic-tool" && part.providerExecuted === true;
}

function demote(part: DynamicToolPart): DynamicToolPart {
  const { providerExecuted: _demoted, ...clientPart } = part;
  return clientPart.state === "output-available"
    ? { ...clientPart, output: stripEncryptedContent(clientPart.output) }
    : clientPart;
}

/**
 * The SDK stream omits a null `title`, but its replay schema requires `title` as a string or
 * null. The API returned null, so null is the faithful value.
 */
function withNullTitles(part: DynamicToolPart): DynamicToolPart {
  if (part.state !== "output-available" || !Array.isArray(part.output)) return part;
  const output: unknown[] = part.output;
  const untitled = (item: unknown) =>
    typeof item === "object" && item !== null && !("title" in item);
  if (!output.some(untitled)) return part;
  return {
    ...part,
    output: output.map((item) => (untitled(item) ? { ...(item as object), title: null } : item)),
  };
}
