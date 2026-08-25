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
  if (trimmed == null || trimmed.length === 0) return undefined;
  // Filenames are attacker-influencable metadata like media types: they ride
  // into provider-visible placeholders and attachment file parts, so an
  // unbounded value persisted by an MCP tool would bloat every later request.
  return boundMetadataLabel(trimmed, 200);
}

/**
 * Bound provider-visible metadata interpolation. Media types and filenames
 * come from tool results (MCP servers copy them verbatim), and placeholder
 * text persists in the provider copy of every later request — never
 * interpolate them raw.
 */
function boundMetadataLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildAttachmentPlaceholder(item: AISDKMediaPart): AISDKTextPart {
  const normalizedMediaType = boundMetadataLabel(normalizeAttachmentMediaType(item.mediaType), 100);
  const filename = normalizeOptionalFilename(item.filename);
  const label = filename != null ? `${filename} (${normalizedMediaType})` : normalizedMediaType;
  return {
    type: "text",
    text: `[Attachment attached: ${label} (base64 len=${item.data.length})]`,
  };
}

function buildUnsupportedMediaPlaceholder(item: AISDKMediaPart): AISDKTextPart {
  const normalizedMediaType = boundMetadataLabel(normalizeAttachmentMediaType(item.mediaType), 100);
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

/**
 * Depth bound for the mutual recursion between extractAttachmentsFromToolOutput
 * and extractAttachmentsFromNestedToolCalls (json wrappers count too). History
 * rows are untrusted persisted JSON: a syntactically valid row nesting
 * {toolCalls:[{result: …}]} chains deep enough would overflow the stack while
 * preparing provider messages, and since extraction runs on EVERY request,
 * one malformed row would brick the workspace (self-healing rule). Real
 * nesting is 1–2 levels (code_execution → bridged tool results).
 *
 * Over-deep TOOL-OUTPUT-SHAPED subtrees (json wrappers, toolCalls record
 * chains) are REPLACED with a bounded placeholder in the provider copy, not
 * retained: those shapes are malformed by construction past the cap, and
 * retaining them would keep shipping whatever payload hides at the leaf
 * (e.g. raw base64) on every later request — trading the stack overflow for
 * context-limit failures. GENERIC wrapper descent instead stops at the cap
 * and leaves the subtree unchanged (see extractAttachmentsFromWrapperValue):
 * media-free deep JSON is plausibly legitimate output and must not be
 * silently truncated. Persisted history itself is never mutated.
 */
const MAX_NESTED_TOOL_EXTRACTION_DEPTH = 64;

const OVER_DEPTH_PLACEHOLDER =
  "[tool output omitted from provider request: nested tool-record depth limit exceeded]";

export function extractAttachmentsFromToolOutput(
  output: unknown,
  depth = 0
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (depth > MAX_NESTED_TOOL_EXTRACTION_DEPTH) {
    return { newOutput: OVER_DEPTH_PLACEHOLDER, attachments: [] };
  }
  if (isJsonContainer(output)) {
    const extracted = extractAttachmentsFromToolOutput(output.value, depth + 1);
    if (extracted == null) {
      return null;
    }

    return {
      newOutput: { type: "json", value: extracted.newOutput },
      attachments: extracted.attachments,
    };
  }

  if (!isContentContainer(output)) {
    const nested = extractAttachmentsFromNestedToolCalls(output, depth + 1);
    if (nested != null) {
      return nested;
    }
    return extractAttachmentsFromWrapperValue(output, depth + 1);
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
  output: unknown,
  depth: number
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
    const extracted = extractAttachmentsFromToolOutput(
      (record as { result?: unknown }).result,
      depth + 1
    );
    if (extracted == null) {
      return record;
    }
    didChange = true;
    pushUnique(extracted.attachments);
    return { ...record, result: extracted.newOutput };
  });

  const outerResult = (output as { result?: unknown }).result;
  const extractedOuter = extractAttachmentsFromToolOutput(outerResult, depth + 1);
  if (extractedOuter != null) {
    didChange = true;
    pushUnique(extractedOuter.attachments);
  }

  // Console output too: `const image = xum.<mediaTool>(...); console.log(image)`
  // copies the media container into consoleOutput args, which would otherwise
  // carry up to the classic console budget (~1MiB) of base64 into the next
  // request as JSON despite the record/result rewrites above.
  const consoleOutput = (output as { consoleOutput?: unknown }).consoleOutput;
  let newConsoleOutput = consoleOutput;
  if (Array.isArray(consoleOutput)) {
    let consoleChanged = false;
    const mapped = consoleOutput.map((record: unknown) => {
      if (typeof record !== "object" || record === null) {
        return record;
      }
      const args = (record as { args?: unknown }).args;
      if (!Array.isArray(args)) {
        return record;
      }
      let argsChanged = false;
      const newArgs = args.map((arg: unknown) => {
        const extracted = extractAttachmentsFromToolOutput(arg, depth + 1);
        if (extracted == null) {
          return arg;
        }
        argsChanged = true;
        pushUnique(extracted.attachments);
        return extracted.newOutput;
      });
      if (!argsChanged) {
        return record;
      }
      consoleChanged = true;
      return { ...record, args: newArgs };
    });
    if (consoleChanged) {
      didChange = true;
      newConsoleOutput = mapped;
    }
  }

  if (!didChange) {
    return null;
  }

  return {
    newOutput: {
      ...output,
      toolCalls: newToolCalls,
      ...(extractedOuter != null ? { result: extractedOuter.newOutput } : {}),
      ...(newConsoleOutput !== consoleOutput ? { consoleOutput: newConsoleOutput } : {}),
    },
    attachments,
  };
}

/**
 * Deep-walk arbitrary wrapper objects/arrays for media content containers.
 * Sandbox code can wrap bridged results (`return { image: xum.mcp(...) }`),
 * and capture-time sanitization intentionally RETAINS supported containers
 * under its budget — so the provider copy must rewrite them into
 * attachments/placeholders wherever they sit, or a normal screenshot ships as
 * both an attachment (from the duplicate nested record) and megabytes of raw
 * JSON (from the wrapped outer result) on every later request. Children route
 * back through extractAttachmentsFromToolOutput, so the shared depth cap
 * bounds the stack (cycles terminate because depth grows on each revisit) and
 * over-deep subtrees degrade to the bounded placeholder.
 */
function extractAttachmentsFromWrapperValue(
  value: unknown,
  depth: number
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  // Generic wrappers past the cap are plausibly LEGITIMATE deep JSON (a
  // media-free API tree), unlike tool-output-shaped chains: stop descending
  // and leave the subtree unchanged instead of substituting the placeholder.
  // The stack stays bounded because no recursion continues from here, and
  // children below are invoked at depth + 1 ≤ cap, so the placeholder branch
  // in extractAttachmentsFromToolOutput is reachable only through
  // json/toolCalls edges that add further depth.
  if (depth >= MAX_NESTED_TOOL_EXTRACTION_DEPTH) {
    return null;
  }
  const attachments: ExtractedToolAttachment[] = [];
  let didChange = false;
  const rewrite = (item: unknown): unknown => {
    const extracted = extractAttachmentsFromToolOutput(item, depth + 1);
    if (extracted == null) {
      return item;
    }
    didChange = true;
    attachments.push(...extracted.attachments);
    return extracted.newOutput;
  };
  const newValue = Array.isArray(value)
    ? value.map(rewrite)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  if (!didChange) {
    return null;
  }
  return { newOutput: newValue, attachments };
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
