import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";

/** Settings revisions also cover sibling Disconnect, source, and allowlist changes. */
export function useClaudeDesignRevision(): number {
  const { api } = useAPI();
  const [designRevision, setDesignRevision] = useState(0);

  // External-system subscription (backend design stream): a valid effect.
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
          setDesignRevision(snapshot.revision);
        }
      } catch {
        // Keep credential controls accessible on a lost connection; reconnect
        // establishes a fresh subscription and revision domain.
      }
    };
    follow().catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  return designRevision;
}
