import type { APIClient } from "@/browser/contexts/API";
import { useSyncExternalStore } from "react";

export interface AdditionalSystemContextSnapshot {
  content: string;
  enabled: boolean;
}

const DEFAULT_SNAPSHOT: AdditionalSystemContextSnapshot = { content: "", enabled: true };

const hydratedWorkspaces = new Set<string>();
const versionByWorkspace = new Map<string, number>();
const snapshotByWorkspace = new Map<string, AdditionalSystemContextSnapshot>();
const subscribersByWorkspace = new Map<string, Set<() => void>>();
const focusListenersByWorkspace = new Map<string, Set<() => void>>();

function getSubscribers(workspaceId: string): Set<() => void> {
  const existing = subscribersByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created = new Set<() => void>();
  subscribersByWorkspace.set(workspaceId, created);
  return created;
}

export function getAdditionalSystemContextVersion(workspaceId: string): number {
  return versionByWorkspace.get(workspaceId) ?? 0;
}

export function isAdditionalSystemContextHydrated(workspaceId: string): boolean {
  return hydratedWorkspaces.has(workspaceId);
}

export function readAdditionalSystemContextSnapshot(
  workspaceId: string
): AdditionalSystemContextSnapshot {
  return snapshotByWorkspace.get(workspaceId) ?? DEFAULT_SNAPSHOT;
}

export function updateAdditionalSystemContextSnapshot(
  workspaceId: string,
  next: AdditionalSystemContextSnapshot
): void {
  hydratedWorkspaces.add(workspaceId);
  versionByWorkspace.set(workspaceId, getAdditionalSystemContextVersion(workspaceId) + 1);

  // Empty content with the default "enabled" toggle collapses to the implicit
  // default. Anything else (non-empty content OR a non-default toggle) needs to
  // be retained so consumers can observe it.
  if (next.content.length === 0 && next.enabled) {
    snapshotByWorkspace.delete(workspaceId);
  } else {
    snapshotByWorkspace.set(workspaceId, next);
  }

  for (const subscriber of getSubscribers(workspaceId)) {
    subscriber();
  }
}

export function subscribeAdditionalSystemContext(
  workspaceId: string,
  callback: () => void
): () => void {
  const subscribers = getSubscribers(workspaceId);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      subscribersByWorkspace.delete(workspaceId);
    }
  };
}

const hydrationInFlight = new Set<string>();

/**
 * Fetch the persisted scratchpad once per workspace per app session.
 *
 * Historically the store was only hydrated by the Instructions-tab editor, so
 * the chat-input decoration for saved instructions stayed hidden until that
 * tab was opened — and then popped in. The chat view's first-paint barrier
 * (useChatViewDataReady) calls this at workspace open so the decoration's
 * state is known before the transcript reveals. Idempotent and re-entrant
 * safe; never rejects (a failed fetch marks the store hydrated-empty so first
 * paint is never blocked — self-healing over a stuck skeleton).
 */
export function ensureAdditionalSystemContextHydrated(api: APIClient, workspaceId: string): void {
  if (isAdditionalSystemContextHydrated(workspaceId) || hydrationInFlight.has(workspaceId)) {
    return;
  }
  hydrationInFlight.add(workspaceId);

  api.workspace
    .getAdditionalSystemContext({ workspaceId })
    .then((result) => {
      // A concurrent hydration (e.g. the Instructions editor) or a local edit
      // may have landed first — never clobber it with this fetch.
      if (!isAdditionalSystemContextHydrated(workspaceId)) {
        updateAdditionalSystemContextSnapshot(workspaceId, {
          content: result.content,
          enabled: result.enabled,
        });
      }
    })
    .catch(() => {
      if (!isAdditionalSystemContextHydrated(workspaceId)) {
        updateAdditionalSystemContextSnapshot(workspaceId, DEFAULT_SNAPSHOT);
      }
    })
    .finally(() => {
      hydrationInFlight.delete(workspaceId);
    });
}

interface SaveCallbacks {
  onError?: (error: unknown) => void;
  onIdle?: () => void;
}

interface SaveState {
  inFlight: boolean;
  pending: AdditionalSystemContextSnapshot | null;
  callbacks: Set<SaveCallbacks>;
}

const saveStateByWorkspace = new Map<string, SaveState>();

function getSaveState(workspaceId: string): SaveState {
  const existing = saveStateByWorkspace.get(workspaceId);
  if (existing) return existing;
  const created: SaveState = { inFlight: false, pending: null, callbacks: new Set() };
  saveStateByWorkspace.set(workspaceId, created);
  return created;
}

function notifySaveError(state: SaveState, error: unknown): void {
  for (const callbacks of state.callbacks) {
    callbacks.onError?.(error);
  }
}

function notifySaveIdle(state: SaveState): void {
  for (const callbacks of state.callbacks) {
    callbacks.onIdle?.();
  }
  state.callbacks.clear();
}

function flushAdditionalSystemContextSave(api: APIClient, workspaceId: string): void {
  const state = getSaveState(workspaceId);
  if (state.inFlight) return;
  const next = state.pending;
  if (next == null) return;

  state.pending = null;
  state.inFlight = true;

  api.workspace
    .setAdditionalSystemContext({
      workspaceId,
      content: next.content,
      enabled: next.enabled,
    })
    .then((result) => {
      // Only sync from server when nothing newer is queued. Otherwise an older
      // save's response would overwrite still-unflushed live edits.
      if (state.pending == null) {
        updateAdditionalSystemContextSnapshot(workspaceId, {
          content: result.content,
          enabled: result.enabled,
        });
      }
    })
    .catch((error) => notifySaveError(state, error))
    .finally(() => {
      state.inFlight = false;
      if (state.pending == null) {
        notifySaveIdle(state);
        return;
      }
      flushAdditionalSystemContextSave(api, workspaceId);
    });
}

export function queueAdditionalSystemContextSave(
  api: APIClient,
  workspaceId: string,
  next: AdditionalSystemContextSnapshot,
  callbacks?: SaveCallbacks
): void {
  const state = getSaveState(workspaceId);
  if (callbacks) {
    state.callbacks.add(callbacks);
  }
  state.pending = next;
  flushAdditionalSystemContextSave(api, workspaceId);
}

/**
 * Focus request channel. ChatInput decoration / Instructions tab badge calls
 * `requestAdditionalSystemContextFocus(workspaceId)` after switching the
 * right-sidebar tab to "instructions"; the editor subscribes via
 * `subscribeAdditionalSystemContextFocus` and focuses its textarea.
 *
 * Using a tiny pub-sub instead of a ref lets the editor be unmounted at the
 * time the request is fired (e.g. when the Instructions tab is being switched
 * on for the first time) — the editor's effect will register the listener as
 * soon as it mounts, and the focus request remains visible because we replay
 * it with a small generation counter.
 */
const pendingFocusGeneration = new Map<string, number>();

export function requestAdditionalSystemContextFocus(workspaceId: string): void {
  const next = (pendingFocusGeneration.get(workspaceId) ?? 0) + 1;
  pendingFocusGeneration.set(workspaceId, next);
  const listeners = focusListenersByWorkspace.get(workspaceId);
  if (!listeners) return;
  for (const listener of listeners) listener();
}

export function subscribeAdditionalSystemContextFocus(
  workspaceId: string,
  callback: () => void
): () => void {
  let listeners = focusListenersByWorkspace.get(workspaceId);
  if (!listeners) {
    listeners = new Set();
    focusListenersByWorkspace.set(workspaceId, listeners);
  }
  const target = listeners;
  target.add(callback);
  return () => {
    target.delete(callback);
    if (target.size === 0) {
      focusListenersByWorkspace.delete(workspaceId);
    }
  };
}

export function getAdditionalSystemContextFocusGeneration(workspaceId: string): number {
  return pendingFocusGeneration.get(workspaceId) ?? 0;
}

export function useAdditionalSystemContextHydrated(workspaceId: string): boolean {
  return useSyncExternalStore(
    (callback) => subscribeAdditionalSystemContext(workspaceId, callback),
    () => isAdditionalSystemContextHydrated(workspaceId),
    () => false
  );
}

export function useAdditionalSystemContextSnapshot(
  workspaceId: string
): AdditionalSystemContextSnapshot {
  return useSyncExternalStore(
    (callback) => subscribeAdditionalSystemContext(workspaceId, callback),
    () => readAdditionalSystemContextSnapshot(workspaceId),
    () => DEFAULT_SNAPSHOT
  );
}
