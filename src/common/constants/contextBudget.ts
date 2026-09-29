/** Shared limits for opt-in, lossless context-window rollover and history retrieval. */
export const CONTEXT_NOTES_MEMORY_PATH = "/memories/workspace/context-notes.md";
export const CONTEXT_NOTES_RESERVED_BYTES = 8 * 1024;
export const CONTEXT_NOTES_RESERVED_TOKENS = 2_000;
export const CONTEXT_CONTINUE_DEDUPE_KEY = "context-budget-continue";
export const CONTEXT_WARNING_DEDUPE_KEY = "context-budget-warning";
export const OUTPUT_RESERVE_TOKENS = 8_192;
export const MAX_OUTPUT_RESERVE_CONTEXT_RATIO = 0.25;
export const MAX_FALLBACK_SYSTEM_FLOOR_CONTEXT_RATIO = 0.5;
export const WARNING_RESERVE_TOKENS = 2_048;
// Headroom one final checkpoint-writing step needs below the hard ceiling: the warning row plus
// a checkpoint-sized margin.
export const FLUSH_RESERVE_TOKENS = WARNING_RESERVE_TOKENS + CONTEXT_NOTES_RESERVED_TOKENS;
// Absolute floor on how far ahead of the rollover point the advance warning fires. The
// percent-based advance (WARNING_ADVANCE_PERCENT of the limit) shrinks with the window, so
// reserve three WARNING_RESERVE_TOKENS: one notes flush plus roughly two working steps.
export const WARNING_ADVANCE_MIN_TOKENS = 3 * WARNING_RESERVE_TOKENS;
export const IMAGE_TOKEN_ESTIMATE = 1_024;
export const SYSTEM_FLOOR_TOKENS_ESTIMATE = 8_192;
export const SESSION_HISTORY_MAX_RESULT_BYTES = 16 * 1024;
export const SESSION_HISTORY_MAX_SCAN_BYTES = 2 * 1024 * 1024;
export const SESSION_HISTORY_MAX_SCAN_ROWS = 500;
// One session_history call finishes its scan internally as a sequence of protected chunks
// (history locks are released between chunks so writers interleave). These bound the work
// of ONE chunk, not the call, and stay above the lower-level scanner's default allowance so a
// typical rollover archive needs few lock holds.
export const SESSION_HISTORY_TOOL_MAX_SCAN_BYTES = 32 * 1024 * 1024;
export const SESSION_HISTORY_TOOL_MAX_SCAN_ROWS = 10_000;
export const SESSION_HISTORY_SCAN_DEADLINE_MS = 2_000;
// Cooperative processing ceiling for a whole call, including its single permitted restart.
// Checked before new work only (each chunk, each lock acquisition, each scanner read); lock
// waits and filesystem latency are not interrupted by it. Codex's history backend uses a
// 35 s request timeout for the equivalent tools.
export const SESSION_HISTORY_TOOL_DEADLINE_MS = 30_000;
export const SESSION_HISTORY_MAX_LINE_BYTES = 1024 * 1024;
// Compaction boundary rows keep this much of SESSION_HISTORY_MAX_LINE_BYTES free for fields
// added after the summary is bounded (publication id/generation, preserved replacement
// metadata). The widest historySequence is already part of the measurement.
export const COMPACTION_BOUNDARY_ROW_HEADROOM_BYTES = 16 * 1024;
// Smallest summary worth truncating to so the boundary row still fits: about five times the
// default 2000-word compaction target. When the pending follow-up leaves less room than this,
// cutting the summary cannot make the row fit, so only the summary's own ceiling applies.
export const MIN_FITTED_COMPACTION_SUMMARY_BYTES = 64 * 1024;
// Compact marker HistoryService writes on every durable compaction boundary. The provider
// scanner only re-reads an oversized row whose raw bytes contain it.
export const SESSION_HISTORY_COMPACTION_BOUNDARY_NEEDLE = '"compactionBoundary":true';
// Largest oversized compaction boundary the provider scanner re-reads to recognize it (#4551).
// Inline attachments make boundary rows large (10 MiB per file before base64); beyond this the
// row keeps the older skip-and-fall-back behavior.
export const SESSION_HISTORY_MAX_BOUNDARY_ROW_BYTES = 64 * 1024 * 1024;
export const SESSION_HISTORY_DEFAULT_LIMIT = 10;
export const SESSION_HISTORY_MAX_SEARCH_LIMIT = 25;
export const SESSION_HISTORY_MAX_WINDOW_LIMIT = 50;
export const SESSION_HISTORY_DEFAULT_READ_CHARS = 8_000;
export const SESSION_HISTORY_MAX_READ_CHARS = 16_000;
export const SESSION_HISTORY_SCAN_CHUNK_BYTES = 64 * 1024;
export const SESSION_HISTORY_ANCHOR_BYTES = 64;
export const SESSION_HISTORY_MAX_QUERY_CHARS = 1024;
export const SESSION_HISTORY_MAX_ID_CHARS = 1024;
// IDs, start offsets and escaped payloads are counted while staging rows. The remaining fields
// (has_more, the two warning codes, truncation marker and continuation offsets) fit within 512 bytes.
export const SESSION_HISTORY_RESULT_ENVELOPE_BYTES = 512;
export const SESSION_HISTORY_READ_RESULT_ENVELOPE_BYTES = 512;
export const SESSION_HISTORY_SEARCH_SNIPPET_CHARS = 500;
// Compact JSON marker; the bounded scanner ignores JSON whitespace around it.
export const SESSION_HISTORY_RESET_NEEDLE = '"contextBoundaryKind":"reset"';
// Each marker character can occupy six raw characters as a JSON Unicode escape.
export const SESSION_HISTORY_RESET_PROBE_CHARS = SESSION_HISTORY_RESET_NEEDLE.length * 6;

// Allow for provider message/tool envelopes beyond encoded visible text.
export const REQUEST_FRAMING_TOKENS = 8;
export const BUDGET_TOKEN_COUNT_CHUNK_CHARS = 4096;
export const BUDGET_TOKEN_CHUNK_SLACK = 8;
