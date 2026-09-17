import { describe, expect, test } from "bun:test";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import {
  computeHistoryRangeFingerprint,
  computePriorHistoryFingerprint,
} from "./onChatCursorFingerprint";

function withHistoryMetadata(
  message: MuxMessage,
  historySequence: number,
  timestamp: number
): MuxMessage {
  return {
    ...message,
    metadata: {
      ...message.metadata,
      historySequence,
      timestamp,
    },
  };
}

describe("computePriorHistoryFingerprint", () => {
  test("returns undefined when no rows exist below the anchor", () => {
    const anchorOnly = withHistoryMetadata(
      createMuxMessage("msg-anchor", "assistant", "anchor"),
      1,
      1_000
    );

    expect(computePriorHistoryFingerprint([anchorOnly], 1)).toBeUndefined();
  });

  test("changes when a lower-sequence row is rewritten with new content", () => {
    const originalRow = withHistoryMetadata(
      createMuxMessage("msg-rewritten", "assistant", "original"),
      1,
      1_001
    );
    const anchorRow = withHistoryMetadata(
      createMuxMessage("msg-anchor", "assistant", "anchor"),
      2,
      1_002
    );

    const originalFingerprint = computePriorHistoryFingerprint([originalRow, anchorRow], 2);

    const rewrittenRow = withHistoryMetadata(
      createMuxMessage("msg-rewritten", "assistant", "rewritten"),
      1,
      1_001
    );
    const rewrittenFingerprint = computePriorHistoryFingerprint([rewrittenRow, anchorRow], 2);

    expect(originalFingerprint).toBeDefined();
    expect(rewrittenFingerprint).toBeDefined();
    expect(rewrittenFingerprint).not.toBe(originalFingerprint);
  });
});

describe("computeHistoryRangeFingerprint", () => {
  const row = (id: string, seq: number, text: string, timestamp = 1_000 + seq) =>
    createMuxMessage(id, seq % 2 === 0 ? "user" : "assistant", text, {
      historySequence: seq,
      timestamp,
    });
  const rows = [
    row("r0", 0, "zero"),
    row("r1", 1, "one"),
    row("r2", 2, "two"),
    row("r3", 3, "three"),
  ];

  test("covers exactly the inclusive range and reports its row count", () => {
    const range = computeHistoryRangeFingerprint(rows, 1, 2);
    expect(range.rowCount).toBe(2);
    expect(computeHistoryRangeFingerprint([rows[1], rows[2]], 1, 2)).toEqual(range);
    // Rows outside the range do not contribute.
    expect(computeHistoryRangeFingerprint([rows[0], rows[1], rows[2]], 1, 2)).toEqual(range);
  });

  test("changes when any covered row's parts, role or id changes", () => {
    const base = computeHistoryRangeFingerprint(rows, 1, 3).fingerprint;
    const variants = [
      [rows[0], row("r1", 1, "ONE"), rows[2], rows[3]],
      [
        rows[0],
        createMuxMessage("r1", "user", "one", { historySequence: 1, timestamp: 1_001 }),
        rows[2],
        rows[3],
      ],
      [rows[0], row("other", 1, "one"), rows[2], rows[3]],
    ];
    for (const variant of variants) {
      expect(computeHistoryRangeFingerprint(variant, 1, 3).fingerprint).not.toBe(base);
    }
    // ...but not when a row outside the range changes.
    expect(
      computeHistoryRangeFingerprint([row("r0", 0, "changed"), ...rows.slice(1)], 1, 3).fingerprint
    ).toBe(base);
  });

  test("is insensitive to what differs between a client-assembled row and its persisted form", () => {
    // Verified over real IPC: the client keeps per-part timestamps and a stream-derived row
    // timestamp, and serializes tool-part keys in a different order.
    const persisted = createMuxMessage(
      "a1",
      "assistant",
      "",
      { historySequence: 1, timestamp: 10 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "file_read",
          input: { filePath: "README.md" },
          state: "output-available",
          output: { content: "hello" },
        },
        { type: "text", text: "done" },
      ]
    );
    const assembled = createMuxMessage(
      "a1",
      "assistant",
      "",
      { historySequence: 1, timestamp: 99 },
      [
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "file_read",
          state: "output-available",
          input: { filePath: "README.md" },
          timestamp: 12,
          output: { content: "hello" },
        },
        { type: "text", text: "done", timestamp: 13 },
      ]
    );
    expect(computeHistoryRangeFingerprint([assembled], 1, 1)).toEqual(
      computeHistoryRangeFingerprint([persisted], 1, 1)
    );
    // Content changes inside a tool part still change the hash.
    const toolPart = assembled.parts[0];
    if (toolPart.type !== "dynamic-tool" || toolPart.state !== "output-available") {
      throw new Error("fixture must start with a settled tool part");
    }
    const changedPart: MuxMessage["parts"][number] = {
      ...toolPart,
      output: { content: "changed" },
    };
    const changedOutput = createMuxMessage("a1", "assistant", "", { historySequence: 1 }, [
      changedPart,
      assembled.parts[1],
    ]);
    expect(computeHistoryRangeFingerprint([changedOutput], 1, 1).fingerprint).not.toBe(
      computeHistoryRangeFingerprint([persisted], 1, 1).fingerprint
    );
  });

  test("a missing middle row changes the count and the hash", () => {
    const full = computeHistoryRangeFingerprint(rows, 0, 3);
    const gap = computeHistoryRangeFingerprint([rows[0], rows[1], rows[3]], 0, 3);
    expect(gap.rowCount).toBe(full.rowCount - 1);
    expect(gap.fingerprint).not.toBe(full.fingerprint);
  });

  test("fences unsettled assistant rows by identity only", () => {
    const placeholder = createMuxMessage("a1", "assistant", "", { historySequence: 1 });
    const streamed = createMuxMessage("a1", "assistant", "streamed text", {
      historySequence: 1,
      partial: true,
    });
    const committedPartial = createMuxMessage("a1", "assistant", "other streamed text", {
      historySequence: 1,
      partial: true,
    });
    expect(computeHistoryRangeFingerprint([streamed], 1, 1)).toEqual(
      computeHistoryRangeFingerprint([placeholder], 1, 1)
    );
    expect(computeHistoryRangeFingerprint([committedPartial], 1, 1)).toEqual(
      computeHistoryRangeFingerprint([placeholder], 1, 1)
    );
    // Identity still counts: a different id or sequence at that position is a conflict…
    expect(
      computeHistoryRangeFingerprint(
        [createMuxMessage("a9", "assistant", "", { historySequence: 1 })],
        1,
        1
      ).fingerprint
    ).not.toBe(computeHistoryRangeFingerprint([placeholder], 1, 1).fingerprint);
    // …and so is a row the server completed while the client still holds the partial.
    const completed = createMuxMessage("a1", "assistant", "streamed text", { historySequence: 1 });
    expect(computeHistoryRangeFingerprint([completed], 1, 1).fingerprint).not.toBe(
      computeHistoryRangeFingerprint([streamed], 1, 1).fingerprint
    );
  });

  test("ignores rows without a historySequence and rejects an inverted range", () => {
    const withUncommitted = [...rows, createMuxMessage("streaming", "assistant", "…")];
    expect(computeHistoryRangeFingerprint(withUncommitted, 0, 3)).toEqual(
      computeHistoryRangeFingerprint(rows, 0, 3)
    );
    expect(() => computeHistoryRangeFingerprint(rows, 2, 1)).toThrow();
  });
});
