import { describe, expect, test } from "bun:test";
import { Lexer, type Tokens } from "marked";
import { listItemRanges } from "./streamingMarkdownBlocks";

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
    // marked turns CRLF into LF, so its offsets would not match the block.
    expect(listItemRanges("- a\r\n- b\r\n- c", 1)).toBeNull();
  });
});
