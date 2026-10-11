import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";

/**
 * MCP Apps (artifacts experiment): origins the user allowed each server's views to reach, per
 * project (project config `mcpAppViewDomains`). Loaded once for the whole MCP section.
 */
export interface McpAppViewDomainsEntry {
  projectPath: string;
  serverName: string;
  origins: string[];
}

export function useMcpAppViewDomains() {
  const { api } = useAPI();
  const [entries, setEntries] = useState<McpAppViewDomainsEntry[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api.mcpApps
      .listViewDomains()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      // The section works without approvals; a failed read just lists none.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, tick]);
  return {
    entries,
    revoke: async (entry: { projectPath: string; serverName: string }) => {
      if (!api) return;
      await api.mcpApps.revokeViewDomains(entry);
      setTick((value) => value + 1);
    },
  };
}

/** "Allowed view domains" of one server; a revoke applies on the next view mount. */
export function McpAppViewDomainsSection(props: {
  entries: readonly McpAppViewDomainsEntry[];
  onRevoke: (entry: McpAppViewDomainsEntry) => void;
}) {
  if (props.entries.length === 0) return null;
  return (
    <div className="border-border-medium border-t px-3 py-2 text-xs">
      <div className="text-foreground mb-1 font-medium">Allowed view domains</div>
      {props.entries.map((entry) => (
        <div key={entry.projectPath} className="flex min-w-0 items-center gap-2 py-0.5">
          <div className="text-muted min-w-0 flex-1 break-words">
            <span className="text-foreground">{entry.projectPath}</span>:{" "}
            {entry.origins.map((origin) => new URL(origin).host).join(", ")}
          </div>
          <button
            type="button"
            onClick={() => props.onRevoke(entry)}
            className="border-border-light focus-visible:ring-accent shrink-0 rounded border px-2 py-0.5 focus-visible:ring-1"
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}
