import type { MuxMessage } from "@/common/types/message";

type MuxPart = MuxMessage["parts"][number];

function withoutAnthropicReplayData(part: MuxPart): MuxPart {
  if (part.type !== "reasoning") return part;
  const hasLegacySignature = part.signature !== undefined;
  if (part.providerOptions?.anthropic === undefined && !hasLegacySignature) return part;

  const { signature: _legacySignature, providerOptions, ...rest } = part;
  const { anthropic: _anthropic, ...otherProviders } = providerOptions ?? {};
  return Object.keys(otherProviders).length > 0
    ? { ...rest, providerOptions: otherProviders }
    : rest;
}

function withoutGeminiThoughtSignatures(part: MuxPart): MuxPart {
  if (part.type === "dynamic-tool") {
    // A tool call's providerOptions hold only Gemini thought signatures (ToolCallReplayMetadata).
    if (part.providerOptions === undefined) return part;
    const { providerOptions: _signatures, ...rest } = part;
    return rest;
  }
  if (part.type !== "reasoning") return part;
  const providerOptions = part.providerOptions;
  if (
    providerOptions === undefined ||
    (providerOptions.google === undefined && providerOptions.googleVertex === undefined)
  ) {
    return part;
  }
  const { google: _google, googleVertex: _googleVertex, ...otherProviders } = providerOptions;
  const { providerOptions: _options, ...rest } = part;
  return Object.keys(otherProviders).length > 0
    ? { ...rest, providerOptions: otherProviders }
    : rest;
}

/**
 * Remove prefix-bound replay data from a keep-tail copy (regular RLM and continuous
 * compaction, whose static copies also build the continuous prefix swap). Anthropic
 * preserved thinking and Gemini thought signatures are bound to the prefix they were
 * produced after (system, tools and every earlier message). The summary replaced the
 * rows that preceded the tail, so that prefix no longer exists: Anthropic would reject
 * the request (400) or drop the blocks, and Gemini 4 Hydrogen rejects a signature whose
 * prefix changed (400) unless the request asks it to drop them.
 *
 * Only the replay data goes (Anthropic signature, redactedData and legacy top-level
 * signature; Gemini thoughtSignature on reasoning parts and tool calls). The parts stay,
 * so step indices stay valid and visible continuous copies still show the thinking text.
 * Request building (stripUnsignedAnthropicReasoning) then leaves the unsigned parts out
 * of Anthropic requests. Gemini returns 400 for a missing signature only on a function
 * call in the active turn, and a copy is never in it: a user row, or the [CONTINUE]
 * sentinel that request building adds after a partial row, always follows the copies
 * before the next model response. OpenAI and xAI reasoning keeps its replay data.
 */
export function stripPrefixBoundReplayFromTailCopy(message: MuxMessage): MuxMessage {
  if (message.role !== "assistant") return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    const stripped = withoutGeminiThoughtSignatures(withoutAnthropicReplayData(part));
    if (stripped !== part) changed = true;
    return stripped;
  });
  return changed ? { ...message, parts } : message;
}
