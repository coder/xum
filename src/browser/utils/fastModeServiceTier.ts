import type { APIClient } from "@/browser/contexts/API";
import type {
  FastModePreviousServiceTier,
  ServiceTier,
} from "@/common/config/schemas/providersConfig";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import type { ProviderConfigInfo, ProvidersConfigMap } from "@/common/orpc/types";
import { isGrokFrontierModel } from "@/common/types/thinking";
import { anthropicFastModeAvailable } from "@/common/utils/ai/anthropicFastMode";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import { openaiServiceTierAvailable } from "@/common/utils/ai/openaiProviderOptionsAvailability";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

export type FastModeProvider = "openai" | "xai" | "anthropic";
/** Providers whose Fast mode is the priority service tier. */
type ServiceTierFastModeProvider = Exclude<FastModeProvider, "anthropic">;

export interface FastModeServiceTierChange {
  apiValue: ServiceTier | "";
  serviceTier: ServiceTier | undefined;
  previousServiceTier: FastModePreviousServiceTier | undefined;
}

export interface FastModeAvailabilityOptions {
  resolvedRouteProvider?: string | null;
  providersConfig?: ProvidersConfigMap | null;
}

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

/** Return the provider preference whose priority tier powers Fast mode on this route. */
export function getFastModeProvider(
  modelString: string,
  options?: FastModeAvailabilityOptions
): FastModeProvider | null {
  if (openaiServiceTierAvailable(modelString, options)) {
    return "openai";
  }
  if (anthropicFastModeAvailable(modelString, options)) {
    return "anthropic";
  }

  const normalized = normalizeToCanonical(modelString);
  const [origin] = normalized.split(":", 2);
  const capabilityModel = resolveModelForMetadata(normalized, options?.providersConfig ?? null);
  if (origin !== "xai" || !isGrokFrontierModel(capabilityModel)) return null;

  // xAI service_tier is also provider-native and cannot survive a gateway route.
  const explicitGateway = getExplicitGatewayPrefix(modelString);
  if (explicitGateway != null) {
    const gatewayConfig = options?.providersConfig?.[explicitGateway];
    const gatewayDefinition = PROVIDER_DEFINITIONS[explicitGateway];
    const gatewayWinsRoute =
      options?.providersConfig == null ||
      (gatewayConfig?.isConfigured === true &&
        gatewayConfig.isEnabled !== false &&
        gatewayDefinition.kind === "gateway" &&
        (gatewayDefinition.routes as readonly string[]).includes("xai"));
    if (gatewayWinsRoute) return null;
  }

  return options?.resolvedRouteProvider == null || options.resolvedRouteProvider === "direct"
    ? "xai"
    : null;
}

/**
 * Fast mode is a temporary priority-tier override. The restore target lives in
 * providers.jsonc so every browser origin and desktop client observes the same state.
 */
export function getFastModeServiceTierChange(
  provider: ServiceTierFastModeProvider,
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): FastModeServiceTierChange {
  if (currentServiceTier !== "priority") {
    return {
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: currentServiceTier ?? "unset",
    };
  }

  // Legacy OpenAI priority configs predate the restore field. xAI's only standard
  // tier is default, so its equivalent fallback must not emit unsupported "auto".
  const restoreServiceTier = previousServiceTier ?? (provider === "openai" ? "auto" : "default");
  return {
    apiValue: restoreServiceTier === "unset" ? "" : restoreServiceTier,
    serviceTier: restoreServiceTier === "unset" ? undefined : restoreServiceTier,
    previousServiceTier: undefined,
  };
}

/**
 * OpenAI and xAI express Fast mode as the priority service tier; Anthropic uses a
 * separate `speed` preference because its own service_tier means something else.
 */
export function isFastModeActive(
  provider: FastModeProvider,
  providerConfig: ProviderConfigInfo | undefined
): boolean {
  return provider === "anthropic"
    ? providerConfig?.speed === "fast"
    : providerConfig?.serviceTier === "priority";
}

/**
 * Toggle Fast mode for the provider and return the persisted config patch to apply
 * optimistically, or null when a write failed (callers should refresh).
 */
export async function applyFastModeToggle(
  providers: ProviderConfigWriter,
  provider: FastModeProvider,
  providerConfig: ProviderConfigInfo | undefined
): Promise<Partial<ProviderConfigInfo> | null> {
  if (provider === "anthropic") {
    const enable = providerConfig?.speed !== "fast";
    // Standard is the API default, so disabling removes the key instead of
    // persisting "standard" (keeps providers.jsonc minimal).
    const result = await providers.setProviderConfig({
      provider,
      keyPath: ["speed"],
      value: enable ? "fast" : "",
    });
    if (!result.success) return null;
    return { speed: enable ? "fast" : undefined };
  }

  const change = await applyFastModeServiceTierChange(
    providers,
    provider,
    providerConfig?.serviceTier,
    providerConfig?.fastModePreviousServiceTier
  );
  if (change == null) return null;
  return {
    serviceTier: change.serviceTier,
    fastModePreviousServiceTier: change.previousServiceTier,
  };
}

/** Persist the provider-specific restore target and service-tier override in a safe order. */
export async function applyFastModeServiceTierChange(
  providers: ProviderConfigWriter,
  provider: ServiceTierFastModeProvider,
  currentServiceTier: ServiceTier | undefined,
  previousServiceTier?: FastModePreviousServiceTier
): Promise<FastModeServiceTierChange | null> {
  const change = getFastModeServiceTierChange(provider, currentServiceTier, previousServiceTier);

  if (currentServiceTier !== "priority") {
    const rememberResult = await providers.setProviderConfig({
      provider,
      keyPath: ["fastModePreviousServiceTier"],
      value: change.previousServiceTier ?? "unset",
    });
    if (!rememberResult.success) return null;
  }

  const tierResult = await providers.setProviderConfig({
    provider,
    keyPath: ["serviceTier"],
    value: change.apiValue,
  });
  if (!tierResult.success) return null;

  if (currentServiceTier === "priority") {
    const clearResult = await providers.setProviderConfig({
      provider,
      keyPath: ["fastModePreviousServiceTier"],
      value: "",
    });
    if (!clearResult.success) return null;
  }

  return change;
}
