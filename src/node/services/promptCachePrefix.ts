/**
 * Anthropic prompt-cache prefix fingerprints.
 *
 * Anthropic caches a request as ordered blocks: tools, then system blocks,
 * then every message content block. A request reuses the cache up to the
 * first block that differs, so a follow-up request stays warm only when the
 * previous request's blocks are a prefix of its own. This module reduces a
 * final wire body to that block list (hashes plus content-free metadata) and
 * finds the first block that broke the prefix.
 *
 * cache_control markers move to the newest block on every request, so they
 * are removed before hashing.
 */

import { createHash } from "node:crypto";

export const PROMPT_CACHE_SECTIONS = ["tools", "system", "messages"] as const;
export type PromptCacheSection = (typeof PROMPT_CACHE_SECTIONS)[number];

/** Content-free description of one block: safe to log and to record on the timeline. */
export interface PromptCacheBlockSummary {
  /** "tool" for tool definitions, "system", or the message role. */
  role: string;
  type: string;
  /** Serialized length in characters, without cache markers. */
  length: number;
  toolName?: string;
}

export interface PromptCacheBlock extends PromptCacheBlockSummary {
  section: PromptCacheSection;
  hash: string;
}

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

export type PromptCachePrefixComparison = { kind: "extends" } | PromptCachePrefixBreak;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function label(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : undefined;
}

/**
 * Drop `cache_control` (Anthropic wire) and `providerOptions.anthropic.cacheControl`
 * (gateway prompt form) at every depth. A wrapper emptied only by a removed
 * marker is dropped too, so a marked block hashes like the unmarked one.
 */
function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheMarkers);
  if (!isRecord(value)) return value;
  const stripped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control" || key === "cacheControl") continue;
    const strippedChild = stripCacheMarkers(child);
    const emptied =
      (key === "providerOptions" || key === "anthropic") &&
      isRecord(child) &&
      Object.keys(child).length > 0 &&
      isRecord(strippedChild) &&
      Object.keys(strippedChild).length === 0;
    if (!emptied) stripped[key] = strippedChild;
  }
  return stripped;
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
 * `system`, `messages`) or the gateway's AI SDK prompt form (`tools`, `prompt`
 * with system messages inline).
 */
export function fingerprintAnthropicRequest(body: Record<string, unknown>): PromptCacheBlock[] {
  const toolNamesByCallId = new Map<string, string>();
  const sections: Record<PromptCacheSection, PromptCacheBlock[]> = {
    tools: [],
    system: [],
    messages: [],
  };
  const add = (section: PromptCacheSection, role: string, part: unknown): void => {
    // A string content is one text block on the wire, so `content: "hi"` and
    // `content: [{ type: "text", text: "hi" }, ...]` share a prefix.
    const normalized =
      typeof part === "string"
        ? { type: "text", text: part }
        : dropDefaultToolCaller(stripCacheMarkers(part));
    const serialized = JSON.stringify(normalized) ?? "null";
    const record = isRecord(normalized) ? normalized : {};
    const type = label(record.type) ?? (section === "tools" ? "tool" : typeof normalized);
    const named = section === "tools" || type.endsWith("tool_use");
    let toolName = label(record.toolName) ?? (named ? label(record.name) : undefined);
    const callId = label(record.id) ?? label(record.toolCallId);
    if (toolName != null && callId != null) toolNamesByCallId.set(callId, toolName);
    const resultId = label(record.tool_use_id);
    toolName ??= resultId != null ? toolNamesByCallId.get(resultId) : undefined;
    const hash = createHash("sha256").update(`${section}\0${role}\0${serialized}`).digest("hex");
    sections[section].push({
      section,
      role,
      type,
      length: serialized.length,
      ...(toolName != null ? { toolName } : {}),
      hash: hash.slice(0, 16),
    });
  };
  const addContent = (section: PromptCacheSection, role: string, content: unknown): void => {
    for (const part of Array.isArray(content) ? content : content != null ? [content] : []) {
      add(section, role, part);
    }
  };

  for (const tool of Array.isArray(body.tools) ? body.tools : []) add("tools", "tool", tool);
  addContent("system", "system", body.system);
  const messages: unknown = Array.isArray(body.messages) ? body.messages : body.prompt;
  for (const message of Array.isArray(messages) ? (messages as unknown[]) : []) {
    const role = (isRecord(message) ? label(message.role) : undefined) ?? "unknown";
    const content = isRecord(message) ? message.content : message;
    addContent(role === "system" ? "system" : "messages", role, content);
  }
  return [...sections.tools, ...sections.system, ...sections.messages];
}

function summarize(block: PromptCacheBlock): PromptCacheBlockSummary {
  const { section: _section, hash: _hash, ...summary } = block;
  return summary;
}

/** "extends" when every previous block starts the next request unchanged (identical included). */
export function comparePromptCachePrefix(
  previous: readonly PromptCacheBlock[],
  next: readonly PromptCacheBlock[]
): PromptCachePrefixComparison {
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
