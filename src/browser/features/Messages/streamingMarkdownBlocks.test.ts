import { describe, expect, test } from "bun:test";
import { Lexer, type Tokens } from "marked";
import { repairIncompleteMarkdownTail } from "./repairIncompleteMarkdownTail";
import { listItemRanges, tableRowRanges } from "./streamingMarkdownBlocks";

function topLevelItems(markdown: string): number {
  // marked's Token union includes a generic `{ type: string }` member, so `type` does not narrow.
  const list = Lexer.lex(markdown, { gfm: true }).find((token) => token.type === "list") as
    | Tokens.List
    | undefined;
  return list?.items.length ?? 0;
}

// Lists whose items hold the constructs that must not be cut: a nested list, an indented fence
// with a `- x` line at the item's own indent, a lazy continuation line, and an HTML block.
const LISTS: Record<string, (k: number) => string> = {
  bullet: (k) => `- item ${k} with **bold** and \`code\`\n`,
  ordered: (k) => `${k + 6}. item ${k} with *em*\n`,
  loose: (k) => `${k}. item ${k} paragraph text\n\n`,
  task: (k) => `- [${k % 2 === 0 ? "x" : " "}] task ${k}\n`,
  nested: (k) => `- item ${k}\n  - child ${k}a\n  - child ${k}b\n    1. deep ${k}\n`,
  fence: (k) => `- item ${k}\n  \`\`\`\n  - x not an item\n  \`\`\`\n`,
  lazy: (k) => `- item ${k} starts here\nlazy continuation ${k}\n`,
  html: (k) => `- item ${k}\n\n  <details>\n  <summary>s${k}</summary>\n  </details>\n`,
};

describe("listItemRanges", () => {
  test.each(Object.entries(LISTS))(
    "%s: ranges join back to every prefix and never split an item",
    (_kind, line) => {
      const full = Array.from({ length: 80 }, (_, k) => line(k + 1)).join("");
      let cuts = 0;
      for (let end = 1; end <= full.length; end += 13) {
        const block = full.slice(0, end);
        const ranges = listItemRanges(block, 200);
        // A prefix that is not a list yet (`7` before its `.`) stays whole.
        const tokens = Lexer.lex(block, { gfm: true }).filter((token) => token.type !== "space");
        if (tokens.length !== 1 || tokens[0].type !== "list") {
          expect(ranges).toBeNull();
          continue;
        }
        expect(ranges).not.toBeNull();
        expect(ranges!.join("")).toBe(block);
        // Each range lexes as whole items of the same list, so no item was cut in two.
        // (An empty last item, `- ` before its text, does not lex as a list on its own.)
        const items = ranges!.reduce(
          (sum, range) => sum + (/^(\d+\.|-) ?$/.test(range) ? 1 : topLevelItems(range)),
          0
        );
        expect(items).toBe(topLevelItems(block));
        cuts = Math.max(cuts, ranges!.length - 1);
      }
      expect(cuts).toBeGreaterThan(3);
    }
  );

  test("keeps an item longer than a range whole, as a range of its own", () => {
    const long = `- long ${"word ".repeat(400)}\n`;
    const block = "- a\n- b\n" + long + "- c\n- d";
    const ranges = listItemRanges(block, 100);
    expect(ranges).toEqual(["- a\n- b\n", long, "- c\n- d"]);
  });

  test("returns null for blocks that are not one list, or whose text the lexer normalizes", () => {
    expect(listItemRanges("A paragraph.", 10)).toBeNull();
    expect(listItemRanges("| a | b |\n|---|---|\n| 1 | 2 |\n", 10)).toBeNull();
    expect(listItemRanges("```\n- a\n- b\n```\n", 10)).toBeNull();
    expect(listItemRanges("- a\n- b\n\nAfter the list.", 10)).toBeNull();
    // A cut could separate a reference or footnote from its definition.
    expect(listItemRanges("- use [a][r]\n- [r]: http://x\n- c", 1)).toBeNull();
    expect(listItemRanges("- use [a][r]\n\n  [r]: http://x\n- c", 1)).toBeNull();
    expect(listItemRanges("- note[^1]\n- b\n\n  [^1]: the note\n- c", 1)).toBeNull();
    expect(listItemRanges("- a [link](http://x)\n- b\n- c", 1)).toEqual([
      "- a [link](http://x)\n",
      "- b\n",
      "- c",
    ]);
    // marked turns CRLF into LF, so its offsets would not match the block.
    expect(listItemRanges("- a\r\n- b\r\n- c", 1)).toBeNull();
  });
});

// Body rows of the one table in `markdown`, or -1 when it is not exactly one table.
function tableRows(markdown: string): number {
  const tokens = Lexer.lex(markdown, { gfm: true }).filter((token) => token.type !== "space");
  return tokens.length === 1 && tokens[0].type === "table"
    ? (tokens[0] as Tokens.Table).rows.length
    : -1;
}

// Rows with the constructs a cut must keep whole: escaped pipes, pipes in code, extra and missing
// cells, empty rows, links and images, an unclosed `**` row and lazy rows (one starts with an image).
const TABLE_ROWS: Array<(k: number) => string> = [
  (k) => `| ${k} | a \\| b | \`x|y\` |`,
  (k) => `| ${k} | [link ${k}](https://x/${k}) | ![img](https://x/${k}.png) |`,
  (k) => `| ${k} | **unclosed bold ${k} |  |`,
  (k) => `| ${k} | extra | cells | here |`,
  (k) => `| ${k} |`,
  () => "|  |  |  |",
  (k) => `lazy row ${k} with *em*`,
  (k) => `![lazy image](https://x/${k}.png) after the image`,
];

function generatedTable(seed: number): string {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31);
  // One table has no outer pipes, the others have aligned columns.
  let out =
    seed === 0 ? "n | value | code\n--- | --- | ---\n" : "| n | value | code |\n|:--|:-:|--:|\n";
  for (let k = 1; out.length < 1_500; k++) out += TABLE_ROWS[next() % TABLE_ROWS.length](k) + "\n";
  // Blank lines end the table; Streamdown keeps them in the table block.
  return out + (seed % 2 === 0 ? "\n" : "\n   \n");
}

describe("tableRowRanges", () => {
  // One case per table: the tail repair of every prefix is slow.
  test.each(Array.from({ length: 10 }, (_, seed) => seed))(
    "tableRowRanges keeps whole rows and never changes or drops a piece (table %i)",
    (seed) => {
      let cuts = 0;
      const rowCache = new Map<string, number>();
      const full = generatedTable(seed);
      for (const repair of [false, true]) {
        let previous: string[] = [];
        for (let end = 1; end <= full.length; end++) {
          const block = repair
            ? repairIncompleteMarkdownTail(full.slice(0, end))
            : full.slice(0, end);
          const ranges = tableRowRanges(block, 200);
          if (ranges === null) {
            // Only a prefix without a whole head (two complete lines) stays whole.
            expect(block.split("\n").length).toBeLessThan(3);
            continue;
          }
          const { head, pieces } = ranges;
          expect(pieces.join("")).toBe(block);
          expect(pieces[0].startsWith(head)).toBe(true);
          // No piece holds only the head (a blank line is never a row).
          for (const piece of pieces.slice(1)) expect(piece.trim()).not.toBe("");
          // Each piece renders as head + slice, and together they hold the rows of the block.
          // Lexing is slow, so it runs at row ends, at new cuts and at the end; sealed pieces never
          // change, so their counts are cached.
          if (block.endsWith("\n") || pieces.length > previous.length || end === full.length) {
            const rows = pieces.map((piece, index) => {
              const source = index === 0 ? piece : head + piece;
              return rowCache.get(source) ?? rowCache.set(source, tableRows(source)).get(source)!;
            });
            expect(rows.reduce((sum, count) => sum + count, 0)).toBe(tableRows(block));
            for (const [index, count] of rows.entries()) {
              if (pieces.length > 1) expect(count).toBeGreaterThan(0);
              // Sealed pieces have an even number of rows, so the zebra stripes stay in phase.
              if (index < rows.length - 1) expect(count % 2).toBe(0);
            }
          }
          // A cut never reads the length of the incomplete last row: the same prefix with only the
          // first character of that row cuts at the same offsets.
          const lineStart = block.lastIndexOf("\n") + 1;
          const shortLine = /^\s*\S?/.exec(block.slice(lineStart))![0];
          const short = tableRowRanges(block.slice(0, lineStart) + shortLine, 200)!.pieces;
          expect(short.slice(0, -1)).toEqual(pieces.slice(0, -1));
          // Pieces are only added at the end: a sealed piece never changes, none disappears.
          expect(pieces.length).toBeGreaterThanOrEqual(previous.length);
          for (let i = 0; i < previous.length - 1; i++) expect(pieces[i]).toBe(previous[i]);
          previous = pieces;
          cuts += pieces.length - 1;
        }
      }
      expect(cuts).toBeGreaterThan(1_000);
    }
  );

  // The tail repair keeps a lone `!` but blanks `![`, so a piece that started at an incomplete line
  // without a pipe would disappear one character later.
  test("an incomplete last line without a pipe starts no piece", () => {
    const rows = "| 1 | aaaaaaaaaaaaaaaaaaaa |\n| 2 | bbbbbbbbbbbbbbbbbbbbbbbbb |\n";
    const table = `| n | v |\n|---|---|\n${rows}`;
    for (const lazy of ["![lazy image](https://x/1.png) after it", "**lazy bold** row"]) {
      let previous = 1;
      for (let end = 1; end <= lazy.length; end++) {
        const block = repairIncompleteMarkdownTail(table + lazy.slice(0, end));
        const pieces = tableRowRanges(block, table.length)!.pieces;
        expect(pieces.length).toBeGreaterThanOrEqual(previous);
        previous = pieces.length;
      }
      expect(tableRowRanges(`${table}${lazy}\n`, table.length)!.pieces).toHaveLength(2);
    }
  });

  test("keeps a table whole when its head is longer than half a piece", () => {
    const wide = `| ${"h | ".repeat(20)}\n|${"---|".repeat(20)}\n| 1 |\n| 2 |\n| 3 |\n`;
    expect(tableRowRanges(wide, 100)).toBeNull();
    expect(tableRowRanges(wide, 2_000)?.pieces).toEqual([wide]);
  });
});
