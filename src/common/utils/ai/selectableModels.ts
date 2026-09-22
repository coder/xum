import { isCodexOauthAllowedModel, isCodexOauthRequiredModel } from "@/common/constants/codexOAuth";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { EffectivePolicy, ProvidersConfigMap } from "@/common/orpc/types";
import { isModelAvailable, resolveRoute } from "@/common/routing";
import {
  isGatewayModelAccessibleForUi,
  isModelAllowedByPolicy,
} from "@/common/utils/policy/modelPolicy";
import { isProviderModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";
import { getProviderModelEntryId } from "@/common/utils/providers/modelEntries";

/**
 * Selectable-models pipeline shared by the composer model picker
 * (useModelsFromSettings) and the backend `models_list` tool. One implementation
 * keeps routing, credential, authoritative-catalog, policy and hidden-model
 * filtering identical on both sides. The predicates below were moved verbatim
 * from the hook and take `providersConfig`/`effectivePolicy` as plain arguments
 * instead of closing over React state.
 */

export const BUILT_IN_MODELS: string[] = Object.values(KNOWN_MODELS).map((m) => m.id);

export interface SelectableModelsInput {
  /** null = provider config still loading (UI only): availability filters are skipped. */
  providersConfig: ProvidersConfigMap | null;
  hiddenModels: string[];
  /** null = policy not enforced. */
  effectivePolicy: EffectivePolicy | null;
  /** Mutable arrays match the resolveRoute/isModelAvailable signatures. */
  routePriority: string[];
  routeOverrides: Record<string, string>;
}

export function getCustomModels(config: ProvidersConfigMap | null): string[] {
  if (!config) return [];
  const models: string[] = [];
  for (const [provider, info] of Object.entries(config)) {
    // Skip mux-gateway - those models are accessed via the cloud toggle, not listed separately
    if (provider === "mux-gateway") continue;
    // Keep github-copilot's persisted catalog for authoritative model gating, not direct selector entries.
    if (provider === "github-copilot") continue;
    // Only surface custom models from enabled providers
    if (!info.isEnabled) continue;
    if (!info.models) continue;
    for (const modelEntry of info.models) {
      const modelId = getProviderModelEntryId(modelEntry);
      models.push(`${provider}:${modelId}`);
    }
  }
  return models;
}

export function filterHiddenModels(models: string[], hiddenModels: string[]): string[] {
  if (hiddenModels.length === 0) {
    return models;
  }

  const hidden = new Set(hiddenModels);
  return models.filter((m) => !hidden.has(m));
}

export function dedupeKeepFirst(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

export function getSuggestedModels(config: ProvidersConfigMap | null): string[] {
  const customModels = getCustomModels(config);
  return dedupeKeepFirst([...customModels, ...BUILT_IN_MODELS]);
}

/** A provider can serve requests: credentials resolved and not disabled by the user. */
export function isProviderConfigured(
  providersConfig: ProvidersConfigMap | null,
  provider: string
): boolean {
  return (
    providersConfig?.[provider]?.isConfigured === true &&
    providersConfig?.[provider]?.isEnabled !== false
  );
}

/**
 * Direct-provider counterpart of isGatewayModelAccessibleForUi: coder and
 * github-copilot carry authoritative catalogs that gate their own model IDs.
 */
export function isAuthoritativeProviderModelAccessible(
  providersConfig: ProvidersConfigMap | null,
  modelString: string
): boolean {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex <= 0 || colonIndex >= modelString.length - 1) {
    return true;
  }

  const provider = modelString.slice(0, colonIndex);
  const providerModelId = modelString.slice(colonIndex + 1);
  return isProviderModelAccessibleFromAuthoritativeCatalog(
    provider,
    providerModelId,
    providersConfig?.[provider]?.models,
    providersConfig?.[provider]?.discoveredModels,
    providersConfig?.[provider]?.removedModels
  );
}

/**
 * The OpenAI auth gates in this pipeline apply to the direct route only. A gateway
 * route (mux-gateway, openrouter, ...) supplies its own credentials, so the
 * user's OpenAI auth state must not hide, or warn about, models the gateway
 * serves. For a model with no active route, resolveRoute falls back to direct,
 * which keeps the gate in place.
 */
export function resolvesToDirectOpenAI(
  modelId: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible: (gateway: string, modelId: string) => boolean
): boolean {
  return (
    resolveRoute(modelId, routePriority, routeOverrides, isConfigured, isGatewayModelAccessible)
      .routeProvider === "openai"
  );
}

/**
 * Policy check on the identity the backend enforces. createModel resolves the
 * route first and then checks `isModelAllowed(routeProvider, routeModelId)`,
 * so a policy that lists only a gateway permits a canonical model whose active
 * route is that gateway. A model with no active route resolves to direct and is
 * checked under its canonical identity.
 */
export function isModelAllowedByPolicyOnActiveRoute(
  policy: EffectivePolicy | null,
  modelId: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible: (gateway: string, modelId: string) => boolean
): boolean {
  const route = resolveRoute(
    modelId,
    routePriority,
    routeOverrides,
    isConfigured,
    isGatewayModelAccessible
  );
  return isModelAllowedByPolicy(policy, `${route.routeProvider}:${route.routeModelId}`);
}

/**
 * The raw entries the composer picker offers, in picker order: custom models of
 * enabled providers, then built-ins, minus hidden models, filtered by
 * authoritative catalogs, route availability, direct-route OpenAI auth gating
 * and the policy on the active route.
 */
export function computeSelectableModels(input: SelectableModelsInput): string[] {
  const { providersConfig, hiddenModels, effectivePolicy, routePriority, routeOverrides } = input;
  const isConfigured = (provider: string) => isProviderConfigured(providersConfig, provider);
  const isGatewayModelAccessible = (gateway: string, modelId: string) =>
    isGatewayModelAccessibleForUi(effectivePolicy, providersConfig, gateway, modelId);

  const suggested = filterHiddenModels(getSuggestedModels(providersConfig), hiddenModels);

  // Hide models that are unavailable from both direct and gateway routes.
  // Keep all models visible while provider config is still loading to avoid UI flicker.
  const providerFiltered =
    providersConfig == null
      ? suggested
      : suggested.filter(
          (modelId) =>
            isAuthoritativeProviderModelAccessible(providersConfig, modelId) &&
            isModelAvailable(
              modelId,
              routePriority,
              routeOverrides,
              isConfigured,
              isGatewayModelAccessible
            )
        );

  const allowedByPolicy = (modelId: string) =>
    isModelAllowedByPolicyOnActiveRoute(
      effectivePolicy,
      modelId,
      routePriority,
      routeOverrides,
      isConfigured,
      isGatewayModelAccessible
    );
  if (providersConfig == null) {
    return effectivePolicy ? providerFiltered.filter(allowedByPolicy) : providerFiltered;
  }
  const hasOpenaiApiKey = providersConfig.openai?.apiKeySet === true;
  const hasCodexOauth = providersConfig.openai?.codexOauthSet === true;

  // OpenAI model gating (direct route only; see resolvesToDirectOpenAI):
  // - API key + OAuth: allow everything.
  // - API key only: hide models that require OAuth.
  // - OAuth only: show only models routable via OAuth.
  // - Neither: hide models that require OAuth (status quo).
  // providerFiltered already guarantees an active route, so the resolved
  // route is the real one rather than the direct fallback.
  const next = providerFiltered.filter((modelId) => {
    if (!modelId.startsWith("openai:")) {
      return true;
    }

    if (
      !resolvesToDirectOpenAI(
        modelId,
        routePriority,
        routeOverrides,
        isConfigured,
        isGatewayModelAccessible
      )
    ) {
      return true;
    }

    if (hasOpenaiApiKey && hasCodexOauth) {
      return true;
    }

    if (!hasOpenaiApiKey && hasCodexOauth) {
      return isCodexOauthAllowedModel(modelId, providersConfig);
    }

    return !isCodexOauthRequiredModel(modelId, providersConfig);
  });

  return effectivePolicy ? next.filter(allowedByPolicy) : next;
}
