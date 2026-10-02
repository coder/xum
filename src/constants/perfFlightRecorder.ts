/**
 * Perf flight recorder (experiment `perfFlightRecorder`) limits. Every bound the
 * backend recorder, the renderer collector and the oRPC schemas share lives here
 * so memory and payload sizes stay bounded by one set of numbers.
 */

/** Backend health sample cadence (1 Hz). */
export const FLIGHT_RECORDER_SAMPLE_INTERVAL_MS = 1000;
/**
 * `monitorEventLoopDelay` sampling resolution. Recorded loop-delay values include
 * it (an idle loop reads about this much), so the p99 trip fires at roughly
 * FLIGHT_RECORDER_LOOP_DELAY_P99_TRIP_MS minus this of real extra delay.
 */
export const FLIGHT_RECORDER_LOOP_DELAY_RESOLUTION_MS = 20;
/** Heap statistics are read on every Nth backend sample. */
export const FLIGHT_RECORDER_HEAP_EVERY_N_SAMPLES = 10;

/** Every ring drops entries older than this, independent of capacity. */
export const FLIGHT_RECORDER_RETENTION_MS = 10 * 60 * 1000;
export const FLIGHT_RECORDER_BACKEND_SAMPLE_CAPACITY = 600;
export const FLIGHT_RECORDER_HEAP_SAMPLE_CAPACITY = 60;
export const FLIGHT_RECORDER_RENDERER_LOAF_CAPACITY = 600;
export const FLIGHT_RECORDER_RENDERER_EVENT_CAPACITY = 600;
export const FLIGHT_RECORDER_TRIP_CAPACITY = 100;

/** Renderer push cadence; a push happens only when there is something to send. */
export const FLIGHT_RECORDER_RENDERER_BATCH_INTERVAL_MS = 5000;
export const FLIGHT_RECORDER_MAX_LOAF_PER_BATCH = 100;
export const FLIGHT_RECORDER_MAX_EVENTS_PER_BATCH = 200;
export const FLIGHT_RECORDER_MAX_SCRIPTS_PER_LOAF = 8;
/** Event-timing entries shorter than this are not reported by the browser. */
export const FLIGHT_RECORDER_EVENT_DURATION_THRESHOLD_MS = 40;

export const FLIGHT_RECORDER_MAX_SOURCE_URL_CHARS = 512;
export const FLIGHT_RECORDER_MAX_FUNCTION_NAME_CHARS = 256;
export const FLIGHT_RECORDER_MAX_INVOKER_CHARS = 256;
export const FLIGHT_RECORDER_MAX_EVENT_NAME_CHARS = 64;
export const FLIGHT_RECORDER_MAX_TAG_CHARS = 32;
export const FLIGHT_RECORDER_MAX_RENDERER_ID_CHARS = 64;
export const FLIGHT_RECORDER_MAX_FAILURE_CHARS = 256;

/** Loop-delay trip: p99 above this in N consecutive sample windows. */
export const FLIGHT_RECORDER_LOOP_DELAY_P99_TRIP_MS = 100;
export const FLIGHT_RECORDER_LOOP_DELAY_TRIP_CONSECUTIVE_WINDOWS = 2;
/** Long-animation-frame trip: a single frame longer than this. */
export const FLIGHT_RECORDER_LOAF_TRIP_MS = 200;
