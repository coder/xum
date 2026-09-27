import { describe, expect, spyOn, test } from "bun:test";
import { computePriorHistoryFingerprint } from "@/common/orpc/onChatCursorFingerprint";
import type { MuxMessage } from "@/common/types/message";
import { mulberry32, pick, randInt, type Rng } from "@/common/utils/testing/fuzzHelpers";
import { computePriorHistoryFingerprintAsync } from "./priorHistoryFingerprintAsync";

// Pairs like "a"/"B" and "e"/"é" order differently under localeCompare and code-unit comparison,
// so a wrong tiebreak (or a missing sort) changes the hash when two rows share a sequence.
const IDS = ["a", "B", "b", "A", "e", "é", "E", "_x", "Z", "ä", "10", "9", "msg-1", "msg-2"];
const TEXTS = ["", "hello", "日本語", "emoji 😀 astral", 'quote " and \\ back', "tab\tnew\nline"];

function generateHistory(rng: Rng): MuxMessage[] {
  const size = pick(rng, [0, 1, 2, 5, 40, 300, 3000]);
  const history: MuxMessage[] = [];
  let sequence = randInt(rng, 5);
  for (let index = 0; index < size; index += 1) {
    // Repeat sequences often enough to exercise the id tiebreak.
    if (rng() > 0.2) sequence += 1;
    const metadata: NonNullable<MuxMessage["metadata"]> = {};
    if (rng() > 0.05) metadata.historySequence = sequence;
    if (rng() > 0.1) metadata.timestamp = 1_000 + index;
    history.push({
      id: pick(rng, IDS),
      role: rng() > 0.5 ? "user" : "assistant",
      metadata: rng() > 0.02 ? metadata : undefined,
      parts: rng() > 0.1 ? [{ type: "text", text: pick(rng, TEXTS) }] : [],
    });
  }

  const order = randInt(rng, 3);
  if (order === 1) {
    // Stored order with ties already in comparator order: the async path skips its sort.
    history.sort(
      (left, right) =>
        (left.metadata?.historySequence ?? 0) - (right.metadata?.historySequence ?? 0) ||
        left.id.localeCompare(right.id)
    );
  } else if (order === 2) {
    // Out-of-order rows: the async path must fall back to sorting.
    for (let index = history.length - 1; index > 0; index -= 1) {
      const swap = randInt(rng, index + 1);
      [history[index], history[swap]] = [history[swap], history[index]];
    }
  }
  return history;
}

function anchorsFor(rng: Rng, history: readonly MuxMessage[]): number[] {
  const sequences = history
    .map((message) => message.metadata?.historySequence)
    .filter((sequence): sequence is number => sequence !== undefined);
  const newest = sequences.length > 0 ? Math.max(...sequences) : 0;
  const anchors = [0, -1, newest + 10];
  // Anchors equal to an existing row's sequence pin the strict `<` boundary.
  if (sequences.length > 0) anchors.push(pick(rng, sequences), pick(rng, sequences));
  anchors.push(randInt(rng, newest + 2));
  return anchors;
}

describe("computePriorHistoryFingerprintAsync", () => {
  // The server hands this value to clients as their reconnect cursor and compares it with the
  // value they return, so it must never diverge from the reference implementation.
  test("matches computePriorHistoryFingerprint on generated histories", async () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const rng = mulberry32(seed);
      const history = generateHistory(rng);
      for (const anchor of anchorsFor(rng, history)) {
        const expected = computePriorHistoryFingerprint(history, anchor);
        const actual = await computePriorHistoryFingerprintAsync(history, anchor);
        if (actual !== expected) {
          throw new Error(
            `seed ${seed}, anchor ${anchor}, ${history.length} rows: ${String(actual)} !== ${String(expected)}`
          );
        }
      }
    }
  });

  test("yields to the event loop on a long input", async () => {
    const history: MuxMessage[] = [2, 1, 0].map(
      (historySequence): MuxMessage => ({
        id: `msg-${historySequence}`,
        role: "user",
        metadata: { historySequence, timestamp: historySequence },
        parts: [{ type: "text", text: "row" }],
      })
    );
    // A clock that advances past the yield budget on every read stands in for an epoch large
    // enough to exceed it, without a timing-dependent input size.
    let fakeNow = 0;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => (fakeNow += 1_000));

    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    let fingerprint: string | undefined;
    try {
      fingerprint = await computePriorHistoryFingerprintAsync(history, 3);
    } finally {
      nowSpy.mockRestore();
    }

    // A non-yielding async function settles in a microtask, before any timer callback.
    expect(timerRan).toBe(true);
    expect(fingerprint).toBe(computePriorHistoryFingerprint(history, 3));
  });
});
