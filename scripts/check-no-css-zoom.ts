#!/usr/bin/env bun
/**
 * Fails when a tracked CSS or HTML file declares the CSS `zoom` property. Safari lays a zoomed
 * element out differently from Chromium, and iPhone Safari painted a Mermaid diagram far outside
 * its frame. Size the element with explicit pixels computed in code instead (see
 * src/browser/features/Messages/mermaidDiagramBox.ts). TS and TSX are covered by
 * local/no-css-zoom. The docs site is not renderer code and is not scanned.
 *
 * Usage: bun scripts/check-no-css-zoom.ts   (or `make check-no-css-zoom`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Blanks CSS and HTML comments but keeps their newlines, so line numbers stay true. */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\n]/g, " ")
  );
}

// A property name follows `{`, `;` or the quote that opens a style attribute. A selector
// (`.zoom:hover`, `a.zoom::after`), a custom property (`--diagram-zoom:`), a value
// (`touch-action: pinch-zoom`) and another name (`a_zoom:`) never do. `-webkit-zoom` counts.
const ZOOM_PROPERTY = /[{;"']\s*(?:-[a-z]+-)?zoom\s*:/gi;

/** The 1-based line of each `zoom` declaration in a CSS or HTML source. */
export function findZoomDeclarations(source: string): number[] {
  const text = blankComments(source);
  return Array.from(text.matchAll(ZOOM_PROPERTY), (match) => {
    const zoomAt = match.index + match[0].toLowerCase().lastIndexOf("zoom");
    return text.slice(0, zoomAt).split("\n").length;
  });
}

/** Tracked CSS and HTML files that this check scans. */
export function trackedStyleFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--", "*.css", "*.html", ":!docs"], {
    encoding: "utf8",
  });
  return listed.split("\0").filter((file) => file !== "");
}

if (import.meta.main) {
  const files = trackedStyleFiles();
  const found = files.flatMap((file) =>
    findZoomDeclarations(readFileSync(file, "utf8")).map((line) => `${file}:${line}`)
  );
  if (found.length > 0) {
    console.error(`Error: do not declare the CSS zoom property:\n  ${found.join("\n  ")}`);
    console.error(
      "Safari lays out a zoomed element differently from Chromium. Size the element with explicit pixels computed in code (src/browser/features/Messages/mermaidDiagramBox.ts)."
    );
    process.exit(1);
  }
  console.log(`check-no-css-zoom: ${files.length} CSS and HTML files, no zoom declaration`);
}
