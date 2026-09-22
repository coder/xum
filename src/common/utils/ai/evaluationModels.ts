import type { ProviderName } from "@/common/constants/providers";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { TYPESAFE_PROVIDER_KEY } from "@/constants/autoModelRouting";

/**
 * Providers whose AI SDK package exposes `provider.evaluationModel(id)` and that
 * the evaluation resolver knows how to construct on a direct API-key route.
 * Eligibility is per provider (no model verification). `typesafe` is the
 * evaluation-only TypeSafe AI credential key (not a chat ProviderName; see
 * TYPESAFE_PROVIDER_KEY), so it can never be offered as a chat/agent model.
 */
export const EVALUATION_PROVIDERS = [
  TYPESAFE_PROVIDER_KEY,
  "openai",
  "anthropic",
  "google",
] as const satisfies ReadonlyArray<ProviderName | typeof TYPESAFE_PROVIDER_KEY>;

export type EvaluationProviderName = (typeof EVALUATION_PROVIDERS)[number];

export function isEvaluationProvider(providerName: string): providerName is EvaluationProviderName {
  return (EVALUATION_PROVIDERS as readonly string[]).includes(providerName);
}

/**
 * Pure prefix check after canonical normalization (a gateway-scoped string such
 * as `openrouter:openai/gpt-5` normalizes to `openai:gpt-5`). This answers "could
 * this model ever be evaluation-eligible?"; the route (direct API key vs.
 * gateway/OAuth) is decided by the resolver, not here.
 */
export function isEvaluationEligibleModelString(modelString: string): boolean {
  const canonical = normalizeToCanonical(modelString);
  const separator = canonical.indexOf(":");
  if (separator <= 0 || separator === canonical.length - 1) {
    return false;
  }
  return isEvaluationProvider(canonical.slice(0, separator));
}

/** Analytics/usage source tag for headless evaluation calls. */
export const EVALUATION_ANALYTICS_SOURCE = "workflow_evaluation";
