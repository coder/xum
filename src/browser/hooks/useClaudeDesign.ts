import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";

interface ClaudeDesign {
  enabled: boolean;
  /** Settings revisions also cover sibling Disconnect, source, and allowlist changes. */
  revision: number;
}

/**
 * Claude Design enablement from the ordered Design stream, not the config snapshot: credential
 * controls may hide only after the backend retired affected clients, which this stream reports,
 * and the snapshot can arrive first.
 */
export function useClaudeDesign(): ClaudeDesign {
  const { api } = useAPI();
  const [design, setDesign] = useState<ClaudeDesign>({ enabled: false, revision: 0 });

  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const follow = async () => {
      let revision = -1;
      try {
        const stream = await api.experiments.onDesignChange(undefined, {
          signal: controller.signal,
        });
        for await (const snapshot of stream) {
          if (controller.signal.aborted) break;
          if (snapshot.revision < revision) continue;
          revision = snapshot.revision;
          setDesign({ enabled: snapshot.enabled, revision: snapshot.revision });
        }
      } catch {
        // Keep credential controls accessible on a lost connection; reconnect
        // establishes a fresh subscription and revision domain.
      }
    };
    follow().catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  return design;
}
