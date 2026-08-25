/**
 * Programmatic Tool Calling (PTC) Types
 *
 * Event and result types for the sandboxed JS runtime that enables
 * multi-tool workflows via code execution.
 */

import { FILE_EDIT_TOOL_NAMES } from "@/common/types/tools";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import { MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import {
  KERNEL_COMPACT_ARGS_CAP_BYTES,
  KERNEL_RETAINED_CONTAINER_MAX_PARTS,
  KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
  KERNEL_RETAINED_PATH_MAX_CHARS,
} from "@/constants/kernelOutput";

/**
 * Event emitted when a tool call starts within the sandbox.
 */
export interface PTCToolCallStartEvent {
  type: "tool-call-start";
  callId: string; // Unique ID for correlation with end event
  toolName: string;
  args: unknown;
  startTime: number;
}

/**
 * Event emitted when a tool call ends within the sandbox.
 */
export interface PTCToolCallEndEvent {
  type: "tool-call-end";
  callId: string; // Same ID as start event for correlation
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  startTime: number;
  endTime: number;
}

/**
 * Event emitted when console.log/warn/error is called in the sandbox.
 */
export interface PTCConsoleEvent {
  type: "console";
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

export type PTCEvent = PTCToolCallStartEvent | PTCToolCallEndEvent | PTCConsoleEvent;

/**
 * Record of a tool call made during execution.
 */
export interface PTCToolCallRecord {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
  /**
   * Kernel-mode (RLM persistent mount) compact-record fields: nested results
   * never enter the model context, so `result` is dropped and replaced by
   * `ok` (did the call succeed) plus `bytes` (serialized size of the
   * suppressed result). The guest already received the full value during
   * execution; its channels for surfacing data are the return value, console
   * output, and `vars`. Absent in ephemeral/RLM-off records, which keep full
   * inline results (the non-RLM inline-results contract).
   */
  ok?: boolean;
  bytes?: number;
}

/**
 * Record of console output during execution.
 */
export interface PTCConsoleRecord {
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

/**
 * Result of executing code in the PTC sandbox.
 */
export interface PTCExecutionResult {
  success: boolean;
  /** Final return value from the code (if success) */
  result?: unknown;
  /** Error message (if !success) */
  error?: string;
  /** Tool calls made during execution (for partial results on failure) */
  toolCalls: PTCToolCallRecord[];
  /** Console output captured during execution */
  consoleOutput: PTCConsoleRecord[];
  /** Total execution time in milliseconds */
  duration_ms: number;
}

/**
 * Nested records whose FULL result must survive kernel-mode capture bounding
 * and post-eval compaction (both consult this predicate):
 *
 * - Persistence-critical tools: post-compaction extractors mine successful
 *   nested file_edit_* diffs (extractEditedFileDiffs) and agent_skill_read
 *   snapshots (loadedSkillSnapshots) out of history. Their results are
 *   repo-controlled and tool-side bounded (~50k-char diff/snapshot caps), so
 *   retaining them matches what classic-mode records already expose.
 * - Media-bearing results: any bridged MCP tool may return a content
 *   container carrying base64 media. Request-time extraction
 *   (extractToolMediaAsUserMessages) turns nested media into model-visible
 *   multimodal attachments — impossible if capture bounding or compaction
 *   already dropped the payload, which would leave RLM users unable to see
 *   bridged screenshots/images at all. Media size is host-tool-produced (the
 *   same trust class as classic-mode records) and rasters are resized at
 *   request time.
 */
export function isKernelRecordResultExempt(toolName: string, result: unknown): boolean {
  return isPersistenceCriticalRecordToolName(toolName) || containsMediaContentPayload(result);
}

/**
 * Capture-time counterpart of isKernelRecordResultExempt (see
 * KernelRecordBounds.captureRetained): returns the value the record should
 * retain, or undefined to apply normal result bounding. Retained values are
 * SANITIZED, never raw:
 *
 * - Persistence-critical results are reduced to the bounded shape the
 *   extractors actually consume (see boundPersistenceCriticalResult) — the
 *   raw results are unbounded upstream (generateDiff has no cap), so a loop
 *   of large edits must not accumulate megabytes per execution in streamed
 *   events and persisted records.
 * - Media containers keep supported parts under an aggregate budget;
 *   unsupported parts (audio/blobs) and over-budget parts become bounded
 *   text placeholders BEFORE the record is retained and persisted.
 */
export function retainExemptKernelRecordResult(toolName: string, result: unknown): unknown {
  if (isPersistenceCriticalRecordToolName(toolName)) {
    return boundPersistenceCriticalResult(toolName, result);
  }
  if (!containsMediaContentPayload(result)) return undefined;
  return sanitizeRetainedMediaContainer(result);
}

/**
 * Reduce a persistence-critical result to the bounded shape the
 * post-compaction extractors consume:
 *
 * - file_edit_*: { success?, diff?, diffTruncated?, error? } with oversized
 *   diffs truncated at a HUNK boundary (see boundRetainedEditDiff) — the
 *   ui_only diff variant is flattened onto `diff`, which the extractor reads
 *   as its fallback.
 * - agent_skill_read: { success, skill } / { success, error } passes through
 *   when its serialized size fits MAX_FILE_CONTENT_SIZE; oversized packages
 *   keep a schema-valid skill with a truncated body (see
 *   boundOversizedSkillPackage) instead of being discarded.
 */
function boundPersistenceCriticalResult(toolName: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as { success?: unknown; error?: unknown };
  const success = typeof record.success === "boolean" ? { success: record.success } : {};
  const error =
    typeof record.error === "string"
      ? { error: record.error.slice(0, KERNEL_COMPACT_ARGS_CAP_BYTES) }
      : {};

  if (toolName === "agent_skill_read") {
    const skill = (result as { skill?: unknown }).skill;
    const reduced = { ...success, ...error, ...(skill !== undefined ? { skill } : {}) };
    const reducedLength = serializedJsonLength(reduced);
    if (reducedLength === undefined) return undefined;
    if (reducedLength <= MAX_FILE_CONTENT_SIZE) return reduced;
    return boundOversizedSkillPackage(skill, reducedLength, success, error);
  }

  const rawDiff = (result as { diff?: unknown }).diff;
  const uiOnlyDiff = getToolOutputUiOnly(result)?.file_edit?.diff;
  const diff = typeof uiOnlyDiff === "string" ? uiOnlyDiff : rawDiff;
  return {
    ...success,
    ...error,
    ...(typeof diff === "string" ? boundRetainedEditDiff(diff) : {}),
  };
}

/**
 * Note appended when a retained skill body is truncated at capture. Distinct
 * from the snapshot-limit note in skillSnapshot.ts: this cut point depends on
 * the package's serialized overhead, not MAX_AGENT_SKILL_SNAPSHOT_CHARS.
 */
const SKILL_BODY_CAPTURE_TRUNCATION_NOTE =
  "\n\n[Skill body truncated at capture to fit the retained-record cap]";

/**
 * Truncate an oversized skill package's BODY — the only unbounded field the
 * snapshot extractor consumes — so the retained {success, skill} fits
 * MAX_FILE_CONTENT_SIZE while AgentSkillPackageSchema still parses. A valid
 * skill whose package serializes just above the cap (body near the separately
 * supported 50k snapshot limit plus frontmatter overhead) must degrade to a
 * bounded body like createLoadedSkillSnapshot does, not lose the whole
 * package to a __kernelBounded marker (which compaction then drops entirely,
 * erasing the skill instructions from every later turn). Serialized escape
 * inflation only ever over-estimates the non-body overhead, so the sliced
 * package is guaranteed to fit. Returns undefined (normal bounding) for
 * malformed packages the extractor would reject anyway.
 */
function boundOversizedSkillPackage(
  skill: unknown,
  reducedLength: number,
  success: { success?: boolean },
  error: { error?: string }
): unknown {
  if (typeof skill !== "object" || skill === null) return undefined;
  const body = (skill as { body?: unknown }).body;
  if (typeof body !== "string") return undefined;
  // Serialized note length minus the surrounding quotes.
  const noteSerializedChars = JSON.stringify(SKILL_BODY_CAPTURE_TRUNCATION_NOTE).length - 2;
  const budget = MAX_FILE_CONTENT_SIZE - (reducedLength - body.length) - noteSerializedChars;
  if (budget <= 0) return undefined;
  return {
    ...success,
    ...error,
    skill: { ...skill, body: `${body.slice(0, budget)}${SKILL_BODY_CAPTURE_TRUNCATION_NOTE}` },
  };
}

/**
 * Bound an oversized unified diff at a HUNK boundary. A mid-hunk slice is not
 * parseable — parsePatch throws on it and applyPatch cannot apply it — so
 * combineDiffs would fall back to ONLY the last diff for the file: a later
 * small edit would erase the earlier large edit from post-compaction context
 * entirely. Whole hunks form a valid, applicable prefix, and diffTruncated
 * propagates the loss to FileEditDiff.truncated (see extractEditedFileDiffs).
 * When not even the first hunk fits, only the flag is retained; the record
 * still attributes the edit via success + path.
 */
function boundRetainedEditDiff(diff: string): { diff?: string; diffTruncated?: true } {
  if (diff.length <= MAX_FILE_CONTENT_SIZE) return { diff };
  // Hunk headers are the only diff lines starting with "@@ " (body lines
  // start with ' ', '+', '-', or '\').
  const hunkHeader = /^@@ /gm;
  const hunkStarts: number[] = [];
  let match;
  while ((match = hunkHeader.exec(diff)) !== null) hunkStarts.push(match.index);
  let end = 0;
  for (let i = 0; i < hunkStarts.length; i++) {
    const hunkEnd = i + 1 < hunkStarts.length ? hunkStarts[i + 1] : diff.length;
    if (hunkEnd > MAX_FILE_CONTENT_SIZE) break;
    end = hunkEnd;
  }
  if (end === 0) return { diffTruncated: true };
  return { diff: diff.slice(0, end), diffTruncated: true };
}

/**
 * JSON.stringify length in CHARACTERS, or undefined when unserializable
 * (cycles, BigInt). Used for the persistence-critical caps, which are char
 * caps by design: MAX_FILE_CONTENT_SIZE bounds repo-controlled diff/skill
 * text everywhere else in the codebase via .length/.slice(), and the
 * downstream extractors compare the same way.
 */
function serializedJsonLength(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
}

/**
 * JSON.stringify length in UTF-8 BYTES, or undefined when unserializable.
 * The media budget is a byte bound on persisted history: charging chars
 * would let server-controlled multibyte metadata (e.g. "image/" + millions
 * of CJK characters) occupy ~3x the documented budget on disk.
 */
function serializedJsonByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    return undefined;
  }
}

/** Media-part shape check shared by the container predicates below. */
function asMediaPart(item: unknown): { data: string; mediaType?: string } | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as { type?: unknown; data?: unknown; mediaType?: unknown };
  if (record.type !== "media" || typeof record.data !== "string") return null;
  return {
    data: record.data,
    ...(typeof record.mediaType === "string" ? { mediaType: record.mediaType } : {}),
  };
}

/**
 * Bounded label for placeholder text: mediaType is server-controlled and can
 * itself be arbitrarily long ("image/" + megabytes still passes the
 * supported-type prefix check), so never interpolate it raw.
 */
function boundedMediaTypeLabel(mediaType: string | undefined): string {
  if (mediaType === undefined) return "unknown";
  return mediaType.length > 100 ? `${mediaType.slice(0, 100)}…` : mediaType;
}

/**
 * See retainExemptKernelRecordResult / sanitizeMediaRecordCapture: sanitize a
 * retained media container. Unsupported media parts are always replaced with
 * bounded placeholders, and every OTHER retained part — media or not — is
 * charged its FULL serialized size (metadata and structure included) against
 * an aggregate budget (KERNEL_RETAINED_MEDIA_BUDGET_BYTES): MCP enforces only
 * a per-part data guard, so payloads could otherwise hide in mediaType
 * strings, sibling fields, or many individually-allowed images and persist
 * unbounded bytes into events and chat.jsonl rows. Part COUNT is bounded
 * separately (KERNEL_RETAINED_CONTAINER_MAX_PARTS) so placeholder structure
 * cannot grow without bound either. Idempotent: placeholders are small text
 * parts that re-charge identically on a second pass.
 */
function sanitizeRetainedMediaContainer(result: unknown): unknown {
  const container = result as { type: "content"; value: unknown[] };
  const parts = container.value.slice(0, KERNEL_RETAINED_CONTAINER_MAX_PARTS);
  let changed = parts.length < container.value.length;
  let retainedBytes = 0;
  const value: unknown[] = parts.map((item) => {
    const media = asMediaPart(item);
    if (
      media !== null &&
      (media.mediaType === undefined || !isSupportedAttachmentMediaType(media.mediaType))
    ) {
      changed = true;
      return {
        type: "text",
        text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — not supported as a model attachment]`,
      };
    }
    const serialized = serializedJsonByteLength(item);
    if (
      serialized !== undefined &&
      retainedBytes + serialized <= KERNEL_RETAINED_MEDIA_BUDGET_BYTES
    ) {
      retainedBytes += serialized;
      return item;
    }
    changed = true;
    return media !== null
      ? {
          type: "text",
          text: `[media bounded at capture: ${boundedMediaTypeLabel(media.mediaType)}, ${media.data.length} base64 chars — aggregate media budget exceeded]`,
        }
      : {
          type: "text",
          text: `[part bounded at capture: ${serialized ?? "unserializable"} serialized bytes — aggregate media budget exceeded]`,
        };
  });
  if (parts.length < container.value.length) {
    value.push({
      type: "text",
      text: `[${container.value.length - parts.length} additional part(s) bounded at capture — container part limit exceeded]`,
    });
  }
  return changed ? { ...container, value } : result;
}

/**
 * Mode-independent capture sanitizer (see IJSRuntime.setCaptureResultSanitizer),
 * applied to results captured into records/events in BOTH classic and kernel
 * mode. Classic (non-RLM) records keep full inline results by contract, but
 * media containers are the exception: exclusive PTC makes the bridge the only
 * route to executable MCP tools, records/events persist into
 * partial.json/chat.jsonl, and request-time attachment extraction rewrites
 * only the provider copy — without a capture budget a server returning many
 * individually-allowed images would persist unbounded multi-megabyte records
 * in default (non-RLM) PTC mode. The guest still receives the full value.
 */
export function sanitizeMediaRecordCapture(_toolName: string, result: unknown): unknown {
  return sanitizeCapturedMediaValue(result);
}

/**
 * Tool-name-free form of sanitizeMediaRecordCapture for values that are not
 * nested tool records: the classic execution's outer return value and console
 * args also persist into the code_execution history row (see
 * createCodeExecutionTool), and `return xum.<mediaTool>(...)` /
 * `console.log(...)` would otherwise carry the raw unbudgeted container.
 */
export function sanitizeCapturedMediaValue(value: unknown): unknown {
  return isMediaContentContainer(value) ? sanitizeRetainedMediaContainer(value) : value;
}

/**
 * Any MCP-style content container carrying at least one media part —
 * supported or not. Broader than containsMediaContentPayload (which gates the
 * kernel retain EXEMPTION on extractable/supported media): the capture
 * sanitizer must also bound containers holding only unsupported media
 * (audio/blobs), which classic mode would otherwise persist raw.
 */
function isMediaContentContainer(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const container = result as { type?: unknown; value?: unknown };
  if (container.type !== "content" || !Array.isArray(container.value)) return false;
  return container.value.some((item: unknown) => asMediaPart(item) !== null);
}

/**
 * Capture-time attribution fields merged onto a __kernelBounded ARGS marker
 * (see KernelRecordBounds.captureArgsRetained): a file_edit_* whose args
 * exceed the kernel args cap (e.g. inserting >2 KiB of content) would
 * otherwise lose its `path`, and both post-compaction diff preservation and
 * crash-safe edited-file tracking skip records they cannot attribute —
 * silently dropping a successful edit whose bounded diff WAS retained. Only
 * the validated path field is preserved; the marker's preview keeps the head
 * of everything else.
 */
export function retainPersistenceCriticalArgsFields(
  toolName: string,
  args: unknown
): Record<string, unknown> | undefined {
  if (!isPersistenceCriticalRecordToolName(toolName)) return undefined;
  const path = extractToolFilePath(args);
  if (path === undefined || path.length > KERNEL_RETAINED_PATH_MAX_CHARS) return undefined;
  return { path };
}

/** See isKernelRecordResultExempt (persistence-critical branch). */
export function isPersistenceCriticalRecordToolName(toolName: string): boolean {
  return (
    toolName === "agent_skill_read" ||
    FILE_EDIT_TOOL_NAMES.includes(toolName as (typeof FILE_EDIT_TOOL_NAMES)[number])
  );
}

/**
 * MCP-style content container ({ type: "content", value: [...] }) holding at
 * least one media part that request-time extraction will actually consume
 * (supported attachment types: images/PDF/SVG). Unsupported media (audio,
 * blobs — up to MiBs of base64 the model can never see as an attachment) does
 * not justify exempting the record from kernel bounding; extraction replaces
 * any unsupported parts that ride along in an exempted container with bounded
 * placeholders at request time.
 */
export function containsMediaContentPayload(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const container = result as { type?: unknown; value?: unknown };
  if (container.type !== "content" || !Array.isArray(container.value)) return false;
  return container.value.some((item: unknown) => {
    const media = asMediaPart(item);
    return media?.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType);
  });
}
