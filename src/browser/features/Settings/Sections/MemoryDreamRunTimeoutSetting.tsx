import { useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  MEMORY_CONSOLIDATION_TIMEOUT_MS,
  MEMORY_DREAM_EDIT_LIMIT_MAX,
  MEMORY_DREAM_MAX_STEPS,
  MEMORY_DREAM_RUN_TIMEOUT_MAX_MINUTES,
} from "@/common/constants/memory";
import { parseWholeNumberDraft, type ParsedWholeNumberDraft } from "./wholeNumberDraft";

const DEFAULT_MINUTES = MEMORY_CONSOLIDATION_TIMEOUT_MS / 60_000;

const INVALID_TIMEOUT_MESSAGE = `Enter whole minutes from 0 to ${MEMORY_DREAM_RUN_TIMEOUT_MAX_MINUTES}, or leave empty for ${DEFAULT_MINUTES}.`;

/** What a draft stands for: minutes (undefined when empty, meaning the default), or an error. */
type ParsedTimeout = ParsedWholeNumberDraft<undefined>;

/**
 * What committing a draft saves: minutes, `null` to clear the saved value (an emptied field, which
 * means the default), or `undefined` for nothing: an invalid draft, or the timeout the run already
 * uses, so a blur on the shown default saves nothing.
 */
function timeoutPatch(parsed: ParsedTimeout, saved: number | undefined): number | null | undefined {
  if ("error" in parsed) return undefined;
  if ((parsed.value ?? DEFAULT_MINUTES) === (saved ?? DEFAULT_MINUTES)) return undefined;
  return parsed.value ?? null;
}

/**
 * Run timeout of one organizer run, shown under the memory-consolidation experiment. The user asked
 * for a field instead of timeouts that grow with the edit limit: a run with many edits may need
 * more than the default, and the user picks how long.
 *
 * No saved value shows (and runs with) the default. An emptied field clears the saved value, which
 * means the default again. 0 means no timeout. The value commits on blur or Enter, like the cost
 * ceiling, so a half-typed number is never saved.
 */
export function MemoryDreamRunTimeoutSetting() {
  const saved = useUserPreferences((preferences) => preferences.memory?.dreamRunTimeoutMinutes);
  // null means not editing: the field shows the saved timeout.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(saved ?? DEFAULT_MINUTES);
  const parsed = parseWholeNumberDraft(text, {
    max: MEMORY_DREAM_RUN_TIMEOUT_MAX_MINUTES,
    empty: undefined,
    error: INVALID_TIMEOUT_MESSAGE,
  });

  const commit = () => {
    setDraft(null);
    const patch = timeoutPatch(parsed, saved);
    // A merge patch deletes a key set to null: an emptied field goes back to the default.
    if (patch !== undefined) updateUserPreferences({ memory: { dreamRunTimeoutMinutes: patch } });
  };

  return (
    <div className="border-border-light flex flex-col gap-2 border-t py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="dream-run-timeout" className="text-foreground text-sm font-medium">
          Dream run timeout
        </label>
        <div className="text-muted mt-0.5 text-xs">
          An organizer run stops after this many minutes. Leave empty for {DEFAULT_MINUTES}. Enter 0
          for no timeout: then only the edit limit (at most {MEMORY_DREAM_EDIT_LIMIT_MAX} edits),
          the step ceiling ({MEMORY_DREAM_MAX_STEPS} steps) and the cost ceiling, if set, end a run.
          A run that hangs holds the memory lock until Xum restarts: other memory runs in the same
          Xum process wait behind it until then, and runs in another Xum process give up after
          waiting at least {DEFAULT_MINUTES} minutes for it and try again later.
        </div>
        {"error" in parsed && (
          <div role="alert" className="text-error mt-1 text-xs">
            {parsed.error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id="dream-run-timeout"
          type="text"
          inputMode="numeric"
          placeholder={String(DEFAULT_MINUTES)}
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="border-border-medium bg-background-secondary h-9 w-24 text-right"
        />
        <span className="text-muted w-10 text-sm">min</span>
      </div>
    </div>
  );
}
