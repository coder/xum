import { describe, expect, test } from "bun:test";
import { streamStartedByUserMessage } from "./todoTurnEndNudge";

describe("streamStartedByUserMessage", () => {
  test.each([
    // A message the user sent starts a user turn, whatever came before.
    { synthetic: false, continuesCompaction: false, previous: false, expected: true },
    // A manual /compact is a user turn too.
    { synthetic: false, continuesCompaction: true, previous: false, expected: true },
    // A machine wake starts a machine turn, even right after a user turn.
    { synthetic: true, continuesCompaction: false, previous: true, expected: false },
    // A compaction request or its follow-up continues the turn that asked for it.
    { synthetic: true, continuesCompaction: true, previous: true, expected: true },
    { synthetic: true, continuesCompaction: true, previous: false, expected: false },
  ])(
    "synthetic=$synthetic continuesCompaction=$continuesCompaction previous=$previous -> $expected",
    (row) => {
      expect(
        streamStartedByUserMessage({
          previous: row.previous,
          synthetic: row.synthetic,
          continuesCompaction: row.continuesCompaction,
        })
      ).toBe(row.expected);
    }
  );
});
