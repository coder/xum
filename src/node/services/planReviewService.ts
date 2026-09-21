import { createHash, randomUUID } from "node:crypto";

import assert from "@/common/utils/assert";
import type { PlanReviewError } from "@/common/types/errors";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import { isDurableContextResetBoundaryMarker } from "@/common/utils/messages/compactionBoundary";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
} from "@/common/utils/planReview/planReviewEnvelope";
import {
  PLAN_REVIEW_RECORD_VERSION,
  isAnchorWithinSnapshot,
  normalizePlanSnapshotContent,
  type PlanReviewAnchor,
  type PlanReviewFeedbackRecord,
  type PlanReviewRecord,
} from "@/common/utils/planReview/planReviewRecord";
import {
  derivePlanReviewState,
  formatPlanReviewStateBlock,
  type PlanReviewState,
} from "@/common/utils/planReview/planReviewState";
import { MAX_PLAN_SNAPSHOT_BYTES, PLAN_REVIEW_METADATA_TYPE } from "@/constants/planReview";
import {
  createRuntimeForWorkspace,
  type WorkspaceMetadataForRuntime,
} from "@/node/runtime/runtimeHelpers";
import { readPlanFile } from "@/node/utils/runtime/helpers";

import type { HistoryService } from "./historyService";
import { log } from "./log";
import { createPlanReviewRecordMessageId } from "./utils/messageIds";

/**
 * Backend side of native plan review: reads the review projection from chat history and
 * appends record rows. Nothing here touches the `propose_plan` tool; snapshots are taken from
 * the session's tool-completion listener (AgentSession) and on demand (WorkspaceService).
 * Every mutation returns the fresh projection so the UI never composes envelopes itself.
 */

type PlanReviewHistory = Pick<
  HistoryService,
  "iterateFullHistory" | "appendDerivedFromFullHistory"
>;

export interface PlanReviewHistoryDeps {
  historyService: PlanReviewHistory;
  /** Publish an appended record row to live subscribers (non-waking, same as workflow rows). */
  emitChatEvent: (workspaceId: string, message: MuxMessage) => void;
}

export interface EnsurePlanSnapshotArgs {
  workspaceId: string;
  metadata: WorkspaceMetadataForRuntime & { projectName: string };
  /** Tool call id of the `propose_plan` that produced this revision; omitted for on-demand snapshots. */
  proposalToolCallId?: string;
}

export interface EnsurePlanSnapshotResult {
  snapshotId: string;
  contentHash: string;
  /** False when a snapshot with the same content hash already existed (idempotent dedup). */
  created: boolean;
  state: PlanReviewState;
}

export interface SubmitPlanReviewFeedbackInput {
  snapshotId: string;
  summary?: string;
  comments: Array<{ anchor: PlanReviewAnchor; quote: string; body: string }>;
  replies: Array<{ threadId: string; body: string }>;
}

export interface PreparedPlanReviewFeedback {
  feedbackId: string;
  threadIds: string[];
  /** Envelope text to send as the user message. */
  text: string;
  muxMetadata: MuxMessageMetadata;
}

function isPlanReviewRow(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === PLAN_REVIEW_METADATA_TYPE;
}

function skipLogger(workspaceId: string) {
  return (reason: string, messageId: string) =>
    log.debug("plan review: ignoring record row", { workspaceId, reason, messageId });
}

function historyFailed(message: string): PlanReviewError {
  return { type: "history_failed", message };
}

export function hashPlanSnapshotContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Hidden record rows (snapshot/resolve/reopen): synthetic without uiVisible, never a human turn. */
function buildPlanReviewRecordMessage(
  record: Exclude<PlanReviewRecord, PlanReviewFeedbackRecord>
): MuxMessage {
  return createMuxMessage(
    createPlanReviewRecordMessageId(),
    "user",
    formatPlanReviewEnvelope(record),
    {
      timestamp: Date.now(),
      synthetic: true,
      muxMetadata: buildPlanReviewMetadata(record),
    }
  );
}

/** Replay of every record row in history (archive included), across compaction and resets. */
export async function getPlanReviewState(
  historyService: PlanReviewHistory,
  workspaceId: string
): Promise<Result<PlanReviewState, PlanReviewError>> {
  const rows: MuxMessage[] = [];
  const scanned = await historyService.iterateFullHistory(workspaceId, "forward", (chunk) => {
    rows.push(...chunk.filter(isPlanReviewRow));
  });
  if (!scanned.success) return Err(historyFailed(scanned.error));
  return Ok(derivePlanReviewState(rows, { onSkip: skipLogger(workspaceId) }));
}

/**
 * Snapshot the current plan file into history unless a snapshot with the same content hash
 * already exists. Dedup and append happen under one history write lock so a racing on-demand
 * request and the completion hook cannot both persist the same revision.
 */
export async function ensurePlanSnapshot(
  deps: PlanReviewHistoryDeps,
  args: EnsurePlanSnapshotArgs
): Promise<Result<EnsurePlanSnapshotResult, PlanReviewError>> {
  const runtime = createRuntimeForWorkspace(args.metadata);
  const plan = await readPlanFile(
    runtime,
    args.metadata.name,
    args.metadata.projectName,
    args.workspaceId
  );
  if (!plan.exists) {
    return Err({ type: "plan_missing", message: `Plan file not found at ${plan.path}` });
  }
  // CRLF-normalize before hashing/storing so anchor line numbers map 1:1 across platforms.
  const content = normalizePlanSnapshotContent(plan.content);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PLAN_SNAPSHOT_BYTES) {
    return Err({
      type: "plan_too_large",
      message: `Plan file is ${bytes} bytes; snapshots are capped at ${MAX_PLAN_SNAPSHOT_BYTES} bytes`,
    });
  }
  const contentHash = hashPlanSnapshotContent(content);

  let priorRows: MuxMessage[] = [];
  const appended = await deps.historyService.appendDerivedFromFullHistory(
    args.workspaceId,
    (
      messages
    ): {
      message: MuxMessage | null;
      value: { snapshotId: string; message: MuxMessage | null };
    } => {
      priorRows = messages.filter(isPlanReviewRow);
      const state = derivePlanReviewState(priorRows, { onSkip: skipLogger(args.workspaceId) });
      const existing = state.snapshots.find((snapshot) => snapshot.contentHash === contentHash);
      if (existing !== undefined) {
        return { message: null, value: { snapshotId: existing.snapshotId, message: null } };
      }
      const snapshotId = `snap_${randomUUID()}`;
      const message = buildPlanReviewRecordMessage({
        v: PLAN_REVIEW_RECORD_VERSION,
        kind: "snapshot",
        recordId: `rec_${randomUUID()}`,
        snapshotId,
        planPath: plan.path,
        contentHash,
        ...(args.proposalToolCallId !== undefined
          ? { proposalToolCallId: args.proposalToolCallId }
          : {}),
        content,
      });
      return { message, value: { snapshotId, message } };
    }
  );
  if (!appended.success) return Err(historyFailed(appended.error));

  const { snapshotId, message } = appended.data;
  if (message !== null) {
    // The append stamped historySequence on this same object, so the emitted row and the
    // projection below both carry the durable sequence.
    deps.emitChatEvent(args.workspaceId, message);
    priorRows.push(message);
  }
  return Ok({
    snapshotId,
    contentHash,
    created: message !== null,
    state: derivePlanReviewState(priorRows, { onSkip: skipLogger(args.workspaceId) }),
  });
}

/** Resolve/reopen a sent thread; a no-op when the thread is already in the requested state. */
export async function setPlanReviewThreadResolved(
  deps: PlanReviewHistoryDeps,
  args: { workspaceId: string; threadId: string; resolved: boolean }
): Promise<Result<PlanReviewState, PlanReviewError>> {
  let priorRows: MuxMessage[] = [];
  const appended = await deps.historyService.appendDerivedFromFullHistory(
    args.workspaceId,
    (
      messages
    ): { message: MuxMessage | null; value: Result<MuxMessage | null, PlanReviewError> } => {
      priorRows = messages.filter(isPlanReviewRow);
      const state = derivePlanReviewState(priorRows, { onSkip: skipLogger(args.workspaceId) });
      const thread = state.threads.find((candidate) => candidate.threadId === args.threadId);
      if (thread === undefined) {
        return {
          message: null,
          value: Err({ type: "unknown_thread", message: `Unknown thread ${args.threadId}` }),
        };
      }
      if (thread.resolved === args.resolved) {
        return { message: null, value: Ok(null) };
      }
      const message = buildPlanReviewRecordMessage({
        v: PLAN_REVIEW_RECORD_VERSION,
        kind: args.resolved ? "resolve" : "reopen",
        recordId: `rec_${randomUUID()}`,
        threadId: args.threadId,
      });
      return { message, value: Ok(message) };
    }
  );
  if (!appended.success) return Err(historyFailed(appended.error));
  if (!appended.data.success) return appended.data;
  const message = appended.data.data;
  if (message !== null) {
    deps.emitChatEvent(args.workspaceId, message);
    priorRows.push(message);
  }
  return Ok(derivePlanReviewState(priorRows, { onSkip: skipLogger(args.workspaceId) }));
}

/**
 * Validate feedback against the current projection and stamp backend-owned ids. The caller
 * sends `text` through the ordinary user-message path with `muxMetadata`, so the row is a real
 * (non-synthetic) user turn that wakes the plan agent.
 */
export async function preparePlanReviewFeedback(
  historyService: PlanReviewHistory,
  workspaceId: string,
  input: SubmitPlanReviewFeedbackInput
): Promise<Result<PreparedPlanReviewFeedback, PlanReviewError>> {
  if (input.comments.length === 0 && input.replies.length === 0) {
    return Err({
      type: "nothing_to_send",
      message: "Feedback needs at least one comment or reply",
    });
  }
  const stateResult = await getPlanReviewState(historyService, workspaceId);
  if (!stateResult.success) return stateResult;
  const state = stateResult.data;
  const snapshot = state.snapshots.find((candidate) => candidate.snapshotId === input.snapshotId);
  if (snapshot === undefined) {
    return Err({ type: "unknown_snapshot", message: `Unknown snapshot ${input.snapshotId}` });
  }
  for (const comment of input.comments) {
    // Empty bodies are rejected at the oRPC boundary; this guards internal callers.
    assert(comment.body.length > 0, "plan review comment body must be non-empty");
    if (!isAnchorWithinSnapshot(comment.anchor, snapshot.content)) {
      return Err({
        type: "invalid_anchor",
        message: `Anchor ${comment.anchor.startLine}-${comment.anchor.endLine} is outside snapshot ${snapshot.snapshotId}`,
      });
    }
  }
  const knownThreads = new Set(state.threads.map((thread) => thread.threadId));
  for (const reply of input.replies) {
    assert(reply.body.length > 0, "plan review reply body must be non-empty");
    if (!knownThreads.has(reply.threadId)) {
      return Err({ type: "unknown_thread", message: `Unknown thread ${reply.threadId}` });
    }
  }

  const feedbackId = `fb_${randomUUID()}`;
  const record: PlanReviewFeedbackRecord = {
    v: PLAN_REVIEW_RECORD_VERSION,
    kind: "feedback",
    recordId: `rec_${randomUUID()}`,
    feedbackId,
    snapshotId: snapshot.snapshotId,
    contentHash: snapshot.contentHash,
    ...(input.summary !== undefined && input.summary.trim().length > 0
      ? { summary: input.summary }
      : {}),
    comments: input.comments.map((comment) => ({
      threadId: `thr_${randomUUID()}`,
      anchor: comment.anchor,
      quote: comment.quote,
      body: comment.body,
    })),
    replies: input.replies.map((reply) => ({
      replyId: `rpl_${randomUUID()}`,
      threadId: reply.threadId,
      body: reply.body,
    })),
  };
  return Ok({
    feedbackId,
    threadIds: record.comments.map((comment) => comment.threadId),
    text: formatPlanReviewEnvelope(record),
    muxMetadata: buildPlanReviewMetadata(record),
  });
}

/**
 * `<plan-review-state>` block for a plan-mode request: unresolved threads derived from durable
 * rows AFTER the latest durable context reset (a reset is a privacy floor, so pre-reset threads
 * stay out of the model's context even though getState still returns them). Never throws —
 * a history read failure must not block a send — and returns undefined when nothing is
 * unresolved.
 */
export async function buildPlanReviewStateInstruction(
  historyService: PlanReviewHistory,
  workspaceId: string
): Promise<string | undefined> {
  const newestFirst: MuxMessage[] = [];
  try {
    const scanned = await historyService.iterateFullHistory(workspaceId, "backward", (chunk) => {
      for (const message of chunk) {
        if (isDurableContextResetBoundaryMarker(message)) return false;
        if (isPlanReviewRow(message)) newestFirst.push(message);
      }
      return true;
    });
    if (!scanned.success) throw new Error(scanned.error);
  } catch (error) {
    log.warn("plan review: could not read history for the plan-review-state block", {
      workspaceId,
      error,
    });
    return undefined;
  }
  if (newestFirst.length === 0) return undefined;
  const state = derivePlanReviewState(newestFirst.reverse(), { onSkip: skipLogger(workspaceId) });
  return formatPlanReviewStateBlock(state);
}
