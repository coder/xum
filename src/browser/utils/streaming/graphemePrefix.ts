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
    // Walking the segmenter from index 0 costs O(prefix) per render, which made a
    // stream O(n^2) (the top app function in chat-switch perf profiles).
    // containing() gives a real grapheme start at or before the answer. V8 returns
    // the exact segment, so the walk below runs once. JavaScriptCore (Bun, Safari)
    // sometimes returns an earlier segment, so finish with a short walk. Segmenting a
    // suffix that starts on a real boundary yields the same boundaries as the full text.
    const hint = graphemeSegmenter.segment(text).containing(maxCodeUnitLength)?.index ?? 0;
    let safeEnd = hint;

    for (const segment of graphemeSegmenter.segment(text.slice(hint))) {
      const segmentEnd = hint + segment.index + segment.segment.length;
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
