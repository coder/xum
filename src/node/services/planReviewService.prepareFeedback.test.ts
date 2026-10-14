import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMuxMessage } from "@/common/types/message";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
  parsePlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import type {
  PlanReviewFeedbackComment,
  PlanReviewRecord,
} from "@/common/utils/planReview/planReviewRecord";
import {
  PLAN_REVIEW_MAX_BODY_CHARS,
  PLAN_REVIEW_MAX_COMMENTS_PER_FEEDBACK,
  PLAN_REVIEW_MAX_QUOTE_CHARS,
  PLAN_REVIEW_MAX_REPLIES_PER_FEEDBACK,
  PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS,
  PLAN_REVIEW_MAX_SUMMARY_CHARS,
} from "@/constants/planReview";
import { hashPlanSnapshotContent, preparePlanReviewFeedback } from "./planReviewService";
import { createTestHistoryService } from "./testHistoryService";

/**
 * Review threads are discovered from full history, but provider requests start at the latest
 * context reset, so a reply to an older thread must carry that thread's context itself.
 */
describe("preparePlanReviewFeedback reply thread context", () => {
  const workspaceId = "ws-plan-review-prepare";
  const content = "# Plan\n\nStep one.\nStep two.\n";
  const contentHash = hashPlanSnapshotContent(content);
  let historyHandle: Awaited<ReturnType<typeof createTestHistoryService>>;

  beforeEach(async () => {
    historyHandle = await createTestHistoryService();
  });

  afterEach(async () => {
    await historyHandle.cleanup();
  });

  async function seed(comments: PlanReviewFeedbackComment[]): Promise<void> {
    const records: PlanReviewRecord[] = [
      {
        v: 1,
        kind: "snapshot",
        recordId: "rec_snapshot",
        snapshotId: "snap_1",
        planPath: "/tmp/plan.md",
        contentHash,
        content,
      },
      {
        v: 1,
        kind: "feedback",
        recordId: "rec_feedback",
        feedbackId: "fb_1",
        snapshotId: "snap_1",
        contentHash,
        comments,
        replies: [],
      },
    ];
    for (const record of records) {
      const appended = await historyHandle.historyService.appendToHistory(
        workspaceId,
        createMuxMessage(`pr-${record.recordId}`, "user", formatPlanReviewEnvelope(record), {
          timestamp: Date.now(),
          synthetic: record.kind !== "feedback",
          muxMetadata: buildPlanReviewMetadata(record),
        })
      );
      expect(appended.success).toBe(true);
    }
  }

  test("each reply carries its thread's anchor, quote, and opening comment, truncated above the caps", async () => {
    // Seeded directly: persisted threads are replayed without the submission caps, so an older or
    // hand-edited row can hold a longer quote/comment than the review UI would accept today.
    const longQuote = "q".repeat(PLAN_REVIEW_MAX_QUOTE_CHARS + 300);
    const longComment = "c".repeat(PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS + 1_000);
    await seed([
      {
        threadId: "thr_short",
        anchor: { startLine: 3, endLine: 3 },
        quote: "Step one.",
        body: "Why first?",
      },
      {
        threadId: "thr_long",
        anchor: { startLine: 1, endLine: 4 },
        quote: longQuote,
        body: longComment,
      },
    ]);

    const prepared = await preparePlanReviewFeedback(
      historyHandle.historyService,
      workspaceId,
      {
        snapshotId: "snap_1",
        comments: [],
        replies: [
          { threadId: "thr_short", body: "Still unclear" },
          { threadId: "thr_long", body: "See above" },
        ],
      },
      { model: "openai:gpt-4o", agentId: "plan" }
    );
    expect(prepared.success).toBe(true);
    if (!prepared.success) return;
    // What the model receives is the envelope text itself.
    const record = parsePlanReviewEnvelope(prepared.data.text);
    expect(record?.kind).toBe("feedback");
    if (record?.kind !== "feedback") return;
    const [short, long] = record.replies;
    expect(short.thread).toEqual({
      anchor: { startLine: 3, endLine: 3 },
      quote: "Step one.",
      comment: "Why first?",
    });
    expect(long.thread?.anchor).toEqual({ startLine: 1, endLine: 4 });
    expect(long.thread?.quote.length).toBe(PLAN_REVIEW_MAX_QUOTE_CHARS);
    expect(long.thread?.quote.startsWith("q".repeat(PLAN_REVIEW_MAX_QUOTE_CHARS - 1))).toBe(true);
    expect(long.thread?.comment.length).toBe(PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS);
    expect(
      long.thread?.comment.startsWith("c".repeat(PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS - 1))
    ).toBe(true);
    expect(long.thread?.comment.endsWith("c")).toBe(false);
  });

  test("a submission with every field at its cap still fits the row budget with reply context", async () => {
    await seed(
      Array.from({ length: PLAN_REVIEW_MAX_REPLIES_PER_FEEDBACK }, (_, index) => ({
        threadId: `thr_${index}`,
        anchor: { startLine: 1, endLine: 1 },
        quote: "q".repeat(PLAN_REVIEW_MAX_QUOTE_CHARS),
        body: "b".repeat(PLAN_REVIEW_MAX_BODY_CHARS),
      }))
    );

    const prepared = await preparePlanReviewFeedback(
      historyHandle.historyService,
      workspaceId,
      {
        snapshotId: "snap_1",
        summary: "s".repeat(PLAN_REVIEW_MAX_SUMMARY_CHARS),
        comments: Array.from({ length: PLAN_REVIEW_MAX_COMMENTS_PER_FEEDBACK }, () => ({
          anchor: { startLine: 1, endLine: 1 },
          quote: "q".repeat(PLAN_REVIEW_MAX_QUOTE_CHARS),
          body: "b".repeat(PLAN_REVIEW_MAX_BODY_CHARS),
        })),
        replies: Array.from({ length: PLAN_REVIEW_MAX_REPLIES_PER_FEEDBACK }, (_, index) => ({
          threadId: `thr_${index}`,
          body: "r".repeat(PLAN_REVIEW_MAX_BODY_CHARS),
        })),
      },
      { model: "openai:gpt-4o", agentId: "plan" }
    );
    expect(prepared.success).toBe(true);
  });
});
