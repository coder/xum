import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { mcpIconRefCache } from "@/browser/utils/mcp/iconRefCache";

/**
 * Resolves a tool-call snapshot's immutable `iconRef` to the host-decoded PNG
 * data URL, or null when there is no ref or the host no longer knows it
 * (restart, eviction). Lookups go through the renderer-session cache, which
 * batches every distinct ref mounted in one render pass into a single
 * `mcp.icons` call owned by the current API client; a reconnected client asks
 * again for refs still pending from its predecessor. A rejected call is not
 * cached and a later mount retries. Without a ref no IPC happens at all.
 */
export function useMcpIcon(iconRef: string | undefined): string | null {
  const { api } = useAPI();
  // Tagged with its ref so a row whose snapshot changes never shows the
  // previous ref's icon while the new lookup is in flight.
  const [resolved, setResolved] = useState<{ iconRef: string; icon: string | null } | null>(null);

  useEffect(() => {
    if (!api || iconRef === undefined || mcpIconRefCache.peek(iconRef) !== undefined) return;
    let ignore = false;
    mcpIconRefCache.resolve(iconRef, api).then(
      (icon) => {
        if (!ignore) setResolved({ iconRef, icon });
      },
      () => {
        // Not cached: the next mount of any row with this ref retries.
      }
    );
    return () => {
      ignore = true;
    };
  }, [api, iconRef]);

  if (iconRef === undefined) return null;
  const cached = mcpIconRefCache.peek(iconRef);
  if (cached !== undefined) return cached;
  return resolved?.iconRef === iconRef ? resolved.icon : null;
}
