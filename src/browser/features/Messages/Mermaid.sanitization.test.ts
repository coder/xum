import { peleRenderOptions, sanitizeMermaidSvg } from "./Mermaid";
import { PELE_SAMPLES } from "./Mermaid.sanitization.fixtures";
import { MERMAID_MAX_ATTRIBUTE_NESTING } from "@/constants/mermaid";
import { chromiumMathSerializer } from "../../../../tests/ui/chromiumMathSerializer";
import { restoreDomGlobals, saveDomGlobals } from "../../../../tests/ui/domGlobals";

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { detectType, render as renderPele } from "pele";

const testWindow = new Window();
globalThis.DOMParser = testWindow.DOMParser as unknown as typeof DOMParser;

const ID_PREFIX = "mermaid-r1";

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

/**
 * Chromium parses a style while DOMParser builds the tree, in time that doubles with each
 * color-mix() nested around an invalid value: 1.27 s at depth 22.
 */
function nestedColorMix(depth: number, after = "", before = ""): string {
  let value = "nope(1)";
  for (let level = 0; level < depth; level++)
    value = `color-mix(in srgb, ${before}${value}${after}, blue)`;
  return value;
}

describe("sanitizeMermaidSvg", () => {
  it("returns null for malformed SVG", () => {
    expect(sanitizeMermaidSvg("<svg><g></svg", ID_PREFIX)).toBeNull();
    expect(
      sanitizeMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red/></svg>',
        ID_PREFIX
      )
    ).toBeNull();
  });

  it("returns null for an svg root outside the SVG namespace", () => {
    expect(sanitizeMermaidSvg('<svg xmlns="urn:x"><rect/></svg>', ID_PREFIX)).toBeNull();
    expect(sanitizeMermaidSvg("<svg><rect/></svg>", ID_PREFIX)).toBeNull();
  });

  it("removes active content, foreignObject and unsafe attributes", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      "<script>alert(1)</script>" +
      '<foreignObject><div onclick="evil()">label</div></foreignObject>' +
      '<a href="javascript:alert(1)"><text>link</text></a>' +
      '<image src="javascript:alert(2)" />' +
      '<rect width="10" height="10" onclick="steal()" />' +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(input, ID_PREFIX);

    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toContain("<script");
    expect(sanitized).not.toContain("onload=");
    expect(sanitized).not.toContain("onclick=");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).not.toContain("xlink:href=");
    expect(sanitized).not.toContain("href=");
    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("label");
  });

  const SVG = "http://www.w3.org/2000/svg";
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
    const sanitized = sanitizeMermaidSvg(svgWith(peleMathLabel()), ID_PREFIX);

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
    // Pele wraps the math only in a div. The sanitizer returns null for a <style> wrapper.
    [
      "a span as the wrapper",
      `<foreignObject class="pele-math"><span xmlns="${XHTML}" style="">${MATH}</span></foreignObject>`,
    ],
  ])("removes a foreignObject with %s", (_case, label) => {
    const sanitized = sanitizeMermaidSvg(svgWith(label), ID_PREFIX);

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("<img");
  });

  // The HTML parser ends `<!-->` at its first `>`, so the <img> after it is a live element. A quote
  // in a comment, CDATA, processing instruction or DOCTYPE hides the style after it from a scan of
  // attribute values, and a DOCTYPE entity expands to CSS.
  const BREAKOUT_COMMENT = '<!--><img src="x" onerror="alert(1)"/>-->';
  const DEEP_RECT = `<rect style="fill:${nestedColorMix(22)}"/>`;
  it.each([
    ["a comment in a text label", svgWith(`<text>${BREAKOUT_COMMENT}label</text>`)],
    ["a comment in a math label", svgWith(peleMathLabel(`${BREAKOUT_COMMENT}${MATH}`))],
    ["a processing instruction in a text label", svgWith("<text><?xx data?>label</text>")],
    ["a processing instruction in a math label", svgWith(peleMathLabel(`<?xx data?>${MATH}`))],
    ["a quote in a comment", svgWith(`<!-- " -->${DEEP_RECT}`)],
    ["a quote in CDATA", svgWith(`<text><![CDATA[ " ]]></text>${DEEP_RECT}`)],
    ["a quote in a processing instruction", svgWith(`<?x " ?>${DEEP_RECT}`)],
    ["a quote in a DOCTYPE comment", `<!DOCTYPE svg [<!-- " -->]>${svgWith(DEEP_RECT)}`],
    [
      "a DOCTYPE entity",
      `<!DOCTYPE svg [<!ENTITY e 'fill:${nestedColorMix(22)}'>]>${svgWith('<rect style="&e;"/>')}`,
    ],
  ])("returns null for %s", (_case, svg) => {
    expect(sanitizeMermaidSvg(svg, ID_PREFIX)).toBeNull();
  });

  it.each([
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
    // Pele writes no namespace prefix. The HTML parser knows no s:foreignobject, so a serializer
    // that keeps the prefix lets the label's div leave the <svg>.
    ["a prefixed element", `<s:rect xmlns:s="${SVG}" width="5"/>`],
    [
      "a prefixed math label",
      peleMathLabel()
        .replaceAll("foreignObject", "s:foreignObject")
        .replace("<s:foreignObject", `<s:foreignObject xmlns:s="${SVG}"`),
    ],
    [
      "a math label with a prefixed wrapper",
      peleMathLabel()
        .replace("<foreignObject", `<foreignObject xmlns:h="${XHTML}"`)
        .replace("<div", "<h:div")
        .replace("</div>", "</h:div>"),
    ],
    [
      "a math label with a prefixed MathML element",
      peleMathLabel(MATH.replace("<mi>x</mi>", `<m:mi xmlns:m="${MATHML}">x</m:mi>`)),
    ],
  ])("removes %s", (_case, label) => {
    const sanitized = sanitizeMermaidSvg(svgWith(label), ID_PREFIX) ?? "";
    const injected = ["#comment", "img", "style", "a", "set", "animate", "p", "link", "unknown"];

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toMatch(/<!--|<\?|<!\[CDATA\[|javascript:/);
    expect(
      htmlNodeNames(sanitized).filter((name) => injected.includes(name) || name.includes(":"))
    ).toEqual([]);
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
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX) ?? "";

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain("attacker.example");
    expect(htmlParts(sanitized).filter((part) => part.includes("attacker"))).toEqual([]);
  });

  it("removes a style with a failing declaration whole", () => {
    expect(
      sanitizeMermaidSvg(svgRoot(`style="fill:red;mask:url(${REMOTE});stroke:blue"`), ID_PREFIX)
    ).not.toContain("style=");
    expect(sanitizeMermaidSvg(svgRoot(`style="mask:url(${REMOTE})"`), ID_PREFIX)).not.toContain(
      "style="
    );
  });

  // A ; inside a quoted string does not end the declaration.
  it.each([
    ["single", `font-family:'a;background:url(${REMOTE})';fill:red`],
    ["double", `font-family:&quot;a;background:url(${REMOTE})&quot;;fill:red`],
  ])("removes a style with a %s-quoted ;", (_case, style) => {
    const sanitized = sanitizeMermaidSvg(svgWith(`<rect style="${style}"/>`), ID_PREFIX) ?? "";

    expect(sanitized).toContain("<rect");
    expect(htmlParts(sanitized).filter((part) => part.startsWith("<rect> style"))).toEqual([]);
  });

  // CSS reads \" in a string as an escaped quote and skips comments, so the text between the
  // quotes or inside the comment is inert. A sanitizer that reads it as declarations makes it live.
  const hidden = "position:fixed;inset:0;width:100vw;height:100vh;background:red";
  const withDivStyle = (style: string) =>
    svgWith(peleMathLabel().replace('style="display:flex"', `style="${style}"`));
  it.each([
    [
      "Q1",
      svgWith(`<rect style="font-family:&quot;a\\&quot;;fill:red&quot;;stroke:blue"/>`),
      "fill:red",
    ],
    ["Q2", svgWith(`<rect style="font-family:&quot;\\&quot;;${hidden};x:&quot;"/>`), hidden],
    ["Q3", svgWith(`<rect style="font-family:'a\\';fill:red';stroke:blue"/>`), "fill:red"],
    ["Q13", svgRoot(`style="font-family:&quot;\\&quot;;${hidden};x:&quot;"`), hidden],
    ["Q14", withDivStyle(`font-family:&quot;\\&quot;;${hidden};x:&quot;`), hidden],
    ["a comment", svgWith(`<rect style="font-family:a/*;${hidden};*/"/>`), hidden],
  ])("keeps no declaration that CSS reads as text in %s", (_case, svg, text) => {
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX) ?? "";
    const pieces = text.split(";");

    expect(sanitized).toContain("<rect");
    expect(pieces.filter((piece) => sanitized.includes(piece))).toEqual([]);
    expect(
      htmlParts(sanitized).filter(
        (part) => part.includes("position") || pieces.some((piece) => part.includes(piece))
      )
    ).toEqual([]);
  });

  it("keeps an id list with whitespace around its ids", () => {
    const sanitized =
      sanitizeMermaidSvg(
        svgRoot(`aria-describedby=" mermaid-r1-desc " aria-labelledby=" "`),
        ID_PREFIX
      ) ?? "";

    expect(sanitized).toContain('aria-describedby=" mermaid-r1-desc "');
    expect(htmlParts(sanitized).filter((part) => part.includes("aria-"))).toEqual([
      '<svg> aria-describedby=" mermaid-r1-desc "',
    ]);
  });

  it("removes an id with whitespace in it", () => {
    const sanitized =
      sanitizeMermaidSvg(svgWith(`<g id=" mermaid-r1-a"/><g id="mermaid-r1-b api"/>`), ID_PREFIX) ??
      "";

    expect(htmlParts(sanitized).filter((part) => part.includes("id="))).toEqual([]);
  });

  it("reads url(#id) only as a whole function name", () => {
    const sanitized =
      sanitizeMermaidSvg(
        svgWith(`<rect fill="xurl(#mermaid-r1-a)" stroke="-url(#mermaid-r1-a)"/>`),
        ID_PREFIX
      ) ?? "";

    expect(htmlParts(sanitized).filter((part) => /fill|stroke/.test(part))).toEqual([]);
  });

  // Pele passes these into a style, but they can paint other content or run a worklet.
  it.each(["element(#app)", "paint(worklet)", "attr(data-x)", "linear-gradient(red, blue)"])(
    "removes a style that uses %s",
    (call) => {
      const sanitized =
        sanitizeMermaidSvg(svgWith(`<rect style="fill:${call};stroke:red"/>`), ID_PREFIX) ?? "";

      expect(htmlParts(sanitized).filter((part) => part.startsWith("<rect> style"))).toEqual([]);
    }
  );

  it("keeps a url(#id) attribute but no url() declaration", () => {
    const sanitized = sanitizeMermaidSvg(
      svgWith(
        `<rect fill="url(#mermaid-r1-a)" stroke="url( '#mermaid-r1-b' )" style="background-image:url(#mermaid-r1-c)"/>`
      ),
      ID_PREFIX
    );

    expect(sanitized).toContain(`fill="url(#mermaid-r1-a)" stroke="url( '#mermaid-r1-b' )"`);
    // In a declaration Chromium fetches the page itself for url(#id).
    expect(sanitized).not.toContain("url(#mermaid-r1-c)");
  });

  // CSS whitespace is only space, tab, LF, CR and FF. Chromium reads url(&#160;#id) as a relative
  // URL and requests /%C2%A0 from the page's origin.
  it.each([
    ["W1", svgWith(`<rect fill="url(&#160;#mermaid-r1-g)"/>`), "fill"],
    ["W2", svgWith(`<rect stroke="url(&#xFEFF;#mermaid-r1-g)"/>`), "stroke"],
    ["W3", svgWith(`<rect fill="url(&#x3000;#mermaid-r1-g)"/>`), "fill"],
    ["W4", svgWith(`<rect fill="url(&#x2028;#mermaid-r1-g)"/>`), "fill"],
    [
      "W5",
      svgWith(peleMathLabel(MATH.replace("<mi>", `<mi mathcolor="url(&#160;#mermaid-r1-g)">`))),
      "mathcolor",
    ],
    ["W29", svgWith(`<rect fill="url(&#160;'#mermaid-r1-g')"/>`), "fill"],
    ["a vertical tab", svgWith(`<rect fill="red&#11;"/>`), "fill"],
    ["a NEL", svgWith(`<rect fill="red&#133;"/>`), "fill"],
    ["a non-ASCII font name", svgWith(`<rect style="font-family:Café"/>`), "style"],
  ])("removes a CSS value with a character outside printable ASCII in %s", (_case, svg, name) => {
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX) ?? "";

    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toContain(` ${name}=`);
    expect(htmlParts(sanitized).filter((part) => part.includes(`> ${name}`))).toEqual([]);
  });

  // Pele's source limit is 50,000 characters, and Pele renders on the renderer thread.
  it.each([
    ["a long name", `font-family:${"a".repeat(49_000)}`],
    ["a long whitespace run", `fill:${" ".repeat(49_000)}`],
  ])("checks a near-limit style with %s in linear time", (_case, style) => {
    const svg = svgWith(`<rect style="${style}"/>`);

    const start = performance.now();
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX);
    const elapsed = performance.now() - start;

    expect(sanitized).toContain("<rect");
    expect(elapsed).toBeLessThan(200);
  });

  it("returns null for a near-limit style of unclosed parentheses in linear time", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:${"rgb(".repeat(12_250)}"/></svg>`;

    const start = performance.now();
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX);
    const elapsed = performance.now() - start;

    expect(sanitized).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it.each([
    ["many strings", `font-family:${"'a'".repeat(16_000)}`],
    ["many comments", `fill:${"/**/".repeat(12_000)}`],
    ["many url()", `fill:${"url(x)".repeat(8_000)}`],
  ])("checks a near-limit style with %s in linear time", (_case, style) => {
    const svg = svgWith(`<rect style="${style}"/>`);

    const start = performance.now();
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX);
    const elapsed = performance.now() - start;

    expect(sanitized).toContain("<rect");
    expect(elapsed).toBeLessThan(200);
  });

  // Each value nests 22 deep as CSS reads it, behind characters that a count of ( and ) misreads.
  // CSS reads a quoted, commented or escaped ) as no closer, and a ) closes only a (, not a [ or {.
  // An unquoted url( starts a URL that ends at the first ), so a quote in it opens no string.
  it.each([
    ["a quoted ) at each level", `fill:${nestedColorMix(22, "", "')' ")}`],
    ["a double-quoted ) at each level", `fill:${nestedColorMix(22, "", "&quot;)&quot; ")}`],
    ["a commented ) at each level", `fill:${nestedColorMix(22, "", "/*)*/ ")}`],
    ["an escaped ) at each level", `fill:${nestedColorMix(22, "", "\\) ")}`],
    ["a [ and ) at each level", `fill:${nestedColorMix(22, "", "[) ")}`],
    ["a { and ) at each level", `fill:${nestedColorMix(22, "", "{) ")}`],
    // The XML parser turns a literal newline into a space, so the string goes on.
    ["a string with a literal newline at each level", `fill:${nestedColorMix(22, "", "')\n)' ")}`],
    ["a quoted ) in an earlier declaration", `font-family:')';fill:${nestedColorMix(22)}`],
    ["a quote in an unquoted url()", `fill:url(x&quot;);color:${nestedColorMix(22)}`],
    ["a quoted url() with a quoted )", `fill:url( &quot;)&quot; ${nestedColorMix(22)})`],
    // Each of these ends a token that takes in the url, so url( is a plain function.
    ...["#", "@", "-", "_", "5", "&#xE9;"].map(
      (before) => [`${before}url(`, `fill:${before}url(${nestedColorMix(22)})`] as const
    ),
  ])("returns null for nesting deeper than the limit behind %s", (_case, style) => {
    expect(sanitizeMermaidSvg(svgWith(`<rect style="${style}"/>`), ID_PREFIX)).toBeNull();
  });

  // DOMParser parses these as CSS too, even where the sanitizer removes them afterwards.
  it.each([
    ["a single-quoted style", `<rect style='fill:${nestedColorMix(22)}'/>`],
    ["an unknown presentation attribute", `<rect mask="${nestedColorMix(22)}"/>`],
    ["an uppercase STYLE", `<rect STYLE="fill:${nestedColorMix(22)}"/>`],
  ])("returns null for nesting deeper than the limit in %s", (_case, element) => {
    expect(sanitizeMermaidSvg(svgWith(element), ID_PREFIX)).toBeNull();
  });

  // DOMParser parses stylesheet text while it builds the tree, and the attribute scan never reads
  // it. Pele writes no <style>.
  const stylesheet = `rect{fill:${nestedColorMix(22)}}`;
  it.each([
    ["an SVG <style>", `<style>${stylesheet}</style>`],
    ["a prefixed <style>", `<x:style xmlns:x="http://www.w3.org/2000/svg">${stylesheet}</x:style>`],
    // JavaScript's \s matches U+1680, but XML reads it as part of the prefix.
    [
      "a <style> whose prefix holds U+1680",
      `<x\u1680:style xmlns:x\u1680="http://www.w3.org/2000/svg">${stylesheet}</x\u1680:style>`,
    ],
    // The HTML parser that inserts the output lowercases tag names, so this becomes a live <style>.
    ["an uppercase <STYLE>", `<STYLE>${stylesheet}</STYLE>`],
    [
      "an XHTML <style> in foreignObject",
      `<foreignObject><style xmlns="${XHTML}">${stylesheet}</style></foreignObject>`,
    ],
    ["a <style> in <desc>", `<desc><style>${stylesheet}</style></desc>`],
  ])("returns null for %s before DOMParser reads it", (_case, element) => {
    const parse = spyOn(DOMParser.prototype, "parseFromString");
    try {
      expect(sanitizeMermaidSvg(svgWith(element), ID_PREFIX)).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  // Chromium nests each var() when it computes styles after insert, in time that doubles with each
  // level, while each declaration nests only 2 deep.
  const chainLink = (level: number) => `color-mix(in srgb, var(--d${level}), blue)`;
  const varChain = (depth: number) =>
    Array.from({ length: depth }, (_, level) => `--d${level + 1}:${chainLink(level)}`).join(";");
  it("removes a style that chains custom properties on one element", () => {
    const sanitized =
      sanitizeMermaidSvg(
        svgWith(`<rect style="--d0:#zzz;${varChain(22)};fill:var(--d22)"/>`),
        ID_PREFIX
      ) ?? "";

    expect(sanitized).toContain("<rect");
    expect(htmlParts(sanitized).filter((part) => part.startsWith("<rect> style"))).toEqual([]);
  });

  it("removes styles that chain custom properties down nested elements", () => {
    const groups = Array.from(
      { length: 20 },
      (_, level) => `<g style="--d${level + 1}:${chainLink(level)}">`
    ).join("");
    const sanitized =
      sanitizeMermaidSvg(
        svgWith(
          `<g style="--d0:#zzz">${groups}<rect style="fill:var(--d20)"/>${"</g>".repeat(21)}`
        ),
        ID_PREFIX
      ) ?? "";

    expect(sanitized).toContain("<g");
    expect(htmlParts(sanitized).filter((part) => part.startsWith("<g> style"))).toEqual([]);
  });

  // Pele declares its custom properties only on the root, and each one only reads a theme variable.
  it.each([
    ["a Pele property on a rect", svgWith(`<rect style="--_r:var(--pele-radius,4px)"/>`)],
    ["an unknown property on the root", svgRoot(`style="--d0:var(--pele-bg,#fff)"`)],
    ["a root property that reads another", svgRoot(`style="--_a:var(--_b)"`)],
    [
      "a root property that reads one in a fallback",
      svgRoot(`style="--_a:var(--pele-a,var(--_b))"`),
    ],
    ["a root property that reads a non-theme one", svgRoot(`style="--_a:var(--color-a)"`)],
    // A ; in a block does not end a custom property, a { block after it joins its value, and a
    // declaration can start after a } block.
    [
      "a root property with a ; in a function",
      svgRoot(`style="--_a:var(--pele-a,calc(1;var(--_b)))"`),
    ],
    ["a root property before a { block", svgRoot(`style="--_a:var(--pele-a,red){;var(--_b)}"`)],
    ["a root property after a } block", svgRoot(`style="a{}--d0:var(--pele-a,red)"`)],
  ])("removes a style that declares %s", (_case, svg) => {
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX) ?? "";

    expect(sanitized).toContain("<rect");
    expect(htmlParts(sanitized).filter((part) => part.includes("> style"))).toEqual([]);
  });

  // CSS reads each of these as one level of nesting.
  it.each([
    ["a quoted value", "font-family:'X'"],
    ["a double-quoted value", "font-family:&quot;X&quot;"],
    ["a string that a newline ends", "font-family:'X&#10;"],
    ["a string that a carriage return ends", "font-family:'X&#13;"],
    ["a string that a form feed ends", "font-family:'X&#12;"],
    ["a comment", "fill:/*X*/"],
    ["a quote in an unquoted url()", "fill:url(x')"],
    // A ) closes the ( above the [.
    ["an open [", "fill:["],
  ])("keeps a style of 9 functions in a row after %s", (_case, before) => {
    const style = [before, ...Array<string>(9).fill("fill:rgb(1 2 3)")].join(";");

    expect(sanitizeMermaidSvg(svgWith(`<rect style="${style}"/>`), ID_PREFIX)).toContain("<rect");
  });

  it.each(["data-x", "class"])(
    "keeps an SVG with a deeply nested value in %s, which the browser never reads as CSS",
    (name) => {
      const label = `${"f(".repeat(40)}x${")".repeat(40)}`;

      expect(sanitizeMermaidSvg(svgWith(`<g ${name}="${label}"/>`), ID_PREFIX)).not.toBeNull();
    }
  );

  // CSS reads an escape unlike the scan, so past one the scan counts every ( and no ).
  it("counts every ( after an escape and no )", () => {
    const svg = (opened: number, after: string) =>
      svgWith(`<rect style="fill:${"f(".repeat(opened)}\\x${after}"/>`);

    expect(sanitizeMermaidSvg(svg(MERMAID_MAX_ATTRIBUTE_NESTING, ""), ID_PREFIX)).not.toBeNull();
    expect(
      sanitizeMermaidSvg(svg(MERMAID_MAX_ATTRIBUTE_NESTING - 1, " g()"), ID_PREFIX)
    ).not.toBeNull();
    expect(
      sanitizeMermaidSvg(svg(MERMAID_MAX_ATTRIBUTE_NESTING - 1, " g() g()"), ID_PREFIX)
    ).toBeNull();
  });

  // Pele escapes &, so only a Pele bug writes these, but the XML parser turns them into ( before
  // Chromium parses the style.
  it("returns null for nesting written as character references", () => {
    const svg = (references: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" style="${references}"/>`;

    expect(
      sanitizeMermaidSvg(svg("&#40;".repeat(4) + "&#x28;".repeat(4)), ID_PREFIX)
    ).not.toBeNull();
    expect(sanitizeMermaidSvg(svg("&#40;".repeat(5) + "&#x28;".repeat(4)), ID_PREFIX)).toBeNull();
  });

  it("keeps only the text of title and desc", () => {
    const sanitized = sanitizeMermaidSvg(
      svgWith("<title>tip<rect/><text>x</text></title><desc>about<g><rect/></g></desc>"),
      ID_PREFIX
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

  it("keeps only ids, id references and url(#id) that start with its idPrefix", () => {
    const sanitized = sanitizeMermaidSvg(
      svgRoot(
        `aria-labelledby="mermaid-r1-title" aria-describedby="mermaid-r1-desc&#9;review-immersive-root"`
      ).replace(
        "</svg>",
        `<title id="mermaid-r1-title">t</title><desc id="api">d</desc>` +
          `<defs><linearGradient id="mermaid-r2-g"/></defs>` +
          `<rect fill="url(#mermaid-r1-g)" stroke="url(#mermaid-r2-g)"/></svg>`
      ),
      ID_PREFIX
    );

    expect(sanitized).toContain('aria-labelledby="mermaid-r1-title"');
    expect(sanitized).toContain('<title id="mermaid-r1-title">');
    expect(sanitized).toContain('fill="url(#mermaid-r1-g)"');
    // window.api, an app element and another diagram's gradient.
    expect(sanitized).not.toMatch(/"api"|review-immersive-root|mermaid-r2/);
  });
});

describe("sanitizeMermaidSvg on Pele's output", () => {
  let measure: { mockRestore(): void };
  let originalXMLSerializer: typeof globalThis.XMLSerializer;

  beforeAll(() => {
    saveDomGlobals();
    originalXMLSerializer = globalThis.XMLSerializer;
    globalThis.document = testWindow.document as unknown as Document;
    globalThis.XMLSerializer = chromiumMathSerializer(
      testWindow.XMLSerializer as unknown as typeof XMLSerializer
    );
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
        peleRenderOptions({ idPrefix: ID_PREFIX, maxWidth, ...fonts })
      );
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement
        .outerHTML;
      const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX);

      expect(svg).not.toContain("$$");
      const kept = new Set(htmlParts(sanitized ?? ""));
      expect([...new Set(htmlParts(parsed))].filter((part) => !kept.has(part))).toEqual([]);
      expect(sanitized).toBe(parsed);
    }
  });

  // Pele passes nestedColorMix values unchanged, and its 50,000-character source limit allows
  // far deeper nesting.
  const sequenceRect = (color: string) =>
    `sequenceDiagram\n  participant A\n  rect ${color}\n  A->>A: hi\n  end`;
  it.each([
    ["a sequence rect", sequenceRect(nestedColorMix(22))],
    [
      "a C4 $bgColor",
      `C4Context\n  Person(a, "A")\n  UpdateElementStyle(a, $bgColor="${nestedColorMix(22)}")`,
    ],
    // CSS reads each ')' as a string, so it closes no function.
    ["a rect with a quoted ) at each level", sequenceRect(nestedColorMix(22, " ')'"))],
    ["a rect with a double-quoted ) at each level", sequenceRect(nestedColorMix(22, ' ")"'))],
    ["a rect nested 200 deep", sequenceRect(nestedColorMix(200))],
  ])("returns null for CSS functions nested deeply in %s", (_case, chart) => {
    const { svg } = renderPele(chart, peleRenderOptions({ idPrefix: ID_PREFIX, ...fonts }));
    expect(svg).toContain("nope(1)");

    const start = performance.now();
    const sanitized = sanitizeMermaidSvg(svg, ID_PREFIX);
    const elapsed = performance.now() - start;

    expect(sanitized).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  // nope(1) adds a level, and Pele writes rx:var(--_r) before the fill of the rect.
  it("keeps a rect nested MERMAID_MAX_ATTRIBUTE_NESTING deep and returns null one deeper", () => {
    const sanitizeRect = (depth: number) =>
      sanitizeMermaidSvg(
        renderPele(
          sequenceRect(nestedColorMix(depth)),
          peleRenderOptions({ idPrefix: ID_PREFIX, ...fonts })
        ).svg,
        ID_PREFIX
      );

    expect(sanitizeRect(MERMAID_MAX_ATTRIBUTE_NESTING - 1)).not.toBeNull();
    expect(sanitizeRect(MERMAID_MAX_ATTRIBUTE_NESTING)).toBeNull();
  });

  // Pele copies these labels into data-id.
  const LABEL = "f(f(f(f(f(f(f(f(f(x)))))))))";
  it.each([
    ["pie", `pie\n  "${LABEL}" : 3`],
    ["gitGraph", `gitGraph\n  commit id: "${LABEL}"`],
    ["sankey-beta", `sankey-beta\n"${LABEL}",B,5`],
    ["journey", `journey\n  section S\n    ${LABEL}: 5: Me`],
  ])("keeps a %s label with deeply nested parentheses", (_type, chart) => {
    const { svg } = renderPele(chart, peleRenderOptions({ idPrefix: ID_PREFIX, ...fonts }));
    expect(svg).toContain(`data-id="${LABEL}`);

    expect(sanitizeMermaidSvg(svg, ID_PREFIX)).toContain(LABEL);
  });

  // Pele wraps the label into tspans where its font measure finds the label too wide, and that
  // measure differs between machines, so at 94 it wraps everywhere.
  // The scan reads attribute values only, so text content may nest any number of parentheses.
  it("keeps a text label with deeply nested parentheses", () => {
    const label = `${"f(".repeat(40)}x${")".repeat(40)}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>`;

    expect(sanitizeMermaidSvg(svg, ID_PREFIX)).toBe(svg);
  });
});
