import React from "react";
import { AlertTriangle, X } from "lucide-react";
import { getModelName } from "@/common/utils/ai/models";
import type { ContextSwitchWarning as WarningData } from "@/browser/utils/compaction/contextSwitchCheck";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".0", "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

interface Props {
  warning: WarningData;
  onCompact: () => void;
  onDismiss: () => void;
}

/**
 * Warning banner shown when user switches to a model that can't fit the current context.
 */
export const ContextSwitchWarning: React.FC<Props> = (props) => {
  const targetName = getModelName(props.warning.targetModel);
  const compactName = props.warning.compactionModel
    ? getModelName(props.warning.compactionModel)
    : null;

  return (
    <div
      data-testid="context-switch-warning"
      className="bg-background-secondary border-plan-mode rounded-md border px-4 py-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-plan-mode mb-1 flex items-center gap-2 text-[13px] font-medium">
            <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            <span>Context May Exceed Model Limit</span>
          </div>
          <p className="text-foreground/80 text-[12px] leading-relaxed">
            Current context ({formatTokens(props.warning.currentTokens)} tokens) may exceed the{" "}
            <span className="font-medium">{targetName}</span> limit (
            {formatTokens(props.warning.targetLimit)}). Consider compacting before sending.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onDismiss}
          className="text-muted hover:text-foreground -mt-1 -mr-1 cursor-pointer p-1"
          title="Dismiss"
          aria-label="Dismiss context limit warning"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        {props.warning.errorMessage ? (
          <span className="text-error text-[12px]">{props.warning.errorMessage}</span>
        ) : (
          <button
            type="button"
            onClick={props.onCompact}
            className="bg-plan-mode/20 hover:bg-plan-mode/30 text-plan-mode cursor-pointer rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
          >
            Compact with {compactName}
          </button>
        )}
      </div>
    </div>
  );
};
