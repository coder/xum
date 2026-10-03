const graphemeSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Longest prefix of `text` that ends on a grapheme boundary and is at most
 * `maxCodeUnitLength` UTF-16 code units long, so streamed text never shows a
 * split emoji or a detached combining mark.
 */
export function sliceAtGraphemeBoundary(text: string, maxCodeUnitLength: number): string {
  if (maxCodeUnitLength <= 0) {
    return "";
  }

  if (maxCodeUnitLength >= text.length) {
    return text;
  }

  if (graphemeSegmenter) {
    let safeEnd = 0;

    for (const segment of graphemeSegmenter.segment(text)) {
      const segmentEnd = segment.index + segment.segment.length;
      if (segmentEnd > maxCodeUnitLength) {
        break;
      }
      safeEnd = segmentEnd;
    }

    return text.slice(0, safeEnd);
  }

  let safeEnd = 0;
  for (const codePoint of Array.from(text)) {
    const codePointEnd = safeEnd + codePoint.length;
    if (codePointEnd > maxCodeUnitLength) {
      break;
    }
    safeEnd = codePointEnd;
  }

  return text.slice(0, safeEnd);
}
