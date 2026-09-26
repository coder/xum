import assert from "@/common/utils/assert";

/**
 * Read-only view of WorkspaceStore's chat-replay state used to defer passive
 * git/PR probes while a workspace's onChat history replay is still pending (#4662).
 */
export interface ChatReplayGate {
  isReplayPending(workspaceId: string): boolean;
  subscribeKey(workspaceId: string, listener: () => void): () => void;
}

/**
 * Arms a one-shot listener that fires `onSettled()` once the workspace's chat replay is
 * no longer pending. Callers arm it only after `isReplayPending` returned true, so it
 * never fires synchronously (callers store the returned cancel function afterwards).
 *
 * Returns a cancel function; the listener auto-unsubscribes after firing once.
 */
export function onChatReplaySettled(
  gate: ChatReplayGate,
  workspaceId: string,
  onSettled: () => void
): () => void {
  assert(
    gate.isReplayPending(workspaceId),
    `onChatReplaySettled requires a pending chat replay for ${workspaceId}`
  );

  let done = false;
  const unsubscribe = gate.subscribeKey(workspaceId, () => {
    if (done || gate.isReplayPending(workspaceId)) {
      return;
    }
    done = true;
    unsubscribe();
    onSettled();
  });

  return () => {
    done = true;
    unsubscribe();
  };
}
