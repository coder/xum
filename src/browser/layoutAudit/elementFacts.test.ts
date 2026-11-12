import { describe, expect, test } from "bun:test";
import {
  isRequiredControl,
  isVisibleTextHolder,
  nestedClippingBoundaries,
  selectorFor,
  textFragments,
  textTruncation,
} from "./elementFacts";
import { createFakeLayoutPage } from "./fakeLayoutPage.testHarness";

/** The selectors of every element matching `query`, in document order. */
function selectors(html: string, query: string): string[] {
  using fake = createFakeLayoutPage(html);
  return Array.from(fake.page.document.querySelectorAll(query)).map((el) =>
    selectorFor(fake.page, el)
  );
}

describe("selectorFor", () => {
  test("names an element by its tag path from <html>", () => {
    expect(selectors("<main><p>a</p></main>", "p")).toEqual(["html > body > main > p"]);
  });

  test("stops at the nearest id", () => {
    const html = '<main id="app"><section id="inner"><p>a</p></section></main>';
    expect(selectors(html, "p")).toEqual(["section#inner > p"]);
    expect(selectors(html, "main")).toEqual(["main#app"]);
  });

  test("counts an element among the siblings that share its tag", () => {
    const html = '<ul id="list"><li>a</li><li>b</li><b>x</b><li>c</li></ul>';
    expect(selectors(html, "li")).toEqual([
      "ul#list > li:nth-of-type(1)",
      "ul#list > li:nth-of-type(2)",
      "ul#list > li:nth-of-type(3)",
    ]);
    expect(selectors(html, "b")).toEqual(["ul#list > b"]);
  });

  test("keeps the nearest five parts of a deeper path", () => {
    const html = "<a><b><i><u><s><em>deep</em></s></u></i></b></a>";
    expect(selectors(html, "em")).toEqual(["b > i > u > s > em"]);
  });

  test("escapes an id the way CSS needs", () => {
    expect(selectors("<p id='a.b:c'>x</p>", "p")).toEqual(["p#a\\.b\\:c"]);
  });
});

describe("textTruncation", () => {
  function truncationOf(css: string) {
    using fake = createFakeLayoutPage(`<p data-css="${css}">text</p>`);
    const paragraph = fake.page.document.querySelector("p");
    if (paragraph === null) throw new Error("no <p>");
    return textTruncation(fake.page.style(paragraph));
  }

  test("names the cut the author asked for, and a line clamp wins over an ellipsis", () => {
    expect(truncationOf("")).toBe("none");
    expect(truncationOf("text-overflow: ellipsis")).toBe("ellipsis");
    expect(truncationOf("webkit-line-clamp: 2")).toBe("line-clamp");
    expect(truncationOf("text-overflow: ellipsis; webkit-line-clamp: 2")).toBe("line-clamp");
    expect(truncationOf("webkit-line-clamp: none")).toBe("none");
  });
});

describe("textFragments", () => {
  const SHOWN_LINE = "0 0 100 20";
  // A paragraph with its own line and `inner` after it. A Range measures hidden text too, so the
  // fake gives every span lines: what comes back is what the filter let through.
  function paragraphLines(inner: string): number[] {
    using fake = createFakeLayoutPage(`<p data-lines="${SHOWN_LINE}">Visible ${inner}</p>`);
    const paragraph = fake.page.document.querySelector("p");
    if (paragraph === null) throw new Error("no <p>");
    return textFragments(fake.page, paragraph).map((box) => box.width);
  }
  const span = (css: string, attributes = "") =>
    `<span data-css="${css}" ${attributes} data-lines="0 0 500 20">words</span>`;

  test("a text boundary reads the text of what it holds, in document order", () => {
    expect(paragraphLines(span(""))).toEqual([100, 500]);
    expect(paragraphLines(`${span("")}${span("")}`)).toEqual([100, 500, 500]);
  });

  test.each([
    ["visibility: hidden", span("visibility: hidden")],
    ["opacity 0", span("opacity: 0")],
    ["content-visibility: hidden", span("content-visibility: hidden")],
    [
      "inside a hidden element",
      `<i data-css="visibility: hidden"><b data-lines="0 0 500 20">words</b></i>`,
    ],
    ["of a diagram", span("", 'class="mermaid"')],
    [
      "screen-reader-only",
      span("position: absolute; white-space: nowrap; overflow-x: hidden", 'data-box="0 0 1 1"'),
    ],
  ])("text that is %s is not read", (_name, inner) => {
    expect(paragraphLines(inner)).toEqual([100]);
  });

  test("a descendant that switches visibility back on is read", () => {
    const inner = `<i data-css="visibility: hidden">${span("visibility: visible")}</i>`;
    expect(paragraphLines(inner)).toEqual([100, 500]);
  });
});

describe("isRequiredControl", () => {
  function isControl(html: string): boolean {
    using fake = createFakeLayoutPage(html);
    const el = fake.page.document.body.firstElementChild;
    if (el === null) throw new Error("no element");
    return isRequiredControl(el);
  }

  test.each([
    "<button>Go</button>",
    "<input>",
    "<select></select>",
    "<textarea></textarea>",
    '<a href="#x">Go</a>',
    "<summary>Go</summary>",
    '<button role="menuitem">Go</button>',
    '<button role="presentation">Go</button>',
    '<div role="slider"></div>',
    '<div role="MenuItemRadio"></div>',
    '<div role="scrollbar"></div>',
  ])("%s is a control", (html) => {
    expect(isControl(html)).toBe(true);
  });

  test.each([
    "<div>Go</div>",
    "<a>Go</a>",
    '<div role="presentation">Go</div>',
    '<ul role="menu"></ul>',
    '<div role="tablist"></div>',
    '<div role="gridcell"></div>',
    '<div role="separator"></div>',
    "<input type='hidden'>",
    "<button disabled>Go</button>",
    '<button aria-disabled="true">Go</button>',
    '<div role="button" aria-disabled="true">Go</div>',
    '<div role="button" disabled>Go</div>',
  ])("%s is not", (html) => {
    expect(isControl(html)).toBe(false);
  });
});

describe("isVisibleTextHolder", () => {
  function holders(html: string): Record<string, boolean> {
    using fake = createFakeLayoutPage(html);
    const found: Record<string, boolean> = {};
    for (const el of Array.from(fake.page.document.body.querySelectorAll("[id]"))) {
      found[el.id] = isVisibleTextHolder(fake.page, el);
    }
    return found;
  }

  test("an element with no box paints its text only when it has display: contents", () => {
    expect(
      holders(`
        <p id="contents" data-css="display: contents">x</p>
        <p id="collapsed" data-box="0 0 100 0">x</p>
        <p id="shown" data-box="0 0 100 20">x</p>
        <p id="hidden-contents" data-css="display: contents; visibility: hidden">x</p>
        <div data-css="display: none"><p id="in-hidden" data-css="display: contents">x</p></div>`)
    ).toEqual({
      contents: true,
      collapsed: false,
      shown: true,
      "hidden-contents": false,
      "in-hidden": false,
    });
  });
});

describe("nestedClippingBoundaries", () => {
  const CLIPPER = 'data-box="0 0 60 20" data-css="overflow-x: hidden"';
  function nested(html: string, tag = "p") {
    using fake = createFakeLayoutPage(html);
    const boundary = fake.page.document.querySelector(tag);
    if (boundary === null) throw new Error(`no <${tag}>`);
    return nestedClippingBoundaries(fake.page, boundary).map((clip) => ({
      id: clip.boundary.el.id,
      widths: clip.fragments.map((fragment) => fragment.width),
    }));
  }

  test("lists each clipper in a text boundary with the lines it holds, and no other element", () => {
    const html = `<p>Intro <span id="s" ${CLIPPER}><b data-lines="0 0 200 20">long</b></span>
      <span id="plain" data-lines="0 0 30 20">tail</span></p>`;
    expect(nested(html)).toEqual([{ id: "s", widths: [200] }]);
  });

  test("text that is not shown is no line of a clipper", () => {
    const hidden = `<p><span id="s" ${CLIPPER}><b data-lines="0 0 40 20">short</b>
      <i data-css="visibility: hidden" data-lines="0 0 400 20">hidden</i></span></p>`;
    expect(nested(hidden)).toEqual([{ id: "s", widths: [40] }]);
  });

  test("an element that is no text boundary has none", () => {
    expect(
      nested(`<div><span id="s" ${CLIPPER} data-lines="0 0 200 20">long</span></div>`, "div")
    ).toEqual([]);
  });
});
