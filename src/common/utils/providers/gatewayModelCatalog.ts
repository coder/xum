import type { ProviderModelEntry } from "@/common/orpc/types";

import { normalizeCopilotModelId } from "@/common/utils/copilot/modelRouting";
import { maybeGetProviderModelEntryId } from "@/common/utils/providers/modelEntries";

export function isProviderModelAccessibleFromAuthoritativeCatalog(
  provider: string,
  modelId: string,
  models: ProviderModelEntry[] | undefined,
  // Coder-only: the AI Bridge catalog discovered at login. It is the
  // authoritative accessible set; `models` only widens it with explicit
  // user additions and never narrows it.
  discoveredModels: string[] | undefined,
  // Coder-only: legacy removal tombstones (recorded by older versions of
  // applyCoderModelEdit; no longer written). Checked before every other
  // branch — including the unknown-catalog fail-open — because a removal
  // was made to force routing away from Coder and must hold even while
  // discovery is pending or failed, or routePriority could route the
  // removed model through Coder instead of the user's configured fallback.
  removedModels?: string[]
): boolean {
  // Coder routing is gated on the discovered AI Bridge catalog: the bridge
  // only serves models its upstreams expose, so routing any other model
  // through Coder would fail at the bridge instead of falling back to a
  // configured direct provider. A present `discoveredModels` (including an
  // empty one) marks the catalog as known and is the accessible set.
  // `models` is the user's explicit list (discovery never merges the catalog
  // into it), so its entries stay routable even when the catalog does not
  // list them, but a catalog model needs no `models` row to route. A MISSING
  // `discoveredModels` means the catalog is unknown (login clears it and
  // discovery is pending, or discovery failed transiently and was not
  // persisted): stay permissive so a temporary /models outage cannot strand
  // routing until the next login.
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
    return models?.some((entry) => maybeGetProviderModelEntryId(entry) === modelId) ?? false;
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
