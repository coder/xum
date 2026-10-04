import { resolveCoderCanonicalRouteInstance } from "@/common/constants/coderOAuth";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import type { ProviderModelEntry } from "@/common/orpc/types";
import type { GatewayModelIdResolver } from "@/common/routing/types";

import { normalizeToCanonical } from "@/common/utils/ai/models";
import { normalizeCopilotModelId } from "@/common/utils/copilot/modelRouting";
import { maybeGetProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isProviderModelAccessibleFromAuthoritativeCatalog(
  provider: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined,
  // Coder-only: the AI Bridge catalog discovered at login. It is the
  // authoritative accessible set; `models` can only widen it.
  discoveredModels: string[] | undefined,
  // Coder-only: durable user removals (see applyCoderModelEdit). Checked
  // before every other branch — including the unknown-catalog fail-open —
  // because an explicit removal must hold even while discovery is pending
  // or failed, or routePriority could route the removed model through Coder
  // instead of the user's configured fallback.
  removedModels?: string[]
): boolean {
  // Coder routing is gated on the discovered AI Bridge catalog: the bridge
  // only serves models its upstreams expose, so routing any other model
  // through Coder would fail at the bridge instead of falling back to a
  // configured direct provider. A present `discoveredModels` (including an
  // empty one) marks the catalog as known and is the accessible set; `models`
  // entries stay routable too (manual additions are not in the catalog), but
  // a catalog model needs no `models` row. A MISSING `discoveredModels` means
  // the catalog is unknown (login clears it and discovery is pending, or
  // discovery failed transiently and was not persisted): stay permissive so a
  // temporary /models outage cannot strand routing until the next login.
  if (provider === "coder") {
    if (removedModels?.includes(modelId)) {
      return false;
    }
    if (!Array.isArray(discoveredModels)) {
      return true;
    }
    if (discoveredModels.includes(modelId)) {
      return true;
    }
    // Google catalogs list `models/<id>` while native selections and the
    // gateway use the bare id; without this a loaded catalog would reject
    // every mapped Gemini route.
    const separatorIndex = modelId.indexOf("/");
    if (
      separatorIndex > 0 &&
      discoveredModels.includes(
        `${modelId.slice(0, separatorIndex)}/models/${modelId.slice(separatorIndex + 1)}`
      )
    ) {
      return true;
    }
    // providers.jsonc is hand-editable JSON: a non-array `models` must not throw here.
    return (
      Array.isArray(models) &&
      models.some((entry) => maybeGetProviderModelEntryId(entry) === modelId)
    );
  }

  // Most provider config model lists are user-managed custom entries, not exhaustive
  // server catalogs. GitHub Copilot is the other exception because OAuth refresh
  // stores the full model catalog returned by Copilot's /models endpoint.
  if (provider !== "github-copilot") {
    return true;
  }

  if (!Array.isArray(models) || models.length === 0) {
    return true;
  }

  const normalizedModelId = normalizeCopilotModelId(modelId);
  let foundValidEntry = false;
  for (const entry of models) {
    const configuredModelId = maybeGetProviderModelEntryId(entry);
    if (configuredModelId == null) {
      continue;
    }

    foundValidEntry = true;
    if (normalizeCopilotModelId(configuredModelId) === normalizedModelId) {
      return true;
    }
  }

  return !foundValidEntry;
}

export function isGatewayModelAccessibleFromAuthoritativeCatalog(
  gateway: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined,
  discoveredModels: string[] | undefined,
  removedModels?: string[]
): boolean {
  return isProviderModelAccessibleFromAuthoritativeCatalog(
    gateway,
    modelId,
    models,
    discoveredModels,
    removedModels
  );
}

interface GatewayRoutingProviderEntry {
  models?: unknown;
  discoveredModels?: unknown;
  removedModels?: unknown;
  canonicalRoutes?: unknown;
  discoveredProviders?: unknown;
  additionalProviders?: unknown;
}

export interface GatewayRouting {
  /** Authoritative-catalog gate for a gateway-scoped model ID. */
  isGatewayModelAccessible: (gateway: string, gatewayModelId: string) => boolean;
  /** Which gateway model ID serves a routed canonical model (see GatewayModelIdResolver). */
  resolveGatewayModelId: GatewayModelIdResolver;
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

/**
 * Config-derived gateway routing inputs for resolveRoute/isModelAvailable/
 * availableRoutes, shared by the browser (ProvidersConfigMap) and the backend
 * (raw providers.jsonc) so both make identical routing decisions. Bundled so a
 * caller cannot apply the Coder catalog gate without the canonicalRoutes
 * mapping (or vice versa).
 */
export function createGatewayRouting(
  providersConfig: Readonly<Record<string, GatewayRoutingProviderEntry | undefined>> | null
): GatewayRouting {
  const coderConfig = providersConfig?.coder;
  // Coder-only keys: validated once because hand-edited providers.jsonc can
  // hold any shape.
  const coderDiscoveredModels = toStringArray(coderConfig?.discoveredModels);
  const coderRemovedModels = toStringArray(coderConfig?.removedModels);
  return {
    isGatewayModelAccessible: (gateway, gatewayModelId) => {
      const models = providersConfig?.[gateway]?.models;
      return isGatewayModelAccessibleFromAuthoritativeCatalog(
        gateway,
        gatewayModelId,
        Array.isArray(models) ? (models as ProviderModelEntry[]) : undefined,
        gateway === "coder" ? coderDiscoveredModels : undefined,
        gateway === "coder" ? coderRemovedModels : undefined
      );
    },
    resolveGatewayModelId: (gateway, origin, originModelId) => {
      if (gateway === "coder") {
        const instance = resolveCoderCanonicalRouteInstance(origin, coderConfig);
        return instance == null ? null : `${instance}/${originModelId}`;
      }
      if (!Object.hasOwn(PROVIDER_DEFINITIONS, gateway)) {
        return null;
      }
      const definition = PROVIDER_DEFINITIONS[gateway as ProviderName];
      if (
        definition.kind !== "gateway" ||
        !(definition.routes as readonly string[]).includes(origin)
      ) {
        return null;
      }
      return definition.toGatewayModelId(origin, originModelId);
    },
  };
}

/**
 * The Coder gateway model ID a selection reaches when its route is Coder: an
 * explicit coder:<instance>/<model> stays literal, a canonical model goes to
 * the instance canonicalRoutes selects. Null when Coder cannot serve it.
 */
export function resolveCoderRouteGatewayModelId(
  modelString: string,
  providersConfig: Readonly<Record<string, GatewayRoutingProviderEntry | undefined>> | null
): string | null {
  if (modelString.startsWith("coder:")) {
    return modelString.slice("coder:".length);
  }
  const canonical = normalizeToCanonical(modelString);
  const colonIndex = canonical.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }
  return createGatewayRouting(providersConfig).resolveGatewayModelId(
    "coder",
    canonical.slice(0, colonIndex),
    canonical.slice(colonIndex + 1)
  );
}
