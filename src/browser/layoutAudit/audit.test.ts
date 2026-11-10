import { describe, expect, test } from "bun:test";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { auditLayout } from "./audit";
import { createFakeLayoutPage, type FakeLayoutPageOptions } from "./fakeLayoutPage.testHarness";

type Rule = LayoutAuditPageFinding["rule"];
type Axis = LayoutAuditPageFinding["axis"];

// An element with no id is named from <html> down.
const TOP_P = "html > body > p";
const TOP_BUTTON = "html > body > button";

const finding = (rule: Rule, selector: string, axis: Axis, overflowPx: number) => ({
  rule,
  selector,
  axis,
  overflowPx,
});

/** A phone: 390 x 844 with a page 900 px tall, unless the test says otherwise. */
function audit(html: string, options: FakeLayoutPageOptions = {}): LayoutAuditPageFinding[] {
  const viewport = { width: 390, height: 844, scrollHeight: 900, ...options.viewport };
  using fake = createFakeLayoutPage(html, { ...options, viewport });
  return auditLayout(fake.page);
}

describe("clipped-text", () => {
  const CLIPPED_CARD = `
    <div id="card" data-box="0 0 200 22" data-css="overflow-y: hidden">
      <p data-box="0 0 200 60" data-lines="0 0 180 20; 0 24 150 20">Two lines of text</p>
    </div>`;

  test("a line below a box that clips is reported on the box that clips", () => {
    expect(audit(CLIPPED_CARD)).toEqual([finding("clipped-text", "div#card", "vertical", 22)]);
  });

  test("a label wider than its own clipping box is reported on the label", () => {
    const html = `<button id="buy" data-box="0 0 100 30" data-css="overflow-x: hidden; white-space: nowrap"
      data-lines="10 5 180 20">Buy it now please</button>`;
    expect(audit(html)).toEqual([finding("clipped-text", "button#buy", "horizontal", 90)]);
  });

  test("text inside a paragraph is judged with the paragraph, not on its own", () => {
    const html = `<p data-box="0 0 100 20" data-css="overflow-x: hidden"><span id="s" data-box="0 0 100 20"
      data-css="overflow-x: hidden" data-lines="0 0 200 20">Clipped span text</span></p>`;
    expect(audit(html)).toEqual([finding("clipped-text", TOP_P, "horizontal", 100)]);
  });

  test("a failing container is reported once, not again for what it holds", () => {
    // p#b is clipped by its own box too (22 px, a tie with the card), so without the outermost-root
    // rule it would be a second finding of its own.
    const html = `
      <div id="outer" data-box="0 0 200 22" data-css="overflow-y: hidden">
        <p id="a" data-box="0 0 200 60" data-lines="0 0 180 20; 0 24 150 20">First paragraph</p>
        <p id="b" data-box="0 0 200 22" data-css="overflow-y: hidden"
          data-lines="0 0 180 20; 0 24 150 20">Second paragraph</p>
      </div>`;
    expect(audit(html)).toEqual([finding("clipped-text", "div#outer", "vertical", 22)]);
    expect(audit(html.replace('id="outer"', 'id="outer" data-css="overflow-y: visible"'))).toEqual([
      finding("clipped-text", "p#b", "vertical", 22),
    ]);
  });

  test("an ancestor takes the blame from a nearer clip only by clipping more", () => {
    const nested = (outerHeight: number) => `
      <div id="outer" data-box="0 0 200 ${outerHeight}" data-css="overflow-y: hidden">
        <div id="inner" data-box="0 0 200 30" data-css="overflow-y: hidden">
          <p data-box="0 0 200 60" data-lines="0 24 150 20">A late line of text</p>
        </div>
      </div>`;
    // The line is 24-44 px, centered at 34. Outer 10 px: 34 px lost, inner 30 px: 14 px lost.
    expect(audit(nested(10))).toEqual([finding("clipped-text", "div#outer", "vertical", 34)]);
    // Outer 40 px keeps the line's center, so only the inner clip fails.
    expect(audit(nested(40))).toEqual([finding("clipped-text", "div#inner", "vertical", 14)]);
  });

  const TEXT = (css: string, box = "0 0 100 20") =>
    `<p id="t" data-box="${box}" data-css="overflow-x: hidden${css}" data-lines="0 0 200 20">Some clipped text</p>`;
  const BASE = [finding("clipped-text", "p#t", "horizontal", 100)];

  test("the plain case this section's skips are measured against is a failure", () => {
    expect(audit(TEXT(""))).toEqual(BASE);
  });

  test.each([
    ["ellipsis", "; text-overflow: ellipsis"],
    ["line-clamp", "; webkit-line-clamp: 2"],
    ["a mask image", "; mask-image: linear-gradient(black, transparent)"],
    ["a clip-path", "; clip-path: inset(0)"],
    ["rounded corners with overflow hidden", "; border-top-left-radius: 8px"],
    ["display none", "; display: none"],
    ["visibility hidden", "; visibility: hidden"],
    ["content-visibility hidden", "; content-visibility: hidden"],
    ["opacity 0.01", "; opacity: 0.01"],
  ])("text with %s is never reported", (_name, css) => {
    expect(audit(TEXT(css))).toEqual([]);
  });

  test("opacity 0.02 is still shown, so it is still judged", () => {
    expect(audit(TEXT("; opacity: 0.02"))).toEqual(BASE);
  });

  test("text under a hidden ancestor is never reported", () => {
    expect(audit(`<div data-box="0 0 100 20" data-css="display: none">${TEXT("")}</div>`)).toEqual(
      []
    );
  });

  test("diagram surfaces are outside the audit", () => {
    expect(audit(`<div class="mermaid">${TEXT("")}</div>`)).toEqual([]);
    const svg = `<svg><text id="t" data-box="0 0 100 20" data-css="overflow-x: hidden"
      data-lines="0 0 200 20">Label</text></svg>`;
    expect(audit(svg)).toEqual([]);
    expect(audit(svg.replace("svg", "div").replace("/svg", "/div"))).toHaveLength(1);
  });

  const HIDDEN = (css: string, box: string) =>
    `<p id="t" data-box="${box}" data-css="overflow-x: hidden; ${css}" data-lines="0 0 200 20">Skip to content</p>`;

  test("standard screen-reader-only text is never reported", () => {
    expect(audit(HIDDEN("position: absolute; white-space: nowrap", "0 0 1 1"))).toEqual([]);
    expect(audit(HIDDEN("position: absolute; clip: rect(0px, 0px, 0px, 0px)", "0 0 1 1"))).toEqual(
      []
    );
    expect(audit(HIDDEN("position: fixed; white-space: nowrap", "0 0 2 2"))).toEqual([]);
  });

  test("a look-alike is judged: too big, not positioned, or with nothing hiding the clip", () => {
    const count = (css: string, box: string) => audit(HIDDEN(css, box)).length;
    expect(count("position: absolute; white-space: nowrap", "0 0 3 3")).toBe(1);
    expect(count("position: static; white-space: nowrap", "0 0 1 1")).toBe(1);
    expect(count("position: absolute", "0 0 1 1")).toBe(1);
  });

  test("anything near a running animation is left alone, nearer or farther", () => {
    expect(audit(TEXT("").replace("<p ", "<p data-animated "))).toEqual([]);
    expect(audit(`<div data-animated>${TEXT("")}</div>`)).toEqual([]);
    expect(audit(TEXT("").replace(">Some", "><i data-animated></i>Some"))).toEqual([]);
  });
});

describe("clipped-control", () => {
  const IN_BAR = (button: string, barCss = "overflow-x: hidden") =>
    `<div id="bar" data-box="0 0 200 40" data-css="${barCss}">${button}</div>`;

  test("a control that sticks out of a clipping ancestor is reported on the ancestor", () => {
    const html = IN_BAR('<button data-box="150 5 100 30">Buy</button>');
    expect(audit(html)).toEqual([finding("clipped-control", "div#bar", "horizontal", 50)]);
  });

  test("an escape of 3 px is tolerated, 4 px is a failure", () => {
    // A 20 px control: 3 px out is 15%, 4 px out is 20%, the least that counts.
    expect(audit(IN_BAR('<button data-box="183 5 20 30">Go</button>'))).toEqual([]);
    expect(audit(IN_BAR('<button data-box="184 5 20 30">Go</button>'))).toEqual([
      finding("clipped-control", "div#bar", "horizontal", 4),
    ]);
  });

  test.each([
    ["disabled", '<button disabled data-box="150 5 100 30">Buy</button>'],
    ["a link without an href", '<a data-box="150 5 100 30">Buy</a>'],
    ["a role that is not a control", '<div role="presentation" data-box="150 5 100 30">Buy</div>'],
    ["hidden", '<button data-css="display: none" data-box="150 5 100 30">Buy</button>'],
    ["animated", '<button data-animated data-box="150 5 100 30">Buy</button>'],
  ])("a %s element is not a required control", (_name, button) => {
    expect(audit(IN_BAR(button))).toEqual([]);
  });

  test("a link with an href, and an ARIA button, are controls", () => {
    const link = IN_BAR('<a href="#x" data-box="150 5 100 30">Buy</a>');
    expect(audit(link)).toHaveLength(1);
    const aria = IN_BAR('<div role="button" data-box="150 5 100 30">Buy</div>');
    expect(audit(aria)).toHaveLength(1);
    const otherRole = IN_BAR('<button role="menuitem" data-box="150 5 100 30">Buy</button>');
    expect(audit(otherRole)).toEqual([]);
  });

  test("a rounded or masked clipping ancestor is cutting on purpose", () => {
    const button = '<button data-box="150 5 100 30">Buy</button>';
    expect(audit(IN_BAR(button, "overflow-x: hidden; border-top-left-radius: 12px"))).toEqual([]);
    expect(audit(IN_BAR(button, "overflow-x: hidden; clip-path: inset(0)"))).toEqual([]);
  });

  test("text under a clipped control's ancestor is not reported a second time", () => {
    const html = IN_BAR(`<button data-box="150 5 100 30">Buy</button>
      <p data-box="0 0 300 20" data-lines="0 0 300 20">A long paragraph of text here</p>`);
    expect(audit(html)).toEqual([finding("clipped-control", "div#bar", "horizontal", 50)]);
    const withoutControl = IN_BAR(
      '<p data-box="0 0 300 20" data-lines="0 0 300 20">A long paragraph of text here</p>'
    );
    expect(audit(withoutControl)).toEqual([finding("clipped-text", "div#bar", "horizontal", 100)]);
  });
});

describe("viewport-unreachable-control", () => {
  test("a control off the left edge is reported", () => {
    const html = '<button id="b" data-box="-60 10 100 30">Menu</button>';
    expect(audit(html)).toEqual([
      finding("viewport-unreachable-control", "button#b", "horizontal", 60),
    ]);
  });

  test("off the left by 3 px is tolerated, 4 px is a failure", () => {
    expect(audit('<button data-box="-3 10 20 30">Go</button>')).toEqual([]);
    expect(audit('<button data-box="-4 10 20 30">Go</button>')).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "horizontal", 4),
    ]);
  });

  test("a horizontal scroller can bring its control into view", () => {
    const html =
      '<div data-box="0 0 390 50" data-css="overflow-x: auto"><button data-box="-60 10 100 30">Menu</button></div>';
    expect(audit(html)).toEqual([]);
  });

  test("a control below the end of the page is reported, one inside it is not", () => {
    const button = '<button data-box="10 1000 100 40">Buy</button>';
    expect(audit(button)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 140),
    ]);
    expect(audit(button, { viewport: { width: 390, height: 844, scrollHeight: 2000 } })).toEqual(
      []
    );
  });

  test("the page's scroll position moves the control down the page", () => {
    const button = '<button data-box="10 500 100 40">Buy</button>';
    expect(audit(button)).toEqual([]);
    expect(audit(button, { viewport: { width: 390, height: 844, scrollY: 500 } })).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 140),
    ]);
  });

  test("a fixed or sticky control must fit the viewport, however long the page", () => {
    const tall = { viewport: { width: 390, height: 844, scrollHeight: 5000 } };
    for (const position of ["fixed", "sticky"]) {
      const button = `<button data-css="position: ${position}" data-box="10 900 100 40">Buy</button>`;
      expect(audit(button, tall)).toEqual([
        finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 96),
      ]);
    }
    expect(audit('<button data-box="10 900 100 40">Buy</button>', tall)).toEqual([]);
  });

  test("when the page cannot scroll, a control must fit the viewport unless a scroller holds it", () => {
    const tall = { viewport: { width: 390, height: 844, scrollHeight: 5000 } };
    const button = '<button data-box="10 900 100 40">Buy</button>';
    function locked(html: string) {
      using fake = createFakeLayoutPage(html, tall);
      fake.page.document.documentElement.setAttribute("data-css", "overflow-y: hidden");
      return auditLayout(fake.page);
    }
    expect(locked(button)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 96),
    ]);
    const held = `<div id="pane" data-box="0 0 390 800" data-css="overflow-y: auto">${button}</div>`;
    expect(locked(held)).toEqual([]);
    const offScreenPane = held.replace("0 0 390 800", "0 -900 390 800");
    expect(locked(offScreenPane)).toEqual([
      finding("viewport-unreachable-control", "div#pane > button", "vertical", 96),
    ]);
  });
});

describe("viewport-unreachable-content", () => {
  const TEXT = (left: number, css = "") =>
    `<p data-box="${left} 0 100 20" data-css="${css}" data-lines="${left} 0 100 20">Text off the left</p>`;

  test("text past the left edge is reported, rounded to a tenth of a pixel", () => {
    expect(audit(TEXT(-80))).toEqual([
      finding("viewport-unreachable-content", TOP_P, "horizontal", 80),
    ]);
    expect(audit(TEXT(-80.26))).toEqual([
      finding("viewport-unreachable-content", TOP_P, "horizontal", 80.3),
    ]);
  });

  test("the text must be at least 24 px out: 23 px is tolerated, 24 px is a failure", () => {
    expect(audit(TEXT(-23))).toEqual([]);
    expect(audit(TEXT(-24))).toEqual([
      finding("viewport-unreachable-content", TOP_P, "horizontal", 24),
    ]);
  });

  test.each([
    [
      "in a horizontal scroller",
      (html: string) => `<div data-box="0 0 390 50" data-css="overflow-x: auto">${html}</div>`,
    ],
    [
      "that is positioned",
      (html: string) => html.replace('data-css=""', 'data-css="position: absolute"'),
    ],
    ["that is animated", (html: string) => html.replace("<p ", "<p data-animated ")],
    ["in a diagram", (html: string) => `<div class="mermaid">${html}</div>`],
  ])("text %s is not reported", (_name, wrap) => {
    expect(audit(wrap(TEXT(-80)))).toEqual([]);
  });
});

describe("page-horizontal-overflow", () => {
  const WIDE_TEXT = '<p data-box="0 0 642 20" data-lines="0 0 642 20">Wide text content</p>';
  const wide = (scrollWidth: number) => ({ viewport: { width: 390, height: 844, scrollWidth } });

  test("a wide document with text past the edge is reported once, on html", () => {
    expect(audit(WIDE_TEXT, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
  });

  test("a control past the edge is evidence too", () => {
    const html = '<button data-box="300 0 342 30">Wide</button>';
    expect(audit(html, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
  });

  test("at 390 px a document 23 px too wide is cosmetic, 24 px is a failure", () => {
    expect(audit(WIDE_TEXT, wide(413))).toEqual([]);
    expect(audit(WIDE_TEXT, wide(414))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 24),
    ]);
  });

  test("a scroll width with no content past the edge is not a failure", () => {
    expect(audit('<div data-box="0 0 642 20"></div>', wide(642))).toEqual([]);
    expect(
      audit('<p data-box="0 0 300 20" data-lines="0 0 300 20">Text that fits</p>', wide(642))
    ).toEqual([]);
  });

  test.each([
    ["positioned", WIDE_TEXT.replace("<p ", '<p data-css="position: absolute" ')],
    [
      "in a horizontal scroller",
      `<div data-box="0 0 390 50" data-css="overflow-x: auto">${WIDE_TEXT}</div>`,
    ],
    ["animated", WIDE_TEXT.replace("<p ", "<p data-animated ")],
    ["a diagram", `<div class="mermaid">${WIDE_TEXT}</div>`],
  ])("text that is %s is not evidence", (_name, html) => {
    expect(audit(html, wide(642))).toEqual([]);
  });
});

describe("overlapping-text", () => {
  const STAGE = (cover: string, text = "Hello world text", textAttrs = "") =>
    `<div id="stage"><p id="t" ${textAttrs} data-box="10 10 200 20" data-lines="10 10 200 20">${text}</p>${cover}</div>`;
  const COVER = (css = "background-color: rgb(255, 255, 255)", extra = "") =>
    `<div id="cover" ${extra} data-box="0 0 300 60" data-css="${css}" data-z="1"></div>`;
  const COVERED = [finding("overlapping-text", "p#t", "horizontal", 0)];

  test("text under one opaque sibling is reported", () => {
    expect(audit(STAGE(COVER()))).toEqual(COVERED);
  });

  test("a transparent overlay is decoration, not a cover", () => {
    expect(audit(STAGE(COVER("background-color: rgba(0, 0, 0, 0)")))).toEqual([]);
  });

  test("a cover must be at least 95% opaque: 0.94 is tolerated, 0.95 is a failure", () => {
    expect(audit(STAGE(COVER("background-color: rgba(255, 255, 255, 0.94)")))).toEqual([]);
    expect(audit(STAGE(COVER("background-color: rgba(255, 255, 255, 0.95)")))).toEqual(COVERED);
    expect(audit(STAGE(COVER("background-color: rgb(255, 255, 255); opacity: 0.94")))).toEqual([]);
    expect(audit(STAGE(COVER("background-color: rgb(255, 255, 255); opacity: 0.95")))).toEqual(
      COVERED
    );
  });

  test("90% of the sample points must be covered: 6 of 9 and 8 of 9 are not enough, 9 of 9 is", () => {
    const partial = COVER().replace("0 0 300 60", "0 0 160 60");
    expect(audit(STAGE(partial))).toEqual([]);
    // A small transparent element on top takes one of the nine points away from the cover.
    const spot = '<div id="spot" data-box="168 24 4 4" data-z="2"></div>';
    expect(audit(STAGE(COVER() + spot))).toEqual([]);
    expect(audit(STAGE(COVER()))).toEqual(COVERED);
  });

  test("an ancestor around the text is not a cover", () => {
    const html = `<div id="stage"><div id="cover" data-box="0 0 300 60" data-z="1"
      data-css="background-color: rgb(255, 255, 255)"><p id="t" data-box="10 10 200 20"
      data-lines="10 10 200 20">Hello world text</p></div></div>`;
    expect(audit(html)).toEqual([]);
  });

  test("short text is skipped, a short control label is not", () => {
    expect(audit(STAGE(COVER(), "Hi"))).toEqual([]);
    const button = `<div id="stage"><button id="go" data-box="10 10 200 20" data-lines="10 10 200 20">Go</button>${COVER()}</div>`;
    expect(audit(button)).toEqual([finding("overlapping-text", "button#go", "horizontal", 0)]);
  });

  test("a line smaller than 16 square px is not sampled", () => {
    const tiny = STAGE(COVER()).replace('data-lines="10 10 200 20"', 'data-lines="10 10 3 5"');
    expect(audit(tiny)).toEqual([]);
  });

  test("positioned text overlaps on purpose, and motion makes the sample unreliable", () => {
    expect(audit(STAGE(COVER(), "Hello world text", 'data-css="position: relative"'))).toEqual([]);
    expect(audit(STAGE(COVER("background-color: rgb(255, 255, 255)", "data-animated")))).toEqual(
      []
    );
    expect(audit(STAGE(COVER(), "Hello world text", "data-animated"))).toEqual([]);
  });
});

describe("limits", () => {
  const FILLER = (count: number) => "<i></i>".repeat(count);
  const BROKEN = '<button data-box="-60 10 100 30">Menu</button>';

  test("only the first 800 elements are audited", () => {
    expect(audit(FILLER(799) + BROKEN)).toHaveLength(1);
    expect(audit(FILLER(800) + BROKEN)).toEqual([]);
  });

  test("only the first 200 candidates are sampled for overlap", () => {
    const candidate = '<p data-box="0 0 10 10">Filler text</p>';
    const covered = `<p id="t" data-box="10 10 200 20" data-lines="10 10 200 20">Hello world text</p>
      <div data-box="0 0 300 60" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div>`;
    expect(audit(candidate.repeat(199) + covered)).toHaveLength(1);
    expect(audit(candidate.repeat(200) + covered)).toEqual([]);
  });
});

describe("one finding per failure", () => {
  test("the same rule, element and axis is reported once", () => {
    // Two lines of one label both sit left of the edge: still a single finding for the element.
    const html = `<p data-box="-80 0 100 40" data-lines="-80 0 100 20; -70 20 100 20">Two wrapped lines</p>`;
    expect(audit(html)).toEqual([finding("viewport-unreachable-content", TOP_P, "horizontal", 80)]);
  });
});
