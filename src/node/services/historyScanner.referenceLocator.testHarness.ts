// Frozen copy of findProviderHistoryStart at 55c8e3c76f1cd92457f2a4f12b393c7ce77efe8a (#4655
// differential oracle), together with every historyScanner.ts helper it reaches: the reset token
// recognizer, the raw-marker and ambiguous-key checks, the readability check and the row
// classifier. Do not edit to follow production; delete together with the locator fast path.
// Re-frozen once, deliberately, with the F1-F3 privacy fixes (historyScanner.formal.test.ts):
// the reset token window strips separators, and oversized rows stream through the raw probe for
// their own reset evidence and for any JSON spelling of the compaction boundary. Those rules
// changed on both sides; the fast-path comparison is unchanged.
// historyScanner.differential.test.ts compares production against this copy, so a change in
// historyScanner.ts to which rows the locator parses, probes, floors at or delivers shows up as a
// divergence. Blind spot: helpers and constants imported from other modules below
// (normalizePersistedMessage, isManualHistoryReset, the boundary predicates, MuxMessageSchema and
// the contextBudget constants) are shared with production, so a change there changes both sides.
import { createScanner, SyntaxKind } from "jsonc-parser";
import type * as fs from "node:fs/promises";
import assert from "node:assert";
import {
  SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE,
  SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES,
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_RESET_PROBE_CHARS,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
} from "@/common/constants/contextBudget";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import type { MuxMessage } from "@/common/types/message";
import { isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import {
  isDurableCompactionBoundaryMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { normalizePersistedMessage } from "@/node/utils/messages/normalizePersistedMessage";
import type { CompactionPendingBoundary as PendingBoundary } from "./compactionPendingState";
import { log } from "./log";

const [resetKeyToken, resetValueToken] = SESSION_HISTORY_RESET_NEEDLE.split(":");
const RESET_PROBE_TOKENS = [resetKeyToken, resetValueToken, ":"] as const;

function isReadableHistoryMessage(value: unknown): value is MuxMessage {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "role" in value &&
    ["user", "assistant", "system"].includes(String(value.role)) &&
    (!("metadata" in value) ||
      value.metadata === undefined ||
      (value.metadata !== null &&
        typeof value.metadata === "object" &&
        !Array.isArray(value.metadata))) &&
    "parts" in value &&
    MuxMessageSchema.shape.parts.safeParse(value.parts).success
  );
}

// Corrupted JSON can contain JS hex escapes; raw and incremental probes must
// recognize the same reset tokens without making the row provider-readable.
function decodeResetEscapes(text: string): string {
  return text.replace(/\\(?:u[\da-fA-F]{4}|x[\da-fA-F]{2})/g, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(2), 16))
  );
}

function compactResetProbe(text: string): string {
  // Corruption may insert raw or escaped control separators where JSON permits
  // whitespace. Remove them before retaining overlap, including long runs.
  return stripEscapedResetSeparators(stripRawResetSeparators(text));
}

function stripRawResetSeparators(text: string): string {
  return text.replace(/[\s\p{Cc}]/gu, "");
}
function stripEscapedResetSeparators(text: string): string {
  return text.replace(/\\(?:u00|x)(?:[0189][\da-f]|20|7f)/gi, "");
}

function hasRawResetMarker(text: string): boolean {
  const decoded = decodeResetEscapes(compactResetProbe(text));
  return decoded.includes(SESSION_HISTORY_RESET_NEEDLE);
}

const RESET_SEPARATORS = /[\s\p{Cc}]/gu;

// ── Separator-aware matching on latin1 text ───────────────────────────────────────────────
// addHistoryResetProbe and the oversized-row raw probe read rows as latin1 (one character per
// byte) and match markers in place instead of rewriting the text: separators are skipped where
// they occur, reproducing hasRawResetMarker's single pass (remove raw separators, then escaped
// separators once, then decode escapes) without a replace over every space of a giant row.

/**
 * RESET_SEPARATOR as latin1 bytes: the UTF-8 encoding of every separator code point. A
 * separator's lead byte is never a UTF-8 continuation byte, so its complete encoding always
 * decodes as that separator, and UTF-8 decoding yields a separator only from its encoding
 * (invalid bytes become U+FFFD). All separators are in the BMP.
 */
const [RAW_SEPARATOR_BYTE, MULTIBYTE_SEPARATORS] = (() => {
  const single = new Uint8Array(256);
  const multi = new Set<string>();
  let bmp = "";
  for (let cp = 0; cp < 0x10000; cp++)
    if (cp < 0xd800 || cp > 0xdfff) bmp += String.fromCharCode(cp);
  for (const match of bmp.matchAll(RESET_SEPARATORS)) {
    const bytes = Buffer.from(match[0], "utf8");
    if (bytes.length === 1) single[bytes[0]] = 1;
    else multi.add(bytes.toString("latin1"));
  }
  assert(single[0x20] === 1 && multi.size > 0, "reset separators cover ASCII and multibyte");
  return [single, multi] as const;
})();
const MULTIBYTE_SEPARATOR_LEADS = new Set(
  [...MULTIBYTE_SEPARATORS].map((bytes) => bytes.charCodeAt(0))
);

/** Length of the raw separator starting at `i`, or 0. */
function rawSeparatorLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (RAW_SEPARATOR_BYTE[c] === 1) return 1;
  if (!MULTIBYTE_SEPARATOR_LEADS.has(c)) return 0;
  if (MULTIBYTE_SEPARATORS.has(text.slice(i, i + 2))) return 2;
  return MULTIBYTE_SEPARATORS.has(text.slice(i, i + 3)) ? 3 : 0;
}

function skipRawSeparators(text: string, i: number): number {
  for (let length = rawSeparatorLength(text, i); length > 0; length = rawSeparatorLength(text, i))
    i += length;
  return i;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  const lower = c | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/**
 * End of the escaped separator starting at the backslash at `i`, or -1: a
 * stripEscapedResetSeparators shape, with raw separators allowed between its characters because
 * they are removed first.
 */
function escapedSeparatorEnd(text: string, i: number): number {
  let j = skipRawSeparators(text, i + 1);
  const kind = text.charCodeAt(j) | 0x20;
  if (kind === 0x75) {
    for (let zero = 0; zero < 2; zero++) {
      j = skipRawSeparators(text, j + 1);
      if (text.charCodeAt(j) !== 0x30) return -1;
    }
  } else if (kind !== 0x78) return -1;
  j = skipRawSeparators(text, j + 1);
  const high = text.charCodeAt(j);
  j = skipRawSeparators(text, j + 1);
  const low = text.charCodeAt(j);
  const separator =
    high === 0x30 || high === 0x31 || high === 0x38 || high === 0x39
      ? hexValue(low) >= 0
      : high === 0x32
        ? low === 0x30
        : high === 0x37 && (low | 0x20) === 0x66;
  return separator ? j + 1 : -1;
}

/** Skip raw and escaped separators (single pass: an escaped separator exposed by removing another is not one). */
function skipSeparators(text: string, i: number): number {
  for (;;) {
    const raw = rawSeparatorLength(text, i);
    if (raw > 0) i += raw;
    else if (text.charCodeAt(i) !== 0x5c) return i;
    else {
      const end = escapedSeparatorEnd(text, i);
      if (end < 0) return i;
      i = end;
    }
  }
}

let unitEnd = 0;
/**
 * Decoded character of the unit at `i`, ending at unitEnd: a character, or a \uXXXX / \xXX escape
 * with separators allowed inside (they are removed before decoding). -1 past the text.
 */
function readUnit(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (Number.isNaN(c)) return -1;
  unitEnd = i + 1;
  if (c !== 0x5c) return c;
  let j = skipSeparators(text, i + 1);
  const kind = text.charCodeAt(j);
  const digits = kind === 0x75 ? 4 : kind === 0x78 ? 2 : 0;
  let value = 0;
  for (let digit = 0; digit < digits; digit++) {
    j = skipSeparators(text, j + 1);
    const hex = hexValue(text.charCodeAt(j));
    if (hex < 0) return 0x5c;
    value = value * 16 + hex;
  }
  if (digits === 0) return 0x5c;
  unitEnd = j + 1;
  return value;
}

/**
 * End of `literal` read unit by unit from the unit starting at `start`, separators skipped
 * between units, or -1. For any unit start, this matches exactly where the text after
 * hasRawResetMarker's transforms holds `literal`.
 */
function matchResetLiteral(text: string, start: number, literal: string): number {
  let i = start;
  for (let k = 0; k < literal.length; k++) {
    if (k > 0) i = skipSeparators(text, i);
    if (readUnit(text, i) !== literal.charCodeAt(k)) return -1;
    i = unitEnd;
  }
  return i;
}

/**
 * `text` from `start` with every separator run shortened to a form the matcher reads alike, until
 * at least `limit` characters are out. A run of raw separators is dropped, or kept as one space
 * next to a byte >= 0x80 (a join could otherwise form a multibyte separator); a run holding an
 * escaped separator becomes \x00 (an escaped separator admits only raw ones inside). This bounds
 * retained overlap without changing what a later join can match.
 */
function canonicalizeSeparators(text: string, start: number, limit: number): string {
  let out = "";
  let i = start;
  while (i < text.length && out.length < limit) {
    let j = i;
    let escaped = false;
    for (;;) {
      const raw = rawSeparatorLength(text, j);
      if (raw > 0) j += raw;
      else if (text.charCodeAt(j) !== 0x5c) break;
      else {
        const end = escapedSeparatorEnd(text, j);
        if (end < 0) break;
        j = end;
        escaped = true;
      }
    }
    if (j === i) out += text[i++];
    else {
      if (escaped) out += "\\x00";
      else if (text.charCodeAt(i - 1) >= 0x80 || text.charCodeAt(j) >= 0x80) out += " ";
      i = j;
    }
  }
  return out;
}

/**
 * The raw reset check (hasRawResetMarker) for one row pushed last segment first, as the provider
 * locator reads rows. `boundary` says whether the same transforms of the row hold the compaction
 * boundary needle, which covers every JSON spelling of that pair (escaped key characters,
 * whitespace around the colon). Retains only a canonical head (canonicalizeSeparators) of the
 * text pushed so far, so memory stays bounded for any row size.
 */
function createReverseRawHistoryProbe() {
  const resetNeedle = SESSION_HISTORY_RESET_NEEDLE;
  const boundaryNeedle = SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE;
  // A needle unit spans at most 30 canonical characters: a \u00XX escape (6) with a \x00 run
  // (4) in each of its 5 gaps (hasRawResetMarker removes escaped separators before decoding),
  // plus a \x00 run before the next unit.
  const keep = 30 * Math.max(resetNeedle.length, boundaryNeedle.length);
  let head = "";
  let reset = false;
  let boundary = false;
  return {
    push(bytes: Buffer) {
      // Reset evidence decides the row (a floor), so stop once it is found.
      if (reset) return;
      const raw = bytes.toString("latin1");
      const text = raw + head;
      // Anchors in `head` were tried when their segment arrived, with all text to their right.
      for (let i = 0; i < raw.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 0x22 && c !== 0x5c) continue;
        if (matchResetLiteral(text, i, resetNeedle) >= 0) {
          reset = true;
          return;
        }
        boundary ||= matchResetLiteral(text, i, boundaryNeedle) >= 0;
      }
      head = canonicalizeSeparators(text, 0, keep).slice(0, keep);
    },
    finish(): { reset: boolean; boundary: boolean } {
      return { reset, boundary };
    },
  };
}

/** Call only for parsed reset candidates; oversized rows cannot establish a rollover exemption. */
function hasAmbiguousResetKeys(text: string): boolean {
  if (Buffer.byteLength(text, "utf8") > SESSION_HISTORY_MAX_LINE_BYTES) return true;
  const scanner = createScanner(text, true);
  const scopes: Array<Set<string> | null> = [];
  let previousString: string | undefined;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    switch (token) {
      case SyntaxKind.OpenBraceToken:
        scopes.push(new Set());
        break;
      case SyntaxKind.OpenBracketToken:
        scopes.push(null);
        break;
      case SyntaxKind.CloseBraceToken:
      case SyntaxKind.CloseBracketToken:
        scopes.pop();
        break;
      case SyntaxKind.StringLiteral:
        // Token values decode escapes, so metadata and metad\\u0061ta collide.
        previousString = scanner.getTokenValue();
        continue;
      case SyntaxKind.ColonToken: {
        const keys = scopes.at(-1);
        assert(keys && previousString !== undefined, "parsed JSON colon must follow an object key");
        if (keys.has(previousString)) return true;
        keys.add(previousString);
        break;
      }
      default:
        break;
    }
    previousString = undefined;
  }
  return false;
}

interface HistoryResetProbe {
  resetProbe: string;
  resetStage: 0 | 1 | 2;
  possibleReset: boolean;
}

function addHistoryResetProbe(state: HistoryResetProbe, segment: Buffer, reverse: boolean): void {
  // Oversized tool outputs remain traversable. Only a potential reset
  // marker is a fail-closed privacy barrier. Match raw bytes (including
  // nested objects conservatively) without parsing or retaining the row.
  // Keep only token-sized raw overlap plus a three-stage recognizer.
  // Junk of arbitrary size may separate intact tokens in unreadable rows;
  // valid rows isolate their own evidence in deliver() and reset this state.
  // Re-frozen with F2: separators are skipped inside and between token characters.
  const raw = segment.toString("latin1");
  const window = reverse ? raw + state.resetProbe : state.resetProbe + raw;
  // Tokens starting at or after `edge` (reverse) or ending at or before it (forward) lie in the
  // already-consumed overlap: counted before, and replaying them could manufacture the opposite
  // token ordering.
  const edge = reverse ? raw.length : state.resetProbe.length;
  const tokens: string[] = [];
  for (let i = 0; i < (reverse ? edge : window.length); i++) {
    const c = window.charCodeAt(i);
    if (c !== 0x22 && c !== 0x3a && c !== 0x5c) continue;
    for (const token of RESET_PROBE_TOKENS) {
      const end = matchResetLiteral(window, i, token);
      if (end >= 0 && (reverse || end > edge)) tokens.push(token);
    }
  }
  if (reverse) tokens.reverse();
  for (const token of tokens) {
    if (token === (reverse ? resetValueToken : resetKeyToken)) {
      if (state.resetStage === 0) state.resetStage = 1;
    } else if (token === ":" && state.resetStage === 1) state.resetStage = 2;
    else if (token === (reverse ? resetKeyToken : resetValueToken) && state.resetStage === 2)
      state.possibleReset = true;
  }
  const keep = SESSION_HISTORY_RESET_PROBE_CHARS - 1;
  if (reverse) state.resetProbe = canonicalizeSeparators(window, 0, keep).slice(0, keep);
  else {
    // Canonicalize a tail long enough to yield `keep` characters.
    for (let from = Math.max(0, window.length - 2 * keep); ; ) {
      const tail = canonicalizeSeparators(window, from, Infinity);
      if (tail.length >= keep || from === 0) {
        state.resetProbe = tail.slice(-keep);
        break;
      }
      from = Math.max(0, window.length - 2 * (window.length - from));
    }
  }
}

function classifyHistoryScanRow(text: string, probe: HistoryResetProbe): MuxMessage | null {
  let rowReset = hasRawResetMarker(text);
  probe.possibleReset ||= rowReset;
  try {
    const raw: unknown = JSON.parse(text);
    try {
      rowReset ||= JSON.stringify(raw).includes(SESSION_HISTORY_RESET_NEEDLE);
      probe.possibleReset ||= rowReset;
    } catch {
      rowReset = true;
      probe.possibleReset = true;
    }
    if (rowReset && hasAmbiguousResetKeys(text)) return null;
    if (!isReadableHistoryMessage(raw)) return null;
    // Readable payloads may discuss resets; only their top-level metadata can
    // mark one. Raw evidence is reserved for unreadable/ambiguous rows above.
    probe.possibleReset = false;
    return normalizePersistedMessage(raw);
  } catch {
    return null;
  }
}

interface LocatedHistoryBoundary {
  offset: number;
  boundaryPublicationId?: string;
  boundary: Exclude<PendingBoundary, { kind: "none" }>;
}
type ProviderHistoryStart =
  | ({ kind: "start" } & LocatedHistoryBoundary)
  | { kind: "exhausted"; oldestBoundary: LocatedHistoryBoundary | null; boundaryCount: number }
  | { kind: "stopped" };

/** One non-empty row delivered by the provider locator, newest first. */
interface ScannedHistoryRow {
  start: number;
  /** Row bytes, excluding the newline. */
  size: number;
  /**
   * Null for unreadable and ambiguous-reset rows, and for oversized
   * (> SESSION_HISTORY_MAX_LINE_BYTES) rows other than a recovered compaction boundary.
   */
  message: MuxMessage | null;
}
const STOPPED = Symbol("stopped");

/**
 * Provider-only location: bound row/probe carryover, not the amount of context scanned.
 * `visit` sees every delivered row and may request a stop; the stop is honored only right
 * after a readable row that is not the start, where no scan state carries over.
 */
export async function referenceFindProviderHistoryStart(
  handle: fs.FileHandle,
  fileSize: number,
  skip: number,
  includeReadableResetFloor: boolean,
  visit?: (row: ScannedHistoryRow) => boolean
): Promise<ProviderHistoryStart> {
  const probe: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  let parts: Buffer[] = [];
  let size = 0;
  let rowEnd = fileSize;
  let unreadableRunEnd: number | null = null;
  let oldestBoundary: LocatedHistoryBoundary | null = null;
  let boundaryCount = 0;
  // Re-frozen with F1/F3: oversized rows also stream through the raw probe (own reset evidence,
  // any JSON spelling of the compaction boundary pair).
  let oversizedProbe: ReturnType<typeof createReverseRawHistoryProbe> | null = null;
  const add = (bytes: Buffer) => {
    addHistoryResetProbe(probe, bytes, true);
    size += bytes.length;
    if (size <= SESSION_HISTORY_MAX_LINE_BYTES) {
      parts.push(bytes);
      return;
    }
    if (!oversizedProbe) {
      oversizedProbe = createReverseRawHistoryProbe();
      for (const part of parts) oversizedProbe.push(part);
    }
    parts = [];
    oversizedProbe.push(bytes);
  };
  /**
   * An oversized compaction boundary behaves exactly like a normal-size one (#4551): rotation
   * already treats it as the epoch start, and skipping it here would bring the sealed epoch back
   * from the archive. Re-read just that row and classify it unchanged, accepting only a durable
   * compaction boundary; ordinary oversized rows and reset evidence keep today's handling (the
   * classifier treats reset keys in oversized text as ambiguous, i.e. an unreadable floor).
   */
  const recoverOversizedBoundary = async (start: number): Promise<MuxMessage | null> => {
    assert(oversizedProbe, "an oversized row streams through the raw probe");
    const evidence = oversizedProbe.finish();
    probe.possibleReset ||= evidence.reset;
    if (!evidence.boundary || probe.possibleReset) return null;
    if (size > SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES) {
      log.warn("Oversized compaction boundary row exceeds the recovery ceiling", {
        offset: start,
        bytes: size,
      });
      return null;
    }
    const row = Buffer.alloc(size);
    const read = await handle.read(row, 0, size, start);
    if (read.bytesRead !== size) throw new Error("History changed during provider read");
    const candidate = classifyHistoryScanRow(row.toString("utf8"), probe);
    if (!isDurableCompactionBoundaryMarker(candidate ?? undefined)) return null;
    log.debug("Recovered an oversized compaction boundary row", { offset: start, bytes: size });
    return candidate;
  };
  const deliver = async (
    start: number
  ): Promise<LocatedHistoryBoundary | typeof STOPPED | null> => {
    if (size === 0) {
      rowEnd = start;
      oversizedProbe = null;
      return null;
    }
    const message =
      size > SESSION_HISTORY_MAX_LINE_BYTES
        ? await recoverOversizedBoundary(start)
        : classifyHistoryScanRow(Buffer.concat(parts.reverse()).toString("utf8"), probe);
    const stopRequested = visit?.({ start, size, message }) === true;
    if (message) unreadableRunEnd = null;
    else unreadableRunEnd ??= rowEnd;
    const durableBoundary = message !== null && isDurableContextBoundaryMarker(message);
    if (isManualHistoryReset(message, probe.possibleReset)) {
      // Retain readable reset markers, but never count them as skippable boundaries.
      // Deletion also needs readable malformed-role floors that provider requests exclude.
      if (durableBoundary || (includeReadableResetFloor && message))
        return {
          offset: start,
          boundaryPublicationId: message.metadata?.compactionPublicationId,
          boundary: durableBoundary
            ? { kind: "identified", messageId: message.id }
            : { kind: "unreadable-reset" },
        };
      // A fragmented marker may end several rows to the right of the key that
      // completed recognition. Never return any of that unreadable evidence.
      return { offset: unreadableRunEnd ?? rowEnd, boundary: { kind: "unreadable-reset" } };
    }
    if (durableBoundary) {
      oldestBoundary = {
        offset: start,
        boundary: { kind: "identified", messageId: message.id },
        boundaryPublicationId: message.metadata?.compactionPublicationId,
      };
      if (boundaryCount++ === skip) return oldestBoundary;
    }
    if (message) {
      probe.resetProbe = "";
      probe.resetStage = 0;
      probe.possibleReset = false;
      // Suffix reads (#4720) may stop only here, right after a readable row R that is not the
      // start. Why that equals the full read's tail:
      // - Clean state: the probe was just reset, unreadableRunEnd is null (set above), parts
      //   and size reset below, rowEnd becomes R.start, and with skip 0 no boundary was
      //   skipped (the first durable boundary always returns). That is exactly a fresh scan of
      //   [0, R.start), which can only return a start <= R.start or "exhausted" (whose archive
      //   fallback keeps every row of this file). So every row visited so far, R included, is
      //   in the full provider read of this snapshot.
      // - Readable rows only: a fragmented raw reset can span a run of unreadable rows
      //   (including oversized rows the classifier never parses). When it completes further
      //   left, the floor is unreadableRunEnd, which also drops the NEWER rows of that run, so
      //   stopping on an unreadable row could return rows the full read excludes.
      if (stopRequested) {
        assert(skip === 0, "provider suffix stops require skip 0");
        return STOPPED;
      }
    }
    parts = [];
    size = 0;
    rowEnd = start;
    oversizedProbe = null;
    return null;
  };
  for (let end = fileSize; end > 0; ) {
    const start = Math.max(0, end - SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    const read = await handle.read(chunk, 0, chunk.length, start);
    if (read.bytesRead !== chunk.length) throw new Error("History changed during provider read");
    let edge = chunk.length;
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== 10) continue;
      add(chunk.subarray(i + 1, edge));
      const location = await deliver(start + i + 1);
      if (location === STOPPED) return { kind: "stopped" };
      if (location !== null) return { kind: "start", ...location };
      edge = i;
    }
    add(chunk.subarray(0, edge));
    end = start;
  }
  const location = await deliver(0);
  if (location === STOPPED) return { kind: "stopped" };
  return location === null
    ? { kind: "exhausted", oldestBoundary, boundaryCount }
    : { kind: "start", ...location };
}
