import type { HostTranscriptBarrier } from "xum/browser/contexts/ChatHostContext";

/**
 * Transcript mutation barrier for the webview's selected workspace (#4942). The shared plan card
 * reads it through ChatHostContext because the webview never registers in WorkspaceStore.
 *
 * Open only after a complete history replay while a server connection exists. A forced catch-up
 * (replay buffer overflow, partial transcript) keeps it closed: actions such as "Implement the
 * plan" act on the transcript the user sees.
 */
export class WebviewTranscriptBarrier implements HostTranscriptBarrier {
  private workspaceId: string | null = null;
  private caughtUp = false;
  private connected = false;
  private readonly listeners = new Set<() => void>();

  /** Closes the barrier for a new selection, a chatReset or a new replay. */
  reset(workspaceId: string | null): void {
    this.update(() => {
      this.workspaceId = workspaceId;
      this.caughtUp = false;
    });
  }

  /** Called when the replay buffer flushes; `complete` is false for a forced catch-up. */
  markCaughtUp(workspaceId: string, complete: boolean): void {
    this.update(() => {
      this.workspaceId = workspaceId;
      this.caughtUp = complete;
    });
  }

  setConnected(connected: boolean): void {
    this.update(() => {
      this.connected = connected;
    });
  }

  subscribe(_workspaceId: string, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isAllowed(workspaceId: string): boolean {
    return this.connected && this.caughtUp && workspaceId === this.workspaceId;
  }

  private update(change: () => void): void {
    const before = this.snapshot();
    change();
    if (this.snapshot() !== before) {
      for (const listener of this.listeners) listener();
    }
  }

  private snapshot(): string {
    return `${this.workspaceId ?? ""}|${this.caughtUp}|${this.connected}`;
  }
}
