/**
 * Path helpers for artifact-relative references (Markdown images, HTML assets).
 *
 * Artifact paths are POSIX paths relative to the artifacts dir. A reference inside an
 * artifact resolves against that artifact's folder and must stay inside the artifacts dir;
 * the backend enforces containment again on every read.
 */

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

export type ArtifactReferenceKind = "relative" | "data" | "external";

/** Classify a src/href value found inside an artifact. */
export function classifyArtifactReference(ref: string): ArtifactReferenceKind {
  const trimmed = ref.trim();
  if (/^data:/i.test(trimmed)) return "data";
  // Scheme URLs, protocol-relative URLs and root-absolute paths cannot be read from the
  // artifacts dir.
  if (URL_SCHEME_PATTERN.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    return "external";
  }
  return "relative";
}

/** Folder of an artifact path ("" for files at the root). */
export function artifactDirname(artifactPath: string): string {
  const slash = artifactPath.lastIndexOf("/");
  return slash < 0 ? "" : artifactPath.slice(0, slash);
}

/**
 * Resolve `ref` against the folder of `fromArtifactPath`. Returns the artifacts-dir-relative
 * path, or null when the reference is not relative or would leave the artifacts dir.
 */
export function resolveArtifactReference(fromArtifactPath: string, ref: string): string | null {
  if (classifyArtifactReference(ref) !== "relative") return null;
  // Query strings and fragments mean nothing for a file read.
  let pathPart = ref.trim().replace(/[?#].*$/, "");
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (pathPart.length === 0 || pathPart.includes("\\") || pathPart.includes("\0")) return null;

  const segments = artifactDirname(fromArtifactPath).split("/").filter(Boolean);
  for (const segment of pathPart.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
}

export function artifactBasename(artifactPath: string): string {
  return artifactPath.slice(artifactPath.lastIndexOf("/") + 1);
}
