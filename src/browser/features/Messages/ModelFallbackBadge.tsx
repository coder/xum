import React from "react";
import { ArrowRightLeft } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import type { ModelFallbackRecord } from "@/common/types/message";
import { formatModelStringForDisplay } from "@/common/utils/ai/models";

/**
 * Tooltip copy for a fallback badge, one line per entry.
 *
 * Exported for unit tests: Radix tooltip content renders through a portal that
 * happy-dom can't observe, so the formatting branches are tested directly.
 */
export function buildModelFallbackTooltipLines(
  record: ModelFallbackRecord,
  effectiveModel: string | undefined
): string[] {
  // Defensive: refusedModels always starts with the requested model; tolerate
  // malformed records by falling back to the requested model alone.
  const refused = record.refusedModels.length > 0 ? record.refusedModels : [record.requestedModel];
  const lines = refused.map((model, index) =>
    index === 0
      ? `Requested ${formatModelStringForDisplay(model)} refused to respond.`
      : `Fallback ${formatModelStringForDisplay(model)} also refused.`
  );
  // Truthy guard (not just !== undefined): an empty-string model must not
  // render a dangling "Answered by ." line; matches ModelDisplay's gating.
  if (effectiveModel) {
    lines.push(`Answered by ${formatModelStringForDisplay(effectiveModel)}.`);
  }
  return lines;
}

interface ModelFallbackBadgeProps {
  modelFallback: ModelFallbackRecord;
  /** The model that actually answered (the message's `model`). */
  effectiveModel?: string;
}

/**
 * Header badge shown when a configured model-fallback chain answered after the
 * requested model refused. The header itself shows the effective model, so
 * without this badge the swap would be invisible in the transcript.
 */
export const ModelFallbackBadge: React.FC<ModelFallbackBadgeProps> = (props) => {
  const lines = buildModelFallbackTooltipLines(props.modelFallback, props.effectiveModel);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* tabIndex makes the explanation keyboard-reachable (Radix opens tooltips on focus).
            data-model-fallback-badge is a stable selector for browser-automation checks. */}
        <span
          tabIndex={0}
          className="text-warning bg-warning/10 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase"
          data-model-fallback-badge
        >
          <ArrowRightLeft aria-hidden="true" className="h-3 w-3" />
          <span>fallback</span>
        </span>
      </TooltipTrigger>
      <TooltipContent align="center">
        {/* Keyed by index: distinct refused models can share a display name
            (e.g. the same model via two providers), so line text is not unique.
            The list is static per render and never reorders. */}
        {lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
};
