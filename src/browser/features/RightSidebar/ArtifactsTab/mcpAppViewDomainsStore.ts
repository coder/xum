import { useEffect, useSyncExternalStore } from "react";
import { useAPI, type APIClient } from "@/browser/contexts/API";
import type { McpAppView, McpAppViewDomains } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * MCP Apps view-domain approvals this renderer changed (mcp-apps experiment), per project and
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
 * started. A key that joins gets a read after it joined: one more read right after a read in
 * flight, or one at once while the follow waits for a change. Its view's getView list can
 * predate a change the follow already read, and no later change event is certain.
 *
 * A failed stream or read does not end the follow while views follow: it opens a new stream
 * after a capped backoff. A new client (a reconnect) replaces the follow instead.
 */
interface ViewDomainsFollow {
  keys: Map<string, number>;
  /** A key joined since the current read started. */
  keysJoined: boolean;
  /** Wakes a follow that waits for a change: a key joined, so it reads now. */
  wake: () => void;
  stop: () => void;
}
const FOLLOW_RETRY_FIRST_MS = 500;
const FOLLOW_RETRY_MAX_MS = 30_000;
/**
 * A stream that lived this long counts as healthy, so the next one starts with the first retry
 * delay again. A stream that ends sooner keeps growing the backoff, even after a good read:
 * otherwise a backend that ends each stream right after its first read gets a new stream every
 * FOLLOW_RETRY_FIRST_MS for good (#6181).
 */
const FOLLOW_HEALTHY_STREAM_MS = 10_000;
/** A read that takes longer fails like any other: the follow retries on a new stream (#6181). */
const FOLLOW_READ_TIMEOUT_MS = 5_000;
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
  if (!follow.keys.has(key)) {
    follow.keysJoined = true;
    follow.wake();
  }
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
  const follow: ViewDomainsFollow = {
    keys: new Map(),
    keysJoined: false,
    wake: () => undefined,
    stop: () => controller.abort(),
  };
  follows.set(api, follow);
  void runViewDomainsFollow(api, follow, controller.signal);
  return follow;
}

async function runViewDomainsFollow(
  api: APIClient,
  follow: ViewDomainsFollow,
  signal: AbortSignal
): Promise<void> {
  let retryMs = FOLLOW_RETRY_FIRST_MS;
  while (!signal.aborted) {
    if (await followChanges(api, follow, signal)) retryMs = FOLLOW_RETRY_FIRST_MS;
    // Stopped, or the stream failed or ended while views still follow: open a new one.
    await abortableDelay(retryMs, signal);
    retryMs = Math.min(retryMs * 2, FOLLOW_RETRY_MAX_MS);
  }
}

/**
 * One stream: read now, then after each change. Returns whether the stream was healthy: a read
 * that a change caused succeeded, or the stream lived FOLLOW_HEALTHY_STREAM_MS.
 */
async function followChanges(
  api: APIClient,
  follow: ViewDomainsFollow,
  signal: AbortSignal
): Promise<boolean> {
  let changes: AsyncIterator<unknown> | null = null;
  const openedAt = Date.now();
  let changeRead = false;
  try {
    const stream = await api.config.onConfigChanged(undefined, { signal });
    changes = stream[Symbol.asyncIterator]();
    // A change can land between a view's getView and the stream start, or fire while the
    // backend starts its watch (before onConfigChanged returns there): read once now.
    await rereadViewDomains(api, follow, signal);
    let change = changes.next();
    while (!signal.aborted) {
      // A key that joins while no read runs wakes this wait: its view's getView list can
      // predate a change already read here, and no later change is certain.
      const joined = new Promise<"joined">((resolve) => (follow.wake = () => resolve("joined")));
      const woke = await Promise.race([change, joined]);
      follow.wake = () => undefined;
      if (woke !== "joined") {
        if (woke.done === true) break;
        change = changes.next();
      }
      await rereadViewDomains(api, follow, signal);
      if (woke !== "joined") changeRead = true;
    }
  } catch {
    // A failed stream or read: the caller retries after a backoff, unless stopped.
  } finally {
    void changes?.return?.();
  }
  return changeRead || Date.now() - openedAt >= FOLLOW_HEALTHY_STREAM_MS;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function rereadViewDomains(
  api: APIClient,
  follow: ViewDomainsFollow,
  signal: AbortSignal
): Promise<void> {
  do {
    follow.keysJoined = false;
    const keys = [...follow.keys.keys()];
    const { revision, approvals } = await api.mcpApps.readViewDomains(undefined, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(FOLLOW_READ_TIMEOUT_MS)]),
    });
    if (signal.aborted) return;
    const read = new Map(approvals.map((a) => [keyOf(a.projectPath, a.serverName), a.origins]));
    for (const key of keys) publishByKey(key, read.get(key) ?? [], revision);
  } while (follow.keysJoined);
}
