import { useAPI } from "@/browser/contexts/API";
import { ARTIFACT_ASSET_LIMITS, type ArtifactAssetReader } from "./artifactAssets";

/** Reader for files an artifact references, through the same size-capped artifacts.read route. */
export function useArtifactAssetReader(workspaceId: string): ArtifactAssetReader | null {
  const { api } = useAPI();
  if (!api) return null;
  return async (path) => {
    // The per-asset cap travels with the read, so an oversize asset comes back too_large
    // without its bytes instead of being transferred and dropped here.
    const result = await api.artifacts.read({
      workspaceId,
      path,
      maxBytes: ARTIFACT_ASSET_LIMITS.maxAssetBytes,
    });
    return result.success ? result.data : null;
  };
}
