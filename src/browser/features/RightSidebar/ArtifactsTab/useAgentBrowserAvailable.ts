import { useEffect, useState } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";

/**
 * Last answer per API client and workspace. The viewer remounts on every file change, so a
 * fresh mount starts from the last answer instead of flashing the warning in and out.
 */
const lastKnown = new WeakMap<APIClient, Map<string, boolean | null>>();

interface Answer {
  api: APIClient;
  workspaceId: string;
  value: boolean | null;
}

/**
 * Whether the agent can look at its own HTML artifacts (`agent-browser` on the runtime's PATH).
 * null while unknown, including when the probe or the request failed.
 */
export function useAgentBrowserAvailable(workspaceId: string): boolean | null {
  const { api } = useAPI();
  // The answer remembers which (api, workspace) it is for: after either changes, an answer for
  // the old pair must not show (a failed request for the new pair would otherwise keep it).
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // Promise.resolve() first, so a client without the route rejects instead of throwing here.
    Promise.resolve()
      .then(() => api.artifacts.capabilities({ workspaceId }))
      .then((result) => {
        const perClient = lastKnown.get(api) ?? new Map<string, boolean | null>();
        perClient.set(workspaceId, result.agentBrowserAvailable);
        lastKnown.set(api, perClient);
        if (!cancelled) setAnswer({ api, workspaceId, value: result.agentBrowserAvailable });
      })
      .catch(() => {
        // Unknown: no warning.
      });
    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);
  if (!api) return null;
  if (answer?.api === api && answer.workspaceId === workspaceId) return answer.value;
  return lastKnown.get(api)?.get(workspaceId) ?? null;
}
