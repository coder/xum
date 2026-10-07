import { useSyncExternalStore } from "react";
import { isPlainObject } from "@/common/utils/isPlainObject";
import type { APIClient } from "@/browser/contexts/API";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import { applyMergePatch, type MergePatch } from "@/common/utils/applyMergePatch";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { BashCollapsedSummaryMode, TranscriptDensity } from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ExperimentId } from "@/common/constants/experiments";
import { showFeedbackToast } from "@/browser/utils/feedbackToast";
import { isAbortError } from "@/browser/utils/isAbortError";

/**
 * Slices of the app config consumed by per-model hooks (useRouting,
 * useMinThinkingLevels). Kept narrow so unrelated config stays out of the
 * snapshot surface.
 */
export interface AppConfigSnapshot {
  routePriority?: string[];
  routeOverrides?: Record<string, string>;
  minThinkingLevelByModel?: Record<string, ThinkingLevel>;
  /** Plan Implement / Continue in Auto replace the chat history first (task setting). */
  proposePlanImplementReplacesChatHistory?: boolean;
  /**
   * Read only by the VS Code webview to seed its local preference cache (#4972, #4962). Desktop
   * hydrates these through UserPreferencesContext / WorkspaceContext instead.
   */
  bashCollapsedSummaryMode?: BashCollapsedSummaryMode;
  transcriptDensity?: TranscriptDensity;
  agentAiDefaults?: AgentAiDefaults;
  /** Read by the command palette to show the toggle's current state (#5791). */
  keepScreenAwake?: boolean;
  /** Backend experiment values; the only experiment state the renderer reads. */
  experiments?: Partial<Record<ExperimentId, boolean>>;
  userPreferences?: UserPreferences;
}

export type UserPreferencesPatch = MergePatch<UserPreferences>;

const EMPTY_SNAPSHOT: AppConfigSnapshot = {};
const EMPTY_USER_PREFERENCES: UserPreferences = {};
const USER_PREFERENCE_SAVE_FAILED_MESSAGE = "Settings could not be saved";
const USER_PREFERENCE_SAVE_UNCONFIRMED_MESSAGE =
  "Connection lost: settings may not have been saved";

/**
 * Returns `previous` when it deep-equals `next`, else `next` rebuilt around the unchanged children
 * of `previous`. onConfigChanged fires after every config write (workspace metadata too), so this
 * keeps selectors over unchanged slices from re-rendering on unrelated writes.
 */
function reuseUnchanged<T>(previous: unknown, next: T): T;
function reuseUnchanged(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(next) && Array.isArray(previous)) {
    const previousItems: unknown[] = previous;
    const nextItems: unknown[] = next;
    const merged = nextItems.map((value, index) => reuseUnchanged(previousItems[index], value));
    const unchanged =
      merged.length === previousItems.length &&
      merged.every((value, index) => value === previousItems[index]);
    return unchanged ? previousItems : merged;
  }
  if (isPlainObject(next) && isPlainObject(previous)) {
    const merged: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      merged[key] = reuseUnchanged(previous[key], value);
    }
    const keys = Object.keys(merged);
    const unchanged =
      keys.length === Object.keys(previous).length &&
      keys.every((key) => key in previous && merged[key] === previous[key]);
    return unchanged ? previous : merged;
  }
  return next;
}

/**
 * App-wide shared cache of the config slices above.
 *
 * Previously every `useRouting()` / `useMinThinkingLevels()` consumer issued
 * its own `config.getConfig()` fetch plus its own `onConfigChanged`
 * subscription on mount. Surfaces that render one picker per row (Agents
 * settings cards, model selectors) multiplied that into O(rows) long-lived
 * subscriptions and fanned every config change into O(rows) backend reads.
 * One store = one fetch + one subscription per app session (mirroring
 * ProvidersConfigStore).
 */
export class AppConfigStore {
  private client: APIClient | null = null;
  private serverSnapshot: AppConfigSnapshot | null = null;
  // serverSnapshot with the in-flight, then queued, preference patches applied.
  private snapshot: AppConfigSnapshot | null = null;
  private inFlightPatches: UserPreferencesPatch[] = [];
  private queuedPatches: UserPreferencesPatch[] = [];
  // Settles when no preference write is pending; rejects when one of its writes failed.
  private pendingWrite: Promise<void> | null = null;
  // Aborted when the client changes: a request to a replaced connection may never settle.
  private clientController: AbortController | null = null;
  private listeners = new Set<() => void>();
  // Version counters to ignore responses older than the applied data from out-of-order fetches
  // (and to invalidate in-flight fetches when an optimistic update lands).
  private fetchVersion = 0;
  private appliedVersion = 0;
  private subscriptionController: AbortController | null = null;
  // Live onConfigChanged iterator, kept on the instance so setClient can
  // force-close it (see ProvidersConfigStore for the leak rationale).
  private subscriptionIterator: AsyncIterator<unknown> | null = null;

  setClient(client: APIClient | null): void {
    // Reconnecting the current client (stories wire it beside APIProvider) keeps its subscription.
    if (client === this.client) return;
    this.client = client;
    this.clientController?.abort();
    this.clientController = client ? new AbortController() : null;

    this.subscriptionController?.abort();
    this.subscriptionController = null;
    void this.subscriptionIterator?.return?.();
    this.subscriptionIterator = null;
    // Invalidate in-flight fetches from the previous client.
    this.appliedVersion = ++this.fetchVersion;

    if (!client) {
      return;
    }

    void this.refresh();
    this.runConfigChangedSubscription(client);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AppConfigSnapshot | null => this.snapshot;

  refresh = async (): Promise<void> => {
    const client = this.client;
    if (!client) return;
    const signal = this.clientController?.signal;
    const myVersion = ++this.fetchVersion;
    try {
      const config = await client.config.getConfig(undefined, { signal });
      if (myVersion > this.appliedVersion) {
        this.appliedVersion = myVersion;
        // The VS Code webview host projects the config and forwards taskSettings only with
        // this one flag, or not at all (#4942), so read it defensively.
        const taskSettings = config.taskSettings as
          | { proposePlanImplementReplacesChatHistory?: boolean }
          | undefined;
        this.serverSnapshot = {
          routePriority: config.routePriority,
          routeOverrides: config.routeOverrides,
          minThinkingLevelByModel: config.minThinkingLevelByModel,
          proposePlanImplementReplacesChatHistory:
            taskSettings?.proposePlanImplementReplacesChatHistory === true,
          // The webview projection may omit these (see redactWebviewOrpcResult).
          bashCollapsedSummaryMode: config.userPreferences?.appearance?.bashCollapsedSummaryMode,
          transcriptDensity: config.userPreferences?.appearance?.transcriptDensity,
          agentAiDefaults: config.agentAiDefaults,
          keepScreenAwake: config.keepScreenAwake === true,
          experiments: config.experiments ?? {},
          userPreferences: config.userPreferences ?? EMPTY_USER_PREFERENCES,
        };
        this.publish();
      }
    } catch {
      // Best-effort only; consumers degrade to defaults.
    }
  };

  /**
   * Optimistically update local state for instant UI feedback. Bumps the
   * fetch version to invalidate any in-flight fetches that would overwrite
   * this optimistic state with stale data.
   */
  updateOptimistically = (updates: Partial<AppConfigSnapshot>): void => {
    this.appliedVersion = ++this.fetchVersion;
    this.serverSnapshot = { ...this.serverSnapshot, ...updates };
    this.publish();
  };

  /** Shows `patch` at once and sends it with the next write; never throws. */
  updateUserPreferences = (patch: UserPreferencesPatch): void => {
    if (!this.client) {
      showFeedbackToast({ type: "error", message: USER_PREFERENCE_SAVE_FAILED_MESSAGE });
      return;
    }
    this.queuedPatches.push(patch);
    this.publish();
    if (!this.pendingWrite) {
      const write = this.writeUserPreferences();
      write.catch(() => undefined);
      this.pendingWrite = write;
    }
  };

  /** Resolves when no preference write is pending; rejects when a pending write failed. */
  flushUserPreferences = (): Promise<void> => this.pendingWrite ?? Promise.resolve();

  private async writeUserPreferences(): Promise<void> {
    let failure: string | null = null;
    try {
      while (this.queuedPatches.length > 0) {
        this.inFlightPatches = this.queuedPatches;
        this.queuedPatches = [];
        const signal = this.clientController?.signal;
        try {
          // Read per batch: a reconnect can replace the client while patches wait.
          const client = this.client;
          if (!client) throw new Error("Not connected");
          await client.config.updateUserPreferences({ patches: this.inFlightPatches }, { signal });
          // Keep the patches applied until a fetch started after the write lands.
          await this.refresh();
        } catch (error) {
          console.warn("Failed to save user preferences:", error);
          if (signal?.aborted || isAbortError(error)) {
            // The connection was lost or replaced mid-request. The server may still apply it (a
            // frozen backend does when it resumes), so do not claim it failed; drop the edits
            // queued behind it, and let the next connection's snapshot show what was saved.
            failure = USER_PREFERENCE_SAVE_UNCONFIRMED_MESSAGE;
            this.queuedPatches = [];
          } else {
            failure ??= USER_PREFERENCE_SAVE_FAILED_MESSAGE;
          }
        }
        this.inFlightPatches = [];
        this.publish();
      }
    } finally {
      this.pendingWrite = null;
    }
    if (failure) {
      showFeedbackToast({ type: "error", message: failure });
      throw new Error(failure);
    }
  }

  private publish(): void {
    const server = this.serverSnapshot;
    const patches = [...this.inFlightPatches, ...this.queuedPatches];
    const view =
      server && patches.length > 0
        ? {
            ...server,
            userPreferences:
              normalizeUserPreferences(
                patches.reduce<unknown>(
                  (preferences, patch) => applyMergePatch(preferences, patch),
                  server.userPreferences
                )
              ) ?? EMPTY_USER_PREFERENCES,
          }
        : server;
    const next = reuseUnchanged(this.snapshot, view);
    if (next !== this.snapshot) {
      this.snapshot = next;
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private runConfigChangedSubscription(client: APIClient): void {
    const controller = new AbortController();
    const { signal } = controller;
    this.subscriptionController = controller;

    let iterator: AsyncIterator<unknown> | null = null;

    void (async () => {
      try {
        const subscribedIterator = await client.config.onConfigChanged(undefined, { signal });

        // If the client was swapped while subscribe() was in flight,
        // force-close immediately so the backend drops its listener.
        if (signal.aborted || this.subscriptionController !== controller) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        this.subscriptionIterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void this.refresh();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup.
      } finally {
        void iterator?.return?.();
        if (this.subscriptionIterator === iterator) {
          this.subscriptionIterator = null;
        }
      }
    })();
  }
}

let storeInstance: AppConfigStore | null = null;

export function getAppConfigStore(): AppConfigStore {
  storeInstance ??= new AppConfigStore();
  return storeInstance;
}

/** `select` must return a slice of the snapshot, not a new object, or the hook re-renders forever. */
export function useAppConfig<T>(select: (config: AppConfigSnapshot) => T): T {
  const store = getAppConfigStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot() ?? EMPTY_SNAPSHOT));
}

export function getUserPreferences(): UserPreferences {
  return getAppConfigStore().getSnapshot()?.userPreferences ?? EMPTY_USER_PREFERENCES;
}

export function updateUserPreferences(patch: UserPreferencesPatch): void {
  getAppConfigStore().updateUserPreferences(patch);
}

export function flushUserPreferences(): Promise<void> {
  return getAppConfigStore().flushUserPreferences();
}

export function useUserPreferences<T>(select: (preferences: UserPreferences) => T): T {
  return useAppConfig((config) => select(config.userPreferences ?? EMPTY_USER_PREFERENCES));
}
