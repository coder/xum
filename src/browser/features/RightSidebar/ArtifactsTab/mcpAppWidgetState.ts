import type { APIClient } from "@/browser/contexts/API";
import type { McpAppView } from "@/common/orpc/schemas/mcpApps";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * window.openai widget state of MCP App views (artifacts experiment, #6178). The backend keeps
 * each view's state in its result record (McpAppResultStore.setWidgetState), so it survives a
 * collapse, a move to the tab and an app restart, and goes with the record.
 *
 * SECURITY: a view instance is its workspace, tool call and result record. The record's random
 * binding (from getView) is part of every key here and of every backend write, so a new
 * record under a reused tool call ID never sees an older view's state, and a late write of the
 * older view is refused.
 *
 * Writes leave the frame's lifetime: they run here, one at a time per view, so a write that
 * arrives as the frame unmounts still lands, and an older write never lands after a newer one.
 * A newer write that arrives while one is in flight replaces any write still waiting.
 */
export interface McpAppWidgetStateTarget {
  workspaceId: string;
  toolCallId: string;
  /** The result record's server (the backend checks it like a model-context update). */
  serverName: string;
  binding: string;
  /** The state getView read from the record. */
  stored: unknown;
}

/** The instance a loaded view writes to; null when it has no result record. */
export function mcpAppWidgetStateTarget(
  workspaceId: string,
  toolCallId: string,
  view: McpAppView | null | undefined
): McpAppWidgetStateTarget | null {
  const binding = view?.widgetStateBinding;
  const serverName = view?.invocation?.serverName;
  if (binding == null || serverName == null) return null;
  return { workspaceId, toolCallId, serverName, binding, stored: view?.widgetState ?? null };
}

/** Bounds for the maps below: far more views than a renderer shows at once. */
const MAX_ENTRIES = 64;

const keyOf = (target: McpAppWidgetStateTarget) =>
  JSON.stringify([target.workspaceId, target.toolCallId, target.binding]);

/** The newest state this renderer saved per view instance, written or still in flight. */
const latest = new Map<string, unknown>();
/** The seed each view document was built with, by its nonce. */
const documentSeeds = new Map<string, unknown>();
/** States saved while Xum reconnected (no live client), per view instance. */
const offline = new Map<string, { target: McpAppWidgetStateTarget; state: unknown }>();
/** Per view instance: the write waiting behind the one in flight (null when none waits). */
const queues = new Map<string, { next: { api: APIClient; state: unknown } | null }>();

function setBounded(map: Map<string, unknown>, key: string, value: unknown) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * The widget state a view document starts with: what this renderer saved last for the same
 * instance, else what the record holds. Fixed per document (`nonce`), so a later write does not
 * change, and so reload, a document that is already built.
 */
export function mcpAppWidgetStateSeed(
  viewDocument: { nonce: string } | null,
  target: McpAppWidgetStateTarget | null
): unknown {
  if (target === null) return null;
  const key = keyOf(target);
  const seed = latest.has(key) ? latest.get(key) : target.stored;
  if (viewDocument === null) return seed;
  if (!documentSeeds.has(viewDocument.nonce)) setBounded(documentSeeds, viewDocument.nonce, seed);
  return documentSeeds.get(viewDocument.nonce);
}

/** Keep a view's new widget state and write it to its record. A view without one keeps none. */
export function saveMcpAppWidgetState(
  api: APIClient | null,
  target: McpAppWidgetStateTarget | null,
  state: unknown
): void {
  if (target === null) return;
  const key = keyOf(target);
  setBounded(latest, key, state);
  if (api === null) {
    // Kept until a client is back (flushOfflineMcpAppWidgetStates); the newest state wins.
    offline.delete(key);
    offline.set(key, { target, state });
    return;
  }
  offline.delete(key);
  const queue = queues.get(key);
  if (queue !== undefined) {
    queue.next = { api, state };
    return;
  }
  const started = { next: null };
  queues.set(key, started);
  // Detached on purpose: the write must outlive the frame. writeQueued never rejects.
  void writeQueued(key, target, { api, state }, started);
}

async function writeQueued(
  key: string,
  target: McpAppWidgetStateTarget,
  first: { api: APIClient; state: unknown },
  queue: { next: { api: APIClient; state: unknown } | null }
): Promise<void> {
  let write: { api: APIClient; state: unknown } | null = first;
  while (write !== null) {
    try {
      const result = await write.api.mcpApps.setWidgetState({
        workspaceId: target.workspaceId,
        toolCallId: target.toolCallId,
        serverName: target.serverName,
        binding: target.binding,
        state: write.state,
      });
      if (!result.success) console.debug("[MCP Apps] widget state not stored:", result.error);
    } catch (error) {
      console.debug("[MCP Apps] widget state not stored:", getErrorMessage(error));
    }
    write = queue.next;
    queue.next = null;
  }
  queues.delete(key);
}

/**
 * Send the states saved while Xum reconnected. Every mounted MCP App frame calls this when its
 * live client comes back, so a state also lands when its own frame unmounted meanwhile.
 */
export function flushOfflineMcpAppWidgetStates(api: APIClient): void {
  const pending = [...offline.values()];
  offline.clear();
  for (const { target, state } of pending) saveMcpAppWidgetState(api, target, state);
}
