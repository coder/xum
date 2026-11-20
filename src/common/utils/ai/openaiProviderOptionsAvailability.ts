/** Route-aware availability for OpenAI-native request options. */
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { OpenAIWireFormat } from "@/common/types/providerOptions";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { wouldRouteOpenAIThroughCodexOauth } from "@/common/utils/providers/codexOauthRouting";
import {
  isGatewayModelAccessibleFromAuthoritativeCatalog,
  resolveCoderRouteGatewayModelId,
} from "@/common/utils/providers/gatewayModelCatalog";
import { resolveCoderWireCanonicalModel } from "@/common/constants/coderOAuth";
import { resolveCoderGatewayMetadataModel } from "@/common/utils/providers/coderGatewayMetadata";
import { isCustomProviderConfig } from "@/common/utils/providers/customProviders";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { openaiGptTier } from "@/common/types/thinking";

export interface OpenAIDirectProviderOptionsAvailability {
  /** Settings-resolved route for the canonical model ("direct" = no gateway). */
  resolvedRouteProvider?: string | null;
  /** Providers config for explicit gateway and Codex OAuth route detection. */
  providersConfig?: ProvidersConfigMap | null;
  /** Request-level OpenAI wire format; the stored config value wins when set. */
  openaiWireFormat?: OpenAIWireFormat | null;
}

/** Share explicit-gateway precedence between direct-only options and Pro mode. */
export function resolveProviderOptionsRoute(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): string {
  const [origin] = normalizeToCanonical(modelString).split(":", 2);

  // Explicit gateway selections only win while that gateway is configured and
  // enabled. Otherwise the backend falls through to the settings-resolved route.
  const explicitGateway = getExplicitGatewayPrefix(modelString);
  if (explicitGateway != null) {
    const gatewayConfig = options?.providersConfig?.[explicitGateway];
    const gatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
    const gatewayWinsRoute =
      options?.providersConfig == null ||
      (gatewayConfig?.isConfigured === true &&
        gatewayConfig.isEnabled !== false &&
        gatewayDefinition.kind === "gateway" &&
        (origin === explicitGateway ||
          (gatewayDefinition.routes as readonly string[]).includes(origin)) &&
        // A removed/catalog-excluded Coder model must use the resolved fallback,
        // even while the gateway itself remains connected.
        (explicitGateway !== "coder" ||
          isGatewayModelAccessibleFromAuthoritativeCatalog(
            explicitGateway,
            modelString.slice(modelString.indexOf(":") + 1),
            gatewayConfig.models,
            gatewayConfig.discoveredModels,
            gatewayConfig.removedModels
          )));
    if (gatewayWinsRoute) {
      return explicitGateway;
    }
  }

  return options?.resolvedRouteProvider ?? "direct";
}

function resolveServiceTierModel(
  modelString: string,
  providersConfig: ProvidersConfigMap | null | undefined
): string {
  if (modelString.startsWith("coder:")) {
    return resolveCoderGatewayMetadataModel(modelString, providersConfig) ?? modelString;
  }
  return normalizeToCanonical(modelString);
}

/**
 * Whether the route and model accept the given OpenAI service tier. The caller
 * first checks if the route accepts any service tiers (openaiServiceTierAvailable).
 *
 * Ultrafast (`service_tier: "ultrafast"`, launched at DevDay 2026-09-29) is
 * model-gated: among the supported models OpenAI serves it only for the GPT
 * tiers OPENAI_GPT_TIERS marks (GPT-5.6 Sol preview access is no longer
 * supported). Ultrafast is also Responses-only: the Chat Completions
 * service_tier enum has no "ultrafast" and rejects it with a 400 (see
 * ultrafastWireAccepted). https://developers.openai.com/api/docs/guides/ultrafast-mode
 *
 * Flex is dropped only for a GPT tier that OpenAI does not offer it on (GPT-6.2);
 * other models, custom ids included, keep the route-only gate.
 *
 * Callers drop a refused tier (Standard or the project default) instead of
 * switching to another paid tier.
 */
export function openaiModelSupportsServiceTier(
  modelString: string,
  serviceTier: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  if (usesCodexServiceTier(modelString, options)) {
    return CODEX_SERVICE_TIERS.has(serviceTier);
  }
  return openaiApiModelSupportsServiceTier(modelString, serviceTier, options);
}

const CODEX_SERVICE_TIERS = new Set(["priority", "default"]);

function usesCodexServiceTier(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  const { providersConfig, openaiWireFormat } = options ?? {};
  return (
    resolveProviderOptionsRoute(modelString, options) === "direct" &&
    wouldRouteOpenAIThroughCodexOauth(
      resolveServiceTierModel(modelString, providersConfig),
      providersConfig,
      {
        openaiWireFormat,
      }
    )
  );
}

function openaiApiModelSupportsServiceTier(
  modelString: string,
  serviceTier: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  switch (serviceTier) {
    case "ultrafast":
      return (
        ultrafastWireAccepted(modelString, options) &&
        openaiServiceTierCapabilities(modelString, options)?.ultrafast === true
      );
    case "flex":
      return openaiServiceTierCapabilities(modelString, options)?.flex !== false;
    default:
      return true;
  }
}

function openaiServiceTierCapabilities(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
) {
  // Mapped aliases and Coder models use the upstream model's tier capabilities.
  return openaiGptTier(resolveModelForMetadata(modelString, options?.providersConfig ?? null));
}

/**
 * Whether the wire this route actually speaks accepts Ultrafast. An allowlist that fails
 * closed: only routes that send OpenAI's own Responses API keep the 6x tier. Gateways with
 * their own adapters (OpenRouter's chat API, Copilot's Chat Completions) do not
 * accept "ultrafast", and each route pins its own wire, so the direct OpenAI wireFormat
 * setting must not decide for them.
 */
function ultrafastWireAccepted(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  const providersConfig = options?.providersConfig;
  const custom = providersConfig?.[modelString.split(":", 1)[0]];
  // Only openai-responses custom providers carry tiers (openaiServiceTierAvailable), and
  // they always speak Responses.
  if (isCustomProviderConfig(custom)) return custom.providerType === "openai-responses";

  const route = resolveProviderOptionsRoute(modelString, options);
  if (route === "coder") {
    // The factory pins a Coder route's wire from the instance type: only "openai"
    // instances speak Responses; "openai-compat" instances use Chat Completions.
    const gatewayModelId = resolveCoderRouteGatewayModelId(modelString, providersConfig ?? null);
    const wire =
      gatewayModelId == null
        ? null
        : resolveCoderWireCanonicalModel(gatewayModelId, providersConfig?.coder);
    return wire?.providerType === "openai";
  }
  if (route !== "direct") return false;
  // Direct OpenAI: the stored wire format wins over the request-level one, as in the factory.
  const wireFormat =
    providersConfig?.openai?.wireFormat ?? options?.openaiWireFormat ?? "responses";
  return wireFormat !== "chatCompletions";
}

/** Fast shares OpenAI's preference across gateways that forward its service tier. */
export function openaiServiceTierAvailable(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  // A config without this shared preference's write target must not expose
  // Fast or inject a hidden saved tier.
  if (options?.providersConfig != null && options.providersConfig.openai == null) return false;

  const prefix = modelString.split(":", 1)[0];
  const custom = options?.providersConfig?.[prefix];
  if (isCustomProviderConfig(custom)) {
    // The generic compatible SDK does not serialize OpenAI-native service tiers.
    return custom.providerType === "openai-responses";
  }

  const route = resolveProviderOptionsRoute(modelString, options);
  if (route === "coder") {
    const gatewayModelId = resolveCoderRouteGatewayModelId(
      modelString,
      options?.providersConfig ?? null
    );
    const wire =
      gatewayModelId == null
        ? null
        : resolveCoderWireCanonicalModel(gatewayModelId, options?.providersConfig?.coder);
    // Other Coder types (e.g. Google) also speak chat completions; that alone
    // cannot establish OpenAI tier support. Unknown instances fail closed.
    return wire?.providerType === "openai" || wire?.providerType === "openai-compat";
  }

  const normalized = resolveServiceTierModel(modelString, options?.providersConfig);
  const [origin, modelId] = normalized.split(":", 2);
  if (origin === "github-copilot") {
    // Copilot's unscoped catalog mixes upstreams; capability mappings cannot
    // turn Claude/Gemini into OpenAI models. Both Copilot adapters forward tiers.
    return /^(?:gpt-\d|o[1-9](?:-|$))/.test(modelId);
  }
  if (origin !== "openai") return false;
  if (route === "openrouter" || route === "github-copilot") {
    return true;
  }
  // Both direct OpenAI API requests and Codex OAuth requests support Fast.
  return route === "direct";
}

export function openaiDirectProviderOptionsAvailable(
  modelString: string,
  options?: OpenAIDirectProviderOptionsAvailability
): boolean {
  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  if (origin !== "openai" || resolveProviderOptionsRoute(modelString, options) !== "direct") {
    return false;
  }

  // Codex OAuth normalizes requests for the ChatGPT backend and strips OpenAI
  // API-only provider options, so toggles for those options must fail closed.
  return !(
    options?.providersConfig != null &&
    wouldRouteOpenAIThroughCodexOauth(normalized, options.providersConfig, {
      openaiWireFormat: options.openaiWireFormat,
    })
  );
}
