import { readFileSync } from "node:fs";
import * as path from "node:path";

// Icons the branded fixtures self-report, in the shape servers commonly use:
// inline data URLs. Nothing here is trusted by the app until the icon pipeline
// has fetched, sniffed, decoded, and re-encoded it.

/** Notion's real SVG logo, exercising the SVG rasterization path. */
export const NOTION_SVG_ICON = {
  src: `data:image/svg+xml;base64,${readFileSync(
    path.join(import.meta.dir, "notion-icon.svg")
  ).toString("base64")}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

/** Smallest valid PNG (one transparent pixel), exercising the raster path. */
export const PIXEL_PNG_ICON = {
  src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  mimeType: "image/png",
  sizes: ["1x1"],
};
