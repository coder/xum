import React, { useState } from "react";
import { AlertTriangle, Check, CircleDot, GitCompareArrows } from "lucide-react";
import { MultiProjectDivergenceDialog } from "@/browser/components/GitStatusIndicator/MultiProjectDivergenceDialog";
import {
  useGitStatusRefreshing,
  useMultiProjectGitSummary,
  type MultiProjectGitSummary,
} from "@/browser/stores/GitStatusStore";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";
import { formatRepoCount } from "./gitStatusFormatters";

interface MultiProjectGitStatusIndicatorProps {
  workspaceId: string;
  tooltipPosition?: "right" | "bottom";
  isWorking?: boolean;
}

interface ChipPresentation {
  icon: React.ReactNode;
  primaryLabel: string;
  secondaryLabels: string[];
  className: string;
}

function formatCategoryCount(count: number, noun: string): string {
  return `${count} ${noun}`;
}

function buildTooltip(summary: MultiProjectGitSummary | null): string {
  if (summary === null) {
    return "Git status is loading for this workspace's repos.";
  }

  const parts: string[] = [];
  if (summary.divergedProjectCount > 0) {
    parts.push(`${summary.divergedProjectCount} of ${summary.totalProjectCount} repos diverged`);
  }
  if (summary.dirtyProjectCount > 0) {
    parts.push(
      `${summary.dirtyProjectCount} ${summary.dirtyProjectCount === 1 ? "has" : "have"} uncommitted changes`
    );
  }
  if (summary.unknownProjectCount > 0) {
    parts.push(
      `${summary.unknownProjectCount} ${summary.unknownProjectCount === 1 ? "repo is" : "repos are"} unavailable`
    );
  }

  if (parts.length === 0) {
    return `All ${formatRepoCount(summary.totalProjectCount)} are clean.`;
  }

  return parts.join("; ");
}

function getChipPresentation(
  summary: MultiProjectGitSummary | null,
  isWorking: boolean
): ChipPresentation {
  if (summary === null) {
    return {
      icon: <CircleDot aria-hidden="true" className="h-3 w-3" />,
      primaryLabel: "repos…",
      secondaryLabels: [],
      className:
        "border-border-light/40 text-muted-light hover:border-foreground/40 hover:text-foreground",
    };
  }

  if (summary.unknownProjectCount > 0) {
    return {
      icon: <AlertTriangle aria-hidden="true" className="h-3 w-3" />,
      primaryLabel: formatCategoryCount(summary.unknownProjectCount, "unknown"),
      secondaryLabels: [
        summary.divergedProjectCount > 0
          ? formatCategoryCount(summary.divergedProjectCount, "diverged")
          : null,
        summary.dirtyProjectCount > 0
          ? formatCategoryCount(summary.dirtyProjectCount, "dirty")
          : null,
      ].flatMap((value) => (value ? [value] : [])),
      className: "border-warning/30 text-warning hover:bg-warning/10 hover:text-warning",
    };
  }

  if (summary.divergedProjectCount > 0) {
    return {
      icon: <GitCompareArrows aria-hidden="true" className="h-3 w-3" />,
      primaryLabel: formatCategoryCount(summary.divergedProjectCount, "diverged"),
      secondaryLabels:
        summary.dirtyProjectCount > 0
          ? [formatCategoryCount(summary.dirtyProjectCount, "dirty")]
          : [],
      className: "border-accent/30 text-accent-text hover:bg-accent/10 hover:text-accent-text",
    };
  }

  if (summary.dirtyProjectCount > 0) {
    return {
      icon: <CircleDot aria-hidden="true" className="h-3 w-3" />,
      primaryLabel: formatCategoryCount(summary.dirtyProjectCount, "dirty"),
      secondaryLabels: [],
      className: "border-warning/30 text-git-dirty hover:bg-warning/10 hover:text-git-dirty",
    };
  }

  return {
    icon: <Check aria-hidden="true" className="h-3 w-3" />,
    primaryLabel: formatRepoCount(summary.totalProjectCount),
    secondaryLabels: [],
    className: isWorking
      ? "border-accent/30 text-accent-text hover:bg-accent/10 hover:text-accent-text"
      : "border-border-light/40 text-muted-light hover:border-foreground/40 hover:text-foreground",
  };
}

export const MultiProjectGitStatusIndicator: React.FC<MultiProjectGitStatusIndicatorProps> = ({
  workspaceId,
  tooltipPosition = "right",
  isWorking = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const trimmedWorkspaceId = workspaceId.trim();
  assert(
    trimmedWorkspaceId.length > 0,
    "MultiProjectGitStatusIndicator requires workspaceId to be a non-empty string."
  );

  const summary = useMultiProjectGitSummary(trimmedWorkspaceId);
  const isRefreshing = useGitStatusRefreshing(trimmedWorkspaceId);
  const tooltip = buildTooltip(summary);
  const presentation = getChipPresentation(summary, isWorking);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "counter-nums relative inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
              presentation.className,
              isRefreshing && "animate-pulse"
            )}
            aria-label="Open multi-project git status details"
            onKeyDown={stopKeyboardPropagation}
            onClick={(event) => {
              event.stopPropagation();
              setIsOpen(true);
            }}
          >
            {presentation.icon}
            <span className="counter-nums whitespace-nowrap">{presentation.primaryLabel}</span>
            {presentation.secondaryLabels.map((label) => (
              <span key={label} className="text-muted whitespace-nowrap">
                · <span className="counter-nums">{label}</span>
              </span>
            ))}
          </button>
        </TooltipTrigger>
        <TooltipContent side={tooltipPosition}>{tooltip}</TooltipContent>
      </Tooltip>
      <MultiProjectDivergenceDialog
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        summary={summary}
        isRefreshing={isRefreshing}
      />
    </>
  );
};
