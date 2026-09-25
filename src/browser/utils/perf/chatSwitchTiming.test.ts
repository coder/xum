import { afterEach, describe, expect, test } from "bun:test";
import {
  CHAT_SWITCH_MARK_PREFIX,
  markChatSwitchMilestone,
  markChatSwitchStart,
} from "./chatSwitchTiming";

/** Sorted by name: every measure shares the start mark, so buffer order is unspecified. */
function recordedMeasures(): Array<{ name: string; workspaceId: string | undefined }> {
  return performance
    .getEntriesByType("measure")
    .filter((entry) => entry.name.startsWith(CHAT_SWITCH_MARK_PREFIX))
    .map((entry) => ({
      name: entry.name.slice(CHAT_SWITCH_MARK_PREFIX.length),
      workspaceId: ((entry as PerformanceMeasure).detail as { workspaceId?: string } | null)
        ?.workspaceId,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe("chat switch timing", () => {
  afterEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  test("records each milestone once, only for the workspace the latest switch targeted", () => {
    markChatSwitchStart("ws-a");
    markChatSwitchStart("ws-b");
    // A late caught-up for the chat the user just left must not time the new switch.
    markChatSwitchMilestone("ws-a", "caught-up");
    // Hidden before shown is an unmount from an earlier switch, not this one.
    markChatSwitchMilestone("ws-b", "skeleton-hidden");
    expect(recordedMeasures()).toEqual([]);
    markChatSwitchMilestone("ws-b", "skeleton-shown");
    markChatSwitchMilestone("ws-b", "skeleton-shown");
    markChatSwitchMilestone("ws-b", "skeleton-hidden");
    markChatSwitchMilestone("ws-b", "caught-up");

    expect(recordedMeasures()).toEqual([
      { name: "caught-up", workspaceId: "ws-b" },
      { name: "skeleton-hidden", workspaceId: "ws-b" },
      { name: "skeleton-shown", workspaceId: "ws-b" },
    ]);
  });

  test("a new switch drops the previous switch's measures", () => {
    markChatSwitchStart("ws-a");
    markChatSwitchMilestone("ws-a", "first-row");
    markChatSwitchStart("ws-b");
    markChatSwitchMilestone("ws-b", "first-row");

    expect(recordedMeasures()).toEqual([{ name: "first-row", workspaceId: "ws-b" }]);
  });
});
