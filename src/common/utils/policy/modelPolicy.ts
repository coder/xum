import type { EffectivePolicy, ProvidersConfigMap } from "@/common/orpc/types";
import { isGatewayModelAccessibleFromAuthoritativeCatalog } from "@/common/utils/providers/gatewayModelCatalog";

/**
 * Policy/model-string helpers shared by the browser picker and the backend
 * `models_list` tool. Moved verbatim from `src/browser/utils/policyUi.ts`
 * (which re-exports them) so the selectable-models pipeline can live in
 * `@/common` without importing browser code.
 */

/**
 * Parse a model string into provider and modelId.
 * Returns null if the string doesn't match the expected "provider:modelId" format.
 */
export function parseModelString(
  modelString: string
): { provider: string; modelId: string } | null {
  const colonIndex = modelString.indexOf(":");
  if (colonIndex <= 0 || colonIndex === modelString.length - 1) {
    return null;
  }

  return {
    provider: modelString.slice(0, colonIndex),
    modelId: modelString.slice(colonIndex + 1),
  };
}

/**
 * Check if a model is allowed by the effective policy.
 * Returns true if no policy is set, or if the model's provider is in the allowlist
 * and either no model restrictions exist or the model is in the allowed list.
 */
export function isModelAllowedByPolicy(
  policy: EffectivePolicy | null,
  modelString: string
): boolean {
  const providerAccess = policy?.providerAccess;
  if (providerAccess == null) {
    return true;
  }

  const parsed = parseModelString(modelString);
  if (!parsed) {
    return true;
  }

  const providerPolicy = providerAccess.find((p) => p.id === parsed.provider);
  if (!providerPolicy) {
    return false;
  }

  const allowedModels = providerPolicy.allowedModels ?? null;
  if (allowedModels === null) {
    return true;
  }

  return allowedModels.includes(parsed.modelId);
}

/**
 * Can this gateway serve the model? Mirrors the backend's routing-time check
 * (createGatewayModelAccessibilityChecker): the gateway's authoritative catalog
 * must list the model and the policy must allow the gateway model. A gateway
 * model that fails either check falls back to other routes on the backend, so
 * UI route resolution must not count it as a route.
 */
export function isGatewayModelAccessibleForUi(
  policy: EffectivePolicy | null,
  providersConfig: ProvidersConfigMap | null,
  gateway: string,
  modelId: string
): boolean {
  return (
    isModelAllowedByPolicy(policy, `${gateway}:${modelId}`) &&
    isGatewayModelAccessibleFromAuthoritativeCatalog(
      gateway,
      modelId,
      providersConfig?.[gateway]?.models,
      providersConfig?.[gateway]?.discoveredModels,
      providersConfig?.[gateway]?.removedModels
    )
  );
}
