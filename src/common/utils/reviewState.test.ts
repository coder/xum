import { describe, expect, it } from "bun:test";
import type { ReviewStateDelta, ReviewStateSections } from "@/common/orpc/schemas/reviewState";
import { applyReviewStateDelta, mergeReviewStateDeltas } from "./reviewState";

describe("mergeReviewStateDeltas", () => {
  // The frontend store flushes all pending deltas as one merged request; the backend
  // result must equal applying the deltas one by one or a queued change is lost.
  const base: ReviewStateSections = {
    hunkExpand: { a: true, b: true },
    firstSeen: { old: 1 },
  };
  const cases: Array<{ name: string; deltas: ReviewStateDelta[] }> = [
    {
      name: "set then delete",
      deltas: [{ hunkExpand: { set: { c: true } } }, { hunkExpand: { delete: ["c", "a"] } }],
    },
    {
      name: "delete then set",
      deltas: [{ hunkExpand: { delete: ["a"] } }, { hunkExpand: { set: { a: false } } }],
    },
    {
      name: "untouched sections stay absent",
      deltas: [{ readMore: { set: { h: { up: 30, down: 0 } } } }, {}],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const sequential = testCase.deltas.reduce(applyReviewStateDelta, base);
      const merged = applyReviewStateDelta(base, mergeReviewStateDeltas(testCase.deltas));
      expect(merged).toEqual(sequential);
    });
  }

  it("first-seen keeps the earliest report whatever order the reports arrive in", () => {
    const earlier: ReviewStateDelta = { firstSeen: { set: { n: 10, old: 5 } } };
    const later: ReviewStateDelta = { firstSeen: { set: { n: 20, old: 0 } } };
    for (const deltas of [
      [earlier, later],
      [later, earlier],
    ]) {
      const expected = { old: 0, n: 10 };
      expect(deltas.reduce(applyReviewStateDelta, base).firstSeen).toEqual(expected);
      expect(applyReviewStateDelta(base, mergeReviewStateDeltas(deltas)).firstSeen).toEqual(
        expected
      );
    }
  });
});
