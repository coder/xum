/** Xum's limits for one Codex-format plugin hook call, in seconds (Codex's default is 600). */
export const HOOK_DEFAULT_TIMEOUT_SECONDS = 10;
export const HOOK_MAX_TIMEOUT_SECONDS = 30;

/** A Stop hook without its own `loop_limit` continues one user turn at most this many times. */
export const MAX_STOP_HOOK_CONTINUATIONS = 3;
/** Stop-hook continuations of one user turn, all hooks together, even with `loop_limit: null`. */
export const MAX_PLUGIN_CONTINUATIONS_PER_USER_TURN = 50;

/** The timeout a hook call runs with: its declared timeout (or the default), capped. */
export function effectiveHookTimeoutSeconds(declaredSeconds: number | undefined): number {
  return Math.min(declaredSeconds ?? HOOK_DEFAULT_TIMEOUT_SECONDS, HOOK_MAX_TIMEOUT_SECONDS);
}
