#!/usr/bin/env bun
/**
 * Fails when a tracked CSS, HTML or SVG file declares the CSS `zoom` property. Safari lays a
 * zoomed element out differently from Chromium, and iPhone Safari painted a Mermaid diagram far
 * outside its frame. Size the element with explicit pixels computed in code instead (see
 * src/browser/features/Messages/mermaidDiagramBox.ts). TS and TSX are covered by
 * local/no-css-zoom. The docs site is not renderer code and is not scanned.
 *
 * Usage: bun scripts/check-no-css-zoom.ts   (or `make check-no-css-zoom`)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";
import postcss, { type Node } from "postcss";

type ParentNode = DefaultTreeAdapterMap["parentNode"];

// postcss leaves CSS escapes in a property name as written.
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})(?:\r\n|[ \t\n\r\f])?|([^\n\r\f]))/gi;
const VENDOR_PREFIX = /^-[a-z]+-/;
const REPLACEMENT_CHARACTER = "\ufffd";

function decodeCssEscapes(name: string): string {
  return name.replace(CSS_ESCAPE, (_escape, hex?: string, literal?: string) => {
    if (literal !== undefined) return literal;
    assert(hex !== undefined, "CSS_ESCAPE matched neither a hex nor a literal escape");
    const codePoint = Number.parseInt(hex, 16);
    const valid =
      codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : REPLACEMENT_CHARACTER;
  });
}

function isZoomProperty(property: string): boolean {
  return decodeCssEscapes(property).toLowerCase().replace(VENDOR_PREFIX, "") === "zoom";
}

// A Tailwind arbitrary property class such as `[zoom:2]` or `md:[zoom:2]`. Keep in sync with
// ZOOM_UTILITY in the local/no-css-zoom lint rule.
const ZOOM_UTILITY = /(?:^|[^\w-])\[(?:-[a-z]+-)?zoom:/i;
// HTML 4 hid a <style> block from old browsers with `<!--` and `-->`. CSS reads both as tokens
// to skip, postcss does not, and blanking them keeps every position.
const CDO_OR_CDC = /<!--|-->/g;

function startLine(node: Node): number {
  assert(node.source?.start, "postcss gave a node no position");
  return node.source.start.line;
}

function zoomLinesInCss(css: string): number[] {
  const lines: number[] = [];
  const root = postcss.parse(css.replace(CDO_OR_CDC, (token) => " ".repeat(token.length)));
  root.walkDecls((declaration) => {
    if (isZoomProperty(declaration.prop)) lines.push(startLine(declaration));
  });
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === "apply" && ZOOM_UTILITY.test(rule.params)) {
      lines.push(startLine(rule));
    }
  });
  return lines.sort((a, b) => a - b);
}

function attributeValue(
  element: DefaultTreeAdapterMap["element"],
  name: string
): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

// parse5 decodes character references (`&#10;` is a newline), so a line inside a decoded value
// need not be a line of the file. Markup hits report the line where the attribute or the <style>
// text starts.
function zoomLinesInElement(element: DefaultTreeAdapterMap["element"]): number[] {
  const location = element.sourceCodeLocation;
  const attributeLine = (name: string) =>
    location?.attrs?.[name]?.startLine ?? location?.startLine ?? 1;
  const lines: number[] = [];
  const style = attributeValue(element, "style");
  if (style !== undefined) {
    lines.push(...zoomLinesInCss(style).map(() => attributeLine("style")));
  }
  const classes = attributeValue(element, "class");
  if (classes !== undefined && ZOOM_UTILITY.test(classes)) lines.push(attributeLine("class"));
  if (element.tagName === "style") {
    const texts = element.childNodes.filter(defaultTreeAdapter.isTextNode);
    const line = texts[0]?.sourceCodeLocation?.startLine ?? location?.startLine ?? 1;
    lines.push(...zoomLinesInCss(texts.map((text) => text.value).join("")).map(() => line));
  }
  return lines;
}

function zoomLinesBelow(parent: ParentNode): number[] {
  // A <template>'s children live in its content fragment, not in childNodes.
  const children = "content" in parent ? parent.content.childNodes : parent.childNodes;
  return children.flatMap((child) =>
    defaultTreeAdapter.isElementNode(child)
      ? [...zoomLinesInElement(child), ...zoomLinesBelow(child)]
      : []
  );
}

export function findZoomDeclarations(file: string, source: string): number[] {
  switch (extname(file).toLowerCase()) {
    case ".css":
      return zoomLinesInCss(source);
    case ".html":
    case ".svg":
      // scriptingEnabled: false parses <noscript> content as elements, so its style attributes
      // are scanned too.
      return zoomLinesBelow(
        parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false })
      );
    default:
      throw new Error(`${file} is not a CSS, HTML or SVG file`);
  }
}

export function trackedStyleFiles(): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--", "*.css", "*.html", "*.svg", ":!docs"],
    { encoding: "utf8" }
  );
  return listed.split("\0").filter((file) => file !== "");
}

if (import.meta.main) {
  const files = trackedStyleFiles();
  if (files.length === 0) {
    console.error("Error: check-no-css-zoom found no tracked CSS, HTML or SVG files to scan");
    process.exit(1);
  }
  const found: string[] = [];
  const unparsable: string[] = [];
  for (const file of files) {
    try {
      for (const line of findZoomDeclarations(file, readFileSync(file, "utf8"))) {
        found.push(`${file}:${line}`);
      }
    } catch (error) {
      unparsable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (unparsable.length > 0) {
    console.error(`Error: could not parse these files:\n  ${unparsable.join("\n  ")}`);
  }
  if (found.length > 0) {
    console.error(
      `Error: do not declare the CSS zoom property. In HTML and SVG the line is where the style or class attribute, or the <style> text, starts:\n  ${found.join("\n  ")}`
    );
    console.error(
      "Safari lays out a zoomed element differently from Chromium. Size the element with explicit pixels computed in code (src/browser/features/Messages/mermaidDiagramBox.ts)."
    );
  }
  if (found.length > 0 || unparsable.length > 0) process.exit(1);
  console.log(`check-no-css-zoom: ${files.length} CSS, HTML and SVG files, no zoom declaration`);
}
