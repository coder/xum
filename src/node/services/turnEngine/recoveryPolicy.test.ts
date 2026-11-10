import { describe, expect, test } from "bun:test";

import {
  MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS,
  recoveryPolicy,
  type AttemptHistory,
  type AttemptOutcome,
  type Decision,
} from "./recoveryPolicy";

type Finished = Extract<AttemptOutcome, { _tag: "Finished" }>;
type Errored = Extract<AttemptOutcome, { _tag: "Errored" }>;

function finished(overrides: Partial<Omit<Finished, "_tag">> = {}): Finished {
  return {
    _tag: "Finished",
    aborted: false,
    interruptPending: false,
    partCount: 2,
    terminal: true,
    refusal: null,
    ...overrides,
  };
}

function errored(overrides: Partial<Omit<Errored, "_tag">> = {}): Errored {
  return {
    _tag: "Errored",
    aborted: false,
    interruptPending: false,
    previousResponseIdRetryable: false,
    reasoningReplayRetryable: false,
    ...overrides,
  };
}

function history(overrides: Partial<AttemptHistory> = {}): AttemptHistory {
  return {
    emptyRetries: 0,
    retriedPreviousResponseId: false,
    retriedReasoningReplay: false,
    ...overrides,
  };
}

interface Case {
  name: string;
  outcome: AttemptOutcome;
  history?: AttemptHistory;
  expected: Decision;
}

const FINISHED_CASES: Case[] = [
  { name: "a clean finish completes", outcome: finished(), expected: { _tag: "Complete" } },
  {
    name: "abort beats refusal and empty output",
    outcome: finished({ aborted: true, refusal: "content-filter", partCount: 0 }),
    expected: { _tag: "Aborted" },
  },
  {
    name: "a refusal after output tries the fallback chain",
    outcome: finished({ refusal: "refusal" }),
    expected: { _tag: "Fallback", refusal: "refusal" },
  },
  {
    name: "a refusal beats the empty-output retry",
    outcome: finished({ refusal: "refusal", partCount: 0 }),
    expected: { _tag: "Fallback", refusal: "refusal" },
  },
  {
    // The fallback executor owns the interrupt check for refusals.
    name: "a refusal still goes to the fallback executor while an interrupt is pending",
    outcome: finished({ refusal: "refusal", interruptPending: true }),
    expected: { _tag: "Fallback", refusal: "refusal" },
  },
  {
    name: "the first empty output retries",
    outcome: finished({ partCount: 0 }),
    expected: { _tag: "Retry", change: "empty" },
  },
  {
    name: "empty output beats truncation",
    outcome: finished({ partCount: 0, terminal: false }),
    expected: { _tag: "Retry", change: "empty" },
  },
  {
    name: "the last allowed empty retry still retries",
    outcome: finished({ partCount: 0 }),
    history: history({ emptyRetries: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS - 1 }),
    expected: { _tag: "Retry", change: "empty" },
  },
  {
    name: "empty output fails once the retry budget is spent",
    outcome: finished({ partCount: 0 }),
    history: history({ emptyRetries: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS }),
    expected: { _tag: "Empty" },
  },
  {
    name: "a pending interrupt skips the empty-output retry",
    outcome: finished({ partCount: 0, interruptPending: true }),
    expected: { _tag: "Empty" },
  },
  {
    name: "output without a terminal event is truncated",
    outcome: finished({ terminal: false }),
    expected: { _tag: "Truncated" },
  },
  {
    name: "spent error retries do not affect a clean finish",
    outcome: finished(),
    history: history({ retriedPreviousResponseId: true, retriedReasoningReplay: true }),
    expected: { _tag: "Complete" },
  },
];

const ERRORED_CASES: Case[] = [
  {
    name: "an unrecoverable error fails",
    outcome: errored(),
    expected: { _tag: "Fail" },
  },
  {
    name: "abort beats every eligible retry",
    outcome: errored({
      aborted: true,
      previousResponseIdRetryable: true,
      reasoningReplayRetryable: true,
    }),
    expected: { _tag: "Aborted" },
  },
  {
    name: "a pending interrupt fails instead of retrying",
    outcome: errored({
      interruptPending: true,
      previousResponseIdRetryable: true,
      reasoningReplayRetryable: true,
    }),
    expected: { _tag: "Fail" },
  },
  {
    name: "previousResponseId recovery is tried before reasoning replay",
    outcome: errored({ previousResponseIdRetryable: true, reasoningReplayRetryable: true }),
    expected: { _tag: "Retry", change: "dropPreviousResponseId" },
  },
  {
    name: "reasoning replay recovery runs when only it is eligible",
    outcome: errored({ reasoningReplayRetryable: true }),
    expected: { _tag: "Retry", change: "dropReasoningReplay" },
  },
  {
    name: "a spent previousResponseId retry falls through to reasoning replay",
    outcome: errored({ previousResponseIdRetryable: true, reasoningReplayRetryable: true }),
    history: history({ retriedPreviousResponseId: true }),
    expected: { _tag: "Retry", change: "dropReasoningReplay" },
  },
  {
    name: "a spent previousResponseId retry is not repeated",
    outcome: errored({ previousResponseIdRetryable: true }),
    history: history({ retriedPreviousResponseId: true }),
    expected: { _tag: "Fail" },
  },
  {
    name: "a spent reasoning replay retry is not repeated",
    outcome: errored({ reasoningReplayRetryable: true }),
    history: history({ retriedReasoningReplay: true }),
    expected: { _tag: "Fail" },
  },
  {
    name: "a spent empty-output budget does not block error recovery",
    outcome: errored({ previousResponseIdRetryable: true }),
    history: history({ emptyRetries: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS }),
    expected: { _tag: "Retry", change: "dropPreviousResponseId" },
  },
];

describe("recoveryPolicy", () => {
  describe("finished attempts", () => {
    test.each(FINISHED_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(recoveryPolicy(c.outcome, c.history ?? history())).toEqual(c.expected);
    });
  });

  describe("errored attempts", () => {
    test.each(ERRORED_CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(recoveryPolicy(c.outcome, c.history ?? history())).toEqual(c.expected);
    });
  });

  test("a turn that keeps failing with a repairable error retries each repair once, then fails", () => {
    // Mirrors processStreamWithCleanup: each Retry spends its flag, and the
    // same eligible error repeats on every attempt.
    const outcome = errored({ previousResponseIdRetryable: true, reasoningReplayRetryable: true });
    let spent = history();
    const decisions: Decision[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const decision = recoveryPolicy(outcome, spent);
      decisions.push(decision);
      if (decision._tag !== "Retry") break;
      spent = {
        ...spent,
        retriedPreviousResponseId:
          spent.retriedPreviousResponseId || decision.change === "dropPreviousResponseId",
        retriedReasoningReplay:
          spent.retriedReasoningReplay || decision.change === "dropReasoningReplay",
      };
    }
    expect(decisions).toEqual([
      { _tag: "Retry", change: "dropPreviousResponseId" },
      { _tag: "Retry", change: "dropReasoningReplay" },
      { _tag: "Fail" },
    ]);
  });
});
