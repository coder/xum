import { getPersistedStateStorage } from "@/browser/hooks/usePersistedState";
import { MODEL_KEY_MAX_CHARS } from "@/common/constants/storage";

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

/**
 * Keep the longest prefix of `value` that serializes to at most `maxChars` (quotes and escapes
 * included). Cuts only between code points, so a surrogate pair is never split.
 */
export function truncateStringToChars(value: string, maxChars: number): string {
  if (JSON.stringify(value).length <= maxChars) return value;
  let total = 2; // '""'
  let end = 0;
  for (const char of value) {
    const charChars = JSON.stringify(char).length - 2;
    if (total + charChars > maxChars) break;
    total += charChars;
    end += char.length;
  }
  return value.slice(0, end);
}

/**
 * Full values of this session whose persisted copy their owner bounded, by storage key. Kept per
 * persisted-state Storage, like usePersistedState's over-budget values: a remount keeps them, and
 * a restart (a new Storage) drops them so the bounded persisted copy comes back. Read with
 * useSyncExternalStore(store.subscribe, () => store.get(key)).
 */
export function createSessionValueStore<T>() {
  const valuesByStorage = new WeakMap<Storage, Map<string, T>>();
  const listeners = new Set<() => void>();
  return {
    get: (key: string): T | undefined => {
      const storage = getPersistedStateStorage();
      return storage ? valuesByStorage.get(storage)?.get(key) : undefined;
    },
    set: (key: string, value: T | undefined): void => {
      const storage = getPersistedStateStorage();
      if (!storage) return;
      let values = valuesByStorage.get(storage);
      if (!values) {
        values = new Map();
        valuesByStorage.set(storage, values);
      }
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Why a custom model id is too long to select, or null: a selected "provider:modelId" that does
 * not fit the per-workspace model key would be lost on restart.
 */
export function getModelIdLengthError(provider: string, modelId: string): string | null {
  if (JSON.stringify(`${provider}:${modelId}`).length <= MODEL_KEY_MAX_CHARS) return null;
  const maxIdChars = MODEL_KEY_MAX_CHARS - JSON.stringify(`${provider}:`).length;
  // The limit applies to the stored JSON string, where escaped characters take two or more.
  const hasEscapes = JSON.stringify(modelId).length - 2 > modelId.length;
  return (
    `Model IDs for ${provider} can be at most ${maxIdChars} characters` +
    (hasEscapes ? " (quotes and backslashes count twice)" : "")
  );
}
