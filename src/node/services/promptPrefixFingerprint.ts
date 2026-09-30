/**
 * Prompt-cache prefix fingerprints for the API debug log (#5254).
 *
 * Provider prompt caches key on the tool block, then the system prompt, then
 * earlier messages. A change to that prefix between turns of one workspace
 * re-reads the whole transcript uncached, so the debug log records a
 * fingerprint of the prefix on every step. Comparing consecutive steps
 * offline shows which part changed; nothing is compared at runtime, so there
 * is no shared state to keep in step with the log. These are fingerprints
 * of the SDK call input (tools and prompt), not of the provider wire bytes:
 * the SDK input does not carry a provider-native tool's cache marker, so a
 * moved tool breakpoint shows up as a tool order or options change.
 * Only computed while API debug logs are on (see devToolsMiddleware).
 */
import crypto from "node:crypto";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { stableStringify } from "@/common/utils/stableStringify";
import type { DevToolsPromptPrefix, DevToolsToolFingerprint } from "@/common/types/devtools";

function hash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(value ?? null))
    .digest("hex")
    .slice(0, 16);
}

/** Anthropic's cacheControl or OpenAI's explicit breakpoint (createOpenAICachedSystemMessage). */
function hasCacheMarker(providerOptions: unknown): boolean {
  const options = providerOptions as
    | { anthropic?: { cacheControl?: unknown }; openai?: { promptCacheBreakpoint?: unknown } }
    | undefined;
  return options?.anthropic?.cacheControl != null || options?.openai?.promptCacheBreakpoint != null;
}

export function fingerprintPromptPrefix(
  params: Pick<LanguageModelV4CallOptions, "tools" | "prompt">
): DevToolsPromptPrefix {
  const tools = (params.tools ?? []).map((tool): DevToolsToolFingerprint => {
    const isFunction = tool.type === "function";
    return {
      name: tool.name,
      description: hash(isFunction ? tool.description : tool.id),
      schema: hash(isFunction ? tool.inputSchema : tool.args),
      options: hash(isFunction ? tool.providerOptions : null),
    };
  });
  // Leading system rows: the stable prefix ends at the last cache-marked row
  // (#5251 puts volatile content in an unmarked tail row after it).
  const firstNonSystem = params.prompt.findIndex((message) => message.role !== "system");
  const systemRows = params.prompt.slice(0, firstNonSystem === -1 ? undefined : firstNonSystem);
  const lastMarked = systemRows.findLastIndex((row) => hasCacheMarker(row.providerOptions));
  const prefixEnd = lastMarked === -1 ? systemRows.length : lastMarked + 1;
  const tail = systemRows.slice(prefixEnd);
  return {
    toolsHash: hash(tools),
    tools,
    systemPrefixHash: hash(systemRows.slice(0, prefixEnd)),
    systemTailHash: tail.length > 0 ? hash(tail) : null,
  };
}
