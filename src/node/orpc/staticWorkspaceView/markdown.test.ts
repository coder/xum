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
    setextUnderline: "Title\n--",
    emptyListItem: "1.",
    indent: "    indented code",
    hardBreak: "line  \nnext",
  },
  inline: {
    markup: "a *bold* word",
    emphasis: "a _b_ c",
    autolink: "see HTTPS://example.test",
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
    ["a math fence", "```math\nx\n```"],
    ["a table without outer pipes", "a | b\n--- | ---"],
    ["a heading in a list item", "- # Title"],
    ["a nested list", "- - child"],
    ["a new bullet marker", "- a\n* b"],
    ["a new ordered delimiter", "1. a\n2) b"],
    ["a tab after a list marker", "-\titem"],
  ])("no view for %s", (_name, text) => {
    expect(renderStatic(document, text, false)).toBeNull();
  });

  test("Unicode line separators and an indented closing fence", () => {
    const root = document.createElement("div");
    root.append(renderStatic(document, "one\u2028\u2028- two\n\n```ts\nx\n   ```", false)!);
    expect([...root.children].map((c) => c.tagName)).toEqual(["P", "UL", "DIV"]);
    expect(root.querySelectorAll(".code-line").length).toBe(1);
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
