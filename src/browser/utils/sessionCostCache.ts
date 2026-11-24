/**
 * Persisted LRU cache for workspace session costs.
 *
 * Stores only the computed cost number (not the full usage JSON) to keep localStorage small.
 * Used by ArchivedWorkspaces to show cached costs immediately and prevent layout flash.
 *
 * TTL: 7 days (costs for archived workspaces rarely change)
 * Max entries: SESSION_COST_CACHE_MAX_ENTRIES
 */

import { createLRUCache } from "@/browser/utils/lruCache";
import {
  SESSION_COST_CACHE_ENTRY_PREFIX,
  SESSION_COST_CACHE_INDEX_KEY,
  SESSION_COST_CACHE_MAX_ENTRIES,
} from "@/common/constants/storage";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const sessionCostCache = createLRUCache<number>({
  entryPrefix: SESSION_COST_CACHE_ENTRY_PREFIX,
  indexKey: SESSION_COST_CACHE_INDEX_KEY,
  maxEntries: SESSION_COST_CACHE_MAX_ENTRIES,
  ttlMs: SEVEN_DAYS_MS,
});
