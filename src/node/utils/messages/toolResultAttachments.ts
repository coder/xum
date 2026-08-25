import {
  getDisplayOnlyFileMetadata,
  isDisplayOnlyFilePart,
  type DisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import {
  isSupportedAttachmentMediaType,
  normalizeAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import {
  isRasterAttachmentMediaType,
  resizeRasterImageAttachmentBase64IfNeeded,
} from "@/node/utils/attachments/resizeRasterImageAttachment";

export interface ExtractedToolAttachment {
  data: string;
  mediaType: string;
  filename?: string;
}

interface AISDKMediaPart {
  type: "media";
  data: string;
  mediaType: string;
  filename?: string;
}

interface AISDKTextPart {
  type: "text";
  text: string;
}

type AISDKContent =
  | AISDKMediaPart
  | AISDKTextPart
  | DisplayOnlyFilePart
  | { type: string; [key: string]: unknown };

interface AISDKContentContainer {
  type: "content";
  value: AISDKContent[];
}

interface JsonContainer {
  type: "json";
  value: unknown;
}

function isJsonContainer(value: unknown): value is JsonContainer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "json" &&
    "value" in (value as Record<string, unknown>)
  );
}

function isContentContainer(value: unknown): value is AISDKContentContainer {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "content" &&
    Array.isArray((value as Record<string, unknown>).value)
  );
}

function isMediaPart(value: unknown): value is AISDKMediaPart {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string" &&
    (record.filename === undefined || typeof record.filename === "string")
  );
}

function normalizeOptionalFilename(filename: string | undefined): string | undefined {
  const trimmed = filename?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

function buildAttachmentPlaceholder(item: AISDKMediaPart): AISDKTextPart {
  const normalizedMediaType = normalizeAttachmentMediaType(item.mediaType);
  const filename = normalizeOptionalFilename(item.filename);
  const label = filename != null ? `${filename} (${normalizedMediaType})` : normalizedMediaType;
  return {
    type: "text",
    text: `[Attachment attached: ${label} (base64 len=${item.data.length})]`,
  };
}

function buildUnsupportedMediaPlaceholder(item: AISDKMediaPart): AISDKTextPart {
  const normalizedMediaType = normalizeAttachmentMediaType(item.mediaType);
  const filename = normalizeOptionalFilename(item.filename);
  const label = filename != null ? `${filename} (${normalizedMediaType})` : normalizedMediaType;
  return {
    type: "text",
    text: `[Media omitted from provider request: ${label} is not supported as a model attachment (base64 len=${item.data.length})]`,
  };
}

function buildDisplayOnlyFilePlaceholder(item: DisplayOnlyFilePart): AISDKTextPart {
  const normalizedMediaType = normalizeAttachmentMediaType(item.mediaType);
  const filename = normalizeOptionalFilename(item.filename);
  const label = filename != null ? `${filename} (${normalizedMediaType})` : normalizedMediaType;
  const sizeValue = getDisplayOnlyFileMetadata(item.providerOptions)?.size;
  const size = typeof sizeValue === "number" ? `, size=${sizeValue} bytes` : "";
  return {
    type: "text",
    text: `[File shown to user only: ${label}${size}. This file type is not supported as a model attachment, so no file bytes were sent to the model.]`,
  };
}

export function extractAttachmentsFromToolOutput(
  output: unknown
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (isJsonContainer(output)) {
    const extracted = extractAttachmentsFromToolOutput(output.value);
    if (extracted == null) {
      return null;
    }

    return {
      newOutput: { type: "json", value: extracted.newOutput },
      attachments: extracted.attachments,
    };
  }

  if (!isContentContainer(output)) {
    return extractAttachmentsFromNestedToolCalls(output);
  }

  const attachments: ExtractedToolAttachment[] = [];
  const newValue: AISDKContent[] = [];
  let didChange = false;

  for (const item of output.value) {
    if (isMediaPart(item)) {
      if (isSupportedAttachmentMediaType(item.mediaType)) {
        didChange = true;
        attachments.push({
          data: item.data,
          mediaType: normalizeAttachmentMediaType(item.mediaType),
          ...(normalizeOptionalFilename(item.filename)
            ? { filename: normalizeOptionalFilename(item.filename) }
            : {}),
        });
        newValue.push(buildAttachmentPlaceholder(item));
        continue;
      }

      // Unsupported media (audio, blobs) can be MiBs of base64 the model can
      // never consume as an attachment; sending it as tool-result JSON text
      // would blow up the request, so replace it with a bounded placeholder.
      didChange = true;
      newValue.push(buildUnsupportedMediaPlaceholder(item));
      continue;
    }

    if (isDisplayOnlyFilePart(item)) {
      didChange = true;
      newValue.push(buildDisplayOnlyFilePlaceholder(item));
      continue;
    }

    newValue.push(item);
  }

  if (!didChange) {
    return null;
  }

  return {
    newOutput: { type: "content", value: newValue },
    attachments,
  };
}

/**
 * code_execution outputs carry nested tool-call records ({ toolName, args,
 * result }). Classic (non-RLM) records retain the full bridged result, so a
 * bridged MCP tool's media lands nested instead of top-level; extract it the
 * same way top-level media is extracted so the model sees the attachment
 * instead of raw base64 riding as JSON text. Kernel-compacted records drop
 * result contents, so there is nothing to extract (the guest still received
 * the full data and can offload it via vars/return handles).
 *
 * The outer `result` (the guest's return value) is processed too: sandbox
 * code that does `return xum.<mediaTool>(...)` duplicates the media container
 * in both the record and the return value, and rewriting only the record
 * would still ship the oversized JSON. Identical media appearing in both
 * places is deduplicated into a single attachment.
 */
function extractAttachmentsFromNestedToolCalls(
  output: unknown
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const toolCalls = (output as { toolCalls?: unknown }).toolCalls;
  if (!Array.isArray(toolCalls)) {
    return null;
  }

  const attachments: ExtractedToolAttachment[] = [];
  const seen = new Set<string>();
  const pushUnique = (items: ExtractedToolAttachment[]) => {
    for (const item of items) {
      const key = `${item.mediaType}:${item.filename ?? ""}:${item.data}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push(item);
      }
    }
  };

  let didChange = false;
  const newToolCalls = toolCalls.map((record: unknown) => {
    if (typeof record !== "object" || record === null) {
      return record;
    }
    const extracted = extractAttachmentsFromToolOutput((record as { result?: unknown }).result);
    if (extracted == null) {
      return record;
    }
    didChange = true;
    pushUnique(extracted.attachments);
    return { ...record, result: extracted.newOutput };
  });

  const outerResult = (output as { result?: unknown }).result;
  const extractedOuter = extractAttachmentsFromToolOutput(outerResult);
  if (extractedOuter != null) {
    didChange = true;
    pushUnique(extractedOuter.attachments);
  }

  if (!didChange) {
    return null;
  }

  return {
    newOutput: {
      ...output,
      toolCalls: newToolCalls,
      ...(extractedOuter != null ? { result: extractedOuter.newOutput } : {}),
    },
    attachments,
  };
}

type ProviderReadyToolAttachment =
  | { type: "attachment"; attachment: ExtractedToolAttachment }
  | { type: "text"; text: string };

// Historical tool outputs can already contain oversized raster images.
// Normalize them at request time so retries do not keep failing on provider image limits.
export async function prepareExtractedToolAttachmentForProvider(
  attachment: ExtractedToolAttachment
): Promise<ProviderReadyToolAttachment> {
  if (attachment.mediaType === SVG_MEDIA_TYPE) {
    try {
      return {
        type: "text",
        text: createInlineSvgAttachmentText(attachment),
      };
    } catch (error) {
      return {
        type: "text",
        text: `[SVG attachment omitted from provider request: ${error instanceof Error ? error.message : "Failed to inline SVG attachment."}]`,
      };
    }
  }

  if (!isRasterAttachmentMediaType(attachment.mediaType)) {
    return {
      type: "attachment",
      attachment,
    };
  }

  try {
    const resizedAttachment = await resizeRasterImageAttachmentBase64IfNeeded(
      attachment.data,
      attachment.mediaType
    );

    return {
      type: "attachment",
      attachment: {
        ...attachment,
        data: resizedAttachment.data,
        mediaType: resizedAttachment.mediaType,
      },
    };
  } catch (error) {
    return {
      type: "text",
      text: `[Image attachment omitted from provider request: ${error instanceof Error ? error.message : "Failed to resize image attachment."}]`,
    };
  }
}
export function createToolAttachmentSummaryText(count: number): string {
  return `[Attached ${count} attachment(s) from tool output]`;
}

export function createDataUrlForExtractedAttachment(attachment: ExtractedToolAttachment): string {
  if (attachment.mediaType === SVG_MEDIA_TYPE) {
    const svgText = Buffer.from(attachment.data, "base64").toString("utf8");
    return `data:${SVG_MEDIA_TYPE},${encodeURIComponent(svgText)}`;
  }

  return `data:${attachment.mediaType};base64,${attachment.data}`;
}

function createInlineSvgAttachmentText(attachment: ExtractedToolAttachment): string {
  if (attachment.mediaType !== SVG_MEDIA_TYPE) {
    throw new Error(`Expected an SVG attachment, got '${attachment.mediaType}'`);
  }

  const svgText = Buffer.from(attachment.data, "base64").toString("utf8");
  if (svgText.length > MAX_SVG_TEXT_CHARS) {
    throw new Error(
      `SVG attachment is too long to inline as text (${svgText.length} chars > ${MAX_SVG_TEXT_CHARS} chars).`
    );
  }

  return (
    `[SVG attachment converted to text (providers generally don't accept ${SVG_MEDIA_TYPE} as an image input).]\n\n` +
    `\`\`\`svg\n${svgText}\n\`\`\``
  );
}
