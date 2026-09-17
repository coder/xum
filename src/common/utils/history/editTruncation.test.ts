import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";

import { getEditTruncateTargetFromMessages } from "./editTruncation";

const snapshot = (id: string) =>
  createMuxMessage(id, "user", "snapshot", {
    synthetic: true,
    fileAtMentionSnapshot: [],
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
