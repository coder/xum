import type { ProviderName } from "@/common/constants/providers";

export interface RouteContext {
  /** Canonical model string (e.g., "anthropic:claude-opus-4-8") */
  canonical: string;
  /** Origin provider — who made the model. Determines capabilities. */
  origin: ProviderName;
  /** Model ID in origin's namespace */
  originModelId: string;
  /** Route provider — who delivers it. Determines SDK format. */
  routeProvider: ProviderName;
  /** Model ID in route provider's format (may differ from originModelId) */
  routeModelId: string;
}

export interface AvailableRoute {
  route: string;
  displayName: string;
  isConfigured: boolean;
}
