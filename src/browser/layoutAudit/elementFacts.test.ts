import { describe, expect, test } from "bun:test";
import { selectorFor, textTruncation } from "./elementFacts";
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
