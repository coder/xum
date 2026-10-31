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

/** A hook call's input larger than this (as JSON) is not sent; both hook runners use it. */
export const HOOK_INPUT_MAX_CHARS = 64 * 1024;

/** The Cursor hook events Xum runs (Cursor plugin RFC D9). Every other event is listed only. */
export const CURSOR_RUNNABLE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "afterFileEdit",
  "afterAgentResponse",
  "stop",
]);

/**
 * Why a Cursor hook does not run, or undefined when it runs. One source for the loader's status
 * and not-applied list and for the hooks panel, checked in this order.
 */
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
