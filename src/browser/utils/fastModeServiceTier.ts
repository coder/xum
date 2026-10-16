import { isNonWorkspaceScopeId } from "@/common/constants/storage";
import { writeScopedAiPick } from "@/browser/utils/scopedAiDefaults";
import type { APIClient } from "@/browser/contexts/API";
import type { ServiceTier } from "@/common/config/schemas/providersConfig";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isGrokFrontierModel } from "@/common/types/thinking";
import { anthropicFastModeAvailable } from "@/common/utils/ai/anthropicFastMode";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";
import {
  openaiModelSupportsServiceTier,
  openaiServiceTierAvailable,
} from "@/common/utils/ai/openaiProviderOptionsAvailability";
import {
  customProviderWireOrigin,
  isCustomProviderConfig,
} from "@/common/utils/providers/customProviders";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";

export type FastModeProvider = "openai" | "xai" | "anthropic";
/**
 * The premium service tiers the selector toggles: Fast (priority) and OpenAI's
 * Ultrafast. They are mutually exclusive.
 */
export type PremiumServiceTier = "priority" | "ultrafast";

export interface FastModeAvailabilityOptions {
  resolvedRouteProvider?: string | null;
  providersConfig?: ProvidersConfigMap | null;
}

/**
 * Speed belongs to this chat, just like reasoning. Keep the pending pick for
 * the next send and nudge an active turn without changing any other chat's default.
 * Like the thinking level, a pick on the new-workspace page is the project (or global)
 * default instead, so it survives reloads and seeds later workspaces.
 */
export function setWorkspaceServiceTier(
  api: APIClient | null | undefined,
  scopeId: string,
  serviceTier: ServiceTier
): void {
  writeScopedAiPick(scopeId, "serviceTier", serviceTier);
  if (api != null && !isNonWorkspaceScopeId(scopeId)) {
    api.workspace.setActiveTurnServiceTier({ workspaceId: scopeId, serviceTier }).catch(() => {
      // Best-effort: a transient IPC failure must not discard the next-send pick.
    });
  }
}

/**
 * Speed belongs to the chat, like its reasoning level: the chat's own pick drives Fast mode
 * for every provider, so switching the chat's model keeps its speed instead of adopting the
 * new provider's setting. Only a chat without a pick inherits that provider's default.
 * "priority" is the provider-agnostic Fast choice; the backend maps it to Anthropic `speed`.
 */
export function resolveChatServiceTier(
  provider: FastModeProvider,
  chatServiceTier: ServiceTier | undefined,
  providersConfig: ProvidersConfigMap | null | undefined
): ServiceTier | undefined {
  if (chatServiceTier != null) return chatServiceTier;
  const providerConfig = providersConfig?.[provider];
  if (provider === "anthropic") return providerConfig?.speed === "fast" ? "priority" : undefined;
  return providerConfig?.serviceTier;
}

/** Turning a premium tier off must not re-inherit a premium provider default. */
export function toggleServiceTier(
  current: ServiceTier | undefined,
  target: PremiumServiceTier
): ServiceTier {
  return current === target ? "default" : target;
}

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
 * Ultrafast is offered like Fast mode (users expect it next to the Fast toggle), but
 * only where the request path would actually send it: the shared OpenAI tier
 * preference must reach the route, and the model and wire format must accept it.
 */
export function ultrafastModeAvailable(
  modelString: string,
  options?: FastModeAvailabilityOptions
): boolean {
  return (
    getFastModeProvider(modelString, options) === "openai" &&
    openaiModelSupportsServiceTier(modelString, "ultrafast", options)
  );
}

/**
 * Why getFastModeProvider returned null: "model" when the model has no Fast mode on any route,
 * "route" when the model has one but this route (gateway, custom provider, custom base URL, ...)
 * cannot send it. The shortcut's toast used to blame the route for every model, Gemini included
 * (#5753).
 */
export function getFastModeUnavailableReason(
  modelString: string,
  providersConfig: ProvidersConfigMap | null
): "model" | "route" {
  // The model's capability identity comes from the provider config, not from the route: an
  // explicit mapping ("Treat as") or a Coder instance's upstream, then a custom provider's
  // wire dialect (an anthropic-messages provider serving claude-opus-5-5 is an Opus model).
  let capabilityModel = normalizeToCanonical(resolveModelForMetadata(modelString, providersConfig));
  const separator = modelString.indexOf(":");
  const custom = separator > 0 ? providersConfig?.[modelString.slice(0, separator)] : undefined;
  if (isCustomProviderConfig(custom) && capabilityModel === normalizeToCanonical(modelString)) {
    const wireOrigin = customProviderWireOrigin(custom.providerType);
    if (wireOrigin != null) capabilityModel = `${wireOrigin}:${modelString.slice(separator + 1)}`;
  }
  // That model's own provider, called directly, is the route where Fast mode works if the model
  // has it at all. No config here: config gates (missing provider, ZDR) are route reasons too.
  return getFastModeProvider(capabilityModel, { resolvedRouteProvider: "direct" })
    ? "route"
    : "model";
}
