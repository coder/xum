import { updatePersistedState } from "@/browser/hooks/usePersistedState";

// Legacy per-workspace cache prefixes, kept only so startup can delete them. These caches
// duplicated backend-owned data (plan text, post-compaction state) and now live in memory;
// leaving them in localStorage wastes quota (QuotaExceededError blocked draft persistence).
const DROPPED_CACHE_KEY_PREFIXES = ["planContent:", "postCompactionState:"] as const;

/**
 * Remove localStorage keys written by caches that no longer persist. Runs on every startup
 * (cheap and idempotent) so keys re-written by an older build after a downgrade are cleaned too.
 */
export function removeDroppedCacheKeys(): void {
  // Enumeration has no persisted-state helper, so read keys directly. Collect them first:
  // removing while iterating shifts indices and would skip keys.
  const storage = window.localStorage;
  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && DROPPED_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    updatePersistedState(key, null);
  }
}
