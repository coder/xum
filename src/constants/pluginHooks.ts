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

/**
 * Spine order of a plugin hook runner's discovery index 0, for Codex and Cursor hooks alike: below
 * the default order 0 of the shell hook middleware, so a plugin's rewrites finish before it.
 */
export const PLUGIN_HOOK_ORDER_BASE = -1_000_000;

/** A hook call's input larger than this (as JSON) is not sent. */
export const HOOK_INPUT_MAX_CHARS = 64 * 1024;

export const CURSOR_RUNNABLE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "afterFileEdit",
  "afterAgentResponse",
  "stop",
]);

export function cursorHookNotAppliedReason(hook: {
  event: string;
  matcher?: string;
  handler: { type: string };
}): string | undefined {
  if (hook.handler.type === "cursor-prompt") return "prompt hooks are not applied in Xum";
  if (!CURSOR_RUNNABLE_HOOK_EVENTS.has(hook.event)) return "event not applied in Xum";
  if (hook.matcher !== undefined) return "matcher not applied in Xum";
  return undefined;
}
