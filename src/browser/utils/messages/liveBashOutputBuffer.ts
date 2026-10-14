import type { WorkspaceChatMessage } from "@/common/orpc/types";

export interface LiveBashOutputView {
  stdout: string;
  stderr: string;
  /** Combined output in emission order (stdout/stderr interleaved). */
  combined: string;
  truncated: boolean;
}

interface LiveBashOutputSegment {
  isError: boolean;
  text: string;
  bytes: number;
}

/**
 * Internal representation used by WorkspaceStore.
 *
 * We retain per-chunk segments so we can drop the oldest output first while
 * still rendering stdout and stderr separately.
 */
export interface LiveBashOutputInternal extends LiveBashOutputView {
  segments: LiveBashOutputSegment[];
  totalBytes: number;
}

function normalizeNewlines(text: string): string {
  // Many CLIs print "progress" output using carriage returns so they can update a single line.
  // In our UI, that reads better as actual line breaks.
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
let warnedMissingTextEncoder = false;

function getUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }

  // Defensive fallback for runtimes without TextEncoder (some RN/Hermes builds).
  // encodeURIComponent uses UTF-8 percent-encoding; count bytes by scanning '%XX' sequences.
  if (!warnedMissingTextEncoder && typeof console !== "undefined") {
    warnedMissingTextEncoder = true;
    console.warn("[liveBashOutputBuffer] TextEncoder unavailable; using slow UTF-8 fallback");
  }

  const encoded = encodeURIComponent(text);
  let bytes = 0;
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%") {
      bytes += 1;
      i += 2;
    } else {
      bytes += 1;
    }
  }
  return bytes;
}

export function appendLiveBashOutputChunk(
  prev: LiveBashOutputInternal | undefined,
  chunk: { text: string; isError: boolean },
  maxBytes: number
): LiveBashOutputInternal {
  if (maxBytes <= 0) {
    throw new Error(`maxBytes must be > 0 (got ${maxBytes})`);
  }

  const base: LiveBashOutputInternal =
    prev ??
    ({
      stdout: "",
      stderr: "",
      combined: "",
      truncated: false,
      segments: [],
      totalBytes: 0,
    } satisfies LiveBashOutputInternal);

  const normalizedText = normalizeNewlines(chunk.text);

  if (normalizedText.length === 0) return base;

  // Clone for purity (tests + avoids hidden mutation assumptions).
  const next: LiveBashOutputInternal = {
    stdout: base.stdout,
    stderr: base.stderr,
    combined: base.combined,
    truncated: base.truncated,
    segments: base.segments.slice(),
    totalBytes: base.totalBytes,
  };

  const segment: LiveBashOutputSegment = {
    isError: chunk.isError,
    text: normalizedText,
    bytes: getUtf8ByteLength(normalizedText),
  };

  next.segments.push(segment);
  next.totalBytes += segment.bytes;
  next.combined += segment.text;
  if (segment.isError) {
    next.stderr += segment.text;
  } else {
    next.stdout += segment.text;
  }

  while (next.totalBytes > maxBytes && next.segments.length > 0) {
    const removed = next.segments.shift();
    if (!removed) break;

    next.totalBytes -= removed.bytes;
    next.truncated = true;
    next.combined = next.combined.slice(removed.text.length);

    if (removed.isError) {
      next.stderr = next.stderr.slice(removed.text.length);
    } else {
      next.stdout = next.stdout.slice(removed.text.length);
    }
  }

  if (next.totalBytes < 0) {
    throw new Error("Invariant violation: totalBytes < 0");
  }

  return next;
}

/**
 * Applies one chat event to a live bash output map keyed by toolCallId. Shared by WorkspaceStore
 * and the VS Code webview so both hosts follow the same rules. Returns true when the map changed.
 *
 * - `bash-output` appends to the tool call's tail buffer (oldest output dropped past maxBytes).
 * - A bash `tool-call-end` whose result carries output drops the buffer. If output is missing
 *   (e.g. tmpfile overflow), the tail stays so the UI still shows something.
 */
export function applyLiveBashOutputEvent(
  liveOutput: Map<string, LiveBashOutputInternal>,
  event: WorkspaceChatMessage,
  maxBytes: number
): boolean {
  if (event.type === "bash-output") {
    const prev = liveOutput.get(event.toolCallId);
    const next = appendLiveBashOutputChunk(
      prev,
      { text: event.text, isError: event.isError },
      maxBytes
    );
    if (next === prev) return false;
    liveOutput.set(event.toolCallId, next);
    return true;
  }

  if (event.type === "tool-call-end" && event.toolName === "bash") {
    const output = (event.result as { output?: unknown } | undefined)?.output;
    if (typeof output === "string") {
      return liveOutput.delete(event.toolCallId);
    }
  }

  return false;
}
