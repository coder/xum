import { z } from "zod";

/**
 * Persisted plan-review records. Each record is ONE history row whose text part is a
 * `<mux_plan_review>` envelope (see planReviewEnvelope.ts) and whose muxMetadata mirrors the
 * record's identity so consumers can filter rows without re-parsing them. Rows are append-only;
 * review state is a replay of these records in history order (see planReviewState.ts).
 */

export const PLAN_REVIEW_RECORD_VERSION = 1;

const nonEmptyString = z.string().min(1);
/** sha256 hex digest of the CRLF-normalized plan text. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** 1-based, inclusive line range of the snapshot the thread is anchored to. */
export const PlanReviewAnchorSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((anchor) => anchor.endLine >= anchor.startLine, {
    message: "anchor endLine must be >= startLine",
  });
export type PlanReviewAnchor = z.infer<typeof PlanReviewAnchorSchema>;

const recordBase = {
  v: z.literal(PLAN_REVIEW_RECORD_VERSION),
  /** Unique per row; a duplicate recordId (e.g. a replayed copy) is ignored by the projection. */
  recordId: nonEmptyString,
};

export const PlanReviewSnapshotRecordSchema = z.object({
  ...recordBase,
  kind: z.literal("snapshot"),
  snapshotId: nonEmptyString,
  planPath: nonEmptyString,
  contentHash: contentHashSchema,
  /** Tool call id of the `propose_plan` that produced this revision; absent for on-demand snapshots. */
  proposalToolCallId: nonEmptyString.optional(),
  /** Full plan text as proposed (CRLF-normalized); anchors are line numbers into this text. */
  content: z.string(),
});

export const PlanReviewFeedbackCommentSchema = z.object({
  threadId: nonEmptyString,
  anchor: PlanReviewAnchorSchema,
  /** Selected or block text the comment refers to; lets the agent relocate it after revisions. */
  quote: z.string(),
  body: nonEmptyString,
});

export const PlanReviewFeedbackReplySchema = z.object({
  replyId: nonEmptyString,
  threadId: nonEmptyString,
  body: nonEmptyString,
});

export const PlanReviewFeedbackRecordSchema = z.object({
  ...recordBase,
  kind: z.literal("feedback"),
  feedbackId: nonEmptyString,
  snapshotId: nonEmptyString,
  contentHash: contentHashSchema,
  summary: z.string().optional(),
  /** New threads opened by this feedback. */
  comments: z.array(PlanReviewFeedbackCommentSchema),
  /** Replies to threads that already existed when the feedback was sent. */
  replies: z.array(PlanReviewFeedbackReplySchema),
});

export const PlanReviewResolveRecordSchema = z.object({
  ...recordBase,
  kind: z.literal("resolve"),
  threadId: nonEmptyString,
});

export const PlanReviewReopenRecordSchema = z.object({
  ...recordBase,
  kind: z.literal("reopen"),
  threadId: nonEmptyString,
});

export const PlanReviewRecordSchema = z.discriminatedUnion("kind", [
  PlanReviewSnapshotRecordSchema,
  PlanReviewFeedbackRecordSchema,
  PlanReviewResolveRecordSchema,
  PlanReviewReopenRecordSchema,
]);

export type PlanReviewRecord = z.infer<typeof PlanReviewRecordSchema>;
export type PlanReviewRecordKind = PlanReviewRecord["kind"];
export type PlanReviewSnapshotRecord = z.infer<typeof PlanReviewSnapshotRecordSchema>;
export type PlanReviewFeedbackRecord = z.infer<typeof PlanReviewFeedbackRecordSchema>;
export type PlanReviewFeedbackComment = z.infer<typeof PlanReviewFeedbackCommentSchema>;
export type PlanReviewFeedbackReply = z.infer<typeof PlanReviewFeedbackReplySchema>;

/**
 * Snapshot content is line-ending-normalized before hashing so anchors map 1:1 across platforms.
 * CommonMark treats a lone CR as a line ending too, so CR-only plans must count the same lines
 * the rendered review shows (getPlanSnapshotLineCount splits on LF only).
 */
export function normalizePlanSnapshotContent(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Number of addressable lines in a snapshot. A trailing newline terminates the last line rather
 * than starting an empty one, matching how Markdown parsers report line positions.
 */
export function getPlanSnapshotLineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

export function isAnchorWithinSnapshot(anchor: PlanReviewAnchor, content: string): boolean {
  return anchor.startLine >= 1 && anchor.endLine <= getPlanSnapshotLineCount(content);
}
