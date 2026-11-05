import { describe, expect, test } from "bun:test";
import { findZoomDeclarations, trackedStyleFiles } from "./check-no-css-zoom";

describe("findZoomDeclarations", () => {
  test.each([
    [
      "main's Mermaid rule",
      ".mermaid-container > svg {\n  max-height: 300px;\n  zoom: var(--diagram-zoom, 1);\n}",
    ],
    ["a style attribute in double quotes", '<div style="zoom: 2">x</div>'],
    ["a style attribute in single quotes", "<div style='zoom:2'>x</div>"],
    ["a declaration after another one in an attribute", '<div style="width:1px;zoom:2">x</div>'],
    ["an unquoted style attribute", "<div style=zoom:2>x</div>"],
    ["a compact rule", ".x{zoom:2}"],
    ["upper case with a space before the colon", ".x { ZOOM : 2; }"],
    ["a declaration after a semicolon", ".x { color: red;zoom: 2 }"],
    ["a vendor prefix", ".x { -webkit-zoom: 2; }"],
    ["a nested rule", ".x { .y { zoom: 1 } }"],
  ])("finds %s", (_name, source) => {
    expect(findZoomDeclarations(source)).toHaveLength(1);
  });

  test.each([
    ["a custom property", ".x { --diagram-zoom: 1; }"],
    ["a value", ".x { touch-action: pinch-zoom; }"],
    ["another name", ".x { a_zoom: 1; zoomed: 2; }"],
    ["a class selector", ".zoom:hover { color: red; }"],
    ["a pseudo-element selector", "a.zoom::after { content: ''; }"],
    ["a selector after a rule", ".a { color: red; }\n.zoom:hover { color: blue; }"],
    ["a tag selector after a rule", ".a { color: red; }\nzoom:hover { color: blue; }"],
    ["a CSS comment", "/* zoom: 1 */ .x { color: red; }"],
    ["a multi-line CSS comment", ".x {\n  /*\n   zoom: 2;\n  */\n  color: red;\n}"],
    ["an HTML comment", '<!-- style="zoom: 2" -->'],
    ["a media feature", "@media (zoom: 1) { .x { color: red; } }"],
    ["text", "<p>zoom: 2 steps</p>"],
  ])("ignores %s", (_name, source) => {
    expect(findZoomDeclarations(source)).toEqual([]);
  });

  test("reports the line of the declaration, past comments and blank lines", () => {
    const source = ".a {\n  /* one\n  two */\n  color: red;\n\n  zoom: 2;\n}\n.b { zoom: 3 }";
    expect(findZoomDeclarations(source)).toEqual([6, 8]);
  });
});

describe("trackedStyleFiles", () => {
  test("lists the renderer's CSS and HTML but not the docs site", () => {
    const files = trackedStyleFiles();
    expect(files).toContain("src/browser/styles/transcript-content.css");
    expect(files).toContain("static/splash.html");
    expect(files.filter((file) => file.startsWith("docs/"))).toEqual([]);
  });
});
