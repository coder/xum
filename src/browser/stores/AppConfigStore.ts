import type { APIClient } from "@/browser/contexts/API";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { BashCollapsedSummaryMode, TranscriptDensity } from "@/common/constants/storage";
import type { AgentAiDefaults } from "@/common/types/agentAiDefaults";

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

  setClient(client: APIClient | null): void {
    this.client = client;

    this.subscriptionController?.abort();
    this.subscriptionController = null;
    void this.subscriptionIterator?.return?.();
    this.subscriptionIterator = null;
    // Invalidate in-flight fetches from the previous client.
    this.fetchVersion++;

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
        this.snapshot = {
          routePriority: config.routePriority,
          routeOverrides: config.routeOverrides,
          minThinkingLevelByModel: config.minThinkingLevelByModel,
          proposePlanImplementReplacesChatHistory:
            taskSettings?.proposePlanImplementReplacesChatHistory === true,
          // The webview projection may omit these (see redactWebviewOrpcResult).
          bashCollapsedSummaryMode: config.userPreferences?.appearance?.bashCollapsedSummaryMode,
          transcriptDensity: config.userPreferences?.appearance?.transcriptDensity,
          agentAiDefaults: config.agentAiDefaults,
        };
        this.notify();
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
