/**
 * Anthropic prompt-cache prefix fingerprints.
 *
 * Anthropic caches a request as an ordered prefix: tools, then system, then
 * messages, and a change at one level invalidates that level and every later
 * one. This module reduces a final wire body to an ordered block list (hashes
 * plus content-free metadata) that follows Anthropic's cache invalidation
 * table (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#what-invalidates-your-cache):
 *
 * 1. Tool definitions. Deferred tools (`defer_loading`) are not part of the
 *    prefix, and native web search and web fetch entries only invalidate
 *    system and messages, so both stay out of this section.
 * 2. A system sentinel: each native web search / web fetch entry with its
 *    configuration, whether any document enables citations ("Toggling web
 *    search or citations: system and messages caches"), the request `speed`
 *    (switching Fast mode invalidates system and messages), and the
 *    structured-output `output_config.format` (Anthropic adds a system
 *    prompt for it, so changing it invalidates system and messages).
 * 3. The leading system blocks.
 * 4. A messages sentinel: `thinking`, `output_config.effort` and
 *    `tool_choice` (which carries `disable_parallel_tool_use` on the wire),
 *    and whether any image is present ("Messages cache").
 * 5. Every message content block in order. A mid-conversation `role:
 *    "system"` message stays in place: it extends the cached prefix.
 *
 * A request reuses the cache up to the first differing block, so a follow-up
 * request stays warm only when the previous request's blocks are a prefix of
 * its own. cache_control markers move to the newest block on every request,
 * so they are removed before hashing, but only where Anthropic accepts them.
 *
 * The AI SDK prompt form (DevTools records, the mux-gateway wire) carries no
 * call-level options, so its messages sentinel only reflects images.
 *
 * Scope: the fingerprint deliberately does not model the model id (callers
 * compare only requests of one model and route: the runtime monitor's route
 * key and the replay audit's model check), beta headers such as 1M context
 * (they are not part of the body), or the inline expansion of a deferred
 * tool's definition at its `tool_reference` block (a definition change of a
 * deferred tool that was already referenced is not detected). A cold start
 * with no reported break therefore means a cause outside the fingerprinted
 * body. Server-side context editing (`context_management`) clears older
 * blocks by a strategy the body does not show, so a request that carries it
 * is not modeled: comparing with it returns `unsupported`, and callers
 * neither report a break nor use it as a baseline for one.
 */

import { createHash } from "node:crypto";
import { isDeferLoadingTool } from "@/common/utils/tools/toolCatalog";

export const PROMPT_CACHE_SECTIONS = ["tools", "system", "messages"] as const;
export type PromptCacheSection = (typeof PROMPT_CACHE_SECTIONS)[number];

/** Content-free description of one block: safe to log and to record on the timeline. */
export interface PromptCacheBlockSummary {
  /** "tool" for tool definitions, "system", "request" for a sentinel, or the message role. */
  role: string;
  type: string;
  /** Serialized length in characters, without cache markers. */
  length: number;
  toolName?: string;
}

export interface PromptCacheBlock extends PromptCacheBlockSummary {
  section: PromptCacheSection;
  hash: string;
  /** Set on the single block of a request the fingerprint does not model (see Scope). */
  unsupported?: PromptCacheUnsupportedReason;
}

export type PromptCacheUnsupportedReason = "context_management";

export interface PromptCachePrefixBreak {
  kind: "break";
  section: PromptCacheSection;
  /** Index of the first differing block; equals the number of blocks that still matched. */
  blockIndex: number;
  previousBlockCount: number;
  nextBlockCount: number;
  previous: PromptCacheBlockSummary;
  /** Absent when the next request is shorter than the previous one. */
  next?: PromptCacheBlockSummary;
}

export type PromptCachePrefixComparison =
  | { kind: "extends" }
  | PromptCachePrefixBreak
  | { kind: "unsupported"; reason: PromptCacheUnsupportedReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : undefined;
}

/**
 * The parts of one block Anthropic sees, without its cache marker: drop
 * block-level `cache_control` (Messages API) and reduce `providerOptions` to
 * the `anthropic` namespace without `cacheControl` (AI SDK prompt form; other
 * namespaces such as `mux` never reach the wire). Nested application JSON
 * (tool schemas, tool input) is left untouched.
 */
function withoutBlockMarker(block: Record<string, unknown>): Record<string, unknown> {
  const { cache_control: _marker, providerOptions, ...rest } = block;
  const anthropic = isRecord(providerOptions) ? providerOptions.anthropic : undefined;
  if (!isRecord(anthropic)) return rest;
  const { cacheControl: _cacheControl, ...anthropicRest } = anthropic;
  return Object.keys(anthropicRest).length > 0
    ? { ...rest, providerOptions: { anthropic: anthropicRest } }
    : rest;
}

/** A message content block as Anthropic sees it, including the blocks nested in a tool result. */
function normalizeContentBlock(part: unknown): unknown {
  // A string content is one text block on the wire, so `content: "hi"` and
  // `content: [{ type: "text", text: "hi" }, ...]` share a prefix.
  if (typeof part === "string") return { type: "text", text: part };
  if (!isRecord(part)) return part;
  const block = withoutBlockMarker(part);
  // Blocks inside a wire tool_result accept their own cache_control.
  if (block.type === "tool_result" && Array.isArray(block.content)) {
    block.content = (block.content as unknown[]).map((nested) =>
      isRecord(nested) ? withoutBlockMarker(nested) : nested
    );
  }
  return dropDefaultToolCaller(block);
}

const NATIVE_SERVER_TOOL = /^(anthropic\.)?web_(search|fetch)_\d+$/;

/** Native web search / web fetch: wire `type: "web_search_20250305"`, prompt form `id: "anthropic.web_search_20250305"`. */
function nativeServerToolType(tool: Record<string, unknown>): string | undefined {
  const id = typeof tool.id === "string" ? tool.id : tool.type;
  return typeof id === "string" && NATIVE_SERVER_TOOL.test(id)
    ? id.replace(/^anthropic\./, "")
    : undefined;
}

function isImage(part: Record<string, unknown>): boolean {
  const mediaType = part.mediaType ?? part.media_type;
  return (
    part.type === "image" ||
    (typeof part.type === "string" && part.type.startsWith("image-")) ||
    (typeof mediaType === "string" && mediaType.startsWith("image/"))
  );
}

/**
 * Whether a content block, or a block inside its tool result, matches: wire
 * `tool_result.content`, or the prompt form's tool-result `output: { type: "content", value }`.
 * Tool results hold documents, search results and images (screenshots).
 */
function someBlock(part: unknown, matches: (block: Record<string, unknown>) => boolean): boolean {
  if (!isRecord(part)) return false;
  if (matches(part)) return true;
  const nested: unknown[] = Array.isArray(part.content)
    ? part.content
    : isRecord(part.output) && Array.isArray(part.output.value)
      ? part.output.value
      : [];
  return nested.some((item) => isRecord(item) && matches(item));
}

function enablesCitations(part: Record<string, unknown>): boolean {
  const anthropic = isRecord(part.providerOptions) ? part.providerOptions.anthropic : undefined;
  const citations = part.citations ?? (isRecord(anthropic) ? anthropic.citations : undefined);
  return isRecord(citations) && citations.enabled === true;
}

/**
 * Anthropic adds `caller: { type: "direct" }` to tool_use blocks in responses, and the AI SDK
 * echoes it on in-turn steps, while a rebuild from chat.jsonl omits it. Direct is the default
 * caller and both forms read the same cache entry (measured through the Coder gateway on
 * Haiku 4.5: the next turn read the full prefix), so it must not count as a break. Other
 * callers (programmatic tool calling) change the block and stay in the hash.
 */
function isDefaultCaller(caller: unknown): boolean {
  return isRecord(caller) && caller.type === "direct" && Object.keys(caller).length === 1;
}

function dropDefaultToolCaller(block: unknown): unknown {
  if (!isRecord(block) || typeof block.type !== "string") return block;
  // Messages API wire form: `{ type: "tool_use", ..., caller }`.
  if (block.type.endsWith("tool_use") && isDefaultCaller(block.caller)) {
    const { caller: _caller, ...rest } = block;
    return rest;
  }
  // AI SDK prompt form (DevTools records, gateway wire): `providerOptions.anthropic.caller`,
  // which the SDK also copies onto the matching tool-result part.
  const providerOptions = block.providerOptions;
  const anthropic = isRecord(providerOptions) ? providerOptions.anthropic : undefined;
  const isToolPart = block.type === "tool-call" || block.type === "tool-result";
  if (!isToolPart || !isRecord(anthropic) || !isDefaultCaller(anthropic.caller)) {
    return block;
  }
  const { caller: _caller, ...anthropicRest } = anthropic;
  const { anthropic: _anthropic, ...optionsRest } = providerOptions as Record<string, unknown>;
  const options =
    Object.keys(anthropicRest).length > 0
      ? { ...optionsRest, anthropic: anthropicRest }
      : optionsRest;
  const { providerOptions: _providerOptions, ...rest } = block;
  return Object.keys(options).length > 0 ? { ...rest, providerOptions: options } : rest;
}

/**
 * Fingerprint a final Anthropic request body: the Messages API form (`tools`,
 * `system`, `messages`) or the AI SDK prompt form (`tools`, `prompt` with
 * system messages inline).
 */
export function fingerprintAnthropicRequest(body: Record<string, unknown>): PromptCacheBlock[] {
  if (body.context_management != null) {
    const unsupported = "context_management";
    return [
      { section: "tools", role: "request", type: "unsupported", length: 0, hash: "", unsupported },
    ];
  }
  const blocks: PromptCacheBlock[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const push = (section: PromptCacheSection, role: string, value: unknown): void => {
    const serialized = JSON.stringify(value) ?? "null";
    const record = isRecord(value) ? value : {};
    const type = label(record.type) ?? (section === "tools" ? "tool" : typeof value);
    const named = section === "tools" || type.endsWith("tool_use");
    let toolName = label(record.toolName) ?? (named ? label(record.name) : undefined);
    const callId = label(record.id) ?? label(record.toolCallId);
    if (toolName != null && callId != null) toolNamesByCallId.set(callId, toolName);
    const resultId = label(record.tool_use_id);
    toolName ??= resultId != null ? toolNamesByCallId.get(resultId) : undefined;
    const hash = createHash("sha256").update(`${section}\0${role}\0${serialized}`).digest("hex");
    blocks.push({
      section,
      role,
      type,
      length: serialized.length,
      ...(toolName != null ? { toolName } : {}),
      hash: hash.slice(0, 16),
    });
  };
  const contentOf = (content: unknown): unknown[] =>
    Array.isArray(content) ? content : content != null ? [content] : [];

  const rawMessages: unknown = Array.isArray(body.messages) ? body.messages : body.prompt;
  const messages = (Array.isArray(rawMessages) ? (rawMessages as unknown[]) : []).map((message) => {
    const content = contentOf(isRecord(message) ? message.content : message);
    // Message-level Anthropic options (prompt form: a system message's `clearAt`, `effort`,
    // `toolChanges`) are serialized into its wire blocks, so they count as a leading block.
    const options = isRecord(message)
      ? withoutBlockMarker({ providerOptions: message.providerOptions })
      : {};
    return {
      role: (isRecord(message) ? label(message.role) : undefined) ?? "unknown",
      content:
        Object.keys(options).length > 0
          ? [{ type: "message-options", ...options }, ...content]
          : content,
    };
  });
  // Only the prompt form's leading system messages are the top-level system
  // prompt; a later one is a mid-conversation system message.
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  const leadingSystemCount = Array.isArray(body.messages)
    ? 0
    : firstNonSystem === -1
      ? messages.length
      : firstNonSystem;
  const allParts = messages.flatMap((message) => message.content);

  // Configuration, not only presence: changing an argument such as `max_uses` invalidates too.
  const serverTools: Array<{ type: string; config: Record<string, unknown> }> = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) {
      push("tools", "tool", tool);
      continue;
    }
    const serverTool = nativeServerToolType(tool);
    if (serverTool != null) {
      serverTools.push({ type: serverTool, config: withoutBlockMarker(tool) });
    } else if (tool.defer_loading !== true && !isDeferLoadingTool(tool)) {
      push("tools", "tool", withoutBlockMarker(tool));
    }
  }
  push("system", "request", {
    type: "system_options",
    serverTools: serverTools
      .map((entry) => ({ ...entry, key: JSON.stringify(entry.config) }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key))
      .map((entry) => entry.config),
    citations: allParts.some((part) => someBlock(part, enablesCitations)),
    // Absent means standard speed, so an explicit "standard" is the same request.
    speed: typeof body.speed === "string" ? body.speed : "standard",
    format: isRecord(body.output_config) ? (body.output_config.format ?? null) : null,
  });
  for (const part of contentOf(body.system)) push("system", "system", normalizeContentBlock(part));
  for (const message of messages.slice(0, leadingSystemCount)) {
    for (const part of message.content) push("system", "system", normalizeContentBlock(part));
  }
  push("messages", "request", {
    type: "message_options",
    thinking: body.thinking ?? null,
    effort: isRecord(body.output_config) ? (body.output_config.effort ?? null) : null,
    toolChoice: body.tool_choice ?? null,
    images: allParts.some((part) => someBlock(part, isImage)),
  });
  for (const message of messages.slice(leadingSystemCount)) {
    for (const part of message.content) {
      push("messages", message.role, normalizeContentBlock(part));
    }
  }
  return blocks;
}

function summarize(block: PromptCacheBlock): PromptCacheBlockSummary {
  const { section: _section, hash: _hash, ...summary } = block;
  return summary;
}

/**
 * "extends" when every previous block starts the next request unchanged
 * (identical included); "unsupported" when either request is one the
 * fingerprint does not model.
 */
export function comparePromptCachePrefix(
  previous: readonly PromptCacheBlock[],
  next: readonly PromptCacheBlock[]
): PromptCachePrefixComparison {
  const unsupported = [...previous, ...next].find(
    (block) => block.unsupported != null
  )?.unsupported;
  if (unsupported != null) return { kind: "unsupported", reason: unsupported };
  let index = 0;
  while (
    index < previous.length &&
    index < next.length &&
    previous[index].hash === next[index].hash
  ) {
    index++;
  }
  if (index === previous.length) return { kind: "extends" };
  const previousBlock = previous[index];
  const nextBlock = next.at(index);
  // A tool appended to the tool list lines up against the first system block:
  // the break belongs to the earlier section.
  const order = (block: PromptCacheBlock) => PROMPT_CACHE_SECTIONS.indexOf(block.section);
  const section =
    nextBlock != null && order(nextBlock) < order(previousBlock)
      ? nextBlock.section
      : previousBlock.section;
  return {
    kind: "break",
    section,
    blockIndex: index,
    previousBlockCount: previous.length,
    nextBlockCount: next.length,
    previous: summarize(previousBlock),
    ...(nextBlock != null ? { next: summarize(nextBlock) } : {}),
  };
}

function describeBlock(block: PromptCacheBlockSummary | undefined): string {
  if (block == null) return "(end of request)";
  const tool = block.toolName != null ? ` ${block.toolName}` : "";
  return `${block.role} ${block.type}${tool} (${block.length} chars)`;
}

/** One-line, content-free description of a break for logs, timelines and CLIs. */
export function describePromptCacheBreak(comparison: PromptCachePrefixBreak): string {
  return (
    `Prompt cache prefix broke in ${comparison.section} at block ${comparison.blockIndex} ` +
    `of ${comparison.previousBlockCount}: ` +
    `${describeBlock(comparison.previous)} -> ${describeBlock(comparison.next)}`
  );
}
