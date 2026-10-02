/**
 * Artifact kinds for the Artifacts tab (experiment: "artifacts").
 *
 * The kind is derived from the file extension only, so the backend listing and
 * the frontend renderer always agree without sniffing content. Kinds without a
 * rich renderer yet (html, svg, csv, mermaid) render as escaped source text
 * until their sandboxed/structured renderers land.
 */
export const ARTIFACT_KINDS = [
  "markdown",
  "json",
  "image",
  "html",
  "svg",
  "csv",
  "mermaid",
  "diff",
  "pdf",
  "canvas",
  "text",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

const EXTENSION_TO_KIND: Record<string, ArtifactKind> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonl: "json",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  html: "html",
  htm: "html",
  svg: "svg",
  csv: "csv",
  tsv: "csv",
  mmd: "mermaid",
  mermaid: "mermaid",
  diff: "diff",
  patch: "diff",
  pdf: "pdf",
};

/** Declarative canvas specs (Concept F) are JSON files with a dedicated suffix. */
const CANVAS_SUFFIX = ".canvas.json";

/** Image MIME types for kinds the renderer shows as <img> from a data: URL. */
const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function getArtifactKind(filePath: string): ArtifactKind {
  if (filePath.toLowerCase().endsWith(CANVAS_SUFFIX)) return "canvas";
  return EXTENSION_TO_KIND[extensionOf(filePath)] ?? "text";
}

/** Kinds whose bytes travel base64-encoded (binary formats). */
export function isBinaryArtifactKind(kind: ArtifactKind): boolean {
  return kind === "image" || kind === "pdf";
}

/** MIME type for image artifacts; null for every non-image kind. */
export function getArtifactImageMimeType(filePath: string): string | null {
  return IMAGE_EXTENSION_TO_MIME[extensionOf(filePath)] ?? null;
}
