import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { McpAppView, McpAppViewDomains } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * MCP Apps view-domain approvals this renderer changed (artifacts experiment), per project and
 * server key, so one Allow (or Revoke) applies at once to every mounted view of that server,
 * not only the frame that asked. A frame uses an entry only when it is newer than the list its
 * own getView returned.
 *
 * Renderer memory only: nothing here is persisted, and the project config (read through getView)
 * stays the source of truth. Callers publish only the list a successful backend call returned.
 *
 * Every list carries the backend's commit revision (mcpAppsOperations.ts), and a list never
 * replaces one with a newer revision. So two approvals at once, or a revoke during an approval,
 * end with the list committed last, whatever order the responses arrive in (#6181).
 */
export interface McpAppViewDomainsEntry {
  /** Backend commit revision of `origins`. */
  revision: number;
  origins: readonly string[];
}

const entries = new Map<string, McpAppViewDomainsEntry>();
// Counts published changes, so Settings re-lists approvals after any Allow or Revoke.
let version = 0;
const listeners = new Set<() => void>();

const keyOf = (projectPath: string, serverName: string) =>
  JSON.stringify([projectPath, serverName]);

export function publishMcpAppViewDomains(
  projectPath: string,
  serverName: string,
  origins: readonly string[],
  revision: number
): void {
  const key = keyOf(projectPath, serverName);
  if ((entries.get(key)?.revision ?? -Infinity) >= revision) return;
  entries.set(key, { revision, origins });
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMcpAppViewDomains(
  projectPath: string | null,
  serverName: string
): McpAppViewDomainsEntry | undefined {
  return useSyncExternalStore(subscribe, () =>
    projectPath == null ? undefined : entries.get(keyOf(projectPath, serverName))
  );
}

/**
 * The origins a view may be granted: the published list when it is newer than the list the
 * view's own getView read, else the view's list.
 */
export function newestMcpAppViewDomains(
  published: McpAppViewDomainsEntry | undefined,
  view: Pick<McpAppView, "approvedDomains" | "approvedDomainsRevision"> | null | undefined
): readonly string[] {
  return published != null && published.revision > (view?.approvedDomainsRevision ?? 0)
    ? published.origins
    : (view?.approvedDomains ?? []);
}

/** Changes when an approval list is published: Settings re-lists the stored approvals then. */
export function useMcpAppViewDomainsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/**
 * Revokes a server's approvals in a project (Settings and the command palette), and narrows the
 * server's mounted views at once: they reload under the base policy and ask again. An approval
 * committed after the revoke has a newer revision, so it still applies. Resolves with the error
 * of a failed revoke, or null.
 */
export async function revokeMcpAppViewDomains(
  api: APIClient,
  entry: Pick<McpAppViewDomains, "projectPath" | "serverName">
): Promise<string | null> {
  let revision: number;
  try {
    ({ revision } = await api.mcpApps.revokeViewDomains({
      projectPath: entry.projectPath,
      serverName: entry.serverName,
    }));
  } catch (error) {
    return getErrorMessage(error);
  }
  publishMcpAppViewDomains(entry.projectPath, entry.serverName, [], revision);
  return null;
}
