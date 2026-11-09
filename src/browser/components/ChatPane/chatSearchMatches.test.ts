import { describe, expect, it } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "@/browser/utils/messages/StreamingMessageAggregator";
import { createContextBudgetRejectedMessage } from "@/common/utils/messages/contextBudgetRejection";
import { findChatSearchMatches } from "./chatSearchMatches";

describe("findChatSearchMatches", () => {
  it("matches literal punctuation without case sensitivity and preserves history order", () => {
    const messages = [
      createMuxMessage("first", "user", "Find [API]."),
      createMuxMessage("other", "assistant", "The API is ready."),
      createMuxMessage("last", "assistant", "The [api] works. [API] is ready."),
    ];
    const matches = findChatSearchMatches(messages, "[api]");
    expect(matches.map((match) => match.messageId)).toEqual(["first", "last"]);
    expect(matches[0].match).toBe("[API]");
    expect(matches[1].match).toBe("[api]");
  });

  it("ignores empty queries, tool payloads, reasoning, and hidden model context", () => {
    const messages: MuxMessage[] = [
      createMuxMessage("hidden", "user", "needle", { synthetic: true }),
      createMuxMessage("visible", "user", "needle", { synthetic: true, uiVisible: true }),
      {
        id: "internal",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "needle" },
          {
            type: "dynamic-tool",
            toolCallId: "call",
            toolName: "bash",
            state: "input-available",
            input: { script: "needle" },
          },
        ],
      },
    ];
    expect(findChatSearchMatches(messages, "")).toEqual([]);
    expect(findChatSearchMatches(messages, "   ")).toEqual([]);
    expect(findChatSearchMatches(messages, "needle").map((match) => match.messageId)).toEqual([
      "visible",
    ]);
  });

  it("searches replies that the display cap hides", () => {
    const aggregator = new StreamingMessageAggregator("search-test");
    for (let index = 0; index < 100; index++) {
      aggregator.addMessage(
        createMuxMessage(
          `message-${index}`,
          index % 2 === 0 ? "user" : "assistant",
          index === 1 ? "The original needle reply." : `Message ${index}`,
          { historySequence: index }
        )
      );
    }
    expect(
      aggregator.getDisplayedMessages().some((message) => message.type === "history-hidden")
    ).toBe(true);
    expect(
      aggregator
        .getDisplayedMessages()
        .some((message) => message.type === "assistant" && message.historyId === "message-1")
    ).toBe(false);
    expect(
      findChatSearchMatches(aggregator.getAllMessages(), "needle").map((match) => match.messageId)
    ).toEqual(["message-1"]);
  });

  it("searches rejected requests using their restored display text", () => {
    const rejected = createContextBudgetRejectedMessage(
      createMuxMessage("rejected", "user", "Rejected needle request")
    );
    expect(findChatSearchMatches([rejected], "needle").map((match) => match.messageId)).toEqual([
      "rejected",
    ]);
  });

  it("searches typed commands instead of model-facing expansions", () => {
    const command = createMuxMessage("command", "user", "Expanded instructions for the model", {
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill",
        skillName: "test-skill",
        scope: "project",
      },
    });
    expect(findChatSearchMatches([command], "/test-skill").map((match) => match.messageId)).toEqual(
      ["command"]
    );
    expect(findChatSearchMatches([command], "Expanded instructions")).toEqual([]);
  });

  it("does not return peer triggers that fold into payload cards", () => {
    const trigger = createMuxMessage("trigger", "user", "Peer agent sent a needle message", {
      synthetic: true,
      uiVisible: true,
      muxMetadata: {
        type: "agent-peer-message",
        fromWorkspaceId: "sender",
        relationship: "unrelated",
        payloadMessageId: "payload",
      },
    });
    expect(findChatSearchMatches([trigger], "needle")).toEqual([]);
  });

  it("searches displayed summaries without their model-facing prefixes", () => {
    const summary = createMuxMessage("summary", "assistant", "Goal cleared: ship the search", {
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "goal-cleared-summary" },
    });
    expect(findChatSearchMatches([summary], "Goal cleared")).toEqual([]);
    expect(
      findChatSearchMatches([summary], "ship the search").map((match) => match.messageId)
    ).toEqual(["summary"]);
  });

  it("searches visible plan previews", () => {
    const plan = createMuxMessage("plan", "assistant", "Build the needle index", {
      synthetic: true,
      uiVisible: true,
      muxMetadata: { type: "plan-display", path: "/tmp/plan.md" },
    });
    expect(findChatSearchMatches([plan], "needle").map((match) => match.messageId)).toEqual([
      "plan",
    ]);
  });

  it("joins adjacent text parts within the same displayed row", () => {
    const message = createMuxMessage("parts", "assistant", "A nee", undefined, [
      { type: "text", text: "dle reply." },
    ]);
    expect(findChatSearchMatches([message], "needle").map((match) => match.messageId)).toEqual([
      "parts",
    ]);
  });

  it("targets the matching displayed row and keeps its preview on the matching line", () => {
    const message = createMuxMessage("parts", "assistant", "An unrelated opening.", undefined, [
      { type: "reasoning", text: "An intermediate step." },
      { type: "text", text: "A needle reply.\nAnother line." },
      { type: "text", text: "A later needle reply." },
    ]);
    const matches = findChatSearchMatches([message], "needle");
    expect(matches).toHaveLength(1);
    expect(matches[0].displayedMessageId).toBe("parts-2");
    expect(matches[0].match).toBe("needle");
    expect(matches[0].after).toBe(" reply.");
  });

  it("does not invent a text match across separate displayed rows", () => {
    const message = createMuxMessage("parts", "assistant", "nee", undefined, [
      { type: "reasoning", text: "An intermediate step." },
      { type: "text", text: "dle" },
    ]);
    expect(findChatSearchMatches([message], "needle")).toEqual([]);
  });
});
