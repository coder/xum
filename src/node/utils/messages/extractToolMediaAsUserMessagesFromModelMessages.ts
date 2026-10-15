import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import { isRasterAttachmentMediaType } from "@/node/utils/attachments/resizeRasterImageAttachment";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  coalesceAttachmentPlaceholders,
  createOmittedToolAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  isSyntheticToolMediaPart,
  prepareExtractedToolAttachmentForProvider,
  SYNTHETIC_TOOL_MEDIA_PART_METADATA,
  type ExtractedToolAttachment,
} from "@/node/utils/messages/toolResultAttachments";

// Extract the output type from ToolResultPart to ensure type compatibility with ai@6
type ToolResultOutput = ToolResultPart["output"];

/**
 * Request-only rewrite for *internal* streamText steps.
 *
 * streamText() can make multiple LLM calls (steps) when tools are enabled.
 * Tool results produced during the stream are included in subsequent step prompts.
 *
 * Some tools return attachments as base64 inside tool results (output.type === "content" with
 * media parts, or output.type === "json" containing a nested "content" container).
 * Providers can treat that as plain text/JSON and blow up context.
 *
 * This helper rewrites tool-result outputs to replace supported attachment payloads with small
 * text placeholders, and inserts a synthetic user message containing the extracted attachments.
 * After a deferred server tool call the attachments stay inside the tool result instead (see
 * holdsDeferredProviderToolCall).
 */
export async function extractToolMediaAsUserMessagesFromModelMessages(
  messages: ModelMessage[]
): Promise<ModelMessage[]> {
  const pools = collectToolMedia(messages);
  const { extractionsByPart, totalAttachments, reservedMediaParts, syntheticMediaParts } = pools;

  // Request-wide cap (r28 security): capture bounds bytes and per-container
  // parts, not distinct records, so a looped bridged media tool could
  // otherwise fan out tens of thousands of synthetic provider parts.
  // Chronologically OLDEST tool media is dropped first, across both kinds: media already in the
  // request (synthetic parts, MCP images inside tool results) is evicted, and new extractions
  // are omitted behind bounded placeholders. One order for both keeps a rebuild (which
  // extracts every step's media again) and an in-turn step (which sees earlier steps' media as
  // synthetic parts) dropping the same items.
  const budget = Math.max(0, MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST - reservedMediaParts);
  const overBudget = Math.max(0, syntheticMediaParts.length + totalAttachments - budget);
  const { evictedSyntheticParts, omittedByPart } = planMediaCap(pools.order, overBudget);
  const nothingToRewrite =
    extractionsByPart.size === 0 &&
    evictedSyntheticParts.size === 0 &&
    pools.inlineToolResultMedia === 0;
  if (nothingToRewrite) return messages;

  const result: ModelMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "user" && Array.isArray(message.content)) {
      result.push(evictSyntheticMediaParts(message, evictedSyntheticParts));
      continue;
    }
    if (message.role !== "assistant" && message.role !== "tool") {
      result.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    // A deferred server tool keeps the previous assistant turn open: the user
    // message after it may hold only tool_result blocks, so the media rides
    // inside the tool results instead of in a synthetic user message.
    const inlineMedia =
      message.role === "tool" && holdsDeferredProviderToolCall(messages[messageIndex - 1]);

    let keptAttachments: ExtractedToolAttachment[] = [];
    let totalExtracted = 0;
    let omittedForMessage = 0;
    let changedMessage = false;

    const newContent = await Promise.all(
      message.content.map(async (part) => {
        if (part.type !== "tool-result") {
          return part;
        }
        const extracted = extractionsByPart.get(part);
        if (extracted === undefined) {
          const prepared = await prepareInlineToolResultMedia(part, evictedSyntheticParts);
          if (prepared !== part) changedMessage = true;
          return prepared;
        }

        changedMessage = true;
        totalExtracted += extracted.attachments.length;
        // Over the request-wide cap: chronologically OLDEST attachments are
        // omitted, and their per-item output placeholders are coalesced so a
        // flooded transcript cannot keep megabytes of placeholder JSON in
        // every request (r29 security).
        const omittedHere = omittedByPart.get(part) ?? 0;
        omittedForMessage += omittedHere;
        const keptHere = extracted.attachments.slice(omittedHere);
        // Excess per-item placeholders (cap omission OR same-payload dedup —
        // r31) are coalesced; unchanged when placeholders match emitted
        // attachments 1:1.
        const output = coalesceAttachmentPlaceholders(extracted.newOutput, keptHere.length);
        if (inlineMedia) {
          return { ...part, output: await createInlineMediaOutput(output, keptHere, omittedHere) };
        }
        keptAttachments = [...keptAttachments, ...keptHere];
        return { ...part, output: output as ToolResultOutput };
      })
    );

    // The content arrays are structurally identical for both roles, but the
    // union needs the role-specific rebuild.
    result.push(
      changedMessage
        ? message.role === "tool"
          ? {
              ...message,
              content: newContent as Extract<ModelMessage, { role: "tool" }>["content"],
            }
          : {
              ...message,
              content: newContent as Extract<ModelMessage, { role: "assistant" }>["content"],
            }
        : message
    );
    if (totalExtracted > 0 && !inlineMedia) {
      result.push(
        await createSyntheticUserMessage(keptAttachments, omittedForMessage, totalExtracted)
      );
    }
  }

  return result;
}

/**
 * True when an assistant message holds a provider-executed tool call (an
 * Anthropic `server_tool_use`, e.g. web_search) whose result is not in the same
 * message. Claude can call a server tool alongside a client tool; the API then
 * returns before running the server tool and runs it once the client results
 * arrive. Until then the turn is open: the next user message must contain only
 * `tool_result` blocks, and anything after them (text, images) ends the turn and
 * fails with "`web_search` tool use with id ... was found without a
 * corresponding `web_search_tool_result` block". The result arrives at the
 * start of the NEXT assistant message, so this shape stays stable in every
 * later step of the turn.
 */
function holdsDeferredProviderToolCall(message: ModelMessage | undefined): boolean {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
  const resolved = new Set(
    message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
  );
  return message.content.some(
    (part) =>
      part.type === "tool-call" && part.providerExecuted === true && !resolved.has(part.toolCallId)
  );
}

type ContentOutputItem = Extract<ToolResultOutput, { type: "content" }>["value"][number];

/**
 * Provider-ready tool-result output that carries the extracted attachments
 * itself (Anthropic accepts images and documents inside `tool_result`). The
 * placeholder-rewritten output keeps the text the model would otherwise see.
 */
async function createInlineMediaOutput(
  output: unknown,
  keptAttachments: ExtractedToolAttachment[],
  omittedCount: number
): Promise<ToolResultOutput> {
  const record = output as { type?: unknown; value?: unknown };
  const value: ContentOutputItem[] =
    record.type === "content" && Array.isArray(record.value)
      ? [...(record.value as ContentOutputItem[])]
      : [
          {
            type: "text",
            text:
              (record.type === "text" || record.type === "error-text") &&
              typeof record.value === "string"
                ? record.value
                : JSON.stringify(record.type === "json" ? record.value : output),
          },
        ];
  if (omittedCount > 0) {
    value.push({ type: "text", text: createOmittedToolAttachmentText(omittedCount) });
  }
  for (const attachment of keptAttachments) {
    const providerReadyAttachment = await prepareExtractedToolAttachmentForProvider(attachment);
    if (providerReadyAttachment.type === "text") {
      value.push({ type: "text", text: providerReadyAttachment.text });
      continue;
    }
    const prepared = providerReadyAttachment.attachment;
    value.push({
      type: "file",
      mediaType: prepared.mediaType,
      data: { type: "data", data: prepared.data },
      ...(prepared.filename
        ? { filename: sanitizeAnthropicDocumentFilename(prepared.filename) }
        : {}),
      // Counted as reserved media on later steps (see the pass-1 scan).
      providerOptions: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
    });
  }
  return { type: "content", value };
}

/**
 * Pass 1 of extractToolMediaAsUserMessagesFromModelMessages: the tool-result parts to extract
 * and the media the request already carries, split into the cap's pools.
 */
function collectToolMedia(messages: ModelMessage[]) {
  // Pass 1 — extract once per tool-result part. The request-wide media cap
  // needs the TOTAL before any emission so the NEWEST attachments survive,
  // and the extraction walk must not run twice per part (see the MuxMessage
  // variant in extractToolMediaAsUserMessages.ts).
  const pools: ToolMediaPools = {
    extractionsByPart: new Map(),
    totalAttachments: 0,
    reservedMediaParts: 0,
    syntheticMediaParts: [],
    inlineToolResultMedia: 0,
    order: [],
  };
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) collectMessageMedia(part, pools);
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") collectToolResultMedia(part, pools);
    }
  }
  return pools;
}

/**
 * Existing media parts share the same per-request provider limits as new
 * extractions (r31), but they split into two pools:
 * - reserved: genuine user uploads (unmarked) — consume the allowance and
 *   are never evicted.
 * - synthetic tool media (marker from a prior history-level extraction) —
 *   evictable oldest-first so a fresh screenshot from the current tool call
 *   still reaches the model at saturation (r34).
 */
interface ToolMediaPools {
  extractionsByPart: Map<object, NonNullable<ReturnType<typeof extractAttachmentsFromToolOutput>>>;
  totalAttachments: number;
  reservedMediaParts: number;
  syntheticMediaParts: unknown[];
  /** Media items tool results carry inline (see collectToolResultMedia). */
  inlineToolResultMedia: number;
  /** Evictable media and extractions in message order, oldest first (see planMediaCap). */
  order: Array<{ key: object; count: number; extraction: boolean }>;
}

/** Drops the oldest `overBudget` media items of `order`: evicts existing ones, omits extractions. */
function planMediaCap(order: ToolMediaPools["order"], overBudget: number) {
  const evictedSyntheticParts = new Set<unknown>();
  const omittedByPart = new Map<object, number>();
  let remaining = overBudget;
  for (const entry of order) {
    if (remaining === 0) break;
    const dropped = Math.min(remaining, entry.count);
    remaining -= dropped;
    if (entry.extraction) omittedByPart.set(entry.key, dropped);
    else evictedSyntheticParts.add(entry.key);
  }
  return { evictedSyntheticParts, omittedByPart };
}

function addEvictableMedia(pools: ToolMediaPools, parts: object[]): void {
  pools.syntheticMediaParts.push(...parts);
  for (const key of parts) pools.order.push({ key, count: 1, extraction: false });
}

function collectMessageMedia(part: unknown, pools: ToolMediaPools): void {
  const partType = (part as { type?: unknown }).type;
  if (partType !== "image" && partType !== "file") return;
  if (isSyntheticToolMediaPart(part)) {
    addEvictableMedia(pools, [part as object]);
  } else {
    pools.reservedMediaParts++;
  }
}

function collectToolResultMedia(part: ToolResultPart, pools: ToolMediaPools): void {
  const extracted = extractAttachmentsFromToolOutput(part.output as unknown);
  if (extracted == null) {
    // Media a tool result carries inline stays where it is: MCP images (mcpToModelOutput,
    // unmarked) and media an earlier extraction inlined after a deferred server tool (marked,
    // see holdsDeferredProviderToolCall). Both are evictable oldest-first like synthetic tool
    // media, or a screenshot loop could pass the provider's limit, and a rebuild (which
    // extracts that media again) and an in-turn step would drop different items.
    const inlineMedia = inlineToolResultMedia(part.output);
    pools.inlineToolResultMedia += inlineMedia.length;
    addEvictableMedia(pools, inlineMedia);
    return;
  }
  // This part is extracted again, which leaves its inline media in place: it reserves its share.
  if (part.output.type === "content") {
    pools.reservedMediaParts += part.output.value.filter(isSyntheticToolMediaPart).length;
  }
  pools.extractionsByPart.set(part, extracted);
  pools.totalAttachments += extracted.attachments.length;
  pools.order.push({ key: part, count: extracted.attachments.length, extraction: true });
}

/** Media items a tool result carries inline (see collectToolResultMedia). */
function inlineToolResultMedia(output: ToolResultOutput): object[] {
  if (output.type !== "content") return [];
  return output.value.filter((item) => {
    const type = (item as { type?: unknown }).type;
    return type === "file" || type === "file-data" || type === "image-data";
  });
}

/**
 * Replaces evicted inline media of one tool result with one cap note and prepares the rest for
 * the provider (same part if nothing changes). MCP images skip extraction, so this is their
 * only self-healing: the MuxMessage-level extraction that once ran on replay resized oversized
 * images and replaced unreadable ones. The in-turn step and the rebuild both run it, so a
 * provider-ready image keeps the same bytes in both.
 */
async function prepareInlineToolResultMedia(
  part: ToolResultPart,
  evicted: ReadonlySet<unknown>
): Promise<ToolResultPart> {
  if (part.output.type !== "content") return part;
  const value = part.output.value;
  const kept = await Promise.all(
    value.filter((item) => !evicted.has(item)).map(prepareInlineRasterItem)
  );
  const evictedHere = value.length - kept.length;
  if (evictedHere === 0 && kept.every((item, index) => item === value[index])) return part;
  const note = { type: "text" as const, text: createOmittedToolAttachmentText(evictedHere) };
  return {
    ...part,
    output: { type: "content", value: evictedHere > 0 ? [...kept, note] : kept },
  };
}

/**
 * Resizes an oversized inline raster (prepareExtractedToolAttachmentForProvider) or replaces
 * unreadable bytes with its note. Returns the same item when it is provider-ready already.
 */
async function prepareInlineRasterItem(item: ContentOutputItem): Promise<ContentOutputItem> {
  const raster = inlineRaster(item);
  if (raster == null) return item;
  const prepared = await prepareExtractedToolAttachmentForProvider(raster);
  if (prepared.type === "text") return { type: "text", text: prepared.text };
  const { data, mediaType } = prepared.attachment;
  if (data === raster.data && mediaType === raster.mediaType) return item;
  // Same item shape (see inlineRaster), new bytes.
  const rewritten: Record<string, unknown> = {
    ...item,
    mediaType,
    data: raster.nested ? { type: "data", data } : data,
  };
  return rewritten as ContentOutputItem;
}

/** The base64 raster an unmarked inline media item carries, or null for anything else. */
function inlineRaster(
  item: ContentOutputItem
): { data: string; mediaType: string; nested: boolean } | null {
  if (isSyntheticToolMediaPart(item)) return null;
  const record = item as { mediaType?: unknown; data?: unknown };
  if (typeof record.mediaType !== "string" || !isRasterAttachmentMediaType(record.mediaType)) {
    return null;
  }
  // mcpToModelOutput emits `file` parts with `{ type: "data", data }`; older shapes hold the
  // base64 string directly.
  const nested = (record.data as { type?: unknown } | null)?.type === "data";
  const data = nested ? (record.data as { data?: unknown }).data : record.data;
  return typeof data === "string" ? { data, mediaType: record.mediaType, nested } : null;
}

/**
 * Replaces evicted synthetic tool-media parts in a user message with one
 * bounded omission note (r34). Only parts identified by the pass-1 scan are
 * touched; genuine user uploads never enter the evicted set.
 */
function evictSyntheticMediaParts(
  message: Extract<ModelMessage, { role: "user" }>,
  evictedSyntheticParts: ReadonlySet<unknown>
): ModelMessage {
  if (evictedSyntheticParts.size === 0 || !Array.isArray(message.content)) return message;
  let evictedHere = 0;
  for (const part of message.content) {
    if (evictedSyntheticParts.has(part)) evictedHere++;
  }
  if (evictedHere === 0) return message;

  const newContent: Array<TextPart | ImagePart | FilePart> = [];
  let noteInserted = false;
  for (const part of message.content) {
    if (!evictedSyntheticParts.has(part)) {
      newContent.push(part);
      continue;
    }
    if (!noteInserted) {
      noteInserted = true;
      newContent.push({
        type: "text",
        text: createOmittedToolAttachmentText(evictedHere),
      });
    }
  }
  return { ...message, content: newContent };
}

async function createSyntheticUserMessage(
  keptAttachments: ExtractedToolAttachment[],
  omittedCount: number,
  totalExtracted: number
): Promise<ModelMessage> {
  const content: Array<TextPart | ImagePart | FilePart> = [
    {
      type: "text",
      text: createToolAttachmentSummaryText(totalExtracted),
    },
  ];

  for (const attachment of keptAttachments) {
    const providerReadyAttachment = await prepareExtractedToolAttachmentForProvider(attachment);
    if (providerReadyAttachment.type === "text") {
      content.push({
        type: "text",
        text: providerReadyAttachment.text,
      });
      continue;
    }

    const preparedAttachment = providerReadyAttachment.attachment;
    if (preparedAttachment.mediaType.startsWith("image/")) {
      content.push({
        type: "image",
        image: preparedAttachment.data,
        mediaType: preparedAttachment.mediaType,
        // Marks the part evictable under the request-wide media cap (r34) —
        // matters when these messages re-enter the transform (replay).
        providerOptions: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
      });
      continue;
    }

    content.push({
      type: "file",
      data: preparedAttachment.data,
      mediaType: preparedAttachment.mediaType,
      providerOptions: SYNTHETIC_TOOL_MEDIA_PART_METADATA,
      ...(preparedAttachment.filename
        ? {
            filename: sanitizeAnthropicDocumentFilename(preparedAttachment.filename),
          }
        : {}),
    });
  }
  if (omittedCount > 0) {
    content.splice(1, 0, {
      type: "text",
      text: createOmittedToolAttachmentText(omittedCount),
    });
  }

  return {
    role: "user",
    content,
  };
}
