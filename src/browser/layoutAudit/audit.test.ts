import { describe, expect, test } from "bun:test";
import { LAYOUT_AUDIT_THRESHOLDS } from "@/common/constants/artifactLayoutAudit";
import type { LayoutAuditPageFinding } from "@/common/types/artifactLayoutAudit";
import { auditLayout } from "./audit";
import {
  createFakeLayoutPage,
  type FakeLayoutPage,
  type FakeLayoutPageOptions,
} from "./fakeLayoutPage.testHarness";
import type { LayoutPage } from "./layoutPage";

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

/** `audit` for text directly in <body>: the fake reads the body's box and lines from attributes. */
function auditBodyText(
  attributes: { box: string; lines: string; css?: string },
  options: FakeLayoutPageOptions = {}
): LayoutAuditPageFinding[] {
  const viewport = { width: 390, height: 844, ...options.viewport };
  using fake = createFakeLayoutPage("averylongunbreakableword", { ...options, viewport });
  const { body } = fake.page.document;
  body.setAttribute("data-box", attributes.box);
  body.setAttribute("data-lines", attributes.lines);
  if (attributes.css !== undefined) body.setAttribute("data-css", attributes.css);
  return auditLayout(fake.page);
}

/**
 * `audit` for a page 3000 px tall, with the scrolls the audit made. `prepare` changes the fake
 * page before the audit (a locked root, say).
 */
function auditScrolling(
  html: string,
  options: FakeLayoutPageOptions = {},
  prepare: (fake: FakeLayoutPage) => void = () => undefined
) {
  const viewport = { width: 390, height: 844, scrollHeight: 3000, ...options.viewport };
  using fake = createFakeLayoutPage(html, { ...options, viewport });
  prepare(fake);
  const findings = auditLayout(fake.page);
  return { findings, scrolls: fake.calls.filter((call) => call.startsWith("scrollTo")) };
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

  describe("a clipper inside a paragraph", () => {
    // The paragraph is wide; the span inside it is not.
    const NESTED = (spanCss: string, spanBox = "0 0 60 20", paragraphCss = "") =>
      `<p id="p" data-box="0 0 300 20" data-css="${paragraphCss}">Intro <span id="s" data-box="${spanBox}"
        data-css="${spanCss}" data-lines="0 0 200 20">A long clipped text</span></p>`;
    const CLIPPING = "overflow-x: hidden; white-space: nowrap";

    test("is reported on the clipper: the paragraph's own box does not cut its text", () => {
      expect(audit(NESTED(CLIPPING))).toEqual([
        finding("clipped-text", "span#s", "horizontal", 140),
      ]);
    });

    test("hidden text inside the clipper is no evidence of a cut", () => {
      // A Range measures `visibility: hidden` text too: the long hidden line would read as cut.
      const html = `<p id="p" data-box="0 0 300 20"><span id="s" data-box="0 0 60 20" data-css="overflow-x: hidden"><span id="shown" data-box="0 0 40 20" data-lines="0 0 40 20">Short</span>
        <span id="hidden" data-box="0 0 400 20" data-css="visibility: hidden" data-lines="0 0 400 20">A long line nobody sees</span></span></p>`;
      expect(audit(html)).toEqual([]);
      // The same line shown is cut.
      expect(audit(html.replace("visibility: hidden", "visibility: visible"))).toEqual([
        finding("clipped-text", "span#s", "horizontal", 340),
      ]);
      // A holder with no box of its own (`display: contents`) still paints its text.
      const contents = html.replace(
        'data-box="0 0 400 20" data-css="visibility: hidden"',
        'data-box="0 0 0 0" data-css="display: contents"'
      );
      expect(audit(contents)).toEqual([finding("clipped-text", "span#s", "horizontal", 340)]);
      // Such a holder ignores opacity and content-visibility: its text still paints, and is cut.
      for (const css of [
        "display: contents; opacity: 0",
        "display: contents; content-visibility: hidden",
      ]) {
        expect(
          audit(contents.replace('data-css="display: contents"', `data-css="${css}"`))
        ).toEqual([finding("clipped-text", "span#s", "horizontal", 340)]);
      }
      // A collapsed holder does not paint either, whatever else it sets.
      for (const css of [
        "visibility: collapse",
        "display: contents; opacity: 0; visibility: collapse",
      ]) {
        expect(audit(html.replace('data-css="visibility: hidden"', `data-css="${css}"`))).toEqual(
          []
        );
      }
      // A wrapper without a box ignores its own opacity: the text it holds paints, and is cut.
      const contentsWrapped = html
        .replace(
          '<span id="hidden" data-box="0 0 400 20" data-css="visibility: hidden"',
          '<span id="wrap" data-box="0 0 0 0" data-css="display: contents; opacity: 0"><span id="hidden" data-box="0 0 400 20"'
        )
        .replace("A long line nobody sees</span>", "A long line nobody sees</span></span>");
      expect(audit(contentsWrapped)).toEqual([
        finding("clipped-text", "span#s", "horizontal", 340),
      ]);
      // Text under a transparent or content-visibility hidden wrapper does not paint.
      for (const css of ["opacity: 0", "content-visibility: hidden"]) {
        const wrapped = html
          .replace(
            '<span id="hidden" data-box="0 0 400 20" data-css="visibility: hidden"',
            `<span id="wrap" data-box="0 0 400 20" data-css="${css}"><span id="hidden" data-box="0 0 400 20"`
          )
          .replace("A long line nobody sees</span>", "A long line nobody sees</span></span>");
        expect(audit(wrapped)).toEqual([]);
      }
    });

    test("is judged on the lines it holds, down to a clipper inside a clipper", () => {
      const html = `<p id="p" data-box="0 0 300 20"><span id="outer" data-box="0 0 60 20" data-css="overflow-x: hidden">
        <span id="inner" data-box="0 0 300 20" data-css="overflow-x: hidden" data-lines="0 0 200 20">Clipped text</span></span></p>`;
      expect(audit(html)).toEqual([finding("clipped-text", "span#outer", "horizontal", 140)]);
    });

    test("takes the blame from the paragraph's box and its clipping ancestors only by clipping more", () => {
      const inCard = (cardWidth: number, spanWidth: number) =>
        `<div id="card" data-box="0 0 ${cardWidth} 20" data-css="overflow-x: hidden">${NESTED(CLIPPING, `0 0 ${spanWidth} 20`)}</div>`;
      // The line ends at 200: the span at 60 loses 140 px, the card at 150 loses 50.
      expect(audit(inCard(150, 60))).toEqual([
        finding("clipped-text", "span#s", "horizontal", 140),
      ]);
      expect(audit(inCard(150, 180))).toEqual([
        finding("clipped-text", "div#card", "horizontal", 50),
      ]);
      // A paragraph that clips as much as the span keeps the blame: a tie keeps the first.
      expect(
        audit(
          NESTED(CLIPPING, "0 0 100 20", "overflow-x: hidden").replace(
            'data-box="0 0 300 20"',
            'data-box="0 0 100 20"'
          )
        )
      ).toEqual([finding("clipped-text", "p#p", "horizontal", 100)]);
    });

    test.each([
      ["ellipsis", "; text-overflow: ellipsis"],
      ["a line clamp", "; webkit-line-clamp: 2"],
      ["a mask image", "; mask-image: linear-gradient(black, transparent)"],
      ["rounded corners", "; border-top-left-radius: 8px"],
      ["visibility hidden", "; visibility: hidden"],
      ["display none", "; display: none"],
      ["a running animation", ""],
    ])("with %s is the author's cut, not a failure", (name, css) => {
      const html = NESTED(CLIPPING + css);
      expect(
        audit(
          name === "a running animation" ? html.replace("<span ", "<span data-animated ") : html
        )
      ).toEqual([]);
    });

    test("that clips only the other axis, or only scrolls, cuts nothing", () => {
      expect(audit(NESTED("overflow-y: hidden"))).toEqual([]);
      expect(audit(NESTED("overflow-x: auto"))).toEqual([]);
    });

    // The text of an element that no rule judges is no evidence of a cut, whichever box holds it.
    test("that is itself screen-reader-only text is never reported", () => {
      const hidden = "position: absolute; overflow-x: hidden; white-space: nowrap";
      expect(audit(NESTED(hidden, "0 0 1 1"))).toEqual([]);
    });

    test("that holds screen-reader-only text is not reported for it", () => {
      const html = `<p data-box="0 0 300 20"><span id="s" data-box="0 0 60 20" data-css="overflow-x: hidden">
        <i data-box="0 0 1 1" data-css="position: absolute; overflow-x: hidden; white-space: nowrap"
        data-lines="0 0 200 20">Hidden label</i></span></p>`;
      expect(audit(html)).toEqual([]);
    });

    test("that holds a diagram's label is not reported for it", () => {
      const diagram = `<p data-box="0 0 300 20"><span id="s" data-box="0 0 60 20" data-css="overflow-x: hidden"><svg>
        <text data-box="0 0 200 20" data-lines="0 0 200 20">Diagram label</text></svg></span></p>`;
      expect(audit(diagram)).toEqual([]);
    });

    test("is not judged for the text of an element that is no text boundary", () => {
      // A div reads only its own text, so the span is its own element: still reported, once.
      const html = `<div id="d" data-box="0 0 300 20"><span id="s" data-box="0 0 60 20" data-css="overflow-x: hidden"
        data-lines="0 0 200 20">A long clipped text</span></div>`;
      expect(audit(html)).toEqual([finding("clipped-text", "span#s", "horizontal", 140)]);
    });
  });

  // An ellipsis marks where a line ends: it never authorizes lines lost below a short box.
  test("an ellipsis excuses a line cut sideways, not lines lost below a short box", () => {
    const TWO_LINES = (css: string) =>
      `<p id="t" data-box="0 0 200 22" data-css="overflow-y: hidden; ${css}"
        data-lines="0 0 180 20; 0 24 150 20">Two lines of text</p>`;
    expect(audit(TWO_LINES("text-overflow: ellipsis"))).toEqual([
      finding("clipped-text", "p#t", "vertical", 22),
    ]);
    expect(audit(TWO_LINES("webkit-line-clamp: 2"))).toEqual([]);
  });

  describe("visibility", () => {
    const HIDDEN_BOX = (inner: string) =>
      `<div data-box="0 0 200 20" data-css="visibility: hidden">${inner}</div>`;

    test("a descendant that switches it back on is painted, so it is judged", () => {
      expect(audit(HIDDEN_BOX(TEXT("; visibility: visible")))).toEqual(BASE);
    });

    test("a descendant that inherits it is hidden, so it is not", () => {
      expect(audit(HIDDEN_BOX(TEXT("")))).toEqual([]);
    });
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

  test.each(["button", "textarea"])(
    "a %s that scrolls itself is not inside a scroller: its own scrolling cannot bring it back",
    (tag) => {
      const html = `<${tag} id="c" data-box="-60 10 100 30" data-css="overflow-x: auto">Menu</${tag}>`;
      expect(audit(html)).toEqual([
        finding("viewport-unreachable-control", `${tag}#c`, "horizontal", 60),
      ]);
    }
  );

  test("a control off the left edge is reported through a scroller that is not above it", () => {
    const html =
      '<div data-box="0 0 390 50" data-css="overflow-x: auto"></div><button data-box="-60 10 100 30">Menu</button>';
    expect(audit(html)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "horizontal", 60),
    ]);
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

  test("text directly in <body> past the left edge is reported", () => {
    const left = (x: number) => ({ box: `${x} 0 100 20`, lines: `${x} 0 100 20` });
    expect(auditBodyText(left(-80))).toEqual([
      finding("viewport-unreachable-content", "html > body", "horizontal", 80),
    ]);
    expect(auditBodyText(left(-23))).toEqual([]);
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
    [
      "of a scroller itself",
      (html: string) => html.replace('data-css=""', 'data-css="overflow-x: auto"'),
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

  test("a control past the edge is evidence even when it scrolls itself (a textarea does)", () => {
    const html = '<textarea data-box="300 0 342 30" data-css="overflow-x: auto"></textarea>';
    expect(audit(html, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
    const held = `<div data-box="0 0 390 50" data-css="overflow-x: auto">${html}</div>`;
    expect(audit(held, wide(642))).toEqual([]);
  });

  test("text directly in <body> past the edge is evidence", () => {
    const wideBody = { box: "0 0 642 20", lines: "0 0 642 20" };
    expect(auditBodyText(wideBody, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
    expect(auditBodyText({ box: "0 0 390 20", lines: "0 0 300 20" }, wide(642))).toEqual([]);
    expect(auditBodyText(wideBody, wide(413))).toEqual([]);
  });

  test("a scrolling <body> is not a scroller that holds its own text", () => {
    const body = { box: "0 0 642 20", lines: "0 0 642 20", css: "overflow-x: auto" };
    expect(auditBodyText(body, wide(642))).toEqual([
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
    [
      "in a scroller that is the text's own element",
      WIDE_TEXT.replace("<p ", '<p data-css="overflow-x: auto" '),
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

  // A computed color keeps its notation, so the alpha is read from each one the same way.
  test.each([
    "rgb(255 255 255)",
    "rgb(255 255 255 / 100%)",
    "rgb(255 255 255 / 0.95)",
    "rgba(255, 255, 255, 1)",
    "hsl(120 50% 50%)",
    "lab(50% 40 59)",
    "lab(50% 40 59 / 1)",
    "lch(50% 80 30)",
    "lch(50% 80 30 / 95%)",
    "oklab(0.6 0.1 0.1)",
    "oklab(0.6 0.1 0.1 / 0.99)",
    "oklch(0.6 0.2 250)",
    "oklch(0.6 0.2 250 / 100%)",
    "color(srgb 1 1 1)",
    "color(display-p3 1 0 0)",
    "color(display-p3 1 0 0 / 1)",
    "OKLCH(0.6 0.2 250)",
  ])("a cover colored %s is opaque", (color) => {
    expect(audit(STAGE(COVER(`background-color: ${color}`)))).toEqual(COVERED);
  });

  test.each([
    "transparent",
    "rgb(255 255 255 / 0.94)",
    "rgb(255 255 255 / 50%)",
    "rgba(255, 255, 255, 0)",
    "hsl(120 50% 50% / 0.2)",
    "lab(50% 40 59 / 0.5)",
    "lch(50% 80 30 / 0%)",
    "oklab(0.6 0.1 0.1 / 0.94)",
    "oklch(0.6 0.2 250 / 0.5)",
    "oklch(0.6 0.2 250 / none)",
    "color(srgb 1 1 1 / 0.3)",
    "color(display-p3 1 0 0 / 0)",
  ])("a cover colored %s is see-through", (color) => {
    expect(audit(STAGE(COVER(`background-color: ${color}`)))).toEqual([]);
  });

  test("a background that is no color is not a cover", () => {
    expect(audit(STAGE(COVER("background-color: not-a-color")))).toEqual([]);
  });

  test("90% of the sample points must be covered: 6 of 9 and 8 of 9 are not enough, 9 of 9 is", () => {
    const partial = COVER().replace("0 0 300 60", "0 0 160 60");
    expect(audit(STAGE(partial))).toEqual([]);
    // A small transparent element on top takes one of the nine points away from the cover.
    const spot = '<div id="spot" data-box="168 24 4 4" data-z="2"></div>';
    expect(audit(STAGE(COVER() + spot))).toEqual([]);
    expect(audit(STAGE(COVER()))).toEqual(COVERED);
  });

  test("covers add up: two panels that together hide the text are a cover, one of them alone is not", () => {
    // Text samples at x 50, 110 and 170: the left panel holds the first two columns, the right
    // panel the third. Each is under the 90% on its own.
    const left = COVER().replace("0 0 300 60", "0 0 160 60");
    const right = COVER()
      .replace('id="cover"', 'id="cover-right"')
      .replace("0 0 300 60", "160 0 140 60");
    expect(audit(STAGE(left + right))).toEqual(COVERED);
    expect(audit(STAGE(left))).toEqual([]);
    expect(audit(STAGE(right))).toEqual([]);
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

  // A line clamp or a short `overflow: hidden` box cuts lines away, but `Range.getClientRects()`
  // still reports a rectangle for each. Two lines show and twenty do not; an opaque block starts
  // right under the two, so the twenty clipped lines (91% of the sample points) sit under it.
  describe("lines that a box clips away", () => {
    const LINES = (count: number, width = 200) =>
      Array.from({ length: count }, (_, i) => `10 ${10 + i * 20} ${width} 20`).join("; ");
    // The clamp keeps the clipped-text rule quiet: this is about what the overlap rule samples.
    const TEXT = (box: string, css: string, lines: string) =>
      `<p id="t" data-box="${box}" data-css="${css}; webkit-line-clamp: 2" data-lines="${lines}">Hello world text</p>`;
    const COVER_FROM = (box: string) =>
      `<div id="cover" data-box="${box}" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div>`;
    const BELOW_TWO_LINES = COVER_FROM("0 50 300 500");

    test.each(["hidden", "clip"])("are not sampled when the text's own box clips (%s)", (value) => {
      const text = TEXT("10 10 200 40", `overflow-x: ${value}; overflow-y: ${value}`, LINES(22));
      expect(audit(`<div id="stage">${text}${BELOW_TWO_LINES}</div>`)).toEqual([]);
    });

    test("are not sampled when an ancestor does the clipping", () => {
      const text = TEXT("10 10 200 440", "overflow-y: visible", LINES(22));
      const clipper = `<div data-box="10 10 200 40" data-css="overflow-y: hidden">${text}</div>`;
      expect(audit(`<div id="stage">${clipper}${BELOW_TWO_LINES}</div>`)).toEqual([]);
    });

    test("the lines that show are still sampled: a cover over them is reported", () => {
      const text = TEXT("10 10 200 40", "overflow-y: hidden", LINES(22));
      expect(audit(`<div id="stage">${text}${COVER_FROM("0 0 300 500")}</div>`)).toEqual(COVERED);
    });

    test("only the axes that the box clips cut a line", () => {
      // Clipped across only: the lines below the box are not cut, so all of them are sampled.
      const across = TEXT("10 10 200 40", "overflow-x: clip", LINES(22));
      expect(audit(`<div id="stage">${across}${BELOW_TWO_LINES}</div>`)).toEqual(COVERED);
      // Clipped across, with lines 400 wide in a box 40 wide: the cover starts past the box.
      const wide = TEXT("10 10 40 440", "overflow-x: clip", LINES(22, 400));
      expect(audit(`<div id="stage">${wide}${COVER_FROM("60 0 600 600")}</div>`)).toEqual([]);
    });
  });

  test("positioned text overlaps on purpose, and motion makes the sample unreliable", () => {
    expect(audit(STAGE(COVER(), "Hello world text", 'data-css="position: relative"'))).toEqual([]);
    expect(audit(STAGE(COVER("background-color: rgb(255, 255, 255)", "data-animated")))).toEqual(
      []
    );
    expect(audit(STAGE(COVER(), "Hello world text", "data-animated"))).toEqual([]);
  });

  describe("a control with no text of its own", () => {
    const CONTROL = (control: string) => `<div id="stage">${control}${COVER()}</div>`;
    const BOXED = 'data-box="10 10 200 30"';

    test.each([
      ["an input with a value", `<input id="f" value="Jane Doe" ${BOXED}>`, "input#f"],
      ["a select", `<select id="f" ${BOXED}><option>One</option></select>`, "select#f"],
      ["an icon-only button", `<button id="f" ${BOXED}><svg></svg></button>`, "button#f"],
      ["a link around an image", `<a id="f" href="/x" ${BOXED}><img alt=""></a>`, "a#f"],
    ])("%s is sampled by its box, so a cover over it is reported", (_name, control, selector) => {
      expect(audit(CONTROL(control))).toEqual([
        finding("overlapping-text", selector, "horizontal", 0),
      ]);
    });

    test("a control that nothing covers, or that a cover leaves mostly free, is not reported", () => {
      expect(audit(`<input id="f" value="Jane" ${BOXED}>`)).toEqual([]);
      const partial = COVER().replace("0 0 300 60", "0 0 160 60");
      expect(audit(`<div id="stage"><input id="f" value="Jane" ${BOXED}>${partial}</div>`)).toEqual(
        []
      );
    });

    test("the same filters apply as for text: static, shown, and at least 16 square px", () => {
      const reported = (attributes: string) =>
        audit(CONTROL(`<input id="f" value="x" ${attributes}>`)).length;
      expect(reported(BOXED)).toBe(1);
      expect(reported(`${BOXED} data-css="position: relative"`)).toBe(0);
      expect(reported(`${BOXED} data-css="opacity: 0"`)).toBe(0);
      expect(reported(`${BOXED} data-animated`)).toBe(0);
      expect(reported('data-box="10 10 3 5"')).toBe(0);
    });

    // A paragraph, label or list item judges the text it holds, never a control's box.
    test.each(["label", "p", "li"])(
      "inside a %s it is sampled too: the text there is not its face",
      (tag) => {
        const html = `<div id="stage"><${tag} data-box="0 0 300 40">Name <input id="f" value="x" ${BOXED}></${tag}>${COVER()}</div>`;
        expect(audit(html)).toEqual([finding("overlapping-text", "input#f", "horizontal", 0)]);
      }
    );

    test("inside a label it is still left alone when excluded or near motion", () => {
      const inLabel = (labelAttributes: string, inputAttributes = "") =>
        `<div id="stage"><label ${labelAttributes} data-box="0 0 300 40">Name <input id="f" value="x" ${BOXED} ${inputAttributes}></label>${COVER()}</div>`;
      expect(audit(inLabel(""))).toHaveLength(1);
      expect(audit(inLabel("", "data-animated"))).toEqual([]);
      expect(audit(inLabel("data-animated"))).toEqual([]);
      expect(audit(inLabel('data-css="mask-image: linear-gradient(black, transparent)"'))).toEqual(
        []
      );
      expect(audit(inLabel('class="mermaid"'))).toEqual([]);
    });

    test("a control that has text is still left to the paragraph around it", () => {
      // Its text is in the item's lines, and a short one is no candidate there: only a control
      // with no text at all is sampled by its box inside a paragraph.
      const html = `<div id="stage"><li data-box="0 0 300 40"><textarea id="f" ${BOXED} data-lines="10 10 200 30">Go</textarea></li>${COVER()}</div>`;
      expect(audit(html)).toEqual([]);
    });

    test("an element that is no control, and a hidden or disabled control, are not sampled", () => {
      expect(audit(CONTROL(`<div id="f" ${BOXED}></div>`))).toEqual([]);
      expect(audit(CONTROL(`<input type="hidden" id="f" ${BOXED}>`))).toEqual([]);
      expect(audit(CONTROL(`<button id="f" disabled ${BOXED}></button>`))).toEqual([]);
    });
  });

  describe("text above and below the screen", () => {
    // A paragraph at `top` and an opaque sibling over it. The page is 3000 px tall.
    const AT = (top: number, id = "t") =>
      `<div id="stage-${id}"><p id="${id}" data-box="10 ${top} 200 20" data-lines="10 ${top} 200 20">Hello world text</p>
        <div data-box="0 ${top - 10} 300 60" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div></div>`;

    test("covered text a user reaches by scrolling is reported", () => {
      expect(auditScrolling(AT(1200)).findings).toEqual([
        finding("overlapping-text", "p#t", "horizontal", 0),
      ]);
    });

    test("is sampled where the point sits in the middle of the viewport, then the scroll is put back", () => {
      // The first point is at 1204: 422 px (half the viewport) below the scroll position.
      expect(auditScrolling(AT(1200)).scrolls).toEqual(["scrollTo 782", "scrollTo 0"]);
    });

    test("one scroll serves every point in the middle half of the viewport", () => {
      const near = [1000, 1030, 1060, 1090, 1120].map((top) => AT(top, `p${top}`)).join("");
      const { findings, scrolls } = auditScrolling(near);
      expect(findings).toHaveLength(5);
      expect(scrolls).toEqual(["scrollTo 582", "scrollTo 0"]);
      // A paragraph farther down needs a scroll of its own.
      expect(auditScrolling(near + AT(2000, "far")).scrolls).toEqual([
        "scrollTo 582",
        "scrollTo 1582",
        "scrollTo 0",
      ]);
    });

    test("text on the screen is sampled where it is, with no scroll", () => {
      expect(auditScrolling(AT(100)).scrolls).toEqual([]);
    });

    test("the scroll position the page started at is the one it is put back to", () => {
      // The boxes are client coordinates at scroll 500: text at 1200 is at 1700 in the document.
      const { findings, scrolls } = auditScrolling(AT(1200), {
        viewport: { width: 390, height: 844, scrollY: 500 },
      });
      expect(findings).toHaveLength(1);
      expect(scrolls).toEqual(["scrollTo 1282", "scrollTo 500"]);
    });

    test("text above the scroll position the page loaded at is sampled too, and the scroll is put back", () => {
      // The page loaded at scroll 1000 (an autofocus, a restored position): this text is at 700
      // in the document, 300 above the top of the screen.
      const { findings, scrolls } = auditScrolling(AT(-300), {
        viewport: { width: 390, height: 844, scrollY: 1000 },
      });
      expect(findings).toEqual([finding("overlapping-text", "p#t", "horizontal", 0)]);
      expect(scrolls).toEqual(["scrollTo 282", "scrollTo 1000"]);
    });

    test("text above the top of the page cannot be scrolled to, so it is not scrolled for", () => {
      const { findings, scrolls } = auditScrolling(AT(-300));
      expect(findings).toEqual([]);
      expect(scrolls).toEqual([]);
    });

    test("text at the end of the page, where the scroll stops short of the middle, is still sampled", () => {
      expect(auditScrolling(AT(2900)).findings).toHaveLength(1);
    });

    test("a point the page cannot bring on screen is skipped, not sampled where it is not", () => {
      // The page scrolls to 2156 at most: a point at 3104 would sit at 948, below the viewport.
      expect(auditScrolling(AT(3100)).findings).toEqual([]);
    });

    test("a page whose root cannot scroll shows a user none of it, so it is not scrolled", () => {
      const { findings, scrolls } = auditScrolling(AT(1200), {}, (fake) => {
        fake.page.document.body.setAttribute("data-css", "overflow-y: hidden");
      });
      expect(findings).toEqual([]);
      expect(scrolls).toEqual([]);
    });

    test("the scroll is put back when a sample throws", () => {
      using fake = createFakeLayoutPage(AT(1200), {
        viewport: { width: 390, height: 844, scrollHeight: 3000 },
      });
      const failing: LayoutPage = {
        ...fake.page,
        elementAt: () => {
          throw new Error("boom");
        },
      };
      expect(() => auditLayout(failing)).toThrow("boom");
      expect(fake.calls.filter((call) => call.startsWith("scrollTo")).at(-1)).toBe("scrollTo 0");
    });
  });
  describe("content in a scrolling panel", () => {
    const WHITE = "background-color: rgb(255, 255, 255)";
    // A panel 200 px tall at y 100, with 900 px of content. `data-scroll-height` makes the fake
    // scroll it. `extra` adds attributes (a first scroll position).
    const PANEL = (content: string, extra = "") =>
      `<div id="panel" data-box="0 100 300 200" data-css="overflow-y: auto" data-scroll-height="900" ${extra}>${content}</div>`;
    // A paragraph at `top` (the panel shows y 100 to 300, so 400 is below it, 40 is above).
    const TEXT = (top: number, id = "t") =>
      `<p id="${id}" data-box="10 ${top} 200 20" data-lines="10 ${top} 200 20">Hello world text</p>`;
    // An opaque block over the panel's box, a sibling of the panel: it does not scroll with it.
    const COVER_OVER_PANEL = `<div id="cover" data-box="0 100 300 200" data-css="${WHITE}" data-z="1"></div>`;
    const covered = [finding("overlapping-text", "p#t", "horizontal", 0)];
    const panelScrolls = (calls: string[]) =>
      calls.filter((call) => call.startsWith("scrollPanel"));
    // `auditScrolling` has the fake page 3000 px tall; this one returns every scroll it made.
    function run(
      html: string,
      prepare: (fake: FakeLayoutPage) => void = () => undefined,
      scrollY = 0
    ) {
      using fake = createFakeLayoutPage(html, {
        viewport: { width: 390, height: 844, scrollHeight: 3000, scrollY },
      });
      prepare(fake);
      return { findings: auditLayout(fake.page), calls: fake.calls };
    }

    test("a cover over what a panel hides below its edge is reported, then the panel is put back", () => {
      const { findings, calls } = run(
        `<div id="stage">${PANEL(TEXT(400))}${COVER_OVER_PANEL}</div>`
      );
      expect(findings).toEqual(covered);
      // The first point is at y 404: the panel scrolls 204 px to put it in the middle of its box.
      expect(panelScrolls(calls)).toEqual(["scrollPanel #panel 204", "scrollPanel #panel 0"]);
    });

    test("overflow-y: scroll holds its content just as auto does", () => {
      const html = `<div id="stage">${PANEL(TEXT(400))}${COVER_OVER_PANEL}</div>`;
      expect(run(html.replace("overflow-y: auto", "overflow-y: scroll")).findings).toEqual(covered);
    });

    test("a panel with no box of its own (display: contents) holds nothing: its text is sampled where it is", () => {
      const noBox = `<div id="panel" data-css="overflow-y: auto">${TEXT(150)}</div>`;
      const { findings, calls } = run(`<div id="stage">${noBox}${COVER_OVER_PANEL}</div>`);
      expect(findings).toEqual(covered);
      expect(panelScrolls(calls)).toEqual([]);
    });

    test("a page loaded scrolled still gets its panel scrolled to the right place", () => {
      // The boxes are client coordinates at scroll 500: the panel is at 600 in the document, and
      // its text is 204 px below the middle of what it shows.
      const html = `<div id="stage">${PANEL(TEXT(400))}${COVER_OVER_PANEL}</div>`;
      const { findings, calls } = run(html, () => undefined, 500);
      expect(findings).toEqual(covered);
      expect(panelScrolls(calls)).toEqual(["scrollPanel #panel 204", "scrollPanel #panel 0"]);
    });

    test("content above the part a panel shows is reached too, and the panel goes back to where it was", () => {
      // The panel loaded scrolled by 300 px: this text is above its box.
      const html = `<div id="stage">${PANEL(TEXT(40), 'data-scroll="300"')}${COVER_OVER_PANEL}</div>`;
      const { findings, calls } = run(html);
      expect(findings).toEqual(covered);
      expect(panelScrolls(calls)).toEqual(["scrollPanel #panel 144", "scrollPanel #panel 300"]);
    });

    test("nothing over the panel: the hidden text is free, and the panel is put back all the same", () => {
      const { findings, calls } = run(`<div id="stage">${PANEL(TEXT(400))}</div>`);
      expect(findings).toEqual([]);
      expect(panelScrolls(calls).at(-1)).toBe("scrollPanel #panel 0");
    });

    test("text a panel shows is sampled where it is: no panel scroll", () => {
      const { findings, calls } = run(
        `<div id="stage">${PANEL(TEXT(150))}${COVER_OVER_PANEL}</div>`
      );
      expect(findings).toEqual(covered);
      expect(panelScrolls(calls)).toEqual([]);
    });

    // The text that the panel hides is not where its rectangle says: a block that follows the
    // panel sits there. A user who scrolls the panel sees the text, free.
    test("a block after the panel does not cover text that is scrolled out of the panel", () => {
      const after = `<div id="after" data-box="0 350 300 150" data-css="${WHITE}" data-z="1"></div>`;
      const { findings } = run(`<div id="stage">${PANEL(TEXT(400))}${after}</div>`);
      expect(findings).toEqual([]);
    });

    test("a panel that cannot scroll that far leaves the point unsampled, not sampled where it lies", () => {
      // No scroll height: the panel scrolls nowhere, and the block that follows it sits at y 400.
      const after = `<div id="after" data-box="0 350 300 150" data-css="${WHITE}" data-z="1"></div>`;
      const stuck = `<div id="panel" data-box="0 100 300 200" data-css="overflow-y: auto">${TEXT(400)}</div>`;
      const { findings, calls } = run(`<div id="stage">${stuck}${after}</div>`);
      expect(findings).toEqual([]);
      expect(panelScrolls(calls)).toEqual(["scrollPanel #panel 204", "scrollPanel #panel 0"]);
    });

    // The panel is 300 px wide; the text lies at x 310, under a block beside the panel. A panel
    // that scrolls sideways could show it, and the audit scrolls panels only up and down.
    test.each([
      ["on the first screen", 100],
      ["below the fold", 1500],
    ])("text past the side of a panel (%s) is not sampled where it lies", (_where, top) => {
      const side = `<p id="t" data-box="310 ${top + 50} 70 20" data-lines="310 ${top + 50} 70 20">Hello world text</p>`;
      const box = `data-box="0 ${top} 300 200"`;
      const panel = `<div id="panel" ${box} data-css="overflow-y: auto" data-scroll-height="900">${side}</div>`;
      const cover = `<div data-box="300 ${top} 90 200" data-css="${WHITE}" data-z="1"></div>`;
      const { findings, calls } = run(`<div id="stage">${panel}${cover}</div>`);
      expect(findings).toEqual([]);
      expect(panelScrolls(calls)).toEqual([]);
    });

    test("a panel scrolls even when the page cannot: its content is still there to reach", () => {
      const { findings, calls } = run(
        `<div id="stage">${PANEL(TEXT(400))}${COVER_OVER_PANEL}</div>`,
        (fake) => fake.page.document.body.setAttribute("data-css", "overflow-y: hidden")
      );
      expect(findings).toEqual(covered);
      expect(calls.filter((call) => call.startsWith("scrollTo"))).toEqual([]);
    });

    describe("a panel below the fold", () => {
      // The panel is at y 1500, 600 px below the first screen of an 844 px viewport.
      const LOW_PANEL = (content: string) =>
        `<div id="panel" data-box="0 1500 300 200" data-css="overflow-y: auto" data-scroll-height="900">${content}</div>`;
      const LOW_COVER = `<div id="cover" data-box="0 1500 300 200" data-css="${WHITE}" data-z="1"></div>`;

      test("text that shows in it needs only the page scroll: the panel stays", () => {
        const { findings, calls } = run(
          `<div id="stage">${LOW_PANEL(TEXT(1550))}${LOW_COVER}</div>`
        );
        expect(findings).toEqual(covered);
        expect(panelScrolls(calls)).toEqual([]);
      });

      test("is scrolled first, then the window shows it, and both go back (the panel first)", () => {
        const html = `<div id="stage">${LOW_PANEL(TEXT(2000))}${LOW_COVER}</div>`;
        const { findings, calls } = run(html);
        expect(findings).toEqual(covered);
        // The first point is at y 2004, 504 px under the middle of the panel's box (1600).
        expect(calls.filter((call) => /^scroll(Panel|To)/.test(call))).toEqual([
          "scrollPanel #panel 404",
          "scrollTo 1178",
          "scrollPanel #panel 0",
          "scrollTo 0",
        ]);
      });
    });

    describe("a panel inside a panel", () => {
      // The inner panel sits at y 800 in the content of the outer one, which shows y 100 to 400:
      // the inner panel is out of sight until the outer one scrolls.
      const INNER = (content: string, atY = 800) =>
        `<div id="inner" data-box="0 ${atY} 300 200" data-css="overflow-y: auto" data-scroll-height="1500">${content}</div>`;
      const OUTER = (content: string) =>
        `<div id="outer" data-box="0 100 300 300" data-css="overflow-y: auto" data-scroll-height="2000">${content}</div>`;
      const COVER_OVER_INNER = (atY = 800) =>
        `<div id="cover" data-box="0 ${atY} 300 200" data-css="${WHITE}" data-z="1"></div>`;

      test("the inner panel scrolls first, then the outer one brings it into view", () => {
        const html = `<div id="stage">${OUTER(INNER(TEXT(1600)) + COVER_OVER_INNER())}</div>`;
        const { findings, calls } = run(html);
        expect(findings).toEqual(covered);
        expect(panelScrolls(calls)).toEqual([
          "scrollPanel #inner 704",
          "scrollPanel #outer 650",
          "scrollPanel #inner 0",
          "scrollPanel #outer 0",
        ]);
      });

      test("an outer panel that shows the inner one stays where it is", () => {
        const html = `<div id="stage">${OUTER(INNER(TEXT(1000), 150) + COVER_OVER_INNER(150))}</div>`;
        const { findings, calls } = run(html);
        expect(findings).toEqual(covered);
        expect(panelScrolls(calls)).toEqual(["scrollPanel #inner 754", "scrollPanel #inner 0"]);
      });
    });

    describe("the work is bounded", () => {
      const { maxScrolledPanels, maxPanelScrolls } = LAYOUT_AUDIT_THRESHOLDS;

      test("a page scrolls only so many panels: the text in the others is not sampled", () => {
        // Panels of 50 px at y 100, 200, ... each with its own text far below and its own cover.
        const panels = Array.from({ length: maxScrolledPanels + 2 }, (_, i) => {
          const top = 100 + i * 100;
          const text = `<p id="t${i}" data-box="10 ${2000 + i * 30} 200 20" data-lines="10 ${2000 + i * 30} 200 20">Hello world text</p>`;
          return `<div id="panel${i}" data-box="0 ${top} 300 50" data-css="overflow-y: auto" data-scroll-height="9000">${text}</div>
            <div data-box="0 ${top} 300 50" data-css="${WHITE}" data-z="1"></div>`;
        });
        const { findings, calls } = run(`<div id="stage">${panels.join("")}</div>`);
        expect(findings.map((f) => f.selector)).toEqual(
          Array.from({ length: maxScrolledPanels }, (_, i) => `p#t${i}`)
        );
        // One scroll and one restore for each panel that was scrolled.
        expect(panelScrolls(calls)).toHaveLength(2 * maxScrolledPanels);
      });

      test("a page makes only so many panel scrolls: the text further down is not sampled", () => {
        // One panel of 100 px with 40 paragraphs 300 px apart: each needs a scroll of its own.
        const rows = Array.from({ length: maxPanelScrolls + 8 }, (_, i) =>
          TEXT(1000 + i * 300, `r${i}`)
        );
        const panel = `<div id="panel" data-box="0 100 300 100" data-css="overflow-y: auto" data-scroll-height="20000">${rows.join("")}</div>`;
        const cover = `<div data-box="0 100 300 100" data-css="${WHITE}" data-z="1"></div>`;
        const { findings, calls } = run(`<div id="stage">${panel}${cover}</div>`);
        expect(findings).toHaveLength(maxPanelScrolls);
        expect(panelScrolls(calls)).toHaveLength(maxPanelScrolls + 1);
      });
    });

    // A list that draws only the rows that show can drop a row when its panel scrolls. The row has
    // two lines: the first shows in the panel and is covered, the second is below its edge.
    test("an element that left the page when its panel scrolled is unknown: not covered, not free", () => {
      const row =
        '<p id="t" data-box="10 150 200 280" data-lines="10 150 200 20; 10 400 200 20">Hello world text</p>';
      using fake = createFakeLayoutPage(`<div id="stage">${PANEL(row)}${COVER_OVER_PANEL}</div>`, {
        viewport: { width: 390, height: 844, scrollHeight: 3000 },
      });
      const text = fake.byId("t");
      const dropping: LayoutPage = {
        ...fake.page,
        scrollElementTo: (el, top) => {
          const reached = fake.page.scrollElementTo(el, top);
          text.remove();
          return reached;
        },
      };
      // The second line's nine points are unknown. Counted as free they would pull the nine
      // covered points of the first line under 90%.
      expect(auditLayout(dropping)).toEqual(covered);
    });

    describe("every scroll is put back", () => {
      const TWO = `<div id="stage">${PANEL(TEXT(400))}${COVER_OVER_PANEL}</div>`;

      test("when a sample throws", () => {
        using fake = createFakeLayoutPage(TWO, {
          viewport: { width: 390, height: 844, scrollHeight: 3000 },
        });
        const failing: LayoutPage = {
          ...fake.page,
          elementAt: () => {
            throw new Error("boom");
          },
        };
        expect(() => auditLayout(failing)).toThrow("boom");
        expect(panelScrolls(fake.calls).at(-1)).toBe("scrollPanel #panel 0");
        expect(fake.calls.at(-1)).toBe("scrollTo 0");
      });

      test("when one of them cannot be put back, the others still are", () => {
        const html = `<div id="stage">
          <div id="a" data-box="0 100 300 50" data-css="overflow-y: auto" data-scroll-height="9000">${TEXT(2000, "ta")}</div>
          <div id="b" data-box="0 200 300 50" data-css="overflow-y: auto" data-scroll-height="9000">${TEXT(2100, "tb")}</div>
          <div data-box="0 100 300 150" data-css="${WHITE}" data-z="1"></div></div>`;
        using fake = createFakeLayoutPage(html, {
          viewport: { width: 390, height: 844, scrollHeight: 3000 },
        });
        const stuck: LayoutPage = {
          ...fake.page,
          scrollElementTo: (el, top) => {
            if (el.id === "a" && top === 0) throw new Error("stuck");
            return fake.page.scrollElementTo(el, top);
          },
        };
        expect(() => auditLayout(stuck)).toThrow(AggregateError);
        expect(fake.calls).toContain("scrollPanel #b 0");
        expect(fake.calls.at(-1)).toBe("scrollTo 0");
      });
    });
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
