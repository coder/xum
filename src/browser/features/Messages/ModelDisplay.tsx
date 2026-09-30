import React from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { ProviderIcon } from "@/browser/components/ProviderIcon/ProviderIcon";
import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  formatModelStringForDisplay,
  getModelProvider,
  normalizeToCanonical,
} from "@/common/utils/ai/models";

interface ModelDisplayProps {
  modelString: string;
  /** Whether to show the tooltip on hover (default: true, set to false when used within another tooltip) */
  showTooltip?: boolean;
  /** @deprecated Legacy signal; prefer routeProvider for source attribution. */
  routedThroughGateway?: boolean;
  /** Route provider used by backend routing for this response (if different from origin provider). */
  routeProvider?: string;
}

function resolveRouteProvider(
  routeProvider: string | undefined,
  routedThroughGateway: boolean | undefined
): string | undefined {
  return routeProvider ?? (routedThroughGateway ? "mux-gateway" : undefined);
}

function getRouteDisplayName(
  routeProvider: string | undefined,
  originProvider: string
): string | null {
  if (!routeProvider || routeProvider === originProvider) {
    return null;
  }

  if (routeProvider in PROVIDER_DEFINITIONS) {
    return PROVIDER_DEFINITIONS[routeProvider as ProviderName].displayName;
  }

  return routeProvider;
}

/**
 * Display a model name with its origin provider icon.
 * When metadata says the request was routed through a gateway/provider, show that as "via …".
 */
export const ModelDisplay: React.FC<ModelDisplayProps> = (props) => {
  const canonicalModel = normalizeToCanonical(props.modelString);
  const originProvider = getModelProvider(canonicalModel);
  const displayName = formatModelStringForDisplay(canonicalModel);
  const resolvedRouteProvider = resolveRouteProvider(
    props.routeProvider,
    props.routedThroughGateway
  );
  const routeDisplayName = getRouteDisplayName(resolvedRouteProvider, originProvider);
  const showTooltip = props.showTooltip ?? true;

  const iconClass =
    "mr-[0.3em] inline-block h-[1.1em] w-[1.1em] align-[-0.19em] [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg_.st0]:fill-current [&_svg_circle]:!fill-current [&_svg_path]:!fill-current [&_svg_rect]:!fill-current";

  const content = (
    <span className="inline normal-case" data-model-display>
      <ProviderIcon provider={originProvider} className={iconClass} data-model-icon />
      <span className="inline">{displayName}</span>
      {routeDisplayName ? (
        <span className="text-muted ml-1 inline">via {routeDisplayName}</span>
      ) : null}
    </span>
  );

  if (!showTooltip) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-model-display-tooltip>{content}</span>
      </TooltipTrigger>
      <TooltipContent align="center" data-model-tooltip-text>
        {canonicalModel}
        {routeDisplayName ? (
          <>
            <br />
            via {routeDisplayName}
          </>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
};
