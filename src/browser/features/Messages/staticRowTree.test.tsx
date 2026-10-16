import "../../../../tests/ui/dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import {
  STATIC_TREE_CLASSES,
  validateStaticTree,
  type StaticNode,
} from "@/common/staticWorkspaceView/tree";
import { renderRowTree } from "./staticRowTree";
import { TypewriterMarkdown } from "./TypewriterMarkdown";
import { UserMessageContent } from "./UserMessageContent";

// Rows the static view draws: the neutral seed rows, then every form a hand-written subset got
// wrong in #6833 (Codex rounds 1-3), which the live components now draw for free.
const DRAWN = [
  "Add a subtract helper next to `add()` in src/math.ts, with a short doc comment.",
  "I added `subtract()` to `src/math.ts`:\n\n```ts\n/** Returns a minus b. */\nexport function subtract(a: number, b: number): number {\n  return a - b;\n}\n```\n\nIt matches the style of `add()`.",
  "Two cases cover it:\n\n1. `subtract(5, 3)` returns `2`.\n2. `subtract(0, 4)` returns `-4` (negative results).\n\nI can write them.",
  "First line\nsecond line\n\n- one\n- two\n\n```py\nx = 1\n\n```\n\nsnake_case and a_b stay text.",
  "```json\n{}\n```",
  "```ts\na\n\n\nb\n```",
  "| a | b |\n|:-|-:|\n| 1 | 2 |",
  "a\n:-",
  "`a\u0000b` and `a``b`",
  "- # T\n- - c\n\n3. three",
  "a ~x~ b, **bold** and *it*",
  "Title\n-\n\n# h1\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n\n> quote\n\n---",
  "```ts\nx\n",
  "```bash\nls\n```",
];
const PAYLOAD = '</script><img src=x onerror="globalThis.__xss=1"> in `<b onclick=x>code</b>`';
// Rows with a link, an image, math, a diagram, a task list, a footnote or details: no view.
const NO_VIEW = [
  "see HTTP://x.test",
  "[l](https://x.test)",
  "![i](https://x.test/a.png)",
  "$$x$$",
  "```math\nx\n```",
  "```mermaid\ngraph TD\n```",
  "- [ ] t",
  "x[^1]\n\n[^1]: n",
  "<details><summary>s</summary>y</details>",
];

const live = (text: string, user: boolean) => (
  <ThemeProvider forcedTheme="dark">
    {user ? (
      <UserMessageContent content={text} variant="sent" />
    ) : (
      <TypewriterMarkdown content={text} isComplete streamKey="k" />
    )}
  </ThemeProvider>
);
/** The live DOM as a tree. React writes style text with spaces; the server markup has none. */
function fromDom(node: Node): StaticNode {
  if (node.nodeType === 3) return node.textContent!;
  const el = node as Element;
  const attrs = Object.fromEntries(
    [...el.attributes].map((a) => [
      a.name,
      a.name === "style" ? a.value.replace(/\s|;$/g, "") : a.value,
    ])
  );
  return [el.tagName.toLowerCase(), attrs, ...[...el.childNodes].map(fromDom)];
}
const classes = (node: StaticNode): string[] =>
  typeof node === "string"
    ? []
    : [
        ...(node[1].class?.split(" ") ?? []),
        ...node.slice(2).flatMap((c) => classes(c as StaticNode)),
      ];

describe("renderRowTree", () => {
  let cleanupDom: () => void;
  beforeEach(() => (cleanupDom = installDom()));
  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  for (const [i, text] of DRAWN.entries()) {
    for (const user of [true, false]) {
      test(`drawn row ${i}, ${user ? "user" : "assistant"}: equals the live DOM`, () => {
        const tree = renderRowTree(text, user);
        expect(tree).not.toBeNull();
        const container = render(live(text, user)).container;
        container.normalize();
        expect(tree).toEqual(fromDom(container.firstChild!));
      });
    }
  }

  test.each(NO_VIEW)("no view for %j", (text) => {
    expect(renderRowTree(text, false)).toBeNull();
  });

  test("the class allow-list is exactly what the drawn rows emit", () => {
    const emitted = new Set(
      DRAWN.flatMap((text) => [true, false].flatMap((user) => classes(renderRowTree(text, user)!)))
    );
    expect([...emitted].sort()).toEqual([...STATIC_TREE_CLASSES].sort());
  });

  test("attacker text stays text: user rows show raw HTML as text, assistant rows give null", () => {
    const tree = JSON.stringify(renderRowTree(PAYLOAD, true));
    expect(tree).toContain("onerror=");
    expect(tree).not.toContain('["img"');
    // Assistant rows parse allowed raw HTML, so the payload becomes an img: not in the allow-list.
    expect(renderRowTree(PAYLOAD, false)).toBeNull();
  });
});

describe("validateStaticTree", () => {
  test.each([
    ["an unknown tag", ["a", { href: "https://x.test" }, "l"]],
    ["a prototype key as tag", ["constructor", {}]],
    ["an event handler", ["p", { onclick: "x" }]],
    ["an unknown class", ["div", { class: "fixed" }]],
    ["a style other than table alignment", ["td", { style: "background:url(x)" }]],
    ["a bad child", ["p", {}, ["img", { src: "x" }]]],
    ["a non-string attribute", ["p", { class: 1 }]],
    ["no attributes object", ["p", "text"]],
    [
      "deep nesting",
      Array.from({ length: 40 }).reduce<unknown>((child) => ["div", {}, child], "x"),
    ],
  ])("rejects %s", (_name, node) => {
    expect(validateStaticTree(node)).toBeNull();
  });
});
