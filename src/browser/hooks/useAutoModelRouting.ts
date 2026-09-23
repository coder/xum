import { useEffect, useRef, useState } from "react";
import { useOptionalAPI } from "@/browser/contexts/API";
import {
  getDefaultAutoModelRoutingConfig,
  normalizeAutoModelRoutingConfig,
  type AutoModelRoutingConfig,
} from "@/common/types/autoModelRouting";
import { getErrorMessage } from "@/common/utils/errors";

export interface AutoModelRoutingState {
  config: AutoModelRoutingConfig;
  // Arrow-function property type so consumers can destructure without
  // tripping @typescript-eslint/unbound-method.
  /** Full replacement of the tiers and evaluation model; the backend normalizes before persisting. */
  setConfig: (config: AutoModelRoutingConfig) => void;
  /** Last rejected write, cleared by the next successful one; the optimistic edit is reverted. */
  writeError: string | null;
}

/**
 * Reads/writes the auto-model-routing config (tiers and evaluation model) from app config.
 *
 * Mirrors useModelFallbacks: fetch on mount, subscribe to config changes,
 * optimistically apply local edits while ignoring stale fetches.
 */
export function useAutoModelRouting(): AutoModelRoutingState {
  const api = useOptionalAPI()?.api ?? null;
  const [config, setLocalConfig] = useState<AutoModelRoutingConfig>(() =>
    getDefaultAutoModelRoutingConfig()
  );
  const [writeError, setWriteError] = useState<string | null>(null);
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);
  // A rejected write re-fetches by re-running the subscription effect below, which owns the
  // only fetch closure (no memoized callback to thread through effect dependencies).
  const [refetchVersion, setRefetchVersion] = useState(0);

  useEffect(() => {
    const configApi = api?.config;
    const onConfigChanged = configApi?.onConfigChanged;
    if (!configApi?.getConfig || !onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const fetchConfig = async () => {
      const fetchVersion = ++fetchVersionRef.current;
      try {
        const loadedConfig = await configApi.getConfig();
        if (fetchVersion !== fetchVersionRef.current || signal.aborted) {
          return;
        }
        setLocalConfig(normalizeAutoModelRoutingConfig(loadedConfig.autoModelRouting));
      } catch {
        // Best-effort only.
      }
    };

    (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }
        iterator = subscribedIterator;
        // Load only once the subscription is live: a save landing between an earlier snapshot
        // and this point would be the one change event this panel never sees.
        void fetchConfig();
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchConfig();
        }
      } catch {
        // Cancelled via the abort signal on cleanup. A refused subscription still loads the
        // current config once so the panel does not sit on defaults.
        if (!signal.aborted) void fetchConfig();
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refetchVersion]);

  const setConfig = (next: AutoModelRoutingConfig) => {
    fetchVersionRef.current++;
    setLocalConfig(next);

    api?.config
      ?.updateAutoModelRouting({ autoModelRouting: next })
      .then(() => setWriteError(null))
      .catch((error: unknown) => {
        // If the write fails, re-fetch so the UI reverts to what the send path applies.
        setWriteError(getErrorMessage(error));
        setRefetchVersion((version) => version + 1);
      });
  };

  return { config, setConfig, writeError };
}
