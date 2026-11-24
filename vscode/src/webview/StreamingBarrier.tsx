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
  /** The live line's activity chips; see StreamingBarrierView's `activity`. */
  activity?: React.ReactNode;
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
 *
 * It is the webview's live line (#7689): it carries the activity chips, also between turns and
 * before the transcript has an aggregator. Both paths render the same element, so the chips never
 * remount when a turn starts or ends, which would close an open panel and the bash output dialog.
 */
export const VscodeStreamingBarrier: React.FC<VscodeStreamingBarrierProps> = (props) => {
  const aggregator = props.aggregator;
  const streamState = aggregator ? getAggregatorStreamState(aggregator) : null;
  const messageId = aggregator?.getActiveStreamMessageId();

  return (
    <StreamingBarrierContent
      workspaceId={props.workspaceId}
      state={{
        canInterrupt: streamState?.canInterrupt ?? false,
        isCompacting: aggregator?.isCompacting() ?? false,
        isStreamStarting: streamState?.isStreamStarting ?? false,
        isInterrupting: aggregator?.hasInterruptingStream() ?? false,
        awaitingUserQuestion: aggregator?.hasAwaitingUserQuestion() ?? false,
        currentModel: aggregator?.getCurrentModel() ?? null,
        pendingStreamModel: aggregator?.getPendingStreamModel() ?? null,
        runtimeStatus: aggregator?.getRuntimeStatus() ?? null,
        activeBashMonitorCount: props.activeBashMonitorCount,
      }}
      streamingStats={
        aggregator && messageId
          ? {
              tokenCount: aggregator.getStreamingTokenCount(messageId),
              tps: aggregator.getStreamingTPS(messageId),
            }
          : null
      }
      className={props.className}
      onCancel={props.onCancel}
      // As on desktop's live line: the model picker sits right below, and the chips need the room.
      showModelName={false}
      activity={props.activity}
      // No onConfigureCompaction: the webview has no Settings surface, so the compaction
      // "configure" hint is intentionally not shown.
    />
  );
};
