import { useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  MEMORY_DREAM_COST_CEILING_MAX_USD,
  MEMORY_DREAM_COST_CEILING_MIN_USD,
} from "@/common/constants/memory";

// Digits with an optional decimal separator, a point or a comma (many keyboards type "0,5").
// `Number()` alone would also take "0x10", "1e3" and "+5".
const DECIMAL_PATTERN = /^(?:\d+[.,]?\d*|[.,]\d+)$/;

// A comma and exactly three digits after a non-zero integer part, as in "1,000": one thousand where
// a comma groups digits, 1.000 where it marks the decimals. A reading either way would save a
// ceiling a thousand times off, so the draft is refused. "0,500" and ",500" cannot be a group.
const THOUSANDS_LOOKALIKE_PATTERN = /^\d*[1-9]\d*,\d{3}$/;

const INVALID_CEILING_MESSAGE = `Enter a number of at least $${MEMORY_DREAM_COST_CEILING_MIN_USD} and at most $${MEMORY_DREAM_COST_CEILING_MAX_USD}, or leave empty for no ceiling.`;

const AMBIGUOUS_CEILING_MESSAGE =
  "A comma and three digits could be a thousands separator. Use a dot or a comma only as the decimal point, and write one thousand as 1000.";

/** What a draft stands for: a ceiling (undefined when empty, meaning none), or why it is no ceiling. */
type ParsedCeiling = { usd: number | undefined } | { error: string };

function parseCeiling(draft: string): ParsedCeiling {
  const trimmed = draft.trim();
  if (trimmed === "") return { usd: undefined };
  if (THOUSANDS_LOOKALIKE_PATTERN.test(trimmed)) return { error: AMBIGUOUS_CEILING_MESSAGE };
  if (!DECIMAL_PATTERN.test(trimmed)) return { error: INVALID_CEILING_MESSAGE };
  // Whole cents: a stopped run prints its spend to the cent, so a ceiling of 0.014 would read as
  // a stop at $0.01, under the ceiling it reached. The field then shows 0.01.
  const usd = Math.round(Number(trimmed.replace(",", ".")) * 100) / 100;
  return usd >= MEMORY_DREAM_COST_CEILING_MIN_USD && usd <= MEMORY_DREAM_COST_CEILING_MAX_USD
    ? { usd }
    : { error: INVALID_CEILING_MESSAGE };
}

/**
 * Cost ceiling of one dream run, shown under the memory-consolidation experiment. Empty means no
 * ceiling. The value commits on blur or Enter, not per keystroke, so a half-typed number is never
 * saved; an invalid draft shows its message and reverts to the saved value on blur. The field is
 * text, not `type=number`: a number field reports "" for a half-typed `1e` or `-`, which would
 * read as an emptied field and clear the ceiling on blur.
 */
export function MemoryDreamCostCeilingSetting() {
  const saved = useUserPreferences((preferences) => preferences.memory?.dreamCostCeilingUsd);
  // null means not editing: the field shows the saved ceiling.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (saved === undefined ? "" : String(saved));
  const parsed = parseCeiling(text);

  const commit = () => {
    setDraft(null);
    if ("error" in parsed || parsed.usd === saved) return;
    // A merge patch deletes a key set to null: that is how an empty field clears the ceiling.
    updateUserPreferences({ memory: { dreamCostCeilingUsd: parsed.usd ?? null } });
  };

  return (
    <div className="border-border-light flex flex-col gap-2 border-t py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="dream-cost-ceiling" className="text-foreground text-sm font-medium">
          Dream cost ceiling
        </label>
        <div className="text-muted mt-0.5 text-xs">
          A dream run stops once its measured spend reaches this many US dollars. Each model step is
          priced from the usage it reports, as the app prices recorded usage, and the step in flight
          when the ceiling is reached can go past it. A model with no known price counts as free.
          Leave empty for no ceiling.
        </div>
        {"error" in parsed && (
          <div role="alert" className="text-error mt-1 text-xs">
            {parsed.error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id="dream-cost-ceiling"
          type="text"
          inputMode="decimal"
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
