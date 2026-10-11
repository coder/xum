import { useSyncExternalStore } from "react";

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
