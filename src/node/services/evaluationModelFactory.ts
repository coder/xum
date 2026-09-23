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
  TYPESAFE_PROVIDER_KEY,
  type AutoModelRoutingEvaluationProvider,
} from "@/constants/autoModelRouting";
import type { ProvidersConfigStore } from "@/node/config/providersConfigStore";
import type { PolicyService } from "@/node/services/policyService";
import {
  buildAIProviderRequestHeaders,
  normalizeAnthropicBaseURL,
  normalizeOpenAICompatibleBaseURL,
  withAnthropicEvaluationEffort,
} from "@/node/services/providerModelFactory";
import {
  resolveProviderCredentials,
  resolveTypeSafeCredentials,
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
  | { code: "custom_provider"; message: string }
  | { code: "missing_api_key"; message: string };

interface EvaluationModelTarget {
  provider: AutoModelRoutingEvaluationProvider;
  modelId: string;
  settings: { apiKey: string; baseURL?: string; headers: Record<string, string> };
  /** OpenAI only: the configured organization, as chat requests send it. */
  organization?: string;
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
  // A custom chat provider under a built-in id (or the reserved typesafe id) points that
  // id at a different endpoint. Its key must not reach an evaluation API, and falling
  // through to native env credentials would route the prompt around the user's endpoint.
  if (typeof entry === "object" && entry !== null && isCustomProviderConfig(entry)) {
    return Err({
      code: "custom_provider",
      message: `${provider} is a custom provider in providers.jsonc; evaluation needs the built-in provider`,
    });
  }
  const config: ProviderConfigRaw =
    typeof entry === "object" && entry !== null ? (entry as ProviderConfigRaw) : {};
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
  const configuredBaseURL = policy?.getForcedBaseUrl(provider) ?? credentials.baseUrl;
  // Same origin-only proxy handling as chat requests: the OpenAI and Anthropic SDKs need the
  // /v1 path that users routinely leave off, and a value the chat factory would fix up must
  // not send every classification to the wrong endpoint.
  const baseURL =
    configuredBaseURL == null
      ? undefined
      : evaluationProvider === "openai"
        ? normalizeOpenAICompatibleBaseURL(configuredBaseURL)
        : evaluationProvider === "anthropic"
          ? normalizeAnthropicBaseURL(configuredBaseURL)
          : configuredBaseURL;
  // Raw config: keep only string-valued header entries.
  const configHeaders =
    typeof config.headers === "object" && config.headers !== null
      ? Object.fromEntries(
          Object.entries(config.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  return Ok({
    provider: evaluationProvider,
    modelId,
    settings: {
      apiKey: credentials.apiKey,
      ...(baseURL ? { baseURL } : {}),
      // Proxy headers from providers.jsonc ride along, as they do for chat requests.
      headers: Object.fromEntries(buildAIProviderRequestHeaders(configHeaders).entries()),
    },
    ...(credentials.organization ? { organization: credentials.organization } : {}),
  });
}

export function createEvaluationModel(
  modelString: string,
  deps: EvaluationModelFactoryDeps
): Effect.Effect<Result<Experimental_EvaluationModelV4, EvaluationModelFailure>> {
  return Effect.gen(function* () {
    const target = resolveEvaluationModelTarget(modelString, deps);
    if (!target.success) return target;
    const { provider, modelId, settings, organization } = target.data;
    switch (provider) {
      case TYPESAFE_PROVIDER_KEY:
        return Ok(createTypeSafeAi(settings).evaluationModel(modelId));
      case "openai": {
        const { createOpenAI } = yield* Effect.promise(PROVIDER_REGISTRY.openai);
        return Ok(
          createOpenAI({ ...settings, ...(organization ? { organization } : {}) }).evaluationModel(
            modelId
          )
        );
      }
      case "anthropic": {
        const { createAnthropic } = yield* Effect.promise(PROVIDER_REGISTRY.anthropic);
        return Ok(
          withAnthropicEvaluationEffort(createAnthropic(settings).evaluationModel(modelId), modelId)
        );
      }
      case "google": {
        const { createGoogleGenerativeAI } = yield* Effect.promise(PROVIDER_REGISTRY.google);
        return Ok(createGoogleGenerativeAI(settings).evaluationModel(modelId));
      }
    }
  });
}
