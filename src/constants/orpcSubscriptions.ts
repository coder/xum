/** Default interval between heartbeat events on long-lived oRPC subscriptions. */
export const SUBSCRIPTION_HEARTBEAT_INTERVAL_MS = 5_000;

// onChat replay batching (#4868). One oRPC event and one WebSocket frame/MessagePort message per
// history row dominates large replays on both ends, so clients that opt in with `batchReplay`
// receive consecutive text-only replay rows grouped into one `message-batch` event.

/** Most rows one replay batch holds; bounds a batch's size even when the byte cap is soft. */
export const ONCHAT_REPLAY_BATCH_MAX_ROWS = 64;

/**
 * Soft cap on a batch's summed text length in UTF-16 units of text/reasoning parts. JSON escaping
 * and metadata are not counted (measuring them would cost a stringify per row), so an
 * escape-heavy or metadata-heavy batch can serialize to more than 1 MiB. That is safe: WebSocket
 * flow control (#4867) bounds buffered bytes per window, not per frame, and single tool rows over
 * 1 MiB already exist. Plain-text batches serialize to about this cap plus per-row metadata.
 */
export const ONCHAT_REPLAY_BATCH_MAX_TEXT_BYTES = 256 * 1024;

/** Text-only rows above this summed text length are sent alone instead of joining a batch. */
export const ONCHAT_REPLAY_BATCH_ROW_TEXT_LIMIT = 64 * 1024;

// Windowed onChat replay (#4961). Replaying every row since the latest compaction boundary costs
// seconds of server read/emit and renderer work on large epochs (1.24M rows: 27 s to the newest
// row, 2.2 GB server RSS), so replay reads a bounded newest window and older rows page in on
// demand.

/**
 * Most rows one replay window holds before the turn-boundary extension. The renderer's caught-up
 * work is ~110 ms at 2k rows versus 2.3 s at 1.24M rows (#4961).
 */
export const ONCHAT_REPLAY_WINDOW_MAX_ROWS = 2000;

/** Raw chat.jsonl bytes one replay window reads before the turn-boundary extension. */
export const ONCHAT_REPLAY_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Extra rows the window may read past its cap to start on a user turn, so a replay does not open
 * in the middle of a turn. A turn longer than this is cut mid-turn instead of unbounded reads.
 */
export const ONCHAT_REPLAY_WINDOW_TURN_EXTENSION_MAX_ROWS = 200;

/** Extra raw bytes the turn-boundary extension may read (same reason as the row bound). */
export const ONCHAT_REPLAY_WINDOW_TURN_EXTENSION_MAX_BYTES = 2 * 1024 * 1024;

/** Most rows one older-history page returns inside the active epoch. */
export const HISTORY_PAGE_MAX_ROWS = 1000;

/** Raw bytes one older-history page returns inside the active epoch. */
export const HISTORY_PAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Byte bound of a "through sequence" page, which returns every row down to a caller-chosen row in
 * one call (for example to reach a pinned or searched row). Larger than a page, but still bounded
 * so one request cannot pull a whole multi-GB epoch into memory.
 */
export const HISTORY_THROUGH_MAX_BYTES = 64 * 1024 * 1024;
