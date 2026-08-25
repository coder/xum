/**
 * Programmatic Tool Calling (PTC) Types
 *
 * Event and result types for the sandboxed JS runtime that enables
 * multi-tool workflows via code execution.
 */

import { FILE_EDIT_TOOL_NAMES } from "@/common/types/tools";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";
import { MAX_FILE_CONTENT_SIZE } from "@/common/constants/attachments";
import {
  KERNEL_COMPACT_ARGS_CAP_BYTES,
  KERNEL_RETAINED_MEDIA_BUDGET_BYTES,
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
 * - file_edit_*: { success?, diff?, error? } with the diff capped at
 *   MAX_FILE_CONTENT_SIZE (+1 char so extractEditedFileDiffs still detects
 *   truncation via its `length > cap` check) — the ui_only diff variant is
 *   flattened onto `diff`, which the extractor reads as its fallback.
 * - agent_skill_read: { success, skill } / { success, error } passes through
 *   when its serialized size fits the same cap; oversized packages fall back
 *   to normal bounding (undefined) and the snapshot degrades like any other
 *   bounded record.
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
    try {
      if (JSON.stringify(reduced).length > MAX_FILE_CONTENT_SIZE) return undefined;
    } catch {
      return undefined;
    }
    return reduced;
  }

  const rawDiff = (result as { diff?: unknown }).diff;
  const uiOnlyDiff = getToolOutputUiOnly(result)?.file_edit?.diff;
  const diff = typeof uiOnlyDiff === "string" ? uiOnlyDiff : rawDiff;
  return {
    ...success,
    ...error,
    ...(typeof diff === "string"
      ? {
          diff:
            diff.length > MAX_FILE_CONTENT_SIZE ? diff.slice(0, MAX_FILE_CONTENT_SIZE + 1) : diff,
        }
      : {}),
  };
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
 * See retainExemptKernelRecordResult: sanitize an otherwise-retained media
 * container. Unsupported media parts are always replaced with bounded
 * placeholders, and supported parts are charged against an aggregate budget
 * (KERNEL_RETAINED_MEDIA_BUDGET_BYTES) — MCP enforces only a per-part guard,
 * so many individually-allowed images could otherwise persist unbounded
 * aggregate base64 into events and chat.jsonl rows.
 */
function sanitizeRetainedMediaContainer(result: unknown): unknown {
  const container = result as { type: "content"; value: unknown[] };
  let changed = false;
  let retainedMediaBytes = 0;
  const value = container.value.map((item) => {
    const media = asMediaPart(item);
    if (media === null) {
      return item;
    }
    if (media.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType)) {
      if (retainedMediaBytes + media.data.length <= KERNEL_RETAINED_MEDIA_BUDGET_BYTES) {
        retainedMediaBytes += media.data.length;
        return item;
      }
      changed = true;
      return {
        type: "text",
        text: `[media bounded at capture: ${media.mediaType}, ${media.data.length} base64 chars — aggregate media budget exceeded]`,
      };
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
    return media?.mediaType !== undefined && isSupportedAttachmentMediaType(media.mediaType);
  });
}
