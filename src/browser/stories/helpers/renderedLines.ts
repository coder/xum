/**
 * The line tops that the text of `range` covers. An inline-block's own client rects hold one box
 * for all its lines, so measure a range over its text.
 */
export function renderedLineTops(range: Range): Set<number> {
  return new Set(Array.from(range.getClientRects()).map((rect) => Math.round(rect.top)));
}

/** The line tops that the first `text` inside `element` covers: one top means it is not split. */
export function textLineTops(element: HTMLElement, text: string): Set<number> {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const start = (node.textContent ?? "").indexOf(text);
    if (start === -1) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    return renderedLineTops(range);
  }
  throw new Error(`${text} is not inside the element`);
}
