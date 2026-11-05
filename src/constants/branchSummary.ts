/**
 * Branch summarization on fork/truncate (rlm-mode experiment, nested under
 * Programmatic Tool Calling). When RLM mode is on and history branches (fork
 * from an earlier message or edit-resend truncation), the abandoned tail is
 * summarized via a cheap side-channel model call and appended to the new
 * branch as a durable labeled row. With RLM off these constants are unused
 * and forks/truncations behave exactly as before.
 */

/**
 * Minimum estimated token size (chars/4 heuristic over serialized parts) of
 * the abandoned segment before a summary is worth a model call. Tiny tails
 * (a quick retry of the last message, a one-line answer) carry no context
 * worth preserving.
 */
export const BRANCH_SUMMARY_MIN_SEGMENT_TOKENS = 1_000;

/**
 * Word target given to the summarizer prompt. Deliberately well below the
 * output-token cap (250 words ≈ 325 tokens at WORDS_TO_TOKENS_RATIO, ~1.6x
 * headroom under BRANCH_SUMMARY_MAX_OUTPUT_TOKENS): when the word target
 * matches the token cap the model always stops at max_tokens and every
 * summary ends mid-sentence. The gap lets summaries finish naturally.
 */
export const BRANCH_SUMMARY_TARGET_WORDS = 250;

/**
 * Hard output-token cap for the summary call. This is a safety bound only —
 * the prompt's word target (BRANCH_SUMMARY_TARGET_WORDS) sits well below it
 * so a well-behaved model never hits this cap.
 */
export const BRANCH_SUMMARY_MAX_OUTPUT_TOKENS = 512;

/**
 * Extra output-token headroom for candidates that cannot disable thinking
 * (Opus 5.5, Fable/Mythos): thinking counts toward max_tokens, so without it
 * thinking can exhaust the summary budget above. BRANCH_SUMMARY_TIMEOUT_MS,
 * not this cap, still bounds wall time.
 */
export const BRANCH_SUMMARY_THINKING_HEADROOM_TOKENS = 1_536;

/**
 * Hard wall-clock bound for the whole summary generation (all candidate models share one
 * deadline). The candidates are STRICTLY the workspace's own configured models (see
 * `deriveSideChannelModelCandidates`), so the throughput that sizes this is the USER's
 * model, not a hosted one. The previous 6s came from dogfooded hosted haiku: ~100 tok/s
 * with ~0.6s TTFB, so a worst-case max_tokens stream is ~0.6s + 512/100 = ~5.7s and the
 * typical natural stop (~325 tokens) lands around 3.9s. That hosted bound starves a
 * self-hosted open-weights model, which commonly answers at 20-50 tok/s (512 tokens then
 * needs ~11-26s) and adds time-to-first-token while it loads.
 *
 * The raise costs a fast route nothing: this is a deadline, not a wait, so a summary that
 * finishes in 4s still finishes in 4s. The cost lands on the slow path — the edit-resend
 * flow waits synchronously on it (see maybeAppendAbandonedBranchSummary for why), and
 * `BRANCH_SUMMARY_LOCK_WAIT_TIMEOUT_MS` derives from this value, so the fork's first-send
 * wait grows with it. Both are traded against the alternative, which is silently dropping
 * the abandoned branch's context on every fork and edit-resend.
 */
export const BRANCH_SUMMARY_TIMEOUT_MS = 20_000;

/**
 * Hard cap on characters accumulated from the summary stream. Purely
 * defensive: BRANCH_SUMMARY_MAX_OUTPUT_TOKENS already bounds well-behaved
 * providers (~4 chars/token ≈ 2k chars), but a pathological provider that
 * ignores both max_tokens and abort could otherwise grow the buffer without
 * bound between the consume loop's deadline checks. Generous multiple of the
 * worst-case legitimate output so it can never clip a real summary.
 */
export const BRANCH_SUMMARY_MAX_ACCUMULATED_CHARS = 32_000;

/**
 * Input cap for the thinking-stripped transcript fed to the summarizer.
 * Oldest messages are dropped first: the newest abandoned work carries the
 * most context worth preserving. ~40k tokens at the chars/4 heuristic keeps
 * the side-channel call cheap even for a large abandoned tail.
 */
export const BRANCH_SUMMARY_MAX_TRANSCRIPT_CHARS = 160_000;
