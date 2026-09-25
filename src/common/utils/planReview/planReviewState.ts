import { z } from "zod";

import type { MuxMessage } from "@/common/types/message";
import { isNonNegativeInteger } from "@/common/utils/numbers";
import { getAuthenticPlanReviewRecord } from "./planReviewEnvelope";
import { PlanReviewAnchorSchema, isAnchorWithinSnapshot } from "./planReviewRecord";

/**
 * Pure projection of plan-review record rows into review state. Shared by the backend (oRPC
 * endpoints, snapshot/feedback services) and the frontend (Run 2 review UI), so it must stay free of
 * node-only imports. Backend state is the only authority; nothing here is cached or persisted.
 */

export const PlanReviewSnapshotSchema = z.object({
  snapshotId: z.string(),
  planPath: z.string(),
  contentHash: z.string(),
  proposalToolCallId: z.string().optional(),
  content: z.string(),
  historySequence: z.number(),
});

export const PlanReviewThreadReplySchema = z.object({
  replyId: z.string(),
  /** Agent replies arrive through a later per-thread reply tool; v1 records only user replies. */
  author: z.enum(["user", "agent"]),
  body: z.string(),
  historySequence: z.number(),
});

export const PlanReviewThreadSchema = z.object({
  threadId: z.string(),
  snapshotId: z.string(),
  anchor: PlanReviewAnchorSchema,
  quote: z.string(),
  body: z.string(),
  feedbackId: z.string(),
  historySequence: z.number(),
  replies: z.array(PlanReviewThreadReplySchema),
  /** Last resolve/reopen record wins. Sending feedback never resolves; only the user does. */
  resolved: z.boolean(),
});

export const PlanReviewFeedbackSchema = z.object({
  feedbackId: z.string(),
  snapshotId: z.string(),
  threadIds: z.array(z.string()),
  historySequence: z.number(),
});

export const PlanReviewStateSchema = z.object({
  snapshots: z.array(PlanReviewSnapshotSchema),
  threads: z.array(PlanReviewThreadSchema),
  feedbacks: z.array(PlanReviewFeedbackSchema),
});

export type PlanReviewSnapshot = z.infer<typeof PlanReviewSnapshotSchema>;
export type PlanReviewThread = z.infer<typeof PlanReviewThreadSchema>;
export type PlanReviewThreadReply = z.infer<typeof PlanReviewThreadReplySchema>;
export type PlanReviewFeedback = z.infer<typeof PlanReviewFeedbackSchema>;
export type PlanReviewState = z.infer<typeof PlanReviewStateSchema>;

export interface DerivePlanReviewStateOptions {
  /** Called for every row or item the replay ignores (corrupt, dangling, duplicate); node callers log it. */
  onSkip?: (reason: string, messageId: string) => void;
  /**
   * sha256 hex of snapshot content (see hashPlanSnapshotContent). When provided, a snapshot row
   * whose declared `contentHash` does not hash back from its `content` is skipped, so a hand-edited
   * or corrupted row can neither anchor threads into text nobody proposed nor let
   * ensurePlanSnapshot deduplicate a real plan against it forever. Optional because this module
   * stays free of node crypto; the backend (the only state authority) always injects it.
   */
  hashContent?: (content: string) => string;
}

export function createEmptyPlanReviewState(): PlanReviewState {
  return { snapshots: [], threads: [], feedbacks: [] };
}

/**
 * Replay record rows in the given (history) order. A row counts only when it is authentic
 * (metadata and envelope agree, see getAuthenticPlanReviewRecord); everything else is skipped
 * so a corrupt or forged row can never create, resolve, or hide a thread (self-healing).
 * Compaction tail copies and duplicate recordIds are inert, except that a later copy of
 * partially accepted feedback fills in the items the earlier copy lacked.
 */
export function derivePlanReviewState(
  messages: Iterable<MuxMessage>,
  options: DerivePlanReviewStateOptions = {}
): PlanReviewState {
  const skip = options.onSkip ?? (() => undefined);
  const state = createEmptyPlanReviewState();
  const snapshotsById = new Map<string, PlanReviewSnapshot>();
  const threadsById = new Map<string, PlanReviewThread>();
  const seenRecordIds = new Set<string>();
  // Feedback accepted with item-level skips (a damaged comment anchor, a reply whose thread is
  // not known yet, a thread id already taken). Its record id stays open so a later copy of the
  // same record (e.g. the intact half of a crash-duplicated archive/active pair) can fill in the
  // missing items; items already accepted from an earlier copy are inert, never duplicated.
  // Items any copy carried but that were rejected stay tracked until some copy accepts them, so a
  // later valid copy that merely omits one cannot seal the record before an intact copy that has
  // it arrives.
  const partialFeedbacks = new Map<
    string,
    {
      feedback: PlanReviewFeedback;
      acceptedReplyIds: Set<string>;
      missingThreadIds: Set<string>;
      missingReplyIds: Set<string>;
    }
  >();
  let index = -1;

  for (const message of messages) {
    index += 1;
    if (message.metadata?.muxMetadata?.type !== "plan-review") continue;
    if (message.metadata.rlmPreservedTailCopy === true) {
      skip("preserved-tail-copy", message.id);
      continue;
    }
    const record = getAuthenticPlanReviewRecord(message);
    if (record === null) {
      skip("invalid-record", message.id);
      continue;
    }
    const partial = partialFeedbacks.get(record.recordId);
    if (
      seenRecordIds.has(record.recordId) ||
      (partial !== undefined &&
        (record.kind !== "feedback" ||
          record.feedbackId !== partial.feedback.feedbackId ||
          record.snapshotId !== partial.feedback.snapshotId))
    ) {
      skip("duplicate-record", message.id);
      continue;
    }
    // The record ID is consumed only once a row passes its kind-specific validation below
    // (see `seenRecordIds.add` in each accepting branch). Consuming it up front let a corrupt
    // copy (e.g. a damaged half of a crash-duplicated archive/active pair) shadow a later valid
    // copy, so the snapshot and every thread anchored to it vanished instead of self-healing.
    // Rows persisted by the backend always carry a sequence; fall back to the visiting index
    // so relative order survives for rows that have not been stamped yet. Persisted rows are
    // parsed JSON without schema validation, so a damaged sequence (string, negative, fraction)
    // takes the same fallback instead of being copied into state and failing oRPC output
    // validation on every getState/mutation (self-healing rule).
    const persistedSequence: unknown = message.metadata.historySequence;
    const historySequence = isNonNegativeInteger(persistedSequence) ? persistedSequence : index;

    switch (record.kind) {
      case "snapshot": {
        if (snapshotsById.has(record.snapshotId)) {
          skip("duplicate-snapshot", message.id);
          break;
        }
        if (
          options.hashContent !== undefined &&
          options.hashContent(record.content) !== record.contentHash
        ) {
          skip("snapshot-hash-mismatch", message.id);
          break;
        }
        const snapshot: PlanReviewSnapshot = {
          snapshotId: record.snapshotId,
          planPath: record.planPath,
          contentHash: record.contentHash,
          ...(record.proposalToolCallId !== undefined
            ? { proposalToolCallId: record.proposalToolCallId }
            : {}),
          content: record.content,
          historySequence,
        };
        snapshotsById.set(snapshot.snapshotId, snapshot);
        state.snapshots.push(snapshot);
        seenRecordIds.add(record.recordId);
        break;
      }
      case "feedback": {
        const snapshot = snapshotsById.get(record.snapshotId);
        if (snapshot === undefined || snapshot.contentHash !== record.contentHash) {
          skip("dangling-feedback-snapshot", message.id);
          break;
        }
        // A later copy extends the entry of the first accepted copy, at that copy's sequence.
        const entry = partial ?? {
          feedback: {
            feedbackId: record.feedbackId,
            snapshotId: snapshot.snapshotId,
            threadIds: [],
            historySequence,
          },
          acceptedReplyIds: new Set<string>(),
          missingThreadIds: new Set<string>(),
          missingReplyIds: new Set<string>(),
        };
        const { feedback, acceptedReplyIds, missingThreadIds, missingReplyIds } = entry;
        // Only an EARLIER copy's items are recovered (inert). An id repeated inside this row is
        // a damaged item: it leaves the copy partial so an intact later copy can fill it in.
        const earlierThreadIds = new Set(feedback.threadIds);
        const earlierReplyIds = new Set(acceptedReplyIds);
        const rowThreadIds = new Set<string>();
        const rowReplyIds = new Set<string>();
        let complete = true;
        for (const comment of record.comments) {
          if (rowThreadIds.has(comment.threadId)) {
            skip("duplicate-thread", message.id);
            complete = false;
            continue;
          }
          rowThreadIds.add(comment.threadId);
          if (earlierThreadIds.has(comment.threadId)) continue;
          if (threadsById.has(comment.threadId)) {
            skip("duplicate-thread", message.id);
            complete = false;
            missingThreadIds.add(comment.threadId);
            continue;
          }
          if (!isAnchorWithinSnapshot(comment.anchor, snapshot.content)) {
            skip("anchor-out-of-range", message.id);
            complete = false;
            missingThreadIds.add(comment.threadId);
            continue;
          }
          const thread: PlanReviewThread = {
            threadId: comment.threadId,
            snapshotId: snapshot.snapshotId,
            anchor: comment.anchor,
            quote: comment.quote,
            body: comment.body,
            feedbackId: record.feedbackId,
            historySequence: feedback.historySequence,
            replies: [],
            resolved: false,
          };
          threadsById.set(thread.threadId, thread);
          state.threads.push(thread);
          feedback.threadIds.push(thread.threadId);
          missingThreadIds.delete(thread.threadId);
        }
        for (const reply of record.replies) {
          if (rowReplyIds.has(reply.replyId)) {
            skip("duplicate-reply", message.id);
            complete = false;
            continue;
          }
          rowReplyIds.add(reply.replyId);
          if (earlierReplyIds.has(reply.replyId)) continue;
          const thread = threadsById.get(reply.threadId);
          if (thread === undefined) {
            skip("dangling-reply-thread", message.id);
            complete = false;
            missingReplyIds.add(reply.replyId);
            continue;
          }
          thread.replies.push({
            replyId: reply.replyId,
            author: "user",
            body: reply.body,
            historySequence: feedback.historySequence,
          });
          acceptedReplyIds.add(reply.replyId);
          missingReplyIds.delete(reply.replyId);
        }
        if (partial === undefined) state.feedbacks.push(feedback);
        if (complete && missingThreadIds.size === 0 && missingReplyIds.size === 0) {
          partialFeedbacks.delete(record.recordId);
          seenRecordIds.add(record.recordId);
        } else {
          partialFeedbacks.set(record.recordId, entry);
        }
        break;
      }
      case "resolve":
      case "reopen": {
        const thread = threadsById.get(record.threadId);
        if (thread === undefined) {
          skip("dangling-resolution-thread", message.id);
          break;
        }
        thread.resolved = record.kind === "resolve";
        seenRecordIds.add(record.recordId);
        break;
      }
    }
  }

  return state;
}
