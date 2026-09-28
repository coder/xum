/**
 * Startup passes that take longer than this are logged at warn level so slow deployments
 * (thousands of workspaces, large session dirs) surface in logs without enabling debug output.
 * Chosen well above a healthy cold start (seconds) but below the point where a health check
 * would already have flagged the process.
 */
export const SLOW_STARTUP_WARN_THRESHOLD_MS = 30_000;

/**
 * Upper bound for the filesystem probe behind GET /health. Node routes async fs work through a
 * small libuv threadpool; when that pool is wedged on unresponsive storage every request that
 * touches disk hangs while the event loop stays idle. The probe turns that into a prompt 503
 * instead of a client-side timeout. Well above a healthy stat (sub-millisecond) and below the
 * 5s the Coder app healthcheck waits before counting a probe as failed.
 */
export const HEALTH_FS_PROBE_TIMEOUT_MS = 2_000;
