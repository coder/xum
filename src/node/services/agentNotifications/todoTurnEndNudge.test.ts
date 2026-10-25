import { describe, expect, test } from "bun:test";
import { resumedStreamStartedByUserMessage, streamStartedByUserMessage } from "./todoTurnEndNudge";

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

describe("resumedStreamStartedByUserMessage", () => {
  test.each([
    // An automatic resume that is not a retry is a machine wake (a sub-agent report drain).
    { automatic: true, retry: false, previous: true, expected: false },
    // An automatic retry continues the current turn.
    { automatic: true, retry: true, previous: true, expected: true },
    { automatic: true, retry: true, previous: false, expected: false },
    // A manual resume (Retry, an answered question) continues the current turn.
    { automatic: false, retry: false, previous: true, expected: true },
    { automatic: false, retry: false, previous: false, expected: false },
  ])("automatic=$automatic retry=$retry previous=$previous -> $expected", (row) => {
    expect(
      resumedStreamStartedByUserMessage({
        previous: row.previous,
        automatic: row.automatic,
        retry: row.retry,
      })
    ).toBe(row.expected);
  });
});
