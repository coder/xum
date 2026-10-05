import { useRef, useState } from "react";

import { Button } from "@/browser/components/Button/Button";
import { ProviderWithIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useAPI } from "@/browser/contexts/API";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  CODER_CANONICAL_ROUTE_ORIGINS,
  type CoderCanonicalRouteOrigin,
  type CoderCanonicalRoutes as CoderCanonicalRoutesMap,
  type CoderGatewayProvider,
} from "@/common/constants/coderOAuth";
import { PROVIDER_DISPLAY_NAMES } from "@/common/constants/providers";
import { getErrorMessage } from "@/common/utils/errors";

// Radix Select reserves "" for clearing the selection, so "Default" needs a sentinel.
const DEFAULT_VALUE = "__default__";

const DEFAULT_LABELS: Record<CoderCanonicalRouteOrigin, string> = {
  anthropic: "Default (anthropic instance)",
  openai: "Default (openai instance)",
  google: "Default (not routed through Coder)",
};

/**
 * Settings card mapping each canonical provider to the same-type AI Gateway
 * instance that serves its native models when route priority picks Coder.
 */
export function CoderCanonicalRoutes() {
  const { api } = useAPI();
  const { config, refresh, updateOptimistically } = useProvidersConfig();
  const coder = config?.coder;
  const routes: CoderCanonicalRoutesMap = coder?.canonicalRoutes ?? {};
  // Same precedence as resolveCoderCanonicalRouteInstance: user-declared
  // instances win over discovered ones with the same name.
  const instancesByName = new Map<string, CoderGatewayProvider>();
  for (const instance of [
    ...(coder?.discoveredProviders ?? []),
    ...(coder?.additionalProviders ?? []),
  ]) {
    instancesByName.set(instance.name, instance);
  }
  const instances = [...instancesByName.values()];

  const [writeError, setWriteError] = useState<string | null>(null);
  const [providerRefreshState, setProviderRefreshState] = useState<
    { kind: "idle" } | { kind: "refreshing" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const providerRefreshInFlightRef = useRef(false);

  const setRoute = async (origin: CoderCanonicalRouteOrigin, instance: string | null) => {
    if (!api) {
      return;
    }
    const next = { ...routes };
    if (instance == null) {
      delete next[origin];
    } else {
      next[origin] = instance;
    }
    setWriteError(null);
    updateOptimistically("coder", { canonicalRoutes: next });
    let error: string;
    try {
      const result = await api.providers.setProviderConfig({
        provider: "coder",
        keyPath: ["canonicalRoutes", origin],
        value: instance ?? "",
      });
      if (result.success) {
        return;
      }
      error = result.error;
    } catch (err) {
      error = getErrorMessage(err);
    }
    setWriteError(error);
    await refresh();
  };

  const refreshProviders = async () => {
    if (!api || providerRefreshInFlightRef.current) {
      return;
    }
    providerRefreshInFlightRef.current = true;
    setProviderRefreshState({ kind: "refreshing" });
    try {
      const result = await api.coderOauth.refreshProviders();
      if (!result.success) {
        setProviderRefreshState({ kind: "error", message: result.error });
        return;
      }
      setProviderRefreshState({ kind: "idle" });
      await refresh();
    } catch (err) {
      setProviderRefreshState({ kind: "error", message: getErrorMessage(err) });
    } finally {
      providerRefreshInFlightRef.current = false;
    }
  };

  return (
    <div className="border-border-light space-y-2 border-t pt-3">
      <div>
        <label className="text-foreground block text-xs font-medium">Model routing</label>
        <p className="text-muted text-xs">
          Native models use the selected Coder provider when route priority picks Coder.
        </p>
      </div>

      {CODER_CANONICAL_ROUTE_ORIGINS.map((origin) => {
        const mapped = routes[origin];
        const options = instances.filter((instance) => instance.type === origin);
        const mappingIsStale =
          mapped != null && !options.some((instance) => instance.name === mapped);
        return (
          <div key={origin} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ProviderWithIcon
                provider={origin}
                displayName
                className="text-foreground min-w-24 text-xs"
              />
              <Select
                value={mapped ?? DEFAULT_VALUE}
                onValueChange={(value) => {
                  setRoute(origin, value === DEFAULT_VALUE ? null : value).catch((err: unknown) => {
                    setWriteError(getErrorMessage(err));
                  });
                }}
              >
                <SelectTrigger
                  className="w-full min-w-0 sm:w-64"
                  aria-label={`${PROVIDER_DISPLAY_NAMES[origin]} Coder provider`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>{DEFAULT_LABELS[origin]}</SelectItem>
                  {mappingIsStale && <SelectItem value={mapped}>{mapped} (not found)</SelectItem>}
                  {options.map((instance) => (
                    <SelectItem key={instance.name} value={instance.name}>
                      {instance.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mappingIsStale && (
              <p className="text-warning text-xs">
                {mapped} is not a known {PROVIDER_DISPLAY_NAMES[origin]} provider on this
                deployment, so {PROVIDER_DISPLAY_NAMES[origin]} models will not route through Coder
                until you pick another one.
              </p>
            )}
          </div>
        );
      })}

      {instances.length === 0 && (
        <p className="text-muted text-xs">
          No AI Gateway providers are known yet. Listing them needs AI Gateway provider read access
          on the deployment; refresh, or declare instances under additionalProviders in
          providers.jsonc.
        </p>
      )}

      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          refreshProviders().catch((err: unknown) => {
            setProviderRefreshState({ kind: "error", message: getErrorMessage(err) });
          });
        }}
        disabled={!api || providerRefreshState.kind === "refreshing"}
      >
        {providerRefreshState.kind === "refreshing" ? "Refreshing..." : "Refresh providers"}
      </Button>

      {providerRefreshState.kind === "error" && (
        <p className="text-destructive text-xs">
          Provider refresh failed: {providerRefreshState.message}
        </p>
      )}
      {writeError != null && (
        <p className="text-destructive text-xs">Saving model routing failed: {writeError}</p>
      )}
    </div>
  );
}
