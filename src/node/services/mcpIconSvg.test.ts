import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { sanitizeMcpIconSvg } from "./mcpIconSvg";

const wrap = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${content}</svg>`;

describe("strict MCP SVG boundary", () => {
  test("re-serializes the unchanged Notion geometry and renders a nonblank PNG", async () => {
    const fixture = readFileSync(
      path.resolve(__dirname, "../../../tests/fixtures/mcp/notion-icon.svg"),
      "utf8"
    );
    const svg = sanitizeMcpIconSvg(fixture);
    expect(svg).not.toBeNull();
    expect(svg).not.toBe(fixture);
    const png = await sharp(Buffer.from(svg!)).resize(64, 64, { fit: "inside" }).png().toBuffer();
    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBeLessThanOrEqual(64);
    expect(info.height).toBeLessThanOrEqual(64);
    const alphas = data.filter((_, index) => index % 4 === 3);
    expect(alphas.some((alpha) => alpha > 0)).toBe(true);
    // Both light and dark opaque pixels are necessary for the actual logo, not a blank rectangle.
    expect(data.some((value, index) => index % 4 === 0 && value < 50 && data[index + 3] > 0)).toBe(
      true
    );
    expect(data.some((value, index) => index % 4 === 0 && value > 200 && data[index + 3] > 0)).toBe(
      true
    );
  });

  test("permits only geometry, numeric transforms, and predefined escaped text", () => {
    const svg = sanitizeMcpIconSvg(
      `<?xml version="1.0"?>${wrap('<title>A &amp; &lt;B&gt;</title><g transform="translate(1, 2) scale(2)"><path d="M0 0L1.5 2e1Z" fill="#fff" clip-rule="evenodd"/><rect width="1px" height="2" fill="currentColor" opacity="0.5"/></g>')}`
    );
    expect(svg).not.toBeNull();
    expect(svg).toContain("A &amp; &lt;B&gt;");
  });

  test.each([
    "<script/>",
    "<style/>",
    "<image/>",
    "<use/>",
    "<foreignObject/>",
    "<clipPath/>",
    "<!-- comment -->",
    "<![CDATA[geometry]]>",
    "<?other instruction?>",
    '<g xmlns="urn:foreign"/>',
    '<x:g xmlns:x="http://www.w3.org/2000/svg"/>',
    '<g xmlns:x="urn:foreign"/>',
    '<path href="https://example.com"/>',
    '<path xlink:href="#a" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
    '<path onload="run()"/>',
    '<path style="fill:red"/>',
    '<path clip-path="url(#a)"/>',
    '<path unknown="1"/>',
    "<path/><svg/>",
    "<g></path>",
    '<path d="M0 0" d="M1 1"/>',
    "<title>&unknown;</title>",
    "<title>&#65;</title>",
  ])("rejects unsupported XML or features: %s", (content) => {
    expect(sanitizeMcpIconSvg(wrap(content))).toBeNull();
  });

  test.each([
    'fill="url(#a)"',
    'fill="URL(#a)"',
    'fill="u\\72l(#a)"',
    'fill="&#117;rl(#a)"',
    'fill="var(--x)"',
    'fill="rgb(0,0,0)"',
    'fill="red/*x*/"',
    'fill="notacolor"',
    'width="Infinity"',
    'width="NaN"',
    'width="1000000"',
    'width="1em"',
    'opacity="1.1"',
    'fill-opacity="-1"',
    'd="M1e999 0"',
    'd="M1000000 0"',
    'd="url(#a)"',
    'transform="translate(url(#a))"',
    'transform="matrix(1,0,0,1,Infinity,0)"',
    'transform="translate(1)junk"',
    'transform="scale()"',
    'transform="matrix(1)"',
    'viewBox="0 0 1"',
    'viewBox="0 0 1 Infinity"',
    'stroke-linecap="unexpected"',
    'fill-rule="inherit"',
    'clip-rule="url(#a)"',
  ])("rejects unsupported attribute values: %s", (attribute) => {
    expect(sanitizeMcpIconSvg(wrap(`<path ${attribute}/>`))).toBeNull();
  });

  test("bounds XML bytes, depth, nodes, attributes, and declarations", () => {
    for (const svg of [
      '<!DOCTYPE svg [<!ENTITY test SYSTEM "file:///etc/passwd">]>' + wrap(""),
      wrap("<g>".repeat(16) + "</g>".repeat(16)),
      wrap("<path/>".repeat(1000)),
      wrap(`<path d="${"M0 0 ".repeat(7000)}"/>`),
      wrap(`<title>${"x".repeat(256 * 1024)}</title>`),
      wrap("") + wrap(""),
      '<svg xmlns="urn:other"/>',
      "<svg/>",
      '<g xmlns="http://www.w3.org/2000/svg"/>',
    ])
      expect(sanitizeMcpIconSvg(svg)).toBeNull();
  });
});
