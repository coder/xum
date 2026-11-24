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

describe("StreamTranslator held inputs (#4944)", () => {
  type HeldInput = Extract<
    WorkspaceChatMessage,
    { type: "held-inputs-changed" }
  >["heldInputs"][number];

  function held(id: string, displayText: string, extra: Partial<HeldInput> = {}): HeldInput {
    return { id, reason: "interrupted", displayText, attachmentCount: 0, reviewCount: 0, ...extra };
  }

  function heldChanged(...heldInputs: HeldInput[]): WorkspaceChatMessage {
    return { type: "held-inputs-changed", workspaceId: "ws", heldInputs };
  }

  async function translate(events: WorkspaceChatMessage[]) {
    const sessionUpdate = mock(() => Promise.resolve(undefined));
    const translator = new StreamTranslator({ sessionUpdate } as unknown as AgentSideConnection);
    async function* stream(): AsyncIterable<WorkspaceChatMessage> {
      for (const event of events) yield await Promise.resolve(event);
    }
    await translator.consumeAndForward("session", stream());
    const notices = sessionUpdate.mock.calls.map((call) => {
      const { update } = (call as unknown[])[0] as {
        update: { sessionUpdate: string; content: { text: string } };
      };
      expect(update.sessionUpdate).toBe("agent_message_chunk");
      return update.content.text;
    });
    return { translator, notices };
  }

  test("announces new held inputs once, numbered, with their full text", async () => {
    const one = held("h1", "first message");
    const two = held("h2", "line one\nline two");
    const three = held("h3", "", { attachmentCount: 2, reviewCount: 1 });
    const { notices } = await translate([
      heldChanged(),
      heldChanged(one, two),
      // The backend re-sends the full list on every change and subscription: a replay, a
      // removal and an empty list announce nothing.
      heldChanged(one, two),
      heldChanged(two),
      heldChanged(two, three),
      heldChanged(),
    ]);

    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("1. first message");
    expect(notices[0]).toContain("2. line one\n   line two");
    // A later new input re-lists everything still held; attachment-only input stays visible.
    expect(notices[1]).not.toContain("first message");
    expect(notices[1]).toContain("1. line one");
    expect(notices[1]).toMatch(/2\. .*2 attachments.*1 review/);
  });

  test("a notice the client never received is announced again on the replay", async () => {
    const sessionUpdate = mock(() => Promise.resolve(undefined));
    sessionUpdate.mockImplementationOnce(() => Promise.reject(new Error("stdout closed")));
    const translator = new StreamTranslator({ sessionUpdate } as unknown as AgentSideConnection);
    async function* stream(): AsyncIterable<WorkspaceChatMessage> {
      yield await Promise.resolve(heldChanged(held("h1", "keep me")));
    }
    const failure: unknown = await translator
      .consumeAndForward("session", stream())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // The resubscription replays the same held list.
    await translator.consumeAndForward("session", stream());
    expect(sessionUpdate).toHaveBeenCalledTimes(2);
  });

  test("restore-to-input defers to held inputs, and shows its text when nothing holds it", async () => {
    const { notices } = await translate([
      { type: "restore-to-input", workspaceId: "ws", text: "kept text", heldInputIds: ["h1"] },
      heldChanged(held("h1", "kept text")),
      { type: "restore-to-input", workspaceId: "ws", text: "only copy" },
      { type: "restore-to-input", workspaceId: "ws", text: "" },
    ]);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("1. kept text");
    expect(notices[1]).toContain("only copy");
  });

  test("numbers resolve against the last notice; gone, unknown or ambiguous are refused", async () => {
    const { translator } = await translate([
      heldChanged(held("h1", "one"), held("h2", "two"), held("h3", "three")),
      heldChanged(held("h1", "one"), held("h3", "three")),
    ]);
    const resolve = (number?: number) => translator.resolveHeldInput("session", number);
    // Number 3 still means "three" after h2 left: no renumbering without a new notice.
    expect(resolve(3)).toMatchObject({ kind: "found", heldInput: { id: "h3" } });
    expect(resolve(2).kind).toBe("refused");
    expect(resolve(4).kind).toBe("refused");
    expect(resolve().kind).toBe("refused");

    const single = await translate([
      heldChanged(held("h1", "a"), held("h2", "b")),
      heldChanged(held("h2", "b")),
    ]);
    expect(single.translator.resolveHeldInput("session", undefined)).toMatchObject({
      number: 2,
      heldInput: { id: "h2" },
    });
    const empty = await translate([heldChanged(held("h1", "a")), heldChanged()]);
    expect(empty.translator.resolveHeldInput("session", 1).kind).toBe("refused");

    // A clean resubscription replays nothing once the list is empty (the backend replays only a
    // non-empty list), so inputs removed during the gap must not stay resolvable.
    const gap = await translate([heldChanged(held("h1", "a"))]);
    const noEvents: WorkspaceChatMessage[] = [];
    await gap.translator.consumeAndForward(
      "session",
      (async function* () {
        for (const event of noEvents) yield await Promise.resolve(event);
      })()
    );
    expect(gap.translator.resolveHeldInput("session", 1).kind).toBe("refused");
  });
});
