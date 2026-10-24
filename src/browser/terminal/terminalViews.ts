/**
 * The terminal sessions that a mounted TerminalView shows in this window, hidden views too.
 *
 * Each such view listens for its session's exit, writes "[Process exited with code N]" and then
 * closes its tab. So the sidebar's session sync leaves those tabs to the view: after a server
 * restart the new server lists no sessions, and removing the tab first would drop the exit line.
 */
const viewCounts = new Map<string, number>();

/** Records a mounted view of `sessionId` until the returned function runs. */
export function registerTerminalView(sessionId: string): () => void {
  viewCounts.set(sessionId, (viewCounts.get(sessionId) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = (viewCounts.get(sessionId) ?? 0) - 1;
    if (count > 0) viewCounts.set(sessionId, count);
    else viewCounts.delete(sessionId);
  };
}

/** The sessions with at least one mounted view. */
export function getViewedTerminalSessionIds(): string[] {
  return [...viewCounts.keys()];
}
