/**
 * Prompt-cache prefix fingerprints for the API debug log (#5254).
 *
 * Provider prompt caches key on the tool block, then the system prompt, then
 * earlier messages. A change to that prefix between turns of one workspace
 * re-reads the whole transcript uncached, so the debug log records what the
 * prefix was and, when it changed, which part changed. These are fingerprints
 * of the SDK call input (tools and prompt), not of the provider wire bytes:
 * the SDK input does not carry a provider-native tool's cache marker, so a
 * moved tool breakpoint shows up as a tool order or options change.
 * Only computed while API debug logs are on (see devToolsMiddleware).
 */
import crypto from "node:crypto";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { stableStringify } from "@/common/utils/stableStringify";
import type { DevToolsPromptPrefix } from "@/common/types/devtools";

interface ToolFingerprint {
  name: string;
  description: string;
  schema: string;
  options: string;
}

/** The step record's fields plus per-tool hashes, kept only as the comparison baseline. */
export interface PromptPrefixFingerprint extends Omit<DevToolsPromptPrefix, "change"> {
  tools: ToolFingerprint[];
}

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
): PromptPrefixFingerprint {
  const tools = (params.tools ?? []).map((tool): ToolFingerprint => {
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
    systemPrefixHash: hash(systemRows.slice(0, prefixEnd)),
    systemTailHash: tail.length > 0 ? hash(tail) : null,
    tools,
  };
}

/** Names what changed between two consecutive live requests, in prefix order. */
export function diffPromptPrefix(
  previous: PromptPrefixFingerprint,
  next: PromptPrefixFingerprint
): string[] {
  const components: string[] = [];
  if (previous.toolsHash !== next.toolsHash) {
    const before = new Map(previous.tools.map((tool) => [tool.name, tool]));
    const after = new Map(next.tools.map((tool) => [tool.name, tool]));
    for (const name of after.keys()) if (!before.has(name)) components.push(`tool-added:${name}`);
    for (const name of before.keys()) if (!after.has(name)) components.push(`tool-removed:${name}`);
    const shared = (tools: ToolFingerprint[], other: Map<string, ToolFingerprint>) =>
      tools.filter((tool) => other.has(tool.name)).map((tool) => tool.name);
    if (shared(previous.tools, after).join("\n") !== shared(next.tools, before).join("\n")) {
      components.push("tool-order");
    }
    for (const tool of next.tools) {
      const old = before.get(tool.name);
      if (old == null) continue;
      if (old.description !== tool.description) components.push(`tool-description:${tool.name}`);
      if (old.schema !== tool.schema) components.push(`tool-schema:${tool.name}`);
      // Includes a moved cache marker.
      if (old.options !== tool.options) components.push(`tool-options:${tool.name}`);
    }
  }
  if (previous.systemPrefixHash !== next.systemPrefixHash) components.push("system-prefix");
  else if (previous.systemTailHash !== next.systemTailHash) components.push("system-tail-only");
  return components;
}
