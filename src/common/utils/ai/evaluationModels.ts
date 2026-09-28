import type { ProviderName } from "@/common/constants/providers";
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

/** Analytics/usage source tag for headless evaluation calls. */
export const EVALUATION_ANALYTICS_SOURCE = "workflow_evaluation";
