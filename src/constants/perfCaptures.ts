/**
 * Triggered CPU profile limits (experiment `perfFlightRecorder`, F2). A capture
 * records what a process does right AFTER a flight recorder trip, so it shows
 * follow-on work, not the stall that tripped the recorder.
 */

/** How long a trip-triggered capture profiles. */
export const PERF_CAPTURE_TRIP_DURATION_MS = 8000;
/** V8 sampling interval: 1 ms. */
export const PERF_CAPTURE_SAMPLING_INTERVAL_US = 1000;
/**
 * Cooldowns per trip kind: after a trip capture is admitted (skipped ones included), the
 * same trip kind is ignored this long. Manual captures neither check nor set them.
 *
 * Backend (`loop-delay-p99`): 60 minutes is a tradeoff, not a measured optimum. Starting
 * the backend profiler blocks the event loop (about 0.76 s per capture, measured on a
 * long-running desktop backend), and at a 10-minute cooldown the recorder caused 4-5 such
 * freezes per hour while every capture showed the same hotspots. A longer cooldown means
 * fewer self-inflicted freezes, but also fewer observations.
 */
export const PERF_CAPTURE_BACKEND_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * Renderer (`long-animation-frame`): stays at 10 minutes because the freeze measurements
 * above cover only the backend.
 */
export const PERF_CAPTURE_RENDERER_COOLDOWN_MS = 10 * 60 * 1000;
/** Retention: newest captures with a profile kept, and their total size on disk. */
export const PERF_CAPTURE_MAX_CAPTURES = 20;
export const PERF_CAPTURE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/**
 * Retention for metadata-only records (skipped or failed captures), counted apart so
 * they never push out a real profile.
 */
export const PERF_CAPTURE_MAX_SKIPPED_RECORDS = 20;
/**
 * Leftover writeFileAtomic temp files, and orphan profiles without valid metadata
 * (an interrupted metadata write), older than this are removed during retention.
 */
export const PERF_CAPTURE_STALE_TEMP_MS = 10 * 60 * 1000;
/** Bounds for a manual `captureNow` duration. */
export const PERF_CAPTURE_MIN_MANUAL_DURATION_MS = 1000;
export const PERF_CAPTURE_MAX_MANUAL_DURATION_MS = 30_000;
/** `skippedReason` length cap (failure messages are truncated to it). */
export const PERF_CAPTURE_MAX_REASON_CHARS = 300;
/** Every trip capture says what it shows: the activity after its trigger. */
export const PERF_CAPTURE_LABEL = "activity after trigger";
/** A manual capture has no trigger; it shows the activity while it ran. */
export const PERF_CAPTURE_MANUAL_LABEL = "manual capture";
