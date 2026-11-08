/**
 * Text of a tool's input or output as the memory harvest model reads it: bounded, free of
 * attachment bytes, and redacted.
 *
 * A tool value is untrusted and can be huge: a command's output of megabytes, an MCP result of a
 * million entries. Only a short prefix is sent, so the value is serialized straight into a budget
 * and the walk stops once the budget is full. Nothing is cloned or stringified whole, and a string
 * is cut to what is left of the budget before it is scanned for media.
 */
import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { isMediaPart } from "@/common/utils/attachments/toolAttachmentParts";
import { isPlainObject } from "@/common/utils/isPlainObject";
import { REDACTION_LOOKAHEAD_CHARS, redactSecretLike } from "@/node/services/memorySecretRedaction";

const MEDIA_STUB = "[media]";
const NESTED_OMITTED = "[nested data omitted]";
export const SESSION_HISTORY_OMITTED = "[session_history result omitted]";
const SESSION_HISTORY_TOOL = "session_history";
const UNSERIALIZABLE = "[unserializable]";
const NONE = "[none]";
// The AI SDK's model-output attachment forms, recognized by type alone as the provider projection
// does (compactionRowSizing.ts). Their bytes never go to the harvest model.
const SDK_ATTACHMENT_TYPES = new Set(["image-data", "file-data"]);
const MAX_TOOL_VALUE_DEPTH = 30;

// RFC 2397: `data:[<media type>][;<parameter>]...[;base64],<payload>`. The header has a media type
// or a parameter, so prose such as `data: a, b` is not taken for a URL.
const MEDIA_TYPE = String.raw`[\w.+-]{1,127}/[\w.+-]{1,127}`;
const PARAMETER = String.raw`;[\w.+-]{1,64}(?:=[^;,\s"'<>]{0,128})?`;
const BASE64_CHARS = "[A-Za-z0-9+/=_-]";
// A line break inside a wrapped payload: raw, or the escape of one in JSON text.
const LINE_BREAK = String.raw`(?:\r?\n|\\r\\n|\\n)`;

// A base64 payload may be wrapped (`base64 -w 76`, MIME): full lines of at least 16 characters, and
// a short last line only behind a full one. A line of prose after an unwrapped payload stays.
const BASE64_URL =
  String.raw`data:(?:${MEDIA_TYPE})?(?:${PARAMETER}){0,3};base64,${BASE64_CHARS}+` +
  String.raw`(?:(?:${LINE_BREAK}${BASE64_CHARS}{16,})+(?:${LINE_BREAK}${BASE64_CHARS}{1,15}(?=${LINE_BREAK}|$))?)?`;

// Any other payload is percent-encoded (`data:image/svg+xml,%3Csvg...`): URL characters, no whitespace.
const ENCODED_URL =
  String.raw`data:(?:${MEDIA_TYPE}(?:${PARAMETER}){0,4}|(?:${PARAMETER}){1,4}),` +
  String.raw`[\w\-.~!$&'()*+,;=:@/?%#]+`;

// Sticky: matches only at `lastIndex`, so a scan reads the URL it finds and not the text after it.
const DATA_URL_AT = new RegExp(`${BASE64_URL}|${ENCODED_URL}`, "iy");
const DATA_SCHEME = /data:/i;

/**
 * The first `limit` characters of `text` once its data URLs are replaced by `[media]`, and whether
 * more followed. A URL costs the stub, not its payload, so attachment bytes never use up the limit.
 * Only the next `limit - kept` characters are searched for a URL start, so text past the limit is
 * not read; a URL that starts inside it is read to its end.
 */
export function takeWithoutMedia(text: string, limit: number): { text: string; cut: boolean } {
  let kept = "";
  let position = 0;
  while (position < text.length) {
    const room = limit - kept.length;
    if (room <= 0) return { text: kept, cut: true };
    const ahead = text.slice(position, position + room);
    const scheme = DATA_SCHEME.exec(ahead);
    if (scheme === null) {
      kept += ahead;
      position += ahead.length;
      continue;
    }
    kept += ahead.slice(0, scheme.index);
    position += scheme.index;
    DATA_URL_AT.lastIndex = position;
    const url = DATA_URL_AT.exec(text);
    // Not a URL after all (`data:` in prose): the scheme's own characters stay.
    kept += url === null ? scheme[0] : MEDIA_STUB;
    position += url === null ? scheme[0].length : url[0].length;
  }
  return { text: kept, cut: false };
}

interface Sink {
  text: string;
  readonly budget: number;
  /** Something was left out: a string cut, or the walk stopped at a full budget. */
  cut: boolean;
}

function isFull(sink: Sink): boolean {
  return sink.text.length >= sink.budget;
}

function write(sink: Sink, chunk: string): void {
  if (chunk === "") return;
  if (isFull(sink)) {
    sink.cut = true;
    return;
  }
  sink.text += chunk;
}

/** A string leaf: JSON-quoted inside a structure, raw when it is the whole value. */
function writeString(sink: Sink, value: string, quoted: boolean): void {
  const kept = takeWithoutMedia(value, sink.budget - sink.text.length);
  if (kept.cut) sink.cut = true;
  write(sink, quoted ? JSON.stringify(kept.text) : kept.text);
}

function isOmittedFromObject(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function walkArray(sink: Sink, value: unknown[], depth: number): void {
  write(sink, "[");
  for (let index = 0; index < value.length; index++) {
    if (isFull(sink)) {
      sink.cut = true;
      return;
    }
    if (index > 0) write(sink, ",");
    walk(sink, value[index], depth + 1);
  }
  write(sink, "]");
}

function walkObject(sink: Sink, value: Record<string, unknown>, depth: number): void {
  write(sink, "{");
  let first = true;
  // Listing the keys of a wide object costs its width once, but a value is read only when the
  // budget has room for it.
  for (const key of Object.keys(value)) {
    if (isFull(sink)) {
      sink.cut = true;
      return;
    }
    const item = value[key];
    // Past the depth limit a child is the placeholder string, so it is never left out.
    if (depth + 1 <= MAX_TOOL_VALUE_DEPTH && isOmittedFromObject(item)) continue;
    if (!first) write(sink, ",");
    first = false;
    writeString(sink, key, true);
    write(sink, ":");
    walk(sink, item, depth + 1);
  }
  write(sink, "}");
}

/**
 * Whether `value` is an attachment record whose bytes must not reach the harvest model. A `media`
 * or `display_file` record counts only with the shared attachment shape the provider projection
 * checks: any other record typed so is application data the tool returned (`{ "type": "media",
 * "text": "campaign channel" }`) and carries evidence, so it renders like any other record.
 */
function isAttachmentRecord(value: Record<string, unknown>): boolean {
  if (value.type === "media") return isMediaPart(value);
  if (value.type === "display_file") return isDisplayOnlyFilePart(value);
  return typeof value.type === "string" && SDK_ATTACHMENT_TYPES.has(value.type);
}

/** What stands for an attachment or a history lookup in place of its object, if `value` is one. */
function placeholderForObject(value: Record<string, unknown>): string | undefined {
  if (isAttachmentRecord(value)) return MEDIA_STUB;
  // A history lookup returns other rows' text; forwarding it would copy that text into this
  // workspace's memory and amplify one lookup into the next epoch's evidence.
  if (value.toolName === SESSION_HISTORY_TOOL) return SESSION_HISTORY_OMITTED;
  return undefined;
}

/**
 * The lists of calls a node made inside itself: persisted `nestedCalls`, and the `toolCalls` of a
 * `code_execution` result.
 */
function innerCallLists(node: Record<string, unknown>): unknown[][] {
  const lists = [node.nestedCalls];
  // A persisted call keeps its value in `output`, a `code_execution` record in `result`.
  for (const value of [node.output, node.result]) {
    if (isPlainObject(value)) lists.push(value.toolCalls);
  }
  return lists.filter(Array.isArray);
}

function callsSessionHistory(node: unknown, depth: number): boolean {
  if (!isPlainObject(node)) return false;
  if (node.toolName === SESSION_HISTORY_TOOL) return true;
  // A chain too deep to read to its end cannot be cleared, so it counts as a lookup.
  if (depth >= MAX_TOOL_VALUE_DEPTH) return true;
  return innerCallLists(node).some((calls) =>
    calls.some((call) => callsSessionHistory(call, depth + 1))
  );
}

/**
 * Whether `part` is a `session_history` lookup, or ran one inside itself. A `code_execution` can
 * return the lookup's value or print it, and nothing in that copy says where it came from, so the
 * part's whole output (result, console, records) is judged by the calls it made and omitted if one
 * was a lookup. Walking the output for a marker would miss every copy that dropped the marker.
 */
export function derivesFromSessionHistory(part: unknown): boolean {
  return callsSessionHistory(part, 0);
}

/** What `JSON.stringify` writes for a null, a boolean or a number; undefined for anything else. */
function jsonPrimitive(value: unknown): string | undefined {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return undefined;
}

/** Writes what `JSON.stringify` would for `value`, with media and history results left out. */
function walk(sink: Sink, value: unknown, depth: number): void {
  if (isFull(sink)) {
    sink.cut = true;
    return;
  }
  if (depth > MAX_TOOL_VALUE_DEPTH) return writeString(sink, NESTED_OMITTED, true);
  if (typeof value === "string") return writeString(sink, value, depth > 0);
  const primitive = jsonPrimitive(value);
  if (primitive !== undefined) return write(sink, primitive);
  if (Array.isArray(value)) return walkArray(sink, value, depth);
  if (!isPlainObject(value)) {
    // A Date, a Map, a class instance: persisted tool values are JSON, so this is rare, and what
    // `JSON.stringify` makes of it is as good as any. A bigint throws.
    return write(sink, JSON.stringify(value) ?? "null");
  }
  const placeholder = placeholderForObject(value);
  if (placeholder !== undefined) return writeString(sink, placeholder, depth > 0);
  walkObject(sink, value, depth);
}

/**
 * Serializes `value` like `JSON.stringify` (a top-level string stays raw) into at most `budget`
 * characters, and says whether all of it fit. The walk stops at a full budget.
 */
export function serializeToolValue(
  value: unknown,
  budget: number
): { text: string; complete: boolean } {
  const sink: Sink = { text: "", budget, cut: false };
  try {
    walk(sink, value, 0);
  } catch {
    return { text: UNSERIALIZABLE, complete: true };
  }
  return { text: sink.text.slice(0, budget), complete: !sink.cut && sink.text.length <= budget };
}

/**
 * A tool's input or output as at most `maxChars` characters of redacted text, then a marker that
 * says it was cut. A serialization that fits in the budget past the cap says how much was cut;
 * a longer one says at least how much, since the walk stopped before it knew.
 */
export function renderToolValue(value: unknown, maxChars: number): string {
  if (value === undefined) return NONE;
  // The redaction scans a lookahead past the cap, so a secret that starts inside the kept text is
  // matched whole before the cut, and not left as a readable prefix.
  const { text, complete } = serializeToolValue(value, maxChars + REDACTION_LOOKAHEAD_CHARS);
  const redacted = redactSecretLike(text);
  if (complete && text.length <= maxChars) return redacted;
  const cutChars = `${text.length - maxChars}${complete ? "" : "+"}`;
  return `${redacted.slice(0, maxChars)} [truncated ${cutChars} more chars for memory harvest]`;
}
