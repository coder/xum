import { useState } from "react";

/**
 * #6038: whether the creation composer of `scopeKey` cannot send yet ("Run /init" stays off then).
 * ProjectPage is reused across projects and drafts while its composer remounts per scope, so a
 * new scope starts blocked until its own composer reports. The reset happens during render, so no
 * render of the new scope shows the previous scope's "can send".
 */
export function useCreationSendBlocked(scopeKey: string) {
  const [state, setState] = useState({ scopeKey, blocked: true });
  if (state.scopeKey !== scopeKey) {
    setState({ scopeKey, blocked: true });
  }
  const blocked = state.scopeKey === scopeKey ? state.blocked : true;
  // Keeps the same state when nothing changed, so a report that repeats causes no render.
  const setBlocked = (next: boolean) =>
    setState((current) =>
      current.scopeKey === scopeKey && current.blocked === next
        ? current
        : { scopeKey, blocked: next }
    );
  return [blocked, setBlocked] as const;
}
