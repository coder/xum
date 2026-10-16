import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { PhoneChrome } from "@/common/staticWorkspaceView/phoneChrome";
import { PHONE_CHROME_JSON } from "@/common/staticWorkspaceView/phoneChrome.generated";
import { validateStaticTree, type StaticNode } from "@/common/staticWorkspaceView/tree";
import { VIEW_BUILDER_SOURCE } from "@/common/staticWorkspaceView/viewBuilder";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { renderRowTree } from "./staticRowTree";

// The page-side builder runs as the shipped string, in a fresh happy-dom window with no module
// scope: only `document` is passed in, as the early script's own scope has it.
const skeleton = JSON.parse(PHONE_CHROME_JSON) as PhoneChrome;
let dom: GlobalWindow | undefined;
afterEach(async () => {
  setSystemTime();
  await dom?.happyDOM.close();
  dom = undefined;
});

interface Row {
  id: string;
  role: string;
  text: string | null;
  timestamp: unknown;
  model: unknown;
  tree: unknown;
}
type Build = (skeleton: unknown, tail: unknown, now: number) => Element | null;
function builder(): { build: Build; doc: Document } {
  dom = new GlobalWindow();
  const doc = dom.document as unknown as Document;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- runs the shipped string itself
  const load = new Function("document", `${VIEW_BUILDER_SOURCE}\nreturn buildWorkspaceView;`) as (
    document: Document
  ) => Build;
  const build = load(doc);
  return { build, doc };
}
const NOW = Date.UTC(2026, 0, 1, 12);
const MODEL = { label: "Sonnet 4.5", provider: "anthropic", via: null };
const row = (text: string, user: boolean, extra: Partial<Row> = {}): Row => ({
  ...{ id: text, role: user ? "user" : "assistant", text, timestamp: NOW - 60_000 },
  ...{ model: user ? null : MODEL, tree: renderRowTree(text, user) },
  ...extra,
});
const SEED = [
  row("Add a subtract helper next to `add()` in src/math.ts.", true),
  row("I added it:\n\n```ts\nexport const sub = (a: number, b: number) => a - b;\n```", false),
  row("Thanks. Which tests should I add?", true),
  row("Two cases:\n\n1. `sub(5, 3)` returns `2`.\n2. `sub(0, 4)` returns `-4`.", false),
];
const tail = (rows: Row[], title = "seed") => ({ title, project: "demo-app", rows });

/** The DOM back as a tree, for comparison with the tree it was built from. */
function toTree(node: Node): StaticNode {
  if (node.nodeType === 3) return node.textContent!;
  const el = node as Element;
  const attrs = Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  return [el.localName, attrs, ...[...el.childNodes].map(toTree)];
}
const rowsOf = (view: Element) => [...view.querySelectorAll("[data-transcript-message]")];

describe("buildWorkspaceView", () => {
  test("draws each row's tree into its template, in order, as the tree itself", () => {
    const { build } = builder();
    const view = build(skeleton, tail(SEED), NOW)!;
    const rows = rowsOf(view);
    expect(rows).toHaveLength(SEED.length);
    rows.forEach((el, i) => {
      const content = el.querySelector(".markdown-content > div")!;
      const tree = SEED[i].tree as StaticNode[];
      expect([...content.childNodes].map(toTree)).toEqual((tree[2] as StaticNode[]).slice(2));
      // The user template draws no model display; the assistant one draws the label.
      expect(el.querySelector("[data-model-display]")?.textContent ?? null).toBe(
        SEED[i].role === "user" ? null : "Sonnet 4.5"
      );
    });
    // The code block keeps its SVG namespace (the copy icon), as the live DOM does.
    const svg = "http://www.w3.org/2000/svg";
    expect(view.querySelector(".markdown-content svg path")?.namespaceURI).toBe(svg);
  });

  test("fills the title and rows slots only: the other slots add no text", () => {
    const { build } = builder();
    const view = build(skeleton, tail(SEED, "My title"), NOW)!;
    const fixed = (node: unknown): string =>
      typeof node === "string"
        ? node
        : Array.isArray(node)
          ? node.slice(2).map(fixed).join("")
          : "";
    const rowText = rowsOf(view)
      .map((el) => el.textContent)
      .join("");
    expect(view.textContent.replace(rowText, "").replace("My title", "")).toBe(
      fixed(skeleton.chrome)
    );
  });

  test("attacker text in the title, a row and the model label stays text", () => {
    const { build, doc } = builder();
    const payload = '</script><img src=x onerror="globalThis.__xss=1">';
    const rows = [
      row(payload, true),
      row("ok", false, { model: { label: payload, provider: "x", via: payload } }),
    ];
    const view = build(skeleton, tail(rows, payload), NOW)!;
    doc.body.append(view);
    expect(doc.querySelector("img")).toBeNull();
    expect(view.textContent.split(payload).length - 1).toBe(4); // title, row, label, route
  });

  // Each case removes one check: the view would draw a row it cannot draw like the live one.
  test.each<[string, Partial<Row>]>([
    ['an "other" row', { role: "other" }],
    ["no tree (math, a link)", { tree: null }],
    ["a timestamp that is not a number", { timestamp: "1" }],
    ["a model without a label", { model: { provider: "x", via: null } }],
    [
      "a tree with more than the content div",
      { tree: ["div", { class: "markdown-content" }, ["div", {}, "a"], ["div", {}, "b"]] },
    ],
  ])("gives no view for %s", (_name, extra) => {
    const { build } = builder();
    expect(build(skeleton, tail([SEED[0], row("x", false, extra)]), NOW)).toBeNull();
  });

  test("checks each row tree as validateStaticTree does", () => {
    const wrap = (node: unknown) => [
      "div",
      { class: "markdown-content" },
      ["div", { class: "whitespace-normal" }, node],
    ];
    const cases: unknown[] = [
      ["p", {}, "ok"],
      ["a", { href: "https://x.test" }, "l"],
      ["constructor", {}],
      ["p", { onclick: "x" }],
      ["div", { class: "fixed" }],
      ["td", { style: "background:url(x)" }],
      ["td", { style: "text-align:left" }],
      ["p", { class: 1 }],
      ["p", "text"],
      Array.from({ length: 40 }).reduce<unknown>((child) => ["div", {}, child], "x"),
    ];
    const { build } = builder();
    for (const node of cases) {
      const drawn = build(skeleton, tail([row("x", true, { tree: wrap(node) })]), NOW) !== null;
      expect([JSON.stringify(node).slice(0, 40), drawn]).toEqual([
        JSON.stringify(node).slice(0, 40),
        validateStaticTree(wrap(node)) !== null,
      ]);
    }
  });

  test.each([
    ["today", Date.UTC(2026, 0, 1, 9, 5)],
    ["another day", Date.UTC(2025, 11, 31, 23, 59)],
    ["another year, same day and month", Date.UTC(2025, 0, 1, 9, 5)],
  ])("formats the row time as formatTimestamp does: %s", (_name, ms) => {
    setSystemTime(new Date(NOW));
    const { build } = builder();
    const view = build(skeleton, tail([row("x", true, { timestamp: ms })]), NOW)!;
    expect(view.querySelector("[data-message-timestamp]")!.textContent).toBe(formatTimestamp(ms));
  });

  test("an empty or malformed tail gives no view", () => {
    const { build } = builder();
    for (const bad of [null, {}, tail([]), { title: 1, rows: SEED }]) {
      expect(build(skeleton, bad, NOW)).toBeNull();
    }
  });
});
