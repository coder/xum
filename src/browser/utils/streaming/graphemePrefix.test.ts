import { describe, expect, it } from "bun:test";
import { sliceAtGraphemeBoundary } from "./graphemePrefix";

// Reference: walk every grapheme from the start of the text. Any faster lookup must
// return exactly this prefix.
function fullWalkPrefix(text: string, max: number): string {
  if (max <= 0) return "";
  if (max >= text.length) return text;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let safeEnd = 0;
  for (const segment of segmenter.segment(text)) {
    const segmentEnd = segment.index + segment.segment.length;
    if (segmentEnd > max) break;
    safeEnd = segmentEnd;
  }
  return text.slice(0, safeEnd);
}

// Multi-code-unit graphemes of every common shape, mixed with ASCII so cuts land
// inside and between them.
const MIXED_GRAPHEMES = [
  "Hi ",
  "e\u0301", // combining acute accent
  "👍🏽", // emoji + skin-tone modifier
  " 👨‍👩‍👧", // ZWJ family
  "🏳️‍🌈", // flag + variation selector + ZWJ
  "🇩🇪🇫🇷", // two regional-indicator flags
  "🇩", // lone regional indicator
  "\r\n",
  "\u1100\u1161\u11a8", // Hangul jamo syllable
  "क्ष", // Devanagari conjunct
  "☺️", // text symbol + emoji variation selector
  " ok",
].join("");

describe("sliceAtGraphemeBoundary", () => {
  it("matches a full grapheme walk at every cut position", () => {
    const texts = [MIXED_GRAPHEMES, MIXED_GRAPHEMES.repeat(3), `x${MIXED_GRAPHEMES}`];
    for (const text of texts) {
      for (let max = -1; max <= text.length + 1; max++) {
        expect({ max, prefix: sliceAtGraphemeBoundary(text, max) }).toEqual({
          max,
          prefix: fullWalkPrefix(text, max),
        });
      }
    }
  });
});
