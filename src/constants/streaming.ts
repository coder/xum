// Smooth streaming presentation constants.
// These control the jitter buffer that makes streamed text appear at a steady cadence
// instead of bursty token clumps. Internal-only; no user-facing setting.
// Short visual debounce for sidebar status handoffs so the row stays anchored while
// startup/streaming flags settle on adjacent renders.
export const WORKSPACE_STREAMING_STATUS_TRANSITION_MS = 150;

/**
 * Average character-per-token estimate used to convert tokens-per-second (from
 * the streaming TPS calculator) into characters-per-second (consumed by the
 * smoothing engine to target the model's actual emission rate). 4 is the
 * standard heuristic for English text and most code.
 */
export const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Largest streaming row (in UTF-16 chars) that paints synchronously when it mounts mid-stream
 * (#5555). Above it the row keeps Streamdown's deferred streaming mode and can show empty for a
 * few frames. Measured in production Chrome with code-heavy replies (a ts fence and a table about
 * every 520 chars), flushSync mount p50/p95: 20k chars 37.7/40.8 ms, 30k chars 69.8/74.8 ms. The
 * cap keeps the synchronous mount under the 50 ms budget with margin.
 */
export const STATIC_STREAMING_MOUNT_MAX_CHARS = 20_000;

/**
 * Rows above STATIC_STREAMING_MOUNT_MAX_CHARS that mount mid-stream render as chunks of whole
 * markdown blocks, each a static render, so no transition is needed (#5647). A chunk of about
 * this many chars keeps each chunk render, and so each streaming delta, short.
 */
export const CHUNKED_STREAMING_CHUNK_CHARS = 2_000;

/** Older chunks of such a row mount this many per animation frame, after its last chunk. */
export const CHUNKED_STREAMING_CHUNKS_PER_FRAME = 4;

export const STREAM_SMOOTHING = {
  /** Baseline reveal speed in characters per second when no live model rate is known yet. */
  BASE_CHARS_PER_SEC: 72,
  /** Floor — never slower than this even when buffer is nearly empty. */
  MIN_CHARS_PER_SEC: 24,
  /** Ceiling — hard cap to prevent overwhelming the markdown renderer. */
  MAX_CHARS_PER_SEC: 420,
  /** Backlog level where adaptive reveal runs at MAX_CHARS_PER_SEC. */
  CATCHUP_BACKLOG_CHARS: 180,
  /**
   * Soft catch-up threshold: above this lag the engine ramps target rate so
   * the lag drains within ~SOFT_CATCHUP_DRAIN_MS — instead of a visible jump.
   */
  SOFT_CATCHUP_LAG_CHARS: 60,
  /** Time horizon over which the engine aims to drain a soft-catchup lag. */
  SOFT_CATCHUP_DRAIN_MS: 250,
  /**
   * Hard safety threshold. Only a pathological burst (slow renderer, paused
   * tab) should ever push backlog this far; if it happens, snap visible
   * forward to keep the user from staring at a long invisible tail. With a
   * model emitting at typical rates the soft catch-up keeps backlog far
   * below this.
   */
  MAX_VISUAL_LAG_CHARS: 1024,
  /** Max characters revealed in a single animation frame. */
  MAX_FRAME_CHARS: 48,
  /**
   * Min characters revealed per tick once budget permits. Set to 2 so reveals
   * coalesce to ~30 Hz at the base rate instead of ~60 Hz — equal visual
   * smoothness to humans, half the markdown-reparse cost.
   */
  MIN_FRAME_CHARS: 2,
} as const;
