/** Per-server MCP startup deadline, kept generous so first-run npx package downloads can finish. */
export const MCP_STARTUP_TIMEOUT_MS = 60_000;

/** Fail-safe wait for startup cleanup so a timeout error cannot hang forever. */
export const MCP_STARTUP_CLEANUP_WAIT_TIMEOUT_MS = 5_000;
