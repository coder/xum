import { createScanner, SyntaxKind } from "jsonc-parser";
import * as fs from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { createHash } from "node:crypto";
import assert from "node:assert";
import {
  SESSION_HISTORY_MAX_SCAN_BYTES,
  SESSION_HISTORY_SCAN_CHUNK_BYTES,
  SESSION_HISTORY_ANCHOR_BYTES,
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_RESET_PROBE_CHARS,
  SESSION_HISTORY_MAX_SCAN_ROWS,
  SESSION_HISTORY_MAX_LINE_BYTES,
  SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE,
  SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES,
} from "@/common/constants/contextBudget";
import type { MuxMessage } from "@/common/types/message";
import { getContextWindowId, isManualHistoryReset } from "@/common/utils/messages/contextWindows";
import {
  getContextBoundaryKind,
  isDurableCompactionBoundaryMarker,
  isDurableContextBoundaryMarker,
} from "@/common/utils/messages/compactionBoundary";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { normalizePersistedMessage } from "@/node/utils/messages/normalizePersistedMessage";
import { EventLoopYielder } from "@/node/utils/concurrency/eventLoopYielder";
import {
  isHistoryIdentifierRepresentable,
  type HistoryArtifact,
  type HistoryScanState,
  type HistorySnapshot,
} from "./historyCursor";
import type { CompactionPendingBoundary as PendingBoundary } from "./compactionPendingState";
import { log } from "./log";
import { projectStatusHistoryRow } from "./historyStatusProjection";

const [resetKeyToken, resetValueToken] = SESSION_HISTORY_RESET_NEEDLE.split(":");
const RESET_PROBE_TOKENS = [resetKeyToken, resetValueToken, ":"] as const;

export function isReadableHistoryMessage(value: unknown): value is MuxMessage {
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

// Raw characters the reset recognizers treat as removable separators. Defined once: the plain-row
// gate below (RESET_OR_BOUNDARY_CANDIDATE) is only sound while it uses exactly this class.
const RESET_SEPARATOR = String.raw`[\s\p{Cc}]`;
const RESET_SEPARATORS = new RegExp(RESET_SEPARATOR, "gu");

function stripRawResetSeparators(text: string): string {
  return text.replace(RESET_SEPARATORS, "");
}
function stripEscapedResetSeparators(text: string): string {
  return text.replace(/\\(?:u00|x)(?:[0189][\da-f]|20|7f)/gi, "");
}

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
const MULTIBYTE_SEPARATOR_LEAD = new Uint8Array(256);
for (const bytes of MULTIBYTE_SEPARATORS) MULTIBYTE_SEPARATOR_LEAD[bytes.charCodeAt(0)] = 1;

/** Length of the raw separator starting at `i`, or 0. */
function rawSeparatorLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (RAW_SEPARATOR_BYTE[c] === 1) return 1;
  if (MULTIBYTE_SEPARATOR_LEAD[c] !== 1) return 0;
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
  // Exact fast reject for the common case, a unit followed by a plain byte (no separator or
  // escape can start there): then the first two units are single characters, except that a
  // backslash starts an escape only before u or x. Scanning giant rows depends on this.
  const c = text.charCodeAt(start);
  const next = text.charCodeAt(start + 1);
  if (next !== 0x5c && RAW_SEPARATOR_BYTE[next] !== 1 && MULTIBYTE_SEPARATOR_LEAD[next] !== 1) {
    if (c === 0x5c) {
      if (next !== 0x75 && next !== 0x78 && literal.charCodeAt(0) !== 0x5c) return -1;
    } else if (c !== literal.charCodeAt(0)) return -1;
    else if (literal.length > 1 && next !== literal.charCodeAt(1)) return -1;
  }
  let i = start;
  for (let k = 0; k < literal.length; k++) {
    if (k > 0) i = skipSeparators(text, i);
    if (readUnit(text, i) !== literal.charCodeAt(k)) return -1;
    i = unitEnd;
  }
  return i;
}

/**
 * Global regex matching exactly the positions where matchResetLiteral passes its fast reject
 * for one of `literals`: a literal's first character followed by its second or by a byte that is
 * not plain, or a backslash followed by u, x or a byte that is not plain. Every other position
 * fails (readUnit reads its own character there, and literals never start with a backslash), so
 * a caller visiting only these positions misses no match, while the regex engine skips the plain
 * text in between natively.
 */
function resetCandidatePattern(literals: readonly string[]): RegExp {
  const byte = (c: number) => `\\x${c.toString(16).padStart(2, "0")}`;
  let notPlain = byte(0x5c);
  for (let c = 0; c < 256; c++)
    if (RAW_SEPARATOR_BYTE[c] === 1 || MULTIBYTE_SEPARATOR_LEAD[c] === 1) notPlain += byte(c);
  const alternatives = new Set([`${byte(0x5c)}[${byte(0x75)}${byte(0x78)}${notPlain}]`]);
  for (const literal of literals) {
    assert(literal.length > 0 && literal.charCodeAt(0) !== 0x5c, "literal starts plainly");
    const first = byte(literal.charCodeAt(0));
    alternatives.add(
      literal.length === 1 ? first : `${first}[${byte(literal.charCodeAt(1))}${notPlain}]`
    );
  }
  return new RegExp([...alternatives].join("|"), "g");
}
const RAW_PROBE_CANDIDATES = resetCandidatePattern([
  SESSION_HISTORY_RESET_NEEDLE,
  SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE,
]);
const TOKEN_PROBE_CANDIDATES = resetCandidatePattern(RESET_PROBE_TOKENS);

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

/** Streaming counterpart of hasRawResetMarker; each transform keeps only a partial escape. */
export function createRawHistoryResetProbe() {
  const decoder = new StringDecoder("utf8");
  let compactTail = "";
  let decodeTail = "";
  let markerTail = "";
  let found = false;
  // Separator removal accepts uppercase U/X; decoding keeps its existing case policy.
  const partialEscape = (text: string) => /\\(?:u[\da-f]{0,3}|x[\da-f]?|)$/i.exec(text)?.[0] ?? "";
  const pushText = (text: string, final = false) => {
    text = compactTail + stripRawResetSeparators(text);
    compactTail = final ? "" : partialEscape(text);
    text =
      decodeTail + stripEscapedResetSeparators(text.slice(0, text.length - compactTail.length));
    decodeTail = final ? "" : partialEscape(text);
    text = markerTail + decodeResetEscapes(text.slice(0, text.length - decodeTail.length));
    found ||= text.includes(SESSION_HISTORY_RESET_NEEDLE);
    markerTail = text.slice(-(SESSION_HISTORY_RESET_NEEDLE.length - 1));
  };
  return {
    push(bytes: Uint8Array) {
      if (!found) pushText(decoder.write(bytes));
    },
    finish() {
      pushText(decoder.end(), true);
      return found;
    },
  };
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
      const candidates = RAW_PROBE_CANDIDATES;
      candidates.lastIndex = 0;
      for (let found = candidates.exec(text); found !== null; found = candidates.exec(text)) {
        const i = found.index;
        if (i >= raw.length) break;
        candidates.lastIndex = i + 1;
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

export function hasRawResetMarker(text: string): boolean {
  const decoded = decodeResetEscapes(compactResetProbe(text));
  return decoded.includes(SESSION_HISTORY_RESET_NEEDLE);
}

/** Call only for parsed reset candidates; oversized rows cannot establish a rollover exemption. */
export function hasAmbiguousResetKeys(text: string): boolean {
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
  // the locator resets this state after every readable row (settle()).
  //
  // Separators are skipped inside and between token characters as hasRawResetMarker removes them
  // (F2): rows join without their LF, so a CR or space before it, or a separator anywhere inside a
  // token, must not hide the token. Tokens are matched at every `"`, `:` and backslash, so they may
  // overlap. Retained overlap is canonical (canonicalizeSeparators): long separator runs never
  // push a token half out of it. #5212 plans to skip matching for segments with no byte a token
  // can start with; anchors are exactly those bytes, but a segment without them can still finish a
  // token that starts in the retained overlap (forward) or supply its tail (reverse).
  const raw = segment.toString("latin1");
  const window = reverse ? raw + state.resetProbe : state.resetProbe + raw;
  // Tokens starting at or after `edge` (reverse) or ending at or before it (forward) lie in the
  // already-consumed overlap: counted before, and replaying them could manufacture the opposite
  // token ordering.
  const edge = reverse ? raw.length : state.resetProbe.length;
  const tokens: string[] = [];
  const candidates = TOKEN_PROBE_CANDIDATES;
  candidates.lastIndex = 0;
  for (let found = candidates.exec(window); found !== null; found = candidates.exec(window)) {
    const i = found.index;
    if (reverse && i >= edge) break;
    candidates.lastIndex = i + 1;
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

/** Feed one oversized row in reverse byte ranges, using the provider's unchanged recognizer. */
export function createUnreadableHistoryResetProbe() {
  const state: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  return {
    push: (bytes: Buffer) => addHistoryResetProbe(state, bytes, true),
    hasReset: () => state.possibleReset,
  };
}

// Exported for tests: historyScanner.plainRow.test.ts checks readPlainHistoryRow against it.
export function classifyHistoryScanRow(text: string, probe: HistoryResetProbe): MuxMessage | null {
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

// Any backslash that may start a \u / \x escape (separators allowed before the letter, as
// stripRawResetSeparators removes them first), the letters of "reset" joined only by separators,
// or the compaction boundary key. See readPlainHistoryRow for why this set suffices.
const RESET_OR_BOUNDARY_CANDIDATE = (() => {
  const separators = `${RESET_SEPARATOR}*`;
  return new RegExp(
    [String.raw`\\${separators}[uUxX]`, [..."reset"].join(separators), "compactionBoundary"].join(
      "|"
    ),
    "u"
  );
})();

// Rows with more `[` plus `{` bytes than this take the full classifier path: nesting depth is at
// most that count, and JSON.stringify must provably not throw for plain rows (see below).
const PLAIN_ROW_MAX_BRACKETS = 1024;

/**
 * Startup check for the bracket guard. JSON.parse is iterative, but JSON.stringify recurses: V8
 * on the Node main thread throws around depth 3-5k, Bun/JSC far deeper. If this runtime cannot
 * stringify PLAIN_ROW_MAX_BRACKETS levels (alternating objects and arrays), disable the plain-row
 * fast path so every row keeps the full classifier.
 */
const plainRowFastPathEnabled = (() => {
  let nested: unknown = [];
  for (let depth = 1; depth < PLAIN_ROW_MAX_BRACKETS; depth++)
    nested = depth % 2 === 0 ? [nested] : { a: nested };
  try {
    JSON.stringify(nested);
    return true;
  } catch (error) {
    log.warn("Disabled the provider history plain-row fast path: shallow JSON.stringify failed", {
      depth: PLAIN_ROW_MAX_BRACKETS,
      error: String(error),
    });
    return false;
  }
})();

/** True when the row's `[` plus `{` bytes exceed PLAIN_ROW_MAX_BRACKETS. */
function exceedsPlainRowBrackets(segments: readonly Buffer[], size: number): boolean {
  if (size <= PLAIN_ROW_MAX_BRACKETS) return false;
  let count = 0;
  for (const segment of segments) {
    for (const bracket of [0x5b, 0x7b]) {
      for (let i = segment.indexOf(bracket); i !== -1; i = segment.indexOf(bracket, i + 1))
        if (++count > PLAIN_ROW_MAX_BRACKETS) return true;
    }
  }
  return false;
}

/**
 * Fast path of the provider locator for a row of at most SESSION_HISTORY_MAX_LINE_BYTES: returns
 * the message classifyHistoryScanRow would return when the row provably carries no reset or
 * boundary evidence, and null otherwise (the caller then runs the reset probe and the full
 * classifier). `segments` are the row's bytes in any order, `text` their utf8 decoding in file
 * order, `size` their total length.
 *
 * SAFETY (provider privacy, #4655): for rows this returns non-null, skipping the probe and the
 * full classifier cannot change what the locator returns or delivers:
 * 1. The caller defers the row's addHistoryResetProbe calls and replays them in arrival order
 *    only when this returns null (or at once when the row turns oversized), so the probe sees
 *    the exact call sequence it saw before. Nothing reads the probe between a row's add() and its
 *    delivery; recoverOversizedBoundary reads it only after that flush.
 * 2. For a row the full path classifies readable, the probe state is unobservable: the
 *    classifier forces possibleReset = false and the locator clears the probe after a readable
 *    row. The only outputs are the message, unreadableRunEnd = null and the boundary checks.
 * 3. No candidate match implies hasRawResetMarker(text) is false: with no backslash followed
 *    (after optional separators) by u/U/x/X, stripEscapedResetSeparators and decodeResetEscapes
 *    are identities on stripRawResetSeparators(text), and the needle contains "reset", which then
 *    needs r, e, s, e, t joined only by separator characters (the same RESET_SEPARATOR class).
 * 4. The needle in JSON.stringify(parsed) needs a parsed string exactly "reset". Without \u
 *    escapes JSON.parse forms letters only from literal letters, so the text would contain a
 *    literal "reset", which the candidate regex excludes.
 * 5. JSON.stringify of parsed data throws only on nesting deeper than the stack allows (its
 *    output is at most 6x a 1 MiB row). Depth is at most the bracket count, capped at
 *    PLAIN_ROW_MAX_BRACKETS, and the startup check proved that depth safe in this runtime.
 * 6. So rowReset stays false (hasAmbiguousResetKeys is never consulted) and the classifier returns
 *    normalizePersistedMessage of the same parse, as below. normalize (legacy rename,
 *    idleCompacted, tool payload depth) never adds compactionBoundary or contextBoundaryKind, and
 *    without \u escapes a parsed key needs its literal text, so the message is neither a durable
 *    boundary nor a manual reset, and the locator takes the same branches with the same message.
 * Unreadable rows and rows with reset or boundary evidence, escapes, deep nesting or oversize all
 * keep the full path. If this gate ever needs more cases, narrow it (send more rows to the full
 * path) instead of adding mechanism.
 */
// Exported for tests: historyScanner.plainRow.test.ts checks it against classifyHistoryScanRow.
export function readPlainHistoryRow(
  text: string,
  segments: readonly Buffer[],
  size: number
): MuxMessage | null {
  if (!plainRowFastPathEnabled || RESET_OR_BOUNDARY_CANDIDATE.test(text)) return null;
  if (exceedsPlainRowBrackets(segments, size)) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (!isReadableHistoryMessage(raw)) return null;
    return normalizePersistedMessage(raw);
  } catch {
    // Same as classifyHistoryScanRow: a parse or normalize failure makes the row unreadable.
    return null;
  }
}

/** Use the provider reader's probe when rewrites join previously separated unreadable rows. */
export function hasUnreadableHistoryResetEvidence(rows: readonly Buffer[]): boolean {
  const probe: HistoryResetProbe = { resetProbe: "", resetStage: 0, possibleReset: false };
  for (let i = rows.length - 1; i >= 0; i--) {
    const raw = rows[i].at(-1) === 10 ? rows[i].subarray(0, -1) : rows[i];
    addHistoryResetProbe(probe, raw, true);
    if (raw.length <= SESSION_HISTORY_MAX_LINE_BYTES)
      classifyHistoryScanRow(raw.toString("utf8"), probe);
    else {
      // The provider locator also checks an oversized row's own text for the marker (F1).
      const local = createRawHistoryResetProbe();
      for (let offset = 0; offset < raw.length; offset += SESSION_HISTORY_SCAN_CHUNK_BYTES)
        local.push(raw.subarray(offset, offset + SESSION_HISTORY_SCAN_CHUNK_BYTES));
      probe.possibleReset ||= local.finish();
    }
    if (probe.possibleReset) return true;
  }
  return false;
}

function historyFileStamp(
  stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } | undefined
): string {
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "missing";
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
// Exported for tests: historyScanner.differential.test.ts compares it with the frozen #4655 oracle.
export async function findProviderHistoryStart(
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
  // Oversized rows are never classified, so their segments also stream through the raw probe:
  // hasRawResetMarker for the row's own reset evidence (a floor, F1), and any JSON spelling of the
  // compaction boundary pair to pick rows worth re-reading (F3). Rows up to the line limit get
  // both from the classifier instead.
  let oversizedProbe: ReturnType<typeof createReverseRawHistoryProbe> | null = null;
  // `parts` holds the row's segments in arrival (reverse file) order while the row fits
  // SESSION_HISTORY_MAX_LINE_BYTES. Their reset-probe calls are deferred (readPlainHistoryRow,
  // point 1): replayed in arrival order by readBufferedRow when the fast path declines, or flushed
  // here the moment the row turns oversized, after which segments stream into the probe as before.
  const feedProbe = (segments: readonly Buffer[]) => {
    for (const segment of segments) addHistoryResetProbe(probe, segment, true);
  };
  const add = (bytes: Buffer) => {
    size += bytes.length;
    if (size <= SESSION_HISTORY_MAX_LINE_BYTES) {
      parts.push(bytes);
      return;
    }
    if (!oversizedProbe) {
      oversizedProbe = createReverseRawHistoryProbe();
      for (const part of parts) oversizedProbe.push(part);
    }
    feedProbe(parts);
    parts = [];
    addHistoryResetProbe(probe, bytes, true);
    oversizedProbe.push(bytes);
  };
  /**
   * An oversized compaction boundary behaves exactly like a normal-size one (#4551): rotation
   * already treats it as the epoch start, and skipping it here would bring the sealed epoch back
   * from the archive. Re-read just that row and classify it unchanged, accepting only a durable
   * compaction boundary. The raw probe picks candidates in any JSON spelling (F3), so the classifier
   * decides; memory stays bounded by SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES as before. Reset
   * evidence keeps the row an unreadable floor (the classifier also treats reset keys in oversized
   * text as ambiguous).
   */
  const recoverOversizedBoundary = async (start: number): Promise<MuxMessage | null> => {
    assert(oversizedProbe, "an oversized row streams through the raw probe");
    const evidence = oversizedProbe.finish();
    // Local reset evidence floors an oversized row exactly like a classified one.
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
  const readBufferedRow = (): MuxMessage | null => {
    // Single-segment rows (all but rows crossing a chunk edge) need no concat; keep `parts` in
    // arrival order for the probe replay below.
    const text = (parts.length === 1 ? parts[0] : Buffer.concat([...parts].reverse())).toString(
      "utf8"
    );
    const plain = readPlainHistoryRow(text, parts, size);
    if (plain) return plain;
    feedProbe(parts);
    return classifyHistoryScanRow(text, probe);
  };
  type Delivered = LocatedHistoryBoundary | typeof STOPPED | null;
  const settle = (start: number, message: MuxMessage | null): Delivered => {
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
  /** Synchronous for rows up to the line limit: only an oversized row may re-read the file. */
  const deliver = (start: number): Delivered | Promise<Delivered> => {
    if (size === 0) {
      rowEnd = start;
      return null;
    }
    if (size > SESSION_HISTORY_MAX_LINE_BYTES)
      return recoverOversizedBoundary(start).then((message) => settle(start, message));
    return settle(start, readBufferedRow());
  };
  for (let end = fileSize; end > 0; ) {
    const start = Math.max(0, end - SESSION_HISTORY_SCAN_CHUNK_BYTES);
    const chunk = Buffer.alloc(end - start);
    const read = await handle.read(chunk, 0, chunk.length, start);
    if (read.bytesRead !== chunk.length) throw new Error("History changed during provider read");
    let edge = chunk.length;
    // Native newline search. Stop explicitly at index 0: a negative offset would search from the
    // end of the chunk again.
    for (let i = chunk.lastIndexOf(10); i >= 0; i = i > 0 ? chunk.lastIndexOf(10, i - 1) : -1) {
      add(chunk.subarray(i + 1, edge));
      const delivered = deliver(start + i + 1);
      const location = delivered instanceof Promise ? await delivered : delivered;
      if (location === STOPPED) return { kind: "stopped" };
      if (location !== null) return { kind: "start", ...location };
      edge = i;
    }
    add(chunk.subarray(0, edge));
    end = start;
  }
  const delivered = deliver(0);
  const location = delivered instanceof Promise ? await delivered : delivered;
  if (location === STOPPED) return { kind: "stopped" };
  return location === null
    ? { kind: "exhausted", oldestBoundary, boundaryCount }
    : { kind: "start", ...location };
}

interface HistorySnapshotFile {
  handle: fs.FileHandle;
  size: number;
  stamp: string;
}

/**
 * Open descriptors of both history files, pinned with their stamps at open time. The status read
 * (#4790) opens it under the history lock and scans it after releasing the lock, so opening,
 * verifying and closing are separate steps. (Not historyCursor's HistorySnapshot, which is a
 * persisted scan position.)
 */
export interface OpenHistorySnapshot {
  files: ReadonlyMap<HistoryArtifact, HistorySnapshotFile>;
  /** Throws "History changed during provider read" if either pathname was replaced or resized. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

export async function openHistorySnapshot(
  paths: Record<HistoryArtifact, string>
): Promise<OpenHistorySnapshot> {
  const files = new Map<HistoryArtifact, HistorySnapshotFile>();
  const close = async () => {
    await Promise.all([...files.values()].map((file) => file.handle.close()));
  };
  try {
    for (const artifact of ["chat", "archive"] as const) {
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(paths[artifact], "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // Register before stat so a failed snapshot still closes its descriptor.
      files.set(artifact, { handle, size: 0, stamp: "missing" });
      const stat = await handle.stat();
      files.set(artifact, { handle, size: stat.size, stamp: historyFileStamp(stat) });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    files,
    verify: async () => {
      // Foreign writers can replace either pathname while these descriptors stay
      // open. Never release provider rows assembled from an obsolete raw offset.
      for (const artifact of ["chat", "archive"] as const) {
        const stat = await fs.stat(paths[artifact]).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (historyFileStamp(stat) !== (files.get(artifact)?.stamp ?? "missing")) {
          throw new Error("History changed during provider read");
        }
      }
    },
    close,
  };
}

/** Run `read` on open descriptors of both history files and fail closed if either was replaced. */
async function withVerifiedHistorySnapshot<T>(
  paths: Record<HistoryArtifact, string>,
  read: (files: ReadonlyMap<HistoryArtifact, HistorySnapshotFile>) => Promise<T>
): Promise<T> {
  const snapshot = await openHistorySnapshot(paths);
  try {
    const result = await read(snapshot.files);
    await snapshot.verify();
    return result;
  } finally {
    await snapshot.close();
  }
}

/** Keep raw location and projected tail reads on one verified snapshot, without write-lock re-entry. */
async function readHistoryProjectionFromLatestBoundary<Row>(
  paths: Record<HistoryArtifact, string>,
  skip: number,
  project?: (value: unknown) => Row | null,
  includeReadableResetFloor = false,
  clampToOldest = true,
  onBytesRead?: (bytes: number) => void
): Promise<{ messages: Row[]; boundary: PendingBoundary; boundaryPublicationId?: string }> {
  assert(Number.isSafeInteger(skip) && skip >= 0, "provider boundary skip must be non-negative");
  return withVerifiedHistorySnapshot(paths, async (files) => {
    const locate = async (
      artifact: HistoryArtifact,
      skipCount: number
    ): Promise<Exclude<ProviderHistoryStart, { kind: "stopped" }>> => {
      const file = files.get(artifact);
      if (!file) return { kind: "exhausted", oldestBoundary: null, boundaryCount: 0 };
      const location = await findProviderHistoryStart(
        file.handle,
        file.size,
        skipCount,
        includeReadableResetFloor
      );
      assert(location.kind !== "stopped", "provider reads without a visitor never stop");
      return location;
    };
    const readTail = async (artifact: HistoryArtifact, offset: number): Promise<Row[]> => {
      const file = files.get(artifact);
      if (!file || !project) return [];
      assert(offset >= 0 && offset <= file.size, "provider start must be within its snapshot");
      const buffer = Buffer.alloc(file.size - offset);
      const read = await file.handle.read(buffer, 0, buffer.length, offset);
      if (read.bytesRead !== buffer.length) throw new Error("History changed during provider read");
      onBytesRead?.(read.bytesRead);
      const messages: Row[] = [];
      // Multi-hundred-MB epochs parse for seconds; keep timers (onChat heartbeats) alive.
      const yielder = new EventLoopYielder();
      // Decode per row instead of one toString+split of the whole tail (a single ~0.4 s block at
      // hundreds of MB, #4655). Equal output: 0x0A is ASCII, never inside a UTF-8 multibyte
      // sequence, and an invalid sequence ends at it, so per-row decoding matches decoding the
      // whole buffer and splitting on "\n".
      for (let pos = 0; pos < buffer.length; ) {
        if (yielder.isDue()) await yielder.yield();
        const newline = buffer.indexOf(10, pos);
        const end = newline === -1 ? buffer.length : newline;
        const line = buffer.toString("utf8", pos, end);
        pos = end + 1;
        if (!line.trim()) continue;
        try {
          const row = project(JSON.parse(line) as unknown);
          if (row !== null) messages.push(row);
        } catch {
          // Project only usable rows; full/UI history keeps its existing reader.
        }
      }
      return messages;
    };
    const chat = await locate("chat", skip);
    let messages: Row[];
    let boundary: PendingBoundary = { kind: "none" };
    let boundaryPublicationId: string | undefined;
    if (chat.kind === "start") {
      boundary = chat.boundary;
      boundaryPublicationId = chat.boundaryPublicationId;
      messages = await readTail("chat", chat.offset);
    } else {
      const archive = await locate("archive", skip - chat.boundaryCount);
      if (archive.kind === "start" || (clampToOldest && archive.oldestBoundary !== null)) {
        const location = archive.kind === "start" ? archive : archive.oldestBoundary!;
        boundary = location.boundary;
        boundaryPublicationId = location.boundaryPublicationId;
        messages = [
          ...(await readTail("archive", location.offset)),
          ...(await readTail("chat", 0)),
        ];
      } else if (clampToOldest && chat.oldestBoundary !== null) {
        boundary = chat.oldestBoundary.boundary;
        boundaryPublicationId = chat.oldestBoundary.boundaryPublicationId;
        messages = await readTail("chat", chat.oldestBoundary.offset);
      } else messages = [...(await readTail("archive", 0)), ...(await readTail("chat", 0))];
    }
    return { messages, boundary, boundaryPublicationId };
  });
}

export function readProviderHistoryFromLatestBoundary(
  paths: Record<HistoryArtifact, string>,
  skip: number,
  options?: {
    /** Mutation classification needs the excluded floor itself; provider requests leave this off. */
    includeReadableResetFloor?: boolean;
    /** Replay timing (#4504): raw tail bytes read from disk, reported per file read. */
    onBytesRead?: (bytes: number) => void;
  }
): Promise<MuxMessage[]> {
  return readHistoryProjectionFromLatestBoundary(
    paths,
    skip,
    (value) => (isReadableHistoryMessage(value) ? normalizePersistedMessage(value) : null),
    options?.includeReadableResetFloor,
    undefined,
    options?.onBytesRead
  ).then((view) => view.messages);
}

/**
 * The sidebar status read (#4720, #4790): a suffix of readProviderHistoryFromLatestBoundary(paths,
 * 0) holding at least `minMatching` rows that satisfy `matches`, or the whole read when it has
 * fewer. Same raw locator and snapshot verification, but it stops at the first safe row once the
 * window is full instead of parsing the whole active epoch. The caller owns `snapshot.close()`.
 *
 * Rows over SESSION_HISTORY_MAX_LINE_BYTES are status-grade, never provider-grade: their tool
 * payloads come back null and their file URLs "" (historyStatusProjection.ts), and the elided
 * bytes are not validated. Status reads none of them; see projectStatusHistoryRow for why the
 * row set and every field status reads stay equal.
 */
export async function readStatusHistorySuffix(
  snapshot: OpenHistorySnapshot,
  minMatching: number,
  matches: (message: MuxMessage) => boolean
): Promise<MuxMessage[]> {
  assert(Number.isSafeInteger(minMatching) && minMatching > 0, "suffix window must be positive");
  const messages = await scanHistorySnapshot(
    snapshot.files,
    { minMatching, matches },
    undefined,
    true
  );
  await snapshot.verify();
  return messages;
}

/**
 * readProviderHistoryFromLatestBoundary(paths, 0) in one pass (#4655): the suffix scan with a
 * stop that is never requested, so the active epoch is read and parsed once instead of located
 * and then re-read. Why the result is equal:
 * - The scan visits every row from the end of chat.jsonl to the located start (or the whole file
 *   when exhausted), keeps rows with `start >= from`, and reads the archive only when chat is
 *   exhausted. With skip 0 an exhausted file has no oldest boundary (the first durable boundary
 *   always returns a start), so the two-pass reader's clamp branches never apply.
 * - Rows the classifier leaves null but the two-pass projection would accept (reset evidence with
 *   ambiguous keys, a stringify throw) floor themselves out: the start is at or after such a row,
 *   so it is never in the returned range (#4720; statusSuffix "unbounded window" cases).
 * - A row up to the line limit keeps the locator's message, normalizePersistedMessage of the same
 *   JSON.parse the projection does; oversized rows are re-read and parsed by that projection.
 * `onBytesRead` keeps the replay-timing meaning (#4504): the raw tail bytes of each file whose
 * rows are returned, archive before chat.
 */
export function readProviderHistory(
  paths: Record<HistoryArtifact, string>,
  options?: { onBytesRead?: (bytes: number) => void }
): Promise<MuxMessage[]> {
  return withVerifiedHistorySnapshot(paths, (files) =>
    scanHistorySnapshot(files, undefined, options?.onBytesRead, false)
  );
}

/**
 * Shared scan of readStatusHistorySuffix (with `stop`, projecting oversized rows) and
 * readProviderHistory (without either). Every positional read checks its length: under the
 * status read's released lock a foreign in-place shrink must fail closed, never parse a partial
 * row (#4790).
 */
async function scanHistorySnapshot(
  files: ReadonlyMap<HistoryArtifact, HistorySnapshotFile>,
  stop: { minMatching: number; matches: (message: MuxMessage) => boolean } | undefined,
  onBytesRead: ((bytes: number) => void) | undefined,
  projectOversized: boolean
): Promise<MuxMessage[]> {
  // Newest file first; each file's rows are newest first and those starting before `from` are
  // not part of the read.
  const scanned: Array<{ file: HistorySnapshotFile; rows: ScannedHistoryRow[]; from: number }> = [];
  let matching = 0;
  for (const artifact of ["chat", "archive"] as const) {
    const file = files.get(artifact);
    if (!file) continue;
    const rows: ScannedHistoryRow[] = [];
    const location = await findProviderHistoryStart(file.handle, file.size, 0, false, (row) => {
      rows.push(row);
      if (!stop) return false;
      // Only rows the full read projects count; oversized rows are parsed below.
      if (row.message !== null && stop.matches(row.message)) matching++;
      // Monotonic: the stop stays requested across unreadable rows until a safe one.
      return matching >= stop.minMatching;
    });
    assert(
      stop !== undefined || location.kind !== "stopped",
      "provider reads without a stop never stop"
    );
    scanned.push({ file, rows, from: location.kind === "start" ? location.offset : 0 });
    // A start or a clean stop ends the read. An exhausted file keeps all its rows (no older
    // file can exclude them); continue into the archive only while the window is short.
    if (location.kind !== "exhausted" || (stop && matching >= stop.minMatching)) break;
  }
  const messages: MuxMessage[] = [];
  for (let s = scanned.length - 1; s >= 0; s--) {
    const { file, rows, from } = scanned[s];
    onBytesRead?.(file.size - from);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].start < from) continue;
      const message = await projectScannedRow(file, rows[i], projectOversized);
      if (message) messages.push(message);
    }
  }
  return messages;
}

/** A located row as the full read projects it: the locator's parse, or a re-read if oversized. */
async function projectScannedRow(
  file: HistorySnapshotFile,
  row: ScannedHistoryRow,
  projectOversized: boolean
): Promise<MuxMessage | null> {
  if (row.size <= SESSION_HISTORY_MAX_LINE_BYTES) return row.message;
  // The locator does not parse oversized rows, but the full read's tail projection does.
  // allocUnsafe is safe only because a short read throws before any byte is decoded.
  const buffer = Buffer.allocUnsafe(row.size);
  const read = await file.handle.read(buffer, 0, buffer.length, row.start);
  if (read.bytesRead !== buffer.length) throw new Error("History changed during provider read");
  try {
    // Status only: cut the payloads it never reads before decoding (#4790).
    const text =
      (projectOversized ? projectStatusHistoryRow(buffer) : null) ?? buffer.toString("utf8");
    const value: unknown = JSON.parse(text);
    return isReadableHistoryMessage(value) ? normalizePersistedMessage(value) : null;
  } catch {
    // Same as the full read: unusable rows are not projected.
    return null;
  }
}

// ── Trailing window for onChat replay (#4961) ──────────────────────────────
// Contract of readProviderHistoryWindow:
// - It returns at most `maxRows` rows and `maxBytes` raw row bytes.
// - It never returns a row that full replay (readProviderHistory) would drop: the window is
//   always a suffix of that read.
// - The window starts at a clean turn start: the first row after the previous turn's last
//   assistant row, so a prompt's snapshot cluster always stays with its prompt. An active epoch
//   that fits the budget is returned whole, from the epoch start.
// - The only fallback: when the budget holds no clean turn start (one turn is longer than the
//   window, or the newest row alone is over `maxBytes`), it returns "not-windowable" and the
//   caller uses full replay.
// How: the backward scan counts every row toward the budget (unreadable, oversized and malformed
// rows too) and never classifies them. It keeps only rows within the budget, so a long corrupt
// tail is never retained (#5220). The final pass projects those rows exactly as full replay does
// (dropping malformed rows, re-reading oversized ones) and trims forward only, to the first clean
// turn start. There is no backward extension.

// Pages before a cursor (#4961 PR3) reuse the same scan. Contract of readProviderHistoryPage:
// - A page holds at most `maxRows` rows and `maxBytes` raw row bytes, and never a row that full
//   replay would drop.
// - The cursor is the numeric historySequence of the client's oldest row. A page ends right
//   before the cursor row and starts at a clean turn start (as above), or at the epoch start.
// - The only fallback is "not-pageable" (the client then does a full replay): the cursor row is
//   not located exactly once in the scanned range, a readable row in that range has no numeric
//   sequence, or no clean turn start fits the budget. Rows newer than the cursor are skipped,
//   neither kept nor counted; oversized and malformed rows are counted, never classified.
// - "before-epoch" means no active-epoch row precedes the cursor (the cursor is the epoch's first
//   row, or older): the caller pages older epochs as before.

// Since reconnects of a windowed client (#4961 PR2b) reuse it too. Contract of
// readProviderHistorySince, for a client whose rows run from its floor row to its anchor row:
// - "range" is the suffix of full replay from the floor row (the row whose historySequence is
//   `floor`) to EOF. Rows older than the floor row are never read.
// - It holds at most two windows (`caps` twice): the client's rows plus a delta, where the delta
//   (rows newer than the anchor row) alone fits `caps`.
// - The only other result is "not-in-range": the floor row is not in the active epoch within that
//   budget (a compaction or reset since, truncated, or too old), or a second row carries the
//   anchor's sequence. The caller then does a fresh windowed full replay.
// - It checks nothing else: the caller's since checks (anchor row, oldest sequence, fingerprint)
//   run on the returned rows. Oversized rows are never matched as the floor or anchor row (the
//   locator does not parse them), which only makes the read stricter.

export interface HistoryWindowCaps {
  maxRows: number;
  maxBytes: number;
}

export type HistoryWindow =
  | { kind: "window"; messages: MuxMessage[]; reachedEpochStart: boolean }
  | { kind: "not-windowable" };

export type HistoryPage =
  | { kind: "page"; messages: MuxMessage[]; reachedEpochStart: boolean }
  | { kind: "not-pageable" }
  | { kind: "before-epoch" };

export async function readProviderHistoryWindow(
  paths: Record<HistoryArtifact, string>,
  caps: HistoryWindowCaps
): Promise<HistoryWindow> {
  const tail = await readActiveEpochTail(paths, caps, undefined);
  assert(tail.kind !== "before-epoch", "a window has no cursor");
  return tail.kind === "page" ? { ...tail, kind: "window" } : { kind: "not-windowable" };
}

export function readProviderHistoryPage(
  paths: Record<HistoryArtifact, string>,
  caps: HistoryWindowCaps,
  beforeHistorySequence: number
): Promise<HistoryPage> {
  assert(isNonNegativeInteger(beforeHistorySequence), "page cursor must be a sequence");
  return readActiveEpochTail(paths, caps, beforeHistorySequence);
}

export type HistorySinceRange =
  | { kind: "range"; messages: MuxMessage[] }
  | { kind: "not-in-range" };

export async function readProviderHistorySince(
  paths: Record<HistoryArtifact, string>,
  caps: HistoryWindowCaps,
  since: { floor: number; anchor: number }
): Promise<HistorySinceRange> {
  assert(isNonNegativeInteger(since.floor), "since floor must be a sequence");
  assert(isNonNegativeInteger(since.anchor), "since anchor must be a sequence");
  const tail = await readActiveEpochTail(paths, caps, undefined, since);
  return tail.kind === "page"
    ? { kind: "range", messages: tail.messages }
    : { kind: "not-in-range" };
}

/**
 * The newest rows of the active epoch that precede the `before` row (or EOF when undefined), or
 * with `since`, the rows from EOF back to the floor row.
 */
function readActiveEpochTail(
  paths: Record<HistoryArtifact, string>,
  caps: HistoryWindowCaps,
  before: number | undefined,
  since?: { floor: number; anchor: number }
): Promise<HistoryPage> {
  assert(Number.isSafeInteger(caps.maxRows) && caps.maxRows > 0, "window maxRows must be > 0");
  assert(Number.isSafeInteger(caps.maxBytes) && caps.maxBytes > 0, "window maxBytes must be > 0");
  return withVerifiedHistorySnapshot(paths, async (files) => {
    // Newest first, like scanHistorySnapshot: rows starting before a file's located start are
    // not part of full replay, and the archive is read only after chat.jsonl is exhausted.
    const kept: Array<{ file: HistorySnapshotFile; row: ScannedHistoryRow }> = [];
    let rows = 0;
    let bytes = 0;
    let overBudget = false;
    // Page cursor state; a window starts at EOF, so its cursor is "located" from the start.
    let cursor: { file: HistorySnapshotFile; start: number } | undefined;
    let unpageable = false;
    let oldestSequence: number | undefined;
    // Since state: the cursor is the floor row.
    let anchorSeen = false;
    const sinceRange = { maxRows: 2 * caps.maxRows, maxBytes: 2 * caps.maxBytes };
    for (const artifact of ["chat", "archive"] as const) {
      const file = files.get(artifact);
      if (!file) continue;
      const fileRows: ScannedHistoryRow[] = [];
      const location = await findProviderHistoryStart(file.handle, file.size, 0, false, (row) => {
        if (before !== undefined && row.message) {
          const sequence = row.message.metadata?.historySequence;
          if (!isNonNegativeInteger(sequence)) unpageable = true;
          else {
            oldestSequence = sequence;
            if (sequence === before) {
              if (cursor) unpageable = true;
              cursor = { file, start: row.start };
              return false;
            }
          }
        }
        if (before !== undefined && !cursor) return unpageable;
        const rowSequence = row.message?.metadata?.historySequence;
        if (since && rowSequence === since.anchor) {
          if (anchorSeen) unpageable = true;
          anchorSeen = true;
        }
        // Since: the delta (rows newer than the anchor row) fits one window, the whole range two.
        const limit = since && anchorSeen ? sinceRange : caps;
        if (!overBudget && rows < limit.maxRows && bytes + row.size <= limit.maxBytes) {
          rows++;
          bytes += row.size;
          fileRows.push(row);
        } else overBudget = true;
        if (since && rowSequence === since.floor && !overBudget) {
          cursor = { file, start: row.start };
          return true;
        }
        // Monotonic: the locator honors the stop at the next readable row. Every row visited up
        // to there is in full replay, and rows past the budget were counted, never kept.
        return overBudget || unpageable;
      });
      const from = location.kind === "start" ? location.offset : 0;
      // A cursor row below the file's epoch start is not a row of full replay.
      if (cursor?.file === file && cursor.start < from) unpageable = true;
      for (const row of fileRows) if (row.start >= from) kept.push({ file, row });
      if (location.kind !== "exhausted" || overBudget || unpageable) break;
    }
    if (unpageable) return { kind: "not-pageable" };
    // The floor row is found only within the budget; the since read then ends at it.
    if (since && !cursor) return { kind: "not-pageable" };
    if (before !== undefined && !cursor) {
      // Missing from the epoch: older than all of it, or gone (truncated) while held.
      const older = oldestSequence === undefined || before < oldestSequence;
      return { kind: older ? "before-epoch" : "not-pageable" };
    }
    const messages: MuxMessage[] = [];
    for (let i = kept.length - 1; i >= 0; i--) {
      const message = await projectScannedRow(kept[i].file, kept[i].row, false);
      if (message) messages.push(message);
    }
    // Within budget, the scan reached the epoch start (or read all history): the whole epoch.
    if (!overBudget) {
      if (before !== undefined && messages.length === 0) return { kind: "before-epoch" };
      return { kind: "page", messages, reachedEpochStart: true };
    }
    // Otherwise the oldest kept row's turn may begin before the budget: trim forward only.
    const start = messages.findIndex(
      (message, i) => i > 0 && message.role === "user" && messages[i - 1].role === "assistant"
    );
    if (start === -1) return { kind: "not-pageable" };
    // The next page ends right before this row, so it needs a sequence (an oversized row's
    // sequence is only known here).
    const first = messages[start].metadata?.historySequence;
    if (before !== undefined && !isNonNegativeInteger(first)) return { kind: "not-pageable" };
    return { kind: "page", messages: messages.slice(start), reachedEpochStart: false };
  });
}

/** Exact occurrence evidence shares the verified boundary scan; never persist it in legacy fallback tags. */
export async function readCompactionPendingHistoryObservation(
  paths: Record<HistoryArtifact, string>,
  skip = 0
) {
  const { boundary, boundaryPublicationId } = await readHistoryProjectionFromLatestBoundary(
    paths,
    skip,
    undefined,
    false,
    false
  );
  return { boundary, boundaryPublicationId };
}

/** Inactive pending-state evidence from the same raw locator and snapshot verification as reads. */
export async function readCompactionPendingHistoryBoundary(
  paths: Record<HistoryArtifact, string>,
  skip = 0
): Promise<PendingBoundary> {
  // Known absence requires exhausting BOTH files; an unreadable reset never becomes absence.
  // No row projection is needed, so the verified location does not re-read the active tail.
  // Retention needs the actual exposed base; provider reads may clamp excessive skips to the oldest window.
  return (await readHistoryProjectionFromLatestBoundary(paths, skip, undefined, false, false))
    .boundary;
}

/** Ordered lifecycle evidence, not a provider message or a source of repaired IDs. */
export interface HistoryControlRow {
  id?: unknown;
  role: "user" | "assistant" | "system";
  metadata?: Record<string, unknown>;
}

export function readHistoryControlEvidenceFromLatestBoundary(
  paths: Record<HistoryArtifact, string>,
  skip: number
): Promise<HistoryControlRow[]> {
  return readHistoryProjectionFromLatestBoundary(paths, skip, (row) => {
    if (!isPlainObject(row)) return null;
    if (row.role !== "user" && row.role !== "assistant" && row.role !== "system") return null;
    // Damaged metadata cannot hide recognized control input or establish synthetic status.
    return normalizeLegacyMuxMetadata<HistoryControlRow>({
      ...("id" in row ? { id: row.id } : {}),
      role: row.role,
      ...(isPlainObject(row.metadata) ? { metadata: row.metadata } : {}),
    });
  }).then((view) => view.messages);
}

export interface BoundedHistoryRow {
  message: MuxMessage;
  /** Exact row, stable across certified EOF appends with an unchanged prefix, not rewrites/rotation. */
  itemId: string;
  windowId: string;
  windowBoundaryKind: HistoryScanState["windowBoundaryKind"];
  startsWindow: boolean;
}
export interface BoundedHistoryScanOptions {
  cursor?: HistoryScanState;
  abortSignal?: AbortSignal;
  /** Absolute performance.now() deadline, shared across composite scans; cleanup is not timed out. */
  deadline?: number;
  /**
   * Visit rows newest-first. Attribution stays exact: each window span is
   * discovered backwards to its boundary row before any of its rows are
   * emitted, so no row is ever attributed to a window guessed from the tail.
   */
  recentFirst?: boolean;
  /** Return false to leave this row unconsumed for the next page. */
  visit: (row: BoundedHistoryRow) => boolean;
}
export interface BoundedHistoryScanResult {
  cursor?: HistoryScanState;
  /** Final state even when the scan finished (no cursor): carries the validated snapshots. */
  state?: HistoryScanState;
  bytesRead: number;
  rowsScanned: number;
  oversizedLines: number;
  malformedLines: number;
  privacyFloorReached: boolean;
}

/** One mutex-held page. Never invokes migration/recovery or a full-file reader. */
export async function scanHistoryFilesBounded(
  paths: Record<HistoryArtifact, string>,
  options: BoundedHistoryScanOptions,
  provenanceEpoch: string,
  maxBytes = SESSION_HISTORY_MAX_SCAN_BYTES,
  maxRows = SESSION_HISTORY_MAX_SCAN_ROWS
): Promise<BoundedHistoryScanResult> {
  assert(maxBytes >= 0 && maxRows >= 0, "history scan budgets must be non-negative");
  const interrupted = () => {
    options.abortSignal?.throwIfAborted();
    return options.deadline != null && performance.now() >= options.deadline;
  };
  options.abortSignal?.throwIfAborted();
  const result: BoundedHistoryScanResult = {
    bytesRead: 0,
    rowsScanned: 0,
    oversizedLines: 0,
    malformedLines: 0,
    privacyFloorReached: false,
  };
  const boundedWindowId = (message: MuxMessage): string | null => {
    const id = getContextWindowId(message);
    if (isHistoryIdentifierRepresentable(id)) return id;
    result.malformedLines++;
    return null;
  };
  const handles = new Map<HistoryArtifact, fs.FileHandle>();
  try {
    for (const artifact of ["chat", "archive"] as const) {
      try {
        options.abortSignal?.throwIfAborted();
        handles.set(artifact, await fs.open(paths[artifact], "r"));
        options.abortSignal?.throwIfAborted();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const initialStamps = new Map<HistoryArtifact, string>();
    for (const artifact of ["chat", "archive"] as const) {
      initialStamps.set(artifact, historyFileStamp(await handles.get(artifact)?.stat()));
    }
    const finish = async () => {
      // The mutex excludes local writers, not foreign backends. Never release
      // rows read through a handle that was rotated/reset while this page ran.
      for (const artifact of ["chat", "archive"] as const) {
        const current = await fs.stat(paths[artifact]).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        if (historyFileStamp(current) !== initialStamps.get(artifact))
          throw new Error("stale_cursor");
      }
      options.abortSignal?.throwIfAborted();
      return result;
    };
    const read = async (artifact: HistoryArtifact, start: number, length: number) => {
      options.abortSignal?.throwIfAborted();
      assert(length >= 0 && result.bytesRead + length <= maxBytes);
      const buffer = Buffer.alloc(length);
      const bytesRead = handles.has(artifact)
        ? (await handles.get(artifact)!.read(buffer, 0, length, start)).bytesRead
        : 0;
      result.bytesRead += bytesRead;
      options.abortSignal?.throwIfAborted();
      return buffer.subarray(0, bytesRead);
    };
    const snapshot = async (
      artifact: HistoryArtifact,
      previous?: HistorySnapshot
    ): Promise<HistorySnapshot> => {
      const stat = await handles.get(artifact)?.stat();
      const size = stat?.size ?? 0;
      const end = previous?.endOffsetSnapshot ?? size;
      const inode = stat ? `${stat.dev}:${stat.ino}` : "missing";
      const modifiedTimeMs = stat?.mtimeMs ?? 0;
      if (
        previous &&
        artifact === "archive" &&
        size === end &&
        modifiedTimeMs !== previous.modifiedTimeMs
      )
        throw new Error("stale_cursor");
      // A validated same-epoch receipt certifies prefix-preserving atomic chat
      // appends even when rename changes its inode. Archive changes still expire.
      if (previous && (size < end || (artifact === "archive" && inode !== previous.inode)))
        throw new Error("stale_cursor");
      const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const headHash = hash(await read(artifact, 0, Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)));
      const anchorHash = hash(
        await read(
          artifact,
          Math.max(0, end - SESSION_HISTORY_ANCHOR_BYTES),
          Math.min(SESSION_HISTORY_ANCHOR_BYTES, end)
        )
      );
      if (previous && (headHash !== previous.headHash || anchorHash !== previous.anchorHash))
        throw new Error("stale_cursor");
      return { endOffsetSnapshot: end, inode, modifiedTimeMs, headHash, anchorHash };
    };
    const initialChat = options.cursor ? undefined : await snapshot("chat");
    const state: HistoryScanState = options.cursor
      ? structuredClone(options.cursor)
      : {
          provenanceEpoch,
          snapshots: { chat: initialChat!, archive: await snapshot("archive") },
          validatedChatSnapshot: initialChat!,
          phase: "floor",
          recentFirst: options.recentFirst === true,
          artifact: "chat",
          byteOffset: 0,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          resetStage: 0,
          possibleReset: false,
          archiveWatermark: -1,
          anchorSequence: null,
          windowId: "w:0",
          windowBoundaryKind: null,
          windowPending: true,
          appendCheck: null,
          floor: null,
          probe: null,
          span: null,
        };
    if (state.provenanceEpoch !== provenanceEpoch) throw new Error("stale_cursor");
    // Direction is bound into the authenticated cursor; a mismatch is a forged or misused cursor.
    if (state.recentFirst !== (options.recentFirst === true)) throw new Error("invalid_cursor");
    if (!options.cursor) state.byteOffset = state.snapshots.chat.endOffsetSnapshot;
    else {
      await snapshot("chat", state.snapshots.chat);
      await snapshot("archive", state.snapshots.archive);
      await snapshot("chat", state.validatedChatSnapshot);
      // Rotation grows the archive and rewrites chat; even archive-only changes
      // invalidate the shared snapshot used by a resumed scan.
      if (
        (await handles.get("archive")?.stat())?.size !==
          state.snapshots.archive.endOffsetSnapshot &&
        handles.has("archive")
      )
        throw new Error("stale_cursor");
    }
    const remaining = () => maxBytes - result.bytesRead;
    interface Position {
      byteOffset: number;
      skippingOversized: boolean;
      oversizedRowEnd: number | null;
      resetProbe: string;
      resetStage: 0 | 1 | 2;
      possibleReset: boolean;
    }
    // Read chunks with at most one line of carryover. An incomplete ordinary
    // line can be retried (<1 MiB); oversized lines resume mid-line, never from
    // their original start, so a multi-megabyte row cannot monopolize every page.
    const scan = async (
      artifact: HistoryArtifact,
      position: Position,
      reverse: boolean,
      end: number,
      lower: number,
      visit: (
        message: MuxMessage | null,
        start: number,
        finish: number,
        oversized: boolean,
        possibleReset: boolean,
        raw: Buffer | null
      ) => boolean
    ) => {
      let cursor = position.byteOffset;
      let rowEdge = cursor;
      let parts: Buffer[] = [];
      let size = 0;
      let skipping = position.skippingOversized;
      const probe: HistoryResetProbe = {
        resetProbe: position.resetProbe,
        resetStage: position.resetStage,
        possibleReset: position.possibleReset,
      };
      const deliver = (edge: number): boolean => {
        options.abortSignal?.throwIfAborted();
        const start = reverse ? edge : rowEdge;
        const finish = reverse ? (position.oversizedRowEnd ?? rowEdge) : edge;
        if (size === 0 && !skipping) {
          rowEdge = edge;
          position.byteOffset = edge;
          return !interrupted();
        }
        result.rowsScanned++;
        let message: MuxMessage | null = null;
        let raw: Buffer | null = null;
        if (skipping) result.oversizedLines++;
        else {
          raw = Buffer.concat(reverse ? parts.reverse() : parts);
          message = classifyHistoryScanRow(raw.toString("utf8"), probe);
          if (!message) result.malformedLines++;
        }
        if (!visit(message, start, finish, skipping, probe.possibleReset, raw)) return false;
        parts = [];
        size = 0;
        skipping = false;
        if (message) {
          probe.resetProbe = "";
          probe.resetStage = 0;
          probe.possibleReset = false;
        }
        position.resetProbe = probe.resetProbe;
        position.resetStage = probe.resetStage;
        position.possibleReset = probe.possibleReset;
        rowEdge = edge;
        position.byteOffset = edge;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        // Row disclosure and its offset commit are atomic with respect to the deadline.
        // Returning before this commit would repeat a delivered row on the next page.
        return !interrupted();
      };
      while (
        (reverse ? cursor > lower : cursor < end) &&
        remaining() > 0 &&
        result.rowsScanned < maxRows &&
        !interrupted()
      ) {
        const length = Math.min(
          SESSION_HISTORY_SCAN_CHUNK_BYTES,
          remaining(),
          reverse ? cursor - lower : end - cursor
        );
        const start = reverse ? cursor - length : cursor;
        const chunk = await read(artifact, start, length);
        if (chunk.length !== length) throw new Error("stale_cursor");
        // Leave an unprocessed chunk out of the saved position/probe, just like byte
        // exhaustion. Ordinary partial rows rewind; oversized probes retain progress.
        if (interrupted()) break;
        let segmentEdge = reverse ? chunk.length : 0;
        const add = (segment: Buffer) => {
          addHistoryResetProbe(probe, segment, reverse);
          size += segment.length;
          if (size > SESSION_HISTORY_MAX_LINE_BYTES) {
            position.oversizedRowEnd ??= rowEdge;
            skipping = true;
            parts = [];
          } else if (!skipping) parts.push(segment);
        };
        for (
          let i = reverse ? chunk.length - 1 : 0;
          reverse ? i >= 0 : i < chunk.length;
          reverse ? i-- : i++
        ) {
          if (chunk[i] !== 10) continue;
          add(reverse ? chunk.subarray(i + 1, segmentEdge) : chunk.subarray(segmentEdge, i));
          const edge = start + i + 1;
          if (!deliver(edge)) return false;
          segmentEdge = reverse ? i : i + 1;
          if (result.rowsScanned >= maxRows) return false;
        }
        add(reverse ? chunk.subarray(0, segmentEdge) : chunk.subarray(segmentEdge));
        cursor = reverse ? start : start + length;
      }
      if (reverse ? cursor === lower : cursor === end) {
        if (!deliver(cursor)) return false;
        position.byteOffset = cursor;
        position.skippingOversized = false;
        position.oversizedRowEnd = null;
        return true;
      }
      // Rewinding an ordinary partial row also restores its start-of-row probe;
      // only oversized rows persist mid-line state. Carryover stays bounded.
      position.byteOffset = skipping ? cursor : rowEdge;
      position.skippingOversized = skipping;
      if (skipping) {
        position.resetProbe = probe.resetProbe;
        position.resetStage = probe.resetStage;
        position.possibleReset = probe.possibleReset;
      }
      return false;
    };

    // New tool-result appends do not expire a cursor. Before disclosing old rows,
    // scan all appended bytes for a new privacy floor, within this SAME budget.
    if (options.cursor) {
      const chatSize = (await handles.get("chat")?.stat())?.size ?? 0;
      if (!state.appendCheck && chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
        state.appendCheck = {
          snapshot: await snapshot("chat"),
          byteOffset: chatSize,
          skippingOversized: false,
          oversizedRowEnd: null,
          resetProbe: "",
          resetStage: 0,
          possibleReset: false,
        };
      }
      if (state.appendCheck) {
        const check = state.appendCheck;
        await snapshot("chat", check.snapshot);
        let reachedValidatedRow = false;
        const completed = await scan(
          "chat",
          check,
          true,
          check.snapshot.endOffsetSnapshot,
          0,
          (message, _start, finish, _oversized, possibleReset) => {
            // A new append can finish the prior snapshot's malformed tail.
            // Continue through that tail, stopping at the first valid old row.
            if (message && finish <= state.validatedChatSnapshot.endOffsetSnapshot) {
              reachedValidatedRow = true;
              return false;
            }
            if (isManualHistoryReset(message, possibleReset)) throw new Error("stale_cursor");
            return true;
          }
        );
        if (!completed && !reachedValidatedRow) {
          result.cursor = state;
          result.state = state;
          return await finish();
        }
        // Keep the retrieval snapshot fixed even when our own result is appended.
        state.validatedChatSnapshot = check.snapshot;
        state.appendCheck = null;
        if (chatSize > state.validatedChatSnapshot.endOffsetSnapshot) {
          result.cursor = state;
          result.state = state;
          return await finish();
        }
      }
    }
    const freshPosition = () => ({
      skippingOversized: false,
      oversizedRowEnd: null,
      resetProbe: "",
      resetStage: 0 as const,
      possibleReset: false,
    });
    // Browsing starts where the floor phase stopped: at the reset row's end, or at
    // the archive head when no reset exists. Newest-first remembers that floor and
    // walks back from the tail instead.
    const enterBrowse = () => {
      if (!state.recentFirst) {
        state.phase = "browse";
        return;
      }
      state.floor = {
        artifact: state.artifact,
        byteOffset: state.byteOffset,
        windowId: state.windowId,
        windowBoundaryKind: state.windowBoundaryKind,
      };
      state.phase = "probe";
      state.artifact = "chat";
      state.byteOffset = state.snapshots.chat.endOffsetSnapshot;
      Object.assign(state, freshPosition());
      state.probe = {
        artifact: "chat",
        byteOffset: state.byteOffset,
        ...freshPosition(),
        lowestReadable: null,
      };
    };
    // Reverse discovery: walk back from the pending span end to the nearest
    // boundary row (or the floor), retaining only locations. Returns false when
    // the page budget ran out.
    const probePage = async (): Promise<boolean> => {
      const probe = state.probe!;
      const floor = state.floor!;
      assert(probe && floor, "newest-first probe requires floor and probe state");
      const lower = probe.artifact === floor.artifact ? floor.byteOffset : 0;
      let boundary:
        | { start: number; windowId: string | null; kind: HistoryScanState["windowBoundaryKind"] }
        | undefined;
      const completed = await scan(
        probe.artifact,
        probe,
        true,
        state.snapshots[probe.artifact].endOffsetSnapshot,
        lower,
        (message, start) => {
          if (!message) return true;
          const kind = getContextBoundaryKind(message);
          if (kind) {
            boundary = { start, windowId: boundedWindowId(message), kind };
            return false;
          }
          probe.lowestReadable = { artifact: probe.artifact, byteOffset: start };
          return true;
        }
      );
      if (boundary) {
        const start = { artifact: probe.artifact, byteOffset: boundary.start };
        state.span = {
          start,
          windowId: boundary.windowId,
          windowBoundaryKind: boundary.kind,
          startsWindow: start,
        };
      } else if (!completed) return false;
      else if (probe.artifact === "chat" && floor.artifact === "archive") {
        Object.assign(probe, freshPosition(), {
          artifact: "archive",
          byteOffset: state.snapshots.archive.endOffsetSnapshot,
        });
        return true;
      } else {
        // The oldest visible span has no boundary row of its own; like the forward
        // walk, its first readable row is the one that starts the window.
        state.span = {
          start: { artifact: floor.artifact, byteOffset: floor.byteOffset },
          windowId: floor.windowId,
          windowBoundaryKind: floor.windowBoundaryKind,
          startsWindow: probe.lowestReadable,
        };
      }
      state.probe = null;
      state.phase = "deliver";
      return true;
    };
    // Reverse delivery of one discovered span, from its end (state position) down
    // to its boundary row, crossing the chat -> archive seam when the span does.
    const deliverPage = async (): Promise<boolean> => {
      const span = state.span!;
      const floor = state.floor!;
      assert(span && floor, "newest-first delivery requires span and floor state");
      const artifact = state.artifact;
      const lower = artifact === span.start.artifact ? span.start.byteOffset : 0;
      const completed = await scan(
        artifact,
        state,
        true,
        state.snapshots[artifact].endOffsetSnapshot,
        lower,
        (message, start, _finish, _oversized, _possibleReset, raw) => {
          if (!message) return true;
          assert(raw, "readable browse rows retain their bounded raw bytes");
          // Unaddressable windows are consumed silently, as in the forward walk.
          if (span.windowId === null) return true;
          return options.visit({
            message,
            itemId: `r:${state.provenanceEpoch}:${artifact}:${start}:${createHash("sha256").update(raw).digest("hex")}`,
            windowId: span.windowId,
            windowBoundaryKind: span.windowBoundaryKind,
            startsWindow:
              span.startsWindow !== null &&
              span.startsWindow.artifact === artifact &&
              span.startsWindow.byteOffset === start,
          });
        }
      );
      if (!completed) return false;
      if (artifact === "chat" && span.start.artifact === "archive") {
        Object.assign(state, freshPosition(), {
          artifact: "archive",
          byteOffset: state.snapshots.archive.endOffsetSnapshot,
        });
        return true;
      }
      assert(
        state.artifact === span.start.artifact && state.byteOffset === span.start.byteOffset,
        "reverse delivery must stop exactly at the span start"
      );
      state.span = null;
      if (span.start.artifact === floor.artifact && span.start.byteOffset === floor.byteOffset) {
        state.phase = "done";
        return true;
      }
      state.probe = {
        artifact: state.artifact,
        byteOffset: state.byteOffset,
        ...freshPosition(),
        lowestReadable: null,
      };
      state.phase = "probe";
      return true;
    };
    while (
      state.phase !== "done" &&
      remaining() > 0 &&
      result.rowsScanned < maxRows &&
      !interrupted()
    ) {
      if (state.phase === "probe") {
        if (!(await probePage())) break;
        continue;
      }
      if (state.phase === "deliver") {
        if (!(await deliverPage())) break;
        continue;
      }
      const artifact = state.artifact;
      const reverse = state.phase === "floor";
      const end = state.snapshots[artifact].endOffsetSnapshot;
      let floor:
        | {
            offset: number;
            windowId: string | null;
            windowBoundaryKind: HistoryScanState["windowBoundaryKind"];
          }
        | undefined;
      const completed = await scan(
        artifact,
        state,
        reverse,
        end,
        0,
        (message, start, finish, _oversized, possibleReset, raw) => {
          if (reverse) {
            // Keep the legacy cursor field, but sequence coverage is not replay proof.
            const sequence = message?.metadata?.historySequence;
            if (artifact === "archive" && Number.isSafeInteger(sequence))
              state.archiveWatermark = Math.max(state.archiveWatermark, sequence!);
            if (isManualHistoryReset(message, possibleReset)) {
              // Corrupt reset rows are privacy floors even when they parse or
              // carry a partial rollover tag. Only a validated rollover is exempt.
              floor = {
                offset: finish,
                windowId: message ? boundedWindowId(message) : "w:0",
                windowBoundaryKind: getContextBoundaryKind(message ?? undefined),
              };
              return false;
            }
            return true;
          }
          if (!message) return true;
          assert(raw, "readable browse rows retain their bounded raw bytes");
          const sequence = message.metadata?.historySequence;
          const anchorSequence =
            Number.isSafeInteger(sequence) && sequence! >= 0 ? sequence! : null;
          // Repaired/imported rows may reuse archived sequences with different
          // identities or payloads. Retain possible replays without exact proof.
          const boundaryKind = getContextBoundaryKind(message);
          const windowId = boundaryKind ? boundedWindowId(message) : state.windowId;
          const windowBoundaryKind = boundaryKind ?? state.windowBoundaryKind;
          // Consume unaddressable windows without persisting oversized IDs in
          // cursors or silently assigning their rows to a different window.
          if (
            windowId !== null &&
            !options.visit({
              message,
              itemId: `r:${state.provenanceEpoch}:${artifact}:${start}:${createHash("sha256").update(raw).digest("hex")}`,
              windowId,
              windowBoundaryKind,
              startsWindow: state.windowPending || boundaryKind !== null,
            })
          )
            return false;
          state.windowId = windowId;
          state.windowBoundaryKind = windowBoundaryKind;
          state.windowPending = false;
          state.anchorSequence = anchorSequence;
          return true;
        }
      );
      if (floor) {
        result.privacyFloorReached = true;
        state.byteOffset = floor.offset;
        state.windowId = floor.windowId;
        // Browsing excludes the reset row itself; preserve its verified kind
        // alongside its ID even when the first visible row is on another page.
        state.windowBoundaryKind = floor.windowBoundaryKind;
        state.windowPending = true;
        Object.assign(state, freshPosition());
        enterBrowse();
      } else if (!completed) break;
      else if (reverse && artifact === "chat") {
        state.artifact = "archive";
        state.byteOffset = state.snapshots.archive.endOffsetSnapshot;
      } else if (reverse) {
        state.byteOffset = 0;
        state.resetProbe = "";
        state.resetStage = 0;
        state.possibleReset = false;
        enterBrowse();
      } else if (artifact === "archive") {
        state.artifact = "chat";
        state.byteOffset = 0;
      } else state.phase = "done";
    }
    if (state.phase !== "done") result.cursor = state;
    result.state = state;
    return await finish();
  } finally {
    await Promise.all([...handles.values()].map((handle) => handle.close()));
  }
}
