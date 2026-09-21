/**
 * Native plan review: inline comments on a proposed plan, persisted as append-only
 * `<mux_plan_review>` rows in the workspace chat history (no browser persistence).
 */

/**
 * Plan text larger than this is not snapshotted into history. Well under the 1 MiB read-side
 * row limit (SESSION_HISTORY_MAX_LINE_BYTES): an oversized row would be skipped by the history
 * scanner, silently losing the snapshot AND its envelope framing.
 */
export const MAX_PLAN_SNAPSHOT_BYTES = 256 * 1024;

/**
 * Upper bound on unresolved threads listed in the `<plan-review-state>` system block; the block
 * names how many were omitted so the agent knows the list is truncated.
 */
export const PLAN_REVIEW_STATE_MAX_THREADS = 30;

/** muxMetadata discriminator shared by every plan-review record row. */
export const PLAN_REVIEW_METADATA_TYPE = "plan-review" as const;
