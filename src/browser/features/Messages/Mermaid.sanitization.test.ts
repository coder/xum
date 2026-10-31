import { peleRenderOptions, sanitizeMermaidSvg } from "./Mermaid";
import { PELE_SAMPLES } from "./Mermaid.sanitization.fixtures";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { detectType, render as renderPele } from "pele";

const testWindow = new Window();
globalThis.DOMParser = testWindow.DOMParser as unknown as typeof DOMParser;

/**
 * Node names after the HTML parse that inserts the sanitizer output. parse5 follows the
 * browser's HTML parser. happy-dom's reads `<!-->` as an open comment, so it hides the live
 * <img> these tests look for.
 */
function htmlNodeNames(markup: string): string[] {
  const names: string[] = [];
  const visit = (nodes: Array<DefaultTreeAdapterMap["childNode"]>) => {
    for (const node of nodes) {
      names.push(node.nodeName);
      if ("childNodes" in node) visit(node.childNodes);
    }
  };
  visit(parseFragment(markup).childNodes);
  return names;
}

/**
 * The elements, attributes and style declarations that the HTML parse builds from markup, as
 * lines such as `<rect> fill="red"` and `<rect> style stroke:blue`.
 */
function htmlParts(markup: string): string[] {
  const parts: string[] = [];
  const visit = (nodes: Array<DefaultTreeAdapterMap["childNode"]>) => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      parts.push(`<${node.tagName}>`);
      for (const { prefix, name, value } of node.attrs) {
        if (name === "style") {
          parts.push(
            ...value.split(";").map((declaration) => `<${node.tagName}> style ${declaration}`)
          );
        } else {
          parts.push(`<${node.tagName}> ${prefix ? `${prefix}:` : ""}${name}="${value}"`);
        }
      }
      visit(node.childNodes);
    }
  };
  visit(parseFragment(markup).childNodes);
  return parts;
}

/** A CSS variable as renderMermaidSvg reads it from the theme. */
function themeVariable(name: string): string {
  const css = readFileSync(path.join(import.meta.dir, "../../styles/theme-dark.css"), "utf8");
  const value = new RegExp(`${name}:([^;]+);`).exec(css)?.[1].trim();
  if (value === undefined) throw new Error(`theme-dark.css sets no ${name}`);
  return value;
}

describe("sanitizeMermaidSvg", () => {
  it("returns null for malformed SVG", () => {
    expect(sanitizeMermaidSvg("<svg><g></svg")).toBeNull();
  });

  it("removes active content, foreignObject and unsafe attributes", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      "<script>alert(1)</script>" +
      '<foreignObject><div onclick="evil()">label</div></foreignObject>' +
      '<a href="javascript:alert(1)"><text>link</text></a>' +
      '<a xlink:href="java&#10;script:alert(3)"><text>split-link</text></a>' +
      '<a href="java&#1114112;script:alert(4)"><text>invalid-codepoint</text></a>' +
      '<image src="javascript:alert(2)" />' +
      '<rect width="10" height="10" onclick="steal()" />' +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(input);

    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onload=");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("java&#10;script:");
    expect(sanitized).not.toContain("&#1114112;");
    expect(sanitized).not.toContain("xlink:href=");
    expect(sanitized).not.toContain("href=");
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("label");
  });

  const XHTML = "http://www.w3.org/1999/xhtml";
  const MATHML = "http://www.w3.org/1998/Math/MathML";
  const MATH = `<math xmlns="${MATHML}" display="block"><semantics><msup><mi>x</mi><mn>2</mn></msup><annotation encoding="application/x-tex">x^2</annotation></semantics></math>`;
  // The shape Pele wraps around a resolver's `html` result.
  const peleMathLabel = (divContent = MATH, divAttributes = "") =>
    '<foreignObject class="pele-math" x="0" y="0" width="20" height="10" overflow="visible">' +
    `<div xmlns="${XHTML}" style="display:flex"${divAttributes}>${divContent}</div>` +
    "</foreignObject>";
  const svgWith = (label: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/>${label}</svg>`;

  it("keeps Pele's MathML labels", () => {
    const sanitized = sanitizeMermaidSvg(svgWith(peleMathLabel()));

    expect(sanitized).toContain('<foreignObject class="pele-math"');
    expect(sanitized).toContain("<msup><mi>x</mi><mn>2</mn></msup>");
  });

  it.each([
    [
      "an HTML label",
      `<foreignObject><div xmlns="${XHTML}"><img src="x" onerror="alert(1)"/></div></foreignObject>`,
    ],
    ["an XHTML img instead of math", peleMathLabel('<img src="x" onerror="alert(1)"/>')],
    ["MathML without a math root", peleMathLabel(`<mrow xmlns="${MATHML}"><mi>x</mi></mrow>`)],
    ["a script beside the math", peleMathLabel(`${MATH}<script>alert(1)</script>`)],
    [
      "an XHTML element inside the math",
      peleMathLabel(`<math xmlns="${MATHML}"><mi xmlns="${XHTML}">x</mi></math>`),
    ],
    // Inherits the MathML namespace, but the HTML parser builds an HTML <img> inside <mtext>.
    [
      "an HTML-named element inside the math",
      peleMathLabel(
        `<math xmlns="${MATHML}"><mtext><img src="https://example.com/beacon.png"/></mtext></math>`
      ),
    ],
    ["an extra attribute on the wrapper", peleMathLabel(MATH, ' onclick="alert(1)"')],
    // The HTML parser would read the math's text as CSS.
    [
      "a style element as the wrapper",
      `<foreignObject class="pele-math"><style xmlns="${XHTML}" style="">${MATH}</style></foreignObject>`,
    ],
  ])("removes a foreignObject with %s", (_case, label) => {
    const sanitized = sanitizeMermaidSvg(svgWith(label));

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("<img");
  });

  // The HTML parser ends `<!-->` at its first `>`, so the <img> after it is a live element. happy-dom
  // has no CDATA nodes and ends a processing instruction at its first `>`, so those cases cannot
  // carry the same <img> here.
  const BREAKOUT_COMMENT = '<!--><img src="x" onerror="alert(1)"/>-->';
  it.each([
    ["a comment in a text label", `<text>${BREAKOUT_COMMENT}label</text>`],
    ["a comment in a math label", peleMathLabel(`${BREAKOUT_COMMENT}${MATH}`)],
    ["a processing instruction in a text label", "<text><?xx data?>label</text>"],
    ["a processing instruction in a math label", peleMathLabel(`<?xx data?>${MATH}`)],
    ["a style element", '<style>@import url("https://example.com/x.css");</style>'],
    // The HTML parser lowercases tag names, so this becomes a live <style>.
    ["an uppercase style element", "<STYLE>text { fill: red }</STYLE>"],
    // A click on the link runs the script that <set> writes into its href.
    [
      "a set that writes a link's href",
      '<a><set attributeName="href" to="javascript:alert(1)"/><text>link</text></a>',
    ],
    [
      "an animate element",
      '<text><animate attributeName="href" values="javascript:alert(1)"/>label</text>',
    ],
    // The HTML parser ends the <svg> at an SVG-namespace <p>, so the <link> after it loads.
    ["an SVG p before a link", '<p/><link rel="stylesheet" href="https://example.com/x.css"/>'],
    ["an unknown element", "<unknown><text>label</text></unknown>"],
  ])("removes %s", (_case, label) => {
    const sanitized = sanitizeMermaidSvg(svgWith(label)) ?? "";
    const injected = ["#comment", "img", "style", "a", "set", "animate", "p", "link", "unknown"];

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toMatch(/<!--|<\?|<!\[CDATA\[|javascript:/);
    expect(htmlNodeNames(sanitized).filter((name) => injected.includes(name))).toEqual([]);
  });

  // Inserted without the sanitizer, every payload but the gradient hrefs, cross-fade(), @import,
  // expression() and xml:base makes Chromium 156 request this URL.
  const REMOTE = "https://attacker.example/x";
  const svgRoot = (rootAttributes: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttributes}><rect width="10" height="10"/></svg>`;
  it.each([
    ["a style mask-image url()", svgWith(`<rect style="mask-image:url(${REMOTE})"/>`)],
    ["a CSS escape in a style url()", svgWith(`<rect style="fill:u\\72l(${REMOTE})"/>`)],
    ["a style fill url()", svgWith(`<rect style="fill:url(${REMOTE}#a)"/>`)],
    ["a style filter url()", svgWith(`<rect style="filter:url(${REMOTE}#f)"/>`)],
    ["a fill url()", svgWith(`<rect fill="url(${REMOTE}#a)"/>`)],
    ["a filter url()", svgWith(`<rect filter="url(${REMOTE}#f)"/>`)],
    ["a mask url()", svgWith(`<rect mask="url(${REMOTE}#m)"/>`)],
    ["a clip-path url()", svgWith(`<rect clip-path="url(${REMOTE}#c)"/>`)],
    ["a marker-end url()", svgWith(`<path d="M0 0L5 5" marker-end="url(${REMOTE}#m)"/>`)],
    ["a gradient href", svgWith(`<defs><linearGradient id="g" href="${REMOTE}#g"/></defs>`)],
    [
      "a gradient xlink:href",
      svgWith(
        `<defs><linearGradient xmlns:xlink="http://www.w3.org/1999/xlink" id="g" xlink:href="${REMOTE}#g"/></defs>`
      ),
    ],
    ["a root style url()", svgRoot(`style="background-image:url(${REMOTE})"`)],
    [
      "a url() with quotes and spaces",
      svgWith(`<rect fill="url( &quot;${REMOTE}&quot; )" style="stroke:url( '${REMOTE}' )"/>`),
    ],
    ["an uppercase URL()", svgWith(`<rect style="fill:URL(${REMOTE})"/>`)],
    ["an image-set()", svgWith(`<rect style="fill:red;background:image-set('${REMOTE}' 1x)"/>`)],
    ["a cross-fade()", svgWith(`<rect style="background:cross-fade('${REMOTE}' 50%, red)"/>`)],
    ["a custom property url()", svgWith(`<rect style="--x:url(${REMOTE});fill:var(--x)"/>`)],
    ["an @import", svgWith(`<rect style="fill:red;@import '${REMOTE}'"/>`)],
    ["an expression()", svgWith(`<rect style="width:expression(fetch('${REMOTE}'))"/>`)],
    ["an xml:base", svgWith(`<g xml:base="${REMOTE}/"><rect fill="url(#a)"/></g>`)],
    // XML attribute names are case-sensitive, but the HTML parser lowercases FILL to fill.
    ["an uppercase attribute name", svgWith(`<rect FILL="url(${REMOTE}#a)"/>`)],
  ])("removes %s", (_case, svg) => {
    const sanitized = sanitizeMermaidSvg(svg) ?? "";

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("attacker.example");
    expect(htmlParts(sanitized).filter((part) => part.includes("attacker"))).toEqual([]);
  });

  it("keeps the style declarations it does not remove", () => {
    expect(
      sanitizeMermaidSvg(svgRoot(`style="fill:red;mask:url(${REMOTE});stroke:blue"`))
    ).toContain('style="fill:red;stroke:blue"');
    expect(sanitizeMermaidSvg(svgRoot(`style="mask:url(${REMOTE})"`))).not.toContain("style=");
  });

  it("keeps a url(#id) attribute but no url() declaration", () => {
    const sanitized = sanitizeMermaidSvg(
      svgWith(`<rect fill="url(#a)" stroke="url( '#b' )" style="background-image:url(#c)"/>`)
    );

    expect(sanitized).toContain(`fill="url(#a)" stroke="url( '#b' )"`);
    // In a declaration Chromium fetches the page itself for url(#c).
    expect(sanitized).not.toContain("url(#c)");
  });

  it("keeps only the text of title and desc", () => {
    const sanitized = sanitizeMermaidSvg(
      svgWith("<title>tip<rect/><text>x</text></title><desc>about<g><rect/></g></desc>")
    );

    expect(htmlNodeNames(sanitized ?? "")).toEqual([
      "svg",
      "rect",
      "title",
      "#text",
      "desc",
      "#text",
    ]);
  });
});

describe("sanitizeMermaidSvg on Pele's output", () => {
  let measure: { mockRestore(): void };
  let originalXMLSerializer: typeof globalThis.XMLSerializer;

  beforeAll(() => {
    saveDomGlobals();
    originalXMLSerializer = globalThis.XMLSerializer;
    globalThis.document = testWindow.document as unknown as Document;
    // happy-dom builds <math> as an HTML element, so its XMLSerializer declares the XHTML
    // namespace before KaTeX's MathML xmlns attribute, and the label fails the MathML check.
    // Chromium builds a MathML element and writes only KaTeX's xmlns.
    globalThis.XMLSerializer = class extends testWindow.XMLSerializer {
      serializeToString(
        ...args: Parameters<Window["XMLSerializer"]["prototype"]["serializeToString"]>
      ) {
        return super
          .serializeToString(...args)
          .replace(/^<math xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" /, "<math ");
      }
    } as unknown as typeof XMLSerializer;
    // happy-dom has no layout, and Pele shows the TeX source of a 0x0 formula. happy-dom parses
    // <math> as an HTMLUnknownElement.
    measure = spyOn(testWindow.HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new testWindow.DOMRect(0, 0, 24, 18)
    );
  });

  afterAll(() => {
    measure.mockRestore();
    globalThis.XMLSerializer = originalXMLSerializer;
    restoreDomGlobals();
  });

  const fonts = {
    fontFamily: themeVariable("--font-primary"),
    fontFamilyMono: themeVariable("--font-monospace"),
  };
  const samples = Object.entries(PELE_SAMPLES).flatMap(([type, charts]) =>
    charts.map((chart, index) => [`${type} ${index + 1}`, type, chart] as const)
  );

  // A Pele upgrade that emits a new element, attribute or CSS function fails here, and the
  // removed parts name what to review.
  it.each(samples)("removes nothing from %s", (_name, type, chart) => {
    expect<string | null>(detectType(chart)).toBe(type);
    // At the narrow width Pele turns wide layouts vertical.
    for (const maxWidth of [undefined, 390]) {
      const { svg } = renderPele(
        chart,
        peleRenderOptions({ idPrefix: "mermaid-r1", maxWidth, ...fonts })
      );
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement
        .outerHTML;
      const sanitized = sanitizeMermaidSvg(svg);

      expect(svg).not.toContain("$$");
      const kept = new Set(htmlParts(sanitized ?? ""));
      expect([...new Set(htmlParts(parsed))].filter((part) => !kept.has(part))).toEqual([]);
      expect(sanitized).toBe(parsed);
    }
  });
});
