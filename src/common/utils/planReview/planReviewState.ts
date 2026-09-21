import { z } from "zod";

import type { MuxMessage } from "@/common/types/message";
import {
  PLAN_REVIEW_STATE_MAX_CHARS,
  PLAN_REVIEW_STATE_MAX_REPLIES_PER_THREAD,
  PLAN_REVIEW_STATE_MAX_TEXT_CHARS,
  PLAN_REVIEW_STATE_MAX_THREADS,
} from "@/constants/planReview";
import { getAuthenticPlanReviewRecord } from "./planReviewEnvelope";
import { PlanReviewAnchorSchema, isAnchorWithinSnapshot } from "./planReviewRecord";

/**
 * Pure projection of plan-review record rows into review state. Shared by the backend (oRPC
 * endpoints, plan-agent context) and the frontend (Run 2 review UI), so it must stay free of
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
 * Compaction tail copies and duplicate recordIds are inert.
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
    if (seenRecordIds.has(record.recordId)) {
      skip("duplicate-record", message.id);
      continue;
    }
    seenRecordIds.add(record.recordId);
    // Rows persisted by the backend always carry a sequence; fall back to the visiting index
    // so relative order survives for rows that have not been stamped yet.
    const historySequence = message.metadata.historySequence ?? index;

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
        break;
      }
      case "feedback": {
        const snapshot = snapshotsById.get(record.snapshotId);
        if (snapshot === undefined || snapshot.contentHash !== record.contentHash) {
          skip("dangling-feedback-snapshot", message.id);
          break;
        }
        const threadIds: string[] = [];
        for (const comment of record.comments) {
          if (threadsById.has(comment.threadId)) {
            skip("duplicate-thread", message.id);
            continue;
          }
          if (!isAnchorWithinSnapshot(comment.anchor, snapshot.content)) {
            skip("anchor-out-of-range", message.id);
            continue;
          }
          const thread: PlanReviewThread = {
            threadId: comment.threadId,
            snapshotId: snapshot.snapshotId,
            anchor: comment.anchor,
            quote: comment.quote,
            body: comment.body,
            feedbackId: record.feedbackId,
            historySequence,
            replies: [],
            resolved: false,
          };
          threadsById.set(thread.threadId, thread);
          state.threads.push(thread);
          threadIds.push(thread.threadId);
        }
        for (const reply of record.replies) {
          const thread = threadsById.get(reply.threadId);
          if (thread === undefined) {
            skip("dangling-reply-thread", message.id);
            continue;
          }
          thread.replies.push({
            replyId: reply.replyId,
            author: "user",
            body: reply.body,
            historySequence,
          });
        }
        state.feedbacks.push({
          feedbackId: record.feedbackId,
          snapshotId: snapshot.snapshotId,
          threadIds,
          historySequence,
        });
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
        break;
      }
    }
  }

  return state;
}

export function getUnresolvedPlanReviewThreads(state: PlanReviewState): PlanReviewThread[] {
  return state.threads.filter((thread) => !thread.resolved);
}

/** Latest snapshot in history order, or undefined before the first proposal. */
export function getLatestPlanReviewSnapshot(
  state: PlanReviewState
): PlanReviewSnapshot | undefined {
  return state.snapshots[state.snapshots.length - 1];
}

/**
 * Keep user text single-line, bounded and unable to close the block it is quoted in. Clipping
 * happens before JSON quoting, so escape expansion of hostile input (control characters,
 * quotes) cannot exceed the per-text budget by more than the escape factor; the whole-block
 * budget below is checked on the final quoted lines.
 */
function quoteForBlock(text: string, maxChars: number = PLAN_REVIEW_STATE_MAX_TEXT_CHARS): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)} …[truncated]` : text;
  return JSON.stringify(clipped).replaceAll("</", "<\\/");
}

/** Sequence of the newest user activity on a thread: its opening comment or latest reply. */
function latestActivity(thread: PlanReviewThread): number {
  return thread.replies.reduce(
    (latest, reply) => Math.max(latest, reply.historySequence),
    thread.historySequence
  );
}

/**
 * Deterministic review context for the plan agent, derived from durable rows on every turn
 * (never stored, independent of compaction summaries). Returns undefined when nothing is
 * unresolved so the block only appears while there is something to address.
 *
 * Rendering is bounded in three ways and always says what it left out: at most `maxThreads`
 * threads, chosen by most recent user activity (a stale unchecked thread cannot starve newer
 * feedback); each quoted text clipped to PLAN_REVIEW_STATE_MAX_TEXT_CHARS and each thread's
 * reply tail to PLAN_REVIEW_STATE_MAX_REPLIES_PER_THREAD; and the whole block capped at
 * PLAN_REVIEW_STATE_MAX_CHARS. Stored feedback is never altered — only this projection is.
 */
export function formatPlanReviewStateBlock(
  state: PlanReviewState,
  maxThreads: number = PLAN_REVIEW_STATE_MAX_THREADS,
  maxChars: number = PLAN_REVIEW_STATE_MAX_CHARS
): string | undefined {
  const unresolved = getUnresolvedPlanReviewThreads(state);
  if (unresolved.length === 0) return undefined;
  const latest = getLatestPlanReviewSnapshot(state);
  // Most recent activity first; ties break on the deterministic thread id.
  const candidates = [...unresolved]
    .sort(
      (a, b) =>
        latestActivity(b) - latestActivity(a) ||
        b.historySequence - a.historySequence ||
        a.threadId.localeCompare(b.threadId)
    )
    .slice(0, maxThreads);
  const header: string[] = [
    "<plan-review-state>",
    "The user reviews proposed plans inline. Every unresolved thread below still needs to be addressed in the plan; only the user can resolve a thread, so never claim one is resolved.",
    "Line numbers refer to the snapshot the thread was written against (identified by its sha256), which may differ from the current plan file — locate the passage by its quote.",
    "Threads are listed most recent user activity first; each lists the opening comment and the newest replies in order.",
  ];
  if (latest !== undefined) {
    header.push(`Current plan snapshot: sha256 ${latest.contentHash} (${latest.planPath})`);
  }
  header.push(`Unresolved threads: ${unresolved.length}`);
  const footer = "</plan-review-state>";
  const truncationNote = (omitted: number) =>
    `Truncated: ${omitted} more unresolved thread(s) are not listed; ask the user if you need them.`;
  // Reserve room for the worst-case truncation note and the closing tag up front so a thread is
  // only admitted when the complete block still fits.
  let used =
    header.join("\n").length + 1 + truncationNote(unresolved.length).length + 1 + footer.length;
  const body: string[] = [];
  let shown = 0;
  for (const thread of candidates) {
    const revision =
      latest !== undefined && thread.snapshotId === latest.snapshotId
        ? "current snapshot"
        : `earlier snapshot ${state.snapshots.find((s) => s.snapshotId === thread.snapshotId)?.contentHash.slice(0, 12) ?? "?"}`;
    const lines = [
      `- thread ${thread.threadId} · ${revision} · lines ${thread.anchor.startLine}-${thread.anchor.endLine}`,
      `  quote: ${quoteForBlock(thread.quote)}`,
      `  comment: ${quoteForBlock(thread.body)}`,
    ];
    const omittedReplies = Math.max(
      0,
      thread.replies.length - PLAN_REVIEW_STATE_MAX_REPLIES_PER_THREAD
    );
    if (omittedReplies > 0)
      lines.push(`  (${omittedReplies} earlier repl${omittedReplies === 1 ? "y" : "ies"} omitted)`);
    for (const reply of thread.replies.slice(omittedReplies)) {
      lines.push(`  reply: ${quoteForBlock(reply.body)}`);
    }
    const cost = lines.join("\n").length + 1;
    if (used + cost > maxChars) break;
    used += cost;
    body.push(...lines);
    shown += 1;
  }
  const lines = [...header, ...body];
  if (shown < unresolved.length) lines.push(truncationNote(unresolved.length - shown));
  lines.push(footer);
  return lines.join("\n");
}
