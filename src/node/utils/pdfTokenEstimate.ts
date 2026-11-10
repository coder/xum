import { inflateSync } from "node:zlib";

import {
  IMAGE_TOKEN_ESTIMATE,
  PDF_MAX_PAGES_ESTIMATE,
  PDF_TOKENS_PER_PAGE_ESTIMATE,
} from "@/common/constants/contextBudget";

/** Page dictionaries (`/Type /Page`), not the `/Pages` tree nodes. */
const PAGE_OBJECT_PATTERN = /\/Type\s*\/Page(?![s])/g;
/** Page-tree nodes carry their descendant page count: `/Type /Pages ... /Count N`. */
const PAGE_TREE_COUNT_PATTERN = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g;
/**
 * Longest stream dictionary the backward parse walks before giving up: a
 * dictionary far larger than any writer emits is a malformed object.
 */
const MAX_STREAM_DICTIONARY_CHARS = 64 * 1024;
/**
 * A direct `/Length N` in a stream dictionary. An indirect reference
 * (`/Length 12 0 R`) is left alone: resolving it needs the object table.
 */
const DIRECT_STREAM_LENGTH_PATTERN = /\/Length\s+(\d+)(?!\s+\d+\s+R)/;
const END_STREAM_KEYWORD = "endstream";
/** Inflation bounds: a hostile stream must not expand without limit. */
const MAX_INFLATED_STREAM_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_TOTAL_BYTES = 64 * 1024 * 1024;

function countPageObjects(text: string): number {
  return text.match(PAGE_OBJECT_PATTERN)?.length ?? 0;
}

function maxPageTreeCount(text: string): number {
  let max = 0;
  for (const match of text.matchAll(PAGE_TREE_COUNT_PATTERN)) {
    const count = Number.parseInt(match[1], 10);
    if (Number.isFinite(count) && count > max) max = count;
  }
  return max;
}

/**
 * Where a payload's `endstream` keyword starts when its dictionary declares a
 * direct length that lands on one (an EOL may precede the keyword). Binary
 * payloads — a stored DEFLATE block, an image — can contain the literal
 * `endstream`, so the declared length wins over the first occurrence; without
 * a usable length the first occurrence is the only delimiter available.
 */
function declaredPayloadEnd(dictionary: string, text: string, dataStart: number): number | null {
  const match = DIRECT_STREAM_LENGTH_PATTERN.exec(dictionary);
  if (match === null) return null;
  const end = dataStart + Number.parseInt(match[1], 10);
  if (end > text.length) return null;
  for (const eol of ["", "\n", "\r\n", "\r"]) {
    if (text.startsWith(END_STREAM_KEYWORD, end + eol.length)) return end;
  }
  return null;
}

/**
 * The dictionary that owns the `stream` keyword at `keywordAt`: the `<< … >>`
 * (nested dictionaries included) closing, whitespace apart, right before it.
 * Parsed backward from the keyword rather than taken from a window of bytes
 * before it — a window reaches into the previous object, whose `/ObjStm` or
 * `/Length` would then be read as this stream's and a Flate content stream
 * that follows an object stream would be inflated and scanned as
 * dictionaries. `none`: no dictionary closes there (the word inside a string
 * or content). `unbalanced`: a dictionary closes there but its brackets never
 * balance within the bound — a malformed object whose stream is undecodable.
 */
function enclosingStreamDictionary(
  text: string,
  keywordAt: number
): { kind: "dictionary"; text: string } | { kind: "none" } | { kind: "unbalanced" } {
  let end = keywordAt;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  if (!text.endsWith(">>", end)) return { kind: "none" };
  const floor = Math.max(0, end - MAX_STREAM_DICTIONARY_CHARS);
  let depth = 0;
  let at = end;
  while (at >= floor + 2) {
    const pair = text.slice(at - 2, at);
    if (pair === ">>") {
      depth++;
      at -= 2;
      continue;
    }
    if (pair === "<<") {
      depth--;
      at -= 2;
      if (depth === 0) return { kind: "dictionary", text: text.slice(at, keywordAt) };
      continue;
    }
    at--;
  }
  return { kind: "unbalanced" };
}

/**
 * Every stream payload (`stream … endstream`) with the dictionary that owns
 * it. The raw scans skip the payloads — page-like text inside a
 * content stream (a document about PDF syntax) is data, not a dictionary —
 * and the inflater picks the object streams among them.
 */
function* streamPayloads(
  text: string
): Generator<{ dictionary: string | null; dataStart: number; endAt: number }> {
  let cursor = 0;
  for (;;) {
    const keywordAt = text.indexOf("stream", cursor);
    if (keywordAt === -1) return;
    // "endstream" contains "stream": skip the closing keyword's own match.
    if (text.slice(Math.max(0, keywordAt - 3), keywordAt) === "end") {
      cursor = keywordAt + "stream".length;
      continue;
    }
    const owner = enclosingStreamDictionary(text, keywordAt);
    if (owner.kind === "none") {
      cursor = keywordAt + "stream".length;
      continue;
    }
    let dataStart = keywordAt + "stream".length;
    if (text[dataStart] === "\r") dataStart++;
    if (text[dataStart] === "\n") dataStart++;
    // A malformed dictionary has no usable length: null stands for it.
    const dictionary = owner.kind === "dictionary" ? owner.text : null;
    const endAt =
      (dictionary === null ? null : declaredPayloadEnd(dictionary, text, dataStart)) ??
      text.indexOf(END_STREAM_KEYWORD, dataStart);
    if (endAt === -1) return;
    cursor = text.indexOf(END_STREAM_KEYWORD, endAt) + END_STREAM_KEYWORD.length;
    yield { dictionary, dataStart, endAt };
  }
}

/** The raw bytes without their stream payloads: only object dictionaries remain to scan. */
function withoutStreamPayloads(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const { dataStart, endAt } of streamPayloads(text)) {
    parts.push(text.slice(cursor, dataStart));
    cursor = endAt;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/**
 * Decoded contents of the document's FlateDecode object streams (`/Type
 * /ObjStm`): modern writers keep page dictionaries there, where a raw scan
 * sees none. Only object streams can hold page dictionaries — content and
 * image streams never do — so they are the only streams inflated, which keeps
 * the always-on scan cheap. Bounded. An object stream that does not decode
 * (encrypted, another filter, corrupt, past the inflation budget) makes the
 * page count UNKNOWN: its dictionaries may be pages no other source counts.
 */
function inflatedStreams(bytes: Buffer, text: string): { decoded: string[]; complete: boolean } {
  const decoded: string[] = [];
  let total = 0;
  let complete = true;
  for (const { dictionary, dataStart, endAt } of streamPayloads(text)) {
    // A stream whose dictionary cannot be delimited may be an object stream
    // holding pages no other source counts: undecodable, so unknown.
    if (dictionary === null) {
      complete = false;
      break;
    }
    if (!dictionary.includes("/ObjStm") || !dictionary.includes("/FlateDecode")) continue;
    if (total >= MAX_INFLATED_TOTAL_BYTES) {
      complete = false;
      break;
    }
    try {
      const data = inflateSync(bytes.subarray(dataStart, endAt), {
        maxOutputLength: MAX_INFLATED_STREAM_BYTES,
      });
      total += data.length;
      decoded.push(data.toString("latin1"));
    } catch {
      complete = false;
    }
  }
  return { decoded, complete };
}

/**
 * Conservative token cost of a PDF attachment. Providers bill a PDF per page
 * (extracted text plus a page image), so pages are priced at the per-page
 * upper bound. Page objects are counted in the raw object dictionaries
 * (stream payloads excluded) together with the page tree's `/Count`, and the
 * FlateDecode object streams (which hold the page dictionaries of most modern
 * PDFs) are inflated and scanned the same way whether or not a raw source is
 * visible. The recovered count is capped at the provider's page limit, and
 * that limit is assumed when no source recovers a count or an object stream
 * could not be decoded: a compressed byte size cannot bound a page count, a
 * partial count is no bound either, and under-estimating lets the pre-send
 * check skip compaction only to fail at dispatch.
 */
export function estimatePdfAttachmentTokens(url: string): number {
  if (!url.startsWith("data:")) return IMAGE_TOKEN_ESTIMATE;
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1 || !url.slice(0, commaIndex).includes(";base64")) {
    return IMAGE_TOKEN_ESTIMATE;
  }
  const bytes = Buffer.from(url.slice(commaIndex + 1), "base64");
  const text = bytes.toString("latin1");
  const dictionaries = withoutStreamPayloads(text);
  let pageObjects = countPageObjects(dictionaries);
  let treeCount = maxPageTreeCount(dictionaries);
  // A hybrid or incrementally saved document keeps some page dictionaries raw
  // and the rest — or the active page tree — in object streams, so a visible
  // raw source does not make the streams redundant: they are always scanned.
  // Page objects are summed across the raw bytes and every stream (each
  // dictionary lives in one place; an incremental update that rewrote a page
  // counts it twice, which only over-estimates); the tree count is a maximum.
  // The two sources are compared once below, never added to each other.
  const streams = inflatedStreams(bytes, text);
  if (!streams.complete) return PDF_MAX_PAGES_ESTIMATE * PDF_TOKENS_PER_PAGE_ESTIMATE;
  for (const decoded of streams.decoded) {
    pageObjects += countPageObjects(decoded);
    treeCount = Math.max(treeCount, maxPageTreeCount(decoded));
  }
  // Providers reject documents over their page cap, so a count above it prices
  // the same request the cap does — a page-like false positive cannot force an
  // irreversible compaction out of a short document.
  const pages = Math.min(Math.max(pageObjects, treeCount), PDF_MAX_PAGES_ESTIMATE);
  return (pages > 0 ? pages : PDF_MAX_PAGES_ESTIMATE) * PDF_TOKENS_PER_PAGE_ESTIMATE;
}
