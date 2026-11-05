#!/usr/bin/env bun
/**
 * Fails when a tracked CSS, HTML or SVG file declares the CSS `zoom` property. Safari lays a
 * zoomed element out differently from Chromium, and iPhone Safari painted a Mermaid diagram far
 * outside its frame. Size the element with explicit pixels computed in code instead (see
 * src/browser/features/Messages/mermaidDiagramBox.ts). TS and TSX are covered by
 * local/no-css-zoom. The docs site is not renderer code and is not scanned.
 *
 * The files are parsed, not text-scanned: a text scan has to guess where comments, strings,
 * escapes and nesting begin, and each guess missed a spelling. CSS goes through postcss. HTML and
 * SVG go through parse5, which finds each `style` attribute and `<style>` element, and decodes
 * character references the way a browser does. A file that does not parse fails the check.
 *
 * Usage: bun scripts/check-no-css-zoom.ts   (or `make check-no-css-zoom`)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";

type ParentNode = DefaultTreeAdapterMap["parentNode"];

// One CSS escape: `\` plus 1-6 hex digits and one optional whitespace, or `\` plus any other
// character, which stands for itself. postcss leaves both in a property name as written.
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

/** The 1-based line of each `zoom` declaration in `css`, whose first line is `firstLine`. */
function zoomLinesInCss(css: string, firstLine: number): number[] {
  const lines: number[] = [];
  postcss.parse(css).walkDecls((declaration) => {
    if (!isZoomProperty(declaration.prop)) return;
    assert(declaration.source?.start, "postcss gave a declaration no position");
    lines.push(firstLine + declaration.source.start.line - 1);
  });
  return lines;
}

function zoomLinesInElement(element: DefaultTreeAdapterMap["element"]): number[] {
  const lines: number[] = [];
  const location = element.sourceCodeLocation;
  const style = element.attrs.find((attribute) => attribute.name === "style");
  if (style !== undefined) {
    const line = location?.attrs?.style?.startLine ?? location?.startLine ?? 1;
    lines.push(...zoomLinesInCss(style.value, line));
  }
  if (element.tagName === "style") {
    const texts = element.childNodes.filter(defaultTreeAdapter.isTextNode);
    const line = texts[0]?.sourceCodeLocation?.startLine ?? location?.startLine ?? 1;
    lines.push(...zoomLinesInCss(texts.map((text) => text.value).join(""), line));
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

/** The 1-based line of each `zoom` declaration in a `.css`, `.html` or `.svg` source. */
export function findZoomDeclarations(file: string, source: string): number[] {
  switch (extname(file).toLowerCase()) {
    case ".css":
      return zoomLinesInCss(source, 1);
    case ".html":
    case ".svg":
      // scriptingEnabled: false parses <noscript> content as elements, as a browser without scripts does.
      return zoomLinesBelow(
        parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false })
      );
    default:
      throw new Error(`${file} is not a CSS, HTML or SVG file`);
  }
}

/** Tracked CSS, HTML and SVG files that this check scans. */
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
    console.error(`Error: do not declare the CSS zoom property:\n  ${found.join("\n  ")}`);
    console.error(
      "Safari lays out a zoomed element differently from Chromium. Size the element with explicit pixels computed in code (src/browser/features/Messages/mermaidDiagramBox.ts)."
    );
  }
  if (found.length > 0 || unparsable.length > 0) process.exit(1);
  console.log(`check-no-css-zoom: ${files.length} CSS, HTML and SVG files, no zoom declaration`);
}
