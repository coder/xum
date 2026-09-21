import { useCallback, useEffect, useRef, useState } from "react";
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
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);

  const fetchConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const loadedConfig = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }
      setLocalConfig(normalizeAutoModelRoutingConfig(loadedConfig.autoModelRouting));
    } catch {
      // Best-effort only.
    }
  }, [api]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchConfig();

    (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }
        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchConfig]);

  const [writeError, setWriteError] = useState<string | null>(null);
  const setConfig = useCallback(
    (next: AutoModelRoutingConfig) => {
      fetchVersionRef.current++;
      setLocalConfig(next);

      api?.config
        ?.updateAutoModelRouting({ autoModelRouting: next })
        .then(() => setWriteError(null))
        .catch((error: unknown) => {
          // If the write fails, re-fetch so the UI reverts to what the send path applies.
          setWriteError(getErrorMessage(error));
          void fetchConfig();
        });
    },
    [api, fetchConfig]
  );

  return { config, setConfig, writeError };
}
