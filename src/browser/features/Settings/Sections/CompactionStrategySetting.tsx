import { useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useTelemetry } from "@/browser/hooks/useTelemetry";
import { useExperiment, useExperimentValue } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import assert from "@/common/utils/assert";
import { SETTING_SELECT_TRIGGER_CLASS, SettingRow } from "../Components/SettingsLayout";

const COMPACTION_STRATEGIES = [
  { value: "summarize", label: "Summarize" },
  { value: "continuous", label: "Continuous" },
  { value: "token-budget", label: "Token Budget" },
] as const;
type CompactionStrategy = (typeof COMPACTION_STRATEGIES)[number]["value"];

// The strategy is two experiment flags. Whole selections run one at a time, across Settings
// remounts too, so rapid choices cannot interleave their writes and leave both flags on.
let compactionStrategyWrites: Promise<void> = Promise.resolve();

/**
 * The strategy the two flags mean. Preserve legacy both-enabled precedence without rewriting
 * preferences on load. A saved Token Budget preference without memory shows the effective
 * strategy and stays saved.
 */
function resolveCompactionStrategy(
  continuous: boolean,
  tokenBudget: boolean,
  memory: boolean
): CompactionStrategy {
  if (continuous) return "continuous";
  return tokenBudget && memory ? "token-budget" : "summarize";
}

type SetFlag = (enabled: boolean) => Promise<unknown>;

/** Off before on; a pair left both on still resolves to continuous. */
async function persistCompactionStrategy(
  value: CompactionStrategy,
  setContinuous: SetFlag,
  setTokenBudget: SetFlag
) {
  if (value !== "token-budget") await setTokenBudget(false);
  if (value !== "continuous") await setContinuous(false);
  if (value === "token-budget") await setTokenBudget(true);
  if (value === "continuous") await setContinuous(true);
}

function useCompactionStrategy() {
  const telemetry = useTelemetry();
  const [continuousCompaction, setContinuousCompaction] = useExperiment(
    EXPERIMENT_IDS.CONTINUOUS_COMPACTION
  );
  const [tokenBudget, setTokenBudget] = useExperiment(EXPERIMENT_IDS.TOKEN_BUDGET);
  const ptc = useExperimentValue(EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING);
  const rlm = useExperimentValue(EXPERIMENT_IDS.RLM);
  // Token Budget keeps its checkpoint in agent memory, so it is offered only with Agent Memory on.
  const memory = useExperimentValue(EXPERIMENT_IDS.MEMORY);
  const strategy = resolveCompactionStrategy(continuousCompaction, tokenBudget, memory);

  const choose = (value: string) => {
    assert(
      value === "summarize" || value === "continuous" || value === "token-budget",
      `Unexpected compaction strategy: ${value}`
    );
    compactionStrategyWrites = compactionStrategyWrites
      .then(() => persistCompactionStrategy(value, setContinuousCompaction, setTokenBudget))
      .catch(() => undefined);
    // Retain the override events previously emitted by the individual experiment switches.
    telemetry.experimentOverridden(EXPERIMENT_IDS.CONTINUOUS_COMPACTION, value === "continuous");
    telemetry.experimentOverridden(EXPERIMENT_IDS.TOKEN_BUDGET, value === "token-budget");
  };

  return {
    strategy,
    strategies: COMPACTION_STRATEGIES.filter((s) => memory || s.value !== "token-budget"),
    tokenBudgetInactive: strategy === "token-budget" && ptc && rlm,
    choose,
  };
}

/**
 * Radix omits onValueChange when the current value is picked again, but picking the shown
 * strategy must still normalize its flags (a legacy both-on pair). Record an activation of the
 * current value and replay it when that activation closes the menu; Escape or a typeahead-only
 * Space closes nothing, so they replay nothing.
 */
function useReselect(current: CompactionStrategy, choose: (value: string) => void) {
  const [open, setOpen] = useState(false);
  const activation = useRef<CompactionStrategy | null>(null);
  const mark = (value: CompactionStrategy) => {
    if (value !== current) return;
    activation.current = value;
    queueMicrotask(() => {
      activation.current = null;
    });
  };
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    const activated = activation.current;
    activation.current = null;
    if (!next && activated) choose(activated);
  };
  return { open, onOpenChange, mark };
}

/** Lives under Agents: it is agent context behavior, not appearance (moved from General). */
export function CompactionStrategySetting() {
  const compaction = useCompactionStrategy();
  const reselect = useReselect(compaction.strategy, compaction.choose);

  return (
    <SettingRow
      id="compaction-strategy"
      hint={
        compaction.tokenBudgetInactive ? (
          <div id="token-budget-inactive" role="status" className="text-warning mt-2 text-xs">
            Token Budget is saved but inactive while Programmatic Tool Calling and RLM Mode are both
            enabled. Disable either in Experiments to use it.
          </div>
        ) : null
      }
    >
      <Select
        value={compaction.strategy}
        onValueChange={compaction.choose}
        open={reselect.open}
        onOpenChange={reselect.onOpenChange}
      >
        <SelectTrigger
          aria-label="Compaction strategy"
          aria-describedby={compaction.tokenBudgetInactive ? "token-budget-inactive" : undefined}
          className={SETTING_SELECT_TRIGGER_CLASS}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {compaction.strategies.map((strategy) => (
            <SelectItem
              key={strategy.value}
              value={strategy.value}
              onPointerUp={() => reselect.mark(strategy.value)}
              onClick={() => reselect.mark(strategy.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") reselect.mark(strategy.value);
              }}
            >
              {strategy.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
