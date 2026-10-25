/**
 * Read-only view of WorkspaceStore's chat-replay state used to defer passive
 * git/PR probes while a workspace's onChat history replay is still pending (#4662).
 */
export interface ChatReplayGate {
  isReplayPending(workspaceId: string): boolean;
  subscribeKey(workspaceId: string, listener: () => void): () => void;
}

/**
 * #4662: returns true while the workspace's chat replay is pending, so the caller skips its
 * git/PR probes for now. Each executeBash spawn blocks the Electron main process ~8-16 ms and
 * the results render during the transcript paint; the cached status stays visible meanwhile,
 * and deferring costs roughly the replay duration (~0.1-0.2 s on cold open).
 *
 * Arms at most one retry per workspace in `retries` (workspace ID -> cancel function). The
 * retry removes its entry and calls `onSettled()` once the replay is no longer pending.
 */
export function deferWhileChatReplayPending(
  gate: ChatReplayGate | null,
  retries: Map<string, () => void>,
  workspaceId: string,
  onSettled: () => void
): boolean {
  if (!gate?.isReplayPending(workspaceId)) {
    return false;
  }
  if (retries.has(workspaceId)) {
    return true;
  }

  let done = false;
  const unsubscribe = gate.subscribeKey(workspaceId, () => {
    if (done || gate.isReplayPending(workspaceId)) {
      return;
    }
    done = true;
    unsubscribe();
    retries.delete(workspaceId);
    onSettled();
  });
  retries.set(workspaceId, () => {
    done = true;
    unsubscribe();
  });
  return true;
}
