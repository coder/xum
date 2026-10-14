import { useEffect, useMemo, useRef } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
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

/** The hook's view of the connection: the current client, and reads waiting for one. */
interface ReaderConnection {
  api: APIClient | null;
  waiters: Array<() => void>;
}

/** The connected client, other than `previous` (the client a cut-off read used). */
function nextClient(connection: ReaderConnection, previous: APIClient | null): Promise<APIClient> {
  return connection.api != null && connection.api !== previous
    ? Promise.resolve(connection.api)
    : new Promise((resolve) =>
        connection.waiters.push(() => resolve(nextClient(connection, previous)))
      );
}

function createConnectedReader(
  connection: ReaderConnection,
  workspaceId: string
): ArtifactAssetReader {
  return async (path: string) => {
    let previous: APIClient | null = null;
    for (;;) {
      const client = await nextClient(connection, previous);
      try {
        return await readArtifactAsset(client, workspaceId, path);
      } catch (error) {
        // Only a read the connection drop cut off is retried, once a new client is there. The
        // socket close rejects it as an abort before React publishes `api: null`, so the client
        // may still look current; the reader passes no signal, so no other abort reaches here.
        // Waiting for a different client keeps a closed socket's instant rejections from
        // looping.
        if (connection.api === client && !isAbortError(error)) throw error;
        previous = client;
      }
    }
  };
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
 * client. A read made while offline waits for the reconnect, and a read the drop cut off runs
 * again on the next client: answering either with "missing" would cache the file as not found
 * and replace data already on screen with an error.
 */
export function useArtifactAssetReader(workspaceId: string | null): ArtifactAssetReader | null {
  const { api } = useAPI();
  const connectionRef = useRef<ReaderConnection>({ api, waiters: [] });
  useEffect(() => {
    const connection = connectionRef.current;
    connection.api = api;
    if (!api) return;
    const waiters = connection.waiters;
    connection.waiters = [];
    for (const wake of waiters) wake();
  }, [api]);
  return useMemo(
    () => (workspaceId == null ? null : createConnectedReader(connectionRef.current, workspaceId)),
    [workspaceId]
  );
}
