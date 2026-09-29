/**
 * Keep growing persisted values inside their key budgets (PERSISTED_KEY_REGISTRY maxValueChars).
 *
 * A value over budget is kept in memory for the session only; localStorage keeps the last value
 * that fit, so after a reload that UI state would silently roll back, for good, because owners
 * rewrite the whole value on every change. Owners of values that grow with use (expansion maps,
 * cached lists) therefore trim before writing; this also shrinks oversized values that older
 * builds wrote, on the next change.
 */

/**
 * Drop the oldest entries until the record serializes to at most `maxChars` (entries too large to
 * fit on their own are skipped). Insertion order is
 * the age order, except that JavaScript lists integer-like keys first; those are dropped first,
 * which still bounds the value.
 */
export function trimRecordToChars<T>(
  record: Record<string, T>,
  maxChars: number
): Record<string, T> {
  const entries = Object.entries(record);
  let total = 2; // "{}"
  const kept: Array<[string, T]> = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const [key, value] = entries[index];
    const valueChars = JSON.stringify(value)?.length ?? 0;
    const bareChars = JSON.stringify(key).length + 1 + valueChars;
    // An entry that cannot fit even alone (e.g. one very long path) is skipped; stopping here would
    // drop every older entry and persist an empty value.
    if (2 + bareChars > maxChars) continue;
    const entryChars = bareChars + (kept.length > 0 ? 1 : 0);
    if (total + entryChars > maxChars) break;
    total += entryChars;
    kept.push(entries[index]);
  }
  return kept.length === entries.length ? record : Object.fromEntries(kept.reverse());
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
