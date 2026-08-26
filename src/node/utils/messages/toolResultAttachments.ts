import {
  getDisplayOnlyFileMetadata,
  isDisplayOnlyFilePart,
  type DisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import {
  MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST,
  MAX_SVG_TEXT_CHARS,
  SVG_MEDIA_TYPE,
} from "@/common/constants/imageAttachments";
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
  /** Untrusted optional metadata: persisted rows may carry any shape here —
   * recognition ignores it (r24) and normalizeOptionalFilename drops
   * non-strings (r25). */
  filename?: unknown;
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
  // Optional metadata must not gate recognition (r24): capture retains a
  // leaf with e.g. filename:null (asMediaPart ignores filename), so a
  // stricter predicate here would leave that retained base64 in
  // provider-visible JSON. Malformed filenames are dropped downstream by
  // normalizeOptionalFilename (null/non-string → no filename).
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string"
  );
}

function normalizeOptionalFilename(filename: unknown): string | undefined {
  // History rows are untrusted: recognition ignores optional metadata (r24),
  // so a persisted leaf can carry filename: 123 — calling .trim() on it would
  // throw during provider-request preparation and brick the workspace (r25,
  // self-healing rule). Non-string metadata is dropped, never thrown on.
  if (typeof filename !== "string") return undefined;
  const trimmed = filename.trim();
  if (trimmed.length === 0) return undefined;
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
 * context-limit failures. GENERIC wrapper descent does NOT consume this cap:
 * it is scanned iteratively without recursion (see
 * extractAttachmentsFromWrapperValue), so media is rewritten at any wrapper
 * depth while media-free deep JSON — plausibly legitimate output — passes
 * through unchanged. Persisted history itself is never mutated.
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
    // Standalone media leaf (r23): sandbox code can pluck a part out of a
    // container (`const part = image.value[0]`) and return it or pass it as
    // another tool's argument; capture retains it under the shared budget,
    // so the provider copy must rewrite it like containered parts.
    if (isMediaPart(output)) {
      if (isSupportedAttachmentMediaType(output.mediaType)) {
        return {
          newOutput: buildAttachmentPlaceholder(output),
          attachments: [
            {
              data: output.data,
              mediaType: normalizeAttachmentMediaType(output.mediaType),
              ...(normalizeOptionalFilename(output.filename)
                ? { filename: normalizeOptionalFilename(output.filename) }
                : {}),
            },
          ],
        };
      }
      return { newOutput: buildUnsupportedMediaPlaceholder(output), attachments: [] };
    }
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

    // Non-media parts can nest their own media containers (e.g. a custom part
    // wrapping another MCP-style container). Capture-time sanitization retains
    // such parts whole while within the aggregate budget (charged at full
    // serialized size), so the provider copy must traverse them like any other
    // wrapper — otherwise the nested base64 rides as raw JSON text in every
    // later request (r18 retry).
    const nested = extractAttachmentsFromToolOutput(item, depth + 1);
    if (nested != null) {
      didChange = true;
      attachments.push(...nested.attachments);
      // Content-container entries must stay typed content parts (AI SDK
      // schema): an over-depth replacement is a bare string, and inserting it
      // raw would make the container malformed and fail model-message
      // conversion or provider validation on every later request (r29).
      newValue.push(
        typeof nested.newOutput === "string"
          ? { type: "text", text: nested.newOutput }
          : (nested.newOutput as AISDKContent)
      );
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
    const rewrites: Record<string, unknown> = {};
    const extractedResult = extractAttachmentsFromToolOutput(
      (record as { result?: unknown }).result,
      depth + 1
    );
    if (extractedResult != null) {
      pushUnique(extractedResult.attachments);
      rewrites.result = extractedResult.newOutput;
    }
    // Nested-call ARGS too (r22): sandbox code can pass a bridged media
    // result into another tool ({payload: image}); classic capture retains
    // the copy under the shared budget, so the provider copy must rewrite it
    // like result media or the base64 rides as JSON in every later request.
    const extractedArgs = extractAttachmentsFromToolOutput(
      (record as { args?: unknown }).args,
      depth + 1
    );
    if (extractedArgs != null) {
      pushUnique(extractedArgs.attachments);
      rewrites.args = extractedArgs.newOutput;
    }
    if (extractedResult == null && extractedArgs == null) {
      return record;
    }
    didChange = true;
    return { ...record, ...rewrites };
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

  // Sibling wrapper fields beyond toolCalls/result/consoleOutput: classic
  // sandbox code can return a wrapper holding BOTH a toolCalls-shaped
  // structure and other media-bearing fields, and returning after only the
  // nested rewrite would leave sibling base64 in request-ready JSON (capture
  // retains supported media under its budget by design).
  const siblingRewrites: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(output as Record<string, unknown>)) {
    if (key === "toolCalls" || key === "result" || key === "consoleOutput") {
      continue;
    }
    const extracted = extractAttachmentsFromToolOutput(item, depth + 1);
    if (extracted == null) {
      continue;
    }
    didChange = true;
    pushUnique(extracted.attachments);
    siblingRewrites[key] = extracted.newOutput;
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
      ...siblingRewrites,
    },
    attachments,
  };
}

/**
 * Tool-output-shaped values route through the recursive shape handlers in
 * extractAttachmentsFromToolOutput (which consume the shared depth cap);
 * everything else is a generic wrapper scanned iteratively below.
 */
function isToolOutputShaped(value: unknown): boolean {
  return (
    isJsonContainer(value) ||
    isContentContainer(value) ||
    (typeof value === "object" &&
      value !== null &&
      Array.isArray((value as { toolCalls?: unknown }).toolCalls))
  );
}

/**
 * Deep-walk arbitrary wrapper objects/arrays for media content containers.
 * Sandbox code can wrap bridged results (`return { image: xum.mcp(...) }`),
 * and capture-time sanitization intentionally RETAINS supported containers
 * under its budget — so the provider copy must rewrite them into
 * attachments/placeholders wherever they sit, or a normal screenshot ships as
 * both an attachment (from the duplicate nested record) and megabytes of raw
 * JSON (from the wrapped outer result) on every later request.
 *
 * Generic wrapper spans are traversed ITERATIVELY (explicit stack, post-order
 * copy-on-write rebuild) rather than recursively: wrapper shapes are
 * model/attacker-authored, and abandoning the scan at a fixed depth would let
 * a media container hidden below that many plain wrappers keep shipping raw
 * base64 in every provider request, while recursing per wrapper level would
 * trade that for stack overflow (capture-time sanitization retains supported
 * containers far deeper than any safe recursion budget). Media-free deep JSON
 * still passes through unchanged (null ⇒ caller keeps the original value).
 * Recursion continues only through tool-output-shaped children
 * (json/content/toolCalls edges), which stay bounded by the shared depth cap;
 * in-memory cycles are skipped via the visiting/processed sets, and cyclic
 * back-edges are kept as-is (persisted JSON history cannot contain them).
 */
function extractAttachmentsFromWrapperValue(
  value: unknown,
  depth: number
): { newOutput: unknown; attachments: ExtractedToolAttachment[] } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const attachments: ExtractedToolAttachment[] = [];
  // Copy-on-write rebuilds keyed by original node identity; nodes absent from
  // this map are unchanged and reused as-is (preserves identity for the
  // media-free case).
  const changed = new Map<object, unknown>();
  const processed = new Set<object>();
  const visiting = new Set<object>();
  const stack: Array<{ node: object; entered: boolean }> = [{ node: value, entered: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const node = frame.node;
    if (!frame.entered) {
      // Duplicate frames (shared children pushed by several parents) and
      // cycle back-edges are dropped before descending.
      if (processed.has(node) || visiting.has(node)) {
        stack.pop();
        continue;
      }
      frame.entered = true;
      visiting.add(node);
      // Descend generic object/array children first (post-order rebuild);
      // tool-output-shaped children are handled at exit via the recursive
      // shape handlers instead.
      const children: unknown[] = Array.isArray(node)
        ? node
        : Object.values(node as Record<string, unknown>);
      for (const child of children) {
        if (typeof child !== "object" || child === null) continue;
        if (processed.has(child) || visiting.has(child)) continue;
        // Media leaves and tool-output shapes are handled at the parent's
        // exit phase via the recursive shape handlers, not span descent.
        if (isMediaPart(child) || isToolOutputShaped(child)) continue;
        stack.push({ node: child, entered: false });
      }
      continue;
    }
    stack.pop();
    visiting.delete(node);
    processed.add(node);
    let nodeChanged = false;
    const rewriteChild = (child: unknown): unknown => {
      if (typeof child !== "object" || child === null) {
        return child;
      }
      if (isMediaPart(child) || isToolOutputShaped(child)) {
        const extracted = extractAttachmentsFromToolOutput(child, depth + 1);
        if (extracted == null) {
          return child;
        }
        nodeChanged = true;
        attachments.push(...extracted.attachments);
        return extracted.newOutput;
      }
      if (changed.has(child)) {
        nodeChanged = true;
        return changed.get(child);
      }
      return child;
    };
    const rebuilt = Array.isArray(node)
      ? node.map(rewriteChild)
      : Object.fromEntries(Object.entries(node).map(([key, child]) => [key, rewriteChild(child)]));
    if (nodeChanged) {
      changed.set(node, rebuilt);
    }
  }
  if (!changed.has(value)) {
    return null;
  }
  return { newOutput: changed.get(value), attachments };
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

/**
 * Placeholder for extracted attachments dropped by the request-wide media cap
 * (see MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST): capture bounds bytes and
 * per-container parts, not distinct records across a transcript, so a looped
 * media tool could otherwise fan out tens of thousands of synthetic provider
 * parts (r28 security). The newest attachments are kept.
 */
export function createOmittedToolAttachmentText(omitted: number): string {
  return `[${omitted} extracted media attachment(s) omitted: request-wide cap of ${MAX_EXTRACTED_TOOL_MEDIA_PARTS_PER_REQUEST} media parts reached; newest attachments are kept]`;
}

const ATTACHMENT_PLACEHOLDER_PREFIX = "[Attachment attached";

/**
 * Coalesce runs of per-item attachment placeholders inside a rewritten tool
 * output. Applied only to outputs whose attachments were (partly) omitted by
 * the request-wide media cap: each media item still leaves a per-item
 * `[Attachment attached: …]` text part behind, so a flooded transcript could
 * carry tens of thousands of placeholder parts (megabytes of provider JSON)
 * even after the attachment cap (r29 security). Consecutive placeholder parts
 * collapse into one bounded summary; single placeholders stay individual.
 * The walk mirrors extraction's shapes and depth bound — the value was
 * already rebuilt (and depth-bounded) by extraction.
 */
export function coalesceAttachmentPlaceholders(output: unknown): unknown {
  return coalescePlaceholderWalk(output, 0);
}

function coalescePlaceholderWalk(value: unknown, depth: number): unknown {
  if (depth > MAX_NESTED_TOOL_EXTRACTION_DEPTH) return value;
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    let changed = false;
    const run: unknown[] = [];
    const flushRun = (): void => {
      if (run.length === 0) return;
      if (run.length === 1) {
        next.push(run[0]);
      } else {
        changed = true;
        next.push({
          type: "text",
          text: `[${run.length} attachments attached from tool output (per-item placeholders coalesced: request-wide media cap reached)]`,
        });
      }
      run.length = 0;
    };
    for (const item of value) {
      if (isAttachmentPlaceholderPart(item)) {
        run.push(item);
        continue;
      }
      flushRun();
      const walked = coalescePlaceholderWalk(item, depth + 1);
      if (walked !== item) changed = true;
      next.push(walked);
    }
    flushRun();
    return changed ? next : value;
  }
  if (typeof value === "object" && value !== null) {
    let changed = false;
    const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      const walked = coalescePlaceholderWalk(child, depth + 1);
      if (walked !== child) changed = true;
      return [key, walked] as const;
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}

function isAttachmentPlaceholderPart(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const part = value as { type?: unknown; text?: unknown };
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    part.text.startsWith(ATTACHMENT_PLACEHOLDER_PREFIX)
  );
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
