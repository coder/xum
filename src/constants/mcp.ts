/** Per-server MCP startup deadline, kept generous so first-run npx package downloads can finish. */
export const MCP_STARTUP_TIMEOUT_MS = 60_000;

/** Fail-safe wait for startup cleanup so a timeout error cannot hang forever. */
export const MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS = 5_000;

// Bounded so a burst of stdio spawns (npx downloads) cannot thrash the host,
// while several unhealthy servers' startup deadlines overlap instead of stacking.
export const MCP_STARTUP_CONCURRENCY = 4;

/** How long a remote MCP connect keeps the override writer's lock after its initiation (see launchUnderOverrideFence). */
export const MCP_LAUNCH_INITIATION_FENCE_MS = 2_000;

/**
 * How long a stdio launch may take to hand back its exec stream under the
 * override writer's lock before it is ABORTED (see launchUnderOverrideFence).
 * Matches the SSH2 transport's connection-acquisition cap: a cold connection
 * that takes longer fails as a startup timeout and is retried by the next
 * request (with a fresh fence) instead of being released to send its command
 * after a sibling's revocation committed.
 */
export const MCP_STDIO_LAUNCH_FENCE_MS = 15_000;
