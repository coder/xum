import { CompactionHandler } from "../compactionHandler";
import { CompactionMonitor } from "../compactionMonitor";
import type { ContextManagementDependencies } from "./contextManagementService";
import type { SessionContextHost } from "./sessionContextHost";

/** Session-local collaborators. Strategy arbitration stays at the original hooks until migrated. */
export class SessionContextController {
  readonly compaction: Pick<
    CompactionHandler,
    | "handleCompletion"
    | "ackPendingStateConsumed"
    | "peekPendingState"
    | "peekCarryoverState"
    | "peekCachedFilePaths"
    | "discardPendingStateDurably"
    | "appendHeartbeatContextResetBoundary"
    | "rollbackHeartbeatContextResetBoundary"
  >;
  /** Removed after Continuous construction and Token Budget retry move behind this controller. */
  readonly transitionalCompactionHandler: CompactionHandler;
  private readonly compactionMonitor: CompactionMonitor;

  constructor(deps: ContextManagementDependencies, host: SessionContextHost) {
    this.transitionalCompactionHandler = new CompactionHandler({
      workspaceId: host.workspaceId,
      historyService: deps.historyService,
      sessionDir: host.sessionDir,
      telemetryService: deps.telemetryService,
      emitter: host.emitter,
      onCompactionComplete: (metadata) => {
        // RLM keep-recent floor: tail copies make the summary no longer the last row.
        // Record before notifying the session's external observer, including clearing a
        // previous continuous summary ID when a later resumeless fold has no tail.
        host.coordinator.recordCompactionSummary(
          (metadata.preservedTailMessageCount ?? 0) > 0 ? metadata.summaryMessageId : null
        );
        host.onCompactionComplete?.(metadata);
      },
      onIdleCompactionOutcome: (success) => host.onIdleCompactionOutcome?.(success),
    });
    // Keep the handler receiver intact while limiting the session's permanent API surface.
    this.compaction = this.transitionalCompactionHandler;
    this.compactionMonitor = new CompactionMonitor(host.workspaceId, (event) =>
      host.emitChatEvent(event)
    );
  }

  get autoCompactionThreshold(): number {
    return this.compactionMonitor.getThreshold();
  }

  setAutoCompactionThreshold(threshold: number): void {
    this.compactionMonitor.setThreshold(threshold);
  }

  onStreamStarting(): void {
    this.compactionMonitor.resetForNewStream();
  }

  // Thin monitor delegates keep decisions in AgentSession during the ownership migration.
  checkBeforeSend(input: Parameters<CompactionMonitor["checkBeforeSend"]>[0]) {
    return this.compactionMonitor.checkBeforeSend(input);
  }

  checkMidStream(input: Parameters<CompactionMonitor["checkMidStream"]>[0]): boolean {
    return this.compactionMonitor.checkMidStream(input);
  }
}
