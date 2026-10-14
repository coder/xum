/** Xum's limits for one Codex-format plugin hook call, in seconds (Codex's default is 600). */
export const HOOK_DEFAULT_TIMEOUT_SECONDS = 10;
export const HOOK_MAX_TIMEOUT_SECONDS = 30;

/** The timeout a hook call runs with: its declared timeout (or the default), capped. */
export function effectiveHookTimeoutSeconds(declaredSeconds: number | undefined): number {
  return Math.min(declaredSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS, HOOK_MAX_TIMEOUT_SECONDS);
}
