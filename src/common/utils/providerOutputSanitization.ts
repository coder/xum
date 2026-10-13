import assert from "@/common/utils/assert";
import { isSupportedAttachmentMediaType } from "@/common/utils/attachments/supportedAttachmentMediaTypes";

const DEFAULT_MAX_SAFE_STRING_CHARS = 12_000;
const DEFAULT_MAX_ERROR_MESSAGE_CHARS = 2_000;
const DEFAULT_PROVIDER_PREVIEW_CHARS = 64;
const DEFAULT_ERROR_PREVIEW_CHARS = 240;
const MAX_RECURSION_DEPTH = 8;

interface TextSafetyStats {
  length: number;
  nulCount: number;
  controlCount: number;
  replacementCount: number;
}

interface SanitizeStringOptions {
  maxChars?: number;
  reason?: "provider-output" | "error-message";
}

// eslint-disable-next-line local/no-object-parameters -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// C0 controls except tab, LF and CR, plus DEL and U+FFFD. A regex scan, because in-turn steps
// now run this over every tool result of the request on every step (see
// sanitizeUnknownForProviderOutput).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

function hasUnsafeText(value: string): boolean {
  return UNSAFE_TEXT_PATTERN.test(value);
}

function isSupportedMediaPart(value: Record<string, unknown>): boolean {
  return (
    value.type === "media" &&
    typeof value.data === "string" &&
    typeof value.mediaType === "string" &&
    isSupportedAttachmentMediaType(value.mediaType)
  );
}

function getTextSafetyStats(value: string): TextSafetyStats {
  let nulCount = 0;
  let controlCount = 0;
  let replacementCount = 0;

  for (const char of value) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
    const code = char.codePointAt(0)!;
    if (code === 0) {
      nulCount += 1;
    }
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      controlCount += 1;
    }
    if (code === 0xfffd) {
      replacementCount += 1;
    }
  }

  return {
    length: value.length,
    nulCount,
    controlCount,
    replacementCount,
  };
}

function isBinaryLikeText(value: string, stats: TextSafetyStats): boolean {
  if (stats.nulCount > 0 || stats.replacementCount > 0) {
    return true;
  }

  if (value.length === 0) {
    return false;
  }

  return stats.controlCount / value.length > 0.02;
}

function escapePreview(value: string, maxChars: number): string {
  assert(Number.isInteger(maxChars) && maxChars > 0, "preview maxChars must be positive");

  let escaped = "";
  for (const char of value) {
    if (escaped.length >= maxChars) {
      break;
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
    const code = char.codePointAt(0)!;
    if (char === "\n") {
      escaped += "\\n";
    } else if (char === "\r") {
      escaped += "\\r";
    } else if (char === "\t") {
      escaped += "\\t";
    } else if (code >= 32 && code !== 127 && code !== 0xfffd) {
      escaped += char;
    } else {
      escaped += `\\u{${code.toString(16)}}`;
    }
  }
  return escaped;
}

function formatCounts(stats: TextSafetyStats): string {
  return `length=${stats.length}, nul=${stats.nulCount}, control=${stats.controlCount}, replacement=${stats.replacementCount}`;
}

function formatBinaryRedaction(
  value: string,
  stats: TextSafetyStats,
  reason: NonNullable<SanitizeStringOptions["reason"]>
): string {
  const previewChars =
    reason === "error-message" ? DEFAULT_ERROR_PREVIEW_CHARS : DEFAULT_PROVIDER_PREVIEW_CHARS;
  const preview = escapePreview(value, previewChars);
  return `[redacted binary-like ${reason}; ${formatCounts(stats)}; preview="${preview}"]`;
}

/** Bound and redact provider-visible strings so binary response bodies cannot poison history. */
export function sanitizeStringForProviderOutput(
  value: string,
  options: SanitizeStringOptions = {}
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_SAFE_STRING_CHARS;
  assert(Number.isInteger(maxChars) && maxChars > 0, "sanitize maxChars must be positive");

  if (value.length <= maxChars && !hasUnsafeText(value)) {
    return value;
  }

  const stats = getTextSafetyStats(value);
  const reason = options.reason ?? "provider-output";
  if (isBinaryLikeText(value, stats)) {
    return formatBinaryRedaction(value, stats, reason);
  }
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${reason}; ${formatCounts(stats)}]`;
}

/** Redact a binary-like tool output string; any other string keeps its full length. */
function redactBinaryLikeString(value: string): string {
  if (!hasUnsafeText(value)) {
    return value;
  }
  const stats = getTextSafetyStats(value);
  return isBinaryLikeText(value, stats)
    ? formatBinaryRedaction(value, stats, "provider-output")
    : value;
}

export function sanitizeErrorMessageForDisplay(message: string): string {
  return sanitizeStringForProviderOutput(message, {
    maxChars: DEFAULT_MAX_ERROR_MESSAGE_CHARS,
    reason: "error-message",
  });
}

/**
 * Provider-bound tool output: redact binary-like strings, keep every other string at its full
 * length. Both paths that send a tool result call this, with the same input (the tool's output
 * value, unwrapped from the SDK's { type, value } container): applyToolOutputRedaction when the
 * next turn rebuilds history, and StreamManager's in-turn steps
 * (stripWorkflowRunRecordsFromModelMessages). The next turn must repeat the exact bytes the
 * previous turn's steps sent, or the Anthropic prompt cache misses from that tool result on.
 *
 * No length cut here: the 12,000-char cut ran on the rebuild only, so every long result
 * (file_read, bash, web_fetch, memory, skill reads) broke the cache prefix at the next turn,
 * and it took away text the model had already read in full. Most tools cap their own output
 * (bash_output and task_await reports do not), and the request-time context-budget preflight
 * bounds the whole request in both paths.
 */
export function sanitizeUnknownForProviderOutput(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactBinaryLikeString(value);
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_RECURSION_DEPTH) {
    return "[redacted deeply nested provider output]";
  }

  if (Array.isArray(value)) {
    const arrayValue = value as readonly unknown[];
    let sanitizedItems: unknown[] | undefined;
    for (let index = 0; index < arrayValue.length; index += 1) {
      const item = arrayValue[index];
      const sanitizedItem = sanitizeUnknownForProviderOutput(item, depth + 1);
      if (sanitizedItems) {
        sanitizedItems[index] = sanitizedItem;
      } else if (sanitizedItem !== item) {
        sanitizedItems = arrayValue.slice(0, index);
        sanitizedItems[index] = sanitizedItem;
      }
    }
    return sanitizedItems ?? value;
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  if (isSupportedMediaPart(value)) {
    return value;
  }

  let sanitizedRecord: Record<string, unknown> | undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    const sanitizedValue = sanitizeUnknownForProviderOutput(nestedValue, depth + 1);
    if (sanitizedRecord) {
      sanitizedRecord[key] = sanitizedValue;
    } else if (sanitizedValue !== nestedValue) {
      sanitizedRecord = { ...value };
      sanitizedRecord[key] = sanitizedValue;
    }
  }
  return sanitizedRecord ?? value;
}
