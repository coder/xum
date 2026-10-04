/**
 * Session tape loader (read side of experiment `sessionTapes`). Validates a whole tape against
 * the contract in `src/common/types/sessionTape.ts` before anything uses its events.
 *
 * Invariants:
 * - The whole tape is validated before a result carries any event: a tape with one bad line is
 *   rejected as a whole, never replayed up to the bad line, and events are never dropped.
 * - Accepted results keep every recorded event in order, decoded exactly as the client would
 *   have received it: RPC JSON decode (Dates, undefined, ...) then `WorkspaceChatMessageSchema`
 *   (its parse output, as the router's self-validating onChat path yields).
 * - `stopped` and `truncated` tapes are accepted but flagged; `error` tapes are always rejected;
 *   truncated tapes are rejected unless the caller opts in.
 *
 * Pure (no fs): tapes hold full chat content, so callers decide where text comes from.
 */
import { RPCJsonSerializer } from "@orpc/client";
import { WorkspaceChatMessageSchema } from "@/common/orpc/schemas";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  SESSION_TAPE_MASKING,
  SESSION_TAPE_VERSION,
  SessionTapeEventLineSchema,
  SessionTapeHeaderSchema,
  SessionTapeTrailerSchema,
  type SessionTapeEndReason,
  type SessionTapeHeader,
  type SessionTapeTrailer,
} from "@/common/types/sessionTape";

const TAPE_FILE_SUFFIX = ".jsonl";

export interface SessionTapeEvent {
  /** Milliseconds from the start of the recorded subscription. */
  t: number;
  /** UTF-8 bytes of the stored event JSON (as recorded). */
  bytes: number;
  event: WorkspaceChatMessage;
}

export interface LoadedSessionTape {
  header: SessionTapeHeader;
  trailer: SessionTapeTrailer;
  events: SessionTapeEvent[];
}

export type SessionTapeLoadResult =
  /** Ended because the subscription closed; complete. */
  | ({ status: "ok" } & LoadedSessionTape)
  /** Ended at an explicit stop while the subscription went on; complete up to the stop point. */
  | ({ status: "stopped" } & LoadedSessionTape)
  /** A size cap was hit (only with `allowTruncated`): gap-free prefix, never a complete tape. */
  | ({ status: "truncated"; endReason: Exclude<SessionTapeEndReason, "error"> } & LoadedSessionTape)
  | {
      status: "rejected";
      reason: string;
      /** 1-based line number of the offending line, when one line is at fault. */
      line?: number;
      /** Parsed header/trailer when they were valid, so tools can still describe the tape. */
      header?: SessionTapeHeader;
      trailer?: SessionTapeTrailer;
    };

export interface SessionTapeLoadOptions {
  /** Accept tapes whose trailer says a size cap was hit (status `truncated`). */
  allowTruncated?: boolean;
}

/**
 * Only finalized tapes end in `.jsonl`; anything after it (e.g. `.jsonl.<hex>`) is an
 * unfinished temp file of an atomic write and must not be loaded.
 */
export function isFinalizedSessionTapeFileName(fileName: string): boolean {
  return fileName.endsWith(TAPE_FILE_SUFFIX);
}

class TapeRejection extends Error {
  /** Set once line 1 parsed, so a later rejection still describes the tape. */
  header?: SessionTapeHeader;
  constructor(
    readonly reason: string,
    readonly line?: number
  ) {
    super(reason);
  }
}

function parseJsonLine(text: string, line: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TapeRejection("malformed JSON line", line);
  }
}

function parseHeader(text: string): SessionTapeHeader {
  const raw = parseJsonLine(text, 1);
  // Version and masking first, with their own messages: a newer or masked tape must be refused
  // as unsupported, not reported as generally malformed.
  if (raw !== null && typeof raw === "object") {
    const { tape, masking } = raw as { tape?: unknown; masking?: unknown };
    if (tape !== SESSION_TAPE_VERSION) {
      throw new TapeRejection(`unsupported tape version ${JSON.stringify(tape)}`, 1);
    }
    if (masking !== SESSION_TAPE_MASKING) {
      throw new TapeRejection(`unsupported masking ${JSON.stringify(masking)}`, 1);
    }
  }
  const parsed = SessionTapeHeaderSchema.safeParse(raw);
  if (!parsed.success) throw new TapeRejection("invalid header", 1);
  return parsed.data;
}

const utf8 = new TextEncoder();

function decodeEvent(
  text: string,
  raw: unknown,
  line: number
): { t: number; bytes: number; event: WorkspaceChatMessage } {
  const parsed = SessionTapeEventLineSchema.safeParse(raw);
  if (!parsed.success) throw new TapeRejection("invalid event line", line);
  const { t, bytes, event, meta } = parsed.data;
  // `bytes` is what payload-size reports use, so it must measure the event JSON as stored. The
  // recorder writes one fixed layout with JSON.stringify; an edited or re-encoded line (other
  // whitespace, escapes or key order) cannot be measured reliably and is not a faithful tape.
  // Measured from the raw parse (zod output reorders keys) and before decoding, which rewrites
  // the event in place. Both are reported after the onChat schema, so a bad event says so.
  const stored = raw as { event: unknown; meta?: unknown };
  const eventJson = JSON.stringify(stored.event);
  const metaJson = stored.meta === undefined ? "" : `,"meta":${JSON.stringify(stored.meta)}`;
  const recorderLayout =
    text === `{"t":${JSON.stringify(t)},"bytes":${bytes},"event":${eventJson}${metaJson}}`;
  const storedBytes = utf8.encode(eventJson).length;
  let decoded: unknown;
  try {
    if (meta?.some((entry) => typeof entry[0] !== "string")) {
      throw new Error("meta entry without a type tag");
    }
    decoded = new RPCJsonSerializer().deserialize({
      json: event,
      meta: meta as Array<[string, ...Array<string | number>]> | undefined,
    });
  } catch {
    throw new TapeRejection("event could not be decoded", line);
  }
  const validated = WorkspaceChatMessageSchema.safeParse(decoded);
  if (!validated.success) throw new TapeRejection("event fails the onChat schema", line);
  if (storedBytes !== bytes) {
    throw new TapeRejection("event byte count does not match the stored event", line);
  }
  if (!recorderLayout) {
    throw new TapeRejection("event line is not in the recorder's encoding", line);
  }
  return { t, bytes, event: validated.data };
}

function loadOrThrow(text: string, options: SessionTapeLoadOptions): SessionTapeLoadResult {
  const lines = text.split("\n");
  // A finalized tape ends with a newline: drop the one empty string it leaves.
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new TapeRejection("empty tape");

  const header = parseHeader(lines[0]);
  try {
    return loadBodyOrThrow(lines, header, options);
  } catch (error) {
    if (error instanceof TapeRejection) error.header = header;
    throw error;
  }
}

function loadBodyOrThrow(
  lines: string[],
  header: SessionTapeHeader,
  options: SessionTapeLoadOptions
): SessionTapeLoadResult {
  const events: SessionTapeEvent[] = [];
  let trailer: SessionTapeTrailer | undefined;
  let lastT = 0;
  for (let index = 1; index < lines.length; index++) {
    const line = index + 1;
    const raw = parseJsonLine(lines[index], line);
    const isTrailer = raw !== null && typeof raw === "object" && "end" in raw;
    if (isTrailer) {
      if (index !== lines.length - 1) throw new TapeRejection("trailer is not the last line", line);
      const parsed = SessionTapeTrailerSchema.safeParse(raw);
      if (!parsed.success) throw new TapeRejection("invalid trailer", line);
      if (parsed.data.t < lastT) throw new TapeRejection("trailer offset goes backwards", line);
      trailer = parsed.data;
      break;
    }
    let decoded: SessionTapeEvent;
    try {
      decoded = decodeEvent(lines[index], raw, line);
    } catch (error) {
      // Validation and re-encoding recurse into the event: a deeply nested event can overflow
      // the stack (RangeError). Bad tape content rejects the tape; it never throws to callers.
      if (error instanceof TapeRejection) throw error;
      throw new TapeRejection("event could not be validated", line);
    }
    // Offsets are taken in delivery order, so a decreasing one means a corrupt or edited tape.
    if (decoded.t < lastT) throw new TapeRejection("event offset goes backwards", line);
    lastT = decoded.t;
    events.push(decoded);
  }
  if (!trailer) throw new TapeRejection("missing trailer (unfinished tape)");

  const rejectWithContext = (reason: string): SessionTapeLoadResult => ({
    status: "rejected",
    reason,
    header,
    trailer,
  });
  const { reason, truncated } = trailer.end;
  if (reason === "error") return rejectWithContext("tape ended with an error");
  // The recorder drops events only after a truncation (or a failed capture, reason `error`).
  if (!truncated && trailer.end.droppedEvents > 0) {
    return rejectWithContext("trailer reports dropped events without truncation");
  }
  if (truncated) {
    if (!options.allowTruncated) return rejectWithContext("tape is truncated (size cap hit)");
    return { status: "truncated", endReason: reason, header, trailer, events };
  }
  return { status: reason === "closed" ? "ok" : "stopped", header, trailer, events };
}

/** Validate and decode a whole tape (the file's text). Bad tape content never throws. */
export function loadSessionTape(
  text: string,
  options: SessionTapeLoadOptions = {}
): SessionTapeLoadResult {
  try {
    return loadOrThrow(text, options);
  } catch (error) {
    if (error instanceof TapeRejection) {
      return {
        status: "rejected",
        reason: error.reason,
        ...(error.line !== undefined && { line: error.line }),
        ...(error.header !== undefined && { header: error.header }),
      };
    }
    // Any line nested deeply enough (header and trailer included) can overflow the stack while
    // it is formatted or validated. That is bad tape content too: reject, never throw.
    if (error instanceof RangeError) {
      return { status: "rejected", reason: "tape is nested too deeply to validate" };
    }
    throw error;
  }
}

export interface SessionTapeSummary {
  eventCount: number;
  /** Sum of the recorded per-event `bytes`. */
  totalBytes: number;
  /** Trailer offset: the recorded subscription's length in milliseconds. */
  durationMs: number;
  /** Event count per onChat `type`, `message-batch` counted once per batch. */
  countsByType: Record<string, number>;
}

export function summarizeSessionTape(tape: LoadedSessionTape): SessionTapeSummary {
  const countsByType: Record<string, number> = {};
  let totalBytes = 0;
  for (const { event, bytes } of tape.events) {
    countsByType[event.type] = (countsByType[event.type] ?? 0) + 1;
    totalBytes += bytes;
  }
  return {
    eventCount: tape.events.length,
    totalBytes,
    durationMs: Math.max(tape.trailer.t, tape.events.at(-1)?.t ?? 0),
    countsByType,
  };
}
