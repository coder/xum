import "../../../../tests/ui/dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import vm from "node:vm";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { TypewriterMarkdown } from "@/browser/features/Messages/TypewriterMarkdown";
import { RENDER_MARKDOWN_JS } from "./markdown";

type Render = (doc: Document, text: string, breaks: boolean) => DocumentFragment | null;
/** The exact exported source, compiled as the browser will: a syntax error fails here. */
const renderStatic = vm.runInNewContext(`(${RENDER_MARKDOWN_JS})`) as Render;

/** Tags, attributes and text, without the whitespace-only text react-markdown puts between blocks. */
function shape(node: Node): unknown {
  if (node.nodeType === 3) return node.textContent;
  const el = node as Element;
  const attrs = [...el.attributes].map((a) => `${a.name}=${a.value}`).sort();
  const kids = [...el.childNodes].filter((c) => c.nodeType !== 3 || c.textContent!.trim());
  return [el.tagName.toLowerCase(), attrs, ...kids.map(shape)];
}
const blocks = (root: Node) => {
  root.normalize();
  return [...root.childNodes].filter((c) => c.nodeType !== 3 || c.textContent!.trim()).map(shape);
};

// Each sample in the subset, rendered by the live components for user rows (preserveLineBreaks)
// and assistant rows (TypewriterMarkdown), must match the static renderer node for node.
const SAMPLES = [
  "Add a subtract helper next to `add()` in src/math.ts, with a short doc comment.",
  "I added `subtract()` to `src/math.ts`:\n\n```ts\n/** Returns a minus b. */\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n```\n\nIt matches the style of `add()`.",
  "Two cases cover it:\n\n1. `subtract(5, 3)` returns `2`.\n2. `subtract(0, 4)` returns `-4` (negative results).\n\nI can write them.",
  "First line\nsecond line\n\n- one\n- two\n\n```py\nx = 1\n\n```\n\nsnake_case and a_b stay text.",
  "```json\n{}\n```",
];

describe("static markdown parity with the live renderer", () => {
  let cleanupDom: () => void;
  beforeEach(() => (cleanupDom = installDom()));
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  for (const [i, text] of SAMPLES.entries()) {
    for (const user of [true, false]) {
      test(`sample ${i}, ${user ? "user" : "assistant"} row`, () => {
        const live = render(
          <ThemeProvider forcedTheme="dark">
            {user ? (
              <MarkdownRenderer content={text} preserveLineBreaks />
            ) : (
              <TypewriterMarkdown content={text} isComplete streamKey="k" />
            )}
          </ThemeProvider>
        );
        const inner = live.container.querySelector(".markdown-content > div")!;
        const fragment = renderStatic(document, text, user);
        expect(fragment).not.toBeNull();
        expect(blocks(fragment!)).toEqual(blocks(inner));
      });
    }
  }
});
