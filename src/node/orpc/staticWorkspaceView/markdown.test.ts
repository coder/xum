import "../../../../tests/ui/dom";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import vm from "node:vm";
import { installDom } from "../../../../tests/ui/dom";
import { RENDER_MARKDOWN_JS, renderMarkdownJs, UNSUPPORTED_MARKDOWN } from "./markdown";

type Render = (doc: Document, text: string, breaks: boolean) => DocumentFragment | null;
const renderStatic = vm.runInNewContext(`(${RENDER_MARKDOWN_JS})`) as Render;
type Rules = typeof UNSUPPORTED_MARKDOWN;

// One sample per rule, keyed by the shared list, so a new rule without a sample fails to compile.
const SAMPLES: { [G in keyof Rules]: Record<keyof Rules[G], string> } = {
  block: {
    heading: "# Title",
    blockquote: "> quoted",
    table: "| a | b |",
    thematicBreak: "text\n\n---",
    setextUnderline: "Title\n===",
    indent: "    indented code",
    hardBreak: "line  \nnext",
  },
  inline: {
    emphasis: "a *bold* word",
    strike: "~~gone~~",
    link: "[docs](x)",
    autolink: "see https://example.test",
    rawHtml: "a <b>tag</b>",
    entity: "a &amp; b",
    escape: "a \\# b",
    math: "costs $5",
  },
  fence: { language: "```bash\nls\n```" },
};

describe("static markdown subset", () => {
  let cleanupDom: () => void;
  beforeEach(() => (cleanupDom = installDom()));
  afterEach(() => cleanupDom());

  for (const [group, rules] of Object.entries(UNSUPPORTED_MARKDOWN)) {
    for (const name of Object.keys(rules)) {
      test(`no view for ${group}.${name}`, () => {
        const sample = (SAMPLES as Record<string, Record<string, string>>)[group][name];
        expect(renderStatic(document, sample, false)).toBeNull();
        // Without this one rule the renderer would draw the sample: the rule decides it.
        const without = structuredClone(UNSUPPORTED_MARKDOWN) as Record<
          string,
          Record<string, RegExp>
        >;
        without[group][name] = /(?!)/;
        const renderWithout = vm.runInNewContext(
          `(${renderMarkdownJs(without as Rules)})`
        ) as Render;
        expect(renderWithout(document, sample, false)).not.toBeNull();
      });
    }
  }

  test.each([
    ["an unclosed code span", "a `b"],
    ["a loose list", "- a\n\n- b"],
    ["a list that does not start at 1", "3. three"],
    ["a lazy list continuation", "- a\nb"],
    ["a mixed list", "- a\n1. b"],
    ["an empty fence", "```ts\n```"],
    ["mermaid", "```mermaid\ngraph TD\n```"],
    ["a fence without a language", "```\nplain\n```"],
    ["a double-backtick code span", "``a`b``"],
  ])("no view for %s", (_name, text) => {
    expect(renderStatic(document, text, false)).toBeNull();
  });

  test("attacker text stays text, in prose and in code", () => {
    const payload =
      '</script><img src=x onerror="globalThis.__xss=1"><script>globalThis.__xss=2</script>';
    for (const text of [`\`${payload}\``, `\`\`\`html\n${payload}\n\`\`\``]) {
      const root = document.createElement("div");
      root.append(renderStatic(document, text, false)!);
      expect(root.querySelectorAll("img, script").length).toBe(0);
      expect(root.textContent).toContain(payload);
    }
    expect((globalThis as { __xss?: number }).__xss).toBeUndefined();
  });
});
