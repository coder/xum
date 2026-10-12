import { useEffect, useMemo, useRef } from "react";
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
 * and tests run without the compiler.
 *
 * It also keeps its identity across a dropped connection. The API is `null` while Xum reconnects
 * and a new client afterwards; a reader tied to either rebuilt every HTML artifact twice (losing
 * its in-page state) and blanked canvas file blocks. So the reader reads through the latest
 * client, and a read made while offline fails like a missing file.
 */
export function useArtifactAssetReader(workspaceId: string | null): ArtifactAssetReader | null {
  const { api } = useAPI();
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  return useMemo(
    () =>
      workspaceId == null
        ? null
        : (path: string) => {
            const client = apiRef.current;
            return client == null
              ? Promise.resolve(null)
              : readArtifactAsset(client, workspaceId, path);
          },
    [workspaceId]
  );
}
