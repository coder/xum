import { useEffect, useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";

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

interface Follower {
  projectPath: string;
  serverName: string;
  approved: readonly string[];
}

/** Mounted views running with approved origins; they share one subscription (O(1) IPC). */
const followers = new Set<Follower>();
let following: { api: APIClient; controller: AbortController; ready: boolean } | null = null;
let reconciling: Promise<void> | null = null;
let reconcileAgain = false;
/** The client of the newest reconcile request: a reconnect replaces the one a read started on. */
let latestApi: APIClient | null = null;

/**
 * Re-read the stored approvals and publish them for every follower that uses an origin no longer
 * stored. A request made while one runs is coalesced into one more read after it, on the newest
 * client. That read also runs when the current one fails: after a reconnect, the old client's
 * read is cut off, and only the new client's read can catch a revoke made during the outage
 * (config events are not replayed). A failed read with no newer request ends the loop, and its
 * error is the result.
 */
async function reconcile(api: APIClient): Promise<void> {
  latestApi = api;
  if (reconciling != null) {
    reconcileAgain = true;
    return reconciling;
  }
  reconciling = (async () => {
    let failure: { error: unknown } | null = null;
    do {
      reconcileAgain = false;
      const client = latestApi;
      assert(client != null, "reconcile: no client to read with");
      const requestSeq = beginMcpAppViewDomainsRequest();
      try {
        const list = await client.mcpApps.listViewDomains();
        failure = null;
        for (const follower of followers) {
          const stored =
            list.find(
              (entry) =>
                entry.projectPath === follower.projectPath &&
                entry.serverName === follower.serverName
            )?.origins ?? [];
          if (follower.approved.some((origin) => !stored.includes(origin))) {
            publishMcpAppViewDomains(follower.projectPath, follower.serverName, stored, requestSeq);
          }
        }
      } catch (error) {
        failure = { error };
      }
    } while (reconcileAgain);
    if (failure != null) throw failure.error;
  })().finally(() => {
    reconciling = null;
  });
  return reconciling;
}

/**
 * Subscribe once for every follower. A subscription that rejects or ends while views are still
 * mounted is restarted (and the restart reconciles once). A restart that is itself lost before it
 * delivers any change stops there, with no timer and no loop: the store is then not following,
 * and the next view that mounts subscribes again.
 */
function startFollowing(api: APIClient, restart = false): void {
  const state = { api, controller: new AbortController(), ready: false };
  following = state;
  const { signal } = state.controller;
  let delivered = false;
  // One failed read (a transient IPC error) must not end the stream: the next change retries.
  const reconcileOnce = () => reconcile(api).catch(() => undefined);
  const follow = async () => {
    const changes = await api.config.onConfigChanged(undefined, { signal });
    // The stream is lazy: its backend listener attaches on the first next(), not when it is
    // returned. So the next event is requested before each read: a revoke before that request
    // is in the read, and one after it is an event, so none falls between the two.
    const iterator = changes[Symbol.asyncIterator]();
    let nextEvent = iterator.next();
    state.ready = true;
    await reconcileOnce();
    for (;;) {
      const event = await nextEvent;
      if (event.done) return;
      if (signal.aborted) {
        await iterator.return?.();
        return;
      }
      delivered = true;
      nextEvent = iterator.next();
      await reconcileOnce();
    }
  };
  // Ends with the abort when the last view unmounts.
  follow()
    .catch(() => undefined)
    .finally(() => {
      if (following !== state) return;
      following = null;
      if (!signal.aborted && followers.size > 0 && (!restart || delivered)) {
        startFollowing(api, true);
      }
    });
}

function follow(api: APIClient, follower: Follower): () => void {
  followers.add(follower);
  if (following?.api !== api) {
    following?.controller.abort();
    startFollowing(api);
  } else if (following.ready) {
    // This view's getView may predate an event the shared listener already handled.
    reconcile(api).catch(() => undefined);
  }
  return () => {
    followers.delete(follower);
    if (followers.size === 0) {
      following?.controller.abort();
      following = null;
    }
  };
}

/**
 * While a view runs with approved origins, follow project-config changes, so a revoke from
 * another window or device also reloads it under the narrower policy. (A revoke in this
 * renderer publishes directly.)
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
    return follow(api, { projectPath, serverName, approved });
    // `approved` is keyed by its content: a re-render with an equal list keeps the follower.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, projectPath, serverName, approvedKey]);
}
