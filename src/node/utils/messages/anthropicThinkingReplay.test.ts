import { describe, expect, test } from "bun:test";

import { laterAnthropicThinkingReplayPoint } from "./anthropicThinkingReplay";

describe("laterAnthropicThinkingReplayPoint", () => {
  test("a second strip moves the point forward, never back", () => {
    expect(laterAnthropicThinkingReplayPoint(undefined, 2)).toBe(2);
    expect(laterAnthropicThinkingReplayPoint(1, 3)).toBe(3);
    // A repair at an earlier step (a retry of a preserved step) cannot put blocks back.
    expect(laterAnthropicThinkingReplayPoint(3, 1)).toBe(3);
  });

  test("server-tool containment wins over every step point", () => {
    expect(laterAnthropicThinkingReplayPoint(4, "end")).toBe("end");
    expect(laterAnthropicThinkingReplayPoint("end", 7)).toBe("end");
  });
});
