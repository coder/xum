import React from "react";
import { Route } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";
import { formatModelStringForDisplay } from "@/common/utils/ai/models";

function describeTier(record: AutoModelRoutingRecord): string {
  return record.tierLabel ?? record.tierId ?? "unknown tier";
}

export function buildAutoModelRoutingBadgeLabel(record: AutoModelRoutingRecord): string {
  const tierLabel = describeTier(record);
  switch (record.status) {
    case "routed":
      return `Auto: ${tierLabel}`;
    case "unmapped-tier":
      return `Auto: ${tierLabel} (no model mapped)`;
    case "fallback":
      return "Auto: fallback";
  }
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Tooltip copy for an auto-routing badge, one line per entry.
 *
 * Exported for unit tests: Radix tooltip content renders through a portal that
 * happy-dom can't observe, so the formatting branches are tested directly.
 */
export function buildAutoModelRoutingTooltipLines(record: AutoModelRoutingRecord): string[] {
  const lines: string[] = [];
  if (record.status === "fallback") {
    lines.push(
      `Classification failed${record.reason ? `: ${record.reason}` : ""}. Used ${formatModelStringForDisplay(record.requestedFallbackModel)}.`
    );
  } else {
    const tierLabel = describeTier(record);
    lines.push(
      record.confidence != null
        ? `Jev chose ${tierLabel} (${formatPercent(record.confidence)} confidence).`
        : `Jev chose ${tierLabel}.`
    );
    lines.push(
      record.status === "routed"
        ? `Ran on ${formatModelStringForDisplay(record.model)}.`
        : `No model mapped to this tier; used ${formatModelStringForDisplay(record.requestedFallbackModel)}.`
    );
  }
  const probabilities = Object.entries(record.probabilities ?? {}).sort(([, a], [, b]) => b - a);
  for (const [tierId, probability] of probabilities) {
    lines.push(`${tierId}: ${formatPercent(probability)}`);
  }
  return lines;
}

interface AutoModelRoutingBadgeProps {
  record: AutoModelRoutingRecord;
}

/**
 * Header badge shown when the composer's Auto entry routed a turn. The header
 * already shows the effective model; this explains which tier picked it.
 */
export const AutoModelRoutingBadge: React.FC<AutoModelRoutingBadgeProps> = (props) => {
  const lines = buildAutoModelRoutingTooltipLines(props.record);
  const isFallback = props.record.status !== "routed";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* tabIndex makes the explanation keyboard-reachable (Radix opens tooltips on focus). */}
        <span
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase",
            isFallback ? "text-warning bg-warning/10" : "text-accent bg-accent/10"
          )}
          data-auto-model-routing-badge={props.record.status}
        >
          <Route aria-hidden="true" className="h-3 w-3" />
          <span className="max-w-[12rem] truncate">
            {buildAutoModelRoutingBadgeLabel(props.record)}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent align="center">
        {lines.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
};
