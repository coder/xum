import { useState } from "react";
import { Input } from "@/browser/components/Input/Input";
import { updateUserPreferences, useUserPreferences } from "@/browser/stores/AppConfigStore";
import {
  MEMORY_CONSOLIDATION_OP_BUDGET,
  MEMORY_DREAM_EDIT_LIMIT_MAX,
} from "@/common/constants/memory";
import { parseWholeNumberDraft } from "./wholeNumberDraft";

/** What unlimited means: the safety cap still bounds one run (see MEMORY_DREAM_EDIT_LIMIT_MAX). */
const UNLIMITED_LABEL = `Unlimited (safety cap: ${MEMORY_DREAM_EDIT_LIMIT_MAX} edits per run)`;

const INVALID_LIMIT_MESSAGE = `Enter a whole number of edits up to ${MEMORY_DREAM_EDIT_LIMIT_MAX}, or enter 0 or leave empty for unlimited.`;

/** The field's text for a saved limit: the default when none is saved, empty for unlimited (0). */
function formatLimit(saved: number | undefined): string {
  if (saved === undefined) return String(MEMORY_CONSOLIDATION_OP_BUDGET);
  return saved === 0 ? "" : String(saved);
}

/**
 * Edit limit of one organizer run, shown under the memory-consolidation experiment. The user asked
 * for it so a run can split memory files that grew far past the size their preferences allow,
 * which the default 8 edits cannot do in one pass.
 *
 * No saved value shows (and runs with) the default. An emptied field saves 0, which means
 * unlimited: a merge patch with null would delete the key, and that reads as the default again.
 * The value commits on blur or Enter, like the cost ceiling, so a half-typed number is never saved.
 */
export function MemoryDreamEditLimitSetting() {
  const saved = useUserPreferences((preferences) => preferences.memory?.dreamEditLimit);
  // null means not editing: the field shows the saved limit.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? formatLimit(saved);
  // An empty field is 0: unlimited.
  const parsed = parseWholeNumberDraft(text, {
    max: MEMORY_DREAM_EDIT_LIMIT_MAX,
    empty: 0,
    error: INVALID_LIMIT_MESSAGE,
  });

  const commit = () => {
    setDraft(null);
    // Compare with the limit the run uses, so a blur on the shown default saves nothing.
    if ("error" in parsed || parsed.value === (saved ?? MEMORY_CONSOLIDATION_OP_BUDGET)) return;
    updateUserPreferences({ memory: { dreamEditLimit: parsed.value } });
  };

  return (
    <div className="border-border-light flex flex-col gap-2 border-t py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="dream-edit-limit" className="text-foreground text-sm font-medium">
          Dream edit limit
        </label>
        <div className="text-muted mt-0.5 text-xs">
          Most memory edits one organizer run can make, in the background or from Consolidate now.
          Each create, replace, insert, delete or rename is one edit. Enter 0 or leave empty for{" "}
          {UNLIMITED_LABEL}: memory files are untrusted input, so one run never makes more.
        </div>
        {"error" in parsed && (
          <div role="alert" className="text-error mt-1 text-xs">
            {parsed.error}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id="dream-edit-limit"
          type="text"
          inputMode="numeric"
          placeholder="Unlimited"
          value={text}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="border-border-medium bg-background-secondary h-9 w-24 text-right"
        />
        <span className="text-muted w-10 text-sm">edits</span>
      </div>
    </div>
  );
}
