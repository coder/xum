import { describe, expect, mock, test } from "bun:test";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { StreamTranslator } from "@/node/acp/streamTranslator";
import { createMuxMessage } from "@/common/types/message";
import type { WorkspaceChatMessage } from "@/common/orpc/types";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type { PlanReviewRecord } from "@/common/utils/planReview/planReviewRecord";

async function replayThrough(events: WorkspaceChatMessage[]): Promise<unknown[]> {
  const sessionUpdate = mock(() => Promise.resolve(undefined));
  const translator = new StreamTranslator({ sessionUpdate } as unknown as AgentSideConnection);
  async function* stream(): AsyncIterable<WorkspaceChatMessage> {
    for (const event of events) yield await Promise.resolve(event);
  }
  await translator.consumeAndForward("session", stream());
  return sessionUpdate.mock.calls.map((call) => (call as unknown[])[0]);
}

describe("StreamTranslator MCP prompt replay", () => {
  test("replays the authored slash command instead of the transformed prompt text", async () => {
    const userMessage = createMuxMessage("user-1", "user", "Using MCP prompt coder/review: src", {
      muxMetadata: {
        type: "normal",
        rawCommand: "/mcp__coder__review src",
        commandPrefix: "/mcp__coder__review",
        mcpPromptRefs: [
          {
            serverName: "coder",
            promptName: "review",
            commandKey: "mcp__coder__review",
            source: "slash",
            arguments: { path: "src" },
          },
        ],
      },
    });

    const updates = await replayThrough([{ ...userMessage, type: "message" }]);

    expect(updates).toEqual([
      {
        sessionId: "session",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "/mcp__coder__review src" },
        },
      },
    ]);
  });

  test("suppresses synthetic MCP prompt snapshot rows", async () => {
    const snapshotMessage = createMuxMessage("mcp-prompt-snapshot-1", "user", "Expanded prompt", {
      synthetic: true,
      mcpPromptSnapshot: {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
      },
    });

    const updates = await replayThrough([{ ...snapshotMessage, type: "message" }]);

    expect(updates).toEqual([]);
  });
});

describe("StreamTranslator plan-review record replay", () => {
  function recordEvent(record: PlanReviewRecord, replay?: true): WorkspaceChatMessage {
    const message = createMuxMessage(
      `row-${record.recordId}`,
      "user",
      formatPlanReviewEnvelope(record),
      {
        ...(record.kind === "feedback" ? {} : { synthetic: true }),
        muxMetadata: buildPlanReviewMetadata(record),
      }
    );
    return { ...message, type: "message", ...(replay ? { replay } : {}) };
  }

  const snapshot: PlanReviewRecord = {
    v: 1,
    kind: "snapshot",
    recordId: "rec_snap",
    snapshotId: "snap_1",
    planPath: "/plans/p.md",
    contentHash: "a".repeat(64),
    content: "# Secret plan\n\nStep one\n",
  };
  const feedback: PlanReviewRecord = {
    v: 1,
    kind: "feedback",
    recordId: "rec_fb",
    feedbackId: "fb_1",
    snapshotId: "snap_1",
    contentHash: "a".repeat(64),
    comments: [
      { threadId: "thr_1", anchor: { startLine: 3, endLine: 3 }, quote: "Step one", body: "Why?" },
    ],
    replies: [],
  };
  const hiddenKinds: PlanReviewRecord[] = [
    snapshot,
    { v: 1, kind: "resolve", recordId: "rec_res", threadId: "thr_1" },
    { v: 1, kind: "reopen", recordId: "rec_reo", threadId: "thr_1" },
  ];

  test("full-history replay forwards only user-visible rows, never hidden state records", async () => {
    const visible = createMuxMessage("user-1", "user", "please plan");
    const updates = await replayThrough([
      { ...visible, type: "message" },
      ...hiddenKinds.map((record) => recordEvent(record)),
      recordEvent(feedback),
    ]);

    const texts = updates.map(
      (update) => (update as { update: { content: { text: string } } }).update.content.text
    );
    expect(texts).toEqual(["please plan", formatPlanReviewEnvelope(feedback)]);
  });

  test("reconnect replay rows flagged `replay` stay suppressed after caught-up", async () => {
    const caughtUp: WorkspaceChatMessage = { type: "caught-up", historyReplayStatus: "complete" };
    const updates = await replayThrough([
      caughtUp,
      ...hiddenKinds.map((record) => recordEvent(record, true)),
    ]);
    expect(updates).toEqual([]);
  });
});
