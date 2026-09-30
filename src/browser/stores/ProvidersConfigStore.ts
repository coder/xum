import { useSyncExternalStore } from "react";
import type { APIClient } from "@/browser/contexts/API";
import type {
  ProviderConfigInfo,
  ProviderModelEntry,
  ProvidersConfigMap,
} from "@/common/orpc/types";

/**
 * App-wide shared cache of the providers config.
 *
 * Previously every `useProvidersConfig()` consumer (a dozen components,
 * including ChatPane and ChatInput) issued its own `providers.getConfig()`
 * fetch plus its own `onConfigChanged` subscription on mount. Besides the
 * IPC fan-out, the per-mount fetch meant `config` was `null` for the first
 * frames of EVERY mount — so config-derived UI (CompactionWarning,
 * CodexOauthWarningBanner) popped in after first paint on every workspace
 * switch, visibly shifting the composer dock.
 *
 * One store = one fetch + one subscription per app session, and after the
 * first load the config is synchronously available to every consumer. The
 * `isLoaded` signal participates in the chat view's first-paint readiness
 * barrier (see useChatViewDataReady).
 */
export class ProvidersConfigStore {
  private client: APIClient | null = null;
  private config: ProvidersConfigMap | null = null;
  private loaded = false;
  private listeners = new Set<() => void>();
  // Version counter to ignore stale responses from out-of-order fetches
  // (and to invalidate in-flight fetches when an optimistic update lands).
  private fetchVersion = 0;
  private subscriptionController: AbortController | null = null;
  // Live onConfigChanged iterator. Kept on the instance (not just in the
  // subscription closure) so setClient can force-close it: some oRPC
  // iterators don't eagerly close on abort alone, and leaving the old one
  // open across client swaps/reconnects leaks backend EventEmitter listeners
  // and keeps stale refresh loops alive.
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

  getConfig = (): ProvidersConfigMap | null => this.config;

  isLoaded = (): boolean => this.loaded;

  refresh = async (): Promise<void> => {
    const client = this.client;
    if (!client) return;
    const myVersion = ++this.fetchVersion;
    try {
      const cfg = await client.providers.getConfig();
      // Only update if this is the latest fetch (ignore stale responses).
      if (myVersion === this.fetchVersion) {
        this.config = cfg;
        this.notify();
      }
    } catch {
      // Ignore errors fetching config.
    } finally {
      // Mark loaded even on failure so consumers (and the chat first-paint
      // barrier) never block on a broken config fetch — self-healing over
      // stuck loading states.
      if (myVersion === this.fetchVersion && !this.loaded) {
        this.loaded = true;
        this.notify();
      }
    }
  };

  /**
   * Optimistically update local state for instant UI feedback.
   * Call this immediately when saving, before the API call completes.
   * Bumps the fetch version to invalidate any in-flight fetches that would
   * overwrite this optimistic state with stale data.
   */
  updateOptimistically = (provider: string, updates: Partial<ProviderConfigInfo>): void => {
    this.fetchVersion++;

    const prev = this.config;
    if (!prev) return;

    this.config = {
      ...prev,
      [provider]: { ...prev[provider], ...updates },
    };
    this.notify();
  };

  /**
   * Optimistically update models for a provider.
   * Returns the new models array for use in the API call.
   * Bumps the fetch version to invalidate any in-flight fetches.
   */
  updateModelsOptimistically = (
    provider: string,
    updater: (currentModels: ProviderModelEntry[]) => ProviderModelEntry[]
  ): ProviderModelEntry[] => {
    this.fetchVersion++;

    const prev = this.config;
    if (!prev) return [];

    const currentModels = prev[provider]?.models ?? [];
    const newModels = updater(currentModels);

    this.config = {
      ...prev,
      [provider]: { ...prev[provider], models: newModels },
    };
    this.notify();
    return newModels;
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
        const subscribedIterator = await client.providers.onConfigChanged(undefined, { signal });

        // If the client was swapped while subscribe() was in flight,
        // force-close immediately so the backend drops its listener.
        if (signal.aborted || this.subscriptionController !== controller) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;
        // Publish so setClient can return() it (see subscriptionIterator).
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

let storeInstance: ProvidersConfigStore | null = null;

export function getProvidersConfigStore(): ProvidersConfigStore {
  storeInstance ??= new ProvidersConfigStore();
  return storeInstance;
}

/**
 * True once the providers config has been fetched (or the fetch failed) for
 * the current app session. Synchronously true afterwards for every consumer.
 */
export function useProvidersConfigLoaded(): boolean {
  const store = getProvidersConfigStore();
  return useSyncExternalStore(store.subscribe, store.isLoaded);
}
