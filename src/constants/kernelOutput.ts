/**
 * RLM kernel-mode model-visible output bounds (Track 2 context isolation).
 *
 * In kernel mode (persistent mount) the model's only data channels out of a
 * code_execution call are its return value (r4 handle offload applies),
 * console output, and compact per-call summaries. Console output is the
 * model's deliberate debug/print channel, so it stays visible — but it must
 * be bounded so a stray `console.log(bigValue)` cannot reopen the context
 * leak that record suppression closed.
 */

/** Cap on total model-visible console bytes per execution (kernel mode only). */
export const KERNEL_CONSOLE_CAP_BYTES = 16 * 1024;

/**
 * Capture-time retention budget for console records inside QuickJSRuntime —
 * applies to EVERY eval (kernel, classic PTC, workflows), not just kernel
 * mode: the guest pushes dumped console args into a host-side array as it
 * runs, so without a capture bound a `console.log` loop over large values
 * retains O(guest output) host memory for the whole eval timeout and can
 * exhaust the process before any post-eval cap runs (the QuickJS heap limit
 * does not bound host-side retention). 64x the model-visible kernel cap:
 * generous slack so the post-eval cap keeps exact byte-level semantics for
 * everything it can ever surface, and far above any legitimate console use
 * in the non-kernel paths (which previously had no bound at all), while
 * keeping per-eval host retention trivially bounded.
 */
export const CONSOLE_CAPTURE_BUDGET_BYTES = 64 * KERNEL_CONSOLE_CAP_BYTES;

/**
 * Cap on the serialized args echoed in one compact kernel call record.
 * Without it, passing kernel data to a nested tool (e.g.
 * `xum.file_write({content: vars.large})`) would echo the entire value back
 * through the record's `args`, defeating the result suppression above. The
 * model wrote the code that produced these args, so a bounded head is enough
 * to recognize the call.
 */
export const KERNEL_COMPACT_ARGS_CAP_BYTES = 2 * 1024;

/** Bounded head shown for a mux.load ingestion ({key, bytes, lines, preview}). */
export const KERNEL_LOAD_PREVIEW_CHARS = 512;

/**
 * Aggregate serialized budget for parts retained in ONE media-container
 * record/event (see sanitizeRetainedMediaContainer). MCP applies only a
 * per-part guard, so a tool returning many individually-allowed images could
 * otherwise persist unbounded aggregate base64 into partial.json/chat.jsonl
 * rows. Charged against each part's FULL serialized size (metadata included:
 * a crafted part can hide megabytes in mediaType with an empty data string).
 * Sized to fit a typical screenshot or two (base64 of a ~1MB PNG is ~1.4MB);
 * parts beyond the budget become bounded placeholders.
 */
export const KERNEL_RETAINED_MEDIA_BUDGET_BYTES = 3 * 1024 * 1024;

/**
 * Max parts retained in one sanitized media container (see
 * sanitizeRetainedMediaContainer). Bounds the container's STRUCTURE: without
 * it, a million zero-cost parts would each earn a placeholder object, growing
 * the sanitized record without bound even when every payload is bounded.
 */
export const KERNEL_RETAINED_CONTAINER_MAX_PARTS = 64;

/**
 * Max chars of a validated tool-arg file path preserved on a __kernelBounded
 * args marker (see retainPersistenceCriticalArgsFields). Covers Linux
 * PATH_MAX (4096); longer strings cannot be real paths of successful edits,
 * so they are dropped rather than truncated (a truncated path would
 * misattribute the record to a nonexistent file).
 */
export const KERNEL_RETAINED_PATH_MAX_CHARS = 4096;
