import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
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
  // Pass 1 — extract once per tool-result part. The request-wide media cap
  // needs the TOTAL before any emission so the NEWEST attachments survive,
  // and the extraction walk must not run twice per part (see the MuxMessage
  // variant in extractToolMediaAsUserMessages.ts).
  const extractionsByPart = new Map<
    object,
    NonNullable<ReturnType<typeof extractAttachmentsFromToolOutput>>
  >();
  let totalAttachments = 0;
  // Existing media parts share the same per-request provider limits as new
  // extractions (r31), but they split into two pools:
  // - reserved: genuine user uploads (unmarked) — consume the allowance and
  //   are never evicted.
  // - synthetic tool media (marker from a prior history-level extraction) —
  //   evictable oldest-first so a fresh screenshot from the current tool call
  //   still reaches the model at saturation (r34).
  let reservedMediaParts = 0;
  const syntheticMediaParts: unknown[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const partType = (part as { type?: unknown }).type;
      if (partType === "image" || partType === "file") {
        if (isSyntheticToolMediaPart(part)) {
          syntheticMediaParts.push(part);
        } else {
          reservedMediaParts++;
        }
      }
    }
    if (message.role !== "assistant" && message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      // Media an earlier step already inlined into a tool result (deferred
      // server tool, see holdsDeferredProviderToolCall) stays where it is, so
      // it reserves its share of the request-wide cap.
      if (part.output.type === "content") {
        reservedMediaParts += part.output.value.filter(isSyntheticToolMediaPart).length;
      }
      const extracted = extractAttachmentsFromToolOutput(part.output as unknown);
      if (extracted == null) continue;
      extractionsByPart.set(part, extracted);
      totalAttachments += extracted.attachments.length;
    }
  }
  if (extractionsByPart.size === 0) return messages;

  // Request-wide cap (r28 security): capture bounds bytes and per-container
  // parts, not distinct records, so a looped bridged media tool could
  // otherwise fan out tens of thousands of synthetic provider parts.
  // Chronologically OLDEST tool media is dropped first: prior synthetic parts
  // (all older — they were extracted from earlier turns' tool results) are
  // evicted before new extractions are omitted behind bounded placeholders.
  const budget = Math.max(0, MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST - reservedMediaParts);
  const overBudget = Math.max(0, syntheticMediaParts.length + totalAttachments - budget);
  // syntheticMediaParts is collected in message order, so a prefix slice is
  // the chronologically oldest set.
  const evictedSyntheticParts = new Set(
    syntheticMediaParts.slice(0, Math.min(overBudget, syntheticMediaParts.length))
  );
  const capState = {
    omitRemaining: overBudget - evictedSyntheticParts.size,
  };

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
          return part;
        }

        changedMessage = true;
        totalExtracted += extracted.attachments.length;
        // Over the request-wide cap: chronologically OLDEST attachments are
        // omitted, and their per-item output placeholders are coalesced so a
        // flooded transcript cannot keep megabytes of placeholder JSON in
        // every request (r29 security).
        const omittedHere = Math.min(capState.omitRemaining, extracted.attachments.length);
        capState.omitRemaining -= omittedHere;
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
