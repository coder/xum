import type { ArtifactReadResult } from "@/common/orpc/schemas/artifacts";
import { getArtifactImageMimeType } from "@/common/utils/artifactKind";
import { resolveArtifactReference } from "./artifactPaths";

/**
 * Bounded loading of files an artifact references by relative path (Markdown images, HTML
 * images/CSS/scripts). Reads go through api.artifacts.read, so the backend's containment and
 * read cap still apply; these caps keep one artifact from pulling in an unbounded amount.
 */
export const ARTIFACT_ASSET_LIMITS = {
  maxAssets: 32,
  maxAssetBytes: 5 * 1024 * 1024,
  maxTotalBytes: 15 * 1024 * 1024,
} as const;

export type ArtifactAssetReader = (path: string) => Promise<ArtifactReadResult | null>;

export type LoadedArtifactAsset =
  | { status: "ok"; path: string; result: Extract<ArtifactReadResult, { status: "ok" }> }
  | { status: "skipped"; reason: string };

export type ArtifactAssetLoader = ReturnType<typeof createArtifactAssetLoader>;

/**
 * Tracks the per-artifact asset budget. Create one per render of an artifact and route every
 * relative reference through `load`.
 */
export function createArtifactAssetLoader(fromArtifactPath: string, read: ArtifactAssetReader) {
  let assets = 0;
  let totalBytes = 0;
  const cache = new Map<string, Promise<LoadedArtifactAsset>>();
  // What each counted path holds in the budget, so `reload` can give it back.
  const charges = new Map<string, number>();

  const loadResolved = async (path: string): Promise<LoadedArtifactAsset> => {
    if (assets >= ARTIFACT_ASSET_LIMITS.maxAssets) {
      return { status: "skipped", reason: "too many assets" };
    }
    assets += 1;
    charges.set(path, 0);
    let result: ArtifactReadResult | null;
    try {
      result = await read(path);
    } catch {
      result = null;
    }
    if (result == null) return { status: "skipped", reason: "not found" };
    if (result.status !== "ok") return { status: "skipped", reason: "not readable" };
    if (result.size > ARTIFACT_ASSET_LIMITS.maxAssetBytes) {
      return { status: "skipped", reason: "too large" };
    }
    if (totalBytes + result.size > ARTIFACT_ASSET_LIMITS.maxTotalBytes) {
      return { status: "skipped", reason: "asset size limit reached" };
    }
    totalBytes += result.size;
    charges.set(path, result.size);
    return { status: "ok", path, result };
  };

  const load = (ref: string): Promise<LoadedArtifactAsset> => {
    const path = resolveArtifactReference(fromArtifactPath, ref);
    if (path == null) return Promise.resolve({ status: "skipped", reason: "not relative" });
    let pending = cache.get(path);
    if (pending == null) {
      pending = loadResolved(path);
      cache.set(path, pending);
    }
    return pending;
  };

  return {
    /** Load a reference found in the artifact. Non-relative references are never read. */
    load,
    /**
     * Read a reference again (its file may have changed). The earlier read's share of the budget
     * is given back first, so refreshes never use the budget up; other cached references stay.
     */
    async reload(ref: string): Promise<LoadedArtifactAsset> {
      const path = resolveArtifactReference(fromArtifactPath, ref);
      const previous = path == null ? undefined : cache.get(path);
      if (path != null && previous != null) {
        await previous;
        // A concurrent reload of the same path may have replaced it already.
        if (cache.get(path) === previous) {
          cache.delete(path);
          const charge = charges.get(path);
          if (charge != null) {
            assets -= 1;
            totalBytes -= charge;
            charges.delete(path);
          }
        }
      }
      return load(ref);
    },
  };
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** data: URL for an image asset, or null when the file is not a supported image. */
export function toImageDataUrl(
  result: Extract<ArtifactReadResult, { status: "ok" }>
): string | null {
  if (result.kind === "image" && result.encoding === "base64") {
    const mime = getArtifactImageMimeType(result.path);
    return mime == null ? null : `data:${mime};base64,${result.content}`;
  }
  if (result.kind === "svg" && result.encoding === "utf8") {
    return `data:image/svg+xml;base64,${utf8ToBase64(result.content)}`;
  }
  return null;
}
