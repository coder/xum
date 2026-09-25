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
 * Per-field/per-record bounds on submitted feedback. Quotes mirror the review UI's 500-char
 * selection cap; bodies stay generous for written instructions. The persisted feedback row is
 * additionally capped by SESSION_HISTORY_MAX_LINE_BYTES after JSON escaping (see
 * preparePlanReviewFeedback).
 */
export const PLAN_REVIEW_MAX_QUOTE_CHARS = 500;
export const PLAN_REVIEW_MAX_BODY_CHARS = 4_000;
export const PLAN_REVIEW_MAX_SUMMARY_CHARS = 2_000;
export const PLAN_REVIEW_MAX_COMMENTS_PER_FEEDBACK = 50;
export const PLAN_REVIEW_MAX_REPLIES_PER_FEEDBACK = 50;
/**
 * Each reply repeats its thread's quote (capped at PLAN_REVIEW_MAX_QUOTE_CHARS) and opening
 * comment, truncated to this many chars, so a thread opened before a context reset still reaches
 * the model with its context. Kept at the quote cap: a maximal plain-text submission (every
 * comment, reply, and summary at its cap) then grows by about 50k chars per envelope copy and
 * still fits the persisted feedback row budget (see preparePlanReviewFeedback); roughly 700 is
 * the ceiling before such a submission would be refused as too large.
 */
export const PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS = 500;
/**
 * Bytes reserved when judging the persisted feedback row against SESSION_HISTORY_MAX_LINE_BYTES.
 * The measured candidate already carries the send options the row will persist (toolPolicy and
 * the startup-retry snapshot); this covers the remaining send-time stamps prepare cannot see
 * (acp prompt id, goal kind/id, enqueue time), all small compared with the reserve.
 */
export const PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES = 16 * 1024;

/**
 * How long turn completion waits for the propose_plan snapshot capture (metadata + plan read +
 * locked append). A stalled remote read (RemoteRuntime commands can wait up to their 300 s
 * timeout) must not keep the workspace busy; an abandoned capture is refused at append admission.
 */
export const PLAN_REVIEW_SNAPSHOT_CAPTURE_TIMEOUT_MS = 15_000;

/** muxMetadata discriminator shared by every plan-review record row. */
export const PLAN_REVIEW_METADATA_TYPE = "plan-review" as const;
