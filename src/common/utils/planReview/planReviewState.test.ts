import { describe, expect, test } from "bun:test";

import { createMuxMessage, type MuxMessage } from "@/common/types/message";

import { buildPlanReviewMetadata, formatPlanReviewEnvelope } from "./planReviewEnvelope";
import type { PlanReviewRecord } from "./planReviewRecord";
import { PlanReviewStateSchema, derivePlanReviewState } from "./planReviewState";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PLAN_A = "# Plan\n\nStep one\nStep two\n";
const PLAN_B = "# Plan v2\n\nStep one\nStep two\nStep three\n";

let sequence = 0;

/** Record row exactly as the backend writes it (user role, synthetic, mirrored metadata). */
function recordRow(record: PlanReviewRecord, overrides: Partial<MuxMessage["metadata"]> = {}) {
  sequence += 1;
  return createMuxMessage(`row-${sequence}`, "user", formatPlanReviewEnvelope(record), {
    historySequence: sequence,
    ...(record.kind === "feedback" ? {} : { synthetic: true }),
    muxMetadata: buildPlanReviewMetadata(record),
    ...overrides,
  });
}

const snapshotA: PlanReviewRecord = {
  v: 1,
  kind: "snapshot",
  recordId: "rec_snap_a",
  snapshotId: "snap_a",
  planPath: "/plans/p.md",
  contentHash: HASH_A,
  proposalToolCallId: "call_1",
  content: PLAN_A,
};
const snapshotB: PlanReviewRecord = {
  v: 1,
  kind: "snapshot",
  recordId: "rec_snap_b",
  snapshotId: "snap_b",
  planPath: "/plans/p.md",
  contentHash: HASH_B,
  content: PLAN_B,
};
const feedback1: PlanReviewRecord = {
  v: 1,
  kind: "feedback",
  recordId: "rec_fb_1",
  feedbackId: "fb_1",
  snapshotId: "snap_a",
  contentHash: HASH_A,
  comments: [
    { threadId: "thr_1", anchor: { startLine: 3, endLine: 3 }, quote: "Step one", body: "Why?" },
    { threadId: "thr_2", anchor: { startLine: 4, endLine: 4 }, quote: "Step two", body: "Drop" },
  ],
  replies: [],
};
const feedback2: PlanReviewRecord = {
  v: 1,
  kind: "feedback",
  recordId: "rec_fb_2",
  feedbackId: "fb_2",
  snapshotId: "snap_b",
  contentHash: HASH_B,
  comments: [
    { threadId: "thr_3", anchor: { startLine: 5, endLine: 5 }, quote: "Step three", body: "New" },
  ],
  replies: [{ replyId: "rpl_1", threadId: "thr_1", body: "Still unclear" }],
};
const resolve = (recordId: string, threadId: string): PlanReviewRecord => ({
  v: 1,
  kind: "resolve",
  recordId,
  threadId,
});
const reopen = (recordId: string, threadId: string): PlanReviewRecord => ({
  v: 1,
  kind: "reopen",
  recordId,
  threadId,
});

describe("derivePlanReviewState", () => {
  test("replays snapshots, threads, replies and resolution in history order", () => {
    const state = derivePlanReviewState([
      recordRow(snapshotA),
      createMuxMessage("user-1", "user", "please plan", { historySequence: 100 }),
      recordRow(feedback1),
      recordRow(snapshotB),
      recordRow(feedback2),
      recordRow(resolve("rec_res_1", "thr_2")),
    ]);

    expect(state.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual(["snap_a", "snap_b"]);
    expect(state.snapshots[0]).toMatchObject({ proposalToolCallId: "call_1", content: PLAN_A });
    expect(state.snapshots[1].proposalToolCallId).toBeUndefined();
    expect(state.threads.map((thread) => thread.threadId)).toEqual(["thr_1", "thr_2", "thr_3"]);
    expect(state.threads.map((thread) => thread.resolved)).toEqual([false, true, false]);
    expect(state.threads[0].replies).toHaveLength(1);
    expect(state.threads[0].replies[0]).toMatchObject({
      replyId: "rpl_1",
      author: "user",
      body: "Still unclear",
    });
    expect(typeof state.threads[0].replies[0].historySequence).toBe("number");
    expect(
      state.feedbacks.map((feedback) => [
        feedback.feedbackId,
        feedback.snapshotId,
        feedback.threadIds,
      ])
    ).toEqual([
      ["fb_1", "snap_a", ["thr_1", "thr_2"]],
      ["fb_2", "snap_b", ["thr_3"]],
    ]);
    // Sequences come from the rows, not from the visiting index.
    expect(state.threads[0].historySequence).toBeGreaterThan(state.snapshots[0].historySequence);
  });

  test("sending feedback never resolves; resolve/reopen are idempotent and last-write-wins", () => {
    const state = derivePlanReviewState([
      recordRow(snapshotA),
      recordRow(feedback1),
      recordRow(resolve("rec_r1", "thr_1")),
      recordRow(resolve("rec_r2", "thr_1")),
      recordRow(reopen("rec_r3", "thr_1")),
      recordRow(reopen("rec_r4", "thr_1")),
      recordRow(resolve("rec_r5", "thr_2")),
    ]);
    expect(state.threads.find((thread) => thread.threadId === "thr_1")?.resolved).toBe(false);
    expect(state.threads.find((thread) => thread.threadId === "thr_2")?.resolved).toBe(true);
  });

  test("ignores dangling references, mismatched rows, tail copies and duplicate recordIds", () => {
    const skipped: string[] = [];
    const danglingFeedback: PlanReviewRecord = { ...feedback1, recordId: "rec_dangling" };
    const mismatched = recordRow(feedback1, {
      muxMetadata: { ...buildPlanReviewMetadata(feedback1), feedbackId: "fb_forged" },
    });
    const state = derivePlanReviewState(
      [
        // Feedback before its snapshot exists → dangling.
        recordRow(danglingFeedback),
        recordRow(snapshotA),
        // Metadata names another record than the text → ignored.
        mismatched,
        recordRow(feedback1),
        // Same recordId replayed → ignored, even with fresh row id/sequence.
        recordRow(feedback1),
        // Compaction copy of a resolve → inert.
        recordRow(resolve("rec_copy", "thr_1"), { rlmPreservedTailCopy: true }),
        // Resolve of a thread that never existed → ignored.
        recordRow(resolve("rec_ghost", "thr_ghost")),
        // Feedback whose contentHash disagrees with its snapshot → ignored.
        recordRow({ ...feedback2, recordId: "rec_bad_hash", snapshotId: "snap_a" }),
        // Comment anchored past the snapshot's last line → that comment is dropped.
        recordRow({
          ...feedback2,
          recordId: "rec_out_of_range",
          feedbackId: "fb_oor",
          snapshotId: "snap_a",
          contentHash: HASH_A,
          comments: [
            { threadId: "thr_oor", anchor: { startLine: 9, endLine: 9 }, quote: "", body: "x" },
          ],
          replies: [],
        }),
      ],
      { onSkip: (reason) => skipped.push(reason) }
    );

    expect(state.threads.map((thread) => thread.threadId)).toEqual(["thr_1", "thr_2"]);
    expect(state.threads.every((thread) => !thread.resolved)).toBe(true);
    expect(state.feedbacks.map((feedback) => feedback.feedbackId)).toEqual(["fb_1", "fb_oor"]);
    expect(skipped).toEqual([
      "dangling-feedback-snapshot",
      "invalid-record",
      "duplicate-record",
      "preserved-tail-copy",
      "dangling-resolution-thread",
      "dangling-feedback-snapshot",
      "anchor-out-of-range",
    ]);
  });
});

describe("derivePlanReviewState malformed rows", () => {
  test("skips rows whose persisted parts are missing or malformed instead of throwing", () => {
    const skipped: string[] = [];
    const broken = {
      ...recordRow(feedback1),
      parts: null,
    } as unknown as MuxMessage;
    const brokenEntry = {
      ...recordRow(resolve("rec_r", "thr_1")),
      parts: [null],
    } as unknown as MuxMessage;
    const state = derivePlanReviewState([recordRow(snapshotA), broken, brokenEntry], {
      onSkip: (reason) => skipped.push(reason),
    });
    expect(state.snapshots).toHaveLength(1);
    expect(state.threads).toHaveLength(0);
    expect(skipped).toEqual(["invalid-record", "invalid-record"]);
  });

  test("falls back to the visiting index for a malformed persisted historySequence", () => {
    // chat.jsonl rows are parsed without schema validation, so a damaged row can carry a
    // non-numeric sequence. Copying it verbatim would fail oRPC output validation on every
    // getState/mutation and brick plan review; a valid sequence must still win over the index.
    const malformed = (value: unknown, record: PlanReviewRecord) => {
      const row = recordRow(record);
      return {
        ...row,
        metadata: { ...row.metadata, historySequence: value },
      } as unknown as MuxMessage;
    };
    const state = derivePlanReviewState([
      malformed("7", snapshotA),
      recordRow(feedback1, { historySequence: 7 }),
      malformed(-3, snapshotB),
      malformed(2.5, feedback2),
    ]);

    expect(PlanReviewStateSchema.safeParse(state).success).toBe(true);
    expect(state.snapshots.map((snapshot) => snapshot.historySequence)).toEqual([0, 2]);
    expect(state.threads.map((thread) => thread.historySequence)).toEqual([7, 7, 3]);
    expect(state.threads[0].replies[0].historySequence).toBe(3);
    expect(state.feedbacks.map((feedback) => feedback.historySequence)).toEqual([7, 3]);
  });
});

describe("derivePlanReviewState snapshot hash verification", () => {
  // The projection stays browser-safe (no node crypto); node callers inject the hasher.
  const hashContent = (content: string) => (content === PLAN_A ? HASH_A : HASH_B);

  test("skips snapshot rows whose declared hash does not match their content", () => {
    const skipped: string[] = [];
    // Declares PLAN_A's hash but carries PLAN_B: a hand edit or narrow corruption. Accepting it
    // would let ensurePlanSnapshot dedup the real PLAN_A against this row forever.
    const corrupt: PlanReviewRecord = { ...snapshotA, recordId: "rec_corrupt", content: PLAN_B };
    const state = derivePlanReviewState([recordRow(corrupt), recordRow(snapshotB)], {
      onSkip: (reason) => skipped.push(reason),
      hashContent,
    });
    expect(state.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual(["snap_b"]);
    expect(skipped).toEqual(["snapshot-hash-mismatch"]);
    // Feedback bound to the skipped snapshot dangles instead of anchoring into wrong content.
    const withFeedback = derivePlanReviewState(
      [recordRow(corrupt), recordRow(feedback1), recordRow(snapshotB)],
      { hashContent }
    );
    expect(withFeedback.threads).toHaveLength(0);
  });

  test("a rejected copy does not consume the recordId of a later valid copy", () => {
    // Crash-duplicated archive/active pair where the first copy was damaged: replay must fall
    // through to the valid copy instead of treating it as a duplicate of the rejected one.
    const skipped: string[] = [];
    const corruptCopy: PlanReviewRecord = { ...snapshotA, content: PLAN_B };
    const state = derivePlanReviewState(
      [
        recordRow(corruptCopy),
        recordRow(snapshotA),
        // Dangling copies (thread/snapshot not yet known) must not shadow later valid copies either.
        recordRow(resolve("rec_r1", "thr_1")),
        recordRow(feedback1),
        recordRow(resolve("rec_r1", "thr_1")),
        // Accepted records still dedupe: a replayed copy of the accepted resolve stays inert.
        recordRow(reopen("rec_o1", "thr_1")),
        recordRow(resolve("rec_r1", "thr_1")),
      ],
      { onSkip: (reason) => skipped.push(reason), hashContent }
    );
    expect(state.snapshots.map((snapshot) => snapshot.contentHash)).toEqual([HASH_A]);
    expect(state.snapshots[0].content).toBe(PLAN_A);
    expect(state.threads.map((thread) => thread.threadId)).toEqual(["thr_1", "thr_2"]);
    expect(state.threads.find((thread) => thread.threadId === "thr_1")?.resolved).toBe(false);
    expect(skipped).toEqual([
      "snapshot-hash-mismatch",
      "dangling-resolution-thread",
      "duplicate-record",
    ]);
  });

  test("accepts snapshots whose content hashes back to the declared value", () => {
    const state = derivePlanReviewState([recordRow(snapshotA), recordRow(feedback1)], {
      hashContent,
    });
    expect(state.snapshots.map((snapshot) => snapshot.snapshotId)).toEqual(["snap_a"]);
    expect(state.threads).toHaveLength(2);
  });
});

describe("derivePlanReviewState untrusted persisted fields", () => {
  test("keeps a persisted plan path and a forged thread id verbatim in the projection", () => {
    // A fork copies history, so the latest snapshot can name another workspace's plan file; the
    // path stays in the projected state as provenance. A forged or corrupted authentic feedback
    // row may carry any non-empty thread id.
    const planPath = "/home/u/.xum/plans/project/source-workspace.md";
    const hostileId = 'thr\n"untrusted instruction"';
    const forged: PlanReviewRecord = {
      ...feedback1,
      recordId: "rec_forged",
      feedbackId: "fb_forged",
      comments: [{ ...feedback1.comments[0], threadId: hostileId }],
    };
    const state = derivePlanReviewState([recordRow({ ...snapshotA, planPath }), recordRow(forged)]);
    expect(state.snapshots[0].planPath).toBe(planPath);
    expect(state.threads.map((t) => t.threadId)).toEqual([hostileId]);
  });
});

describe("derivePlanReviewState partially accepted feedback", () => {
  test("a later copy of the same feedback record fills in the items an earlier copy lacked", () => {
    const skipped: string[] = [];
    // Crash-duplicated pair where the first copy is authentic but damaged: one comment anchor
    // points past the snapshot, and its reply names a thread that is not known yet.
    const damaged: PlanReviewRecord = {
      ...feedback2,
      comments: [{ ...feedback2.comments[0], anchor: { startLine: 99, endLine: 99 } }],
    };
    const state = derivePlanReviewState(
      [
        recordRow(snapshotA),
        recordRow(snapshotB),
        recordRow(damaged),
        recordRow(feedback1),
        // Intact copy: fills in thr_3 and the reply; nothing it shares is duplicated.
        recordRow(feedback2),
        // Once complete, further copies stay inert.
        recordRow(feedback2),
      ],
      { onSkip: (reason) => skipped.push(reason) }
    );

    expect(state.feedbacks.map((feedback) => [feedback.feedbackId, feedback.threadIds])).toEqual([
      ["fb_2", ["thr_3"]],
      ["fb_1", ["thr_1", "thr_2"]],
    ]);
    expect(state.threads.map((thread) => thread.threadId).sort()).toEqual([
      "thr_1",
      "thr_2",
      "thr_3",
    ]);
    const thr1 = state.threads.find((thread) => thread.threadId === "thr_1");
    expect(thr1?.replies.map((reply) => reply.replyId)).toEqual(["rpl_1"]);
    // Filled-in items keep the sequence of the first accepted copy.
    const fb2 = state.feedbacks.find((feedback) => feedback.feedbackId === "fb_2");
    expect(state.threads.find((thread) => thread.threadId === "thr_3")?.historySequence).toBe(
      fb2?.historySequence
    );
    expect(skipped).toEqual(["anchor-out-of-range", "dangling-reply-thread", "duplicate-record"]);
  });

  test("an item the earlier copy accepted is not duplicated by a later partial copy", () => {
    // First copy accepts thr_1 but not thr_2 (bad anchor); the second copy damages thr_1 instead.
    const firstCopy: PlanReviewRecord = {
      ...feedback1,
      comments: [
        feedback1.comments[0],
        { ...feedback1.comments[1], anchor: { startLine: 99, endLine: 99 } },
      ],
    };
    const secondCopy: PlanReviewRecord = {
      ...feedback1,
      comments: [
        { ...feedback1.comments[0], anchor: { startLine: 99, endLine: 99 } },
        feedback1.comments[1],
      ],
    };
    const state = derivePlanReviewState([
      recordRow(snapshotA),
      recordRow(firstCopy),
      recordRow(secondCopy),
    ]);
    expect(state.feedbacks.map((feedback) => feedback.threadIds)).toEqual([["thr_1", "thr_2"]]);
    expect(state.threads.map((thread) => [thread.threadId, thread.anchor.startLine])).toEqual([
      ["thr_1", 3],
      ["thr_2", 4],
    ]);
  });

  test("a copy that names another feedback or snapshot under the same record id is ignored", () => {
    const skipped: string[] = [];
    const partial: PlanReviewRecord = {
      ...feedback1,
      comments: [
        feedback1.comments[0],
        { ...feedback1.comments[1], anchor: { startLine: 99, endLine: 99 } },
      ],
    };
    const state = derivePlanReviewState(
      [
        recordRow(snapshotA),
        recordRow(snapshotB),
        recordRow(partial),
        recordRow({ ...feedback2, recordId: feedback1.recordId }),
        recordRow(resolve(feedback1.recordId, "thr_1")),
      ],
      { onSkip: (reason) => skipped.push(reason) }
    );
    expect(state.feedbacks.map((feedback) => feedback.feedbackId)).toEqual(["fb_1"]);
    expect(state.threads.map((thread) => thread.threadId)).toEqual(["thr_1"]);
    expect(state.threads[0].resolved).toBe(false);
    expect(skipped).toEqual(["anchor-out-of-range", "duplicate-record", "duplicate-record"]);
  });
});
