import type { WorkspaceChatMessage } from "xum/common/orpc/types";
import { BASH_TRUNCATE_MAX_TOTAL_BYTES } from "xum/common/constants/toolLimits";
import type { LiveBashOutputSource } from "xum/browser/stores/liveBashOutputSource";
import {
  applyLiveBashOutputEvent,
  type LiveBashOutputInternal,
  type LiveBashOutputView,
} from "xum/browser/utils/messages/liveBashOutputBuffer";

/**
 * Live bash output for the webview's single selected workspace (#4750), fed from the chat
 * events the extension already forwards. Uses the same buffer rules as desktop's WorkspaceStore
 * (applyLiveBashOutputEvent) without registering the workspace in that store.
 */
export class WebviewLiveBashOutput implements LiveBashOutputSource {
  private workspaceId: string | null = null;
  private readonly output = new Map<string, LiveBashOutputInternal>();
  private readonly listeners = new Set<() => void>();

  /** Drops all live output, e.g. when the selection changes or the transcript replays again. */
  reset(workspaceId: string | null): void {
    this.workspaceId = workspaceId;
    if (this.output.size === 0) return;
    this.output.clear();
    this.notify();
  }

  apply(workspaceId: string, event: WorkspaceChatMessage): void {
    if (workspaceId !== this.workspaceId) return;
    if (applyLiveBashOutputEvent(this.output, event, BASH_TRUNCATE_MAX_TOTAL_BYTES)) {
      this.notify();
    }
  }

  subscribe(_workspaceId: string, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get(workspaceId: string, toolCallId: string): LiveBashOutputView | null {
    if (workspaceId !== this.workspaceId) return null;
    return this.output.get(toolCallId) ?? null;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
