import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  beginMcpAppViewDomainsRequest,
  publishMcpAppViewDomains,
} from "@/browser/features/RightSidebar/ArtifactsTab/mcpAppViewDomainsStore";
import type { McpAppViewDomains } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * MCP Apps (artifacts experiment): origins the user allowed each server's views to reach, per
 * project (project config `mcpAppViewDomains`). Loaded once for the whole MCP section.
 */
/** The last failed revoke, shown next to its entry. */
export interface McpAppViewDomainsRevokeError {
  projectPath: string;
  serverName: string;
  message: string;
}

export function useMcpAppViewDomains() {
  const { api } = useAPI();
  const [entries, setEntries] = useState<McpAppViewDomains[]>([]);
  const [revokeError, setRevokeError] = useState<McpAppViewDomainsRevokeError | null>(null);
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
    revokeError,
    revoke: async (entry: Pick<McpAppViewDomains, "projectPath" | "serverName">) => {
      if (!api) return;
      const requestSeq = beginMcpAppViewDomainsRequest();
      try {
        await api.mcpApps.revokeViewDomains({
          projectPath: entry.projectPath,
          serverName: entry.serverName,
        });
      } catch (error) {
        setRevokeError({ ...entry, message: getErrorMessage(error) });
        return;
      }
      setRevokeError(null);
      // Mounted views of this server reload at once under the base policy (and ask again).
      publishMcpAppViewDomains(entry.projectPath, entry.serverName, [], requestSeq);
      setTick((value) => value + 1);
    },
  };
}

/**
 * Approvals whose server has no row in `servers` (project-local, plugin or removed servers, since
 * the list shows global servers only): shown in their own block so they can still be revoked.
 */
export function unlistedMcpAppViewDomains(
  entries: readonly McpAppViewDomains[],
  servers: Readonly<Record<string, unknown>>
): McpAppViewDomains[] {
  return entries.filter((entry) => !Object.hasOwn(servers, entry.serverName));
}

/** The host of a stored origin; the config schema allows any string, so never throw here. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * "Allowed view domains" of one server, or (`showServer`) of servers without a row in the list
 * above (project, plugin or removed servers), which can still be revoked here.
 */
export function McpAppViewDomainsSection(props: {
  entries: readonly McpAppViewDomains[];
  onRevoke: (entry: McpAppViewDomains) => void;
  showServer?: boolean;
  error?: McpAppViewDomainsRevokeError | null;
}) {
  if (props.entries.length === 0) return null;
  const failed = props.error;
  return (
    <div className="border-border-medium border-t px-3 py-2 text-xs">
      <div className="text-foreground mb-1 font-medium">Allowed view domains</div>
      {props.entries.map((entry) => (
        <div key={JSON.stringify([entry.projectPath, entry.serverName])} className="py-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="text-muted min-w-0 flex-1 break-words">
              {props.showServer && <span className="text-foreground">{entry.serverName} in </span>}
              <span className="text-foreground">{entry.projectPath}</span>:{" "}
              {entry.origins.map(hostOf).join(", ")}
            </div>
            <button
              type="button"
              onClick={() => props.onRevoke(entry)}
              className="border-border-light focus-visible:ring-accent shrink-0 rounded border px-2 py-0.5 focus-visible:ring-1"
            >
              Revoke
            </button>
          </div>
          {failed?.projectPath === entry.projectPath && failed.serverName === entry.serverName && (
            <div className="text-danger">Could not revoke: {failed.message}</div>
          )}
        </div>
      ))}
    </div>
  );
}
