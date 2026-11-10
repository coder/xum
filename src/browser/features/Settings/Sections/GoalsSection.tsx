import { useEffect, useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
import { DEFAULT_GOAL_DEFAULTS, normalizeGoalDefaults, type GoalDefaults } from "@/constants/goals";

function formatBudgetDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseBudgetDollars(value: string): number | null {
  const normalized = value.trim().replace(/^\$/, "");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) {
    return null;
  }
  return Math.round(Number(normalized) * 100);
}

function parseTurnCap(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

interface GoalDefaultsControlsProps {
  loadConfig?: () => Promise<{ goalDefaults?: Partial<GoalDefaults> | null }>;
  /**
   * Fired after every successful persist of the global goal defaults.
   * Callers that render inherited-value labels (e.g., the workspace
   * override panel in the GoalTab) use this to re-pull the global defaults
   * so their "Inherits X from All workspaces" copy stays accurate.
   */
  onPersist?: (next: GoalDefaults) => void;
}

export function GoalDefaultsControls(props: GoalDefaultsControlsProps) {
  const { api } = useAPI();
  const loadConfig = props.loadConfig;
  const onPersist = props.onPersist;
  const [goalDefaults, setGoalDefaults] = useState<GoalDefaults>(() => ({
    ...DEFAULT_GOAL_DEFAULTS,
  }));
  const [budgetDraft, setBudgetDraft] = useState(
    formatBudgetDollars(DEFAULT_GOAL_DEFAULTS.defaultBudgetCents)
  );
  const [turnCapDraft, setTurnCapDraft] = useState("");

  useEffect(() => {
    const configPromise = loadConfig?.() ?? api?.config?.getConfig();
    if (!configPromise) {
      return;
    }

    void configPromise
      .then((config) => {
        const defaults = normalizeGoalDefaults(config.goalDefaults);
        setGoalDefaults(defaults);
        setBudgetDraft(formatBudgetDollars(defaults.defaultBudgetCents));
        setTurnCapDraft(defaults.defaultTurnCap == null ? "" : String(defaults.defaultTurnCap));
      })
      .catch(() => {
        // Keep defaults editable if config loading fails; a later edit can still persist.
      });
  }, [api, loadConfig]);

  const persistGoalDefaults = (next: GoalDefaults) => {
    const normalized = normalizeGoalDefaults(next);
    setGoalDefaults(normalized);
    // Codex P2: await the update before firing `onPersist`. If we
    // notified synchronously, the parent (e.g., GoalDefaultsSection)
    // could re-read `api.config.getConfig()` *before* the underlying
    // saveConfig commits, leaving the inherited-value labels stale.
    // Tradeoff: a transient `updateGoalDefaults` failure leaves the
    // local optimistic state ahead of disk, but the next save (or a
    // reload) recovers; that's preferable to letting consumers see
    // stale defaults.
    void (async () => {
      try {
        await api?.config?.updateGoalDefaults?.({ goalDefaults: normalized });
      } finally {
        onPersist?.(normalized);
      }
    })();
  };

  const saveBudget = (value: string) => {
    const parsed = parseBudgetDollars(value);
    const nextBudgetCents = parsed ?? DEFAULT_GOAL_DEFAULTS.defaultBudgetCents;
    setBudgetDraft(formatBudgetDollars(nextBudgetCents));
    persistGoalDefaults({ ...goalDefaults, defaultBudgetCents: nextBudgetCents });
  };

  const saveTurnCap = (value: string) => {
    const nextTurnCap = parseTurnCap(value);
    setTurnCapDraft(nextTurnCap == null ? "" : String(nextTurnCap));
    persistGoalDefaults({ ...goalDefaults, defaultTurnCap: nextTurnCap });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="goal-default-budget" className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">Default goal budget</div>
          <div className="text-muted mt-0.5 text-xs">
            Applied to new goals when no budget flag is provided. Use $0.00 for no dollar limit.
          </div>
        </label>
        <div className="flex items-center gap-1">
          <span className="text-muted text-sm">$</span>
          <Input
            id="goal-default-budget"
            aria-label="Default goal budget in dollars"
            type="text"
            inputMode="decimal"
            value={budgetDraft}
            onChange={(event) => setBudgetDraft(event.target.value)}
            onBlur={(event) => saveBudget(event.currentTarget.value)}
            className="border-border-medium bg-background-secondary h-9 w-24 text-right"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <label htmlFor="goal-default-turn-cap" className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">Default turn cap</div>
          <div className="text-muted mt-0.5 text-xs">
            Leave empty to disable the turn cap for new goals.
          </div>
        </label>
        <Input
          id="goal-default-turn-cap"
          aria-label="Default goal turn cap"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={turnCapDraft}
          onChange={(event) => setTurnCapDraft(event.target.value)}
          onBlur={(event) => saveTurnCap(event.currentTarget.value)}
          className="border-border-medium bg-background-secondary h-9 w-24 text-right"
        />
      </div>

      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-medium">
            Always require explicit budget
          </span>
          <span className="text-muted mt-0.5 block text-xs">
            When enabled, omitted budgets use the default budget instead of creating unbudgeted
            goals.
          </span>
        </span>
        <input
          aria-label="Always require explicit budget"
          type="checkbox"
          checked={goalDefaults.alwaysRequireExplicitBudget}
          onChange={(event) =>
            persistGoalDefaults({
              ...goalDefaults,
              alwaysRequireExplicitBudget: event.target.checked,
            })
          }
          className="accent-accent mt-1 h-4 w-4"
        />
      </label>
    </div>
  );
}
