import {
  GATEWAY_PROVIDERS,
  PROVIDER_DEFINITIONS,
  type ProviderName,
} from "@/common/constants/providers";
import { getExplicitGatewayPrefix, normalizeToCanonical } from "@/common/utils/ai/models";

import type { AvailableRoute, GatewayModelIdResolver, RouteContext } from "./types";

interface RoutingProviderDefinition {
  displayName: string;
  kind: "direct" | "gateway" | "local";
  routes?: readonly ProviderName[];
  toGatewayModelId?: (origin: string, modelId: string) => string;
}

interface ParsedRoutingInput {
  origin: ProviderName;
  originModelId: string;
  explicitGateway?: ProviderName;
  explicitGatewayModelId?: string;
}

type GatewayModelAccessibility = (gateway: string, modelId: string) => boolean;

/**
 * Route priority used when config.json has none persisted. Shared by the browser
 * (useRouting) and the backend (models_list) so both resolve the same routes.
 */
export const DEFAULT_ROUTE_PRIORITY: string[] = ["direct"];

function getProviderDefinition(provider: string): RoutingProviderDefinition | undefined {
  if (!(provider in PROVIDER_DEFINITIONS)) {
    return undefined;
  }

  return PROVIDER_DEFINITIONS[provider as ProviderName] as RoutingProviderDefinition;
}

function parseRoutingInput(modelInput: string): ParsedRoutingInput {
  const explicitGateway = getExplicitGatewayPrefix(modelInput);
  const explicitGatewayModelId =
    explicitGateway == null ? undefined : modelInput.slice(modelInput.indexOf(":") + 1);

  const canonicalModel = normalizeToCanonical(modelInput);
  const colonIdx = canonicalModel.indexOf(":");
  const origin = (
    colonIdx === -1 ? canonicalModel : canonicalModel.slice(0, colonIdx)
  ) as ProviderName;
  const originModelId = colonIdx === -1 ? canonicalModel : canonicalModel.slice(colonIdx + 1);

  return {
    origin,
    originModelId,
    explicitGateway,
    explicitGatewayModelId,
  };
}

function getCanonicalRouteKey(parsed: ParsedRoutingInput): string {
  return `${parsed.origin}:${parsed.originModelId}`;
}

function directRouteContext(
  _modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>
): RouteContext {
  return {
    canonical: getCanonicalRouteKey(parsed),
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: parsed.origin,
    routeModelId: parsed.originModelId,
  };
}

function explicitGatewayRouteContext(
  _modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>
): RouteContext {
  const explicitGateway = parsed.explicitGateway;
  const explicitGatewayModelId = parsed.explicitGatewayModelId;
  if (explicitGateway == null || explicitGatewayModelId == null) {
    throw new Error("Explicit gateway route context requires an explicit gateway input");
  }

  return {
    canonical: getCanonicalRouteKey(parsed),
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: explicitGateway,
    // Preserve the caller's explicit gateway suffix instead of re-synthesizing it,
    // so slash-format gateways like OpenRouter don't double-prefix the origin.
    routeModelId: explicitGatewayModelId,
  };
}

// A provided resolver is authoritative for routed gateway contexts; without
// one, the static PROVIDER_DEFINITIONS route table decides.
function getGatewayRouteModelId(
  parsed: ReturnType<typeof parseRoutingInput>,
  gateway: string,
  resolveGatewayModelId?: GatewayModelIdResolver
): string | null {
  if (resolveGatewayModelId) {
    return resolveGatewayModelId(gateway, parsed.origin, parsed.originModelId);
  }
  const definition = getProviderDefinition(gateway);
  if (!definition?.toGatewayModelId || !definition.routes?.includes(parsed.origin)) {
    return null;
  }
  return definition.toGatewayModelId(parsed.origin, parsed.originModelId);
}

function gatewayRouteContext(
  _modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  gateway: ProviderName,
  routeModelId: string
): RouteContext {
  return {
    canonical: getCanonicalRouteKey(parsed),
    origin: parsed.origin,
    originModelId: parsed.originModelId,
    routeProvider: gateway,
    routeModelId,
  };
}

function getConfiguredDirectRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility
): RouteContext | null {
  if (!isConfigured(parsed.origin)) {
    return null;
  }

  if (
    getProviderDefinition(parsed.origin)?.kind === "gateway" &&
    isGatewayModelAccessible &&
    !isGatewayModelAccessible(parsed.origin, parsed.originModelId)
  ) {
    return null;
  }

  return directRouteContext(modelInput, parsed);
}

function getConfiguredExplicitGatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility
): RouteContext | null {
  if (parsed.explicitGateway == null || parsed.explicitGatewayModelId == null) {
    return null;
  }

  if (!isConfigured(parsed.explicitGateway)) {
    return null;
  }

  if (
    isGatewayModelAccessible &&
    !isGatewayModelAccessible(parsed.explicitGateway, parsed.explicitGatewayModelId)
  ) {
    return null;
  }

  return explicitGatewayRouteContext(modelInput, parsed);
}

function getConfiguredGatewayRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  gateway: string,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility,
  resolveGatewayModelId?: GatewayModelIdResolver
): RouteContext | null {
  if (getProviderDefinition(gateway)?.kind !== "gateway") {
    return null;
  }
  const routeModelId = getGatewayRouteModelId(parsed, gateway, resolveGatewayModelId);
  if (routeModelId == null || !isConfigured(gateway)) {
    return null;
  }

  if (isGatewayModelAccessible && !isGatewayModelAccessible(gateway, routeModelId)) {
    return null;
  }

  return gatewayRouteContext(modelInput, parsed, gateway as ProviderName, routeModelId);
}

// Keep active-route discovery separate from resolveRoute's last-resort fallback
// so browser availability checks stay aligned with the current override/priority state.
function findActiveRouteContext(
  modelInput: string,
  parsed: ReturnType<typeof parseRoutingInput>,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility,
  resolveGatewayModelId?: GatewayModelIdResolver
): RouteContext | null {
  // Explicit gateway is a preferred first candidate, not a dead-end.
  // If the gateway itself is configured, use it; otherwise fall through
  // to canonical override/priority routing so the underlying model
  // stays reachable via other configured routes.
  if (parsed.explicitGateway != null) {
    const explicit = getConfiguredExplicitGatewayRouteContext(
      modelInput,
      parsed,
      isConfigured,
      isGatewayModelAccessible
    );
    if (explicit) {
      return explicit;
    }
    // Fall through to canonical routing below
  }

  // 1. Check per-model override
  // Route overrides are stored under canonical model identity (for example, "openai:gpt-5"),
  // not under raw explicit gateway strings like "openrouter:openai/gpt-5".
  const canonicalKey = getCanonicalRouteKey(parsed);
  const override = routeOverrides[canonicalKey];
  if (override === "direct" || override === parsed.origin) {
    const direct = getConfiguredDirectRouteContext(
      modelInput,
      parsed,
      isConfigured,
      isGatewayModelAccessible
    );
    if (direct) {
      return direct;
    }
    // Direct override not viable — fall through to priority list
  }

  if (override) {
    const viaOverride = getConfiguredGatewayRouteContext(
      modelInput,
      parsed,
      override,
      isConfigured,
      isGatewayModelAccessible,
      resolveGatewayModelId
    );
    if (viaOverride) {
      return viaOverride;
    }
    // Override not viable — fall through to priority list
  }

  // 2. Walk routePriority
  for (const route of routePriority) {
    if (route === "direct") {
      const direct = getConfiguredDirectRouteContext(
        modelInput,
        parsed,
        isConfigured,
        isGatewayModelAccessible
      );
      if (direct) {
        return direct;
      }
      continue;
    }

    const viaPriority = getConfiguredGatewayRouteContext(
      modelInput,
      parsed,
      route,
      isConfigured,
      isGatewayModelAccessible,
      resolveGatewayModelId
    );
    if (viaPriority) {
      return viaPriority;
    }
  }

  return null;
}

/**
 * Pure route resolution. Given a routing input and routing config,
 * determine which provider to route through.
 */
export function resolveRoute(
  modelInput: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility,
  resolveGatewayModelId?: GatewayModelIdResolver
): RouteContext {
  const parsed = parseRoutingInput(modelInput);
  const resolved = findActiveRouteContext(
    modelInput,
    parsed,
    routePriority,
    routeOverrides,
    isConfigured,
    isGatewayModelAccessible,
    resolveGatewayModelId
  );
  if (resolved) {
    return resolved;
  }

  // 3. Nothing configured — fall back to direct (will fail at credential check later)
  return directRouteContext(modelInput, parsed);
}

/** Is this model reachable via the current configured routing state? */
export function isModelAvailable(
  modelInput: string,
  routePriority: string[],
  routeOverrides: Record<string, string>,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility,
  resolveGatewayModelId?: GatewayModelIdResolver
): boolean {
  const parsed = parseRoutingInput(modelInput);
  return (
    findActiveRouteContext(
      modelInput,
      parsed,
      routePriority,
      routeOverrides,
      isConfigured,
      isGatewayModelAccessible,
      resolveGatewayModelId
    ) != null
  );
}

/** Which routes can reach this model? Returns all possible routes with configuration status. */
export function availableRoutes(
  modelInput: string,
  isConfigured: (provider: string) => boolean,
  isGatewayModelAccessible?: GatewayModelAccessibility,
  resolveGatewayModelId?: GatewayModelIdResolver
): AvailableRoute[] {
  const parsed = parseRoutingInput(modelInput);
  const routes: AvailableRoute[] = [];

  // Add gateways that can route this origin
  for (const gateway of GATEWAY_PROVIDERS) {
    const routeModelId = getGatewayRouteModelId(parsed, gateway, resolveGatewayModelId);
    if (
      routeModelId != null &&
      (!isGatewayModelAccessible || isGatewayModelAccessible(gateway, routeModelId))
    ) {
      routes.push({
        route: gateway,
        displayName: PROVIDER_DEFINITIONS[gateway].displayName,
        isConfigured: isConfigured(gateway),
      });
    }
  }

  // Add direct route
  const originDefinition = getProviderDefinition(parsed.origin);
  const directIsAccessible =
    originDefinition?.kind !== "gateway" ||
    !isGatewayModelAccessible ||
    isGatewayModelAccessible(parsed.origin, parsed.originModelId);
  if (originDefinition && directIsAccessible) {
    routes.push({
      route: "direct",
      displayName: `Direct (${originDefinition.displayName})`,
      isConfigured: isConfigured(parsed.origin),
    });
  }

  return routes;
}
