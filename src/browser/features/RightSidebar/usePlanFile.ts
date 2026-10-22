import { useEffect, useRef, useState } from "react";
import assert from "@/common/utils/assert";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import { isConnectionLostError } from "@/browser/contexts/connectionLink";
import { getErrorMessage } from "@/common/utils/errors";

export type PlanRead =
  | { status: "ok"; content: string; path: string }
  | { status: "error"; error: string }
  /** Cut off by a lost connection (ConnectionLostError): not a plan error. */
  | { status: "lost" };

export async function readPlan(api: APIClient, workspaceId: string): Promise<PlanRead> {
  try {
    const result = await api.workspace.getPlanContent({ workspaceId });
    if (!result.success) {
      return { status: "error", error: result.error };
    }
    assert(result.data.path.length > 0, "Plan path should be non-empty");
    return { status: "ok", content: result.data.content, path: result.data.path };
  } catch (error: unknown) {
    return isConnectionLostError(error)
      ? { status: "lost" }
      : { status: "error", error: getErrorMessage(error) };
  }
}

/**
 * The workspace's plan file, read through `workspace.getPlanContent` and read again whenever
 * `refreshKey` changes (the plan has no push channel). A plan already on screen stays while
 * the next read is in flight, and offline (no client during a reconnect): the new client's
 * read then replaces it in the background. A read that fails clears it. Without a plan on
 * screen, a read shows the loading state first.
 */
export function usePlanFile(workspaceId: string, refreshKey = 0) {
  const { api } = useAPI();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  // True once a plan is on screen: offline (no client during a reconnect) then keeps it.
  const hasPlanRef = useRef(false);

  useEffect(() => {
    assert(workspaceId.trim().length > 0, "workspaceId is required to load plan preview");

    if (!api) {
      if (!hasPlanRef.current) {
        setIsLoading(false);
        setError("API unavailable");
      }
      return;
    }

    // A read with a client replaces the offline error. Without a plan on screen, it shows
    // "Loading plan…" (the view may have opened while there was no client).
    setError(null);
    if (!hasPlanRef.current) {
      setIsLoading(true);
    }

    let cancelled = false;

    void readPlan(api, workspaceId).then((read) => {
      // A lost connection (or this effect's own cleanup) keeps what is shown for the next client.
      if (cancelled || read.status === "lost") {
        return;
      }
      setIsLoading(false);
      if (read.status === "error") {
        // The plan is gone or unreadable now (deleted after it was shown, a runtime that went
        // away): nothing stale stays behind the error, so the actions disable, and the next read
        // starts from the loading state.
        setError(read.error);
        setContent(null);
        setPath(null);
        hasPlanRef.current = false;
        return;
      }
      setError(null);
      setContent(read.content);
      setPath(read.path);
      hasPlanRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId, refreshKey]);

  return { isLoading, error, content, path };
}
