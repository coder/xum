import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

import { buildHistoryEditPrecondition, getEditTruncateTargetFromMessages } from "./editTruncation";

const snapshot = (id: string) =>
  createMuxMessage(id, "user", "snapshot", {
    synthetic: true,
    fileAtMentionSnapshot: [],
  });

describe("buildHistoryEditPrecondition", () => {
  const committed = (id: string, seq: number) =>
    createMuxMessage(id, seq % 2 === 0 ? "user" : "assistant", `text ${seq}`, {
      historySequence: seq,
    });
  const rows = [committed("u0", 0), committed("a0", 1), committed("u1", 2), committed("a1", 3)];

  test("treats rows with a malformed historySequence like uncommitted rows", () => {
    const expected = buildHistoryEditPrecondition(rows, "u1");
    // Negative, fractional and NaN sequences pass the wire schema (any number) but are not
    // evidence; they neither move the newest row nor make the fingerprint throw.
    const polluted = [
      ...rows,
      createMuxMessage("neg", "assistant", "…", { historySequence: -4 }),
      createMuxMessage("frac", "assistant", "…", { historySequence: 3.5 }),
      createMuxMessage("nan", "assistant", "…", { historySequence: Number.NaN }),
      createMuxMessage("uncommitted", "assistant", "…"),
    ];
    expect(buildHistoryEditPrecondition(polluted, "u1")).toEqual(expected);
    expect(expected).toMatchObject({ newestMessageId: "a1", newestHistorySequence: 3 });
  });

  test("a malformed-sequence row still separates a snapshot from the edited row", () => {
    // Adjacency is decided over every row, as the backend's cut is: the snapshot is NOT part of
    // the edited turn here, so the range starts at the edited row on both sides.
    const separated = [
      committed("u0", 0),
      createMuxMessage("snap", "user", "snapshot", {
        historySequence: 1,
        synthetic: true,
        fileAtMentionSnapshot: [],
      }),
      createMuxMessage("junk", "assistant", "…", { historySequence: 1.5 }),
      committed("u1", 2),
      committed("a1", 3),
    ];
    expect(buildHistoryEditPrecondition(separated, "u1")).toMatchObject({
      rangeStartMessageId: "u1",
      rangeStartHistorySequence: 2,
      newestMessageId: "a1",
      rangeRowCount: 2,
    });
  });

  test("cannot fence when the range starts at a snapshot whose sequence is malformed", () => {
    const badSnapshotStart = [
      committed("u0", 0),
      createMuxMessage("snap", "user", "snapshot", {
        historySequence: -1,
        synthetic: true,
        fileAtMentionSnapshot: [],
      }),
      committed("u1", 2),
    ];
    expect(buildHistoryEditPrecondition(badSnapshotStart, "u1")).toBeUndefined();
  });

  test("cannot fence an edited row whose own sequence is malformed", () => {
    const rowsWithBadEdit = [
      committed("u0", 0),
      createMuxMessage("u1", "user", "edited", { historySequence: -1 }),
    ];
    expect(buildHistoryEditPrecondition(rowsWithBadEdit, "u1")).toBeUndefined();
  });
});

describe("getEditTruncateTargetFromMessages", () => {
  test("returns the edited row when nothing precedes it", () => {
    const rows = [createMuxMessage("u1", "user", "hi"), createMuxMessage("a1", "assistant", "yo")];
    expect(getEditTruncateTargetFromMessages(rows, "u1")).toBe("u1");
  });

  test("returns the first of the synthetic snapshot rows immediately preceding the edit", () => {
    const rows = [
      createMuxMessage("u0", "user", "earlier"),
      createMuxMessage("a0", "assistant", "answer"),
      snapshot("snap-1"),
      snapshot("snap-2"),
      createMuxMessage("u1", "user", "edited"),
    ];
    expect(getEditTruncateTargetFromMessages(rows, "u1")).toBe("snap-1");
  });

  test("stops at the first non-snapshot row", () => {
    const rows = [
      snapshot("snap-0"),
      createMuxMessage("a0", "assistant", "answer"),
      createMuxMessage("u1", "user", "edited"),
    ];
    expect(getEditTruncateTargetFromMessages(rows, "u1")).toBe("u1");
  });

  test("returns undefined for an unknown edit target", () => {
    expect(getEditTruncateTargetFromMessages([createMuxMessage("u1", "user", "x")], "ghost")).toBe(
      undefined
    );
  });
});
