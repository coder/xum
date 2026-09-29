/**
 * Keep growing persisted values inside their key budgets (PERSISTED_KEY_REGISTRY maxValueChars).
 *
 * A write over budget is refused and leaves the old value, which would freeze that UI state for
 * good because owners rewrite the whole value on every change. Owners of values that grow with use
 * (expansion maps, cached lists) therefore trim before writing; this also shrinks oversized values
 * that older builds wrote, on the next change.
 */

/**
 * Drop the oldest entries until the record serializes to at most `maxChars`. Insertion order is
 * the age order, except that JavaScript lists integer-like keys first; those are dropped first,
 * which still bounds the value.
 */
export function trimRecordToChars<T>(
  record: Record<string, T>,
  maxChars: number
): Record<string, T> {
  const entries = Object.entries(record);
  let total = 2; // "{}"
  let kept = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const [key, value] = entries[index];
    const valueChars = JSON.stringify(value)?.length ?? 0;
    const entryChars = JSON.stringify(key).length + 1 + valueChars + (kept > 0 ? 1 : 0);
    if (total + entryChars > maxChars) break;
    total += entryChars;
    kept++;
  }
  return kept === entries.length
    ? record
    : Object.fromEntries(entries.slice(entries.length - kept));
}

/**
 * Set `key` to `value` as the newest entry (undefined removes it), then trim the oldest entries
 * so the record fits `maxChars`.
 */
export function withRecordEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T | undefined,
  maxChars: number
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  if (value !== undefined) next[key] = value;
  return trimRecordToChars(next, maxChars);
}

/** Keep the longest prefix of `items` that serializes to at most `maxChars`. */
export function trimArrayToChars<T>(items: readonly T[], maxChars: number): T[] {
  let total = 2; // "[]"
  let kept = 0;
  for (const item of items) {
    const itemChars = (JSON.stringify(item)?.length ?? 4) + (kept > 0 ? 1 : 0);
    if (total + itemChars > maxChars) break;
    total += itemChars;
    kept++;
  }
  return items.slice(0, kept);
}
