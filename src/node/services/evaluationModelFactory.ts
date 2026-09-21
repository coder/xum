import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { Effect } from "effect";
import { PROVIDER_REGISTRY } from "@/common/constants/providers";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  isAutoModelRoutingEvaluationModel,
  splitAutoModelRoutingEvaluationModel,
} from "@/common/types/autoModelRouting";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { isProviderDisabledInConfig } from "@/common/utils/providers/isProviderDisabled";
import {
  AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS,
  TYPESAFE_API_KEY_ENV_VARS,
  TYPESAFE_PROVIDER_KEY,
  type AutoModelRoutingEvaluationProvider,
} from "@/constants/autoModelRouting";
import type { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import type { PolicyService } from "@/node/services/policyService";
import { buildAIProviderRequestHeaders } from "@/node/services/providerModelFactory";
import {
  resolveApiKeyCandidate,
  resolveProviderCredentials,
  type ProviderConfigRaw,
} from "@/node/utils/providerRequirements";

/**
 * Builds AI SDK evaluation models (`experimental_evaluate`) from the user's
 * `provider:model` choice. Mirrors the chat-model factory's contract in
 * miniature: providers.jsonc is the only credential source, an enforced policy
 * gates provider, model, and base URL, and every failure is a typed reason the
 * Settings status line can show.
 */

export interface EvaluationModelFactoryDeps {
  providersConfigStore: Pick<ProvidersConfigStore, "loadProvidersConfig">;
  policyService?: Pick<
    PolicyService,
    "isEnforced" | "isProviderAllowed" | "isModelAllowed" | "getForcedBaseUrl"
  >;
  env?: Record<string, string | undefined>;
}

export type EvaluationModelFailure =
  | { code: "invalid_model"; message: string }
  | { code: "policy_denied"; message: string }
  | { code: "provider_disabled"; message: string }
  | { code: "missing_api_key"; message: string };

interface EvaluationModelTarget {
  provider: AutoModelRoutingEvaluationProvider;
  modelId: string;
  settings: { apiKey: string; baseURL?: string; headers: Record<string, string> };
}

/**
 * Everything except the SDK import: credentials, policy, and base URL. Synchronous so
 * the Settings status line can report availability without loading a provider SDK.
 */
export function resolveEvaluationModelTarget(
  modelString: string,
  deps: EvaluationModelFactoryDeps
): Result<EvaluationModelTarget, EvaluationModelFailure> {
  if (!isAutoModelRoutingEvaluationModel(modelString)) {
    return Err({
      code: "invalid_model",
      message: `Evaluation model must be provider:model with one of ${AUTO_MODEL_ROUTING_EVALUATION_PROVIDERS.join(", ")}`,
    });
  }
  const { provider, modelId } = splitAutoModelRoutingEvaluationModel(modelString);
  const evaluationProvider = provider as AutoModelRoutingEvaluationProvider;
  const policy = deps.policyService?.isEnforced() ? deps.policyService : undefined;
  if (
    policy &&
    (!policy.isProviderAllowed(provider) || !policy.isModelAllowed(provider, modelId))
  ) {
    return Err({
      code: "policy_denied",
      message: `${modelString} is not allowed by provider policy`,
    });
  }
  const providersConfig = deps.providersConfigStore.loadProvidersConfig() ?? {};
  const entry: unknown = (providersConfig as Record<string, unknown>)[provider];
  // A custom chat provider under a built-in id (or the reserved typesafe id) owns the
  // key for a different endpoint; never send it to an evaluation API.
  const config: ProviderConfigRaw =
    typeof entry === "object" && entry !== null && !isCustomProviderConfig(entry)
      ? (entry as ProviderConfigRaw)
      : {};
  if (isProviderDisabledInConfig(config as { enabled?: unknown })) {
    return Err({
      code: "provider_disabled",
      message: `${provider} is disabled in providers.jsonc`,
    });
  }
  const env = deps.env ?? process.env;
  const credentials =
    evaluationProvider === TYPESAFE_PROVIDER_KEY
      ? resolveTypeSafeCredentials(config, env)
      : resolveProviderCredentials(evaluationProvider, config, env);
  if (!credentials.apiKey) {
    return Err({
      code: "missing_api_key",
      message: `No API key configured for ${provider} in providers.jsonc`,
    });
  }
  const baseURL = policy?.getForcedBaseUrl(provider) ?? credentials.baseUrl;
  return Ok({
    provider: evaluationProvider,
    modelId,
    settings: {
      apiKey: credentials.apiKey,
      ...(baseURL ? { baseURL } : {}),
      headers: Object.fromEntries(buildAIProviderRequestHeaders(undefined).entries()),
    },
  });
}

function resolveTypeSafeCredentials(
  config: ProviderConfigRaw,
  env: Record<string, string | undefined>
): { apiKey?: string; baseUrl?: string } {
  const resolved = resolveApiKeyCandidate(
    { apiKey: config.apiKey, apiKeyFile: config.apiKeyFile },
    {
      envApiKeys: [...TYPESAFE_API_KEY_ENV_VARS],
      env,
      fileErrors: "ignore",
    }
  );
  const baseUrl = typeof config.baseUrl === "string" && config.baseUrl ? config.baseUrl : undefined;
  return resolved.kind === "resolved" ? { apiKey: resolved.apiKey, baseUrl } : { baseUrl };
}

export function createEvaluationModel(
  modelString: string,
  deps: EvaluationModelFactoryDeps
): Effect.Effect<Result<Experimental_EvaluationModelV4, EvaluationModelFailure>> {
  return Effect.gen(function* () {
    const target = resolveEvaluationModelTarget(modelString, deps);
    if (!target.success) return target;
    const { provider, modelId, settings } = target.data;
    switch (provider) {
      case TYPESAFE_PROVIDER_KEY:
        return Ok(createTypeSafeAi(settings).evaluationModel(modelId));
      case "openai": {
        const { createOpenAI } = yield* Effect.promise(PROVIDER_REGISTRY.openai);
        return Ok(createOpenAI(settings).evaluationModel(modelId));
      }
      case "anthropic": {
        const { createAnthropic } = yield* Effect.promise(PROVIDER_REGISTRY.anthropic);
        return Ok(createAnthropic(settings).evaluationModel(modelId));
      }
      case "google": {
        const { createGoogleGenerativeAI } = yield* Effect.promise(PROVIDER_REGISTRY.google);
        return Ok(createGoogleGenerativeAI(settings).evaluationModel(modelId));
      }
    }
  });
}
