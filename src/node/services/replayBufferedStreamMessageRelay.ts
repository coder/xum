import type { WorkspaceChatMessage } from "@/common/orpc/types";

type ReplayBufferedSessionMessage = Extract<
  WorkspaceChatMessage,
  {
    type:
      | "stream-delta"
      | "reasoning-delta"
      | "stream-end"
      | "stream-abort"
      | "stream-error"
      | "init-start"
      | "init-output"
      | "init-end";
  }
>;

type ReplayBufferedDeltaMessage = Extract<
  ReplayBufferedSessionMessage,
  { type: "stream-delta" | "reasoning-delta" }
>;

function isReplayBufferedSessionMessage(
  message: WorkspaceChatMessage
): message is ReplayBufferedSessionMessage {
  return (
    message.type === "stream-delta" ||
    message.type === "reasoning-delta" ||
    message.type === "stream-end" ||
    message.type === "stream-abort" ||
    message.type === "stream-error" ||
    message.type === "init-start" ||
    message.type === "init-output" ||
    message.type === "init-end"
  );
}

function isReplayBufferedDeltaMessage(
  message: ReplayBufferedSessionMessage
): message is ReplayBufferedDeltaMessage {
  return message.type === "stream-delta" || message.type === "reasoning-delta";
}

type ReplayBufferedInitMessage = Extract<
  ReplayBufferedSessionMessage,
  { type: "init-start" | "init-output" | "init-end" }
>;

function isReplayBufferedInitMessage(
  message: ReplayBufferedSessionMessage
): message is ReplayBufferedInitMessage {
  return (
    message.type === "init-start" || message.type === "init-output" || message.type === "init-end"
  );
}

function isReplayMessage(message: WorkspaceChatMessage): boolean {
  return (message as { replay?: unknown }).replay === true;
}

function replayBufferedDeltaKey(message: ReplayBufferedDeltaMessage): string {
  return JSON.stringify([message.type, message.messageId, message.timestamp, message.delta]);
}

function replayBufferedInitKey(message: ReplayBufferedInitMessage): string {
  switch (message.type) {
    case "init-start":
      return JSON.stringify([message.type, message.hookPath, message.timestamp]);
    case "init-output":
      return JSON.stringify([
        message.type,
        message.lineNumber ?? null,
        message.line,
        message.isError === true,
        message.timestamp,
      ]);
    case "init-end":
      return JSON.stringify([
        message.type,
        message.exitCode,
        message.truncatedLines ?? null,
        message.timestamp,
      ]);
  }
}

export function createReplayBufferedStreamMessageRelay(
  push: (message: WorkspaceChatMessage) => void
): {
  handleSessionMessage: (message: WorkspaceChatMessage) => void;
  finishReplay: () => void;
} {
  let isReplaying = true;
  const bufferedLiveSessionMessages: ReplayBufferedSessionMessage[] = [];

  // Counters (not Sets) so we don't drop more buffered events than were replayed.
  const replayedDeltaKeyCounts = new Map<string, number>();
  const replayedInitKeyCounts = new Map<string, number>();

  const noteReplayedDelta = (message: ReplayBufferedDeltaMessage) => {
    const key = replayBufferedDeltaKey(message);
    replayedDeltaKeyCounts.set(key, (replayedDeltaKeyCounts.get(key) ?? 0) + 1);
  };

  const noteReplayedInit = (message: ReplayBufferedInitMessage) => {
    const key = replayBufferedInitKey(message);
    replayedInitKeyCounts.set(key, (replayedInitKeyCounts.get(key) ?? 0) + 1);
  };

  const shouldDropBufferedDelta = (message: ReplayBufferedDeltaMessage): boolean => {
    const key = replayBufferedDeltaKey(message);
    const remaining = replayedDeltaKeyCounts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      replayedDeltaKeyCounts.delete(key);
    } else {
      replayedDeltaKeyCounts.set(key, remaining - 1);
    }
    return true;
  };

  const shouldDropBufferedInit = (message: ReplayBufferedInitMessage): boolean => {
    const key = replayBufferedInitKey(message);
    const remaining = replayedInitKeyCounts.get(key) ?? 0;
    if (remaining <= 0) {
      return false;
    }
    if (remaining === 1) {
      replayedInitKeyCounts.delete(key);
    } else {
      replayedInitKeyCounts.set(key, remaining - 1);
    }
    return true;
  };

  const handleSessionMessage = (message: WorkspaceChatMessage) => {
    if (isReplaying && isReplayBufferedSessionMessage(message)) {
      if (!isReplayMessage(message)) {
        // Preserve live ordering during replay buffering. Init events need the same isolation as
        // stream events so reconnect replay cannot blank the row or drop lines due to reordering.
        bufferedLiveSessionMessages.push(message);
        return;
      }

      // Track replayed deltas/init events so buffered live events from the same window do not
      // double-apply after `caught-up`.
      if (isReplayBufferedDeltaMessage(message)) {
        noteReplayedDelta(message);
      } else if (isReplayBufferedInitMessage(message)) {
        noteReplayedInit(message);
      }
    }

    push(message);
  };

  const finishReplay = () => {
    // Flush buffered live session messages after replay (`caught-up` already queued by replayHistory).
    for (const message of bufferedLiveSessionMessages) {
      if (isReplayBufferedDeltaMessage(message) && shouldDropBufferedDelta(message)) {
        continue;
      }
      if (isReplayBufferedInitMessage(message) && shouldDropBufferedInit(message)) {
        continue;
      }
      push(message);
    }

    isReplaying = false;

    // Avoid retaining replay keys for the lifetime of the subscription.
    replayedDeltaKeyCounts.clear();
    replayedInitKeyCounts.clear();
    bufferedLiveSessionMessages.length = 0;
  };

  return { handleSessionMessage, finishReplay };
}
