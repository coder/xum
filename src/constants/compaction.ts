/** Shared by the qualified pending store's runtime producers and metadata readers. */
export const POST_COMPACTION_STATE_FILENAME = "post-compaction.json";

/**
 * Bounds the post-compaction header build at stream end. A slow remote read (plan file over SSH)
 * must not hold the paid summary unpublished, where a Stop would drop it.
 */
export const POST_COMPACTION_CONTEXT_BUILD_TIMEOUT_MS = 30 * 1000;
