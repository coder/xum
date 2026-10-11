import { useEffect, useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";

/**
 * MCP Apps view-domain approvals this renderer changed (artifacts experiment), per project and
 * server key, so one Allow (or Revoke) applies at once to every mounted view of that server,
 * not only the frame that asked. A frame uses an entry only when it is newer than its own
 * getView fetch (`seq`), so a fetch that started later always wins.
 *
 * Renderer memory only: nothing here is persisted, and the project config (read through getView)
 * stays the source of truth. Callers publish only the list a successful backend call returned.
 */
export interface McpAppViewDomainsEntry {
  seq: number;
  origins: readonly string[];
}

let seq = 0;
const entries = new Map<string, McpAppViewDomainsEntry>();
const listeners = new Set<() => void>();

const keyOf = (projectPath: string, serverName: string) =>
  JSON.stringify([projectPath, serverName]);

/** Sequence of the newest published change; read before a fetch starts. */
export function currentMcpAppViewDomainsSeq(): number {
  return seq;
}

export function publishMcpAppViewDomains(
  projectPath: string,
  serverName: string,
  origins: readonly string[]
): void {
  entries.set(keyOf(projectPath, serverName), { seq: ++seq, origins });
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
 * While a view runs with approved origins, follow project-config changes, so a revoke from
 * another window or device also reloads it under the narrower policy: re-read the stored
 * approvals and publish them when any origin this view uses is gone. (A revoke in this renderer
 * publishes directly.)
 */
export function useMcpAppViewDomainsRevocations(
  api: APIClient | null,
  projectPath: string | null,
  serverName: string,
  approved: readonly string[]
): void {
  const approvedKey = JSON.stringify(approved);
  useEffect(() => {
    if (api == null || projectPath == null || approved.length === 0) return;
    const controller = new AbortController();
    const follow = async () => {
      const changes = await api.config.onConfigChanged(undefined, { signal: controller.signal });
      for await (const _ of changes) {
        const stored =
          (await api.mcpApps.listViewDomains()).find(
            (entry) => entry.projectPath === projectPath && entry.serverName === serverName
          )?.origins ?? [];
        if (controller.signal.aborted) return;
        if (approved.some((origin) => !stored.includes(origin))) {
          publishMcpAppViewDomains(projectPath, serverName, stored);
        }
      }
    };
    // Ends with the abort on unmount; a lost subscription leaves the view as it is.
    follow().catch(() => undefined);
    return () => controller.abort();
    // `approved` is keyed by its content: a re-render with an equal list keeps the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectPath, serverName, approvedKey]);
}
