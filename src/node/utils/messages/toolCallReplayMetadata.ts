import { CODER_GOOGLE_PROVIDER_OPTIONS_NAMESPACE } from "@/common/constants/coderOAuth";
import type { MuxMessage, MuxToolPart, ToolCallReplayMetadata } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";

// Persisted namespace -> SDK metadata namespaces it is read from. @ai-sdk/google-vertex
// writes both `googleVertex` and `vertex`; one canonical copy is kept.
const TOOL_CALL_SIGNATURE_SOURCES = [
  [CODER_GOOGLE_PROVIDER_OPTIONS_NAMESPACE, [CODER_GOOGLE_PROVIDER_OPTIONS_NAMESPACE]],
  ["google", ["google"]],
  ["googleVertex", ["googleVertex", "vertex"]],
] as const;

/**
 * Keep only the Gemini thought signatures of a tool call's provider metadata.
 * Also sanitizes persisted rows, which are read with unchecked casts.
 */
export function toolCallReplayMetadataFrom(value: unknown): ToolCallReplayMetadata | undefined {
  if (!isPlainObject(value)) return undefined;
  const metadata: ToolCallReplayMetadata = {};
  for (const [namespace, sources] of TOOL_CALL_SIGNATURE_SOURCES) {
    const thoughtSignature = sources
      .map((source) => {
        const entry = value[source];
        return isPlainObject(entry) ? entry.thoughtSignature : undefined;
      })
      .find((signature): signature is string => typeof signature === "string" && signature !== "");
    if (thoughtSignature != null) {
      metadata[namespace] = { thoughtSignature };
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Request-only: convertToModelMessages turns this into the tool call's providerOptions. */
type ToolPartWithReplayMetadata = MuxToolPart & {
  callProviderMetadata?: Record<string, { thoughtSignature: string }>;
};

/**
 * Give each persisted tool call back the thought signature its request's client
 * reads. Only `namespace` is sent: SDK converters fall back to other Gemini
 * namespaces (the compatible client reads `google`), so sending every stored
 * signature would hand one route's signature to another, or to a non-Gemini
 * endpoint after a model switch. Non-mutating.
 */
export function attachToolCallReplayMetadata(
  messages: MuxMessage[],
  namespace: string | undefined
): MuxMessage[] {
  const replayNamespace = TOOL_CALL_SIGNATURE_SOURCES.find(([name]) => name === namespace)?.[0];
  if (replayNamespace == null) return messages;
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      const signature = toolCallReplayMetadataFrom(part.providerOptions)?.[replayNamespace];
      if (signature == null) return part;
      changed = true;
      const bridged: ToolPartWithReplayMetadata = {
        ...part,
        callProviderMetadata: { [replayNamespace]: signature },
      };
      return bridged;
    });
    return changed ? { ...message, parts } : message;
  });
}
