import React from "react";

import type { StreamingMessageAggregator } from "xum/browser/utils/messages/StreamingMessageAggregator";
import {
  StreamingBarrierContent,
  type StreamingBarrierCancelPhase,
} from "xum/browser/features/Messages/ChatBarrier/StreamingBarrier";

export interface VscodeStreamingBarrierProps {
  workspaceId: string;
  aggregator: StreamingMessageAggregator | null;
  /** Armed background bash monitors for this workspace, forwarded by the extension host. */
  activeBashMonitorCount: number;
  /** Interrupts the stream through the webview's single interrupt path (also used by Esc). */
  onCancel: (phase: StreamingBarrierCancelPhase) => void;
  className?: string;
}

/**
 * The desktop WorkspaceStore's canInterrupt / isStreamStarting, derived from the webview's
 * aggregator. Also feeds the transcript's turn-active bundle state (#4979).
 */
export function getAggregatorStreamState(aggregator: StreamingMessageAggregator): {
  canInterrupt: boolean;
  isStreamStarting: boolean;
} {
  const canInterrupt = aggregator.hasInterruptibleActiveStream();
  return {
    canInterrupt,
    isStreamStarting:
      !canInterrupt &&
      (aggregator.getStreamLifecycle()?.phase === "preparing" ||
        aggregator.getPendingStreamStartTime() !== null),
  };
}

/**
 * Feeds the desktop barrier from the webview's aggregator (#4971). The webview does not feed
 * WorkspaceStore, so this mirrors its active-workspace derivation for a caught-up transcript. The
 * App re-renders on every transcript flush, so the live stats are re-read on each one.
 */
export const VscodeStreamingBarrier: React.FC<VscodeStreamingBarrierProps> = (props) => {
  const aggregator = props.aggregator;
  if (!aggregator) {
    return null;
  }

  const { canInterrupt, isStreamStarting } = getAggregatorStreamState(aggregator);
  const messageId = aggregator.getActiveStreamMessageId();

  return (
    <StreamingBarrierContent
      workspaceId={props.workspaceId}
      state={{
        canInterrupt,
        isCompacting: aggregator.isCompacting(),
        isStreamStarting,
        isInterrupting: aggregator.hasInterruptingStream(),
        awaitingUserQuestion: aggregator.hasAwaitingUserQuestion(),
        currentModel: aggregator.getCurrentModel() ?? null,
        pendingStreamModel: aggregator.getPendingStreamModel(),
        runtimeStatus: aggregator.getRuntimeStatus(),
        activeBashMonitorCount: props.activeBashMonitorCount,
      }}
      streamingStats={
        messageId
          ? {
              tokenCount: aggregator.getStreamingTokenCount(messageId),
              tps: aggregator.getStreamingTPS(messageId),
            }
          : null
      }
      className={props.className}
      onCancel={props.onCancel}
      // No onConfigureCompaction: the webview has no Settings surface, so the compaction
      // "configure" hint is intentionally not shown.
    />
  );
};
