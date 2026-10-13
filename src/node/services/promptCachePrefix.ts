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
 *    "system"` message stays in place: it extends the cached prefix. A block
 *    with a `tool_reference` also hashes the referenced tool's definition,
 *    because Anthropic expands the reference into that definition in place.
 *    On models that keep only the current turn's thinking (see
 *    stripsEarlierTurnThinking), earlier turns' thinking blocks are left out,
 *    as Anthropic strips them.
 *
 * Each sentinel also keeps its options beside the hash (server tools and the
 * format only as a digest), so a break in a sentinel names the options that
 * changed.
 *
 * A request reuses the cache up to the first differing block, so a follow-up
 * request stays warm only when the previous request's blocks are a prefix of
 * its own. cache_control markers move to the newest block on every request,
 * so they are removed before hashing, but only where Anthropic accepts them.
 *
 * The AI SDK prompt form (DevTools records, the mux-gateway wire) carries no
 * call-level options, so its messages sentinel only reflects images. Its
 * leading system messages follow the pinned converter, which sends only their
 * text (see leadingSystemBlocks).
 *
 * Scope: the fingerprint deliberately does not hash the model id (callers
 * compare only requests of one model and route: the runtime monitor's route
 * key and the replay audit's model check). Beta headers are not part of the
 * body and are not modeled: every beta the AI SDK adds follows from a body
 * field the fingerprint already hashes, and the one Xum adds itself (1M
 * context on Sonnet 4 and 4.5) does not change the cache (measured through the
 * Coder gateway on Sonnet 4.5: a request with the header read the whole prefix
 * the request without it wrote). A cold start with no reported break
 * therefore means a cause outside the fingerprinted body. Server-side context
 * editing (`context_management`) clears older blocks by a strategy the body does not show, so a request that carries it
 * is not modeled: comparing with it returns `unsupported`, and callers
 * neither report a break nor use it as a baseline for one.
 */

import { createHash } from "node:crypto";
import {
  describeChangedOption,
  type PromptCacheChangedOption,
  type PromptCacheOptionValue,
} from "@/common/utils/ai/promptCacheChangedOption";
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
  /**
   * Only on the `system_options` and `message_options` sentinels: each option
   * as reported (a digest for KEY_ONLY_OPTIONS), so a break can name the
   * option that changed. The hash still decides whether the block matched.
   */
  options?: Record<string, PromptCacheOptionValue>;
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
  /** Set when both first differing blocks are the same options sentinel. */
  changedOptions?: PromptCacheChangedOption[];
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
 * Options a break names by key only: server tool configurations hold
 * arguments (domains, locations) and the structured-output format holds a
 * JSON schema with its descriptions. They are kept as a digest.
 */
const KEY_ONLY_OPTIONS = new Set(["serverTools", "format"]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The reportable form of one sentinel's options (see PromptCacheBlock.options). */
function optionValues(sentinel: Record<string, unknown>): Record<string, PromptCacheOptionValue> {
  const values: Record<string, PromptCacheOptionValue> = {};
  for (const [key, value] of Object.entries(sentinel)) {
    if (key === "type") continue;
    const serialized = JSON.stringify(value) ?? "null";
    if (KEY_ONLY_OPTIONS.has(key)) values[key] = sha256(serialized).slice(0, 16);
    else if (typeof value === "string") values[key] = value.slice(0, 128);
    else if (value === null || typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
    } else values[key] = serialized.slice(0, 128);
  }
  return values;
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

function anthropicOptionsOf(part: Record<string, unknown>): Record<string, unknown> {
  const anthropic = isRecord(part.providerOptions) ? part.providerOptions.anthropic : undefined;
  return isRecord(anthropic) ? anthropic : {};
}

/**
 * The converter sends a referenced file with `containerUpload` as a `container_upload`
 * block before it looks at the media type, so an image file sent that way is no image.
 */
function isContainerUpload(part: Record<string, unknown>): boolean {
  return (
    part.type === "file" &&
    isRecord(part.data) &&
    part.data.type === "reference" &&
    anthropicOptionsOf(part).containerUpload === true
  );
}

function sendsImage(part: Record<string, unknown>): boolean {
  return isImage(part) && !isContainerUpload(part);
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
  const citations = part.citations ?? anthropicOptionsOf(part).citations;
  return isRecord(citations) && citations.enabled === true;
}

/** `tool_name` of each wire `tool_reference` in a block list. */
function wireReferenceNames(list: unknown): unknown[] {
  return (Array.isArray(list) ? list : [])
    .filter(isRecord)
    .filter((item) => item.type === "tool_reference")
    .map((item) => item.tool_name);
}

function customReferenceNames(parts: unknown[]): unknown[] {
  return parts
    .map((item) => (isRecord(item) && item.type === "custom" ? anthropicOptionsOf(item) : {}))
    .filter((anthropic) => anthropic.type === "tool-reference")
    .map((anthropic) => anthropic.toolName);
}

/**
 * A prompt-form tool result's references, where the pinned converter reads them
 * (`convertToAnthropicPrompt`): a client tool result's `output: { type: "content" }` parts of
 * type `custom` with `providerOptions.anthropic.type: "tool-reference"`, and the
 * `output: { type: "json" }` of a provider-executed tool search, which the converter sends
 * as a `tool_search_tool_result`. Any other JSON output is sent as text: application data.
 */
function promptResultReferenceNames(
  part: Record<string, unknown>,
  role: string,
  toolSearchNames: ReadonlySet<string>
): unknown[] {
  const output = isRecord(part.output) ? part.output : {};
  const value = Array.isArray(output.value) ? (output.value as unknown[]) : [];
  if (output.type === "content") return customReferenceNames(value);
  const isToolSearch =
    role === "assistant" && output.type === "json" && toolSearchNames.has(String(part.toolName));
  return isToolSearch
    ? value
        .filter(isRecord)
        .filter((item) => item.type === "tool_reference")
        .map((item) => item.toolName)
    : [];
}

/**
 * Names of the tools a message block references, read only from the protocol fields that
 * carry references (never from tool input or a tool result's own JSON): a wire
 * `tool_result.content` list, a wire `tool_search_tool_result`, a wire `tool_addition`, a
 * prompt-form tool result (see promptResultReferenceNames), and the `tool_addition`s of a
 * mid-conversation system message's `toolChanges`. A removal names a tool without loading
 * its definition, so it is no expansion. Anthropic expands each reference into the
 * referenced tool's full definition at that position.
 */
function toolReferenceNames(
  block: Record<string, unknown>,
  role: string,
  toolSearchNames: ReadonlySet<string>
): unknown[] {
  switch (block.type) {
    case "tool_result":
      return wireReferenceNames(block.content);
    case "tool_search_tool_result":
      return wireReferenceNames(searchReferences(block.content));
    case "tool_addition":
      return wireAdditionNames(block.tool);
    case "tool-result":
      return promptResultReferenceNames(block, role, toolSearchNames);
    case "message-options":
      return toolAdditionNames(anthropicOptionsOf(block).toolChanges);
    default:
      return [];
  }
}

function searchReferences(content: unknown): unknown {
  return isRecord(content) ? content.tool_references : undefined;
}

/** A wire `tool_addition` names its tool as `tool: { type: "tool_reference", name }`. */
function wireAdditionNames(tool: unknown): unknown[] {
  return isRecord(tool) && tool.type === "tool_reference" ? [tool.name] : [];
}

function toolAdditionNames(changes: unknown): unknown[] {
  return (Array.isArray(changes) ? changes : [])
    .filter(isRecord)
    .filter((change) => change.type === "tool_addition")
    .map((change) => change.toolName);
}

/** Prompt-form names of the provider tool search tools (`anthropic.tool_search_*`). */
function toolSearchToolNames(tools: unknown): Set<string> {
  return new Set(
    (Array.isArray(tools) ? tools : [])
      .filter(isRecord)
      .filter(
        (tool) =>
          typeof tool.id === "string" && /^anthropic\.tool_search_(regex|bm25)_\d+$/.test(tool.id)
      )
      .map((tool) => String(tool.name))
  );
}

/**
 * The definitions of the tools a block references, as an extra hash input: Anthropic
 * expands a tool_reference into the tool's definition in place, so a changed definition
 * of a referenced deferred tool changes this block (measured through the Coder gateway on
 * Haiku 4.5 for a tool result and on Haiku 5.5 for a tool_addition; changing an
 * unreferenced deferred tool kept the whole prefix).
 */
function referencedDefinitions(
  value: unknown,
  role: string,
  context: { toolDefinitions: Map<string, unknown>; toolSearchNames: ReadonlySet<string> }
): string {
  if (!isRecord(value)) return "";
  const names = toolReferenceNames(value, role, context.toolSearchNames).filter(
    (name): name is string => typeof name === "string"
  );
  if (names.length === 0) return "";
  return `\0${JSON.stringify(names.map((name) => context.toolDefinitions.get(name) ?? null))}`;
}

function claudeVersion(modelId: string): { family: string; version: number } | undefined {
  // Current ids: claude-<family>-<major>[-<minor>][-<date>]; a date is not a minor version.
  // Some routes write the minor with a dot (claude-opus-4.5). An id that does not end the
  // version cleanly (claude-opus-4.x) is unknown, not an older model.
  const current = /claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?(?![.\d])/.exec(modelId);
  if (current != null) {
    return { family: current[1], version: Number(current[2]) + Number(current[3] ?? 0) / 10 };
  }
  // Claude 3 ids: claude-3[-<minor>]-<family>.
  const legacy = /claude-(\d)(?:[-.](\d))?-(opus|sonnet|haiku)/.exec(modelId);
  return legacy != null
    ? { family: legacy[3], version: Number(legacy[1]) + Number(legacy[2] ?? 0) / 10 }
    : undefined;
}

/**
 * Whether Anthropic keeps only the current turn's thinking for this model. On these
 * models, once a user message holds anything other than tool results, the API strips
 * every earlier thinking block from the prompt, so those blocks leave the cached prefix
 * (https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-block-preservation-by-model:
 * earlier Opus and Sonnet models, all Haiku models through Haiku 4.5). Measured through
 * the Coder gateway: on Haiku 4.5 a new user message, or text next to a tool result, read
 * the cache only up to the first thinking block; Sonnet 4.6 read the whole prefix.
 * Unknown models keep all thinking, like every model the docs list after these.
 */
export function stripsEarlierTurnThinking(modelId: string): boolean {
  const parsed = claudeVersion(modelId);
  if (parsed == null) return false;
  if (parsed.family === "opus") return parsed.version < 4.5;
  if (parsed.family === "sonnet") return parsed.version < 4.6;
  return parsed.version <= 4.5;
}

const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);

function isToolResult(part: unknown): boolean {
  return isRecord(part) && (part.type === "tool_result" || part.type === "tool-result");
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
 * The AI SDK Anthropic converter sends a prompt-form `reasoning` part only as a signed
 * `thinking` block or a `redacted_thinking` block. A part with neither (the `"..."`
 * placeholder ensureAnthropicThinkingBeforeToolCalls adds before tool calls on rebuild) is
 * dropped with a warning, so it never reaches Anthropic and must not count as a block.
 */
function isUnsentReasoning(part: unknown): boolean {
  if (!isRecord(part) || part.type !== "reasoning") return false;
  const anthropic = isRecord(part.providerOptions) ? part.providerOptions.anthropic : undefined;
  return !isRecord(anthropic) || (anthropic.signature == null && anthropic.redactedData == null);
}

interface FingerprintMessage {
  role: string;
  content: unknown[];
}

/**
 * The blocks one leading prompt-form system message sends, by the pinned converter's
 * initial-system rule (`convertToAnthropicPrompt`): only its text reaches top-level
 * `system`, and none when the message carries options but no text. Tool changes are
 * dropped there. `clearAt` and `effort` are dropped too, except that an effort-only
 * message with empty text becomes a `role: "system"` message at the start of `messages`.
 */
function leadingSystemBlocks(message: Record<string, unknown>): {
  system: unknown[];
  messages: unknown[];
} {
  if (typeof message.content !== "string")
    return { system: contentOf(message.content), messages: [] };
  const anthropic = anthropicOptionsOf(message);
  const text = message.content;
  const effortOnly =
    text === "" &&
    anthropic.effort != null &&
    !hasSystemMessageOptions({ ...anthropic, effort: undefined });
  return {
    system: text !== "" || !hasSystemMessageOptions(anthropic) ? [text] : [],
    messages: effortOnly
      ? [{ type: "message-options", providerOptions: { anthropic: { effort: anthropic.effort } } }]
      : [],
  };
}

function hasSystemMessageOptions(anthropic: Record<string, unknown>): boolean {
  const toolChanges = Array.isArray(anthropic.toolChanges) ? anthropic.toolChanges : [];
  return toolChanges.length > 0 || anthropic.clearAt != null || anthropic.effort != null;
}

function roleOf(message: unknown): string {
  return (isRecord(message) ? label(message.role) : undefined) ?? "unknown";
}

/**
 * The messages after the top-level system prompt, as Anthropic keeps them. Message-level
 * Anthropic options (prompt form: a mid-conversation system message's `clearAt`, `effort`,
 * `toolChanges`) are serialized into its wire message, so they count as a leading block.
 */
function conversationMessages(raw: unknown[], modelId: string | undefined): FingerprintMessage[] {
  const messages = raw.map((message) => {
    const content = contentOf(isRecord(message) ? message.content : message);
    const options = isRecord(message)
      ? withoutBlockMarker({ providerOptions: message.providerOptions })
      : {};
    const optionBlocks =
      Object.keys(options).length > 0 ? [{ type: "message-options", ...options }] : [];
    return { role: roleOf(message), content: [...optionBlocks, ...content] };
  });
  return modelId != null && stripsEarlierTurnThinking(modelId)
    ? withoutEarlierTurnThinking(messages)
    : messages;
}

function contentOf(content: unknown): unknown[] {
  return Array.isArray(content) ? content : content != null ? [content] : [];
}

/**
 * Drop the thinking blocks a last-turn-only model strips (see stripsEarlierTurnThinking):
 * those of every message before the last user message that holds anything other than tool
 * results. The thinking of the current tool-use loop stays.
 */
function withoutEarlierTurnThinking(messages: FingerprintMessage[]): FingerprintMessage[] {
  const lastTurn = messages.findLastIndex(
    (message) => message.role === "user" && message.content.some((part) => !isToolResult(part))
  );
  return messages.map((message, index) =>
    index < lastTurn && message.role === "assistant"
      ? {
          ...message,
          content: message.content.filter(
            (part) => !(isRecord(part) && THINKING_TYPES.has(String(part.type)))
          ),
        }
      : message
  );
}

/**
 * Fingerprint a final Anthropic request body: the Messages API form (`tools`,
 * `system`, `messages`) or the AI SDK prompt form (`tools`, `prompt` with
 * system messages inline). `modelId` names the model when the body does not
 * (`model`, Messages API form only); it selects the thinking-preservation rule.
 */
export function fingerprintAnthropicRequest(
  body: Record<string, unknown>,
  options: { modelId?: string } = {}
): PromptCacheBlock[] {
  if (body.context_management != null) {
    const unsupported = "context_management";
    return [
      { section: "tools", role: "request", type: "unsupported", length: 0, hash: "", unsupported },
    ];
  }
  const blocks: PromptCacheBlock[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const toolDefinitions = new Map<string, unknown>();
  const referenceContext = { toolDefinitions, toolSearchNames: toolSearchToolNames(body.tools) };
  const push = (section: PromptCacheSection, role: string, value: unknown): PromptCacheBlock => {
    const serialized = JSON.stringify(value) ?? "null";
    const record = isRecord(value) ? value : {};
    const type = label(record.type) ?? (section === "tools" ? "tool" : typeof value);
    const named = section === "tools" || type.endsWith("tool_use");
    let toolName = label(record.toolName) ?? (named ? label(record.name) : undefined);
    const callId = label(record.id) ?? label(record.toolCallId);
    if (toolName != null && callId != null) toolNamesByCallId.set(callId, toolName);
    const resultId = label(record.tool_use_id);
    toolName ??= resultId != null ? toolNamesByCallId.get(resultId) : undefined;
    // Tool definitions hold application JSON, not references.
    const expansion =
      section === "tools" ? "" : referencedDefinitions(value, role, referenceContext);
    const hash = sha256(`${section}\0${role}\0${serialized}${expansion}`);
    const block: PromptCacheBlock = {
      section,
      role,
      type,
      length: serialized.length,
      ...(toolName != null ? { toolName } : {}),
      hash: hash.slice(0, 16),
    };
    blocks.push(block);
    return block;
  };
  // The sentinel is hashed as before; its options are kept beside the hash.
  const pushOptions = (section: PromptCacheSection, sentinel: Record<string, unknown>): void => {
    push(section, "request", sentinel).options = optionValues(sentinel);
  };

  const rawMessages: unknown = Array.isArray(body.messages) ? body.messages : body.prompt;
  const rawList = Array.isArray(rawMessages) ? (rawMessages as unknown[]) : [];
  // Only the prompt form's leading system messages are the top-level system
  // prompt; a later one is a mid-conversation system message.
  const firstNonSystem = rawList.findIndex((message) => roleOf(message) !== "system");
  const leadingSystemCount = Array.isArray(body.messages)
    ? 0
    : firstNonSystem === -1
      ? rawList.length
      : firstNonSystem;
  const leading = rawList.slice(0, leadingSystemCount).filter(isRecord).map(leadingSystemBlocks);
  const messages = conversationMessages(
    rawList.slice(leadingSystemCount),
    typeof body.model === "string" ? body.model : options.modelId
  );
  const allParts = [
    ...leading.flatMap((entry) => [...entry.system, ...entry.messages]),
    ...messages.flatMap((message) => message.content),
  ];

  // Configuration, not only presence: changing an argument such as `max_uses` invalidates too.
  const serverTools: Array<{ type: string; config: Record<string, unknown> }> = [];
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) {
      push("tools", "tool", tool);
      continue;
    }
    if (typeof tool.name === "string") toolDefinitions.set(tool.name, withoutBlockMarker(tool));
    const serverTool = nativeServerToolType(tool);
    if (serverTool != null) {
      serverTools.push({ type: serverTool, config: withoutBlockMarker(tool) });
    } else if (tool.defer_loading !== true && !isDeferLoadingTool(tool)) {
      push("tools", "tool", withoutBlockMarker(tool));
    }
  }
  pushOptions("system", {
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
  for (const part of leading.flatMap((entry) => entry.system)) {
    push("system", "system", normalizeContentBlock(part));
  }
  pushOptions("messages", {
    type: "message_options",
    thinking: body.thinking ?? null,
    effort: isRecord(body.output_config) ? (body.output_config.effort ?? null) : null,
    toolChoice: body.tool_choice ?? null,
    images: allParts.some((part) => someBlock(part, sendsImage)),
  });
  for (const part of leading.flatMap((entry) => entry.messages)) push("messages", "system", part);
  for (const message of messages) {
    for (const part of message.content.filter((entry) => !isUnsentReasoning(entry))) {
      push("messages", message.role, normalizeContentBlock(part));
    }
  }
  return blocks;
}

function summarize(block: PromptCacheBlock): PromptCacheBlockSummary {
  const { section: _section, hash: _hash, options: _options, ...summary } = block;
  return summary;
}

/** The options that differ when both blocks are the same options sentinel, else undefined. */
function changedOptions(
  previous: PromptCacheBlock,
  next: PromptCacheBlock | undefined
): PromptCacheChangedOption[] | undefined {
  if (previous.options == null || next?.options == null || previous.type !== next.type) {
    return undefined;
  }
  const before = previous.options;
  const after = next.options;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = keys
    .filter((key) => before[key] !== after[key])
    .map((key) =>
      KEY_ONLY_OPTIONS.has(key)
        ? { key }
        : { key, previous: before[key] ?? null, next: after[key] ?? null }
    );
  return changed.length > 0 ? changed : undefined;
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
  const changed = changedOptions(previousBlock, nextBlock);
  return {
    kind: "break",
    section,
    blockIndex: index,
    previousBlockCount: previous.length,
    nextBlockCount: next.length,
    previous: summarize(previousBlock),
    ...(nextBlock != null ? { next: summarize(nextBlock) } : {}),
    ...(changed != null ? { changedOptions: changed } : {}),
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
    `${describeBlock(comparison.previous)} -> ${describeBlock(comparison.next)}` +
    (comparison.changedOptions != null
      ? `; changed options: ${comparison.changedOptions.map(describeChangedOption).join(", ")}`
      : "")
  );
}
