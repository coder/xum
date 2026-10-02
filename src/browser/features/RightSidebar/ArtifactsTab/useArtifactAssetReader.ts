import { useAPI } from "@/browser/contexts/API";
import { ARTIFACT_ASSET_LIMITS, type ArtifactAssetReader } from "./artifactAssets";

/**
 * Reader for files an artifact references, through the same size-capped artifacts.read route.
 * A null workspaceId turns relative assets off (pinned checkout files: their neighbours are not
 * in the artifacts folder and need not be pinned).
 */
export function useArtifactAssetReader(workspaceId: string | null): ArtifactAssetReader | null {
  const { api } = useAPI();
  if (!api || workspaceId == null) return null;
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
