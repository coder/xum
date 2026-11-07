import assert from "node:assert/strict";

/**
 * Records `key` in `seen`, the conditions already logged in full; true when it was not there
 * yet. Past `cap` keys the oldest go first (a Set iterates in insertion order), so keys that
 * change on every call cannot grow it without bound.
 */
export function rememberLogKey(seen: Set<string>, key: string, cap: number): boolean {
  assert(Number.isInteger(cap) && cap > 0, "rememberLogKey: cap must be a positive integer");
  if (seen.has(key)) return false;
  seen.add(key);
  for (const oldest of seen) {
    if (seen.size <= cap) break;
    seen.delete(oldest);
  }
  return true;
}
