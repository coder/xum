import { useSyncExternalStore } from "react";
import { isPlainObject } from "@/common/utils/isPlainObject";
import type { APIClient } from "@/browser/contexts/API";
import type { UserPreferences } from "@/common/config/schemas/userPreferences";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { BashCollapsedSummaryMode, TranscriptDensity } from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";
import type { ExperimentId } from "@/common/constants/experiments";

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

const EMPTY_SNAPSHOT: AppConfigSnapshot = {};
const INITIAL_READ_RETRY_MS = 250;
const MAX_INITIAL_READ_RETRY_MS = 5_000;
const EMPTY_USER_PREFERENCES: UserPreferences = {};

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
  private snapshot: AppConfigSnapshot | null = null;
  private listeners = new Set<() => void>();
  // Version counter to ignore stale responses from out-of-order fetches
  // (and to invalidate in-flight fetches when an optimistic update lands).
  private fetchVersion = 0;
  private subscriptionController: AbortController | null = null;
  // Live onConfigChanged iterator, kept on the instance so setClient can
  // force-close it (see ProvidersConfigStore for the leak rationale).
  private subscriptionIterator: AsyncIterator<unknown> | null = null;
  private loadedCurrentClient = false;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    this.wait = wait;
  }

  setClient(client: APIClient | null): void {
    // Reconnecting the current client (stories wire it beside APIProvider) keeps its subscription.
    if (client === this.client) return;
    this.client = client;

    this.subscriptionController?.abort();
    this.subscriptionController = null;
    void this.subscriptionIterator?.return?.();
    this.subscriptionIterator = null;
    // Invalidate in-flight fetches from the previous client.
    this.fetchVersion++;
    this.loadedCurrentClient = false;

    if (!client) {
      return;
    }

    const controller = new AbortController();
    this.subscriptionController = controller;
    void this.loadInitialConfig(controller.signal);
    this.runConfigChangedSubscription(client, controller);
  }

  // onConfigChanged may never fire on an idle backend, so a failed first read is retried until
  // one succeeds; otherwise the app would stay on defaults with no base for later writes.
  private async loadInitialConfig(signal: AbortSignal): Promise<void> {
    for (let delayMs = INITIAL_READ_RETRY_MS; ; ) {
      await this.refresh();
      if (signal.aborted || this.loadedCurrentClient) return;
      await this.wait(delayMs);
      if (signal.aborted || this.loadedCurrentClient) return;
      delayMs = Math.min(delayMs * 2, MAX_INITIAL_READ_RETRY_MS);
    }
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
    const myVersion = ++this.fetchVersion;
    try {
      const config = await client.config.getConfig();
      // Only update if this is the latest fetch (ignore stale responses).
      if (myVersion === this.fetchVersion) {
        // The VS Code webview host projects the config and forwards taskSettings only with
        // this one flag, or not at all (#4942), so read it defensively.
        const taskSettings = config.taskSettings as
          | { proposePlanImplementReplacesChatHistory?: boolean }
          | undefined;
        const next = reuseUnchanged(this.snapshot, {
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
        });
        this.loadedCurrentClient = true;
        if (next !== this.snapshot) {
          this.snapshot = next;
          this.notify();
        }
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
    this.fetchVersion++;
    this.snapshot = { ...this.snapshot, ...updates };
    this.notify();
  };

  /** Forgets the loaded config, so nothing shows another server's values before the next fetch. */
  clearCachedState = (): void => {
    this.fetchVersion++;
    this.snapshot = null;
    this.notify();
  };

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private runConfigChangedSubscription(client: APIClient, controller: AbortController): void {
    const { signal } = controller;

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

export function useUserPreferences<T>(select: (preferences: UserPreferences) => T): T {
  return useAppConfig((config) => select(config.userPreferences ?? EMPTY_USER_PREFERENCES));
}
