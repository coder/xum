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

export interface AISDKMediaPart {
  type: "media";
  data: string;
  mediaType: string;
  filename?: string;
}

/**
 * Original attachment-carrying parts a tool result can produce: model
 * attachments (media) and user-preview-only files (display_file). Shared with
 * the PTC ToolBridge, which strips these out of sandbox-visible values.
 */
export type ToolAttachmentPart = AISDKMediaPart | DisplayOnlyFilePart;

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

/**
 * Split media/display-file parts out of a tool-result value array, replacing
 * each with a small text placeholder. Returns the original parts so callers
 * can route them (provider extraction, PTC bridge stripping).
 */
export function splitAttachmentPartsFromValueArray(items: unknown[]): {
  newItems: AISDKContent[];
  mediaParts: AISDKMediaPart[];
  displayParts: DisplayOnlyFilePart[];
  didChange: boolean;
} {
  const newItems: AISDKContent[] = [];
  const mediaParts: AISDKMediaPart[] = [];
  const displayParts: DisplayOnlyFilePart[] = [];
  let didChange = false;

  for (const item of items) {
    if (isMediaPart(item) && isSupportedAttachmentMediaType(item.mediaType)) {
      didChange = true;
      mediaParts.push(item);
      newItems.push(buildAttachmentPlaceholder(item));
      continue;
    }

    if (isDisplayOnlyFilePart(item)) {
      didChange = true;
      displayParts.push(item);
      newItems.push(buildDisplayOnlyFilePlaceholder(item));
      continue;
    }

    newItems.push(item as AISDKContent);
  }

  return { newItems, mediaParts, displayParts, didChange };
}

function toExtractedToolAttachment(item: AISDKMediaPart): ExtractedToolAttachment {
  return {
    data: item.data,
    mediaType: normalizeAttachmentMediaType(item.mediaType),
    ...(normalizeOptionalFilename(item.filename)
      ? { filename: normalizeOptionalFilename(item.filename) }
      : {}),
  };
}

/**
 * Tool outputs that carry attachment parts in a top-level `attachments` array
 * (e.g. code_execution re-attaching media produced by nested attach_file
 * calls). Any tool output using this shape gets its media lifted to real
 * model attachments by extractToolMediaAsUserMessages.
 */
function isAttachmentsCarrier(value: unknown): value is { attachments: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).attachments)
  );
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

  if (isContentContainer(output)) {
    const split = splitAttachmentPartsFromValueArray(output.value);
    if (!split.didChange) {
      return null;
    }

    return {
      newOutput: { type: "content", value: split.newItems },
      attachments: split.mediaParts.map(toExtractedToolAttachment),
    };
  }

  if (isAttachmentsCarrier(output)) {
    const split = splitAttachmentPartsFromValueArray(output.attachments);
    if (!split.didChange) {
      return null;
    }

    return {
      newOutput: { ...output, attachments: split.newItems },
      attachments: split.mediaParts.map(toExtractedToolAttachment),
    };
  }

  return null;
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
