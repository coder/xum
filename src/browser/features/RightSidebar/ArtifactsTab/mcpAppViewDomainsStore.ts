import { useSyncExternalStore } from "react";

/**
 * MCP Apps view-domain approvals this renderer changed (artifacts experiment), per project and
 * server key, so one Allow (or Revoke) applies at once to every mounted view of that server,
 * not only the frame that asked. A frame uses an entry only when it is newer than its own
 * getView fetch (`seq`), so a fetch that started later always wins.
 *
 * Renderer memory only: nothing here is persisted, and the project config (read through getView)
 * stays the source of truth. Callers publish only the list a successful backend call returned.
 *
 * Responses can arrive out of order (two views approving at once), so each change carries the
 * sequence taken when its request was sent (beginMcpAppViewDomainsRequest), and a list from an
 * older request never replaces one from a newer request.
 */
export interface McpAppViewDomainsEntry {
  /** When the entry was published: compared with a frame's getView fetch. */
  seq: number;
  /** When the request that returned `origins` was sent. */
  requestSeq: number;
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

/** Take a request's sequence just before it is sent; pass it to publishMcpAppViewDomains. */
export function beginMcpAppViewDomainsRequest(): number {
  return ++seq;
}

export function publishMcpAppViewDomains(
  projectPath: string,
  serverName: string,
  origins: readonly string[],
  requestSeq: number
): void {
  const key = keyOf(projectPath, serverName);
  if ((entries.get(key)?.requestSeq ?? 0) > requestSeq) return;
  entries.set(key, { seq: ++seq, requestSeq, origins });
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

// A revoke in this renderer publishes here directly, so its mounted views narrow at once. A revoke
// made in another window or on another device takes effect when the view next mounts (its getView
// reads the stored approvals): cross-process config events are missed (#6179), and a live
// cross-window follow is deferred to #6181.
