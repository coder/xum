import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import { STABLE_TIMESTAMP } from "./workspaces";

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT SCENARIO BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Chat handler type for onChat callbacks */
type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

/** Creates a chat handler that sends messages then caught-up */
export function createStaticChatHandler(messages: ChatMuxMessage[]): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      for (const msg of messages) {
        callback(msg);
      }
      callback({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });
    }, 50);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  };
}

/** Creates a chat handler with streaming state */
export function createStreamingChatHandler(opts: {
  messages: ChatMuxMessage[];
  streamingMessageId: string;
  model: string;
  historySequence: number;
  streamText?: string;
  pendingTool?: { toolCallId: string; toolName: string; args: object };
}): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      // Send historical messages
      for (const msg of opts.messages) {
        callback(msg);
      }
      callback({ type: "caught-up", historyReplayStatus: "complete", hasOlderHistory: false });

      // Start streaming
      callback({
        type: "stream-start",
        workspaceId: "mock",
        messageId: opts.streamingMessageId,
        model: opts.model,
        historySequence: opts.historySequence,
        startTime: Date.now(),
      });

      // Send text delta if provided
      if (opts.streamText) {
        callback({
          type: "stream-delta",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          delta: opts.streamText,
          tokens: 10,
          timestamp: STABLE_TIMESTAMP,
        });
      }

      // Send tool call start if provided
      if (opts.pendingTool) {
        callback({
          type: "tool-call-start",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          toolCallId: opts.pendingTool.toolCallId,
          toolName: opts.pendingTool.toolName,
          args: opts.pendingTool.args,
          tokens: 5,
          timestamp: STABLE_TIMESTAMP,
        });
      }
    }, 50);

    // Keep the streaming state active, but avoid emitting periodic visible deltas.
    // Those deltas can make visual snapshots flaky (different text length per run).
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  };
}
