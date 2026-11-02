import { describe, expect, test } from "bun:test";
import { resumedStreamStartedByUserMessage, streamStartedByUserMessage } from "./todoTurnEndNudge";

describe("streamStartedByUserMessage", () => {
  test.each([
    // Only a manual send that is not synthetic is a message the user sent.
    { automatic: false, synthetic: false, expected: true },
    // A machine wake, a goal continuation, a compaction request or follow-up.
    { automatic: true, synthetic: true, expected: false },
    // An automatic send that stays visible (a task brief, a delegated workspace turn).
    { automatic: true, synthetic: false, expected: false },
    { automatic: false, synthetic: true, expected: false },
  ])("automatic=$automatic synthetic=$synthetic -> $expected", (row) => {
    expect(streamStartedByUserMessage({ automatic: row.automatic, synthetic: row.synthetic })).toBe(
      row.expected
    );
  });
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
