/**
 * Programmatic Tool Calling (PTC) Types
 *
 * Event and result types for the sandboxed JS runtime that enables
 * multi-tool workflows via code execution.
 */

import { FILE_EDIT_TOOL_NAMES } from "@/common/types/tools";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";

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
 * retain, or undefined to apply normal result bounding. Media containers are
 * retained in SANITIZED form — unsupported media parts (audio/blobs, up to
 * 8 MiB each with no aggregate cap) are replaced with bounded text
 * placeholders BEFORE the record is retained and persisted, so a mixed
 * container (image + audio) keeps only its extractable payload.
 */
export function retainExemptKernelRecordResult(toolName: string, result: unknown): unknown {
  if (isPersistenceCriticalRecordToolName(toolName)) return result;
  if (!containsMediaContentPayload(result)) return undefined;
  return boundUnsupportedMediaPartsAtCapture(result);
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

/** See retainExemptKernelRecordResult: bound unsupported media parts inside an otherwise-retained container. */
function boundUnsupportedMediaPartsAtCapture(result: unknown): unknown {
  const container = result as { type: "content"; value: unknown[] };
  let changed = false;
  const value = container.value.map((item) => {
    const media = asMediaPart(item);
    if (
      media === null ||
      (media.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType))
    ) {
      return item;
    }
    changed = true;
    return {
      type: "text",
      text: `[media bounded at capture: ${media.mediaType ?? "unknown"}, ${media.data.length} base64 chars — not supported as a model attachment]`,
    };
  });
  return changed ? { ...container, value } : result;
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
    return (
      media !== null &&
      media.mediaType !== undefined &&
      isSupportedAttachmentMediaType(media.mediaType)
    );
  });
}
