import { describe, expect, test } from "bun:test";
import remend from "remend";
import { repairIncompleteMarkdownTail } from "./repairIncompleteMarkdownTail";

const INTRO = "# Title\n\nIntro with **bold** and `code`.\n\n";

// Complete, balanced blocks of the kinds a reply streams: prose with nested emphasis, code,
// tables, lists, quotes and math.
const BLOCK_TEMPLATES: Array<(k: number) => string> = [
  (k) =>
    `## Heading ${k}\n\nSome **bold ${k}** and *italic* text with \`code\` and a [link](https://example.com/${k}).\n\n`,
  (k) => "```ts\nconst v" + k + " = a + b; // `tick` **x**\n```\n\n",
  (k) => `| A | B |\n| --- | --- |\n| **x${k}** | \`y\` |\n| _u_ | ~~s~~ |\n\n`,
  (k) =>
    `- item ${k} with **bold**\n- item two with [a link](http://x/${k})\n  continued *line*\n\n`,
  (k) => `1. first ~~strike~~\n2. second $x^${k}$ and ***both***\n\n`,
  (k) => `$$\nE = mc^${k}\n$$\n\n`,
  (k) => `> quote with **bold ${k}\n> continued** text and _under_\n\n`,
  (k) => `Para ${k} with nested **bold *italic* inside** and __strong__ end.\n\n`,
];

function generatedDocuments(count: number): string[] {
  // Fixed-seed LCG so a failure reproduces.
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return Array.from({ length: count }, () => {
    let doc = "";
    for (let k = 0; k < 8; k++)
      doc += BLOCK_TEMPLATES[Math.floor(next() * BLOCK_TEMPLATES.length)](k);
    return doc;
  });
}

describe("repairIncompleteMarkdownTail", () => {
  test("matches whole-text remend on every streamed prefix of balanced documents", () => {
    let compared = 0;
    let markerEndings = 0;
    for (const doc of generatedDocuments(6)) {
      for (let end = 1; end <= doc.length; end++) {
        const prefix = doc.slice(0, end);
        const whole = remend(prefix);
        const tail = repairIncompleteMarkdownTail(prefix);
        compared++;
        if (whole === tail) continue;
        // remend pairs a lone trailing `*`/`_`/`$` using the first unpaired marker of its whole
        // input, so for the frame where the text ends on such a marker it can append a closer
        // based on an earlier block. Both keep the text as written; only the appended closer
        // differs, and the next character settles it.
        markerEndings++;
        expect(prefix).toMatch(/[*_$]$/);
        expect(tail.slice(0, prefix.length)).toBe(whole.slice(0, prefix.length));
      }
    }
    expect(compared).toBeGreaterThan(2_000);
    // Guard against a generator change that makes the property vacuous.
    expect(markerEndings).toBeLessThan(compared / 10);
  });

  // Fixed cases with absolute expected text (not the remend oracle the property test uses).
  test.each([
    // remend leaves an open fence as typed: Streamdown renders an unclosed fence as a code block.
    ["an unclosed fence", "```ts\nconst a = 1;\nconst b", "```ts\nconst a = 1;\nconst b"],
    ["an unclosed bold", "Some **bold text", "Some **bold text**"],
    [
      "an unclosed link",
      "See [the docs](https://exa",
      "See [the docs](streamdown:incomplete-link)",
    ],
    [
      "a trailing table row",
      "| A | B |\n| --- | --- |\n| 1 | **tw",
      "| A | B |\n| --- | --- |\n| 1 | **tw**",
    ],
  ])("repairs %s in the last block and keeps earlier blocks", (_name, lastBlock, repaired) => {
    expect(repairIncompleteMarkdownTail(INTRO + lastBlock)).toBe(INTRO + repaired);
  });

  test("falls back to whole-text remend for a single block", () => {
    expect(repairIncompleteMarkdownTail("Only **one block")).toBe("Only **one block**");
  });

  test.each([
    // An image on the last line is cut, as remend 1.0.2 did, instead of "[Image blocked: alt]".
    ["image on the last line", "Some text\nlast line ![alt te", "Some text\nlast line"],
    ["image with a partial URL", "See ![a](https://x/y.p", "See"],
    ["nested images", "x ![a ![b", "x"],
    // 1.0.2 cut here too and deleted every later line; keep the lines and drop the placeholder.
    ["image on an earlier line", "p ![a b\nc d e", "p ![a b\nc d e"],
    ["image before later list items", "- ![a\n- b\n- c **d", "- ![a\n- b\n- c **d"],
    ["image inside a code fence", "```md\n![a\nmore", "```md\n![a\nmore"],
    [
      "image after placeholder text earlier in the reply",
      "a ](streamdown:incomplete-image) and ![x",
      "a ](streamdown:incomplete-image) and",
    ],
    [
      "literal placeholder text",
      "a ](streamdown:incomplete-image)",
      "a ](streamdown:incomplete-image)",
    ],
  ])("handles an unclosed %s", (_name, text, repaired) => {
    expect(repairIncompleteMarkdownTail(text)).toBe(repaired);
  });

  // remend 1.4.0 added these passes; remend 1.0.2 left such text as it was.
  test.each([
    ["comparisonOperators", "- > 25"],
    ["htmlTags", "text <custom"],
    ["singleTilde", "20~25 and"],
  ])("keeps the %s pass off", (_pass, text) => {
    expect(repairIncompleteMarkdownTail(text)).toBe(text);
  });

  test("intended difference: an unbalanced marker in an earlier block no longer adds a closer at the end", () => {
    const text = "Price is 5 * 3.\n\nAll done.";
    // remend 1.0.2 on the whole text counted the earlier lone `*` and appended a stray `*`.
    expect(repairIncompleteMarkdownTail(text)).toBe(text);
  });
});
