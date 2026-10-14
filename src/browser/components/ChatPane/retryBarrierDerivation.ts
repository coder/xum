import type { DisplayedMessage } from "@/common/types/message";
import type { RuntimeStatusEvent, StreamAbortReasonSnapshot } from "@/common/types/stream";
import type { AutoRetryStatus } from "@/browser/utils/messages/autoRetryStatus";
import { shouldShowInterruptedBarrier } from "@/browser/utils/messages/messageUtils";
import {
  getInterruptionContext,
  getLastMainRetryCandidateMessage,
  isPreTokenInterruptedUserTurn,
} from "@/common/utils/messages/retryEligibility";

export interface RetryBarrierDerivationInput {
  /** Latest transcript rows: interruption and the retry candidate are derived from these. */
  messages: DisplayedMessage[];
  /** Rows actually rendered (ChatPane's deferred rows); interrupted dividers are placed on these. */
  renderedMessages: DisplayedMessage[];
  pendingStreamStartTime: number | null;
  runtimeStatus: RuntimeStatusEvent | null;
  lastAbortReason: StreamAbortReasonSnapshot | null;
  autoRetryStatus: AutoRetryStatus | null;
  isHydratingTranscript: boolean;
  /** A turn is starting or streaming (the streaming barrier shows). */
  isTurnActive: boolean;
  /** Read-only transcript: nothing can be resumed from it. */
  transcriptOnly: boolean;
}

export interface RetryBarrierDerivation {
  /** The last turn was interrupted by an error (not a user abort); drives keybinds and UI. */
  showRetryBarrier: boolean;
  lastRetryCandidateMessage: DisplayedMessage | undefined;
  shouldMountRetryBarrier: boolean;
  showRetryBarrierUI: boolean;
  /** Rows followed by an inline "Interrupted" divider. */
  interruptedBarrierMessageIds: Set<string>;
  /** The divider on the retry candidate offers resume (button and keybind). */
  interruptedTailResumable: boolean;
}

/**
 * Retry/interrupted chrome visibility after a stream stops, shared by desktop ChatPane and the
 * VS Code webview (which derives it from its own aggregator) so both show the same barriers.
 */
export function getRetryBarrierDerivation(
  input: RetryBarrierDerivationInput
): RetryBarrierDerivation {
  const interruption = getInterruptionContext(
    input.messages,
    input.pendingStreamStartTime,
    input.runtimeStatus,
    input.lastAbortReason
  );
  const showRetryBarrier =
    !input.isHydratingTranscript && !input.isTurnActive && interruption.hasInterruptedStream;
  const isAutoRetryActive =
    input.autoRetryStatus?.type === "auto-retry-scheduled" ||
    input.autoRetryStatus?.type === "auto-retry-starting";

  const lastRetryCandidateMessage = getLastMainRetryCandidateMessage(input.messages);
  const suppressRetryBarrier =
    lastRetryCandidateMessage?.type === "stream-error" &&
    lastRetryCandidateMessage.errorType === "context_exceeded";
  const showRetryBarrierUI = showRetryBarrier && !suppressRetryBarrier;

  // Derive inline transcript chrome once so row rendering and layout pinning share the exact same
  // visibility decision. This keeps late interrupted markers from sneaking in through a second code
  // path after hydration or auto-retry state changes.
  const interruptedBarrierMessageIds = new Set<string>();
  for (const message of input.renderedMessages) {
    if (
      shouldShowInterruptedBarrier(message, {
        isHydratingTranscript: input.isHydratingTranscript,
        isAutoRetryActive,
      })
    ) {
      interruptedBarrierMessageIds.add(message.id);
    }
  }
  // A turn interrupted before its first token leaves the user message as the tail
  // with no assistant row, so the loop above never marks it. Mark it here (subject
  // to the same hydration/auto-retry/streaming suppression) so the divider still
  // offers to continue. interruptedTailResumable/render both key off this set.
  if (
    !input.isHydratingTranscript &&
    !isAutoRetryActive &&
    !input.isTurnActive &&
    lastRetryCandidateMessage != null &&
    isPreTokenInterruptedUserTurn(lastRetryCandidateMessage, input.lastAbortReason)
  ) {
    interruptedBarrierMessageIds.add(lastRetryCandidateMessage.id);
  }

  // Resumable only on the writable tail and only when RetryBarrier is suppressed
  // (user-aborted case). When RetryBarrier is visible, its button owns resume.
  const interruptedTailResumable =
    !input.transcriptOnly &&
    !showRetryBarrierUI &&
    lastRetryCandidateMessage != null &&
    interruptedBarrierMessageIds.has(lastRetryCandidateMessage.id);

  return {
    showRetryBarrier,
    lastRetryCandidateMessage,
    shouldMountRetryBarrier: !suppressRetryBarrier,
    showRetryBarrierUI,
    interruptedBarrierMessageIds,
    interruptedTailResumable,
  };
}
