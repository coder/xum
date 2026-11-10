import { describe, expect, test } from "bun:test";
// Test-only reference output; the main-thread rule does not apply to a bun test.
// eslint-disable-next-line no-restricted-imports
import { createHighlighter } from "shiki";
import { canHighlight, highlightToShikiHtml } from "./highlightsEngine";
import { extractShikiLines, SHIKI_COLOR_REPLACEMENTS, SHIKI_LIGHT_THEME } from "./shiki-shared";

// Samples end with a newline and hold an empty line, because diff highlighting maps the
// extracted lines back to diff rows by index: the line count must match Shiki's exactly.
const SAMPLES: Record<string, string> = {
  typescript: 'const a = "<b>";\n\n// note\nfunction f(x: number) { return x && a }\n',
  python: "def f(x):\n    # note\n\n    return x < 3\n",
  rust: 'fn main() {\n    let s = "a&b";\n\n    println!("{}", s);\n}\n',
  yaml: "a: 1\n\n# note\nb: [x, y]\n",
  bash: 'echo "$HOME" > /tmp/x\n\nif [ -f a ]; then cat a; fi\n',
};

// Text of a line, with the entities both encoders use (Shiki: &#x3C;, Highlights: &lt;) decoded.
const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

describe("highlightToShikiHtml", () => {
  test.each(Object.keys(SAMPLES))("%s: same lines and text as Shiki", async (lang) => {
    const shiki = await createHighlighter({ themes: [SHIKI_LIGHT_THEME], langs: [lang] });
    const shikiHtml = shiki.codeToHtml(SAMPLES[lang], { lang, theme: SHIKI_LIGHT_THEME });

    const ours = extractShikiLines(highlightToShikiHtml(SAMPLES[lang], lang, "light"));
    expect(ours.map(stripTags)).toEqual(extractShikiLines(shikiHtml).map(stripTags));
    // Every token keeps the style shape the contrast stories select on.
    expect(ours.join("")).toMatch(/<span style="color:#[0-9a-f]{6}/);
  });

  test("escapes markup in tokens", () => {
    const html = highlightToShikiHtml(
      'const s = "<img src=x onerror=alert(1)>";',
      "typescript",
      "dark"
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("applies the light contrast map to theme colors", () => {
    // min-light paints comments #c2c3c5 (1.6:1 on the light code background).
    const html = highlightToShikiHtml("// note", "typescript", "light");
    const replacement = SHIKI_COLOR_REPLACEMENTS[SHIKI_LIGHT_THEME]["#c2c3c5"];
    expect(html).toContain(`color:${replacement}`);
    expect(html).not.toContain("#c2c3c5");
  });

  test("refuses a language without a Highlights lexer", () => {
    expect(canHighlight("ini")).toBe(false);
    expect(() => highlightToShikiHtml("a=1", "ini", "light")).toThrow();
  });
});
