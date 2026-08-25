import * as fs from "fs/promises";
import * as path from "path";
import writeFileAtomic from "write-file-atomic";
import assert from "@/common/utils/assert";
import {
  toGoalSnapshot,
  toPendingGoalSnapshot,
  type GoalHistoryEndReason,
  type GoalHistoryEntry,
  type GoalRecordV1,
  type GoalSetError,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import type { WorkspaceActivitySnapshot } from "@/common/types/workspace";
import type { Workspace } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  GoalBoardV1Schema,
  GoalHistoryEntrySchema,
  GoalRecordV1Schema,
} from "@/common/orpc/schemas/goal";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalBoardV1 } from "@/common/types/goal";
import {
  createMuxMessage,
  isSyntheticSnapshotUserMessage,
  pickStartupRetrySendOptions,
} from "@/common/types/message";
import type { ProvidersConfigMap, SendMessageOptions } from "@/common/orpc/types";
import { isWorkspaceArchived } from "@/common/utils/archive";
import {
  hasBudgetedResumableGoal,
  hasGoalBudgetLimit,
  modelHasPricingData,
  normalizeGoalBudgetCents,
  UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
} from "@/common/utils/goals/budgetPricing";
import type { SendMessageError } from "@/common/types/errors";
import type { Config } from "@/node/config";
import type { HistoryService } from "@/node/services/historyService";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { workspaceFileLocks } from "@/node/utils/concurrency/workspaceFileLocks";
import {
  DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS,
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
  GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
  GOAL_CONTINUATION_KIND,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import { buildGoalBudgetLimitMessage, buildGoalContinuationMessage } from "@/constants/goalPrompts";
import type { IdleDispatcher, IdleDispatchPayload } from "./idleDispatcher";
import { log } from "./log";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "./timelineRecorder";

const GOAL_FILE = "goal.json";
const GOAL_BOARD_FILE = "goal-board.json";
const PENDING_GOAL_EDIT_MESSAGE =
  "Goal is still being saved. Wait for the current stream to finish before editing it.";
const REPLACE_GUARDED_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "active",
  "budget_limited",
  "paused",
]);

const GOAL_HISTORY_FILE = "goal-history.jsonl";
// Cap the number of history entries returned to the renderer. Goal lifecycles
// are coarse-grained (one entry per clear / replace / mark-complete) so a
// generous cap still keeps the response payload bounded; older entries remain
// on disk in the JSONL but are simply not surfaced to the UI.
const GOAL_HISTORY_RENDER_CAP = 200;
const MICRO_CENTS_PER_CENT = 1_000_000;

function costUsdToMicroCents(costUsd: number | null | undefined): number {
  return Math.max(0, Math.round((costUsd ?? 0) * 100 * MICRO_CENTS_PER_CENT));
}

/**
 * Returns the goal's accumulated cost in micro-cents, falling back to the
 * coarser `costCents` field for goals persisted before micro-cent tracking
 * was added.
 */
function getGoalCostMicroCents(goal: GoalRecordV1): number {
  return goal.costMicroCents ?? goal.costCents * MICRO_CENTS_PER_CENT;
}

type GoalLifecycleEvent =
  | "goal_created"
  | "goal_replaced"
  | "goal_cleared"
  | "goal_paused"
  | "goal_resumed"
  | "goal_completed"
  | "goal_budget_changed"
  | "goal_budget_limited"
  | "goal_continuation_fired"
  | "goal_wrapup_fired"
  | "goal_crash_gate_set";

type GoalLifecycleProperties = Record<string, string | number | boolean | null>;
type GoalLifecycleInitiator = "user" | "model" | "auto";

export interface GoalLifecycleAnalyticsSink {
  recordGoalLifecycleEvent(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void;
}

interface SetGoalReplacementGuard {
  replaceExistingGoal?: boolean | null;
  expectedGoalId?: string | null;
}

export interface SetGoalInput {
  workspaceId: string;
  objective?: string | null;
  status?: GoalStatus | null;
  budgetCents?: number | null;
  turnCap?: number | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  /**
   * Internal model-tool guard for replacing active-like goals. It is checked
   * under the goal file lock so stale pre-reads cannot authorize a replace.
   */
  replacementGuard?: SetGoalReplacementGuard | null;
  requireUserAcknowledgmentSinceMs?: number | null;
  initiator?: GoalLifecycleInitiator;
  /**
   * Internal model-tool path: treat an objective payload as "start a new goal"
   * even when the objective text matches the current goal.
   */
  forceNewGoal?: boolean | null;
  /**
   * When true and a current goal already exists, an objective update mutates
   * the existing record in place (preserving goalId + accounting) instead of
   * archiving + replacing. See the matching field on the public
   * `GoalSetInputSchema` for the rationale.
   */
  editInPlace?: boolean | null;
}

export type GoalContinuationSkipReason =
  | "not_registered"
  | "no_pending_candidate"
  | "workspace_not_found"
  | "archived"
  | "transcript_only"
  | "initializing"
  | "incompatible_runtime"
  | "child_workspace"
  | "active_descendant_tasks"
  | "currently_streaming"
  | "queued_user_input"
  | "pending_follow_up"
  | "plan_mode"
  | "compact_mode"
  | "user_stop"
  | "goal_missing"
  | "goal_mismatch"
  | "goal_not_active"
  | "requires_ack"
  | "budget_wrapup_already_fired"
  | "budget_wrapup_suppressed"
  | "cooldown";

export interface GoalContinuationRuntimeState {
  isInitializing?: boolean;
  isRuntimeCompatible?: boolean;
  isBusy?: boolean;
  hasQueuedMessages?: boolean;
  hasPendingFollowUp?: boolean;
}

export interface GoalContinuationRuntimeBridge {
  hasActiveDescendantTasks(workspaceId: string): boolean;
  getRuntimeState(workspaceId: string): GoalContinuationRuntimeState;
  executeGoalContinuation(input: {
    workspaceId: string;
    message: string;
    options: SendMessageOptions;
    startStreamInBackground?: boolean;
    kind?: GoalSyntheticMessageKind;
  }): Promise<boolean>;
  /**
   * Build default SendMessageOptions for a kickoff continuation that is armed
   * outside of a stream-end (e.g. when the user resumes a paused goal on an
   * idle workspace). Returns null when defaults can't be derived.
   */
  getKickoffSendOptions?(workspaceId: string): Promise<SendMessageOptions | null>;
}

type PendingGoalContinuationSource = "stream_end" | "kickoff" | "budget_wrapup";

interface PendingGoalContinuationCandidate {
  goalId: string;
  requestedAtMs: number;
  streamEndedAtMs: number;
  source: PendingGoalContinuationSource;
  sendOptions: SendMessageOptions;
}

/**
 * Defensive validation for persisted timestamps: chat.jsonl rows are unchecked
 * JSON, so metadata numbers can arrive malformed (negative, NaN, or a string
 * masquerading through a cast). Only finite non-negative numbers participate
 * in goal-safety comparisons; everything else is treated as absent.
 */
function toValidEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

interface ChatTailGoalModeResult {
  mode: "active" | "paused" | null;
  /**
   * Why the tail resolved to paused: an explicit `goal-pause-boundary` row vs
   * an ordinary manual user row. Reconciliation uses this to distinguish an
   * explicit pause from the implicit "no continuation appended yet" state of a
   * freshly armed kickoff (see `applyChatTailGoalMode`).
   */
  pausedBy?: "pause_boundary" | "manual_user";
  /**
   * When `pausedBy === "manual_user"`: the moment the user authored the pausing
   * row — its persisted enqueue time (queued sends) or the row timestamp.
   * Reconciliation compares this against `goal.createdAtMs` to tell pre-goal
   * rows (must not pause a never-driven goal) from genuine post-goal
   * interventions (must pause even if the dispatch-time auto-pause was lost to
   * a crash).
   */
  manualRowAuthoredAtMs?: number;
}

interface GoalContinuationEligibilityResult {
  eligible: boolean;
  reason?: GoalContinuationSkipReason;
  goal?: GoalRecordV1;
  candidate?: PendingGoalContinuationCandidate;
  lastStreamStamp?: GoalStreamStamp;
  deferUntilMs?: number;
}

interface PendingGoalMutation {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
  status?: GoalStatus | null;
  completionSummary?: string | null;
  expectedGoalId?: string | null;
  replacementGuard?: SetGoalReplacementGuard | null;
  initiator?: GoalLifecycleInitiator;
  forceNewGoal?: boolean | null;
  /** Stable id for the optimistic record returned before the deferred write drains. */
  projectedGoalId?: string | null;
  /**
   * Creation time of the optimistic record. The drain re-creates the durable
   * goal, but the user could already see (and react to) the projected goal
   * mid-stream — a later stream-end `createdAtMs` would misclassify a queued
   * intervention as pre-goal input (Codex P1).
   */
  projectedCreatedAtMs?: number | null;
  /**
   * Carries the caller's `editInPlace` intent across mid-stream deferral so
   * a queued rename preserves goalId + accounting when it drains.
   */
  editInPlace?: boolean | null;
}

export type GoalStreamOriginKind = "goal_continuation" | "goal_budget_limit" | "user" | "other";

interface GoalStreamStamp {
  originKind: GoalStreamOriginKind;
  sequence: number;
  goalId: string | null;
}

interface StreamAccountingInput {
  workspaceId: string;
  /** Total cost attributable to this stream from start (cumulative for previews, final for records). */
  costUsd?: number | null;
  isCompaction?: boolean;
  streamStartedAtMs?: number | null;
  streamOriginKind?: GoalStreamOriginKind;
}

export interface ChildReportAttributionInput {
  parentWorkspaceId: string;
  childWorkspaceId: string;
  childCostCents: number;
}

export interface ChildReportAttributionResult {
  goalBefore: GoalRecordV1;
  goalAfter: GoalRecordV1;
  attributed: boolean;
  causedBudgetLimit: boolean;
}

function skippedChildAttribution(goal: GoalRecordV1): ChildReportAttributionResult {
  return {
    goalBefore: goal,
    goalAfter: goal,
    attributed: false,
    causedBudgetLimit: false,
  };
}

export class WorkspaceGoalChildWorkspaceError extends Error {
  readonly code = "GOAL_CHILD_WORKSPACE";

  constructor(workspaceId: string) {
    super(
      `Workspace ${workspaceId} is a child task workspace. Goals can only be set on parent workspaces.`
    );
    this.name = "WorkspaceGoalChildWorkspaceError";
  }
}

export class WorkspaceGoalTransitionError extends Error {
  readonly code = "GOAL_INVALID_TRANSITION";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGoalTransitionError";
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function lengthBucket(length: number): string {
  if (length < 10) return "0-9";
  if (length < 50) return "10-49";
  if (length < 100) return "50-99";
  return "100+";
}

function centsBucket(cents: number): string {
  if (cents === 0) return "0";
  if (cents < 100) return "1-99";
  if (cents < 1_000) return "100-999";
  return "1000+";
}

function countBucket(count: number): string {
  if (count === 0) return "0";
  if (count < 10) return "1-9";
  if (count < 100) return "10-99";
  return "100+";
}

/**
 * Local helper kept bare-decimal because the only call site (clear summary)
 * embeds it in a template literal that already supplies the `$` prefix.
 * Distinct from the shared `formatGoalCents` in `budgetPricing.ts` (which is
 * dollar-prefixed); callers that want the prefixed form must import from
 * there rather than defining a local copy.
 */
function formatCentsBare(cents: number): string {
  return (cents / 100).toFixed(2);
}

function actionForStatus(status: GoalStatus): "pause" | "resume" | "complete" {
  if (status === "active") {
    return "resume";
  }
  if (status === "complete") {
    return "complete";
  }
  return "pause";
}

function completionSummaryPatch(
  status: GoalStatus | null | undefined,
  completionSummary: string | null
): Pick<GoalRecordV1, "completionSummary"> | Record<string, never> {
  if (status === "complete" && completionSummary != null) {
    return { completionSummary };
  }
  if (status != null && status !== "complete") {
    return { completionSummary: undefined };
  }
  return {};
}

/**
 * Whitelist the model/agent configuration carried into synthetic continuations.
 *
 * The prior turn's full `SendMessageOptions` may carry payload-adjacent fields
 * (e.g. attachments at the IPC boundary, edit/correlation ids, mux metadata)
 * that should never be re-sent on auto-continuations:
 *  - re-sending attachments inflates cost and can hit per-request limits.
 *  - replaying `editMessageId` / `acpPromptId` / `muxMetadata` retargets the
 *    synthetic message at the wrong turn or breaks ACP correlation.
 *
 * `pickStartupRetrySendOptions` already encodes the canonical whitelist used
 * for crash-recovery retries, so reuse it here.
 */
function continuationSendOptions(sendOptions: SendMessageOptions): SendMessageOptions {
  const options: SendMessageOptions = {
    ...pickStartupRetrySendOptions(sendOptions),
    allowAgentSetGoal: undefined,
  };
  // Startup retries preserve workspace-turn correlation, but goal continuations start a new turn.
  delete options.muxMetadata;
  return options;
}

export interface WorkspaceGoalServiceOptions {
  /** Override interactive continuation cooldown; CLI goal runs use 0 to drive immediately. */
  continuationCooldownMs?: number;
  /** Allow CLI kickoff turns to receive the same budget-limit wrap-up as continuations. */
  allowUserOriginBudgetWrapup?: boolean;
  /** Prevent setGoal from queuing an automatic kickoff when the CLI sends its own message. */
  suppressKickoffContinuation?: boolean;
}

export class WorkspaceGoalService {
  private readonly fileLocks = workspaceFileLocks;
  private readonly continuationCooldownMs: number;
  private readonly allowUserOriginBudgetWrapup: boolean;
  private readonly suppressKickoffContinuation: boolean;
  private readonly pendingGoalMutations = new Map<string, PendingGoalMutation>();
  private readonly pendingGoalSnapshots = new Map<string, GoalSnapshot>();
  private readonly liveGoalPreviewSnapshots = new Map<string, GoalSnapshot>();

  private pendingContinuationCandidates = new Map<string, PendingGoalContinuationCandidate>();
  private continuationReRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastUserStopAtMsByWorkspace = new Map<string, number>();
  private recordedStreamStartedAtMsByWorkspace = new Map<string, number>();
  private lastGoalStreamStamps = new Map<string, GoalStreamStamp>();
  /**
   * Monotonic per-workspace stream-end drain counter. Bumped when
   * `applyPendingAfterStreamEnd` starts and again when it exits, so a queued
   * setGoal can detect that a drain ran while it was in flight and must not
   * install a pending mutation nothing will drain (Codex P2
   * PRRT_kwDOPxxmWM6cBr9Q).
   */
  private readonly streamEndDrainGenerations = new Map<string, number>();
  private nextGoalStreamStampSequence = 1;
  private goalContinuationBridge: GoalContinuationRuntimeBridge | null = null;
  private goalContinuationDispatcher: IdleDispatcher | null = null;
  private goalContinuationConsumerDisposer: (() => void) | null = null;

  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;

  private onActivityChange?: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void;

  /**
   * Injected callback that interrupts the active stream for a workspace.
   * Wired in `coreServices` via `WorkspaceService.interruptStream`. Tests
   * that don't supply one simply skip the interrupt step — `promote
   * UpcomingGoal` then falls back to its file-lock body as a plain
   * stream-free promotion, which keeps unit tests deterministic.
   */
  private streamInterrupter?: (workspaceId: string) => Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly analytics?: GoalLifecycleAnalyticsSink,
    options: WorkspaceGoalServiceOptions = {}
  ) {
    this.continuationCooldownMs =
      options.continuationCooldownMs ?? DEFAULT_GOAL_CONTINUATION_COOLDOWN_MS;
    this.allowUserOriginBudgetWrapup = options.allowUserOriginBudgetWrapup === true;
    this.suppressKickoffContinuation = options.suppressKickoffContinuation === true;
    assert(
      Number.isFinite(this.continuationCooldownMs) && this.continuationCooldownMs >= 0,
      "WorkspaceGoalService requires a non-negative continuation cooldown"
    );
  }

  async restoreGoalAccountingSnapshot(
    workspaceId: string,
    streamStartedAtMs: number | null = null
  ): Promise<void> {
    assert(workspaceId.trim().length > 0, "restoreGoalAccountingSnapshot requires workspaceId");
    await this.restorePersistedGoalSnapshot(workspaceId, { streamStartedAtMs });
  }

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  setOnActivityChange(
    listener: (workspaceId: string, snapshot: WorkspaceActivitySnapshot) => void
  ): void {
    this.onActivityChange = listener;
  }

  /**
   * The optimistic goal published while a goal is set mid-stream, before
   * stream-end persistence writes goal.json. Returns null when no mutation is
   * queued for the workspace.
   *
   * Consumed by `WorkspaceService.emitWorkspaceActivity` to overlay the
   * optimistic goal onto activity snapshots that are built from (still
   * pre-stream) persisted metadata — e.g. `status_set`/`todo_write`/recency
   * emits during the same stream. Without the overlay those snapshots replay
   * the stale pre-stream goal and the Goal tab flickers back to it until the
   * next goal read re-emits the optimistic one. This service clears the pending
   * snapshot before emitting authoritative reverts (abort) or durable
   * persistence (stream-end), so those transitions naturally win.
   */
  getPendingGoalSnapshot(workspaceId: string): GoalSnapshot | null {
    return this.pendingGoalSnapshots.get(workspaceId) ?? null;
  }

  setStreamInterrupter(interrupter: (workspaceId: string) => Promise<void>): void {
    this.streamInterrupter = interrupter;
  }

  private async readChatTailGoalMode(workspaceId: string): Promise<ChatTailGoalModeResult> {
    const historyResult = await this.historyService.getLastMessages(workspaceId, 100);
    if (!historyResult.success) {
      log.warn("Failed to read chat tail for goal mode reconciliation", {
        workspaceId,
        error: historyResult.error,
      });
      return { mode: null };
    }

    if (historyResult.data.length === 0) {
      return { mode: null };
    }

    for (let index = historyResult.data.length - 1; index >= 0; index -= 1) {
      const message = historyResult.data[index];
      if (message.role !== "user" || isSyntheticSnapshotUserMessage(message)) {
        continue;
      }

      if (message.metadata?.kind === GOAL_CONTINUATION_KIND) {
        return { mode: "active" };
      }
      if (message.metadata?.muxMetadata?.type === "goal-pause-boundary") {
        return { mode: "paused", pausedBy: "pause_boundary" };
      }
      if (message.metadata?.synthetic === true) {
        continue;
      }
      // Queue-dispatched rows persist their authoring time separately: the row
      // timestamp is stamped at dispatch, which can postdate a goal created at
      // the blocking turn's stream end even though the user typed pre-goal.
      // Codex P2 (PRRT_kwDOPxxmWM6b_1_J): chat.jsonl rows are unchecked JSON,
      // so validate each candidate before comparing — a malformed enqueuedAtMs
      // (negative, NaN, or a string) must fall back to the row timestamp
      // instead of silently misclassifying a post-goal intervention as
      // pre-goal and leaving the goal running.
      const authoredAtMs =
        toValidEpochMs(message.metadata?.enqueuedAtMs) ??
        toValidEpochMs(message.metadata?.timestamp);
      return {
        mode: "paused",
        pausedBy: "manual_user",
        ...(authoredAtMs != null ? { manualRowAuthoredAtMs: authoredAtMs } : {}),
      };
    }

    return { mode: null };
  }

  private applyChatTailGoalMode(
    workspaceId: string,
    goal: GoalRecordV1,
    chatTailMode: ChatTailGoalModeResult
  ): GoalRecordV1 {
    if (chatTailMode.mode == null || (goal.status !== "active" && goal.status !== "paused")) {
      return goal;
    }

    // Kickoff window: a freshly activated goal (model set_goal / user Resume)
    // arms a kickoff continuation candidate before its first goal_continuation
    // row is appended, so the chat tail still ends at a pre-goal manual user
    // row. Reconciling active→paused here would let any concurrent read (Goal
    // panel, tool building, a synthetic bash-monitor wake turn) pause the goal
    // before the kickoff fires — and the wake turn's stream-end hook could then
    // drop the kickoff candidate, stranding the goal (see
    // requestContinuationAfterStreamEnd). Explicit pauses are unaffected: every
    // explicit pause path deletes the candidate first and appends a
    // goal-pause-boundary row, which is deliberately not suppressed here.
    if (
      goal.status === "active" &&
      chatTailMode.mode === "paused" &&
      chatTailMode.pausedBy === "manual_user"
    ) {
      // Durable kickoff window: a goal that has never fired a continuation has
      // no goal_continuation row in history yet, so the chat tail still ends at
      // a manual user row that predates the goal. The in-memory candidate guard
      // below covers the live process, but candidates are lost on restart and
      // can be evicted by unrelated paths — after which the very next getGoal
      // (heartbeat / wake-turn tool assembly, Goal panel reads, stream-end
      // hooks) would silently pause the goal before it ever ran (user report:
      // scheduled heartbeats "pausing" fresh goals).
      //
      // Scoped to rows AUTHORED before the goal existed (persisted enqueue time
      // for queued sends, row timestamp otherwise): a row the user authored
      // after the goal became visible is a genuine intervention and must still
      // pause even when the dispatch-time auto-pause was lost to a crash
      // (Codex P2 — persisted state stays self-healing). Explicit pause paths
      // are unaffected: they append a goal-pause-boundary row, which reconciles
      // via the pause_boundary branch.
      if (
        goal.lastContinuationFiredAtMs == null &&
        chatTailMode.manualRowAuthoredAtMs != null &&
        chatTailMode.manualRowAuthoredAtMs <= goal.createdAtMs
      ) {
        return goal;
      }
      const candidate = this.pendingContinuationCandidates.get(workspaceId);
      if (candidate?.source === "kickoff" && candidate.goalId === goal.goalId) {
        return goal;
      }
    }

    const desiredStatus = chatTailMode.mode;
    if (goal.status === desiredStatus) {
      return goal;
    }

    // User rationale: goal running/paused mode is locked to the chat tail by
    // construction. A goal-continuation user turn is the only durable proof that
    // the model has been asked to keep driving the goal; any other latest user
    // turn leaves the goal paused until Resume appends a fresh continuation.
    const next = GoalRecordV1Schema.parse({
      ...goal,
      status: desiredStatus,
      updatedAtMs: Date.now(),
    });
    return this.applyBudgetDrivenStatus(next);
  }

  private async syncGoalStatusToChatTail(workspaceId: string): Promise<GoalRecordV1 | null> {
    const chatTailMode = await this.readChatTailGoalMode(workspaceId);
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushGoalReadSnapshot(workspaceId, null);
        return null;
      }

      const next = this.applyChatTailGoalMode(workspaceId, current, chatTailMode);
      if (next === current) {
        return current;
      }

      await this.writeGoal(workspaceId, next);
      await this.pushGoalReadSnapshot(workspaceId, next);
      this.emitBudgetLimited(workspaceId, next, current.status);
      this.emitStatusLifecycle(next, current.status, "auto");
      return next;
    });
  }

  private async appendGoalPauseBoundaryIfNeeded(workspaceId: string): Promise<boolean> {
    const chatTailMode = await this.readChatTailGoalMode(workspaceId);
    if (chatTailMode.mode !== "active") {
      return true;
    }

    // Hidden synthetic user boundary: it makes Pause durable in the same
    // declarative state model as Resume without rewriting prior continuation
    // history. The row is model-visible but not rendered unless synthetic debug
    // messages are enabled, matching other context-only system breadcrumbs.
    const message = createMuxMessage(
      `goal-paused-${Date.now()}-${crypto.randomUUID()}`,
      "user",
      "Goal paused by the user. Do not continue the goal until a later goal continuation message.",
      {
        timestamp: Date.now(),
        synthetic: true,
        muxMetadata: { type: "goal-pause-boundary" },
      }
    );
    const appendResult = await this.historyService.appendToHistory(workspaceId, message);
    if (!appendResult.success) {
      log.warn("Failed to append goal pause boundary", {
        workspaceId,
        error: appendResult.error,
      });
      return false;
    }
    return true;
  }

  // Shared resolver for the goal service's per-workspace session files
  // (goal.json / goal-history.jsonl / goal-board.json). Centralizes the
  // non-empty workspaceId guard and session-dir join so each file accessor
  // doesn't re-assert and re-join the same way.
  private resolveSessionFilePath(workspaceId: string, fileName: string): string {
    assert(workspaceId.trim().length > 0, "WorkspaceGoalService requires non-empty workspaceId");
    return path.join(this.config.getSessionDir(workspaceId), fileName);
  }

  private getFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_FILE);
  }

  private getHistoryFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_HISTORY_FILE);
  }

  /**
   * Append a goal record snapshot to the workspace's goal-history JSONL.
   * Callers are expected to hold the workspace file lock so this never races
   * with a `writeGoal` for the same workspace. A serialize-then-append failure
   * is logged but never bubbled: the user's lifecycle action (clear, replace,
   * complete) must succeed even if history persistence fails, because the
   * authoritative state lives in `goal.json` and the lifecycle event log.
   */
  private async appendGoalHistoryEntry(
    workspaceId: string,
    goal: GoalRecordV1,
    endReason: GoalHistoryEndReason
  ): Promise<void> {
    const entry: GoalHistoryEntry = {
      version: 1,
      endReason,
      endedAtMs: Date.now(),
      goal,
    };
    const filePath = this.getHistoryFilePath(workspaceId);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      // JSONL append: one entry per line, no rewriting prior history. Newline
      // first would corrupt readers expecting a trailing newline on the last
      // record, so we always emit `<json>\n`.
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      log.warn("Failed to append goal history entry", { workspaceId, endReason, error });
    }
  }

  private createGoal(input: {
    objective: string;
    budgetCents: number | null;
    turnCap: number | null;
    status?: GoalStatus | null;
    completionSummary?: string | null;
    goalId?: string | null;
    /**
     * Preserved creation time for goals projected mid-stream: the durable
     * record must date from when the user could first see the goal, or queued
     * interventions typed against the visible goal would be misread as
     * pre-goal input by the goal-safety guards.
     */
    createdAtMs?: number | null;
  }): GoalRecordV1 {
    const now = input.createdAtMs ?? Date.now();
    const status = input.status ?? "active";
    const goal = GoalRecordV1Schema.parse({
      version: 1,
      goalId: input.goalId ?? crypto.randomUUID(),
      objective: input.objective,
      status,
      budgetCents: normalizeGoalBudgetCents(input.budgetCents),
      turnCap: input.turnCap,
      costCents: 0,
      costMicroCents: 0,
      turnsUsed: 0,
      attributedChildren: [],
      budgetLimitInjectedForGoalId: null,
      requireUserAcknowledgmentSinceMs: null,
      lastContinuationFiredAtMs: null,
      ...(input.completionSummary != null
        ? { completionSummary: input.completionSummary.trim() }
        : {}),
      createdAtMs: now,
      updatedAtMs: now,
    });
    return status === "active" ? this.applyBudgetDrivenStatus(goal) : goal;
  }

  private async writeGoal(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const filePath = this.getFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, `${JSON.stringify(goal, null, 2)}\n`, "utf-8");
  }

  private async renameCorruptGoal(
    workspaceId: string,
    filePath: string,
    error: unknown
  ): Promise<void> {
    const corruptPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, corruptPath);
    } catch (renameError) {
      if (!isNotFound(renameError)) {
        log.warn("Failed to rename corrupt goal.json", { workspaceId, error: renameError });
      }
    }
    log.warn("Ignoring corrupt goal.json", { workspaceId, corruptPath, error });
    await this.pushSnapshot(workspaceId, null);
  }

  private async readGoalFile(workspaceId: string): Promise<GoalRecordV1 | null> {
    const filePath = this.getFilePath(workspaceId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }

    try {
      return GoalRecordV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      await this.renameCorruptGoal(workspaceId, filePath, error);
      return null;
    }
  }

  private async pushSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const snapshot = goal ? toGoalSnapshot(goal) : null;
    const activity = await this.extensionMetadata.setGoal(workspaceId, snapshot);
    this.onActivityChange?.(workspaceId, activity);
    return snapshot;
  }

  private async pushTransientGoalSnapshot(
    workspaceId: string,
    snapshot: GoalSnapshot
  ): Promise<boolean> {
    const activity = await this.extensionMetadata.getSnapshot(workspaceId);
    if (!activity) {
      // No baseline activity snapshot to overlay the transient goal on
      // (extensionMetadata has no entry for this workspace yet). Callers
      // that must guarantee delivery — e.g. live cost previews — should
      // observe this `false` return and fall back to `pushSnapshot`, which
      // creates the entry and emits via the durable path. Pending-goal
      // publication does not retry here because it only fires after a
      // `setGoal` that already created the entry.
      return false;
    }
    this.onActivityChange?.(workspaceId, {
      ...activity,
      goal: snapshot,
      transientGoalOnly: true,
    });
    return true;
  }

  private async pushLiveGoalPreviewOverlay(
    workspaceId: string,
    durableGoal: GoalRecordV1
  ): Promise<void> {
    const livePreview = this.liveGoalPreviewSnapshots.get(workspaceId);
    if (!livePreview || livePreview.goalId !== durableGoal.goalId) {
      return;
    }

    const durableSnapshot = toGoalSnapshot(durableGoal);
    if (livePreview.costCents <= durableSnapshot.costCents) {
      return;
    }

    // Preserve live "budget used" while a user edits budget/turn limits mid-stream.
    // The mutable edit must persist the durable pre-stream accounting to goal.json so
    // final `recordStreamAccounting` can add the cumulative stream cost exactly once,
    // but the Goals UI should keep showing the same live usage Stats already reports.
    await this.pushTransientGoalSnapshot(workspaceId, {
      ...durableSnapshot,
      costCents: livePreview.costCents,
    });
  }
  private async publishPendingGoalSnapshot(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    const snapshot = toPendingGoalSnapshot(goal);
    this.pendingGoalSnapshots.set(workspaceId, snapshot);
    await this.pushTransientGoalSnapshot(workspaceId, snapshot);
  }

  private async pushGoalReadSnapshot(
    workspaceId: string,
    goal: GoalRecordV1 | null
  ): Promise<GoalSnapshot | null> {
    const pendingSnapshot = this.pendingGoalSnapshots.get(workspaceId);
    if (pendingSnapshot) {
      // Goal reads keep activity snapshots warm, but mid-stream queued goals
      // must keep showing the transient replacement until stream-end persistence.
      await this.pushTransientGoalSnapshot(workspaceId, pendingSnapshot);
      return pendingSnapshot;
    }
    if (!goal) {
      // Goals are GA, so normal model/tool-availability paths call getGoal()
      // for every turn. Avoid writing `goal: null` on every no-goal read;
      // explicit lifecycle operations (clear/corrupt repair/etc.) still push
      // null snapshots when state actually changes.
      return null;
    }
    return this.pushSnapshot(workspaceId, goal);
  }

  private async restorePersistedGoalSnapshot(
    workspaceId: string,
    options: { streamStartedAtMs?: number | null } = {}
  ): Promise<void> {
    try {
      await this.fileLocks.withLock(workspaceId, async () => {
        this.liveGoalPreviewSnapshots.delete(workspaceId);
        if (options.streamStartedAtMs != null) {
          this.recordedStreamStartedAtMsByWorkspace.set(workspaceId, options.streamStartedAtMs);
        }
        const current = await this.readGoalFile(workspaceId);
        await this.pushSnapshot(workspaceId, current);
      });
    } catch (error) {
      log.warn("Failed to restore persisted goal snapshot", { workspaceId, error });
    }
  }

  private assertParentWorkspace(workspaceId: string): void {
    const workspace = this.config.findWorkspace(workspaceId);
    if (workspace?.parentWorkspaceId != null) {
      throw new WorkspaceGoalChildWorkspaceError(workspaceId);
    }
  }

  private emitLifecycle(event: GoalLifecycleEvent, properties: GoalLifecycleProperties): void {
    try {
      this.analytics?.recordGoalLifecycleEvent(event, properties);
    } catch (error) {
      log.warn("Failed to record goal lifecycle event", { event, error });
    }
  }

  private async isWorkspaceStreaming(workspaceId: string): Promise<boolean> {
    const snapshot = await this.extensionMetadata.getSnapshot(workspaceId);
    return snapshot?.streaming === true;
  }

  /**
   * Bounded poll for the workspace's streaming flag to drop. Same backoff
   * as `runDeferredAutoPromoteAfterStreamEnd` so callers never wait more
   * than ~600ms. Returns silently when the timer exhausts; the caller is
   * expected to proceed regardless (promote falls open).
   */
  private async waitForStreamSettled(workspaceId: string): Promise<void> {
    const backoffMs = [0, 50, 100, 200, 250];
    for (const delay of backoffMs) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!(await this.isWorkspaceStreaming(workspaceId))) return;
    }
  }

  registerGoalContinuationConsumer(
    idleDispatcher: IdleDispatcher,
    bridge: GoalContinuationRuntimeBridge
  ): () => void {
    assert(idleDispatcher, "registerGoalContinuationConsumer requires an idle dispatcher");
    assert(bridge, "registerGoalContinuationConsumer requires a runtime bridge");
    assert(
      this.goalContinuationConsumerDisposer == null,
      "goal continuation idle consumer is already registered"
    );

    this.goalContinuationBridge = bridge;
    this.goalContinuationDispatcher = idleDispatcher;
    this.goalContinuationConsumerDisposer = idleDispatcher.registerConsumer({
      name: GOAL_CONTINUATION_IDLE_CONSUMER_NAME,
      priority: GOAL_CONTINUATION_IDLE_CONSUMER_PRIORITY,
      buildPayload: (workspaceId) => this.buildGoalContinuationPayload(workspaceId),
    });

    return () => {
      this.goalContinuationConsumerDisposer?.();
      this.goalContinuationConsumerDisposer = null;
      this.goalContinuationBridge = null;
      this.goalContinuationDispatcher = null;
      for (const timer of this.continuationReRequestTimers.values()) {
        clearTimeout(timer);
      }
      this.continuationReRequestTimers.clear();
    };
  }

  private async getPricedContinuationSendOptions(
    workspaceId: string,
    goal: GoalRecordV1,
    sendOptions: SendMessageOptions
  ): Promise<SendMessageOptions | null> {
    const normalized = continuationSendOptions(sendOptions);
    if (!hasBudgetedResumableGoal(goal)) {
      return normalized;
    }
    const providersConfig = this.getProvidersConfigForPricing();
    if (modelHasPricingData(normalized.model, providersConfig)) {
      return normalized;
    }
    const kickoff = await this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId);
    if (!kickoff || kickoff.agentId === "plan" || kickoff.agentId === "compact") {
      return null;
    }
    const fallback = continuationSendOptions(kickoff);
    return modelHasPricingData(fallback.model, providersConfig) ? fallback : null;
  }

  async requestContinuationAfterStreamEnd(input: {
    workspaceId: string;
    sendOptions: SendMessageOptions;
    streamEndedAtMs?: number;
  }): Promise<void> {
    assert(
      input.workspaceId.trim().length > 0,
      "requestContinuationAfterStreamEnd requires workspaceId"
    );
    if (this.goalContinuationDispatcher == null) {
      return;
    }

    const existingCandidate = this.pendingContinuationCandidates.get(input.workspaceId);
    if (existingCandidate?.source === "kickoff") {
      const kickoffGoal = await this.normalizeGoalLimits(input.workspaceId, {
        syncChatTail: false,
      });
      if (
        kickoffGoal?.goalId === existingCandidate.goalId &&
        (kickoffGoal.status === "active" || kickoffGoal.status === "paused")
      ) {
        // Model-created goals arm a kickoff candidate when the queued set_goal
        // drains. The enclosing user stream also calls this stream-end hook; do
        // not downgrade that kickoff into a stream_end candidate, because
        // stream_end candidates reconcile against the pre-goal manual user row
        // and would pause the new goal before it can continue.
        //
        // `paused` is included because chat-tail reconciliation can flip a
        // kickoff-window goal to paused before its first continuation row lands
        // (e.g. when a synthetic bash-monitor wake turn runs first and its
        // stream end lands here). Eligibility and dispatch deliberately accept
        // paused kickoff candidates and recordContinuationFired flips the goal
        // back to active. Every explicit pause path deletes the candidate
        // first, so a paused goal with an armed kickoff can only be that
        // auto-flip — dropping it here would strand the goal (issue: bash
        // monitor wakes disabling freshly set goals).
        await this.goalContinuationDispatcher.requestDispatch(
          input.workspaceId,
          GOAL_CONTINUATION_IDLE_CONSUMER_NAME
        );
        return;
      }
    }

    const goal = await this.getGoal(input.workspaceId);
    if (goal?.status !== "active" && goal?.status !== "budget_limited") {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const sendOptions = await this.getPricedContinuationSendOptions(
      input.workspaceId,
      goal,
      input.sendOptions
    );
    if (!sendOptions) {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      return;
    }

    const streamEndedAtMs = input.streamEndedAtMs ?? Date.now();
    this.pendingContinuationCandidates.set(input.workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: Date.now(),
      streamEndedAtMs,
      source: "stream_end",
      sendOptions,
    });
    await this.goalContinuationDispatcher.requestDispatch(
      input.workspaceId,
      GOAL_CONTINUATION_IDLE_CONSUMER_NAME
    );
  }

  clearPendingContinuationForManualUserMessage(workspaceId: string): void {
    assert(
      workspaceId.trim().length > 0,
      "clearPendingContinuationForManualUserMessage requires workspaceId"
    );
    this.pendingContinuationCandidates.delete(workspaceId);
  }

  /**
   * Treat an agent's text-only `goal_continuation` turn as implicit
   * completion. The continuation prompt asks the agent to call
   * `complete_goal` explicitly, but real models sometimes finish with a
   * plain text "looks done" reply instead. Without this fallback the
   * continuation loop would re-fire on the same idle output until budget
   * or cooldown gates intervene.
   *
   * AgentSession owns the "no tool calls + goalKind === continuation"
   * predicate (it has the stream parts + activeStreamContext in scope);
   * this method re-reads goal state and only acts when the goal is
   * currently `active`. `budget_limited` is intentionally out-of-scope —
   * its one-shot wrap-up flow owns terminal text turns. `paused` /
   * `complete` / missing goals also fall through.
   *
   * Errors from the underlying `setGoal` (e.g. a concurrent clear/replace
   * surfacing as `goal_conflict`, or a status flip racing with the read)
   * are logged and swallowed so the stream-end handler never throws on
   * this best-effort path.
   *
   * **Auto-promotion of upcoming goals.** When the workspace has queued
   * upcoming goals, the inline `setGoal({ status: "complete" })` call
   * triggers `maybeAutoPromoteOnComplete`, but that helper skips while
   * `isWorkspaceStreaming` is still true — and at stream-end the
   * `extensionMetadata.setStreaming(false)` update is asynchronous, so
   * the skip is likely. We therefore re-run the deferred auto-promote
   * pass (`runDeferredAutoPromoteAfterStreamEnd`) after a successful
   * completion. This is the same hook `applyPendingAfterStreamEnd`
   * already uses for the parallel "agent called `complete_goal`
   * mid-stream" case (#3326 Codex P2 PRRT_kwDOPxxmWM6DMh9j); without
   * it the next upcoming goal stays stuck in `upcoming` until some
   * later manual mutation.
   */
  async completeGoalFromSilentContinuation(input: {
    workspaceId: string;
    completionSummary: string;
  }): Promise<GoalRecordV1 | null> {
    assert(
      input.workspaceId.trim().length > 0,
      "completeGoalFromSilentContinuation requires workspaceId"
    );
    const summary = input.completionSummary.trim();
    if (summary.length === 0) {
      return null;
    }
    const goal = await this.getGoal(input.workspaceId);
    if (goal?.status !== "active") {
      return null;
    }
    const result = await this.setGoal({
      workspaceId: input.workspaceId,
      status: "complete",
      initiator: "model",
      completionSummary: summary,
      // Optimistic-concurrency guard so a goal that was cleared or
      // replaced between the read above and the write below surfaces as
      // a typed `goal_conflict` instead of a confusing validation error.
      expectedGoalId: goal.goalId,
    });
    if (!result.success) {
      log.info("completeGoalFromSilentContinuation: skipped", {
        workspaceId: input.workspaceId,
        error: result.error.type,
      });
      return null;
    }
    // Auto-promote any queued upcoming goal once streaming actually
    // settles. See the JSDoc above for the race description; this
    // mirrors `applyPendingAfterStreamEnd`'s tail so both completion
    // paths (mid-stream tool call + silent text-only) converge on the
    // same promotion behaviour.
    await this.runDeferredAutoPromoteAfterStreamEnd(input.workspaceId);
    return result.data;
  }

  async recordUserStoppedStream(workspaceId: string, stoppedAtMs = Date.now()): Promise<void> {
    assert(workspaceId.trim().length > 0, "recordUserStoppedStream requires workspaceId");
    assert(Number.isFinite(stoppedAtMs) && stoppedAtMs >= 0, "user stop timestamp must be valid");
    this.lastUserStopAtMsByWorkspace.set(workspaceId, stoppedAtMs);
    this.pendingContinuationCandidates.delete(workspaceId);
    this.pendingGoalSnapshots.delete(workspaceId);
    this.liveGoalPreviewSnapshots.delete(workspaceId);
    // Drop queued goal mutations too. If a
    // user sets a goal mid-stream then stops the stream, the mutation would
    // otherwise stay queued and apply on the NEXT stream's stream-end via
    // applyPendingAfterStreamEnd, writing goal.json with createdAtMs > the
    // userStopAtMs gate — auto-continuation would then fire in a context the
    // user did not intend (the stop was meant to discard the goal change).
    const hadPendingGoalMutation = this.pendingGoalMutations.delete(workspaceId);

    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.status !== "active" && current?.status !== "budget_limited") {
        // Mid-stream /goal now publishes an optimistic activity snapshot so the
        // Goal panel opens immediately. If the user aborts that stream, revert
        // the panel to the persisted goal file (or null) along with dropping the
        // queued mutation.
        if (hadPendingGoalMutation) {
          await this.pushSnapshot(workspaceId, current);
        }
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        requireUserAcknowledgmentSinceMs: Math.floor(stoppedAtMs),
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
    });
  }

  async buildGoalContinuationPayload(workspaceId: string): Promise<IdleDispatchPayload | null> {
    const eligibility = await this.checkGoalContinuationEligibility(workspaceId, Date.now());
    if (!eligibility.eligible) {
      // Self-deferring reasons (e.g. `currently_streaming`, `initializing`)
      // re-request dispatch on a ~1s timer, so logging at info level produces
      // one line per retry for the entire duration of an active stream. Drop
      // those to debug; keep terminal reasons at info since they fire once
      // and are useful diagnostic signal.
      const logFn = eligibility.deferUntilMs != null ? log.debug : log.info;
      logFn("WorkspaceGoalService: skipped goal continuation", {
        workspaceId,
        reason: eligibility.reason,
      });
      if (eligibility.deferUntilMs != null) {
        this.scheduleContinuationReRequest(workspaceId, eligibility.deferUntilMs);
        return null;
      }
      return null;
    }

    const { goal, candidate } = eligibility;
    assert(goal != null, "eligible goal continuation requires a goal");
    assert(candidate != null, "eligible goal continuation requires a pending candidate");

    if (goal.status === "budget_limited") {
      const lastStreamStamp = eligibility.lastStreamStamp;
      assert(lastStreamStamp != null, "eligible budget wrap-up requires a stream stamp");
      const message = buildGoalBudgetLimitMessage(goal);
      return {
        dispatch: async () => {
          // Send first, mark only on accept. If sendMessage rejects transiently
          // (e.g. requireIdle fails because a new turn started), we want a future
          // dispatch to retry — we must not permanently flip
          // budgetLimitInjectedForGoalId or the goal gets stuck in budget_limited
          // with no wrap-up. Mirrors the active-continuation path below.
          const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
            workspaceId,
            message,
            options: candidate.sendOptions,
            startStreamInBackground: false,
            kind: GOAL_BUDGET_LIMIT_KIND,
          });
          if (accepted !== true) {
            this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
            return;
          }
          this.timelineRecorder.record(workspaceId, {
            kind: "goal.continuation_dispatched",
            source: { system: "goal" },
            status: "started",
            data: { reason: "budget_limit", digest: goal.objective },
          });
          const reserved = await this.tryMarkBudgetLimitInjected(
            workspaceId,
            goal.goalId,
            lastStreamStamp
          );
          if (reserved) {
            this.emitBudgetWrapupFired(reserved, Date.now());
          }
          this.deletePendingCandidateIfStillSame(workspaceId, candidate);
        },
      };
    }

    const continuationGoal =
      goal.status === "paused" && candidate.source === "kickoff"
        ? GoalRecordV1Schema.parse({ ...goal, status: "active" })
        : goal;
    assert(
      continuationGoal.status === "active",
      "goal idle payload requires active, paused-kickoff, or budget-limited goal"
    );
    const message = buildGoalContinuationMessage(continuationGoal);
    return {
      dispatch: async () => {
        const accepted = await this.goalContinuationBridge?.executeGoalContinuation({
          workspaceId,
          message,
          options: candidate.sendOptions,
          startStreamInBackground: candidate.source === "kickoff",
          kind: GOAL_CONTINUATION_KIND,
        });
        if (accepted !== true) {
          this.scheduleContinuationReRequest(workspaceId, Date.now() + 1_000);
          return;
        }
        this.timelineRecorder.record(workspaceId, {
          kind: "goal.continuation_dispatched",
          source: { system: "goal" },
          status: "started",
          data: { digest: goal.objective },
        });
        await this.recordContinuationFired(workspaceId, goal.goalId, Date.now());
        if (candidate.source !== "kickoff") {
          this.deletePendingCandidateIfStillSame(workspaceId, candidate);
          return;
        }
        // Keep kickoff candidates until the stream-end path replaces or clears
        // them. Background startup failures happen after the synthetic user row
        // is accepted; retaining the candidate lets the failure hook re-request
        // dispatch instead of stranding the active goal.
      },
    };
  }

  /**
   * Delete the pending continuation candidate for a workspace ONLY if the map
   * entry still references the same candidate this dispatch closure captured.
   *
   * Between executeGoalContinuation returning true and the cleanup
   * delete, two file-lock awaits yield the event loop
   * (tryMarkBudgetLimitInjected / recordContinuationFired). If the
   * continuation stream fails immediately and the stream-end handler writes a
   * NEW candidate during the yield, an unconditional delete-by-key would drop
   * that fresh candidate — the next dispatch cycle would then find no
   * candidate and skip silently.
   *
   * Reference equality is the simplest correct guard: each pending candidate
   * is a distinct object, so identity checks against the captured closure
   * variable cannot collide with a concurrently-written replacement.
   */
  private deletePendingCandidateIfStillSame(
    workspaceId: string,
    candidate: PendingGoalContinuationCandidate
  ): void {
    if (this.pendingContinuationCandidates.get(workspaceId) === candidate) {
      this.pendingContinuationCandidates.delete(workspaceId);
    }
  }

  async checkGoalContinuationEligibility(
    workspaceId: string,
    nowMs: number
  ): Promise<GoalContinuationEligibilityResult> {
    assert(workspaceId.trim().length > 0, "checkGoalContinuationEligibility requires workspaceId");
    assert(Number.isFinite(nowMs) && nowMs >= 0, "checkGoalContinuationEligibility requires nowMs");

    const candidate = this.pendingContinuationCandidates.get(workspaceId);
    if (!candidate) {
      return { eligible: false, reason: "no_pending_candidate" };
    }
    const bridge = this.goalContinuationBridge;
    if (!bridge) {
      return { eligible: false, reason: "not_registered" };
    }

    const workspace = this.findWorkspaceConfigEntry(workspaceId);
    if (!workspace) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "workspace_not_found" };
    }
    if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "archived" };
    }
    if (!workspace.path) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "transcript_only" };
    }
    if (workspace.parentWorkspaceId != null) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "child_workspace" };
    }
    if (bridge.hasActiveDescendantTasks(workspaceId)) {
      return { eligible: false, reason: "active_descendant_tasks" };
    }

    const runtimeState = bridge.getRuntimeState(workspaceId);
    if (runtimeState.isInitializing === true) {
      return { eligible: false, reason: "initializing", deferUntilMs: nowMs + 1_000 };
    }
    if (runtimeState.isRuntimeCompatible === false) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "incompatible_runtime" };
    }
    if (runtimeState.isBusy === true || (await this.isWorkspaceStreaming(workspaceId))) {
      return { eligible: false, reason: "currently_streaming", deferUntilMs: nowMs + 1_000 };
    }
    if (runtimeState.hasQueuedMessages === true) {
      return { eligible: false, reason: "queued_user_input" };
    }
    if (runtimeState.hasPendingFollowUp === true) {
      return { eligible: false, reason: "pending_follow_up" };
    }
    if (candidate.sendOptions.agentId === "plan" || candidate.sendOptions.mode === "plan") {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "plan_mode" };
    }
    if (candidate.sendOptions.agentId === "compact" || candidate.sendOptions.mode === "compact") {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "compact_mode" };
    }

    const userStopAtMs = this.lastUserStopAtMsByWorkspace.get(workspaceId);
    if (userStopAtMs != null) {
      const goalForStopCheck = await this.readGoalFile(workspaceId);
      if (!goalForStopCheck) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "goal_missing" };
      }
      if (userStopAtMs >= goalForStopCheck.createdAtMs) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "user_stop" };
      }
    }

    const goal = await this.normalizeGoalLimits(workspaceId, {
      syncChatTail: candidate.source !== "kickoff",
    });
    if (!goal) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "goal_missing" };
    }
    if (goal.goalId !== candidate.goalId) {
      this.pendingContinuationCandidates.delete(workspaceId);
      return { eligible: false, reason: "goal_mismatch" };
    }
    if (goal.status !== "active" && goal.status !== "budget_limited") {
      if (goal.status !== "paused" || candidate.source !== "kickoff") {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "goal_not_active" };
      }
    }
    if (goal.requireUserAcknowledgmentSinceMs != null) {
      return { eligible: false, reason: "requires_ack" };
    }

    if (goal.status === "budget_limited") {
      const lastStreamStamp = this.lastGoalStreamStamps.get(workspaceId);
      if (goal.budgetLimitInjectedForGoalId === goal.goalId) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "budget_wrapup_already_fired" };
      }
      if (
        lastStreamStamp?.goalId !== goal.goalId ||
        !this.isBudgetWrapupEligibleOrigin(lastStreamStamp.originKind)
      ) {
        this.pendingContinuationCandidates.delete(workspaceId);
        return { eligible: false, reason: "budget_wrapup_suppressed" };
      }
      return { eligible: true, goal, candidate, lastStreamStamp };
    }

    const lastContinuationFiredAtMs = goal.lastContinuationFiredAtMs ?? null;
    if (
      lastContinuationFiredAtMs != null &&
      nowMs - lastContinuationFiredAtMs < this.continuationCooldownMs
    ) {
      return {
        eligible: false,
        reason: "cooldown",
        deferUntilMs: lastContinuationFiredAtMs + this.continuationCooldownMs,
      };
    }

    return { eligible: true, goal, candidate };
  }

  private scheduleContinuationReRequest(workspaceId: string, dueAtMs: number): void {
    if (this.goalContinuationDispatcher == null) {
      return;
    }
    const delayMs = Math.max(0, dueAtMs - Date.now());
    const existing = this.continuationReRequestTimers.get(workspaceId);
    if (existing != null) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.continuationReRequestTimers.delete(workspaceId);
      if (!this.pendingContinuationCandidates.has(workspaceId)) {
        return;
      }
      this.goalContinuationDispatcher
        ?.requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
        .catch((error: unknown) => {
          log.warn("Failed to re-request goal continuation dispatch", { workspaceId, error });
        });
    }, delayMs);
    this.continuationReRequestTimers.set(workspaceId, timer);
  }

  private findWorkspaceConfigEntry(workspaceId: string): Workspace | null {
    const config = this.config.loadConfigOrDefault();
    for (const [, projectConfig] of config.projects) {
      const workspace = projectConfig.workspaces.find((candidate) => candidate.id === workspaceId);
      if (workspace) {
        return workspace;
      }
    }
    return null;
  }

  private async normalizeGoalLimits(
    workspaceId: string,
    options: { syncChatTail?: boolean } = {}
  ): Promise<GoalRecordV1 | null> {
    const chatTailMode =
      options.syncChatTail === true ? await this.readChatTailGoalMode(workspaceId) : null;
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushGoalReadSnapshot(workspaceId, null);
        return null;
      }
      const budgetNormalized = this.applyBudgetDrivenStatus(current);
      const next = chatTailMode
        ? this.applyChatTailGoalMode(workspaceId, budgetNormalized, chatTailMode)
        : budgetNormalized;
      if (next !== current) {
        await this.writeGoal(workspaceId, next);
        await this.pushGoalReadSnapshot(workspaceId, next);
        this.emitBudgetLimited(workspaceId, next, current.status);
        this.emitStatusLifecycle(next, current.status, "auto");
        return next;
      }
      await this.pushGoalReadSnapshot(workspaceId, current);
      return current;
    });
  }

  private async recordContinuationFired(
    workspaceId: string,
    expectedGoalId: string,
    firedAtMs: number
  ): Promise<void> {
    const chatTailMode = await this.readChatTailGoalMode(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (current?.goalId !== expectedGoalId) {
        return;
      }
      const continuationAccepted =
        current.status === "active" ||
        (current.status === "paused" && chatTailMode.mode === "active");
      if (!continuationAccepted) {
        return;
      }
      const next = GoalRecordV1Schema.parse({
        ...current,
        status: "active",
        lastContinuationFiredAtMs: firedAtMs,
        updatedAtMs: firedAtMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      this.emitStatusLifecycle(next, current.status, "auto");
      this.emitContinuationFired(next, firedAtMs);
    });
  }

  private emitContinuationFired(goal: GoalRecordV1, firedAtMs: number): void {
    const budgetRemaining =
      goal.budgetCents == null ? null : Math.max(0, goal.budgetCents - goal.costCents);
    this.emitLifecycle("goal_continuation_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      budget_remaining_cents_bucket:
        budgetRemaining == null ? "unlimited" : centsBucket(budgetRemaining),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      turn_cap_present: goal.turnCap != null,
      source: "stream_end_idle_dispatch",
    });
  }

  private isBudgetWrapupEligibleOrigin(originKind: GoalStreamOriginKind): boolean {
    return this.allowUserOriginBudgetWrapup || originKind !== "user";
  }

  private async tryMarkBudgetLimitInjected(
    workspaceId: string,
    expectedGoalId: string,
    expectedLastStreamStamp: GoalStreamStamp
  ): Promise<GoalRecordV1 | null> {
    assert(expectedGoalId.trim().length > 0, "budget wrap-up reservation requires a goal id");
    assert(
      this.isBudgetWrapupEligibleOrigin(expectedLastStreamStamp.originKind),
      "budget wrap-up reservation requires a goal-attributable stream"
    );

    return this.fileLocks.withLock(workspaceId, async () => {
      const currentStamp = this.lastGoalStreamStamps.get(workspaceId);
      if (
        currentStamp?.goalId !== expectedGoalId ||
        !this.isBudgetWrapupEligibleOrigin(currentStamp.originKind)
      ) {
        return null;
      }

      const current = await this.readGoalFile(workspaceId);
      if (
        current?.goalId !== expectedGoalId ||
        current.status !== "budget_limited" ||
        current.budgetLimitInjectedForGoalId === expectedGoalId
      ) {
        return null;
      }

      const next = GoalRecordV1Schema.parse({
        ...current,
        budgetLimitInjectedForGoalId: expectedGoalId,
        updatedAtMs: Date.now(),
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  private emitBudgetWrapupFired(goal: GoalRecordV1, firedAtMs: number): void {
    this.emitLifecycle("goal_wrapup_fired", {
      turns_used: goal.turnsUsed,
      cost_cents_bucket: centsBucket(goal.costCents),
      "cost-overshoot": centsBucket(
        Math.max(0, goal.costCents - (goal.budgetCents ?? goal.costCents))
      ),
      elapsed_minutes_bucket: countBucket(
        Math.floor(Math.max(0, firedAtMs - goal.createdAtMs) / 60_000)
      ),
      source: "stream_end_idle_dispatch",
    });
  }

  private validateStatusTransition(
    current: GoalRecordV1 | null,
    nextStatus: GoalStatus,
    completionSummary: string | null,
    initiator: GoalLifecycleInitiator
  ): void {
    if (!current) {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a goal because no goal is set.`
      );
    }

    // Reviving a completed goal is a deliberate user action: agents that
    // marked a goal complete via the `complete_goal` tool (initiator
    // "model") must not be able to walk that back on the next turn — that
    // would let a loop re-arm itself indefinitely. But a human in the
    // GoalTab is allowed to resume the goal they archived themselves
    // (e.g., the agent declared victory too early), so we only block
    // non-user initiators here.
    if (current.status === "complete" && nextStatus !== "complete" && initiator !== "user") {
      throw new WorkspaceGoalTransitionError(
        `Cannot ${actionForStatus(nextStatus)} a completed goal. Clear it before starting another.`
      );
    }

    // From `complete` the user may go to either `active` (resume work) or
    // `paused` (revive without immediately re-arming continuations).
    // From any other state the normal pause/resume guards still apply.
    if (nextStatus === "paused" && current.status !== "active" && current.status !== "complete") {
      throw new WorkspaceGoalTransitionError("Cannot pause a goal that is not active.");
    }

    if (nextStatus === "active" && current.status !== "paused" && current.status !== "complete") {
      throw new WorkspaceGoalTransitionError("Cannot resume a goal that is not paused.");
    }

    if (nextStatus === "complete") {
      if (completionSummary == null || completionSummary.length === 0) {
        throw new WorkspaceGoalTransitionError("Completion summary is required.");
      }
      if (current.status !== "active" && current.status !== "budget_limited") {
        throw new WorkspaceGoalTransitionError(
          "Cannot complete a goal that is not active or budget-limited."
        );
      }
    }
  }

  private conflictForExpectedGoalId(
    current: GoalRecordV1 | null,
    expectedGoalId: string | null | undefined
  ): GoalSetError | null {
    if (expectedGoalId === undefined) {
      return null;
    }
    const actualGoalId = current?.goalId ?? null;
    if (actualGoalId === expectedGoalId) {
      return null;
    }
    return { type: "goal_conflict", expectedGoalId, actualGoalId };
  }

  private conflictForReplacementGuard(
    current: GoalRecordV1 | null,
    replacementGuard: SetGoalReplacementGuard | null | undefined
  ): GoalSetError | null {
    if (!replacementGuard || !current || !REPLACE_GUARDED_STATUSES.has(current.status)) {
      return null;
    }

    if (replacementGuard.replaceExistingGoal !== true) {
      return {
        type: "invalid_transition",
        message:
          "set_goal would replace the current active goal. Continue or complete the existing goal, or ask the user before replacing it. If the user explicitly asked to replace it, call get_goal and retry with replaceExistingGoal=true and expectedGoalId.",
      };
    }

    if (replacementGuard.expectedGoalId !== current.goalId) {
      return {
        type: "invalid_transition",
        message: `set_goal replacement requires expectedGoalId to match the current goalId from get_goal (${current.goalId}).`,
      };
    }

    return null;
  }

  private applyMutableFields(goal: GoalRecordV1, input: SetGoalInput): GoalRecordV1 {
    const completionSummary = input.completionSummary?.trim() ?? null;
    if (input.status != null) {
      this.validateStatusTransition(
        goal,
        input.status,
        completionSummary,
        input.initiator ?? "user"
      );
    }

    const next: GoalRecordV1 = GoalRecordV1Schema.parse({
      ...goal,
      ...(input.status != null ? { status: input.status } : {}),
      ...(Object.hasOwn(input, "budgetCents")
        ? { budgetCents: normalizeGoalBudgetCents(input.budgetCents) }
        : {}),
      ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
      ...(Object.hasOwn(input, "requireUserAcknowledgmentSinceMs")
        ? { requireUserAcknowledgmentSinceMs: input.requireUserAcknowledgmentSinceMs ?? null }
        : {}),
      ...completionSummaryPatch(input.status, completionSummary),
      updatedAtMs: Date.now(),
    });
    return this.applyBudgetDrivenStatus(next);
  }

  private hasReachedBudgetLimit(goal: GoalRecordV1): boolean {
    const { budgetCents } = goal;
    if (budgetCents == null || !hasGoalBudgetLimit(budgetCents)) {
      return false;
    }
    return getGoalCostMicroCents(goal) >= budgetCents * MICRO_CENTS_PER_CENT;
  }

  private hasReachedTurnLimit(goal: GoalRecordV1): boolean {
    return goal.turnCap != null && goal.turnsUsed >= goal.turnCap;
  }

  private hasReachedAnyLimit(goal: GoalRecordV1): boolean {
    return this.hasReachedBudgetLimit(goal) || this.hasReachedTurnLimit(goal);
  }

  private applyCostAccounting(
    goal: GoalRecordV1,
    costMicroCentsThisStream: number
  ): Pick<GoalRecordV1, "costCents" | "costMicroCents"> {
    const costMicroCents = getGoalCostMicroCents(goal) + costMicroCentsThisStream;
    return {
      costCents: Math.round(costMicroCents / MICRO_CENTS_PER_CENT),
      costMicroCents,
    };
  }

  private applyBudgetDrivenStatus(
    next: GoalRecordV1,
    options?: { originKind?: GoalStreamOriginKind }
  ): GoalRecordV1 {
    const normalizedBudgetCents = normalizeGoalBudgetCents(next.budgetCents);
    const normalized =
      normalizedBudgetCents === next.budgetCents
        ? next
        : GoalRecordV1Schema.parse({
            ...next,
            budgetCents: normalizedBudgetCents,
            updatedAtMs: Date.now(),
          });
    const reachedLimit = this.hasReachedAnyLimit(normalized);
    const shouldLimitActiveGoal = normalized.status === "active" && reachedLimit;
    const shouldRearmBudgetLimitedGoal = normalized.status === "budget_limited" && !reachedLimit;
    if (!shouldLimitActiveGoal && !shouldRearmBudgetLimitedGoal) {
      return normalized;
    }

    return GoalRecordV1Schema.parse({
      ...normalized,
      status: shouldLimitActiveGoal ? "budget_limited" : "active",
      // Raising/removing limits re-arms the one-shot budget wrap-up.
      budgetLimitInjectedForGoalId: shouldRearmBudgetLimitedGoal
        ? null
        : normalized.budgetLimitInjectedForGoalId,
      // Persist the origin kind on active→budget_limited so restart recovery
      // can decide whether to arm a wrap-up. Clear it when re-arming back to
      // `active` after the budget is raised or removed.
      budgetLimitOriginKind: shouldLimitActiveGoal
        ? (options?.originKind ?? null)
        : shouldRearmBudgetLimitedGoal
          ? null
          : normalized.budgetLimitOriginKind,
      updatedAtMs: Date.now(),
    });
  }

  private emitBudgetLimited(
    workspaceId: string,
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    properties?: GoalLifecycleProperties
  ): void {
    if (previousStatus === "budget_limited" || goal.status !== "budget_limited") {
      return;
    }

    this.timelineRecorder.record(workspaceId, {
      kind: "goal.budget_limited",
      source: { system: "goal", key: `goal-budget-limited:${goal.goalId}:${goal.updatedAtMs}` },
      status: "completed",
      data: { digest: goal.objective },
    });
    this.emitLifecycle("goal_budget_limited", {
      hasBudget: goal.budgetCents != null,
      hasTurnCap: goal.turnCap != null,
      "cost-overshoot": this.hasReachedBudgetLimit(goal)
        ? centsBucket(Math.max(0, goal.costCents - (goal.budgetCents ?? 0)))
        : null,
      "turn-overshoot": this.hasReachedTurnLimit(goal)
        ? countBucket(Math.max(0, goal.turnsUsed - (goal.turnCap ?? 0)))
        : null,
      ...(properties ?? {}),
    });
  }

  private budgetDeltaProperties(
    field: "budget" | "turn-cap",
    previous: number | null,
    next: number | null
  ): GoalLifecycleProperties {
    const previousValue = previous ?? 0;
    const nextValue = next ?? 0;
    const delta = nextValue - previousValue;
    let deltaSign = "zero";
    let raisedVsLowered = "unchanged";
    if (delta > 0) {
      deltaSign = "positive";
      raisedVsLowered = "raised";
    } else if (delta < 0) {
      deltaSign = "negative";
      raisedVsLowered = "lowered";
    }
    return {
      [`${field}-delta-sign`]: deltaSign,
      [`${field}-raised-vs-lowered`]: raisedVsLowered,
      [`${field}-delta-cents`]: field === "budget" ? delta : null,
      [`${field}-delta-turns`]: field === "turn-cap" ? delta : null,
    };
  }

  private emitBudgetChanged(
    current: GoalRecordV1 | null,
    next: GoalRecordV1,
    input: SetGoalInput
  ): void {
    const budgetTouched = Object.hasOwn(input, "budgetCents");
    const turnCapTouched = Object.hasOwn(input, "turnCap");
    if (!budgetTouched && !turnCapTouched) {
      return;
    }

    this.emitLifecycle("goal_budget_changed", {
      hasBudget: next.budgetCents != null,
      hasTurnCap: next.turnCap != null,
      ...(budgetTouched
        ? this.budgetDeltaProperties("budget", current?.budgetCents ?? null, next.budgetCents)
        : {}),
      ...(turnCapTouched
        ? this.budgetDeltaProperties("turn-cap", current?.turnCap ?? null, next.turnCap)
        : {}),
    });
  }

  private emitStatusLifecycle(
    goal: GoalRecordV1,
    previousStatus: GoalStatus,
    initiator: GoalLifecycleInitiator
  ): void {
    if (goal.status === previousStatus) {
      return;
    }

    if (goal.status === "paused") {
      this.emitLifecycle("goal_paused", { initiator });
    } else if (
      goal.status === "active" &&
      (previousStatus === "paused" || previousStatus === "complete")
    ) {
      // BudgetLimited → Active is a budget-driven re-arm, not a user resume;
      // it is reported via goal_budget_changed only. Complete → Active is
      // a user-initiated revive (validateStatusTransition only lets the
      // `user` initiator out of `complete`) — surface it as `goal_resumed`
      // so the lifecycle funnel sees revived goals symmetrically with
      // paused→active resumes.
      this.emitLifecycle("goal_resumed", { initiator });
    } else if (goal.status === "complete") {
      this.emitLifecycle("goal_completed", {
        initiator,
        summaryLengthBucket: lengthBucket(goal.completionSummary?.length ?? 0),
      });
    }
  }

  private getProvidersConfigForPricing(): ProvidersConfigMap | null {
    const maybeConfig = this.config as Config & {
      loadProvidersConfig?: () => ProvidersConfigMap | null;
    };
    if (typeof maybeConfig.loadProvidersConfig !== "function") {
      return null;
    }
    // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
    return maybeConfig.loadProvidersConfig() as unknown as ProvidersConfigMap | null;
  }

  async requestPendingGoalContinuationDispatch(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "requestPendingGoalContinuationDispatch requires workspaceId"
    );
    if (!this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    await this.goalContinuationDispatcher?.requestDispatch(
      workspaceId,
      GOAL_CONTINUATION_IDLE_CONSUMER_NAME
    );
  }

  async syncGoalModeWithChatTail(workspaceId: string): Promise<GoalRecordV1 | null> {
    assert(workspaceId.trim().length > 0, "syncGoalModeWithChatTail requires workspaceId");
    return this.syncGoalStatusToChatTail(workspaceId);
  }

  async getGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    return this.normalizeGoalLimits(workspaceId, { syncChatTail: true });
  }

  /**
   * Reject sends/resumes that would run a non-terminal budgeted goal on an
   * unpriced model. Without this gate, the turn streams happily, accounting
   * records 0 cost (no pricing data → `getTotalCost(...) ?? 0`), and budget
   * enforcement is silently bypassed for real work. Persistence-only blocks
   * are not enough: the actual stream is what burns the budget.
   *
   * Owned by WorkspaceGoalService so every dispatch path can share one gate
   * implementation:
   *  - `WorkspaceService.sendMessage` / `resumeStream` (initial calls) — to
   *    avoid persisting an unpriced model into workspace AI settings before
   *    the rejection.
   *  - `AgentSession.sendMessage` (every internal/queued/auto dispatch) — to
   *    catch races where the goal becomes budgeted while a queued message
   *    waits, or where a server-internal caller picks an unpriced model.
   *
   * Intentionally does NOT honour `options.skipAiSettingsPersistence`: that
   * field is part of the public `SendMessageOptionsSchema` and forwarded
   * verbatim by the router, so trusting it would let any oRPC caller flip a
   * single bool to disarm the gate. Internal compaction / heartbeat callers
   * always pick a priced model via `getPreferredCompactionSettings` /
   * heartbeat builders, so they hit the early `modelHasPricingData` exit
   * below without touching `goal.json`.
   */
  async assertPricedModelForBudgetedGoal(
    workspaceId: string,
    model: string | undefined
  ): Promise<Result<void, SendMessageError>> {
    if (!model || modelHasPricingData(model, this.getProvidersConfigForPricing())) {
      return Ok(undefined);
    }
    const goal = await this.getGoal(workspaceId);
    if (!hasBudgetedResumableGoal(goal)) {
      return Ok(undefined);
    }
    return Err({ type: "unknown", raw: UNPRICED_TARGET_MODEL_GOAL_MESSAGE });
  }

  async inheritFromFork(
    parentWorkspaceId: string,
    forkWorkspaceId: string
  ): Promise<GoalRecordV1 | null> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "inheritFromFork requires non-empty parentWorkspaceId"
    );
    assert(forkWorkspaceId.trim().length > 0, "inheritFromFork requires non-empty forkWorkspaceId");
    assert(
      parentWorkspaceId !== forkWorkspaceId,
      "inheritFromFork requires distinct parent and fork workspaces"
    );

    const parentGoal = await this.fileLocks.withLock(parentWorkspaceId, () =>
      this.readGoalFile(parentWorkspaceId)
    );
    if (!parentGoal) {
      return null;
    }

    const inherited = this.createGoal({
      objective: parentGoal.objective,
      budgetCents: parentGoal.budgetCents,
      turnCap: parentGoal.turnCap,
      status: "paused",
    });

    return this.fileLocks.withLock(forkWorkspaceId, async () => {
      const existingForkGoal = await this.readGoalFile(forkWorkspaceId);
      assert(existingForkGoal == null, "inheritFromFork expects a fresh fork workspace goal file");
      await this.writeGoal(forkWorkspaceId, inherited);
      await this.pushSnapshot(forkWorkspaceId, inherited);
      this.emitLifecycle("goal_created", {
        viaFork: true,
        sourceStatus: parentGoal.status,
        objectiveLengthBucket: lengthBucket(inherited.objective.length),
        hasBudget: inherited.budgetCents != null,
        hasTurnCap: inherited.turnCap != null,
      });
      return inherited;
    });
  }

  async setGoal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    // Catch the two known throw paths (`assertParentWorkspace` and
    // `applyMutableFields`/`validateStatusTransition`) and surface them as
    // typed Result errors so the oRPC `setGoal` handler does not leak them as
    // unhandled 500s.
    try {
      return await this.setGoalInternal(input);
    } catch (error) {
      if (error instanceof WorkspaceGoalChildWorkspaceError) {
        return Err({ type: "child_workspace", message: error.message });
      }
      if (error instanceof WorkspaceGoalTransitionError) {
        return Err({ type: "invalid_transition", message: error.message });
      }
      throw error;
    }
  }

  private async setGoalInternal(input: SetGoalInput): Promise<Result<GoalRecordV1, GoalSetError>> {
    const objective = input.objective?.trim();
    this.assertParentWorkspace(input.workspaceId);
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): captured synchronously at entry so the
    // in-lock recheck below can detect a stream-end drain that started or
    // finished while this setter was in flight. The extension-metadata
    // streaming flag updates asynchronously after stream end, so it alone can
    // hold a stale "live" long enough for a setter to queue a mutation the
    // drain has already stopped watching for.
    const drainGenerationAtEntry = this.streamEndDrainGenerations.get(input.workspaceId) ?? 0;

    if (!objective && this.pendingGoalSnapshots.has(input.workspaceId)) {
      // Until stream-end persists the queued objective, status/budget-only edits
      // would target the old durable goal (or no goal) while the panel displays
      // the optimistic replacement. Reject them instead of mutating the wrong record.
      return Err({ type: "invalid_transition", message: PENDING_GOAL_EDIT_MESSAGE });
    }

    // -----------------------------------------------------------------------
    // Mid-stream branch: setGoal during an active stream defers the actual
    // disk write until applyPendingAfterStreamEnd. The returned `Ok(projected)`
    // is a synthetic record for immediate UI rendering; it has NOT been
    // persisted yet.
    //
    // The projected goalId is persisted through the queued mutation so model
    // tool results remain valid optimistic-concurrency tokens after stream-end.
    // Without carrying this id into the drain, a transcript-persisted set_goal
    // result could point complete_goal at a throwaway pre-persistence id.
    // -----------------------------------------------------------------------
    if (objective && (await this.isWorkspaceStreaming(input.workspaceId))) {
      const deferredResult = await this.fileLocks.withLock(input.workspaceId, async () => {
        if (
          !(await this.isWorkspaceStreaming(input.workspaceId)) ||
          (this.streamEndDrainGenerations.get(input.workspaceId) ?? 0) !== drainGenerationAtEntry
        ) {
          // The stream can end while this caller waits for the goal file lock.
          // Persist immediately instead of queueing after stream-end already
          // drained. The drain-generation check covers the stale-streaming
          // window: the async streaming flag can still read "live" after the
          // drain finished, and a mutation installed then would be stranded.
          return null;
        }
        const current = await this.readGoalFile(input.workspaceId);
        const conflict =
          this.conflictForExpectedGoalId(current, input.expectedGoalId) ??
          this.conflictForReplacementGuard(current, input.replacementGuard);
        if (conflict) {
          return Err(conflict);
        }
        // For an `editInPlace` rename, the eventual drain renames the
        // existing record instead of creating a fresh one. Mirror that path
        // here so the optimistic Goal tab snapshot preserves id/accounting
        // and applies budget-driven status before stream end.
        let projected: GoalRecordV1;
        let projectedIsFreshGoal = false;
        if (input.editInPlace === true && current) {
          const renamed = GoalRecordV1Schema.parse({
            ...current,
            objective,
            updatedAtMs: Date.now(),
          });
          projected = this.applyMutableFields(renamed, input);
        } else if (input.forceNewGoal !== true && current?.objective === objective) {
          const hasMutableChange =
            input.status != null ||
            input.completionSummary != null ||
            Object.hasOwn(input, "budgetCents") ||
            Object.hasOwn(input, "turnCap") ||
            Object.hasOwn(input, "requireUserAcknowledgmentSinceMs");
          projected = hasMutableChange ? this.applyMutableFields(current, input) : current;
        } else {
          projected = this.createGoal({
            objective,
            budgetCents: input.budgetCents ?? null,
            turnCap: input.turnCap ?? null,
            status: input.status,
            completionSummary: input.completionSummary,
          });
          projectedIsFreshGoal = true;
        }
        if (
          (projected.status === "active" || projected.status === "budget_limited") &&
          !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, projected))
        ) {
          return Err({
            type: "invalid_transition" as const,
            message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
          });
        }
        if (
          !(await this.isWorkspaceStreaming(input.workspaceId)) ||
          (this.streamEndDrainGenerations.get(input.workspaceId) ?? 0) !== drainGenerationAtEntry
        ) {
          // Avoid queueing after the one stream-end drain has already observed no
          // pending mutation (stale-streaming reads included — see the
          // drain-generation comment on the first recheck above).
          return null;
        }
        // Codex P1 (PRRT_kwDOPxxmWM6b-orH): the mutation must be installed
        // synchronously after the streaming
        // re-check, BEFORE the publication await. `recordUserStoppedStream`
        // deletes pending mutations synchronously before taking the goal file
        // lock, so a user abort landing during publication must find the
        // mutation already installed — installing it afterwards would
        // resurrect a goal the abort just discarded, silently applying it at
        // the end of the NEXT stream (AgentSession deliberately skips the
        // stream-end drain for user aborts).
        const pendingMutation: PendingGoalMutation = {
          objective,
          ...(Object.hasOwn(input, "budgetCents")
            ? { budgetCents: input.budgetCents ?? null }
            : {}),
          ...(Object.hasOwn(input, "turnCap") ? { turnCap: input.turnCap ?? null } : {}),
          ...(input.status != null ? { status: input.status } : {}),
          ...(input.completionSummary != null
            ? { completionSummary: input.completionSummary }
            : {}),
          ...(Object.hasOwn(input, "expectedGoalId")
            ? { expectedGoalId: input.expectedGoalId ?? null }
            : {}),
          ...(input.replacementGuard != null ? { replacementGuard: input.replacementGuard } : {}),
          ...(input.initiator != null ? { initiator: input.initiator } : {}),
          ...(input.forceNewGoal != null ? { forceNewGoal: input.forceNewGoal } : {}),
          projectedGoalId: projected.goalId,
          projectedCreatedAtMs: projected.createdAtMs,
          // Forward `editInPlace` so an inline rename submitted while the
          // agent is streaming still takes the rename branch when the
          // pending mutation drains.
          ...(input.editInPlace != null ? { editInPlace: input.editInPlace } : {}),
        };
        this.pendingGoalMutations.set(input.workspaceId, pendingMutation);
        // A user can run /goal while the first turn is still streaming. The
        // durable goal write must wait for stream accounting, but the Goal panel
        // reads activity snapshots, so publish the projected goal immediately
        // without persisting this crash-unsafe optimistic state.
        await this.publishPendingGoalSnapshot(input.workspaceId, projected);
        if (
          projectedIsFreshGoal &&
          this.pendingGoalMutations.get(input.workspaceId) === pendingMutation
        ) {
          // Codex P2 (PRRT_kwDOPxxmWM6b-CH5, PRRT_kwDOPxxmWM6b-Uli): stamp
          // fresh-goal creation AFTER publication completes. createGoal()'s
          // construction stamp predates the kickoff-model validation await,
          // the streaming re-check, and the async activity-snapshot read
          // inside publication — a message queued during any of those awaits
          // postdated that stamp while the goal was not yet visible anywhere,
          // so the pre-goal guard (enqueuedAtMs <= createdAtMs) misread it as
          // an intervention against a goal the user could not have seen.
          // Existing-goal branches keep their original durable createdAtMs —
          // those goals were published long ago.
          //
          // The identity guard (Codex P1 PRRT_kwDOPxxmWM6b-orH) skips the
          // re-stamp when a user abort (or competing setter) removed or
          // replaced OUR mutation during the publication await — re-installing
          // the mutation or snapshot here would resurrect state the abort
          // deliberately discarded.
          const publishedAtMs = Date.now();
          projected = GoalRecordV1Schema.parse({
            ...projected,
            createdAtMs: publishedAtMs,
            updatedAtMs: publishedAtMs,
          });
          this.pendingGoalMutations.set(input.workspaceId, {
            ...pendingMutation,
            projectedCreatedAtMs: publishedAtMs,
          });
          // Sync the in-memory pending snapshot so later re-publishes match
          // what the drain will persist.
          this.pendingGoalSnapshots.set(input.workspaceId, toPendingGoalSnapshot(projected));
        }
        return Ok(projected);
      });
      if (deferredResult != null) {
        return deferredResult;
      }
    }

    return this.setGoalImmediately({ ...input, objective });
  }

  private async canRunBudgetedGoalOnKickoffModel(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<boolean> {
    if (!hasBudgetedResumableGoal(goal)) {
      return true;
    }
    const model = (await this.goalContinuationBridge?.getKickoffSendOptions?.(workspaceId))?.model;
    if (!model) {
      return true;
    }
    return modelHasPricingData(model, this.getProvidersConfigForPricing());
  }

  private async setGoalImmediately(
    input: SetGoalInput & { objective?: string },
    options?: { replacementGoalId?: string | null; replacementCreatedAtMs?: number | null }
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    const result = await this.fileLocks.withLock(input.workspaceId, () =>
      this.persistGoalMutationLocked(input, options)
    );
    return this.finalizeGoalPersistence(input, result);
  }

  /**
   * Locked core of `setGoalImmediately`: validates guards against the durable
   * record and persists. Callers MUST hold the goal file lock. The stream-end
   * drain calls this inside its claim tenure (Codex P2 PRRT_kwDOPxxmWM6cBACj)
   * so no setter can interleave between claiming a pending mutation and
   * persisting it — every later setter therefore validates its guards against
   * durable state that already includes the drained mutation.
   */
  private async persistGoalMutationLocked(
    input: SetGoalInput & { objective?: string },
    options?: { replacementGoalId?: string | null; replacementCreatedAtMs?: number | null }
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    {
      const current = await this.readGoalFile(input.workspaceId);
      const conflict =
        this.conflictForExpectedGoalId(current, input.expectedGoalId) ??
        this.conflictForReplacementGuard(current, input.replacementGuard);
      if (conflict) {
        return Err(conflict);
      }
      const trimmedObjective = input.objective?.trim();
      const objective =
        trimmedObjective && trimmedObjective.length > 0 ? trimmedObjective : current?.objective;
      if (!objective) {
        // No objective + status mutation + no current goal will fall into
        // `validateStatusTransition(null, ...)` below, which throws a typed
        // `WorkspaceGoalTransitionError`. That throw is caught by the outer
        // `setGoal` wrapper and surfaced as a typed `invalid_transition`
        // Result error — no
        // unhandled 500 reaches the oRPC layer.
        if (input.status != null) {
          this.validateStatusTransition(
            null,
            input.status,
            input.completionSummary?.trim() ?? null,
            input.initiator ?? "user"
          );
        }
        // No-objective + no-status path (e.g. RightSidebar "Update budget"
        // race where another window cleared the goal concurrently): use the
        // typed transition error so the outer `setGoal` wrapper surfaces it
        // as a typed `invalid_transition` Result instead of letting a plain
        // Error escape as an unhandled 500.
        throw new WorkspaceGoalTransitionError(
          "Goal objective is required because no goal currently exists for this workspace."
        );
      }

      // Edit-in-place objective change: when the caller is the right-sidebar
      // "Edit goal objective" affordance (or any other entry point that opts in
      // via `editInPlace`), changing the objective on the existing goal should
      // feel like editing budget / turn-cap — preserve `goalId` + accounting.
      // The default `setGoal` path (slash command, kickoff prompts) still
      // archives + recreates because callers there express the intent "start a
      // new goal", not "rename the current one".
      const isEditInPlace =
        input.editInPlace === true && current != null && current.objective !== objective;
      if (isEditInPlace) {
        const previousStatus = current.status;
        const renamed = GoalRecordV1Schema.parse({
          ...current,
          objective,
          updatedAtMs: Date.now(),
        });
        // Apply other inline edits (status / budget / turnCap) on top of the
        // renamed record so a single payload can rename and update budget
        // atomically.
        const withEdits = this.applyMutableFields(renamed, input);
        if (
          (withEdits.status === "active" || withEdits.status === "budget_limited") &&
          !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, withEdits))
        ) {
          return Err({
            type: "invalid_transition" as const,
            message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
          });
        }
        await this.writeGoal(input.workspaceId, withEdits);
        await this.pushSnapshot(input.workspaceId, withEdits);
        await this.pushLiveGoalPreviewOverlay(input.workspaceId, withEdits);
        this.emitBudgetChanged(current, withEdits, input);
        this.emitBudgetLimited(input.workspaceId, withEdits, previousStatus);
        this.emitStatusLifecycle(withEdits, previousStatus, input.initiator ?? "user");
        // Lifecycle event: this is a rename, not a replace. Reuse
        // `goal_replaced` (same-objective semantics already overloaded for
        // attribute-only mutations) with `sameObjective: false` so analytics
        // can still distinguish rename from a full reset by checking
        // `goalId` continuity in the funnel.
        this.emitLifecycle("goal_replaced", {
          sameObjective: false,
          objectiveLengthBucket: lengthBucket(objective.length),
          hasBudget: withEdits.budgetCents != null,
          hasTurnCap: withEdits.turnCap != null,
          editInPlace: true,
        });
        await this.maybeAutoPromoteOnComplete(input.workspaceId, withEdits, previousStatus);
        return Ok(withEdits);
      }

      if (input.forceNewGoal !== true && current?.objective === objective) {
        const hasMutableChange =
          input.status != null ||
          input.completionSummary != null ||
          Object.hasOwn(input, "budgetCents") ||
          Object.hasOwn(input, "turnCap") ||
          Object.hasOwn(input, "requireUserAcknowledgmentSinceMs");
        const previousStatus = current.status;
        let updated = hasMutableChange ? this.applyMutableFields(current, input) : current;
        if (hasMutableChange) {
          if (
            (updated.status === "active" || updated.status === "budget_limited") &&
            !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, updated))
          ) {
            return Err({
              type: "invalid_transition" as const,
              message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
            });
          }

          // User resume is an explicit opt-in after a stop/crash gate; clear
          // both the in-memory stop marker and persisted acknowledgment gate.
          if (
            previousStatus === "paused" &&
            updated.status === "active" &&
            (input.initiator ?? "user") === "user"
          ) {
            this.lastUserStopAtMsByWorkspace.delete(input.workspaceId);
            updated = GoalRecordV1Schema.parse({
              ...updated,
              requireUserAcknowledgmentSinceMs: null,
              updatedAtMs: Date.now(),
            });
          }
          await this.writeGoal(input.workspaceId, updated);
          await this.pushSnapshot(input.workspaceId, updated);
          await this.pushLiveGoalPreviewOverlay(input.workspaceId, updated);
          this.emitBudgetChanged(current, updated, input);
          this.emitBudgetLimited(input.workspaceId, updated, previousStatus);
          this.emitStatusLifecycle(updated, previousStatus, input.initiator ?? "user");
          await this.maybeAutoPromoteOnComplete(input.workspaceId, updated, previousStatus);
        }
        if (input.objective != null) {
          this.emitLifecycle("goal_replaced", {
            sameObjective: true,
            objectiveLengthBucket: lengthBucket(objective.length),
            hasBudget: updated.budgetCents != null,
            hasTurnCap: updated.turnCap != null,
          });
        }
        return Ok(updated);
      }

      let next = this.createGoal({
        objective,
        budgetCents: input.budgetCents ?? null,
        turnCap: input.turnCap ?? null,
        status: input.status,
        completionSummary: input.completionSummary,
        goalId: options?.replacementGoalId ?? null,
        createdAtMs: options?.replacementCreatedAtMs ?? null,
      });
      if (
        (next.status === "active" || next.status === "budget_limited") &&
        !(await this.canRunBudgetedGoalOnKickoffModel(input.workspaceId, next))
      ) {
        return Err({
          type: "invalid_transition" as const,
          message: UNPRICED_TARGET_MODEL_GOAL_MESSAGE,
        });
      }
      this.liveGoalPreviewSnapshots.delete(input.workspaceId);
      // Archive the outgoing goal to history before we overwrite goal.json.
      // The new goal gets a fresh `goalId` so the right-sidebar GoalTab needs
      // a record of the prior one in its completed-goals list (cleared/
      // replaced/completed all flow through here for the "previous current
      // goal" snapshot).
      if (current) {
        await this.appendGoalHistoryEntry(
          input.workspaceId,
          current,
          current.status === "complete" ? "completed" : "replaced"
        );
      }
      await this.writeGoal(input.workspaceId, next);
      await this.pushSnapshot(input.workspaceId, next);
      if (options?.replacementCreatedAtMs == null) {
        // Codex P2 (PRRT_kwDOPxxmWM6cBr9B): direct creations must also carry a
        // publication-time createdAtMs. The construction stamp above predates
        // the kickoff-model validation, history-archive, and write/push awaits
        // — a message the user authored during those awaits would postdate it
        // and be misread as an intervention against a goal not yet visible.
        // No await sits between the snapshot push resolving and this re-stamp,
        // so nothing can be admitted in between; the durable record carries
        // the publication stamp (crash between the writes leaves the
        // provisional stamp — today's behavior). Drained queued mutations pass
        // replacementCreatedAtMs and already carry their publication stamp.
        const publishedAtMs = Date.now();
        next = GoalRecordV1Schema.parse({
          ...next,
          createdAtMs: publishedAtMs,
          updatedAtMs: publishedAtMs,
        });
        await this.writeGoal(input.workspaceId, next);
      }
      this.emitBudgetChanged(current, next, input);
      this.emitLifecycle(current ? "goal_replaced" : "goal_created", {
        sameObjective: current?.objective === objective,
        objectiveLengthBucket: lengthBucket(objective.length),
        hasBudget: next.budgetCents != null,
        hasTurnCap: next.turnCap != null,
      });
      return Ok(next);
    }
  }

  /**
   * Post-lock finalization shared by `setGoalImmediately` and the stream-end
   * drain: lifecycle/timeline side effects, pause-boundary handling, kickoff
   * arming, and chat-tail syncs. Runs outside the goal file lock.
   */
  private async finalizeGoalPersistence(
    input: SetGoalInput & { objective?: string },
    result: Result<GoalRecordV1, GoalSetError>
  ): Promise<Result<GoalRecordV1, GoalSetError>> {
    if (!result.success) {
      return result;
    }

    if (input.objective != null) {
      this.recordGoalSet(input.workspaceId, result.data);
    }
    if (input.status === "complete" && result.data.status === "complete") {
      this.timelineRecorder.record(input.workspaceId, {
        kind: "goal.completed",
        source: {
          system: "goal",
          key: `goal-completed:${result.data.goalId}:${result.data.updatedAtMs}`,
        },
        status: "completed",
        data: { digest: result.data.completionSummary ?? result.data.objective },
      });
    }

    if (input.status === "paused" && result.data.status === "paused") {
      this.pendingContinuationCandidates.delete(input.workspaceId);
      const pauseBoundaryReady = await this.appendGoalPauseBoundaryIfNeeded(input.workspaceId);
      if (!pauseBoundaryReady) {
        return result;
      }
      const synced = await this.syncGoalStatusToChatTail(input.workspaceId);
      return Ok(synced ?? result.data);
    }

    if (result.data.status === "active") {
      await this.armKickoffContinuationIfIdle(input.workspaceId, result.data);
      if (input.initiator === "model") {
        // A model-created set_goal starts from an ordinary user turn, not a
        // goal-continuation row. Do not reconcile it against chat tail here or
        // the new goal pauses itself before its kickoff continuation can run.
        return result;
      }
      const synced = await this.syncGoalStatusToChatTail(input.workspaceId);
      return Ok(synced ?? result.data);
    }
    if (result.data.status === "budget_limited") {
      await this.armBudgetWrapupForBudgetLimitedGoal(input.workspaceId, result.data);
    }
    return result;
  }

  /**
   * Arm a pending continuation candidate whose request and stream-end
   * timestamps are both "now". Shared by the kickoff and budget-wrap-up paths,
   * which arm an otherwise-identical candidate differing only in `source`. The
   * stream_end path is intentionally not routed through here because it carries
   * an inbound `streamEndedAtMs` and pre-normalized `sendOptions`.
   */
  private armImmediateContinuationCandidate(
    workspaceId: string,
    goal: GoalRecordV1,
    source: "kickoff" | "budget_wrapup",
    sendOptions: SendMessageOptions
  ): void {
    const nowMs = Date.now();
    this.pendingContinuationCandidates.set(workspaceId, {
      goalId: goal.goalId,
      requestedAtMs: nowMs,
      streamEndedAtMs: nowMs,
      source,
      sendOptions: continuationSendOptions(sendOptions),
    });
  }

  private async armKickoffContinuationIfIdle(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<void> {
    if (this.suppressKickoffContinuation) {
      return;
    }
    if (goal.status !== "active") {
      return;
    }
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    const existingCandidate = this.pendingContinuationCandidates.get(workspaceId);
    if (existingCandidate?.goalId === goal.goalId) {
      // A real stream-end already armed this goal; re-request dispatch in case
      // the previous request was consumed while an acknowledgment gate was set.
      try {
        await this.goalContinuationDispatcher.requestDispatch(
          workspaceId,
          GOAL_CONTINUATION_IDLE_CONSUMER_NAME
        );
      } catch (error: unknown) {
        log.warn("Failed to re-request kickoff goal continuation dispatch", {
          workspaceId,
          error,
        });
      }
      return;
    }
    const sendOptions = await this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions) {
      return;
    }
    if (sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }

    this.armImmediateContinuationCandidate(workspaceId, goal, "kickoff", sendOptions);
    try {
      await this.goalContinuationDispatcher.requestDispatch(
        workspaceId,
        GOAL_CONTINUATION_IDLE_CONSUMER_NAME
      );
    } catch (error: unknown) {
      log.warn("Failed to request kickoff goal continuation dispatch", { workspaceId, error });
    }
  }

  // Promotions write goal.json directly instead of going through `setGoal`, so they must record the
  // new objective themselves: otherwise the workspace's active goal changes with no timeline row.
  private recordGoalSet(workspaceId: string, goal: GoalRecordV1): void {
    this.timelineRecorder.record(workspaceId, {
      kind: "goal.set",
      source: { system: "goal", key: `goal-set:${goal.goalId}:${goal.updatedAtMs}` },
      status: "completed",
      data: { digest: goal.objective },
    });
  }

  private armContinuationForPromotedGoal(workspaceId: string, goal: GoalRecordV1): void {
    // Promotion is an explicit handoff to this queued goal. Any stop/ack gate
    // was attached to an older active turn and would otherwise strand the
    // promoted goal until the user pause/unpauses it.
    this.lastUserStopAtMsByWorkspace.delete(workspaceId);
    if (goal.status === "active") {
      this.armKickoffContinuationIfIdle(workspaceId, goal).catch((error: unknown) => {
        log.warn("Failed to arm promoted goal continuation", { workspaceId, error });
      });
    } else if (goal.status === "budget_limited") {
      this.armBudgetWrapupForBudgetLimitedGoal(workspaceId, goal).catch((error: unknown) => {
        log.warn("Failed to arm promoted goal budget wrap-up", { workspaceId, error });
      });
    }
  }

  /**
   * Re-arm pending continuation / budget-wrap-up dispatches after a process
   * restart. `pendingContinuationCandidates` and `lastGoalStreamStamps` are
   * in-memory and are wiped on restart; the goal record on disk is the
   * persisted source of truth, so we re-derive whatever dispatch state is
   * owed by the persisted status.
   *
   * Without this, a `budget_limited` goal with `budgetLimitInjectedForGoalId
   * === null` (i.e. the budget was hit but the wrap-up message had not yet
   * fired before the crash) is permanently stranded:
   *   - eligibility lookup finds no in-memory stamp and returns
   *     `budget_wrapup_suppressed`, deleting the candidate.
   *   - `armKickoffContinuationIfIdle` only fires for `status === "active"`.
   *
   * The user would need to manually clear the goal or raise the budget to
   * recover. Instead we synthesize the stamp + candidate so the wrap-up can
   * fire on the next idle moment.
   *
   * Called from `AgentSession.runStartupRecovery` per workspace.
   */
  async recoverPendingDispatchAfterRestart(workspaceId: string): Promise<void> {
    assert(
      workspaceId.trim().length > 0,
      "recoverPendingDispatchAfterRestart requires workspaceId"
    );
    const goal = await this.normalizeGoalLimits(workspaceId, { syncChatTail: true });
    if (!goal) {
      return;
    }
    if (goal.status === "active") {
      await this.armKickoffContinuationIfIdle(workspaceId, goal);
      await this.syncGoalStatusToChatTail(workspaceId);
      return;
    }
    if (goal.status === "budget_limited" && goal.budgetLimitInjectedForGoalId === null) {
      // only synthesize a wrap-up if the stream that hit the
      // budget was goal-attributable. A user-origin stream that exhausted
      // the budget was correctly suppressed pre-restart
      // (`checkGoalContinuationEligibility` rejects it as
      // `budget_wrapup_suppressed`); after restart we'd otherwise lose that
      // suppression because in-memory `lastGoalStreamStamps` is empty and
      // this function would synthesize a `GOAL_CONTINUATION_KIND` stamp.
      // Legacy goal records with `budgetLimitOriginKind` undefined arm by
      // default — the field is new and most existing budget_limited goals
      // would otherwise be permanently stranded.
      const originKind = goal.budgetLimitOriginKind ?? null;
      if (originKind === "user") {
        return;
      }
      await this.armBudgetWrapupForBudgetLimitedGoal(workspaceId, goal);
    }
  }

  /**
   * Synthesize a `GOAL_CONTINUATION_KIND` stream stamp + arm a continuation
   * candidate so the budget-wrap-up eligibility check passes its identity
   * guards (`lastStreamStamp.goalId === goal.goalId` && a non-user origin).
   *
   * Called from two paths:
   *   1. `recoverPendingDispatchAfterRestart` — in-memory dispatch state was
   *      wiped on restart and the persisted goal is `budget_limited` with no
   *      wrap-up injected.
   *   2. `attributeChildReport` — a child task's cost rolled the goal into
   *      `budget_limited`. Without this the wrap-up never fires because the
   *      attribution path does not produce a continuation-origin stream.
   */
  private async armBudgetWrapupForBudgetLimitedGoal(
    workspaceId: string,
    goal: GoalRecordV1
  ): Promise<void> {
    if (this.goalContinuationDispatcher == null || this.goalContinuationBridge == null) {
      return;
    }
    if (this.pendingContinuationCandidates.has(workspaceId)) {
      return;
    }
    const sendOptions = await this.goalContinuationBridge.getKickoffSendOptions?.(workspaceId);
    if (!sendOptions || sendOptions.agentId === "plan" || sendOptions.agentId === "compact") {
      return;
    }

    this.recordLastGoalStream(workspaceId, GOAL_CONTINUATION_KIND, goal.goalId);
    this.armImmediateContinuationCandidate(workspaceId, goal, "budget_wrapup", sendOptions);
    this.goalContinuationDispatcher
      .requestDispatch(workspaceId, GOAL_CONTINUATION_IDLE_CONSUMER_NAME)
      .catch((error: unknown) => {
        log.warn("Failed to request budget-wrap-up dispatch", {
          workspaceId,
          error,
        });
      });
  }

  async requireUserAcknowledgment(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgment requires a non-negative integer timestamp"
    );
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: sinceMs,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  async acknowledgeUser(workspaceId: string): Promise<GoalRecordV1 | null> {
    assert(workspaceId.trim().length > 0, "acknowledgeUser requires workspaceId");
    return this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }
      if (current.requireUserAcknowledgmentSinceMs == null) {
        await this.pushSnapshot(workspaceId, current);
        return current;
      }

      const next = this.applyMutableFields(current, {
        workspaceId,
        requireUserAcknowledgmentSinceMs: null,
      });
      await this.writeGoal(workspaceId, next);
      await this.pushSnapshot(workspaceId, next);
      return next;
    });
  }

  async requireUserAcknowledgmentForCrashRecovery(
    workspaceId: string,
    sinceMs = Date.now()
  ): Promise<GoalRecordV1 | null> {
    assert(
      Number.isInteger(sinceMs) && sinceMs >= 0,
      "requireUserAcknowledgmentForCrashRecovery requires a non-negative integer timestamp"
    );
    const next = await this.requireUserAcknowledgment(workspaceId, sinceMs);
    if (next) {
      this.emitLifecycle("goal_crash_gate_set", {
        workspaceIdLengthBucket: lengthBucket(workspaceId.length),
      });
    }
    return next;
  }

  private recordLastGoalStream(
    workspaceId: string,
    originKind: GoalStreamOriginKind,
    goalId: string | null
  ): GoalStreamStamp {
    const stamp = {
      originKind,
      sequence: this.nextGoalStreamStampSequence,
      goalId,
    };
    this.nextGoalStreamStampSequence += 1;
    this.lastGoalStreamStamps.set(workspaceId, stamp);
    return stamp;
  }

  /**
   * Push a live cost preview to the activity snapshot. The cost is the
   * cumulative current-stream cost on top of the durable base;
   * `recordStreamAccounting` performs final accounting at stream end.
   *
   * Previously this path always called `pushSnapshot` which rewrote the
   * shared `extensionMetadata.json` (writeFileAtomic, serialized through a
   * global mutation lock) on every `usage-delta` event. That made the Goals
   * UI cost lag behind the Stats/Costs tabs mid-stream: Stats reads the
   * frontend aggregator in-memory, while Goal cost waited on a per-delta
   * disk write + activity round-trip. Restart recovery overwrites
   * extensionMetadata from goal.json anyway (`restorePersistedGoalSnapshot`
   * and `restoreGoalAccountingSnapshot`), so preview writes were redundant
   * once a baseline activity snapshot exists.
   *
   * Prefer `pushTransientGoalSnapshot` so subscribers (the renderer's
   * WorkspaceStore, the Goal tab) receive the preview without the global
   * write lock. If no baseline activity exists yet, fall back to
   * `pushSnapshot` so the first preview still creates and emits the
   * workspace activity entry instead of being dropped.
   */
  async previewStreamAccounting(input: StreamAccountingInput): Promise<GoalSnapshot | null> {
    assert(input.workspaceId.trim().length > 0, "previewStreamAccounting requires workspaceId");
    if (input.isCompaction === true) {
      return null;
    }

    const pendingSnapshot = this.pendingGoalSnapshots.get(input.workspaceId);
    if (pendingSnapshot) {
      return pendingSnapshot;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        return null;
      }
      if (
        input.streamStartedAtMs != null &&
        this.recordedStreamStartedAtMsByWorkspace.get(input.workspaceId) === input.streamStartedAtMs
      ) {
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        return toGoalSnapshot(current);
      }
      // Mirror recordStreamAccounting's maintenance skip: final accounting
      // discards non-goal-driven cost on a budget_limited goal, so previewing
      // it would show climbing cost mid-stream that snaps back at stream end.
      const previewOriginKind = input.streamOriginKind ?? "user";
      if (
        current.status === "budget_limited" &&
        previewOriginKind !== "goal_continuation" &&
        previewOriginKind !== "goal_budget_limit"
      ) {
        return toGoalSnapshot(current);
      }

      const preview = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        updatedAtMs: Date.now(),
      });
      const snapshot = toGoalSnapshot(preview);
      this.liveGoalPreviewSnapshots.set(input.workspaceId, snapshot);
      const didEmitTransient = await this.pushTransientGoalSnapshot(input.workspaceId, snapshot);
      if (!didEmitTransient) {
        // If the baseline activity snapshot does not exist yet (for
        // example, extensionMetadata was reset or stream-start's
        // fire-and-forget metadata write has not finished), fall back to
        // the durable path so this preview is still delivered to Goals UI
        // subscribers instead of being dropped.
        return this.pushSnapshot(input.workspaceId, preview);
      }
      return snapshot;
    });
  }

  async recordStreamAccounting(input: StreamAccountingInput): Promise<GoalRecordV1 | null> {
    assert(input.workspaceId.trim().length > 0, "recordStreamAccounting requires workspaceId");
    const originKind = input.streamOriginKind ?? (input.isCompaction === true ? "other" : "user");

    if (input.isCompaction === true) {
      this.recordLastGoalStream(input.workspaceId, originKind, null);
      return null;
    }

    const costMicroCentsThisStream = costUsdToMicroCents(input.costUsd);
    this.liveGoalPreviewSnapshots.delete(input.workspaceId);
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const current = await this.readGoalFile(input.workspaceId);
      if (!current) {
        this.recordLastGoalStream(input.workspaceId, originKind, null);
        return null;
      }

      if (input.streamStartedAtMs != null && current.createdAtMs > input.streamStartedAtMs) {
        this.recordLastGoalStream(input.workspaceId, originKind, current.goalId);
        await this.pushSnapshot(input.workspaceId, current);
        return null;
      }

      // Non-running goals only accrue cost from streams that are actually goal
      // work racing the status change (an in-flight continuation or budget
      // wrap-up). Maintenance streams — scheduled heartbeats ("user" origin,
      // no agentInitiated flag) and background wake turns ("other") — must not
      // charge turns/cost or bump updatedAtMs on a goal that is not running;
      // doing so made every heartbeat/wake look like it had just touched the
      // goal. `budget_limited` is included so background activity while the
      // wrap-up is pending cannot inflate the recorded overshoot. Mirrors
      // attributeChildReport's paused/complete skip.
      const isGoalDrivenStream =
        originKind === "goal_continuation" || originKind === "goal_budget_limit";
      if (current.status !== "active" && !isGoalDrivenStream) {
        // Codex P2 (PRRT_kwDOPxxmWM6cBACb, PRRT_kwDOPxxmWM6cBr9I): a skipped
        // maintenance stream on a budget_limited goal must never overwrite
        // the stamp of the stream that hit the budget. A goal-driven stamp
        // keeps the pending wrap-up eligible (overwriting it would suppress
        // the final wrap-up turn); a user-origin stamp deliberately
        // suppresses the wrap-up (overwriting it with a wake's "other" stamp
        // would dispatch an autonomous wrap-up the user's own budget-limited
        // stream intentionally blocked). Only stamp when no stamp exists for
        // this goal (e.g. after restart, where suppression is handled by the
        // durable budgetLimitInjectedForGoalId gate).
        const existingStamp = this.lastGoalStreamStamps.get(input.workspaceId);
        const preserveExistingStamp =
          current.status === "budget_limited" && existingStamp?.goalId === current.goalId;
        if (!preserveExistingStamp) {
          this.recordLastGoalStream(input.workspaceId, originKind, current.goalId);
        }
        await this.pushSnapshot(input.workspaceId, current);
        return current;
      }

      // Only count goal-attributable turns. A rare `user`-origin stream that
      // reaches here while still active must not consume a turn against the cap.
      const turnsDelta = originKind === "user" ? 0 : 1;
      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, costMicroCentsThisStream),
        turnsUsed: current.turnsUsed + turnsDelta,
        updatedAtMs: Date.now(),
      });
      const next = this.applyBudgetDrivenStatus(accounted, { originKind });
      if (input.streamStartedAtMs != null) {
        this.recordedStreamStartedAtMsByWorkspace.set(input.workspaceId, input.streamStartedAtMs);
      }
      await this.writeGoal(input.workspaceId, next);
      await this.pushSnapshot(input.workspaceId, next);
      this.recordLastGoalStream(input.workspaceId, originKind, next.goalId);
      this.emitBudgetLimited(input.workspaceId, next, current.status);
      return next;
    });
  }

  async attributeChildReport(
    input: ChildReportAttributionInput
  ): Promise<ChildReportAttributionResult | null> {
    assert(
      input.parentWorkspaceId.trim().length > 0,
      "attributeChildReport requires parentWorkspaceId"
    );
    assert(
      input.childWorkspaceId.trim().length > 0,
      "attributeChildReport requires childWorkspaceId"
    );
    assert(
      input.parentWorkspaceId !== input.childWorkspaceId,
      "attributeChildReport requires distinct parent and child workspaces"
    );
    assert(
      Number.isInteger(input.childCostCents) && input.childCostCents >= 0,
      "attributeChildReport requires a non-negative integer childCostCents"
    );

    return this.fileLocks.withLock(input.parentWorkspaceId, async () => {
      const current = await this.readGoalFile(input.parentWorkspaceId);
      if (!current) {
        return null;
      }

      if (current.status === "paused" || current.status === "complete") {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      if (current.attributedChildren.includes(input.childWorkspaceId)) {
        await this.pushSnapshot(input.parentWorkspaceId, current);
        return skippedChildAttribution(current);
      }

      const accounted = GoalRecordV1Schema.parse({
        ...current,
        ...this.applyCostAccounting(current, input.childCostCents * MICRO_CENTS_PER_CENT),
        turnsUsed: current.turnsUsed + 1,
        attributedChildren: [...current.attributedChildren, input.childWorkspaceId],
        updatedAtMs: Date.now(),
      });
      // Tag the budget-limit transition so post-restart recovery knows the
      // wrap-up is owed . `goal_continuation` is the right tag here
      // because the wrap-up MUST fire — child attribution is goal-attributable
      // work. The recovery path checks for `!= "user"`.
      const next = this.applyBudgetDrivenStatus(accounted, { originKind: "goal_continuation" });
      const causedLimit = current.status === "active" && next.status === "budget_limited";

      await this.writeGoal(input.parentWorkspaceId, next);
      await this.pushSnapshot(input.parentWorkspaceId, next);
      this.emitBudgetLimited(input.parentWorkspaceId, next, current.status, {
        "caused-by-child": true,
      });
      // when child attribution drives the
      // goal into budget_limited, arm the same wrap-up stamp + candidate the
      // restart-recovery path uses. Without this the goal sits stuck in
      // budget_limited with no mechanism to fire the wrap-up because the
      // attribution path never produces a normal stream-end candidate/stamp.
      if (causedLimit) {
        await this.armBudgetWrapupForBudgetLimitedGoal(input.parentWorkspaceId, next);
      } else if (next.status === "active") {
        this.armKickoffContinuationIfIdle(input.parentWorkspaceId, next).catch((error: unknown) => {
          log.warn("Failed to arm parent goal continuation after child attribution", {
            workspaceId: input.parentWorkspaceId,
            error,
          });
        });
      }
      return {
        goalBefore: current,
        goalAfter: next,
        attributed: true,
        causedBudgetLimit: causedLimit,
      };
    });
  }

  async clearGoal(workspaceId: string): Promise<GoalRecordV1 | null> {
    const cleared = await this.fileLocks.withLock(workspaceId, async () => {
      const current = await this.readGoalFile(workspaceId);
      this.pendingGoalMutations.delete(workspaceId);
      this.pendingGoalSnapshots.delete(workspaceId);
      this.liveGoalPreviewSnapshots.delete(workspaceId);
      this.pendingContinuationCandidates.delete(workspaceId);
      this.recordedStreamStartedAtMsByWorkspace.delete(workspaceId);
      this.lastGoalStreamStamps.delete(workspaceId);
      const timer = this.continuationReRequestTimers.get(workspaceId);
      if (timer != null) {
        clearTimeout(timer);
        this.continuationReRequestTimers.delete(workspaceId);
      }
      if (!current) {
        await this.pushSnapshot(workspaceId, null);
        return null;
      }

      // Archive the cleared goal to history before deleting the canonical
      // record. `endReason` reflects the goal's *exit reason*: a manual clear
      // of a goal that the user (or model) had already marked complete is
      // recorded as "completed" so the UI can label it as such in the
      // completed-goals list under the present goal.
      await this.appendGoalHistoryEntry(
        workspaceId,
        current,
        current.status === "complete" ? "completed" : "cleared"
      );

      await fs.rm(this.getFilePath(workspaceId), { force: true });
      await this.pushSnapshot(workspaceId, null);
      this.emitLifecycle("goal_cleared", {
        finalStatus: current.status,
        costCentsBucket: centsBucket(current.costCents),
        turnsUsed: current.turnsUsed,
      });
      // Auto-promote the head of `upcoming` (if any) to the active slot
      // so the workspace's roadmap continues without an extra user
      // action. Promotion uses initiator-neutral lifecycle reporting
      // (`goal_created`); the user can still pause / replace as desired.
      await this.promoteNextUpcomingUnlocked(workspaceId);
      return current;
    });

    if (cleared) {
      await this.appendClearSummary(workspaceId, cleared);
    }

    return cleared;
  }

  private async appendClearSummary(workspaceId: string, goal: GoalRecordV1): Promise<void> {
    // The goal-cleared summary exists for MODEL context — after a goal
    // is cleared the agent still needs to know what just happened so it
    // can answer follow-up questions ("what did we just finish?",
    // "resume the previous one"). The right-sidebar Goal Board already
    // surfaces the same information visually (Completed / Archived
    // sections), so rendering this synthetic message as a full assistant
    // chat bubble was pure noise — it appeared inline whenever the user
    // cleared, replaced, or completed a goal, and clobbered the actual
    // conversation flow.
    //
    // `uiVisible: false` (the default for synthetic messages) keeps it
    // in the AI request payload but hides it from the rendered transcript,
    // which is what we want here.
    const summary = `Goal cleared: "${goal.objective}" — spent $${formatCentsBare(goal.costCents)} over ${goal.turnsUsed} turns (status: ${goal.status})`;
    const message = createMuxMessage(
      `goal-cleared-${Date.now()}-${crypto.randomUUID()}`,
      "assistant",
      summary,
      {
        synthetic: true,
        muxMetadata: { type: "goal-cleared-summary" },
      }
    );
    const result = await this.historyService.appendToHistory(workspaceId, message);
    if (!result.success) {
      log.warn("Failed to append goal cleared summary", { workspaceId, error: result.error });
    }
  }

  private bumpStreamEndDrainGeneration(workspaceId: string): void {
    this.streamEndDrainGenerations.set(
      workspaceId,
      (this.streamEndDrainGenerations.get(workspaceId) ?? 0) + 1
    );
  }

  async applyPendingAfterStreamEnd(workspaceId: string): Promise<GoalRecordV1 | null> {
    this.liveGoalPreviewSnapshots.delete(workspaceId);
    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): bump the drain generation at entry so
    // setters admitted BEFORE this drain detect it at their in-lock recheck
    // and persist directly instead of installing a mutation this drain may
    // already have stopped watching for.
    this.bumpStreamEndDrainGeneration(workspaceId);
    let drained: GoalRecordV1 | null = null;

    // Codex P2 (PRRT_kwDOPxxmWM6b_KgE): a queued setGoal may be holding the
    // goal file lock mid-publication; its post-publication re-stamp replaces
    // the mutation object with one carrying the finalized publication
    // createdAtMs. Taking the mutation without the locked handoff would drain
    // the pre-publication construction stamp, and a message authored during
    // the publication await would then be misclassified as a post-goal
    // intervention.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cANQH): the claim (read + delete) must happen
    // INSIDE one lock tenure — setters install/replace mutations only while
    // holding this lock, so an unlocked reread-then-delete could steal an
    // older mutation mid-setter. The claim also honors discards that landed
    // in the window (user abort / clearGoal), which delete the mutation
    // before the claim runs.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cAl6e, PRRT_kwDOPxxmWM6cANQH,
    // PRRT_kwDOPxxmWM6cBACj): each pass claims AND persists inside ONE lock
    // tenure via `persistGoalMutationLocked`. Setters install/replace
    // mutations only while holding this lock, so nothing can interleave
    // between the claim and its persistence — a later setter always validates
    // its expectedGoalId/replacement guard against durable state that already
    // includes every drained pass, keeping accepted guards coherent on
    // replay.
    //
    // Codex P2 (PRRT_kwDOPxxmWM6cBACH): loop until a locked claim observes no
    // mutation instead of a fixed pass cap — a cap exit could strand the
    // newest mutation with no remaining stream-end hook. Termination: nothing
    // can install while we hold the lock, each iteration consumes the single
    // mutation slot, and new installs require a setter that still observes
    // the (stale) live-stream flag, which closes shortly after stream end.
    while (true) {
      // Unlocked fast path: setters install before publication, so a setter
      // mid-publication always has a visible mutation here; an empty map means
      // there is nothing to hand off (the common no-mutation stream end).
      if (this.pendingGoalMutations.get(workspaceId) == null) {
        break;
      }
      // Mirror the `setGoal` wrapper here: invalid queued transitions must
      // be logged and swallowed so the stream-end pipeline stays alive.
      // The caller already treats null as "no apply happened".
      let claimedMutation = false;
      try {
        const tenure = await this.fileLocks.withLock(workspaceId, async () => {
          const claimed = this.pendingGoalMutations.get(workspaceId);
          if (claimed == null) {
            // Discarded (user abort / clearGoal) between the fast path and
            // the claim.
            return null;
          }
          claimedMutation = true;
          this.pendingGoalMutations.delete(workspaceId);
          this.pendingGoalSnapshots.delete(workspaceId);
          const { projectedGoalId, projectedCreatedAtMs, ...pendingInput } = claimed;
          const input = { workspaceId, ...pendingInput };
          return {
            input,
            result: await this.persistGoalMutationLocked(input, {
              replacementGoalId: projectedGoalId ?? null,
              replacementCreatedAtMs: projectedCreatedAtMs ?? null,
            }),
          };
        });
        if (tenure == null) {
          break;
        }
        const finalized = await this.finalizeGoalPersistence(tenure.input, tenure.result);
        drained = finalized.success ? finalized.data : drained;
      } catch (error) {
        log.warn("applyPendingAfterStreamEnd: dropped invalid queued goal mutation", {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Always re-read the durable record after a claim: queued snapshots
        // are optimistic, and drains can succeed as persistence no-ops,
        // reject, or throw.
        if (claimedMutation) {
          await this.restorePersistedGoalSnapshot(workspaceId);
        }
      }
    }

    // Codex P2 (PRRT_kwDOPxxmWM6cBr9Q): bump again on exit, synchronously with
    // the loop's final empty-map check (no await sits between them). A setter
    // admitted DURING this drain whose in-lock recheck runs after that final
    // check therefore sees a changed generation and persists directly; one
    // whose recheck ran earlier installed a mutation the loop drained.
    this.bumpStreamEndDrainGeneration(workspaceId);

    // Stream-end deferred auto-promotion.
    //
    // Runs AFTER any queued setGoal drains so the deferred setGoal can
    // target the same goal it was queued against — otherwise its
    // `expectedGoalId` would race ahead of the promote and the
    // setGoalImmediately call would return `goal_conflict` and silently
    // drop the user's edit.
    //
    // Two reasons this helper might find work to do at this point:
    //   (a) The agent called `complete_goal` mid-stream — goal.json is
    //       already complete and no pending mutation queued.
    //   (b) The queued mutation we just drained completed the goal —
    //       `maybeAutoPromoteOnComplete` skipped because the stream
    //       was still live during the drain's `applyMutableFields`.
    // Either way, the active goal is `complete` on disk by now and the
    // upcoming head deserves promotion.
    await this.runDeferredAutoPromoteAfterStreamEnd(workspaceId);

    return drained;
  }

  /**
   * Stream-end hook for deferred auto-promotion. When the agent marks
   * the active goal complete mid-stream, `maybeAutoPromoteOnComplete`
   * skips because `isWorkspaceStreaming` is still true. This method
   * runs after the stream has settled and picks up where that skipped:
   * if the current active goal is `complete` and there's an upcoming
   * head, archive the completed goal to history and promote the head.
   *
   * **Retry on streaming race.** `applyPendingAfterStreamEnd`
   * is called from AgentSession once per stream; the
   * `extensionMetadata.setStreaming(false)` call comes from a separate
   * async listener in WorkspaceService and may not have run yet. We
   * poll `isWorkspaceStreaming` with a small bounded backoff so we
   * don't drop the auto-promote on this race. If after all retries
   * we still see streaming, give up — the next manual mutation will
   * land here naturally.
   *
   * Failures are logged + swallowed; the stream-end pipeline must not
   * be disrupted by board mutations.
   */
  private async runDeferredAutoPromoteAfterStreamEnd(workspaceId: string): Promise<void> {
    // Quick early exit if there's nothing to promote — avoids the
    // streaming-poll cost on the hot path for single-goal workspaces.
    const earlyBoard = await this.readBoard(workspaceId);
    if (earlyBoard.upcoming.length === 0) {
      return;
    }
    const earlyGoal = await this.readGoalFile(workspaceId);
    if (earlyGoal?.status !== "complete") {
      return;
    }

    // poll for stop-streaming up to ~600ms total. The races
    // we've seen in practice resolve in one or two ticks; the longer
    // bound is defensive against laggy listeners. We stop polling the
    // first time we see streaming=false (so the common case is fast).
    const POLL_DELAYS_MS = [0, 50, 100, 200, 250];
    let stillStreaming = true;
    for (const delayMs of POLL_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (!(await this.isWorkspaceStreaming(workspaceId))) {
        stillStreaming = false;
        break;
      }
    }
    if (stillStreaming) {
      log.warn(
        "Deferred auto-promote skipped: workspace still streaming after retries; will rearm on next mutation",
        { workspaceId, goalId: earlyBoard.upcoming[0].goalId }
      );
      return;
    }

    try {
      await this.fileLocks.withLock(workspaceId, async () => {
        const current = await this.readGoalFile(workspaceId);
        if (current?.status !== "complete") {
          return;
        }
        const board = await this.readBoard(workspaceId);
        if (board.upcoming.length === 0) {
          return;
        }
        const [head] = board.upcoming;
        const projected = GoalRecordV1Schema.parse({
          ...head,
          status: "active",
          updatedAtMs: Date.now(),
        });
        if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, projected))) {
          log.warn(
            "Deferred auto-promote skipped: queued goal is budgeted but kickoff model is unpriced",
            { workspaceId, goalId: head.goalId }
          );
          return;
        }
        // Same as `maybeAutoPromoteOnComplete`: archive the completed
        // goal then write the promotion. Both happen under the same
        // workspace lock as the stream-end accounting drain so the UI
        // sees a consistent board.
        await this.appendGoalHistoryEntry(workspaceId, current, "completed");
        await this.promoteNextUpcomingUnlocked(workspaceId);
      });
    } catch (error) {
      log.warn("Deferred auto-promote after stream end failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Goal board (multi-goal queue)
  //
  // The board is stored at `goal-board.json` next to `goal.json` so the
  // existing single-goal storage + agent contract are untouched. The
  // agent's `get_goal` tool still reads only `goal.json` and never sees
  // upcoming or archived goals — the user owns the queue, not the agent.
  //
  // Concurrency uses the same per-workspace `fileLocks` as goal.json so
  // a board mutation can't race a setGoal write that flips the active
  // goal. Auto-promotion (`promoteNextOnComplete`) reads/writes both
  // files inside one lock for the same reason.
  // ───────────────────────────────────────────────────────────────────────

  private getBoardFilePath(workspaceId: string): string {
    return this.resolveSessionFilePath(workspaceId, GOAL_BOARD_FILE);
  }

  private async readBoard(workspaceId: string): Promise<GoalBoardV1> {
    const filePath = this.getBoardFilePath(workspaceId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return GoalBoardV1Schema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) {
        return { version: 1, upcoming: [], archived: [] };
      }
      log.warn("Ignoring corrupt goal-board.json", { workspaceId, error });
      return { version: 1, upcoming: [], archived: [] };
    }
  }

  private async writeBoard(workspaceId: string, board: GoalBoardV1): Promise<void> {
    const filePath = this.getBoardFilePath(workspaceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // When both lists are empty, drop the file entirely so a workspace
    // that never used the board stays bit-identical to a never-touched
    // one (matches the heartbeat / goal-defaults pattern).
    if (board.upcoming.length === 0 && board.archived.length === 0) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await writeFileAtomic(filePath, `${JSON.stringify(board, null, 2)}\n`, "utf-8");
  }

  /**
   * Renderer-facing snapshot of all four board sections, oldest-first
   * within each section. Active comes from `goal.json`, completed from
   * `goal-history.jsonl` (newest first, capped at the existing render
   * cap), upcoming + archived from `goal-board.json`.
   */
  async getGoalBoard(workspaceId: string): Promise<GoalBoardSnapshot> {
    return this.fileLocks.withLock(workspaceId, async () => {
      const [activeGoal, board, history] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
        this.readHistoryUnlocked(workspaceId),
      ]);

      const entries: GoalBoardEntry[] = [];

      if (activeGoal) {
        entries.push({ section: "active", goal: activeGoal });
      }
      for (const goal of board.upcoming) {
        entries.push({ section: "upcoming", goal });
      }
      // Completed entries come from history. We dedupe against:
      //   - the active goal id (stale history line race during edit)
      //   - the archived list (archived-from-complete goals)
      //   - the upcoming list (when a user archives a completed goal then
      //     revives it, the original history entry still exists; without
      //     this dedup the goal would render in both Upcoming and Completed).
      //   - earlier history rows for the same goalId (a goal
      //     completed → archived → revived → promoted → completed
      //     again has TWO 'completed' rows; we want only the newest).
      //     `history` is sorted newest-first, so the first row we see
      //     for a goalId is the most recent.
      const seenCompletedIds = new Set<string>();
      for (const entry of history) {
        if (entry.endReason !== "completed") continue;
        if (activeGoal && entry.goal.goalId === activeGoal.goalId) continue;
        if (board.archived.some((g) => g.goalId === entry.goal.goalId)) continue;
        if (board.upcoming.some((g) => g.goalId === entry.goal.goalId)) continue;
        if (seenCompletedIds.has(entry.goal.goalId)) continue;
        seenCompletedIds.add(entry.goal.goalId);
        entries.push({ section: "complete", goal: entry.goal, endedAtMs: entry.endedAtMs });
      }
      for (const goal of board.archived) {
        entries.push({ section: "archived", goal });
      }

      return { entries };
    });
  }

  /**
   * Read history WITHOUT acquiring the lock. Only callers that already
   * hold the lock may use this (`getGoalBoard` reads goal.json + board
   * + history under one lock).
   */
  private async readHistoryUnlocked(
    workspaceId: string,
    logCorruptLines = false
  ): Promise<GoalHistoryEntry[]> {
    const filePath = this.getHistoryFilePath(workspaceId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const indexed: Array<{ index: number; entry: GoalHistoryEntry }> = [];
      let appendIndex = 0;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          indexed.push({
            index: appendIndex,
            entry: GoalHistoryEntrySchema.parse(JSON.parse(trimmed)),
          });
        } catch (error) {
          if (logCorruptLines) {
            log.warn("Skipping corrupt goal history entry", { workspaceId, error });
          }
        }
        appendIndex += 1;
      }
      indexed.sort((a, b) => {
        if (b.entry.endedAtMs !== a.entry.endedAtMs) {
          return b.entry.endedAtMs - a.entry.endedAtMs;
        }
        return b.index - a.index;
      });
      return indexed.slice(0, GOAL_HISTORY_RENDER_CAP).map((row) => row.entry);
    } catch (error) {
      if (isNotFound(error)) return [];
      log.warn("Failed to read goal history", { workspaceId, error });
      return [];
    }
  }

  /**
   * Append a new goal to the workspace's `upcoming` list. The goal is
   * created in the standard way (via `createGoal`) so it has a stable
   * goalId + cost accounting fields, but its status is the placeholder
   * `paused` — meaningless until promotion, but it satisfies the
   * non-empty status constraint on `GoalRecordV1`. Promotion (manual or
   * auto) is what actually flips it to `active`.
   */
  async addUpcomingGoal(input: {
    workspaceId: string;
    objective: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }): Promise<GoalRecordV1> {
    this.assertParentWorkspace(input.workspaceId);
    const objective = input.objective.trim();
    assert(objective.length > 0, "addUpcomingGoal requires a non-empty objective");

    return this.fileLocks.withLock(input.workspaceId, async () => {
      const board = await this.readBoard(input.workspaceId);
      const goal = this.createGoal({
        objective,
        budgetCents: input.budgetCents ?? null,
        turnCap: input.turnCap ?? null,
        // `paused` is the placeholder status for upcoming goals — they
        // are not actively running and not yet acknowledged by the
        // agent. The promote path replaces this with `active` after a
        // proper write through setGoal.
        status: "paused",
      });
      const next: GoalBoardV1 = {
        ...board,
        upcoming: [...board.upcoming, goal],
      };
      await this.writeBoard(input.workspaceId, next);
      return goal;
    });
  }

  /**
   * Patch an upcoming goal in place. Used by the right-sidebar Upcoming
   * row's inline editor — users can change a queued goal's objective,
   * budget, or turn cap without first promoting it. Returns the patched
   * record on success and `null` when the id is unknown (idempotent for
   * double-submit). Fields explicitly set to `null` clear the limit;
   * fields left as `undefined` are preserved from the existing record
   * so the UI can patch a single column.
   *
   * Active goals do not flow through this method — they keep using
   * `setGoal` with `editInPlace: true` so the agent's view stays in sync
   * via the lifecycle event stream. Upcoming goals are not visible to
   * the agent, so a pure file-locked write is sufficient here.
   */
  async updateUpcomingGoal(input: {
    workspaceId: string;
    goalId: string;
    objective?: string;
    budgetCents?: number | null;
    turnCap?: number | null;
  }): Promise<GoalRecordV1 | null> {
    this.assertParentWorkspace(input.workspaceId);
    if (input.objective?.trim().length === 0) {
      throw new WorkspaceGoalTransitionError("Goal objective cannot be empty.");
    }
    return this.fileLocks.withLock(input.workspaceId, async () => {
      const board = await this.readBoard(input.workspaceId);
      const idx = board.upcoming.findIndex((g) => g.goalId === input.goalId);
      if (idx === -1) return null;
      const existing = board.upcoming[idx];
      const updated: GoalRecordV1 = GoalRecordV1Schema.parse({
        ...existing,
        objective: input.objective === undefined ? existing.objective : input.objective.trim(),
        budgetCents: input.budgetCents === undefined ? existing.budgetCents : input.budgetCents,
        turnCap: input.turnCap === undefined ? existing.turnCap : input.turnCap,
        updatedAtMs: Date.now(),
      });
      const nextUpcoming = [...board.upcoming];
      nextUpcoming[idx] = updated;
      await this.writeBoard(input.workspaceId, { ...board, upcoming: nextUpcoming });
      return updated;
    });
  }

  /**
   * Move a goal from one board location to archived. The goal can come
   * from any section: active (the slot is cleared and history records a
   * "cleared" entry), upcoming (removed from queue), or complete
   * (snapshotted from history into the board so the user can still see
   * it after the history line scrolls off the render cap).
   *
   * The user is the only initiator of archive — the agent never sees
   * archived goals (filtered out of `goal-board.json` reads in the
   * agent tool boundary if/when those tools are added).
   */
  async archiveGoal(workspaceId: string, goalId: string): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const [activeGoal, board, history] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
        this.readHistoryUnlocked(workspaceId),
      ]);

      // Already archived: idempotent no-op so a double-click doesn't
      // surprise the user.
      if (board.archived.some((g) => g.goalId === goalId)) {
        return;
      }

      // Source priority: always prefer the currently-active
      // slot. A goal that was completed → archived → revived →
      // promoted → completed-again has both a stale history entry AND
      // is the current active. Checking history first would snapshot
      // the stale history row and leave the live active slot in
      // place; the user's archive click would then appear not to
      // work and could surface duplicate Archived rows.
      if (activeGoal?.goalId === goalId) {
        // Append a "cleared" history entry so the user's view of
        // completed/cleared history stays accurate, then place a
        // snapshot in archived. We use the current ACTIVE record
        // (with its latest accounting) rather than any older history
        // entry for the same id.
        await this.appendGoalHistoryEntry(workspaceId, activeGoal, "cleared");
        await fs.rm(this.getFilePath(workspaceId), { force: true });
        await this.pushSnapshot(workspaceId, null);
        const next: GoalBoardV1 = {
          ...board,
          archived: [activeGoal, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }

      // Source: upcoming list.
      const upcomingIdx = board.upcoming.findIndex((g) => g.goalId === goalId);
      if (upcomingIdx !== -1) {
        const [removed] = board.upcoming.splice(upcomingIdx, 1);
        const next: GoalBoardV1 = {
          ...board,
          archived: [removed, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }

      // Source: history (completed goal). Add to archived; the
      // `getGoalBoard` dedup filters the history line so the goal
      // doesn't double-render.
      const historyEntry = history.find(
        (e) => e.goal.goalId === goalId && e.endReason === "completed"
      );
      if (historyEntry) {
        const next: GoalBoardV1 = {
          ...board,
          archived: [historyEntry.goal, ...board.archived],
        };
        await this.writeBoard(workspaceId, next);
        return;
      }
      // Unknown id: silently ignored. The renderer can race a board
      // refresh against a concurrent clear; throwing here would
      // surface confusing errors for what is a benign race.
    });
  }

  /**
   * Move an archived goal back into `upcoming`. The user can then
   * promote it to active or leave it in the queue.
   */
  async reviveArchivedGoal(workspaceId: string, goalId: string): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const board = await this.readBoard(workspaceId);
      const idx = board.archived.findIndex((g) => g.goalId === goalId);
      if (idx === -1) return;
      const [revived] = board.archived.splice(idx, 1);
      const next: GoalBoardV1 = {
        ...board,
        upcoming: [...board.upcoming, revived],
      };
      await this.writeBoard(workspaceId, next);
    });
  }

  /**
   * Reorder the `upcoming` list to match the given goalId sequence.
   * Goals whose ids aren't in the input list are appended at the end
   * (defensive against concurrent additions); ids in the input that
   * don't match an upcoming goal are silently dropped (defensive
   * against stale UI state).
   */
  async reorderUpcomingGoals(workspaceId: string, upcomingIds: string[]): Promise<void> {
    this.assertParentWorkspace(workspaceId);
    await this.fileLocks.withLock(workspaceId, async () => {
      const board = await this.readBoard(workspaceId);
      const byId = new Map(board.upcoming.map((g) => [g.goalId, g]));
      const reordered: GoalRecordV1[] = [];
      for (const id of upcomingIds) {
        const goal = byId.get(id);
        if (goal) {
          reordered.push(goal);
          byId.delete(id);
        }
      }
      // Anything still in the map wasn't covered by the input order;
      // preserve their relative order at the end.
      for (const goal of board.upcoming) {
        if (byId.has(goal.goalId)) {
          reordered.push(goal);
        }
      }
      const next: GoalBoardV1 = { ...board, upcoming: reordered };
      await this.writeBoard(workspaceId, next);
    });
  }

  /**
   * Promote an upcoming goal to active. If a goal is already active,
   * it is demoted to the head of `upcoming` so the user's roadmap
   * stays intact (matches the design's "swap on drag-to-activate"
   * semantics — the demoted goal is the natural next pick).
   *
   * **Mid-stream guard.** Promotion overwrites `goal.json`,
   * which `recordStreamAccounting` reads on every chunk to attribute
   * cost. If we promote while a stream is still running for the
   * current active goal, the freshly-promoted goal would absorb the
   * previous goal's cost. Interrupt/poll first so the promoted goal can
   * safely receive its kickoff continuation once the workspace is idle.
   *
   * Returns the new active record (the promoted goal, with status
   * flipped to `active` via the normal createGoal-like path) or
   * `null` when the requested upcoming id doesn't exist.
   */
  async promoteUpcomingGoal(workspaceId: string, goalId: string): Promise<GoalRecordV1 | null> {
    this.assertParentWorkspace(workspaceId);

    // Interrupt the active stream (if any) before promoting so the
    // in-flight turn's costs are attributed to the goal that ran them.
    // The promoted goal's view (via the agent's `get_goal` tool) then
    // takes effect on the kickoff continuation; otherwise a mid-stream
    // promote could attribute the current stream tail to the new goal.
    //
    // Behavior intentionally fails open: if no interrupter is wired
    // (tests) or the interrupt errors, we still proceed to promote.
    // The promotion arm below picks up the new goal via `get_goal`; worst
    // case is the small slice of stream tail that lands before the abort
    // settles. We log so production paths flag the rare error.
    if (await this.isWorkspaceStreaming(workspaceId)) {
      if (this.streamInterrupter) {
        try {
          await this.streamInterrupter(workspaceId);
        } catch (error) {
          log.warn("promoteUpcomingGoal: stream interrupt failed; continuing with promote", {
            workspaceId,
            error,
          });
        }
        // Stream tear-down may not flip `streaming=false` synchronously
        // with `interruptStream` resolving. Poll briefly (same backoff
        // as `runDeferredAutoPromoteAfterStreamEnd`) so the file-lock
        // body sees the post-interrupt state.
        await this.waitForStreamSettled(workspaceId);
      }
    }

    const promotedGoal = await this.fileLocks.withLock(workspaceId, async () => {
      const [currentActive, board] = await Promise.all([
        this.readGoalFile(workspaceId),
        this.readBoard(workspaceId),
      ]);
      const idx = board.upcoming.findIndex((g) => g.goalId === goalId);
      if (idx === -1) return null;
      const [promoted] = board.upcoming.splice(idx, 1);

      // Flip status to active. We reuse `createGoal` shape via direct
      // schema parse rather than calling setGoal to avoid re-entering
      // the streaming/conflict path — promotion happens inside one
      // file lock and shouldn't fan out into the public setGoal flow.
      //
      // a previously-active goal demoted back into upcoming
      // may already have cost ≥ budget or turnsUsed ≥ turnCap
      // (e.g. it hit `budget_limited`, was demoted by a different
      // promote, then re-queued). Run `applyBudgetDrivenStatus` so the
      // re-activated record correctly lands in `budget_limited` if the
      // limits are already exhausted; otherwise it would accept a send
      // and only flip after the next chunk's accounting.
      //
      // Also clear `completionSummary` so a previously-completed goal
      // that's been archived → revived → promoted doesn't carry its
      // 'done' message into the new active turn. The agent's
      // `get_goal` tool reads goal.json directly and would otherwise
      // see a stale summary. Matches the
      // `completionSummaryPatch` invariant for non-complete statuses.
      const now = Date.now();
      const baseActivated = GoalRecordV1Schema.parse({
        ...promoted,
        status: "active",
        updatedAtMs: now,
        completionSummary: undefined,
        requireUserAcknowledgmentSinceMs: null,
      });
      const activated = this.applyBudgetDrivenStatus(baseActivated);

      // gate budgeted goal promotion on pricing data. A user
      // who queued a goal under a priced model and then switched to an
      // unpriced one would otherwise activate a budgeted goal they
      // can't actually send messages against — `assertPricedModelFor
      // BudgetedGoal` would block every send until the model is
      // changed or the goal cleared. Same guard `setGoal` uses for
      // direct creates.
      if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, activated))) {
        throw new WorkspaceGoalTransitionError(UNPRICED_TARGET_MODEL_GOAL_MESSAGE);
      }

      // Demote the previously-active goal to the head of upcoming, but
      // ONLY if it's still alive. A completed goal sitting in the active
      // slot (the user-marked-complete + queued-next workflow) must NOT
      // re-enter the queue: completed goals are terminal
      // from the queue's perspective. Push them to history under the
      // "completed" reason so the board's Completed section surfaces
      // them, and skip the upcoming demote.
      let nextUpcoming: GoalRecordV1[];
      if (currentActive) {
        if (currentActive.status === "complete") {
          await this.appendGoalHistoryEntry(workspaceId, currentActive, "completed");
          nextUpcoming = board.upcoming;
        } else {
          nextUpcoming = [currentActive, ...board.upcoming];
        }
      } else {
        nextUpcoming = board.upcoming;
      }

      await this.writeBoard(workspaceId, {
        ...board,
        upcoming: nextUpcoming,
      });
      await this.writeGoal(workspaceId, activated);
      await this.pushSnapshot(workspaceId, activated);
      this.emitLifecycle("goal_resumed", { initiator: "user" });
      return activated;
    });
    if (promotedGoal) {
      this.recordGoalSet(workspaceId, promotedGoal);
      this.armContinuationForPromotedGoal(workspaceId, promotedGoal);
    }
    return promotedGoal;
  }

  /**
   * Called after a `complete` status transition inside `setGoal` to move the
   * completed goal into the Complete board section and promote the next queued
   * goal into focus.
   *
   * Behavior:
   *   - If the transition isn't into `complete`, no-op.
   *   - If there are no upcoming goals queued, no-op — the existing
   *     UX (completion summary on the active card) stays intact for
   *     users who don't use the queue. This preserves backward compat.
   *   - Otherwise: append the completed goal to `goal-history.jsonl`
   *     under `completed` endReason, then promote the head of upcoming
   *     into the active slot. The previously-completed goal then only
   *     lives in history (the Board renders it under the Completed
   *     section).
   *
   * Caller must hold the workspace file lock; promotion + history
   * append happen under the same lock as the original mutation so the
   * board snapshot is always consistent.
   */
  private async maybeAutoPromoteOnComplete(
    workspaceId: string,
    completedGoal: GoalRecordV1,
    previousStatus: GoalStatus
  ): Promise<void> {
    if (completedGoal.status !== "complete" || previousStatus === "complete") {
      return;
    }
    const board = await this.readBoard(workspaceId);
    if (board.upcoming.length === 0) {
      return;
    }
    // check BOTH the streaming guard and the pricing
    // gate BEFORE appending the completion history entry. Either
    // failure here means promotion can't go through; we must leave
    // the completed goal in `goal.json` so a later retry archives it
    // exactly once instead of producing a duplicate Completed row.
    if (await this.isWorkspaceStreaming(workspaceId)) {
      log.warn("Auto-promote on complete skipped: workspace is still streaming", {
        workspaceId,
        goalId: board.upcoming[0].goalId,
      });
      return;
    }
    const [head] = board.upcoming;
    const projected = GoalRecordV1Schema.parse({
      ...head,
      status: "active",
      updatedAtMs: Date.now(),
    });
    if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, projected))) {
      log.warn(
        "Auto-promote on complete skipped: queued goal is budgeted but kickoff model is unpriced",
        { workspaceId, goalId: head.goalId }
      );
      return;
    }
    // Move the completed goal into history before overwriting goal.json
    // with the promoted goal. The board's Completed section reads from
    // history, so this is what makes the just-completed goal visible
    // there.
    await this.appendGoalHistoryEntry(workspaceId, completedGoal, "completed");
    await this.promoteNextUpcomingUnlocked(workspaceId);
  }

  /**
   * Called after a goal is marked complete (by agent or user) or
   * cleared. If `upcoming` has a head, promote it to active so the
   * agent has a roadmap to pick up immediately. Promotion also arms the
   * kickoff continuation when a runtime bridge can supply send options; this
   * matches explicit resume and prevents queued goals from waiting on a
   * pause/unpause nudge.
   *
   * Caller must hold the workspace file lock. Returns the new active
   * record if a promotion happened, null otherwise.
   */
  private async promoteNextUpcomingUnlocked(workspaceId: string): Promise<GoalRecordV1 | null> {
    const board = await this.readBoard(workspaceId);
    if (board.upcoming.length === 0) return null;
    // same mid-stream guard as `promoteUpcomingGoal`.
    // `clearGoal` and `maybeAutoPromoteOnComplete` invoke this helper
    // while a stream may still be running (the agent's `complete_goal`
    // tool fires mid-turn). Writing the queued goal to `goal.json` in
    // that window lets the remaining stream cost get attributed to the
    // newly-promoted record. Skip the auto-promote while streaming —
    // the caller (manual setGoal/clearGoal flow) already succeeded;
    // the upcoming head stays intact and the user can trigger a
    // promote later (or stream-end will land here naturally on the
    // next mutation).
    if (await this.isWorkspaceStreaming(workspaceId)) {
      log.warn("Auto-promote on complete skipped: workspace is still streaming", {
        workspaceId,
        goalId: board.upcoming[0].goalId,
      });
      return null;
    }
    const [head, ...rest] = board.upcoming;
    const now = Date.now();
    // same budget-driven normalization as
    // `promoteUpcomingGoal`. Cover the auto-promote-on-complete path
    // and the deferred stream-end path; both write the head into
    // `goal.json` and need to respect already-exhausted limits.
    // Also clear `completionSummary` (see `promoteUpcomingGoal` for
    // the rationale — agent's `get_goal` would otherwise see a stale
    // 'done' message on a revived/promoted goal).
    const baseActivated = GoalRecordV1Schema.parse({
      ...head,
      status: "active",
      updatedAtMs: now,
      completionSummary: undefined,
      requireUserAcknowledgmentSinceMs: null,
    });
    const activated = this.applyBudgetDrivenStatus(baseActivated);
    // same pricing gate as `promoteUpcomingGoal`. If the next
    // queued goal is budgeted and the workspace is currently on an
    // unpriced model, refuse the auto-promotion — otherwise we'd leave
    // the workspace in a state where the user can't send messages
    // (their active goal is blocked by `assertPricedModelForBudgetedGoal`).
    // The completion mutation still succeeds; the upcoming list keeps
    // its head and the user is left to either change models or clear
    // the head goal before the next promote attempt.
    if (!(await this.canRunBudgetedGoalOnKickoffModel(workspaceId, activated))) {
      log.warn(
        "Auto-promote on complete skipped: queued goal is budgeted but kickoff model is unpriced",
        { workspaceId, goalId: head.goalId }
      );
      return null;
    }
    await this.writeBoard(workspaceId, { ...board, upcoming: rest });
    await this.writeGoal(workspaceId, activated);
    await this.pushSnapshot(workspaceId, activated);
    this.emitLifecycle("goal_created", {
      viaFork: false,
      sourceStatus: head.status,
      objectiveLengthBucket: lengthBucket(head.objective.length),
      hasBudget: activated.budgetCents != null,
      hasTurnCap: activated.turnCap != null,
    });
    this.recordGoalSet(workspaceId, activated);
    this.armContinuationForPromotedGoal(workspaceId, activated);
    return activated;
  }
}
