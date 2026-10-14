import { useEffect, useSyncExternalStore } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
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
  publishByKey(keyOf(projectPath, serverName), origins, revision);
}

function publishByKey(key: string, origins: readonly string[], revision: number): void {
  const current = entries.get(key);
  if ((current?.revision ?? -Infinity) >= revision) return;
  entries.set(key, { revision, origins });
  // Views compare revisions, so they always hear of a newer list. Settings re-lists only when
  // the origins changed: a follow read after a config change of any other kind repeats them.
  if (current === undefined || !sameOrigins(current.origins, origins)) version++;
  for (const listener of listeners) listener();
}

function sameOrigins(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((origin, index) => origin === b[index]);
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

/**
 * Live follow of approvals changed elsewhere (#6181): another window's Revoke, or another Xum
 * process editing config.json. Per API client, one config change stream for all mounted views,
 * counted by project and server key. After the stream opens, and after each change, the
 * follow re-reads every approval (readViewDomains: one call, with a revision newer than every
 * list committed before it) and publishes the lists of the keys followed when that read
 * started. A view that mounts later has its own getView list, and the revisions order the two.
 */
interface ViewDomainsFollow {
  keys: Map<string, number>;
  stop: () => void;
}
const follows = new Map<APIClient, ViewDomainsFollow>();

/** Follow the approvals of a mounted view's server in its project while it stays mounted. */
export function useFollowMcpAppViewDomains(projectPath: string | null, serverName: string): void {
  const { api } = useAPI();
  // A new client (a reconnect) re-runs this: the old stream stops and a new one opens.
  useEffect(() => {
    if (api == null || projectPath == null) return;
    return followViewDomains(api, keyOf(projectPath, serverName));
  }, [api, projectPath, serverName]);
}

function followViewDomains(api: APIClient, key: string): () => void {
  const follow = follows.get(api) ?? startViewDomainsFollow(api);
  follow.keys.set(key, (follow.keys.get(key) ?? 0) + 1);
  return () => {
    const left = (follow.keys.get(key) ?? 1) - 1;
    if (left > 0) follow.keys.set(key, left);
    else follow.keys.delete(key);
    if (follow.keys.size > 0 || follows.get(api) !== follow) return;
    follows.delete(api);
    follow.stop();
  };
}

function startViewDomainsFollow(api: APIClient): ViewDomainsFollow {
  const controller = new AbortController();
  const follow: ViewDomainsFollow = { keys: new Map(), stop: () => controller.abort() };
  follows.set(api, follow);
  void runViewDomainsFollow(api, follow, controller.signal);
  return follow;
}

async function runViewDomainsFollow(
  api: APIClient,
  follow: ViewDomainsFollow,
  signal: AbortSignal
): Promise<void> {
  let changes: AsyncIterator<unknown> | null = null;
  try {
    const stream = await api.config.onConfigChanged(undefined, { signal });
    changes = stream[Symbol.asyncIterator]();
    // A change can land between a view's getView and the stream start, or fire while the
    // backend starts its watch (before onConfigChanged returns there): read once now.
    await rereadViewDomains(api, follow, signal);
    while (!signal.aborted && !(await changes.next()).done) {
      await rereadViewDomains(api, follow, signal);
    }
  } catch {
    // The stream ends with its client (a reconnect gives a new client) or on stop.
  } finally {
    void changes?.return?.();
  }
}

async function rereadViewDomains(
  api: APIClient,
  follow: ViewDomainsFollow,
  signal: AbortSignal
): Promise<void> {
  const keys = [...follow.keys.keys()];
  const { revision, approvals } = await api.mcpApps.readViewDomains();
  if (signal.aborted) return;
  const read = new Map(approvals.map((a) => [keyOf(a.projectPath, a.serverName), a.origins]));
  for (const key of keys) publishByKey(key, read.get(key) ?? [], revision);
}
