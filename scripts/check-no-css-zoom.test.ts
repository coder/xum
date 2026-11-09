import { describe, expect, test } from "bun:test";
import { findZoomDeclarations, trackedStyleFiles } from "./check-no-css-zoom";

describe("findZoomDeclarations", () => {
  test.each([
    ["a CSS rule", "a.css", ".x {\n  zoom: var(--diagram-zoom, 1);\n}"],
    ["an upper case name with a space before the colon", "a.css", ".x { ZOOM : 2; }"],
    ["a rule inside an at-rule", "a.css", "@media (min-width: 1px) { .x { zoom: 2 } }"],
    ["a nested rule", "a.css", ".x { .y { zoom: 1 } }"],
    ["a declaration after a nested rule", "a.css", ".x { &.y { color: red } zoom: 2; }"],
    ["a vendor prefix", "a.css", ".x { -webkit-zoom: 2; }"],
    ["a hex escape", "a.css", ".x { z\\6f om: 2; }"],
    ["a Tailwind arbitrary property in @apply", "a.css", ".x { @apply p-2 md:[zoom:2]; }"],
    ["an escape of a letter", "a.css", ".x { zo\\om: 2; }"],
    ["an escaped vendor prefix", "a.css", ".x { \\2d webkit-zoom: 2; }"],
    ["a style attribute", "a.html", '<div style="width:1px; zoom: 2">x</div>'],
    ["an unquoted style attribute", "a.html", "<div style=zoom:2>x</div>"],
    ["a character reference in a style attribute", "a.html", '<div style="&#122;oom: 2">x</div>'],
    [
      "a Tailwind arbitrary property in a class attribute",
      "a.html",
      '<div class="p-2 md:[zoom:2]">x</div>',
    ],
    ["a style element", "a.html", "<style>.x { zoom: 2 }</style>"],
    [
      "a style element in a legacy comment wrapper",
      "a.html",
      "<style><!--\n.x { zoom: 2 }\n--></style>",
    ],
    ["a style attribute in a template", "a.html", '<template><b style="zoom:2"></b></template>'],
    ["a style attribute in a noscript", "a.html", '<noscript><b style="zoom:2"></b></noscript>'],
    ["a style attribute in an SVG", "a.svg", '<svg style="zoom: 2" viewBox="0 0 1 1"></svg>'],
    ["a style element in an SVG", "a.svg", "<svg><style>.x { zoom: 2 }</style></svg>"],
    [
      "a CDATA style element in an SVG",
      "a.svg",
      "<svg><style><![CDATA[.x { zoom: 2 }]]></style></svg>",
    ],
  ])("finds %s", (_name, file, source) => {
    expect(findZoomDeclarations(file, source)).toHaveLength(1);
  });

  test.each([
    ["a class selector", "a.css", ".zoom:hover { color: red; }"],
    [
      "a tag selector with a pseudo-class",
      "a.css",
      "a { color: red; }\nzoom:hover { color: blue; }",
    ],
    ["a custom property", "a.css", ".x { --diagram-zoom: 1; --zoom: 2; }"],
    ["a longer property name", "a.css", ".x { touch-action: pinch-zoom; zoomed: 2; a-zoom: 3; }"],
    ["a CSS comment", "a.css", "/* zoom: 1 */ .x { color: red; }"],
    ["a quoted string", "a.css", '.x::after { content: "Zoom: 100%"; }'],
    ["a media feature", "a.css", "@media (zoom: 1) { .x { color: red; } }"],
    ["an HTML comment", "a.html", '<!-- <div style="zoom: 2"> -->'],
    [
      "an attribute that is not style",
      "a.html",
      '<input placeholder="Zoom: 100%" data-style="zoom: 2">',
    ],
    ["HTML text", "a.html", "<p>Zoom: 100%</p><script>el.style.cssText = 'zoom: 2';</script>"],
    [
      "a style attribute without zoom",
      "a.html",
      '<div style="--diagram-zoom: 2; width: 1px">x</div>',
    ],
    ["a class selector in a style element", "a.html", "<style>.zoom:hover { color: red }</style>"],
    [
      "a style element in a legacy comment wrapper",
      "a.html",
      "<style><!--\n.x { color: red }\n--></style>",
    ],
    [
      "a Tailwind class that is not the zoom property",
      "a.html",
      '<div class="[--diagram-zoom:2] zoom-in-95">x</div>',
    ],
    ["an @apply without zoom", "a.css", ".x { @apply p-2 zoom-in-95; }"],
    ["SVG text", "a.svg", "<svg><text>Zoom: 100%</text></svg>"],
  ])("ignores %s", (_name, file, source) => {
    expect(findZoomDeclarations(file, source)).toEqual([]);
  });

  test("reports the line of each declaration, past comments and blank lines", () => {
    const css = ".a {\n  /* one\n  two */\n  color: red;\n\n  zoom: 2;\n}\n.b { zoom: 3 }";
    expect(findZoomDeclarations("a.css", css)).toEqual([6, 8]);
  });

  test("reports the line where a style attribute or a style element starts", () => {
    const html =
      '<html>\n<head>\n<style>\n.a {\n  zoom: 2;\n}\n</style>\n</head>\n<body>\n<div\n  style="color: red;&#10;zoom: 2">x</div>\n</body>\n</html>';
    expect(findZoomDeclarations("a.html", html)).toEqual([3, 11]);
  });

  test("fails on CSS that does not parse, since a file it cannot read is not proven clean", () => {
    expect(() => findZoomDeclarations("a.css", ".x { zoom: 2;")).toThrow();
    expect(() => findZoomDeclarations("a.html", '<div style="color"></div>')).toThrow();
  });
});

describe("trackedStyleFiles", () => {
  test("lists the renderer's CSS, HTML and SVG but not the docs site", () => {
    const files = trackedStyleFiles();
    expect(files).toContain("src/browser/styles/transcript-content.css");
    expect(files).toContain("static/splash.html");
    expect(files).toContain("src/browser/assets/logos/xum-logo-dark.svg");
    expect(files.filter((file) => file.startsWith("docs/"))).toEqual([]);
  });
});
