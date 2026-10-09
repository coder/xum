import { Lexer } from "marked";

// A footnote reference or definition. marked has no footnote syntax, so it is found by its text.
const FOOTNOTE = /\[\^[^\]\s]+\]/;

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
  const lexed = Lexer.lex(block, { gfm: true });
  // Reference definitions and footnotes apply to the whole document, so a cut could put a use and
  // its definition in different chunks, and the use would render unresolved while streaming. Such
  // a list stays whole. marked records every reference definition in `links`, also inside items.
  if (Object.keys(lexed.links).length > 0 || FOOTNOTE.test(block)) return null;
  const tokens = lexed.filter((token) => token.type !== "space");
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

/**
 * Cuts one markdown table block into pieces of whole rows, each about `maxChars` long with the
 * head (header and delimiter rows), so a huge streaming table can render as a stack of small
 * tables (#5666). The pieces join back to the block; the first piece starts with the head, and
 * each later piece renders with the head in front of it. Returns null when the block is not one
 * table, so the caller keeps it whole.
 *
 * The cuts only grow at the end while the block grows: a cut is decided only by the lengths of
 * rows that end with a newline, so a sealed piece never changes and no piece disappears.
 */
export function tableRowRanges(
  block: string,
  maxChars: number
): { head: string; pieces: string[] } | null {
  // Streamdown merges a footnote or `$$` block with later blocks, so the block can hold more than
  // the table.
  if (FOOTNOTE.test(block) || block.includes("$$")) return null;
  const delimiterEnd = block.indexOf("\n", block.indexOf("\n") + 1);
  if (delimiterEnd === -1) return null;
  const head = block.slice(0, delimiterEnd + 1);
  // A container (list item, blockquote, HTML block) starts the block, so its head is no table.
  const tokens = Lexer.lex(head, { gfm: true }).filter((token) => token.type !== "space");
  if (tokens.length !== 1 || tokens[0].type !== "table" || head.length > maxChars / 2) return null;
  const pieces: string[] = [];
  let pieceStart = 0;
  let pieceFirstRow = 0;
  let row = 0;
  for (let start = head.length; start < block.length; ) {
    const newline = block.indexOf("\n", start);
    const end = newline === -1 ? block.length : newline + 1;
    const line = block.slice(start, end);
    // A blank line can only end the table, so it is never a row.
    if (line.trim() === "") {
      start = end;
      continue;
    }
    // The tail repair can add a last line without a pipe (a lone `**`) or blank a last line that
    // starts with `![`, so such a line starts a piece only once it is complete. Sealed pieces keep
    // an even number of rows, so the zebra stripes stay in phase across pieces.
    const pieceChars = start - pieceStart + (pieces.length > 0 ? head.length : 0);
    if (
      (newline !== -1 || /^\s*\|/.test(line)) &&
      row % 2 === 0 &&
      row > pieceFirstRow &&
      pieceChars >= maxChars
    ) {
      pieces.push(block.slice(pieceStart, start));
      pieceStart = start;
      pieceFirstRow = row;
    }
    row++;
    start = end;
  }
  pieces.push(block.slice(pieceStart));
  return { head, pieces };
}
