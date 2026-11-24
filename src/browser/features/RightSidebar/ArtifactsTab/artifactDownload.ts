import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactImageMimeType } from "@/common/utils/artifactKind";
import { artifactBasename } from "./artifactPaths";

type OkReadResult = Extract<ArtifactReadResult, { status: "ok" }>;

function mimeTypeFor(result: OkReadResult): string {
  if (result.kind === "pdf") return "application/pdf";
  if (result.kind === "image")
    return getArtifactImageMimeType(result.path) ?? "application/octet-stream";
  // Text kinds download as plain text: the browser must never sniff them into HTML.
  return "text/plain;charset=utf-8";
}

/** Blob of the artifact's bytes from an already completed read (no extra backend route). */
export function artifactToBlob(result: OkReadResult): Blob {
  if (result.encoding === "base64") {
    const binary = atob(result.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeTypeFor(result) });
  }
  return new Blob([result.content], { type: mimeTypeFor(result) });
}

export function downloadArtifact(result: OkReadResult) {
  const url = URL.createObjectURL(artifactToBlob(result));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifactBasename(result.path);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next task: the click has started the download by then.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Open the artifact in a new browser window (the browser's own PDF viewer). Not offered in
 * the desktop app, whose window-open handler only forwards http(s) URLs to the OS.
 */
export function openArtifactInNewWindow(result: OkReadResult) {
  const url = URL.createObjectURL(artifactToBlob(result));
  window.open(url, "_blank", "noopener");
  // The new window loads the blob asynchronously; keep the URL alive long enough for that.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
