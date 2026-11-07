import { useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import { MEMORY_DREAM_COST_CEILING_MIN_USD } from "@/common/constants/memory";

/** The ceiling a draft stands for: undefined when empty (no ceiling), null when it is not a valid one. */
function parseCeiling(draft: string): number | undefined | null {
  const trimmed = draft.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= MEMORY_DREAM_COST_CEILING_MIN_USD ? value : null;
}

/**
 * Cost ceiling of one dream run, shown under the memory-consolidation experiment. Empty means no
 * ceiling. The value commits on blur or Enter, not per keystroke, so a half-typed number is never
 * saved; an invalid draft shows its message and reverts to the saved value on blur.
 */
export function MemoryDreamCostCeilingSetting() {
  const saved = useUserPreferences((preferences) => preferences.memory?.dreamCostCeilingUsd);
  // null means not editing: the field shows the saved ceiling.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (saved === undefined ? "" : String(saved));
  const parsed = parseCeiling(text);

  const commit = () => {
    setDraft(null);
    if (parsed === null || parsed === saved) return;
    // A merge patch deletes a key set to null: that is how an empty field clears the ceiling.
    updateUserPreferences({ memory: { dreamCostCeilingUsd: parsed ?? null } });
  };

  return (
    <div className="border-border-light flex flex-col gap-2 border-t py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="dream-cost-ceiling" className="text-foreground text-sm font-medium">
          Dream cost ceiling
        </label>
        <div className="text-muted mt-0.5 text-xs">
          A dream run whose estimated cost is over this many US dollars does not start. The estimate
          is an upper bound, not a bill: it assumes every step resends the whole prompt and every
          memory file, so the real cost is usually lower. Leave empty for no ceiling.
        </div>
        {parsed === null && (
          <div role="alert" className="text-error mt-1 text-xs">
            Enter at least ${MEMORY_DREAM_COST_CEILING_MIN_USD}, or leave empty for no ceiling.
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id="dream-cost-ceiling"
          type="number"
          inputMode="decimal"
          min={MEMORY_DREAM_COST_CEILING_MIN_USD}
          step={MEMORY_DREAM_COST_CEILING_MIN_USD}
          placeholder="None"
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="border-border-medium bg-background-secondary h-9 w-24 text-right"
        />
        <span className="text-muted w-8 text-sm">USD</span>
      </div>
    </div>
  );
}
