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
