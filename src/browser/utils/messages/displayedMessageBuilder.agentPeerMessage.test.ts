import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

// Peer payloads are assistant-role synthetic pre-turn rows (peer bytes never gain user-role
// authority), so the card metadata attaches to assistant text rows.
function buildAssistantRow(muxMetadata: MuxMessageMetadata) {
  const message = createMuxMessage(
    "peer-1",
    "assistant",
    "<mux_agent_message>…</mux_agent_message>",
    {
      historySequence: 1,
      synthetic: true,
      uiVisible: true,
      muxMetadata,
    }
  );
  const displayed = buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  expect(displayed).toHaveLength(1);
  const row = displayed[0];
  if (row?.type !== "assistant") throw new Error(`expected assistant row, got ${row?.type}`);
  return row;
}

describe("buildDisplayedMessagesForMessage agent peer message metadata", () => {
  test("surfaces well-formed peer metadata for the attributed card", () => {
    const row = buildAssistantRow({
      type: "agent-peer-message",
      fromWorkspaceId: "task-watcher",
      fromTitle: "Watcher",
      relationship: "sibling",
    });
    expect(row.agentPeerMessage).toEqual({
      fromWorkspaceId: "task-watcher",
      fromTitle: "Watcher",
      relationship: "sibling",
    });
  });

  test("tolerates a missing title", () => {
    const row = buildAssistantRow({
      type: "agent-peer-message",
      fromWorkspaceId: "task-watcher",
      relationship: "descendant",
    } as unknown as MuxMessageMetadata);
    expect(row.agentPeerMessage).toEqual({
      fromWorkspaceId: "task-watcher",
      relationship: "descendant",
    });
  });

  // muxMetadata is z.any() across the oRPC boundary, so corrupted chat.jsonl lines can carry
  // the peer type with malformed fields (e.g. an object fromTitle rendered as a React child
  // would throw). The builder must fall back to plain text rendering instead of crashing.
  test.each([
    ["missing sender", { type: "agent-peer-message", relationship: "sibling" }],
    [
      "non-string sender",
      { type: "agent-peer-message", fromWorkspaceId: 42, relationship: "sibling" },
    ],
    [
      "object-valued title",
      {
        type: "agent-peer-message",
        fromWorkspaceId: "task-watcher",
        fromTitle: { evil: true },
        relationship: "sibling",
      },
    ],
    [
      "unknown relationship",
      { type: "agent-peer-message", fromWorkspaceId: "task-watcher", relationship: "parent" },
    ],
  ])("falls back to plain text rendering for %s", (_label, malformed) => {
    const row = buildAssistantRow(malformed as unknown as MuxMessageMetadata);
    expect(row.agentPeerMessage).toBeUndefined();
    expect(row.content).toBe("<mux_agent_message>…</mux_agent_message>");
  });
});
