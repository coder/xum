import type { FilePart, ImagePart, ModelMessage, TextPart, ToolResultPart } from "ai";
import { MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST } from "@/common/constants/imageAttachments";
import { sanitizeAnthropicDocumentFilename } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import {
  createOmittedToolAttachmentText,
  createToolAttachmentSummaryText,
  extractAttachmentsFromToolOutput,
  prepareExtractedToolAttachmentForProvider,
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
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
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
  // Chronologically OLDEST overflow is omitted behind a bounded placeholder.
  const capState = {
    omitRemaining: Math.max(0, totalAttachments - MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST),
  };

  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "tool") {
      result.push(message);
      continue;
    }
    if (!Array.isArray(message.content)) {
      result.push(message);
      continue;
    }

    let extractedAttachments: ExtractedToolAttachment[] = [];
    let changedMessage = false;

    const newContent = message.content.map((part) => {
      if (part.type !== "tool-result") {
        return part;
      }
      const extracted = extractionsByPart.get(part);
      if (extracted === undefined) {
        return part;
      }

      changedMessage = true;
      extractedAttachments = [...extractedAttachments, ...extracted.attachments];

      return {
        ...part,
        output: extracted.newOutput as ToolResultOutput,
      };
    });

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
    if (extractedAttachments.length > 0) {
      result.push(await createSyntheticUserMessage(extractedAttachments, capState));
    }
  }

  return result;
}

async function createSyntheticUserMessage(
  attachments: ExtractedToolAttachment[],
  capState: { omitRemaining: number }
): Promise<ModelMessage> {
  const content: Array<TextPart | ImagePart | FilePart> = [
    {
      type: "text",
      text: createToolAttachmentSummaryText(attachments.length),
    },
  ];

  let omittedHere = 0;
  for (const attachment of attachments) {
    if (capState.omitRemaining > 0) {
      // Over the request-wide cap: the payload was already replaced with a
      // placeholder in the tool output; skipping BEFORE provider preparation
      // also avoids the resize work.
      capState.omitRemaining--;
      omittedHere++;
      continue;
    }
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
      });
      continue;
    }

    content.push({
      type: "file",
      data: preparedAttachment.data,
      mediaType: preparedAttachment.mediaType,
      ...(preparedAttachment.filename
        ? {
            filename: sanitizeAnthropicDocumentFilename(preparedAttachment.filename),
          }
        : {}),
    });
  }
  if (omittedHere > 0) {
    content.splice(1, 0, {
      type: "text",
      text: createOmittedToolAttachmentText(omittedHere),
    });
  }

  return {
    role: "user",
    content,
  };
}
