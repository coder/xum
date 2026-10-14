import { describe, expect, test } from "bun:test";
import type { DisplayedMessage } from "@/common/types/message";
import {
  buildTranscriptTruncationPlan,
  MAX_HISTORY_HIDDEN_SEGMENTS,
} from "./transcriptTruncationPlan";

const ALWAYS_KEEP_MESSAGE_TYPES = new Set<DisplayedMessage["type"]>([
  "user",
  "stream-error",
  "compaction-boundary",
  "plan-display",
  "workspace-init",
]);

function user(id: string, sequence: number): DisplayedMessage {
  return {
    type: "user",
    id,
    historyId: `history-${id}`,
    content: id,
    historySequence: sequence,
  };
}

function assistant(id: string, sequence: number): DisplayedMessage {
  return {
    type: "assistant",
    id,
    historyId: `history-${id}`,
    content: id,
    historySequence: sequence,
    isStreaming: false,
    isPartial: false,
    isCompacted: false,
    isIdleCompacted: false,
  };
}

function tool(id: string, sequence: number): DisplayedMessage {
  return {
    type: "tool",
    id,
    historyId: `history-${id}`,
    toolCallId: `call-${id}`,
    toolName: "bash",
    args: { script: "echo hi", timeout_secs: 1, display_name: "test" },
    status: "completed",
    isPartial: false,
    historySequence: sequence,
  };
}

function reasoning(id: string, sequence: number): DisplayedMessage {
  return {
    type: "reasoning",
    id,
    historyId: `history-${id}`,
    content: id,
    historySequence: sequence,
    isStreaming: false,
    isPartial: false,
  };
}

function compactionBoundary(
  id: string,
  sequence: number,
  position: "start" | "end" = "start"
): DisplayedMessage {
  return {
    type: "compaction-boundary",
    id,
    historySequence: sequence,
    position,
  };
}

describe("buildTranscriptTruncationPlan", () => {
  test("places an omission marker directly before a kept non-user seam", () => {
    const displayedMessages: DisplayedMessage[] = [
      user("u0", 0),
      assistant("a0", 1),
      user("u1", 2),
      assistant("a1", 3),
      compactionBoundary("boundary-1", 4, "start"),
      user("u2", 5),
      assistant("a2", 6),
      user("u3", 7),
      assistant("a3", 8),
      user("u4", 9),
    ];

    const plan = buildTranscriptTruncationPlan({
      displayedMessages,
      maxDisplayedMessages: 4,
      alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
    });

    const markerIndices = plan.rows
      .map((message, index) => (message.type === "history-hidden" ? index : -1))
      .filter((index) => index !== -1);

    expect(markerIndices).toHaveLength(2);
    const secondMarkerIndex = markerIndices[1];
    expect(plan.rows[secondMarkerIndex + 1]?.type).toBe("compaction-boundary");
  });

  test("keeps a trailing omission marker at the old/recent seam when no later user exists", () => {
    const displayedMessages: DisplayedMessage[] = [
      user("u0", 0),
      assistant("a0", 1),
      user("u1", 2),
      assistant("a1", 3),
      assistant("a2", 4),
      tool("tool-1", 5),
      reasoning("reasoning-1", 6),
      assistant("a3", 7),
    ];

    const plan = buildTranscriptTruncationPlan({
      displayedMessages,
      maxDisplayedMessages: 4,
      alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
    });

    const markerIndices = plan.rows
      .map((message, index) => (message.type === "history-hidden" ? index : -1))
      .filter((index) => index !== -1);

    expect(markerIndices).toHaveLength(2);
    const trailingMarkerIndex = markerIndices[1];
    expect(plan.rows[trailingMarkerIndex + 1]?.id).toBe("a2");
  });

  test("caps omission markers by merging older runs", () => {
    const displayedMessages: DisplayedMessage[] = [];
    for (let i = 0; i < 20; i++) {
      displayedMessages.push(user(`u${i}`, i * 2));
      displayedMessages.push(assistant(`a${i}`, i * 2 + 1));
    }

    const plan = buildTranscriptTruncationPlan({
      displayedMessages,
      maxDisplayedMessages: 4,
      alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
      maxHiddenSegments: 3,
    });

    expect(MAX_HISTORY_HIDDEN_SEGMENTS).toBeGreaterThan(3);
    expect(plan.segments).toHaveLength(3);
    expect(plan.hiddenCount).toBe(18);
    expect(plan.segments.map((segment) => segment.hiddenCount)).toEqual([16, 1, 1]);

    const markerRows = plan.rows.filter(
      (message): message is Extract<DisplayedMessage, { type: "history-hidden" }> => {
        return message.type === "history-hidden";
      }
    );
    expect(markerRows).toHaveLength(3);
    expect(markerRows.map((row) => row.hiddenCount)).toEqual([16, 1, 1]);
  });
});

// Rows are memoized on prop identity (#4961 F20): a recompute that yields an equal marker must
// return the same object, and a marker whose counts change must be a new one, so it re-renders.
describe("buildTranscriptTruncationPlan marker reuse", () => {
  const markers = (displayedMessages: DisplayedMessage[]) =>
    buildTranscriptTruncationPlan({
      displayedMessages,
      maxDisplayedMessages: 2,
      alwaysKeepMessageTypes: ALWAYS_KEEP_MESSAGE_TYPES,
    }).rows.filter((row) => row.type === "history-hidden");

  test("returns the same marker objects when a recompute yields equal markers", () => {
    const rows = () => [user("u0", 0), assistant("a0", 1), user("u1", 2), assistant("a1", 3)];
    const before = markers([...rows(), assistant("tail-1", 4), assistant("tail-2", 5)]);
    const after = markers([...rows(), assistant("tail-1", 4), assistant("tail-2", 5)]);

    expect(before).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  test("returns a new marker when any of its counts change", () => {
    // Each pair differs in one field of the second marker: hiddenCount, tool, reasoning.
    const pairs: Array<[DisplayedMessage[], DisplayedMessage[]]> = [
      [[assistant("x1", 4)], [assistant("x1", 4), assistant("x2", 5)]],
      [
        [tool("x1", 4), assistant("x2", 5)],
        [tool("x1", 4), tool("x2", 5)],
      ],
      [
        [reasoning("x1", 4), assistant("x2", 5)],
        [reasoning("x1", 4), reasoning("x2", 5)],
      ],
    ];
    for (const [first, second] of pairs) {
      const head = [user("u0", 0), assistant("a0", 1), user("u1", 2)];
      const tail = [assistant("tail-1", 10), assistant("tail-2", 11)];
      const before = markers([...head, ...first, ...tail]);
      const after = markers([...head, ...second, ...tail]);
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[1]).not.toEqual(before[1]);
    }
  });
});
