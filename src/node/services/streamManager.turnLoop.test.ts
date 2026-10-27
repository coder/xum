import { describe, expect, test } from "bun:test";

import { createLiveStreamHarness } from "./streamManager.liveStream.testHarness";
import { installStreamManagerTestHistory } from "./streamManager.suite.testHarness";

import { isSuccessfulToolOutput } from "./streamManager";

installStreamManagerTestHistory();

describe("isSuccessfulToolOutput", () => {
  test.each<[string, unknown, boolean]>([
    ["a non-object", "done", false],
    ["null", null, false],
    ["an explicit success marker", { success: true }, true],
    ["a failed success marker, even with ok", { success: false, ok: true }, false],
    ["a success marker that is not true", { success: "yes" }, false],
    ["an ok marker", { ok: true }, true],
    ["a failed ok marker", { ok: false }, false],
    ["an error field", { error: "boom" }, false],
    ["an isError flag", { isError: true }, false],
    ["any other object", { value: 1 }, true],
  ])("%s", (_label, output, expected) => {
    expect(isSuccessfulToolOutput(output)).toBe(expected);
  });
});

describe("StreamManager stream completion", () => {
  test("a completed stream stops counting as streaming before its stream-end is emitted", async () => {
    // The stream is marked completed after its final commit and right before stream-end,
    // so stream-end listeners (compaction among them) no longer see it as streaming.
    const harness = createLiveStreamHarness();
    const workspaceId = "ws-complete-order";
    const streamingAtEnd: boolean[] = [];
    harness.streamManager.setEventSink((event) => {
      if (event.type === "stream-end") {
        streamingAtEnd.push(harness.streamManager.isStreaming(workspaceId));
      }
      harness.events.push(event);
    });
    const live = await harness.start({ workspaceId, messageId: "msg-1" });
    await live.push({ type: "text-delta", text: "done" });
    await live.finish();
    expect(streamingAtEnd).toEqual([false]);
  });
});
