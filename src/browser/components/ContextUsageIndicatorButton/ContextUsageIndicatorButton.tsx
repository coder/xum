import React from "react";
import { Hourglass } from "lucide-react";
import { TokenMeter } from "@/browser/features/RightSidebar/TokenMeter";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../Dialog/Dialog";
import {
  HorizontalThresholdSlider,
  getAutoCompactionLabel,
  getEffectiveThreshold,
  type AutoCompactionConfig,
} from "@/browser/features/RightSidebar/ThresholdSlider";
import { Switch } from "../Switch/Switch";
import { formatTokens, type TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { cn } from "@/common/lib/utils";
import { Toggle1MContext } from "../Toggle1MContext/Toggle1MContext";
import { COMPOSER_COMPACT_HIDE_CLASS, COMPOSER_CONTROL_HEIGHT_CLASS } from "@/constants/layout";

/** Compact threshold tick mark for the button view */
const CompactThresholdIndicator: React.FC<{ threshold: number }> = ({ threshold }) => {
  if (threshold >= 100) return null;

  return (
    <div
      className="bg-plan-mode pointer-events-none absolute top-0 z-50 h-full w-px"
      style={{ left: `${threshold}%` }}
    />
  );
};

export interface IdleCompactionConfig {
  /** Hours of inactivity before idle compaction triggers, or null if disabled */
  hours: number | null;
  /** Update the idle compaction hours setting */
  setHours: (hours: number | null) => void;
}

interface ContextUsageIndicatorButtonProps {
  data: TokenMeterData;
  autoCompaction?: AutoCompactionConfig;
  idleCompaction?: IdleCompactionConfig;
  /** Current model ID — used to show 1M context toggle for supported models */
  model?: string;
  /**
   * False while the workspace's chat history still replays. Usage comes from that history, so
   * empty `data` then means "not loaded yet", not "no usage" (#6101). Omitted means loaded.
   */
  historyLoaded?: boolean;
}

/** Tick marks with vertical lines attached to the meter */
const PercentTickMarks: React.FC = () => {
  const ticks = [0, 25, 50, 75, 100];
  return (
    <div className="relative -mt-1 h-5 w-full">
      {ticks.map((pct) => {
        const transform =
          pct === 0 ? "translateX(0%)" : pct === 100 ? "translateX(-100%)" : "translateX(-50%)";
        return (
          <div
            key={pct}
            className="absolute flex flex-col items-center"
            style={{ left: `${pct}%`, transform }}
          >
            <div className="bg-border-medium h-[3px] w-px" />
            <span className="text-muted text-[8px] leading-tight">{pct}</span>
          </div>
        );
      })}
    </div>
  );
};

function getUsageSliderHint(config: AutoCompactionConfig): string {
  if (!config.setThreshold) {
    return getAutoCompactionLabel(config);
  }
  return config.rolloverEnabled
    ? `${getAutoCompactionLabel(config)} · Drag blue slider to adjust`
    : "Drag blue slider to adjust usage-based auto-compaction";
}

/** Unified auto-compact settings panel */
const AutoCompactSettings: React.FC<{
  data: TokenMeterData;
  /** Usage text for the header, from getContextUsageLabels. */
  summary: string;
  /** Usage not loaded yet: `data` is empty for lack of data, so hide the limit warning too. */
  loading: boolean;
  usageConfig?: AutoCompactionConfig;
  idleConfig?: IdleCompactionConfig;
  model?: string;
}> = (props) => {
  const [idleInputValue, setIdleInputValue] = React.useState(
    props.idleConfig?.hours?.toString() ?? "24"
  );

  // Sync idle input when external hours change
  React.useEffect(() => {
    setIdleInputValue(props.idleConfig?.hours?.toString() ?? "24");
  }, [props.idleConfig?.hours]);

  const showUsageSlider = Boolean(props.usageConfig && props.data.maxTokens);
  const isIdleEnabled = props.idleConfig?.hours !== null && props.idleConfig?.hours !== undefined;

  const handleIdleToggle = (enabled: boolean) => {
    if (!props.idleConfig) return;
    const parsed = parseInt(idleInputValue, 10);
    props.idleConfig.setHours(enabled ? (Number.isNaN(parsed) || parsed < 1 ? 24 : parsed) : null);
  };

  const handleIdleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!props.idleConfig) return;
    const val = parseInt(e.target.value, 10);
    if (
      !isNaN(val) &&
      val >= 1 &&
      val !== props.idleConfig.hours &&
      props.idleConfig.hours !== null
    ) {
      props.idleConfig.setHours(val);
    } else if (e.target.value === "" || isNaN(val) || val < 1) {
      setIdleInputValue(props.idleConfig.hours?.toString() ?? "24");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Context Usage header with instruction */}
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-foreground font-medium">Context Usage</span>
          <span className="text-muted text-xs">{props.summary}</span>
        </div>
        {showUsageSlider && props.usageConfig && (
          <div className="text-muted counter-nums mt-1 text-[10px]">
            {getUsageSliderHint(props.usageConfig)}
          </div>
        )}
      </div>

      {/* Token meter with threshold slider + tick marks */}
      <div>
        <div className="relative w-full py-1.5">
          <TokenMeter segments={props.data.segments} orientation="horizontal" />
          {showUsageSlider && props.usageConfig && (
            <HorizontalThresholdSlider config={props.usageConfig} />
          )}
        </div>
        {showUsageSlider && <PercentTickMarks />}
      </div>

      {/* 1M context toggle for supported Anthropic models */}
      {props.model && <Toggle1MContext model={props.model} />}

      {/* Idle-based auto-compact */}
      {props.idleConfig && (
        <div className="border-separator-light border-t pt-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Hourglass className="text-muted h-2.5 w-2.5" />
              <span className="text-foreground text-[11px] font-medium">Idle compaction</span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                value={idleInputValue}
                onChange={(e) => setIdleInputValue(e.target.value)}
                onBlur={handleIdleBlur}
                disabled={!isIdleEnabled}
                className={cn(
                  "border-border-medium bg-background-secondary focus:border-accent h-5 w-10 rounded border px-1 text-center text-[11px] focus:outline-none",
                  !isIdleEnabled && "opacity-50"
                )}
              />
              <span className={cn("text-[10px]", isIdleEnabled ? "text-muted" : "text-muted/50")}>
                hrs
              </span>
              <Switch
                checked={isIdleEnabled}
                onCheckedChange={handleIdleToggle}
                className="scale-75"
              />
            </div>
          </div>
          <div className="text-muted mt-0.5 text-[10px]">
            Auto-compact after workspace inactivity
          </div>
        </div>
      )}

      {/* Warning for unknown model limits */}
      {!props.data.maxTokens && !props.loading && (
        <div className="text-subtle text-[10px] italic">
          Unknown model limits - showing relative usage only
        </div>
      )}

      {/* Persistence note */}
      <div className="text-muted border-separator-light border-t pt-2 text-[10px]">
        Usage threshold saved per model{props.idleConfig && "; idle timer saved per project"}
      </div>
    </div>
  );
};

/**
 * Button and dialog labels; a null `compactLabel` means usage is not loaded yet, so neither the
 * button nor the dialog shows a number.
 */
function getContextUsageLabels(
  data: TokenMeterData,
  historyLoaded: boolean | undefined
): { ariaLabel: string; compactLabel: string | null; summary: string } {
  // Cached rows or the pre-replay snapshot already carry usage and show it at once.
  if (historyLoaded === false && data.totalTokens === 0) {
    return { ariaLabel: "Context usage: loading", compactLabel: null, summary: "Loading" };
  }
  const total = formatTokens(data.totalTokens);
  if (!data.maxTokens) {
    return {
      ariaLabel: `Context usage: ${total} (unknown limit)`,
      compactLabel: total,
      summary: total,
    };
  }
  const summary = `${total} / ${formatTokens(data.maxTokens)} (${data.totalPercentage.toFixed(1)}%)`;
  return {
    ariaLabel: `Context usage: ${summary}`,
    compactLabel: `${Math.round(data.totalPercentage)}%`,
    summary,
  };
}

export const ContextUsageIndicatorButton: React.FC<ContextUsageIndicatorButtonProps> = (props) => {
  const idleHours = props.idleCompaction?.hours;
  const isIdleCompactionEnabled = idleHours !== null && idleHours !== undefined;

  // Show nothing only if no tokens AND no idle compaction config to display
  // (idle compaction settings should always be accessible when the prop is passed)
  if (props.data.totalTokens === 0 && !props.idleCompaction) return null;

  const { ariaLabel, compactLabel, summary } = getContextUsageLabels(
    props.data,
    props.historyLoaded
  );

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          className={cn(
            "border-border-light hover:bg-hover focus-visible:ring-accent flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 focus-visible:ring-1",
            COMPOSER_CONTROL_HEIGHT_CLASS
          )}
          type="button"
        >
          {/* Keep this control scannable: usage is already conveyed by the meter + percentage, and
            click opens the detailed compaction settings without a competing hover interaction. */}
          {isIdleCompactionEnabled && (
            <span className={COMPOSER_COMPACT_HIDE_CLASS}>
              <Hourglass className="text-muted h-3 w-3" />
            </span>
          )}

          {/* Narrow composers keep the percentage only: a 56px meter reads as an empty bar at
            low usage while starving the model and agent labels next to it. */}
          {props.data.totalTokens > 0 ? (
            <div
              data-context-usage-meter
              className={cn("relative h-3 w-14", COMPOSER_COMPACT_HIDE_CLASS)}
            >
              <TokenMeter
                segments={props.data.segments}
                orientation="horizontal"
                className="h-3"
                trackClassName="bg-surface-quaternary"
              />
              {props.autoCompaction && props.autoCompaction.threshold < 100 && (
                <CompactThresholdIndicator
                  threshold={getEffectiveThreshold(props.autoCompaction)}
                />
              )}
            </div>
          ) : (
            /* Empty meter placeholder - allows access to settings with no usage */
            <div
              data-context-usage-meter
              className={cn(
                "bg-surface-quaternary relative h-3 w-14 rounded-full",
                COMPOSER_COMPACT_HIDE_CLASS
              )}
            />
          )}

          <span
            data-context-usage-percent
            className="text-muted counter-nums text-[10px] font-medium"
          >
            {/* Static on purpose: the placeholder only stands in for the number (no pulse). */}
            {compactLabel ?? (
              <span
                aria-hidden
                className="bg-surface-quaternary inline-block h-2 w-[3ch] rounded"
              />
            )}
          </span>
        </button>
      </DialogTrigger>

      {/*
        Keep compaction controls in a dialog so auto + idle settings stay open
        while users adjust sliders/toggles, instead of depending on hover timing.
      */}
      <DialogContent maxWidth="380px" className="gap-3 p-3">
        <DialogHeader className="space-y-0">
          <DialogTitle className="text-sm">Compaction Settings</DialogTitle>
        </DialogHeader>
        {/* Keep manual /compact discoverability in the settings modal so the inline auto-compact hint stays minimal. */}
        <div className="text-muted text-[10px]">
          <div>
            Run <span className="font-mono">/compact</span> to compact manually
          </div>
          <div className="mt-1">
            • <span className="font-mono">-m model</span>
          </div>
          <div>
            • <span className="font-mono">-t max output tokens</span>
          </div>
          <div>• Add a followup message on the next line</div>
        </div>
        <AutoCompactSettings
          data={props.data}
          summary={summary}
          loading={compactLabel === null}
          usageConfig={props.autoCompaction}
          idleConfig={props.idleCompaction}
          model={props.model}
        />
      </DialogContent>
    </Dialog>
  );
};
