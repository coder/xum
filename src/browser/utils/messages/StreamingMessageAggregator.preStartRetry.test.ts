import { describe, expect, test } from "bun:test";

import { getInterruptionContext } from "@/common/utils/messages/retryEligibility";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const WORKSPACE_ID = "ws-1";
const MODEL = "anthropic:claude-sonnet-4-5";

function seedUserTurn(aggregator: StreamingMessageAggregator): void {
  aggregator.handleMessage({
    type: "message",
    id: "user-1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { historySequence: 1, timestamp: 100 },
  });
}

/** A failed attempt before any stream exists: the backend emits only a stream-error. */
function failPreStart(aggregator: StreamingMessageAggregator, messageId: string): void {
  aggregator.handleStreamError({
    type: "stream-error",
    messageId,
    error: "Remote workspace unreachable: ssh exited with code 255",
    errorType: "runtime_start_failed",
  });
}

function completeReply(
  aggregator: StreamingMessageAggregator,
  messageId: string,
  historySequence: number
): void {
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    historySequence,
    model: MODEL,
    startTime: 200,
  });
  aggregator.handleStreamDelta({
    type: "stream-delta",
    workspaceId: WORKSPACE_ID,
    messageId,
    delta: "ok",
    tokens: 1,
    timestamp: 210,
  });
  aggregator.handleStreamEnd({
    type: "stream-end",
    workspaceId: WORKSPACE_ID,
    messageId,
    metadata: { historySequence, timestamp: 220, model: MODEL },
    parts: [{ type: "text", text: "ok" }],
  });
}

function displayedTypes(aggregator: StreamingMessageAggregator): string[] {
  // Only the assistant-side rows matter here; the seeded user row is context.
  return aggregator
    .getDisplayedMessages()
    .map((message) => message.type)
    .filter((type) => type !== "user");
}

// #4832: pre-start error rows are live-only and never persisted, so each failed attempt gets a
// locally assigned sequence while the successful attempt's reply takes the first free server
// sequence. The reply must supersede those rows, exactly as a new user message already does.
describe("StreamingMessageAggregator pre-start errors followed by a successful retry", () => {
  test.each([1, 2, 3])(
    "%i failed attempt(s) then a successful retry leave no error or barrier",
    (failures) => {
      const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
      seedUserTurn(aggregator);
      for (let attempt = 1; attempt <= failures; attempt++) {
        failPreStart(aggregator, `assistant-failed-${attempt}`);
      }
      expect(displayedTypes(aggregator)).toContain("stream-error");

      // The failed attempts persisted nothing, so the reply lands right after the user row.
      completeReply(aggregator, "assistant-reply", 2);

      expect(displayedTypes(aggregator)).toEqual(["assistant"]);
      expect(getInterruptionContext(aggregator.getDisplayedMessages()).hasInterruptedStream).toBe(
        false
      );
    }
  );

  test("an error on the retried reply itself still shows", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    seedUserTurn(aggregator);
    failPreStart(aggregator, "assistant-failed-1");
    aggregator.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId: "assistant-reply",
      historySequence: 2,
      model: MODEL,
      startTime: 200,
    });
    aggregator.handleStreamError({
      type: "stream-error",
      messageId: "assistant-reply",
      error: "Provider overloaded",
      errorType: "server_error",
    });

    expect(displayedTypes(aggregator)).toEqual(["stream-error"]);
    expect(getInterruptionContext(aggregator.getDisplayedMessages()).hasInterruptedStream).toBe(
      true
    );
  });

  test("a pre-start failure after a successful reply still shows", () => {
    const aggregator = new StreamingMessageAggregator(TEST_CREATED_AT);
    seedUserTurn(aggregator);
    completeReply(aggregator, "assistant-reply", 2);
    failPreStart(aggregator, "assistant-failed-later");

    expect(displayedTypes(aggregator)).toEqual(["assistant", "stream-error"]);
    expect(getInterruptionContext(aggregator.getDisplayedMessages()).hasInterruptedStream).toBe(
      true
    );
  });
});
