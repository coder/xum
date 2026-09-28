import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { formatAgentMessageEnvelope } from "@/common/utils/agentMessageEnvelope";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

// A peer message is persisted as two rows: the assistant payload (the agent-message card) and a
// fixed user-role trigger that wakes the recipient. The transcript folds the trigger into the card.
const SENDER = "ws-sender";

function payloadRow(id: string, historySequence: number, fromWorkspaceId = SENDER) {
  return createMuxMessage(
    id,
    "assistant",
    formatAgentMessageEnvelope({
      from: fromWorkspaceId,
      relationship: "unrelated",
      message: "hello",
    }),
    {
      historySequence,
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "agent-peer-message", fromWorkspaceId, relationship: "unrelated" },
    }
  );
}

function triggerRow(id: string, historySequence: number, muxMetadata: MuxMessageMetadata) {
  return createMuxMessage(id, "user", "Peer agent sent an agent message…", {
    historySequence,
    synthetic: true,
    uiVisible: true,
    muxMetadata,
  });
}

function peerTrigger(payloadMessageId?: string): MuxMessageMetadata {
  return {
    type: "agent-peer-message",
    fromWorkspaceId: SENDER,
    relationship: "unrelated",
    ...(payloadMessageId != null ? { payloadMessageId } : {}),
  };
}

function displayedIds(
  messages: Parameters<StreamingMessageAggregator["loadHistoricalMessages"]>[0]
) {
  const aggregator = new StreamingMessageAggregator("2024-01-01T00:00:00.000Z");
  aggregator.loadHistoricalMessages(messages);
  return aggregator
    .getDisplayedMessages()
    .flatMap((message) => ("historyId" in message ? [message.historyId] : []));
}

describe("StreamingMessageAggregator agent peer message folding", () => {
  test("hides the trigger once its payload card is shown", () => {
    // A streaming reply can land between payload and trigger; pairing is by ID, not adjacency.
    const reply = createMuxMessage("reply", "assistant", "working", { historySequence: 2 });
    expect(
      displayedIds([
        payloadRow("payload", 1),
        reply,
        triggerRow("trigger", 3, peerTrigger("payload")),
      ])
    ).toEqual(["payload", "reply"]);
  });

  test("folds a trigger that carries a delegated workspace-turn correlation", () => {
    const correlated: MuxMessageMetadata = {
      type: "workspace-turn-task",
      taskHandleId: "wst_1",
      ownerWorkspaceId: "owner",
      turnId: "turn-1",
      agentPeerMessageTrigger: {
        fromWorkspaceId: SENDER,
        relationship: "unrelated",
        payloadMessageId: "payload",
      },
    };
    expect(displayedIds([payloadRow("payload", 1), triggerRow("trigger", 2, correlated)])).toEqual([
      "payload",
    ]);
  });

  test("keeps the trigger row when it cannot be paired with a shown payload", () => {
    // Older history has no pairing ID.
    expect(
      displayedIds([payloadRow("payload", 1), triggerRow("trigger", 2, peerTrigger())])
    ).toEqual(["payload", "trigger"]);
    // The payload is gone (e.g. dropped before a context boundary).
    expect(displayedIds([triggerRow("trigger", 2, peerTrigger("payload"))])).toEqual(["trigger"]);
    // The named row belongs to a different sender.
    expect(
      displayedIds([
        payloadRow("payload", 1, "ws-other"),
        triggerRow("trigger", 2, peerTrigger("payload")),
      ])
    ).toEqual(["payload", "trigger"]);
    // A human (non-synthetic) row wearing trigger metadata is never hidden.
    const human = createMuxMessage("human", "user", "please review", {
      historySequence: 2,
      muxMetadata: peerTrigger("payload"),
    });
    expect(displayedIds([payloadRow("payload", 1), human])).toEqual(["payload", "human"]);
  });
});
