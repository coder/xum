import { Lexer } from "marked";

/**
 * Cuts one markdown list block into ranges of whole top-level items, each about `maxChars` long,
 * that join back to the block. Returns null when the block is not a single list, so the caller
 * keeps it whole.
 *
 * Item bounds come from `marked`, the lexer behind Streamdown's block splitter (pinned to the
 * same version), so a nested list, an indented fence or a lazy continuation line stays inside its
 * item. An item longer than `maxChars` is a range on its own: there is no cut inside an item.
 */
export function listItemRanges(block: string, maxChars: number): string[] | null {
  const tokens = Lexer.lex(block, { gfm: true }).filter((token) => token.type !== "space");
  const list = tokens[0];
  if (tokens.length !== 1 || list.type !== "list") return null;
  const starts: number[] = [];
  let offset = 0;
  for (const item of list.items as Array<{ raw: string }>) {
    // The lexer normalizes some input (e.g. CRLF), so its raw text can differ from the block.
    // Then the offsets would not map back, and the block stays whole.
    if (!block.startsWith(item.raw, offset)) return null;
    starts.push(offset);
    offset += item.raw.length;
  }
  // The last item runs to the end of the block: the lexer trims the trailing whitespace of its raw.
  const ranges: string[] = [];
  let rangeStart = 0;
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? block.length;
    if (start > rangeStart && end - rangeStart > maxChars) {
      ranges.push(block.slice(rangeStart, start));
      rangeStart = start;
    }
  }
  ranges.push(block.slice(rangeStart));
  return ranges;
}
