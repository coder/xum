import type { EventEmitter } from "events";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { TurnCoordinator } from "../turnCoordinator";

/** Session-owned authority, kept separate from the app-scoped factory's dependencies. */
export interface SessionContextHost {
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly emitter: EventEmitter;
  readonly coordinator: Pick<TurnCoordinator, "recordCompactionSummary">;
  emitChatEvent(event: WorkspaceChatMessage): void;
  onCompactionComplete?(metadata: CompactionCompletionMetadata): void;
  onIdleCompactionOutcome?(success: boolean): void;
}
