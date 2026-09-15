import { eventSpine } from "../../events/eventSpine";
import { log } from "../../log";
import { buildAutoCompactionFollowUp } from "../compactionRequests";
import type { SessionContextHost } from "../sessionContextHost";
import type { ContinuousStrategy } from "./continuous";

/** Policy compaction stops the stream without entering the public user-interrupt path. */
export class SummarizeStrategy {
  constructor(
    private readonly host: SessionContextHost,
    private readonly continuous: ContinuousStrategy
  ) {}

  async interruptForCompaction(): Promise<void> {
    if (this.host.coordinator.midStreamCompactionPending || this.host.coordinator.closing) {
      return;
    }
    using _execution = this.host.coordinator.enterExecution();
    const admissionStale = this.host.captureCompactionAdmission("automatic");

    const streamContext = this.host.state.stream;
    if (!streamContext?.modelString || !streamContext.options) {
      return;
    }

    const interruptedUserMessageId = this.host.state.userMessageId;
    this.continuous.continuousCompactor.reset("legacy-fallback");

    const token = this.host.coordinator.beginCompactionObservation("legacy");
    if (token == null) return;
    this.host.coordinator.setCompactionStage(token, "stopping");
    try {
      const stopResult = await this.host.streams.stopStream(this.host.workspaceId, {
        abortReason: "system",
      });
      if (!stopResult.success) {
        log.warn("Failed to stop stream for mid-stream compaction", {
          workspaceId: this.host.workspaceId,
          error: stopResult.error,
        });
        return;
      }

      await this.host.waitForIdle();
      if (this.host.coordinator.disposed || admissionStale()) {
        return;
      }

      const followUpContent = buildAutoCompactionFollowUp({
        // Keep mid-stream auto-compaction on the shared default sentinel so
        // buildCompactionMessageText can hide the internal resume marker.
        messageText: "Continue",
        options: streamContext.options,
        agentInitiated: streamContext.agentInitiated,
        goalKind: streamContext.goalKind,
        goalId: streamContext.goalId,
        modelForStream: streamContext.modelString,
        muxMetadata: streamContext.workspaceTurnMetadata,
      });
      // Waterfall hook point: see the on-send compaction.prepare run above.
      await eventSpine.run("compaction.prepare", {
        workspaceId: this.host.workspaceId,
        reason: "mid-stream",
      });

      if (admissionStale()) return;
      const autoCompactionRequest = this.host.buildAutoCompactionRequest({
        followUpContent,
        baseOptions: streamContext.options,
        reason: "mid-stream",
      });

      await this.host.sendCompactionRequest(
        {
          messageText: autoCompactionRequest.messageText,
          sendOptions: {
            ...autoCompactionRequest.sendOptions,
            muxMetadata: autoCompactionRequest.metadata,
          },
          agentInitiated: autoCompactionRequest.agentInitiated,
        },
        {
          stream: streamContext,
          admissionStale,
          interruptedUserMessageId,
          failureDisposition: "legacy-interrupt",
        }
      );
    } finally {
      this.host.coordinator.finishCompactionObservation(token);
      // Preflight drains deferred to this pending compaction have no other retry: if the
      // compaction request never became a turn, release the queue now (no-op when it did).
      this.host.onCompactionObservationSettled();
    }
  }
}
