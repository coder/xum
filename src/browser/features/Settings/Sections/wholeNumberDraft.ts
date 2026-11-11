// Digits only: `Number()` alone would also take "0x10", "1e3", "+5" and "2.5".
const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** What a numeric settings draft stands for: its value (`empty` for an empty field), or an error. */
export type ParsedWholeNumberDraft<Empty> = { value: number | Empty } | { error: string };

/**
 * Reads the draft of a whole-number Settings field (the dream edit limit and run timeout): an
 * empty field is `empty`, whole digits up to `max` are their number, and anything else is `error`.
 * The fields share this rule, so a change to what they accept reaches both.
 */
export function parseWholeNumberDraft<Empty>(
  draft: string,
  options: { max: number; empty: Empty; error: string }
): ParsedWholeNumberDraft<Empty> {
  const trimmed = draft.trim();
  if (trimmed === "") return { value: options.empty };
  const value = Number(trimmed);
  return WHOLE_NUMBER_PATTERN.test(trimmed) && value <= options.max
    ? { value }
    : { error: options.error };
}
