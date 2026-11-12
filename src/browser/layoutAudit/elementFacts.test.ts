import { describe, expect, test } from "bun:test";
import { selectorFor, textTruncation, visiblePart } from "./elementFacts";
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

describe("visiblePart", () => {
  const LINE = { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 };

  /** `LINE` as the text of a <p> in a 50 x 10 box at 10, 5, with `css` on the box (a <div>). */
  function visibleInBox(css: string, rect = LINE) {
    using fake = createFakeLayoutPage(
      `<div data-box="10 5 50 10" data-css="${css}"><p data-box="0 0 100 20">text</p></div>`
    );
    const paragraph = fake.page.document.querySelector("p");
    if (paragraph === null) throw new Error("no <p>");
    return visiblePart(fake.page, paragraph, rect);
  }

  test("cuts a rectangle at the box of an ancestor that clips, on the axes it clips", () => {
    expect(visibleInBox("overflow-x: hidden; overflow-y: hidden")).toEqual({
      left: 10,
      top: 5,
      right: 60,
      bottom: 15,
      width: 50,
      height: 10,
    });
    expect(visibleInBox("overflow-x: clip")).toEqual({ ...LINE, left: 10, right: 60, width: 50 });
    expect(visibleInBox("overflow-y: hidden")).toEqual({ ...LINE, top: 5, bottom: 15, height: 10 });
  });

  test("leaves a rectangle whole when no box clips it: a scroller shows it by scrolling", () => {
    expect(visibleInBox("")).toEqual(LINE);
    expect(visibleInBox("overflow-y: auto")).toEqual(LINE);
  });

  test("cuts at the padding box: a border is not room for text", () => {
    const bordered = "overflow-x: hidden; border-left-width: 4px; border-right-width: 6px";
    expect(visibleInBox(bordered)).toEqual({ ...LINE, left: 14, right: 54, width: 40 });
  });

  test("returns null when nothing is left, a rectangle that only touches the box included", () => {
    const hidden = "overflow-x: hidden; overflow-y: hidden";
    expect(visibleInBox(hidden, { ...LINE, left: 60, right: 160 })).toBeNull();
    expect(visibleInBox(hidden, { ...LINE, top: 15, bottom: 35 })).toBeNull();
    expect(visibleInBox(hidden, { ...LINE, left: 59, right: 160 })).not.toBeNull();
  });

  test("an element's own clipping box cuts its text too", () => {
    using fake = createFakeLayoutPage(
      '<p data-box="10 5 50 10" data-css="overflow-x: hidden">text</p>'
    );
    const paragraph = fake.page.document.querySelector("p");
    if (paragraph === null) throw new Error("no <p>");
    expect(visiblePart(fake.page, paragraph, LINE)).toEqual({
      ...LINE,
      left: 10,
      right: 60,
      width: 50,
    });
  });
});
