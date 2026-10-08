import {
  listPersistedStateKeys,
  removePersistedStateKeys,
} from "@/browser/hooks/usePersistedState";

// Legacy per-workspace cache prefixes, kept only so startup can delete them. These caches
// duplicated backend-owned data (plan text, post-compaction state) and now live in memory;
// leaving them in localStorage wastes quota (QuotaExceededError blocked draft persistence).
// Experiment values live only on the backend; an older build would re-upload stale local copies.
// Workspace AI picks live in workspace metadata or, until sent, in memory.
const DROPPED_CACHE_KEY_PREFIXES = [
  "planContent:",
  "postCompactionState:",
  "experiment:",
  "agentId:",
  "workspaceAiSettingsByAgent:",
  "autoModelRouting:",
  "autoThinkingLevel:",
  "autoRoutingChoiceByAgent:",
] as const;

/**
 * Remove localStorage keys written by caches that no longer persist. Runs on every startup
 * (cheap and idempotent) so keys re-written by an older build after a downgrade are cleaned too.
 */
export function removeDroppedCacheKeys(): void {
  removePersistedStateKeys(listPersistedStateKeys(DROPPED_CACHE_KEY_PREFIXES));
}
