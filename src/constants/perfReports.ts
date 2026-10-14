/**
 * "Report slowness" bundle limits (experiment `perfFlightRecorder`, F4). A report is a
 * local directory under `<xum home>/perf/reports/<id>/`; nothing is uploaded.
 */

/** Upper bound for one bundle on disk. Captures are dropped (oldest first) to fit. */
export const PERF_REPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
/** At most this many of the newest captures are considered for a bundle. */
export const PERF_REPORT_MAX_CAPTURES = 10;
/** A hang record's JS stack is truncated to this many characters. */
export const PERF_REPORT_MAX_HANG_STACK_CHARS = 16_000;
/** A `.<id>.partial` report directory older than this was abandoned (the process quit). */
export const PERF_REPORT_STALE_PARTIAL_MS = 10 * 60 * 1000;
