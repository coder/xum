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

/**
 * Remove Anthropic replay data from a keep-tail copy (regular RLM and continuous
 * compaction). Preserved thinking binds each signed block to its prefix (system,
 * tools and every earlier message). The summary replaced the rows that preceded
 * the tail, so the tail's thinking is bound to a prefix that no longer exists:
 * Anthropic would reject the request (400) or drop the blocks.
 *
 * Only the replay data goes (signature, redactedData, legacy top-level signature).
 * The parts stay, so step indices stay valid and visible continuous copies still
 * show the thinking text. Request building (stripUnsignedAnthropicReasoning) then
 * leaves the unsigned parts out of Anthropic requests. Other providers' reasoning
 * keeps its replay data.
 */
export function stripAnthropicThinkingFromTailCopy(message: MuxMessage): MuxMessage {
  if (message.role !== "assistant") return message;
  let changed = false;
  const parts = message.parts.map((part) => {
    const stripped = withoutAnthropicReplayData(part);
    if (stripped !== part) changed = true;
    return stripped;
  });
  return changed ? { ...message, parts } : message;
}
