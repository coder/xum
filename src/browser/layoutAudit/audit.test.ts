import { describe, expect, test } from "bun:test";
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
    ["an ellipsis and a line clamp", "; text-overflow: ellipsis; webkit-line-clamp: 2"],
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

  // A line clamp drops whole lines. A browser paints no ellipsis on a word that is cut sideways
  // anywhere but the clamp's last line, so the clamp is no excuse for the word.
  test("a line clamp does not excuse a word cut sideways", () => {
    expect(audit(TEXT("; webkit-line-clamp: 2"))).toEqual(BASE);
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
      ["an ellipsis and a line clamp", "; text-overflow: ellipsis; webkit-line-clamp: 2"],
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

    test("with a line clamp but no ellipsis still cuts a word sideways", () => {
      expect(audit(NESTED(CLIPPING + "; webkit-line-clamp: 2"))).toEqual([
        finding("clipped-text", "span#s", "horizontal", 140),
      ]);
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
  });

  // A native control stays one under any role, and a role on another element needs to be a
  // widget role that one element fills by itself.
  const CONTROL_FILLED: Array<[string, string]> = [
    ["a button with role menuitem", '<button role="menuitem" data-box="150 5 100 30">Buy</button>'],
    [
      "a button with a role that is no widget",
      '<button role="presentation" data-box="150 5 100 30">Buy</button>',
    ],
    ["a link with role tab", '<a href="#x" role="tab" data-box="150 5 100 30">Buy</a>'],
    ["an input with role searchbox", '<input role="searchbox" data-box="150 5 100 30">'],
    ...[
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "scrollbar",
      "tab",
      "slider",
      "spinbutton",
      "searchbox",
      "treeitem",
      "combobox",
      "TextBox",
    ].map((role): [string, string] => [
      `a div with role ${role}`,
      `<div role="${role}" data-box="150 5 100 30">Buy</div>`,
    ]),
  ];

  test.each(CONTROL_FILLED)("%s is a control", (_name, control) => {
    expect(audit(IN_BAR(control))).toEqual([
      finding("clipped-control", "div#bar", "horizontal", 50),
    ]);
  });

  test("a container role, and a role that is not operable by itself, is no control", () => {
    const roles = ["menu", "tablist", "listbox", "grid", "tree", "toolbar", "group"];
    for (const role of [...roles, "gridcell", "separator", "progressbar", "tabpanel"]) {
      expect(audit(IN_BAR(`<div role="${role}" data-box="150 5 100 30">Buy</div>`))).toEqual([]);
    }
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

  test("a fixed control must fit the viewport, however long the page", () => {
    const tall = { viewport: { width: 390, height: 844, scrollHeight: 5000 } };
    const button = '<button data-css="position: fixed" data-box="10 900 100 40">Buy</button>';
    expect(audit(button, tall)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 96),
    ]);
    expect(audit('<button data-box="10 900 100 40">Buy</button>', tall)).toEqual([]);
  });

  // A sticky control sits in the flow until the user scrolls to it: below the fold is not lost.
  test("a sticky control below the fold is reached by scrolling, like one in the flow", () => {
    const tall = { viewport: { width: 390, height: 844, scrollHeight: 5000 } };
    const sticky = (box: string) =>
      `<button data-css="position: sticky" data-box="${box}">Buy</button>`;
    expect(audit(sticky("10 900 100 40"), tall)).toEqual([]);
    // Past the end of the page, nothing scrolls to it.
    expect(audit(sticky("10 5100 100 40"), tall)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 140),
    ]);
  });

  test("a sticky control on a page that cannot scroll must fit the viewport", () => {
    const tall = { viewport: { width: 390, height: 844, scrollHeight: 5000 } };
    using fake = createFakeLayoutPage(
      '<button data-css="position: sticky" data-box="10 900 100 40">Buy</button>',
      tall
    );
    fake.page.document.documentElement.setAttribute("data-css", "overflow-y: hidden");
    expect(auditLayout(fake.page)).toEqual([
      finding("viewport-unreachable-control", TOP_BUTTON, "vertical", 96),
    ]);
  });

  // A control past the right edge widens the page: page-horizontal-overflow reports that. A fixed
  // one does not, so it is reported on its own.
  test("a fixed control past the right edge is reported, one in the flow is not", () => {
    const fixed = (box: string) =>
      `<button id="fab" data-css="position: fixed" data-box="${box}">Help</button>`;
    expect(audit(fixed("340 10 100 40"))).toEqual([
      finding("viewport-unreachable-control", "button#fab", "horizontal", 50),
    ]);
    expect(audit(fixed("0 10 100 40"))).toEqual([]);
    // 3 px past the edge is tolerated, as at the left edge.
    expect(audit(fixed("293 10 100 40"))).toEqual([]);
    expect(audit('<button data-box="340 10 100 40">Help</button>')).toEqual([]);
  });

  test("a fixed control that a horizontal scroller holds is left alone at the right edge", () => {
    const html = `<div data-box="0 0 390 50" data-css="overflow-x: auto">
      <button data-css="position: fixed" data-box="340 10 100 40">Help</button></div>`;
    expect(audit(html)).toEqual([]);
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

  // An image has no text line: its box is where it ends, as a control's is.
  test.each(["img", "video", "canvas", "iframe", "embed", "object"])(
    "a visible <%s> past the edge is evidence",
    (tag) => {
      const html = `<${tag} data-box="0 0 642 100"></${tag}>`;
      expect(audit(html, wide(642))).toEqual([
        finding("page-horizontal-overflow", "html", "horizontal", 252),
      ]);
      expect(audit(html, wide(413))).toEqual([]);
    }
  );

  test("an image in a link, a list item or a table cell is evidence: no paragraph judges it", () => {
    const html = '<ul><li data-box="0 0 642 100"><img data-box="0 0 642 100"></li></ul>';
    expect(audit(html, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
  });

  test.each([
    ["positioned", '<img data-css="position: absolute" data-box="0 0 642 100">'],
    ["fixed", '<img data-css="position: fixed" data-box="0 0 642 100">'],
    ["visibility hidden", '<img data-css="visibility: hidden" data-box="0 0 642 100">'],
    ["transparent", '<img data-css="opacity: 0" data-box="0 0 642 100">'],
    ["without a box", "<img>"],
    ["animated", '<img data-animated data-box="0 0 642 100">'],
    ["in a diagram", '<div class="mermaid"><img data-box="0 0 642 100"></div>'],
    [
      "in a horizontal scroller",
      '<div data-box="0 0 390 100" data-css="overflow-x: auto"><img data-box="0 0 642 100"></div>',
    ],
  ])("an image that is %s is not evidence", (_name, html) => {
    expect(audit(html, wide(642))).toEqual([]);
  });

  // A box with no height does not hide text that spills out of it (the text paints).
  test("text that spills out of a box with no height is evidence", () => {
    const html = '<p data-box="0 0 390 0" data-lines="0 0 642 20">Wide spilled text</p>';
    expect(audit(html, wide(642))).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
      // The line is lost below its box too, as for any box that is too short.
      finding("clipped-text", TOP_P, "vertical", 20),
    ]);
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

  test("a line of 16 square px is sampled, one of 15 is not", () => {
    const line = (size: string) =>
      STAGE(COVER()).replace('data-lines="10 10 200 20"', `data-lines="10 10 ${size}"`);
    expect(audit(line("4 4"))).toEqual(COVERED);
    expect(audit(line("3 5"))).toEqual([]);
  });

  test("text of 8 characters is long enough to read, 7 is not", () => {
    expect(audit(STAGE(COVER(), "12345678"))).toEqual(COVERED);
    expect(audit(STAGE(COVER(), "1234567"))).toEqual([]);
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

    // The item's lines are no stand-in for the control: they hold its text only when it has any
    // (a short one is no candidate there), and say nothing of a covered control that has none.
    test("a control that has text lines is sampled by them, inside a paragraph too", () => {
      const html = `<div id="stage"><li data-box="0 0 300 40"><textarea id="f" ${BOXED} data-lines="10 10 200 30">Go</textarea></li>${COVER()}</div>`;
      expect(audit(html)).toEqual([finding("overlapping-text", "textarea#f", "horizontal", 0)]);
      const aria = `<div id="stage"><li data-box="0 0 300 40"><div role="checkbox" id="f" ${BOXED} data-lines="10 10 200 30">Go</div></li>${COVER()}</div>`;
      expect(audit(aria)).toEqual([finding("overlapping-text", "div#f", "horizontal", 0)]);
    });

    test("a textarea that holds text has no text line, so it is sampled by its box", () => {
      // A browser draws the value from a shadow tree: a Range over the text the textarea holds has
      // no rectangle, so the control is sampled like an input.
      const html = `<div id="stage"><label data-box="0 0 300 40">Notes <textarea id="f" ${BOXED}>Initial value</textarea></label>${COVER()}</div>`;
      expect(audit(html)).toEqual([finding("overlapping-text", "textarea#f", "horizontal", 0)]);
      expect(audit(html.replace(COVER(), ""))).toEqual([]);
    });

    test("an element that is no control, and a hidden or disabled control, are not sampled", () => {
      expect(audit(CONTROL(`<div id="f" ${BOXED}></div>`))).toEqual([]);
      expect(audit(CONTROL(`<input type="hidden" id="f" ${BOXED}>`))).toEqual([]);
      expect(audit(CONTROL(`<button id="f" disabled ${BOXED}></button>`))).toEqual([]);
    });
  });

  describe("text below the screen", () => {
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
});

// An element with no area is not an element nobody sees: its text can still paint.
describe("an element whose box has no area", () => {
  const wide = (scrollWidth: number) => ({ viewport: { width: 390, height: 844, scrollWidth } });
  // The line sticks out of a box with no height: it is lost below its box, as for any short box.
  const LOST_BELOW = finding("clipped-text", TOP_P, "vertical", 20);

  test("text that spills out of a box with no height is judged by its lines", () => {
    const spill = (left: number) =>
      `<p data-box="${left} 0 100 0" data-lines="${left} 0 100 20">Text spilling out</p>`;
    expect(audit(spill(-80))).toEqual([
      finding("viewport-unreachable-content", TOP_P, "horizontal", 80),
      LOST_BELOW,
    ]);
    expect(audit(spill(0))).toEqual([LOST_BELOW]);
  });

  test("text that spills out of a box with no height can be covered", () => {
    const html = `<div><p id="t" data-box="10 10 200 0" data-lines="10 10 200 20">Hello world text</p>
      <div data-box="0 0 300 60" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div></div>`;
    expect(audit(html)).toEqual([
      finding("clipped-text", "p#t", "vertical", 20),
      finding("overlapping-text", "p#t", "horizontal", 0),
    ]);
  });

  // A collapsed panel (`height: 0; overflow: hidden`) holds text that nobody sees.
  test.each([
    [
      "itself",
      '<div data-box="0 0 390 0" data-css="overflow-y: hidden" data-lines="0 0 642 20">Panel text</div>',
    ],
    [
      "an ancestor",
      '<div data-box="0 0 390 0" data-css="overflow-y: hidden"><p data-box="0 0 390 0" data-lines="0 0 642 20">Panel text</p></div>',
    ],
  ])("text in a box with no area that %s clips is hidden, not judged", (_name, html) => {
    expect(audit(html, wide(642))).toEqual([]);
  });

  test("an ancestor with an area that clips is for the clipping rules to judge", () => {
    const html = `<div id="card" data-box="0 0 100 100" data-css="overflow-x: hidden">
      <p data-box="0 0 100 0" data-lines="0 0 300 20">Text in a card</p></div>`;
    expect(audit(html)).toEqual([finding("clipped-text", "div#card", "horizontal", 200)]);
  });

  test("a `display: contents` element's overflow clips nothing: no box holds its text", () => {
    const FITS = '<p data-box="0 0 300 20" data-lines="0 0 300 20">A paragraph that fits</p>';
    const wrapper = (inner: string, attributes = "") =>
      `<div id="w" ${attributes} data-css="display: contents; overflow-x: hidden">${inner}</div>`;
    // Its empty rectangle is no clip for the text it holds, nor for a control.
    expect(audit(wrapper(FITS))).toEqual([]);
    expect(audit(wrapper('<button data-box="10 10 100 30">Go</button>'))).toEqual([]);
    // Nor for its own text.
    expect(audit(wrapper("Its own text", 'data-lines="0 0 200 20"'))).toEqual([]);
    // A box with the same overflow does cut.
    const boxed = FITS.replace("<p ", '<p id="inner" ');
    const card = `<div id="card" data-box="0 0 100 20" data-css="overflow-x: hidden">${boxed}</div>`;
    expect(audit(card)).toEqual([finding("clipped-text", "div#card", "horizontal", 200)]);
  });

  test("a `display: contents` paragraph is judged by its lines, and a card around it clips them", () => {
    const html = `<div id="card" data-box="0 0 100 20" data-css="overflow-x: hidden">
      <p data-css="display: contents" data-lines="0 0 300 20">A long paragraph without a box</p></div>`;
    expect(audit(html)).toEqual([finding("clipped-text", "div#card", "horizontal", 200)]);
  });
});

describe("text a text boundary holds that is not shown", () => {
  // A Range still measures the text of a hidden or transparent element: the fake gives the span
  // its lines too. Only what the user sees is evidence.
  const HOLDING = (spanCss: string, lines: string, paragraphCss = "") =>
    `<p id="p" data-box="0 0 300 20" data-css="${paragraphCss}" data-lines="0 0 100 20">Visible <span data-css="${spanCss}" data-lines="${lines}">words nobody sees</span></p>`;
  const SHOWN = "visibility: visible";

  test.each([["visibility: hidden"], ["opacity: 0"], ["content-visibility: hidden"]])(
    "a span with %s does not clip its paragraph",
    (css) => {
      const clipping = "overflow-x: hidden";
      expect(audit(HOLDING(SHOWN, "0 0 900 20", clipping))).toEqual([
        finding("clipped-text", "p#p", "horizontal", 600),
      ]);
      expect(audit(HOLDING(css, "0 0 900 20", clipping))).toEqual([]);
    }
  );

  test("a hidden span past the edge neither widens the page nor loses the paragraph's left edge", () => {
    const wide = { viewport: { width: 390, height: 844, scrollWidth: 900 } };
    expect(audit(HOLDING(SHOWN, "0 0 900 20"), wide)).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 510),
    ]);
    expect(audit(HOLDING("visibility: hidden", "0 0 900 20"), wide)).toEqual([]);
    expect(audit(HOLDING(SHOWN, "-200 0 100 20"))).toEqual([
      finding("viewport-unreachable-content", "p#p", "horizontal", 200),
    ]);
    expect(audit(HOLDING("visibility: hidden", "-200 0 100 20"))).toEqual([]);
  });

  test("a hidden span does not dilute the cover over the text that is shown", () => {
    // Half of the lines Range measures sit under no cover: 9 of 18 points is no near-total cover.
    const html = (spanCss: string) =>
      `<div id="stage"><p id="t" data-box="10 10 400 20" data-lines="10 10 200 20">Hello <span data-css="${spanCss}" data-lines="250 10 100 20">world text</span></p>
        <div data-box="0 0 220 60" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div></div>`;
    expect(audit(html("visibility: hidden"))).toEqual([
      finding("overlapping-text", "p#t", "horizontal", 0),
    ]);
    expect(audit(html(SHOWN))).toEqual([]);
  });
});

describe("text in an element with no box (display: contents)", () => {
  // `display: contents` takes the element's box away (the fake's empty `data-box`). Its text still
  // paints, in lines of its parent's, so the lines are what is judged.
  const CONTENTS = (lines: string, css = "") =>
    `<p id="p" data-css="display: contents; ${css}" data-lines="${lines}">Paragraph text that paints</p>`;
  const wide = { viewport: { width: 390, height: 844, scrollWidth: 642 } };

  test("text past the right edge is evidence of page overflow", () => {
    expect(audit(CONTENTS("0 0 642 20"), wide)).toEqual([
      finding("page-horizontal-overflow", "html", "horizontal", 252),
    ]);
  });

  test("text past the left edge is reported on the element", () => {
    expect(audit(CONTENTS("-80 0 100 20"))).toEqual([
      finding("viewport-unreachable-content", "p#p", "horizontal", 80),
    ]);
  });

  test("a clipping ancestor cuts it, and its own overflow, which has no box to clip, does not", () => {
    const lines = "0 0 180 20; 0 24 150 20";
    const card = `<div id="card" data-box="0 0 200 22" data-css="overflow-y: hidden">${CONTENTS(lines)}</div>`;
    expect(audit(card)).toEqual([finding("clipped-text", "div#card", "vertical", 22)]);
    expect(audit(CONTENTS(lines, "overflow-y: hidden"))).toEqual([]);
  });

  test("an opaque sibling over it is reported", () => {
    const covered = `<div id="stage">${CONTENTS("10 10 200 20")}
      <div data-box="0 0 300 60" data-css="background-color: rgb(255, 255, 255)" data-z="1"></div></div>`;
    expect(audit(covered)).toEqual([finding("overlapping-text", "p#p", "horizontal", 0)]);
  });

  test("it is hidden as any element is: by its visibility or by an ancestor", () => {
    expect(audit(CONTENTS("-80 0 100 20", "visibility: hidden"))).toEqual([]);
    const inside = (css: string) => `<div data-css="${css}">${CONTENTS("-80 0 100 20")}</div>`;
    expect(audit(inside("display: none"))).toEqual([]);
    expect(audit(inside("opacity: 0"))).toEqual([]);
    expect(audit(inside("content-visibility: hidden"))).toEqual([]);
  });

  test("its ellipsis and line clamp cut and excuse nothing: a clipping ancestor still reports the line", () => {
    const card = (axis: string, size: string, inner: string) =>
      `<div id="card" data-box="${size}" data-css="overflow-${axis}: hidden">${inner}</div>`;
    const ellipsis = (inner: string) => card("x", "0 0 200 40", inner);
    const cutLine = CONTENTS("0 0 300 20", "text-overflow: ellipsis");
    expect(audit(ellipsis(cutLine))).toEqual([
      finding("clipped-text", "div#card", "horizontal", 100),
    ]);
    const clamp = card(
      "y",
      "0 0 200 22",
      CONTENTS("0 0 180 20; 0 24 150 20", "webkit-line-clamp: 2")
    );
    expect(audit(clamp)).toEqual([finding("clipped-text", "div#card", "vertical", 22)]);
    // A paragraph that has a box lays its text out, so its ellipsis is the author's cut.
    const boxed = `<p data-box="0 0 300 20" data-css="text-overflow: ellipsis" data-lines="0 0 300 20">Paragraph text that paints</p>`;
    expect(audit(ellipsis(boxed))).toEqual([]);
  });

  // The collapsed panel is a known false alarm (docs): a paragraph in it has a box and its text is
  // cut by the panel. A paragraph with `display: contents` has no area, and the panel that clips it
  // has none either, so nobody sees it: it is hidden, like any element with no area.
  test("a paragraph in a collapsed panel is reported on the panel, unless it has no box", () => {
    const panel = (css: string, box: string) =>
      `<div id="panel" data-box="0 0 200 0" data-css="overflow-y: hidden"><p data-box="${box}" data-css="${css}" data-lines="0 0 180 20">Collapsed panel text</p></div>`;
    expect(audit(panel("", "0 0 200 20"))).toEqual([finding("clipped-text", "div#panel", "vertical", 20)]);
    expect(audit(panel("display: contents", ""))).toEqual([]);
  });

  // The fake sizes the inner paragraph by its `data-box`, so this one has no height. A browser
  // gives a block paragraph in a collapsed panel its line height: see the test above.
  test("an element whose box has no area is hidden, whatever its text and lines are", () => {
    const collapsed = `<div data-box="0 0 200 0" data-css="overflow-y: hidden"><p data-box="0 0 200 0" data-lines="0 0 180 20; 0 24 150 20">Collapsed text</p></div>`;
    expect(audit(collapsed)).toEqual([]);
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
