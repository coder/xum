import { useMemo } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { ARTIFACT_ASSET_LIMITS, type ArtifactAssetReader } from "./artifactAssets";

async function readArtifactAsset(api: APIClient, workspaceId: string, path: string) {
  // The per-asset cap travels with the read, so an oversize asset comes back too_large
  // without its bytes instead of being transferred and dropped here.
  const result = await api.artifacts.read({
    workspaceId,
    path,
    maxBytes: ARTIFACT_ASSET_LIMITS.maxAssetBytes,
  });
  return result.success ? result.data : null;
}

/**
 * Reader for files an artifact references, through the same size-capped artifacts.read route.
 * A null workspaceId turns relative assets off (pinned checkout files: their neighbours are not
 * in the artifacts folder and need not be pinned).
 *
 * The reader must keep its identity across renders: renderers list it in effect dependencies
 * and those effects set state, so an unstable reader rebuilt the document (or re-read images) in
 * an endless loop. useMemo is for that identity, not for speed: without it the React Compiler
 * memoized on `api.artifacts`, which the oRPC client returns as a fresh proxy on every access,
 * and tests run without the compiler. The closure touches only `api`, which is stable.
 */
export function useArtifactAssetReader(workspaceId: string | null): ArtifactAssetReader | null {
  const { api } = useAPI();
  return useMemo(
    () =>
      !api || workspaceId == null
        ? null
        : (path: string) => readArtifactAsset(api, workspaceId, path),
    [api, workspaceId]
  );
}
