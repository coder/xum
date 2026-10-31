import { sanitizeMermaidSvg } from "./Mermaid";

import { Window } from "happy-dom";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

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
});
