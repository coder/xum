/**
 * Per-workspace caps for code-review state persisted in `<sessionDir>/review-state.json`.
 * Shared by the backend store and the frontend view composition so both evict identically.
 */

/** Maximum hunk read states kept per workspace (newest by timestamp win). */
export const MAX_READ_STATES = 1024;

/** Maximum hunk first-seen records kept per workspace (newest by timestamp win). */
export const MAX_FIRST_SEEN_RECORDS = 2048;
