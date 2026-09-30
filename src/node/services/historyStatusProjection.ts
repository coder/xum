import assert from "node:assert";

/**
 * Status-grade projection of one history row over SESSION_HISTORY_MAX_LINE_BYTES (#4790).
 *
 * On sessions made of a few giant rows (inline attachments, multi-MB tool outputs) the sidebar
 * status suffix is the whole epoch, and 97-99% of those rows' bytes are tool payloads and file
 * URLs the status transcript never reads. Decoding and JSON.parse of them dominated the status
 * tick. This scanner cuts those values out of the raw bytes before JSON.parse:
 * - `parts[*].input` / `parts[*].output` whose value is a string, object or array -> `null`
 *   (scalars are kept: JSON.parse validates them);
 * - `parts[*].url` whose value is a string -> `""`;
 * - `parts[*].nestedCalls[*].input` / `.output` (string, object or array) -> `null`.
 * Every other byte is kept, so JSON.parse still validates it.
 *
 * The result is status-grade, never provider-grade: payload bytes are not validated. Why status
 * output stays equal:
 * - The formatter reads only role, text parts and tool type/toolName/state; isStatusTranscriptRow
 *   reads metadata and the plan-review/workflow markers. None of them is a cut value.
 * - The schemas accept the replacements (tool `input`/`output` z.unknown(), nested
 *   z.unknown().optional(), file `url` z.string(); other part types strip unknown keys), and
 *   a well-formed row projects exactly, so a row the full parse reads stays readable.
 * - Floors (compaction boundaries, raw resets) are decided by the raw locator before rows are
 *   materialized, and oversized rows never count toward the status stop window.
 * Documented divergence (inclusion-only): a cut value that is corrupt but balanced (raw control
 * character or bad escape inside a string, invalid scalar or mismatched bracket types inside a
 * container; bytes JSON.stringify never writes) leaves the row readable to status while the
 * provider read drops it. Such a row is inside the current epoch either way.
 *
 * Strictly non-repairing: any structural doubt returns null and the caller parses the full row.
 */
export function projectStatusHistoryRow(row: Buffer): string | null {
  const scanner = new StatusRowScanner(row);
  try {
    const start = scanner.skipWs(0);
    if (row[start] !== OPEN_BRACE) return null;
    const end = scanner.walkObject(start, (key, value) =>
      key === "parts" && row[value] === OPEN_BRACKET
        ? scanner.walkArray(value, (element) =>
            row[element] === OPEN_BRACE ? scanner.walkObject(element, scanner.partMember) : null
          )
        : null
    );
    if (scanner.skipWs(end) !== row.length) return null;
  } catch (error) {
    if (error instanceof NotProjectable) return null;
    throw error;
  }
  return scanner.output();
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;
const NULL_BYTES = Buffer.from("null");
const EMPTY_STRING_BYTES = Buffer.from('""');

/** Malformed input: the caller falls back to the full parse. Never an assertion. */
class NotProjectable extends Error {}

const isJsonWhitespace = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;

/** Value handler: returns the end of the value it walked, or null to skip it unchanged. */
type ValueVisitor = (start: number) => number | null;
type MemberVisitor = (key: string, valueStart: number) => number | null;

class StatusRowScanner {
  private readonly cuts: Array<{ start: number; end: number; replacement: Buffer }> = [];

  constructor(private readonly row: Buffer) {}

  skipWs(index: number): number {
    let i = index;
    while (isJsonWhitespace(this.row[i])) i++;
    return i;
  }

  /** Index of the quote that closes the string opening at `start`. */
  private stringEnd(start: number): number {
    for (let j = start; ; ) {
      j = this.row.indexOf(QUOTE, j + 1);
      if (j === -1) throw new NotProjectable();
      let k = j - 1;
      while (this.row[k] === BACKSLASH) k--;
      // An even run of backslashes escapes itself, not the quote.
      if ((j - 1 - k) % 2 === 0) return j;
    }
  }

  /** End of the value at `start`, without validating its contents (JSON.parse does). */
  private skipValue(start: number): number {
    const row = this.row;
    const first = row[start];
    if (first === QUOTE) return this.stringEnd(start) + 1;
    if (first === OPEN_BRACE || first === OPEN_BRACKET) {
      let depth = 0;
      for (let j = start; j < row.length; ) {
        const byte = row[j];
        if (byte === QUOTE) {
          j = this.stringEnd(j) + 1;
          continue;
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth++;
        else if ((byte === CLOSE_BRACE || byte === CLOSE_BRACKET) && --depth === 0) return j + 1;
        j++;
      }
      throw new NotProjectable();
    }
    let j = start;
    while (j < row.length) {
      const byte = row[j];
      if (byte === COMMA || byte === CLOSE_BRACE || byte === CLOSE_BRACKET) break;
      if (isJsonWhitespace(byte)) break;
      j++;
    }
    if (j === start) throw new NotProjectable();
    return j;
  }

  private key(start: number, end: number): string {
    // Plain keys compare by bytes; escaped ones ("outp\u0075t") by their decoded value.
    // latin1 maps every non-ASCII byte to a non-ASCII character, so it never equals an ASCII key.
    if (!this.row.subarray(start, end).includes(BACKSLASH))
      return this.row.toString("latin1", start + 1, end);
    try {
      return JSON.parse(this.row.toString("utf8", start, end + 1)) as string;
    } catch {
      throw new NotProjectable();
    }
  }

  walkObject(start: number, visit: MemberVisitor): number {
    assert(this.row[start] === OPEN_BRACE, "walkObject starts at an object");
    let i = this.skipWs(start + 1);
    if (this.row[i] === CLOSE_BRACE) return i + 1;
    for (;;) {
      if (this.row[i] !== QUOTE) throw new NotProjectable();
      const keyEnd = this.stringEnd(i);
      const key = this.key(i, keyEnd);
      i = this.skipWs(keyEnd + 1);
      if (this.row[i] !== COLON) throw new NotProjectable();
      const value = this.skipWs(i + 1);
      i = this.skipWs(visit(key, value) ?? this.skipValue(value));
      if (this.row[i] === CLOSE_BRACE) return i + 1;
      if (this.row[i] !== COMMA) throw new NotProjectable();
      i = this.skipWs(i + 1);
    }
  }

  walkArray(start: number, visit: ValueVisitor): number {
    assert(this.row[start] === OPEN_BRACKET, "walkArray starts at an array");
    let i = this.skipWs(start + 1);
    if (this.row[i] === CLOSE_BRACKET) return i + 1;
    for (;;) {
      i = this.skipWs(visit(i) ?? this.skipValue(i));
      if (this.row[i] === CLOSE_BRACKET) return i + 1;
      if (this.row[i] !== COMMA) throw new NotProjectable();
      i = this.skipWs(i + 1);
    }
  }

  /** `input`/`output` holding a string, object or array become null. */
  private readonly payloadMember: MemberVisitor = (key, value) => {
    if (key !== "input" && key !== "output") return null;
    const first = this.row[value];
    if (first !== QUOTE && first !== OPEN_BRACE && first !== OPEN_BRACKET) return null;
    return this.cut(value, NULL_BYTES);
  };

  /** A member of one `parts` element. */
  readonly partMember: MemberVisitor = (key, value) => {
    if (key === "url")
      return this.row[value] === QUOTE ? this.cut(value, EMPTY_STRING_BYTES) : null;
    if (key === "nestedCalls")
      return this.row[value] === OPEN_BRACKET
        ? this.walkArray(value, (call) =>
            this.row[call] === OPEN_BRACE ? this.walkObject(call, this.payloadMember) : null
          )
        : null;
    return this.payloadMember(key, value);
  };

  private cut(start: number, replacement: Buffer): number {
    const end = this.skipValue(start);
    const previous = this.cuts.at(-1);
    assert(!previous || previous.end <= start, "status projection cuts must be increasing");
    assert(end <= this.row.length, "status projection cut must be within the row");
    // `""` -> `""` changes nothing; do not count it as a replacement.
    if (!replacement.equals(this.row.subarray(start, end)))
      this.cuts.push({ start, end, replacement });
    return end;
  }

  /** Kept ranges plus replacements, decoded once; null when nothing was cut. */
  output(): string | null {
    if (this.cuts.length === 0) return null;
    const pieces: Buffer[] = [];
    let kept = 0;
    for (const { start, end, replacement } of this.cuts) {
      pieces.push(this.row.subarray(kept, start), replacement);
      kept = end;
    }
    pieces.push(this.row.subarray(kept));
    // Cuts start and end at ASCII delimiters, which never sit inside a UTF-8 sequence, so one
    // decode of the kept bytes equals decoding each kept range of the original row.
    return Buffer.concat(pieces).toString("utf8");
  }
}
