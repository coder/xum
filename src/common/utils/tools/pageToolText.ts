import { TOOL_TEXT_PAGE_MAX_CHARS } from "@/common/constants/toolLimits";
import assert from "@/common/utils/assert";

export interface ToolTextPage {
  text: string;
  /** Present when text remains: pass it as offset_chars to read the next page. */
  nextCharOffset?: number;
}

/**
 * One page of a long stored text, in UTF-16 units like session_history's read_item. The cut
 * never splits a surrogate pair, so pages concatenate back to the exact text.
 */
export function pageToolText(
  text: string,
  offsetChars = 0,
  maxChars = TOOL_TEXT_PAGE_MAX_CHARS
): ToolTextPage {
  assert(Number.isInteger(offsetChars) && offsetChars >= 0, "offsetChars must be >= 0");
  assert(Number.isInteger(maxChars) && maxChars > 1, "maxChars must be > 1");
  const start = Math.min(offsetChars, text.length);
  let end = Math.min(start + maxChars, text.length);
  const previous = text.charCodeAt(end - 1);
  if (end < text.length && previous >= 0xd800 && previous <= 0xdbff) end -= 1;
  const page = text.slice(start, end);
  return end < text.length ? { text: page, nextCharOffset: end } : { text: page };
}

/**
 * pageToolText plus the fields a paged tool result carries: nextCharOffset and a note naming
 * the exact call (with "<offset>" in `call`) that reads the next page. On the last page both
 * are absent.
 */
export function pageToolTextForResult(
  text: string,
  offsetChars: number | null | undefined,
  call: string
): { text: string; nextCharOffset?: number; note?: string } {
  const page = pageToolText(text, offsetChars ?? 0);
  if (page.nextCharOffset == null) return page;
  const next = String(page.nextCharOffset);
  return {
    ...page,
    note: `Text continues: read the next page with ${call.replace("<offset>", next)}.`,
  };
}
