import { createHash, randomUUID } from "node:crypto";

import assert from "@/common/utils/assert";
import type { PlanReviewError } from "@/common/types/errors";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import {
  createMuxMessage,
  getCompactionFollowUpContent,
  isCompactionSummaryMetadata,
  pickPreservedSendOptions,
  pickStartupRetrySendOptions,
} from "@/common/types/message";
import { Err, Ok, type Result } from "@/common/types/result";
import {
  buildPlanReviewMetadata,
  formatPlanReviewEnvelope,
  getAuthenticPlanReviewRecord,
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
  type PlanReviewState,
} from "@/common/utils/planReview/planReviewState";
import { SESSION_HISTORY_MAX_LINE_BYTES } from "@/common/constants/contextBudget";
import {
  MAX_PLAN_SNAPSHOT_BYTES,
  PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES,
  PLAN_REVIEW_MAX_QUOTE_CHARS,
  PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS,
  PLAN_REVIEW_METADATA_TYPE,
  PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS,
} from "@/constants/planReview";
import {
  createRuntimeForWorkspace,
  type WorkspaceMetadataForRuntime,
} from "@/node/runtime/runtimeHelpers";
import { getLegacyPlanFilePath, getPlanFilePath } from "@/common/utils/planStorage";
import { execBuffered, readPlanFile } from "@/node/utils/runtime/helpers";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { isDockerRuntime, isSSHRuntime } from "@/common/types/runtime";

import type { HistoryService } from "./historyService";
import { log } from "./log";
import { createPlanReviewRecordMessageId, createUserMessageId } from "./utils/messageIds";

/**
 * Backend side of native plan review: reads the review projection from chat history and
 * appends record rows. Nothing here touches the `propose_plan` tool; snapshots are taken from
 * the session's tool-completion listener (AgentSession) and on demand (WorkspaceService).
 * Every mutation returns the fresh projection so the UI never composes envelopes itself.
 */

type PlanReviewHistory = Pick<
  HistoryService,
  "iterateFullHistory" | "appendDerivedFromFullHistory" | "captureCompactionReplacement"
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
  /**
   * Abandons the capture: checked before the (possibly remote, slow) plan read, after it, and
   * again at append admission under the history lock, so a capture whose turn already settled
   * or stopped can never publish a late row.
   */
  signal?: AbortSignal;
  /**
   * Context generation the capture is admitted under, read again at append time. A turn-owned
   * capture passes its turn's live admission capture, which follows the turn's own context
   * rollovers. When omitted (on-demand), the generation is read before the plan read.
   */
  frontier?: { readonly generation: string | undefined };
  /**
   * The exact plan bytes the proposal read and validated (turn-owned captures, handed over by
   * propose_plan through a backend-owned callback). When set, the mutable plan file is not
   * re-read, so an edit after the proposal cannot be snapshotted as the proposal.
   */
  proposedContent?: string;
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

/**
 * Refusal for plan-review metadata on a generic send or a client-supplied history row (see
 * carriesPlanReviewMetadata).
 */
export const PLAN_REVIEW_METADATA_RESERVED_MESSAGE =
  "Plan review records can only be created through the plan review actions, not sent as a message or written into chat history.";

/**
 * Whether client-supplied muxMetadata (send options, or a row written through
 * workspace.replaceChatHistory) would persist a plan-review row: directly, as the nested
 * follow-up of a compaction request that dispatches after compaction, or as a compaction
 * summary's pending follow-up that recovery dispatches. Only the dedicated endpoints
 * (planReviewSubmitFeedback and the record appends in this module) may write such rows; a
 * generic write carrying the discriminator plus a matching envelope would otherwise persist an
 * authentic record that skipped their validation. Accepts any value: clients supply muxMetadata
 * as an unvalidated black box.
 */
export function carriesPlanReviewMetadata(muxMetadata: unknown): boolean {
  // Compaction recovery redispatches each nested follow-up straight through AgentSession, past
  // this guard, so the whole follow-up chain is inspected. A chain deeper than any real one
  // (or a cycle) fails closed: it is refused as if it carried the discriminator.
  let current: unknown = muxMetadata;
  for (let depth = 0; depth <= PLAN_REVIEW_FOLLOW_UP_MAX_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const metadata = current as MuxMessageMetadata;
    if (metadata.type === PLAN_REVIEW_METADATA_TYPE) return true;
    current = isCompactionSummaryMetadata(metadata)
      ? metadata.pendingFollowUp?.muxMetadata
      : getCompactionFollowUpContent(metadata)?.muxMetadata;
  }
  return true;
}

/** Nesting bound for carriesPlanReviewMetadata; real follow-up chains are one level deep. */
const PLAN_REVIEW_FOLLOW_UP_MAX_DEPTH = 8;

function isPlanReviewRow(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === PLAN_REVIEW_METADATA_TYPE;
}

/** Backend projection options: skip logging plus the sha256 verification the shared projection cannot import. */
function deriveOptions(workspaceId: string) {
  return {
    onSkip: (reason: string, messageId: string) =>
      log.debug("plan review: ignoring record row", { workspaceId, reason, messageId }),
    hashContent: hashPlanSnapshotContent,
  };
}

function historyFailed(message: string): PlanReviewError {
  return { type: "history_failed", message };
}

/** Cut to at most `maxChars` UTF-16 units, marking the cut and never splitting a surrogate pair. */
function truncatePlanReviewText(text: string, maxChars: number): string {
  assert(maxChars > 1, "plan review truncation cap must leave room for the marker");
  if (text.length <= maxChars) return text;
  let end = maxChars - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function hashPlanSnapshotContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Size of `message` as HistoryService would persist it: message + workspaceId, with a
 * widest-case sequence stamp. Record text is JSON-escaped once in the envelope and again in the
 * JSONL row, so content under a raw cap (quotes, backslashes, control characters) can still
 * exceed the row limit — and the provider/replacement-row scanners treat such a row as an
 * unreadable run, so it must be refused before it is written.
 */
function measurePersistedRowBytes(message: MuxMessage, workspaceId: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...message,
      workspaceId,
      metadata: { ...message.metadata, historySequence: Number.MAX_SAFE_INTEGER },
    }),
    "utf8"
  );
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
  return Ok(derivePlanReviewState(rows, deriveOptions(workspaceId)));
}

function captureAborted(): PlanReviewError {
  return { type: "capture_aborted", message: "Plan snapshot capture aborted" };
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
  if (args.signal?.aborted) return Err(captureAborted());
  // Admission contract, re-checked at the append under the history write lock. That lock is an
  // in-process mutex plus a cross-process lockfile every backend on this Xum home takes
  // (acquireProcessFileLock; a live holder is never reclaimed), so it also fences sibling
  // backends (XUM_ALLOW_MULTIPLE_INSTANCES) whose in-memory state this process cannot see.
  // 1. Generation: no destructive history mutation committed since the capture's frontier. Every
  //    full clear and non-compaction destructive replace (empty history included, via the Stop
  //    publication they run through), reset, and compaction replace of non-empty history
  //    advances it under that lock; ordinary appends and compaction boundaries leave it alone (a
  //    Stop or an active-context cut also advances it, which only refuses conservatively).
  // 2. Existence: the plan file must still exist. A full clear and every replaceHistory with
  //    deletePlanFile unlink the plan BEFORE their history commit, so bytes read earlier cannot
  //    land after it. This is the whole fence where the generation stays put: a
  //    compaction-boundary replace, or a compaction replace over already-empty history.
  //    Existence, not equality: a proposal capture keeps the proposed bytes by design, even when
  //    the plan was edited after the proposal.
  // Accepted residual: where the generation stays put, a NEW plan written after the replace lets
  // a capture that read the old plan before it append a snapshot of the old bytes beside the new
  // plan. Snapshot rows are hidden from the model (isPlanReviewRecordMessage); only the review
  // panel shows it.
  // Never hold the lock across the (possibly remote) plan read itself; the existence check is one
  // bounded probe of the two plan paths (probePlanExistence).
  let frontier: { readonly generation: string | undefined };
  if (args.frontier !== undefined) {
    frontier = args.frontier;
  } else {
    const captured = await deps.historyService.captureCompactionReplacement(args.workspaceId);
    if (!captured.success) return Err(historyFailed(captured.error));
    frontier = { generation: captured.data.generation };
  }
  const runtime = createRuntimeForWorkspace(args.metadata);
  const plan =
    args.proposedContent !== undefined
      ? {
          exists: true,
          content: args.proposedContent,
          // The same resolved path readPlanFile reports.
          path: await runtime.resolvePath(
            getPlanFilePath(args.metadata.name, args.metadata.projectName, runtime.getXumHome())
          ),
        }
      : await readPlanFile(
          runtime,
          args.metadata.name,
          args.metadata.projectName,
          args.workspaceId
        );
  if (args.signal?.aborted) return Err(captureAborted());
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
  // Build the candidate row up front so its PERSISTED size can be judged (see
  // measurePersistedRowBytes). Discarded when the locked dedup below finds the same hash.
  const candidateSnapshotId = `snap_${randomUUID()}`;
  const candidate = buildPlanReviewRecordMessage({
    v: PLAN_REVIEW_RECORD_VERSION,
    kind: "snapshot",
    recordId: `rec_${randomUUID()}`,
    snapshotId: candidateSnapshotId,
    planPath: plan.path,
    contentHash,
    ...(args.proposalToolCallId !== undefined
      ? { proposalToolCallId: args.proposalToolCallId }
      : {}),
    content,
  });
  const rowBytes = measurePersistedRowBytes(candidate, args.workspaceId);
  if (rowBytes > SESSION_HISTORY_MAX_LINE_BYTES) {
    return Err({
      type: "plan_too_large",
      message: `Plan snapshot row would be ${rowBytes} bytes; history rows are capped at ${SESSION_HISTORY_MAX_LINE_BYTES} bytes`,
    });
  }

  const xumHome = runtime.getXumHome();
  const planPaths = [
    getPlanFilePath(args.metadata.name, args.metadata.projectName, xumHome),
    // readPlanFile falls back to (and migrates) the legacy path, so it still counts as the plan.
    getLegacyPlanFilePath(args.workspaceId, xumHome),
  ];
  // Same split as WorkspaceService.deletePlanFilesForWorkspace: SSH and Docker plans are reached
  // through a remote shell, everything else through runtime.stat (host paths, or a devcontainer's
  // mounted/exec'd view).
  const remotePlan =
    isSSHRuntime(args.metadata.runtimeConfig) || isDockerRuntime(args.metadata.runtimeConfig);
  const probe = async (signal: AbortSignal): Promise<"exists" | "missing" | "unconfirmed"> => {
    if (!remotePlan) {
      for (const planPath of planPaths) {
        try {
          if (!(await runtime.stat(planPath, signal)).isDirectory) return "exists";
        } catch {
          // Missing: not a plan.
        }
      }
      return "missing";
    }
    // SSH/Docker: both paths in ONE exec, so the lock waits one round trip; pathEnv
    // canonicalizes them per runtime (tilde, remote home, container paths).
    const result = await execBuffered(
      runtime,
      'for p in "$XUM_PLAN" "$XUM_LEGACY_PLAN"; do [ -e "$p" ] && [ ! -d "$p" ] && exit 0; done; exit 1',
      {
        cwd: "/tmp",
        pathEnv: { XUM_PLAN: planPaths[0], XUM_LEGACY_PLAN: planPaths[1] },
        timeout: Math.ceil(PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS / 1000),
        abortSignal: signal,
        maxOutputBytes: 1024,
      }
    );
    return result.exitCode === 0 ? "exists" : result.exitCode === 1 ? "missing" : "unconfirmed";
  };
  // Runs under the cross-process history write lock, so it is bounded (raced, in case a runtime
  // ignores its signal), follows the capture's signal, and FAILS CLOSED: an aborted, timed-out
  // or failed probe refuses the capture instead of skipping the check.
  const probePlanExistence = async (): Promise<"exists" | "missing" | "unconfirmed"> => {
    const cancelProbe = new AbortController();
    try {
      const raced = await raceWithAbortAndTimeout(probe(cancelProbe.signal), {
        signal: args.signal,
        timeoutMs: PLAN_SNAPSHOT_EXISTENCE_PROBE_TIMEOUT_MS,
      });
      return raced.kind === "ok" ? raced.value : "unconfirmed";
    } catch {
      return "unconfirmed";
    } finally {
      cancelProbe.abort();
    }
  };

  let priorRows: MuxMessage[] = [];
  const appended = await deps.historyService.appendDerivedFromFullHistory(
    args.workspaceId,
    async (
      messages,
      lockState
    ): Promise<{
      message: MuxMessage | null;
      value: { snapshotId: string; message: MuxMessage | null } | "aborted" | "plan_missing";
    }> => {
      // Admission check under the lock: the read above may have taken long enough for the
      // owning turn to settle or stop, and a late row must not be published after that.
      if (args.signal?.aborted) return { message: null, value: "aborted" };
      if (lockState.generation !== frontier.generation) {
        return { message: null, value: "aborted" };
      }
      const existence = await probePlanExistence();
      if (existence === "missing") return { message: null, value: "plan_missing" };
      if (existence !== "exists") return { message: null, value: "aborted" };
      priorRows = messages.filter(isPlanReviewRow);
      const state = derivePlanReviewState(priorRows, deriveOptions(args.workspaceId));
      const existing = state.snapshots.find((snapshot) => snapshot.contentHash === contentHash);
      if (existing !== undefined) {
        return { message: null, value: { snapshotId: existing.snapshotId, message: null } };
      }
      return { message: candidate, value: { snapshotId: candidateSnapshotId, message: candidate } };
    }
  );
  if (!appended.success) return Err(historyFailed(appended.error));
  if (appended.data === "aborted") return Err(captureAborted());
  if (appended.data === "plan_missing") {
    return Err({ type: "plan_missing", message: `Plan file was deleted: ${plan.path}` });
  }

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
    state: derivePlanReviewState(priorRows, deriveOptions(args.workspaceId)),
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
      const state = derivePlanReviewState(priorRows, deriveOptions(args.workspaceId));
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
  return Ok(derivePlanReviewState(priorRows, deriveOptions(args.workspaceId)));
}

/**
 * Validate feedback against the current projection and stamp backend-owned ids. The caller
 * sends `text` through the ordinary user-message path with `muxMetadata`, so the row is a real
 * (non-synthetic) user turn that wakes the plan agent.
 */
export async function preparePlanReviewFeedback(
  historyService: PlanReviewHistory,
  workspaceId: string,
  input: SubmitPlanReviewFeedbackInput,
  /** The send options the caller will pass to sendMessage; they are persisted on the row too. */
  options: SendMessageOptions
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
  const knownThreads = new Map(state.threads.map((thread) => [thread.threadId, thread]));
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
    replies: input.replies.map((reply) => {
      const thread = knownThreads.get(reply.threadId);
      assert(thread !== undefined, "plan review reply thread was validated above");
      return {
        replyId: `rpl_${randomUUID()}`,
        threadId: reply.threadId,
        body: reply.body,
        // Threads are discovered from full history, but a thread opened before a context reset
        // is no longer in the provider request; repeat its context so the reply stays
        // meaningful. Always included (no boundary detection), and bounded: the thread comes
        // from persisted rows, whose quote/body were never capped on replay.
        thread: {
          anchor: thread.anchor,
          quote: truncatePlanReviewText(thread.quote, PLAN_REVIEW_MAX_QUOTE_CHARS),
          comment: truncatePlanReviewText(thread.body, PLAN_REVIEW_MAX_REPLY_THREAD_COMMENT_CHARS),
        },
      };
    }),
  };
  const text = formatPlanReviewEnvelope(record);
  const muxMetadata = buildPlanReviewMetadata(record);
  // Per-field caps hold at the oRPC boundary, but the persisted row is the double-escaped
  // envelope PLUS the send options sendMessage stamps on it (toolPolicy and the startup-retry
  // snapshot, whose additionalSystemInstructions/providerOptions are unbounded); refuse before
  // sendMessage writes a row the history scanners would skip as unreadable (which would also
  // silently drop the user's feedback from provider requests).
  // AgentSession also stamps the (trimmed, otherwise unbounded) ACP prompt id on the user row and
  // on an on-send compaction request row, so it counts toward both shapes below.
  const acpPromptId =
    typeof options.acpPromptId === "string" && options.acpPromptId.trim().length > 0
      ? options.acpPromptId.trim()
      : undefined;
  const rowBytes = measurePersistedRowBytes(
    createMuxMessage(createUserMessageId(), "user", text, {
      timestamp: Date.now(),
      toolPolicy: options.toolPolicy,
      retrySendOptions: pickStartupRetrySendOptions(options),
      ...(acpPromptId !== undefined ? { acpPromptId } : {}),
      muxMetadata,
    }),
    workspaceId
  );
  // When the send trips on-send auto-compaction, the persisted row is the compaction REQUEST,
  // which carries the envelope twice (prompt text and metadata.parsed.followUpContent.text) and
  // the send options twice (retrySendOptions and the follow-up's preserved options), and the
  // later summary boundary carries the follow-up again beside the model's summary. Budget that
  // larger derived shape — the ordinary row plus a second escaped copy of the envelope and of the
  // preserved options — so no row the feedback can produce exceeds the history line limit (an
  // oversized boundary row would make provider-history boundary detection fall back to the
  // previous boundary).
  const derivedRowBytes =
    rowBytes +
    Buffer.byteLength(JSON.stringify(text), "utf8") +
    Buffer.byteLength(JSON.stringify(pickPreservedSendOptions(options)), "utf8");
  const maxRowBytes = SESSION_HISTORY_MAX_LINE_BYTES - PLAN_REVIEW_FEEDBACK_ROW_HEADROOM_BYTES;
  if (derivedRowBytes > maxRowBytes) {
    return Err({
      type: "feedback_too_large",
      message: `Feedback would persist rows of up to ${derivedRowBytes} bytes; plan review feedback is capped at ${maxRowBytes} bytes per submission`,
    });
  }
  return Ok({
    feedbackId,
    threadIds: record.comments.map((comment) => comment.threadId),
    text,
    muxMetadata,
  });
}

/**
 * The authentic feedback row `message` would put into review state: the row itself, or the
 * nested follow-up of an on-send compaction request, which dispatches as that row later.
 */
export function carriedPlanReviewFeedback(message: MuxMessage): MuxMessage | null {
  if (getAuthenticPlanReviewRecord(message)?.kind === "feedback") return message;
  const followUp = getCompactionFollowUpContent(message.metadata?.muxMetadata);
  if (followUp?.muxMetadata?.type !== PLAN_REVIEW_METADATA_TYPE) return null;
  const nested = createMuxMessage(message.id, "user", followUp.text, {
    muxMetadata: followUp.muxMetadata,
  });
  return getAuthenticPlanReviewRecord(nested)?.kind === "feedback" ? nested : null;
}

/**
 * Append precondition for rows that carry plan-review feedback (see
 * HistoryService.acceptCompactionReplacement's `admitsFullHistory`), or undefined when `batch`
 * carries none.
 *
 * Feedback binds snapshot and thread ids read before the send, and a clear or truncation (this
 * window, another window, or a sibling backend) can remove them before the row is written. The
 * projection would then skip the row as dangling while the transcript shows it as sent. The
 * precondition is the projection's own acceptance rule, evaluated under the history write lock
 * at the actual append: the feedback must be accepted with every comment thread and every reply.
 * It runs for the compaction request that defers feedback and again when the follow-up lands.
 */
export function createPlanReviewFeedbackPrecondition(
  batch: readonly MuxMessage[]
): ((history: MuxMessage[]) => boolean) | undefined {
  const carried = batch.flatMap((message) => carriedPlanReviewFeedback(message) ?? []);
  if (carried.length === 0) return undefined;
  return (history) => {
    const prior = history.filter(isPlanReviewRow);
    const options = { hashContent: hashPlanSnapshotContent };
    const priorState = derivePlanReviewState(prior, options);
    return carried.every((candidate) => {
      const record = getAuthenticPlanReviewRecord(candidate);
      assert(record?.kind === "feedback", "carried plan-review feedback must stay authentic");
      // History already holding this feedback fully accepted means another dispatch (e.g. a
      // sibling backend recovering the same compaction follow-up) appended it first; the check
      // below would pass on that copy alone and start a duplicate model turn. A PARTIAL earlier
      // copy (a damaged crash duplicate) is not refused: this intact candidate is what lets the
      // projection fill in its missing items. Only plan-review rows are in `prior`, so the
      // compaction request and summary that carry the deferred follow-up never count here.
      if (isFeedbackFullyAccepted(priorState, record)) return false;
      return isFeedbackFullyAccepted(derivePlanReviewState([...prior, candidate], options), record);
    });
  };
}

/** Whether `state` holds `record` with every comment thread and every reply accepted. */
function isFeedbackFullyAccepted(
  state: PlanReviewState,
  record: PlanReviewFeedbackRecord
): boolean {
  const feedback = state.feedbacks.find((entry) => entry.feedbackId === record.feedbackId);
  if (feedback === undefined || feedback.threadIds.length !== record.comments.length) return false;
  return record.replies.every((reply) =>
    state.threads.some(
      (thread) =>
        thread.threadId === reply.threadId &&
        thread.replies.some((entry) => entry.replyId === reply.replyId)
    )
  );
}
