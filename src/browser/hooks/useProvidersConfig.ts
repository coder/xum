import { useSyncExternalStore } from "react";
import { getProvidersConfigStore } from "@/browser/stores/ProvidersConfigStore";
import type { ProvidersConfigMap } from "@/common/orpc/types";

export function hasConfiguredProvider(config: ProvidersConfigMap | null): boolean {
  return config != null && Object.values(config).some((provider) => provider?.isConfigured);
}

/**
 * Hook to get provider config with automatic refresh on config changes.
 *
 * Backed by the app-wide ProvidersConfigStore (one fetch + one onConfigChanged
 * subscription per app session), so after the first load the config is
 * synchronously available on mount — config-derived banners can never pop in
 * after first paint on workspace switches. Use updateOptimistically for
 * instant UI feedback when saving; optimistic updates are visible to every
 * consumer, not just the caller.
 */
export function useProvidersConfig() {
  const store = getProvidersConfigStore();
  const config = useSyncExternalStore(store.subscribe, store.getConfig);
  const loaded = useSyncExternalStore(store.subscribe, store.isLoaded);
  return {
    config,
    loading: !loaded,
    refresh: store.refresh,
    updateOptimistically: store.updateOptimistically,
    updateModelsOptimistically: store.updateModelsOptimistically,
  };
}
