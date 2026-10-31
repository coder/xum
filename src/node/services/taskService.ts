import { ServiceTierSchema, type ServiceTier } from "@/common/config/schemas/providersConfig";
import { DesktopInputCoordinator } from "@/node/services/desktop/DesktopInputCoordinator";
import { randomUUID } from "node:crypto";
import {
  getValidAgentMessageDispatchMode,
  getValidMessagingTag,
  getValidUnrelatedWorkspaceConsent,
} from "@/common/orpc/schemas/workspace";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fsPromises from "fs/promises";
import type { z } from "zod";
import {
  TASK_CREATE_WAIT_WARNING_MS,
  TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS,
  TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
} from "@/constants/terminationTimeouts";
import { SLOW_STARTUP_WARN_THRESHOLD_MS } from "@/constants/startup";
import { raceWithAbortAndTimeout } from "@/node/utils/concurrency/withTimeout";
import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  SecretsStore,
  type Config,
  type ProjectsConfig,
  type Workspace as WorkspaceConfigEntry,
} from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import {
  buildWorkspaceAgentContext,
  workspaceTurnTerminalAttentionSuppressed,
  type WorkspaceTurnManager,
} from "@/node/services/workspaceTurnManager";
import {
  TASK_RECOVERY_FALLBACK_AGENT_ID,
  formatSubagentFailureUserMessage,
  formatSubagentReportUserMessage,
  getIsoNow,
  resolveTaskAgentIdForResume,
  terminalAttentionOutcome,
  type AgentTaskIntegration,
  type AgentTaskStatus,
  type BackgroundableForegroundWaiter,
  type QueueCutAttributionSnapshot,
  type QueueCutReceipt,
  type ResolvedWorkspaceAiSettings,
  type TaskCreateArgs,
  type TaskKind,
  type TaskReawakenOutcome,
  type TaskTurnAdmission,
  type TurnAcceptanceOrigin,
  type TurnAdmissionToken,
  type WorkspaceHost,
  type WorkspaceLifecycleResult,
  type WorkspaceTurnHost,
} from "@/node/services/taskWorkspaceSeam";
export type { TaskKind } from "@/node/services/taskWorkspaceSeam";
export { ForegroundWaitBackgroundedError } from "@/node/services/taskWaiters";
import {
  ACTIVE_AGENT_TASK_STATUSES,
  buildAgentTaskIndex,
  countActiveAgentTasks,
  hasActiveDescendantAgentTasksUsingIndex,
  isActiveAgentTaskEntry,
  isDescendantAgentTaskUsingParentById,
  listAgentTaskWorkspaces,
  resolveWorkspaceAISettings,
  type AgentTaskIndex,
  type AgentTaskWorkspaceEntry,
} from "@/node/services/agentTaskIndex";
import type { SubagentAttemptSettlementSource } from "@/node/services/subagentAttemptSettlements";
import { isTaskAttemptId, newTaskAttemptId } from "@/node/utils/taskAttemptId";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN } from "@/common/constants/workflowReports";
import {
  SUBAGENT_FAILURE_ENVELOPE_TAG,
  parseSubagentReportEnvelope,
  subagentReportFallbackTitle,
  subagentUpdateFallbackTitle,
} from "@/common/utils/subagentReportEnvelope";
import { BACKGROUND_WORK_WAKE_OPENINGS } from "@/common/utils/machineTurnPrompts";
import type { AgentPeerMessageMeta } from "@/common/utils/agentMessageEnvelope";
import type { SendMessageOptions } from "@/common/orpc/types";
import {
  AGENT_PEER_MESSAGE_DEDUPE_PREFIX,
  AGENT_REPORT_PROGRESS_SUPERSEDED_REASON,
  INSTANCE_DISCOVERY_DEFAULT_LIMIT,
  INSTANCE_DISCOVERY_MAX_LIMIT,
  agentReportProgressDedupePrefix,
  taskRecoveryPromptDedupeKey,
  taskRecoveryPromptDedupePrefix,
  TASK_RECOVERY_DIAGNOSTIC_MAX_CHARS,
  SEND_ADMISSION_STALE_MESSAGE,
  TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE,
  WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
  pendingRemovalAdmissionMessage,
  retiredAttemptMessage,
} from "@/constants/agentMessaging";
import {
  formatReawakenChangedMessage,
  REAWAKEN_DEFINITION_READ_TIMEOUT_MS,
  TASK_FAMILY_MESSAGE_MAX_CHARS,
} from "@/constants/taskMessages";
import { log } from "@/node/services/log";
import { ATTEMPT_CLOSURE_SETTLE_WAIT_MS, AttemptLedger } from "@/node/services/attemptLedger";
export { ATTEMPT_CLOSURE_SETTLE_WAIT_MS } from "@/node/services/attemptLedger";
import { TaskStopLatch } from "@/node/services/taskStopLatch";
import { StreamEndLedger } from "@/node/services/streamEndLedger";
import { PeerSendParking } from "@/node/services/peerSendParking";
import {
  TaskWaiters,
  type PendingTaskStartWaiter,
  type PendingTaskWaiter,
} from "@/node/services/taskWaiters";
import { isProjectTrusted, isWorkspaceProjectTrustedIn } from "@/node/utils/projectTrust";
import { eventSpine } from "@/node/services/events/eventSpine";
import { sandboxHostService } from "@/node/services/sandbox/sandboxHostService";
import {
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { runBackgroundInit } from "@/node/runtime/runtimeFactory";
import {
  WorkspaceMutationInProgressError,
  workspaceUseLeasesFor,
  type WorkspaceUseLease,
  type WorkspaceUseLeases,
} from "@/node/services/workspaceUseLeases";
import {
  formatRuntimeUnreachableError,
  isRuntimeTransportError,
  type InitLogger,
  type Runtime,
} from "@/node/runtime/Runtime";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import { resolvePlanFileLocation } from "@/node/utils/runtime/planLocation";
import {
  coerceNonEmptyString,
  readTaskParentBranch,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
  markChildGoalPauseOwed,
  rowSupersedes,
} from "@/node/services/taskUtils";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { isErrnoException } from "@/node/utils/fs";
import { Ok, Err, type Result } from "@/common/types/result";
import {
  DEFAULT_TASK_SETTINGS,
  type TaskAttemptOutcome,
  type TaskAttemptSettlement,
  type TaskSettings,
} from "@/common/types/tasks";
import {
  resolveBackgroundWorkAttentionPolicy,
  type BackgroundWorkAttentionPolicy,
} from "@/common/types/backgroundWorkAttention";
import {
  createMuxMessage,
  isContextBudgetWarningMessage,
  type MuxMessage,
  type MuxMessageMetadata,
} from "@/common/types/message";
import {
  createCompactionSummaryMessageId,
  createTaskFailureMessageId,
  createTaskReportMessageId,
} from "@/node/services/utils/messageIds";
import { defaultModel, normalizeSelectedModel } from "@/common/utils/ai/models";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { SCRATCH_PROJECT_CONFIG_KEY, SCRATCH_PROJECT_NAME } from "@/common/constants/scratch";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import {
  isDockerRuntime,
  isLocalProjectRuntime,
  isWorktreeRuntime,
  runtimeModeSupportsSharedTaskWorkspace,
  type RuntimeConfig,
} from "@/common/types/runtime";
import type {
  ProjectRef,
  WorkspaceMetadata,
  WorkspaceRemovalDescendant,
  WorkspaceRemoveWarning,
} from "@/common/types/workspace";
import { getRuntimeType } from "@/node/runtime/initHook";
// Outside the agent loop: TaskService passes the host's runtimes (nodeRuntimeFactory) to agent and skill reads.
import { nodeRuntimeFactory } from "@/node/services/runtimeFactory/nodeRuntimeFactory";
import { AgentIdSchema } from "@/common/orpc/schemas";
import type { AgentId } from "@/common/types/agentDefinition";
import {
  MINTED_SEND_ID_PREFIX,
  SendMessageOptionsSchema,
  ToolPolicySchema,
} from "@/common/orpc/schemas/stream";
import { computeSendDigest, type SendIdentity } from "@/node/services/sendIds";
import {
  normalizeAgentId,
  resolvePersistedAgentId,
  resolvePersistedAgentIdCandidates,
} from "@/common/utils/agentIds";
import {
  buildTaskBaseCommitShaByProjectPath,
  getPrimaryProjectName,
  GitPatchArtifactService,
} from "@/node/services/gitPatchArtifactService";
import { findUnpreservedSubagentWork } from "@/node/services/subagentRemovalWorkCheck";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import type { GoalRecordV1 } from "@/common/types/goal";
import {
  canAgentDriveGoal,
  GOAL_BUDGET_LIMIT_KIND,
  GOAL_CONTINUATION_KIND,
  type GoalSyntheticMessageKind,
} from "@/constants/goals";
import {
  buildGoalBudgetLimitMessage,
  buildGoalContinuationMessage,
  synthesizeSilentContinuationSummary,
} from "@/constants/goalPrompts";
import { subagentReportSourceKey } from "@/common/orpc/schemas/timeline";
import { NOOP_TIMELINE_RECORDER, type TimelineRecorder } from "@/node/services/timelineRecorder";
import { getTotalCost, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import {
  coerceOpenAIReasoningMode,
  type OpenAIReasoningMode,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import {
  targetWorkspaceBucketToLayer,
  type AgentAiSettingsLayerValues,
  type TaskAiPins,
} from "@/common/types/agentAiSettings";
import {
  buildParentAiSettingsFallbacks,
  buildReawakenContextKey,
  planReawakenAi,
  resolveParentWorkspaceExecSettings,
  type AgentTaskTurnAi,
  type PreparedReawakenAi,
} from "@/node/services/agentTaskReawakenAi";
import { InvalidExplicitAiSettingError } from "@/common/utils/ai/resolveAgentAiSettings";
import {
  loadAgentDefinitionAiLayers,
  resolveNodeAgentAiSettings,
  type NodeAgentDefinitionContext,
} from "@/node/services/agentDefinitions/resolveNodeAgentAiSettings";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import type { StreamStopCause } from "@/common/types/streamStopCause";
import {
  isActiveWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  WORKFLOW_BACKGROUND_CONTINUATION_STATUSES,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  buildWorkflowResultContextMessage,
  isWorkflowDisplayOnlyMessage,
} from "@/common/utils/workflowRunMessages";
import {
  AgentReportInlineToolArgsSchema,
  AgentReportSubmittedReportSchema,
  TaskToolResultSchema,
  type SubagentGitPatchArtifact,
} from "@/common/utils/tools/toolDefinitions";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import {
  AgentPeerMessageBroker,
  type AgentPeerMessageAdmissionError,
  type PeerPathRelation,
} from "@/node/services/agentPeerMessageBroker";

/** Cross-tree senders are untrusted: their refusal reasons carry no path/runtime detail. */
const OPAQUE_CHECKOUT_RELATIONS: ReadonlySet<PeerPathRelation> = new Set([
  "target_unrelated",
  "target_tagged",
]);
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import {
  readSubagentGitPatchArtifact,
  readSubagentGitPatchArtifactsFile,
} from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  readSubagentReportArtifactStrict,
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
  type SubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import {
  readSubagentFailureArtifact,
  readSubagentFailureArtifactsFile,
  readSubagentFailureArtifactStrict,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { secretsToRecord } from "@/common/types/secrets";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonRetryableStreamError } from "@/common/utils/messages/retryEligibility";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { isWorkspaceArchived } from "@/common/utils/archive";
import type { StartupRecoveryState } from "@/node/services/startupRecovery";
import { judgeLifecycleMarkerOwner } from "@/node/services/lifecycleMarkerOwners";
import { LegacyTodoNudgePolicyTrace, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  collectReferencedTaskIdsFromTaskToolOutput,
  type CompletedTaskReportReceipt,
  receiptMatchesReport,
  collectCompletedTaskReportReceipts,
  parseTaskToolInputForRecovery,
  collectAgentReferencedWorkflowRunIdsFromParts,
} from "@/node/services/taskToolOutputs";
import {
  isResetBoundaryMessage,
  isCompactionRequestMessage,
  isWorkflowSupersessionMessage,
  hasTerminalWorkflowTaskAwaitInParts,
  hasTerminalWorkflowToolOutputInParts,
} from "@/node/services/taskMessagePredicates";
import {
  isActiveWorkspaceTurnTaskStatus,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";
import {
  TerminalAttentionStore,
  type TerminalAttentionNotification,
} from "@/node/services/terminalAttentionStore";
import { WorkflowRunAttention } from "@/node/services/workflowRunAttention";
import {
  TerminalAttentionNotifier,
  WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS,
} from "@/node/services/terminalAttentionNotifier";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import type { AgentWorkflowRunStrictPin } from "@/node/services/agentWorkflowRunReferences";
import { normalizeWorkflowAgentReportPayloadForHostSchema } from "@/common/utils/tools/workflowReportPayload";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";

export class AgentReportWaitTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for agent_report");
    this.name = "AgentReportWaitTimeoutError";
  }
}

/** The options of TaskService.waitForAgentReport. */
interface AgentReportWaitOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  requestingWorkspaceId?: string;
  backgroundOnMessageQueued?: boolean;
  onExecutionStarted?: () => void | Promise<void>;
}

/** What one waitForAgentReport call waits for, fixed before its first await. */
interface ReportWaitRequest {
  readonly taskId: string;
  /** The caller's object: steps read its fields when they run, as the method did. */
  readonly options: AgentReportWaitOptions | undefined;
  readonly timeoutMs: number;
  readonly requestingWorkspaceId: string | undefined;
}

/** The resolve and reject of the promise a pending report wait returns. */
interface ReportWaitSettle {
  readonly resolve: (report: AgentTaskReport) => void;
  readonly reject: (error: Error) => void;
}

/**
 * A registered report wait. The waiter's closures, the report timer and the abort listener read
 * the mutable fields when they run, so steps read and write them here and never copy one into a
 * local.
 */
interface ReportWaitSession {
  readonly request: ReportWaitRequest;
  readonly settle: ReportWaitSettle;
  /** The waiter-store record. Its resolve and reject clean up, then settle. */
  readonly waiter: PendingTaskWaiter;
  timeout: ReturnType<typeof setTimeout> | null;
  startWaiter: PendingTaskStartWaiter | null;
  abortListener: (() => void) | null;
  stopBlockingRequester: (() => void) | null;
  executionStartNotified: boolean;
}

/** The request of one waitForAgentReport call: the timeout (default 10 minutes) and requester. */
function buildReportWaitRequest(
  taskId: string,
  options: AgentReportWaitOptions | undefined
): ReportWaitRequest {
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

  const requestingWorkspaceId = coerceNonEmptyString(options?.requestingWorkspaceId);
  return { taskId, options, timeoutMs, requestingWorkspaceId };
}

/** "refuse" is for model-driven task_remove (#4723); user-confirmed and automatic removals omit it. */
export interface SubagentRemovalOptions {
  lossyWorkPolicy?: "refuse";
  /** The caller holds the sub-agent's mutation gate (a parent removal gates its tree, #4477). */
  mutationGateHeld?: boolean;
  /** Receives what the forced removal left behind, for the parent removal's result (#5143). */
  onRemovalWarnings?: (warnings: WorkspaceRemoveWarning[]) => void;
  /**
   * #5106: the unpreserved work the user confirmed in the preview. Removal refuses if the work
   * found under the locks differs, so it never deletes what the confirmation did not list.
   */
  acknowledgedWork?: SubagentRemovalPreview;
}

export interface SubagentRemovalPreview {
  summary: string | null;
  paths: string[];
}

/** A sub-agent removal that passed the scope and inactivity checks; later steps extend it. */
interface InactiveTaskRemoval {
  readonly taskId: string;
  /** The row read at entry: the removal stays bound to its attempt (#4478). */
  readonly entry: { projectPath: string; workspace: WorkspaceConfigEntry };
  readonly target: { taskId: string; workspaceId: string; displayName?: string };
  readonly options: SubagentRemovalOptions | undefined;
}

/** The removal under the patch operation lock, with the patch artifact read there. */
interface InactiveTaskRemovalUnderPatchLock extends InactiveTaskRemoval {
  readonly patchArtifact: SubagentGitPatchArtifact | null;
}

/** The removal after the background-process check; guardLiveWriters gates the hold (#4761). */
interface GuardedInactiveTaskRemoval extends InactiveTaskRemovalUnderPatchLock {
  readonly guardLiveWriters: boolean;
}

/** Forwards a successful removal's warnings to the caller and maps the removal result. */
function reportInactiveTaskRemoval(
  result: Result<void> & { warnings?: WorkspaceRemoveWarning[] },
  removal: InactiveTaskRemoval
): Result<WorkspaceLifecycleResult, string> {
  if (result.success && result.warnings?.length)
    removal.options?.onRemovalWarnings?.(result.warnings);
  return Ok(
    result.success
      ? { status: "removed", action: "remove", ...removal.target }
      : { status: "error", action: "remove", ...removal.target, error: result.error }
  );
}

interface TaskParentAiMeta {
  /** Parent's persisted selected agent (see persistSelectedAgentId). */
  agentId?: string;
  aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
  aiSettings?: ResolvedWorkspaceAiSettings;
}

export interface AgentTaskStatusLookup {
  exists: boolean;
  taskStatus: AgentTaskStatus | null;
}

export interface AgentTaskTimestamps {
  createdAt?: string;
  reportedAt?: string;
}

type RpcTaskCreateArgs = Omit<TaskCreateArgs, "thinkingLevel"> & { thinkingLevel?: string };

function normalizeRpcTaskThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  return value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function parseTerminalSubagentTaskId(content: string): string | null {
  const report = parseSubagentReportEnvelope(content);
  if (report?.status === "completed") return report.taskId;
  if (!content.startsWith(SUBAGENT_FAILURE_ENVELOPE_TAG)) return null;
  return /<task_id>([^\n<]+)<\/task_id>/.exec(content)?.[1] ?? null;
}

/**
 * What acknowledgeAgentReports learns from one pass over the owner's history, for pending children
 * only: the sequence of each child's newest report row, the receipts that completed answers hold,
 * and the highest request sequence such an answer covered.
 */
interface TerminalReportHistoryScan {
  readonly terminalSequenceByTaskId: Map<string, number>;
  coveredHistorySequence: number;
  readonly toolReportsByTaskId: Map<string, CompletedTaskReportReceipt[]>;
}

/** A wake decided from the history scan, or a continuation that its turn record must decide. */
type AgentReportConsumption =
  | { kind: "decided"; consumed: boolean }
  | { kind: "continuation"; handleId: string; reports: readonly CompletedTaskReportReceipt[] };

/** Records the history sequence of a synthetic report row that names a pending child. */
function recordTerminalSubagentSequence(
  message: MuxMessage,
  pendingIds: ReadonlySet<string>,
  scan: TerminalReportHistoryScan
): void {
  const text = message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const taskId = parseTerminalSubagentTaskId(text);
  const historySequence = message.metadata?.historySequence;
  if (taskId != null && pendingIds.has(taskId) && typeof historySequence === "number") {
    scan.terminalSequenceByTaskId.set(taskId, historySequence);
  }
}

/** An assistant row that finished its stream: the first three terms of a completed answer. */
function isStoppedAssistantMessage(message: MuxMessage): boolean {
  return (
    message.role === "assistant" &&
    message.metadata?.partial !== true &&
    message.metadata?.finishReason === "stop"
  );
}

/** A compaction summary (or its legacy mode form) also stops, but it is not an answer. */
function isCompactionMessage(message: MuxMessage): boolean {
  return message.metadata?.agentId === "compact" || message.metadata?.mode === "compact";
}

/** Collects a completed answer's receipts for pending children and the request it covered. */
function collectAssistantReportReceipts(
  message: MuxMessage,
  pendingIds: ReadonlySet<string>,
  scan: TerminalReportHistoryScan
): void {
  // A late task_await can supply a report inside this SDK stream even though the
  // request's history watermark predates it. Collect receipts independently of row
  // order: the assistant placeholder is updated in place ahead of mid-stream reports.
  for (const report of collectCompletedTaskReportReceipts(message)) {
    if (!pendingIds.has(report.taskId)) continue;
    const reports = scan.toolReportsByTaskId.get(report.taskId) ?? [];
    reports.push(report);
    scan.toolReportsByTaskId.set(report.taskId, reports);
  }
  const requestHistorySequence = message.metadata?.requestHistorySequence;
  if (typeof requestHistorySequence !== "number") return;
  scan.coveredHistorySequence = Math.max(scan.coveredHistorySequence, requestHistorySequence);
}

/** Scans the whole history before any wake is decided: receipts can precede their report rows. */
function scanTerminalReportHistory(
  messages: readonly MuxMessage[],
  pendingIds: ReadonlySet<string>
): TerminalReportHistoryScan {
  const scan: TerminalReportHistoryScan = {
    terminalSequenceByTaskId: new Map<string, number>(),
    coveredHistorySequence: -1,
    toolReportsByTaskId: new Map<string, CompletedTaskReportReceipt[]>(),
  };
  for (const message of messages) {
    if (message.role === "user" && message.metadata?.synthetic === true) {
      recordTerminalSubagentSequence(message, pendingIds, scan);
      continue;
    }

    if (isStoppedAssistantMessage(message) && !isCompactionMessage(message)) {
      collectAssistantReportReceipts(message, pendingIds, scan);
    }
  }
  return scan;
}

/**
 * Decides a wake from the scan alone: a covered report row, or a first assignment's receipt. A
 * continuation of a workspace-turn handle is left to its turn record, which only TaskService reads.
 */
function decideAgentReportConsumption(
  notification: TerminalAttentionNotification,
  scan: TerminalReportHistoryScan
): AgentReportConsumption {
  const terminalSequence = scan.terminalSequenceByTaskId.get(notification.sourceId);
  const consumed = terminalSequence != null && scan.coveredHistorySequence >= terminalSequence;
  const reports = scan.toolReportsByTaskId.get(notification.sourceId) ?? [];
  if (!consumed && notification.terminalOutcome === "completed" && reports.length > 0) {
    if (notification.generationId == null) {
      // Initial assignments have no execution identity; continuations do. Never let
      // a stable child ID's older receipt consume a later assignment's notification.
      return { kind: "decided", consumed: reports.some((report) => report.kind === "initial") };
    }
    // Resolve the notification's assignment, not the child's latest execution: the
    // parent may already have reawakened that child before this drain gets its turn.
    const [handleId] = notification.generationId.split(":");
    if (!isWorkspaceTurnTaskId(handleId)) return { kind: "decided", consumed: false };
    return { kind: "continuation", handleId, reports };
  }
  return { kind: "decided", consumed };
}

/** A continuation receipt that names the record's handle (or no handle), final message and report. */
function receiptMatchesTurnRecord(
  report: CompletedTaskReportReceipt,
  record: WorkspaceTurnTaskHandleRecord
): boolean {
  return (
    report.kind === "continuation" &&
    (report.handleId == null || report.handleId === record.handleId) &&
    report.messageId === record.messageId &&
    receiptMatchesReport(report, record.reportMarkdown)
  );
}

/**
 * Workspace-turn terminal output is not injected into parent history; it lives in the task handle
 * store. The wake-up must tell the agent to retrieve it with a one-shot task_await.
 */
function buildCompletedWorkspaceTurnPrompt(handleIds: string[]): string {
  assert(handleIds.length > 0, "buildCompletedWorkspaceTurnPrompt requires at least one handle id");
  return (
    `${BACKGROUND_WORK_WAKE_OPENINGS.workspaceTurnsTerminal} ` +
    `${handleIds.join(", ")}. ` +
    `Call task_await now with task_ids: ${JSON.stringify(handleIds)} and timeout_secs: 0 to ` +
    "retrieve their terminal output, then integrate it into your work. These handles are already " +
    "terminal — do not repeatedly wait if task_await returns a terminal status."
  );
}

/**
 * Tool-end wake for sub-agent reports/failures that landed in a busy owner's history (see
 * cutBusyOwnerTurnForSubagentAttention). The reports themselves are already durable rows above
 * this prompt, so it only points at them and explains the backgrounded waits.
 */
function buildBusyOwnerSubagentAttentionPrompt(allFailed: boolean): string {
  const opening = allFailed
    ? BACKGROUND_WORK_WAKE_OPENINGS.subagentsFailed
    : BACKGROUND_WORK_WAKE_OPENINGS.subagentsCompleted;
  return (
    `${opening} Their ${allFailed ? "failures are" : "reports are"} in the conversation above; ` +
    "review them now. Any task_await you were running was sent to the background and its tasks " +
    "keep running; call task_await again when you need their results."
  );
}

function getTaskCompletionInstruction(params: {
  completionKind: "final_response" | "propose_plan";
  requiresStructuredOutput?: boolean;
}): string {
  if (params.completionKind === "propose_plan") {
    return "Call propose_plan exactly once now. Base it only on the planning work already completed in this workspace.";
  }

  const structuredInstruction = params.requiresStructuredOutput
    ? "First call agent_report with the final structured output required by this workflow step. Then "
    : "";
  return `${structuredInstruction}respond with your final assistant message now. Base it only on the work already completed in this workspace.`;
}

type AgentReportFinalizationResult =
  | { finalized: true }
  | {
      finalized: false;
      reason:
        | "invalid_structured_output"
        | "pending_guidance"
        | "terminal_interrupted"
        | "superseded_attempt"
        | "retired_attempt";
      message: string;
    };

/**
 * Rendered form of a labeled task message as sendMessageToDescendantAgentTask
 * persists it.
 */
/**
 * Config loads leniently: a corrupted non-string or blank id must never become an advertised
 * related-chat row, or one bad entry would break task_list's result schema for every peer.
 * Returns the id unchanged (not trimmed) so it still addresses the exact entry.
 */
function addressableWorkspaceId(entry: { id?: unknown }): string | undefined {
  return typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : undefined;
}

function renderLabeledTaskMessage(label: string, message: string): string {
  return `${label}:\n\n${message}`;
}

function formatStructuredOutputValidationMessage(params: {
  workflowTask: NonNullable<WorkspaceConfigEntry["workflowTask"]>;
  errors: Array<{ path: string; message: string }>;
}): string {
  const stepLabel = params.workflowTask.stepId
    ? ` for workflow step ${params.workflowTask.stepId}`
    : "";
  const errorSummary = formatJsonSchemaValidationErrors(params.errors, { maxErrors: 5 });
  return `agent_report structuredOutput failed schema validation${stepLabel}: ${errorSummary}`;
}

/** Entry selected to continue a host-cut turn; undefined for genuine or blocked stops. */
function continuationEntryIdOfStopCause(
  stopCause: StreamStopCause | undefined
): string | undefined {
  if (stopCause?.kind === "queued-input") return stopCause.entryId;
  if (stopCause?.kind === "context-budget" && stopCause.decision !== "block") {
    return stopCause.continuationEntryId;
  }
  return undefined;
}

function normalizeWorkflowAgentReportArgsForWorkflowTask(
  workflowTask: WorkspaceConfigEntry["workflowTask"] | undefined,
  reportArgs: {
    reportMarkdown: string;
    title?: string;
    structuredOutput?: unknown;
    planFilePath?: string;
  }
): { reportMarkdown: string; title?: string; structuredOutput?: unknown; planFilePath?: string } {
  if (workflowTask?.outputSchema === undefined || reportArgs.structuredOutput === undefined) {
    return reportArgs;
  }
  return {
    ...reportArgs,
    structuredOutput: normalizeWorkflowAgentReportPayloadForHostSchema(
      workflowTask.outputSchema,
      reportArgs.structuredOutput
    ),
  };
}

function validateWorkflowAgentReportStructuredOutput(params: {
  workflowTask?: WorkspaceConfigEntry["workflowTask"];
  reportArgs: { structuredOutput?: unknown };
  allowLegacyInvalidOutputSchema: boolean;
}): string | null {
  const workflowTask = params.workflowTask;
  if (workflowTask?.outputSchema === undefined) {
    return null;
  }

  if (params.allowLegacyInvalidOutputSchema) {
    return null;
  }

  if (
    !Object.hasOwn(params.reportArgs, "structuredOutput") ||
    params.reportArgs.structuredOutput === undefined
  ) {
    return formatStructuredOutputValidationMessage({
      workflowTask,
      errors: [{ path: "$.structuredOutput", message: "Required property is missing" }],
    });
  }

  const structuredOutput = normalizeWorkflowAgentReportPayloadForHostSchema(
    workflowTask.outputSchema,
    params.reportArgs.structuredOutput
  );
  const validation = validateJsonSchemaSubset(workflowTask.outputSchema, structuredOutput);
  if (validation.success) {
    return null;
  }

  return formatStructuredOutputValidationMessage({
    workflowTask,
    errors: validation.errors,
  });
}

function isAgentRunnableAsChild(
  frontmatter: { subagent?: { runnable?: boolean; workflow_runnable?: boolean } },
  params: { workflowOwned: boolean }
): boolean {
  if (frontmatter.subagent?.runnable === true) {
    return true;
  }
  return params.workflowOwned && frontmatter.subagent?.workflow_runnable === true;
}

export interface TaskCreateResult {
  desktopOwnerWorkspaceId?: string;
  taskId: string;
  kind: TaskKind;
  status: "queued" | "starting" | "running";
  /** Resolved (post-precedence) AI settings the child was created with. */
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * `sendId`: the brief send's id (idempotent sends, see sendIds.ts), persisted on the row as
 * taskPromptSendId before the send. The row that accepts the brief carries it, so a reawakening
 * prepends a kept taskPrompt only while no history row does.
 */
type TaskLaunchStart =
  | { kind: "sendMessage"; prompt: string; sendId: string }
  | { kind: "resumeStream" };

/**
 * A launch's brief send id: minted for one launch (the reservation that writes it next to
 * taskPrompt), so no publication has seen it before that launch's send. A relaunch mints anew.
 */
function mintTaskBriefSendId(): string {
  return `${MINTED_SEND_ID_PREFIX}${randomUUID()}`;
}

/**
 * The brief's send identity: the launch stamps it, and a lookup checks the same id. The digest is
 * the brief's also when the row carries the brief followed by guidance (a reactivation that
 * prepends a kept brief, #5544): the id stands for the brief that row delivers.
 */
function taskBriefSendIdentity(prompt: string, sendId: string): SendIdentity {
  return { id: sendId, digest: computeSendDigest({ message: prompt.trim() }) };
}

/** The report a settled child delivers (waitForAgentReport, readAttemptOutcome). */
export interface AgentTaskReport {
  reportMarkdown: string;
  title?: string;
  structuredOutput?: unknown;
  planFilePath?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/**
 * An execution attempt this process owns: reserved, launched, reawakened or reactivated HERE.
 * Identity (not a counter compared by value) so a settlement captured before an awaited write
 * can be matched exactly against the attempt it belongs to. Persisted status, a stop cascade or
 * startup reconciliation never mint one: a prior backend's attempt has no owner in this process.
 */
export interface OwnedTaskAttempt {
  readonly generation: number;
  readonly source: string;
  /**
   * Reservation cancellation of THIS attempt (createMany abortSignal). Rides with the identity so
   * a plan the scheduler rebuilds from config (capacity-queued, or requeued by the stop barrier)
   * still observes it; a reawakening starts a new identity and never inherits it.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Persisted taskAttemptId this attempt was admitted under (captured at admission, never re-read
   * from config): a settlement or receipt names exactly this id. Undefined only for owners of a
   * pre-identity entry that no admission has stamped yet.
   */
  readonly attemptId: string | undefined;
  /**
   * Lineage proven settled at admission (reservation by construction; reawaken/reactivation only
   * with a receipt or this process's settled predecessor). Decided once from the committed row;
   * downgraded (never upgraded) when the committing mutator saw the unproven marker appear after
   * the snapshot. False → this attempt can never produce a cross-process receipt.
   */
  receiptEligible: boolean;
}

/** In-process settlement ledger entry; see AttemptLedger.attemptSettlementByTaskId. */
export interface AttemptSettlementEntry {
  /** The attempt id the closure/settlement names; undefined only for pre-identity entries. */
  readonly attemptId: string | undefined;
  /** Present when the attempt is owned by this process (only owners can reach `settled`). */
  readonly attempt?: OwnedTaskAttempt;
  /**
   * `closing`: a producer decided the attempt ends and closed it to further sends, but the
   * owner's settlement is not recorded yet (or never will be, for an unowned attempt).
   * `settled`: the owner's authoritative settlement (terminal-no-report evidence).
   */
  phase: "closing" | "settled";
  source: string;
}

/** A reawakenInterruptedTask refusal: the call decided to reawaken and lost a race. */
type ReawakenRefusal = Extract<TaskReawakenOutcome, { kind: "refused" }>;

/** The settled-predecessor evidence reawakenInterruptedTask reads before its lineage awaits. */
interface ReawakenPredecessor {
  readonly settledPredecessor: AttemptSettlementEntry | undefined;
  readonly releasedReportedAttempt: boolean;
  readonly resumeSettledReportedTask: boolean;
}

/** What reawakenInterruptedTask read from the row and ledgers before its lineage awaits. */
interface ReawakenCandidate extends ReawakenPredecessor {
  readonly workspace: WorkspaceConfigEntry;
  readonly previousAttemptId: string | undefined;
  readonly stopEpochAtStart: number;
}

/** classifyReawakenAdmission: an outcome that ends the call, or a candidate to reawaken. */
type ReawakenAdmission =
  | Exclude<TaskReawakenOutcome, { kind: "reawakened" }>
  | { kind: "proceed"; candidate: ReawakenCandidate };

/**
 * The snapshots reawakenInterruptedTask's critical section rechecks against: all taken before
 * the mutex (the stop epoch before the lineage awaits), never re-read under it.
 */
interface ReawakenPlan extends ReawakenCandidate {
  readonly workspaceId: string;
  readonly lineage: { readonly proven: boolean; readonly reason: string };
  readonly attemptId: string;
}

/** The row reads resumable as an interrupted task or a desktop-owned reported one. */
function rowReadsInterruptedForReawaken(
  ws: Pick<WorkspaceConfigEntry, "taskStatus" | "taskDesktopOwnerWorkspaceId">
): boolean {
  return (
    ws.taskStatus === "interrupted" ||
    (ws.taskStatus === "reported" && ws.taskDesktopOwnerWorkspaceId != null)
  );
}

/** The row still names `previousAttemptId`, with no retire claim and no pending removal. */
function rowKeepsAttempt(
  ws: Pick<WorkspaceConfigEntry, "taskAttemptRetiredBy" | "pendingRemoval" | "taskAttemptId">,
  previousAttemptId: string | undefined
): boolean {
  return (
    ws.taskAttemptRetiredBy == null &&
    ws.pendingRemoval == null &&
    ws.taskAttemptId === previousAttemptId
  );
}

/**
 * The model fields of a send into an active task: the active agent's settings first, then the
 * row's task model and thinking level, then the default model.
 */
function buildActiveTaskAiSendOptions(
  workspace: Pick<WorkspaceConfigEntry, "taskModelString" | "taskThinkingLevel">,
  agentId: string,
  aiSettings: ResolvedWorkspaceAiSettings | undefined
): Pick<
  SendMessageOptions,
  "model" | "agentId" | "thinkingLevel" | "reasoningMode" | "serviceTier"
> {
  return {
    model: coerceNonEmptyString(aiSettings?.model) ?? workspace.taskModelString ?? defaultModel,
    agentId,
    thinkingLevel: aiSettings?.thinkingLevel ?? workspace.taskThinkingLevel,
    reasoningMode: coerceOpenAIReasoningMode(aiSettings?.reasoningMode),
    serviceTier: ServiceTierSchema.safeParse(aiSettings?.serviceTier).data,
  };
}

/** This process settled exactly the attempt the row still names. */
function settlementNamesRowAttempt(
  settled: AttemptSettlementEntry | undefined,
  rowAttemptId: string | undefined
): boolean {
  return rowAttemptId != null && settled?.attemptId === rowAttemptId && settled.phase === "settled";
}

/**
 * One send admitted into a task workspace against a specific attempt (see TurnAdmissionToken in
 * the seam). Identity is immutable: an obligation admitted under attempt X can never enter, or be
 * removed from, a successor attempt's stop record.
 */
export interface AdmittedSend {
  readonly taskId: string;
  readonly attemptId: string;
  /** Set for sends admitted while this process owns the attempt (receipt authority, later change). */
  readonly attempt?: OwnedTaskAttempt;
  state: "pending" | "enqueued" | "admitted" | "discharged";
  /** The admitted turn generation; rebound to its successor on supersession. */
  turnId?: symbol;
  /**
   * Set when `turnId` was rebound from a superseded predecessor (recordWorkspaceTurnSuperseded):
   * the obligation waits on that turn, but the turn was not admitted for it. Lookups that
   * attribute a turn's stream to an attempt prefer the turn's direct admission.
   */
  inherited?: boolean;
  /** Stop records that captured this obligation while it was pending (by reference). */
  readonly capturedBy: Set<WorkspaceStopRecord>;
  readonly token: TurnAdmissionToken;
}

/**
 * The decision a child task's stream-end handler owes for the owned attempt whose stream just
 * ended: did that stream carry the task's terminal report? Registered synchronously in the
 * stream-end event's own tick — before the session's turn-completion policy (a later microtask)
 * can drain the queue against the attempt — and resolved exactly once from inside the handler:
 *  - `pending`: not classified yet. Queued follow-ups bound to this attempt are HELD at the
 *    dequeue gate (retained, not dispatched, not dropped) and a direct send still in preflight
 *    reads stale — neither may start a turn under an attempt that is about to complete.
 *  - `nonreport`: no terminal report was published; the attempt continues and held entries
 *    proceed through their ordinary gates under it.
 *  - `published`: the report is durable and the attempt released. A held entry is refused, its
 *    text handed back as unsent input; the user's next send is a new, normally admitted send
 *    (markInterruptedTaskRunning mints the fresh attempt) — never an automatic continuation.
 *  - `indeterminate`: the handler threw, the artifact was not durable everywhere, or the row has
 *    no parent to report to. Never a continuation: held entries are refused as for `published`.
 * Bound to the exact OwnedTaskAttempt object, so a reawakening that replaced the attempt while
 * the handler waited never reads a predecessor's decision as its own. A stream this process ran
 * for an attempt it does not own (a startup re-drive, a prior process's attempt) gets an UNOWNED
 * decision (`attempt` undefined) keyed by the persisted attempt id: queued sends bound to that id
 * are held and refused exactly the same way, and no ownership, settlement or receipt authority is
 * granted to obtain the hold. Lifetime is explicit, never
 * a count: dropped once no pending/enqueued obligation of the attempt remains to read it, and
 * when a new attempt begins in this process (sends bound to the old id read stale anyway). A
 * terminal (`published`/`indeterminate`) decision additionally stays while the reporting turn it
 * was decided for is live: input sent after it resolved but before that turn settles targets the
 * same attempt and must still find it (preflight refusal, or the dequeue gate's refusal).
 */
export interface StreamEndDecision {
  readonly attempt: OwnedTaskAttempt | undefined;
  readonly attemptId: string;
  readonly messageId: string;
  outcome: "pending" | "nonreport" | "published" | "indeterminate";
  /**
   * The session's turn generation the stream ended in (undefined when none was live, or once it
   * settled). Rebound on supersession like a stop record's captured turns.
   */
  turn: symbol | undefined;
}

interface TaskLaunchPlan {
  taskId: string;
  parentWorkspaceId: string;
  parentMeta: WorkspaceMetadata;
  agentId: string;
  agentType: string;
  start: TaskLaunchStart;
  title: string;
  workspaceName: string;
  createdAt: string;
  taskRuntimeConfig: RuntimeConfig;
  parentRuntimeConfig: RuntimeConfig;
  configProjectPath: string;
  workspaceKind?: "scratch";
  taskModelString: string;
  canonicalModel: string;
  effectiveThinkingLevel?: ThinkingLevel;
  effectiveReasoningMode?: OpenAIReasoningMode;
  /** New reservations only (always an object); relaunches of existing entries keep theirs. */
  taskAiPins?: TaskAiPins;
  skipInitHook: boolean;
  preferredTrunkBranch?: string;
  workflowTask?: TaskCreateArgs["workflowTask"];
  bestOf?: TaskCreateArgs["bestOf"];
  onRefusal?: TaskCreateArgs["onRefusal"];
  attentionPolicy?: TaskCreateArgs["attentionPolicy"];
  taskDesktopOwnerWorkspaceId?: string;
  /**
   * Reservation cancellation (createMany abortSignal), re-checked after every await of the launch
   * up to the physical send admission. Plans rebuilt by the scheduler or after a restart carry
   * none and follow the existing path.
   */
  abortSignal?: AbortSignal;
  /** Attempt id the reservation commit (or the queue drain's launch CAS) published for this plan. */
  attemptId?: string;
  /**
   * createMany only: the parent row was found by id when the reservation was revalidated, so the
   * commit refuses if it is gone by then (see assertParentAdmitsChild).
   */
  requireParentRow?: boolean;
  /** createMany only: see LegacyParentRow. */
  legacyParentRow?: LegacyParentRow;
  /**
   * Flipped by the launch fence immediately before the send is admitted. A launch failure that
   * observes it false has positive evidence that no execution was ever admitted for the attempt.
   */
  sendAdmitted?: boolean;
  /**
   * The "launch" use lease the reservation took before the row became `starting`, handed to the
   * launch (startReservedAgentTask), which takes it over and releases it when it settles.
   */
  launchLease?: WorkspaceUseLease;
}

/** What fenceReservationRow's row mutator saw; its callers read it after the edit settles. */
interface ReservationRowFence {
  transitioned: boolean;
  superseded: boolean;
  rowMoved: boolean;
}

/** A Task.create request after validation, read before the global mutex is taken. */
interface TaskCreateRequest {
  readonly args: TaskCreateArgs;
  readonly parentWorkspaceId: string;
  readonly prompt: string;
  readonly agentId: string;
  /** Legacy alias of agentId, for on-disk compatibility. */
  readonly agentType: string;
  readonly normalizedBestOf: TaskCreateArgs["bestOf"];
  readonly taskDesktopOwnerWorkspaceId: string | undefined;
}

/** The request plus the parent facts Task.create reads once under the global mutex. */
interface TaskCreateParent extends TaskCreateRequest {
  readonly parentMeta: WorkspaceMetadata;
  readonly cfg: ProjectsConfig;
  readonly projectPluginsTrusted: boolean;
  readonly taskSettings: TaskSettings;
  readonly parentEntry: ReturnType<typeof findWorkspaceEntry>;
  readonly legacyParentRow: LegacyParentRow | undefined;
  readonly parentIsScratch: boolean;
  readonly configProjectPath: string;
}

/** The parent facts plus the new task's identity, runtime and checkout choice. */
interface TaskCreatePlacement extends TaskCreateParent {
  readonly activeCount: number;
  readonly shouldQueue: boolean;
  readonly taskId: string;
  readonly workspaceName: string;
  readonly parentRuntimeConfig: RuntimeConfig;
  readonly taskRuntimeConfig: RuntimeConfig;
  readonly runtime: Runtime;
  readonly parentWorkspacePath: string;
  readonly taskRuntimeMode: ReturnType<typeof getRuntimeType>;
  readonly parentIsMultiProject: boolean;
  readonly useSharedWorkspace: boolean;
}

/** Everything Task.create decided before it queues or launches the task. */
interface TaskCreatePlan extends TaskCreatePlacement {
  readonly parentBranchName: string | undefined;
  readonly skipInitHook: boolean;
  readonly taskModelString: string;
  readonly canonicalModel: string;
  readonly effectiveThinkingLevel: ThinkingLevel;
  readonly effectiveReasoningMode: OpenAIReasoningMode | undefined;
  readonly taskAiPins: TaskAiPins;
  readonly createdAt: string;
}

/** Validates Task.create's bestOf: undefined when absent, else the normalized group slot. */
function normalizeTaskCreateBestOf(
  bestOf: TaskCreateArgs["bestOf"]
): Result<TaskCreateArgs["bestOf"], string> {
  if (!bestOf) {
    return Ok(undefined);
  }
  const groupId = coerceNonEmptyString(bestOf.groupId);
  if (!groupId) {
    return Err("Task.create: bestOf.groupId is required when bestOf is provided");
  }
  if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
    return Err("Task.create: bestOf.index must be a non-negative integer");
  }
  if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
    return Err("Task.create: bestOf.total must be an integer >= 2");
  }
  if (bestOf.index >= bestOf.total) {
    return Err("Task.create: bestOf.index must be less than bestOf.total");
  }

  return Ok({
    groupId,
    index: bestOf.index,
    total: bestOf.total,
  });
}

/**
 * Whether a task shares its parent's checkout: a scratch parent, or isolation: "none" on a
 * runtime that supports it for a single-project parent. A multi-project parent there is refused.
 */
function decideSharedTaskWorkspace(
  isolation: TaskCreateArgs["isolation"],
  taskRuntimeMode: ReturnType<typeof getRuntimeType>,
  parentIsScratch: boolean,
  parentIsMultiProject: boolean
): Result<boolean, string> {
  if (
    isolation === "none" &&
    runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
    parentIsMultiProject
  ) {
    return Err(`Task.create: ${MULTI_PROJECT_SHARED_ISOLATION_ERROR}`);
  }
  return Ok(
    parentIsScratch ||
      (isolation === "none" &&
        runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
        !parentIsMultiProject)
  );
}

/** A direct launch's materialized checkout, read by the steps after its entry is persisted. */
interface TaskLaunchCheckout {
  readonly initLogger: InitLogger;
  readonly workspacePath: string;
  readonly trunkBranch: string;
  readonly forkedRuntimeConfig: RuntimeConfig;
  readonly runtimeForTaskWorkspace: Runtime;
}

/** What a direct launch materialized, before its entry is persisted. */
interface MaterializedTaskCheckout extends TaskLaunchCheckout {
  readonly forkedFromSource: boolean;
  readonly inheritedProjects: ProjectRef[] | undefined;
  /**
   * Written with the task's row (appendLaunchedTaskEntry), never before it: a fork rollback
   * elsewhere restores this parent mark only while no row uses the shared workspace (#5114).
   */
  readonly sourceRuntimeConfigUpdate: RuntimeConfig | undefined;
}

/**
 * A direct Task.create launch's progress. The launch writes it as it advances and its failure
 * path (failTaskLaunch) reads it, so it is one mutable record: a copy would read stale values.
 */
interface TaskLaunchState {
  materializedCheckout: { initLogger: InitLogger; runtime: Runtime } | undefined;
  readonly attemptId: string;
  /** Unset until the entry is persisted: a failure before that only rolls the checkout back. */
  launchAttempt: OwnedTaskAttempt | undefined;
  sendAdmitted: boolean;
}

/**
 * The plan fields that the launch blocks shared by a reserved launch (TaskLaunchPlan) and a
 * direct Task.create launch (TaskCreatePlan) read.
 */
type TaskLaunchSource = Pick<
  TaskLaunchPlan,
  | "taskId"
  | "workspaceName"
  | "parentWorkspaceId"
  | "parentMeta"
  | "parentRuntimeConfig"
  | "configProjectPath"
  | "skipInitHook"
>;

/** The launch failure message for a prompt admission the launch fence did not grant. */
function launchAdmissionRefusalMessage(
  admission: Exclude<TaskTurnAdmission, { kind: "admitted" }>
): string {
  return admission.kind === "refused"
    ? admission.message
    : "Task launch refused: the task record is no longer an agent task";
}

/** The launch failure message for a prompt send that failed. */
function launchSendErrorMessage(error: string | SendMessageError): string {
  return typeof error === "string" ? error : formatSendMessageError(error).message;
}

/** What failTaskLaunch's CAS on the task's row found. */
interface TaskLaunchFailureMark {
  superseded: boolean;
  transitionedToInterrupted: boolean;
  parentWorkspaceId: string | undefined;
}

/**
 * A queued task the drain cleared for launch, with what it read for the launch plan before the
 * launch lease: snapshots, never re-read after the lease and CAS awaits.
 */
interface QueuedTaskLaunchRequest {
  readonly taskId: string;
  /** The queued row the drain listed. */
  readonly task: AgentTaskWorkspaceEntry;
  readonly start: TaskLaunchStart;
  readonly parentWorkspaceId: string;
  readonly parentMeta: WorkspaceMetadata;
  readonly agentId: string;
  readonly workspaceName: string;
  readonly createdAt: string;
  readonly taskRuntimeConfig: RuntimeConfig;
  readonly parentRuntimeConfig: RuntimeConfig;
  readonly configProjectPath: string;
  readonly canonicalModel: string;
  readonly skipInitHook: boolean;
}

/** The attempt a queued task's launch CAS wrote on the fresh row. */
interface QueuedLaunchAttempt {
  readonly attemptId: string;
  readonly receiptEligible: boolean;
}

/**
 * One queued task's outcome in a drain: it took a slot, it was skipped (refused, failed or left
 * queued), or shutdown began and the drain reserves no more tasks.
 */
type QueuedTaskReservation = "reserved" | "skipped" | "shutdown";

/** What a queue drain read under the mutex before its per-task loop, for every task's checks. */
interface QueuedDrainSnapshot {
  readonly config: ProjectsConfig;
  readonly taskIndex: AgentTaskIndex;
}

/** A drain that has queued tasks and a free slot: what its per-task loop reads. */
interface QueuedDrain extends QueuedDrainSnapshot {
  readonly queuedTasks: readonly AgentTaskWorkspaceEntry[];
  readonly availableSlots: number;
}

/** A drain's reads under the mutex: idle (nothing queued, or no free slot), or open. */
type QueuedDrainOpening =
  | { readonly kind: "idle" }
  | { readonly kind: "open"; readonly drain: QueuedDrain };

/** A queued task's parent, as the drain's config names it, and the runtimes its launch uses. */
interface QueuedTaskParent {
  readonly parentWorkspaceId: string;
  readonly parentEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
  readonly parentWorkspaceName: string;
  readonly taskRuntimeConfig: RuntimeConfig;
  readonly parentRuntimeConfig: RuntimeConfig;
}

/** A queued task past the drain's refusals: snapshots taken before its parent metadata read. */
interface QueuedTaskCandidate extends QueuedTaskParent {
  readonly taskId: string;
  /** The queued row the drain listed. */
  readonly task: AgentTaskWorkspaceEntry;
  readonly start: TaskLaunchStart;
  readonly config: ProjectsConfig;
  readonly configProjectPath: string;
}

/** The candidate plus its parent's metadata (read, or rebuilt from the parent's config row). */
interface QueuedTaskParentRead extends QueuedTaskCandidate {
  readonly parentRuntimeProjectPath: string;
  readonly parentMeta: WorkspaceMetadata;
}

/** A queued task's brief send, or a resume of the stream a legacy record left pending. */
function queuedTaskLaunchStart(taskId: string, task: AgentTaskWorkspaceEntry): TaskLaunchStart {
  const queuedPrompt = coerceNonEmptyString(task.taskPrompt);
  const start: TaskLaunchStart = queuedPrompt
    ? { kind: "sendMessage", prompt: queuedPrompt, sendId: mintTaskBriefSendId() }
    : { kind: "resumeStream" };
  if (start.kind === "resumeStream") {
    // Older queued task records stored the initial prompt only in chat history.
    // Keep those upgrade-safe by resuming the existing pending stream instead of failing launch.
    taskQueueDebug("TaskService.maybeStartQueuedTasks legacy resumeStream reservation", {
      taskId,
    });
  }
  return start;
}

/** A queued task's parent in the drain's config, or why the task cannot launch under it. */
function resolveQueuedTaskParent(
  task: AgentTaskWorkspaceEntry,
  config: ProjectsConfig
): { kind: "refused"; reason: string } | { kind: "found"; parent: QueuedTaskParent } {
  const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
  if (!parentWorkspaceId) {
    return { kind: "refused", reason: "Queued task missing parentWorkspaceId" };
  }

  const parentEntry = findWorkspaceEntry(config, parentWorkspaceId);
  if (!parentEntry) {
    return { kind: "refused", reason: "Queued task parent not found" };
  }
  const parentWorkspaceName = coerceNonEmptyString(parentEntry.workspace.name);
  if (!parentWorkspaceName) {
    return { kind: "refused", reason: "Queued task parent missing workspace name" };
  }

  const taskRuntimeConfig = task.runtimeConfig ?? parentEntry.workspace.runtimeConfig;
  const parentRuntimeConfig = parentEntry.workspace.runtimeConfig ?? taskRuntimeConfig;
  if (!taskRuntimeConfig || !parentRuntimeConfig) {
    return { kind: "refused", reason: "Queued task missing runtimeConfig" };
  }
  return {
    kind: "found",
    parent: {
      parentWorkspaceId,
      parentEntry,
      parentWorkspaceName,
      taskRuntimeConfig,
      parentRuntimeConfig,
    },
  };
}

/** Why a queued task's projects refuse its launch, or undefined when every one is trusted. */
function queuedTaskTrustRefusal(
  task: AgentTaskWorkspaceEntry,
  normalizedTaskProjectPath: string,
  config: ProjectsConfig
): string | undefined {
  const taskProjectConfig = config.projects.get(normalizedTaskProjectPath);
  if (!taskProjectConfig?.trusted) {
    return "Task skipped: project is not trusted";
  }
  const untrustedSecondaryProject = findUntrustedSecondaryProject(
    task,
    normalizedTaskProjectPath,
    config
  );
  if (untrustedSecondaryProject) {
    return `Task skipped: project ${untrustedSecondaryProject.projectPath} is not trusted`;
  }
  return undefined;
}

/** A multi-project task's first secondary project that the config does not trust. */
function findUntrustedSecondaryProject(
  task: AgentTaskWorkspaceEntry,
  normalizedTaskProjectPath: string,
  config: ProjectsConfig
): NonNullable<AgentTaskWorkspaceEntry["projects"]>[number] | undefined {
  return Array.isArray(task.projects) && task.projects.length > 1
    ? task.projects.find((project) => {
        const normalizedProjectPath = stripTrailingSlashes(project.projectPath);
        if (normalizedProjectPath === normalizedTaskProjectPath) {
          return false;
        }
        return !(config.projects.get(normalizedProjectPath)?.trusted ?? false);
      })
    : undefined;
}

/** Release a launch lease; a failed release is logged (the lock dies with the process anyway). */
async function releaseLaunchLease(taskId: string, lease: WorkspaceUseLease): Promise<void> {
  await lease.release().catch((error: unknown) => {
    log.warn("Task launch: failed to release the launch lease", {
      taskId,
      error: getErrorMessage(error),
    });
  });
}

/**
 * The launch leases createMany takes for its `starting` reservations before committing them (see
 * startReservedAgentTask). Each is handed to its launch with take(); scope exit releases the rest,
 * on every path where a reservation is not launched.
 */
async function holdLaunchLeases(
  leases: WorkspaceUseLeases,
  taskIds: readonly string[]
): Promise<{ take(taskId: string): WorkspaceUseLease | undefined } & AsyncDisposable> {
  const held = new Map<string, WorkspaceUseLease>();
  const releaseAll = async () => {
    for (const [taskId, lease] of held) await releaseLaunchLease(taskId, lease);
    held.clear();
  };
  try {
    for (const taskId of taskIds) held.set(taskId, await leases.hold(taskId, "launch"));
  } catch (error) {
    await releaseAll();
    throw error;
  }
  return {
    take(taskId) {
      const lease = held.get(taskId);
      held.delete(taskId);
      return lease;
    },
    [Symbol.asyncDispose]: releaseAll,
  };
}

interface TaskCreateManyOptions {
  onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
  /**
   * Cancels the cancellable admission stages of createMany (tree locks, global mutex, read-only
   * preparation, desktop gate, checkpoint entry) promptly, and fences the owned commit/launch:
   * a canceled plan is persisted `interrupted` with taskLaunchError "Reservation canceled" and is
   * never launched. Config writes and the checkpoint callback already entered are owned to
   * completion, never detached. The Result error is NOT the "Task interrupted" restart sentinel.
   */
  abortSignal?: AbortSignal;
  /**
   * Single-use publication (G2, #4452 gap 2), aligned with the args: the i-th child replaces the
   * retired attempt named here. The publishing config commit verifies, in the same write, that
   * the prior row still names that attempt, carries this claim nonce and has no replacement yet,
   * and records the child as its replacementTaskId. Any mismatch fails the whole reservation.
   */
  retires?: ReadonlyArray<TaskRetiresClaim | undefined>;
}

/** The claim a replacement child consumes (claimRetiredAttempt's result). */
export interface TaskRetiresClaim {
  taskId: string;
  attemptId: string;
  nonce: string;
}

/**
 * #4914: an upgraded parent whose config row is still id-less resolves only through its session
 * metadata (Config.findWorkspace). Its stable identity (config project key + workspace path) lets
 * a task-creation commit find that row again, so a removal of it refuses the child as well.
 */
interface LegacyParentRow {
  projectPath: string;
  workspacePath: string;
}

/**
 * #4782: a child committed under a parent that another backend is removing (or has removed) would
 * outlive it as an orphaned row. Checked inside every task-creation config write; the removal
 * checks for descendants after its marker claim (WorkspaceService.removeUnlocked), so either the
 * child's write sees the marker or the removal sees the child. `requireRow` refuses a parent row
 * that disappeared since preparation found it by id; `legacyRow` finds (and requires) an id-less
 * row that preparation resolved through session metadata, unless its id was persisted meanwhile.
 */
function assertParentAdmitsChild(
  config: Parameters<typeof findWorkspaceEntry>[0],
  parentWorkspaceId: string,
  options: { requireRow: boolean; legacyRow?: LegacyParentRow }
): void {
  const legacyRow = options.legacyRow;
  const parent =
    findWorkspaceEntry(config, parentWorkspaceId)?.workspace ??
    (legacyRow == null
      ? undefined
      : config.projects
          .get(legacyRow.projectPath)
          ?.workspaces.find((row) => !row.id && row.path === legacyRow.workspacePath));
  if (parent == null) {
    if (options.requireRow || legacyRow != null) {
      throw new Error(`Task.create: parent workspace ${parentWorkspaceId} was removed`);
    }
    return;
  }
  if (parent.pendingRemoval != null) {
    throw new Error(
      `Task.create: parent workspace ${parentWorkspaceId} is being removed (by Xum process ${parent.pendingRemoval.pid})`
    );
  }
  // #4928: another backend's archive checked for (active) sub-agents before its archivedAt commit
  // and cannot see this creation, so the creation sees that archive instead. Its pendingArchive
  // marker is written before it lists the sub-agents it cascades over, and this check runs inside
  // the same cross-process config lock: either this write sees the marker (or the archived row),
  // or the archive's listing sees this child. The marker of an ancestor fences this parent too,
  // since that archive cascades over it. The walk follows ids only: an archive never marks an
  // id-less (#4914) row (WorkspaceService.claimPendingArchive refuses to archive one), and every
  // row between the parent and a marked ancestor is one of its sub-agents, which task creation
  // always writes with an id. A marker whose owner process died does not refuse.
  if (isWorkspaceArchived(parent.archivedAt, parent.unarchivedAt)) {
    throw new Error(`Task.create: parent workspace ${parentWorkspaceId} is archived`);
  }
  const visited = new Set<string>();
  let row: typeof parent | undefined = parent;
  while (row != null) {
    const marker = row.pendingArchive;
    if (marker != null && !judgeLifecycleMarkerOwner(marker).dead) {
      throw new Error(
        `Task.create: parent workspace ${parentWorkspaceId} is being archived (by Xum process ${marker.pid})`
      );
    }
    const nextId: string | undefined = row.parentWorkspaceId;
    if (nextId == null || visited.has(nextId)) break;
    visited.add(nextId);
    row = findWorkspaceEntry(config, nextId)?.workspace;
  }
}

/** Last stage a reservation entered; carried into abort/timeout diagnostics and the stall warning. */
type TaskReservationStage =
  | "tree-lock"
  | "mutex"
  | "prepare"
  | "revalidate"
  | "desktop-gate"
  | "checkpoint"
  | "config-commit"
  | "launch";

/** Prefix of every cancellation error createMany returns (never the restart sentinel). */
const TASK_RESERVATION_INTERRUPTED_PREFIX = "Interrupted";
/** taskLaunchError persisted for a reservation canceled before its launch was admitted. */
const TASK_RESERVATION_CANCELED_MESSAGE = "Reservation canceled";

/**
 * Stage tracking for one createMany call: the last entered stage is included in cancellation
 * errors, and a single warning names it if the reservation is still waiting after
 * TASK_CREATE_WAIT_WARNING_MS (cleared on completion; no polling).
 */
class TaskReservationProgress {
  stage: TaskReservationStage = "tree-lock";
  private readonly startedAt = Date.now();
  private warning: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.warning = setTimeout(() => {
      this.warning = undefined;
      log.warn("[task-create] Task reservation still waiting", {
        stage: this.stage,
        elapsedMs: this.elapsedMs(),
      });
    }, TASK_CREATE_WAIT_WARNING_MS);
    this.warning.unref?.();
  }

  enter(stage: TaskReservationStage): void {
    this.stage = stage;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  interruptedError(): string {
    return `${TASK_RESERVATION_INTERRUPTED_PREFIX} (task reservation canceled at stage ${this.stage} after ${this.elapsedMs()} ms)`;
  }

  dispose(): void {
    if (this.warning != null) clearTimeout(this.warning);
    this.warning = undefined;
  }
}

/**
 * Read-only preparation of one createMany plan, computed BEFORE the global mutex (cancellable).
 * `inputs` is the JSON of every config-derived value the preparation consumed; under the mutex
 * the same snapshot is recomputed from a fresh config and must match byte for byte (drift fails
 * closed with a retryable error). `definitionSource`/`frontmatter` pin the agent definition.
 */
interface PreparedTaskReservation {
  args: TaskCreateArgs;
  parentWorkspaceId: string;
  prompt: string;
  agentId: AgentId;
  parentMeta: WorkspaceMetadata;
  configProjectPath: string;
  parentIsScratch: boolean;
  taskDesktopOwnerWorkspaceId: string | undefined;
  normalizedBestOf: TaskCreateArgs["bestOf"];
  runtime: Runtime;
  parentWorkspacePath: string;
  taskRuntimeConfig: RuntimeConfig;
  parentRuntimeConfig: RuntimeConfig;
  sharedWorkspacePath: string | undefined;
  parentBranchName: string | undefined;
  skipInitHook: boolean;
  definitionSource: string | undefined;
  frontmatter: string;
  taskModelString: string;
  canonicalModel: string;
  effectiveThinkingLevel: ThinkingLevel;
  effectiveReasoningMode: OpenAIReasoningMode | undefined;
  taskAiPins: TaskAiPins;
  inputs: string;
  /** pinParentMetaForReservation(parentMeta) at preparation time. */
  parentMetaJson: string;
}

/**
 * The checked request: what prepareTaskReservation knows before its first read. Each step gets
 * these values from the record, so no step re-reads them after an await.
 */
interface ReservationRequest extends Readonly<
  Pick<
    PreparedTaskReservation,
    | "args"
    | "parentWorkspaceId"
    | "prompt"
    | "agentId"
    | "taskDesktopOwnerWorkspaceId"
    | "normalizedBestOf"
  >
> {
  readonly cfg: ProjectsConfig;
  readonly taskSettings: TaskSettings;
}

/** The request plus the parent, read from its metadata and the loaded config. */
interface ReservationParent
  extends
    ReservationRequest,
    Readonly<
      Pick<PreparedTaskReservation, "parentMeta" | "configProjectPath" | "parentIsScratch">
    > {
  readonly parentEntry: ReturnType<typeof findWorkspaceEntry>;
  readonly projectPluginsTrusted: boolean;
}

/** The parent's runtime and checkout (see resolveParentRuntime). */
interface ReservationParentRuntime extends Readonly<
  Pick<
    PreparedTaskReservation,
    "runtime" | "parentWorkspacePath" | "taskRuntimeConfig" | "parentRuntimeConfig"
  >
> {
  readonly taskRuntimeMode: ReturnType<typeof getRuntimeType>;
  readonly parentIsMultiProject: boolean;
}

/** What prepareTaskReservation knows before it reads the agent definition. */
interface ReservationPlacement
  extends
    ReservationParent,
    ReservationParentRuntime,
    Readonly<Pick<PreparedTaskReservation, "sharedWorkspacePath" | "parentBranchName">> {}

/** The placement plus the facts read from the agent definition. */
interface ReservationAgentDefinition
  extends
    ReservationPlacement,
    Readonly<Pick<PreparedTaskReservation, "skipInitHook" | "definitionSource" | "frontmatter">> {}

interface MaterializedTaskLaunch {
  workspacePath: string;
  trunkBranch: string;
  forkedRuntimeConfig: RuntimeConfig;
  runtimeForTaskWorkspace: Runtime;
  inheritedProjects: WorkspaceMetadata["projects"];
  sourceRuntimeConfigUpdate?: RuntimeConfig;
  reusedExistingCheckout: boolean;
}

/**
 * A reserved launch's checkout once materialized: what the materialize step returned, with the
 * launch's init log and its shared-checkout facts. Built once after the fork, never re-read.
 */
interface ReservedLaunchCheckout extends Readonly<MaterializedTaskLaunch> {
  readonly initLogger: InitLogger;
  /** The row was queued as isolation: "none" (read when the launch started). */
  readonly taskWasShared: boolean;
  /** The task reuses its parent's checkout: it was shared and that checkout still existed. */
  readonly sharesParentCheckout: boolean;
}

export type TaskMessageQueueDispatchMode = "tool-end" | "turn-end";

export interface SendAgentTaskMessageResult {
  delivery: "accepted" | "queued" | "reactivated";
  queueDispatchMode?: TaskMessageQueueDispatchMode;
  /**
   * Queued until the target's running delegated workspace turn, owned by another workspace,
   * finishes; it then runs as its own turn (#4997).
   */
  awaitsDelegatedTurn?: true;
  executionTaskId?: string;
}

export interface RetitleAgentTaskResult {
  title: string;
}

export type RetitleAgentTaskError =
  | { code: "not_found" }
  | { code: "invalid_scope" }
  | { code: "update_failed"; message: string };

export type SendAgentTaskMessageError =
  | { code: "not_found" }
  | { code: "invalid_scope" }
  | { code: "not_active"; taskStatus: AgentTaskStatus | "unknown"; message?: string }
  | { code: "send_failed"; message: string };

/** Result of a child->parent family message (RLM family messaging). */
export interface SendParentAgentMessageResult {
  parentWorkspaceId: string;
}

export type SendParentAgentMessageError =
  | { code: "invalid_scope"; message: string }
  | { code: "send_failed"; message: string };

/**
 * Ancestry, not ownership: only descendants receive trusted parent→child guidance.
 * Siblings/cousins, ancestors and unrelated workspaces receive untrusted envelopes.
 * Workspace-turn ownership is a separate graph and grants no message authority.
 */
export type AgentTreeTargetRelation =
  | "target_descendant"
  | "target_ancestor"
  | "peer"
  | "target_main_chat"
  | "target_side_chat"
  | "target_tagged"
  | "target_unrelated";

export type SendAgentTreeMessageError = SendAgentTaskMessageError | AgentPeerMessageAdmissionError;

interface TrustedDescendantMessageOptions {
  messageLabel?: string;
  preTurnMessages?: MuxMessage[];
  /** Internal (F54): set only by scheduleDeferredDescendantMessage's redelivery. */
  redelivery?: DeferredDescendantRedelivery;
}

/** One deferred redelivery attempt of a trusted descendant message (F54). */
interface DeferredDescendantRedelivery {
  /** The Stop fence of the original send: a Stop during the wait still wins. */
  stopFence: ReadonlyMap<string, number>;
  /** Earlier waits for this message; at the bound, the message takes the live path. */
  attempt: number;
  /** Set by the dispatch when the target is still streaming without a task execution. */
  deferAgain: boolean;
  /** The target's archive at the original send (see DeferredDescendantMessage). */
  archivedAtSend: string | null;
}

/** A trusted descendant message whose delivery waits for an idle target (F54). */
interface DeferredDescendantMessage {
  ancestorWorkspaceId: string;
  taskId: string;
  trimmedMessage: string;
  queueDispatchMode: TaskMessageQueueDispatchMode;
  sender: "ancestor" | "sibling";
  options: TrustedDescendantMessageOptions | undefined;
  stopFence: ReadonlyMap<string, number>;
  /**
   * F203: the target's archivedAt at the original send, or null when it was not archived. A send
   * to an archived task unarchives it on purpose. An archive that lands during the wait (also a
   * re-archive after an unarchive) is a later user decision than the message, so, like a Stop, it
   * wins over the redelivery.
   */
  archivedAtSend: string | null;
}

function resolveDescendantMessageStopFence(
  options: TrustedDescendantMessageOptions | undefined,
  captured: ReadonlyMap<string, number>
): ReadonlyMap<string, number> {
  return options?.redelivery?.stopFence ?? captured;
}

function isInactiveAgentTaskStatus(
  status: AgentTaskStatus | undefined,
  legacyArchived: boolean
): boolean {
  return status === "reported" || status === "interrupted" || legacyArchived;
}

/**
 * The target's archive at the original send (F203), or null when the user archived it during the
 * wait: that archive is a later user decision than the message and wins, like a Stop. An archive
 * is identified by its archivedAt, so a re-archive after an unarchive also counts as new.
 */
function resolveDeferralArchivedAtSend(
  redelivery: DeferredDescendantRedelivery | undefined,
  target: { archived: boolean; archivedAt: string | undefined }
): { archivedAtSend: string | null } | null {
  const current = target.archived ? (target.archivedAt ?? null) : null;
  if (redelivery == null) return { archivedAtSend: current };
  return current != null && current !== redelivery.archivedAtSend
    ? null
    : { archivedAtSend: redelivery.archivedAtSend };
}

/** After this many idle waits, a deferred message falls back to plain live delivery. */
const MAX_DEFERRED_DESCENDANT_MESSAGE_WAITS = 5;

export type TreeMessageSpec =
  | {
      relation: "descendant";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
      options?: TrustedDescendantMessageOptions;
    }
  | {
      relation: "peer";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      targetRelation: Exclude<AgentTreeTargetRelation, "target_descendant">;
      queueDispatchMode?: TaskMessageQueueDispatchMode;
      /** Set on the retry of a message that waited for a delegated turn (#4997). */
      awaitedDelegatedTurn?: PeerDelegatedTurnWait;
    }
  | {
      relation: "parent-family";
      senderWorkspaceId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
    }
  | {
      relation: "sibling-family";
      senderWorkspaceId: string;
      targetId: string;
      message: string;
      queueDispatchMode: TaskMessageQueueDispatchMode;
    };

type TreeMessagePipelineResult =
  | SendAgentTaskMessageResult
  | SendParentAgentMessageResult
  | (SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation });

type TreeMessagePipelineError = SendAgentTreeMessageError | SendParentAgentMessageError;

/**
 * What a peer message's first admission established, kept while it waits for the target's
 * delegated turn (#4997). Its retry re-runs the whole peer path against these baselines.
 */
export interface PeerDelegatedTurnWait {
  /** Recipient consent at first admission: an off/on cycle must not revive the message. */
  unrelatedConsent: string | undefined;
  /** Both endpoints' tag generations at first admission: a clear/re-tag cycle is a new link. */
  tagGenerations?: { sender: string | undefined; target: string | undefined };
  /**
   * The target's delegated-turn registration count when the message parked. Any later
   * registration is a replacement turn, which the message never waits through, even one that
   * already settled (#5271). See onWorkspaceTurnRegistered.
   */
  registrationEpoch: number;
  /**
   * Stop generations from first admission; a stop since then refuses the message. The target's
   * entry is refreshed once when the drain starts (see flushParkedPeerSends).
   */
  stopEpochs: Map<string, number>;
}

type PeerTreeMessageSpec = Extract<TreeMessageSpec, { relation: "peer" }>;

type PeerSendResult = Result<
  SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
  SendAgentTreeMessageError
>;

interface PeerSendRefusal {
  code: "refused";
  reason: string;
}

/**
 * A peer send's fixed refusals. The admission probe and the result handling compare them by
 * identity, so each send makes its own set.
 */
interface PeerSendRefusals {
  readonly unrelatedRuntime: PeerSendRefusal;
  readonly senderInactive: PeerSendRefusal;
  readonly delegatedRootStarting: PeerSendRefusal;
  readonly awaitDelegatedTurn: PeerSendRefusal;
  readonly interrupted: PeerSendRefusal;
}

/** One send's refusals: each send makes its own set (see PeerSendRefusals). */
function createPeerSendRefusals(): PeerSendRefusals {
  return {
    unrelatedRuntime: {
      code: "refused",
      reason: "Unrelated messages require local or worktree runtimes on both endpoints.",
    },
    senderInactive: {
      code: "refused",
      reason: "Sender is no longer active; terminal or archived tasks cannot send peer messages.",
    },
    delegatedRootStarting: {
      code: "refused",
      reason: "The target is starting or switching a delegated workspace turn; retry shortly.",
    },
    // Marks a message that waits for the delegated turn. Returned to the sender only when the
    // turn started while the send was already being admitted and its rows may be durable.
    awaitDelegatedTurn: {
      code: "refused",
      reason:
        "The target started a delegated workspace turn that another workspace owns; retry after it finishes.",
    },
    interrupted: {
      code: "refused",
      reason:
        "Target was interrupted by the user and will not accept agent messages until the user resumes it.",
    },
  };
}

/** The entry point named in sendTreeMessage's assertion message. */
function treeMessageAssertionName(spec: TreeMessageSpec): string {
  return spec.relation === "descendant"
    ? "sendMessageToDescendantAgentTask"
    : spec.relation === "peer"
      ? "sendAgentTreeMessage"
      : spec.relation === "parent-family"
        ? "sendMessageToParentFromAgentTask"
        : "sendMessageToSiblingAgentTask";
}

/** A peer send's request, read before the target's admission lock is taken. */
interface PeerSendRequest {
  readonly spec: PeerTreeMessageSpec;
  readonly message: string;
  readonly senderWorkspaceId: string;
  readonly targetId: string;
  readonly relation: PeerTreeMessageSpec["targetRelation"];
  readonly awaitedDelegatedTurn: PeerDelegatedTurnWait | undefined;
}

/** A peer send's facts, read once under the target's admission lock (see sendTreeMessage). */
interface PeerSendRoute extends PeerSendRequest {
  readonly index: AgentTaskIndex;
  readonly targetEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
  readonly senderEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
  readonly unrelatedConsent: string | undefined;
  readonly tagGenerations: { sender: string | undefined; target: string | undefined };
  readonly targetIsAgentTask: boolean;
  readonly refusals: PeerSendRefusals;
}

/** Both endpoints of a peer send with their ancestors, each endpoint first. */
interface PeerSendChains {
  readonly targetChainIds: string[];
  readonly senderChainIds: string[];
}

/** The route plus the stop baselines a peer send latched before its first await. */
interface PeerSendAdmission extends PeerSendRoute, PeerSendChains {
  readonly capturedStopEpochs: Map<string, number>;
  readonly capturedUserStopEpoch: number;
  readonly firstAttempt: boolean;
}

/**
 * The only mutable state of one peer send attempt. The admission probe and the send callbacks
 * run later, from sendMessage and the session, so they read and write these fields when they
 * run: a copy taken earlier would miss a write.
 */
interface PeerSendAttempt {
  /** "unresolved" until the correlation lookup runs; undefined means no correlation. */
  delegatedTurnCorrelation:
    | { taskHandleId: string; ownerWorkspaceId: string }
    | undefined
    | "unresolved";
  admissionRefusal: SendAgentTreeMessageError | null;
  /**
   * Registration count when a delegated turn first refused this attempt. The message waits
   * for that turn only: the session's final admission gate awaits its rollback before
   * onCanceled parks the message, and a turn registering during that await must not count as
   * the awaited one (#5277).
   */
  refusedAtRegistrationEpoch: number | undefined;
  parkedThisAttempt: boolean;
  accepted: boolean;
}

/** A prepared peer message: the untrusted envelope for the payload row and the fixed trigger. */
interface PeerSendEnvelope {
  readonly envelope: string;
  readonly payloadMessageId: string;
  readonly trigger: string;
  readonly muxMetadata: MuxMessageMetadata;
  readonly peerTriggerMeta: AgentPeerMessageMeta;
}

/** The prepared message plus the delegated-turn correlation its trigger carries, if any. */
interface PeerSendTurn extends PeerSendEnvelope {
  readonly triggerMuxMetadata: MuxMessageMetadata;
  readonly workspaceTurnMuxMetadata: Awaited<
    ReturnType<WorkspaceTurnManager["getActiveWorkspaceTurnMuxMetadataForWorkspace"]>
  >;
}

/** The caller-relative relationship tag on task_list scope:"tree" rows. */
export type TreeAgentRelationship = "self" | "ancestor" | "sibling" | "descendant";

export interface TreeAgentTaskInfo extends DescendantAgentTaskInfo {
  relationship: TreeAgentRelationship;
}

export interface TaskTreeAgentsResult {
  /** Root of the caller's task tree (a plain workspace, not an agent task). */
  rootWorkspaceId: string;
  rootTitle?: string;
  /** "self" when the caller is the root; "ancestor" otherwise. */
  rootRelationship: "self" | "ancestor";
  /** True when the root workspace is archived: peer sends refuse it, so discovery hides it. */
  rootArchived?: true;
  /**
   * True when the resolved root ID has no config entry (parent chain ends at a removed or
   * corrupted workspace): peer sends return not_found for it, so discovery hides the row.
   */
  rootMissing?: true;
  /**
   * True when the CALLER cannot send peer messages at all (best-of candidate or workflow-owned
   * chain): non-descendant rows are omitted so discovery never advertises unreachable targets.
   */
  callerPeerMessagingRestricted?: true;
  tasks: TreeAgentTaskInfo[];
  /** Direct chat links and shared-@tag links; neither grants task ancestry or lifecycle authority. */
  relatedChats?: Array<{
    workspaceId: string;
    title?: string;
    relationship: "main_chat" | "side_chat" | "tagged";
  }>;
}

export interface InstanceWorkspacesResult {
  rows: Array<
    Pick<WorkspaceConfigEntry, "title" | "name" | "createdAt"> & {
      workspaceId: string;
      projectPath: string;
      relationship: "self" | "ancestor" | "unrelated";
      busy: boolean;
    }
  >;
  totalMatching: number;
  nextOffset?: number;
  callerPeerMessagingRestricted?: true;
}

/** The paging and query options of one listInstanceWorkspaces call, after defaults. */
interface InstanceDiscoveryPage {
  readonly limit: number;
  readonly offset: number;
  readonly query: string;
}

interface InstanceDiscoveryCaller {
  readonly workspaceId: string;
  readonly root: string;
}

interface InstanceDiscoveryCandidate {
  row: Omit<InstanceWorkspacesResult["rows"][number], "busy">;
  createdAtMs: number;
}

/** Applies the paging defaults and asserts their ranges; normalizes the query. */
function readInstanceDiscoveryPage(options: {
  query?: string | null;
  limit?: number | null;
  offset?: number | null;
}): InstanceDiscoveryPage {
  const limit = options.limit ?? INSTANCE_DISCOVERY_DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  assert(
    Number.isInteger(limit) && limit >= 1 && limit <= INSTANCE_DISCOVERY_MAX_LIMIT,
    "listInstanceWorkspaces: limit out of range"
  );
  assert(
    Number.isSafeInteger(offset) && offset >= 0,
    "listInstanceWorkspaces: offset must be a nonnegative integer"
  );
  return { limit, offset, query: options.query?.trim().toLowerCase() ?? "" };
}

/** Match config metadata attribution: synthetic buckets are not searchable project paths. */
function instanceRowProjectPath(
  workspace: WorkspaceConfigEntry,
  projectConfigPath: string
): string {
  return workspace.kind === "scratch"
    ? workspace.path
    : (workspace.projects?.[0]?.projectPath ?? projectConfigPath);
}

/** An empty query matches every row; the haystack is built only for a set query. */
function instanceRowMatchesQuery(
  query: string,
  id: string,
  workspace: WorkspaceConfigEntry,
  projectPath: string
): boolean {
  return (
    !query ||
    [id, workspace.title, workspace.name, projectPath].some((value) =>
      value?.toLowerCase().includes(query)
    )
  );
}

function toInstanceDiscoveryCandidate(
  id: string,
  workspace: WorkspaceConfigEntry,
  projectPath: string,
  caller: InstanceDiscoveryCaller
): InstanceDiscoveryCandidate {
  assert(!workspace.parentWorkspaceId, "Instance discovery must only expose roots");
  const createdAtMs = Date.parse(workspace.createdAt ?? "");
  return {
    row: {
      workspaceId: id,
      title: workspace.title,
      name: workspace.name,
      projectPath,
      createdAt: workspace.createdAt,
      relationship:
        id === caller.workspaceId ? "self" : id === caller.root ? "ancestor" : "unrelated",
    },
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : -Infinity,
  };
}

export interface TerminateAgentTaskResult {
  /** Task IDs terminated (includes descendants). */
  terminatedTaskIds: string[];
}

export interface DescendantAgentTaskInfo {
  taskId: string;
  status: AgentTaskStatus;
  parentWorkspaceId: string;
  agentType?: string;
  workspaceName?: string;
  title?: string;
  createdAt?: string;
  executionTaskId?: string;
  executionStatus?: WorkspaceTurnTaskStatus;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  bestOf?: WorkspaceMetadata["bestOf"];
  depth: number;
}

const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

/**
 * isolation: "none" cannot be honored for multi-project parents: AIService runs multi-project rows
 * through a MultiProjectRuntime that derives the container and every per-project checkout from the
 * task's OWN name, so a task pointed at the parent's checkouts would run in paths that were never
 * created (#4411). Refuse explicitly instead of silently forking, so the caller sees what happened.
 */
const MULTI_PROJECT_SHARED_ISOLATION_ERROR =
  'isolation: "none" is not supported for multi-project workspaces; omit isolation or pass isolation: "fork" to run the sub-agent in forked checkouts.';

/**
 * Whether startup recovery acts on this row: a `running` or `awaiting_report` task (a legacy row
 * without a taskStatus reads as running) that no other live backend holds a use lease on.
 */
function isActiveStartupTask(
  task: AgentTaskWorkspaceEntry,
  inUseElsewhere: ReadonlySet<string>
): boolean {
  if (!task.id || inUseElsewhere.has(task.id)) return false;
  return ["running", "awaiting_report"].includes(task.taskStatus ?? "running");
}

/**
 * Whether startup recovery re-drives this row. Archived rows are not re-driven. Archiving stops a
 * task's stream but keeps its taskStatus (see isActiveAgentTaskEntry), and every send to an
 * archived workspace is refused, so a re-drive failed on every restart. An unarchive makes the row
 * an ordinary one again, and a task_send_message to it unarchives and reactivates it.
 */
function isStartupRedriveCandidate(
  task: AgentTaskWorkspaceEntry,
  inUseElsewhere: ReadonlySet<string>
): boolean {
  return (
    isActiveStartupTask(task, inUseElsewhere) &&
    !isWorkspaceArchived(task.archivedAt, task.unarchivedAt)
  );
}

/**
 * A legacy task row (no taskStatus) has no durable evidence that it was running: startup recovery
 * sends it the restart nudge only for an interrupted history tail.
 */
function lacksLegacyRestartEvidence(
  task: AgentTaskWorkspaceEntry,
  state: StartupRecoveryState | undefined
): boolean {
  return task.taskStatus == null && state !== "interrupted";
}

/**
 * A legacy task row that startup recovery has no work for: no restart evidence, no pending
 * guidance, and an `idle` probe, which proves no compaction follow-up is pending either.
 */
function isIdleLegacyStartupTask(
  task: AgentTaskWorkspaceEntry,
  state: StartupRecoveryState | undefined,
  pendingGuidanceCount: number
): boolean {
  return state === "idle" && pendingGuidanceCount === 0 && lacksLegacyRestartEvidence(task, state);
}

/**
 * What startup recovery read after its queue drain, for every re-drive step: snapshots, never
 * re-read after a re-drive's awaits.
 */
interface StartupRecoverySnapshot {
  readonly config: ProjectsConfig;
  readonly taskIndex: AgentTaskIndex;
  readonly states: ReadonlyMap<string | undefined, StartupRecoveryState>;
  readonly awaitingReportTasks: readonly AgentTaskWorkspaceEntry[];
  readonly runningTasks: readonly AgentTaskWorkspaceEntry[];
}

/** Whether shutdown aborted startup recovery; logs the stage it stopped before. */
function startupRecoveryCancelled(
  options: { signal?: AbortSignal } | undefined,
  stage: string
): boolean {
  if (options?.signal?.aborted !== true) return false;
  log.info("[startup] TaskService.recoverInterruptedTasks cancelled by shutdown", { stage });
  return true;
}

/**
 * The counters of recoverInterruptedTasks' completion log. One mutable record: each re-drive
 * step adds to the counters for what it did.
 */
interface StartupRecoveryTally {
  resumedAwaitingReportCount: number;
  skippedAwaitingReportDueToActiveDescendants: number;
  skippedAwaitingReportAlreadyBusy: number;
  failedAwaitingReportCount: number;
  resumedRunningCount: number;
  skippedRunningDueToActiveDescendants: number;
  skippedRunningAlreadyStreaming: number;
  failedRunningCount: number;
}

/** A running task's startup re-drive, decided from the recovery snapshot before its rotation. */
interface RunningTaskRedrive {
  readonly taskId: string;
  /** The recovery snapshot row. */
  readonly task: AgentTaskWorkspaceEntry;
  readonly pendingGuidance: NonNullable<AgentTaskWorkspaceEntry["taskPendingGuidance"]>;
  /** A task with a pending question: its guidance only queues. */
  readonly queueOnly: boolean;
  readonly alreadyStreaming: boolean;
}

/** A running task's re-drive after its attempt rotation: each send is fenced to that attempt. */
interface FencedRunningTaskRedrive extends RunningTaskRedrive {
  readonly fenceStartupSend: () => TurnAdmissionToken | undefined;
  readonly sendOptions: ReturnType<typeof buildTaskTurnSendOptions>;
}

/**
 * Counts the compaction follow-up of a running task's re-drive. True when it ends the re-drive:
 * the follow-up failed, or it resumed a task that has no guidance to replay.
 */
function tallyRunningFollowUp(
  followUp: Result<boolean>,
  pendingGuidanceCount: number,
  tally: StartupRecoveryTally
): boolean {
  if (!followUp.success) tally.failedRunningCount += 1;
  else if (followUp.data && pendingGuidanceCount === 0) tally.resumedRunningCount += 1;
  return !followUp.success || (followUp.data && pendingGuidanceCount === 0);
}

function isWorkspaceBusyIdleOnlySend(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "unknown" &&
    typeof (error as { raw?: unknown }).raw === "string" &&
    (error as { raw: string }).raw.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE)
  );
}

const REMOVED_AGENT_TASKS_DIR = "removed-agent-tasks";

/** Maximum consecutive auto-resumes before stopping. Prevents infinite loops when descendants are stuck. */

const MAX_CONSECUTIVE_PARENT_AUTO_RESUMES = 3;

/**
 * Maximum completion-tool recovery prompts for a child task (since it last
 * completed successfully) before the task is interrupted instead of prompted
 * again. Unlike the in-memory
 * parent auto-resume counter above, this budget is persisted on the workspace
 * config entry (taskRecoveryAttempts) so crash/restart recovery loops stay
 * bounded across app restarts. Covers terminal-but-unclassified outcomes such
 * as repeated empty_output errors, repeated length-truncated turns, and models
 * that never call their completion tool.
 */
const MAX_TASK_RECOVERY_ATTEMPTS = 5;

/**
 * Upper bound a child's stream-end arbitration waits for the session's goal accounting of the
 * same stream (see WorkspaceGoalService.waitForStreamAccountingReceipt).
 */
const CHILD_GOAL_ACCOUNTING_WAIT_MS = 10_000;
/**
 * Backoff before the queue drain retries a task it left queued because the task's launch lease
 * was refused (a rename, archive or removal held its mutation gate, here or in another backend,
 * or the lease file could not be written). Nothing signals the release of another backend's
 * gate, so the drain retries; each retry reads fresh state and takes the lease normally.
 */
const QUEUED_LAUNCH_LEASE_RETRY_MS = 1_000;

/** See TaskService.arbitrateChildGoalAtStreamEnd. */
type ChildGoalTurnOutcome = "none" | "handled" | "failed" | "deferred";

/** The ended stream's task origin, captured in the stream-end event's own tick. */
export interface StreamEndTaskOrigin {
  executionId: string | null;
  stopEpoch: number;
  ownedAttempt: OwnedTaskAttempt | undefined;
  unownedAttemptId?: string;
}

/** What handleStreamEnd reads once, after its admission checks, for both of its branches. */
interface StreamEndAdmission {
  readonly workspaceId: string;
  readonly cfg: ReturnType<Config["loadConfigOrDefault"]>;
  readonly entry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
  /** The attempt the stream ran under, captured at the event (see TaskService.admitStreamEnd). */
  readonly streamAttemptId: AttemptFence;
  readonly taskIndex: AgentTaskIndex;
}

/** A parent (root) stream end's inputs, all snapshots taken before the parent branch's awaits. */
interface ParentStreamEndContext {
  readonly event: StreamEndEvent;
  readonly queueCutSnapshot: QueueCutAttributionSnapshot;
  readonly workspaceId: string;
  readonly entry: StreamEndAdmission["entry"];
  readonly taskIndex: AgentTaskIndex;
}

/**
 * Per-call state of a parent stream end's blocker checks. The exemption Sets are fixed once
 * built. Each blocker recheck reassigns the id lists, and later steps read their current values.
 */
interface ParentStreamEndState extends ParentStreamEndContext {
  readonly queueBackgroundedTaskIds: ReadonlySet<string>;
  readonly notifyOnTerminalTaskIds: ReadonlySet<string>;
  activeTaskIds: string[];
  blockingTaskIds: string[];
  activeWorkflowRunIds: string[];
  activeWorkspaceTurnIds: string[];
}

type ParentAutoResumeOptions = Awaited<ReturnType<TaskService["resolveParentAutoResumeOptions"]>>;

/** A child (task) stream end's inputs, all snapshots taken before the child branch's awaits. */
interface ChildStreamEndContext extends StreamEndAdmission {
  readonly event: StreamEndEvent;
  readonly queueCutSnapshot: QueueCutAttributionSnapshot;
  readonly taskOrigin: StreamEndTaskOrigin;
  readonly isCompaction: boolean;
}

/** A child stream end's context plus what it read once its workspace turn was finalized. */
interface ChildStreamEndState extends ChildStreamEndContext {
  readonly status: WorkspaceConfigEntry["taskStatus"];
  /** The stream's final report; always null for a plan-like task. */
  readonly reportArgs: Awaited<ReturnType<TaskService["resolveFinalAgentReportArgs"]>>;
  readonly isPlanLike: boolean;
  readonly proposePlanResult: ReturnType<TaskService["findProposePlanSuccessInParts"]>;
}

/** A child's non-blocking background work, which still holds its final report back. */
interface ChildBackgroundWork {
  /** Captured before the workflow and workspace-turn awaits (see holdChildForBlockingDescendants). */
  readonly activeDescendantTaskIds: readonly string[];
  readonly activeTaskWorkflowRunIds: readonly string[];
  readonly activeWorkspaceTurnIds: readonly string[];
}

/** Active task ids that block the parent: neither queue-backgrounded nor notify_on_terminal. */
function filterParentBlockingTaskIds(
  taskIds: readonly string[],
  queueBackgroundedTaskIds: ReadonlySet<string>,
  notifyOnTerminalTaskIds: ReadonlySet<string>
): string[] {
  return taskIds.filter(
    (id) => !queueBackgroundedTaskIds.has(id) && !notifyOnTerminalTaskIds.has(id)
  );
}

/** Ended streams per task the goal arbitration remembers, so a duplicate delivery is a no-op. */
const CHILD_GOAL_ARBITRATED_STREAMS_MAX = 32;

/** See TaskStopLatch.workspaceStopRecords. */
export interface WorkspaceStopRecord {
  /** Latch releases (one per overlapping cascade) run together once release conditions hold. */
  releases: Array<() => void>;
  /**
   * Cleanups this record still owes: one is planned per cascade at latch time (before any await,
   * so an owner settling during Phase A cannot release ahead of the unscoped clearQueue/stopStream),
   * consumed when Phase B issues it and paid back only when that ORIGINAL promise settles —
   * never by a timeout.
   */
  cleanupInFlight: number;
  /** The attempt the cascade stops: the owned attempt's id, else the task's current persisted id. */
  attemptId: string | undefined;
  /**
   * Turn generations that must settle before release: the one admitted at capture (none when the
   * session was idle) plus every pending admission whose turn became visible afterwards. A
   * superseded generation is replaced by its successor (onWorkspaceTurnSuperseded).
   */
  capturedTurns: Set<symbol>;
  /**
   * Sends admitted against `attemptId` that had not yet claimed a turn at capture (pending or
   * enqueued). Each is discharged by its own token (refused/canceled) or moves into capturedTurns
   * when its turn is admitted; the record cannot release while one is outstanding.
   */
  pendingAdmissions: Set<AdmittedSend>;
  /** Live execution mirror at capture (reawakened child); undefined when none. */
  capturedExecutionId: string | undefined;
  executionSettled: boolean;
  /**
   * The cascade recorded a durable stop marker (terminal task status, or the workspace is gone).
   * A failed persistence keeps the latch (fail closed) until a later cascade or settlement
   * records one — ownership evidence alone would otherwise free a child whose status still
   * reads running to peer messaging right after the failed stop.
   */
  stopPersisted: boolean;
  /** Attempt owned by this process at capture; only its settlement may be minted on release. */
  ownedAttempt: OwnedTaskAttempt | undefined;
  /** Registered stream at capture; a later stop must not touch a replacement (expectedMessageId). */
  capturedStreamMessageId: string | undefined;
  /**
   * The owned attempt's settlement receipt (decideSettlementReceipt), written once the release
   * conditions hold and BEFORE the latch releases run: `writing` while it is awaited (a recheck
   * meanwhile schedules no second write), then `written`, or `failed` (the write failed or the
   * config was unreadable). Unset when no receipt applies (in-memory settlement only).
   */
  receipt?: "writing" | "written" | "failed";
}

/** Result of TaskService.decideSettlementReceipt. */
export type SettlementReceiptDecision =
  | { kind: "memory-only" }
  | { kind: "unreadable" }
  | { kind: "write"; attemptId: string; parentWorkspaceId: string; owners: string[] };

/**
 * Task-pinned send options for an automatic TaskService turn (required-report prompt today;
 * child goal turns later). A whitelist on purpose: per-send payload (attachments, muxMetadata,
 * ACP correlation, system instructions), the required-report require-policy and queue dedupe
 * keys belong to the individual caller, never to every automatic turn.
 */
function buildTaskTurnSendOptions(
  workspace: WorkspaceConfigEntry
): Pick<
  SendMessageOptions,
  "model" | "agentId" | "thinkingLevel" | "reasoningMode" | "serviceTier"
> {
  return {
    model: workspace.taskModelString ?? defaultModel,
    agentId: resolveTaskAgentIdForResume(workspace),
    thinkingLevel: workspace.taskThinkingLevel,
    reasoningMode: coerceOpenAIReasoningMode(workspace.aiSettings?.reasoningMode),
    // A chat send updates the agent bucket, not the task's creation-time root settings.
    serviceTier: ServiceTierSchema.safeParse(
      resolveWorkspaceAISettings(workspace, resolveTaskAgentIdForResume(workspace))?.serviceTier
    ).data,
  };
}

/** promptTaskForRequiredCompletionTool's options. */
interface CompletionPromptOptions {
  reason?: "startup" | "stream_end" | "error";
  error?: Pick<ErrorEvent, "error" | "errorType">;
  /** formatStructuredOutputValidationMessage output for an invalid agent_report. */
  structuredOutputDiagnostic?: string;
  /**
   * A caller that decided this prompt for exactly one attempt (the startup re-drive's rotated
   * id) binds the obligation before calling and hands it over here: the prompt is then
   * fenced to that attempt through this method's awaits (the budget write is a CAS on it and
   * the send carries the token), and a token that produces no send is disposed here. Without
   * a fence the prompt is a same-attempt continuation bound at the handoff.
   */
  fence?: { turnAdmission: TurnAdmissionToken; attemptId: string };
  /**
   * The attempt the caller decided this prompt for (a stream end's or error's attempt): its
   * budget write and a recovery-limit failure are CAS'd on it; a row another writer
   * re-admitted meanwhile gets no write and no prompt. Required (see AttemptFence): `null`
   * for fenced prompts (the fence carries the attempt) and for callers with no proven one.
   */
  expectedAttemptId: AttemptFence;
}

/**
 * What promptTaskForRequiredCompletionTool's finally does with the fence token. One mutable
 * record: the steps write it at their exits, and the finally reads it after the last step.
 */
interface CompletionPromptFenceState {
  disposition: "no-work" | "refused" | "handed-off";
}

/** The awaiting_report row promptTaskForRequiredCompletionTool read at entry, and its call. */
interface CompletionPromptRequest {
  readonly workspaceId: string;
  readonly options: CompletionPromptOptions;
  readonly fence: CompletionPromptOptions["fence"];
  /** The entry-time row: the send options and the logs read it, never a fresh read. */
  readonly entry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
  readonly state: CompletionPromptFenceState;
}

/** A prompt the recovery limit let through, with the completion it asks for. */
interface CompletionPromptPlan extends CompletionPromptRequest {
  readonly completionKind: "propose_plan" | "final_response";
  readonly requiresStructuredOutput: boolean;
}

/** The send of a prompt that passed its budget charge, built in the charge's tick. */
interface CompletionPromptSend {
  readonly taskTurnSendOptions: ReturnType<typeof buildTaskTurnSendOptions>;
  readonly startedAt: number;
  readonly recoveryMessage: string;
  /** The caller's fence token, a token bound to the decided attempt, or none. */
  readonly sendToken: TurnAdmissionToken | undefined;
}

/** A prompt exit with no send: the finally disposes the fence token as no-work or refused. */
function withoutSend(state: CompletionPromptFenceState, result: boolean): boolean {
  state.disposition = result ? "no-work" : "refused";
  return result;
}

/** The row of a child task awaiting its report, or null (no row, no parent, another status). */
function findAwaitingReportTaskEntry(
  cfg: ProjectsConfig,
  workspaceId: string
): CompletionPromptRequest["entry"] | null {
  const entry = findWorkspaceEntry(cfg, workspaceId);
  if (!entry?.workspace.parentWorkspaceId) {
    return null;
  }
  if (entry.workspace.taskStatus !== "awaiting_report") {
    return null;
  }
  return entry;
}

/** The terminal failure message of a task that used up its recovery budget. */
function recoveryLimitErrorMessage(
  completionKind: CompletionPromptPlan["completionKind"],
  error: CompletionPromptOptions["error"]
): string {
  const lastError = error ? ` Last error (${error.errorType ?? "unknown"}): ${error.error}` : "";
  return `Task interrupted after ${MAX_TASK_RECOVERY_ATTEMPTS} recovery attempts without a successful ${completionKind === "propose_plan" ? "propose_plan" : "final assistant response"}.${lastError} The task model may be unable to complete this request; try a different model or a simpler prompt.`;
}

/** Logs a completion prompt's send; true when the send was accepted. */
function logCompletionPromptResult(
  plan: CompletionPromptPlan,
  send: CompletionPromptSend,
  sendResult: Result<void, SendMessageError>
): boolean {
  const { workspaceId, entry, options, completionKind } = plan;
  const { model, agentId } = send.taskTurnSendOptions;
  const durationMs = Date.now() - send.startedAt;
  if (!sendResult.success) {
    log.error("Failed to prompt task for required completion", {
      workspaceId,
      taskName: entry.workspace.name,
      projectPath: entry.projectPath,
      completionKind,
      reason: options?.reason,
      model,
      agentId,
      durationMs,
      sendError: sendResult.error,
      priorErrorType: options?.error?.errorType,
      priorError: options?.error?.error,
    });
    return false;
  }

  log.info("Prompted task for required completion", {
    workspaceId,
    taskName: entry.workspace.name,
    projectPath: entry.projectPath,
    completionKind,
    reason: options?.reason,
    model,
    agentId,
    durationMs,
  });
  return true;
}

/**
 * The terminal failure the row's marker (#4579) records for `attemptId`, or undefined when the
 * marker is absent or names another attempt (a later attempt ignores an earlier failure).
 */
function markedTerminalFailure(
  row: WorkspaceConfigEntry | undefined,
  attemptId: string | undefined
): { errorMessage: string } | undefined {
  const marker = row?.taskTerminalFailure;
  if (attemptId == null || marker?.attemptId !== attemptId) return undefined;
  return {
    errorMessage:
      coerceNonEmptyString(row?.taskLaunchError) ?? `Task failed terminally (${marker.errorType})`,
  };
}

function indeterminateOutcome(reason: string): TaskAttemptOutcome<AgentTaskReport> {
  return { kind: "indeterminate", reason };
}

/** A step of inspectAttemptOutcome that already decided the outcome (the method returns it). */
interface DecidedAttemptOutcome {
  readonly kind: "decided";
  readonly outcome: TaskAttemptOutcome<AgentTaskReport>;
}

/** The row (lenient read) and the session dir that would hold its report. */
interface LocatedAttemptRecord {
  readonly entry: ReturnType<typeof findWorkspaceEntry>;
  readonly reportOwnerWorkspaceId: string | undefined;
}

/**
 * What the artifact reads proved. One record, so every classification step decides from the
 * same observation: `entry` is the row read after the artifact awaits (#4414), never the
 * snapshot taken before them, and `reportPositivelyAbsent` is true only once the report read
 * positively found none.
 */
interface AttemptArtifactProbe {
  readonly entry: ReturnType<typeof findWorkspaceEntry>;
  readonly failure: { errorMessage: string } | undefined;
  readonly reportPositivelyAbsent: boolean;
}

/**
 * The row's terminal-failure marker (#4579) counts only for the attempt it names, so an
 * artifact write that failed still fails the step, and a later attempt's no-report is not.
 */
function failureFieldsOf(
  probe: AttemptArtifactProbe,
  attemptId: string | undefined
): { failure?: { errorMessage: string } } {
  const marked = probe.failure ?? markedTerminalFailure(probe.entry?.workspace, attemptId);
  return marked != null ? { failure: marked } : {};
}

/** The probed row's status: a row without one predates the field and reads as running. */
function probedTaskStatus(probe: AttemptArtifactProbe): AgentTaskStatus | undefined {
  return probe.entry?.workspace.taskStatus ?? (probe.entry != null ? "running" : undefined);
}

/**
 * The attempt a settlement/finalization write acts for (see rowSupersedes). A REQUIRED parameter
 * on every helper reachable from stream end, stream error, report publication and interrupted
 * settlement, so the compiler makes each caller state it: the captured attempt id (the writes are
 * a CAS on it), or `null` when the caller has no proven attempt (a legacy/pre-identity row, a
 * parent- or timer-driven decision), which keeps today's unconditional writes.
 */
export type AttemptFence = string | null;

/**
 * Who a stream event belongs to, read in the event's own tick (resolveStreamAttemptAtEvent):
 * this process's owned attempt, else the attempt the stream's turn was admitted under (or the
 * persisted id). Both undefined = captured without an identity (a pre-identity row).
 */
export interface StreamAttemptOrigin {
  ownedAttempt: OwnedTaskAttempt | undefined;
  unownedAttemptId: string | undefined;
}

function toAgentTaskReport(source: AgentTaskReport): AgentTaskReport {
  return {
    reportMarkdown: source.reportMarkdown,
    title: source.title,
    planFilePath: source.planFilePath,
    structuredOutput: source.structuredOutput,
    model: source.model,
    thinkingLevel: source.thinkingLevel,
  };
}

function truncateSingleLine(text: string, maxChars: number): string {
  const singleLine = text.split(/[\r\n\u2028\u2029]/u, 1)[0].trim();
  return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, maxChars - 1)}…`;
}

/**
 * Reason persisted when other queued input (a manual user message, /compact)
 * cut a delegated turn at a tool boundary and superseded it. The target
 * workspace continues under the new input, so the owner sees an interruption
 * with this explanation rather than a task failure.
 */

/**
 * Reason prefix persisted when the owner's OWN follow-up turn (task
 * kind="workspace", mode="existing", tool-end dispatch) cut its active
 * delegated turn at a tool boundary. The full reason names the successor
 * handle. Wording stays neutral third-person: the persisted error can surface
 * to a direct parent that did NOT initiate the successor (parent ≠ owner
 * envelope case) and to any awaiting workspace — second-person phrasing
 * belongs only in the initiating task tool's creation note. This flavor
 * settles quietly for the owner (no terminal-attention wake, no direct-parent
 * envelope when the parent IS the owner): an agent should not be woken merely
 * to learn the expected consequence of a follow-up it just initiated.
 */

/**
 * The error string is the durable flavor marker (no schema field): prefix
 * matching keeps old records parseable on downgrade while letting suppression
 * decisions derive purely from the persisted record.
 */

/**
 * Terminal settlements whose owner terminal-attention wake is suppressed. A
 * pure function of the settled record so live settlement, startup recovery,
 * and resettle agree — restarts must not resurrect a suppressed wake.
 * Deliberately NOT recorded via terminalAttentionNotifiedAt (which means "a
 * notification was delivered"): deriving from the record keeps the audit trail
 * clean and stays downgrade-safe with no schema change.
 */

/**
 * Provider-terminal stream errors that settle a child task even while it is
 * still `running` (before it owes its completion tool). Subset of
 * NON_RETRYABLE_STREAM_ERRORS: user intent (aborted) must never terminally
 * settle a running task, and errors with in-session recovery
 * (context_exceeded) settle only after that recovery declines (see
 * handleTaskStreamError).
 */
const RUNNING_TASK_TERMINAL_STREAM_ERRORS: ReadonlySet<StreamErrorType> = new Set([
  "model_refusal",
  "authentication",
  "quota",
  "model_not_found",
  "runtime_not_ready",
  // The child's in-stream repair failed or was unsafe; no automatic recovery remains.
  "reasoning_rejected",
]);

type WorkflowTaskConfig = NonNullable<WorkspaceConfigEntry["workflowTask"]>;

interface WorkflowTaskOwner {
  taskId: string;
  workspace: AgentTaskWorkspaceEntry;
  workflowTask: WorkflowTaskConfig;
}

interface InactiveWorkflowTaskOwner {
  ownerTaskId: string;
  runId: string;
  status?: WorkflowRunStatus;
  reason: string;
}

type InterruptedTaskStatusMutation = "interrupted" | "preserved-completed-report";

interface ParentAutoResumeHint {
  agentId?: string;
}

/** Launch identity recorded with a workflow run reference; see AgentWorkflowRunReference. */
interface WorkflowWakeInitiatingAgent {
  agentId: string;
  createdAtMs: number;
  strictAgentResolution?: AgentWorkflowRunStrictPin | null;
}

// Coalescing key for terminal workflow wakes: the pin is part of the launch identity, so an
// agentId alone must not merge a pinned launch with an unpinned (or differently pinned) one.
// undefined (legacy walk fallback), null (verified unpinned), and each concrete pin are
// distinct groups; over-splitting structurally equal pins is safe, merging them is not.
function workflowWakeGroupKey(agent: WorkflowWakeInitiatingAgent): string {
  const pin = agent.strictAgentResolution;
  return `${agent.agentId}\u0000${pin === undefined ? "walk" : JSON.stringify(pin)}`;
}

// Reserved workflowWakeGroupSendBackoffUntilMs key for the non-workflow (sub-agent and
// workspace-turn) send batch. Group keys start with a non-empty agentId and the empty string
// keys the unpinned group, so a leading \u0000 cannot collide.
const NON_WORKFLOW_WAKE_BACKOFF_KEY = "\u0000non-workflow";

/** A queued workflow run's terminal wake prompt, built for one terminal-attention drain. */
interface TerminalWorkflowWakeCandidate {
  runId: string;
  run: WorkflowRunRecord;
  prompt: string;
  initiatingAgent?: WorkflowWakeInitiatingAgent;
}

/** A workspace-turn notification that can wake its owner, and the handle id the wake names. */
interface TerminalWorkspaceTurnWakeCandidate {
  notification: TerminalAttentionNotification;
  publicAwaitId: string;
}

/** A terminal-attention drain's pending notifications and queued workflow runs, read at its start. */
interface TerminalDrainSnapshot {
  readonly ownerWorkspaceId: string;
  readonly freshSubagentAttentionTurns: ReadonlyMap<string, symbol>;
  /** Without legacy workflow records; acknowledgeTerminalDrainReports drops acknowledged reports. */
  readonly pending: readonly TerminalAttentionNotification[];
  readonly queuedWorkflowRunIds: readonly string[];
}

/** A drain's snapshot plus the owner's config entry, which exists and is not archived. */
interface TerminalDrainOwner extends TerminalDrainSnapshot {
  readonly cfg: ReturnType<Config["loadConfigOrDefault"]>;
  readonly entry: NonNullable<ReturnType<typeof findWorkspaceEntry>>;
}

/** A drain's owner after its agent reports were acknowledged and their messages ensured. */
interface TerminalDrainAgentAttention extends TerminalDrainOwner {
  readonly taskIndex: AgentTaskIndex;
  readonly agentNotifications: readonly TerminalAttentionNotification[];
  readonly deliverableAgentNotificationIds: ReadonlySet<string>;
  readonly latestMessageTimestampByTaskId: ReadonlyMap<string, number>;
}

/** A terminal-attention drain's candidates, collected after the owner was seen idle. */
interface TerminalDrainCandidates extends TerminalDrainAgentAttention {
  readonly workspaceTurnCandidates: readonly TerminalWorkspaceTurnWakeCandidate[];
  readonly deliverableWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[];
  /** A recent send of the non-workflow batch was rejected: the batch sits out this drain. */
  readonly nonWorkflowSendBackedOff: boolean;
  readonly hasNonWorkflowDeliverables: boolean;
  readonly workspaceTurnMuxMetadata: Awaited<
    ReturnType<WorkspaceTurnManager["getActiveWorkspaceTurnMuxMetadataForWorkspace"]>
  >;
}

/** A drain's candidates plus the wake's caller restrictions and the reread candidate records. */
interface TerminalWakeRevalidation extends TerminalDrainCandidates {
  readonly wakeRestrictions: Awaited<
    ReturnType<TaskService["resolveTerminalWakeCallerSendRestrictions"]>
  >;
  /** The workspace-turn candidates' records, reread in one batch, by candidate index. */
  readonly candidateRecords: ReadonlyArray<WorkspaceTurnTaskHandleRecord | null>;
}

/**
 * A terminal-attention drain's composed wake, read by the delivery steps (deliverTerminalWake).
 * Every field is final once the drain has partitioned its candidates and composed the prompt.
 */
interface TerminalWakeDelivery extends TerminalWakeRevalidation {
  /** The selected launch-identity group; empty when no workflow group revalidated. */
  readonly currentWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[];
  readonly workflowInitiatingAgent: WorkflowWakeInitiatingAgent | undefined;
  readonly supersededWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[];
  readonly suppressedNotificationIds: readonly string[];
  /** The sub-agent and workspace-turn notifications this wake delivers. */
  readonly effectivePending: readonly TerminalAttentionNotification[];
  readonly prompt: string;
  readonly resumeOptions: ParentAutoResumeOptions;
  readonly effectiveStrictPin: SendMessageOptions["strictAgentResolution"];
}

type TerminalWakeSendResult = Awaited<ReturnType<WorkspaceHost["sendMessage"]>>;

/**
 * Picks the newest launch-identity group among the remaining workflow wakes. The wakes without an
 * initiating agent form one group, picked once no agent-bound wake remains.
 */
function pickNewestWorkflowWakeGroup(
  remainingWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[]
): {
  groupAgent: WorkflowWakeInitiatingAgent | undefined;
  groupKey: string | undefined;
  groupCandidates: TerminalWorkflowWakeCandidate[];
} {
  let groupAgent: WorkflowWakeInitiatingAgent | undefined;
  for (const candidate of remainingWorkflowPrompts) {
    const agent = candidate.initiatingAgent;
    if (agent != null && (groupAgent == null || agent.createdAtMs > groupAgent.createdAtMs)) {
      groupAgent = agent;
    }
  }
  const groupKey = groupAgent != null ? workflowWakeGroupKey(groupAgent) : undefined;
  const groupCandidates = remainingWorkflowPrompts.filter((candidate) =>
    groupKey == null
      ? candidate.initiatingAgent == null
      : candidate.initiatingAgent != null &&
        workflowWakeGroupKey(candidate.initiatingAgent) === groupKey
  );
  return { groupAgent, groupKey, groupCandidates };
}

/** Splits a workflow group by its revalidation verdicts; a "defer" wake lands in neither list. */
function classifyWorkflowGroupRevalidation(
  groupCandidates: readonly TerminalWorkflowWakeCandidate[],
  groupRevalidation: ReadonlyArray<"deliverable" | "superseded" | "defer">
): {
  groupCurrent: TerminalWorkflowWakeCandidate[];
  groupSuperseded: TerminalWorkflowWakeCandidate[];
} {
  const groupCurrent: TerminalWorkflowWakeCandidate[] = [];
  const groupSuperseded: TerminalWorkflowWakeCandidate[] = [];
  groupCandidates.forEach((candidate, index) => {
    const verdict = groupRevalidation[index];
    if (verdict === "deliverable") {
      groupCurrent.push(candidate);
    } else if (verdict === "superseded") {
      groupSuperseded.push(candidate);
    }
  });
  return { groupCurrent, groupSuperseded };
}

/**
 * Partitions the reread workspace-turn candidates: a suppressed handle is marked superseded later,
 * a backed-off non-workflow batch sits out the drain, and every other candidate is delivered.
 */
function partitionWorkspaceTurnWakeCandidates(revalidation: TerminalWakeRevalidation): {
  deliverableWorkspaceTurnNotificationIds: Set<string>;
  publicAwaitIds: string[];
  suppressedNotificationIds: string[];
} {
  const deliverableWorkspaceTurnNotificationIds = new Set<string>();
  const publicAwaitIds: string[] = [];
  const suppressedNotificationIds: string[] = [];
  revalidation.workspaceTurnCandidates.forEach((candidate, index) => {
    const record = revalidation.candidateRecords[index];
    if (record != null && workspaceTurnTerminalAttentionSuppressed(record)) {
      suppressedNotificationIds.push(candidate.notification.id);
      return;
    }
    if (revalidation.nonWorkflowSendBackedOff) {
      // Backed off: sits out this drain and stays pending for the sweep-cadence retry.
      return;
    }
    deliverableWorkspaceTurnNotificationIds.add(candidate.notification.id);
    publicAwaitIds.push(candidate.publicAwaitId);
  });
  return { deliverableWorkspaceTurnNotificationIds, publicAwaitIds, suppressedNotificationIds };
}

function isTypedWorkspaceEvent(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === type &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return isTypedWorkspaceEvent(value, "stream-end");
}

function isStreamAbortEvent(value: unknown): value is StreamAbortEvent {
  return isTypedWorkspaceEvent(value, "stream-abort");
}

function isErrorEvent(value: unknown): value is ErrorEvent {
  return isTypedWorkspaceEvent(value, "error");
}

function hasAncestorWorkspaceId(
  entry: { ancestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.ancestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function hasWorkflowOwnedAncestorWorkspaceId(
  entry: { workflowOwnedAncestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.workflowOwnedAncestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === true
  );
}

function formatBackgroundAwaitTargetList(label: string, ids: string[]): string | null {
  if (ids.length === 0) {
    return null;
  }
  return `${label} (${ids.join(", ")})`;
}

function buildBackgroundAwaitPrompt(params: {
  taskIds: string[];
  workflowRunIds: string[];
}): string {
  assert(
    params.taskIds.length > 0 || params.workflowRunIds.length > 0,
    "buildBackgroundAwaitPrompt requires at least one awaitable target"
  );

  const targetLabels = [
    formatBackgroundAwaitTargetList("task handle(s)", params.taskIds),
    formatBackgroundAwaitTargetList("workflow run(s)", params.workflowRunIds),
  ].filter((label): label is string => label != null);
  const taskIds = [...params.taskIds, ...params.workflowRunIds];

  return (
    `${BACKGROUND_WORK_WAKE_OPENINGS.awaitableWorkActive}${targetLabels.join(" and ")}. ` +
    "You MUST NOT end your turn while any listed task handles are queued/starting/running/awaiting_report or workflow runs are pending/running/backgrounded. " +
    `Call task_await now with task_ids: ${JSON.stringify(taskIds)} to wait for them. ` +
    "If any are still queued/starting/running/awaiting_report/backgrounded after that, call task_await again. " +
    "Only once all listed work is terminal should you write your final response, integrating any reports or workflow results."
  );
}

function withToolPolicy(toolPolicy: ToolPolicy | undefined): { toolPolicy?: ToolPolicy } {
  return toolPolicy != null ? { toolPolicy } : {};
}

function sanitizeAgentTypeForName(agentType: string): string {
  const normalized = agentType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[_-]+|[_-]+$/g, "");

  return normalized.length > 0 ? normalized : "agent";
}

function buildAgentWorkspaceName(agentType: string, workspaceId: string): string {
  const safeType = sanitizeAgentTypeForName(agentType);
  const base = `agent_${safeType}_${workspaceId}`;
  // Hard cap to validation limit (64). Ensure stable suffix is preserved.
  if (base.length <= 64) return base;

  const suffix = `_${workspaceId}`;
  const maxPrefixLen = 64 - suffix.length;
  const prefix = `agent_${safeType}`.slice(0, Math.max(0, maxPrefixLen));
  const name = `${prefix}${suffix}`;
  return name.length <= 64 ? name : `agent_${workspaceId}`.slice(0, 64);
}

async function runtimePathExists(runtime: Runtime, path: string): Promise<boolean> {
  assert(path.length > 0, "runtimePathExists: path must be non-empty");
  try {
    await runtime.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A launched task's base commits in its materialized checkout: each project's HEAD, keyed by
 * project path, and the parent project's. The reserved launch and a direct Task.create launch
 * both persist them on the task's row.
 */
async function readTaskBaseCommits(
  plan: TaskLaunchSource,
  checkout: Pick<
    MaterializedTaskLaunch,
    "workspacePath" | "forkedRuntimeConfig" | "inheritedProjects" | "runtimeForTaskWorkspace"
  >
): Promise<{
  taskBaseCommitSha: string | undefined;
  taskBaseCommitShaByProjectPath: Record<string, string>;
}> {
  const projectRepos = getWorkspaceProjectRepos({
    // Outside the agent loop: the host's runtimes.
    runtimeFactory: nodeRuntimeFactory,
    workspaceId: plan.taskId,
    workspaceName: plan.workspaceName,
    workspacePath: checkout.workspacePath,
    runtimeConfig: checkout.forkedRuntimeConfig,
    projectPath: plan.parentMeta.projectPath,
    projectName: plan.parentMeta.projectName,
    projects: checkout.inheritedProjects,
  });

  const taskBaseCommitShaByProjectPath: Record<string, string> = {};
  for (const projectRepo of projectRepos) {
    const taskBaseCommitSha = await tryReadGitHeadCommitSha(
      checkout.runtimeForTaskWorkspace,
      projectRepo.repoCwd
    );
    if (taskBaseCommitSha) {
      taskBaseCommitShaByProjectPath[projectRepo.projectPath] = taskBaseCommitSha;
    }
  }

  return {
    taskBaseCommitSha: taskBaseCommitShaByProjectPath[plan.parentMeta.projectPath] ?? undefined,
    taskBaseCommitShaByProjectPath,
  };
}

function buildWorkflowTimeoutFinalizationPrompt(
  finalInstructions: string | undefined,
  completionKind: "final_response" | "propose_plan",
  requiresStructuredOutput: boolean
): string {
  const reportNoun = completionKind === "propose_plan" ? "plan" : "response";
  const base =
    `Your workflow step time budget has expired. Stop starting new work and prepare a final ${reportNoun} now.\n\n` +
    `In your ${reportNoun}:\n` +
    "- summarize work completed;\n" +
    "- list files changed or inspected;\n" +
    "- include validation/test results already obtained;\n" +
    "- call out uncertainty and remaining work;\n" +
    `- do not run additional long-running tools unless absolutely necessary to write the ${reportNoun}.\n\n` +
    getTaskCompletionInstruction({ completionKind, requiresStructuredOutput });
  if (finalInstructions == null) {
    return base;
  }
  return `${base}\n\nAdditional workflow-specific finalization instructions:\n${finalInstructions}`;
}

/**
 * Fail host-local worktree reactivation before reporting success; otherwise a missing checkout
 * surfaces only after the asynchronous turn starts. Remote readiness can start or provision
 * runtimes.
 */
async function getMissingHostLocalCheckoutError(entry: {
  projectPath: string;
  workspace: WorkspaceConfigEntry;
}): Promise<string | null> {
  const { workspace } = entry;
  // Legacy entries may omit `name`; config metadata loading then falls back to the path basename,
  // so probe the same name instead of skipping the guard (single-project probes use the persisted
  // path either way).
  const name =
    coerceNonEmptyString(workspace.name) ??
    coerceNonEmptyString(path.basename(coerceNonEmptyString(workspace.path) ?? ""));
  const runtimeConfig = workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
  if (name == null || !isWorktreeRuntime(runtimeConfig)) {
    return null;
  }
  const projects = workspace.projects ?? [];
  if (projects.length > 1) {
    // Multi-project (#4824): MultiProjectRuntime.ensureReady checks each constituent runtime in
    // order, and the execution paths build worktree constituents without a persisted path hint.
    // Probing the same constituents here reports the checkout the runtime gate would.
    for (const project of projects) {
      const readiness = await createRuntimeForWorkspace({
        runtimeConfig,
        projectPath: project.projectPath,
        name,
      }).ensureReady();
      if (!readiness.ready) return readiness.error;
    }
    return null;
  }
  const runtime = createRuntimeForWorkspace({
    runtimeConfig,
    projectPath: entry.projectPath,
    name,
    namedWorkspacePath: coerceNonEmptyString(workspace.path),
  });
  const readiness = await runtime.ensureReady();
  return readiness.ready ? null : readiness.error;
}

/**
 * Whether a persisted report artifact can be a row's own report while the row has not reported
 * (#7003). Publication writes `reported` before any artifact, so an artifact beside such a row is
 * another attempt's (a resumed child keeps its earlier report on disk) unless it names the row's
 * attempt (another backend's report, mid-publication). Equal also when both are unbound: a row
 * that never had an attempt id was never rotated past the artifact (a pre-identity task's stale
 * `running` still self-heals). An unbound (legacy) artifact still self-heals an interrupted row.
 */
function reportArtifactBelongsToUnreportedRow(
  artifact: Pick<SubagentReportArtifact, "taskAttemptId">,
  row: Pick<WorkspaceConfigEntry, "taskAttemptId" | "taskStatus">
): boolean {
  if (artifact.taskAttemptId === row.taskAttemptId) return true;
  return artifact.taskAttemptId == null && row.taskStatus === "interrupted";
}

/** What a parent's one pending best-of `task` call asks for, read from the parent's partial. */
interface PendingBestOfRequest {
  readonly total: number;
  readonly agentId: string | undefined;
  readonly title: string | undefined;
  readonly partialStartedAt: number | undefined;
  readonly legacyVariants: boolean;
}

/** A child group that can answer the pending request, with the start times of its rows. */
interface BestOfGroupCandidate {
  groupId: string;
  total: number;
  createdAtMs: number[];
}

type LegacyBestOfRow = ReturnType<Config["listLegacyTaskVariantWorkspaces"]>[number];

function findSinglePendingTaskToolPart(parts: MuxMessage["parts"]) {
  const pendingParts = parts.filter(
    (part): part is DynamicToolPart & { toolName: "task"; state: "input-available" } =>
      isDynamicToolPart(part) && part.toolName === "task" && part.state === "input-available"
  );
  return pendingParts.length === 1 ? pendingParts[0] : undefined;
}

/** The request of the partial's one pending `task` call, or null unless it asks for a group. */
function readPendingBestOfRequest(partial: MuxMessage): PendingBestOfRequest | null {
  const pendingPart = findSinglePendingTaskToolPart(partial.parts);
  if (!pendingPart) {
    return null;
  }

  const parsedInput = parseTaskToolInputForRecovery(pendingPart.input);
  if (!parsedInput) {
    return null;
  }

  const requestedTotal = parsedInput.groupCount;
  if (requestedTotal <= 1) {
    return null;
  }

  return {
    total: requestedTotal,
    agentId: coerceNonEmptyString(
      parsedInput.data.agentId ?? parsedInput.data.subagent_type
    )?.toLowerCase(),
    title: coerceNonEmptyString(parsedInput.data.title),
    partialStartedAt:
      typeof partial.metadata?.timestamp === "number" ? partial.metadata.timestamp : undefined,
    legacyVariants: parsedInput.legacyVariants,
  };
}

/** A row conflicts only when both the request and the row set the value (truthy) and they differ. */
function conflictsWithRequested(
  requested: string | undefined,
  actual: string | undefined
): boolean {
  return Boolean(requested && actual && actual !== requested);
}

function matchConfigBestOfRow(
  workspace: WorkspaceConfigEntry,
  parentWorkspaceId: string,
  request: PendingBestOfRequest
): { groupId: string; total: number } | undefined {
  if (workspace.parentWorkspaceId !== parentWorkspaceId) {
    return undefined;
  }

  const groupId = coerceNonEmptyString(workspace.bestOf?.groupId);
  const total = workspace.bestOf?.total;
  if (!groupId || total !== request.total) {
    return undefined;
  }

  const workspaceAgentId = resolvePersistedAgentId(workspace, "");
  if (conflictsWithRequested(request.agentId, workspaceAgentId)) {
    return undefined;
  }

  const workspaceTitle = coerceNonEmptyString(workspace.title);
  if (conflictsWithRequested(request.title, workspaceTitle)) {
    return undefined;
  }

  return { groupId, total };
}

function collectConfigBestOfGroups(
  cfg: ProjectsConfig,
  parentWorkspaceId: string,
  request: PendingBestOfRequest
): Map<string, BestOfGroupCandidate> {
  const groups = new Map<string, BestOfGroupCandidate>();
  for (const project of cfg.projects.values()) {
    for (const workspace of project.workspaces) {
      const match = matchConfigBestOfRow(workspace, parentWorkspaceId, request);
      if (!match) {
        continue;
      }

      const entry = groups.get(match.groupId) ?? { ...match, createdAtMs: [] };
      const createdAtMs =
        typeof workspace.createdAt === "string" ? Date.parse(workspace.createdAt) : Number.NaN;
      if (Number.isFinite(createdAtMs)) {
        entry.createdAtMs.push(createdAtMs);
      }
      groups.set(match.groupId, entry);
    }
  }
  return groups;
}

function matchLegacyBestOfRow(
  workspace: LegacyBestOfRow,
  request: PendingBestOfRequest
): { groupId: string; total: number } | undefined {
  const { groupId, total } = workspace.bestOf;
  if (total !== request.total) {
    return undefined;
  }

  const workspaceAgentId = normalizeAgentId(workspace.agentId ?? workspace.agentType, "");
  if (conflictsWithRequested(request.agentId, workspaceAgentId)) {
    return undefined;
  }
  // Inline, not conflictsWithRequested: the row title is read only when a title was requested.
  if (request.title && workspace.title && workspace.title !== request.title) {
    return undefined;
  }

  return { groupId, total };
}

function collectLegacyBestOfGroups(
  workspaces: LegacyBestOfRow[],
  request: PendingBestOfRequest,
  groups: Map<string, BestOfGroupCandidate>
): void {
  for (const workspace of workspaces) {
    const match = matchLegacyBestOfRow(workspace, request);
    if (!match) {
      continue;
    }

    const entry = groups.get(match.groupId) ?? { ...match, createdAtMs: [] };
    const createdAtMs = workspace.createdAt ? Date.parse(workspace.createdAt) : Number.NaN;
    if (Number.isFinite(createdAtMs)) {
      entry.createdAtMs.push(createdAtMs);
    }
    groups.set(match.groupId, entry);
  }
}

/**
 * The group the pending call waits on, or null when none or several qualify. Without a partial
 * start time only a lone group qualifies.
 */
function selectPendingBestOfGroup(
  groups: Map<string, BestOfGroupCandidate>,
  partialStartedAt: number | undefined
): BestOfGroupCandidate | null {
  const matchingGroups = Array.from(groups.values());
  const startedAfterPartial = (group: { createdAtMs: number[] }): boolean => {
    if (partialStartedAt == null) {
      return true;
    }

    return (
      group.createdAtMs.length > 0 &&
      group.createdAtMs.every((createdAtMs) => createdAtMs >= partialStartedAt)
    );
  };
  if (matchingGroups.length === 0) {
    return null;
  }
  if (matchingGroups.length === 1) {
    return startedAfterPartial(matchingGroups[0]) ? matchingGroups[0] : null;
  }
  if (partialStartedAt == null) {
    return null;
  }

  const recentMatchingGroups = matchingGroups.filter((group) => startedAfterPartial(group));
  return recentMatchingGroups.length === 1 ? recentMatchingGroups[0] : null;
}

export class TaskService implements AgentTaskIntegration {
  // Serialize stream-end processing per workspace to avoid races when
  // finalizing reported tasks and cleanup state transitions. Lock order: acquired BEFORE the
  // task-tree lifecycle lock. Stream-end finalization and cleanup rechecks hold this lock while
  // remove() takes the tree lock, so any path needing both nests event -> task-tree.
  private readonly workspaceEventLocks = new MutexMap<string>();
  // Separate parent-scoped lock for deferred best-of fallback/finalization. This path can run
  // concurrently from multiple child stream-end handlers for the same parent, and it must remain
  // safe even when the parent stream-end already holds workspaceEventLocks for the parent itself.
  private readonly deferredBestOfLocks = new MutexMap<string>();
  // Serialize lifecycle transitions across a whole parent/descendant tree so reawakening and
  // removal cannot cross and delete a child while its next execution starts.
  private readonly workspaceTreeLifecycleLocks = new MutexMap<string>();
  private readonly mutex = new AsyncMutex();
  private maybeStartQueuedTasksInFlight: Promise<void> | undefined;
  private maybeStartQueuedTasksRerunRequested = false;
  // A queue drain with no queued task skips the global workspace-turn count: it reads every turn
  // file of every session, hundreds of ms on real installs, and runs on every task settle. That
  // count also settles stale active turn records (settleStaleWorkspaceTurn), which wakes their
  // owners; at startup it is the only automatic settle for a stale turn that targets a non-task
  // workspace. So startup recovery requests one forced sweep from the next drain. Generations,
  // not a flag: a drain that captured an older request cannot clear one armed during its count.
  private staleTurnSweepRequestedGeneration = 0;
  private staleTurnSweepDoneGeneration = 0;
  // Git worktree creation touches per-repository metadata; serialize that narrow phase per project
  // while allowing post-fork init/send startup work for sibling tasks to overlap.
  private readonly reservedTaskLaunchByProjectPath = new Map<string, Promise<void>>();
  // Terminal attention scheduling and bookkeeping: notify_on_terminal persists, drain chains, idle
  // waits, fresh sub-agent edges and wake-group send backoff. The drain itself stays here.
  private readonly terminalAttention: TerminalAttentionNotifier;
  /** Tail of each task's chain of deferred trusted messages (F54), in send order. */
  private readonly deferredDescendantMessagesByTask = new Map<string, Promise<void>>();
  // Owed workflow terminal wakes and the per-run settlement chain (see WorkflowRunAttention).
  private readonly workflowRunAttention: WorkflowRunAttention;
  private workflowAttentionSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The pending drain retry after a refused launch lease (QUEUED_LAUNCH_LEASE_RETRY_MS). */
  private queuedLaunchLeaseRetryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Report/start waiters, foreground-await state and the completed-report cache. */
  private readonly waiters: TaskWaiters;

  private readonly terminalAttentionStore: TerminalAttentionStore;

  // Task workspace removals that outlived their termination timeout. Retries must
  // await the ORIGINAL removal outcome: the host's remove() short-circuits Ok
  // for IDs already being removed, so re-calling it would count a still-in-flight
  // (possibly failing) removal as success and let ancestor deletion orphan the child.
  private readonly pendingTaskWorkspaceRemovals = new Map<string, Promise<Result<void>>>();
  private readonly gitPatchArtifactService: GitPatchArtifactService;
  private timelineRecorder: TimelineRecorder = NOOP_TIMELINE_RECORDER;
  private readonly handoffInProgress = new Set<string>();
  /**
   * Hard-interrupted parent workspaces must not auto-resume until the next user message.
   * This closes races where descendants could report between parent interrupt and cascade cleanup.
   */
  private interruptedParentWorkspaceIds = new Set<string>();
  /**
   * User Stops per workspace (markParentWorkspaceInterrupted). The stop epoch also counts
   * owner interrupts of a delegated turn, which a message waiting for that turn survives (see
   * flushParkedPeerSends), so parking needs this separate count to tell a user Stop apart.
   */
  private readonly workspaceUserStopEpochs = new Map<string, number>();
  private readonly peerSendParking: PeerSendParking;
  private readonly taskStopLatch: TaskStopLatch;
  private readonly attemptLedger: AttemptLedger;
  private readonly streamEndLedger: StreamEndLedger;
  /** Tracks consecutive auto-resumes per workspace. Reset when a user message is sent. */
  private consecutiveAutoResumes = new Map<string, number>();

  private async findLatestWorkflowSupersession(workspaceId: string): Promise<{
    found: boolean;
    timestamp?: number;
  }> {
    assert(workspaceId.length > 0, "findLatestWorkflowSupersession requires workspaceId");
    let latest: { found: boolean; timestamp?: number } = { found: false };
    const historyResult = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (!isWorkflowSupersessionMessage(message)) {
            continue;
          }
          const timestamp = message.metadata?.timestamp;
          latest = {
            found: true,
            ...(typeof timestamp === "number" ? { timestamp } : {}),
          };
          return false;
        }
        return undefined;
      }
    );

    if (!historyResult.success) {
      log.warn("Failed to read full history for workflow supersession", {
        workspaceId,
        error: historyResult.error,
      });
    }
    return latest;
  }

  async listAgentReferencedWorkflowRunIds(
    workspaceId: string,
    currentParts: readonly unknown[],
    currentMessageId?: string
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listAgentReferencedWorkflowRunIds requires workspaceId");

    const latestSupersession = await this.findLatestWorkflowSupersession(workspaceId);
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    let historyMessages: MuxMessage[] = [];
    let historyScanStartIndex = 0;
    let trustCurrentParts = true;
    if (historyResult.success) {
      historyMessages = historyResult.data;
      const latestSupersessionIndex = historyMessages.findLastIndex(isWorkflowSupersessionMessage);
      if (latestSupersessionIndex !== -1) {
        historyScanStartIndex = latestSupersessionIndex + 1;
        const currentMessageIndex =
          currentMessageId == null
            ? -1
            : historyMessages.findIndex((message) => message.id === currentMessageId);
        if (currentMessageIndex !== -1 && currentMessageIndex < latestSupersessionIndex) {
          trustCurrentParts = false;
        }
      }
    } else {
      log.warn("Failed to read history for workflow run references", {
        workspaceId,
        error: historyResult.error,
      });
    }

    const runIds = new Set<string>();
    let references: Awaited<ReturnType<typeof readAgentWorkflowRunReferences>> = [];
    try {
      references = await readAgentWorkflowRunReferences(
        path.join(this.config.sessionsDir, workspaceId)
      );
    } catch (error: unknown) {
      // Rediscovery is non-destructive and re-runs on the next listing; skip this pass.
      log.warn("Failed to read agent workflow run references", { workspaceId, error });
    }
    for (const reference of references) {
      // If the latest user/reset supersession has no durable timestamp, fail safe: only trust
      // workflow provenance re-established by current/post-supersession assistant output below.
      if (latestSupersession.found && latestSupersession.timestamp === undefined) {
        continue;
      }
      if (
        latestSupersession.timestamp !== undefined &&
        reference.createdAtMs <= latestSupersession.timestamp
      ) {
        continue;
      }
      runIds.add(reference.runId);
    }

    if (trustCurrentParts) {
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(currentParts, runIds)) {
        runIds.add(runId);
      }
    }

    for (const message of historyMessages.slice(historyScanStartIndex)) {
      if (message.role !== "assistant" || isWorkflowDisplayOnlyMessage(message)) {
        continue;
      }
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(message.parts, runIds)) {
        runIds.add(runId);
      }
    }

    return Array.from(runIds);
  }

  async listActiveBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listActiveBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRuns();
      return runs
        .filter(
          (run) =>
            referencedRunIdSet.has(run.id) &&
            run.workspaceId === workspaceId &&
            isActiveWorkflowRunStatus(run.status)
        )
        .map((run) => run.id);
    } catch (error: unknown) {
      // Workflow state should never make stream-end cleanup fail; task_await can still discover
      // runs on a later turn once storage is readable again.
      log.warn("Failed to list active background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async listBlockingBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[],
    currentParts: readonly unknown[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listBlockingBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, workspaceId),
      });
      const runs = await runStore.listRuns();
      const blockingRunIds: string[] = [];
      for (const run of runs) {
        if (!referencedRunIdSet.has(run.id) || run.workspaceId !== workspaceId) {
          continue;
        }
        if (resolveBackgroundWorkAttentionPolicy(run.attentionPolicy) === "notify_on_terminal") {
          continue;
        }
        if (isActiveWorkflowRunStatus(run.status)) {
          blockingRunIds.push(run.id);
          continue;
        }
        if (!isTerminalWorkflowRunStatus(run.status)) {
          continue;
        }
        // A foreground workflow_run/workflow_resume terminal result is already visible to this
        // turn, so requiring a second task_await would be redundant (and impossible for agents
        // whose read-only policy only permits task_await as a recovery tool).
        if (
          hasTerminalWorkflowTaskAwaitInParts(currentParts, run.id) ||
          hasTerminalWorkflowToolOutputInParts(currentParts, run.id)
        ) {
          continue;
        }
        const isCurrent = await this.workspaceService.isWorkflowInvocationCurrent(
          workspaceId,
          run.id
        );
        if (isCurrent) {
          blockingRunIds.push(run.id);
        }
      }
      return blockingRunIds;
    } catch (error: unknown) {
      log.warn("Failed to list blocking background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  // Workflow abort/interrupt is the source of truth: task-level restart and stream-end
  // recovery must not resurrect a workflow child (or its descendants) once the owning run
  // is no longer active. Manual workflow_resume replays from the workflow journal instead.
  private findWorkflowTaskOwnersInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner[] {
    assert(taskId.length > 0, "findWorkflowTaskOwnersInAncestry requires taskId");
    const owners: WorkflowTaskOwner[] = [];
    let current: string | undefined = taskId;
    for (let depth = 0; current != null; depth += 1) {
      assert(
        depth < 32,
        `findWorkflowTaskOwnersInAncestry: possible parentWorkspaceId cycle starting at ${taskId}`
      );
      const entry = index.byId.get(current);
      if (entry == null) {
        current = index.parentById.get(current);
        continue;
      }
      const workflowTask = entry.workflowTask;
      if (workflowTask != null) {
        owners.push({ taskId: current, workspace: entry, workflowTask });
      }
      current = index.parentById.get(current);
    }
    return owners;
  }

  private findWorkflowTaskOwnerInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner | null {
    return this.findWorkflowTaskOwnersInAncestry(index, taskId)[0] ?? null;
  }

  private async getInactiveWorkflowTaskOwner(
    owner: WorkflowTaskOwner
  ): Promise<InactiveWorkflowTaskOwner | null> {
    const workflowTask = owner.workflowTask;
    const parentWorkspaceId = coerceNonEmptyString(owner.workspace.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: "workflow-owned task is missing its parent workspace",
      };
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      if (run.workspaceId !== parentWorkspaceId) {
        return {
          ownerTaskId: owner.taskId,
          runId: workflowTask.runId,
          status: run.status,
          reason: `workflow run belongs to ${run.workspaceId}, not ${parentWorkspaceId}`,
        };
      }
      if (isActiveWorkflowRunStatus(run.status)) {
        return null;
      }
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        status: run.status,
        reason: `workflow run is ${run.status}`,
      };
    } catch (error: unknown) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: `workflow run is unavailable: ${getErrorMessage(error)}`,
      };
    }
  }

  private async getInactiveWorkflowTaskOwnerForRecovery(
    taskId: string,
    config: ProjectsConfig,
    index?: AgentTaskIndex
  ): Promise<InactiveWorkflowTaskOwner | null> {
    assert(taskId.length > 0, "getInactiveWorkflowTaskOwnerForRecovery requires taskId");
    const owners = this.findWorkflowTaskOwnersInAncestry(
      index ?? this.buildAgentTaskIndex(config),
      taskId
    );
    for (const owner of owners) {
      const inactiveOwner = await this.getInactiveWorkflowTaskOwner(owner);
      if (inactiveOwner != null) {
        return inactiveOwner;
      }
    }
    return null;
  }

  /** WorkspaceTurnTaskHost (see TaskStopLatch.bumpWorkspaceStopEpoch). */
  bumpWorkspaceStopEpoch(workspaceId: string): void {
    this.taskStopLatch.bumpWorkspaceStopEpoch(workspaceId);
  }

  /** AgentTaskIntegration (see TaskStopLatch.getWorkspaceStopEpoch). */
  getWorkspaceStopEpoch(workspaceId: string): number {
    return this.taskStopLatch.getWorkspaceStopEpoch(workspaceId);
  }

  /** WorkspaceTurnTaskHost: a delegated turn's registration release (#4997). */
  onWorkspaceTurnRegistrationReleased(workspaceId: string): void {
    this.peerSendParking.scheduleParkedPeerSendFlush(workspaceId);
  }

  /** WorkspaceTurnTaskHost: a new delegated turn registered (#5271). */
  onWorkspaceTurnRegistered(workspaceId: string): void {
    this.peerSendParking.onWorkspaceTurnRegistered(workspaceId);
  }

  /** Tests spy on this; PeerSendParking's scheduled flush calls back through it. */
  private flushParkedPeerSends(targetId: string): Promise<void> {
    return this.peerSendParking.flushParkedPeerSends(targetId);
  }

  /** WorkspaceTurnTaskHost (see TaskStopLatch.latchWorkspaceStopsInProgress). */
  latchWorkspaceStopsInProgress(workspaceIds: readonly string[]): () => void {
    return this.taskStopLatch.latchWorkspaceStopsInProgress(workspaceIds);
  }

  /** AgentTaskIntegration: a stop cascade holds the workspace's latch. */
  isWorkspaceStopInProgress(workspaceId: string): boolean {
    return this.taskStopLatch.isWorkspaceStopInProgress(workspaceId);
  }

  /** Tests spy on this; TaskStopLatch owns Phase B. */
  private runWorkspaceStopCleanup(
    targets: readonly string[],
    options: Parameters<TaskStopLatch["runWorkspaceStopCleanup"]>[1]
  ): Promise<void> {
    return this.taskStopLatch.runWorkspaceStopCleanup(targets, options);
  }

  /** WorkspaceTurnTaskHost (see TaskStopLatch.releaseRetainedStopLatches). */
  releaseRetainedStopLatches(workspaceId: string): void {
    this.taskStopLatch.releaseRetainedStopLatches(workspaceId);
  }

  /**
   * Owner settlement: a turn generation ended for good (see onWorkspaceTurnSettled). Discharges
   * every obligation admitted under that turn and releases it from the stop record that waited on
   * it. Turn correlation is exact — a turn that never settles keeps its obligations, which is the
   * fail-closed shape (cleanup-pending), never a silent discharge.
   */
  private recordWorkspaceTurnSettled(workspaceId: string, turnGeneration: symbol): void {
    for (const send of this.attemptLedger.sendsOf(workspaceId)) {
      if (send.state === "admitted" && send.turnId === turnGeneration) {
        this.attemptLedger.dischargeAdmittedSend(send);
      }
    }
    // A terminal decision held for this turn's late readers: only actual readers keep it now.
    this.streamEndLedger.settleTurn(workspaceId, turnGeneration);
    this.attemptLedger.recheckResumeFailureSettlement(workspaceId);
    this.taskStopLatch.releaseCapturedTurn(workspaceId, turnGeneration);
  }

  /**
   * The coordinator replaced a live generation with a successor without the predecessor going
   * idle (see onWorkspaceTurnSuperseded): the predecessor will never settle on its own, so every
   * wait bound to it — captured turns of a stop record, admitted obligations — is rebound to the
   * successor, whose settlement is the next authoritative signal.
   */
  private recordWorkspaceTurnSuperseded(workspaceId: string, previous: symbol, next: symbol): void {
    if (previous === next) return;
    for (const send of this.attemptLedger.sendsOf(workspaceId)) {
      if (send.state === "admitted" && send.turnId === previous) {
        send.turnId = next;
        send.inherited = true;
      }
    }
    this.streamEndLedger.rebindTurn(workspaceId, previous, next);
    this.taskStopLatch.rebindCapturedTurn(workspaceId, previous, next);
  }

  /** Tests call this; AttemptLedger owns the attempt identity. */
  private beginOwnedTaskAttempt(
    taskId: string,
    source: string,
    identity: { attemptId: string | undefined; receiptEligible: boolean; abortSignal?: AbortSignal }
  ): OwnedTaskAttempt {
    return this.attemptLedger.beginOwnedTaskAttempt(taskId, source, identity);
  }

  /** Tests spy on this; AttemptLedger owns the closure. */
  private closeAttemptAdmission(
    taskId: string,
    attemptId: string | undefined,
    ownedAttempt: OwnedTaskAttempt | undefined,
    source: string
  ): void {
    this.attemptLedger.closeAttemptAdmission(taskId, attemptId, ownedAttempt, source);
  }

  /** Tests call this; AttemptLedger owns the settlement. */
  private settleOwnedTaskAttempt(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    source: string
  ): void {
    this.attemptLedger.settleOwnedTaskAttempt(taskId, attempt, source);
  }

  /** Tests spy on this; AttemptLedger owns the decision. */
  private decideSettlementReceipt(
    taskId: string,
    attempt: OwnedTaskAttempt | undefined,
    settlementSource: string
  ): SettlementReceiptDecision {
    return this.attemptLedger.decideSettlementReceipt(taskId, attempt, settlementSource);
  }

  /** Tests spy on this; AttemptLedger owns the write. */
  private writeSettlementReceipt(
    taskId: string,
    target: { attemptId: string; parentWorkspaceId: string; owners: string[] },
    source: SubagentAttemptSettlementSource
  ): Promise<boolean> {
    return this.attemptLedger.writeSettlementReceipt(taskId, target, source);
  }

  /** Tests call this; AttemptLedger owns the listeners. */
  private notifyAttemptSettlementListeners(taskId: string): void {
    this.attemptLedger.notifyAttemptSettlementListeners(taskId);
  }

  // ---------------------------------------------------------------------------------------------
  // Attempt identity and send admission
  // ---------------------------------------------------------------------------------------------

  /**
   * The task's current attempt id: the persisted value only (the given entry or the config
   * snapshot, which re-reads the file whenever it changed). The row is the source of truth every
   * CAS writer compares against, and another process's committed rotation is visible only there.
   * Undefined for pre-identity entries AND for a row that is missing, lost its id, or could not
   * be read (lenient load → default view): every token then reads stale and every fence refuses,
   * never falling back to an id this process remembers — a stale memory must not revive an
   * attempt the registry no longer names (see currentAttemptIdByTaskId).
   */
  private currentTaskAttemptId(taskId: string, entry?: WorkspaceConfigEntry): string | undefined {
    const persisted =
      entry?.taskAttemptId ??
      findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId)?.workspace.taskAttemptId;
    return isTaskAttemptId(persisted) ? persisted : undefined;
  }

  /**
   * The attempt id a stream event belongs to, read in the event's own tick (see
   * resolveStreamAttemptAtEvent).
   */
  private streamAttemptIdAtEvent(taskId: string): string | undefined {
    const origin = this.resolveStreamAttemptAtEvent(taskId);
    return origin.ownedAttempt != null ? origin.ownedAttempt.attemptId : origin.unownedAttemptId;
  }

  /** Tests and the stream listeners call this (see AttemptLedger.resolveStreamAttemptAtEvent). */
  private resolveStreamAttemptAtEvent(taskId: string): StreamAttemptOrigin {
    return this.attemptLedger.resolveStreamAttemptAtEvent(taskId);
  }

  /**
   * Stop epochs of `taskId` and its ancestors, captured when a reawakening decision begins (before
   * its first await). See reawakeningOvertakenByStop.
   */
  private captureReawakeningStopFence(taskId: string): ReadonlyMap<string, number> {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    const chain = [
      taskId,
      ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, taskId),
    ];
    return new Map(chain.map((id) => [id, this.getWorkspaceStopEpoch(id)]));
  }

  /**
   * A Stop of the task or any ancestor that latched or ran since `fence` was captured overtakes
   * the reawakening. With R > P > C, the user's Stop of R latches C, but an idle C releases its
   * latch at once while P's tool call (the reawakening) is still suspended, so the task's own
   * latch alone cannot see a Stop that already completed. Mirrors reawakenInterruptedTask's
   * stop-epoch recheck; a Stop is a later user decision than the reawakening it overtakes.
   */
  private reawakeningOvertakenByStop(fence: ReadonlyMap<string, number>): boolean {
    for (const [id, epoch] of fence) {
      if (this.isWorkspaceStopInProgress(id) || this.getWorkspaceStopEpoch(id) !== epoch) {
        return true;
      }
    }
    return false;
  }

  /** AgentTaskIntegration (see AttemptLedger.admitTaskWorkspaceTurn). */
  admitTaskWorkspaceTurn(
    workspaceId: string,
    options: { acceptanceOrigin: TurnAcceptanceOrigin; expectedAttemptId?: string }
  ): TaskTurnAdmission {
    return this.attemptLedger.admitTaskWorkspaceTurn(workspaceId, options);
  }

  /** Tests spy on this (see AttemptLedger.evaluateAttemptLineage). */
  private evaluateAttemptLineage(
    taskId: string,
    entry: WorkspaceConfigEntry
  ): Promise<{ proven: boolean; reason: string }> {
    return this.attemptLedger.evaluateAttemptLineage(taskId, entry);
  }

  /** Tests spy on this; TaskStopLatch owns the wait. */
  private waitForWorkspaceStopsToRelease(
    workspaceIds: readonly string[],
    deadlineMs: number
  ): Promise<void> {
    return this.taskStopLatch.waitForWorkspaceStopsToRelease(workspaceIds, deadlineMs);
  }

  /**
   * Startup re-drive of a `running`/`awaiting_report` task (recoverInterruptedTasks): the previous
   * process may still hold an admitted execution, so the re-driven work is a new, UNOWNED and
   * unproven attempt — the CAS rotates the id and sets the marker; no ownership, no receipts.
   * `snapshot` is the row the recovery pass decided on: the CAS refuses (false) when the row
   * moved since (another writer admitted or stopped the task — re-driving it would dispatch a
   * duplicate under an id nobody decided on), when a workflow claim retired the attempt, or
   * when the write fails.
   */
  private async rotateAttemptForStartupRedrive(
    taskId: string,
    snapshot: Pick<WorkspaceConfigEntry, "taskAttemptId" | "taskStatus">
  ): Promise<string | undefined> {
    const attemptId = newTaskAttemptId();
    let committed = false;
    let moved = false;
    try {
      await this.editWorkspaceEntry(
        taskId,
        (ws) => {
          if (ws.taskAttemptRetiredBy != null || ws.pendingRemoval != null) return;
          if (
            ws.taskAttemptId !== snapshot.taskAttemptId ||
            ws.taskStatus !== snapshot.taskStatus
          ) {
            moved = true;
            return;
          }
          ws.taskAttemptId = attemptId;
          ws.taskAttemptUnproven = true;
          committed = true;
        },
        { allowMissing: true }
      );
    } catch (error: unknown) {
      log.warn("[startup] failed to rotate the attempt id before re-driving a task; skipping", {
        taskId,
        error,
      });
      return undefined;
    }
    if (moved) {
      log.info("[startup] task skipped: its row moved after the recovery snapshot", { taskId });
      return undefined;
    }
    if (!committed) {
      log.info(
        "[startup] task skipped: a workflow claim retired its attempt, or it is being removed",
        {
          taskId,
        }
      );
      return undefined;
    }
    this.attemptLedger.publishAttemptRotation(taskId, attemptId);
    return attemptId;
  }

  /**
   * Startup re-drive of a pending compaction follow-up, fenced to exactly the attempt this
   * decision rotated: the obligation is bound here (refused when the row already names another
   * writer's attempt — a decision never adopts a successor) and rides the session's send as its
   * token and staleness probe, so a rotation or claim landing during the dispatch's awaits
   * refuses it at the session's admission gates. A token that produced no turn is disposed here;
   * an admitted one belongs to its turn (and to any Stop that captures it).
   */
  private async dispatchFencedStartupCompactionFollowUp(
    taskId: string,
    attemptId: string
  ): Promise<Result<boolean>> {
    const admission = this.admitTaskWorkspaceTurn(taskId, {
      acceptanceOrigin: "automatic",
      expectedAttemptId: attemptId,
    });
    if (admission.kind !== "admitted") {
      return Err(
        admission.kind === "refused"
          ? admission.message
          : "Startup follow-up refused: the task record is no longer an agent task"
      );
    }
    const followUp = await this.workspaceService.dispatchPendingCompactionFollowUp(taskId, {
      turnAdmission: admission.token,
    });
    if (followUp.success && followUp.data) {
      // `true` means the session took the follow-up, not that a turn was admitted: a session torn
      // down during the send's awaits resolves Ok through its disposed guard without calling
      // onAdmitted. The session's direct send never enqueues the token, so after the wrapper
      // settles it is either admitted (disposal is then a no-op — it belongs to its turn) or
      // produced no turn and must not stay pending, or a later Stop would wait on it forever.
      admission.token.onDisposed("no-work");
      return followUp;
    }
    // Nothing dispatched. A token that reads stale now was refused at the session's gates because
    // this decision's attempt is gone (rotated or retired by another writer): report that as a
    // failure so the caller issues no further send for the decision.
    const stale = admission.token.admissionStale();
    admission.token.onDisposed(followUp.success && !stale ? "no-work" : "refused");
    return stale ? Err(SEND_ADMISSION_STALE_MESSAGE) : followUp;
  }

  /**
   * Authoritative outcome of a child's current attempt, read under the task's event lock — the
   * serialization report publication (handleStreamEnd → publishAgentTaskReport) runs under — so
   * report and termination evidence are one observation. Positive evidence only: a persisted
   * status, a missing entry or a settled latch of an attempt nobody in this process owns is
   * `indeterminate`, never "no report". `requestingWorkspaceId` names the ancestor session dir
   * holding the persisted report after config cleanup (no scan over all parents).
   */
  async readAttemptOutcome(
    taskId: string,
    options?: { requestingWorkspaceId?: string }
  ): Promise<TaskAttemptOutcome<AgentTaskReport>> {
    assert(taskId.length > 0, "readAttemptOutcome: taskId must be non-empty");
    return await this.workspaceEventLocks.withLock(taskId, () =>
      this.inspectAttemptOutcome(taskId, options)
    );
  }

  /** Workflow adapter (see AttemptLedger.claimRetiredAttempt). */
  claimRetiredAttempt(
    taskId: string,
    attemptId: string,
    claimant: { runId: string; stepId: string; inputHash: string }
  ): Promise<Result<{ nonce: string }, string>> {
    return this.attemptLedger.claimRetiredAttempt(taskId, attemptId, claimant);
  }

  /** Workflow adapter (see AttemptLedger.tombstoneUnpublishedReservation). */
  tombstoneUnpublishedReservation(
    parentWorkspaceId: string,
    taskId: string
  ): Promise<Result<void, string>> {
    return this.attemptLedger.tombstoneUnpublishedReservation(parentWorkspaceId, taskId);
  }

  /**
   * Strict read (see TaskAttemptOutcome's `code: "no-record"`): true only when a well-formed
   * config, or no config file, has no row for the task. The lenient read also returns an empty
   * config for a malformed or unreadable file, which must never read as "no row".
   */
  private taskRowPositivelyAbsent(taskId: string): boolean {
    try {
      return (
        findWorkspaceEntry(this.config.loadConfigOrDefault({ throwOnError: true }), taskId) == null
      );
    } catch {
      return false;
    }
  }

  private async inspectAttemptOutcome(
    taskId: string,
    options?: { requestingWorkspaceId?: string }
  ): Promise<TaskAttemptOutcome<AgentTaskReport>> {
    const cached = this.waiters.getCompletedReport(taskId);
    if (cached) {
      return { kind: "reported", report: toAgentTaskReport(cached) };
    }
    const located = this.locateAttemptRecord(taskId, options);
    if (located.kind === "decided") return located.outcome;
    const read = await this.readAttemptArtifacts(taskId, located.record);
    if (read.kind === "decided") return read.outcome;
    const { probe } = read;
    const live = this.classifyLiveAttempt(taskId, probe);
    if (live.kind === "decided") return live.outcome;

    const status = probedTaskStatus(probe);
    const owned = this.attemptLedger.ownedAttempt(taskId);
    if (owned == null) {
      return await this.classifyUnownedAttempt(taskId, probe, status);
    }
    return this.classifyOwnedAttempt(taskId, probe, {
      owned,
      status,
      executionId: live.executionId,
    });
  }

  /** Rejects a row that is not an agent task, else locates it (see LocatedAttemptRecord). */
  private locateAttemptRecord(
    taskId: string,
    options: { requestingWorkspaceId?: string } | undefined
  ): DecidedAttemptOutcome | { kind: "located"; record: LocatedAttemptRecord } {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    if (entry != null && !entry.workspace.parentWorkspaceId) {
      return { kind: "decided", outcome: indeterminateOutcome("workspace is not an agent task") };
    }
    const reportOwnerWorkspaceId =
      coerceNonEmptyString(options?.requestingWorkspaceId) ??
      coerceNonEmptyString(entry?.workspace.parentWorkspaceId);
    return { kind: "located", record: { entry, reportOwnerWorkspaceId } };
  }

  /**
   * Strict report read, then (only when the report is positively absent) the strict failure
   * read. Without a session dir nothing is read and the located row stays the probe's row.
   */
  private async readAttemptArtifacts(
    taskId: string,
    located: LocatedAttemptRecord
  ): Promise<DecidedAttemptOutcome | { kind: "probed"; probe: AttemptArtifactProbe }> {
    const { reportOwnerWorkspaceId } = located;
    if (reportOwnerWorkspaceId == null) {
      return {
        kind: "probed",
        probe: { entry: located.entry, failure: undefined, reportPositivelyAbsent: false },
      };
    }
    const read = await readSubagentReportArtifactStrict(
      path.join(this.config.sessionsDir, reportOwnerWorkspaceId),
      taskId
    );
    if (read.kind === "found") {
      this.waiters.cacheCompletedReport(taskId, {
        reportMarkdown: read.artifact.reportMarkdown,
        title: read.artifact.title,
        planFilePath: read.artifact.planFilePath,
        structuredOutput: read.artifact.structuredOutput,
        model: read.artifact.model,
        thinkingLevel: read.artifact.thinkingLevel,
        workflowOwnedAncestorWorkspaceIds: read.artifact.workflowOwnedAncestorWorkspaceIds,
        ancestorWorkspaceIds: read.artifact.ancestorWorkspaceIds,
      });
      return {
        kind: "decided",
        outcome: { kind: "reported", report: toAgentTaskReport(read.artifact) },
      };
    }
    if (read.kind === "unreadable") {
      return {
        kind: "decided",
        outcome: indeterminateOutcome(
          `report artifact unreadable in ${reportOwnerWorkspaceId}: ${read.error}`
        ),
      };
    }
    // A terminal failure (failAgentTaskTerminally) settles like a no-report stop and leaves a
    // receipt too, so its failure artifact is read next, as strictly as the report: a found
    // failure marks the outcome (never replaced), an unreadable one proves nothing.
    const failureRead = await readSubagentFailureArtifactStrict(
      path.join(this.config.sessionsDir, reportOwnerWorkspaceId),
      taskId
    );
    if (failureRead.kind === "unreadable") {
      return {
        kind: "decided",
        outcome: this.resolveUnreadableFailureArtifact(
          taskId,
          reportOwnerWorkspaceId,
          failureRead.error
        ),
      };
    }
    const failure =
      failureRead.kind === "found"
        ? { errorMessage: failureRead.artifact.errorMessage }
        : undefined;
    // The artifact read awaited: another backend may have re-admitted the row meanwhile, so
    // the classification below must not decide from the snapshot taken before it (#4414).
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    return { kind: "probed", probe: { entry, failure, reportPositivelyAbsent: true } };
  }

  /**
   * The row's marker (#4579) still proves a terminal failure for the attempt it names;
   * without one, a damaged artifact proves nothing (fail closed).
   */
  private resolveUnreadableFailureArtifact(
    taskId: string,
    reportOwnerWorkspaceId: string,
    error: string
  ): TaskAttemptOutcome<AgentTaskReport> {
    let row: WorkspaceConfigEntry | undefined;
    try {
      row = findWorkspaceEntry(
        this.config.loadConfigOrDefault({ throwOnError: true }),
        taskId
      )?.workspace;
    } catch {
      row = undefined;
    }
    const owned = this.attemptLedger.ownedAttempt(taskId);
    const attemptId = row?.taskAttemptId;
    const marked = markedTerminalFailure(row, attemptId);
    if (marked != null && (owned?.attemptId == null || owned.attemptId === attemptId)) {
      return { kind: "terminal-no-report", attemptId, failure: marked };
    }
    return indeterminateOutcome(
      `failure artifact unreadable in ${reportOwnerWorkspaceId}: ${error}`
    );
  }

  /**
   * Evidence that the attempt is still running in this process. Runs after the artifact
   * awaits; `executionId` carries over to the owned classification.
   */
  private classifyLiveAttempt(
    taskId: string,
    probe: AttemptArtifactProbe
  ): DecidedAttemptOutcome | { kind: "not-live"; executionId: string } {
    // Owned cleanup in flight (Layer 2 latch): its release is the guaranteed settlement signal.
    if (this.isWorkspaceStopInProgress(taskId)) {
      return { kind: "decided", outcome: { kind: "cleanup-pending" } };
    }
    const liveRegistration =
      this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(taskId);
    if (liveRegistration != null) {
      return { kind: "decided", outcome: { kind: "live", executionId: liveRegistration.handleId } };
    }
    const executionId = coerceNonEmptyString(probe.entry?.workspace.taskExecutionId) ?? taskId;
    // Admitted in this process: a registered stream, or a turn admitted but still preparing
    // (no stream yet; Layer 2 may already have persisted "interrupted" ahead of its settlement).
    if (
      this.aiService.isStreaming(taskId) ||
      this.workspaceService.getActiveTurnGeneration(taskId) != null
    ) {
      return { kind: "decided", outcome: { kind: "live", executionId } };
    }
    return { kind: "not-live", executionId };
  }

  /** No attempt owned here: only durable evidence (the row, the parent's receipt) can decide. */
  private async classifyUnownedAttempt(
    taskId: string,
    probe: AttemptArtifactProbe,
    status: AgentTaskStatus | undefined
  ): Promise<TaskAttemptOutcome<AgentTaskReport>> {
    if (probe.entry == null) {
      const reason = "no task record and no attempt owned by this process";
      return this.taskRowPositivelyAbsent(taskId)
        ? { kind: "indeterminate", reason, code: "no-record" }
        : indeterminateOutcome(reason);
    }
    // Report first: this branch runs only once the report artifact read positively found none.
    if (probe.reportPositivelyAbsent) {
      const proof = await this.attemptLedger.readUnownedSettlementProof(taskId);
      if (proof.kind === "proven") {
        return {
          kind: "terminal-no-report",
          attemptId: proof.attemptId,
          ...failureFieldsOf(probe, proof.attemptId),
        };
      }
      return indeterminateOutcome(
        `task status ${status ?? "running"} without an attempt owned by this process: ${proof.reason}`
      );
    }
    return indeterminateOutcome(
      `task status ${status ?? "running"} without an attempt owned by this process (legacy or prior-process attempt)`
    );
  }

  /** An attempt this process owns: the current row, then its settlement, then its status. */
  private classifyOwnedAttempt(
    taskId: string,
    probe: AttemptArtifactProbe,
    attempt: {
      readonly owned: OwnedTaskAttempt;
      readonly status: AgentTaskStatus | undefined;
      readonly executionId: string;
    }
  ): TaskAttemptOutcome<AgentTaskReport> {
    const { owned, status } = attempt;
    const rowConflict = this.readOwnedAttemptRowConflict(taskId, owned);
    if (rowConflict != null) return rowConflict;
    const settlement = this.attemptLedger.attemptSettlement(taskId);
    if (settlement?.attempt === owned) {
      return this.settleOwnedAttempt(taskId, probe, owned, settlement.phase);
    }
    if (status != null && ACTIVE_AGENT_TASK_STATUSES.has(status)) {
      // Reserved/queued/launching/running under this process's ownership; no stream yet.
      return { kind: "live", executionId: attempt.executionId };
    }
    return indeterminateOutcome(
      `owned attempt (${owned.source}) has status ${status ?? "missing"} without settlement evidence`
    );
  }

  /** The outcome when the current row contradicts this process's ownership; undefined if not. */
  private readOwnedAttemptRowConflict(
    taskId: string,
    owned: OwnedTaskAttempt
  ): TaskAttemptOutcome<AgentTaskReport> | undefined {
    // In-process authority covers exactly the attempt the persisted row names now (#4311, #4414):
    // once the row names another writer's attempt, lost its id, or cannot be read, this process's
    // ownership says nothing about the task — never report it as ended. Strict, and after the last
    // await. A positively absent row keeps the owned verdict below (e.g. a reservation canceled
    // before publication): with no row, nothing can be admitted for the task.
    let currentRow: WorkspaceConfigEntry | undefined;
    try {
      currentRow = findWorkspaceEntry(
        this.config.loadConfigOrDefault({ throwOnError: true }),
        taskId
      )?.workspace;
    } catch (error: unknown) {
      return indeterminateOutcome(`config unreadable: ${getErrorMessage(error)}`);
    }
    if (currentRow != null && currentRow.taskAttemptId !== owned.attemptId) {
      return indeterminateOutcome(
        `row names attempt ${currentRow.taskAttemptId ?? "none"}; this process owns ${owned.attemptId ?? "none"}`
      );
    }
    return undefined;
  }

  /** The owned attempt's own settlement entry decides: closing, or settled without a report. */
  private settleOwnedAttempt(
    taskId: string,
    probe: AttemptArtifactProbe,
    owned: OwnedTaskAttempt,
    phase: AttemptSettlementEntry["phase"]
  ): TaskAttemptOutcome<AgentTaskReport> {
    // Closed but not yet settled: the producer's awaited write (config, later the receipt) is
    // still in flight. Its settlement is the guaranteed next signal (fail closed, not a wait).
    if (phase === "closing") return { kind: "cleanup-pending" };
    if (!probe.reportPositivelyAbsent) {
      return indeterminateOutcome(
        "attempt settled but no session directory names where its report would be"
      );
    }
    return {
      kind: "terminal-no-report",
      ...(owned.attemptId != null ? { attemptId: owned.attemptId } : {}),
      ...failureFieldsOf(probe, owned.attemptId),
      // Ended before (or without) a published row, e.g. a canceled reservation.
      ...(probe.entry == null && this.taskRowPositivelyAbsent(taskId)
        ? { code: "no-record" as const }
        : {}),
    };
  }

  /** Public entry point (WorkflowTaskServiceAdapter, WorkflowRunner); AttemptLedger owns the wait. */
  waitForAttemptSettlement(
    taskId: string,
    options: { abortSignal?: AbortSignal; timeoutMs: number; requestingWorkspaceId?: string }
  ): Promise<TaskAttemptSettlement<AgentTaskReport>> {
    return this.attemptLedger.waitForAttemptSettlement(taskId, options);
  }

  private recordTaskInterrupted(taskId: string, parentWorkspaceId: string | undefined): void {
    // Latch the stop for in-flight peer-send admission even when there is no parent to notify.
    this.bumpWorkspaceStopEpoch(taskId);
    this.clearTaskRecovery(taskId);
    this.notifyAttemptSettlementListeners(taskId);
    if (!parentWorkspaceId) {
      return;
    }
    // Every interrupted transition lands here right after the status commit. The child's queued
    // incremental updates are superseded now: left in place as tool-end entries they would still
    // cut the parent's active turn at its next step boundary before their admission probe refuses
    // them. (A continuation owned by a different ancestor is cleaned by its settlement instead.)
    const queuedProgressRemoval = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
      parentWorkspaceId,
      agentReportProgressDedupePrefix(taskId),
      { cancelReason: AGENT_REPORT_PROGRESS_SUPERSEDED_REASON, skipCancelCallbacks: true }
    );
    if (!queuedProgressRemoval.success) {
      log.warn("Failed to remove queued incremental sub-agent reports after interrupt", {
        parentWorkspaceId,
        childWorkspaceId: taskId,
        error: queuedProgressRemoval.error,
      });
    }
    this.timelineRecorder.record(parentWorkspaceId, {
      kind: "task.interrupted",
      source: { system: "task" },
      status: "interrupted",
      anchor: { taskId, childWorkspaceId: taskId },
    });
  }

  /**
   * A terminal outcome or explicit Stop ends recovery: release every cut receipt, including
   * sources still waiting for the event lock, and remove prompts from the child's own queue.
   * Delayed source events are separately fenced by their execution identity and Stop epoch.
   */
  private clearTaskRecovery(taskId: string): void {
    this.streamEndLedger.forgetDeferral(taskId);
    this.workspaceService.clearQueueCutReceipts(taskId);
    const removal = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
      taskId,
      taskRecoveryPromptDedupePrefix(taskId),
      { cancelReason: "Task recovery prompt superseded by the task's terminal outcome." }
    );
    if (!removal.success) {
      log.warn("Failed to remove queued task recovery prompts", { taskId, error: removal.error });
    }
  }

  private applyInterruptedTaskStatus(
    workspace: WorkspaceConfigEntry
  ): InterruptedTaskStatusMutation {
    if (hasCompletedAgentReport(workspace)) {
      // Preserve completed report evidence so already-finished tasks stay inspectable
      // and collapse-eligible after a later interrupt/recovery pass.
      return "preserved-completed-report";
    }

    const previousStatus = workspace.taskStatus;
    const persistedQueuedPrompt = coerceNonEmptyString(workspace.taskPrompt);
    workspace.taskStatus = "interrupted";
    workspace.reportedAt = undefined;
    markChildGoalPauseOwed(workspace);

    // Queued tasks persist their initial prompt in config until first start. Preserve that
    // intent across interrupts, including repeated interrupts after the status is no longer queued.
    if (previousStatus !== "queued" && !persistedQueuedPrompt) {
      workspace.taskPrompt = undefined;
      // The brief's send id means nothing without the brief (#5544).
      workspace.taskPromptSendId = undefined;
    }
    return "interrupted";
  }

  private async interruptTaskRecoveryForInactiveWorkflowOwner(
    taskId: string,
    config: ProjectsConfig,
    trigger: string,
    index?: AgentTaskIndex,
    options?: { scheduleQueueDrain?: boolean }
  ): Promise<boolean> {
    assert(taskId.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires taskId");
    assert(trigger.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires trigger");
    const inactiveOwner = await this.getInactiveWorkflowTaskOwnerForRecovery(taskId, config, index);
    if (inactiveOwner == null) {
      return false;
    }

    let interrupted = false;
    let transitionedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        const previousStatus = ws.taskStatus;
        parentWorkspaceId = ws.parentWorkspaceId;
        interrupted = this.applyInterruptedTaskStatus(ws) === "interrupted";
        transitionedToInterrupted = interrupted && previousStatus !== "interrupted";
      },
      { allowMissing: true }
    );
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(taskId, parentWorkspaceId);
    }
    if (interrupted) await this.settleChildGoalPause(taskId);

    log.debug("Skipping workflow-owned task recovery after inactive workflow owner", {
      taskId,
      trigger,
      ownerTaskId: inactiveOwner.ownerTaskId,
      workflowRunId: inactiveOwner.runId,
      workflowRunStatus: inactiveOwner.status,
      reason: inactiveOwner.reason,
    });
    if (interrupted) {
      this.rejectWaiters(taskId, new Error("Task interrupted"));
      await this.emitWorkspaceMetadata(taskId);
      if (options?.scheduleQueueDrain !== false) {
        this.scheduleMaybeStartQueuedTasks();
      }
    }
    return true;
  }

  markTaskForegroundRelevant(taskId: string): void {
    this.waiters.markTaskForegroundRelevant(taskId);
  }

  /**
   * Resolve the persisted attention policy for a child agent-task workspace.
   * Missing/legacy records default to `blocking_until_terminal`.
   */
  private resolveAgentTaskAttentionPolicy(
    taskId: string,
    index: AgentTaskIndex
  ): BackgroundWorkAttentionPolicy {
    return resolveBackgroundWorkAttentionPolicy(index.byId.get(taskId)?.taskAttentionPolicy);
  }

  private readonly agentPeerMessageBroker: AgentPeerMessageBroker;
  private workspaceTurnManager: WorkspaceTurnManager | undefined;
  /** Stream message ids whose child-goal arbitration already ran, per task (bounded). */
  private readonly childGoalArbitratedStreams = new Map<string, string[]>();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceHost,
    private readonly initStateManager: InitStateManager,
    private readonly sessionUsageService?: SessionUsageService,
    private readonly workspaceGoalService?: WorkspaceGoalService,
    private readonly secretsStore: SecretsStore = new SecretsStore(config.rootDir),
    terminalAttentionStore?: TerminalAttentionStore,
    private readonly desktopInputCoordinator = new DesktopInputCoordinator(config)
  ) {
    this.attemptLedger = new AttemptLedger({
      config: () => this.config,
      aiService: () => this.aiService,
      workspaceService: () => this.workspaceService,
      turnManager: () => this.getWorkspaceTurnManager(),
      workspaceEventLocks: () => this.workspaceEventLocks,
      buildAgentTaskIndex: (cfg) => this.buildAgentTaskIndex(cfg),
      listAncestorWorkspaceIdsUsingParentById: (parentById, taskId) =>
        this.listAncestorWorkspaceIdsUsingParentById(parentById, taskId),
      stopRecordAttemptId: (taskId) => this.taskStopLatch.stopRecordAttemptId(taskId),
      hasStopRecord: (taskId) => this.taskStopLatch.hasStopRecord(taskId),
      isWorkspaceStopInProgress: (workspaceId) => this.isWorkspaceStopInProgress(workspaceId),
      isCurrentStopRecord: (workspaceId, record) =>
        this.taskStopLatch.isCurrentStopRecord(workspaceId, record),
      recheckWorkspaceStopRelease: (workspaceId) =>
        this.taskStopLatch.recheckWorkspaceStopRelease(workspaceId),
      currentTaskAttemptId: (taskId, entry) => this.currentTaskAttemptId(taskId, entry),
      editWorkspaceEntry: (workspaceId, updater, options) =>
        this.editWorkspaceEntry(workspaceId, updater, options),
      settleChildGoalPause: (workspaceId) => this.settleChildGoalPause(workspaceId),
      findStreamEndDecision: (taskId, attemptId) =>
        this.streamEndLedger.findStreamEndDecision(taskId, attemptId),
      pruneStreamEndDecisions: (taskId) => this.streamEndLedger.pruneStreamEndDecisions(taskId),
      discardStreamEndDecisions: (taskId) => {
        this.streamEndLedger.discardStreamEndDecisions(taskId);
      },
      // Through TaskService: tests spy on inspectAttemptOutcome on the instance.
      inspectAttemptOutcome: (taskId, options) => this.inspectAttemptOutcome(taskId, options),
      notifyAttemptSettlementListeners: (taskId) => this.notifyAttemptSettlementListeners(taskId),
      closeAttemptAdmission: (taskId, attemptId, ownedAttempt, source) =>
        this.closeAttemptAdmission(taskId, attemptId, ownedAttempt, source),
      settleOwnedTaskAttempt: (taskId, attempt, source) =>
        this.settleOwnedTaskAttempt(taskId, attempt, source),
      decideSettlementReceipt: (taskId, attempt, settlementSource) =>
        this.decideSettlementReceipt(taskId, attempt, settlementSource),
      writeSettlementReceipt: (taskId, target, source) =>
        this.writeSettlementReceipt(taskId, target, source),
    });
    this.taskStopLatch = new TaskStopLatch({
      config: () => this.config,
      aiService: () => this.aiService,
      workspaceService: () => this.workspaceService,
      turnManager: () => this.getWorkspaceTurnManager(),
      terminalAttention: () => this.terminalAttention,
      scheduleMaybeStartQueuedTasks: () => this.scheduleMaybeStartQueuedTasks(),
      scheduleParkedPeerSendFlush: (workspaceId) =>
        this.peerSendParking.scheduleParkedPeerSendFlush(workspaceId),
      notifyAttemptSettlementListeners: (taskId) => this.notifyAttemptSettlementListeners(taskId),
      addAttemptSettlementListener: (taskId, listener) =>
        this.attemptLedger.addAttemptSettlementListener(taskId, listener),
      removeAttemptSettlementListener: (taskId, listener) =>
        this.attemptLedger.removeAttemptSettlementListener(taskId, listener),
      ownedAttempt: (taskId) => this.attemptLedger.ownedAttempt(taskId),
      currentTaskAttemptId: (taskId) => this.currentTaskAttemptId(taskId),
      admittedSends: (taskId) => this.attemptLedger.sendsOf(taskId),
      ownsReceiptEligibleAttempt: (taskId, attempt) =>
        this.attemptLedger.ownsReceiptEligibleAttempt(taskId, attempt),
      findStreamEndDecision: (taskId, attemptId) =>
        this.streamEndLedger.findStreamEndDecision(taskId, attemptId),
      decideSettlementReceipt: (taskId, attempt, settlementSource) =>
        this.decideSettlementReceipt(taskId, attempt, settlementSource),
      writeSettlementReceipt: (taskId, target, source) =>
        this.writeSettlementReceipt(taskId, target, source),
      closeAttemptAdmission: (taskId, attemptId, ownedAttempt, source) =>
        this.closeAttemptAdmission(taskId, attemptId, ownedAttempt, source),
      settleOwnedTaskAttempt: (taskId, attempt, source) =>
        this.settleOwnedTaskAttempt(taskId, attempt, source),
      recheckResumeFailureSettlement: (taskId) =>
        this.attemptLedger.recheckResumeFailureSettlement(taskId),
    });
    this.streamEndLedger = new StreamEndLedger({
      config: () => this.config,
      workspaceService: () => this.workspaceService,
      workspaceGoalService: () => this.workspaceGoalService,
      workspaceEventLocks: () => this.workspaceEventLocks,
      handleStreamEnd: (event, queueCutSnapshot, taskOrigin) =>
        this.handleStreamEnd(event, queueCutSnapshot, taskOrigin),
      recoverTaskFromIncompleteStreamEnd: (workspaceId, status, streamAttemptId) =>
        this.recoverTaskFromIncompleteStreamEnd(workspaceId, status, streamAttemptId),
      getWorkspaceStopEpoch: (workspaceId) => this.getWorkspaceStopEpoch(workspaceId),
      getAgentTaskExecutionId: (taskId) => this.getAgentTaskExecutionId(taskId),
      recheckWorkspaceStopRelease: (workspaceId) =>
        this.taskStopLatch.recheckWorkspaceStopRelease(workspaceId),
      attemptAdmissionOpen: (taskId, attemptId) =>
        this.attemptLedger.attemptAdmissionOpen(taskId, attemptId),
      addAttemptSettlementListener: (taskId, listener) =>
        this.attemptLedger.addAttemptSettlementListener(taskId, listener),
      removeAttemptSettlementListener: (taskId, listener) =>
        this.attemptLedger.removeAttemptSettlementListener(taskId, listener),
      sendsOf: (taskId) => this.attemptLedger.sendsOf(taskId),
    });
    this.peerSendParking = new PeerSendParking({
      flush: (targetId) => this.flushParkedPeerSends(targetId),
      getWorkspaceTurnManager: () => this.getWorkspaceTurnManager(),
      isWorkspaceStopInProgress: (workspaceId) => this.isWorkspaceStopInProgress(workspaceId),
      getWorkspaceStopEpoch: (workspaceId) => this.getWorkspaceStopEpoch(workspaceId),
      sendTreeMessage: (spec) => this.sendTreeMessage(spec),
    });
    this.agentPeerMessageBroker = new AgentPeerMessageBroker({
      // Parked sends count against the recipient's queue cap like queued ones.
      countQueuedAgentPeerMessages: (targetId) =>
        workspaceService.countQueuedAgentPeerMessages(targetId) +
        this.peerSendParking.countParked(targetId),
    });
    this.waiters = new TaskWaiters({
      scheduleNotifyOnTerminalPersist: (taskId, ownerWorkspaceId) =>
        this.scheduleNotifyOnTerminalPersist(taskId, ownerWorkspaceId),
      hasQueuedMessages: (workspaceId, dispatchMode) =>
        this.workspaceService.hasQueuedMessages(workspaceId, dispatchMode),
    });
    this.terminalAttentionStore = terminalAttentionStore ?? new TerminalAttentionStore(config);
    this.workflowRunAttention = new WorkflowRunAttention({
      sessionsDir: () => this.config.sessionsDir,
      terminalAttentionStore: () => this.terminalAttentionStore,
    });
    this.terminalAttention = new TerminalAttentionNotifier({
      terminalAttentionStore: () => this.terminalAttentionStore,
      config: () => this.config,
      aiService: () => this.aiService,
      workspaceService: () => this.workspaceService,
      turnManager: () => this.getWorkspaceTurnManager(),
      // Through TaskService: the test harness wraps drainTerminalAttention on the instance.
      drain: (ownerWorkspaceId) => this.drainTerminalAttention(ownerWorkspaceId),
    });
    this.gitPatchArtifactService = new GitPatchArtifactService(config, historyService.locks);

    this.aiService.on("stream-end", (payload: unknown) => {
      if (!isStreamEndEvent(payload)) return;

      // New streams persist attribution at the stop decision. Keep this snapshot for legacy events
      // and disposable ownership transfer, before the event lock lets another input enter the queue.
      const queueCutSnapshot = this.getWorkspaceTurnManager().captureQueueCutAttributionSnapshot(
        payload.workspaceId
      );
      const taskOrigin = {
        executionId: this.getAgentTaskExecutionId(payload.workspaceId),
        stopEpoch: this.getWorkspaceStopEpoch(payload.workspaceId),
        // The attempt whose stream just ended: captured in the event's own tick, before the lock
        // wait or any handler await could let a reawakening replace it (see
        // releaseReportedTaskAttempt).
        // Without a matching owner (startup re-drive, prior-process attempt, a successor another
        // backend admitted): the attempt the stream's turn was admitted under, read in the same
        // tick (see resolveStreamAttemptAtEvent). Undefined for workspaces that are not tasks.
        ...this.resolveStreamAttemptAtEvent(payload.workspaceId),
      };
      // The decision this handler owes for the attempt's ended stream, registered in the event's
      // own tick so the session's turn-completion drain (a later microtask) finds it.
      const decision = this.streamEndLedger.registerStreamEndDecision(
        payload.workspaceId,
        payload.messageId,
        taskOrigin.ownedAttempt,
        taskOrigin.unownedAttemptId
      );
      this.streamEndLedger.runStreamEndHandler(payload, queueCutSnapshot, taskOrigin, decision);
    });

    this.aiService.on("stream-abort", (payload: unknown) => {
      if (!isStreamAbortEvent(payload)) return;

      // The aborted stream's attempt, captured in the event's own tick (before the lock wait lets
      // another writer re-admit the row): the abort's cleanup acts for that attempt only.
      const abortOrigin = this.resolveStreamAttemptAtEvent(payload.workspaceId);
      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamAbort(payload, abortOrigin);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamAbort failed", { error });
        });
    });

    this.aiService.on("error", (payload: unknown) => {
      if (!isErrorEvent(payload)) return;

      // The failing stream's attempt, captured in the event's own tick (before the lock wait lets
      // another writer re-admit the row): the error settles that attempt only.
      const errorAttemptId = this.streamAttemptIdAtEvent(payload.workspaceId);
      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleTaskStreamError(payload, errorAttemptId);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleTaskStreamError failed", { error });
        });
    });

    // Stop cascades wait on the admitted turn they captured; its owner reports settlement here.
    this.workspaceService.onWorkspaceTurnSettled((workspaceId, turnGeneration) => {
      this.recordWorkspaceTurnSettled(workspaceId, turnGeneration);
    });
    this.workspaceService.onWorkspaceTurnSuperseded((workspaceId, previous, next) => {
      this.recordWorkspaceTurnSuperseded(workspaceId, previous, next);
    });

    // Successor outcomes (withdrawn, admitted, streaming) are published as queue changes.
    this.workspaceService.onQueuedMessageChanged((workspaceId) => {
      if (!this.streamEndLedger.hasDeferral(workspaceId)) return;
      this.workspaceEventLocks
        .withLock(workspaceId, async () => {
          await this.streamEndLedger.reconcileDeferredTaskStreamEnd(workspaceId);
        })
        .catch((error: unknown) => {
          log.error("TaskService.reconcileDeferredTaskStreamEnd failed", { error });
        });
    });
  }

  setWorkspaceTurnManager(manager: WorkspaceTurnManager): void {
    this.workspaceTurnManager = manager;
  }

  private getWorkspaceTurnManager(): WorkspaceTurnManager {
    assert(this.workspaceTurnManager, "WorkspaceTurnManager is not configured");
    return this.workspaceTurnManager;
  }

  async acquireTaskCreationLock(): Promise<AsyncDisposable> {
    return await this.mutex.acquire();
  }

  setTimelineRecorder(recorder: TimelineRecorder): void {
    this.timelineRecorder = recorder;
  }

  // Prefer per-agent settings so tasks inherit the correct agent defaults;
  // fall back to legacy workspace settings for older configs.
  resolveWorkspaceAISettings(
    workspace: {
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    },
    agentId: string | undefined
  ): ResolvedWorkspaceAiSettings | undefined {
    return resolveWorkspaceAISettings(workspace, agentId);
  }

  /**
   * Parent-workspace fallback layers (unified precedence tier 7) for a spawned
   * task: the parent's bucket for the TARGET agent, then the parent's ACTIVE
   * agent bucket (the user toggles settings on the active agent, so the target
   * bucket rarely exists), then legacy workspace settings.
   */
  buildParentAiSettingsFallbacks(
    parentMeta: TaskParentAiMeta,
    targetAgentId: string
  ): AgentAiSettingsLayerValues[] {
    return buildParentAiSettingsFallbacks(parentMeta, targetAgentId);
  }

  /**
   * Delegated-run AI settings for a spawned task via the unified resolver
   * (profile "subagent"). Persistence and send options use selected values so
   * a pro preference survives temporarily non-pro models (the send path
   * re-gates per model/route); thinking uses the effective clamped level.
   * Model normalization stays gateway-preserving (see resolveAgentAiSettings):
   * the value is persisted into child workspace aiSettings and drives queued
   * follow-ups and plan->exec continuations.
   *
   * Throws InvalidExplicitAiSettingError for an invalid explicit model; call
   * sites convert it to their Err surface instead of silently running a
   * fallback model.
   */
  private async resolveTaskAISettings(params: {
    cfg: ReturnType<Config["loadConfigOrDefault"]>;
    parentWorkspaceId: string;
    parentMeta: TaskParentAiMeta;
    agentId: string;
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
    parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
    /** Checkout for definition/base-chain tiers; omit to use the implicit fallback chain. */
    definitionContext?: NodeAgentDefinitionContext;
  }): Promise<{
    taskModelString: string;
    canonicalModel: string;
    effectiveThinkingLevel: ThinkingLevel;
    effectiveReasoningMode?: OpenAIReasoningMode;
    /** Fields set by explicit arguments; persisted as taskAiPins (always an object). */
    pins: TaskAiPins;
  }> {
    const parent = findWorkspaceEntry(params.cfg, params.parentWorkspaceId)?.workspace;
    const resolved = await resolveNodeAgentAiSettings({
      agentId: params.agentId,
      profile: "subagent",
      cfg: params.cfg,
      providersConfig: this.aiService.getProvidersConfig(),
      explicit: {
        model: coerceNonEmptyString(params.modelString) ?? undefined,
        thinkingLevel: params.thinkingLevel ?? undefined,
      },
      parentWorkspaceExecSettings: resolveParentWorkspaceExecSettings(parent),
      parentRuntime: params.parentRuntimeAiSettings
        ? {
            model: coerceNonEmptyString(params.parentRuntimeAiSettings.modelString) ?? undefined,
            thinkingLevel: params.parentRuntimeAiSettings.thinkingLevel,
          }
        : undefined,
      fallbacks: this.buildParentAiSettingsFallbacks(params.parentMeta, params.agentId),
      definitionContext: params.definitionContext,
    });

    // Explicit task arguments stay pinned when an ancestor later reawakens the task.
    const pins: TaskAiPins = {
      ...(resolved.sources.model.tier === "explicit" ? { model: resolved.selected.model } : {}),
      ...(resolved.sources.thinkingLevel.tier === "explicit"
        ? { thinkingLevel: resolved.selected.thinkingLevel }
        : {}),
      ...(resolved.sources.reasoningMode?.tier === "explicit" &&
      resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
    };

    return {
      taskModelString: resolved.selected.model,
      canonicalModel: resolved.effective.model,
      effectiveThinkingLevel: resolved.effective.thinkingLevel,
      ...(resolved.selected.reasoningMode != null
        ? { effectiveReasoningMode: resolved.selected.reasoningMode }
        : {}),
      pins,
    };
  }

  /**
   * Derives auto-resume send options (agentId, model, thinkingLevel) from durable
   * conversation metadata, so synthetic resumes preserve the parent's active agent.
   *
   * Precedence: stream-end event metadata → last non-compaction assistant message in history → workspace AI settings → defaults.
   */
  private async resolveParentAutoResumeOptions(
    parentWorkspaceId: string,
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      };
    },
    fallbackModel: string,
    hint?: ParentAutoResumeHint
  ): Promise<{
    model: string;
    agentId: string;
    thinkingLevel?: ThinkingLevel;
    reasoningMode?: OpenAIReasoningMode;
    serviceTier?: ServiceTier;
  }> {
    // 1) Try stream-end hint metadata (available in handleStreamEnd path)
    // Compaction is internal bookkeeping, not an identity for resuming user work.
    let agentId = hint?.agentId === "compact" ? undefined : hint?.agentId;

    // Durable history preserves the parent identity across process restarts. The walk is
    // unbounded: synthetic rows without an agent identity (drain-appended sub-agent reports,
    // heartbeat scaffolding) can push the newest agent-bearing assistant row past any fixed
    // tail, and a truncated read would silently recompose terminal-wake sends from the exec
    // fallback, lifting a restricted agent's tool policy.
    if (!agentId) {
      const found: { agentId?: string } = {};
      await this.historyService.iterateFullHistory(parentWorkspaceId, "backward", (messages) => {
        for (const msg of messages) {
          if (
            msg.role === "assistant" &&
            typeof msg.metadata?.agentId === "string" &&
            msg.metadata.agentId.length > 0 &&
            msg.metadata.agentId !== "compact"
          ) {
            found.agentId = msg.metadata.agentId;
            return false;
          }
        }
        return undefined;
      });
      // A failed read falls through to defaults (best-effort); the terminal drain separately
      // fails closed on unreadable history via resolveTerminalWakeCallerSendRestrictions.
      agentId = found.agentId;
    }

    // 3) Default
    // Keep task auto-resume recovery on exec even if the workspace default agent changes.
    // This path needs a deterministic editing-capable fallback for legacy/incomplete metadata.
    agentId = agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;

    // Unified interactive resolution: the workspace's own bucket owns the
    // settings; configured agent defaults and the legacy workspace settings
    // fill unset fields. Reasoning passes through selected (un-gated); the
    // send path re-gates per model/route so pro is inert for unsupported models.
    const workspace = parentEntry.workspace;
    const normalizedAgentId = normalizeAgentId(agentId, "");
    const bucket = normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined;
    const resolved = await resolveNodeAgentAiSettings({
      agentId,
      profile: "interactive",
      cfg: this.config.loadConfigOrDefault(),
      providersConfig: this.aiService.getProvidersConfig(),
      targetWorkspaceSettings: bucket ? targetWorkspaceBucketToLayer(bucket) : undefined,
      fallbacks: workspace.aiSettings
        ? [
            {
              model: workspace.aiSettings.model,
              thinkingLevel: workspace.aiSettings.thinkingLevel,
              reasoningMode: coerceOpenAIReasoningMode(workspace.aiSettings.reasoningMode),
              serviceTier: ServiceTierSchema.safeParse(workspace.aiSettings.serviceTier).data,
            },
          ]
        : undefined,
      defaultModel: fallbackModel,
    });
    return {
      model: resolved.selected.model,
      agentId,
      thinkingLevel: resolved.selected.thinkingLevel,
      ...(resolved.selected.serviceTier != null
        ? { serviceTier: resolved.selected.serviceTier }
        : {}),
      ...(resolved.selected.reasoningMode != null
        ? { reasoningMode: resolved.selected.reasoningMode }
        : {}),
    };
  }

  private async isPlanLikeTaskWorkspace(entry: {
    projectPath: string;
    workspace: Pick<
      WorkspaceConfigEntry,
      "id" | "name" | "path" | "runtimeConfig" | "agentId" | "agentType" | "parentWorkspaceId"
    >;
  }): Promise<boolean> {
    assert(entry.projectPath.length > 0, "isPlanLikeTaskWorkspace: projectPath must be non-empty");

    const agentIdCandidates = resolvePersistedAgentIdCandidates(entry.workspace);
    if (agentIdCandidates.length === 0) {
      return false;
    }
    // #6426: one cached config load per call (not per candidate or per read).
    const projectPluginsTrusted = isProjectTrusted(this.config, entry.projectPath);

    const workspacePath = coerceNonEmptyString(entry.workspace.path);
    const workspaceName = coerceNonEmptyString(entry.workspace.name) ?? entry.workspace.id;
    const runtimeConfig = entry.workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    if (!workspacePath || !workspaceName) {
      return agentIdCandidates.includes("plan");
    }

    const cfg = this.config.loadConfigOrDefault();
    const runtime = createRuntimeForWorkspace({
      runtimeConfig,
      projectPath: entry.projectPath,
      name: workspaceName,
    });
    const agentDiscoveryCandidates: Array<{ runtime: Runtime; workspacePath: string }> = [
      { runtime, workspacePath },
    ];

    const parentEntry = entry.workspace.parentWorkspaceId
      ? findWorkspaceEntry(cfg, entry.workspace.parentWorkspaceId)
      : null;
    const parentWorkspaceName = coerceNonEmptyString(parentEntry?.workspace.name);
    if (parentEntry != null && parentWorkspaceName != null) {
      try {
        agentDiscoveryCandidates.push(
          createRuntimeContextForWorkspace({
            runtimeConfig: parentEntry.workspace.runtimeConfig ?? runtimeConfig,
            projectPath: parentEntry.projectPath,
            name: parentWorkspaceName,
            namedWorkspacePath: coerceNonEmptyString(parentEntry.workspace.path),
          })
        );
      } catch (error: unknown) {
        log.debug("Failed to build parent task agent-discovery runtime", {
          workspaceId: entry.workspace.id,
          parentWorkspaceId: entry.workspace.parentWorkspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const agentId of agentIdCandidates) {
      let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;
      let fallbackAgentId: string | undefined;
      for (const discovery of agentDiscoveryCandidates) {
        try {
          const agentDefinition = await readAgentDefinition(
            discovery.runtime,
            discovery.workspacePath,
            agentId,
            { projectPluginsTrusted, runtimeFactory: nodeRuntimeFactory }
          );
          const chain = await resolveAgentInheritanceChain({
            runtime: discovery.runtime,
            workspacePath: discovery.workspacePath,
            agentId: agentDefinition.id,
            agentDefinition,
            workspaceId: entry.workspace.id ?? workspaceName,
            projectPluginsTrusted,
            runtimeFactory: nodeRuntimeFactory,
          });

          if (agentDefinition.scope === "project") {
            return agentDefinition.id === "compact" ? false : isPlanLikeInResolvedChain(chain);
          }
          fallbackChain ??= chain;
          fallbackAgentId ??= agentDefinition.id;
        } catch (error: unknown) {
          log.debug("Failed to resolve task agent mode from discovery path", {
            workspaceId: entry.workspace.id,
            agentId,
            agentDiscoveryPath: discovery.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (fallbackChain != null) {
        if (fallbackAgentId === "compact") {
          return false;
        }
        return isPlanLikeInResolvedChain(fallbackChain);
      }
    }

    return agentIdCandidates.includes("plan");
  }

  async emitWorkspaceMetadata(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "emitWorkspaceMetadata: workspaceId must be non-empty");

    const metadata = await this.config.findWorkspaceMetadata(workspaceId);
    this.workspaceService.emit("metadata", { workspaceId, metadata });
  }

  private configureMultiProjectRuntimeEnvResolver(runtime: Runtime): void {
    if (!(runtime instanceof MultiProjectRuntime)) {
      return;
    }

    const projectEnvCache = new Map<string, Record<string, string>>();
    runtime.envResolver = async (runtimeProjectPath: string) => {
      const normalizedRuntimeProjectPath = stripTrailingSlashes(runtimeProjectPath);
      const cachedEnv = projectEnvCache.get(normalizedRuntimeProjectPath);
      if (cachedEnv) {
        return cachedEnv;
      }

      const projectEnv = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(normalizedRuntimeProjectPath)
      );
      projectEnvCache.set(normalizedRuntimeProjectPath, projectEnv);
      return projectEnv;
    };
  }

  private taskTreeRootId(workspaceId: string): string {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    let currentWorkspaceId = workspaceId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.warn("Task tree lifecycle lock encountered a parent cycle", { workspaceId });
        return workspaceId;
      }
      visited.add(currentWorkspaceId);
      const parentWorkspaceId = index.parentById.get(currentWorkspaceId);
      if (parentWorkspaceId == null) {
        return currentWorkspaceId;
      }
      currentWorkspaceId = parentWorkspaceId;
    }
    log.warn("Task tree lifecycle lock exceeded parent traversal depth", { workspaceId });
    return workspaceId;
  }

  async withTaskTreeLifecycleLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    assert(workspaceId.length > 0, "withTaskTreeLifecycleLock requires workspaceId");
    return await this.withTaskTreeLifecycleLocks([workspaceId], operation);
  }

  withGitPatchArtifactOperationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    assert(taskId.length > 0, "withGitPatchArtifactOperationLock requires taskId");
    return this.gitPatchArtifactService.withOperationLock(taskId, operation);
  }

  private async withTaskTreeLifecycleLocks<T>(
    workspaceIds: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const rootIds = [
      ...new Set(workspaceIds.map((workspaceId) => this.taskTreeRootId(workspaceId))),
    ]
      .filter((workspaceId) => workspaceId.length > 0)
      .sort();
    const acquire = async (index: number): Promise<T> => {
      const rootId = rootIds[index];
      if (rootId == null) {
        return await operation();
      }
      return await this.workspaceTreeLifecycleLocks.withLock(rootId, () => acquire(index + 1));
    };
    return await acquire(0);
  }

  async editWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry, config: ProjectsConfig) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "editWorkspaceEntry: workspaceId must be non-empty");

    let found = false;
    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === workspaceId);
        if (!ws) continue;
        updater(ws, config);
        found = true;
        return config;
      }

      if (options?.allowMissing) {
        return config;
      }

      throw new Error(`editWorkspaceEntry: workspace ${workspaceId} not found`);
    });

    return found;
  }

  /**
   * Restart recovery for agent tasks followed by the startup housekeeping passes. The server
   * entry point runs the two halves separately around its listener bind (see
   * ServiceContainer.initializeCore / runStartupHousekeeping); desktop startup runs them back to back.
   */
  async initialize(): Promise<void> {
    await this.recoverInterruptedTasks();
    await this.runStartupHousekeeping();
  }

  /**
   * Re-establishes the tasks that were active when the process last exited: execution-handle
   * mirrors, stale `starting` tasks, the queue drain, and the restart prompts for
   * `awaiting_report`/`running` tasks. Bounded by the number of active tasks, not by deployment
   * size. Must finish before any client can act on tasks: a stop, resume, or send racing these
   * transitions would be overwritten or would resurrect a task the client just stopped, so the
   * server binds its listener after this resolves, or once it exceeds the startup step bound
   * (ServiceContainer: a slow recovery must not keep the server down).
   *
   * Such a recovery can still be running at shutdown, so `options.signal` (aborted by dispose)
   * stops it before the queue drain and before each re-drive: work reserved or dispatched after
   * shutdown began would fail against latched services and be persisted as interrupted.
   *
   * Only the decisions belong here, never network-bound work: a large server restarted with many
   * active tasks outlived the startup step bound while awaiting each re-drive's stream startup
   * (runtime `ensureReady`, MCP servers, model creation) one task at a time, and an outlived
   * recovery overlaps early clients. So re-drive prompts return once accepted (stream startup
   * continues in the background, like the guidance replay and compaction follow-up sends), and
   * the queue drain is scheduled like any runtime drain instead of awaiting the forks, init hooks
   * and first turns it launches.
   */
  async recoverInterruptedTasks(options?: { signal?: AbortSignal }): Promise<void> {
    const startupStartedAt = Date.now();
    const startupConfig = this.config.loadConfigOrDefault();
    this.logStartupRecoveryStarting(startupConfig);

    await this.getWorkspaceTurnManager().reconcileAgentTaskExecutionIds();

    // A task that another live backend is still running holds a use lease on its workspace there
    // (a turn, init hook, MCP server, command, terminal or editor). Leave it to that backend in
    // every pass below: re-driving it here would start a duplicate execution (#4801). A launch
    // holds a "launch" lease from before its row becomes `starting`, so
    // a `starting` row in startupConfig whose launch still runs is skipped too: its lease was
    // published before this scan. Idle windows (between turns, waiting on descendants) hold no
    // lease, so this backend can still take such a task over by rotation; the attempt-bound CAS
    // fencing treats the other backend's execution as superseded.
    const inUseElsewhere = await this.findTasksInUseByOtherBackends(startupConfig);

    await this.recoverStaleStartingTasks(startupConfig, inUseElsewhere);
    await this.interruptStartupTasksOfInactiveWorkflows(inUseElsewhere);
    const candidates = this.listStartupRedriveCandidates(
      this.config.loadConfigOrDefault(),
      inUseElsewhere
    );
    const states = new Map(
      await Promise.all(
        candidates.map(
          async (task) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
            [task.id, await this.workspaceService.getStartupRecoveryState(task.id!)] as const
        )
      )
    );
    await this.settleStoppedStartupTasks(candidates, states);

    // Normalize stopped capacity before launching siblings; newly launched work is not part of
    // the recovery snapshot and must never be interrupted by an old Stop or opt-out.
    // Scheduled, not awaited: launches are ordinary runtime work that already races clients
    // (reservation is a CAS on `queued`), and the re-drives below only touch snapshot candidates.
    if (startupRecoveryCancelled(options, "queue-drain")) return;
    // The drain sweeps stale workspace turns even with an empty queue (see the field's comment).
    this.staleTurnSweepRequestedGeneration += 1;
    this.scheduleMaybeStartQueuedTasks();

    const snapshot = this.loadStartupRecoverySnapshot(inUseElsewhere, states);
    const tally: StartupRecoveryTally = {
      resumedAwaitingReportCount: 0,
      skippedAwaitingReportDueToActiveDescendants: 0,
      skippedAwaitingReportAlreadyBusy: 0,
      failedAwaitingReportCount: 0,
      resumedRunningCount: 0,
      skippedRunningDueToActiveDescendants: 0,
      skippedRunningAlreadyStreaming: 0,
      failedRunningCount: 0,
    };

    for (const task of snapshot.awaitingReportTasks) {
      if (!task.id) continue;
      if (startupRecoveryCancelled(options, "awaiting-report")) return;
      await this.resumeAwaitingReportTask(task.id, task, snapshot, tally);
    }

    for (const task of snapshot.runningTasks) {
      if (!task.id) continue;
      if (startupRecoveryCancelled(options, "running")) return;
      await this.resumeRunningTask(task.id, task, snapshot, tally);
    }

    log.info("[startup] TaskService.recoverInterruptedTasks completed", {
      totalMs: Date.now() - startupStartedAt,
      skippedInUseElsewhereCount: inUseElsewhere.size,
      awaitingReportTaskCount: snapshot.awaitingReportTasks.length,
      resumedAwaitingReportCount: tally.resumedAwaitingReportCount,
      skippedAwaitingReportDueToActiveDescendants:
        tally.skippedAwaitingReportDueToActiveDescendants,
      skippedAwaitingReportAlreadyBusy: tally.skippedAwaitingReportAlreadyBusy,
      failedAwaitingReportCount: tally.failedAwaitingReportCount,
      runningTaskCount: snapshot.runningTasks.length,
      resumedRunningCount: tally.resumedRunningCount,
      skippedRunningDueToActiveDescendants: tally.skippedRunningDueToActiveDescendants,
      skippedRunningAlreadyStreaming: tally.skippedRunningAlreadyStreaming,
      failedRunningCount: tally.failedRunningCount,
    });
  }

  /** Logs the start of recoverInterruptedTasks with the number of queued tasks it found. */
  private logStartupRecoveryStarting(startupConfig: ProjectsConfig): void {
    const queuedTaskCountAtStartup = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) => task.taskStatus === "queued" && typeof task.id === "string"
    ).length;

    log.info("[startup] TaskService.recoverInterruptedTasks starting", {
      queuedTaskCountAtStartup,
    });
  }

  /**
   * Requeues the `starting` rows of startupConfig that no other backend uses: a launch that the
   * previous process left there. A row whose stream is still live becomes `running` instead.
   */
  private async recoverStaleStartingTasks(
    startupConfig: ProjectsConfig,
    inUseElsewhere: ReadonlySet<string>
  ): Promise<void> {
    const staleStartingTasks = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) =>
        task.taskStatus === "starting" &&
        typeof task.id === "string" &&
        !inUseElsewhere.has(task.id)
    );
    if (staleStartingTasks.length > 0) {
      let acceptedPromptCount = 0;
      for (const task of staleStartingTasks) {
        assert(task.id != null && task.id.length > 0, "stale starting task id is required");
        const isStreaming = this.aiService.isStreaming(task.id);
        const acceptedPrompt = !isStreaming && (await this.hasAcceptedInitialTaskPrompt(task));
        if (acceptedPrompt) acceptedPromptCount += 1;
        await this.requeueStaleStartingTask(task.id, task, isStreaming, acceptedPrompt);
      }
      log.info("[startup] Recovered stale starting agent tasks", {
        count: staleStartingTasks.length,
        acceptedPromptCount,
      });
    }
  }

  /**
   * Requeues one stale `starting` row under the attempt the lease scan judged (`task`, the
   * startupConfig row). A failed write marks the task's launch failed.
   */
  private async requeueStaleStartingTask(
    taskId: string,
    task: AgentTaskWorkspaceEntry,
    isStreaming: boolean,
    acceptedPrompt: boolean
  ): Promise<void> {
    try {
      await this.editActiveWorkspaceEntry(
        taskId,
        (workspace) => {
          if (workspace.taskStatus !== "starting") return;
          // Only the reservation the lease scan judged: a row re-admitted under a new attempt
          // since is that launch's, and its lease was published after the scan.
          if (workspace.taskAttemptId !== task.taskAttemptId) return;
          workspace.taskStatus = isStreaming ? "running" : "queued";
          // A `starting` entry found at startup may already have an admitted execution in
          // another process. The relaunch would otherwise look exactly like a never-launched
          // reservation, so mark the lineage unproven: the drain's launcher owns it in memory
          // but can never vouch for it across processes.
          workspace.taskAttemptUnproven = true;
          // History already owns accepted prompts; do not duplicate them on restart.
          if (acceptedPrompt) {
            workspace.taskPrompt = undefined;
            workspace.taskPromptSendId = undefined;
          }
        },
        { allowMissing: true }
      );
    } catch (error) {
      await this.markTaskLaunchFailed(taskId, getErrorMessage(error));
    }
  }

  /**
   * Startup prepass: interrupts the recovery of every active task whose workflow owner is
   * inactive, before any task is settled or re-driven.
   */
  private async interruptStartupTasksOfInactiveWorkflows(
    inUseElsewhere: ReadonlySet<string>
  ): Promise<void> {
    const config = this.config.loadConfigOrDefault();
    const taskIndex = this.buildAgentTaskIndex(config);
    // Workflow cancellation is authoritative even when a child has its own Stop or question, and
    // for archived rows too: a cancelled run's archived child must not stay active until unarchive.
    const activeTasks = this.listAgentTaskWorkspaces(config).filter((task) =>
      isActiveStartupTask(task, inUseElsewhere)
    );
    for (const task of activeTasks) {
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        task.id!,
        config,
        "startup-inactive-workflow-owner-prepass",
        taskIndex,
        { scheduleQueueDrain: false }
      );
    }
  }

  /** The rows startup recovery re-drives (see isStartupRedriveCandidate). */
  private listStartupRedriveCandidates(
    config: ProjectsConfig,
    inUseElsewhere: ReadonlySet<string>
  ): AgentTaskWorkspaceEntry[] {
    return this.listAgentTaskWorkspaces(config).filter((task) =>
      isStartupRedriveCandidate(task, inUseElsewhere)
    );
  }

  /** Stops each `stopped` candidate that is neither streaming nor busy, under its tree lock. */
  private async settleStoppedStartupTasks(
    candidates: readonly AgentTaskWorkspaceEntry[],
    states: StartupRecoverySnapshot["states"]
  ): Promise<void> {
    for (const task of candidates) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const id = task.id!;
      if (states.get(id) !== "stopped") continue;
      await this.withTaskTreeLifecycleLock(id, async () => {
        if (this.aiService.isStreaming(id) || this.workspaceService.isBusyForMessage(id)) return;
        const stopped = await this.stopDescendantAgentTaskUnderLifecycleLock(
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
          task.parentWorkspaceId!,
          id,
          false
        );
        if (!stopped.success) throw new Error(stopped.error);
      }).catch((error: unknown) => {
        log.warn("Failed to settle stopped task on startup", { taskId: id, error });
      });
    }
  }

  /**
   * The recovery snapshot of the re-drives: config re-read after the queue drain, and the
   * eligible candidates split into awaiting-report and running re-drives.
   */
  private loadStartupRecoverySnapshot(
    inUseElsewhere: ReadonlySet<string>,
    states: StartupRecoverySnapshot["states"]
  ): StartupRecoverySnapshot {
    // Recovery awaits and queue draining can change task status: re-read before replaying intent.
    const config = this.config.loadConfigOrDefault();
    const taskIndex = this.buildAgentTaskIndex(config);
    const eligible = this.listStartupRedriveCandidates(config, inUseElsewhere).filter(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      (task) => states.has(task.id) && !["blocked", "stopped"].includes(states.get(task.id)!)
    );
    const awaitingReportTasks = eligible.filter(
      (task) => task.taskStatus === "awaiting_report" && states.get(task.id) !== "question"
    );
    const runningTasks = eligible.filter(
      (task) => (task.taskStatus ?? "running") === "running" || states.get(task.id) === "question"
    );
    return { config, taskIndex, states, awaitingReportTasks, runningTasks };
  }

  /**
   * Admits one startup re-drive: the desktop admits it, no inactive workflow owns the task, and
   * its live row still has the status of the recovery snapshot.
   */
  private async admitStartupRecovery(
    task: AgentTaskWorkspaceEntry,
    reason: string,
    snapshot: StartupRecoverySnapshot
  ): Promise<boolean> {
    if (
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      !(await this.admitTaskDesktopRecovery(task.id!)) ||
      (await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        task.id!,
        snapshot.config,
        reason,
        snapshot.taskIndex
      ))
    )
      return false;
    // Earlier recovery awaits can finish other candidates; verify live status at each dispatch.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
    const latest = findWorkspaceEntry(this.config.loadConfigOrDefault(), task.id!)?.workspace;
    return latest != null && latest.taskStatus === task.taskStatus;
  }

  /**
   * Startup re-drive of one `awaiting_report` task: its compaction follow-up, else the prompt for
   * its required completion tool. Each early return below was a `continue` of
   * recoverInterruptedTasks' awaiting-report loop.
   */
  private async resumeAwaitingReportTask(
    taskId: string,
    task: AgentTaskWorkspaceEntry,
    snapshot: StartupRecoverySnapshot,
    tally: StartupRecoveryTally
  ): Promise<void> {
    if (!(await this.admitStartupRecovery(task, "startup-awaiting-report", snapshot))) return;
    if (this.skipActiveAwaitingReportTask(taskId, snapshot.taskIndex, tally)) return;

    // Admission classification: startup re-drive = new UNOWNED attempt (rotate + mark) before
    // the first send below; the sends are then fenced against the fresh id at the handoff.
    // Guarded by the recovery snapshot (`task`), not a re-read: a row that moved meanwhile was
    // admitted or stopped by another writer and must not be re-driven.
    // Retry a goal pause the previous process owed before re-driving the task.
    await this.settleChildGoalPause(taskId);
    const rotatedAttemptId = await this.rotateAttemptForStartupRedrive(taskId, task);
    if (rotatedAttemptId == null) {
      tally.failedAwaitingReportCount += 1;
      return;
    }
    const followUp = await this.dispatchFencedStartupCompactionFollowUp(taskId, rotatedAttemptId);
    if (!followUp.success) tally.failedAwaitingReportCount += 1;
    else if (followUp.data) tally.resumedAwaitingReportCount += 1;
    if (!followUp.success || followUp.data) return;
    await this.promptStartupAwaitingReportCompletion(taskId, rotatedAttemptId, tally);
  }

  /** Counts and skips an awaiting_report task that has blocking active descendants or is busy. */
  private skipActiveAwaitingReportTask(
    taskId: string,
    taskIndex: AgentTaskIndex,
    tally: StartupRecoveryTally
  ): boolean {
    // Avoid resuming a task while it still has blocking active descendants (it shouldn't report yet).
    const hasBlockingActiveDescendants =
      this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, taskId).length > 0;
    if (hasBlockingActiveDescendants) {
      tally.skippedAwaitingReportDueToActiveDescendants += 1;
      return true;
    }
    // A busy session already owns a turn (e.g. an earlier pass's background completion prompt
    // still preparing, not yet streaming): rotating would hand its result to a superseded
    // attempt. Its stream end re-enters completion recovery.
    if (this.workspaceService.isBusyForMessage(taskId)) {
      tally.skippedAwaitingReportAlreadyBusy += 1;
      return true;
    }
    return false;
  }

  /** Prompts for the required completion tool, fenced to the task's rotated attempt. */
  private async promptStartupAwaitingReportCompletion(
    taskId: string,
    rotatedAttemptId: string,
    tally: StartupRecoveryTally
  ): Promise<void> {
    // The completion prompt is fenced to the attempt this decision rotated, like every other
    // startup send: bound here (refused once another writer's attempt owns the row) and carried
    // through the prompt helper's own awaits as its token, so a rotation landing during them
    // refuses the send at the gates instead of the handoff adopting the successor.
    const completionAdmission = this.admitTaskWorkspaceTurn(taskId, {
      acceptanceOrigin: "automatic",
      expectedAttemptId: rotatedAttemptId,
    });
    if (completionAdmission.kind !== "admitted") {
      tally.failedAwaitingReportCount += 1;
      return;
    }
    const resumed = await this.promptTaskForRequiredCompletionTool(taskId, {
      reason: "startup",
      fence: { turnAdmission: completionAdmission.token, attemptId: rotatedAttemptId },
      // The fence carries the attempt (see the option's doc).
      expectedAttemptId: null,
    });
    if (!resumed) {
      tally.failedAwaitingReportCount += 1;
      return;
    }

    tally.resumedAwaitingReportCount += 1;
  }

  /**
   * Startup re-drive of one `running` task (or one with a pending question). Returns without a
   * send when the task has nothing to re-drive: each skip below was a `continue` of
   * recoverInterruptedTasks' running loop.
   */
  private async resumeRunningTask(
    taskId: string,
    task: AgentTaskWorkspaceEntry,
    snapshot: StartupRecoverySnapshot,
    tally: StartupRecoveryTally
  ): Promise<void> {
    if (!(await this.admitStartupRecovery(task, "startup-running", snapshot))) return;
    const pendingGuidance = task.taskPendingGuidance ?? [];
    const queueOnly = snapshot.states.get(taskId) === "question";
    if (queueOnly && pendingGuidance.length === 0) return;
    // A busy session counts as active: re-drive sends return once accepted, so an earlier
    // recovery pass's nudge can still be preparing (not yet streaming) when this pass runs.
    const alreadyStreaming =
      this.aiService.isStreaming(taskId) || this.workspaceService.isBusyForMessage(taskId);
    const redrive = { taskId, task, pendingGuidance, queueOnly, alreadyStreaming };
    if (this.skipActiveRunningTask(redrive, snapshot.taskIndex, tally)) return;
    // Decided before the attempt rotation below: that rotation writes the whole config file,
    // and a large config with many legacy rows outlived the startup step bound (#6511).
    if (isIdleLegacyStartupTask(task, snapshot.states.get(taskId), pendingGuidance.length)) return;
    await this.rotateAndFollowUpRunningTask(redrive, snapshot, tally);
  }

  /**
   * Counts and skips a running task without guidance to queue that is already streaming or
   * waits on blocking active descendants.
   */
  private skipActiveRunningTask(
    redrive: RunningTaskRedrive,
    taskIndex: AgentTaskIndex,
    tally: StartupRecoveryTally
  ): boolean {
    const { taskId, pendingGuidance, alreadyStreaming } = redrive;
    // Guidance must queue even for active tasks; generic restart nudges must not.
    if (alreadyStreaming && pendingGuidance.length === 0) {
      tally.skippedRunningAlreadyStreaming += 1;
      return true;
    }
    const hasBlockingActiveDescendants =
      this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, taskId).length > 0;
    if (hasBlockingActiveDescendants && pendingGuidance.length === 0) {
      tally.skippedRunningDueToActiveDescendants += 1;
      return true;
    }
    return false;
  }

  /**
   * Rotates a running task's attempt for its re-drive and restores its compaction intent, then
   * sends the rest of the re-drive fenced to the rotated attempt.
   */
  private async rotateAndFollowUpRunningTask(
    redrive: RunningTaskRedrive,
    snapshot: StartupRecoverySnapshot,
    tally: StartupRecoveryTally
  ): Promise<void> {
    const { taskId, task } = redrive;
    // Admission classification: startup re-drive (compaction follow-up, guidance replay or the
    // restart nudge) = new UNOWNED attempt; rotate + mark once before the first send, guarded
    // by the recovery snapshot (`task`) like the awaiting-report re-drive above.
    // Retry a goal pause the previous process owed before re-driving the task.
    await this.settleChildGoalPause(taskId);
    const rotatedAttemptId = await this.rotateAttemptForStartupRedrive(taskId, task);
    if (rotatedAttemptId == null) {
      tally.failedRunningCount += 1;
      return;
    }

    // Restore compaction intent before new guidance/nudges make its tail stale.
    // Guidance then queues behind that continuation without losing either payload.
    const followUp =
      redrive.alreadyStreaming || redrive.queueOnly
        ? Ok(false)
        : await this.dispatchFencedStartupCompactionFollowUp(taskId, rotatedAttemptId);
    if (tallyRunningFollowUp(followUp, redrive.pendingGuidance.length, tally)) return;
    await this.sendFencedRunningTaskRedrive(redrive, rotatedAttemptId, snapshot, tally);
  }

  /**
   * Fences the guidance replay or restart nudge of a running task's re-drive to its rotated
   * attempt, then sends it.
   */
  private async sendFencedRunningTaskRedrive(
    redrive: RunningTaskRedrive,
    rotatedAttemptId: string,
    snapshot: StartupRecoverySnapshot,
    tally: StartupRecoveryTally
  ): Promise<void> {
    const { task } = redrive;
    // Every further send of this decision is fenced to the attempt rotated for it: bound here
    // (refused once another writer's attempt owns the row) and carried as the send's token, so
    // the handoff never adopts a successor and a Stop captures the obligation.
    const startupTaskId = redrive.taskId;
    const fenceStartupSend = (): TurnAdmissionToken | undefined => {
      const admission = this.admitTaskWorkspaceTurn(startupTaskId, {
        acceptanceOrigin: "automatic",
        expectedAttemptId: rotatedAttemptId,
      });
      return admission.kind === "admitted" ? admission.token : undefined;
    };
    const model = task.taskModelString ?? defaultModel;
    const agentId = resolveTaskAgentIdForResume(task);
    const sendOptions = {
      model,
      agentId,
      thinkingLevel: task.taskThinkingLevel,
      reasoningMode: coerceOpenAIReasoningMode(task.aiSettings?.reasoningMode),
      serviceTier: ServiceTierSchema.safeParse(
        resolveWorkspaceAISettings(task, agentId)?.serviceTier
      ).data,
    };
    const send: FencedRunningTaskRedrive = { ...redrive, fenceStartupSend, sendOptions };
    if (redrive.pendingGuidance.length > 0) {
      await this.replayStartupPendingGuidance(send, tally);
      return;
    }
    await this.sendStartupRestartNudge(send, snapshot, tally);
  }

  /** Replays a running task's pending guidance in order; the first failed send ends the replay. */
  private async replayStartupPendingGuidance(
    send: FencedRunningTaskRedrive,
    tally: StartupRecoveryTally
  ): Promise<void> {
    const { taskId, task, queueOnly, fenceStartupSend, sendOptions } = send;
    let sendResult: Result<void, SendMessageError> = Ok(undefined);
    for (const guidance of send.pendingGuidance) {
      const token = fenceStartupSend();
      if (token == null) {
        sendResult = Err({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE });
        break;
      }
      sendResult = await this.workspaceService.sendMessage(
        taskId,
        `Updated guidance from parent:\n\n${guidance.message}`,
        { ...sendOptions, queueDispatchMode: guidance.queueDispatchMode },
        {
          ...this.taskGuidanceSendOptions(taskId, guidance.id, task.taskStatus ?? "running"),
          restoreQueued: queueOnly,
          turnAdmission: token,
          admissionStale: () => token.admissionStale(),
        }
      );
      if (!sendResult.success) break;
    }
    if (!sendResult.success) {
      tally.failedRunningCount += 1;
      log.error("Failed to replay pending task guidance on startup", {
        taskId,
        error: sendResult.error,
      });
      return;
    }
    tally.resumedRunningCount += 1;
  }

  /** Sends the restart nudge of a running task's re-drive. */
  private async sendStartupRestartNudge(
    send: FencedRunningTaskRedrive,
    snapshot: StartupRecoverySnapshot,
    tally: StartupRecoveryTally
  ): Promise<void> {
    const { taskId, task, fenceStartupSend, sendOptions } = send;
    // Legacy tasks lack active-status evidence. Durable compaction/guidance above still wins.
    if (lacksLegacyRestartEvidence(task, snapshot.states.get(taskId))) return;
    const isPlanLike = await this.isPlanLikeTaskWorkspace({
      projectPath: task.projectPath,
      workspace: task,
    });

    const logContext = {
      taskId,
      taskName: task.name,
      projectPath: task.projectPath,
      model: sendOptions.model,
      agentId: sendOptions.agentId,
      isPlanLike,
    };
    log.info("[startup] Resuming running task", logContext);
    const resumeStartedAt = Date.now();
    const restartCompletionInstruction = isPlanLike
      ? "When you have a final plan, call propose_plan exactly once."
      : "When you have a final answer, return it in your final assistant message.";
    const nudgeToken = fenceStartupSend();
    const sendResult =
      nudgeToken == null
        ? Err<SendMessageError>({ type: "unknown", raw: SEND_ADMISSION_STALE_MESSAGE })
        : await this.workspaceService.sendMessage(
            taskId,
            "Xum restarted while this task was running. Continue where you left off. " +
              restartCompletionInstruction,
            sendOptions,
            {
              acceptanceOrigin: "automatic",
              synthetic: true,
              agentInitiated: true,
              taskTurnKind: "recovery",
              // Accepted is enough; stream startup must not gate the listener (see
              // recoverInterruptedTasks' doc).
              startStreamInBackground: true,
              turnAdmission: nudgeToken,
              admissionStale: () => nudgeToken.admissionStale(),
            }
          );
    const durationMs = Date.now() - resumeStartedAt;
    if (!sendResult.success) {
      tally.failedRunningCount += 1;
      log.error("Failed to resume running task on startup", {
        ...logContext,
        durationMs,
        error: sendResult.error,
      });
      return;
    }

    tally.resumedRunningCount += 1;
    log.info("[startup] Resumed running task", { ...logContext, durationMs });
  }

  /**
   * Startup passes over every reported task and session directory: pending patch-artifact
   * generation, reported-task cleanup, workflow garbage sweeps, and terminal-attention delivery.
   * Scales with deployment size, so the server runs it after its listener is bound. Clients may
   * therefore already be acting: every step re-checks live state before it mutates, and
   * `options.signal` (aborted by dispose) stops the pass at the next step boundary so teardown
   * neither waits for nor races housekeeping against disposed services.
   */
  async runStartupHousekeeping(options?: { signal?: AbortSignal }): Promise<void> {
    const startupStartedAt = Date.now();
    const cancelled = (): boolean => options?.signal?.aborted === true;
    const config = this.config.loadConfigOrDefault();

    // Restart-safety for git patch artifacts:
    // - If xum crashed mid-generation, patch artifacts can be left "pending".
    // - Completed tasks can be stranded in config until cleanup runs again, so restart should
    //   resume artifact generation and re-run the deletion pass.
    const completedReportTasks = this.listAgentTaskWorkspaces(config).filter(
      (task) => hasCompletedAgentReport(task) && typeof task.id === "string" && task.id.length > 0
    );

    const patchGenerationRecoveryStartedAt = Date.now();
    const patchArtifactsByParent = new Map<
      string,
      Awaited<ReturnType<typeof readSubagentGitPatchArtifactsFile>>
    >();
    for (const task of completedReportTasks) {
      if (cancelled()) return;
      if (!task.parentWorkspaceId) continue;
      // Archived checkouts may be absent; recover their artifacts after unarchive restores them.
      if (isWorkspaceArchived(task.archivedAt, task.unarchivedAt)) continue;
      // A reported task that is streaming again (a client reactivated it) may be committing;
      // the continuation refresh that runs when that turn ends generates its artifact.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      if (this.aiService.isStreaming(task.id!)) continue;
      try {
        let artifacts = patchArtifactsByParent.get(task.parentWorkspaceId);
        if (!artifacts) {
          artifacts = await readSubagentGitPatchArtifactsFile(
            path.join(this.config.sessionsDir, task.parentWorkspaceId)
          );
          patchArtifactsByParent.set(task.parentWorkspaceId, artifacts);
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        const artifact = artifacts.artifactsByChildTaskId[task.id!];
        if (artifact != null && artifact.status !== "pending") continue;

        // Pass the loop snapshot: reloading config.json per reported task made this pass scale
        // with (reported tasks x config size) on large deployments.
        await this.gitPatchArtifactService.maybeStartGeneration(
          task.parentWorkspaceId,
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
          task.id!,
          (wsId) => this.requestReportedTaskCleanupRecheck(wsId),
          { config }
        );
      } catch (error: unknown) {
        log.error("Failed to resume subagent git patch generation on startup", {
          parentWorkspaceId: task.parentWorkspaceId,
          childWorkspaceId: task.id,
          error,
        });
      }
    }
    const patchGenerationRecoveryMs = Date.now() - patchGenerationRecoveryStartedAt;

    // Restart-safety for grouped best-of completion: if child report artifacts already exist
    // on disk after a restart, there may be no later child stream-end to finalize the pending
    // parent task tool call. Re-run the deferred parent delivery/finalization pass first so
    // cleanup rechecks do not stay blocked forever behind a stale input-available partial.
    // A parent turn (client or resumed child) may start meanwhile; the finalization write is a
    // compare-and-set on the partial's identity, so it never lands on a live turn's partial.
    if (cancelled()) return;
    const bestOfRecoveryStartedAt = Date.now();
    const bestOfParentWorkspaceIds = new Set<string>();
    for (const task of completedReportTasks) {
      const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
      const taskId = coerceNonEmptyString(task.id);
      const bestOf = taskId ? this.getEffectiveTaskGroup(taskId, task) : undefined;
      if (!parentWorkspaceId || (bestOf?.total ?? 1) <= 1) {
        continue;
      }
      if (this.aiService.isStreaming(parentWorkspaceId)) {
        continue;
      }
      bestOfParentWorkspaceIds.add(parentWorkspaceId);
    }
    for (const parentWorkspaceId of bestOfParentWorkspaceIds) {
      if (cancelled()) return;
      await this.deliverDeferredBestOfReportsForParent(parentWorkspaceId);
    }
    const bestOfRecoveryMs = Date.now() - bestOfRecoveryStartedAt;

    // Best-effort completed-report ancestor recheck after restart.
    const cleanupReportedTasksStartedAt = Date.now();
    // Reuse one config snapshot across tasks to screen out the (usual) ineligible majority without
    // a config parse each; reload it only after a removal changed the tree. The snapshot never
    // decides a deletion: canCleanupReportedTask re-evaluates any positive verdict on fresh config,
    // since clients may have reactivated or re-parented a task since the snapshot.
    let cleanupConfig = config;
    for (const task of completedReportTasks) {
      if (cancelled()) return;
      if (!task.id) continue;
      const removedCount = await this.cleanupReportedLeafTask(task.id, { config: cleanupConfig });
      if (removedCount > 0) {
        cleanupConfig = this.config.loadConfigOrDefault();
      }
    }
    const cleanupReportedTasksMs = Date.now() - cleanupReportedTasksStartedAt;
    if (cancelled()) return;

    // Startup self-heal for leftover workflow task garbage: interrupted-without-report
    // workflow-owned children of inactive runs (both the ones the prepass above just
    // interrupted and historical leftovers) are archived out of the active sidebar.
    // Startup-time rule: never crash the app — archive failures are logged and retried
    // on the next launch.
    try {
      await this.archiveLeftoverTasksOfInactiveWorkflowRuns();
    } catch (error: unknown) {
      log.error("Startup workflow task archive sweep failed", { error });
    }

    if (cancelled()) return;
    let queuedTerminalWorkflowRunAttentionCount = 0;
    try {
      queuedTerminalWorkflowRunAttentionCount = await this.sweepWorkflowRunTerminalAttention();
    } catch (error: unknown) {
      // Startup-time initialization must never crash the app; the interval sweep retries.
      log.warn("Startup workflow terminal attention sweep failed", { error });
    }
    if (this.workflowAttentionSweepTimer == null) {
      this.workflowAttentionSweepTimer = setInterval(() => {
        void this.sweepWorkflowRunTerminalAttention().catch((error: unknown) => {
          log.warn("Workflow terminal attention sweep failed", { error });
        });
        void this.schedulePendingTerminalAttentionOwnerDrains().catch((error: unknown) => {
          log.warn("Pending terminal attention re-poke failed", { error });
        });
      }, WORKFLOW_TERMINAL_ATTENTION_SWEEP_INTERVAL_MS);
      this.workflowAttentionSweepTimer.unref?.();
    }
    if (cancelled()) return;
    await this.getWorkspaceTurnManager().resolveOrphanedDelegatedTargets();
    const recoveredTerminalWorkspaceTurnNotificationCount =
      await this.getWorkspaceTurnManager().recoverTerminalWorkspaceTurnAttentionNotifications();
    const terminalAttentionDrainStartedAt = Date.now();
    const pendingTerminalAttentionOwnerWorkspaceCount =
      await this.schedulePendingTerminalAttentionOwnerDrains();
    const terminalAttentionDrainMs = Date.now() - terminalAttentionDrainStartedAt;

    const totalMs = Date.now() - startupStartedAt;
    const completedPayload = {
      totalMs,
      completedReportTaskCount: completedReportTasks.length,
      patchGenerationRecoveryMs,
      bestOfParentRecoveryCount: bestOfParentWorkspaceIds.size,
      bestOfRecoveryMs,
      queuedTerminalWorkflowRunAttentionCount,
      recoveredTerminalWorkspaceTurnNotificationCount,
      pendingTerminalAttentionOwnerWorkspaceCount,
      terminalAttentionDrainMs,
      cleanupReportedTasksMs,
    };
    if (totalMs > SLOW_STARTUP_WARN_THRESHOLD_MS) {
      log.warn("[startup] TaskService.runStartupHousekeeping completed", completedPayload);
    } else {
      log.info("[startup] TaskService.runStartupHousekeeping completed", completedPayload);
    }
  }

  /** Active tasks whose workspace another live backend holds a use lease on (see recovery). */
  private async findTasksInUseByOtherBackends(config: ProjectsConfig): Promise<Set<string>> {
    const leases = workspaceUseLeasesFor(this.config);
    const inUse = new Set<string>();
    const candidates = this.listAgentTaskWorkspaces(config).filter(
      (task) =>
        typeof task.id === "string" &&
        ["starting", "running", "awaiting_report"].includes(task.taskStatus ?? "running")
    );
    await Promise.all(
      candidates.map(async (task) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        const taskId = task.id!;
        const use = await leases.findForeignUse(taskId);
        if (use == null) return;
        inUse.add(taskId);
        log.info("[startup] task skipped: another Xum backend is using its workspace", {
          taskId,
          kind: use.kind,
          holder: use.holder,
        });
      })
    );
    return inUse;
  }

  /**
   * Whether history already holds the task's initial brief. A row with a brief send id
   * (taskPromptSendId) is decided by that id alone. Rows written before brief send ids keep the
   * older test: any user row since the latest boundary.
   */
  private async hasAcceptedInitialTaskPrompt(task: WorkspaceConfigEntry): Promise<boolean> {
    const workspaceId = task.id;
    assert(
      workspaceId != null && workspaceId.length > 0,
      "hasAcceptedInitialTaskPrompt: workspaceId must be non-empty"
    );
    const prompt = coerceNonEmptyString(task.taskPrompt);
    if (prompt != null && task.taskPromptSendId != null) {
      return this.isTaskBriefInHistory(workspaceId, prompt, task.taskPromptSendId);
    }

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      log.warn("Failed to inspect task history during stale starting recovery", {
        workspaceId,
        error: historyResult.error,
      });
      return false;
    }

    return historyResult.data.some((message) => message.role === "user");
  }

  /**
   * Whether a readable history row (archive included) carries the brief's send id with the
   * brief's payload, read under the history write lock. The row is the
   * only acceptance evidence: a send's result and its onAccepted callback both miss a send whose
   * rows became durable before it failed. Only that proof drops the kept prompt. A line that names
   * the id but cannot be read back (providers never see it), a row with another payload, or a
   * failed lookup count as absent: the brief is sent again rather than lost (the behavior before
   * brief send ids).
   */
  private async isTaskBriefInHistory(
    workspaceId: string,
    prompt: string,
    sendId: string
  ): Promise<boolean> {
    const decision = await this.historyService.decideSendIds(workspaceId, [
      taskBriefSendIdentity(prompt, sendId),
    ]);
    if (!decision.success) {
      log.warn("Failed to look up a task brief's send id; treating the brief as unsent", {
        workspaceId,
        error: decision.error,
      });
      return false;
    }
    if (decision.data.kind === "refused") {
      log.warn(
        "Task brief send id found on a row that does not prove the brief; sending it again",
        {
          workspaceId,
          reason: decision.data.reason,
        }
      );
    }
    return decision.data.kind === "already-accepted";
  }

  /**
   * Before a reawakening prepends a kept taskPrompt: drop it when a history row already carries
   * its brief's send id (the launch's send accepted it, then failed or was stopped before
   * `running`). Rows without a brief send id keep the older behavior: the kept prompt is sent.
   * Only while no launch or turn of the task is in flight on any backend (its "launch" or "turn"
   * use lease) and no Stop is in progress here: a send in flight can roll its row back after this
   * lookup saw it (a Stop on the backend that runs it), which would lose the brief. With a lease
   * held, the kept prompt stays and is sent again, as before brief send ids.
   */
  private async dropKeptTaskPromptAlreadyInHistory(taskId: string): Promise<void> {
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId)?.workspace;
    const prompt = coerceNonEmptyString(workspace?.taskPrompt);
    const sendId = workspace?.taskPromptSendId;
    if (prompt == null || sendId == null) return;
    if (workspace?.taskStatus !== "interrupted" && workspace?.taskStatus !== "reported") return;
    if (this.isWorkspaceStopInProgress(taskId) || this.aiService.isStreaming(taskId)) return;
    // Cross-process: the launching backend holds this lease until its send (and any rollback of
    // the send's rows) has returned. No launch starts for an inactive row, so none can begin
    // after this check.
    if (await workspaceUseLeasesFor(this.config).isHeld(taskId, "launch")) return;
    if (!(await this.isTaskBriefInHistory(taskId, prompt, sendId))) return;
    // A reawakening's send carries a brief id too (#5544), and it can run on another backend, where
    // a Stop can still roll its row back. Its session publishes its "turn" lease before the row
    // is written and releases it once the send has settled, so: the row was seen, then no turn is
    // live, then the row is still there. Only then is it permanent. A turn started after the
    // config read above carries a newer id, which the edit below refuses.
    if (await workspaceUseLeasesFor(this.config).isHeld(taskId, "turn")) return;
    if (!(await this.isTaskBriefInHistory(taskId, prompt, sendId))) return;
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        // Only the prompt this lookup decided on: a rewrite since then belongs to its writer.
        if (ws.taskPromptSendId !== sendId || ws.taskPrompt !== workspace?.taskPrompt) return;
        ws.taskPrompt = undefined;
        ws.taskPromptSendId = undefined;
      },
      { allowMissing: true }
    );
  }

  private startWorkspaceInit(workspaceId: string, projectPath: string): InitLogger {
    assert(workspaceId.length > 0, "startWorkspaceInit: workspaceId must be non-empty");
    assert(projectPath.length > 0, "startWorkspaceInit: projectPath must be non-empty");

    this.initStateManager.startInit(workspaceId, projectPath);
    return {
      logStep: (message: string) =>
        this.initStateManager.appendOutput(workspaceId, message, false, true),
      logProgress: (label: string, percent: number) =>
        this.initStateManager.reportProgress(workspaceId, label, percent),
      logStdout: (line: string) => this.initStateManager.appendOutput(workspaceId, line, false),
      logStderr: (line: string) => this.initStateManager.appendOutput(workspaceId, line, true),
      logComplete: (exitCode: number) => void this.initStateManager.endInit(workspaceId, exitCode),
      enterHookPhase: () => this.initStateManager.enterHookPhase(workspaceId),
    };
  }

  private resolveTaskDesktopOwner(args: TaskCreateArgs, agentId: string): string | undefined {
    const desktop = args.desktop ?? (agentId === "desktop" ? "shared" : "isolated");
    if (desktop !== "shared") return undefined;
    if (args.bestOf != null && args.bestOf.total > 1) {
      throw new Error("Shared desktop tasks cannot use best-of groups; use desktop: isolated");
    }
    return this.desktopInputCoordinator.resolveTarget(args.parentWorkspaceId).ownerWorkspaceId;
  }

  private async admitTaskDesktopRecovery(taskId: string): Promise<boolean> {
    try {
      await this.desktopInputCoordinator.withAdmission(taskId, () => Promise.resolve(undefined));
      return true;
    } catch (error) {
      await this.markTaskLaunchFailed(taskId, getErrorMessage(error));
      return false;
    }
  }

  private async editActiveWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    // Admission protects only persistence. Never hold the desktop gate across nested sends.
    return await this.desktopInputCoordinator.withAdmission(workspaceId, () =>
      this.editWorkspaceEntry(
        workspaceId,
        (workspace, config) => {
          updater(workspace);
          this.desktopInputCoordinator.assertAdmission(config, workspaceId);
        },
        options
      )
    );
  }

  /** The parent's LegacyParentRow when its config row has no id in `cfg` (#4914). */
  private legacyParentRowOf(
    cfg: ReturnType<Config["loadConfigOrDefault"]>,
    parentWorkspaceId: string
  ): LegacyParentRow | undefined {
    if (findWorkspaceEntry(cfg, parentWorkspaceId) != null) return undefined;
    const found = this.config.findWorkspace(parentWorkspaceId);
    return found == null
      ? undefined
      : { projectPath: found.projectPath, workspacePath: found.workspacePath };
  }

  async createMany(
    argsList: TaskCreateArgs[],
    options: TaskCreateManyOptions = {}
  ): Promise<Result<TaskCreateResult[], string>> {
    if (argsList.length === 0) {
      return Ok([]);
    }
    const parentWorkspaceIds = argsList.map((args) => coerceNonEmptyString(args.parentWorkspaceId));
    if (parentWorkspaceIds.some((workspaceId) => workspaceId == null)) {
      return Err("Task.createMany: parentWorkspaceId is required");
    }
    const progress = new TaskReservationProgress();
    try {
      progress.enter("tree-lock");
      return await this.runCancellableAcquisition(
        (callback) =>
          this.withTaskTreeLifecycleLocks(
            parentWorkspaceIds.filter((workspaceId): workspaceId is string => workspaceId != null),
            callback
          ),
        options.abortSignal,
        () => this.createManyUnderTaskTreeLifecycleLocks(argsList, options, progress),
        () => Err(progress.interruptedError())
      );
    } finally {
      progress.dispose();
    }
  }

  /**
   * Race a lock/gate acquisition against `signal`. An abort BEFORE the callback enters resolves
   * `onAborted()` at once, and the late-acquired callback observes the signal as its first
   * statement and returns the same result without doing work — the lock is released immediately
   * and nothing runs detached. An abort AFTER entry is not observed here: the operation handles it
   * at its own cancellation points and stays owned by this caller to completion.
   */
  private async runCancellableAcquisition<T>(
    acquire: (callback: () => Promise<T>) => Promise<T>,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
    onAborted: () => T
  ): Promise<T> {
    if (signal == null) return await acquire(operation);
    if (signal.aborted) return onAborted();
    let entered = false;
    const acquisition = acquire(async () => {
      entered = true;
      if (signal.aborted) return onAborted();
      return await operation();
    });
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!entered) resolve(onAborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      acquisition.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }

  /**
   * Every config-derived input one plan's preparation read from the config entry itself, as JSON
   * (parent identity resolved through the metadata service is pinned separately as
   * parentMetaJson). Recomputed from a fresh config under the mutex; a mismatch means the
   * preparation is stale (parent moved, trust or AI defaults changed, depth changed) and the
   * reservation must fail closed for a retry.
   */
  private snapshotReservationInputs(
    cfg: ProjectsConfig,
    args: TaskCreateArgs,
    parentWorkspaceId: string,
    configProjectPath: string,
    agentId: string
  ): string {
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    const parent = parentEntry?.workspace;
    let desktopOwner: string | undefined | { error: string };
    try {
      desktopOwner = this.resolveTaskDesktopOwner(args, agentId);
    } catch (error) {
      desktopOwner = { error: getErrorMessage(error) };
    }
    return JSON.stringify({
      parent:
        parentEntry == null || parent == null
          ? null
          : {
              projectPath: parentEntry.projectPath,
              path: parent.path,
              kind: parent.kind,
              archivedAt: parent.archivedAt,
              unarchivedAt: parent.unarchivedAt,
              taskStatus: parent.taskStatus,
              taskExecutionStatus: parent.taskExecutionStatus,
              taskIsolation: parent.taskIsolation,
              taskTrunkBranch: parent.taskTrunkBranch,
              aiSettings: parent.aiSettings,
              aiSettingsByAgent: parent.aiSettingsByAgent,
              agentId: parent.agentId,
              agentType: parent.agentType,
            },
      trusted: cfg.projects.get(configProjectPath)?.trusted ?? false,
      depth: this.getTaskDepth(cfg, parentWorkspaceId),
      maxTaskNestingDepth: (cfg.taskSettings ?? DEFAULT_TASK_SETTINGS).maxTaskNestingDepth,
      agentAiDefaults: cfg.agentAiDefaults,
      minThinkingLevelByModel: cfg.minThinkingLevelByModel,
      desktopOwner,
    });
  }

  /**
   * The parent metadata fields a reservation consumes (identity, checkout naming, runtime,
   * projects). Pinned as JSON for revalidation; derived defaults a read-only build fills anew on
   * every call (createdAt for a legacy entry) are deliberately not part of it.
   */
  private pinParentMetaForReservation(parentMeta: WorkspaceMetadata): string {
    return JSON.stringify({
      id: parentMeta.id,
      kind: parentMeta.kind,
      name: parentMeta.name,
      projectPath: parentMeta.projectPath,
      projectName: parentMeta.projectName,
      runtimeConfig: parentMeta.runtimeConfig,
      projects: parentMeta.projects,
    });
  }

  /**
   * Await a pure read while it stays cancellable: an abort resolves at once and the late result is
   * discarded. Only for reads with no owned side effect (metadata built with
   * persistMigrations: false, definition files, AI-settings resolution) — never for config writes.
   */
  private async readCancellable<T>(
    read: Promise<T>,
    signal: AbortSignal | undefined
  ): Promise<{ kind: "ok"; value: T } | { kind: "aborted" }> {
    const raced = await raceWithAbortAndTimeout(read, { signal });
    return raced.kind === "ok" ? raced : { kind: "aborted" };
  }

  /**
   * Read-only preparation of one plan (no locks held, cancellable at every read); see
   * PreparedTaskReservation. Metadata is built without persisting read-time migrations so a
   * discarded late result never leaves a detached config write behind.
   */
  private async prepareTaskReservation(
    args: TaskCreateArgs,
    cfg: ProjectsConfig,
    progress: TaskReservationProgress,
    signal: AbortSignal | undefined
  ): Promise<Result<PreparedTaskReservation, string>> {
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
    if (!parentWorkspaceId) return Err("Task.createMany: parentWorkspaceId is required");
    if (args.kind !== "agent") return Err("Task.createMany: unsupported kind");

    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) return Err("Task.createMany: prompt is required");

    const agent = this.resolveReservationAgentId(args);
    if (!agent.success) return agent;
    const bestOf = this.normalizeReservationBestOf(args.bestOf);
    if (!bestOf.success) return bestOf;

    return this.readReservationParent(
      {
        args,
        cfg,
        taskSettings,
        parentWorkspaceId,
        prompt,
        ...agent.data,
        normalizedBestOf: bestOf.data,
      },
      progress,
      signal
    );
  }

  /** Parses the requested agentId and resolves the task's desktop owner. */
  private resolveReservationAgentId(
    args: TaskCreateArgs
  ): Result<Pick<PreparedTaskReservation, "agentId" | "taskDesktopOwnerWorkspaceId">, string> {
    const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
    if (!normalizedAgentId) return Err("Task.createMany: agentId is required");
    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return Err(`Task.createMany: invalid agentId (${normalizedAgentId})`);
    }
    const agentId = parsedAgentId.data;
    let taskDesktopOwnerWorkspaceId: string | undefined;
    try {
      taskDesktopOwnerWorkspaceId = this.resolveTaskDesktopOwner(args, agentId);
    } catch (error) {
      return Err(getErrorMessage(error));
    }
    return Ok({ agentId, taskDesktopOwnerWorkspaceId });
  }

  /** Checks a best-of request and returns it normalized (undefined when there is none). */
  private normalizeReservationBestOf(
    bestOf: TaskCreateArgs["bestOf"]
  ): Result<TaskCreateArgs["bestOf"], string> {
    let normalizedBestOf: TaskCreateArgs["bestOf"];
    if (bestOf) {
      const groupId = coerceNonEmptyString(bestOf.groupId);
      if (!groupId)
        return Err("Task.createMany: bestOf.groupId is required when bestOf is provided");
      if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
        return Err("Task.createMany: bestOf.index must be a non-negative integer");
      }
      if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
        return Err("Task.createMany: bestOf.total must be an integer >= 2");
      }
      if (bestOf.index >= bestOf.total) {
        return Err("Task.createMany: bestOf.index must be less than bestOf.total");
      }
      normalizedBestOf = {
        groupId,
        index: bestOf.index,
        total: bestOf.total,
      };
    }
    return Ok(normalizedBestOf);
  }

  /**
   * Reads the parent's metadata (cancellable) and refuses a parent that cannot take a new task,
   * then places the task.
   */
  private async readReservationParent(
    request: ReservationRequest,
    progress: TaskReservationProgress,
    signal: AbortSignal | undefined
  ): Promise<Result<PreparedTaskReservation, string>> {
    const { cfg, taskSettings, parentWorkspaceId } = request;
    const parentMetaRead = await this.readCancellable(
      this.aiService.getWorkspaceMetadata(parentWorkspaceId, { persistMigrations: false }),
      signal
    );
    if (parentMetaRead.kind !== "ok") return Err(progress.interruptedError());
    const parentMetaResult = parentMetaRead.value;
    if (!parentMetaResult.success) {
      return Err(`Task.createMany: parent workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;
    // #6426: once per reservation, from the loaded config.
    const projectPluginsTrusted = isWorkspaceProjectTrustedIn(cfg.projects, parentMeta);
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    const project = this.resolveTrustedParentProject(cfg, parentMeta, parentEntry);
    if (!project.success) return project;
    const parentRefusal = this.refuseStoppedOrReportedParent(parentEntry);
    if (!parentRefusal.success) return parentRefusal;

    const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
    if (requestedDepth > taskSettings.maxTaskNestingDepth) {
      return Err(
        `Task.createMany: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
      );
    }

    return this.readReservationParentBranch(
      { ...request, parentMeta, parentEntry, projectPluginsTrusted, ...project.data },
      progress,
      signal
    );
  }

  /** Refuses an archived parent or an untrusted project; returns the project's config key. */
  private resolveTrustedParentProject(
    cfg: ProjectsConfig,
    parentMeta: WorkspaceMetadata,
    parentEntry: ReturnType<typeof findWorkspaceEntry>
  ): Result<Pick<PreparedTaskReservation, "parentIsScratch" | "configProjectPath">, string> {
    if (
      parentEntry != null &&
      isWorkspaceArchived(parentEntry.workspace.archivedAt, parentEntry.workspace.unarchivedAt)
    ) {
      return Err("Task.createMany: parent workspace is archived");
    }
    const parentIsScratch = parentEntry?.workspace.kind === "scratch";
    const configProjectPath = parentIsScratch
      ? SCRATCH_PROJECT_CONFIG_KEY
      : stripTrailingSlashes(parentMeta.projectPath);
    const taskProjectConfig = cfg.projects.get(configProjectPath);
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }
    return Ok({ parentIsScratch, configProjectPath });
  }

  /** Refuses a parent stopped by task_stop or done after agent_report, unless its turn is active. */
  private refuseStoppedOrReportedParent(
    parentEntry: ReturnType<typeof findWorkspaceEntry>
  ): Result<void, string> {
    if (
      parentEntry?.workspace.taskStatus === "interrupted" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.createMany: cannot spawn new tasks after task_stop");
    }

    if (
      parentEntry?.workspace.taskStatus === "reported" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.createMany: cannot spawn new tasks after agent_report");
    }
    return Ok(undefined);
  }

  /**
   * Places the task on the parent's runtime and decides whether it shares the parent's
   * checkout, then reads the parent's branch (cancellable) and reads the agent definition.
   */
  private async readReservationParentBranch(
    parent: ReservationParent,
    progress: TaskReservationProgress,
    signal: AbortSignal | undefined
  ): Promise<Result<PreparedTaskReservation, string>> {
    const { args, parentWorkspaceId, parentMeta, parentEntry } = parent;
    const parentRuntime = this.resolveParentRuntime(parentMeta, parentEntry);
    const { runtime, parentWorkspacePath, taskRuntimeMode, parentIsMultiProject } = parentRuntime;
    const sharing = this.resolveSharedTaskWorkspace(args, parent.parentIsScratch, parentRuntime);
    if (!sharing.success) return sharing;
    const { useSharedWorkspace, sharedWorkspacePath } = sharing.data;
    // Branch actually checked out in the parent's checkout (see create() for rationale).
    const parentBranchRead = await this.readCancellable(
      readTaskParentBranch(parentEntry, parentMeta, () => ({
        runtime,
        workspacePath: parentWorkspacePath,
      })),
      signal
    );
    if (parentBranchRead.kind !== "ok") return Err(progress.interruptedError());
    const parentBranchName = parentBranchRead.value;
    if (args.isolation === "none" && !useSharedWorkspace) {
      log.debug("Task.createMany: isolation=none not honored; falling back to fork", {
        parentWorkspaceId,
        runtimeMode: taskRuntimeMode,
        parentIsMultiProject,
      });
    }

    return this.readReservationAgentDefinition(
      { ...parent, ...parentRuntime, sharedWorkspacePath, parentBranchName },
      progress,
      signal
    );
  }

  /** The parent's runtime, its checkout path and the facts the isolation gating reads. */
  private resolveParentRuntime(
    parentMeta: WorkspaceMetadata,
    parentEntry: ReturnType<typeof findWorkspaceEntry>
  ): ReservationParentRuntime {
    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;
    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
    // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: taskRuntimeConfig,
      projectPath: parentMeta.projectPath,
      name: parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
    });
    // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
    // itself an isolation: "none" task, its name is synthetic and the derived path does not
    // exist — its real checkout is the persisted (shared) path.
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : (coerceNonEmptyString(parentEntry?.workspace.path) ??
        runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

    const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
    const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
    return {
      parentRuntimeConfig,
      taskRuntimeConfig,
      runtime,
      parentWorkspacePath,
      taskRuntimeMode,
      parentIsMultiProject,
    };
  }

  /** Decides whether the task shares the parent's checkout (isolation: "none" or a scratch parent). */
  private resolveSharedTaskWorkspace(
    args: TaskCreateArgs,
    parentIsScratch: boolean,
    parentRuntime: ReservationParentRuntime
  ): Result<
    Pick<PreparedTaskReservation, "sharedWorkspacePath"> & { useSharedWorkspace: boolean },
    string
  > {
    const { taskRuntimeMode, parentIsMultiProject, parentWorkspacePath } = parentRuntime;
    // isolation: "none" — same gating as create(): only worktree/SSH single-project parents
    // share the parent checkout; multi-project parents on those runtimes are refused (see
    // MULTI_PROJECT_SHARED_ISOLATION_ERROR); everything else falls back to the normal fork path.
    if (
      args.isolation === "none" &&
      runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
      parentIsMultiProject
    ) {
      return Err(`Task.createMany: ${MULTI_PROJECT_SHARED_ISOLATION_ERROR}`);
    }
    const useSharedWorkspace =
      parentIsScratch ||
      (args.isolation === "none" &&
        runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
        !parentIsMultiProject);
    const sharedWorkspacePath = useSharedWorkspace ? parentWorkspacePath : undefined;
    return Ok({ useSharedWorkspace, sharedWorkspacePath });
  }

  /**
   * The runnable agentIds for a refusal message. Only the refusal paths of
   * readReservationAgentDefinition call it.
   */
  private async describeRunnableAgents(reservation: ReservationPlacement): Promise<string> {
    const { args, cfg, runtime, parentWorkspacePath, projectPluginsTrusted } = reservation;
    try {
      const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath, {
        projectPluginsTrusted,
        runtimeFactory: nodeRuntimeFactory,
      });
      const runnableIds = (
        await Promise.all(
          allAgents.map(async (agent) => {
            try {
              const frontmatter = await resolveAgentFrontmatter(
                runtime,
                parentWorkspacePath,
                agent.id,
                {
                  skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope),
                  projectPluginsTrusted,
                  runtimeFactory: nodeRuntimeFactory,
                }
              );
              if (
                !isAgentRunnableAsChild(frontmatter, {
                  workflowOwned: args.workflowTask != null,
                })
              ) {
                return null;
              }
              return isAgentEffectivelyDisabled({
                cfg,
                agentId: agent.id,
                resolvedFrontmatter: frontmatter,
              })
                ? null
                : agent.id;
            } catch {
              return null;
            }
          })
        )
      ).filter((id): id is string => typeof id === "string");
      return runnableIds.length > 0
        ? `Runnable agentIds: ${runnableIds.join(", ")}`
        : "No runnable agents available";
    } catch {
      return "Could not discover available agents";
    }
  }

  /**
   * Reads the agent definition (cancellable) and refuses an agent that cannot run as this
   * sub-agent, then reads the AI settings.
   */
  private async readReservationAgentDefinition(
    reservation: ReservationPlacement,
    progress: TaskReservationProgress,
    signal: AbortSignal | undefined
  ): Promise<Result<PreparedTaskReservation, string>> {
    const { args, cfg, agentId, runtime, parentWorkspacePath, projectPluginsTrusted } = reservation;
    let skipInitHook = false;
    let definitionSource: string | undefined;
    let frontmatterJson: string;
    try {
      const definitionRead = await this.readCancellable(
        resolveAgentDefinition(runtime, parentWorkspacePath, agentId, {
          projectPluginsTrusted,
          runtimeFactory: nodeRuntimeFactory,
        }),
        signal
      );
      if (definitionRead.kind !== "ok") return Err(progress.interruptedError());
      const definition = definitionRead.value;
      const frontmatter = definition.frontmatter;
      if (!isAgentRunnableAsChild(frontmatter, { workflowOwned: args.workflowTask != null })) {
        const hint = await this.describeRunnableAgents(reservation);
        return Err(`Task.createMany: agentId is not runnable as a sub-agent (${agentId}). ${hint}`);
      }
      if (isAgentEffectivelyDisabled({ cfg, agentId, resolvedFrontmatter: frontmatter })) {
        const hint = await this.describeRunnableAgents(reservation);
        return Err(`Task.createMany: agentId is disabled (${agentId}). ${hint}`);
      }
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
      definitionSource = definition.source;
      frontmatterJson = JSON.stringify(frontmatter);
    } catch (error) {
      // An unreachable host is not an unknown agent (#4831): say it can be retried.
      if (isRuntimeTransportError(error)) {
        return Err(
          formatRuntimeUnreachableError(
            `Task.createMany: could not verify agentId (${agentId})`,
            error
          )
        );
      }
      const hint = await this.describeRunnableAgents(reservation);
      return Err(`Task.createMany: unknown agentId (${agentId}). ${hint}`);
    }

    return this.readReservationAiSettings(
      { ...reservation, skipInitHook, definitionSource, frontmatter: frontmatterJson },
      progress,
      signal
    );
  }

  /** Resolves the task's AI settings (cancellable) and builds the prepared reservation. */
  private async readReservationAiSettings(
    reservation: ReservationAgentDefinition,
    progress: TaskReservationProgress,
    signal: AbortSignal | undefined
  ): Promise<Result<PreparedTaskReservation, string>> {
    const {
      args,
      cfg,
      parentWorkspaceId,
      prompt,
      agentId,
      parentMeta,
      projectPluginsTrusted,
      configProjectPath,
      parentIsScratch,
      taskDesktopOwnerWorkspaceId,
      normalizedBestOf,
      runtime,
      parentWorkspacePath,
      taskRuntimeConfig,
      parentRuntimeConfig,
      sharedWorkspacePath,
      parentBranchName,
      skipInitHook,
      definitionSource,
      frontmatter: frontmatterJson,
    } = reservation;
    let taskModelString: string;
    let canonicalModel: string;
    let effectiveThinkingLevel: ThinkingLevel;
    let effectiveReasoningMode: OpenAIReasoningMode | undefined;
    let taskAiPins: TaskAiPins;
    try {
      const aiSettingsRead = await this.readCancellable(
        this.resolveTaskAISettings({
          cfg,
          parentWorkspaceId,
          parentMeta,
          agentId,
          modelString: args.modelString,
          thinkingLevel: args.thinkingLevel,
          parentRuntimeAiSettings: args.parentRuntimeAiSettings,
          definitionContext: {
            runtime,
            workspacePath: parentWorkspacePath,
            workspaceId: parentWorkspaceId,
            projectPluginsTrusted,
            runtimeFactory: nodeRuntimeFactory,
          },
        }),
        signal
      );
      if (aiSettingsRead.kind !== "ok") return Err(progress.interruptedError());
      ({
        taskModelString,
        canonicalModel,
        effectiveThinkingLevel,
        effectiveReasoningMode,
        pins: taskAiPins,
      } = aiSettingsRead.value);
    } catch (error) {
      if (error instanceof InvalidExplicitAiSettingError) {
        return Err(`Task.createMany: ${error.message}`);
      }
      // The agent's definition defaults could not be read (#4829): fail retryably
      // instead of spawning with default AI settings.
      if (isRuntimeTransportError(error)) {
        return Err(formatRuntimeUnreachableError("Task.createMany", error));
      }
      throw error;
    }

    return Ok({
      args,
      parentWorkspaceId,
      prompt,
      agentId,
      parentMeta,
      configProjectPath,
      parentIsScratch,
      taskDesktopOwnerWorkspaceId,
      normalizedBestOf,
      runtime,
      parentWorkspacePath,
      taskRuntimeConfig,
      parentRuntimeConfig,
      sharedWorkspacePath,
      parentBranchName,
      skipInitHook,
      definitionSource,
      frontmatter: frontmatterJson,
      taskModelString,
      canonicalModel,
      effectiveThinkingLevel,
      effectiveReasoningMode,
      taskAiPins,
      inputs: this.snapshotReservationInputs(
        cfg,
        args,
        parentWorkspaceId,
        configProjectPath,
        agentId
      ),
      parentMetaJson: this.pinParentMetaForReservation(parentMeta),
    });
  }

  private async createManyUnderTaskTreeLifecycleLocks(
    argsList: TaskCreateArgs[],
    options: TaskCreateManyOptions,
    progress: TaskReservationProgress
  ): Promise<Result<TaskCreateResult[], string>> {
    const signal = options.abortSignal;
    const interrupted = (): Result<TaskCreateResult[], string> => Err(progress.interruptedError());

    // Stage: read-only preparation, before the global mutex. Cancellable between plans; a result
    // computed after the abort is discarded.
    progress.enter("prepare");
    const prepared: PreparedTaskReservation[] = [];
    for (const args of argsList) {
      const preparation = await this.prepareTaskReservation(
        args,
        this.config.loadConfigOrDefault(),
        progress,
        signal
      );
      if (signal?.aborted) return interrupted();
      if (!preparation.success) return preparation;
      prepared.push(preparation.data);
    }

    // Stage: global mutex (cancellable acquisition; a late lock is released untouched).
    progress.enter("mutex");
    const acquisition = this.mutex.acquire();
    const lockRace = await raceWithAbortAndTimeout(acquisition, { signal });
    if (lockRace.kind !== "ok") {
      void acquisition.then((lock) => lock[Symbol.asyncDispose]());
      return interrupted();
    }
    await using _lock = lockRace.value;
    if (signal?.aborted) return interrupted();

    // Stage: revalidate every prepared input against a fresh config, then decide capacity.
    progress.enter("revalidate");
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    let reservedActiveCount =
      this.countActiveAgentTasks(cfg) +
      (await this.getWorkspaceTurnManager().countActiveWorkspaceTurns());
    if (signal?.aborted) return interrupted();

    // sharedWorkspacePath is set for honored isolation: "none" plans; the entry is persisted
    // pointing at the parent's checkout and startReservedAgentTask reuses it without fork/init.
    const plans: Array<
      TaskLaunchPlan & { status: "queued" | "starting"; sharedWorkspacePath?: string }
    > = [];
    const results: TaskCreateResult[] = [];

    for (const plan of prepared) {
      const inputsNow = this.snapshotReservationInputs(
        cfg,
        plan.args,
        plan.parentWorkspaceId,
        plan.configProjectPath,
        plan.agentId
      );
      if (inputsNow !== plan.inputs) {
        return Err(
          "Task.createMany: reservation inputs changed during preparation (parent, trust or AI defaults); retry"
        );
      }
      // Parent identity as the metadata service resolves it (runtime config, name, projects).
      // Read-only and cancellable under the mutex: no config-queue wait, and a held read releases
      // the mutex on abort instead of stalling every other reservation.
      const parentMetaNowRead = await this.readCancellable(
        this.aiService.getWorkspaceMetadata(plan.parentWorkspaceId, { persistMigrations: false }),
        signal
      );
      if (parentMetaNowRead.kind !== "ok") return interrupted();
      const parentMetaNow = parentMetaNowRead.value;
      if (
        !parentMetaNow.success ||
        this.pinParentMetaForReservation(parentMetaNow.data) !== plan.parentMetaJson
      ) {
        return Err(
          "Task.createMany: parent workspace changed during preparation (runtime, name or projects); retry"
        );
      }
      // The definition resolved before the mutex must still be the one that would run.
      let definitionNow: { source?: string; frontmatter: unknown };
      try {
        const definitionNowRead = await this.readCancellable(
          resolveAgentDefinition(plan.runtime, plan.parentWorkspacePath, plan.agentId, {
            projectPluginsTrusted: isWorkspaceProjectTrustedIn(cfg.projects, parentMetaNow.data),
            runtimeFactory: nodeRuntimeFactory,
          }),
          signal
        );
        if (definitionNowRead.kind !== "ok") return interrupted();
        definitionNow = definitionNowRead.value;
      } catch (error) {
        return Err(
          `Task.createMany: agent definition changed during preparation (${plan.agentId}): ${getErrorMessage(error)}; retry`
        );
      }
      if (
        definitionNow.source !== plan.definitionSource ||
        JSON.stringify(definitionNow.frontmatter) !== plan.frontmatter
      ) {
        return Err(
          `Task.createMany: agent definition changed during preparation (${plan.agentId}); retry`
        );
      }
      if (signal?.aborted) return interrupted();

      const taskId = this.config.generateStableId();
      const workspaceName = buildAgentWorkspaceName(plan.agentId, taskId);
      const nameValidation = validateWorkspaceName(workspaceName);
      if (!nameValidation.valid) {
        return Err(
          `Task.createMany: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
        );
      }

      const status: "queued" | "starting" =
        reservedActiveCount >= taskSettings.maxParallelAgentTasks ? "queued" : "starting";
      if (status === "starting") reservedActiveCount += 1;

      const createdAt = getIsoNow();
      plans.push({
        taskId,
        parentWorkspaceId: plan.parentWorkspaceId,
        requireParentRow: findWorkspaceEntry(cfg, plan.parentWorkspaceId) != null,
        legacyParentRow: this.legacyParentRowOf(cfg, plan.parentWorkspaceId),
        parentMeta: plan.parentMeta,
        agentId: plan.agentId,
        agentType: plan.agentId,
        start: { kind: "sendMessage", prompt: plan.prompt, sendId: mintTaskBriefSendId() },
        title: plan.args.title,
        workspaceName,
        createdAt,
        taskRuntimeConfig: plan.taskRuntimeConfig,
        parentRuntimeConfig: plan.parentRuntimeConfig,
        configProjectPath: plan.configProjectPath,
        workspaceKind: plan.parentIsScratch ? "scratch" : undefined,
        taskModelString: plan.taskModelString,
        canonicalModel: plan.canonicalModel,
        effectiveThinkingLevel: plan.effectiveThinkingLevel,
        effectiveReasoningMode: plan.effectiveReasoningMode,
        taskAiPins: plan.taskAiPins,
        skipInitHook: plan.skipInitHook,
        workflowTask: plan.args.workflowTask,
        bestOf: plan.normalizedBestOf,
        onRefusal: plan.args.onRefusal,
        attentionPolicy: plan.args.attentionPolicy,
        taskDesktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
        status,
        ...(signal != null ? { abortSignal: signal } : {}),
        ...(plan.sharedWorkspacePath != null
          ? { sharedWorkspacePath: plan.sharedWorkspacePath }
          : {}),
        // Real branch checked out in the parent's checkout: persisted as taskTrunkBranch and used
        // by orchestrateFork's create-fallback when the fork cannot detect a source branch
        // (a shared parent's synthetic name, or an auto-named worktree parent's, names no
        // branch). Only then: other parents keep the existing branch-discovery fallback.
        ...(plan.parentBranchName != null && plan.parentBranchName !== plan.parentMeta.name
          ? { preferredTrunkBranch: plan.parentBranchName }
          : {}),
      });
      results.push({
        taskId,
        kind: "agent",
        status,
        modelString: plan.taskModelString,
        thinkingLevel: plan.effectiveThinkingLevel,
        desktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId ?? taskId,
      });
    }

    // Before the commit publishes any `starting` row: its launch lease (see startReservedAgentTask).
    let heldLaunchLeases: Awaited<ReturnType<typeof holdLaunchLeases>>;
    try {
      heldLaunchLeases = await holdLaunchLeases(
        workspaceUseLeasesFor(this.config),
        plans.filter((plan) => plan.status === "starting").map((plan) => plan.taskId)
      );
    } catch (error) {
      return Err(`Task.createMany: ${getErrorMessage(error)}`);
    }
    await using launchLeases = heldLaunchLeases;

    // Stage: desktop gate (cancellable acquisition), then the owned checkpoint + commit.
    progress.enter("desktop-gate");
    let canceledInsideCommit = false;
    const commit = async (): Promise<Result<TaskCreateResult[], string> | null> => {
      // Checkpoint entry is the LAST cancellation point: an abort observed here leaves nothing
      // durable. Once a callback is entered it is owned to completion (the runner checks the
      // signal itself before its store write).
      progress.enter("checkpoint");
      if (signal?.aborted) return interrupted();
      // Ownership BEFORE exposure: every id a checkpoint callback may durably record is owned by
      // this process from here, whatever happens to the callbacks or the commit. The identity is
      // kept through a successful commit (the launch reuses it) and, when the pre-launch path
      // fails, settled once nothing can launch — a checkpointed id must never read back to the
      // runner as "no attempt owned by this process".
      // The reservation is the FIRST admission of a brand-new task by construction, so its
      // lineage is proven: the attempt id minted here is persisted by the commit below in the same
      // write that creates the entry, and the launch reuses it.
      const ownedAttempts = new Map(
        plans.map((plan) => {
          plan.attemptId = newTaskAttemptId();
          return [
            plan.taskId,
            this.beginOwnedTaskAttempt(plan.taskId, "reservation", {
              attemptId: plan.attemptId,
              receiptEligible: true,
              ...(signal != null ? { abortSignal: signal } : {}),
            }),
          ];
        })
      );
      try {
        for (const [index, result] of results.entries()) {
          // Workflow callers durably checkpoint returned task IDs before task records are
          // persisted. If this backend dies before the commit, the checkpoint names a task that
          // never existed: a resuming runner tombstones the ID (tombstoneUnpublishedReservation)
          // and only then replaces it, and the commit below refuses a tombstoned ID, so a stalled
          // (not dead) backend's late commit can never publish a second child for the step.
          await options.onTaskReserved?.(index, result);
        }
        progress.enter("config-commit");
        await this.commitReservations(
          plans,
          signal,
          () => {
            canceledInsideCommit = true;
          },
          options.retires
        );
      } catch (error: unknown) {
        await this.settleFailedReservations(plans, ownedAttempts, signal, error);
        throw error;
      }
      return null;
    };

    let commitOutcome: Result<TaskCreateResult[], string> | null;
    try {
      commitOutcome = await this.runCancellableAcquisition(
        (callback) =>
          this.desktopInputCoordinator.withReservations(
            plans.flatMap((plan) =>
              plan.taskDesktopOwnerWorkspaceId == null
                ? []
                : [
                    {
                      ownerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
                      borrowerWorkspaceId: plan.taskId,
                    },
                  ]
            ),
            callback
          ),
        signal,
        commit,
        interrupted
      );
    } catch (error) {
      return Err(getErrorMessage(error));
    }
    if (commitOutcome != null) return commitOutcome;

    progress.enter("launch");
    for (const result of results) {
      await this.emitWorkspaceMetadata(result.taskId);
    }

    // Post-commit fence, after the last await and immediately before scheduling: an abort that
    // landed after the mutator ran reconciles the live reservations to interrupted with an OWNED
    // write (never detached).
    if (canceledInsideCommit || signal?.aborted) {
      this.closeReservedAttempts(plans, "reservation-canceled");
      // The first fence write that rejected; thrown once every plan was handled (#5028).
      let fenceFailure: { error: unknown } | undefined;
      for (const plan of plans) {
        const ownedAttempt = this.attemptLedger.ownedAttempt(plan.taskId);
        const fence: ReservationRowFence = {
          transitioned: canceledInsideCommit,
          superseded: false,
          rowMoved: false,
        };
        if (!canceledInsideCommit) {
          try {
            await this.fenceReservationRow(plan, TASK_RESERVATION_CANCELED_MESSAGE, fence);
          } catch (error: unknown) {
            // Nothing launches this row now (#5028), unless the row already moved on (another
            // writer's attempt, whose waiters this cancel must not touch).
            if (!fence.rowMoved) this.waiters.armWaitersOfUnendedTask(plan.taskId);
            fenceFailure ??= { error };
            continue;
          }
        }
        if (fence.transitioned) this.recordTaskInterrupted(plan.taskId, plan.parentWorkspaceId);
        if (fence.transitioned) await this.settleChildGoalPause(plan.taskId);
        // Waiters are keyed by the stable task id: once another writer re-admitted the row under
        // its own attempt they are that attempt's (its task_await must not read this cancel).
        // Rejected BEFORE the receipt write's await, which a successor's new waiter could
        // otherwise register during and then be rejected as this attempt's.
        if (!fence.superseded) {
          this.rejectWaiters(plan.taskId, new Error(TASK_RESERVATION_CANCELED_MESSAGE));
        }
        // Canceled before any launch was scheduled: nothing ran under the attempt.
        await this.attemptLedger.persistOwnedAttemptSettlement(
          plan.taskId,
          ownedAttempt,
          "reservation-canceled",
          "reservation-canceled"
        );
        await this.emitWorkspaceMetadata(plan.taskId);
      }
      if (fenceFailure != null) throw fenceFailure.error;
      return interrupted();
    }

    for (const plan of plans) {
      if (plan.status === "starting") {
        plan.launchLease = launchLeases.take(plan.taskId);
        this.scheduleReservedTaskLaunch(plan);
      }
    }
    if (plans.some((plan) => plan.status === "queued")) {
      this.scheduleMaybeStartQueuedTasks();
    }

    return Ok(results);
  }

  /** The reservation's owned config write (see createManyUnderTaskTreeLifecycleLocks). */
  private async commitReservations(
    plans: ReadonlyArray<
      TaskLaunchPlan & { status: "queued" | "starting"; sharedWorkspacePath?: string }
    >,
    signal: AbortSignal | undefined,
    onCanceledInsideCommit: () => void,
    retires?: ReadonlyArray<TaskRetiresClaim | undefined>
  ): Promise<void> {
    assert(
      retires == null || retires.length <= plans.length,
      "commitReservations: retires must align with the plans"
    );
    await this.config.editConfig((config) => {
      // Single-use publication (#4452 gap 2), in the same write that publishes the children: each
      // replacement consumes its claim. A stale runner whose claim was re-stamped, or a second
      // replacement of the same retired attempt, throws here and nothing of this batch is written.
      for (const [index, claim] of (retires ?? []).entries()) {
        if (claim == null) continue;
        const prior = findWorkspaceEntry(config, claim.taskId)?.workspace;
        const retiredBy = prior?.taskAttemptRetiredBy;
        if (
          prior?.taskAttemptId !== claim.attemptId ||
          retiredBy?.attemptId !== claim.attemptId ||
          retiredBy.nonce !== claim.nonce ||
          retiredBy.replacementTaskId != null
        ) {
          throw new Error(
            `Task.createMany: the retired attempt ${claim.attemptId} of ${claim.taskId} was re-claimed or already replaced`
          );
        }
        prior.taskAttemptRetiredBy = { ...retiredBy, replacementTaskId: plans[index].taskId };
      }
      // Fence inside the mutator: an abort that landed while waiting for the config lock (or
      // during the checkpoint) persists the plans interrupted instead of live reservations.
      // A resuming workflow runner abandoned this reservation (tombstoneUnpublishedReservation)
      // and replaces it: refuse in the same write, before anything of this batch is published.
      for (const plan of plans) {
        const tombstones = findWorkspaceEntry(config, plan.parentWorkspaceId)?.workspace
          .taskReservationTombstones;
        if (Array.isArray(tombstones) && tombstones.includes(plan.taskId)) {
          throw new Error(
            `Task.createMany: reservation ${plan.taskId} was abandoned by a resumed workflow runner (tombstoned); not publishing`
          );
        }
      }
      const canceledInsideCommit = signal?.aborted === true;
      if (canceledInsideCommit) onCanceledInsideCommit();
      for (const plan of plans) {
        assertParentAdmitsChild(config, plan.parentWorkspaceId, {
          requireRow: plan.requireParentRow === true,
          legacyRow: plan.legacyParentRow,
        });
        const runtime = createRuntimeForWorkspace({
          runtimeConfig: plan.taskRuntimeConfig,
          projectPath: plan.parentMeta.projectPath,
          name: plan.parentMeta.name,
        });
        const workspacePath =
          plan.sharedWorkspacePath ??
          runtime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
        const trunkBranch =
          coerceNonEmptyString(plan.preferredTrunkBranch) ??
          coerceNonEmptyString(plan.parentMeta.name);
        if (!trunkBranch) {
          throw new Error("Task.createMany: parent workspace name missing");
        }
        let projectConfig = config.projects.get(plan.configProjectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(plan.configProjectPath, projectConfig);
        }
        projectConfig.workspaces.push({
          kind: plan.workspaceKind,
          path: workspacePath,
          id: plan.taskId,
          name: plan.workspaceName,
          title: plan.title,
          createdAt: plan.createdAt,
          runtimeConfig: plan.taskRuntimeConfig,
          // New rows have no legacy plan to migrate (#5174).
          remotePlanMigrated: true,
          aiSettings:
            plan.effectiveThinkingLevel !== undefined
              ? {
                  model: plan.canonicalModel,
                  thinkingLevel: plan.effectiveThinkingLevel,
                  ...(plan.effectiveReasoningMode != null
                    ? { reasoningMode: plan.effectiveReasoningMode }
                    : {}),
                }
              : undefined,
          parentWorkspaceId: plan.parentWorkspaceId,
          agentId: plan.agentId,
          agentType: plan.agentType,
          workflowTask: plan.workflowTask,
          bestOf: plan.bestOf,
          taskStatus: canceledInsideCommit ? "interrupted" : plan.status,
          taskLaunchError: canceledInsideCommit ? TASK_RESERVATION_CANCELED_MESSAGE : undefined,
          taskAttemptId: plan.attemptId,
          taskPrompt: plan.start.kind === "sendMessage" ? plan.start.prompt : undefined,
          // A queued row's id is replaced by its launch's own (maybeStartQueuedTasks).
          taskPromptSendId: plan.start.kind === "sendMessage" ? plan.start.sendId : undefined,
          taskTrunkBranch: trunkBranch,
          taskModelString: plan.taskModelString,
          taskThinkingLevel: plan.effectiveThinkingLevel,
          taskAiPins: plan.taskAiPins ?? {},
          taskOnRefusal: plan.onRefusal,
          taskIsolation: plan.sharedWorkspacePath != null ? "none" : undefined,
          taskAttentionPolicy: plan.attentionPolicy,
          taskDesktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
          projects: plan.parentMeta.projects,
        });
        this.desktopInputCoordinator.assertAdmission(config, plan.taskId);
      }
      return config;
    });
  }

  // --- Reservation receipt producers (G2): the no-report boundary for canceled/failed batches ---
  /**
   * Close EVERY attempt of a canceled/failed reservation batch synchronously, before the first
   * await of the per-plan settlement loop: a send reaching the fence from here on is refused, so
   * no plan's attempt can gain work while an earlier plan's status edit or receipt write is
   * awaited (attemptCannotStillReport then decides each plan's receipt). A closure recorded for
   * another attempt (a row re-admitted by another writer) is never replaced.
   */
  private closeReservedAttempts(plans: readonly TaskLaunchPlan[], source: string): void {
    for (const plan of plans) {
      if (plan.attemptId == null) continue;
      this.attemptLedger.closeAttemptAdmissionUnlessOtherClosed(
        plan.taskId,
        plan.attemptId,
        this.attemptLedger.ownedAttempt(plan.taskId),
        source
      );
    }
  }
  // --- end reservation receipt producers ---

  /**
   * The owned pre-launch path ended before scheduling (a checkpoint callback or the config commit
   * failed). Launchability must be KNOWN before the attempt is settled: a record the failed write
   * still committed would be picked up by the scheduler, so it is fenced (interrupted) first; an
   * unreadable config or a failed fence leaves the attempt unsettled (indeterminate) rather than
   * guessed. Failure or absence alone is never authority — the fence is.
   */
  private async settleFailedReservations(
    plans: ReadonlyArray<TaskLaunchPlan & { status: "queued" | "starting" }>,
    ownedAttempts: ReadonlyMap<string, OwnedTaskAttempt>,
    signal: AbortSignal | undefined,
    error: unknown
  ): Promise<void> {
    const message = signal?.aborted
      ? TASK_RESERVATION_CANCELED_MESSAGE
      : `Reservation failed: ${getErrorMessage(error)}`;
    this.closeReservedAttempts(plans, "reservation-failed");
    for (const plan of plans) {
      let committed: boolean;
      try {
        committed =
          findWorkspaceEntry(
            this.config.loadConfigOrDefault({ throwOnError: true }),
            plan.taskId
          ) != null;
      } catch (readError: unknown) {
        log.warn("Task reservation failed and its config state is unreadable; attempt unresolved", {
          taskId: plan.taskId,
          error: readError,
        });
        continue;
      }
      if (committed) {
        const fence: ReservationRowFence = {
          transitioned: false,
          superseded: false,
          rowMoved: false,
        };
        try {
          await this.fenceReservationRow(plan, message, fence);
          if (fence.transitioned) this.recordTaskInterrupted(plan.taskId, plan.parentWorkspaceId);
          if (fence.transitioned) await this.settleChildGoalPause(plan.taskId);
          // A row another writer re-admitted: its waiters belong to that attempt (see above).
          if (!fence.superseded) this.rejectWaiters(plan.taskId, new Error(message));
          await this.emitWorkspaceMetadata(plan.taskId);
        } catch (fenceError: unknown) {
          log.warn("Task reservation failed and its committed record could not be fenced", {
            taskId: plan.taskId,
            error: fenceError,
          });
          // Nothing launches this row now (#5028), unless it already moved on (see above).
          if (!fence.rowMoved) this.waiters.armWaitersOfUnendedTask(plan.taskId);
          continue;
        }
      }
      // The pre-launch path failed before scheduling: nothing ran under the attempt. A row the
      // failed commit never wrote gets no receipt (readSettlementReceiptRow: elsewhere).
      await this.attemptLedger.persistOwnedAttemptSettlement(
        plan.taskId,
        ownedAttempts.get(plan.taskId),
        signal?.aborted ? "reservation-canceled" : "reservation-failed",
        "reservation-failed"
      );
    }
  }

  /**
   * The fence write of a reserved row that will not launch (createManyUnderTaskTreeLifecycleLocks'
   * post-commit fence, settleFailedReservations): `interrupted` with `message`, unless the row
   * moved on (another status, or another writer's attempt). Sync: it returns the edit's promise
   * for the caller to await, so sharing it adds no await. `fence` records what the mutator saw.
   */
  private fenceReservationRow(
    plan: TaskLaunchPlan & { status: "queued" | "starting" },
    message: string,
    fence: ReservationRowFence
  ): Promise<boolean> {
    return this.editWorkspaceEntry(
      plan.taskId,
      (ws) => {
        fence.superseded = rowSupersedes(ws, plan.attemptId);
        if (ws.taskStatus !== plan.status || fence.superseded) {
          fence.rowMoved = true;
          return;
        }
        ws.taskStatus = "interrupted";
        markChildGoalPauseOwed(ws);
        ws.taskLaunchError = message;
        fence.transitioned = true;
      },
      { allowMissing: true }
    );
  }

  /**
   * A reservation canceled before its send was admitted: persist the owned settlement
   * (`interrupted`, "Reservation canceled") instead of launching. Whatever was materialized stays
   * with the published row (see cleanupMaterializedTaskWorkspace).
   */
  private async cancelReservedLaunch(
    plan: TaskLaunchPlan,
    initLogger?: InitLogger,
    materialized?: { runtime: Runtime; preservePhysicalWorkspace: boolean }
  ): Promise<void> {
    initLogger?.logComplete(-1);
    if (materialized != null) {
      await this.cleanupMaterializedTaskWorkspace(
        materialized.runtime,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: materialized.preservePhysicalWorkspace }
      );
    }
    await this.markTaskLaunchFailed(plan.taskId, TASK_RESERVATION_CANCELED_MESSAGE, plan);
  }

  /**
   * The row no longer names the attempt this launch plan was admitted for: another writer
   * re-admitted the task meanwhile. Plans without an id (pre-identity records reached without
   * the drain CAS) are never superseded by this test.
   */
  private launchSuperseded(
    plan: Pick<TaskLaunchPlan, "taskId" | "attemptId">,
    row: WorkspaceConfigEntry | undefined = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.taskId
    )?.workspace
  ): boolean {
    return plan.attemptId != null && row?.taskAttemptId !== plan.attemptId;
  }

  /**
   * This process's owned attempt is no longer the row's: the record, checkout and session dir
   * belong to another writer's admission now, so a failure of the superseded attempt must not
   * interrupt or delete them. Unowned tasks and pre-identity owners are never held back.
   */
  private ownedAttemptSuperseded(taskId: string, row: WorkspaceConfigEntry | undefined): boolean {
    const owned = this.attemptLedger.ownedAttempt(taskId)?.attemptId;
    return owned != null && row?.taskAttemptId !== owned;
  }

  private async cleanupMaterializedTaskWorkspace(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
    }
  ): Promise<void> {
    assert(projectPath.length > 0, "cleanupMaterializedTaskWorkspace requires projectPath");
    assert(workspaceName.length > 0, "cleanupMaterializedTaskWorkspace requires workspaceName");
    assert(taskId.length > 0, "cleanupMaterializedTaskWorkspace requires taskId");
    let row: WorkspaceConfigEntry | undefined;
    try {
      // Strict: a lenient read of an unreadable or invalid config.json is empty, and the missing
      // row below would delete a registered task's checkout. Unprovable absence retains.
      row = findWorkspaceEntry(
        this.config.loadConfigOrDefault({ throwOnError: true }),
        taskId
      )?.workspace;
    } catch (error) {
      log.error("Task launch cleanup: config unreadable; retaining the checkout and session", {
        taskId,
        error: getErrorMessage(error),
      });
      return;
    }
    // Only a published row can name a successor attempt. A missing row was unpublished by a
    // removal and no writer re-admits a row that no longer exists, so its checkout is the
    // removal's: delete it. Counting a missing row as superseded leaked the checkout a fork made
    // while the removal ran. A row a removal only marked
    // (pendingRemoval) is still retained below: a removal can abort and release its marker while
    // the delete runs, and another backend could then reawaken the row. No live removal can mark
    // the row while a launch prepares it (the launch lease, see startReservedAgentTask), so such
    // a marker is a leftover the next removal retakes, and that removal deletes the checkout.
    if (row != null && this.ownedAttemptSuperseded(taskId, row)) {
      log.info("Task launch cleanup skipped: the record was re-admitted by another writer", {
        taskId,
      });
      return;
    }
    // A published row keeps its checkout and session dir: the ownership check above is one-shot,
    // and another backend (XUM_ALLOW_MULTIPLE_INSTANCES) can re-admit the row while the
    // destructive awaits below run, so deleting would destroy the successor's artifacts. Nothing
    // in-process can serialize with that writer, so a failed launch retains them instead — the
    // row is marked interrupted (launch error recorded) and stays inspectable and resumable;
    // removing the task deletes them through the ordinary workspace removal. (An unsanitized
    // checkout is reclaimed only after its row is unpublished: reclaimUnsanitizedTaskCheckout.)
    if (row != null) {
      log.info("Task launch cleanup: retaining the published task's checkout and session", {
        taskId,
      });
      return;
    }
    // The normalized view is lossy (buckets that normalize to one path collapse, invalid entries
    // vanish), so absence from it alone never authorizes the delete: the raw persisted ids must
    // lack the task too, and an unreadable raw config retains.
    let persistedIds: Set<string>;
    try {
      persistedIds = this.config.readPersistedWorkspaceIdSuperset();
    } catch (error: unknown) {
      log.error("Task launch cleanup: raw config unreadable; retaining the checkout and session", {
        taskId,
        error: getErrorMessage(error),
      });
      return;
    }
    if (persistedIds.has(taskId)) {
      log.info("Task launch cleanup: the raw config still lists the task; retaining its checkout", {
        taskId,
      });
      return;
    }

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task launch cleanup: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        if (!deleteResult.success) {
          log.error("Task launch cleanup: failed to delete materialized workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task launch cleanup: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = path.join(this.config.sessionsDir, taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task launch cleanup: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Reclaim a launch's checkout whose stale plugin overrides could not be sanitized. Nothing
   * re-sanitizes a retained checkout before a later resume sends into it, so it must go — but only
   * once no backend can re-admit its row: the row is unpublished first, in one config edit (edits
   * run on fresh bytes under the cross-process registration lock), and only while it still names
   * `expectedAttemptId`, the attempt this process owns and launched. The removal is also confirmed
   * from the persisted bytes (belt and braces; a failed save rejects, #4444). The checkout and
   * session dir are named after the task id, so no other task can reuse them once the row is gone.
   * Anything short of a confirmed unpublication — no or another owner, a moved row, a lost or
   * unverifiable write — retains everything; the failure is then recorded on the row. Returns
   * whether the row was unpublished and whether the checkout was actually deleted.
   */
  private async reclaimUnsanitizedTaskCheckout(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    expectedAttemptId: string | undefined
  ): Promise<{ rowUnpublished: boolean; checkoutRemoved: boolean }> {
    let unpublished = false;
    if (
      expectedAttemptId != null &&
      this.attemptLedger.ownedAttempt(taskId)?.attemptId === expectedAttemptId
    ) {
      try {
        await this.config.editConfig((config) => {
          for (const project of config.projects.values()) {
            const index = project.workspaces.findIndex((ws) => ws.id === taskId);
            if (index === -1) continue;
            if (project.workspaces[index]?.taskAttemptId === expectedAttemptId) {
              project.workspaces.splice(index, 1);
              unpublished = true;
            }
            break;
          }
          return config;
        });
        unpublished &&=
          findWorkspaceEntry(this.config.loadConfigOrDefault({ throwOnError: true }), taskId) ==
          null;
      } catch (error: unknown) {
        log.warn("Task launch: could not unpublish the unsanitized task row", {
          taskId,
          error: getErrorMessage(error),
        });
        unpublished = false;
      }
    }
    if (!unpublished) {
      log.warn("Task launch: unsanitized checkout retained (its row is still published)", {
        taskId,
      });
      return { rowUnpublished: false, checkoutRemoved: false };
    }
    const { checkoutRemoved } = await this.rollbackFailedTaskCreate(
      runtime,
      projectPath,
      workspaceName,
      taskId,
      { rowUnpublished: true }
    );
    return { rowUnpublished: true, checkoutRemoved };
  }

  private async getExistingMaterializedTaskLaunch(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    workspace: WorkspaceConfigEntry
  ): Promise<MaterializedTaskLaunch | null> {
    const workspacePath =
      coerceNonEmptyString(workspace.path) ??
      sourceRuntime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
    if (!(await runtimePathExists(sourceRuntime, workspacePath))) {
      return null;
    }

    const forkedRuntimeConfig = workspace.runtimeConfig ?? plan.taskRuntimeConfig;
    const runtimeForTaskWorkspace = createRuntimeForWorkspace({
      // The task's id, as on the fork paths: a devcontainer recreated after a crash gets the
      // workspace's scratch mount only when the runtime knows whose workspace it is.
      id: plan.taskId,
      runtimeConfig: forkedRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.workspaceName,
      namedWorkspacePath: workspacePath,
    });
    const trunkBranch =
      coerceNonEmptyString(workspace.taskTrunkBranch) ??
      coerceNonEmptyString(plan.preferredTrunkBranch) ??
      coerceNonEmptyString(plan.parentMeta.name) ??
      plan.workspaceName;

    return {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      runtimeForTaskWorkspace,
      inheritedProjects: workspace.projects ?? plan.parentMeta.projects,
      reusedExistingCheckout: true,
    };
  }

  private async runProjectForkExclusive<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    assert(projectPath.length > 0, "runProjectForkExclusive requires projectPath");

    const previousLaunch =
      this.reservedTaskLaunchByProjectPath.get(projectPath) ?? Promise.resolve();
    const run = previousLaunch.catch(() => undefined).then(fn);
    const trackedLaunch = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.reservedTaskLaunchByProjectPath.get(projectPath) === trackedLaunch) {
          this.reservedTaskLaunchByProjectPath.delete(projectPath);
        }
      });
    this.reservedTaskLaunchByProjectPath.set(projectPath, trackedLaunch);
    return await run;
  }

  /**
   * The gate before reusing or forking the task's checkout: only this plan's own `starting` row.
   * A row another writer re-admitted under a new attempt is that writer's to prepare (the
   * gate used to check only the status, so two launches could prepare one checkout). A row a
   * removal marked is refused (throws, as the admission would): with the launch lease held no
   * live removal can have marked it, so this is a marker a crashed or failed removal left behind,
   * and the launch must not fork a checkout under it.
   */
  private mayMaterializeTaskWorkspace(
    plan: TaskLaunchPlan,
    row: WorkspaceConfigEntry | undefined
  ): boolean {
    if (row?.taskStatus !== "starting" || this.launchSuperseded(plan, row)) return false;
    if (row.pendingRemoval != null) {
      throw new Error(pendingRemovalAdmissionMessage(row.pendingRemoval));
    }
    return true;
  }

  /**
   * The launch's own row, read strictly (#5527). A lenient read of an unreadable config.json is
   * empty, which reads as a removed row: the launch would return without settling and leave the
   * row `starting` (holding its task slot) until a restart. The throw reaches
   * scheduleReservedTaskLaunch, which marks the launch failed.
   */
  private readLaunchRow(taskId: string): ReturnType<typeof findWorkspaceEntry> {
    return findWorkspaceEntry(this.config.loadConfigOrDefault({ throwOnError: true }), taskId);
  }

  private async materializeReservedTaskWorkspace(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    initLogger: InitLogger
  ): Promise<MaterializedTaskLaunch | null> {
    const entry = this.readLaunchRow(plan.taskId);
    if (entry == null || !this.mayMaterializeTaskWorkspace(plan, entry.workspace)) {
      return null;
    }

    const existing = await this.getExistingMaterializedTaskLaunch(
      plan,
      sourceRuntime,
      entry.workspace
    );
    if (existing) {
      taskQueueDebug("TaskService.startReservedAgentTask reusing materialized workspace", {
        taskId: plan.taskId,
        workspacePath: existing.workspacePath,
      });
      return existing;
    }

    const projectPath = stripTrailingSlashes(plan.parentMeta.projectPath);
    return await this.runProjectForkExclusive(projectPath, async () => {
      const entryBeforeFork = this.readLaunchRow(plan.taskId);
      if (!this.mayMaterializeTaskWorkspace(plan, entryBeforeFork?.workspace)) {
        return null;
      }

      const forkResult = await orchestrateFork(
        this.taskForkOptions(plan, sourceRuntime, initLogger, plan.preferredTrunkBranch)
      );

      if (!forkResult.success) {
        throw new Error(`Task fork failed: ${forkResult.error}`);
      }

      return {
        workspacePath: forkResult.data.workspacePath,
        trunkBranch: forkResult.data.trunkBranch,
        forkedRuntimeConfig: forkResult.data.forkedRuntimeConfig,
        runtimeForTaskWorkspace: forkResult.data.targetRuntime,
        inheritedProjects: forkResult.data.projects,
        ...(forkResult.data.sourceRuntimeConfigUpdate != null
          ? { sourceRuntimeConfigUpdate: forkResult.data.sourceRuntimeConfigUpdate }
          : {}),
        reusedExistingCheckout: false,
      };
    });
  }

  private scheduleReservedTaskLaunch(plan: TaskLaunchPlan): void {
    assert(plan.taskId.length > 0, "scheduleReservedTaskLaunch requires taskId");
    void this.enqueueReservedTaskLaunch(plan).catch((error: unknown) => {
      log.error("Failed to launch reserved task", { taskId: plan.taskId, error });
      void this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error), plan).catch(
        (markError: unknown) => {
          // A rejected config write here would otherwise be an unhandled rejection (#4444).
          log.error("Failed to record reserved task launch failure", {
            taskId: plan.taskId,
            error: markError,
          });
        }
      );
    });
  }

  /**
   * Settles (never rejects) once the in-flight queue drain settles, including the launches it
   * awaits. Shutdown joins it: startup recovery schedules its drain instead of awaiting it, so
   * the recovery promise alone no longer covers those launches.
   */
  queueDrainSettled(): Promise<void> {
    return (
      this.maybeStartQueuedTasksInFlight?.then(
        () => undefined,
        () => undefined
      ) ?? Promise.resolve()
    );
  }

  scheduleMaybeStartQueuedTasks(): void {
    void this.maybeStartQueuedTasks().catch((error: unknown) => {
      log.error("TaskService.maybeStartQueuedTasks failed", { error });
    });
  }

  private async markTaskLaunchFailed(
    taskId: string,
    message: string,
    /**
     * The failing launch's plan, when the caller has it. Receipt evidence is positive and
     * captured, never a call-site whitelist: the plan names the owned attempt and its launch
     * fence never admitted the send (sendAdmitted still false). Without it the attempt settles in
     * memory only, as before receipts existed.
     */
    launch?: Pick<TaskLaunchPlan, "attemptId" | "sendAdmitted" | "abortSignal">
  ): Promise<void> {
    assert(taskId.length > 0, "markTaskLaunchFailed requires taskId");
    // A reserved launch that fails once shutdown has latched the sessions is not a task failure
    // (#4473): shutdown latches before its bounded join of the queue drain, so a launch still in
    // flight fails against the latch. The latch is set before any session refuses, so every such
    // failure observes it here. Leave the row untouched: startup recovery already requeues a
    // stale `starting` row (dropping a prompt history already accepted, marking the lineage
    // unproven), exactly as after a crash mid-launch. A failure that merely coincides with
    // shutdown is retried on the next start rather than recorded. The caller's own cancellation
    // stays authoritative.
    if (
      launch != null &&
      launch.abortSignal?.aborted !== true &&
      this.workspaceService.isShuttingDown()
    ) {
      log.info("Task launch failure during shutdown: leaving the task for startup recovery", {
        taskId,
        message,
      });
      return;
    }
    // The launch owner gives up: settle exactly the attempt it owned when it decided. The
    // closure is recorded inside the updater, against the fresh row's id, before the write is
    // awaited — no send can be admitted for that id from here on.
    const ownedAttempt = this.attemptLedger.ownedAttempt(taskId);
    let transitionedToInterrupted = false;
    let superseded = false;
    let parentWorkspaceId: string | undefined;
    try {
      await this.editWorkspaceEntry(
        taskId,
        (ws) => {
          // The failure belongs to the attempt this process owned; a row re-admitted by another
          // writer meanwhile is that writer's to end (see ownedAttemptSuperseded).
          if (this.ownedAttemptSuperseded(taskId, ws)) {
            superseded = true;
            return;
          }
          transitionedToInterrupted = ws.taskStatus !== "interrupted";
          parentWorkspaceId = ws.parentWorkspaceId;
          ws.taskStatus = "interrupted";
          markChildGoalPauseOwed(ws);
          ws.taskLaunchError = message;
          // Survives a restart: the in-memory record alone is lost with the process (#4674).
          if (this.initStateManager.getUnsanitizedCheckoutError(taskId)) {
            ws.taskCheckoutUnsanitized = true;
          }
          this.closeAttemptAdmission(taskId, ws.taskAttemptId, ownedAttempt, "launch-failed");
        },
        { allowMissing: true }
      );
    } catch (error) {
      // Fail closed (#4747): an unpersisted failure is not delivered to waiters, whose owner is
      // unknown when the updater never ran. But a waiter that attached while the task was
      // queued/starting arms its timeout only on the move to running, which this failed launch
      // never makes; arm it now (and for later waiters) so they settle at their timeout.
      this.waiters.armWaitersOfUnendedTask(taskId);
      throw error;
    }
    this.waiters.clearUnpersistedLaunchFailure(taskId);
    if (superseded) {
      log.info("Task launch failure not recorded: the record was re-admitted by another writer", {
        taskId,
        message,
      });
      return;
    }
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(taskId, parentWorkspaceId);
    }
    await this.settleChildGoalPause(taskId);
    // Launch evidence on top of the shared boundary (attemptCannotStillReport): this launch's own
    // fence never admitted its send, which the boundary alone cannot see once a send's obligation
    // was discharged.
    const neverSent =
      launch != null &&
      launch.sendAdmitted !== true &&
      launch.attemptId != null &&
      launch.attemptId === ownedAttempt?.attemptId;
    // Before any await below (the receipt write, the metadata emit): a successor's waiter
    // registered meanwhile must not be rejected as this attempt's.
    this.rejectWaiters(taskId, new Error(message));
    if (neverSent) {
      await this.attemptLedger.persistOwnedAttemptSettlement(
        taskId,
        ownedAttempt,
        "launch-failed",
        "launch-failed"
      );
    } else {
      this.settleOwnedTaskAttempt(taskId, ownedAttempt, "launch-failed");
    }
    await this.emitWorkspaceMetadata(taskId);
    this.scheduleMaybeStartQueuedTasks();
  }

  /**
   * The launch holds a "launch" use lease on the task's workspace until it settles.
   * The reservation (createMany, or the queue drain's CAS) takes
   * it before the row becomes `starting` and hands it over in the plan; a plan without one
   * takes it here. Each side publishes, then checks the other (see WorkspaceUseLeases): a removal
   * (or another structural mutator) publishes its gate, then refuses this lease, in this process
   * or another; the launch publishes the lease, then refuses a live gate. So a removal never
   * marks the row and deletes the checkout while the launch can still fork it back, and the
   * launch never needs to delete under another process's marker (the removal can abort and
   * release it mid-delete). Since a `starting` row's lease is published before the row is, another
   * backend's startup recovery, which reads the rows and then skips any with a live foreign
   * lease, never requeues (and relaunches) a task being prepared.
   */
  private async startReservedAgentTask(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "startReservedAgentTask requires taskId");
    let lease = plan.launchLease;
    plan.launchLease = undefined;
    if (lease == null) {
      try {
        lease = await workspaceUseLeasesFor(this.config).hold(plan.taskId, "launch");
      } catch (error) {
        if (!(error instanceof WorkspaceMutationInProgressError)) throw error;
        // A removal, archive or rename of the task is running: the launch refuses before it
        // touches anything, and fails its reservation as the admission would (a row it no longer
        // owns as `starting` is left alone).
        const row = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId)?.workspace;
        if (row?.taskStatus === "starting" && !this.launchSuperseded(plan, row)) throw error;
        return;
      }
    }
    try {
      await this.startReservedAgentTaskLeased(plan);
    } finally {
      await releaseLaunchLease(plan.taskId, lease);
    }
  }

  /**
   * The launch under its lease, in steps. Each step calls the next one right after its own last
   * await instead of returning a value to await, so no write, admission or send waits an extra
   * microtask. startReservedAgentTask awaits the whole chain before it releases the lease.
   */
  private async startReservedAgentTaskLeased(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.parentWorkspaceId.length > 0, "startReservedAgentTask requires parentWorkspaceId");
    if (plan.start.kind === "sendMessage") {
      assert(plan.start.prompt.length > 0, "startReservedAgentTask requires prompt");
    }

    const entryAtStart = this.readLaunchRow(plan.taskId);
    if (entryAtStart?.workspace.taskStatus !== "starting") {
      return;
    }
    // Stop-cascade barrier: no launch while its own or its parent's stop latch is held. The
    // reservation already flipped the record to "starting" and the scheduler selects only
    // "queued", so a deferred launch hands its record back or it is stranded; the latch release
    // rechecks the queue. Only a still-reserved record is reverted — a status written meanwhile
    // (an explicit Stop's "interrupted") stays as is and is never relaunched.
    if (this.taskStopLatch.deferLaunchWhileStopInProgress(plan.taskId, plan.parentWorkspaceId)) {
      await this.deferLaunchForStopLatch(plan);
      return;
    }

    // The launch belongs to the reservation it was scheduled for. A row naming another attempt
    // was re-admitted by another writer since (another backend's stale-starting revert followed
    // by its own reservation): that attempt is owned and dispatched there. Adopting it would make
    // two processes drive one attempt, and this launch's failure handling would interrupt or
    // delete the successor's record and checkout — so it abandons without touching anything.
    if (this.launchSuperseded(plan, entryAtStart.workspace)) {
      log.info("[task-attempt] launch abandoned: its reservation was superseded", {
        taskId: plan.taskId,
        reservedAttemptId: plan.attemptId,
        current: entryAtStart.workspace.taskAttemptId,
      });
      return;
    }
    await this.stampLaunchAttempt(plan, entryAtStart);
  }

  /**
   * Defers a launch while a stop latch is held (the barrier in startReservedAgentTaskLeased): a
   * still-reserved row goes back to `queued`, and the drain runs here if the latch was released
   * during that write.
   */
  private async deferLaunchForStopLatch(plan: TaskLaunchPlan): Promise<void> {
    log.debug("startReservedAgentTask deferred: a stop is in progress", { taskId: plan.taskId });
    try {
      await this.editActiveWorkspaceEntry(
        plan.taskId,
        (workspace) => {
          if (workspace.taskStatus !== "starting") return;
          if (rowSupersedes(workspace, plan.attemptId)) return;
          workspace.taskStatus = "queued";
        },
        { allowMissing: true }
      );
    } catch (error) {
      await this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error), plan);
      return;
    }
    await this.emitWorkspaceMetadata(plan.taskId);
    // The release-time drain may have seen "starting" while this rollback was awaiting disk.
    // Complete the handoff after publishing "queued", or leave the next release owning it.
    if (!this.taskStopLatch.deferLaunchWhileStopInProgress(plan.taskId, plan.parentWorkspaceId)) {
      this.scheduleMaybeStartQueuedTasks();
    }
  }

  /** Gives the launch its attempt id (stamped on a row without one), then adopts it. */
  private async stampLaunchAttempt(
    plan: TaskLaunchPlan,
    entryAtStart: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): Promise<void> {
    // An owned reservation (or the queue drain's launch CAS) keeps its identity through the
    // launch. A `starting` record nobody in this process owns under its current id (pre-identity
    // entry reached without the drain CAS) becomes owned here; without an id it is stamped
    // first, marked unproven — an older build's stale-starting revert may have relaunched an
    // admitted execution without any marker.
    let launchAttemptId = entryAtStart.workspace.taskAttemptId;
    let launchReceiptEligible = entryAtStart.workspace.taskAttemptUnproven !== true;
    if (!isTaskAttemptId(launchAttemptId)) {
      launchReceiptEligible = false;
      const stamped = newTaskAttemptId();
      try {
        await this.editActiveWorkspaceEntry(plan.taskId, (workspace) => {
          if (workspace.taskStatus !== "starting" || isTaskAttemptId(workspace.taskAttemptId)) {
            return;
          }
          workspace.taskAttemptId = stamped;
          workspace.taskAttemptUnproven = true;
        });
      } catch (error) {
        await this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error), plan);
        return;
      }
      launchAttemptId =
        findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId)?.workspace
          .taskAttemptId ?? stamped;
      this.attemptLedger.publishAttemptRotation(plan.taskId, launchAttemptId);
    }
    this.adoptLaunchAttempt(plan, launchAttemptId, launchReceiptEligible);
    await this.admitLaunchDesktopRecovery(plan, entryAtStart);
  }

  /** Binds the plan to the launch's attempt and owns that attempt in this process. */
  private adoptLaunchAttempt(
    plan: TaskLaunchPlan,
    launchAttemptId: string,
    launchReceiptEligible: boolean
  ): void {
    plan.attemptId = launchAttemptId;
    if (this.attemptLedger.ownedAttempt(plan.taskId)?.attemptId !== launchAttemptId) {
      this.beginOwnedTaskAttempt(plan.taskId, "launch", {
        attemptId: launchAttemptId,
        receiptEligible: launchReceiptEligible,
      });
    }
  }

  /** The desktop recovery admission between two cancel checks, then the materialize step. */
  private async admitLaunchDesktopRecovery(
    plan: TaskLaunchPlan,
    entryAtStart: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): Promise<void> {
    if (plan.abortSignal?.aborted) {
      await this.cancelReservedLaunch(plan);
      return;
    }

    // Revalidate persisted bindings on restart before materializing a checkout or starting init.
    if (!(await this.admitTaskDesktopRecovery(plan.taskId))) return;
    if (plan.abortSignal?.aborted) {
      await this.cancelReservedLaunch(plan);
      return;
    }
    await this.materializeLaunchCheckout(plan, entryAtStart);
  }

  /**
   * Starts the init log and materializes the task's checkout (a fork, or the shared parent
   * checkout it reuses), then builds the checkout record the later steps read.
   */
  private async materializeLaunchCheckout(
    plan: TaskLaunchPlan,
    entryAtStart: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): Promise<void> {
    // isolation: "none" tasks were queued pointing at the parent's checkout. When that checkout
    // still exists, materialization reuses it (no fork); if it disappeared, materialization falls
    // back to forking a real workspace and the shared flag must be cleared below.
    const taskWasShared = entryAtStart.workspace.taskIsolation === "none";

    const initLogger = this.startWorkspaceInit(plan.taskId, plan.parentMeta.projectPath);
    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) fork from the
    // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
    const parentEntryForLaunch = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.parentWorkspaceId
    );
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: plan.taskRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntryForLaunch?.workspace.path),
    });

    let materialized: MaterializedTaskLaunch | null;
    try {
      materialized = await this.materializeReservedTaskWorkspace(plan, runtime, initLogger);
    } catch (error: unknown) {
      initLogger.logComplete(-1);
      throw error;
    }
    if (!materialized) {
      initLogger.logComplete(-1);
      return;
    }

    // Track reuse explicitly: owner-derived paths can change during launch, so equality is unsafe.
    const sharesParentCheckout = taskWasShared && materialized.reusedExistingCheckout;
    const checkout: ReservedLaunchCheckout = {
      ...materialized,
      initLogger,
      taskWasShared,
      sharesParentCheckout,
    };
    if (plan.abortSignal?.aborted) {
      await this.cancelMaterializedLaunch(plan, checkout);
      return;
    }
    await this.updateLaunchSourceRuntime(plan, checkout);
  }

  /**
   * Rechecks the row after the fork, then writes the parent's runtime config when the fork
   * changed it.
   */
  private async updateLaunchSourceRuntime(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    const entryAfterMaterialize = this.readLaunchRowBeforeSanitize(plan, checkout);
    if (!entryAfterMaterialize) {
      checkout.initLogger.logComplete(-1);
      await this.cleanupLaunchCheckout(plan, checkout);
      return;
    }
    if (entryAfterMaterialize.workspace.taskStatus !== "starting") {
      checkout.initLogger.logComplete(-1);
      return;
    }

    if (checkout.sourceRuntimeConfigUpdate) {
      await this.config.updateWorkspaceMetadata(plan.parentWorkspaceId, {
        runtimeConfig: checkout.sourceRuntimeConfigUpdate,
      });
      await this.emitWorkspaceMetadata(plan.parentWorkspaceId);
    }

    await this.persistLaunchCheckout(plan, checkout);
  }

  /** Writes the checkout and its base commits on the task's row and publishes it. */
  private async persistLaunchCheckout(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    this.configureMultiProjectRuntimeEnvResolver(checkout.runtimeForTaskWorkspace);
    const base = await readTaskBaseCommits(plan, checkout);

    await this.editWorkspaceEntry(
      plan.taskId,
      (ws) => {
        if (ws.taskStatus !== "starting" || this.launchSuperseded(plan, ws)) {
          return;
        }
        ws.path = checkout.workspacePath;
        ws.runtimeConfig = checkout.forkedRuntimeConfig;
        ws.taskTrunkBranch = checkout.trunkBranch;
        ws.taskBaseCommitSha = base.taskBaseCommitSha;
        ws.taskBaseCommitShaByProjectPath = base.taskBaseCommitShaByProjectPath;
        ws.projects = checkout.inheritedProjects;
        // The shared parent checkout was gone, so this task had to fork a real workspace.
        // Clear the shared flag so removal cleans up the new worktree.
        if (checkout.taskWasShared && !checkout.sharesParentCheckout) {
          ws.taskIsolation = undefined;
        }
      },
      { allowMissing: true }
    );
    await this.emitWorkspaceMetadata(plan.taskId);
    if (plan.abortSignal?.aborted) {
      await this.cancelMaterializedLaunch(plan, checkout);
      return;
    }
    await this.sanitizeLaunchCheckout(plan, checkout);
  }

  /** Rechecks the persisted row, then sanitizes a forked checkout: sanitize or fail. */
  private async sanitizeLaunchCheckout(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    const entryBeforeSend = this.readLaunchRowBeforeSanitize(plan, checkout);
    if (!entryBeforeSend) {
      checkout.initLogger.logComplete(-1);
      await this.cleanupLaunchCheckout(plan, checkout);
      return;
    }
    if (
      entryBeforeSend.workspace.taskStatus !== "starting" ||
      this.launchSuperseded(plan, entryBeforeSend.workspace)
    ) {
      checkout.initLogger.logComplete(-1);
      return;
    }

    if (!checkout.sharesParentCheckout) {
      // SECURITY: task worktrees materialize AFTER their workspace entry is
      // registered, so creation-time plugin-override sanitization never saw
      // this checkout — a tracked stale `plugin:` enable would re-activate a
      // same-name reinstall's default-disabled MCP server on the first send.
      // Same contract as the host's create/fork paths: sanitize or fail.
      const sanitizeError = await this.workspaceService.sanitizeMaterializedTaskWorkspace(
        plan.taskId,
        checkout.workspacePath,
        checkout.forkedRuntimeConfig
      );
      if (sanitizeError !== undefined) {
        // Before any reclaim or init completion: MCP and sends refuse this checkout (#4674).
        this.initStateManager.markCheckoutUnsanitized(plan.taskId);
        // Reclaim the just-materialized worktree/session before failing the
        // launch: the throw reaches scheduleReservedTaskLaunch, which only
        // marks the task interrupted — without this cleanup the physical
        // checkout would accumulate and collide with later same-name forks.
        let reclaimed = false;
        try {
          reclaimed = (
            await this.reclaimUnsanitizedTaskCheckout(
              checkout.runtimeForTaskWorkspace,
              plan.parentMeta.projectPath,
              plan.workspaceName,
              plan.taskId,
              plan.attemptId
            )
          ).rowUnpublished;
        } finally {
          // SECURITY: init ends only after the reclaim attempt. Ending it releases every
          // request parked in waitForInit (MCP prompt discovery among them); released while
          // the row is still published, one would start MCP servers inside this unsanitized
          // checkout. A reclaimed task is gone (row, checkout, session dir): drop its init state
          // as workspace removal does, since completing it would recreate the session dir to
          // persist init-status.json. A retained checkout completes init so waiters don't hang.
          if (reclaimed) {
            this.initStateManager.clearInMemoryState(plan.taskId);
          } else {
            checkout.initLogger.logComplete(-1);
          }
        }
        throw new Error(sanitizeError);
      }
    }

    await this.initReservedLaunchWorkspace(plan, checkout);
  }

  /**
   * Starts the init in the task's own checkout (a shared parent checkout skips it), then admits
   * the prompt.
   */
  private async initReservedLaunchWorkspace(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    if (checkout.sharesParentCheckout) {
      // The parent's checkout is already initialized and live; re-running init would redundantly
      // (and possibly disruptively) mutate it. Skip init entirely.
      checkout.initLogger.logStep(
        "Sharing parent workspace (isolation: none) — skipping fork and init"
      );
      checkout.initLogger.logComplete(0);
      await this.admitReservedLaunchPrompt(plan, checkout);
      return;
    }
    const secrets = await secretsToRecord(
      this.secretsStore.getEffectiveSecrets(plan.parentMeta.projectPath)
    );
    // The sanitize and secrets awaits above leave a window in which the parent can cancel this
    // launch, the user can Stop the task, or a removal can mark it. Nothing aborts an init
    // started after that: a cancel and a Stop never do, and a removal aborts only the init
    // already running at its mark. So recheck all four right before starting the init (the
    // abort signal alone misses the Stop and the removal).
    if (plan.abortSignal?.aborted) {
      await this.cancelMaterializedLaunch(plan, checkout);
      return;
    }
    await this.registerReservedLaunchInit(plan, checkout, secrets);
  }

  /**
   * The three row rechecks after the abort check (a strict read, the status and attempt, a
   * removal mark), then the init registration and the prompt admission, in the same tick.
   */
  private async registerReservedLaunchInit(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout,
    secrets: Record<string, string>
  ): Promise<void> {
    let entryBeforeInit: ReturnType<typeof findWorkspaceEntry>;
    try {
      // Strict: an unreadable config.json must not read as a removed row, or the launch would
      // return without settling and leave the row `starting`. The throw reaches
      // scheduleReservedTaskLaunch, which marks the launch failed.
      entryBeforeInit = findWorkspaceEntry(
        this.config.loadConfigOrDefault({ throwOnError: true }),
        plan.taskId
      );
    } catch (error) {
      checkout.initLogger.logComplete(-1);
      throw error;
    }
    if (!entryBeforeInit) {
      checkout.initLogger.logComplete(-1);
      await this.cleanupLaunchCheckout(plan, checkout);
      return;
    }
    if (
      entryBeforeInit.workspace.taskStatus !== "starting" ||
      this.launchSuperseded(plan, entryBeforeInit.workspace)
    ) {
      checkout.initLogger.logComplete(-1);
      return;
    }
    if (entryBeforeInit.workspace.pendingRemoval != null) {
      // As the admission below would refuse it: the removal owns the row and its checkout.
      checkout.initLogger.logComplete(-1);
      await this.cleanupLaunchCheckout(plan, checkout);
      throw new Error(pendingRemovalAdmissionMessage(entryBeforeInit.workspace.pendingRemoval));
    }
    this.registerTaskBackgroundInit(plan, checkout, secrets);
    await this.admitReservedLaunchPrompt(plan, checkout);
  }

  /**
   * The launch's linearization point and launch fence: a cancel seen here never launched, and
   * past the admission only a Stop ends the execution. Then the send, in the same tick.
   */
  private async admitReservedLaunchPrompt(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    const startOptions = {
      model: plan.taskModelString,
      agentId: plan.agentId,
      thinkingLevel: plan.effectiveThinkingLevel,
      // Inherited pro mode: the send path re-gates per model/route, so this is
      // inert for non-GPT-5.6 task models.
      reasoningMode: plan.effectiveReasoningMode,
    };
    // Linearization point: cancellation observed here guarantees "never launched"; past the
    // admission below only a Stop (Layer 2) ends the execution.
    if (plan.abortSignal?.aborted) {
      await this.cancelMaterializedLaunch(plan, checkout);
      return;
    }
    // Launch fence (same-attempt send under the reservation's id): bind the obligation before
    // dispatch so a Stop landing during the send's own awaits captures it, and record that an
    // admission was attempted — a later launch failure can no longer claim "never admitted".
    const admission = this.admitTaskWorkspaceTurn(plan.taskId, {
      acceptanceOrigin: "automatic",
      expectedAttemptId: plan.attemptId,
    });
    if (admission.kind !== "admitted") {
      const message = launchAdmissionRefusalMessage(admission);
      await this.cleanupLaunchCheckout(plan, checkout);
      throw new Error(message);
    }
    plan.sendAdmitted = true;
    await this.sendReservedLaunchPrompt(plan, checkout, admission, startOptions);
  }

  /**
   * Sends the admitted prompt (or resumes the stream) under the admission token. A failed send
   * reclaims the checkout and fails the launch. A sent launch becomes `running`.
   */
  private async sendReservedLaunchPrompt(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout,
    admission: Extract<TaskTurnAdmission, { kind: "admitted" }>,
    startOptions: SendMessageOptions
  ): Promise<void> {
    // The token doubles as the send's staleness probe: a guarded send is never a user resume, so
    // WorkspaceService skips markInterruptedTaskRunning for it (that rescue serializes on the
    // global mutex createMany may still hold while this launch starts). The resume-kind start has
    // no probe seam; its rescue returns before the mutex because the record is still `starting`.
    const sendResult =
      plan.start.kind === "sendMessage"
        ? await this.workspaceService.sendMessage(plan.taskId, plan.start.prompt, startOptions, {
            acceptanceOrigin: "automatic",
            allowQueuedAgentTask: true,
            agentInitiated: true,
            turnAdmission: admission.token,
            admissionStale: () => admission.token.admissionStale(),
            // The row that accepts the brief carries its id: only that row, never this
            // send's result or callbacks, proves the brief reached history. A send can make its
            // rows durable and still return Err (a Stop makes its admission stale), and a Stop can
            // land after an Ok before `running`; both keep taskPrompt. Minted for this launch
            // and never offered before, so the publication skips the history read.
            sendIdentities: [
              {
                ...taskBriefSendIdentity(plan.start.prompt, plan.start.sendId),
                unpublished: true,
              },
            ],
            // On-send compaction would publish a compaction row, not the brief: the brief would
            // become a follow-up dispatched later without its id, so a durable-then-Err follow-up
            // could not be recognized and the brief would be sent twice. The brief runs as its
            // own turn instead; mid-stream compaction still protects the context limit.
            skipOnSendCompaction: true,
          })
        : await this.workspaceService.resumeStream(plan.taskId, startOptions, {
            acceptanceOrigin: "automatic",
            allowQueuedAgentTask: true,
            agentInitiated: true,
            turnAdmission: admission.token,
          });
    if (!sendResult.success) {
      const message = launchSendErrorMessage(sendResult.error);
      await this.cleanupLaunchCheckout(plan, checkout);
      throw new Error(message);
    }

    // A Stop can land between the pre-send check and this write (Layer 2 persists "interrupted"
    // BEFORE stopping the admitted turn). Only a record still in its reserved "starting" state
    // becomes "running"; a stopped record keeps its terminal status and its owned settlement.
    const transitioned = await this.setTaskStatus(plan.taskId, "running", {
      onlyFromStatus: "starting",
      expectedAttemptId: plan.attemptId,
    });
    if (!transitioned) {
      log.debug("startReservedAgentTask: reservation no longer starting after admission", {
        taskId: plan.taskId,
      });
    }
    this.scheduleMaybeStartQueuedTasks();
  }

  /** Cancels a launch after its fork, with the checkout's runtime and its shared flag. */
  private cancelMaterializedLaunch(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    return this.cancelReservedLaunch(plan, checkout.initLogger, {
      runtime: checkout.runtimeForTaskWorkspace,
      preservePhysicalWorkspace: checkout.sharesParentCheckout,
    });
  }

  /** Reclaims the launch's checkout (never the parent's shared one) when the launch ends early. */
  private cleanupLaunchCheckout(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): Promise<void> {
    return this.cleanupMaterializedTaskWorkspace(
      checkout.runtimeForTaskWorkspace,
      plan.parentMeta.projectPath,
      plan.workspaceName,
      plan.taskId,
      { preservePhysicalWorkspace: checkout.sharesParentCheckout }
    );
  }

  /**
   * The row reads between the fork and the sanitize step. A throw fails the launch, which
   * leaves the task resumable: first quarantine a checkout the sanitize step has not run in
   * (#4674: sends and MCP refuse it), then end the init so init waiters don't hang.
   */
  private readLaunchRowBeforeSanitize(
    plan: TaskLaunchPlan,
    checkout: ReservedLaunchCheckout
  ): ReturnType<typeof findWorkspaceEntry> {
    try {
      return this.readLaunchRow(plan.taskId);
    } catch (error) {
      if (!checkout.sharesParentCheckout) {
        this.initStateManager.markCheckoutUnsanitized(plan.taskId);
      }
      checkout.initLogger.logComplete(-1);
      throw error;
    }
  }

  createFromRpc(args: RpcTaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    return this.create({
      ...args,
      thinkingLevel: normalizeRpcTaskThinkingLevel(args.thinkingLevel),
    });
  }

  async create(args: TaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return Err("Task.create: parentWorkspaceId is required");
    }
    return await this.withTaskTreeLifecycleLock(parentWorkspaceId, async () =>
      this.createUnderTaskTreeLifecycleLock(args, parentWorkspaceId)
    );
  }

  private async createUnderTaskTreeLifecycleLock(
    args: TaskCreateArgs,
    parentWorkspaceId: string
  ): Promise<Result<TaskCreateResult, string>> {
    const request = this.readTaskCreateRequest(args, parentWorkspaceId);
    if (!request.success) {
      return request;
    }

    // Held until the create settles: every step below runs under it, and none takes it again (the
    // mutex is not reentrant). The step call must be awaited here: a bare `return promise` would
    // dispose the lock before the promise settles.
    await using _lock = await this.mutex.acquire();

    return await this.loadTaskCreateParent(request.data);
  }

  /** Validates a Task.create request before the global mutex is taken. */
  private readTaskCreateRequest(
    args: TaskCreateArgs,
    parentWorkspaceId: string
  ): Result<TaskCreateRequest, string> {
    if (args.kind !== "agent") {
      return Err("Task.create: unsupported kind");
    }

    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.create: prompt is required");
    }

    const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
    if (!normalizedAgentId) {
      return Err("Task.create: agentId is required");
    }

    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return Err(`Task.create: invalid agentId (${normalizedAgentId})`);
    }

    const normalizedBestOf = normalizeTaskCreateBestOf(args.bestOf);
    if (!normalizedBestOf.success) {
      return normalizedBestOf;
    }

    const agentId = parsedAgentId.data;
    const agentType = agentId; // Legacy alias for on-disk compatibility.
    let taskDesktopOwnerWorkspaceId: string | undefined;
    try {
      taskDesktopOwnerWorkspaceId = this.resolveTaskDesktopOwner(args, agentId);
    } catch (error) {
      return Err(getErrorMessage(error));
    }

    return Ok({
      args,
      parentWorkspaceId,
      prompt,
      agentId,
      agentType,
      normalizedBestOf: normalizedBestOf.data,
      taskDesktopOwnerWorkspaceId,
    });
  }

  /**
   * Task.create under the global mutex: reads the parent, then chains to countAndPlaceTask and
   * the later steps. Each step starts the next in the same tick as its own last await, so no call
   * runs later than it did inline.
   */
  private async loadTaskCreateParent(
    request: TaskCreateRequest
  ): Promise<Result<TaskCreateResult, string>> {
    // Validate parent exists and fetch runtime context.
    const parentMetaResult = await this.aiService.getWorkspaceMetadata(request.parentWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.create: parent workspace not found (${parentMetaResult.error})`);
    }
    const parent = this.readTaskCreateParent(request, parentMetaResult.data);
    if (!parent.success) {
      return parent;
    }
    return this.countAndPlaceTask(parent.data);
  }

  /** Reads the parent's config facts once, and refuses an archived parent or untrusted project. */
  private readTaskCreateParent(
    request: TaskCreateRequest,
    parentMeta: WorkspaceMetadata
  ): Result<TaskCreateParent, string> {
    const { parentWorkspaceId } = request;
    // Enforce nesting depth.
    const cfg = this.config.loadConfigOrDefault();
    // #6426: once per create, from the loaded config.
    const projectPluginsTrusted = isWorkspaceProjectTrustedIn(cfg.projects, parentMeta);
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    const legacyParentRow = this.legacyParentRowOf(cfg, parentWorkspaceId);
    if (
      parentEntry != null &&
      isWorkspaceArchived(parentEntry.workspace.archivedAt, parentEntry.workspace.unarchivedAt)
    ) {
      return Err("Task.create: parent workspace is archived");
    }
    const parentIsScratch = parentEntry?.workspace.kind === "scratch";
    const configProjectPath = parentIsScratch
      ? SCRATCH_PROJECT_CONFIG_KEY
      : stripTrailingSlashes(parentMeta.projectPath);

    // Trust gate: block task creation for untrusted projects.
    // The frontend shows a confirmation dialog for primary workspace creation,
    // but task spawning bypasses the UI — enforce trust here as defense-in-depth.
    const taskProjectConfig = cfg.projects.get(configProjectPath);
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    return Ok({
      ...request,
      parentMeta,
      cfg,
      projectPluginsTrusted,
      taskSettings,
      parentEntry,
      legacyParentRow,
      parentIsScratch,
      configProjectPath,
    });
  }

  /** Refuses a stopped or too-deep parent, then counts the active tasks and names the new task. */
  private async countAndPlaceTask(
    parent: TaskCreateParent
  ): Promise<Result<TaskCreateResult, string>> {
    const { cfg, taskSettings, agentId } = parent;
    const refusal = this.refuseTaskCreateUnderParent(parent);
    if (refusal !== undefined) {
      return refusal;
    }

    // Enforce parallelism (global).
    const activeCount =
      this.countActiveAgentTasks(cfg) +
      (await this.getWorkspaceTurnManager().countActiveWorkspaceTurns());
    const shouldQueue = activeCount >= taskSettings.maxParallelAgentTasks;

    const taskId = this.config.generateStableId();
    const workspaceName = buildAgentWorkspaceName(agentId, taskId);

    const nameValidation = validateWorkspaceName(workspaceName);
    if (!nameValidation.valid) {
      return Err(
        `Task.create: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
      );
    }

    const placement = this.placeTaskWorkspace(parent, {
      activeCount,
      shouldQueue,
      taskId,
      workspaceName,
    });
    if (!placement.success) {
      return placement;
    }
    return this.readTaskCreateParentBranch(placement.data);
  }

  /** The parent-state and nesting-depth gates: the refusal, or undefined to admit the child. */
  private refuseTaskCreateUnderParent(parent: TaskCreateParent): Result<never, string> | undefined {
    const { cfg, parentEntry, parentWorkspaceId, taskSettings } = parent;
    if (
      parentEntry?.workspace.taskStatus === "interrupted" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.create: cannot spawn new tasks after task_stop");
    }

    if (
      parentEntry?.workspace.taskStatus === "reported" &&
      !isActiveWorkspaceTurnTaskStatus(parentEntry.workspace.taskExecutionStatus)
    ) {
      return Err("Task.create: cannot spawn new tasks after agent_report");
    }

    const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
    if (requestedDepth > taskSettings.maxTaskNestingDepth) {
      return Err(
        `Task.create: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
      );
    }

    return undefined;
  }

  /** Builds the task's runtime from the parent's and decides whether it shares the checkout. */
  private placeTaskWorkspace(
    parent: TaskCreateParent,
    counted: Pick<TaskCreatePlacement, "activeCount" | "shouldQueue" | "taskId" | "workspaceName">
  ): Result<TaskCreatePlacement, string> {
    const { args, parentMeta, parentEntry, parentIsScratch } = parent;
    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
    // parent's REAL checkout — critical when the parent is itself an isolation: "none" task whose
    // synthetic name has no derived checkout (agent discovery + fork source both depend on it).
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: taskRuntimeConfig,
      projectPath: parentMeta.projectPath,
      name: parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
    });

    // Validate the agent definition exists and is runnable as a sub-agent.
    // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
    // itself an isolation: "none" task, its name is synthetic and the derived path does not exist —
    // its real checkout is the persisted (shared) path. Persisted paths are canonical elsewhere too
    // (see runtimeHelpers.resolveWorkspaceRootPath).
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : (coerceNonEmptyString(parentEntry?.workspace.path) ??
        runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

    // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead of
    // forking a new one. Only honored on runtimes where the fork creates a separate checkout we can
    // safely bypass (worktree/SSH) and for single-project parents; multi-project parents on those
    // runtimes are refused (see MULTI_PROJECT_SHARED_ISOLATION_ERROR); otherwise fall back to forking.
    const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
    const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
    const sharedWorkspace = decideSharedTaskWorkspace(
      args.isolation,
      taskRuntimeMode,
      parentIsScratch,
      parentIsMultiProject
    );
    if (!sharedWorkspace.success) {
      return sharedWorkspace;
    }
    return Ok({
      ...parent,
      ...counted,
      parentRuntimeConfig,
      taskRuntimeConfig,
      runtime,
      parentWorkspacePath,
      taskRuntimeMode,
      parentIsMultiProject,
      useSharedWorkspace: sharedWorkspace.data,
    });
  }

  /**
   * Task.create once the task is placed: reads the parent's checked-out branch, then chains to
   * checkTaskAgentRunnable and resolveTaskCreateAiSettings, which queues or launches the task.
   * Each step starts the next in the same tick as its own last await.
   */
  private async readTaskCreateParentBranch(
    placement: TaskCreatePlacement
  ): Promise<Result<TaskCreateResult, string>> {
    const {
      args,
      parentEntry,
      parentMeta,
      runtime,
      parentWorkspacePath,
      useSharedWorkspace,
      taskId,
      taskRuntimeMode,
      parentIsMultiProject,
    } = placement;
    // The branch actually checked out in the parent's checkout (see readTaskParentBranch): an
    // isolation: "none" parent's name, and an auto-named worktree parent's, name no branch.
    // Persisting the real branch keeps dequeue fork-fallbacks (preferredTrunkBranch) on an
    // existing base, and a shared task's review base on the branch its checkout is on.
    const parentBranchName = await readTaskParentBranch(parentEntry, parentMeta, () => ({
      runtime,
      workspacePath: parentWorkspacePath,
    }));
    if (args.isolation === "none" && !useSharedWorkspace) {
      log.debug("Task.create: isolation=none not honored; falling back to fork", {
        taskId,
        runtimeMode: taskRuntimeMode,
        parentIsMultiProject,
      });
    }
    return this.checkTaskAgentRunnable(placement, parentBranchName);
  }

  /**
   * Builds the error hint with all available runnable agents.
   * NOTE: This resolves frontmatter inheritance so same-name overrides (e.g. project exec.md
   * with base: exec) still count as runnable.
   */
  private async describeRunnableTaskAgents(placement: TaskCreatePlacement): Promise<string> {
    const { args, cfg, runtime, parentWorkspacePath, projectPluginsTrusted } = placement;
    try {
      const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath, {
        projectPluginsTrusted,
        runtimeFactory: nodeRuntimeFactory,
      });

      const runnableIds = (
        await Promise.all(
          allAgents.map(async (agent) => {
            try {
              const frontmatter = await resolveAgentFrontmatter(
                runtime,
                parentWorkspacePath,
                agent.id,
                {
                  skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope),
                  projectPluginsTrusted,
                  runtimeFactory: nodeRuntimeFactory,
                }
              );
              if (
                !isAgentRunnableAsChild(frontmatter, {
                  workflowOwned: args.workflowTask != null,
                })
              ) {
                return null;
              }

              const effectivelyDisabled = isAgentEffectivelyDisabled({
                cfg,
                agentId: agent.id,
                resolvedFrontmatter: frontmatter,
              });
              return effectivelyDisabled ? null : agent.id;
            } catch {
              return null;
            }
          })
        )
      ).filter((id): id is string => typeof id === "string");

      return runnableIds.length > 0
        ? `Runnable agentIds: ${runnableIds.join(", ")}`
        : "No runnable agents available";
    } catch {
      return "Could not discover available agents";
    }
  }

  /** Refuses an agent that is unknown, disabled or not runnable as a sub-agent. */
  private async checkTaskAgentRunnable(
    placement: TaskCreatePlacement,
    parentBranchName: string | undefined
  ): Promise<Result<TaskCreateResult, string>> {
    const { args, cfg, agentId, runtime, parentWorkspacePath, projectPluginsTrusted } = placement;
    let skipInitHook = false;
    try {
      const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId, {
        projectPluginsTrusted,
        runtimeFactory: nodeRuntimeFactory,
      });
      if (!isAgentRunnableAsChild(frontmatter, { workflowOwned: args.workflowTask != null })) {
        const hint = await this.describeRunnableTaskAgents(placement);
        return Err(`Task.create: agentId is not runnable as a sub-agent (${agentId}). ${hint}`);
      }

      if (
        isAgentEffectivelyDisabled({
          cfg,
          agentId,
          resolvedFrontmatter: frontmatter,
        })
      ) {
        const hint = await this.describeRunnableTaskAgents(placement);
        return Err(`Task.create: agentId is disabled (${agentId}). ${hint}`);
      }
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
    } catch (error) {
      if (isRuntimeTransportError(error)) {
        return Err(
          formatRuntimeUnreachableError(`Task.create: could not verify agentId (${agentId})`, error)
        );
      }
      const hint = await this.describeRunnableTaskAgents(placement);
      return Err(`Task.create: unknown agentId (${agentId}). ${hint}`);
    }
    return this.resolveTaskCreateAiSettings(placement, parentBranchName, skipInitHook);
  }

  /** Resolves the task's model and thinking settings, then queues or launches the task. */
  private async resolveTaskCreateAiSettings(
    placement: TaskCreatePlacement,
    parentBranchName: string | undefined,
    skipInitHook: boolean
  ): Promise<Result<TaskCreateResult, string>> {
    const {
      args,
      cfg,
      parentWorkspaceId,
      parentMeta,
      agentId,
      runtime,
      parentWorkspacePath,
      projectPluginsTrusted,
      taskId,
      workspaceName,
      activeCount,
      taskSettings,
      shouldQueue,
      taskRuntimeConfig,
      prompt,
    } = placement;
    let taskModelString: string;
    let canonicalModel: string;
    let effectiveThinkingLevel: ThinkingLevel;
    let effectiveReasoningMode: OpenAIReasoningMode | undefined;
    let taskAiPins: TaskAiPins;
    try {
      ({
        taskModelString,
        canonicalModel,
        effectiveThinkingLevel,
        effectiveReasoningMode,
        pins: taskAiPins,
      } = await this.resolveTaskAISettings({
        cfg,
        parentWorkspaceId,
        parentMeta,
        agentId,
        modelString: args.modelString,
        thinkingLevel: args.thinkingLevel,
        parentRuntimeAiSettings: args.parentRuntimeAiSettings,
        definitionContext: {
          runtime,
          workspacePath: parentWorkspacePath,
          workspaceId: parentWorkspaceId,
          projectPluginsTrusted,
          runtimeFactory: nodeRuntimeFactory,
        },
      }));
    } catch (error) {
      if (error instanceof InvalidExplicitAiSettingError) {
        return Err(`Task.create: ${error.message}`);
      }
      if (isRuntimeTransportError(error)) {
        return Err(formatRuntimeUnreachableError("Task.create", error));
      }
      throw error;
    }

    const createdAt = getIsoNow();

    taskQueueDebug("TaskService.create decision", {
      parentWorkspaceId,
      taskId,
      agentId,
      workspaceName,
      createdAt,
      activeCount,
      maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
      shouldQueue,
      runtimeType: taskRuntimeConfig.type,
      workflowRunId: args.workflowTask?.runId,
      workflowStepId: args.workflowTask?.stepId,
      promptLength: prompt.length,
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
    });

    const plan: TaskCreatePlan = {
      ...placement,
      parentBranchName,
      skipInitHook,
      taskModelString,
      canonicalModel,
      effectiveThinkingLevel,
      effectiveReasoningMode,
      taskAiPins,
      createdAt,
    };

    if (shouldQueue) {
      return this.createQueuedTask(plan);
    }

    return this.launchTask(plan);
  }

  /**
   * Task.create's direct launch: materializes the checkout and persists the entry under the
   * desktop gate, then chains to sanitizeTaskLaunchCheckout. Runs under the global mutex that
   * createUnderTaskTreeLifecycleLock holds.
   */
  private async launchTask(plan: TaskCreatePlan): Promise<Result<TaskCreateResult, string>> {
    const launch: TaskLaunchState = {
      // Set once a checkout exists for this task: a throw after that point (base-SHA read, config
      // persistence) must roll the checkout back instead of leaking it like an unhandled rejection.
      materializedCheckout: undefined,
      // Admission classification: a direct (unqueued) launch is the FIRST admission of a brand-new
      // task by construction, exactly like a reservation — the id minted here is persisted by the
      // write that creates the entry and owned by this process before anything can send into the
      // workspace; a launch failure below settles that ownership (launch failed) as soon as nothing
      // runs under it, so a Stop or reawaken never meets an owned attempt without settlement
      // evidence while work still running under it keeps its own settlement.
      attemptId: newTaskAttemptId(),
      launchAttempt: undefined,
      // Flipped when the launch fence admits the send (as TaskLaunchPlan.sendAdmitted): a failure
      // that observes it false has positive evidence that this launch never dispatched its prompt.
      sendAdmitted: false,
    };
    const materialized = await this.reserveTaskDesktop(plan, () =>
      this.materializeTaskCheckout(plan, launch)
    ).catch((error: unknown) => Err(getErrorMessage(error)));
    if (!materialized.success) {
      if (launch.materializedCheckout != null) {
        // Runs after the desktop gate released: only the checkout and any persisted entry (which
        // would otherwise hold the desktop reservation as a running child) need to go.
        await this.failTaskLaunch(
          plan,
          launch,
          materialized.error,
          launch.materializedCheckout.runtime,
          {
            preservePhysicalWorkspace: plan.useSharedWorkspace,
          }
        );
        launch.materializedCheckout.initLogger.logComplete(-1);
      }
      return materialized;
    }
    return this.sanitizeTaskLaunchCheckout(plan, launch, materialized.data);
  }

  /**
   * Shares the parent's checkout or forks a new one, then persists the task's entry and owns its
   * launch attempt. Runs inside the desktop gate (reserveTaskDesktop).
   */
  private async materializeTaskCheckout(
    plan: TaskCreatePlan,
    launch: TaskLaunchState
  ): Promise<Result<TaskLaunchCheckout, string>> {
    const { taskId, workspaceName, parentWorkspaceId, parentMeta } = plan;
    const initLogger = this.startWorkspaceInit(taskId, parentMeta.projectPath);

    let checkout: MaterializedTaskCheckout;
    if (plan.useSharedWorkspace) {
      checkout = this.shareParentCheckout(plan, initLogger);
    } else {
      // Note: Local project-dir runtimes share the same directory (unsafe by design).
      // For worktree/ssh runtimes we attempt a fork first; otherwise fall back to createWorkspace.
      const forkResult = await orchestrateFork(this.buildTaskForkOptions(plan, initLogger));

      if (!forkResult.success) {
        initLogger.logComplete(-1);
        return Err(`Task fork failed: ${forkResult.error}`);
      }

      checkout = {
        initLogger,
        workspacePath: forkResult.data.workspacePath,
        trunkBranch: forkResult.data.trunkBranch,
        forkedRuntimeConfig: forkResult.data.forkedRuntimeConfig,
        sourceRuntimeConfigUpdate: forkResult.data.sourceRuntimeConfigUpdate,
        runtimeForTaskWorkspace: forkResult.data.targetRuntime,
        forkedFromSource: forkResult.data.forkedFromSource,
        inheritedProjects: forkResult.data.projects,
      };
    }
    const { workspacePath, trunkBranch, runtimeForTaskWorkspace } = checkout;

    launch.materializedCheckout = { initLogger, runtime: runtimeForTaskWorkspace };

    // Multi-project forks need per-project secrets for each runtime's init hook.
    this.configureMultiProjectRuntimeEnvResolver(runtimeForTaskWorkspace);

    const base = await readTaskBaseCommits(plan, checkout);

    taskQueueDebug("TaskService.create started (workspace created)", {
      taskId,
      workspaceName,
      workspacePath,
      trunkBranch,
      forkSuccess: checkout.forkedFromSource,
    });

    // Persist workspace entry before starting work so it's durable across crashes.
    await this.config.editConfig((config) =>
      this.appendLaunchedTaskEntry(config, plan, launch, checkout, base)
    );
    // Owned before the entry is announced (emitWorkspaceMetadata below): the first send into
    // this workspace, whoever issues it, is admitted under an attempt this process owns.
    launch.launchAttempt = this.beginOwnedTaskAttempt(taskId, "launch", {
      attemptId: launch.attemptId,
      receiptEligible: true,
    });
    if (checkout.sourceRuntimeConfigUpdate != null) {
      // Ensure UI gets the updated runtimeConfig for the parent workspace.
      await this.emitWorkspaceMetadata(parentWorkspaceId);
    }

    return Ok(checkout);
  }

  /** isolation: "none": the task runs in the parent workspace's checkout, without fork or init. */
  private shareParentCheckout(
    plan: TaskCreatePlan,
    initLogger: InitLogger
  ): MaterializedTaskCheckout {
    // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead
    // of forking. Mirrors local-runtime semantics for worktree/SSH so read-only analysis (or
    // prompt-isolated work) skips the fork + init overhead and sees the parent's uncommitted work.
    //
    // SAFETY: the task still gets a unique workspace name, and workspace deletion is keyed on that
    // name (runtime.deleteWorkspace(projectPath, name)), so removing this task never deletes the
    // shared parent checkout. workspaceService.remove additionally skips physical deletion for
    // tasks persisted with taskIsolation === "none".
    const workspacePath = plan.parentWorkspacePath;
    const trunkBranch = plan.parentBranchName ?? "main";
    // Build the runtime with the child's identity but the parent's checkout path. Worktree/SSH
    // runtimes honor this persisted path override (see *Runtime.getWorkspacePath), so cwd
    // resolution and ensureReady land in the shared parent checkout instead of a name-derived
    // directory that was never created. This mirrors the runtime rebuilt from the persisted entry.
    const runtimeForTaskWorkspace = createRuntimeForWorkspace({
      runtimeConfig: plan.parentRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.workspaceName,
      namedWorkspacePath: plan.parentWorkspacePath,
    });
    initLogger.logStep("Sharing parent workspace (isolation: none) — skipping fork and init");
    initLogger.logComplete(0);
    return {
      initLogger,
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig: plan.parentRuntimeConfig,
      sourceRuntimeConfigUpdate: undefined,
      runtimeForTaskWorkspace,
      forkedFromSource: false,
      inheritedProjects: plan.parentMeta.projects,
    };
  }

  /** The orchestrateFork options for a direct launch that forks its parent's checkout. */
  private buildTaskForkOptions(
    plan: TaskCreatePlan,
    initLogger: InitLogger
  ): Parameters<typeof orchestrateFork>[0] {
    const { parentMeta, parentBranchName } = plan;
    return this.taskForkOptions(
      plan,
      plan.runtime,
      initLogger,
      // Create-fallback base when the fork cannot detect a source branch — a shared parent's
      // synthetic name, or an auto-named worktree parent's, names no branch, so supply the
      // actual checked-out branch. Only then: other parents keep the existing
      // branch-discovery fallback.
      parentBranchName != null && parentBranchName !== parentMeta.name
        ? parentBranchName
        : undefined
    );
  }

  /**
   * The orchestrateFork options for a task that forks its parent's checkout. The reserved launch
   * and a direct launch differ only in the source runtime and the create-fallback trunk branch.
   */
  private taskForkOptions(
    plan: TaskLaunchSource,
    sourceRuntime: Runtime,
    initLogger: InitLogger,
    preferredTrunkBranch: string | undefined
  ): Parameters<typeof orchestrateFork>[0] {
    return {
      sourceRuntime,
      projectPath: plan.parentMeta.projectPath,
      sourceWorkspaceName: plan.parentMeta.name,
      newWorkspaceName: plan.workspaceName,
      newWorkspaceId: plan.taskId,
      initLogger,
      config: this.config,
      sourceWorkspaceId: plan.parentWorkspaceId,
      sourceRuntimeConfig: plan.parentRuntimeConfig,
      parentMetadata: plan.parentMeta,
      allowCreateFallback: true,
      ...(preferredTrunkBranch != null ? { preferredTrunkBranch } : {}),
      trusted:
        this.config.loadConfigOrDefault().projects.get(plan.configProjectPath)?.trusted ?? false,
      multiProjectExperimentEnabled: this.workspaceService.isExperimentEnabled(
        EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
      ),
    };
  }

  /** The direct launch's config edit: appends the running task's row under its parent's project. */
  private appendLaunchedTaskEntry(
    config: ProjectsConfig,
    plan: TaskCreatePlan,
    launch: TaskLaunchState,
    checkout: MaterializedTaskCheckout,
    base: Pick<WorkspaceConfigEntry, "taskBaseCommitSha" | "taskBaseCommitShaByProjectPath">
  ): ProjectsConfig {
    const { taskId, parentWorkspaceId, effectiveThinkingLevel, effectiveReasoningMode } = plan;
    const { sourceRuntimeConfigUpdate } = checkout;
    assertParentAdmitsChild(config, parentWorkspaceId, {
      requireRow: plan.parentEntry != null,
      legacyRow: plan.legacyParentRow,
    });
    if (sourceRuntimeConfigUpdate != null) {
      const parentRow = Array.from(config.projects.values())
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.id === parentWorkspaceId);
      if (parentRow == null) {
        throw new Error(`Workspace ${parentWorkspaceId} not found in config`);
      }
      parentRow.runtimeConfig = sourceRuntimeConfigUpdate;
    }
    let projectConfig = config.projects.get(plan.configProjectPath);
    if (!projectConfig) {
      projectConfig = { workspaces: [] };
      config.projects.set(plan.configProjectPath, projectConfig);
    }

    projectConfig.workspaces.push({
      kind: plan.parentIsScratch ? "scratch" : undefined,
      path: checkout.workspacePath,
      id: taskId,
      name: plan.workspaceName,
      title: plan.args.title,
      createdAt: plan.createdAt,
      runtimeConfig: checkout.forkedRuntimeConfig,
      // New rows have no legacy plan to migrate (#5174).
      remotePlanMigrated: true,
      aiSettings: {
        model: plan.canonicalModel,
        thinkingLevel: effectiveThinkingLevel,
        ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
      },
      agentId: plan.agentId,
      parentWorkspaceId,
      agentType: plan.agentType,
      workflowTask: plan.args.workflowTask,
      bestOf: plan.normalizedBestOf,
      taskStatus: "running",
      // Direct (unqueued) launch: this write is the admission, so it stamps the attempt id the
      // send below is fenced against (WorkspaceService binds the obligation at handoff).
      taskAttemptId: launch.attemptId,
      taskTrunkBranch: checkout.trunkBranch,
      taskBaseCommitSha: base.taskBaseCommitSha,
      taskBaseCommitShaByProjectPath: base.taskBaseCommitShaByProjectPath,
      taskModelString: plan.taskModelString,
      taskThinkingLevel: effectiveThinkingLevel,
      taskAiPins: plan.taskAiPins,
      taskOnRefusal: plan.args.onRefusal,
      taskIsolation: plan.useSharedWorkspace ? "none" : undefined,
      taskAttentionPolicy: plan.args.attentionPolicy,
      taskDesktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
      projects: checkout.inheritedProjects,
    });
    this.desktopInputCoordinator.assertAdmission(config, taskId);
    return config;
  }

  /**
   * The direct launch after its entry is persisted. Sanitizes the materialized checkout, then
   * chains to announceAndInitTask and sendTaskLaunchPrompt: each step starts the next in the same
   * tick as its own last await, so no call runs later than it did inline.
   */
  private async sanitizeTaskLaunchCheckout(
    plan: TaskCreatePlan,
    launch: TaskLaunchState,
    checkout: TaskLaunchCheckout
  ): Promise<Result<TaskCreateResult, string>> {
    if (!plan.useSharedWorkspace) {
      // SECURITY: this checkout materialized outside the host's create/fork paths, so
      // registration-time plugin-override sanitization never saw it —
      // a tracked stale `plugin:` enable would re-activate a same-name
      // reinstall's default-disabled MCP server on the send below. Runs
      // BEFORE emitWorkspaceMetadata (the pre-announcement invariant of
      // normal workspace creation): once metadata is emitted, the UI or any
      // subscriber can send to this running-status task workspace while
      // sanitization is still waiting on the override lock.
      const sanitizeError = await this.workspaceService.sanitizeMaterializedTaskWorkspace(
        plan.taskId,
        checkout.workspacePath,
        checkout.forkedRuntimeConfig
      );
      if (sanitizeError !== undefined) {
        // The row stays published with this checkout: MCP and sends refuse it (#4674).
        this.initStateManager.markCheckoutUnsanitized(plan.taskId);
        await this.failTaskLaunch(
          plan,
          launch,
          sanitizeError,
          checkout.runtimeForTaskWorkspace,
          {}
        );
        checkout.initLogger.logComplete(-1);
        return Err(sanitizeError);
      }
    }
    return this.announceAndInitTask(plan, launch, checkout);
  }

  /** Announces the launched task's workspace and kicks its init, then sends the prompt. */
  private async announceAndInitTask(
    plan: TaskCreatePlan,
    launch: TaskLaunchState,
    checkout: TaskLaunchCheckout
  ): Promise<Result<TaskCreateResult, string>> {
    const { taskId } = plan;
    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

    // Kick init (best-effort, async). Shared-workspace (isolation: "none") tasks reuse the parent's
    // already-initialized checkout, so re-running init would redundantly (and possibly disruptively)
    // mutate the live parent workspace — skip it entirely.
    if (!plan.useSharedWorkspace) {
      const secrets = await secretsToRecord(
        this.secretsStore.getEffectiveSecrets(plan.parentMeta.projectPath)
      );
      this.registerTaskBackgroundInit(plan, checkout, secrets);
    }
    return this.sendTaskLaunchPrompt(plan, launch, checkout);
  }

  /** Starts a launched task's init in its own checkout (callers skip a shared parent checkout). */
  private registerTaskBackgroundInit(
    plan: TaskLaunchSource,
    checkout: Omit<TaskLaunchCheckout, "forkedRuntimeConfig">,
    env: Record<string, string>
  ): void {
    // Registered (not just fired) with the host's abort-and-settlement mechanism:
    // a model-driven archive of this task workspace must be able to cancel the init and
    // must wait for the hook process's actual exit before snapshot capture, checkout
    // deletion, or Coder hooks can proceed (see initSettlementPromises).
    const initAbortController = new AbortController();
    this.workspaceService.registerExternalBackgroundInit(
      plan.taskId,
      initAbortController,
      runBackgroundInit(
        checkout.runtimeForTaskWorkspace,
        {
          projectPath: plan.parentMeta.projectPath,
          branchName: plan.workspaceName,
          trunkBranch: checkout.trunkBranch,
          workspacePath: checkout.workspacePath,
          initLogger: checkout.initLogger,
          env,
          abortSignal: initAbortController.signal,
          skipInitHook: plan.skipInitHook,
          trusted:
            this.config.loadConfigOrDefault().projects.get(plan.configProjectPath)?.trusted ??
            false,
        },
        plan.taskId,
        workspaceUseLeasesFor(this.config)
      )
    );
  }

  /** Admits the launch's prompt under the attempt it persisted and sends it. */
  private async sendTaskLaunchPrompt(
    plan: TaskCreatePlan,
    launch: TaskLaunchState,
    checkout: TaskLaunchCheckout
  ): Promise<Result<TaskCreateResult, string>> {
    const { taskId, taskModelString, effectiveThinkingLevel } = plan;
    // Start immediately (counts towards parallel limit). Launch fence, as in startReservedAgentTask:
    // the obligation is bound under the owned attempt before dispatch and the token doubles as the
    // send's staleness probe. A guarded send is never a user resume, so WorkspaceService skips
    // markInterruptedTaskRunning for it — which matters here because this method holds the global
    // mutex that method serializes on (a rescue reaching it from this send would self-deadlock).
    // Bound to the attempt this launch persisted: the row was published above (metadata emitted,
    // sanitization awaited), so another writer may have re-admitted it under its own attempt
    // since — a launch decided for A never dispatches its prompt under B (refused, and the
    // failure path below leaves B's row alone).
    const admission = this.admitTaskWorkspaceTurn(taskId, {
      acceptanceOrigin: "automatic",
      expectedAttemptId: launch.attemptId,
    });
    launch.sendAdmitted = admission.kind === "admitted";
    const sendResult =
      admission.kind !== "admitted"
        ? Err(launchAdmissionRefusalMessage(admission))
        : await this.workspaceService
            .sendMessage(
              taskId,
              plan.prompt,
              {
                model: taskModelString,
                agentId: plan.agentId,
                thinkingLevel: effectiveThinkingLevel,
                reasoningMode: plan.effectiveReasoningMode,
              },
              {
                acceptanceOrigin: "automatic",
                agentInitiated: true,
                turnAdmission: admission.token,
                admissionStale: () => admission.token.admissionStale(),
              }
            )
            .catch((error: unknown) => Err(getErrorMessage(error)));
    if (!sendResult.success) {
      const message = launchSendErrorMessage(sendResult.error);
      await this.failTaskLaunch(plan, launch, message, checkout.runtimeForTaskWorkspace, {
        preservePhysicalWorkspace: plan.useSharedWorkspace,
      });
      return Err(message);
    }

    return Ok({
      taskId,
      kind: "agent",
      status: "running",
      modelString: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
      desktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId ?? taskId,
    });
  }

  /**
   * Launch failure. Before the entry is persisted (launchAttempt unset) nothing is published:
   * only the materialized checkout exists and the rollback removes it. Once the entry is
   * persisted the workspace IS published — a racing user or peer send can be admitted under
   * the attempt while the launch send is in flight, and another writer (a second backend's
   * startup re-drive or reawaken) can re-admit the row under its own attempt (A → B). Deleting
   * the row, checkout and session dir underneath those obligations, or underneath the other
   * writer's attempt, would strand them — so a published launch is never rolled back: it ends
   * as an interrupted workspace with its launch error (removable like any other), exactly as
   * the queued launch's markTaskLaunchFailed leaves it, and every step is bound to the attempt
   * this launch decided:
   *  1. the closure (synchronous: no further send binds to the id);
   *  2. the durable marker, a CAS on the row still naming this attempt — a row another writer
   *     re-admitted is that writer's to end (no marker, no stop, no metadata for it; only this
   *     attempt's own obligations are accounted for);
   *  3. when anything is live under the row this launch still owns, this task's own stop
   *     cascade in the two-producer shape of failAgentTaskTerminally: Phase A directly (this
   *     method holds the global mutex Phase A requires; the mutex is not reentrant, so it must
   *     not be re-acquired here), Phase B (clearQueue + stopStream, bounded), then a bounded
   *     wait for the captured owners to settle, which releases the record and settles the
   *     attempt (Phase C).
   * An owner that outlives the bound (or one that runs under a row another writer took over)
   * defers the settlement to its own end: no proof is minted here for work still running. The
   * bound keeps this method's hold on the global mutex finite; a hung owner never pins task
   * creation.
   *
   * After the marker's await the steps chain (endPublishedTaskLaunchFailure, then
   * stopFailedTaskLaunch or settleFailedTaskLaunch, then finishTaskLaunchFailure): each starts
   * the next in the same tick as its own last await, so no call runs later than it did inline.
   */
  private async failTaskLaunch(
    plan: TaskCreatePlan,
    launch: TaskLaunchState,
    message: string,
    runtimeForRollback: Runtime,
    rollback: { preservePhysicalWorkspace?: boolean }
  ): Promise<void> {
    const { taskId } = plan;
    const { attemptId, launchAttempt } = launch;
    if (launchAttempt == null) {
      await this.rollbackFailedTaskCreate(
        runtimeForRollback,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        taskId,
        rollback
      );
      return;
    }
    this.closeAttemptAdmission(taskId, attemptId, launchAttempt, "launch-failed");
    const mark: TaskLaunchFailureMark = {
      superseded: false,
      transitionedToInterrupted: false,
      parentWorkspaceId: undefined,
    };
    try {
      const found = await this.editWorkspaceEntry(
        taskId,
        (ws) => {
          if (ws.taskAttemptId !== attemptId) {
            mark.superseded = true;
            return;
          }
          mark.transitionedToInterrupted = ws.taskStatus !== "interrupted";
          mark.parentWorkspaceId = ws.parentWorkspaceId;
          ws.taskStatus = "interrupted";
          markChildGoalPauseOwed(ws);
          ws.taskLaunchError = message;
          // Survives a restart, like markTaskLaunchFailed (#4674).
          if (this.initStateManager.getUnsanitizedCheckoutError(taskId)) {
            ws.taskCheckoutUnsanitized = true;
          }
        },
        { allowMissing: true }
      );
      // A row another writer removed meanwhile is theirs as well: nothing of ours to mark.
      if (!found) mark.superseded = true;
    } catch (error: unknown) {
      // No durable marker and no knowledge of the row: fail closed. The attempt stays closed
      // (no send binds to it) and unsettled (a Stop or reawaken finds it closing); nothing is
      // stopped or deleted against a row of unknown ownership.
      log.error("Task.create: failed to persist the launch failure", {
        taskId,
        error: getErrorMessage(error),
      });
      return;
    }
    if (mark.superseded) {
      log.info("Task launch failure not recorded: the record was re-admitted by another writer", {
        taskId,
        message,
      });
      // Idle under this attempt (its pending obligations are refused at their next gate, since
      // the row no longer names it): settled. Live: its turn ends on its own — no early proof.
      if (!this.isLiveUnderLaunchAttempt(taskId, attemptId)) {
        this.settleOwnedTaskAttempt(taskId, launchAttempt, "launch-failed");
      }
      return;
    }
    return this.endPublishedTaskLaunchFailure(taskId, launch, launchAttempt, message, mark);
  }

  /**
   * The launch attempt's own live work, by the ledger that binds sends to attempts: an obligation
   * still in preflight or queued, or an admitted one whose turn is the session's live turn.
   * Attempt-scoped on purpose — under a row another writer re-admitted, the session's other
   * work is that writer's and must not be sampled as ours.
   */
  private isLiveUnderLaunchAttempt(taskId: string, attemptId: string): boolean {
    const activeTurn = this.workspaceService.getActiveTurnGeneration(taskId);
    for (const send of this.attemptLedger.sendsOf(taskId)) {
      if (send.attemptId !== attemptId) continue;
      if (send.state === "pending" || send.state === "enqueued") return true;
      if (send.state === "admitted" && send.turnId != null && send.turnId === activeTurn) {
        return true;
      }
    }
    return false;
  }

  /**
   * failTaskLaunch after its durable marker landed on a row this launch still owns: stops what
   * is live under the row, or settles the idle attempt, then finishes the failure.
   */
  private endPublishedTaskLaunchFailure(
    taskId: string,
    launch: TaskLaunchState,
    launchAttempt: OwnedTaskAttempt,
    message: string,
    mark: TaskLaunchFailureMark
  ): Promise<void> {
    // The marker is durable on a row this launch still owns. Anything live under the row is
    // ours to stop: the closure above preceded the marker's await, so this sample is
    // authoritative (nothing binds to the attempt since), and the row is re-read synchronously
    // here because the other writer's rotation may have landed during that await — in which
    // case the row is theirs from here on and only this attempt's own obligations count.
    const rowStillOurs = this.currentTaskAttemptId(taskId) === launch.attemptId;
    const liveExecution = rowStillOurs
      ? this.workspaceService.getActiveTurnGeneration(taskId) != null ||
        this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(taskId) != null ||
        this.aiService.isStreaming(taskId) ||
        this.attemptLedger.hasPendingAdmissions(taskId)
      : this.isLiveUnderLaunchAttempt(taskId, launch.attemptId);
    if (rowStillOurs && liveExecution) {
      return this.stopFailedTaskLaunch(taskId, message, mark);
    }
    if (!liveExecution) {
      return this.settleFailedTaskLaunch(taskId, launch, launchAttempt, mark);
    }
    return this.finishTaskLaunchFailure(taskId, mark);
  }

  /** Runs the failed launch's own stop cascade on the row it still owns, then finishes. */
  private async stopFailedTaskLaunch(
    taskId: string,
    message: string,
    mark: TaskLaunchFailureMark
  ): Promise<void> {
    this.taskStopLatch.beginWorkspaceStop(taskId);
    this.taskStopLatch.markWorkspaceStopPersisted(taskId);
    await this.runWorkspaceStopCleanup([taskId], {
      label: "TaskService.create launch failure",
      abandonPartial: true,
      clearQueue: true,
    });
    await this.attemptLedger.waitForAttemptClosureToSettle(taskId, ATTEMPT_CLOSURE_SETTLE_WAIT_MS);
    if (this.taskStopLatch.hasStopRecord(taskId)) {
      log.warn("Task.create launch failure: the failed launch's attempt is still live", {
        taskId,
        message,
      });
    }
    return this.finishTaskLaunchFailure(taskId, mark);
  }

  /** Settles the failed launch's idle attempt, then finishes. */
  private async settleFailedTaskLaunch(
    taskId: string,
    launch: TaskLaunchState,
    launchAttempt: OwnedTaskAttempt,
    mark: TaskLaunchFailureMark
  ): Promise<void> {
    // Receipt evidence as in markTaskLaunchFailed: the send was never admitted (on top of the
    // shared attemptCannotStillReport boundary); otherwise the settlement stays in memory.
    if (launch.sendAdmitted) {
      this.settleOwnedTaskAttempt(taskId, launchAttempt, "launch-failed");
    } else {
      await this.attemptLedger.persistOwnedAttemptSettlement(
        taskId,
        launchAttempt,
        "launch-failed",
        "launch-failed"
      );
    }
    return this.finishTaskLaunchFailure(taskId, mark);
  }

  /** Records the interrupted transition, settles the owed goal pause and announces the row. */
  private async finishTaskLaunchFailure(
    taskId: string,
    mark: TaskLaunchFailureMark
  ): Promise<void> {
    if (mark.transitionedToInterrupted) {
      this.recordTaskInterrupted(taskId, mark.parentWorkspaceId);
    }
    if (!mark.superseded) await this.settleChildGoalPause(taskId);
    await this.emitWorkspaceMetadata(taskId);
  }

  /** Runs `reserve` under the shared desktop's reservation for the task, when the task has one. */
  private reserveTaskDesktop<T>(plan: TaskCreatePlan, reserve: () => Promise<T>): Promise<T> {
    return plan.taskDesktopOwnerWorkspaceId == null
      ? reserve()
      : this.desktopInputCoordinator.withReservation(
          plan.taskDesktopOwnerWorkspaceId,
          plan.taskId,
          reserve
        );
  }

  /**
   * Task.create's queued branch: persists the task as queued and schedules the queue drain.
   * Runs under the global mutex that createUnderTaskTreeLifecycleLock holds.
   */
  private async createQueuedTask(plan: TaskCreatePlan): Promise<Result<TaskCreateResult, string>> {
    const { taskId, workspaceName, parentWorkspaceId } = plan;
    const trunkBranch = plan.parentBranchName;
    if (!trunkBranch) {
      return Err("Task.create: parent workspace name missing (cannot queue task)");
    }

    // NOTE: Queued tasks are persisted immediately, but their workspace is created later
    // when a parallel slot is available. This ensures queued tasks don't create worktrees
    // or run init hooks until they actually start.
    // Shared-workspace (isolation: "none") tasks point at the parent's existing checkout, so the
    // dequeue path sees the directory already exists and skips fork + init.
    const workspacePath = plan.useSharedWorkspace
      ? plan.parentWorkspacePath
      : plan.runtime.getWorkspacePath(plan.parentMeta.projectPath, workspaceName);

    taskQueueDebug("TaskService.create queued (persist-only)", {
      taskId,
      workspaceName,
      parentWorkspaceId,
      trunkBranch,
      workspacePath,
    });

    try {
      await this.reserveTaskDesktop(plan, async () => {
        await this.config.editConfig((config) =>
          this.appendQueuedTaskEntry(config, plan, workspacePath, trunkBranch)
        );
      });
    } catch (error) {
      return Err(getErrorMessage(error));
    }

    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

    // NOTE: Do NOT persist the prompt into chat history until the task actually starts.
    // Otherwise the frontend treats "last message is user" as an interrupted stream and
    // will auto-retry / backoff-spam resume attempts while the task is queued.
    taskQueueDebug("TaskService.create queued persisted (prompt stored in config)", {
      taskId,
      workspaceName,
    });

    // Schedule queue processing (best-effort).
    this.scheduleMaybeStartQueuedTasks();
    taskQueueDebug("TaskService.create queued scheduled maybeStartQueuedTasks", { taskId });
    return Ok({
      taskId,
      kind: "agent",
      status: "queued",
      modelString: plan.taskModelString,
      thinkingLevel: plan.effectiveThinkingLevel,
      desktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId ?? taskId,
    });
  }

  /** The queued branch's config edit: appends the queued task's row under its parent's project. */
  private appendQueuedTaskEntry(
    config: ProjectsConfig,
    plan: TaskCreatePlan,
    workspacePath: string,
    trunkBranch: string
  ): ProjectsConfig {
    const { taskId, parentWorkspaceId, effectiveThinkingLevel, effectiveReasoningMode } = plan;
    assertParentAdmitsChild(config, parentWorkspaceId, {
      requireRow: plan.parentEntry != null,
      legacyRow: plan.legacyParentRow,
    });
    let projectConfig = config.projects.get(plan.configProjectPath);
    if (!projectConfig) {
      projectConfig = { workspaces: [] };
      config.projects.set(plan.configProjectPath, projectConfig);
    }

    projectConfig.workspaces.push({
      kind: plan.parentIsScratch ? "scratch" : undefined,
      path: workspacePath,
      id: taskId,
      name: plan.workspaceName,
      title: plan.args.title,
      createdAt: plan.createdAt,
      runtimeConfig: plan.taskRuntimeConfig,
      // New rows have no legacy plan to migrate (#5174).
      remotePlanMigrated: true,
      aiSettings: {
        model: plan.canonicalModel,
        thinkingLevel: effectiveThinkingLevel,
        ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
      },
      parentWorkspaceId,
      agentId: plan.agentId,
      agentType: plan.agentType,
      workflowTask: plan.args.workflowTask,
      bestOf: plan.normalizedBestOf,
      taskStatus: "queued",
      // Never admitted: the queue drain's launch CAS rotates it and takes ownership.
      taskAttemptId: newTaskAttemptId(),
      taskPrompt: plan.prompt,
      taskTrunkBranch: trunkBranch,
      taskModelString: plan.taskModelString,
      taskThinkingLevel: effectiveThinkingLevel,
      taskAiPins: plan.taskAiPins,
      taskOnRefusal: plan.args.onRefusal,
      taskIsolation: plan.useSharedWorkspace ? "none" : undefined,
      taskAttentionPolicy: plan.args.attentionPolicy,
      taskDesktopOwnerWorkspaceId: plan.taskDesktopOwnerWorkspaceId,
      projects: plan.parentMeta.projects,
    });
    this.desktopInputCoordinator.assertAdmission(config, taskId);
    return config;
  }

  async retitleDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string,
    title: string
  ): Promise<Result<RetitleAgentTaskResult, RetitleAgentTaskError>> {
    assert(ancestorWorkspaceId.length > 0, "retitleDescendantAgentTask: ancestor ID is required");
    assert(taskId.length > 0, "retitleDescendantAgentTask: task ID is required");
    const trimmedTitle = title.trim();
    assert(trimmedTitle.length > 0, "retitleDescendantAgentTask: title is required");

    return await this.withTaskTreeLifecycleLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (entry == null) {
        return Err({ code: "not_found" as const });
      }

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId) ||
        this.isWorkflowOwnedTaskUsingIndex(index, taskId)
      ) {
        return Err({ code: "invalid_scope" as const });
      }

      const result = await this.workspaceService.updateTitle(taskId, trimmedTitle);
      if (!result.success) {
        return Err({ code: "update_failed" as const, message: result.error });
      }
      return Ok({ title: trimmedTitle });
    });
  }

  async sendMessageToDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode,
    options?: {
      /** Transcript label prefixed to the delivered message. */
      messageLabel?: string;
      /**
       * Synthetic assistant rows delivered atomically with the message through queued prompt
       * updates, reactivation, or live turn admission.
       */
      preTurnMessages?: MuxMessage[];
    }
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "sendMessageToDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "sendMessageToDescendantAgentTask: taskId must be non-empty");
    return this.sendTreeMessage({
      relation: "descendant",
      senderWorkspaceId: ancestorWorkspaceId,
      targetId: taskId,
      message,
      queueDispatchMode,
      options,
    });
  }

  /**
   * Reawaken an inactive descendant (reported, interrupted, or legacy-archived) under a fresh
   * ancestor-owned continuation execution. Callers hold the task's event lock and have verified
   * the child is neither streaming nor under an active continuation.
   */
  private async reactivateInactiveAgentTask(params: {
    ancestorWorkspaceId: string;
    taskId: string;
    message: string;
    /**
     * A stopped queued child keeps its only copy of the initial brief in taskPrompt: the message
     * follows that brief in the reactivation prompt.
     */
    prependKeptBrief?: true;
    queueDispatchMode: TaskMessageQueueDispatchMode;
    preTurnMessages?: MuxMessage[];
    sendMessage?: WorkspaceTurnHost["sendMessage"];
    /**
     * Ancestor-triggered reawakening only: re-resolve AI settings from current defaults
     * and pins (new-style children). Absent (bash-monitor wakes) keeps the frozen path.
     */
    aiRefresh?: { prepared: PreparedReawakenAi | undefined };
    /**
     * captureReawakeningStopFence(taskId), taken when the caller's decision began; null when a
     * Stop overlapping the reawakening does not invalidate it (bash-monitor wakes).
     */
    stopFence: ReadonlyMap<string, number> | null;
  }): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    const { ancestorWorkspaceId, taskId } = params;
    assert(
      params.stopFence?.has(taskId) ?? true,
      "reactivateInactiveAgentTask: stopFence must cover the task"
    );
    // Read in the caller's decision tick (no await since its inactive check, for ancestor sends).
    const entryAtDecision = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      taskId
    )?.workspace;
    // The status this reawakening decided on; the identity CAS below refuses a resume's flip of
    // it to `running`.
    const statusAtDecision = entryAtDecision?.taskStatus;
    // Before the unarchive, which can restore a checkout the removing backend is deleting (#4478).
    const marker = entryAtDecision?.pendingRemoval;
    if (marker != null) {
      return Err({ code: "send_failed" as const, message: pendingRemovalAdmissionMessage(marker) });
    }
    const unarchiveResult = await this.unarchiveAgentTaskAncestry(ancestorWorkspaceId, taskId);
    if (!unarchiveResult.success) {
      return Err({ code: "send_failed" as const, message: unarchiveResult.error });
    }
    const refreshedEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    if (refreshedEntry == null) {
      return Err({ code: "not_found" as const });
    }
    // Check after unarchiving: unarchive can restore a checkout that archiving deleted.
    const checkoutError = await getMissingHostLocalCheckoutError(refreshedEntry);
    if (checkoutError != null) {
      return Err({
        code: "send_failed" as const,
        message: `Cannot reawaken sub-agent ${taskId}: its checkout is unavailable (${checkoutError}). Spawn a fresh sub-agent instead.`,
      });
    }
    // Plan (no awaits, no writes) before any family rows or attempt ownership change, so a
    // refusal here leaves the task untouched. The settings commit later, with the claim.
    let agentTaskAi: AgentTaskTurnAi | undefined;
    if (params.aiRefresh != null) {
      const planConfig = this.config.loadConfigOrDefault();
      const planEntry = findWorkspaceEntry(planConfig, taskId);
      if (planEntry == null) {
        return Err({ code: "not_found" as const });
      }
      const contextKey = buildReawakenContextKey(planEntry);
      const plan = planReawakenAi({
        config: planConfig,
        taskId,
        prepared: params.aiRefresh.prepared,
        freshContextKey: contextKey,
        providersConfig: this.aiService.getProvidersConfig(),
      });
      if (plan.kind === "stale") {
        return Err({ code: "send_failed" as const, message: formatReawakenChangedMessage(taskId) });
      }
      if (plan.kind === "resolved") {
        agentTaskAi = { snapshot: plan.snapshot, inputsKey: plan.inputsKey, contextKey };
      }
    }
    // Verified by the caller: not streaming and no active continuation, and
    // concurrent task-machinery sends serialize on the lifecycle + event
    // locks held there, so no task-driven turn admission can be in flight
    // during this append; the rows precede the reactivation prompt row
    // createWorkspaceTurn sends. A createWorkspaceTurn failure leaves an
    // untriggered untrusted-labeled row behind.
    if (params.preTurnMessages != null && params.preTurnMessages.length > 0) {
      const appendOutcome = await this.appendFamilyPayloadRows(taskId, params.preTurnMessages);
      if (!appendOutcome.success) {
        return appendOutcome;
      }
    }
    if (refreshedEntry.workspace.taskAttemptRetiredBy != null) {
      return Err({
        code: "send_failed" as const,
        message: retiredAttemptMessage(refreshedEntry.workspace.taskAttemptRetiredBy),
      });
    }
    if (refreshedEntry.workspace.pendingRemoval != null) {
      return Err({
        code: "send_failed" as const,
        message: pendingRemovalAdmissionMessage(refreshedEntry.workspace.pendingRemoval),
      });
    }
    // Admission classification: reactivation = new OWNED attempt. The CAS publishes the fresh id
    // before any turn exists; once committed the new identity is kept in config and memory
    // whatever createWorkspaceTurn returns or throws (P3: never roll an id back) — a refused
    // reactivation leaves an owned, unsettled attempt that a later Stop settles.
    const previousAttemptId = refreshedEntry.workspace.taskAttemptId;
    // A prepended brief gets a fresh brief send id, stored with the attempt commit before the
    // send (#5544). The send can make its row durable and still return Err, which keeps
    // taskPrompt; the launch's id is on no row, so only this id lets the next reawakening's
    // lookup (dropKeptTaskPromptAlreadyInHistory) recognize the row and not prepend it again.
    const keptBrief =
      params.prependKeptBrief === true
        ? coerceNonEmptyString(refreshedEntry.workspace.taskPrompt)
        : undefined;
    const briefSendId = keptBrief != null ? mintTaskBriefSendId() : undefined;
    // The terminated attempt's goal stays paused across reactivation (also covers a set_goal that
    // raced the termination); a failed pause leaves taskGoalPauseOwed fencing goal turns.
    await this.settleChildGoalPause(taskId, { force: true });
    const lineage = await this.evaluateAttemptLineage(taskId, refreshedEntry.workspace);
    const reactivationAttemptId = newTaskAttemptId();
    let committedProven = false;
    let published = false;
    {
      // Critical section (see markInterruptedTaskRunning): the identity CAS, the row check and
      // the ownership install run under the global mutex every cascade's Phase A holds, so no
      // Stop can capture the fresh id (or the superseded predecessor) between the commit and its
      // owner. Lock order eventLock → mutex is the one createWorkspaceTurn below establishes.
      await using _lock = await this.mutex.acquire();
      if (this.isWorkspaceStopInProgress(taskId)) {
        // A cascade already latched this task: publishing an attempt now would leave one the
        // cascade cannot settle (its record captured the predecessor). Refuse before the write.
        return Err({
          code: "send_failed" as const,
          message: WORKSPACE_STOP_IN_PROGRESS_SEND_BLOCKED_MESSAGE,
        });
      }
      // A Stop of the task or an ancestor that ran to completion during the awaits above: the
      // cascade found nothing live on the idle child and already released its latch, so only the
      // epochs show it. The reawakening must lose.
      if (params.stopFence != null && this.reawakeningOvertakenByStop(params.stopFence)) {
        log.debug("Sub-agent reactivation refused: overtaken by a stop", { taskId });
        return Err({ code: "send_failed" as const, message: SEND_ADMISSION_STALE_MESSAGE });
      }
      // A manual resume (reawakenInterruptedTask, which holds neither the event nor the tree
      // lock) may have published and started its own attempt since the caller found the child
      // inactive: rotating it would supersede that live turn and drop its report.
      if (this.attemptLedger.hasLiveReawakening(taskId)) {
        return Err({
          code: "send_failed" as const,
          message: TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE,
        });
      }
      await this.editWorkspaceEntry(
        taskId,
        (ws) => {
          if (
            !rowKeepsAttempt(ws, previousAttemptId) ||
            // A manual resume flips `interrupted` to `running` with its own fresh id, possibly
            // before the refresh above read the id. Only that flip refuses: the unarchive above
            // may itself settle a legacy shared-desktop child's stale `running` to `interrupted`.
            (ws.taskStatus === "running" && statusAtDecision !== "running")
          ) {
            return;
          }
          ws.taskAttemptId = reactivationAttemptId;
          // Only the brief this reactivation prepends: a rewrite since the read is its writer's.
          if (briefSendId != null && ws.taskPrompt === refreshedEntry.workspace.taskPrompt) {
            ws.taskPromptSendId = briefSendId;
          }
          committedProven = lineage.proven && ws.taskAttemptUnproven !== true;
          if (!committedProven) ws.taskAttemptUnproven = true;
          published = true;
        },
        { allowMissing: true }
      );
      if (!published) {
        // Nothing was published: the previous attempt (owned or not) stays exactly as it was.
        const latest = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId)?.workspace;
        return Err({
          code: "send_failed" as const,
          message:
            latest?.taskAttemptRetiredBy != null
              ? retiredAttemptMessage(latest.taskAttemptRetiredBy)
              : latest?.pendingRemoval != null
                ? pendingRemovalAdmissionMessage(latest.pendingRemoval)
                : "Sub-agent reactivation refused: its attempt changed concurrently; retry.",
        });
      }
      // A writer outside this mutex (another backend) may have rotated the row again during the
      // commit's own awaits: never publish or own an identity the durable row no longer names.
      const committedRow = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
      if (committedRow?.workspace.taskAttemptId !== reactivationAttemptId) {
        log.info("[task-attempt] reactivated attempt superseded before it was owned", {
          taskId,
          attemptId: reactivationAttemptId,
          current: committedRow?.workspace.taskAttemptId,
        });
        return Err({
          code: "send_failed" as const,
          message: "Sub-agent reactivation refused: its attempt changed concurrently; retry.",
        });
      }
      this.attemptLedger.publishAttemptRotation(taskId, reactivationAttemptId);
      if (!committedProven) {
        log.info("[task-attempt] reactivated attempt is not receipt-eligible", {
          taskId,
          attemptId: reactivationAttemptId,
          reason: lineage.proven ? "unproven marker appeared before the CAS" : lineage.reason,
        });
      }
      this.beginOwnedTaskAttempt(taskId, "reactivation", {
        attemptId: reactivationAttemptId,
        receiptEligible: committedProven,
      });
      // Live until createWorkspaceTurn returns; its send's admission is the evidence after that.
      this.attemptLedger.beginReawakening(taskId, reactivationAttemptId);
    }
    let execution: Awaited<ReturnType<WorkspaceTurnManager["createWorkspaceTurn"]>>;
    try {
      execution = await this.getWorkspaceTurnManager().createWorkspaceTurn({
        ownerWorkspaceId: ancestorWorkspaceId,
        prompt: keptBrief != null ? `${keptBrief}\n\n${params.message}` : params.message,
        title:
          coerceNonEmptyString(refreshedEntry.workspace.title) ??
          coerceNonEmptyString(refreshedEntry.workspace.name) ??
          "Sub-agent",
        workspace: {
          mode: "existing",
          workspaceId: taskId,
          queueDispatchMode: params.queueDispatchMode,
        },
        allowAgentWorkspace: true,
        attentionPolicy: "notify_on_terminal",
        ...(params.sendMessage != null ? { sendMessage: params.sendMessage } : {}),
        ...(agentTaskAi != null ? { agentTaskAi } : {}),
        ...(keptBrief != null && briefSendId != null
          ? {
              sendIdentities: [
                { ...taskBriefSendIdentity(keptBrief, briefSendId), unpublished: true },
              ],
            }
          : {}),
      });
    } finally {
      this.attemptLedger.endReawakening(taskId, reactivationAttemptId);
    }
    if (!execution.success) {
      // The fresh attempt is already published (config and memory) and stays: it reads as an
      // owned, unsettled attempt (indeterminate) until a Stop settles it. Restoring the retired
      // predecessor here would let a stale settlement describe an attempt that no longer exists.
      log.info("[task-attempt] reactivation refused after its attempt was published", {
        taskId,
        attemptId: reactivationAttemptId,
        error: execution.error,
      });
      return Err({ code: "send_failed" as const, message: execution.error });
    }
    return Ok({
      delivery: "reactivated" as const,
      executionTaskId: execution.data.taskId,
    });
  }

  /**
   * Reads a reawakening candidate's definition layers before the task locks are taken.
   * The config snapshot is only a hint: planReawakenAi re-checks agent and checkout
   * context under the locks. Live, legacy and non-inactive children return undefined, so
   * guidance to a running child does no definition reads. Archived children are read too:
   * reawakening restores them, and a missing checkout just fails the (bounded) read, which
   * falls back to resolving without layers. Never mutates.
   */
  private async prepareReawakenAi(taskId: string): Promise<PreparedReawakenAi | undefined> {
    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    if (entry == null) return undefined;
    const workspace = entry.workspace;
    if (
      workspace.taskAiPins == null ||
      (workspace.taskStatus !== "reported" && workspace.taskStatus !== "interrupted") ||
      isActiveWorkspaceTurnTaskStatus(workspace.taskExecutionStatus) ||
      this.aiService.isStreaming(taskId)
    ) {
      return undefined;
    }
    const workspaceName = coerceNonEmptyString(workspace.name);
    if (workspace.runtimeConfig == null || workspaceName == null) {
      return undefined;
    }
    const agentId = resolveTaskAgentIdForResume(workspace);
    const contextKey = buildReawakenContextKey(entry);
    let context: ReturnType<typeof buildWorkspaceAgentContext>;
    try {
      context = buildWorkspaceAgentContext(
        {
          runtimeConfig: workspace.runtimeConfig,
          projectPath: entry.projectPath,
          workspaceName,
          persistedWorkspacePath: workspace.path,
          subProjectPath: workspace.subProjectPath,
        },
        // #6426: from the snapshot loaded above (no second config read).
        isWorkspaceProjectTrustedIn(cfg.projects, {
          kind: workspace.kind,
          projectPath: entry.projectPath,
        })
      );
    } catch (error) {
      log.debug("prepareReawakenAi: definition context unavailable", {
        taskId,
        error: getErrorMessage(error),
      });
      return { taskId, agentId, contextKey, layers: null };
    }
    const layers = await loadAgentDefinitionAiLayers(
      agentId,
      {
        runtime: context.runtime,
        workspacePath: context.workspacePath,
        workspaceId: taskId,
        projectPluginsTrusted: context.projectPluginsTrusted,
        runtimeFactory: nodeRuntimeFactory,
      },
      { abortSignal: AbortSignal.timeout(REAWAKEN_DEFINITION_READ_TIMEOUT_MS) }
    );
    return { taskId, agentId, contextKey, layers };
  }

  async reactivateInactiveAgentTaskFromBashMonitorWake(
    workspaceId: string,
    prompt: string,
    send: WorkspaceTurnHost["sendMessage"]
  ): Promise<Result<void, string> | null> {
    assert(workspaceId.length > 0, "reactivateInactiveAgentTaskFromBashMonitorWake: workspaceId");
    // Event lock only: the wake dispatcher's removal counterpart nests task-tree -> bash-monitor
    // history locks, so taking the tree lock from a wake would invert that order. Removal and
    // archive races are caught by createWorkspaceTurn's own lifecycle admission instead.
    return this.workspaceEventLocks.withLock(workspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, workspaceId);
      const parentWorkspaceId = entry?.workspace.parentWorkspaceId;
      if (
        entry == null ||
        parentWorkspaceId == null ||
        // Workflow-owned children report through the runner's own journal path.
        entry.workspace.workflowTask != null ||
        isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      ) {
        return null;
      }
      const status = entry.workspace.taskStatus;
      if (status !== "reported" && status !== "interrupted") {
        return null;
      }
      // A live continuation (any ancestor's) keeps owning the child's turns; the plain wake
      // continues it through history inheritance.
      const currentExecution =
        entry.workspace.taskExecutionId != null
          ? (await this.getDescendantAgentTaskExecutionSnapshot(parentWorkspaceId, workspaceId))
              ?.record
          : undefined;
      if (isActiveWorkspaceTurnTaskStatus(currentExecution?.status)) {
        return null;
      }
      if (this.aiService.isStreaming(workspaceId)) {
        return null;
      }
      const result = await this.reactivateInactiveAgentTask({
        ancestorWorkspaceId: parentWorkspaceId,
        taskId: workspaceId,
        message: prompt,
        queueDispatchMode: "tool-end",
        sendMessage: send,
        // No Stop fence (unlike task_send_message): the wake is the child's own monitor
        // output, not a turn of the stopped tree. A user's tree Stop retires the attention a
        // descendant owed when the cascade latched it (#5377), and new monitor input stays
        // automatic after a Stop (AgentSession.isAutomaticSendBlocked), so a wake overlapping a
        // Stop is the wake-after-Stop order. The wake dispatcher retries a wake refused during
        // a Stop instead of sending it plainly.
        stopFence: null,
      });
      if (result.success) {
        return Ok(undefined);
      }
      return Err(
        "message" in result.error && result.error.message != null
          ? result.error.message
          : result.error.code
      );
    });
  }

  /**
   * Trusted ancestor guidance keeps its dedicated lifecycle machinery: queued prompt splice,
   * inactive-task reactivation, and durable live-guidance reservation.
   */
  private async dispatchTrustedDescendantMessage(
    ancestorWorkspaceId: string,
    taskId: string,
    trimmedMessage: string,
    queueDispatchMode: TaskMessageQueueDispatchMode,
    /**
     * Who reawakens an inactive child: only an ancestor re-resolves its AI settings.
     * Sibling-family messages ride this trusted path too but keep the frozen settings
     * (plan D1), so they skip definition reads and the refresh policy entirely.
     */
    sender: "ancestor" | "sibling",
    options?: TrustedDescendantMessageOptions
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    // Before the first await: a Stop of the child or any ancestor (the sender's included) that
    // lands while this send is suspended overtakes a reawakening it decides on.
    const stopFence = resolveDescendantMessageStopFence(
      options,
      this.captureReawakeningStopFence(taskId)
    );
    const deferral = {
      ancestorWorkspaceId,
      taskId,
      trimmedMessage,
      queueDispatchMode,
      sender,
      options,
      stopFence,
    };
    const messageLabel = options?.messageLabel ?? "Updated guidance from parent";
    // Keep the labeled message explicit in the child transcript so it cannot be confused
    // with the original brief, whoever the sender is.
    const labeledMessage = renderLabeledTaskMessage(messageLabel, trimmedMessage);

    const queuedUpdateResult = await (async (): Promise<
      Result<SendAgentTaskMessageResult | null, SendAgentTaskMessageError>
    > => {
      // The scheduler snapshots taskPrompt and flips queued -> starting under this mutex. Use the
      // same lock so a correction is either included in that snapshot or observes starting and is
      // rejected; it can never be persisted after the scheduler already captured a stale prompt.
      await using _lock = await this.mutex.acquire();
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry) {
        return Err({ code: "not_found" as const });
      }
      const taskIndex = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(
          taskIndex.parentById,
          ancestorWorkspaceId,
          taskId
        )
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      if (entry.workspace.taskStatus !== "queued") {
        return Ok(null);
      }
      if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
        return Ok(null);
      }

      const initialPrompt = coerceNonEmptyString(entry.workspace.taskPrompt);
      if (!initialPrompt) {
        return Err({
          code: "send_failed" as const,
          message: "Queued task has no durable prompt to update.",
        });
      }
      // While the entry is still queued under the scheduler mutex, no prompt
      // send can be mid-admission (the scheduler flips queued -> starting
      // under this same mutex before sending), so a direct durable append
      // cannot land inside a PREPARING window; the rows precede the future
      // prompt row. Persisted before the splice: a splice failure leaves an
      // untriggered untrusted-labeled row behind.
      if (options?.preTurnMessages != null && options.preTurnMessages.length > 0) {
        const appendOutcome = await this.appendFamilyPayloadRows(taskId, options.preTurnMessages);
        if (!appendOutcome.success) {
          return appendOutcome;
        }
      }
      await this.editWorkspaceEntry(taskId, (workspace) => {
        workspace.taskPrompt = `${initialPrompt}\n\n${labeledMessage}`;
        // No send carried this prompt; its launch mints its own id.
        workspace.taskPromptSendId = undefined;
      });
      return Ok({ delivery: "queued" as const });
    })();
    if (!queuedUpdateResult.success) {
      return queuedUpdateResult;
    }
    if (queuedUpdateResult.data != null) {
      return Ok(queuedUpdateResult.data);
    }

    // Definition I/O never runs under the event or tree lifecycle lock: read the child's
    // definition layers first (inactive candidates only), then plan under the locks.
    let preparedReawakenAi: PreparedReawakenAi | undefined;
    try {
      preparedReawakenAi = sender === "ancestor" ? await this.prepareReawakenAi(taskId) : undefined;
    } catch (error) {
      // Reawakening without the definition layers would persist default AI settings for
      // the child (#4829); a timeout still falls back inside prepareReawakenAi.
      if (!isRuntimeTransportError(error)) throw error;
      return Err({
        code: "send_failed" as const,
        message: formatRuntimeUnreachableError("Could not reawaken the task", error),
      });
    }

    // Event lock first, then the task-tree lock: the order every path holding both follows (see
    // workspaceEventLocks). The reverse nesting deadlocked against reported-task cleanup.
    return this.workspaceEventLocks.withLock(taskId, async () =>
      this.withTaskTreeLifecycleLock(taskId, async () => {
        // A brief history already holds is not prepended again on reawakening; the
        // reactivation reads the kept brief from the row after this. Awaited before the row read
        // below, so the inactive decision and reactivateInactiveAgentTask see the same row.
        await this.dropKeptTaskPromptAlreadyInHistory(taskId);
        const cfg = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(cfg, taskId);
        if (!entry) {
          return Err({ code: "not_found" as const });
        }
        const taskIndex = this.buildAgentTaskIndex(cfg);
        if (
          !this.isDescendantAgentTaskUsingParentById(
            taskIndex.parentById,
            ancestorWorkspaceId,
            taskId
          )
        ) {
          return Err({ code: "invalid_scope" as const });
        }

        const currentExecution =
          entry.workspace.taskExecutionId != null
            ? ((await this.getDescendantAgentTaskExecutionSnapshot(ancestorWorkspaceId, taskId))
                ?.record ?? null)
            : null;
        const continuationActive = isActiveWorkspaceTurnTaskStatus(currentExecution?.status);
        const legacyArchived = isWorkspaceArchived(
          entry.workspace.archivedAt,
          entry.workspace.unarchivedAt
        );
        const inactive =
          !continuationActive &&
          isInactiveAgentTaskStatus(entry.workspace.taskStatus, legacyArchived);
        const deferred = this.deferDescendantMessage(deferral, {
          inactive,
          archived: legacyArchived,
          archivedAt: entry.workspace.archivedAt,
          taskStatus: entry.workspace.taskStatus,
        });
        if (deferred != null) return deferred;
        if (inactive && !this.aiService.isStreaming(taskId)) {
          return this.reactivateInactiveAgentTask({
            ancestorWorkspaceId,
            taskId,
            message: labeledMessage,
            prependKeptBrief: true,
            queueDispatchMode,
            preTurnMessages: options?.preTurnMessages,
            ...(sender === "ancestor" ? { aiRefresh: { prepared: preparedReawakenAi } } : {}),
            stopFence,
          });
        }

        if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
          return Err({
            code: "not_active" as const,
            taskStatus: entry.workspace.taskStatus ?? "unknown",
            message:
              "Task workspace is archived; retry task_send_message to restore and reawaken it.",
          });
        }

        // Missing status is a legacy running task. A reported/interrupted agent workspace may also
        // have an active follow-up workspace-turn execution; its live stream accepts steering here.
        const previousStatus = entry.workspace.taskStatus ?? "running";
        if (
          previousStatus !== "running" &&
          previousStatus !== "awaiting_report" &&
          !this.aiService.isStreaming(taskId) &&
          !continuationActive
        ) {
          return Err({ code: "not_active" as const, taskStatus: previousStatus ?? "unknown" });
        }

        // An active target whose checkout is missing could never run the delivered turn (#4824):
        // refuse before the durable guidance or any payload row is written, instead of failing
        // later with runtime_not_ready. Inactive targets are probed by reactivateInactiveAgentTask
        // after unarchiving (which can restore the checkout); queued targets only edit their prompt.
        const checkoutError = await getMissingHostLocalCheckoutError(entry);
        if (checkoutError != null) {
          return Err({
            code: "send_failed" as const,
            message: `Cannot deliver to sub-agent ${taskId}: its checkout is unavailable (${checkoutError}).`,
          });
        }

        const guidanceId = randomUUID();
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            (workspace.taskPendingGuidance ??= []).push({
              id: guidanceId,
              // Startup-recovery replay presents reservations as parent guidance, so
              // non-default labels (sibling messages) must keep their attribution in
              // the durable record.
              message: options?.messageLabel != null ? labeledMessage : trimmedMessage,
              queueDispatchMode,
            });
            if (workspace.taskStatus == null || previousStatus === "awaiting_report") {
              // Persist the legacy implicit-running state so startup recovery can replay this durable
              // guidance if Xum exits before the replacement turn accepts it.
              workspace.taskStatus = "running";
            }
          },
          { allowMissing: true }
        );

        const activeAgentId = resolveTaskAgentIdForResume(entry.workspace);
        const activeAiSettings = this.resolveWorkspaceAISettings(entry.workspace, activeAgentId);
        // Parent guidance continues the delegated execution, rather than superseding it and
        // stranding its report. Use the normal continuation guards for earlier manual input.
        const workspaceTurnMuxMetadata =
          await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
            taskId
          );
        const guidance = this.taskGuidanceSendOptions(taskId, guidanceId, previousStatus);
        const settleFailure = async (status: "interrupted" | "error", reason: string) => {
          await guidance.onCanceled();
          if (workspaceTurnMuxMetadata != null) {
            await this.getWorkspaceTurnManager().settleWorkspaceTurnContinuationFailure(
              taskId,
              workspaceTurnMuxMetadata,
              status,
              reason
            );
          }
        };
        let accepted = false;
        // Admission classification: guidance into a live child continues its attempt (no rotation).
        const sendResult = await this.workspaceService.sendMessage(
          taskId,
          // Synthetic metadata avoids treating parent/sibling orchestration as a direct human
          // intervention in child-only features such as goals and interactive questions.
          labeledMessage,
          {
            ...buildActiveTaskAiSendOptions(entry.workspace, activeAgentId, activeAiSettings),
            queueDispatchMode,
            ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
          },
          {
            ...guidance,
            workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
            // Sibling messages are agent messages; parent guidance is not (#4804).
            ...(sender === "sibling" ? { honorRecipientHold: true } : {}),
            onCanceled: (reason) => settleFailure("interrupted", reason),
            // Live target: pre-turn rows ride the send through AgentSession
            // turn admission (queued with the trigger when the target is busy).
            preTurnMessages: options?.preTurnMessages,
            // If the replacement turn cannot start, remove the settlement reservation and restore
            // an idle child to completion recovery instead of leaving it permanently running.
            onAcceptedPreStreamFailure: (error) =>
              settleFailure("error", formatSendMessageError(error).message),
            onAccepted: async () => {
              await guidance.onAccepted();
              accepted = true;
            },
          }
        );

        if (!sendResult.success) {
          await guidance.onCanceled();
          return Err({
            code: "send_failed" as const,
            message: formatSendMessageError(sendResult.error).message,
          });
        }

        return Ok(accepted ? { delivery: "accepted" } : { delivery: "queued", queueDispatchMode });
      })
    );
  }

  /**
   * Send order (F54): while an earlier message to this task waits for the target to go idle, a new
   * message queues behind it instead of overtaking it. Redeliveries are the chain itself.
   */
  private deferDescendantMessage(
    deferral: Omit<DeferredDescendantMessage, "archivedAtSend">,
    target: {
      inactive: boolean;
      archived: boolean;
      archivedAt: string | undefined;
      taskStatus: AgentTaskStatus | undefined;
    }
  ): Result<SendAgentTaskMessageResult, SendAgentTaskMessageError> | null {
    const archive = resolveDeferralArchivedAtSend(deferral.options?.redelivery, target);
    if (archive == null) {
      return Err({
        code: "not_active" as const,
        taskStatus: target.taskStatus ?? "unknown",
        message: "Task workspace was archived while the message waited for its stream to end.",
      });
    }
    const params = { ...deferral, archivedAtSend: archive.archivedAtSend };
    const queued = Ok({ delivery: "queued" as const, queueDispatchMode: params.queueDispatchMode });
    if (
      params.options?.redelivery == null &&
      this.deferredDescendantMessagesByTask.has(params.taskId)
    ) {
      this.scheduleDeferredDescendantMessage(params);
      return queued;
    }
    return target.inactive && this.deferWhileTargetStreamsWithoutExecution(params) ? queued : null;
  }

  /**
   * F54: an inactive task's stream belongs to no task execution (for example the tail of one that
   * just settled). A message queued into it would run as a plain turn that cannot report, message
   * or spawn, so it waits until the target is idle, where it reawakens the task. After
   * MAX_DEFERRED_DESCENDANT_MESSAGE_WAITS waits it falls back to the live path.
   */
  private deferWhileTargetStreamsWithoutExecution(params: DeferredDescendantMessage): boolean {
    if (!this.aiService.isStreaming(params.taskId)) return false;
    const redelivery = params.options?.redelivery;
    if (redelivery == null) {
      this.scheduleDeferredDescendantMessage(params);
      return true;
    }
    if (redelivery.attempt >= MAX_DEFERRED_DESCENDANT_MESSAGE_WAITS) return false;
    redelivery.deferAgain = true;
    return true;
  }

  /**
   * Redeliver a trusted descendant message once the target is idle (see the F54 note in
   * dispatchTrustedDescendantMessage). Messages to one task chain in send order. The chain is the
   * owner: tracked with terminal attention drains (tests await them) and failures are logged.
   * Like the session queue it replaces for this case, the wait is in memory only.
   */
  private scheduleDeferredDescendantMessage(params: DeferredDescendantMessage): void {
    const previous = this.deferredDescendantMessagesByTask.get(params.taskId);
    const deliver = async () => {
      // A message behind an earlier one tries at once when that one is done: the earlier one may
      // have reawakened the task, whose live execution then takes this message as guidance.
      let waitForIdle = previous == null;
      await previous;
      for (let attempt = 0; ; attempt++) {
        if (waitForIdle) await this.workspaceService.waitForIdleAndNoQueuedMessages(params.taskId);
        waitForIdle = true;
        const redelivery = {
          stopFence: params.stopFence,
          attempt,
          deferAgain: false,
          archivedAtSend: params.archivedAtSend,
        };
        const result = await this.dispatchTrustedDescendantMessage(
          params.ancestorWorkspaceId,
          params.taskId,
          params.trimmedMessage,
          params.queueDispatchMode,
          params.sender,
          { ...params.options, redelivery }
        );
        if (redelivery.deferAgain) continue;
        if (!result.success) {
          log.warn("Deferred descendant message was not delivered", {
            taskId: params.taskId,
            error: result.error,
          });
        }
        return;
      }
    };
    const promise = deliver()
      .catch((error: unknown) => {
        log.warn("Deferred descendant message failed", { taskId: params.taskId, error });
      })
      .finally(() => {
        this.terminalAttention.untrackDrain(promise);
        if (this.deferredDescendantMessagesByTask.get(params.taskId) === promise) {
          this.deferredDescendantMessagesByTask.delete(params.taskId);
        }
      });
    this.deferredDescendantMessagesByTask.set(params.taskId, promise);
    this.terminalAttention.trackDrain(promise);
  }

  private taskGuidanceSendOptions(
    taskId: string,
    guidanceId: string,
    previousStatus: AgentTaskStatus
  ) {
    const clear = async (failed = false): Promise<void> => {
      await this.editWorkspaceEntry(
        taskId,
        (workspace) => {
          const remaining = (workspace.taskPendingGuidance ?? []).filter(
            (guidance) => guidance.id !== guidanceId
          );
          workspace.taskPendingGuidance = remaining.length > 0 ? remaining : undefined;
          if (failed && remaining.length === 0 && workspace.taskStatus === "running") {
            workspace.taskStatus = this.aiService.isStreaming(taskId)
              ? previousStatus
              : "awaiting_report";
          }
        },
        { allowMissing: true }
      );
    };
    const onCanceled = () => clear(true);
    // Live and restored guidance must share the same handoff and settlement lifecycle.
    return {
      acceptanceOrigin: "automatic" as const,
      synthetic: true,
      agentInitiated: true,
      startStreamInBackground: true,
      queueDedupeKey: guidanceId,
      onAccepted: () => clear(),
      onCanceled,
      onAcceptedPreStreamFailure: onCanceled,
    };
  }

  /**
   * Append family payload rows directly to a target's durable history for the
   * delivery paths with no live turn admission (queued splice, reactivation).
   * A mid-loop failure rolls earlier rows back (best effort) so the caller can
   * treat the failure as nothing-persisted.
   */
  private async appendFamilyPayloadRows(
    targetWorkspaceId: string,
    rows: MuxMessage[]
  ): Promise<Result<void, SendAgentTaskMessageError>> {
    assert(rows.length > 0, "appendFamilyPayloadRows: rows must be non-empty");
    const appendedIds: string[] = [];
    for (const row of rows) {
      const appendResult = await this.historyService.appendToHistory(targetWorkspaceId, row);
      if (!appendResult.success) {
        if (appendedIds.length > 0) {
          await this.historyService.deleteMessages(targetWorkspaceId, appendedIds);
        }
        return Err({ code: "send_failed" as const, message: appendResult.error });
      }
      appendedIds.push(row.id);
    }
    for (const row of rows) {
      this.workspaceService.emitChatEvent(targetWorkspaceId, { ...row, type: "message" });
    }
    return Ok(undefined);
  }

  /**
   * Routes a task_send_message send by ancestry, without widening lifecycle ownership.
   * Descendant targets take the unchanged trusted guidance path (framing, reactivation, durable
   * pending guidance); siblings/cousins, ancestors and unrelated workspaces receive an
   * untrusted <mux_agent_message> envelope. The relation is computed server-side so a sender can
   * never claim parent authority it does not have.
   */
  async sendAgentTreeMessage(
    senderWorkspaceId: string,
    targetId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode = "tool-end"
  ): Promise<
    Result<
      SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
      SendAgentTreeMessageError
    >
  > {
    assert(
      senderWorkspaceId.length > 0,
      "sendAgentTreeMessage: senderWorkspaceId must be non-empty"
    );
    assert(targetId.length > 0, "sendAgentTreeMessage: targetId must be non-empty");
    const trimmedMessage = message.trim();
    assert(trimmedMessage.length > 0, "sendAgentTreeMessage: message must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const relation = this.resolveAgentTreeTargetRelation(
      cfg,
      this.buildAgentTaskIndex(cfg).parentById,
      senderWorkspaceId,
      targetId
    );
    if (relation == null) {
      // Private side chats must look like unknown IDs to anyone outside their direct link.
      // Only self-sends reveal an invalid scope; discovery does not advertise private chats.
      return Err({ code: senderWorkspaceId === targetId ? "invalid_scope" : "not_found" });
    }

    if (relation === "target_descendant") {
      const result = await this.sendTreeMessage({
        relation: "descendant",
        senderWorkspaceId,
        targetId,
        message,
        queueDispatchMode,
      });
      return result.success ? Ok({ ...result.data, relation }) : result;
    }

    return this.sendTreeMessage({
      relation: "peer",
      senderWorkspaceId,
      targetId,
      message,
      targetRelation: relation,
      queueDispatchMode,
    });
  }

  private async sendFamilyTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "parent-family" | "sibling-family" }>,
    message: string
  ): Promise<Result<TreeMessagePipelineResult, TreeMessagePipelineError>> {
    const cfg = this.config.loadConfigOrDefault();
    const senderEntry = findWorkspaceEntry(cfg, spec.senderWorkspaceId);
    let targetWorkspaceId: string;
    let familyKind: "child" | "sibling";
    let authorizingParentId: string | undefined;

    if (spec.relation === "parent-family") {
      const parentWorkspaceId = senderEntry?.workspace.parentWorkspaceId;
      if (senderEntry == null || !parentWorkspaceId) {
        return Err({
          code: "invalid_scope" as const,
          message: "task_message_parent is only available from a sub-agent task workspace.",
        });
      }
      if (senderEntry.workspace.workflowTask != null) {
        return Err({
          code: "invalid_scope" as const,
          message: "Workflow-owned tasks communicate through the workflow journal, not messaging.",
        });
      }
      const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
      if (parentEntry == null) {
        return Err({ code: "send_failed" as const, message: "Parent workspace no longer exists." });
      }
      // A parent whose checkout is missing could never run the wake turn (#4824): refuse before
      // any row is persisted, instead of failing later with runtime_not_ready.
      // The sender is the parent's own child, so it may see the readiness error.
      const checkoutError = await getMissingHostLocalCheckoutError(parentEntry);
      if (checkoutError != null) {
        return Err({
          code: "send_failed" as const,
          message: `Parent workspace's checkout is unavailable (${checkoutError}), so it cannot receive messages.`,
        });
      }
      targetWorkspaceId = parentWorkspaceId;
      familyKind = "child";
    } else {
      const index = this.buildAgentTaskIndex(cfg);
      const sharedParentId = index.parentById.get(spec.senderWorkspaceId);
      if (senderEntry == null || !sharedParentId) {
        return Err({ code: "invalid_scope" as const });
      }
      if (findWorkspaceEntry(cfg, spec.targetId) == null) {
        return Err({ code: "not_found" as const });
      }
      if (
        spec.targetId === spec.senderWorkspaceId ||
        index.parentById.get(spec.targetId) !== sharedParentId
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      if (
        this.isWorkflowOwnedTaskUsingIndex(index, spec.targetId) ||
        this.isWorkflowOwnedTaskUsingIndex(index, spec.senderWorkspaceId)
      ) {
        return Err({ code: "invalid_scope" as const });
      }
      targetWorkspaceId = spec.targetId;
      familyKind = "sibling";
      authorizingParentId = sharedParentId;
    }

    assert(senderEntry != null, "family sender validated above");
    const prepared = this.agentPeerMessageBroker.prepareFamilyMessage({
      kind: familyKind,
      senderWorkspaceId: spec.senderWorkspaceId,
      senderTitle:
        coerceNonEmptyString(senderEntry.workspace.title) ??
        coerceNonEmptyString(senderEntry.workspace.name) ??
        "sub-agent",
      message,
    });
    const triggerLabel = prepared.triggerLabel;
    if (spec.relation === "sibling-family") {
      assert(triggerLabel != null, "sibling family message requires a trigger label");
    }

    return this.agentPeerMessageBroker.withDeliveryLock(targetWorkspaceId, async () => {
      // A code_execution loop can call these helpers far faster than a model emits tool calls,
      // so they share task_send_message's peer throttles (rate limits, duplicate suppression,
      // queue cap) instead of a per-session budget that refused long conversations until
      // restart. Checked and recorded under the target's delivery lock, which task_send_message
      // also holds from admission through dispatch (withPeerAdmissionLock), so concurrent sends
      // on either route cannot both pass the same slot, duplicate or queue position.
      const throttleError = this.agentPeerMessageBroker.checkPeerAdmission(
        spec.senderWorkspaceId,
        targetWorkspaceId,
        message
      );
      if (throttleError != null) {
        return Err({
          code: "send_failed" as const,
          message:
            throttleError.code === "rate_limited"
              ? `Rate limited: too many messages to this target; retry in ${Math.ceil((throttleError.retryAfterMs ?? 0) / 1000)} s.`
              : throttleError.reason,
        });
      }
      // Charge the rate slot before dispatch: a delivery can persist its rows and still report
      // failure (goal sync, acceptance observers), and charging only successes would let a
      // loop retry at full speed while appending a payload each time.
      this.agentPeerMessageBroker.recordPeerAttempt(spec.senderWorkspaceId, targetWorkspaceId);
      // SECURITY: sender-controlled content and title stay in an untrusted assistant row. A fixed
      // user-row trigger containing only server-generated IDs wakes the recipient (r21/r25), and
      // both rows ride turn admission together so neither can land in a PREPARING window (r30).
      const payloadRow = createMuxMessage(
        prepared.payloadMessageId,
        "assistant",
        prepared.payloadContent,
        {
          timestamp: Date.now(),
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: "family-message" },
        }
      );
      if (spec.relation === "parent-family") {
        const parentEntry = findWorkspaceEntry(cfg, targetWorkspaceId);
        assert(parentEntry != null, "validated parent workspace disappeared from snapshot");
        const wakeResult = await this.wakeParentWorkspaceWithSyntheticMessage({
          parentWorkspaceId: targetWorkspaceId,
          parentEntry,
          content: prepared.triggerContent,
          queueDispatchMode: spec.queueDispatchMode,
          resolveRecipientHold: true,
          preTurnMessages: [payloadRow],
        });
        if (!wakeResult.success) {
          return Err({ code: "send_failed" as const, message: wakeResult.error });
        }
        this.agentPeerMessageBroker.recordPeerDelivery(
          spec.senderWorkspaceId,
          targetWorkspaceId,
          message
        );
        return Ok({ parentWorkspaceId: targetWorkspaceId });
      }

      assert(authorizingParentId != null, "validated sibling sender lost its parent in snapshot");
      assert(triggerLabel != null, "sibling family message requires a trigger label");
      const sendResult = await this.dispatchTrustedDescendantMessage(
        authorizingParentId,
        spec.targetId,
        prepared.triggerContent,
        this.resolveRecipientDispatchMode(spec.targetId, spec.queueDispatchMode),
        "sibling",
        {
          messageLabel: triggerLabel,
          preTurnMessages: [payloadRow],
        }
      );
      if (sendResult.success) {
        this.agentPeerMessageBroker.recordPeerDelivery(
          spec.senderWorkspaceId,
          targetWorkspaceId,
          message
        );
      }
      return sendResult;
    });
  }

  /**
   * Busy-time delivery for agent messages is the recipient's choice. Tool-end is the default
   * because fast delivery is what lets agents coordinate; a recipient that must not be cut into
   * mid-turn opts into turn-end, which also overrides a sender's explicit tool-end. Senders may
   * always ask for the less intrusive turn-end. Reads config fresh so a preference acknowledged
   * before admission applies.
   */
  private resolveRecipientDispatchMode(
    targetWorkspaceId: string,
    requested: TaskMessageQueueDispatchMode | undefined
  ): TaskMessageQueueDispatchMode {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), targetWorkspaceId);
    const recipient =
      getValidAgentMessageDispatchMode(entry?.workspace.agentMessageDispatchMode) ?? "tool-end";
    return recipient === "turn-end" ? "turn-end" : (requested ?? recipient);
  }

  /**
   * task_send_message's per-target admission lock. task_message_parent/sibling share its peer
   * throttles, so both routes must also hold one lock from admission through dispatch: with
   * separate locks a family
   * send admitted while a peer send was in flight passed the same rate slot, duplicate check and
   * queue position. The broker's delivery lock is the one
   * the family route holds; it is taken before the event lock, the family route's nesting (its
   * sibling dispatch takes the event lock inside it).
   * The resulting per-target FIFO is intended (#5334): a family send to a target, including
   * task_message_parent, waits behind an in-flight task_send_message to that target, and the
   * reverse, for as long as that send's admission and dispatch take. The wait is what lets the
   * later send see the earlier one's rate slot, duplicate entry and queue position. The
   * cross-route tests in taskService.peerLimitsRepro.test.ts pin it for
   * task_message_sibling behind task_send_message: the family send must not be admitted before
   * the peer send's delivery is recorded. task_message_parent takes the same lock.
   */
  private withPeerAdmissionLock<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
    return this.agentPeerMessageBroker.withDeliveryLock(targetId, () =>
      this.workspaceEventLocks.withLock(targetId, fn)
    );
  }

  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "descendant" }>
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>>;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "peer" }>
  ): Promise<
    Result<
      SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
      SendAgentTreeMessageError
    >
  >;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "parent-family" }>
  ): Promise<Result<SendParentAgentMessageResult, SendParentAgentMessageError>>;
  private sendTreeMessage(
    spec: Extract<TreeMessageSpec, { relation: "sibling-family" }>
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>>;
  private async sendTreeMessage(
    spec: TreeMessageSpec
  ): Promise<Result<TreeMessagePipelineResult, TreeMessagePipelineError>> {
    const message = spec.message.trim();
    const assertionName = treeMessageAssertionName(spec);
    assert(message.length > 0, `${assertionName}: message must be non-empty`);

    if (spec.relation === "descendant") {
      return this.dispatchTrustedDescendantMessage(
        spec.senderWorkspaceId,
        spec.targetId,
        message,
        spec.queueDispatchMode,
        "ancestor",
        spec.options
      );
    }

    if (message.length > TASK_FAMILY_MESSAGE_MAX_CHARS) {
      return spec.relation === "peer"
        ? Err({
            code: "refused" as const,
            reason: `Message exceeds the ${TASK_FAMILY_MESSAGE_MAX_CHARS}-character peer-message limit; send a shorter summary.`,
          })
        : Err({
            code: "send_failed" as const,
            message: `Message exceeds the ${TASK_FAMILY_MESSAGE_MAX_CHARS}-character family-message limit; send a summary instead.`,
          });
    }

    if (spec.relation === "parent-family" || spec.relation === "sibling-family") {
      return this.sendFamilyTreeMessage(spec, message);
    }

    const { senderWorkspaceId, targetId, targetRelation: relation, awaitedDelegatedTurn } = spec;
    const request: PeerSendRequest = {
      spec,
      message,
      senderWorkspaceId,
      targetId,
      relation,
      awaitedDelegatedTurn,
    };
    // Every peer step runs inside both admission locks and none takes either again. The
    // callback returns the step chain's promise, so the locks release when the send settles.
    return this.withPeerAdmissionLock(targetId, () => this.admitPeerSendUnderLock(request));
  }

  /** The peer send under the target's admission locks (see withPeerAdmissionLock). */
  private async admitPeerSendUnderLock(request: PeerSendRequest): Promise<PeerSendResult> {
    const route = this.resolvePeerSendRoute(request);
    if (!route.success) {
      return route;
    }
    const refusal =
      this.refusePeerSendByEndpoint(route.data) ??
      this.refusePeerSendByIsolation(route.data) ??
      this.refusePeerSendByArchive(route.data);
    if (refusal != null) {
      return Err(refusal);
    }
    const admitted = this.admitPeerSendToTarget(route.data);
    if (!admitted.success) {
      return admitted;
    }
    return this.checkPeerTargetCheckout(admitted.data.admission, admitted.data.attempt);
  }

  /**
   * Reads both endpoints under the lock and re-verifies the relation and the link the send was
   * routed under.
   */
  private resolvePeerSendRoute(
    request: PeerSendRequest
  ): Result<PeerSendRoute, SendAgentTreeMessageError> {
    const { spec, senderWorkspaceId, targetId, relation, awaitedDelegatedTurn } = request;
    if (awaitedDelegatedTurn != null) {
      // A retry leaves the parked list only here, under the target's admission lock: removed
      // earlier, it was counted nowhere while it waited for the lock, and a fresh send
      // admitted meanwhile could push the queue past its cap (see flushParkedPeerSends).
      this.peerSendParking.removeRetry(targetId, spec);
    }
    const cfg = this.config.loadConfigOrDefault();
    const targetEntry = findWorkspaceEntry(cfg, targetId);
    const senderEntry = findWorkspaceEntry(cfg, senderWorkspaceId);
    if (!targetEntry || !senderEntry) {
      return Err({ code: "not_found" as const });
    }
    const index = this.buildAgentTaskIndex(cfg);

    // Re-verify under the target's event lock: tree membership may have changed since routing.
    if (
      this.resolveAgentTreeTargetRelation(cfg, index.parentById, senderWorkspaceId, targetId) !==
      relation
    ) {
      return Err({ code: "invalid_scope" as const });
    }

    // Recipient consent is separate from knowing its ID. Refuse before exposing target state,
    // using the same response as an unknown workspace.
    const unrelatedConsent = getValidUnrelatedWorkspaceConsent(
      targetEntry.workspace.unrelatedWorkspaceConsent
    );
    // A retry after a delegated turn needs the grant it was first admitted under: an off/on
    // cycle is a new grant, not permission to revive input admitted before it.
    if (this.unrelatedConsentRevoked(relation, unrelatedConsent, awaitedDelegatedTurn)) {
      return Err({ code: "not_found" as const });
    }
    // Same rule for tag links: both endpoints' generations are captured here and in
    // the parked wait, so restoring the same tag string after a revocation is a new
    // link and cannot revive a message admitted under the previous one.
    const tagGenerations = this.messagingTagGenerationsOf(
      senderEntry.workspace,
      targetEntry.workspace
    );
    if (
      awaitedDelegatedTurn != null &&
      this.tagGenerationMismatch(relation, awaitedDelegatedTurn.tagGenerations, tagGenerations)
    ) {
      return Err({ code: "invalid_scope" as const });
    }

    return Ok({
      ...request,
      index,
      targetEntry,
      senderEntry,
      unrelatedConsent,
      tagGenerations,
      // Roots may start an idle turn. Agent-task targets must already be live: peers cannot own
      // queued prompts or reactivate terminal tasks without rerouting their report ownership.
      targetIsAgentTask: coerceNonEmptyString(targetEntry.workspace.parentWorkspaceId) != null,
      refusals: createPeerSendRefusals(),
    });
  }

  private refusePeerSendByEndpoint(route: PeerSendRoute): SendAgentTreeMessageError | null {
    const { senderWorkspaceId, relation, targetEntry, senderEntry, refusals } = route;
    // Preserve remote/container isolation without changing the existing same-tree policy.
    if (
      relation === "target_unrelated" &&
      (!this.isUnrelatedMessagingEndpoint(senderEntry.workspace) ||
        !this.isUnrelatedMessagingEndpoint(targetEntry.workspace))
    ) {
      return refusals.unrelatedRuntime;
    }

    // Terminal and archived senders cannot wake peers. A reawakened child may send only while
    // its mirrored workspace-turn execution is running and backed by an accepted live handle;
    // queued/starting reservations still belong to the previous terminal execution.
    if (this.isInactivePeerMessagingEndpoint(senderEntry.workspace, senderWorkspaceId)) {
      return refusals.senderInactive;
    }
    return null;
  }

  private refusePeerSendByIsolation(route: PeerSendRoute): SendAgentTreeMessageError | null {
    const { senderWorkspaceId, targetId, index } = route;
    // Workflow-owned endpoints exchange I/O through WorkflowRunner's journal; peer messages
    // would break durable replay (same rationale as reportAgentProgress's early return).
    if (
      this.isWorkflowOwnedTaskUsingIndex(index, senderWorkspaceId) ||
      this.isWorkflowOwnedTaskUsingIndex(index, targetId)
    ) {
      return {
        code: "refused" as const,
        reason: "Workflow-owned tasks cannot send or receive peer messages.",
      };
    }

    // Best-of candidates (and their subtrees) must stay independent: sibling↔candidate would
    // break candidate independence and candidate→ancestor would lobby the selecting parent
    // mid-run. Only the existing ancestor→candidate guidance path is allowed.
    if (
      this.isBestOfChainUsingIndex(index, senderWorkspaceId) ||
      this.isBestOfChainUsingIndex(index, targetId)
    ) {
      return {
        code: "refused" as const,
        reason: "Best-of candidates cannot send or receive peer messages.",
      };
    }
    return null;
  }

  private refusePeerSendByArchive(route: PeerSendRoute): SendAgentTreeMessageError | null {
    const { targetEntry } = route;
    const targetUnavailable =
      targetEntry.workspace.pendingRemoval != null ||
      isWorkspaceArchived(targetEntry.workspace.archivedAt, targetEntry.workspace.unarchivedAt);
    if (targetUnavailable) {
      return {
        code: "not_active" as const,
        taskStatus: targetEntry.workspace.taskStatus ?? "unknown",
        message: "Target workspace is archived or being removed; it cannot receive peer messages.",
      };
    }
    return null;
  }

  /**
   * Admits a routed peer send to its target: the delegated-turn, agent-status and stop gates,
   * then the stop baselines the admission probe compares against.
   */
  private admitPeerSendToTarget(
    route: PeerSendRoute
  ): Result<{ admission: PeerSendAdmission; attempt: PeerSendAttempt }, SendAgentTreeMessageError> {
    const { refusals } = route;
    // A root running a delegated workspace turn stays owner-only (#4997). Only the turn's OWNER
    // may CONTINUE it (correlation resolved below): the owner already steers the turn through
    // follow-ups. Any other sender, an opted-in unrelated root or a same-tree descendant, waits
    // until the turn settles and then runs as its own turn under the recipient's saved agent:
    // continuing the turn would run under the recipient's saved agent rather than the owner's
    // per-turn override (handle records do not store it) and land in the owner's result. Even
    // the owner is refused while the turn is only reserved (its requireIdle send has not passed
    // admission) or when the live handle no longer matches the resolved correlation:
    // dispatched uncorrelated, such a wake would steal the reserved turn or settle the owner's
    // turn as superseded. Agent-task targets are excluded: a reawakened child's execution is its
    // own task run under its own agent, and once it settles the child is terminal, which peers
    // cannot reactivate.
    // Process-local courtesy: another backend's delegated turn is invisible here (#4446; see
    // CONCURRENT BACKENDS in processLiveness.ts).
    const attempt: PeerSendAttempt = {
      delegatedTurnCorrelation: "unresolved",
      admissionRefusal: null,
      refusedAtRegistrationEpoch: undefined,
      parkedThisAttempt: false,
      accepted: false,
    };
    if (this.delegatedRootRefusalOf(route, attempt) === refusals.delegatedRootStarting) {
      return Err(refusals.delegatedRootStarting);
    }
    const statusRefusal = this.refusePeerSendByAgentStatus(route);
    if (statusRefusal != null) {
      return Err(statusRefusal);
    }
    const chains = this.resolvePeerSendChains(route);
    if (!chains.success) {
      return chains;
    }
    return Ok({ admission: this.capturePeerStopEpochs(route, chains.data), attempt });
  }

  private refusePeerSendByAgentStatus(route: PeerSendRoute): SendAgentTreeMessageError | null {
    const { targetId, targetEntry } = route;
    if (route.targetIsAgentTask) {
      const targetStatus = targetEntry.workspace.taskStatus ?? "running";
      // Match task_list's effective-running overlay, but require accepted correlation so a
      // queued reawakening cannot be converted into an unowned peer continuation.
      const targetExecutionActive = this.hasLiveRunningExecution(targetEntry.workspace, targetId);
      if (!targetExecutionActive) {
        if (targetStatus === "queued" || targetStatus === "starting") {
          return {
            code: "not_active" as const,
            taskStatus: targetStatus,
            message:
              "Target has not started yet; only its parent may update a queued task's prompt.",
          };
        }
        // Stable terminal status wins even while the old stream winds down, or a queued peer
        // trigger could dispatch after completion and reactivate the task.
        if (targetStatus !== "running" && targetStatus !== "awaiting_report") {
          return {
            code: "not_active" as const,
            taskStatus: targetStatus,
            message: "Target is inactive; peer messages cannot reactivate it — ask its parent.",
          };
        }
      }
    }
    return null;
  }

  /** Both endpoints' ancestor chains, refused when the user interrupted or is stopping one. */
  private resolvePeerSendChains(
    route: PeerSendRoute
  ): Result<PeerSendChains, SendAgentTreeMessageError> {
    const { senderWorkspaceId, targetId, index, refusals } = route;
    // A hard interrupt is an explicit user stop: markParentWorkspaceInterrupted suppresses
    // auto-resume until real user input, and an agent message racing that cascade must not
    // undo the stop by queueing or starting another turn on the interrupted workspace. The
    // suppression set holds the ANCESTOR the user interrupted, so check the target's whole
    // ancestor chain — the termination cascade may not have reached a lower target yet.
    const targetChainIds = [
      targetId,
      ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, targetId),
    ];
    if (this.isPeerChainInterrupted(targetChainIds)) {
      return Err(refusals.interrupted);
    }

    // A user stop on any of the SENDER's ancestors also invalidates this send: the descendant
    // interruption cascade may not have reached the sender yet (its status still reads
    // running), but a prompt-influenced agent in a stopped subtree must not wake workspaces
    // outside it from its winding-down tool call.
    const senderChainIds = [
      senderWorkspaceId,
      ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, senderWorkspaceId),
    ];
    if (this.isPeerChainInterrupted(senderChainIds)) {
      return Err(refusals.senderInactive);
    }

    // In-progress stop latches: a send ENTERING after a stop's epoch bump would capture the
    // post-bump generation as its clean baseline (making the epoch probe below blind to it)
    // while the cascade is still persisting terminal statuses — the endpoints still read
    // running. The level latch spans exactly that window; once released, the persisted
    // statuses take over refusal. Target attribution wins on a shared stopped ancestor.
    if (this.isPeerChainStopping(targetChainIds)) {
      return Err(refusals.interrupted);
    }
    if (this.isPeerChainStopping(senderChainIds)) {
      return Err(refusals.senderInactive);
    }
    return Ok({ targetChainIds, senderChainIds });
  }

  /**
   * Latch stop generations for the admission probe: the suppression set and persisted
   * statuses are level-triggered, so a Stop followed by a quick user resume BETWEEN probe
   * evaluations (e.g. while a queued entry sits in PREPARING) would read as clean again. Any
   * bump after this capture keeps the send stale forever — the resumed workspace belongs to
   * the user, not to a wake admitted before the stop. Both endpoints' chains are captured;
   * the per-chain probes attribute the refusal to the stopped side.
   * A retry after a delegated turn keeps its first admission's generations; the target's was
   * refreshed when the drain started (see flushParkedPeerSends).
   */
  private capturePeerStopEpochs(route: PeerSendRoute, chains: PeerSendChains): PeerSendAdmission {
    const { targetId, awaitedDelegatedTurn } = route;
    const { targetChainIds, senderChainIds } = chains;
    assert(
      awaitedDelegatedTurn == null || (targetChainIds.length === 1 && !route.targetIsAgentTask),
      "only root targets wait for a delegated turn"
    );
    const capturedStopEpochs = new Map(
      [...senderChainIds, ...targetChainIds].map((id) => [
        id,
        awaitedDelegatedTurn?.stopEpochs.get(id) ?? this.getWorkspaceStopEpoch(id),
      ])
    );
    // Only a first attempt parks, and only root targets wait, so the target's own count is
    // the one that matters (see park()).
    const capturedUserStopEpoch = this.workspaceUserStopEpochs.get(targetId) ?? 0;
    return {
      ...route,
      targetChainIds,
      senderChainIds,
      capturedStopEpochs,
      capturedUserStopEpoch,
      firstAttempt: awaitedDelegatedTurn == null,
    };
  }

  /**
   * A known missing checkout (#4305), e.g. a worktree archived with checkout deletion and then
   * unarchived: refuse before any envelope row is persisted, instead of
   * accepting the message and failing later with runtime_not_ready. One probe of this target,
   * never in instance discovery. Same-tree targets are probed too (#4824). An unrelated
   * sender is untrusted, so its reason is fixed and carries no path or runtime detail; a
   * same-tree sender gets the readiness error. A checkout deleted after this probe still
   * hits the runtime gate. Probed after the stop epochs are captured: this await is a
   * suspension point, and admissionStale() must still see a Stop that lands while it is
   * pending.
   */
  private async checkPeerTargetCheckout(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): Promise<PeerSendResult> {
    const checkoutError = await getMissingHostLocalCheckoutError(admission.targetEntry);
    if (checkoutError != null) {
      return Err({
        code: "refused" as const,
        reason: OPAQUE_CHECKOUT_RELATIONS.has(admission.relation)
          ? "The target workspace's checkout is unavailable, so it cannot receive messages."
          : `The target workspace's checkout is unavailable (${checkoutError}), so it cannot receive messages.`,
      });
    }

    const throttleError = this.chargePeerSendAttempt(admission);
    if (throttleError != null) {
      return Err(throttleError);
    }
    return this.resolvePeerTurnMetadata(
      admission,
      attempt,
      this.preparePeerSendEnvelope(admission)
    );
  }

  /** Checks the peer throttles and charges the rate slot of a first attempt. */
  private chargePeerSendAttempt(
    admission: PeerSendAdmission
  ): AgentPeerMessageAdmissionError | null {
    const { senderWorkspaceId, targetId, message, awaitedDelegatedTurn } = admission;
    // A retry after a delegated turn was already admitted and counted once.
    const throttleError =
      awaitedDelegatedTurn == null
        ? this.agentPeerMessageBroker.checkPeerAdmission(senderWorkspaceId, targetId, message)
        : null;
    if (throttleError != null) {
      return throttleError;
    }
    // Charge the rate slot at admission, like the family route: sendMessage can persist the
    // payload row and still report failure, and charging only successes let a failing loop
    // land a payload per call without limit. A retry was charged when it was first admitted.
    // A send refused after this point (the admission probe sees a stop, an archive or a consent
    // change, or park() refuses after a user Stop) keeps its slot too. That is intended (#5334): it matches the
    // family route, and a refund would have to tell a clean refusal apart from a failure that
    // already persisted rows, which is the case the charge exists for.
    if (awaitedDelegatedTurn == null) {
      this.agentPeerMessageBroker.recordPeerAttempt(senderWorkspaceId, targetId);
    }
    return null;
  }

  /** Builds the peer envelope, its payload row metadata and the trigger's attribution. */
  private preparePeerSendEnvelope(admission: PeerSendAdmission): PeerSendEnvelope {
    const { senderWorkspaceId, senderEntry, relation, message } = admission;
    const rawSenderTitle =
      coerceNonEmptyString(senderEntry.workspace.title) ??
      coerceNonEmptyString(senderEntry.workspace.name);
    const {
      envelope,
      fromTitle: senderTitle,
      payloadMessageId,
      relationship,
      trigger,
    } = this.agentPeerMessageBroker.preparePeerMessage({
      senderWorkspaceId,
      senderTitle: rawSenderTitle,
      relation,
      message,
    });
    const muxMetadata: MuxMessageMetadata = {
      type: "agent-peer-message",
      fromWorkspaceId: senderWorkspaceId,
      ...(senderTitle != null ? { fromTitle: senderTitle } : {}),
      relationship,
    };
    // Bare attribution (no discriminator) — carried on workspace-turn correlated triggers so
    // correlation stripping can downgrade the row to plain peer metadata (see message.ts).
    // payloadMessageId lets the transcript fold the trigger into the payload card.
    const peerTriggerMeta: AgentPeerMessageMeta = {
      fromWorkspaceId: senderWorkspaceId,
      ...(senderTitle != null ? { fromTitle: senderTitle } : {}),
      relationship,
      payloadMessageId,
    };
    // SECURITY: same assistant-row/fixed-trigger separation as the family-message paths above —
    // sending the envelope as the message TEXT persisted it as a USER row, promoting
    // prompt-injected peer output to user-priority input in the target (user turns drive
    // bash/file tools under the target's own policy). The envelope rides as an assistant-role
    // pre-turn row instead, and the turn is triggered by a fixed-content user message with
    // ZERO sender-controlled bytes (workspace IDs are server-generated; the capped title stays
    // inside the untrusted envelope row). The trigger names the payload row by its
    // server-generated message ID, not adjacency — a streaming target's own assistant row can
    // land between payload and queued trigger.
    return { envelope, payloadMessageId, trigger, muxMetadata, peerTriggerMeta };
  }

  /**
   * Delegated-turn correlation: if the target is currently executing a delegated workspace
   * turn, the trigger must carry that correlation (like wakeParentWorkspaceWithSynthetic-
   * Message) — otherwise the queued peer wake dispatches as an unrelated turn and the next
   * stream end settles the owner's delegated turn as interrupted/superseded. Peer
   * attribution stays on the assistant payload row, so no provenance is lost; the queue
   * still counts these entries by their dedupe-key prefix.
   * A retry after a delegated turn never carries a correlation (#4997).
   */
  private async resolvePeerTurnMetadata(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    prepared: PeerSendEnvelope
  ): Promise<PeerSendResult> {
    const { senderWorkspaceId, targetId, awaitedDelegatedTurn, targetIsAgentTask } = admission;
    const resolvedTurnMuxMetadata =
      awaitedDelegatedTurn == null
        ? await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
            targetId,
            { requireAcceptedRegistration: true }
          )
        : undefined;
    // Only its owner continues a root's delegated turn (#4997): a non-owner's message waits for
    // it, so it never needs the correlation, and must not carry it if the turn settles before
    // the admission gates look again. Reawakened agent-task children are continued
    // by any peer.
    const workspaceTurnMuxMetadata =
      targetIsAgentTask || resolvedTurnMuxMetadata?.ownerWorkspaceId === senderWorkspaceId
        ? resolvedTurnMuxMetadata
        : undefined;
    attempt.delegatedTurnCorrelation = workspaceTurnMuxMetadata;
    // Keep the explicit trigger marker alongside the correlation: displayedMessageBuilder
    // renders machine notifications from metadata, so a bare workspace-turn replacement would
    // present the backend trigger as a human prompt (and re-enter prompt navigation).
    const triggerMuxMetadata: MuxMessageMetadata =
      workspaceTurnMuxMetadata != null
        ? { ...workspaceTurnMuxMetadata, agentPeerMessageTrigger: prepared.peerTriggerMeta }
        : { type: "agent-peer-message", ...prepared.peerTriggerMeta };
    return this.resolvePeerSendOptions(admission, attempt, {
      ...prepared,
      workspaceTurnMuxMetadata,
      triggerMuxMetadata,
    });
  }

  /** Picks the send options of the target's kind, then dispatches with them. */
  private resolvePeerSendOptions(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    turn: PeerSendTurn
  ): Promise<PeerSendResult> {
    const { relation, awaitedDelegatedTurn, targetIsAgentTask } = admission;
    if (relation === "target_ancestor" && awaitedDelegatedTurn == null) {
      return this.dispatchPeerSendWithAncestorOptions(admission, attempt, turn);
    }
    if (!targetIsAgentTask || awaitedDelegatedTurn != null) {
      return this.dispatchPeerSendWithRecipientOptions(admission, attempt, turn);
    }
    return this.dispatchPeerSend(
      admission,
      attempt,
      turn,
      this.buildTaskPeerSendOptions(admission, turn.triggerMuxMetadata)
    );
  }

  private async dispatchPeerSendWithAncestorOptions(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    turn: PeerSendTurn
  ): Promise<PeerSendResult> {
    const resumeOptions = await this.resolveParentAutoResumeOptions(
      admission.targetId,
      admission.targetEntry,
      defaultModel
    );
    return this.dispatchPeerSend(admission, attempt, turn, {
      model: resumeOptions.model,
      agentId: resumeOptions.agentId,
      thinkingLevel: resumeOptions.thinkingLevel,
      reasoningMode: resumeOptions.reasoningMode,
      serviceTier: resumeOptions.serviceTier,
      muxMetadata: turn.triggerMuxMetadata,
    });
  }

  private async dispatchPeerSendWithRecipientOptions(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    turn: PeerSendTurn
  ): Promise<PeerSendResult> {
    const { targetId, targetEntry, awaitedDelegatedTurn } = admission;
    assert(!admission.targetIsAgentTask);
    // Honor the recipient's selected identity (including plan), not the sender's or an
    // older history row. Without a selection, the shared history → exec fallback applies.
    // Known tradeoff: the owner's continuation of its delegated turn also uses these
    // persisted settings, not its per-turn agent override (handle records do not store it).
    // A retry after a delegated turn never falls back to history, whose newest agent is that
    // turn's override: it takes the recipient's saved agent or the workspace default.
    const persistedAgentId =
      awaitedDelegatedTurn != null
        ? resolvePersistedAgentId(targetEntry.workspace)
        : resolvePersistedAgentIdCandidates(targetEntry.workspace)[0];
    const resumeOptions = await this.resolveParentAutoResumeOptions(
      targetId,
      targetEntry,
      defaultModel,
      persistedAgentId ? { agentId: persistedAgentId } : undefined
    );
    return this.dispatchPeerSend(admission, attempt, turn, {
      ...resumeOptions,
      muxMetadata: turn.triggerMuxMetadata,
    });
  }

  private buildTaskPeerSendOptions(
    admission: PeerSendAdmission,
    triggerMuxMetadata: MuxMessageMetadata
  ): SendMessageOptions {
    const { targetEntry } = admission;
    const activeAgentId = resolveTaskAgentIdForResume(targetEntry.workspace);
    const activeAiSettings = this.resolveWorkspaceAISettings(targetEntry.workspace, activeAgentId);
    return {
      ...buildActiveTaskAiSendOptions(targetEntry.workspace, activeAgentId, activeAiSettings),
      muxMetadata: triggerMuxMetadata,
    };
  }

  /**
   * Dispatches an admitted peer send: rechecks its admission, hands the trigger and its payload
   * row to the target's turn admission, then settles the result.
   */
  private async dispatchPeerSend(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    turn: PeerSendTurn,
    sendOptions: SendMessageOptions
  ): Promise<PeerSendResult> {
    const { spec, senderWorkspaceId, targetId, firstAttempt, refusals } = admission;
    const { trigger, workspaceTurnMuxMetadata } = turn;
    // The envelope rides as an assistant-role pre-turn row (never a user turn), persisted
    // atomically with the trigger through the target's own turn admission — a direct history
    // append could land inside another turn's PREPARING window.
    const payloadRow = createMuxMessage(turn.payloadMessageId, "assistant", turn.envelope, {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      muxMetadata: turn.muxMetadata,
    });
    const refusedBeforeDispatch =
      this.refuseStalePeerSendBeforeDispatch(admission, attempt) ??
      this.queuePeerSendBehindParked(admission, attempt);
    if (refusedBeforeDispatch !== undefined) {
      return refusedBeforeDispatch;
    }
    // Resolved after the awaits above so a preference change acknowledged meanwhile applies.
    const effectiveDispatchMode = this.resolveRecipientDispatchMode(
      targetId,
      spec.queueDispatchMode
    );
    const queuedSendOptions = { ...sendOptions, queueDispatchMode: effectiveDispatchMode };

    const reconcileWithdrawnContinuation =
      workspaceTurnMuxMetadata != null
        ? () =>
            this.scheduleWithdrawnWorkspaceTurnContinuationReconcile(
              targetId,
              workspaceTurnMuxMetadata
            )
        : undefined;
    // Admission classification: parent guidance into a live child continues its attempt (no
    // rotation); the fence at the handoff refuses it once the attempt closed.
    const sendResult = await this.workspaceService.sendMessage(
      targetId,
      trigger,
      queuedSendOptions,
      {
        acceptanceOrigin: "automatic",
        admissionStale: () => this.isPeerAdmissionStale(admission, attempt),
        // Re-read at the enqueue point, after sendMessage's own awaits (#4804).
        honorRecipientHold: true,
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        // Peer sends must not count as fresh user attention: resetAutoResumeCount clears the
        // auto-resume budget and the user's interrupt latch, which only the user or parent may do.
        skipAutoResumeReset: true,
        // Unique key ⇒ never coalesces (removable dedupe keys force a sealed queue entry), so
        // sender attribution, queue caps, and previews survive later queued messages.
        queueDedupeKey: `${AGENT_PEER_MESSAGE_DEDUPE_PREFIX}${senderWorkspaceId}:${randomUUID()}`,
        removableQueueDedupeKey: true,
        workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
        preTurnMessages: [payloadRow],
        onAccepted: () => {
          attempt.accepted = true;
        },
        // A first attempt withdrawn because another workspace's delegated turn started meanwhile
        // waits for that turn instead. Any other withdrawal (stop, revoked consent, archive, or
        // a retry's) drops it as before. onCanceled fires only when the rows were never written
        // or were verifiably rolled back, so waiting cannot duplicate them; a failure after
        // durable rows only refuses.
        onCanceled: () => {
          if (firstAttempt && attempt.admissionRefusal === refusals.awaitDelegatedTurn) {
            this.parkPeerSendForDelegatedTurn(admission, attempt);
          }
          reconcileWithdrawnContinuation?.();
        },
        onAcceptedPreStreamFailure: reconcileWithdrawnContinuation,
      }
    );
    return this.settlePeerSendResult(admission, attempt, sendResult, effectiveDispatchMode);
  }

  /**
   * Recheck immediately before dispatch: resolveParentAutoResumeOptions and the
   * workspace-turn lookup awaited since the first check.
   */
  private refuseStalePeerSendBeforeDispatch(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): PeerSendResult | undefined {
    if (this.isPeerAdmissionStale(admission, attempt)) {
      if (
        admission.firstAttempt &&
        attempt.admissionRefusal === admission.refusals.awaitDelegatedTurn
      ) {
        return this.waitForDelegatedTurn(admission, attempt);
      }
      return Err(attempt.admissionRefusal ?? admission.refusals.interrupted);
    }
    return undefined;
  }

  /**
   * Messages that waited for a delegated turn are still draining: queue behind them rather
   * than overtake them. The owner's continuation of a live turn is not affected.
   */
  private queuePeerSendBehindParked(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): PeerSendResult | undefined {
    const { targetId } = admission;
    if (
      admission.firstAttempt &&
      !admission.targetIsAgentTask &&
      this.peerSendParking.hasParked(targetId) &&
      this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(targetId) == null
    ) {
      return this.waitForDelegatedTurn(admission, attempt);
    }
    return undefined;
  }

  /**
   * A non-owner's message waits for the delegated turn and retries this whole path once the
   * turn's registration is released (#4997). It never carries the turn's correlation, so it
   * can neither defer nor settle the owner's handle, and dropping it changes no turn state.
   * It waits at most once: a retry that meets another delegated turn, or that the queue
   * withdraws, is dropped like any other withdrawn message. A dropped retry is only logged;
   * its sender already got a queued result (best-effort peer delivery).
   * Once per attempt: more than one refusal path can observe the wait.
   * Runs from onCanceled too, so it reads the attempt's fields when it runs.
   */
  private parkPeerSendForDelegatedTurn(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): void {
    const { spec, targetId, unrelatedConsent, tagGenerations, capturedStopEpochs } = admission;
    assert(
      admission.firstAttempt,
      "sendTreeMessage: a retry after a delegated turn never waits again"
    );
    if (attempt.parkedThisAttempt) return;
    // A user Stop since this attempt was admitted refuses it, even when the stop landed after
    // the refusing gate (the final gate awaits its rollback before onCanceled parks). The
    // Stop already dropped the parked list, and the flush takes a new target stop baseline,
    // so a message parked now would run after the Stop once the user resumes.
    if ((this.workspaceUserStopEpochs.get(targetId) ?? 0) !== admission.capturedUserStopEpoch) {
      attempt.admissionRefusal = admission.refusals.interrupted;
      return;
    }
    attempt.parkedThisAttempt = true;
    this.peerSendParking.parkPeerSend({
      ...spec,
      awaitedDelegatedTurn: {
        unrelatedConsent,
        tagGenerations,
        registrationEpoch:
          attempt.refusedAtRegistrationEpoch ?? this.peerSendParking.registrationEpoch(targetId),
        stopEpochs: new Map(capturedStopEpochs),
      },
    });
  }

  /** Parks the send for the delegated turn and reports it queued, or refuses it. */
  private waitForDelegatedTurn(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): PeerSendResult {
    this.parkPeerSendForDelegatedTurn(admission, attempt);
    if (!attempt.parkedThisAttempt) {
      return Err(attempt.admissionRefusal ?? admission.refusals.interrupted);
    }
    this.agentPeerMessageBroker.recordPeerDelivery(
      admission.senderWorkspaceId,
      admission.targetId,
      admission.message
    );
    return Ok({
      delivery: "queued" as const,
      relation: admission.relation,
      awaitsDelegatedTurn: true as const,
    });
  }

  /** Maps sendMessage's result to the peer send's result, in the original refusal order. */
  private settlePeerSendResult(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    sendResult: Result<void, SendMessageError>,
    effectiveDispatchMode: TaskMessageQueueDispatchMode
  ): PeerSendResult {
    const { senderWorkspaceId, targetId, message, relation, refusals } = admission;
    if (!sendResult.success) {
      if (attempt.admissionRefusal === refusals.awaitDelegatedTurn) {
        if (attempt.parkedThisAttempt) return this.waitForDelegatedTurn(admission, attempt);
        return Err(refusals.awaitDelegatedTurn);
      }
      // A probe-triggered rejection surfaces the precise refusal (stop won the race), not a
      // generic transport failure.
      if (attempt.admissionRefusal != null) {
        return Err(attempt.admissionRefusal);
      }
      return Err({
        code: "send_failed" as const,
        message: formatSendMessageError(sendResult.error).message,
      });
    }

    if (admission.firstAttempt) {
      this.agentPeerMessageBroker.recordPeerDelivery(senderWorkspaceId, targetId, message);
    }
    return Ok(
      attempt.accepted
        ? { delivery: "accepted" as const, relation }
        : { delivery: "queued" as const, relation, queueDispatchMode: effectiveDispatchMode }
    );
  }

  /**
   * Admission staleness probe: neither interruptStream nor stopDescendantAgentTask takes
   * this target's event lock, so a user Stop or task_stop can land during ANY await between
   * the stop capture and the real admission — including the host's sendMessage() pricing/settings
   * awaits and the session's turn preparation. The probe is synchronous and
   * re-evaluated by the host at the enqueue block and the session's turn-admission
   * gates, so a stop in those windows refuses the send instead of queueing a wake or
   * resurrecting the stopped task via markInterruptedTaskRunning.
   * It runs from sendMessage and the session, so it reads and writes the attempt when it runs.
   */
  private isPeerAdmissionStale(admission: PeerSendAdmission, attempt: PeerSendAttempt): boolean {
    return (
      this.isPeerAdmissionStaleByStops(admission, attempt) ||
      this.isPeerAdmissionStaleByDelegatedRoot(admission, attempt) ||
      this.isPeerAdmissionStaleInConfig(admission, attempt)
    );
  }

  private isPeerAdmissionStaleByStops(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): boolean {
    const { targetChainIds, senderChainIds, capturedStopEpochs, refusals } = admission;
    // Latched stop checks first: unlike the level-triggered probes below, a generation bump
    // stays observable even when a user resume already cleared suppression and restored
    // running statuses between probe evaluations. The in-progress latch backstops stops
    // whose cascade has not yet persisted terminal statuses. Target attribution wins when
    // a shared ancestor (e.g. the tree root) was stopped — the target-side refusal tells
    // the sender the recipient will not accept messages until the user resumes it.
    if (
      this.peerChainStopEpochChanged(targetChainIds, capturedStopEpochs) ||
      this.isPeerChainStopping(targetChainIds)
    ) {
      attempt.admissionRefusal = refusals.interrupted;
      return true;
    }
    if (
      this.peerChainStopEpochChanged(senderChainIds, capturedStopEpochs) ||
      this.isPeerChainStopping(senderChainIds)
    ) {
      attempt.admissionRefusal = refusals.senderInactive;
      return true;
    }
    if (this.isPeerChainInterrupted(targetChainIds)) {
      attempt.admissionRefusal = refusals.interrupted;
      return true;
    }
    return false;
  }

  private isPeerAdmissionStaleByDelegatedRoot(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): boolean {
    const delegatedRootRefusal = this.delegatedRootRefusalOf(admission, attempt);
    if (delegatedRootRefusal != null) {
      if (delegatedRootRefusal === admission.refusals.awaitDelegatedTurn) {
        attempt.refusedAtRegistrationEpoch ??= this.peerSendParking.registrationEpoch(
          admission.targetId
        );
      }
      attempt.admissionRefusal = delegatedRootRefusal;
      return true;
    }
    return false;
  }

  private isPeerAdmissionStaleInConfig(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt
  ): boolean {
    const { senderWorkspaceId, targetId, senderChainIds, refusals } = admission;
    const freshCfg = this.config.loadConfigOrDefault();
    // Sender revalidation: a reawakened child stopped mid-send (its owner interrupted the
    // workspace turn) must not wake an idle peer from its winding-down tool call. The
    // execution mirror is marked terminal with the handle transition, so this re-read
    // observes the stop before stopStream completes. The chain check covers a user stop on
    // a sender ancestor whose cascade has not reached the sender yet.
    const freshSender = findWorkspaceEntry(freshCfg, senderWorkspaceId);
    if (
      freshSender == null ||
      this.isPeerChainInterrupted(senderChainIds) ||
      this.isInactivePeerMessagingEndpoint(freshSender.workspace, senderWorkspaceId)
    ) {
      attempt.admissionRefusal = refusals.senderInactive;
      return true;
    }
    const freshEntry = findWorkspaceEntry(freshCfg, targetId);
    if (freshEntry == null) {
      attempt.admissionRefusal = { code: "not_found" as const };
      return true;
    }
    return (
      this.isPeerAdmissionStaleByLink(admission, attempt, freshCfg, freshSender, freshEntry) ||
      this.isPeerAdmissionStaleByArchive(attempt, freshEntry) ||
      this.isPeerAdmissionStaleByAgentStatus(admission, attempt, freshEntry)
    );
  }

  private isPeerAdmissionStaleByLink(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    freshCfg: ProjectsConfig,
    freshSender: NonNullable<ReturnType<typeof findWorkspaceEntry>>,
    freshEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): boolean {
    const { senderWorkspaceId, targetId, relation, tagGenerations, unrelatedConsent } = admission;
    // Chat links and @tags authorize only the currently linked pair/group, not a
    // permanent cross-runtime grant. Recheck after preparation and at queued dispatch.
    if (
      this.resolveAgentTreeTargetRelation(
        freshCfg,
        this.buildAgentTaskIndex(freshCfg).parentById,
        senderWorkspaceId,
        targetId
      ) !== relation
    ) {
      attempt.admissionRefusal = { code: "invalid_scope" as const };
      return true;
    }
    // The relation can re-resolve as tagged after a clear/re-tag cycle with the
    // same string; the generation fence is what permanently invalidates the send.
    if (
      this.tagGenerationMismatch(
        relation,
        tagGenerations,
        this.messagingTagGenerationsOf(freshSender.workspace, freshEntry.workspace)
      )
    ) {
      attempt.admissionRefusal = { code: "invalid_scope" as const };
      return true;
    }
    // An off/on cycle is a new grant, not permission to revive previously queued input.
    // Recheck through the final synchronous session gate as well as after preparation awaits.
    if (
      relation === "target_unrelated" &&
      getValidUnrelatedWorkspaceConsent(freshEntry.workspace.unrelatedWorkspaceConsent) !==
        unrelatedConsent
    ) {
      attempt.admissionRefusal = { code: "not_found" as const };
      return true;
    }
    // Runtime can change during preparation or while queued; recheck both ends at dispatch.
    if (
      relation === "target_unrelated" &&
      (!this.isUnrelatedMessagingEndpoint(freshSender.workspace) ||
        !this.isUnrelatedMessagingEndpoint(freshEntry.workspace))
    ) {
      attempt.admissionRefusal = admission.refusals.unrelatedRuntime;
      return true;
    }
    return false;
  }

  private isPeerAdmissionStaleByArchive(
    attempt: PeerSendAttempt,
    freshEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): boolean {
    // Closing a side chat claims removal before tearing down its session; neither an
    // in-flight reply nor queued input may wake it behind that discard/archive boundary.
    if (
      freshEntry.workspace.pendingRemoval != null ||
      isWorkspaceArchived(freshEntry.workspace.archivedAt, freshEntry.workspace.unarchivedAt)
    ) {
      attempt.admissionRefusal = {
        code: "not_active" as const,
        taskStatus: freshEntry.workspace.taskStatus ?? "unknown",
        message: "Target workspace is archived or being removed; it cannot receive peer messages.",
      };
      return true;
    }
    return false;
  }

  private isPeerAdmissionStaleByAgentStatus(
    admission: PeerSendAdmission,
    attempt: PeerSendAttempt,
    freshEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>
  ): boolean {
    if (admission.targetIsAgentTask) {
      // task_stop persists taskStatus="interrupted" (and terminal execution mirrors) under
      // the task-tree lifecycle lock; re-read the persisted state at admission so the stop
      // always wins the race.
      const freshStatus = freshEntry.workspace.taskStatus ?? "running";
      if (
        !this.hasLiveRunningExecution(freshEntry.workspace, admission.targetId) &&
        freshStatus !== "running" &&
        freshStatus !== "awaiting_report"
      ) {
        attempt.admissionRefusal = {
          code: "not_active" as const,
          taskStatus: freshStatus,
          message:
            "Target stopped before the message was admitted; peer messages cannot reactivate it.",
        };
        return true;
      }
    }
    return false;
  }

  /**
   * The delegated-turn refusal of a root target, or null. The admission probe calls it again
   * after the correlation lookup, so it reads the attempt's correlation when it runs.
   */
  private delegatedRootRefusalOf(
    route: PeerSendRoute,
    attempt: PeerSendAttempt
  ): PeerSendRefusal | null {
    const { targetId, awaitedDelegatedTurn, refusals } = route;
    if (route.targetIsAgentTask) return null;
    // A retry is dropped once any delegated turn registered after it parked, even one that
    // settled again before this check (#5271).
    if (
      awaitedDelegatedTurn != null &&
      this.peerSendParking.registrationEpoch(targetId) !== awaitedDelegatedTurn.registrationEpoch
    ) {
      return refusals.awaitDelegatedTurn;
    }
    const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(targetId);
    // A send that resolved a correlation continues that turn only while it is registered:
    // once it settled (for example by a read of its handle, which does not take this lock),
    // the correlation is stale and must not reach the session.
    if (live == null) {
      return attempt.delegatedTurnCorrelation != null &&
        attempt.delegatedTurnCorrelation !== "unresolved"
        ? refusals.delegatedRootStarting
        : null;
    }
    return this.liveDelegatedTurnRefusalOf(route, attempt, live);
  }

  private liveDelegatedTurnRefusalOf(
    route: PeerSendRoute,
    attempt: PeerSendAttempt,
    live: NonNullable<ReturnType<WorkspaceTurnManager["getLiveWorkspaceTurnRegistration"]>>
  ): PeerSendRefusal | null {
    const { refusals } = route;
    // A retry never joins a delegated turn, not even one its own sender started meanwhile.
    if (live.ownerWorkspaceId !== route.senderWorkspaceId || route.awaitedDelegatedTurn != null) {
      return refusals.awaitDelegatedTurn;
    }
    if (!live.accepted) return refusals.delegatedRootStarting;
    // Before the correlation lookup, the owner's accepted turn is a continuation candidate.
    if (attempt.delegatedTurnCorrelation === "unresolved") return null;
    return live.handleId !== attempt.delegatedTurnCorrelation?.taskHandleId ||
      live.ownerWorkspaceId !== attempt.delegatedTurnCorrelation.ownerWorkspaceId
      ? refusals.delegatedRootStarting
      : null;
  }

  /** True when the user interrupted a workspace of the chain (see sendTreeMessage). */
  private isPeerChainInterrupted(chainIds: readonly string[]): boolean {
    return chainIds.some((id) => this.interruptedParentWorkspaceIds.has(id));
  }

  /** True while a stop of a workspace of the chain is still in progress. */
  private isPeerChainStopping(chainIds: readonly string[]): boolean {
    return chainIds.some((id) => this.isWorkspaceStopInProgress(id));
  }

  /** True when a workspace of the chain was stopped since its stop epoch was captured. */
  private peerChainStopEpochChanged(
    chainIds: readonly string[],
    capturedStopEpochs: ReadonlyMap<string, number>
  ): boolean {
    return chainIds.some((id) => this.getWorkspaceStopEpoch(id) !== capturedStopEpochs.get(id));
  }

  async stopDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<{ stoppedTaskIds: string[] }, string>> {
    assert(ancestorWorkspaceId.length > 0, "stopDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "stopDescendantAgentTask: taskId required");

    // A resolved Stop means the stopped tasks accept a message at once (#6727). Their latches drop
    // only after the cleanup (Phase C: e.g. once the settlement receipt is on disk), so wait for
    // that. The bound is terminateAllDescendantAgentTasks' and starts with the Stop: at the
    // deadline the wait logs and returns, the Stop still resolves, and a send is refused as before.
    const releaseDeadlineMs = Date.now() + TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS;
    const stopped = await this.withTaskTreeLifecycleLock(taskId, () =>
      this.stopDescendantAgentTaskUnderLifecycleLock(ancestorWorkspaceId, taskId)
    );
    if (!stopped.success) return stopped;
    // Outside the lifecycle lock: nothing that drops a latch can wait behind this Stop.
    await this.waitForWorkspaceStopsToRelease(stopped.data.latchedTaskIds, releaseDeadlineMs);
    return Ok({ stoppedTaskIds: stopped.data.stoppedTaskIds });
  }

  private async stopDescendantAgentTaskUnderLifecycleLock(
    ancestorWorkspaceId: string,
    taskId: string,
    drainQueue = true
  ): Promise<Result<{ stoppedTaskIds: string[]; latchedTaskIds: readonly string[] }, string>> {
    const stoppedTaskIds: string[] = [];
    const metadataToEmit = new Set<string>();
    const activeHandlesById = new Map<
      string,
      Array<{ ownerWorkspaceId: string; handleId: string }>
    >();
    const latched: string[] = [];
    const goalPausesOwed: string[] = [];

    // Phase A (global mutex, no stream/network awaits): see terminateAllDescendantAgentTasks.
    try {
      await using _lock = await this.mutex.acquire();
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }
      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      const taskIds = [taskId, ...this.listDescendantAgentTaskIdsFromIndex(index, taskId)];
      taskIds.sort(
        (left, right) =>
          this.getTaskDepthFromParentById(index.parentById, right) -
          this.getTaskDepthFromParentById(index.parentById, left)
      );
      // Latch the stop for the whole subtree BEFORE any await below: stopStream waits for
      // in-flight tool calls to settle, and one of those tool calls may be the very peer send
      // this stop must invalidate — a bump deferred to the status transition would deadlock
      // behind it and let every admission probe pass in the meantime. The level latch also
      // covers sends ENTERING during the cascade (they would treat the bumped generation as
      // clean while statuses still read running); each latch drops once its owner settled and
      // cleanup finished.
      for (const id of taskIds) {
        this.taskStopLatch.beginWorkspaceStop(id);
        latched.push(id);
      }
      const activeWorkspaceTurns = await this.getWorkspaceTurnManager().listAllWorkspaceTurns({
        statuses: ["queued", "starting", "running"],
      });

      for (const id of taskIds) {
        const current = findWorkspaceEntry(this.config.loadConfigOrDefault(), id);
        if (!current) {
          // Removed since the subtree snapshot: no status is left to persist, but the latch
          // still waits for the captured owner and the planned cleanup (no absent-config bypass).
          this.taskStopLatch.markWorkspaceStopPersisted(id);
          continue;
        }
        const status = current.workspace.taskStatus ?? "running";
        const activeHandles = activeWorkspaceTurns.filter((turn) => turn.workspaceId === id);
        const executionActive =
          ACTIVE_AGENT_TASK_STATUSES.has(status) || this.aiService.isStreaming(id);
        if (!executionActive && activeHandles.length === 0) {
          // Already terminal with nothing live: the persisted status is the stop marker.
          this.taskStopLatch.markWorkspaceStopPersisted(id);
          continue;
        }
        activeHandlesById.set(
          id,
          activeHandles.map((handle) => ({
            ownerWorkspaceId: handle.ownerWorkspaceId,
            handleId: handle.handleId,
          }))
        );

        // Stop cancels the durable queue too, but never guidance authored after this snapshot.
        const canceledGuidance = new Set(
          current.workspace.taskPendingGuidance?.map((entry) => entry.id)
        );
        let transitioned = false;
        let interrupted = false;
        let parentWorkspaceId: string | undefined;
        await this.editWorkspaceEntry(
          id,
          (workspace) => {
            const previousStatus = workspace.taskStatus;
            parentWorkspaceId = workspace.parentWorkspaceId;
            workspace.taskPendingGuidance = workspace.taskPendingGuidance?.filter(
              (entry) => !canceledGuidance.has(entry.id)
            );
            if (workspace.taskPendingGuidance?.length === 0) delete workspace.taskPendingGuidance;
            const mutation = this.applyInterruptedTaskStatus(workspace);
            interrupted = mutation === "interrupted";
            transitioned = interrupted && previousStatus !== "interrupted";
          },
          { allowMissing: true }
        );
        this.taskStopLatch.markWorkspaceStopPersisted(id);
        if (parentWorkspaceId != null) {
          await this.terminalAttention.suppressTerminalAttention({
            ownerWorkspaceId: parentWorkspaceId,
            sourceKind: "agent_task",
            sourceId: id,
          });
        }
        if (interrupted) goalPausesOwed.push(id);
        if (transitioned) {
          this.recordTaskInterrupted(id, parentWorkspaceId);
          this.rejectWaiters(id, new Error("Task stopped"));
          metadataToEmit.add(id);
        }
        stoppedTaskIds.push(id);
      }
    } finally {
      if (latched.length > 0) {
        await this.finishSubtreeStopCleanup(latched, activeHandlesById);
      }
    }
    // Unlocked: the explicit pause appends the child's goal-pause boundary row.
    await this.settleChildGoalPauses(goalPausesOwed);

    for (const id of metadataToEmit) {
      await this.emitWorkspaceMetadata(id);
    }
    if (drainQueue) await this.maybeStartQueuedTasks();
    return Ok({ stoppedTaskIds, latchedTaskIds: latched });
  }

  /**
   * Phase B of a subtree stop (unlocked): workspace-turn handles are interrupted first —
   * interruptWorkspaceTurn awaits its own stopStream, which must not run under the global mutex
   * either — then every latched descendant's queue clear and stop, once, bounded and concurrent.
   */
  private async finishSubtreeStopCleanup(
    latched: readonly string[],
    activeHandlesById: ReadonlyMap<string, Array<{ ownerWorkspaceId: string; handleId: string }>>
  ): Promise<void> {
    for (const [id, handles] of activeHandlesById) {
      for (const handle of handles) {
        const interrupted = await this.getWorkspaceTurnManager().interruptWorkspaceTurn(
          handle.ownerWorkspaceId,
          handle.handleId,
          { scheduleQueueDrain: false }
        );
        if (!interrupted.success) {
          log.warn("stopDescendantAgentTask: interruptWorkspaceTurn failed", {
            taskId: id,
            handleId: handle.handleId,
            error: interrupted.error,
          });
          continue;
        }
        await this.terminalAttention.suppressTerminalAttention({
          ownerWorkspaceId: handle.ownerWorkspaceId,
          sourceKind: "workspace_turn",
          sourceId: handle.handleId,
        });
      }
    }
    await this.runWorkspaceStopCleanup(latched, {
      label: "stopDescendantAgentTask",
      abandonPartial: false,
      clearQueue: true,
    });
  }

  async terminateDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<TerminateAgentTaskResult, string>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "terminateDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "terminateDescendantAgentTask: taskId must be non-empty");

    const terminatedTaskIds: string[] = [];
    const terminationErrors: string[] = [];
    let toTerminate: string[] = [];
    let parentById = new Map<string, string>();
    const latched: string[] = [];
    const stopTimedOut = new Set<string>();

    // Phase A (global mutex, no stream/network awaits): snapshot the subtree, latch it with its
    // captured owners and settle waiters. Stops and removals run unlocked below.
    try {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      // Terminate the entire subtree to avoid orphaned descendant tasks.
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, taskId);
      toTerminate = Array.from(new Set([taskId, ...descendants]));

      // Delete leaves first to avoid leaving children with missing parents.
      parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of toTerminate) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      toTerminate.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const terminationError = new Error("Task terminated");
      for (const id of toTerminate) {
        this.taskStopLatch.beginWorkspaceStop(id);
        latched.push(id);
        this.waiters.deleteCompletedReport(id);
        this.rejectWaiters(id, terminationError);
        // Durable stop marker before removal: a workspace whose removal later fails or times out
        // must not read as a live running task once its latch settles. An entry already gone has
        // no status left to persist; its captured owner and cleanup still gate the release.
        await this.editWorkspaceEntry(
          id,
          (ws) => {
            this.applyInterruptedTaskStatus(ws);
          },
          { allowMissing: true }
        );
        this.taskStopLatch.markWorkspaceStopPersisted(id);
      }
    } finally {
      // Phase B: every stop at once, bounded per child and in aggregate; a timed-out stop keeps
      // its workspace (and its ancestors) in place because the removal below would race a stream
      // that may still be running.
      if (latched.length > 0) {
        await this.runWorkspaceStopCleanup(latched, {
          label: "terminateDescendantAgentTask",
          abandonPartial: true,
          clearQueue: false,
          onTimeout: (id) => stopTimedOut.add(id),
        });
      }
    }
    // A workspace whose removal below fails or is skipped keeps a paused goal.
    await this.settleChildGoalPauses(latched);

    // When a descendant workspace could not be removed, keep every ancestor of it
    // so the surviving child never points at removed parent metadata.
    const ancestorsBlockedByFailedChild = new Set<string>();
    const blockAncestorsOf = (id: string) => {
      for (
        let cur = parentById.get(id);
        cur != null && !ancestorsBlockedByFailedChild.has(cur);
        cur = parentById.get(cur)
      ) {
        ancestorsBlockedByFailedChild.add(cur);
      }
    };

    for (const id of toTerminate) {
      if (stopTimedOut.has(id)) {
        terminationErrors.push(`Timed out stopping task stream (${id})`);
        blockAncestorsOf(id);
      }
    }

    {
      for (const id of toTerminate) {
        if (stopTimedOut.has(id)) {
          continue;
        }
        if (ancestorsBlockedByFailedChild.has(id)) {
          terminationErrors.push(
            `Skipped removing task workspace (${id}): a descendant task workspace was not removed`
          );
          continue;
        }

        try {
          let removePromise = this.pendingTaskWorkspaceRemovals.get(id);
          if (!removePromise) {
            removePromise = this.workspaceService.remove(id, true);
            this.pendingTaskWorkspaceRemovals.set(id, removePromise);
            const trackedPromise = removePromise;
            void trackedPromise
              .then(
                (result) => result.success,
                (error: unknown) => {
                  log.debug("terminateDescendantAgentTask: workspace removal threw", {
                    taskId: id,
                    error,
                  });
                  return false;
                }
              )
              .then((removed) => {
                if (this.pendingTaskWorkspaceRemovals.get(id) === trackedPromise) {
                  this.pendingTaskWorkspaceRemovals.delete(id);
                }
                // A removal that outlived its termination timeout frees the task slot
                // only when it settles, so kick the scheduler for queued tasks then.
                if (removed) {
                  this.scheduleMaybeStartQueuedTasks();
                }
              });
          }
          const removeOutcome = await raceWithAbortAndTimeout(removePromise, {
            timeoutMs: TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS,
          });
          if (removeOutcome.kind !== "ok") {
            terminationErrors.push(`Timed out removing task workspace (${id})`);
            blockAncestorsOf(id);
            continue;
          }
          if (!removeOutcome.value.success) {
            terminationErrors.push(
              `Failed to remove task workspace (${id}): ${removeOutcome.value.error}`
            );
            blockAncestorsOf(id);
            continue;
          }
        } catch (error: unknown) {
          terminationErrors.push(
            `Failed to remove task workspace (${id}): ${getErrorMessage(error)}`
          );
          blockAncestorsOf(id);
          continue;
        }

        terminatedTaskIds.push(id);
      }
    }
    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    if (terminationErrors.length > 0) {
      return Err(terminationErrors.join("; "));
    }
    return Ok({ terminatedTaskIds });
  }

  /**
   * Best-effort sweep of leftover task workspaces once a workflow run reached a terminal
   * state (completed, failed, interrupted): recheck completed children still deferred by
   * cleanup gates and archive interrupted-without-report garbage.
   */
  async markWorkflowRunEnded(workflowRunId: string): Promise<void> {
    assert(workflowRunId.length > 0, "markWorkflowRunEnded: workflowRunId must be non-empty");
    await this.sweepEndedWorkflowRunTasks(workflowRunId);
  }

  /**
   * Hide leftover task workspaces of a workflow run that reached a terminal state.
   *
   * Why: interrupting a run leaves its children in taskStatus "interrupted" WITHOUT a
   * completed report, and canCleanupReportedTask requires a completed report — so those
   * children would linger in the active sidebar forever (until manual deletion).
   * Workflow-owned children are transient by design (results persist in the workflow
   * run/report artifacts), so archive them — never remove — once the owning run has
   * ended. Archived entries disappear from the active sidebar but keep their data for
   * inspection. User-spawned interrupted tasks are untouched: they intentionally stay
   * visible for manual inspection/resume.
   *
   * workflow_resume stays safe: resume replays the journal and restarts incomplete steps
   * with FRESH task ids (see WorkflowRunner's unrecoverable-started-task restart), so
   * archived old children are never reused.
   *
   * Idempotent (interrupted + not-already-archived filter), so it runs from both the
   * run-end hook and the run-scoped interrupt path: WorkflowService.interruptRun aborts
   * the runner BEFORE terminating descendants, so the runner's onRunEnded can fire while
   * children are still "running" — only the later interrupt-path sweep sees them.
   */
  private async sweepEndedWorkflowRunTasks(workflowRunId: string): Promise<void> {
    assert(workflowRunId.length > 0, "sweepEndedWorkflowRunTasks: workflowRunId must be non-empty");

    // Confirm the run ended before pruning (#5398): the run-end hook also fires when the runner
    // throws while the journal still says running (WorkflowRunner.run), and a pipeline's
    // fail-fast interruptRun reaches this sweep mid-run. A later run end, or the startup sweep,
    // prunes these children once the run is inactive.
    if (await this.isWorkflowRunStillActive(workflowRunId)) {
      log.debug("Skipping workflow task sweep: the run is still active", { workflowRunId });
      return;
    }

    // Phase 1: archive interrupted-without-report descendants of the run. Descendants of
    // run children (spawned by workflow-owned agents) are included via ancestry.
    {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const interruptedTaskIds = [...index.byId.entries()]
        .filter(
          ([taskId, workspace]) =>
            this.isWorkflowRunDescendant(index, taskId, workflowRunId) &&
            workspace.taskStatus === "interrupted" &&
            !hasCompletedAgentReport(workspace) &&
            !isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        )
        .map(([taskId]) => taskId);
      await this.archiveWorkflowTaskWorkspacesDeepestFirst(interruptedTaskIds, index);
    }

    // Phase 2: recheck reported descendants of the run (deepest-first). Eligible ones are
    // removed by the normal cleanup walk. The rest can be blocked by the structural-leaf
    // topology gate: hasChildAgentTasks counts archived children too, so a reported
    // ancestor whose only remaining children are the entries archived in phase 1 can
    // never become removable — removing it anyway would orphan those archived config
    // entries. Archive such ancestors instead: hidden from the active sidebar, fully
    // preserved for inspection, tree intact.
    {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const reportedTaskIds = [...index.byId.entries()]
        .filter(
          ([taskId, workspace]) =>
            this.isWorkflowRunDescendant(index, taskId, workflowRunId) &&
            hasCompletedAgentReport(workspace)
        )
        .map(([taskId]) => taskId);
      const depthById = new Map<string, number>();
      for (const taskId of reportedTaskIds) {
        depthById.set(taskId, this.getTaskDepthFromParentById(index.parentById, taskId));
      }
      reportedTaskIds.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      for (const taskId of reportedTaskIds) {
        await this.cleanupReportedLeafTask(taskId);

        const freshConfig = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(freshConfig, taskId);
        if (!entry) continue; // removed by the cleanup walk
        if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
          continue;
        }
        // Defensive: never hide a workspace with an active stream.
        if (this.aiService.isStreaming(taskId)) continue;
        const freshIndex = this.buildAgentTaskIndex(freshConfig);
        const childTaskIds = freshIndex.childrenByParent.get(taskId) ?? [];
        // Leaf tasks deferred by non-topology gates (pending patch artifact, best-of
        // grouping) keep their own event-driven rechecks; do not archive them here.
        if (childTaskIds.length === 0) continue;
        const blockedOnlyByArchivedChildren = childTaskIds.every((childTaskId) => {
          const child = freshIndex.byId.get(childTaskId);
          return child != null && isWorkspaceArchived(child.archivedAt, child.unarchivedAt);
        });
        if (!blockedOnlyByArchivedChildren) continue;
        await this.archiveWorkflowTaskWorkspacesDeepestFirst([taskId], freshIndex);
      }
    }
  }

  /**
   * False only when every parent workspace holding a task of the run shows the run ended: a
   * terminal status, or no resumable run record (gone, another workspace's, or corrupt). One
   * status-snapshot read per parent; an I/O error proves nothing, so the run counts as active.
   */
  private async isWorkflowRunStillActive(workflowRunId: string): Promise<boolean> {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    const parentWorkspaceIds = new Set<string>();
    for (const workspace of index.byId.values()) {
      const parentWorkspaceId = coerceNonEmptyString(workspace.parentWorkspaceId);
      if (workspace.workflowTask?.runId === workflowRunId && parentWorkspaceId != null) {
        parentWorkspaceIds.add(parentWorkspaceId);
      }
    }
    for (const parentWorkspaceId of parentWorkspaceIds) {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, parentWorkspaceId),
      });
      try {
        const status = await runStore.getRunStatusForLiveness({
          workspaceId: parentWorkspaceId,
          runId: workflowRunId,
        });
        if (status != null && isActiveWorkflowRunStatus(status)) return true;
      } catch (error: unknown) {
        // A corrupt record (JSON/schema) can never be resumed, so it counts as ended
        // (self-heal); an I/O error (EIO, EACCES) may hide an active run.
        if (!isErrnoException(error)) continue;
        log.warn("Workflow run status unreadable; leaving its tasks for a later sweep", {
          workflowRunId,
          parentWorkspaceId,
          error: getErrorMessage(error),
        });
        return true;
      }
    }
    return false;
  }

  /**
   * Archive task workspaces deepest-first (so the host's archive preconditions on
   * descendants hold), logging and continuing on per-task failures — one failed archive
   * must not abort the sweep; failures self-heal on the next startup sweep.
   */
  private async archiveWorkflowTaskWorkspacesDeepestFirst(
    taskIds: readonly string[],
    index: AgentTaskIndex
  ): Promise<void> {
    if (taskIds.length === 0) return;
    const depthById = new Map<string, number>();
    for (const taskId of taskIds) {
      depthById.set(taskId, this.getTaskDepthFromParentById(index.parentById, taskId));
    }
    const orderedTaskIds = [...taskIds].sort(
      (a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0)
    );
    // Ancestors of a task whose archive failed or was skipped must stay visible too:
    // hiding the parent while its child remains active would orphan the child in the
    // sidebar. Deepest-first ordering guarantees descendants settle before ancestors.
    const blockedAncestorIds = new Set<string>();
    const markAncestorsBlocked = (taskId: string): void => {
      let currentId = index.parentById.get(taskId);
      for (let depth = 0; currentId != null && depth < 32; depth++) {
        blockedAncestorIds.add(currentId);
        currentId = index.parentById.get(currentId);
      }
    };
    for (const taskId of orderedTaskIds) {
      if (blockedAncestorIds.has(taskId)) {
        // Own ancestors are already in the set: the failing descendant's walk went to root.
        log.warn(
          "Skipping auto-archive of workflow task workspace; a descendant stayed unarchived",
          { taskId }
        );
        continue;
      }
      try {
        const result = await this.workspaceService.archive(taskId);
        if (!result.success) {
          log.warn("Failed to archive leftover workflow task workspace", {
            taskId,
            error: result.error,
          });
          markAncestorsBlocked(taskId);
        } else if (result.data.kind === "confirm-lossy-untracked-files") {
          // Snapshot-archive mode asks for user confirmation before discarding untracked
          // files. Auto-acknowledging would silently lose data, so leave this workspace
          // visible for manual handling instead.
          log.warn(
            "Skipping auto-archive of workflow task workspace pending untracked-file confirmation",
            { taskId }
          );
          markAncestorsBlocked(taskId);
        }
      } catch (error: unknown) {
        log.warn("Archive of leftover workflow task workspace threw", { taskId, error });
        markAncestorsBlocked(taskId);
      }
    }
  }

  /**
   * Startup self-heal: archive interrupted-without-report workflow-owned tasks whose
   * owning workflow run is no longer active. Covers both children the startup prepass
   * just transitioned to "interrupted" (inactive workflow owner) and historical garbage
   * left by interrupts before this sweep existed. Delegates to
   * sweepEndedWorkflowRunTasks per inactive run so blocked reported ancestors are also
   * resolved. Returns the number of inactive runs swept.
   */
  private async archiveLeftoverTasksOfInactiveWorkflowRuns(): Promise<number> {
    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const inactiveRunIds = new Set<string>();
    for (const [taskId, workspace] of index.byId) {
      if (isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) continue;
      // Seed from two unarchived shapes so a crash mid-sweep still self-heals:
      // - interrupted-without-report children (normal leftover garbage), and
      // - reported tasks, covering a crash after phase 1 archived the interrupted
      //   children but before phase 2 archived the reported ancestor they block —
      //   at that point no unarchived interrupted task remains to re-seed the run.
      // Reported tasks of ACTIVE runs are filtered out by the inactivity check below.
      if (workspace.taskStatus !== "interrupted" && !hasCompletedAgentReport(workspace)) {
        continue;
      }
      // Non-workflow-owned tasks have no owner in ancestry → null → skipped (user-spawned
      // interrupted tasks intentionally stay visible).
      const inactiveOwner = await this.getInactiveWorkflowTaskOwnerForRecovery(taskId, cfg, index);
      if (inactiveOwner == null) continue;
      inactiveRunIds.add(inactiveOwner.runId);
    }
    for (const runId of inactiveRunIds) {
      await this.sweepEndedWorkflowRunTasks(runId);
    }
    return inactiveRunIds.size;
  }

  /**
   * Interrupt all descendant agent tasks for a workspace (leaf-first).
   *
   * Rationale: when a user hard-interrupts a parent workspace, descendants must
   * also stop so they cannot later auto-resume the interrupted parent.
   *
   * Keep interrupted task workspaces on disk so users can inspect or manually
   * resume them later.
   *
   * Legacy naming note: this method retains the original "terminate" name for
   * compatibility with existing call sites.
   *
   * `onStopsReleased`: once every latched descendant's Stop released (its settlement receipt is
   * durable or failed) or the cleanup deadline passed, and before the archival and queue work
   * below (which has no deadline). A workflow interrupt writes the run's "interrupted" status
   * there (WorkflowService.interruptRunTree): a receipt still being written when the
   * backend dies would leave the child indeterminate on every resume. Its error is rethrown
   * after that work.
   */
  async terminateAllDescendantAgentTasks(
    workspaceId: string,
    options?: {
      workflowRunId?: string;
      onStopsReleased?: () => Promise<void>;
      retireBashMonitorAttention?: (taskId: string) => void;
    }
  ): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "terminateAllDescendantAgentTasks: workspaceId must be non-empty"
    );
    const stopReleaseDeadlineMs = Date.now() + TASK_TERMINATION_STOP_STREAM_AGGREGATE_TIMEOUT_MS;

    const interruptedTaskIds: string[] = [];
    const latched: string[] = [];
    const capturedExecutionsById = new Map<
      string,
      { ownerWorkspaceId: string; handleId: string }
    >();

    // Phase A (global mutex, config writes only — no stream or network awaits): snapshot the
    // subtree, latch every descendant with its captured owner, persist terminal statuses and
    // settle waiters. A hung child stream must never block unrelated task creation. Phase B runs
    // in the finally for every latched id even if Phase A throws midway.
    try {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).filter(
        (taskId) =>
          options?.workflowRunId == null ||
          this.isWorkflowRunDescendant(index, taskId, options.workflowRunId)
      );
      if (descendants.length === 0) {
        return interruptedTaskIds;
      }

      // Interrupt leaves first to avoid descendant/ancestor status races.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of descendants) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      descendants.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const interruptionError = new Error("Parent workspace interrupted");

      // Bump + latch the WHOLE descendant set before any await below. The hard-interrupted
      // ancestor's suppression entry is level-triggered and cleared by the user's next real send
      // (resetAutoResumeCount), which can happen while a descendant's stop is still pending — a
      // peer send entering then would capture the already-bumped ancestor epoch as its clean
      // baseline and could wake a cousin or the root after Stop. Each latch holds until the
      // captured owner settles and the descendant's cleanup finishes (recheckWorkspaceStopRelease).
      for (const id of descendants) {
        const record = this.taskStopLatch.beginWorkspaceStop(id);
        latched.push(id);
        // Every latched descendant, a preserved completed report included (its continuation can
        // be executing): synchronously here, so the retirement withdraws an in-flight wake and
        // snapshots the attention owed now, while the latch already refuses new admissions.
        options?.retireBashMonitorAttention?.(id);
        // A reawakened child's live continuation handle is an owner this record waits on; Phase B
        // must settle it explicitly (interruptCapturedExecution). Captured here, in the same
        // synchronous block as the record, so Phase B targets exactly the registration captured.
        if (record.capturedExecutionId != null && !record.executionSettled) {
          const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(id);
          if (live?.handleId === record.capturedExecutionId) {
            capturedExecutionsById.set(id, {
              ownerWorkspaceId: live.ownerWorkspaceId,
              handleId: live.handleId,
            });
          }
        }
      }
      for (const id of descendants) {
        try {
          let preservedCompletedDescendant = false;
          let transitionedToInterrupted = false;
          let parentWorkspaceId: string | undefined;
          const updated = await this.editWorkspaceEntry(
            id,
            (ws) => {
              const previousStatus = ws.taskStatus;
              parentWorkspaceId = ws.parentWorkspaceId;
              preservedCompletedDescendant =
                this.applyInterruptedTaskStatus(ws) === "preserved-completed-report";
              transitionedToInterrupted =
                !preservedCompletedDescendant && previousStatus !== "interrupted";
            },
            { allowMissing: true }
          );
          if (!updated) {
            // Missing descendants should still reject prompt waiters promptly so task_await does
            // not hang until timeout after a parent hard interrupt races with external cleanup.
            // There is no status left to persist; the owner conditions still apply.
            this.taskStopLatch.markWorkspaceStopPersisted(id);
            this.rejectWaiters(id, interruptionError);
            log.debug("terminateAllDescendantAgentTasks: descendant workspace missing", {
              taskId: id,
            });
            continue;
          }
          this.taskStopLatch.markWorkspaceStopPersisted(id);

          if (preservedCompletedDescendant) {
            // A reawakened completed child executes under a live workspace-turn handle while its
            // STABLE status stays terminal: its stop record waits for that execution's mirror
            // settlement (releaseRetainedStopLatches) instead of the interrupted status.
            log.debug("terminateAllDescendantAgentTasks: preserving completed descendant report", {
              taskId: id,
            });
            continue;
          }

          if (transitionedToInterrupted) {
            this.recordTaskInterrupted(id, parentWorkspaceId);
          }
          // Report monotonicity: descendants that did not complete a report must reject waiters
          // once the interrupt status transition is persisted.
          this.rejectWaiters(id, interruptionError);
          interruptedTaskIds.push(id);
        } catch (error: unknown) {
          // Keep processing the remaining descendants; this one's latch stays held (fail closed)
          // until its owner settles and cleanup finishes.
          log.error(
            "terminateAllDescendantAgentTasks: interrupt processing failed; retaining stop latch",
            { taskId: id, error }
          );
        }
      }
    } finally {
      // Phase B (unlocked, bounded, concurrent) then Phase C via recheckWorkspaceStopRelease.
      if (latched.length > 0) {
        await this.runWorkspaceStopCleanup(latched, {
          label: "terminateAllDescendantAgentTasks",
          abandonPartial: false,
          clearQueue: true,
          capturedExecutionsById,
        });
      }
    }
    let stopsReleasedError: { error: unknown } | undefined;
    if (options?.onStopsReleased != null) {
      await this.waitForWorkspaceStopsToRelease(latched, stopReleaseDeadlineMs);
      await options.onStopsReleased().catch((error: unknown) => {
        stopsReleasedError = { error };
      });
    }
    // After Phase B (streams stopped, locks released): the explicit pause appends boundary rows.
    await this.settleChildGoalPauses(interruptedTaskIds);

    for (const taskId of interruptedTaskIds) {
      await this.emitWorkspaceMetadata(taskId);
    }

    if (options?.workflowRunId != null) {
      // Run-scoped interrupts arrive after the owning run's terminal status write
      // (WorkflowService.interruptRun aborts the runner, persists "interrupted" before this
      // point, via onStopsReleased or before terminating descendants), so the children just
      // interrupted above can be archived right away. markWorkflowRunEnded also sweeps, but the runner-abort path can fire
      // onRunEnded before this termination completes — sweeping here closes that
      // ordering race (the sweep is idempotent).
      await this.sweepEndedWorkflowRunTasks(options.workflowRunId);
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    if (stopsReleasedError != null) throw stopsReleasedError.error;
    return interruptedTaskIds;
  }

  private async rollbackFailedTaskCreate(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
      /** The caller already removed the row (and confirmed it): see reclaimUnsanitizedTaskCheckout. */
      rowUnpublished?: boolean;
    }
  ): Promise<{ checkoutRemoved: boolean }> {
    let checkoutRemoved = false;
    let removedFromConfig = options?.rowUnpublished === true;
    try {
      if (!removedFromConfig) {
        await this.config.removeWorkspace(taskId);
        removedFromConfig = true;
      }
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove workspace from config", {
        taskId,
        error: getErrorMessage(error),
      });
    }

    // A create that failed after sendMessage may already have scheduled
    // extension-metadata writes (e.g. the recency update), which would
    // recreate the entry after the deregistration above and leak a stale key
    // until the next process start's lazy prune. Only after deregistration
    // actually succeeded: discarding also write-tombstones the id for this
    // process, which must not silence metadata for a workspace that is still
    // registered because removeWorkspace failed.
    if (removedFromConfig) {
      await this.workspaceService.discardExtensionMetadataEntry(taskId);
    }

    this.workspaceService.emit("metadata", { workspaceId: taskId, metadata: null });

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task.create rollback: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        checkoutRemoved = deleteResult.success;
        if (!deleteResult.success) {
          log.error("Task.create rollback: failed to delete workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task.create rollback: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = path.join(this.config.sessionsDir, taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
    return { checkoutRemoved };
  }

  isForegroundAwaiting(workspaceId: string): boolean {
    return this.waiters.isForegroundAwaiting(workspaceId);
  }

  startForegroundAwait(workspaceId: string): () => void {
    return this.waiters.startForegroundAwait(workspaceId);
  }

  registerBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    this.waiters.registerBackgroundableForegroundWaiter(workspaceId, waiter);
  }

  unregisterBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    this.waiters.unregisterBackgroundableForegroundWaiter(workspaceId, waiter);
  }

  /** See TaskWaiters.backgroundForegroundWaitsForWorkspace. */
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number {
    return this.waiters.backgroundForegroundWaitsForWorkspace(workspaceId);
  }

  /** See TerminalAttentionNotifier.markBackgroundWorkNotifyOnTerminal (task tool calls it). */
  markBackgroundWorkNotifyOnTerminal(taskId: string, ownerWorkspaceId: string): Promise<void> {
    return this.terminalAttention.markBackgroundWorkNotifyOnTerminal(taskId, ownerWorkspaceId);
  }

  private scheduleNotifyOnTerminalPersist(
    taskId: string,
    ownerWorkspaceId: string | undefined
  ): void {
    this.terminalAttention.scheduleNotifyOnTerminalPersist(taskId, ownerWorkspaceId);
  }

  /**
   * Level-triggered reconciliation scan: re-derive owed workflow terminal wakes from durable
   * state (top-level notify_on_terminal run records in a terminal status, minus
   * generation-scoped settled markers) into the in-memory queue and poke the drain. Runs at
   * startup and on a fixed sweep interval, so missed terminal callbacks, crashes, and
   * deferred (transiently unreadable) evaluations always get re-evaluated without any
   * per-failure retry bookkeeping. Archived workspaces are skipped, which parks their wakes
   * unsettled: the unarchive hook (noteWorkspaceUnarchived) and the next interval sweep
   * re-queue them instead of dropping them.
   */
  private async sweepWorkflowRunTerminalAttention(onlyWorkspaceId?: string): Promise<number> {
    const cfg = this.config.loadConfigOrDefault();
    let queuedCount = 0;
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        if (
          workspace.id == null ||
          (onlyWorkspaceId != null && workspace.id !== onlyWorkspaceId) ||
          isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
        ) {
          continue;
        }
        const runStore = new WorkflowRunStore({
          sessionDir: path.join(this.config.sessionsDir, workspace.id),
        });
        let runs: Awaited<ReturnType<WorkflowRunStore["listRuns"]>>;
        try {
          runs = await runStore.listRuns();
        } catch (error: unknown) {
          log.warn("Failed to sweep workflow terminal attention", {
            workspaceId: workspace.id,
            error: getErrorMessage(error),
          });
          continue;
        }
        let queuedForWorkspace = false;
        for (const run of runs) {
          if (
            run.workspaceId !== workspace.id ||
            run.parentWorkflow != null ||
            resolveBackgroundWorkAttentionPolicy(run.attentionPolicy) !== "notify_on_terminal" ||
            // Interrupted runs were stopped deliberately: the terminal callback only notifies
            // them under an explicit service opt-in, and this re-derivation must not undo the
            // user's stop by injecting a continuation prompt. Opt-in callbacks queue directly.
            !WORKFLOW_BACKGROUND_CONTINUATION_STATUSES.has(run.status)
          ) {
            continue;
          }
          let marker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
          try {
            marker = await this.terminalAttentionStore.get(
              workspace.id,
              TerminalAttentionStore.notificationId("workflow_run", run.id, run.updatedAt)
            );
          } catch (error: unknown) {
            // Startup awaits this sweep, so one unreadable marker must not abort it (or app
            // init). Skip the run: an unreadable marker cannot prove the wake is owed, and
            // the next sweep retries, so delivery is delayed, never crashed or duplicated.
            log.warn("Failed to read workflow terminal settlement marker; skipping run", {
              workspaceId: workspace.id,
              runId: run.id,
              error: getErrorMessage(error),
            });
            continue;
          }
          if (marker != null) {
            continue;
          }
          // Upgrade compatibility: the previous build recorded consumption only under the
          // stable un-suffixed id (no generation markers), including history-invisible
          // consumption such as a kernel-nested task_await. The guard keeps generation
          // markers authoritative: the restart-time stable clear is best-effort, so a stale
          // previous-generation marker must not suppress the newer result; mismatched or
          // unparseable evidence fails toward notify.
          let stableMarker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
          try {
            stableMarker = await this.terminalAttentionStore.get(
              workspace.id,
              TerminalAttentionStore.notificationId("workflow_run", run.id)
            );
          } catch (error: unknown) {
            log.warn("Failed to read stable workflow settlement marker; skipping run", {
              workspaceId: workspace.id,
              runId: run.id,
              error: getErrorMessage(error),
            });
            continue;
          }
          if (
            stableMarker != null &&
            (stableMarker.status === "delivered" || stableMarker.status === "superseded")
          ) {
            // Prefer exact generation evidence (this build's settlement refresh records the
            // consumed generation), which is immune to wall-clock corrections; the createdAt
            // recency heuristic remains only for legacy markers from the previous build,
            // which recorded no generation.
            let consumedByStableMarker = stableMarker.generationId === run.updatedAt;
            if (!consumedByStableMarker && stableMarker.generationId == null) {
              const stableMarkerAt = Date.parse(stableMarker.createdAt);
              const terminalGenerationAt = Date.parse(run.updatedAt);
              consumedByStableMarker =
                Number.isFinite(stableMarkerAt) &&
                Number.isFinite(terminalGenerationAt) &&
                stableMarkerAt >= terminalGenerationAt;
            }
            if (consumedByStableMarker) {
              try {
                // Migrate the decision onto this generation's marker so later sweeps stay
                // single-read; the stable marker already proves consumption, so a failed
                // migration only re-runs this fallback on the next sweep.
                await this.terminalAttentionStore.recordSettled({
                  ownerWorkspaceId: workspace.id,
                  sourceKind: "workflow_run",
                  sourceId: run.id,
                  generationId: run.updatedAt,
                  terminalOutcome: terminalAttentionOutcome(run.status),
                  status: stableMarker.status,
                });
              } catch (error: unknown) {
                log.warn("Failed to migrate stable workflow settlement marker", {
                  workspaceId: workspace.id,
                  runId: run.id,
                  error: getErrorMessage(error),
                });
              }
              continue;
            }
          }
          if (this.workflowRunAttention.queueWorkflowRunAttention(workspace.id, run.id)) {
            queuedCount += 1;
          }
          queuedForWorkspace = true;
        }
        if (queuedForWorkspace) {
          this.scheduleTerminalAttentionDrain(workspace.id);
        }
      }
    }
    return queuedCount;
  }

  // ---- Terminal attention notifier ------------------------------------------------------------
  // Deep module for delivering terminal wake-ups for notify_on_terminal work. Sub-agent and
  // workspace-turn settlements enqueue a persisted outbox notification (outside any settlement
  // lock); workflow wakes are level-triggered instead, re-derived from run records + settled
  // markers (see sweepWorkflowRunTerminalAttention). The drain fires when the owner is idle,
  // sends one coalesced synthetic wake-up, and records delivery only after an accepted send.

  /**
   * Note a top-level background workflow run's terminal transition and poke the drain. Purely
   * an accelerator over the durable state the sweep re-derives (run records + settled
   * markers): a lost poke, a removed workspace, or a later resume needs no compensation here,
   * so this writes nothing to disk.
   */
  noteWorkflowRunTerminalAttention(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
  }): void {
    assert(
      params.ownerWorkspaceId.length > 0,
      "noteWorkflowRunTerminalAttention requires ownerWorkspaceId"
    );
    assert(params.runId.length > 0, "noteWorkflowRunTerminalAttention requires runId");
    if (!isTerminalWorkflowRunStatus(params.status)) {
      return;
    }
    this.workflowRunAttention.queueWorkflowRunAttention(params.ownerWorkspaceId, params.runId);
    this.scheduleTerminalAttentionDrain(params.ownerWorkspaceId);
  }

  // Startup and the sweep call this; tests cast-call it. See the notifier for the why.
  private schedulePendingTerminalAttentionOwnerDrains(): Promise<number> {
    return this.terminalAttention.schedulePendingTerminalAttentionOwnerDrains();
  }

  /**
   * Tool-path access to the invocation-boundary snapshot recorded into the
   * agent-workflow-runs sidecar (see recordBackgroundWorkflowRunReference).
   */
  async getWorkflowInvocationBoundaryMessageId(
    workspaceId: string,
    runId: string
  ): Promise<string | null> {
    return this.workspaceService.getWorkflowInvocationBoundaryMessageId(workspaceId, runId);
  }

  /** See WorkflowRunAttention.markWorkflowRunTerminalAttentionSettled. */
  async markWorkflowRunTerminalAttentionSettled(params: {
    ownerWorkspaceId: string;
    runId: string;
    status: WorkflowRunStatus;
    runUpdatedAt: string;
    settledAs: "delivered" | "superseded";
  }): Promise<void> {
    return await this.workflowRunAttention.markWorkflowRunTerminalAttentionSettled(params);
  }

  /** See WorkflowRunAttention.clearWorkflowRunDowngradeSettlement. */
  async clearWorkflowRunDowngradeSettlement(params: {
    ownerWorkspaceId: string;
    runId: string;
  }): Promise<void> {
    return await this.workflowRunAttention.clearWorkflowRunDowngradeSettlement(params);
  }

  private async getAgentTerminalAttentionGenerationId(
    ownerWorkspaceId: string,
    childTaskId: string
  ): Promise<string | undefined> {
    const execution = await this.getDescendantAgentTaskExecutionSnapshot(
      ownerWorkspaceId,
      childTaskId
    );
    return execution?.record.handleId;
  }

  // Spied on in tests, and called through TaskHost (taskWorkspaceSeam): stays a facade.
  enqueueTerminalAttention(
    params: Parameters<TerminalAttentionNotifier["enqueueTerminalAttention"]>[0]
  ): Promise<void> {
    return this.terminalAttention.enqueueTerminalAttention(params);
  }

  scheduleTerminalAttentionDrain(ownerWorkspaceId: string): void {
    this.terminalAttention.scheduleTerminalAttentionDrain(ownerWorkspaceId);
  }

  /**
   * Caller send restrictions (tool policy, workspace-agent disable flag, strict-agent pin) to
   * restore on a terminal-attention wake. The newest manual user row carries the
   * conversation's persisted restrictions; synthetic rows without any (earlier wakes,
   * heartbeat scaffolding) do not define them and are skipped. The walk is unbounded: a long
   * assistant/synthetic tail after the launch turn must not push the defining row out of
   * sight and silently lift the restrictions. It stops at the newest context reset boundary,
   * since rows from the discarded context must not re-disable tools available to the reset
   * context. Throws when history is unreadable so the caller can fail closed instead of
   * waking with unrestricted tools.
   */
  private async resolveTerminalWakeCallerSendRestrictions(ownerWorkspaceId: string): Promise<{
    toolPolicy?: ToolPolicy;
    disableWorkspaceAgents?: boolean;
    strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
  }> {
    // The pin and the policy resolve independently: a synthetic launch row (preserved
    // heartbeat, compaction follow-up) can carry only a strict pin, and the wake bound to that
    // turn's agent must keep the pin loud without lifting an older manual row's policy.
    // Manual rows still define both wholesale (absence means lifted).
    const state: {
      pin: { strictAgentResolution?: SendMessageOptions["strictAgentResolution"] } | null;
      restrictions: { disableWorkspaceAgents?: boolean } | null;
      trace: LegacyTodoNudgePolicyTrace;
    } = { pin: null, restrictions: null, trace: new LegacyTodoNudgePolicyTrace(undefined) };
    const historyResult = await this.historyService.iterateFullHistory(
      ownerWorkspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          // A context reset discards everything before it: pre-reset rows must not define
          // the wake's restrictions or pin. Stopping here leaves undefined fields as fresh
          // defaults, matching a manual send in the post-reset context.
          if (isResetBoundaryMessage(message)) {
            return false;
          }
          if (message.role !== "user") {
            continue;
          }
          // A compaction request disables every tool for its own summary turn only. That
          // per-turn policy is not a caller restriction: adopting it would strip all tools
          // from every wake until the next manual send, so the walk keeps going to the row
          // that actually defines the conversation's restrictions.
          if (isCompactionRequestMessage(message)) {
            continue;
          }
          // Rows older than the one that defined the restrictions only prove where its policy
          // came from (see LegacyTodoNudgePolicyTrace).
          state.trace.visit(message);
          const metadata = message.metadata;
          // The strict-agent pin lives in the row's retry snapshot: an explicit agent override
          // must stay loud on the wake too, or a vanished/corrupted definition would silently
          // recompose the send from the exec fallback (same rule as startup retry and
          // compaction follow-ups). Forwarded verbatim per the field's design note: the object
          // form pins the validated definition's scope/source/chain provenance, not just
          // loudness. Schema-validated like toolPolicy below, since it crosses the same
          // persisted-row boundary; invalid shapes are dropped.
          const rawStrictPin = metadata?.retrySendOptions?.strictAgentResolution;
          const parsedStrictPin =
            rawStrictPin != null && rawStrictPin !== false
              ? SendMessageOptionsSchema.shape.strictAgentResolution.safeParse(rawStrictPin)
              : null;
          if (parsedStrictPin != null && !parsedStrictPin.success) {
            log.warn("Ignoring malformed persisted strictAgentResolution on terminal wake", {
              ownerWorkspaceId,
              messageId: message.id,
            });
          }
          const strictAgentResolution = parsedStrictPin?.success ? parsedStrictPin.data : undefined;
          if (
            state.pin == null &&
            (strictAgentResolution != null || metadata?.synthetic !== true)
          ) {
            state.pin = strictAgentResolution != null ? { strictAgentResolution } : {};
          }
          if (
            state.restrictions == null &&
            (metadata?.toolPolicy != null ||
              metadata?.disableWorkspaceAgents != null ||
              metadata?.synthetic !== true)
          ) {
            // Persisted rows are untrusted disk state: a malformed toolPolicy would throw deep
            // inside send resolution and leave the wake permanently blocked on the same corrupt
            // row. Sanitize instead of trusting the JSON shape; an unparseable policy restores
            // nothing while a valid disable flag still applies (self-healing doctrine).
            const parsedPolicy =
              metadata?.toolPolicy != null ? ToolPolicySchema.safeParse(metadata.toolPolicy) : null;
            if (parsedPolicy != null && !parsedPolicy.success) {
              log.warn("Ignoring malformed persisted toolPolicy on terminal wake", {
                ownerWorkspaceId,
                messageId: message.id,
              });
            }
            // The returned policy is the trace's: it drops a legacy TODO-nudge rule only when
            // older rows prove that Xum added it.
            state.trace = new LegacyTodoNudgePolicyTrace(parsedPolicy?.data);
            state.trace.visit(message);
            state.restrictions = {
              ...(typeof metadata?.disableWorkspaceAgents === "boolean"
                ? { disableWorkspaceAgents: metadata.disableWorkspaceAgents }
                : {}),
            };
          }
          if (state.pin != null && state.restrictions != null && state.trace.finished) {
            return false;
          }
        }
        return undefined;
      }
    );
    if (!historyResult.success) {
      throw new Error(`history unavailable: ${historyResult.error}`);
    }
    return { ...state.restrictions, ...withToolPolicy(state.trace.policy), ...state.pin };
  }

  /**
   * A withdrawn correlated continuation settles nothing itself, but its turn's stream end may have
   * deferred to it (#5261). Once the target is idle the stale-turn sweep decides from live state;
   * the event lock orders this after any already-emitted stream end. Tracked with terminal
   * attention drains, which a settlement here schedules.
   */
  private scheduleWithdrawnWorkspaceTurnContinuationReconcile(
    targetId: string,
    muxMetadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): void {
    const reconcile = async () => {
      for (;;) {
        const idle = await this.workspaceService.waitForIdleAndNoQueuedMessages(targetId).then(
          () => true,
          (error: unknown) => {
            log.debug("Withdrawn continuation idle wait failed; reconciling once", {
              targetId,
              error,
            });
            return false;
          }
        );
        const outcome = await this.workspaceEventLocks.withLock(targetId, () =>
          this.getWorkspaceTurnManager().reconcileWithdrawnWorkspaceTurnContinuation(
            targetId,
            muxMetadata
          )
        );
        if (!idle || outcome !== "retry") return;
      }
    };
    const promise = reconcile()
      .catch((error: unknown) => {
        log.warn("Withdrawn workspace-turn continuation reconcile failed", { targetId, error });
      })
      .finally(() => {
        this.terminalAttention.untrackDrain(promise);
      });
    this.terminalAttention.trackDrain(promise);
  }

  /**
   * Last-moment revalidation for an already-materialized workflow prompt candidate. The
   * composed prompt retains the run snapshot captured at derivation, and invocation
   * currentness alone (conversation evidence) misses two hazards that arrive without
   * touching history or owner busy-ness:
   * - the run's generation can change (a Workflows UI resume/retry flips it back to running;
   *   a kernel resume can complete a NEWER generation), so the retained prompt would deliver
   *   a stale result as if final;
   * - a kernel-nested task_await can consume this generation, writing only the settlement
   *   marker, so resending would replay output the conversation already handled.
   * "superseded" settles the candidate; "defer" leaves its queue entry pending so a later
   * drain re-derives from the then-current run record and markers.
   * Currentness is deliberately the LAST await: it is the read that observes a destructive
   * history mutation (clear/truncation) retiring the run's invocation, and any awaited read
   * after it would reopen the stale-injection window this reread exists to close.
   */
  private async revalidateWorkflowPromptForDispatch(
    ownerWorkspaceId: string,
    candidate: { runId: string; run: WorkflowRunRecord }
  ): Promise<"deliverable" | "superseded" | "defer"> {
    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, ownerWorkspaceId),
      });
      const currentRun = await runStore.getRun(candidate.runId);
      if (
        currentRun.status !== candidate.run.status ||
        currentRun.updatedAt !== candidate.run.updatedAt
      ) {
        return "defer";
      }
      const settledMarker = await this.terminalAttentionStore.get(
        ownerWorkspaceId,
        TerminalAttentionStore.notificationId(
          "workflow_run",
          candidate.runId,
          candidate.run.updatedAt
        )
      );
      if (settledMarker != null) {
        return "defer";
      }
    } catch {
      return "defer";
    }
    const currentness = await this.workspaceService
      .getWorkflowInvocationCurrentness(ownerWorkspaceId, candidate.runId)
      .catch(() => "indeterminate" as const);
    if (currentness !== "current") {
      return currentness === "not_current" ? "superseded" : "defer";
    }
    return "deliverable";
  }

  private async buildWorkflowTerminalPrompt(
    ownerWorkspaceId: string,
    runId: string
  ): Promise<
    | {
        outcome: "deliver";
        prompt: string;
        run: WorkflowRunRecord;
        initiatingAgent?: WorkflowWakeInitiatingAgent;
      }
    // settle: superseded or already consumed; record the generation marker so scans stop here.
    | { outcome: "settle"; run: WorkflowRunRecord }
    // drop: not (or no longer) a wake candidate; just dequeue, nothing durable to mark.
    | { outcome: "drop" }
    // defer: state transiently unreadable; keep queued for the next drain trigger or sweep.
    | { outcome: "defer" }
  > {
    assert(ownerWorkspaceId.length > 0, "buildWorkflowTerminalPrompt requires ownerWorkspaceId");
    assert(runId.length > 0, "buildWorkflowTerminalPrompt requires runId");
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, ownerWorkspaceId),
    });
    let run: Awaited<ReturnType<WorkflowRunStore["getRun"]>>;
    try {
      run = await runStore.getRun(runId);
    } catch (error: unknown) {
      // A missing run (ENOENT) or an unparseable record (no fs code; rereading cannot repair
      // it) is definitively ineligible. Every other fs failure (EIO, EACCES, EISDIR...) is
      // potentially transient, and dropping on it would delay the wake to the next sweep's
      // re-derivation for no reason: defer those like indeterminate currentness below.
      const code =
        error != null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (typeof code === "string" && code !== "ENOENT") {
        log.warn("Deferring workflow terminal wake-up; run record unreadable", {
          ownerWorkspaceId,
          runId,
          error: getErrorMessage(error),
        });
        return { outcome: "defer" };
      }
      log.warn("Failed to load terminal workflow run for wake-up", {
        ownerWorkspaceId,
        runId,
        error: getErrorMessage(error),
      });
      return { outcome: "drop" };
    }
    if (
      run.workspaceId !== ownerWorkspaceId ||
      run.parentWorkflow != null ||
      // A resumed run left terminal state; its next terminal transition re-queues it.
      !isTerminalWorkflowRunStatus(run.status)
    ) {
      return { outcome: "drop" };
    }
    // The durable settled marker outranks the in-memory queue entry: a kernel-nested
    // task_await or workflow_resume can settle this generation after the terminal callback
    // queued it, and that consumption leaves no history evidence for the classification
    // below, so skipping this check would deliver a duplicate wake.
    let settledMarker: Awaited<ReturnType<TerminalAttentionStore["get"]>>;
    try {
      settledMarker = await this.terminalAttentionStore.get(
        ownerWorkspaceId,
        TerminalAttentionStore.notificationId("workflow_run", run.id, run.updatedAt)
      );
    } catch (error: unknown) {
      // An unreadable marker cannot prove the wake is owed; defer like indeterminate currentness.
      log.warn("Deferring workflow terminal wake-up; settlement marker unreadable", {
        ownerWorkspaceId,
        runId,
        error: getErrorMessage(error),
      });
      return { outcome: "defer" };
    }
    if (settledMarker != null) {
      return { outcome: "drop" };
    }
    const currentness = await this.workspaceService.getWorkflowInvocationCurrentness(
      ownerWorkspaceId,
      run.id
    );
    // Indeterminate means history was unreadable, not that the run was superseded: settling
    // now would permanently drop the wake over a transient fault, so defer and retry instead.
    if (currentness === "indeterminate") {
      return { outcome: "defer" };
    }
    if (currentness === "not_current") {
      return { outcome: "settle", run };
    }
    // Bind the wake to the agent recorded at launch: the newest agent-bearing assistant row
    // can belong to an unrelated later synthetic turn (a heartbeat is not a supersession
    // boundary), which would pair a different agent's tool surface with the launch turn's
    // caller policy. Advisory: legacy references fall back to the history walk.
    let initiatingAgent: WorkflowWakeInitiatingAgent | undefined;
    try {
      const references = await readAgentWorkflowRunReferences(
        path.join(this.config.sessionsDir, ownerWorkspaceId)
      );
      const reference = references.find((candidate) => candidate.runId === run.id);
      if (reference?.agentId != null) {
        initiatingAgent = {
          agentId: reference.agentId,
          createdAtMs: reference.createdAtMs,
          ...(reference.strictAgentResolution !== undefined
            ? { strictAgentResolution: reference.strictAgentResolution }
            : {}),
        };
      }
    } catch {
      // Currentness can succeed (e.g. a direct invocation row) and this identity read still
      // fail transiently. Delivering without the recorded identity would bind the wake to the
      // newest agent-bearing history row, handing the run's output to an unrelated later
      // synthetic turn's agent; defer like an unreadable run record.
      return { outcome: "defer" };
    }
    const scriptPath = run.workflow.sourcePath ?? run.workflow.name;
    return {
      outcome: "deliver",
      run,
      ...(initiatingAgent != null ? { initiatingAgent } : {}),
      prompt: buildWorkflowResultContextMessage({
        rawCommand: `workflow_run ${scriptPath}`,
        name: scriptPath,
        runId: run.id,
        status: run.status,
        result: null,
        run,
      }),
    };
  }

  private async ensureAgentTerminalMessages(
    ownerWorkspaceId: string,
    notifications: readonly TerminalAttentionNotification[]
  ): Promise<{
    deliverableNotificationIds: Set<string>;
    latestMessageTimestampByTaskId: Map<string, number>;
  }> {
    const deliverableNotificationIds = new Set<string>();
    const latestMessageTimestampByTaskId = new Map<string, number>();
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(ownerWorkspaceId);
    if (!historyResult.success) {
      return { deliverableNotificationIds, latestMessageTimestampByTaskId };
    }
    const existingReportMessages = new Map<string, MuxMessage>();
    const existingTaskIds = new Set<string>();
    for (const message of historyResult.data) {
      if (message.role !== "user" || message.metadata?.synthetic !== true) continue;
      const taskId = parseTerminalSubagentTaskId(
        message.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      );
      if (taskId == null) continue;
      existingTaskIds.add(taskId);
      existingReportMessages.set(taskId, message);
      const timestamp = message.metadata?.timestamp;
      if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
        latestMessageTimestampByTaskId.set(
          taskId,
          Math.max(latestMessageTimestampByTaskId.get(taskId) ?? 0, timestamp)
        );
      }
    }

    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        ownerWorkspaceId
      );
    const sessionDir = path.join(this.config.sessionsDir, ownerWorkspaceId);
    for (const notification of notifications) {
      if (existingTaskIds.has(notification.sourceId)) {
        const existingMessage = existingReportMessages.get(notification.sourceId);
        if (existingMessage != null && workspaceTurnMuxMetadata != null) {
          const existingCorrelation =
            this.getWorkspaceTurnManager().getWorkspaceTurnMetadataFromValue(
              existingMessage.metadata?.muxMetadata
            );
          if (existingCorrelation != null) {
            const matchesActiveTurn =
              existingCorrelation.taskHandleId === workspaceTurnMuxMetadata.taskHandleId &&
              existingCorrelation.ownerWorkspaceId === workspaceTurnMuxMetadata.ownerWorkspaceId &&
              existingCorrelation.turnId === workspaceTurnMuxMetadata.turnId;
            if (!matchesActiveTurn) {
              // Keep the old report visible, but do not let it wake or settle a later turn.
              await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
              continue;
            }
          } else {
            const updatedMessage: MuxMessage = {
              ...existingMessage,
              metadata: {
                ...existingMessage.metadata,
                muxMetadata: workspaceTurnMuxMetadata,
              },
            };
            const updateResult = await this.historyService.updateHistory(
              ownerWorkspaceId,
              updatedMessage
            );
            if (updateResult.success) {
              existingReportMessages.set(notification.sourceId, updatedMessage);
              this.workspaceService.emitChatEvent(ownerWorkspaceId, {
                ...updatedMessage,
                type: "message",
              });
            } else {
              log.warn("Failed to backfill workspace-turn metadata on terminal report", {
                ownerWorkspaceId,
                taskId: notification.sourceId,
                error: updateResult.error,
              });
            }
          }
        }

        // Report/failure delivery necessarily precedes terminal-attention enqueue. Presence in parent
        // history is therefore authoritative here; continuation freshness is checked separately
        // against the private execution's createdAt before suppressing its workspace-turn wake.
        deliverableNotificationIds.add(notification.id);
        continue;
      }

      const report = await readSubagentReportArtifact(sessionDir, notification.sourceId);
      const failure =
        report == null
          ? await readSubagentFailureArtifact(sessionDir, notification.sourceId)
          : null;
      const content = report
        ? formatSubagentReportUserMessage({
            childWorkspaceId: notification.sourceId,
            agentType: "agent",
            title: report.title ?? "Subagent report",
            reportMarkdown: report.reportMarkdown,
            status: "completed",
            ...(report.model != null ? { model: report.model } : {}),
            ...(report.thinkingLevel != null ? { thinkingLevel: report.thinkingLevel } : {}),
            ...(report.structuredOutput !== undefined
              ? { structuredOutput: report.structuredOutput }
              : {}),
          })
        : failure
          ? formatSubagentFailureUserMessage({
              childWorkspaceId: notification.sourceId,
              agentType: "agent",
              errorType: failure.errorType,
              errorMessage: failure.errorMessage,
            })
          : null;
      if (content == null) {
        log.warn("Superseding terminal sub-agent attention with no durable result", {
          ownerWorkspaceId,
          taskId: notification.sourceId,
        });
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
        continue;
      }

      const timestamp = Date.now();
      const message = createMuxMessage(
        report != null ? createTaskReportMessageId() : createTaskFailureMessageId(),
        "user",
        content,
        {
          timestamp,
          synthetic: true,
          uiVisible: true,
          ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
        }
      );
      const appendResult = await this.historyService.appendToHistory(ownerWorkspaceId, message);
      if (!appendResult.success) {
        log.warn("Failed to repair terminal sub-agent message", {
          ownerWorkspaceId,
          taskId: notification.sourceId,
          error: appendResult.error,
        });
        continue;
      }
      this.workspaceService.emitChatEvent(ownerWorkspaceId, { ...message, type: "message" });
      existingTaskIds.add(notification.sourceId);
      latestMessageTimestampByTaskId.set(notification.sourceId, timestamp);
      deliverableNotificationIds.add(notification.id);
    }
    return { deliverableNotificationIds, latestMessageTimestampByTaskId };
  }

  /** Acknowledge only durably completed answers, before their receipts can be compacted away. */
  async acknowledgeAgentReports(ownerWorkspaceId: string): Promise<ReadonlySet<string>> {
    const consumedIds = new Set<string>();
    const pending = (await this.terminalAttentionStore.listPending(ownerWorkspaceId)).filter(
      (notification) => notification.sourceKind === "agent_task"
    );
    if (pending.length === 0) return consumedIds;

    const pendingIds = new Set(pending.map((notification) => notification.sourceId));
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(ownerWorkspaceId);
    if (!historyResult.success) {
      log.warn("Failed to inspect terminal sub-agent responses", {
        ownerWorkspaceId,
        error: historyResult.error,
      });
      return consumedIds;
    }

    const scan = scanTerminalReportHistory(historyResult.data, pendingIds);
    return await this.markConsumedAgentReports(ownerWorkspaceId, pending, scan, consumedIds);
  }

  /**
   * Decides each pending wake in order and marks the consumed ones delivered. One config read serves
   * every wake. A failed delivery rejects before any later wake is decided.
   */
  private async markConsumedAgentReports(
    ownerWorkspaceId: string,
    pending: readonly TerminalAttentionNotification[],
    scan: TerminalReportHistoryScan,
    consumedIds: Set<string>
  ): Promise<ReadonlySet<string>> {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    const owners = [
      ownerWorkspaceId,
      ...this.listAncestorWorkspaceIdsUsingParentById(index.parentById, ownerWorkspaceId),
    ];
    for (const notification of pending) {
      const decision = decideAgentReportConsumption(notification, scan);
      let consumed: boolean;
      if (decision.kind === "decided") {
        consumed = decision.consumed;
      } else {
        let record: WorkspaceTurnTaskHandleRecord | null = null;
        for (const ownerId of owners) {
          record = await this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
            ownerId,
            decision.handleId
          );
          if (record != null) break;
        }
        consumed = this.continuationReceiptConsumes(notification, record, decision.reports);
      }
      if (consumed) {
        await this.terminalAttentionStore.markDelivered(ownerWorkspaceId, notification.id);
        consumedIds.add(notification.id);
      }
    }
    return consumedIds;
  }

  /** A continuation is consumed when a receipt matches its handle's completed turn record. */
  private continuationReceiptConsumes(
    notification: TerminalAttentionNotification,
    record: WorkspaceTurnTaskHandleRecord | null,
    reports: readonly CompletedTaskReportReceipt[]
  ): boolean {
    if (record?.status === "completed" && record.workspaceId === notification.sourceId) {
      const generation =
        this.getWorkspaceTurnManager().workspaceTurnTerminalAttentionGenerationId(record);
      return (
        (notification.generationId === generation ||
          notification.generationId === record.handleId) &&
        reports.some((report) => receiptMatchesTurnRecord(report, record))
      );
    }
    return false;
  }

  /**
   * A sub-agent report or failure that lands while its owner is mid-turn is already a durable row
   * in the owner's history, but the terminal drain defers until idle and the running turn's model
   * only sees its in-memory messages. A parent blocked in a long task_await on OTHER tasks (or any
   * long tool) therefore could not act on it for many minutes. Per user request, such reports also
   * trigger a new agent turn promptly: queue one coalesced tool-end wake, which (like an
   * agent_report progress update) backgrounds foreground waits and ends the current turn at the
   * next tool boundary. The wake travels the normal queue so queue-cut attribution, delegated-turn
   * continuation and sub-agent parents behave exactly as for any other queued input; the drain
   * then acknowledges the reports once that turn answers after them.
   *
   * Edge-triggered and immediate: only notifications this process just enqueued while the owner
   * was streaming (fresh edges) can cut, on the first drain after their delivery. So a failed or withdrawn wake never re-cuts later
   * turns, and a report left pending across a restart or an older delegated continuation never
   * cuts a later turn; the idle drain still delivers (or supersedes) those as before. No history is
   * read here: busy drains must not inspect history (see "Reconcile only after observing idle").
   */
  private async cutBusyOwnerTurnForSubagentAttention(
    ownerWorkspaceId: string,
    ownerEntry: NonNullable<ReturnType<typeof findWorkspaceEntry>>,
    pending: readonly TerminalAttentionNotification[],
    freshTurns: ReadonlyMap<string, symbol>
  ): Promise<void> {
    // Only the streaming turn that was live when the report was delivered can be cut: a successor
    // turn (for example a manual send, or the next turn after this one ended) already loaded the
    // report from history. A queued, preparing or retrying turn reads history when it starts (a
    // report landing mid-PREPARING keeps the previous wait-for-idle delivery), and a
    // user-interrupted parent stays put until the user acts.
    // The wake must also become the queue head, overtaking only hidden turn-end entries (peer
    // messages, heartbeats). Security: a queued user-authored message may carry stricter caller
    // restrictions that are not in history yet, and promotion never overtakes it, so a wake queued
    // behind it would run after it with older grants. A queued tool-end entry already cuts this
    // turn, and the turn it starts sees the report. Both cases defer to the idle drain.
    // An owner that holds agent messages until its turn ends is not cut (#4737): the idle drain
    // delivers the report when the turn ends. Re-read with the other checks so a preference
    // change acknowledged during the awaits below applies. Exception: an owner running a
    // delegated workspace turn keeps the cut, because without a same-turn continuation that turn
    // would settle and publish its result before the owner saw its child's report.
    const holdsReportUntilTurnEnd = (): boolean =>
      this.resolveRecipientDispatchMode(ownerWorkspaceId, undefined) === "turn-end" &&
      this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(ownerWorkspaceId) == null;
    const liveTurnStillCuttable = (): boolean =>
      !holdsReportUntilTurnEnd() &&
      this.aiService.isStreaming(ownerWorkspaceId) &&
      !this.interruptedParentWorkspaceIds.has(ownerWorkspaceId) &&
      this.workspaceService.promotedToolEndWouldLeadQueue(ownerWorkspaceId);
    const liveTurn = this.workspaceService.getActiveTurnGeneration(ownerWorkspaceId);
    const fresh = pending.filter(
      (notification) =>
        notification.sourceKind === "agent_task" &&
        liveTurn != null &&
        freshTurns.get(notification.id) === liveTurn
    );
    if (fresh.length === 0 || !liveTurnStillCuttable()) {
      return;
    }
    // Non-fatal on failure: the notification stays pending and the idle drain resumes the owner
    // as before. Contain throws too, so the caller still schedules its after-idle drain.
    let wakeError: string | undefined;
    try {
      // Security: this wake starts a fresh turn whose timing the child's report chooses, so it
      // must keep the conversation's caller restrictions exactly like the idle drain's wake.
      // Throws on unreadable history, which fails closed (no cut) via the catch below.
      const restrictions = await this.resolveTerminalWakeCallerSendRestrictions(ownerWorkspaceId);
      // That history read awaited: the turn may have ended or input may have been queued since.
      if (
        !liveTurnStillCuttable() ||
        this.workspaceService.getActiveTurnGeneration(ownerWorkspaceId) !== liveTurn
      ) {
        return;
      }
      const wakeResult = await this.wakeParentWorkspaceWithSyntheticMessage({
        parentWorkspaceId: ownerWorkspaceId,
        parentEntry: ownerEntry,
        content: buildBusyOwnerSubagentAttentionPrompt(
          fresh.every((notification) => notification.terminalOutcome !== "completed")
        ),
        sendRestrictions: restrictions,
        // Coalesces reports that arrive before the wake dispatches into one queued turn.
        queueDedupeKey: "busy-owner-subagent-attention",
        queueDispatchMode: "tool-end",
        // Same reason as agent_report: only the queue head's dispatch mode can cut the stream.
        promoteAheadOfHiddenTurnEnd: true,
        settleContinuationOnSendRefusal: false,
        // Security: yield to a manual send still in preflight (invisible to the queue check
        // above), and re-check queue leadership at the enqueue point after the send's awaits.
        yieldToPreflightSends: true,
        // Hold turned on during this helper's or the send's awaits (#4737): the enqueue point
        // re-checks the probe and yields instead of cutting; the idle drain delivers the report.
        admissionStale: holdsReportUntilTurnEnd,
      });
      if (!wakeResult.success) wakeError = wakeResult.error;
    } catch (error: unknown) {
      wakeError = getErrorMessage(error);
    }
    if (wakeError != null) {
      log.warn("Busy-owner sub-agent report wake failed; deferring to the idle drain", {
        ownerWorkspaceId,
        error: wakeError,
      });
    }
  }

  /**
   * Drain pending terminal notifications for one owner workspace: defer (leave pending) when the
   * owner is busy/queued/preparing, otherwise send one coalesced synthetic wake-up and mark the
   * drained notifications delivered. Stale (deleted-workspace) notifications are marked superseded.
   */
  private async drainTerminalAttention(ownerWorkspaceId: string): Promise<void> {
    // Every drain consumes the fresh edges, whichever branch it takes: an idle drain delivers them
    // itself, and a busy drain may cut the live turn for them exactly once.
    const freshSubagentAttentionTurns = this.terminalAttention.takeFreshTurns(ownerWorkspaceId);
    const allPending = await this.terminalAttentionStore.listPending(ownerWorkspaceId);
    // Legacy pre-reconciler outbox records for workflow runs (no generation suffix) are dead
    // state now that workflow wakes are re-derived from run records + settled markers: delete
    // them so they cannot hold the drain hot forever.
    for (const notification of allPending) {
      if (notification.sourceKind === "workflow_run") {
        await this.terminalAttentionStore.delete(ownerWorkspaceId, notification.id);
      }
    }
    const pending = allPending.filter((notification) => notification.sourceKind !== "workflow_run");
    const queuedWorkflowRunIds = this.workflowRunAttention.queuedRunIds(ownerWorkspaceId);
    if (pending.length === 0 && queuedWorkflowRunIds.length === 0) {
      return;
    }
    // The rest of the drain is a chain of steps: resolveTerminalDrainOwner →
    // deferTerminalDrainWhileOwnerBusy → acknowledgeTerminalDrainReports →
    // collectWorkspaceTurnWakeCandidates → collectTerminalWorkflowWakePrompts →
    // readNonWorkflowBackoffAndMuxMetadata → resolveTerminalWakeRestrictions →
    // selectTerminalWorkflowWakeGroup → composeTerminalWake → deliverTerminalWake. Each step
    // starts the next one in the same tick as its own last await, so no collaborator call runs a
    // microtask later than it did inline; only the drain's own resolution comes later.
    return this.resolveTerminalDrainOwner({
      ownerWorkspaceId,
      freshSubagentAttentionTurns,
      pending,
      queuedWorkflowRunIds,
    });
  }

  /** Supersedes the pending wakes of a deleted or archived owner; else checks the owner's turn. */
  private async resolveTerminalDrainOwner(snapshot: TerminalDrainSnapshot): Promise<void> {
    const { ownerWorkspaceId, pending } = snapshot;
    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, ownerWorkspaceId);
    if (entry == null) {
      // Owner workspace no longer exists: the terminal artifacts remain retrievable elsewhere.
      // Queue only, no markers: a settled-marker write would recreate the deleted session dir.
      this.workflowRunAttention.dropOwner(ownerWorkspaceId);
      for (const notification of pending) {
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
      }
      return;
    }

    if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
      // Workflow wakes stay unsettled while archived: the sweep skips archived workspaces, so
      // dropping the queue parks them until an unarchive-time sweep re-derives the entries.
      this.workflowRunAttention.dropOwner(ownerWorkspaceId);
      for (const notification of pending) {
        await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
      }
      return;
    }
    return this.deferTerminalDrainWhileOwnerBusy({ ...snapshot, cfg, entry });
  }

  /** A busy owner keeps its wakes pending; the drain may cut its live turn for fresh reports. */
  private async deferTerminalDrainWhileOwnerBusy(owner: TerminalDrainOwner): Promise<void> {
    const { ownerWorkspaceId } = owner;
    // Defer-until-idle: never inject ahead of an active stream or a queued/preparing user turn.
    const ownerHasPendingQueuedPreparingOrRetry =
      this.workspaceService.hasPendingQueuedOrPreparingTurn(ownerWorkspaceId);
    const ownerHasBusyQueuedOrRetry =
      this.workspaceService.isBusyForMessage(ownerWorkspaceId) ||
      this.workspaceService.hasQueuedMessages(ownerWorkspaceId) ||
      ownerHasPendingQueuedPreparingOrRetry;
    if (
      this.aiService.isStreaming(ownerWorkspaceId) ||
      ownerHasBusyQueuedOrRetry ||
      this.interruptedParentWorkspaceIds.has(ownerWorkspaceId)
    ) {
      await this.cutBusyOwnerTurnForSubagentAttention(
        ownerWorkspaceId,
        owner.entry,
        owner.pending,
        owner.freshSubagentAttentionTurns
      );
      if (ownerHasBusyQueuedOrRetry && !this.interruptedParentWorkspaceIds.has(ownerWorkspaceId)) {
        this.terminalAttention.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
      }
      return;
    }
    return this.acknowledgeTerminalDrainReports(owner);
  }

  /** Acknowledges the agent reports already in history, and ensures the rest have messages. */
  private async acknowledgeTerminalDrainReports(owner: TerminalDrainOwner): Promise<void> {
    const { ownerWorkspaceId } = owner;
    const taskIndex = this.buildAgentTaskIndex(owner.cfg);
    if (await this.hasBlockingActiveWorkForTerminalDrain(ownerWorkspaceId, taskIndex)) {
      return;
    }

    // Reconcile only after observing idle: an earlier history snapshot can still contain
    // the streaming placeholder, then race the final answer and start a duplicate turn.
    // Normal completion acknowledges before compaction; this is recovery for missed
    // callbacks or reports whose notification was published after the answer committed.
    const consumedIds = await this.acknowledgeAgentReports(ownerWorkspaceId);
    const pending = owner.pending.filter((notification) => !consumedIds.has(notification.id));

    const agentNotifications = pending.filter(
      (notification) => notification.sourceKind === "agent_task"
    );
    const {
      deliverableNotificationIds: deliverableAgentNotificationIds,
      latestMessageTimestampByTaskId,
    } = await this.ensureAgentTerminalMessages(ownerWorkspaceId, agentNotifications);
    // The acknowledged subset replaces the snapshot's pending list for every later step.
    return this.collectWorkspaceTurnWakeCandidates({
      ...owner,
      pending,
      taskIndex,
      agentNotifications,
      deliverableAgentNotificationIds,
      latestMessageTimestampByTaskId,
    });
  }

  /**
   * Collects the pending workspace-turn wakes, superseding a persistent child continuation whose
   * report is already in the owner's history.
   */
  private async collectWorkspaceTurnWakeCandidates(
    attention: TerminalDrainAgentAttention
  ): Promise<void> {
    const { ownerWorkspaceId, taskIndex, latestMessageTimestampByTaskId } = attention;
    const workspaceTurnNotifications = attention.pending.filter(
      (notification) => notification.sourceKind === "workspace_turn"
    );
    const workspaceTurnCandidates: TerminalWorkspaceTurnWakeCandidate[] = [];
    for (const notification of workspaceTurnNotifications) {
      const record = await this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
        ownerWorkspaceId,
        notification.sourceId
      );
      const isPersistentChildContinuation =
        record != null &&
        this.isDescendantAgentTaskUsingParentById(
          taskIndex.parentById,
          ownerWorkspaceId,
          record.workspaceId
        );
      if (isPersistentChildContinuation) {
        const latestTerminalMessageAt = latestMessageTimestampByTaskId.get(record.workspaceId);
        const continuationCreatedAt = Date.parse(record.createdAt);
        if (
          latestTerminalMessageAt != null &&
          Number.isFinite(continuationCreatedAt) &&
          latestTerminalMessageAt >= continuationCreatedAt
        ) {
          // A persistent child continuation reports through the stable child transcript row. Once
          // that report/failure is in parent history, a second task_await wake for the private
          // workspace-turn handle is redundant and exposes an implementation detail to the user.
          await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, notification.id);
          continue;
        }
      }

      workspaceTurnCandidates.push({
        notification,
        publicAwaitId: isPersistentChildContinuation ? record.workspaceId : notification.sourceId,
      });
    }
    return this.collectTerminalWorkflowWakePrompts(attention, workspaceTurnCandidates);
  }

  /** Builds the queued workflow runs' wake prompts, settling or dropping the stale runs. */
  private async collectTerminalWorkflowWakePrompts(
    attention: TerminalDrainAgentAttention,
    workspaceTurnCandidates: readonly TerminalWorkspaceTurnWakeCandidate[]
  ): Promise<void> {
    const { ownerWorkspaceId } = attention;
    const deliverableWorkflowPrompts: TerminalWorkflowWakeCandidate[] = [];

    for (const runId of attention.queuedWorkflowRunIds) {
      const workflowPrompt = await this.buildWorkflowTerminalPrompt(ownerWorkspaceId, runId);
      if (workflowPrompt.outcome === "defer") {
        // History, sidecar, or the run record was transiently unreadable: the run stays
        // queued and the next drain trigger or sweep re-evaluates it.
        log.warn("Deferring workflow terminal attention; state unavailable", {
          ownerWorkspaceId,
          runId,
        });
        continue;
      }
      if (workflowPrompt.outcome === "drop") {
        this.workflowRunAttention.dropRun(ownerWorkspaceId, runId);
        continue;
      }
      if (workflowPrompt.outcome === "settle") {
        // Dropping a notify_on_terminal wake strands the run's owner; keep the drop diagnosable.
        log.warn("Settling superseded workflow terminal attention", {
          ownerWorkspaceId,
          runId,
        });
        await this.markWorkflowRunTerminalAttentionSettled({
          ownerWorkspaceId,
          runId,
          status: workflowPrompt.run.status,
          runUpdatedAt: workflowPrompt.run.updatedAt,
          settledAs: "superseded",
        });
        continue;
      }
      deliverableWorkflowPrompts.push({
        runId,
        run: workflowPrompt.run,
        prompt: workflowPrompt.prompt,
        ...(workflowPrompt.initiatingAgent != null
          ? { initiatingAgent: workflowPrompt.initiatingAgent }
          : {}),
      });
    }
    return this.readNonWorkflowBackoffAndMuxMetadata(
      attention,
      workspaceTurnCandidates,
      deliverableWorkflowPrompts
    );
  }

  /** Reads whether the non-workflow batch is backed off, and the active turn's mux metadata. */
  private async readNonWorkflowBackoffAndMuxMetadata(
    attention: TerminalDrainAgentAttention,
    workspaceTurnCandidates: readonly TerminalWorkspaceTurnWakeCandidate[],
    deliverableWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[]
  ): Promise<void> {
    const { ownerWorkspaceId } = attention;
    // Deliver one launch-identity group per drain, keyed by agentId AND recorded strict pin:
    // the whole coalesced prompt is handled under the single agentId/pin passed to
    // sendMessage, so batching runs from different launch identities would hand a restricted
    // launch's (attacker-influenced) output to another launch's tool grants. Mixed batches
    // too: workspace-turn and sub-agent attention resumes under the conversation's own
    // (history-walk) identity, so agent-bound workflow groups never share their send.
    // Unselected groups stay queued for a later drain; the newest launch goes first.
    // Suppression revalidation below can only shrink the workspace-turn set, so gating on
    // pre-suppression candidates over-approximates non-workflow deliverables: the safe
    // direction, deferring agent-bound groups rather than ever mixing identities in one send.
    // A backed-off non-workflow batch (its conversation-identity send was rejected) sits out
    // the drain entirely, staying pending for the sweep-cadence retry, so agent-bound groups
    // are not starved behind a send that fails the same way on every drain.
    const nonWorkflowSendBackedOff = this.terminalAttention.isWakeSendBackedOff(
      ownerWorkspaceId,
      NON_WORKFLOW_WAKE_BACKOFF_KEY
    );
    const hasNonWorkflowDeliverables =
      !nonWorkflowSendBackedOff &&
      (attention.deliverableAgentNotificationIds.size > 0 || workspaceTurnCandidates.length > 0);
    // Unselected groups stay queued: the delivered group's wake turn ends with a streamEnded
    // drain (and the sweep backstops an aborted one), which delivers the next group.
    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        ownerWorkspaceId
      );

    return this.resolveTerminalWakeRestrictions({
      ...attention,
      workspaceTurnCandidates,
      deliverableWorkflowPrompts,
      nonWorkflowSendBackedOff,
      hasNonWorkflowDeliverables,
      workspaceTurnMuxMetadata,
    });
  }

  /**
   * Resolves the wake's caller restrictions and rereads the workspace-turn candidates, then
   * chains on: selectTerminalWorkflowWakeGroup → composeTerminalWake → deliverTerminalWake. Each
   * step starts the next one in the same tick as its own last await.
   */
  private async resolveTerminalWakeRestrictions(
    candidates: TerminalDrainCandidates
  ): Promise<void> {
    const { ownerWorkspaceId } = candidates;
    // Security: restore the conversation's active caller tool policy on the wake. The ordinary
    // in-stream workflow continuation carries the live turn's effectiveToolPolicy; this
    // synthetic send starts a fresh turn, and omitting the policy would let a workflow wake
    // regain tools the caller disabled (with attacker-influenced workflow output choosing the
    // timing). The agent-level policy recomposes from agentId at send resolution.
    let wakeRestrictions: TerminalWakeRevalidation["wakeRestrictions"];
    try {
      wakeRestrictions = await this.resolveTerminalWakeCallerSendRestrictions(ownerWorkspaceId);
    } catch (error: unknown) {
      // Fail closed: an unknown policy must not fall back to unrestricted tools. Everything
      // stays pending/queued for the next drain trigger or sweep.
      log.warn("Deferring terminal wake; caller tool policy unavailable", {
        ownerWorkspaceId,
        error,
      });
      return;
    }

    // Last-moment suppression revalidation: a quiet owner-follow-up resettle
    // deletes its notification files, but cannot retract this drain's
    // already-taken listPending() snapshot, so the handle records are the
    // source of truth. All candidates are re-read in ONE parallel batch and
    // partitioned synchronously, so no candidate's check goes stale behind a
    // later candidate's await; suppressed handles are dropped instead of
    // waking the owner, and their notifications are marked superseded only
    // after the delivery decision. The residual window is the batch read →
    // sendMessage gap below (no awaits in between besides workflow group
    // selection and delivery itself) — closing it would
    // require holding settlement locks across delivery, which the drain must
    // not do; worst case is one redundant wake (fail toward notify, never a
    // lost wake).
    const candidateRecords = await Promise.all(
      candidates.workspaceTurnCandidates.map((candidate) =>
        this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
          ownerWorkspaceId,
          candidate.notification.sourceId
        )
      )
    );
    return this.selectTerminalWorkflowWakeGroup({
      ...candidates,
      wakeRestrictions,
      candidateRecords,
    });
  }

  /**
   * Selects the launch-identity group of workflow wakes to deliver, and resolves the wake's resume
   * options under that group's identity (or the conversation's own when none is selected).
   */
  private async selectTerminalWorkflowWakeGroup(
    revalidation: TerminalWakeRevalidation
  ): Promise<void> {
    const { ownerWorkspaceId, entry, deliverableWorkflowPrompts } = revalidation;
    // Workflow candidates get the same last-moment treatment, one launch-identity group at a
    // time: a full history clear that completes after buildWorkflowTerminalPrompt classified
    // these runs retires the sidecar but cannot retract the materialized candidates, and once
    // the clear releases its admission guard the owner is idle again, so this requireIdle
    // send would inject a pre-clear workflow result into the freshly cleared conversation.
    // The clear retires references before truncating, so a reread sees not_current and
    // settles; unreadable state stays queued for the next drain or sweep. Groups are tried
    // newest-first until one revalidates, so one unreadable group cannot stall independent
    // wakes behind the sweep. Bounded: every iteration permanently removes one group from
    // this drain's consideration.
    const supersededWorkflowPrompts: TerminalWorkflowWakeCandidate[] = [];
    let currentWorkflowPrompts: readonly TerminalWorkflowWakeCandidate[] = [];
    let workflowInitiatingAgent: WorkflowWakeInitiatingAgent | undefined;
    let resumeOptions: ParentAutoResumeOptions | undefined;
    let remainingWorkflowPrompts = revalidation.hasNonWorkflowDeliverables
      ? deliverableWorkflowPrompts.filter((candidate) => candidate.initiatingAgent == null)
      : deliverableWorkflowPrompts;
    while (remainingWorkflowPrompts.length > 0) {
      const { groupAgent, groupKey, groupCandidates } =
        pickNewestWorkflowWakeGroup(remainingWorkflowPrompts);
      // Group keys embed \u0000, so the empty string safely keys the unpinned group.
      const backoffKey = groupKey ?? "";
      if (this.terminalAttention.isWakeSendBackedOff(ownerWorkspaceId, backoffKey)) {
        // Recently rejected send: leave the group queued and give the next group its turn.
        remainingWorkflowPrompts = remainingWorkflowPrompts.filter(
          (candidate) => !groupCandidates.includes(candidate)
        );
        continue;
      }
      // Resolve the send identity before the revalidation reread so the reread stays the last
      // await before dispatch: a history clear that completes during this history and
      // agent-settings read retires the sidecar, and a reread taken before it would go stale
      // and inject the pre-clear result into the freshly cleared conversation.
      const groupResumeOptions = await this.resolveParentAutoResumeOptions(
        ownerWorkspaceId,
        entry,
        defaultModel,
        groupAgent != null ? { agentId: groupAgent.agentId } : undefined
      );
      const groupRevalidation = await Promise.all(
        groupCandidates.map((candidate) =>
          this.revalidateWorkflowPromptForDispatch(ownerWorkspaceId, candidate)
        )
      );
      const { groupCurrent, groupSuperseded } = classifyWorkflowGroupRevalidation(
        groupCandidates,
        groupRevalidation
      );
      supersededWorkflowPrompts.push(...groupSuperseded);
      if (groupCurrent.length > 0) {
        currentWorkflowPrompts = groupCurrent;
        workflowInitiatingAgent = groupAgent;
        resumeOptions = groupResumeOptions;
        break;
      }
      remainingWorkflowPrompts = remainingWorkflowPrompts.filter(
        (candidate) => !groupCandidates.includes(candidate)
      );
    }

    // No workflow group was selected: resolve under the conversation's own identity. The
    // workspace-turn and sub-agent wakes tolerate this await in the residual window (worst
    // case one redundant wake, never a stale workflow injection).
    resumeOptions ??= await this.resolveParentAutoResumeOptions(
      ownerWorkspaceId,
      entry,
      defaultModel
    );
    return this.composeTerminalWake(revalidation, {
      currentWorkflowPrompts,
      workflowInitiatingAgent,
      supersededWorkflowPrompts,
      resumeOptions,
    });
  }

  /**
   * Partitions the reread workspace-turn candidates, composes the wake prompt and hands the wake
   * to deliverTerminalWake. Synchronous: it runs inside the batch read → sendMessage window.
   */
  private composeTerminalWake(
    revalidation: TerminalWakeRevalidation,
    selection: Pick<
      TerminalWakeDelivery,
      | "currentWorkflowPrompts"
      | "workflowInitiatingAgent"
      | "supersededWorkflowPrompts"
      | "resumeOptions"
    >
  ): Promise<void> {
    // Pair the pin with the delivered group: the newest pin-bearing history row can belong to
    // a different group's wake (each wake persists its own pin), and pinning another agent's
    // provenance onto this group's agentId makes resolution reject the wake on every retry. A
    // recorded pin (or a verified-unpinned null) overrides the walk; legacy references
    // without the field keep the walk pin.
    const groupPin = selection.workflowInitiatingAgent?.strictAgentResolution;
    const effectiveStrictPin =
      groupPin !== undefined
        ? (groupPin ?? undefined)
        : revalidation.wakeRestrictions.strictAgentResolution;
    const { deliverableWorkspaceTurnNotificationIds, publicAwaitIds, suppressedNotificationIds } =
      partitionWorkspaceTurnWakeCandidates(revalidation);

    // Sub-agent reports and failures are already durable user-context messages. Resume from history
    // directly instead of injecting a second user turn that merely tells the model they exist.
    const promptSections: string[] = [];
    if (publicAwaitIds.length > 0) {
      promptSections.push(buildCompletedWorkspaceTurnPrompt(publicAwaitIds));
    }
    promptSections.push(...selection.currentWorkflowPrompts.map((candidate) => candidate.prompt));
    const prompt = promptSections.join("\n\n");
    const effectivePending = revalidation.nonWorkflowSendBackedOff
      ? []
      : revalidation.pending.filter((notification) => {
          if (notification.sourceKind === "agent_task") {
            return revalidation.deliverableAgentNotificationIds.has(notification.id);
          }
          return deliverableWorkspaceTurnNotificationIds.has(notification.id);
        });
    return this.deliverTerminalWake({
      ...revalidation,
      ...selection,
      suppressedNotificationIds,
      effectivePending,
      prompt,
      effectiveStrictPin,
    });
  }

  /**
   * Delivers a drain's composed wake through a chain of steps: exitTerminalWakeWithoutDelivery,
   * resumeTerminalWakeWithoutPrompt, or sendTerminalWakePrompt → fallBackFromBusyTerminalWake →
   * sendBusyFallbackTerminalWake → finishTerminalWakeSend. Each step starts the next one in the
   * same tick as its own last await, so no collaborator call runs a microtask later than it did
   * inline; only the drain's own resolution comes later. This step stays synchronous: no await
   * may separate the drain's batch revalidation from sendMessage.
   */
  private deliverTerminalWake(wake: TerminalWakeDelivery): Promise<void> {
    if (wake.effectivePending.length === 0 && wake.currentWorkflowPrompts.length === 0) {
      return this.exitTerminalWakeWithoutDelivery(wake);
    }
    const sendOptions = this.buildTerminalWakeSendOptions(wake);
    if (wake.prompt.length === 0) {
      return this.resumeTerminalWakeWithoutPrompt(wake, sendOptions);
    }
    return this.sendTerminalWakePrompt(wake, sendOptions);
  }

  /** Nothing to send: marks the suppressed wakes superseded, and re-pokes when that changed state. */
  private async exitTerminalWakeWithoutDelivery(wake: TerminalWakeDelivery): Promise<void> {
    const { ownerWorkspaceId, suppressedNotificationIds, supersededWorkflowPrompts } = wake;
    await this.markSuppressedTerminalWakesSuperseded(wake);
    // Suppression can empty the very batch that excluded agent-bound workflow groups; with
    // nothing sent there is no streamEnded drain, so re-poke instead of parking the queued
    // wake on the sweep. No spin: re-poke only when this drain durably changed state (a
    // suppressed turn or superseded workflow was just marked), so the re-drain sees a
    // different candidate set; an all-indeterminate batch parks for the sweep instead.
    if (
      wake.deliverableWorkflowPrompts.length > 0 &&
      (suppressedNotificationIds.length > 0 || supersededWorkflowPrompts.length > 0)
    ) {
      this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
    }
  }

  /** Marks the wake's suppressed workspace turns and superseded workflow runs as settled. */
  private async markSuppressedTerminalWakesSuperseded(wake: TerminalWakeDelivery): Promise<void> {
    const { ownerWorkspaceId } = wake;
    for (const id of wake.suppressedNotificationIds) {
      await this.terminalAttentionStore.markSuperseded(ownerWorkspaceId, id);
    }
    for (const candidate of wake.supersededWorkflowPrompts) {
      await this.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId,
        runId: candidate.runId,
        status: candidate.run.status,
        runUpdatedAt: candidate.run.updatedAt,
        settledAs: "superseded",
      });
    }
  }

  /** Marks the wake's notifications delivered and its workflow runs settled as delivered. */
  private async markTerminalWakeDelivered(wake: TerminalWakeDelivery): Promise<void> {
    const { ownerWorkspaceId } = wake;
    for (const notification of wake.effectivePending) {
      await this.terminalAttentionStore.markDelivered(ownerWorkspaceId, notification.id);
    }
    for (const candidate of wake.currentWorkflowPrompts) {
      // Marker failures are contained inside the settle method; the delivered wake itself is
      // durable history evidence, so the next evaluation settles this run as consumed.
      await this.markWorkflowRunTerminalAttentionSettled({
        ownerWorkspaceId,
        runId: candidate.runId,
        status: candidate.run.status,
        runUpdatedAt: candidate.run.updatedAt,
        settledAs: "delivered",
      });
    }
  }

  /** Returns the wake's notifications to pending after an accepted send failed before its stream. */
  private async markTerminalWakePendingForRetry(wake: TerminalWakeDelivery): Promise<void> {
    for (const notification of wake.effectivePending) {
      await this.terminalAttentionStore.markPending(wake.ownerWorkspaceId, notification.id);
    }
  }

  /** The wake's send options: the resolved identity plus the caller's restrictions and pin. */
  private buildTerminalWakeSendOptions(wake: TerminalWakeDelivery): SendMessageOptions {
    const { resumeOptions, wakeRestrictions, effectiveStrictPin, workspaceTurnMuxMetadata } = wake;
    return {
      model: resumeOptions.model,
      agentId: resumeOptions.agentId,
      thinkingLevel: resumeOptions.thinkingLevel,
      reasoningMode: resumeOptions.reasoningMode,
      serviceTier: resumeOptions.serviceTier,
      ...(wakeRestrictions.toolPolicy != null ? { toolPolicy: wakeRestrictions.toolPolicy } : {}),
      ...(wakeRestrictions.disableWorkspaceAgents === true ? { disableWorkspaceAgents: true } : {}),
      ...(effectiveStrictPin != null ? { strictAgentResolution: effectiveStrictPin } : {}),
      ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    };
  }

  /** A prompt-free wake: resumes the owner from history, which already holds the sub-agent reports. */
  private async resumeTerminalWakeWithoutPrompt(
    wake: TerminalWakeDelivery,
    sendOptions: SendMessageOptions
  ): Promise<void> {
    const { ownerWorkspaceId, entry } = wake;
    assert(
      wake.agentNotifications.length > 0,
      "prompt-free terminal drain requires sub-agent work"
    );
    // No workspace-turn wakes are delivered on this path, so marking the
    // suppressed ones first cannot go stale against a delivery.
    await this.markSuppressedTerminalWakesSuperseded(wake);
    const resumeResult = await this.workspaceService.resumeStream(ownerWorkspaceId, sendOptions, {
      acceptanceOrigin: "automatic",
      agentInitiated: true,
      // A nested task owner resumed for a descendant's report runs an automatic task turn:
      // it must not be able to create or replace that child's goal.
      ...(entry.workspace.parentWorkspaceId ? { taskTurnKind: "recovery" as const } : {}),
    });
    if (!resumeResult.success) {
      // Persistent failures (for example a budget/model gate) are not made retryable by waiting for
      // idle—the owner is already idle here. Keep the outbox entry pending for a later real signal.
      log.warn("Prompt-free sub-agent resume failed; leaving attention pending", {
        ownerWorkspaceId,
        error: resumeResult.error,
      });
      // Same starvation shape as the prompt path: agent-bound groups were excluded by this
      // batch, so back it off and re-poke to let them send under their own launch identity.
      if (wake.deliverableWorkflowPrompts.some((candidate) => candidate.initiatingAgent != null)) {
        this.terminalAttention.backOffTerminalWakeSends(ownerWorkspaceId, [
          NON_WORKFLOW_WAKE_BACKOFF_KEY,
        ]);
      }
      return;
    }
    if (!resumeResult.data.started) {
      this.terminalAttention.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
      return;
    }
    await this.markTerminalWakeDelivered(wake);
  }

  /** Sends the wake prompt idle-only, then marks the suppressed wakes superseded. */
  private async sendTerminalWakePrompt(
    wake: TerminalWakeDelivery,
    sendOptions: SendMessageOptions
  ): Promise<void> {
    const sendResult = await this.workspaceService.sendMessage(
      wake.ownerWorkspaceId,
      wake.prompt,
      sendOptions,
      // Synthetic, idle-only auto-resume — same flags as the active-work auto-resume path.
      {
        acceptanceOrigin: "automatic",
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        requireIdle: true,
        // The wake carries caller restrictions, and its prompt is the only record of workspace-turn
        // handles marked delivered below, so it must not become a compaction follow-up (#4721).
        skipOnSendCompaction: true,
      }
    );
    // Deferred until after the delivery attempt so no await separates the
    // batch revalidation above from sendMessage. Best-effort: an early return
    // above leaves these pending, and a later drain re-derives suppression
    // from the records and drops them again.
    await this.markSuppressedTerminalWakesSuperseded(wake);
    return this.fallBackFromBusyTerminalWake(wake, sendOptions, sendResult);
  }

  /**
   * After a busy idle-only rejection, retries the wake without requireIdle when the owner is idle
   * again and no blocking work is active (sendBusyFallbackTerminalWake). Every other result goes
   * on to finishTerminalWakeSend unchanged.
   */
  private async fallBackFromBusyTerminalWake(
    wake: TerminalWakeDelivery,
    sendOptions: SendMessageOptions,
    sendResult: TerminalWakeSendResult
  ): Promise<void> {
    const { ownerWorkspaceId } = wake;
    if (!sendResult.success && isWorkspaceBusyIdleOnlySend(sendResult.error)) {
      const latestCfg = this.config.loadConfigOrDefault();
      const latestTaskIndex = this.buildAgentTaskIndex(latestCfg);
      if (
        findWorkspaceEntry(latestCfg, ownerWorkspaceId) != null &&
        !this.aiService.isStreaming(ownerWorkspaceId) &&
        !this.workspaceService.hasPendingQueuedOrPreparingTurn(ownerWorkspaceId) &&
        !this.interruptedParentWorkspaceIds.has(ownerWorkspaceId) &&
        !(await this.hasBlockingActiveWorkForTerminalDrain(ownerWorkspaceId, latestTaskIndex))
      ) {
        return this.sendBusyFallbackTerminalWake(wake, sendOptions);
      }
    }
    return this.finishTerminalWakeSend(wake, sendResult);
  }

  /** Revalidates the wake's workflow candidates and sends the wake again, without requireIdle. */
  private async sendBusyFallbackTerminalWake(
    wake: TerminalWakeDelivery,
    sendOptions: SendMessageOptions
  ): Promise<void> {
    const { ownerWorkspaceId, currentWorkflowPrompts } = wake;
    // Security: the composed prompt retains the pre-check workflow results, and this
    // fallback send omits requireIdle, so its epoch snapshot postdates any clear or reset
    // that completed during the awaited checks above and the clear guard would accept the
    // stale injection into the fresh context. The busy race the primary send just lost
    // may also have been a competing owner turn consuming these very results through
    // kernel-nested task_await (settlement marker only, no history evidence) or a
    // Workflows UI resume changing the run generation. Revalidate everything so the
    // fallback keeps the primary path's contract (no awaits between revalidation and
    // delivery); any stale candidate aborts toward a fresh drain that re-derives, and
    // the queue entries survive for it.
    if (currentWorkflowPrompts.length > 0) {
      const fallbackRevalidation = await Promise.all(
        currentWorkflowPrompts.map((candidate) =>
          this.revalidateWorkflowPromptForDispatch(ownerWorkspaceId, candidate)
        )
      );
      if (fallbackRevalidation.some((verdict) => verdict !== "deliverable")) {
        log.debug("Terminal wake busy fallback aborted; workflow candidates went stale", {
          ownerWorkspaceId,
        });
        this.scheduleTerminalAttentionDrain(ownerWorkspaceId);
        return;
      }
    }
    let fallbackAccepted = false;
    const sendResult = await this.workspaceService.sendMessage(
      ownerWorkspaceId,
      wake.prompt,
      sendOptions,
      {
        acceptanceOrigin: "automatic",
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        // Same wake as the primary send above (#4721).
        skipOnSendCompaction: true,
        onCanceled: () => {
          this.terminalAttention.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
        },
        onAcceptedPreStreamFailure: async () => {
          await this.markTerminalWakePendingForRetry(wake);
          this.terminalAttention.scheduleTerminalAttentionDrainAfterIdle(ownerWorkspaceId);
        },
        onAccepted: async () => {
          fallbackAccepted = true;
          await this.markTerminalWakeDelivered(wake);
        },
      }
    );
    if (sendResult.success && !fallbackAccepted) {
      return;
    }
    return this.finishTerminalWakeSend(wake, sendResult);
  }

  /** A rejected wake backs off its batches (non-busy rejections) and stays pending; else delivered. */
  private async finishTerminalWakeSend(
    wake: TerminalWakeDelivery,
    sendResult: TerminalWakeSendResult
  ): Promise<void> {
    const { ownerWorkspaceId, currentWorkflowPrompts, workflowInitiatingAgent } = wake;
    if (!sendResult.success) {
      if (!isWorkspaceBusyIdleOnlySend(sendResult.error)) {
        // A non-busy rejection is likely batch-specific (an unresolvable pinned agent, a model
        // or provider gate). Back the sent batches off until the sweep cadence retries them
        // and re-poke so the remaining groups get their send this cycle instead of starving
        // behind newest-first selection; the non-workflow batch backs off the same way so a
        // persistently rejected conversation-identity send cannot exclude agent-bound groups
        // on every drain. Bounded: each re-poked drain either delivers or backs off one more
        // key, and with every key backed off it selects nothing.
        const backoffKeys: string[] = [];
        if (currentWorkflowPrompts.length > 0) {
          backoffKeys.push(
            workflowInitiatingAgent != null ? workflowWakeGroupKey(workflowInitiatingAgent) : ""
          );
        }
        if (wake.effectivePending.length > 0) {
          backoffKeys.push(NON_WORKFLOW_WAKE_BACKOFF_KEY);
        }
        if (backoffKeys.length > 0) {
          this.terminalAttention.backOffTerminalWakeSends(ownerWorkspaceId, backoffKeys);
        }
      }
      // Busy rejection: the owner started work between the idle check and the send; leave
      // pending and retry on the next drain trigger.
      log.debug("Terminal attention wake-up not accepted; leaving pending", {
        ownerWorkspaceId,
        error: sendResult.error,
      });
      return;
    }

    await this.markTerminalWakeDelivered(wake);
  }

  /** See TaskWaiters.backgroundForegroundWaitIfQueued. */
  backgroundForegroundWaitIfQueued(
    shouldBackgroundOnQueuedMessage: boolean,
    requestingWorkspaceId: string | undefined
  ): void {
    this.waiters.backgroundForegroundWaitIfQueued(
      shouldBackgroundOnQueuedMessage,
      requestingWorkspaceId
    );
  }

  async reportAgentProgress(
    childWorkspaceId: string,
    toolCallId: string,
    report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): Promise<void> {
    assert(childWorkspaceId.length > 0, "reportAgentProgress requires childWorkspaceId");
    assert(toolCallId.length > 0, "reportAgentProgress requires toolCallId");
    assert(report.reportMarkdown.length > 0, "reportAgentProgress requires reportMarkdown");

    await this.workspaceEventLocks.withLock(childWorkspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const childEntry = findWorkspaceEntry(cfg, childWorkspaceId);
      const directParentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
      if (!childEntry || !directParentWorkspaceId) {
        throw new Error("agent_report is only available from an active sub-agent task");
      }

      const executionId = childEntry.workspace.taskExecutionId;
      let continuationRecord: WorkspaceTurnTaskHandleRecord | null = null;
      if (executionId != null) {
        const active =
          this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(childWorkspaceId);
        if (active?.handleId === executionId) {
          continuationRecord = await this.getWorkspaceTurnManager().getWorkspaceTurnRecord(
            active.ownerWorkspaceId,
            executionId
          );
        } else {
          continuationRecord =
            (await this.getWorkspaceTurnManager().listAllWorkspaceTurns()).find(
              (record) => record.handleId === executionId
            ) ?? null;
        }
      }
      const continuationActive = isActiveWorkspaceTurnTaskStatus(continuationRecord?.status);
      if (hasCompletedAgentReport(childEntry.workspace) && !continuationActive) {
        throw new Error("agent_report cannot send updates after the sub-agent has completed");
      }
      if (childEntry.workspace.taskStatus === "interrupted" && !continuationActive) {
        throw new Error("agent_report cannot send updates from an interrupted sub-agent");
      }
      const activeExecution =
        continuationActive && continuationRecord != null ? continuationRecord : null;
      const parentWorkspaceId = activeExecution?.ownerWorkspaceId ?? directParentWorkspaceId;

      if (childEntry.workspace.workflowTask != null) {
        // Workflow-owned tasks deliver structured output through WorkflowRunner's journal/result
        // path. Waking the parent here would background a foreground workflow wait and expose the
        // internal schema handoff as a user-visible sub-agent update.
        return;
      }

      const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
      if (!parentEntry) {
        throw new Error("agent_report could not find the parent workspace");
      }
      // Like task_message_parent (#4824): a parent whose checkout is missing could never run the
      // wake turn, so refuse before the report row is persisted.
      const parentCheckoutError = await getMissingHostLocalCheckoutError(parentEntry);
      if (parentCheckoutError != null) {
        throw new Error(
          `agent_report cannot wake the parent: its checkout is unavailable (${parentCheckoutError})`
        );
      }

      const agentType = coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent";
      const title = coerceNonEmptyString(report.title) ?? subagentUpdateFallbackTitle(agentType);
      const reportContent = formatSubagentReportUserMessage({
        childWorkspaceId,
        agentType,
        title,
        reportMarkdown: report.reportMarkdown,
        status: "in_progress",
        ...(childEntry.workspace.taskModelString != null
          ? { model: childEntry.workspace.taskModelString }
          : {}),
        ...(childEntry.workspace.taskThinkingLevel != null
          ? { thinkingLevel: childEntry.workspace.taskThinkingLevel }
          : {}),
        ...(report.structuredOutput !== undefined
          ? { structuredOutput: report.structuredOutput }
          : {}),
      });
      // A progress report is itself the wake-up message. Unlike terminal attention, it must be
      // allowed through while this child is still active so review findings and other incremental
      // results can immediately background a foreground wait or queue behind a busy parent turn.
      // The key is scoped to the active continuation execution (when any) so that execution's
      // terminal settlement drops exactly the updates it superseded.
      const dedupePrefix = agentReportProgressDedupePrefix(
        childWorkspaceId,
        activeExecution?.handleId
      );
      // Superseded once this run is over: the settlement paths persist the child's status mirror
      // (`reported`/`interrupted`, or a terminal execution status for a continuation) BEFORE they
      // remove queued updates, so an entry already dequeued into the parent's asynchronous
      // PREPARING phase — invisible to that removal — is refused at admission instead of starting
      // a stale "in progress" turn after the terminal outcome. Synchronous reads only: admission
      // probes run inside the session's turn gates. As with peer sends, a probe-carrying send
      // never resurrects an interrupted parent.
      const superseded = (): boolean => {
        const fresh = findWorkspaceEntry(this.config.loadConfigOrDefault(), childWorkspaceId);
        if (fresh == null) {
          return true;
        }
        if (activeExecution != null) {
          // A successor generation claims the mirror only once this execution stopped being the
          // live registration, and clearing it is part of this execution's own teardown — either
          // way the update belongs to a finished generation.
          return (
            fresh.workspace.taskExecutionId !== activeExecution.handleId ||
            !isActiveWorkspaceTurnTaskStatus(fresh.workspace.taskExecutionStatus)
          );
        }
        return (
          hasCompletedAgentReport(fresh.workspace) || fresh.workspace.taskStatus === "interrupted"
        );
      };
      // A stop or settlement can land between the status checks above and here (neither shares
      // this child's event lock), and the mirror is written at continuation acceptance, before
      // the child's turn can call agent_report — so a probe that is already true means the run
      // is over. Refuse now rather than wake the parent with an obsolete update.
      if (superseded()) {
        throw new Error("agent_report cannot send updates after the sub-agent's run has ended");
      }
      const wakeResult = await this.wakeParentWorkspaceWithSyntheticMessage({
        parentWorkspaceId,
        parentEntry,
        content: reportContent,
        queueDedupeKey: `${dedupePrefix}${toolCallId}`,
        // Reports are agent messages too (#4737): a parent that holds agent messages until its
        // turn ends gets this update at turn end instead of being cut at the next step.
        resolveRecipientHold: true,
        // Only the queue head's dispatch mode can cut the parent's stream. A child's earlier
        // ancestor-bound peer message (turn-end by default) at the head would otherwise hold this
        // report until the parent's turn ends — observed as 8–40 minute "delayed" updates.
        promoteAheadOfHiddenTurnEnd: true,
        admissionStale: superseded,
      });
      if (!wakeResult.success) {
        throw new Error(`agent_report failed to wake the parent workspace: ${wakeResult.error}`);
      }
    });
  }

  /**
   * Wake a parent workspace with a synthetic child-originated message. Shared by
   * agent_report progress updates and RLM family messaging (task_message_parent).
   * The message travels through the parent's normal send/queue mechanics, so it is
   * durably logged like any user turn, coalesces behind a busy parent stream, and
   * carries workspace-turn continuation metadata when the parent itself runs as a
   * delegated workspace turn.
   */
  private async wakeParentWorkspaceWithSyntheticMessage(params: {
    parentWorkspaceId: string;
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      };
    };
    content: string;
    /** Coalesces repeated wakes for the same source (e.g. one agent_report tool call). */
    queueDedupeKey?: string;
    /** Queue ahead of hidden turn-end predecessors (see SendMessageInternalOptions). */
    promoteAheadOfHiddenTurnEnd?: boolean;
    /**
     * Synchronous "this wake has been superseded" probe, re-checked at the parent's turn-admission
     * gates (even after the entry left the queue for PREPARING). A stale wake is refused rather
     * than dispatched, and never settles the parent's own workspace turn as failed.
     */
    admissionStale?: () => boolean;
    /**
     * Opportunistic wakes (see cutBusyOwnerTurnForSubagentAttention) pass false: a send refused
     * before anything was queued never cut the parent's live stream, so the delegated turn is
     * intact and must not be settled as failed. Cancellation or a pre-stream failure after the
     * entry was queued still settles, because a queued tool-end entry may already have ended it.
     */
    settleContinuationOnSendRefusal?: boolean;
    /** See SendMessageInternalOptions.yieldToPreflightSends. */
    yieldToPreflightSends?: boolean;
    /** Caller restrictions restored onto the wake's turn (see resolveTerminalWakeCallerSendRestrictions). */
    sendRestrictions?: {
      toolPolicy?: ToolPolicy;
      disableWorkspaceAgents?: boolean;
      strictAgentResolution?: SendMessageOptions["strictAgentResolution"];
    };
    queueDispatchMode?: TaskMessageQueueDispatchMode;
    /**
     * Apply the parent's agent-message hold preference to queueDispatchMode, read after this
     * helper's awaits so a preference acknowledged meanwhile still applies, and again at the
     * send's enqueue point (#4804).
     */
    resolveRecipientHold?: boolean;
    /** Synthetic assistant rows persisted just before the wake's user row (family payloads). */
    preTurnMessages?: MuxMessage[];
    /** Invoked once the wake turn is durably accepted. */
    onAccepted?: () => void;
  }): Promise<Result<void, string>> {
    assert(params.parentWorkspaceId.length > 0, "wakeParentWorkspace: parent ID required");
    assert(params.content.length > 0, "wakeParentWorkspace: content required");
    const { parentWorkspaceId } = params;
    const resumeOptions = await this.resolveParentAutoResumeOptions(
      parentWorkspaceId,
      params.parentEntry,
      defaultModel
    );
    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        parentWorkspaceId
      );
    // When the parent itself runs as a delegated workspace turn, this wake continues that turn,
    // so a canceled/failed send normally settles the turn as failed. A wake whose source has been
    // superseded (params.admissionStale, e.g. a sub-agent progress report outrun by the child's
    // terminal outcome) is the exception: the parent's live turn is intact and the terminal
    // delivery is its next wake, so refusing or dropping the stale wake must not interrupt it.
    const settleContinuationFailure = async (
      status: "interrupted" | "error",
      message: string
    ): Promise<void> => {
      if (workspaceTurnMuxMetadata == null) {
        return;
      }
      if (params.admissionStale?.() === true) {
        log.debug("Superseded parent wake dropped without settling the parent's workspace turn", {
          parentWorkspaceId,
          status,
          message,
        });
        return;
      }
      await this.getWorkspaceTurnManager().settleWorkspaceTurnContinuationFailure(
        parentWorkspaceId,
        workspaceTurnMuxMetadata,
        status,
        message
      );
    };

    const queueDispatchMode =
      params.resolveRecipientHold === true
        ? this.resolveRecipientDispatchMode(parentWorkspaceId, params.queueDispatchMode)
        : params.queueDispatchMode;
    const sendResult = await this.workspaceService.sendMessage(
      parentWorkspaceId,
      params.content,
      {
        model: resumeOptions.model,
        agentId: resumeOptions.agentId,
        thinkingLevel: resumeOptions.thinkingLevel,
        reasoningMode: resumeOptions.reasoningMode,
        serviceTier: resumeOptions.serviceTier,
        ...(queueDispatchMode != null ? { queueDispatchMode } : {}),
        ...(params.sendRestrictions?.toolPolicy != null
          ? { toolPolicy: params.sendRestrictions.toolPolicy }
          : {}),
        ...(params.sendRestrictions?.disableWorkspaceAgents === true
          ? { disableWorkspaceAgents: true }
          : {}),
        ...(params.sendRestrictions?.strictAgentResolution != null
          ? { strictAgentResolution: params.sendRestrictions.strictAgentResolution }
          : {}),
        ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
      },
      {
        acceptanceOrigin: "automatic",
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        startStreamInBackground: true,
        workspaceTurnContinuation: workspaceTurnMuxMetadata != null,
        ...(params.resolveRecipientHold === true ? { honorRecipientHold: true } : {}),
        ...(params.preTurnMessages != null ? { preTurnMessages: params.preTurnMessages } : {}),
        ...(params.onAccepted != null ? { onAccepted: params.onAccepted } : {}),
        ...(params.queueDedupeKey != null
          ? { queueDedupeKey: params.queueDedupeKey, removableQueueDedupeKey: true }
          : {}),
        ...(params.promoteAheadOfHiddenTurnEnd === true
          ? { promoteAheadOfHiddenTurnEnd: true }
          : {}),
        ...(params.yieldToPreflightSends === true ? { yieldToPreflightSends: true } : {}),
        ...(params.admissionStale != null ? { admissionStale: params.admissionStale } : {}),
        // Caller restrictions and admission probes cannot survive a deferral into a durable
        // compaction follow-up (#4721), so such wakes skip on-send compaction.
        ...(params.sendRestrictions != null || params.admissionStale != null
          ? { skipOnSendCompaction: true }
          : {}),
        ...(workspaceTurnMuxMetadata != null
          ? {
              onCanceled: async (reason: string) => {
                await settleContinuationFailure("interrupted", reason);
              },
              onAcceptedPreStreamFailure: async (error: SendMessageError) => {
                await settleContinuationFailure("error", formatSendMessageError(error).message);
              },
            }
          : {}),
      }
    );
    if (!sendResult.success) {
      const formattedError = formatSendMessageError(sendResult.error);
      if (params.settleContinuationOnSendRefusal !== false) {
        await settleContinuationFailure("error", formattedError.message);
      }
      return Err(formattedError.message);
    }
    return Ok(undefined);
  }

  /**
   * Child -> parent family message (RLM family messaging, task_message_parent).
   *
   * Appends a clearly-labeled child message into the PARENT workspace's queue using
   * the same synthetic send/queue mechanics task_send_message uses toward children.
   * Loop safety: the message coalesces in the parent's existing queue and creates no
   * automatic reply obligation or delivery receipt — agent_report remains the
   * terminal/progress reporting channel.
   */
  async sendMessageToParentFromAgentTask(
    childWorkspaceId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode
  ): Promise<Result<SendParentAgentMessageResult, SendParentAgentMessageError>> {
    assert(
      childWorkspaceId.length > 0,
      "sendMessageToParentFromAgentTask: childWorkspaceId must be non-empty"
    );
    return this.sendTreeMessage({
      relation: "parent-family",
      senderWorkspaceId: childWorkspaceId,
      message,
      queueDispatchMode,
    });
  }

  /**
   * Sibling -> sibling family message (RLM family messaging, task_message_sibling).
   *
   * NUCLEAR-FAMILY SCOPING: the target must share the sender's DIRECT parent —
   * exactly one hop up plus one hop down. Grandparents, grandchildren, uncles, and
   * unrelated tasks are refused with invalid_scope. Restricting messaging to the
   * nuclear family keeps the parent the coordination hub and prevents global-mailbox
   * chaos across the task tree.
   */
  async sendMessageToSiblingAgentTask(
    senderWorkspaceId: string,
    targetTaskId: string,
    message: string,
    queueDispatchMode: TaskMessageQueueDispatchMode
  ): Promise<Result<SendAgentTaskMessageResult, SendAgentTaskMessageError>> {
    assert(
      senderWorkspaceId.length > 0,
      "sendMessageToSiblingAgentTask: senderWorkspaceId must be non-empty"
    );
    assert(
      targetTaskId.length > 0,
      "sendMessageToSiblingAgentTask: targetTaskId must be non-empty"
    );
    return this.sendTreeMessage({
      relation: "sibling-family",
      senderWorkspaceId,
      targetId: targetTaskId,
      message,
      queueDispatchMode,
    });
  }

  async requestAgentFinalReportForTimeout(
    taskId: string,
    options: {
      workflowRunId: string;
      stepId: string;
      inputHash: string;
      finalizationToken: string;
      finalInstructions?: string;
    }
  ): Promise<"prompted" | "queued" | "already_reported" | "not_active"> {
    assert(taskId.length > 0, "requestAgentFinalReportForTimeout: taskId must be non-empty");
    assert(
      options.finalizationToken.length > 0,
      "requestAgentFinalReportForTimeout: finalizationToken must be non-empty"
    );

    const reservation = await this.workspaceEventLocks.withLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return { status: "not_active" as const };
      }
      if (hasCompletedAgentReport(entry.workspace) || this.waiters.hasCompletedReport(taskId)) {
        return { status: "already_reported" as const };
      }
      if (entry.workspace.taskStatus === "interrupted" && !this.aiService.isStreaming(taskId)) {
        return { status: "not_active" as const };
      }

      const tokens = entry.workspace.taskTimeoutFinalizationTokens ?? [];
      const alreadyPrompted = tokens.includes(options.finalizationToken);
      if (!alreadyPrompted) {
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            workspace.taskStatus = "awaiting_report";
          },
          { allowMissing: true }
        );
      }
      return { status: "reserved" as const, alreadyPrompted };
    });

    if (reservation.status !== "reserved") {
      return reservation.status;
    }
    if (reservation.alreadyPrompted) {
      return "prompted";
    }
    if (this.aiService.isStreaming(taskId)) {
      await this.aiService.stopStream(taskId, {
        soft: true,
        abandonPartial: false,
        abortReason: "system",
      });
    }

    const freshConfig = this.config.loadConfigOrDefault();
    const freshEntry = findWorkspaceEntry(freshConfig, taskId);
    if (!freshEntry?.workspace.parentWorkspaceId) {
      return "not_active";
    }
    if (hasCompletedAgentReport(freshEntry.workspace) || this.waiters.hasCompletedReport(taskId)) {
      return "already_reported";
    }
    let finalizationAccepted = false;
    const persistFinalizationToken = async (): Promise<void> => {
      await this.workspaceEventLocks.withLock(taskId, async () => {
        const cfg = this.config.loadConfigOrDefault();
        const entry = findWorkspaceEntry(cfg, taskId);
        if (!entry?.workspace.parentWorkspaceId) {
          return;
        }
        if (hasCompletedAgentReport(entry.workspace) || this.waiters.hasCompletedReport(taskId)) {
          return;
        }
        await this.editActiveWorkspaceEntry(
          taskId,
          (workspace) => {
            const existing = workspace.taskTimeoutFinalizationTokens ?? [];
            workspace.taskTimeoutFinalizationTokens = Array.from(
              new Set([...existing, options.finalizationToken])
            );
            workspace.taskStatus = "awaiting_report";
          },
          { allowMissing: true }
        );
      });
      finalizationAccepted = true;
    };
    const completionKind = (await this.isPlanLikeTaskWorkspace(freshEntry))
      ? "propose_plan"
      : "final_response";
    const requiresStructuredOutput =
      freshEntry.workspace.workflowTask?.outputSchema !== undefined &&
      !(await this.shouldAllowLegacyInvalidWorkflowOutputSchema(taskId, freshEntry));
    const model = freshEntry.workspace.taskModelString ?? defaultModel;
    const agentId = resolveTaskAgentIdForResume(freshEntry.workspace);
    // Admission classification: timeout finalization continues the same attempt (no rotation).
    const sendResult = await this.workspaceService.sendMessage(
      taskId,
      buildWorkflowTimeoutFinalizationPrompt(
        options.finalInstructions,
        completionKind,
        requiresStructuredOutput
      ),
      {
        model,
        agentId,
        thinkingLevel: freshEntry.workspace.taskThinkingLevel,
        reasoningMode: coerceOpenAIReasoningMode(freshEntry.workspace.aiSettings?.reasoningMode),
        serviceTier: ServiceTierSchema.safeParse(
          resolveWorkspaceAISettings(freshEntry.workspace, agentId)?.serviceTier
        ).data,
        ...(completionKind === "propose_plan"
          ? { toolPolicy: [{ regex_match: "^propose_plan$", action: "require" as const }] }
          : {}),
        // Never cut the child's live turn (the soft stop above already ends it at a boundary).
        queueDispatchMode: "turn-end",
      },
      {
        acceptanceOrigin: "automatic",
        synthetic: true,
        agentInitiated: true,
        // An automatic report prompt: it must not be able to create or replace a child goal.
        taskTurnKind: "required_report",
        startStreamInBackground: true,
        queueDedupeKey: taskRecoveryPromptDedupeKey(taskId, "timeout-finalization"),
        removableQueueDedupeKey: true,
        onAccepted: persistFinalizationToken,
        onCanceled: (reason) => {
          log.debug("Workflow timeout finalization prompt was canceled", {
            taskId,
            workflowRunId: options.workflowRunId,
            stepId: options.stepId,
            reason,
          });
        },
      }
    );
    if (!sendResult.success) {
      log.error("Failed to prompt workflow task for timeout final report", {
        taskId,
        workflowRunId: options.workflowRunId,
        stepId: options.stepId,
        error: sendResult.error,
      });
      return "not_active";
    }

    return finalizationAccepted ? "prompted" : "queued";
  }

  async failAgentTaskForHardTimeout(
    taskId: string,
    options: { workflowRunId: string; stepId: string; inputHash: string; reason: string }
  ): Promise<void> {
    assert(taskId.length > 0, "failAgentTaskForHardTimeout: taskId must be non-empty");
    assert(options.reason.length > 0, "failAgentTaskForHardTimeout: reason must be non-empty");

    await this.workspaceEventLocks.withLock(taskId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return;
      }
      if (hasCompletedAgentReport(entry.workspace) || this.waiters.hasCompletedReport(taskId)) {
        return;
      }
      try {
        const clearQueueResult = this.workspaceService.clearQueue(taskId);
        if (!clearQueueResult.success) {
          log.debug("failAgentTaskForHardTimeout: clearQueue failed", {
            taskId,
            error: clearQueueResult.error,
          });
        }
      } catch (error: unknown) {
        log.debug("failAgentTaskForHardTimeout: clearQueue threw", { taskId, error });
      }
      try {
        await this.aiService.stopStream(taskId, {
          abandonPartial: true,
          abortReason: "system",
        });
      } catch (error: unknown) {
        log.debug("failAgentTaskForHardTimeout: stopStream threw", { taskId, error });
      }
      await this.terminateAllDescendantAgentTasks(taskId, { workflowRunId: options.workflowRunId });
      await this.failAgentTaskTerminally(
        taskId,
        entry,
        { errorType: "workflow_agent_timeout", errorMessage: options.reason },
        // Timer/parent-driven: ends whatever runs under the task now, not one captured attempt.
        { expectedAttemptId: null }
      );
    });
  }

  async waitForAgentReport(
    taskId: string,
    options?: AgentReportWaitOptions
  ): Promise<AgentTaskReport> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    // Report monotonicity invariant: check the in-memory cache before any status-based
    // interruption handling so a finalized report stays awaitable once observed.
    const cached = this.waiters.getCompletedReport(taskId);
    if (cached) {
      return toAgentTaskReport(cached);
    }

    const request = buildReportWaitRequest(taskId, options);
    if (request.requestingWorkspaceId) {
      // A renewed foreground wait means this task is blocking again unless re-backgrounded later.
      this.markTaskForegroundRelevant(taskId);
    }

    return await this.waitForUncachedAgentReport(request);
  }

  /**
   * The wait once no report is cached. Sync up to the step it returns, so a task that is not
   * interrupted registers its waiter in the caller's own tick (see maybeStartQueuedTasks).
   */
  private waitForUncachedAgentReport(request: ReportWaitRequest): Promise<AgentTaskReport> {
    // Fast-path: if the task is already gone (cleanup) or already reported (restart), return the
    // persisted artifact from the requesting workspace session dir.
    const cfg = this.config.loadConfigOrDefault();
    const taskWorkspaceEntry = findWorkspaceEntry(cfg, request.taskId);
    const taskStatus = taskWorkspaceEntry?.workspace.taskStatus;

    if (!taskWorkspaceEntry || taskStatus === "reported") {
      return this.readSettledAgentReport(request);
    }

    if (taskStatus === "interrupted") {
      return this.waitForInterruptedAgentReport(request, taskWorkspaceEntry);
    }

    return this.awaitPendingAgentReport(request);
  }

  /** A gone or reported task: its persisted report, else its persisted failure, else not found. */
  private async readSettledAgentReport(request: ReportWaitRequest): Promise<AgentTaskReport> {
    const persisted = await this.readPersistedReportForWait(
      request.taskId,
      request.requestingWorkspaceId
    );
    if (persisted) {
      return persisted;
    }

    const persistedFailure = await this.readPersistedFailureForWait(request);
    if (persistedFailure) {
      throw persistedFailure;
    }

    throw new Error("Task not found");
  }

  /** An interrupted task: its persisted report, else a wait while its stream still runs. */
  private async waitForInterruptedAgentReport(
    request: ReportWaitRequest,
    taskWorkspaceEntry: { projectPath: string; workspace: WorkspaceConfigEntry }
  ): Promise<AgentTaskReport> {
    const persisted = await this.readPersistedReportForWait(
      request.taskId,
      request.requestingWorkspaceId
    );
    if (persisted) {
      return persisted;
    }

    // Report monotonicity: interrupted tasks can still be streaming while stream-end
    // finalization persists agent_report. Waiters should keep waiting in that window.
    if (!this.aiService.isStreaming(request.taskId)) {
      throw new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted");
    }

    return await this.awaitPendingAgentReport(request);
  }

  /**
   * The promise of a pending wait. Its executor starts the wait's setup without waiting for it,
   * and a setup that rejects rejects the wait with an Error.
   */
  private awaitPendingAgentReport(request: ReportWaitRequest): Promise<AgentTaskReport> {
    return new Promise<AgentTaskReport>((resolve, reject) => {
      void this.startPendingReportWait(request, { resolve, reject }).catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /**
   * A pending wait's setup: re-reads the row, then settles a gone or reported task, re-checks an
   * interrupted one, or registers the waiter.
   */
  private async startPendingReportWait(
    request: ReportWaitRequest,
    settle: ReportWaitSettle
  ): Promise<void> {
    // Validate existence early to avoid waiting on never-resolving task IDs.
    const cfg = this.config.loadConfigOrDefault();
    const taskWorkspaceEntry = findWorkspaceEntry(cfg, request.taskId);
    if (!taskWorkspaceEntry || taskWorkspaceEntry.workspace.taskStatus === "reported") {
      return await this.settleGoneReportWait(request, settle);
    }

    if (taskWorkspaceEntry.workspace.taskStatus === "interrupted") {
      return await this.continueInterruptedReportWait(request, settle, taskWorkspaceEntry);
    }

    return await this.registerPendingReportWaiter(request, settle, taskWorkspaceEntry);
  }

  /** The row is gone or reported: settle with its persisted report, else its failure. */
  private async settleGoneReportWait(
    request: ReportWaitRequest,
    settle: ReportWaitSettle
  ): Promise<void> {
    const persisted = await this.readPersistedReportForWait(
      request.taskId,
      request.requestingWorkspaceId
    );
    if (persisted) {
      settle.resolve(persisted);
      return;
    }

    const persistedFailure = await this.readPersistedFailureForWait(request);
    settle.reject(persistedFailure ?? new Error("Task not found"));
  }

  /** The row is still interrupted: settle with its persisted report, else wait while it streams. */
  private async continueInterruptedReportWait(
    request: ReportWaitRequest,
    settle: ReportWaitSettle,
    taskWorkspaceEntry: { projectPath: string; workspace: WorkspaceConfigEntry }
  ): Promise<void> {
    const persisted = await this.readPersistedReportForWait(
      request.taskId,
      request.requestingWorkspaceId
    );
    if (persisted) {
      settle.resolve(persisted);
      return;
    }

    // Report monotonicity: an interrupted task may still be in stream-end teardown,
    // so keep the waiter alive while the stream is active.
    if (!this.aiService.isStreaming(request.taskId)) {
      settle.reject(new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted"));
      return;
    }

    return await this.registerPendingReportWaiter(request, settle, taskWorkspaceEntry);
  }

  /**
   * Registers the wait with no await before the registration: the foreground await, the waiter and
   * its backgroundable registration. Then reads the report once more, and arms the rest unless that
   * read found it.
   */
  private async registerPendingReportWaiter(
    request: ReportWaitRequest,
    settle: ReportWaitSettle,
    taskWorkspaceEntry: { projectPath: string; workspace: WorkspaceConfigEntry }
  ): Promise<void> {
    const session: ReportWaitSession = {
      request,
      settle,
      timeout: null,
      startWaiter: null,
      abortListener: null,
      stopBlockingRequester: request.requestingWorkspaceId
        ? this.startForegroundAwait(request.requestingWorkspaceId)
        : null,
      executionStartNotified: false,
      // The waiter's closures run after this literal, so they can name `session`.
      waiter: {
        taskId: request.taskId,
        requestingWorkspaceId: undefined,
        backgroundOnMessageQueued: false,
        resolve: (report) => {
          session.waiter.cleanup();
          settle.resolve(report);
        },
        reject: (error) => {
          session.waiter.cleanup();
          settle.reject(error);
        },
        cleanup: () => this.cleanupPendingReportWaiter(session),
      },
    };
    const shouldBackgroundOnQueuedMessage = this.addPendingReportWaiter(session);

    // The read can throw (e.g. adopting the report fails to write config). The waiter, its
    // backgroundable registration and the foreground-await count are live by now: release
    // them before the outer catch rejects (cleanup, then settle, like waiter.reject). Else the
    // requester stays foreground-awaiting, so it charges no maxParallelAgentTasks slot, and a
    // dead waiter stays registered.
    const persistedAfterRegister = await this.readPersistedReportForWait(
      request.taskId,
      request.requestingWorkspaceId
    ).catch((error: unknown) => {
      session.waiter.cleanup();
      throw error;
    });
    if (persistedAfterRegister) {
      session.waiter.resolve(persistedAfterRegister);
      return;
    }

    this.armPendingReportWaiter(
      session,
      taskWorkspaceEntry.workspace.taskStatus,
      shouldBackgroundOnQueuedMessage
    );
  }

  /**
   * Adds the session's waiter to the store, then registers it as backgroundable when a queued
   * message may background it. Returns whether it may.
   */
  private addPendingReportWaiter(session: ReportWaitSession): boolean {
    const { waiter } = session;
    const { taskId, options, requestingWorkspaceId } = session.request;
    this.waiters.addPendingWaiter(taskId, waiter);

    const shouldBackgroundOnQueuedMessage = Boolean(
      requestingWorkspaceId && (options?.backgroundOnMessageQueued ?? true)
    );
    waiter.requestingWorkspaceId = requestingWorkspaceId;
    waiter.backgroundOnMessageQueued = shouldBackgroundOnQueuedMessage;

    if (shouldBackgroundOnQueuedMessage && requestingWorkspaceId) {
      this.registerBackgroundableForegroundWaiter(requestingWorkspaceId, waiter);
    }
    return shouldBackgroundOnQueuedMessage;
  }

  /**
   * The waiter's cleanup: releases everything the wait holds (backgroundable registration,
   * waiter, start waiter, report timer, abort listener, foreground await).
   */
  private cleanupPendingReportWaiter(session: ReportWaitSession): void {
    const { waiter } = session;
    const { taskId, options } = session.request;
    if (waiter.requestingWorkspaceId && waiter.backgroundOnMessageQueued) {
      this.unregisterBackgroundableForegroundWaiter(waiter.requestingWorkspaceId, waiter);
    }

    this.waiters.removePendingWaiter(taskId, waiter);

    this.cleanupReportWaitStartWaiter(session);

    if (session.timeout) {
      clearTimeout(session.timeout);
      session.timeout = null;
    }

    if (session.abortListener && options?.abortSignal) {
      options.abortSignal.removeEventListener("abort", session.abortListener);
      session.abortListener = null;
    }

    if (session.stopBlockingRequester) {
      try {
        session.stopBlockingRequester();
      } finally {
        session.stopBlockingRequester = null;
      }
    }
  }

  /**
   * The rest of a wait's setup once the read after registration found no report: arms the report
   * timer (or a start waiter), queues the completion prompt of an awaiting_report task, listens
   * for the abort, then backgrounds the wait if a message is already queued.
   */
  private armPendingReportWaiter(
    session: ReportWaitSession,
    initialStatus: WorkspaceConfigEntry["taskStatus"],
    shouldBackgroundOnQueuedMessage: boolean
  ): void {
    // Don't start the execution timeout while the task is still queued/starting.
    // The timer starts once the child actually begins running (queued/starting -> running).
    if (initialStatus === "queued" || initialStatus === "starting") {
      this.armQueuedReportWaitStart(session);
    } else {
      this.startReportWaitTimeout(session);
    }

    if (initialStatus === "awaiting_report") {
      this.promptAwaitingReportTaskForWaiter(session.request.taskId);
    }
    if (this.listenForReportWaitAbort(session) === "aborted") {
      return;
    }

    this.backgroundForegroundWaitIfQueued(
      shouldBackgroundOnQueuedMessage,
      session.request.requestingWorkspaceId
    );
  }

  /** A queued or starting task's wait: a start waiter arms the report timer once the task runs. */
  private armQueuedReportWaitStart(session: ReportWaitSession): void {
    const { taskId, requestingWorkspaceId } = session.request;
    const startWaiterEntry: PendingTaskStartWaiter = {
      start: () => this.startReportWaitTimeout(session),
      cleanup: () => {
        this.waiters.removePendingStartWaiter(taskId, startWaiterEntry);
      },
    };
    session.startWaiter = startWaiterEntry;

    this.waiters.addPendingStartWaiter(taskId, startWaiterEntry);

    // Close the race where the task starts between the initial config read and registering the waiter.
    // A launch whose failure could not be written never starts: arm the timeout now (#4747).
    const cfgAfterRegister = this.config.loadConfigOrDefault();
    const afterEntry = findWorkspaceEntry(cfgAfterRegister, taskId);
    if (
      (afterEntry?.workspace.taskStatus !== "queued" &&
        afterEntry?.workspace.taskStatus !== "starting") ||
      this.waiters.isLaunchFailureUnpersisted(taskId)
    ) {
      this.cleanupReportWaitStartWaiter(session);
      this.startReportWaitTimeout(session);
    }

    // If the awaited task is queued and the caller is blocked in the foreground, ensure the
    // scheduler runs after the waiter is registered. This avoids deadlocks when
    // maxParallelAgentTasks is low.
    if (requestingWorkspaceId) {
      this.scheduleMaybeStartQueuedTasks();
    }
  }

  /** Removes the wait's start waiter, if it still has one. */
  private cleanupReportWaitStartWaiter(session: ReportWaitSession): void {
    if (!session.startWaiter) return;
    session.startWaiter.cleanup();
    session.startWaiter = null;
  }

  /** Arms the wait's report timer once the task runs, and reports that start to the caller. */
  private startReportWaitTimeout(session: ReportWaitSession): void {
    if (session.timeout) return;
    this.notifyReportWaitExecutionStarted(session);
    session.timeout = setTimeout(() => {
      // Prefer a persisted terminal failure over a generic timeout so late
      // awaits surface the typed failure (e.g. model_refusal) even when the
      // live rejection was missed (restart/cleanup windows).
      void (async () => {
        const persistedFailure = await this.readPersistedFailureForWait(session.request).catch(
          () => null
        );
        session.waiter.cleanup();
        session.settle.reject(persistedFailure ?? new AgentReportWaitTimeoutError());
      })();
    }, session.request.timeoutMs);
  }

  /** Calls the caller's onExecutionStarted once per wait, without waiting for it. */
  private notifyReportWaitExecutionStarted(session: ReportWaitSession): void {
    if (session.executionStartNotified) return;
    session.executionStartNotified = true;
    const { taskId, options } = session.request;
    void Promise.resolve(options?.onExecutionStarted?.()).catch((error: unknown) => {
      log.error("waitForAgentReport execution-start callback failed", { taskId, error });
    });
  }

  /** Queues the completion prompt of an awaiting_report task on its event lock, never awaited. */
  private promptAwaitingReportTaskForWaiter(taskId: string): void {
    // Reuse the standard completion reminder when a waiter attaches instead of carrying a
    // separate waiter-only recovery mode and prompt string.
    void this.workspaceEventLocks
      .withLock(taskId, async () => {
        // A waiter attaching decides for whatever attempt runs now: no captured attempt.
        await this.promptTaskForRequiredCompletionTool(taskId, { expectedAttemptId: null });
      })
      .catch((error: unknown) => {
        log.error("Failed to resume awaiting_report task for waiter", {
          taskId,
          error,
        });
      });
  }

  /**
   * An already-aborted signal ends the wait now ("aborted"). A live one gets a listener that ends
   * the wait when it aborts ("pending").
   */
  private listenForReportWaitAbort(session: ReportWaitSession): "aborted" | "pending" {
    const { options } = session.request;
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        session.waiter.cleanup();
        session.settle.reject(new Error("Interrupted"));
        return "aborted";
      }

      session.abortListener = () => {
        session.waiter.cleanup();
        session.settle.reject(new Error("Interrupted"));
      };
      options.abortSignal.addEventListener("abort", session.abortListener, { once: true });
    }
    return "pending";
  }

  getAgentTaskExecutionId(taskId: string): string | null {
    assert(taskId.length > 0, "getAgentTaskExecutionId: taskId must be non-empty");
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    return entry?.workspace.taskExecutionId ?? null;
  }

  async getDescendantAgentTaskExecutionSnapshot(
    ancestorWorkspaceId: string,
    taskId: string,
    options: { consumingWorkspaceId?: string } = {}
  ): Promise<{
    ownerWorkspaceId: string;
    record: WorkspaceTurnTaskHandleRecord;
  } | null> {
    assert(
      ancestorWorkspaceId.length > 0,
      "getDescendantAgentTaskExecutionSnapshot: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "getDescendantAgentTaskExecutionSnapshot: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    if (!this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)) {
      return null;
    }

    const executionTaskId = index.byId.get(taskId)?.taskExecutionId;
    if (!isWorkspaceTurnTaskId(executionTaskId)) {
      return null;
    }

    // A continuation is owned by whichever ancestor reawakened the child, not necessarily by the
    // ancestor currently listing or awaiting it. Search the child's ancestry, then return the
    // actual owner so subsequent reads and terminal-attention updates use the correct session.
    for (const ownerWorkspaceId of this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    )) {
      const record = await this.getWorkspaceTurnManager().getWorkspaceTurnSnapshot(
        ownerWorkspaceId,
        executionTaskId,
        options
      );
      if (record?.workspaceId === taskId) {
        return { ownerWorkspaceId, record };
      }
    }

    return null;
  }

  private hasLiveRunningExecution(workspace: WorkspaceConfigEntry, workspaceId: string): boolean {
    // A persisted running mirror can outlive its handle after a crash.
    // Require a matching accepted registration to exclude stale mirrors and unaccepted reservations.
    const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(workspaceId);
    return (
      workspace.taskExecutionStatus === "running" &&
      workspace.taskExecutionId != null &&
      live != null &&
      live.handleId === workspace.taskExecutionId &&
      live.accepted
    );
  }

  hasLiveAgentTaskContinuation(workspaceId: string): boolean {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    return entry != null && this.hasLiveRunningExecution(entry.workspace, workspaceId);
  }

  getAgentTaskStatus(taskId: string): AgentTaskStatus | null {
    assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    const status = entry?.workspace.taskStatus;
    return status ?? null;
  }

  getAgentTaskTimestamps(taskId: string): AgentTaskTimestamps | null {
    assert(taskId.length > 0, "getAgentTaskTimestamps: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    if (!entry) {
      return null;
    }

    return {
      createdAt: entry.workspace.createdAt,
      reportedAt: entry.workspace.reportedAt,
    };
  }

  getAgentTaskStatuses(taskIds: string[]): Map<string, AgentTaskStatusLookup> {
    for (const taskId of taskIds) {
      assert(taskId.length > 0, "getAgentTaskStatuses: taskId must be non-empty");
    }

    if (taskIds.length === 0) {
      return new Map<string, AgentTaskStatusLookup>();
    }

    const cfg = this.config.loadConfigOrDefault();
    const statuses = new Map<string, AgentTaskStatusLookup>();

    for (const taskId of taskIds) {
      const entry = findWorkspaceEntry(cfg, taskId);
      statuses.set(taskId, {
        exists: entry != null,
        taskStatus: entry?.workspace.taskStatus ?? null,
      });
    }

    return statuses;
  }

  hasDescendantAgentTasks(workspaceId: string): boolean {
    assert(workspaceId.length > 0, "hasDescendantAgentTasks: workspaceId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    return this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).length > 0;
  }

  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksForWorkspace: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    return this.hasActiveDescendantAgentTasks(cfg, workspaceId);
  }

  listActiveDescendantAgentTaskIds(
    workspaceId: string,
    options: { excludeWorkflowTasks?: boolean } = {}
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listActiveDescendantAgentTaskIds: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const result: string[] = [];
    const stack: Array<{ taskId: string; workflowOwned: boolean }> = [
      ...(index.childrenByParent.get(workspaceId) ?? []).map((taskId) => ({
        taskId,
        workflowOwned: false,
      })),
    ];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      const workflowOwned = next.workflowOwned || entry?.workflowTask != null;
      if (
        entry != null &&
        this.isActiveAgentTaskEntry(entry) &&
        !(options.excludeWorkflowTasks && workflowOwned)
      ) {
        result.push(next.taskId);
      }
      const children = index.childrenByParent.get(next.taskId);
      if (children) {
        for (const child of children) {
          stack.push({ taskId: child, workflowOwned });
        }
      }
    }
    return result;
  }

  private async unarchiveAgentTaskAncestry(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<Result<boolean, string>> {
    const config = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(config);
    const chain: string[] = [];
    let currentWorkspaceId: string | undefined = taskId;
    for (let depth = 0; currentWorkspaceId != null && depth < 32; depth++) {
      chain.push(currentWorkspaceId);
      if (currentWorkspaceId === ownerWorkspaceId) break;
      currentWorkspaceId = index.parentById.get(currentWorkspaceId);
    }
    if (chain.at(-1) !== ownerWorkspaceId) {
      return Err("Task is not a descendant of this workspace");
    }

    // A child cannot appear in the active workspace tree while an ancestor remains archived.
    // Restore root-to-leaf so every intermediate parent is visible before its child.
    let didUnarchive = false;
    chain.reverse();
    for (const workspaceId of chain) {
      const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
      if (
        entry == null ||
        !isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      ) {
        continue;
      }
      didUnarchive = true;
      // WhileTaskTreeLocked: callers run under the send path's task-tree lock for this same
      // tree (ancestors share the root), so the plain unarchive() wrapper would self-deadlock.
      const result = await this.workspaceService.unarchiveWhileTaskTreeLocked(workspaceId);
      if (!result.success) {
        return Err(result.error);
      }
    }
    return Ok(didUnarchive);
  }

  async removeInactiveDescendantAgentTask(
    ownerWorkspaceId: string,
    taskId: string,
    options?: SubagentRemovalOptions
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    assert(ownerWorkspaceId.length > 0, "removeInactiveDescendantAgentTask requires owner");
    assert(taskId.length > 0, "removeInactiveDescendantAgentTask requires taskId");

    return await this.withTaskTreeLifecycleLock(taskId, () =>
      this.removeInactiveDescendantAgentTaskWhileTaskTreeLocked(ownerWorkspaceId, taskId, options)
    );
  }

  private async removeInactiveDescendantAgentTaskWhileTaskTreeLocked(
    ownerWorkspaceId: string,
    taskId: string,
    options?: SubagentRemovalOptions
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    const config = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(config, taskId);
    if (entry == null) {
      return await this.reportMissingRemovalTarget(ownerWorkspaceId, taskId);
    }

    const index = this.buildAgentTaskIndex(config);
    if (!this.isDescendantAgentTaskUsingParentById(index.parentById, ownerWorkspaceId, taskId)) {
      return Ok({ status: "invalid_scope", action: "remove", taskId });
    }

    const displayName = coerceNonEmptyString(entry.workspace.title) ?? entry.workspace.name;
    const target = {
      taskId,
      workspaceId: taskId,
      ...(displayName != null ? { displayName } : {}),
    };
    const busyRefusal = this.refuseBusyRemovalTarget(taskId, entry, target);
    if (busyRefusal != null) {
      return busyRefusal;
    }

    return await this.gitPatchArtifactService.withOperationLock(taskId, () =>
      this.removeInactiveTaskUnderPatchLock({ taskId, entry, target, options })
    );
  }

  /** A missing row was the owner's when its tombstone or a report or failure record names it. */
  private async reportMissingRemovalTarget(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    const wasOwned =
      (await this.hasRemovedAgentTaskTombstone(ownerWorkspaceId, taskId)) ||
      (await this.filterDescendantAgentTaskIds(ownerWorkspaceId, [taskId])).includes(taskId);
    return Ok(
      wasOwned
        ? { status: "already_removed", action: "remove", taskId, workspaceId: taskId }
        : { status: "invalid_scope", action: "remove", taskId }
    );
  }

  /** Refuses while descendants remain or the task is active or streaming; undefined when idle. */
  private refuseBusyRemovalTarget(
    taskId: string,
    entry: InactiveTaskRemoval["entry"],
    target: InactiveTaskRemoval["target"]
  ): Result<WorkspaceLifecycleResult, string> | undefined {
    const descendantTaskIds = this.listDescendantAgentTasks(taskId).map((task) => task.taskId);
    if (descendantTaskIds.length > 0) {
      return Ok({
        status: "error",
        action: "remove",
        ...target,
        descendantTaskIds,
        error: "Cannot remove a sub-agent while descendant sub-agents remain.",
      });
    }

    if (
      this.isActiveAgentTaskEntry({ ...entry.workspace, projectPath: entry.projectPath }) ||
      this.aiService.isStreaming(taskId)
    ) {
      return Ok({
        status: "active",
        action: "remove",
        ...target,
        activeTaskIds: [taskId],
        note: "Stop the sub-agent before removing it.",
      });
    }
    return undefined;
  }

  private async removeInactiveTaskUnderPatchLock(
    removal: InactiveTaskRemoval
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    // The task can become inactive before its background format-patch job finishes. Wait for the
    // in-process job, then refuse removal if a restart left a durable pending marker behind; the
    // child worktree is the source needed to recover that artifact.
    await this.gitPatchArtifactService.waitForGeneration(removal.taskId);
    const parentWorkspaceId = removal.entry.workspace.parentWorkspaceId;
    const patchArtifact = parentWorkspaceId
      ? await readSubagentGitPatchArtifact(
          path.join(this.config.sessionsDir, parentWorkspaceId),
          removal.taskId
        )
      : null;
    if (patchArtifact?.status === "pending") {
      return Ok({
        status: "error",
        action: "remove",
        ...removal.target,
        error: "Cannot remove the sub-agent while its git patch artifact is still pending.",
      });
    }
    return await this.refuseBackgroundBashBeforeRemoval({ ...removal, patchArtifact });
  }

  private async refuseBackgroundBashBeforeRemoval(
    removal: InactiveTaskRemovalUnderPatchLock
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    // #4761: a live writer in the checkout (a background process, a terminal, an external
    // editor) could write after the lossy-work check below, and the forced removal would lose
    // that work unreported. Take the archive path's admission hold: it refuses while such
    // activity exists and admits no new sends, bash, terminals or opens until it is released
    // after the removal. Model-driven only: automatic cleanup and the user cascade never refuse.
    // Only when removal deletes the checkout (see subagentRemovalPreservesCheckout): a preserved
    // checkout loses no files, and the sticky app marker would block its removal forever.
    const guardLiveWriters =
      removal.options?.lossyWorkPolicy === "refuse" &&
      !subagentRemovalPreservesCheckout(removal.entry.workspace);
    // The fresh background-process check first, as model-driven archive does: it refreshes exit
    // statuses (the hold's snapshot may still list an exited process) and sees crash orphans.
    if (
      guardLiveWriters &&
      (await this.workspaceService.hasRunningBackgroundBashProcesses(removal.taskId))
    ) {
      return Ok({
        status: "error",
        action: "remove",
        ...removal.target,
        error:
          "Background bash processes are still running in this sub-agent's checkout. Stop them before removing the sub-agent.",
      });
    }
    return await this.removeInactiveTaskUnderLiveWriterHold({ ...removal, guardLiveWriters });
  }

  /** Takes the live-writer hold (#4761) and keeps it until the checks and the removal settle. */
  private async removeInactiveTaskUnderLiveWriterHold(
    removal: GuardedInactiveTaskRemoval
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    const liveWriterHold = removal.guardLiveWriters
      ? this.workspaceService.acquirePreInterruptionArchiveHold(removal.taskId, {
          queuedDelegatedTurnCount: 0,
          expectedDelegatedTurnCorrelations: [],
          operation: "remove",
        })
      : undefined;
    if (liveWriterHold?.success === false) {
      return Ok({
        status: "error",
        action: "remove",
        ...removal.target,
        error: liveWriterHold.error,
      });
    }
    using _liveWriterHold = liveWriterHold?.success === true ? liveWriterHold.data : undefined;
    // Awaited, not returned: a bare return would release the hold before the removal runs.
    return await this.refuseLossyWorkBeforeRemoval(removal);
  }

  private async refuseLossyWorkBeforeRemoval(
    removal: GuardedInactiveTaskRemoval
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    // Checked under the tree and patch-artifact locks, right before the tombstone and removal.
    if (removal.options?.lossyWorkPolicy === "refuse") {
      // An editor or native terminal opened earlier is not trackable, so it may still write.
      if (
        removal.guardLiveWriters &&
        (await this.workspaceService.hasUntrackableExternalAppOpen(removal.taskId))
      ) {
        return Ok({
          status: "error",
          action: "remove",
          ...removal.target,
          error:
            "An external editor or native terminal was opened in this sub-agent's checkout and may still write to it. Ask the user to remove the sub-agent.",
        });
      }
      const refusal = await this.refuseLossySubagentRemoval(
        removal.taskId,
        removal.entry,
        removal.patchArtifact ?? null
      );
      if (refusal != null)
        return Ok({ status: "error", action: "remove", ...removal.target, ...refusal });
    }
    return await this.refuseChangedWorkBeforeRemoval(removal);
  }

  /** #5106: refuses when the work found under the locks differs from what the user confirmed. */
  private async refuseChangedWorkBeforeRemoval(
    removal: InactiveTaskRemovalUnderPatchLock
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    if (removal.options?.acknowledgedWork != null) {
      const current = await this.describeSubagentRemovalPreview(
        removal.taskId,
        removal.entry,
        removal.patchArtifact ?? null
      );
      if (
        current.summary !== removal.options.acknowledgedWork.summary ||
        current.paths.join("\0") !== removal.options.acknowledgedWork.paths.join("\0")
      ) {
        return Ok({
          status: "error",
          action: "remove",
          ...removal.target,
          error:
            "The sub-agent's unsaved work changed after the confirmation was shown, so it was not removed. Review it again.",
        });
      }
    }

    return await this.persistTombstonesAndRemoveTask(removal);
  }

  private async persistTombstonesAndRemoveTask(
    removal: InactiveTaskRemoval
  ): Promise<Result<WorkspaceLifecycleResult, string>> {
    const tombstoneResult = await this.persistRemovedAgentTaskTombstones(removal.taskId);
    if (!tombstoneResult.success) {
      return Ok({
        status: "error",
        action: "remove",
        ...removal.target,
        error: tombstoneResult.error,
      });
    }
    // Bound to the attempt checked inactive above (#4478): another backend can reawaken the task
    // during the awaits since, and the removal must then refuse instead of deleting its checkout.
    const result = await this.workspaceService.removeWhileTaskTreeLocked(
      removal.taskId,
      true,
      { expectedAttemptId: removal.entry.workspace.taskAttemptId },
      removal.options?.mutationGateHeld === true ? { mutationGateHeld: true } : undefined
    );
    return reportInactiveTaskRemoval(result, removal);
  }

  /**
   * #4723: a model's task_remove must not discard a child's unsaved work (the rule #3950 applies
   * to peer archives). Returns the refusal fields, or null when removal loses nothing.
   */
  private async refuseLossySubagentRemoval(
    taskId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    patchArtifact: SubagentGitPatchArtifact | null
  ): Promise<{ error: string; paths?: string[] } | null> {
    const lost = await this.describeUnpreservedSubagentWork(taskId, entry, patchArtifact);
    if (lost == null) return null;
    const guidance =
      "This tool cannot approve losing a sub-agent's work, and you must not delete that work to get around it. " +
      "Leave the sub-agent in place and tell the user what it holds; the user can save or clear it and ask you to retry, " +
      "or remove the sub-agent themselves from the command palette (Remove Current Sub-agent or Remove Workspace), whose confirmation lists this work.";
    return {
      error: `${lost.summary} ${guidance}`,
      ...(lost.paths.length > 0 ? { paths: lost.paths } : {}),
    };
  }

  /**
   * What removing this sub-agent would permanently delete, or null when nothing. Shared by the
   * model's refusal and the user's confirmation (#5106), so both report the same work.
   */
  private async describeUnpreservedSubagentWork(
    taskId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    patchArtifact: SubagentGitPatchArtifact | null,
    /** Where the reader finds the paths: the model gets a `paths` field, the dialog a list. */
    pathsLocation = "listed in paths"
  ): Promise<{ summary: string; paths: string[] } | null> {
    const ws = entry.workspace;
    const runtimeConfig = ws.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    if (subagentRemovalPreservesCheckout(ws)) return null;
    const workspacePath = coerceNonEmptyString(ws.path);
    const workspaceName = coerceNonEmptyString(ws.name);
    const check =
      workspacePath == null || workspaceName == null
        ? Err("the checkout path is unknown")
        : await findUnpreservedSubagentWork({
            runtime: createRuntimeForWorkspace({
              runtimeConfig,
              projectPath: entry.projectPath,
              name: workspaceName,
              namedWorkspacePath: workspacePath,
            }),
            projectRepos: getWorkspaceProjectRepos({
              // Outside the agent loop: the host's runtimes.
              runtimeFactory: nodeRuntimeFactory,
              workspaceId: taskId,
              workspaceName,
              workspacePath,
              runtimeConfig,
              projectPath: entry.projectPath,
              projectName: getPrimaryProjectName(entry.projectPath, ws.projects),
              projects: ws.projects,
            }),
            patchArtifact,
            patchArtifactSessionDir: path.join(
              this.config.sessionsDir,
              ws.parentWorkspaceId ?? taskId
            ),
            taskBaseCommitShaByProjectPath: buildTaskBaseCommitShaByProjectPath({
              projectPath: entry.projectPath,
              projects: ws.projects,
              taskBaseCommitSha: coerceNonEmptyString(ws.taskBaseCommitSha),
              taskBaseCommitShaByProjectPath: ws.taskBaseCommitShaByProjectPath,
            }),
            removalDeletesBundleClone: isDockerRuntime(runtimeConfig),
          });
    if (!check.success) {
      return {
        summary: `Cannot verify that removing this sub-agent keeps its work (${check.error}).`,
        paths: [],
      };
    }
    const work = check.data;
    if (work.kind === "none") return null;
    const otherRefCommitCount = work.otherRefCommitCount ?? 0;
    const lost = [
      ...(work.paths.length > 0 ? [`the uncommitted or untracked files ${pathsLocation}`] : []),
      ...(work.uncapturedCommitCount > 0
        ? [`${work.uncapturedCommitCount} commit(s) not captured by a ready patch artifact`]
        : []),
      ...(otherRefCommitCount > 0
        ? // Copies without a source record count every other branch (#5105), so do not claim the
          // commits exist nowhere else; only that nothing proves they do.
          [
            `${otherRefCommitCount} commit(s) on other local branches or in the stash that nothing shows exist outside this checkout`,
          ]
        : []),
      ...(work.commitCheckError != null
        ? [`any commits, which could not be checked (${work.commitCheckError})`]
        : []),
    ];
    assert(lost.length > 0, "a lossy removal result must name what would be lost");
    return {
      summary: `Removing this sub-agent would permanently delete ${lost.join(" and ")}.`,
      paths: work.paths,
    };
  }

  /** #5106: what a user-confirmed removal would lose, for the confirmation dialog. */
  async previewSubagentRemoval(taskId: string): Promise<Result<SubagentRemovalPreview, string>> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    if (entry == null) return Err("This sub-agent no longer exists.");
    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (parentWorkspaceId == null) return Err("This is not a sub-agent.");
    // Refuse up front what removal would refuse, rather than asking the user to confirm a removal
    // that cannot happen (and listing files a running sub-agent is still changing).
    if (
      this.isActiveAgentTaskEntry({ ...entry.workspace, projectPath: entry.projectPath }) ||
      this.aiService.isStreaming(taskId)
    ) {
      return Err("Stop the sub-agent before removing it.");
    }
    if (this.listDescendantAgentTasks(taskId).length > 0) {
      return Err("Cannot remove a sub-agent while descendant sub-agents remain.");
    }
    const patchArtifact = await readSubagentGitPatchArtifact(
      path.join(this.config.sessionsDir, parentWorkspaceId),
      taskId
    );
    if (patchArtifact?.status === "pending") {
      return Err("Cannot remove the sub-agent while its git patch artifact is still pending.");
    }
    return Ok(await this.describeSubagentRemovalPreview(taskId, entry, patchArtifact));
  }

  private async describeSubagentRemovalPreview(
    taskId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    patchArtifact: SubagentGitPatchArtifact | null
  ): Promise<SubagentRemovalPreview> {
    const lost = await this.describeUnpreservedSubagentWork(
      taskId,
      entry,
      patchArtifact,
      "listed below"
    );
    return { summary: lost?.summary ?? null, paths: lost?.paths ?? [] };
  }

  /**
   * #5106: removal the user confirmed after seeing the preview. It takes the same path as the
   * parent deletion cascade (no lossy-work refusal), so it still refuses active sub-agents,
   * sub-agents with descendants and pending patch artifacts.
   */
  async removeSubagentForUser(
    taskId: string,
    acknowledgedWork: SubagentRemovalPreview
  ): Promise<Result<{ warnings?: WorkspaceRemoveWarning[] }, string>> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    if (entry == null) return Err("This sub-agent no longer exists.");
    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (parentWorkspaceId == null) return Err("This is not a sub-agent.");
    const warnings: WorkspaceRemoveWarning[] = [];
    const result = await this.removeInactiveDescendantAgentTask(parentWorkspaceId, taskId, {
      acknowledgedWork,
      onRemovalWarnings: (removalWarnings) => warnings.push(...removalWarnings),
    });
    if (!result.success) return Err(result.error);
    switch (result.data.status) {
      case "removed":
      case "already_removed":
        return Ok(warnings.length > 0 ? { warnings } : {});
      case "active":
        return Err("Stop the sub-agent before removing it.");
      case "invalid_scope":
        return Err("This is not a sub-agent.");
      default:
        return Err(
          ("error" in result.data ? result.data.error : undefined) ?? "Sub-agent removal failed."
        );
    }
  }

  listWorkspaceRemovalDescendants(workspaceId: string): WorkspaceRemovalDescendant[] {
    const index = this.buildAgentTaskIndex(this.config.loadConfigOrDefault());
    const taskIds = this.listDescendantAgentTaskIdsFromIndex(index, workspaceId);
    taskIds.sort(
      (a, b) =>
        this.getTaskDepthFromParentById(index.parentById, b) -
        this.getTaskDepthFromParentById(index.parentById, a)
    );
    return taskIds.map((taskId) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const entry = index.byId.get(taskId)!;
      return {
        workspaceId: taskId,
        title: coerceNonEmptyString(entry.title) ?? entry.name ?? taskId,
        active: this.isActiveAgentTaskEntry(entry) || this.aiService.isStreaming(taskId),
      };
    });
  }

  async removeAcknowledgedDescendantsWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedIds: string[],
    gatedIds?: ReadonlySet<string>
  ): Promise<Result<void> & { warnings?: WorkspaceRemoveWarning[] }> {
    const descendants = this.listWorkspaceRemovalDescendants(workspaceId);
    const acknowledged = new Set(acknowledgedIds);
    const current = new Set(descendants.map((descendant) => descendant.workspaceId));
    if (descendants.some((descendant) => !acknowledged.has(descendant.workspaceId))) {
      return Err("The descendant scope changed. Confirm the current descendants before removal.");
    }
    for (const taskId of acknowledged) {
      // Only a durable removal record permits an absent ID during a partial retry.
      if (
        !current.has(taskId) &&
        (this.config.findWorkspace(taskId) != null ||
          !(await this.hasRemovedAgentTaskTombstone(workspaceId, taskId)))
      ) {
        return Err("The acknowledged descendant scope does not match this workspace.");
      }
    }
    // Check the full scope before removal. Force does not grant consent to stop children.
    if (descendants.some((descendant) => descendant.active)) {
      return Err("Stop active descendant sub-agents before removing this workspace.");
    }
    const warnings: WorkspaceRemoveWarning[] = [];
    for (const descendant of descendants) {
      const failure = (error: string) =>
        Err(`Cannot remove ${descendant.title} (${descendant.workspaceId}): ${error}`);
      try {
        const result = await this.removeInactiveDescendantAgentTaskWhileTaskTreeLocked(
          workspaceId,
          descendant.workspaceId,
          {
            mutationGateHeld: gatedIds?.has(descendant.workspaceId) === true,
            onRemovalWarnings: (descendantWarnings) => warnings.push(...descendantWarnings),
          }
        );
        if (!result.success) return failure(result.error);
        if (result.data.status !== "removed" && result.data.status !== "already_removed") {
          return failure(
            "error" in result.data
              ? (result.data.error ?? "Descendant removal failed.")
              : "Descendant removal failed."
          );
        }
      } catch (error) {
        return failure(getErrorMessage(error));
      }
    }
    return { ...Ok(undefined), ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private removedAgentTaskTombstonePath(ownerWorkspaceId: string, taskId: string): string {
    return path.join(
      this.config.sessionsDir,
      ownerWorkspaceId,
      REMOVED_AGENT_TASKS_DIR,
      `${encodeURIComponent(taskId)}.json`
    );
  }

  private async hasRemovedAgentTaskTombstone(
    ownerWorkspaceId: string,
    taskId: string
  ): Promise<boolean> {
    try {
      const raw = await fsPromises.readFile(
        this.removedAgentTaskTombstonePath(ownerWorkspaceId, taskId),
        "utf-8"
      );
      const parsed = JSON.parse(raw) as unknown;
      return (
        parsed != null &&
        typeof parsed === "object" &&
        (parsed as { taskId?: unknown }).taskId === taskId
      );
    } catch (error: unknown) {
      if (
        error != null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      log.debug("Failed to read removed sub-agent tombstone", {
        ownerWorkspaceId,
        taskId,
        error,
      });
      return false;
    }
  }

  private async persistRemovedAgentTaskTombstones(taskId: string): Promise<Result<void, string>> {
    const config = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(config);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    );
    if (ancestorWorkspaceIds.length === 0) {
      return Err("Cannot persist removed sub-agent ownership: missing ancestor lineage");
    }

    const payload = JSON.stringify(
      {
        taskId,
        ancestorWorkspaceIds,
        removedAt: getIsoNow(),
      },
      null,
      2
    );
    try {
      for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
        const filePath = this.removedAgentTaskTombstonePath(ancestorWorkspaceId, taskId);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, payload, "utf-8");
      }
      return Ok(undefined);
    } catch (error: unknown) {
      return Err(`Failed to persist removed sub-agent tombstone: ${getErrorMessage(error)}`);
    }
  }

  listDescendantAgentTasks(
    workspaceId: string,
    options?: { statuses?: AgentTaskStatus[]; excludeWorkflowTasks?: boolean }
  ): DescendantAgentTaskInfo[] {
    assert(workspaceId.length > 0, "listDescendantAgentTasks: workspaceId must be non-empty");

    const statuses = options?.statuses;
    const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const result: DescendantAgentTaskInfo[] = [];

    const stack: Array<{ taskId: string; depth: number; workflowOwned: boolean }> = [];
    for (const childTaskId of index.childrenByParent.get(workspaceId) ?? []) {
      stack.push({ taskId: childTaskId, depth: 1, workflowOwned: false });
    }

    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      if (!entry) continue;

      assert(
        entry.parentWorkspaceId,
        `listDescendantAgentTasks: task ${next.taskId} is missing parentWorkspaceId`
      );

      const workflowOwned = next.workflowOwned || entry.workflowTask != null;
      const status: AgentTaskStatus = entry.taskStatus ?? "running";
      if (
        (!statusFilter || statusFilter.has(status)) &&
        !(options?.excludeWorkflowTasks === true && workflowOwned)
      ) {
        result.push({
          taskId: next.taskId,
          status,
          parentWorkspaceId: entry.parentWorkspaceId,
          agentType: entry.agentType,
          workspaceName: entry.name,
          title: entry.title,
          createdAt: entry.createdAt,
          executionTaskId: entry.taskExecutionId,
          executionStatus: entry.taskExecutionStatus,
          modelString: entry.aiSettings?.model,
          thinkingLevel: entry.aiSettings?.thinkingLevel,
          ...(entry.bestOf != null ? { bestOf: { ...entry.bestOf } } : {}),
          depth: next.depth,
        });
      }

      for (const childTaskId of index.childrenByParent.get(next.taskId) ?? []) {
        stack.push({ taskId: childTaskId, depth: next.depth + 1, workflowOwned });
      }
    }

    // Stable ordering: oldest first, then depth (ties by taskId for determinism).
    result.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aTime !== bTime) return aTime - bTime;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.taskId.localeCompare(b.taskId);
    });

    return result;
  }

  async filterDescendantAgentTaskIds(
    ancestorWorkspaceId: string,
    taskIds: string[]
  ): Promise<string[]> {
    assert(
      ancestorWorkspaceId.length > 0,
      "filterDescendantAgentTaskIds: ancestorWorkspaceId required"
    );
    assert(Array.isArray(taskIds), "filterDescendantAgentTaskIds: taskIds must be an array");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;

    const result: string[] = [];
    const maybePersisted: string[] = [];

    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.length === 0) continue;

      if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
        result.push(taskId);
        continue;
      }

      const cached = this.waiters.getCompletedReport(taskId);
      if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
        result.push(taskId);
        continue;
      }

      maybePersisted.push(taskId);
    }

    if (maybePersisted.length === 0) {
      return result;
    }

    // Terminal failures persist in a separate artifacts file (a failure must
    // never masquerade as a completed report), so scope checks must consult
    // BOTH: a background-failed child that was cleaned up or lost to a restart
    // must stay in scope for task_await so waitForAgentReport can surface the
    // persisted typed failure instead of degrading to invalid_scope/not_found.
    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    for (const taskId of maybePersisted) {
      if (
        hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
        hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
      ) {
        result.push(taskId);
      }
    }

    return result;
  }

  private listDescendantAgentTaskIdsFromIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listDescendantAgentTaskIdsFromIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const visited = new Set([workspaceId]);
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const next = stack.pop()!;
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      result.push(next);
      const children = index.childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  private isWorkflowRunDescendant(
    index: AgentTaskIndex,
    taskId: string,
    workflowRunId: string
  ): boolean {
    let current: string | undefined = taskId;
    for (let i = 0; current != null && i < 32; i++) {
      const entry = index.byId.get(current);
      if (entry?.workflowTask?.runId === workflowRunId) {
        return true;
      }
      current = index.parentById.get(current);
    }
    return false;
  }

  async isWorkflowOwnedDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<boolean> {
    assert(
      ancestorWorkspaceId.length > 0,
      "isWorkflowOwnedDescendantAgentTask: ancestorWorkspaceId required"
    );
    assert(taskId.length > 0, "isWorkflowOwnedDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const indexResult = this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
      this.buildAgentTaskIndex(cfg),
      ancestorWorkspaceId,
      taskId
    );
    if (indexResult != null) {
      return indexResult;
    }

    const cached = this.waiters.getCompletedReport(taskId);
    if (hasWorkflowOwnedAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return false;
    }

    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const persisted = await readSubagentReportArtifactsFile(sessionDir);
    const entry = persisted.artifactsByChildTaskId[taskId];
    if (entry != null) {
      return hasWorkflowOwnedAncestorWorkspaceId(entry, ancestorWorkspaceId);
    }

    // A workflow-owned child that failed terminally leaves only a failure
    // artifact. It must stay excluded from direct task_await after cleanup,
    // matching live behavior: its failure is consumed through the workflow run.
    const failures = await readSubagentFailureArtifactsFile(sessionDir);
    return hasWorkflowOwnedAncestorWorkspaceId(
      failures.failuresByChildTaskId[taskId],
      ancestorWorkspaceId
    );
  }

  private getWorkflowOwnedDescendantAgentTaskUsingIndex(
    index: AgentTaskIndex,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean | null {
    let current = taskId;
    let workflowOwned = false;

    for (let i = 0; i < 32; i++) {
      const entry = index.byId.get(current);
      workflowOwned ||= entry?.workflowTask != null;

      const parent = index.parentById.get(current);
      if (!parent) return null;
      if (parent === ancestorWorkspaceId) return workflowOwned;
      current = parent;
    }

    throw new Error(
      `getWorkflowOwnedDescendantAgentTaskUsingIndex: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  async isDescendantAgentTask(ancestorWorkspaceId: string, taskId: string): Promise<boolean> {
    assert(ancestorWorkspaceId.length > 0, "isDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "isDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
      return true;
    }

    if (await this.hasRemovedAgentTaskTombstone(ancestorWorkspaceId, taskId)) {
      return true;
    }

    // The task workspace may have been removed after it settled (cleanup/restart). Preserve scope
    // checks by consulting persisted report AND failure artifacts in the ancestor session dir —
    // a terminally-failed child must stay awaitable so its typed failure can be surfaced.
    const cached = this.waiters.getCompletedReport(taskId);
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }

    const sessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    return (
      hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
      hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
    );
  }

  /**
   * Locate a live descendant's branch root: the direct child of `ancestorWorkspaceId` on the
   * parent chain leading to `taskId` (the task itself for a direct child). Callers that must
   * respect the ancestor's privacy floor prove that this branch root was created inside the
   * ancestor's current context segment; verified ancestry then extends the proof to the whole
   * branch. Tasks that were removed (tombstone/report evidence only) have no live chain.
   */
  async resolveDescendantAgentTaskBranchRoot(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<{ status: "live"; branchRootTaskId: string } | { status: "removed" | "unrelated" }> {
    assert(
      ancestorWorkspaceId.length > 0,
      "resolveDescendantAgentTaskBranchRoot: ancestor required"
    );
    assert(taskId.length > 0, "resolveDescendantAgentTaskBranchRoot: taskId required");
    const parentById = this.buildAgentTaskIndex(this.config.loadConfigOrDefault()).parentById;
    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      if (parent === ancestorWorkspaceId) return { status: "live", branchRootTaskId: current };
      current = parent;
    }
    return (await this.isDescendantAgentTask(ancestorWorkspaceId, taskId))
      ? { status: "removed" }
      : { status: "unrelated" };
  }

  isDescendantAgentTaskUsingParentById(
    parentById: Map<string, string>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    return isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId);
  }

  /** Walks parentWorkspaceId chains up to the tree root (a workspace with no agent-task parent). */
  private resolveRootWorkspaceIdUsingParentById(
    parentById: Map<string, string>,
    workspaceId: string
  ): string {
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return current;
      current = parent;
    }

    throw new Error(
      `resolveRootWorkspaceIdUsingParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  private isUnrelatedMessagingEndpoint(workspace: WorkspaceConfigEntry): boolean {
    return (
      workspace.sideChatParentWorkspaceId == null &&
      this.isLocalUnrelatedMessagingEndpoint(workspace)
    );
  }

  private isLocalUnrelatedMessagingEndpoint(workspace: WorkspaceConfigEntry): boolean {
    let runtimeConfig = workspace.runtimeConfig;
    if (runtimeConfig === undefined) {
      // Only complete inline metadata owns the default. A partly migrated entry can still
      // resolve to SSH from metadata.json; wait for that migration rather than guessing local.
      if (
        coerceNonEmptyString(workspace.id) == null ||
        coerceNonEmptyString(workspace.name) == null
      ) {
        return false;
      }
      runtimeConfig = DEFAULT_RUNTIME_CONFIG;
    }
    return isLocalProjectRuntime(runtimeConfig) || isWorktreeRuntime(runtimeConfig);
  }

  /**
   * Side chats share their owner's runtime, but are not task children. Keep this direct-link
   * permission separate from ancestry so neither chat gains lifecycle or trusted-guidance power,
   * and a side chat cannot bridge isolated top-level workspaces (even with unrelated consent).
   */
  private resolveDirectChatRelation(
    sender: WorkspaceConfigEntry,
    target: WorkspaceConfigEntry
  ): "target_main_chat" | "target_side_chat" | null {
    if (
      sender.sideChatParentWorkspaceId != null &&
      target.sideChatParentWorkspaceId == null &&
      sender.sideChatParentWorkspaceId === target.id
    ) {
      return "target_main_chat";
    }
    if (
      target.sideChatParentWorkspaceId != null &&
      sender.sideChatParentWorkspaceId == null &&
      target.sideChatParentWorkspaceId === sender.id
    ) {
      return "target_side_chat";
    }
    return null;
  }

  /**
   * User-set @tag link: two root chats whose user assigned the same messaging tag may
   * intercommunicate. Tags are user-only consent (no agent tool sets them), shared-tag
   * equality is mutual, and clearing/changing either side revokes the link because every
   * admission re-resolves it. Root chats only: sub-agent children and side chats can
   * neither carry nor bridge a tag link, so runtime-isolated top-level workspaces stay
   * isolated unless their user explicitly tags them.
   */
  private sharesMessagingTag(sender: WorkspaceConfigEntry, target: WorkspaceConfigEntry): boolean {
    if (
      sender.sideChatParentWorkspaceId != null ||
      target.sideChatParentWorkspaceId != null ||
      // Raw presence, not coercion: config loads leniently, so a malformed non-string
      // or blank parent marker must fail closed as a child, exactly as setMessagingTag
      // rejects any non-null marker — never silently promote it to a root chat.
      sender.parentWorkspaceId != null ||
      target.parentWorkspaceId != null ||
      sender.id == null ||
      sender.id === target.id
    ) {
      return false;
    }
    const tag = getValidMessagingTag(sender.messagingTag);
    return tag != null && tag === getValidMessagingTag(target.messagingTag);
  }

  /** Relation for messaging only; chat links and tags never enter the task ownership graph. */
  private resolveAgentTreeTargetRelation(
    cfg: ProjectsConfig,
    parentById: Map<string, string>,
    senderWorkspaceId: string,
    targetId: string
  ): AgentTreeTargetRelation | null {
    const sender = findWorkspaceEntry(cfg, senderWorkspaceId);
    const target = findWorkspaceEntry(cfg, targetId);
    if (sender == null || target == null) {
      return this.resolveTaskAncestryRelation(parentById, senderWorkspaceId, targetId);
    }
    if (
      sender.workspace.sideChatParentWorkspaceId == null &&
      target.workspace.sideChatParentWorkspaceId == null
    ) {
      return this.resolveNonSideChatRelation(
        sender.workspace,
        target.workspace,
        parentById,
        senderWorkspaceId,
        targetId
      );
    }
    return this.resolveDirectChatRelation(sender.workspace, target.workspace);
  }

  /** A retry needs the consent grant it was first admitted under (off/on is a new grant). */
  private unrelatedConsentRevoked(
    relation: PeerPathRelation,
    unrelatedConsent: string | undefined,
    awaitedDelegatedTurn: PeerDelegatedTurnWait | undefined
  ): boolean {
    return (
      relation === "target_unrelated" &&
      (unrelatedConsent == null ||
        (awaitedDelegatedTurn != null &&
          unrelatedConsent !== awaitedDelegatedTurn.unrelatedConsent))
    );
  }

  /** True when a tagged send's endpoint generations differ from its admission baseline. */
  private tagGenerationMismatch(
    relation: PeerPathRelation,
    expected: { sender: string | undefined; target: string | undefined } | undefined,
    actual: { sender: string | undefined; target: string | undefined }
  ): boolean {
    return relation === "target_tagged" && !this.messagingTagGenerationsEqual(expected, actual);
  }

  /**
   * Config loads leniently, so a corrupted generation may be a non-string whose identity
   * changes on every config reparse. Read only valid strings (else undefined) so corrupted
   * state can never manufacture a spurious revocation.
   */
  private messagingTagGenerationsOf(
    sender: WorkspaceConfigEntry,
    target: WorkspaceConfigEntry
  ): { sender: string | undefined; target: string | undefined } {
    return {
      sender: coerceNonEmptyString(sender.messagingTagGeneration),
      target: coerceNonEmptyString(target.messagingTagGeneration),
    };
  }

  private messagingTagGenerationsEqual(
    a: { sender: string | undefined; target: string | undefined } | undefined,
    b: { sender: string | undefined; target: string | undefined } | undefined
  ): boolean {
    return a?.sender === b?.sender && a?.target === b?.target;
  }

  /** Ancestry wins inside a tree; only cross-tree root pairs can be tag-linked. */
  private resolveNonSideChatRelation(
    sender: WorkspaceConfigEntry,
    target: WorkspaceConfigEntry,
    parentById: Map<string, string>,
    senderWorkspaceId: string,
    targetId: string
  ): AgentTreeTargetRelation | null {
    const ancestry = this.resolveTaskAncestryRelation(parentById, senderWorkspaceId, targetId);
    return ancestry === "target_unrelated" && this.sharesMessagingTag(sender, target)
      ? "target_tagged"
      : ancestry;
  }

  /** Only task parent chains grant ancestry; chat links and workspace-turn ownership do not. */
  private resolveTaskAncestryRelation(
    parentById: Map<string, string>,
    senderWorkspaceId: string,
    targetId: string
  ): AgentTreeTargetRelation | null {
    if (senderWorkspaceId === targetId) return null;
    if (this.isDescendantAgentTaskUsingParentById(parentById, senderWorkspaceId, targetId)) {
      return "target_descendant";
    }
    if (this.isDescendantAgentTaskUsingParentById(parentById, targetId, senderWorkspaceId)) {
      return "target_ancestor";
    }
    // Ancestor/descendant is already ruled out, so a shared root means sibling/cousin. Distinct
    // roots (including two unrelated plain workspaces, each its own root) are cross-tree.
    const senderRoot = this.resolveRootWorkspaceIdUsingParentById(parentById, senderWorkspaceId);
    const targetRoot = this.resolveRootWorkspaceIdUsingParentById(parentById, targetId);
    const relation = senderRoot === targetRoot ? "peer" : "target_unrelated";
    assert(relation !== "target_unrelated" || senderRoot !== targetRoot);
    return relation;
  }

  /** True when the workspace or any agent-task ancestor carries best-of candidate metadata. */
  private isBestOfChainUsingIndex(index: AgentTaskIndex, workspaceId: string): boolean {
    return this.findNearestBestOfGroupUsingIndex(index, workspaceId) != null;
  }

  /** Nearest best-of candidate metadata on the workspace or any agent-task ancestor. */
  private findNearestBestOfGroupUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): TaskCreateArgs["bestOf"] {
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const entry = index.byId.get(current);
      const group = entry != null ? this.getEffectiveTaskGroup(current, entry) : undefined;
      if (group != null) return group;
      const parent = index.parentById.get(current);
      if (!parent) return undefined;
      current = parent;
    }

    throw new Error(
      `findNearestBestOfGroupUsingIndex: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  /**
   * An on-demand root-workspace address book, separate from either ownership graph. Activity and
   * delegated-turn state come from this backend's memory; another backend's live work is not
   * reflected (see CONCURRENT BACKENDS in processLiveness.ts).
   */
  listInstanceWorkspaces(
    callerWorkspaceId: string,
    options: { query?: string | null; limit?: number | null; offset?: number | null }
  ): InstanceWorkspacesResult {
    assert(callerWorkspaceId.length > 0, "listInstanceWorkspaces: callerWorkspaceId required");
    // Invalid paging throws here, before the config read.
    const page = readInstanceDiscoveryPage(options);
    const cfg = this.config.loadConfigOrDefault();
    const caller = findWorkspaceEntry(cfg, callerWorkspaceId);
    // Instance discovery must not bridge the runtime boundary closed by unrelated messaging.
    if (caller == null || !this.isUnrelatedMessagingEndpoint(caller.workspace)) {
      return { rows: [], totalMatching: 0, callerPeerMessagingRestricted: true };
    }
    const index = this.buildAgentTaskIndex(cfg);
    if (
      this.isWorkflowOwnedTaskUsingIndex(index, callerWorkspaceId) ||
      this.isBestOfChainUsingIndex(index, callerWorkspaceId)
    ) {
      return { rows: [], totalMatching: 0, callerPeerMessagingRestricted: true };
    }
    const callerRoot = this.resolveRootWorkspaceIdUsingParentById(
      index.parentById,
      callerWorkspaceId
    );
    const candidates = this.collectInstanceDiscoveryCandidates(cfg, index, page.query, {
      workspaceId: callerWorkspaceId,
      root: callerRoot,
    });
    return this.pageInstanceDiscoveryCandidates(candidates, page);
  }

  /**
   * The id of a root that instance discovery can list, or undefined for a hidden row. These are
   * the first six visibility terms; isInstanceRootBusyOrRestricted holds the other five.
   */
  private discoverableInstanceRootId(
    workspace: WorkspaceConfigEntry,
    callerRoot: string
  ): string | undefined {
    const id = workspace.id;
    if (
      id == null ||
      id.trim().length === 0 ||
      workspace.parentWorkspaceId ||
      // Same-tree visibility is unchanged; hide unrelated roots before matching or probing them.
      (id !== callerRoot &&
        getValidUnrelatedWorkspaceConsent(workspace.unrelatedWorkspaceConsent) == null) ||
      !this.isUnrelatedMessagingEndpoint(workspace) ||
      isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
    ) {
      return undefined;
    }
    return id;
  }

  /**
   * The last five visibility terms, in memory only. Not isPeerMessagingRestricted: it runs the two
   * index predicates in the reverse order, and their ancestry walks throw on a parent cycle.
   */
  private isInstanceRootBusyOrRestricted(index: AgentTaskIndex, id: string): boolean {
    return (
      this.interruptedParentWorkspaceIds.has(id) ||
      this.isWorkspaceStopInProgress(id) ||
      this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(id) != null ||
      // Match peer-path predicates, not a new raw-tag rule. The current index contains
      // only task children, so ordinary roots cannot match these task restrictions.
      this.isWorkflowOwnedTaskUsingIndex(index, id) ||
      this.isBestOfChainUsingIndex(index, id)
    );
  }

  /** Visible roots that match the query, in config order. Probes no activity. */
  private collectInstanceDiscoveryCandidates(
    cfg: ProjectsConfig,
    index: AgentTaskIndex,
    query: string,
    caller: InstanceDiscoveryCaller
  ): InstanceDiscoveryCandidate[] {
    const candidates: InstanceDiscoveryCandidate[] = [];
    for (const [projectConfigPath, project] of cfg.projects) {
      for (const workspace of project.workspaces) {
        // The 11 visibility terms run in order and stop at the first that hides the row.
        const id = this.discoverableInstanceRootId(workspace, caller.root);
        if (id == null || this.isInstanceRootBusyOrRestricted(index, id)) continue;
        const projectPath = instanceRowProjectPath(workspace, projectConfigPath);
        if (!instanceRowMatchesQuery(query, id, workspace, projectPath)) continue;
        candidates.push(toInstanceDiscoveryCandidate(id, workspace, projectPath, caller));
      }
    }
    return candidates;
  }

  /** Sorts the candidates in place, then probes activity for the requested page only. */
  private pageInstanceDiscoveryCandidates(
    candidates: InstanceDiscoveryCandidate[],
    page: InstanceDiscoveryPage
  ): InstanceWorkspacesResult {
    const { limit, offset } = page;
    // Activity must not reorder pages. Missing/invalid dates sort last, including before-epoch histories.
    candidates.sort(
      (a, b) => b.createdAtMs - a.createdAtMs || a.row.workspaceId.localeCompare(b.row.workspaceId)
    );
    const totalMatching = candidates.length;
    // No history reads or per-workspace disk access. Probe activity only for the bounded output.
    const rows = candidates.slice(offset, offset + limit).map(({ row }) => ({
      ...row,
      busy:
        this.workspaceService.isBusyForMessage(row.workspaceId) ||
        this.aiService.isStreaming(row.workspaceId),
    }));
    const nextOffset = offset + rows.length < totalMatching ? offset + rows.length : undefined;
    assert(rows.length <= limit);
    assert(
      nextOffset == null || (nextOffset === offset + rows.length && nextOffset < totalMatching)
    );
    return { rows, totalMatching, ...(nextOffset != null ? { nextOffset } : {}) };
  }

  /**
   * All addressable agent tasks in the caller's task tree (the root's full descendant
   * enumeration, workflow-owned subtrees excluded), tagged with each row's relationship to the
   * caller. The root is returned separately because it is a plain workspace, not an agent task.
   */
  listTaskTreeAgents(workspaceId: string): TaskTreeAgentsResult {
    assert(workspaceId.length > 0, "listTaskTreeAgents: workspaceId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    // the peer relation leg refuses EVERY peer/ancestor delivery from a best-of candidate
    // (independence) or a workflow-owned task (journal determinism) based on the sender's own
    // chain — advertising root/sibling/ancestor rows to such a caller would direct it at
    // targets it can never message. Descendant guidance stays valid, so those rows survive.
    const callerWorkflowOwned = this.isWorkflowOwnedTaskUsingIndex(index, workspaceId);
    const callerRestricted = this.isPeerMessagingRestricted(index, workspaceId);
    const rootWorkspaceId = this.resolveRootWorkspaceIdUsingParentById(
      index.parentById,
      workspaceId
    );
    const rootEntry = findWorkspaceEntry(cfg, rootWorkspaceId);
    const rootTitle =
      rootEntry != null
        ? (coerceNonEmptyString(rootEntry.workspace.title) ??
          coerceNonEmptyString(rootEntry.workspace.name))
        : undefined;

    const tasks = this.listDescendantAgentTasks(rootWorkspaceId)
      .filter((task) => {
        if (!this.isWorkflowOwnedTaskUsingIndex(index, task.taskId)) return true;
        // Workflow subtrees are hidden from callers OUTSIDE them (their I/O rides the runner's
        // durable journal). A workflow-owned caller still owns its own subtree: descendant
        // guidance routes through the trusted path before peer workflow restrictions apply, so
        // the restricted view must keep the self/descendant rows its note promises.
        return (
          callerWorkflowOwned &&
          (task.taskId === workspaceId ||
            this.isDescendantAgentTaskUsingParentById(index.parentById, workspaceId, task.taskId))
        );
      })
      .map((task): TreeAgentTaskInfo => {
        const relationship: TreeAgentRelationship =
          task.taskId === workspaceId
            ? "self"
            : this.isDescendantAgentTaskUsingParentById(index.parentById, workspaceId, task.taskId)
              ? "descendant"
              : this.isDescendantAgentTaskUsingParentById(
                    index.parentById,
                    task.taskId,
                    workspaceId
                  )
                ? "ancestor"
                : "sibling";
        // the peer relation leg refuses a candidate's ENTIRE subtree (isBestOfChainUsingIndex walks
        // ancestors), so discovery must mark nested children of a candidate too: inherit the
        // nearest ancestor's candidate metadata when the row carries none of its own, keeping the
        // tree note's "bestOf metadata ⇒ not peer-addressable" rule aligned with refusal behavior.
        const bestOf = task.bestOf ?? this.findNearestBestOfGroupUsingIndex(index, task.taskId);
        const info: TreeAgentTaskInfo = {
          ...task,
          ...(bestOf != null ? { bestOf } : {}),
          relationship,
        };
        // A crash or failed startup reconciliation can leave a stale persisted "running"
        // execution mirror on a stably terminal peer, and peer admission only honors a mirror
        // backed by the matching ACCEPTED live handle — so peer discovery must apply the same
        // predicate or it would advertise a nonterminal, addressable row task_send_message
        // always refuses. Descendant/self rows keep the full overlay (guidance may target any
        // state, and the ancestor-scoped snapshot in task_list refines them).
        if (relationship === "sibling" || relationship === "ancestor") {
          const live = this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(task.taskId);
          const liveBacked =
            task.executionTaskId != null &&
            live != null &&
            live.handleId === task.executionTaskId &&
            live.accepted;
          if (!liveBacked) {
            delete info.executionTaskId;
            delete info.executionStatus;
          }
        }
        return info;
      })
      .filter((task) => {
        // Archived state is independent of taskStatus (legacy archived rows can still read
        // "running"), and the peer relation leg unconditionally refuses archived targets — hide
        // them from PEER discovery so the note's addressability claim stays true. Archived
        // DESCENDANTS stay visible: their delivery routes through the trusted
        // sendMessageToDescendantAgentTask path, which can restore and reawaken an inactive
        // child, so hiding them would strand a valid reusable task ID after compaction.
        if (task.relationship === "descendant" || task.relationship === "self") {
          return true;
        }
        if (callerRestricted) {
          return false;
        }
        const entry = index.byId.get(task.taskId);
        return entry == null || !isWorkspaceArchived(entry.archivedAt, entry.unarchivedAt);
      });

    // An archived root refuses peer sends at the peer relation leg's archived-target check, so
    // discovery must not advertise it as an addressable "workspace" row.
    const rootArchived =
      rootEntry != null &&
      isWorkspaceArchived(rootEntry.workspace.archivedAt, rootEntry.workspace.unarchivedAt);

    const relatedChats = this.listRelatedChats(cfg, index, workspaceId);

    return {
      rootWorkspaceId,
      ...(relatedChats.length > 0 ? { relatedChats } : {}),
      ...(rootTitle != null ? { rootTitle } : {}),
      rootRelationship: rootWorkspaceId === workspaceId ? "self" : "ancestor",
      ...(rootArchived ? { rootArchived: true as const } : {}),
      // Partial removal or config corruption can leave a retained descendant whose parent chain
      // ends at a workspace that no longer exists; sendAgentTreeMessage returns not_found for
      // that ID, so discovery must say so instead of advertising an addressable root row.
      ...(rootEntry == null ? { rootMissing: true as const } : {}),
      ...(callerRestricted ? { callerPeerMessagingRestricted: true as const } : {}),
      tasks,
    };
  }

  /** Shared by peer admission and linked-chat discovery so discarded/inactive chats never wake peers. */
  private isInactivePeerMessagingEndpoint(
    workspace: WorkspaceConfigEntry,
    workspaceId: string
  ): boolean {
    // Removal claims the row before stopping its session. A winding-down side-chat tool call
    // must not wake the main chat while that row still exists, including at final admission.
    if (
      workspace.pendingRemoval != null ||
      isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
    )
      return true;
    if (coerceNonEmptyString(workspace.parentWorkspaceId) == null) return false;
    const status = workspace.taskStatus ?? "running";
    return (
      !this.hasLiveRunningExecution(workspace, workspaceId) &&
      status !== "running" &&
      status !== "awaiting_report"
    );
  }

  private isPeerMessagingRestricted(index: AgentTaskIndex, workspaceId: string): boolean {
    return (
      this.isBestOfChainUsingIndex(index, workspaceId) ||
      this.isWorkflowOwnedTaskUsingIndex(index, workspaceId)
    );
  }

  private relatedChatRelationship(
    caller: WorkspaceConfigEntry,
    candidate: WorkspaceConfigEntry
  ): "main_chat" | "side_chat" | "tagged" | undefined {
    const direct = this.resolveDirectChatRelation(caller, candidate);
    if (direct === "target_main_chat") return "main_chat";
    if (direct === "target_side_chat") return "side_chat";
    return this.sharesMessagingTag(caller, candidate) ? "tagged" : undefined;
  }

  private getRelatedChatInfo(
    caller: WorkspaceConfigEntry,
    candidate: WorkspaceConfigEntry
  ): NonNullable<TaskTreeAgentsResult["relatedChats"]>[number] | undefined {
    const workspaceId = addressableWorkspaceId(candidate);
    if (workspaceId == null) return undefined;
    const relationship = this.relatedChatRelationship(caller, candidate);
    if (relationship == null) return undefined;
    return {
      workspaceId,
      title: coerceNonEmptyString(candidate.title) ?? coerceNonEmptyString(candidate.name),
      relationship,
    };
  }

  /** Discover direct chat links only, without joining task ownership or instance discovery. */
  private listRelatedChats(
    cfg: ProjectsConfig,
    index: AgentTaskIndex,
    workspaceId: string
  ): NonNullable<TaskTreeAgentsResult["relatedChats"]> {
    const caller = findWorkspaceEntry(cfg, workspaceId)?.workspace;
    if (caller == null) return [];
    if (
      this.isInactivePeerMessagingEndpoint(caller, workspaceId) ||
      this.isPeerMessagingRestricted(index, workspaceId)
    )
      return [];
    const candidates = Array.from(cfg.projects.values()).flatMap((project) => project.workspaces);
    return candidates.flatMap((candidate) => {
      const info = this.getRelatedChatInfo(caller, candidate);
      if (info == null || !this.isDiscoverableRelatedChat(index, candidate, info.workspaceId)) {
        return [];
      }
      return [info];
    });
  }

  /**
   * Discovery mirrors admission: inactive, restricted, or user-stopped chats are hidden, since
   * sendTreeMessage refuses a stopped target chain regardless of relationship.
   */
  private isDiscoverableRelatedChat(
    index: AgentTaskIndex,
    candidate: WorkspaceConfigEntry,
    workspaceId: string
  ): boolean {
    return !(
      this.isInactivePeerMessagingEndpoint(candidate, workspaceId) ||
      this.isPeerMessagingRestricted(index, workspaceId) ||
      this.interruptedParentWorkspaceIds.has(workspaceId) ||
      this.isWorkspaceStopInProgress(workspaceId)
    );
  }

  // --- Internal orchestration ---

  private listAncestorWorkspaceIdsUsingParentById(
    parentById: Map<string, string>,
    taskId: string
  ): string[] {
    const ancestors: string[] = [];

    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return ancestors;
      ancestors.push(parent);
      current = parent;
    }

    throw new Error(
      `listAncestorWorkspaceIdsUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  listAgentTaskWorkspaces(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): AgentTaskWorkspaceEntry[] {
    return listAgentTaskWorkspaces(config);
  }

  isDescendantAgentTaskInConfig(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    return this.isDescendantAgentTaskUsingParentById(
      this.buildAgentTaskIndex(config).parentById,
      ancestorWorkspaceId,
      taskId
    );
  }

  listAgentTaskExecutionEntries(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): Array<Pick<WorkspaceConfigEntry, "id" | "taskExecutionId" | "taskExecutionStatus">> {
    return this.listAgentTaskWorkspaces(config);
  }

  buildAgentTaskIndex(config: ReturnType<Config["loadConfigOrDefault"]>): AgentTaskIndex {
    return buildAgentTaskIndex(config);
  }

  private isWorkflowOwnedTaskUsingIndex(index: AgentTaskIndex, taskId: string): boolean {
    assert(taskId.length > 0, "isWorkflowOwnedTaskUsingIndex: taskId must be non-empty");
    return this.findWorkflowTaskOwnerInAncestry(index, taskId) != null;
  }

  /**
   * Filter active workflow run IDs down to those whose persisted attention
   * policy still blocks the owner's turn-end. `notify_on_terminal` runs are
   * non-blocking; their terminal result is delivered via the existing
   * AIService background-run terminal continuation.
   */
  private async listBlockingWorkflowRunIds(
    workspaceId: string,
    runIds: string[]
  ): Promise<string[]> {
    if (runIds.length === 0) {
      return [];
    }
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, workspaceId),
    });
    const blocking: string[] = [];
    for (const runId of runIds) {
      const run = await runStore.getRun(runId).catch(() => null);
      if (resolveBackgroundWorkAttentionPolicy(run?.attentionPolicy) !== "notify_on_terminal") {
        blocking.push(runId);
      }
    }
    return blocking;
  }

  async noteWorkspaceUnarchived(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "noteWorkspaceUnarchived requires workspaceId");
    // Archived owners park workflow terminal wakes unsettled (the drain drops the in-memory
    // queue and the sweep skips archived workspaces), so without this unarchive-time
    // reconciliation an idle owner would stay silent until the interval sweep.
    await this.sweepWorkflowRunTerminalAttention(workspaceId);
    // Unarchive interrupts a legacy shared-desktop child archived while active (see
    // settleArchivedSharedDesktopTask), which owes its goal pause like any termination.
    await this.settleChildGoalPause(workspaceId);
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (
      entry &&
      hasCompletedAgentReport(entry.workspace) &&
      !isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt) &&
      !isActiveWorkspaceTurnTaskStatus(entry.workspace.taskExecutionStatus) &&
      !this.aiService.isStreaming(workspaceId)
    ) {
      await this.maybeStartPatchGenerationForReportedTask(workspaceId);
    }
  }

  /**
   * Whether any top-level workflow runs are durably active for this workspace. The archive
   * sink rechecks this after arming its admission gate (see archiveUnlocked) so a workflow
   * admitted between the lifecycle caller's earlier snapshot and the sink cannot be orphaned
   * in an archived workspace.
   */
  async hasActiveTopLevelWorkflowRunsForWorkspace(workspaceId: string): Promise<boolean> {
    try {
      return (await this.listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId)).length > 0;
    } catch (error: unknown) {
      // Fail closed: this feeds the archive sink, and an unreadable run store cannot prove
      // the absence of active runs (a crash-recovered run may still resume later).
      log.warn("Workflow activity scan failed; treating workspace as having active runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return true;
    }
  }

  /**
   * Strict variant for archive gates: scan failures (unreadable run store or run records)
   * propagate instead of reading as "no runs". A crash-recovered run with a delayed resume
   * would otherwise restart inside a workspace whose archive was admitted on the false
   * empty answer.
   */
  async listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId: string): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "listActiveWorkflowRunIdsForWorkspaceStrict requires workspaceId"
    );
    const runStore = new WorkflowRunStore({
      sessionDir: path.join(this.config.sessionsDir, workspaceId),
    });
    const runs = await runStore.listRunsForActivityScan();
    return runs
      .filter(
        (run) =>
          run.workspaceId === workspaceId &&
          run.parentWorkflow == null &&
          isActiveWorkflowRunStatus(run.status)
      )
      .map((run) => run.id);
  }

  /**
   * Lenient variant for heuristics (task-owned-work and terminal-drain checks) where a
   * transient scan failure should not abort the surrounding flow. Archive gates must use
   * the strict variant (or hasActiveTopLevelWorkflowRunsForWorkspace, which fails closed).
   */
  private async listActiveWorkflowRunIdsForWorkspace(workspaceId: string): Promise<string[]> {
    try {
      return await this.listActiveWorkflowRunIdsForWorkspaceStrict(workspaceId);
    } catch (error: unknown) {
      log.warn("Failed to list active workflow runs for workspace", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async hasActiveTaskOwnedWork(
    workspaceId: string,
    taskIndex: AgentTaskIndex
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "hasActiveTaskOwnedWork requires workspaceId");
    if (this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, workspaceId)) {
      return true;
    }
    if (
      (await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId))
        .length > 0
    ) {
      return true;
    }
    return (await this.listActiveWorkflowRunIdsForWorkspace(workspaceId)).length > 0;
  }

  private async hasBlockingActiveWorkForTerminalDrain(
    workspaceId: string,
    taskIndex: AgentTaskIndex
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "hasBlockingActiveWorkForTerminalDrain requires workspaceId");
    if (
      this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(taskIndex, workspaceId, {
        excludeWorkflowTasks: true,
      }).length > 0
    ) {
      return true;
    }
    const activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    if (
      (
        await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
          workspaceId,
          activeWorkspaceTurnIds
        )
      ).length > 0
    ) {
      return true;
    }
    const activeWorkflowRunIds = await this.listActiveWorkflowRunIdsForWorkspace(workspaceId);
    return (await this.listBlockingWorkflowRunIds(workspaceId, activeWorkflowRunIds)).length > 0;
  }

  private isActiveAgentTaskEntry(task: AgentTaskWorkspaceEntry): boolean {
    return isActiveAgentTaskEntry(task, (id) => this.aiService.isStreaming(id));
  }

  countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number {
    return countActiveAgentTasks(this.listAgentTaskWorkspaces(config), {
      isStreaming: (id) => this.aiService.isStreaming(id),
      isForegroundAwaiting: (id) => this.isForegroundAwaiting(id),
    });
  }

  hasActiveDescendantAgentTasks(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean {
    return this.hasActiveDescendantAgentTasksUsingIndex(
      this.buildAgentTaskIndex(config),
      workspaceId
    );
  }

  private hasActiveDescendantAgentTasksUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): boolean {
    return hasActiveDescendantAgentTasksUsingIndex(index, workspaceId, (id) =>
      this.aiService.isStreaming(id)
    );
  }

  private listBlockingActiveDescendantAgentTaskIdsUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string,
    options: { excludeWorkflowTasks?: boolean } = {}
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listBlockingActiveDescendantAgentTaskIdsUsingIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const stack: Array<{ taskId: string; workflowOwned: boolean }> = [
      ...(index.childrenByParent.get(workspaceId) ?? []).map((taskId) => ({
        taskId,
        workflowOwned: false,
      })),
    ];
    while (stack.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      const workflowOwned = next.workflowOwned || entry?.workflowTask != null;
      const nonBlockingSubtree =
        this.resolveAgentTaskAttentionPolicy(next.taskId, index) === "notify_on_terminal" ||
        this.waiters.isTaskQueueBackgrounded(next.taskId);
      if (
        !nonBlockingSubtree &&
        entry != null &&
        this.isActiveAgentTaskEntry(entry) &&
        !(options.excludeWorkflowTasks && workflowOwned)
      ) {
        result.push(next.taskId);
      }
      const children = index.childrenByParent.get(next.taskId);
      if (!nonBlockingSubtree && children) {
        for (const child of children) {
          stack.push({ taskId: child, workflowOwned });
        }
      }
    }
    return result;
  }

  /**
   * Topology predicate: does this workspace still have child agent-task nodes in config?
   * Unlike hasActiveDescendantAgentTasks (which checks runtime activity for scheduling),
   * this checks structural tree shape — any child node blocks parent deletion regardless
   * of its status.
   */
  private hasChildAgentTasks(index: AgentTaskIndex, workspaceId: string): boolean {
    return (index.childrenByParent.get(workspaceId)?.length ?? 0) > 0;
  }

  private getTaskDepth(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): number {
    assert(workspaceId.length > 0, "getTaskDepth: workspaceId must be non-empty");

    return this.getTaskDepthFromParentById(
      this.buildAgentTaskIndex(config).parentById,
      workspaceId
    );
  }

  private getTaskDepthFromParentById(parentById: Map<string, string>, workspaceId: string): number {
    let depth = 0;
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      depth += 1;
      current = parent;
    }

    if (depth >= 32) {
      throw new Error(
        `getTaskDepthFromParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
      );
    }

    return depth;
  }

  async maybeStartQueuedTasks(): Promise<void> {
    const existingRun = this.maybeStartQueuedTasksInFlight;
    if (existingRun != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRun;
      return;
    }

    // A foreground task waiter registers itself in waitForAgentReport's async setup. Yield once so
    // immediate scheduler calls from the same turn see that foreground-awaiting state and avoid a
    // nested-task deadlock at maxParallelAgentTasks=1.
    await Promise.resolve();
    const existingRunAfterYield = this.maybeStartQueuedTasksInFlight;
    if (existingRunAfterYield != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRunAfterYield;
      return;
    }

    const run = (async () => {
      do {
        this.maybeStartQueuedTasksRerunRequested = false;
        await this.maybeStartQueuedTasksFromReservations();
      } while (this.maybeStartQueuedTasksRerunRequested);
    })().finally(() => {
      if (this.maybeStartQueuedTasksInFlight === run) {
        this.maybeStartQueuedTasksInFlight = undefined;
      }
    });
    this.maybeStartQueuedTasksInFlight = run;
    await run;
  }

  /**
   * One coalesced drain retry after a refused launch lease. A drain already in flight when it
   * fires reruns (maybeStartQueuedTasksRerunRequested), so the wake is never lost; a retry that is
   * refused again rearms it.
   */
  private armQueuedLaunchLeaseRetry(): void {
    if (this.queuedLaunchLeaseRetryTimer != null || this.workspaceService.isShuttingDown()) return;
    this.queuedLaunchLeaseRetryTimer = setTimeout(() => {
      this.queuedLaunchLeaseRetryTimer = undefined;
      if (this.workspaceService.isShuttingDown()) return;
      this.scheduleMaybeStartQueuedTasks();
    }, QUEUED_LAUNCH_LEASE_RETRY_MS);
    this.queuedLaunchLeaseRetryTimer.unref?.();
  }

  private async maybeStartQueuedTasksFromReservations(): Promise<void> {
    const plans: TaskLaunchPlan[] = [];
    // Each launch takes its plan's lease over (startReservedAgentTask). A throw before the
    // launches below must not leave the leases of the plans collected so far held: their removal
    // would refuse until this process exits.
    await using _unlaunchedLeases = {
      [Symbol.asyncDispose]: async () => {
        for (const plan of plans) {
          const lease = plan.launchLease;
          plan.launchLease = undefined;
          if (lease != null) await releaseLaunchLease(plan.taskId, lease);
        }
      },
    };

    {
      await using _lock = await this.mutex.acquire();

      const opening = await this.openQueuedDrain();
      if (opening.kind === "idle") return;
      const { drain } = opening;
      let reservedSlots = 0;
      for (const task of drain.queuedTasks) {
        if (reservedSlots >= drain.availableSlots) {
          break;
        }
        const reservation = await this.reserveQueuedTaskSlot(task, drain, plans);
        if (reservation === "shutdown") break;
        if (reservation === "reserved") reservedSlots += 1;
      }
    }

    await this.launchReservedPlans(plans);
  }

  /** A config's queued tasks, oldest first. */
  private listQueuedAgentTasks(sourceConfig: ProjectsConfig): AgentTaskWorkspaceEntry[] {
    return this.listAgentTaskWorkspaces(sourceConfig)
      .filter((task) => task.taskStatus === "queued" && typeof task.id === "string")
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aTime - bTime;
      });
  }

  /**
   * The drain's first reads under the mutex: the queued tasks, after a prepass that interrupts
   * the ones whose workflow owner is no longer active (and re-reads the config if it did).
   */
  private async openQueuedDrain(): Promise<QueuedDrainOpening> {
    let config = this.config.loadConfigOrDefault();
    const taskSettings: TaskSettings = config.taskSettings ?? DEFAULT_TASK_SETTINGS;
    let taskIndex = this.buildAgentTaskIndex(config);
    let queuedTasks = this.listQueuedAgentTasks(config);

    let interruptedInactiveWorkflowQueuedTask = false;
    for (const task of queuedTasks) {
      const taskId = task.id;
      assert(taskId != null && taskId.length > 0, "queued task id is required");
      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          taskId,
          config,
          "queued-inactive-workflow-owner-prepass",
          taskIndex,
          { scheduleQueueDrain: false }
        )
      ) {
        interruptedInactiveWorkflowQueuedTask = true;
      }
    }
    if (interruptedInactiveWorkflowQueuedTask) {
      config = this.config.loadConfigOrDefault();
      taskIndex = this.buildAgentTaskIndex(config);
      queuedTasks = this.listQueuedAgentTasks(config);
    }
    return await this.countQueuedDrainSlots(taskSettings, { config, taskIndex }, queuedTasks);
  }

  /**
   * The drain's free slots, from the active tasks and the turn count (which also completes a
   * pending stale-turn sweep). Idle when no task is queued or no slot is free.
   */
  private async countQueuedDrainSlots(
    taskSettings: TaskSettings,
    snapshot: QueuedDrainSnapshot,
    queuedTasks: readonly AgentTaskWorkspaceEntry[]
  ): Promise<QueuedDrainOpening> {
    // Captured before the count reads any turn file: only requests armed before then are swept.
    const staleTurnSweepGeneration = this.staleTurnSweepRequestedGeneration;
    if (
      queuedTasks.length === 0 &&
      staleTurnSweepGeneration === this.staleTurnSweepDoneGeneration
    ) {
      taskQueueDebug("TaskService.maybeStartQueuedTasks no queued tasks", {});
      return { kind: "idle" };
    }
    const activeAgentTasks = this.countActiveAgentTasks(snapshot.config);
    const { count: activeWorkspaceTurns, complete: sweptEveryOwner } =
      await this.getWorkspaceTurnManager().countActiveWorkspaceTurnsInGlobalScan();
    // A count that throws, or a scan that skipped an unreadable owner directory, leaves the
    // request pending so a later drain retries the sweep (empty-queue drains included).
    if (sweptEveryOwner) {
      this.staleTurnSweepDoneGeneration = Math.max(
        this.staleTurnSweepDoneGeneration,
        staleTurnSweepGeneration
      );
    }
    if (queuedTasks.length === 0) return { kind: "idle" };
    const availableSlots = Math.max(
      0,
      taskSettings.maxParallelAgentTasks - (activeAgentTasks + activeWorkspaceTurns)
    );
    taskQueueDebug("TaskService.maybeStartQueuedTasks reservation summary", {
      maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
      availableSlots,
    });
    if (availableSlots === 0) return { kind: "idle" };
    return { kind: "open", drain: { ...snapshot, queuedTasks, availableSlots } };
  }

  /**
   * One queued task of a drain, in queue order: the workflow-owner and stop checks, a task that
   * is already streaming and the launch refusals, then its launch from the parent metadata read.
   */
  private async reserveQueuedTaskSlot(
    task: AgentTaskWorkspaceEntry,
    drain: QueuedDrainSnapshot,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const taskId = task.id;
    assert(taskId != null && taskId.length > 0, "queued task id is required");
    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        taskId,
        drain.config,
        "queued-launch",
        drain.taskIndex,
        { scheduleQueueDrain: false }
      )
    ) {
      return "skipped";
    }

    // Stop-cascade barrier (see startReservedAgentTask): a task whose own or parent's stop
    // latch is held is not even reserved; the latch release rechecks the queue.
    if (
      this.taskStopLatch.deferLaunchWhileStopInProgress(
        taskId,
        coerceNonEmptyString(task.parentWorkspaceId)
      )
    ) {
      return "skipped";
    }

    if (this.aiService.isStreaming(taskId)) {
      await this.setTaskStatus(taskId, "running");
      return "reserved";
    }

    const start = queuedTaskLaunchStart(taskId, task);
    const parent = resolveQueuedTaskParent(task, drain.config);
    if (parent.kind === "refused") {
      await this.markTaskLaunchFailed(taskId, parent.reason);
      return "skipped";
    }

    const configProjectPath = stripTrailingSlashes(task.projectPath);
    const trustRefusal = queuedTaskTrustRefusal(task, configProjectPath, drain.config);
    if (trustRefusal != null) {
      await this.markTaskLaunchFailed(taskId, trustRefusal);
      return "skipped";
    }
    return await this.readQueuedTaskParentMeta(
      { ...parent.parent, taskId, task, start, config: drain.config, configProjectPath },
      plans
    );
  }

  /** Reads the parent's metadata; a failed read falls back to metadata from its config row. */
  private async readQueuedTaskParentMeta(
    candidate: QueuedTaskCandidate,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const { parentWorkspaceId, parentEntry, parentWorkspaceName } = candidate;
    const parentRuntimeProjectPath =
      parentEntry.workspace.kind === "scratch"
        ? parentEntry.workspace.path
        : parentEntry.projectPath;
    const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
    const parentMeta = parentMetaResult.success
      ? parentMetaResult.data
      : ({
          id: parentWorkspaceId,
          name: parentWorkspaceName,
          kind: parentEntry.workspace.kind,
          projectPath: parentRuntimeProjectPath,
          projectName:
            parentEntry.workspace.kind === "scratch"
              ? SCRATCH_PROJECT_NAME
              : (parentEntry.workspace.projects?.find(
                  (project) =>
                    stripTrailingSlashes(project.projectPath) ===
                    stripTrailingSlashes(parentEntry.projectPath)
                )?.projectName ??
                parentEntry.projectPath.split("/").filter(Boolean).at(-1) ??
                parentEntry.projectPath),
          runtimeConfig: candidate.parentRuntimeConfig,
          projects: parentEntry.workspace.projects,
        } satisfies WorkspaceMetadata);
    return await this.resolveQueuedTaskSkipInitHook(
      { ...candidate, parentRuntimeProjectPath, parentMeta },
      plans
    );
  }

  /**
   * Reads the agent's skip_init_hook from the parent's checkout. A read that fails is logged and
   * leaves the init hook on.
   */
  private async resolveQueuedTaskSkipInitHook(
    context: QueuedTaskParentRead,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const { taskId, task, parentEntry, parentWorkspaceName, parentRuntimeProjectPath } = context;
    const agentId = resolveTaskAgentIdForResume(task);
    assert(agentId.length > 0, "queued task agentId is required");
    let skipInitHook = false;
    try {
      const parentRuntime = createRuntimeForWorkspace({
        runtimeConfig: context.parentRuntimeConfig,
        projectPath: parentRuntimeProjectPath,
        name: parentWorkspaceName,
      });
      const parentWorkspacePath =
        coerceNonEmptyString(parentEntry.workspace.path) ??
        parentRuntime.getWorkspacePath(parentRuntimeProjectPath, parentWorkspaceName);
      const frontmatter = await resolveAgentFrontmatter(
        parentRuntime,
        parentWorkspacePath,
        agentId,
        {
          projectPluginsTrusted: isWorkspaceProjectTrustedIn(context.config.projects, {
            kind: parentEntry.workspace.kind,
            projectPath: parentEntry.projectPath,
          }),
          runtimeFactory: nodeRuntimeFactory,
        }
      );
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
    } catch (error: unknown) {
      log.debug("Queued task: failed to resolve skip_init_hook during reservation", {
        taskId,
        agentId,
        error: getErrorMessage(error),
      });
    }
    return await this.requestQueuedTaskLaunch(context, agentId, skipInitHook, plans);
  }

  /** Checks the queued task's own workspace name, then requests its launch with its model. */
  private async requestQueuedTaskLaunch(
    context: QueuedTaskParentRead,
    agentId: string,
    skipInitHook: boolean,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const { taskId, task } = context;
    const workspaceName = coerceNonEmptyString(task.name);
    if (!workspaceName) {
      await this.markTaskLaunchFailed(taskId, "Queued task missing workspace name");
      return "skipped";
    }

    const canonicalModel =
      coerceNonEmptyString(task.aiSettings?.model) ??
      // Gateway-preserving (see resolveTaskAISettings): this lands in the
      // relaunched task's persisted aiSettings.
      normalizeSelectedModel(task.taskModelString ?? defaultModel);
    const createdAt = task.createdAt ?? getIsoNow();
    return await this.leaseQueuedTaskLaunch(
      {
        taskId,
        task,
        start: context.start,
        parentWorkspaceId: context.parentWorkspaceId,
        parentMeta: context.parentMeta,
        agentId,
        workspaceName,
        createdAt,
        taskRuntimeConfig: context.taskRuntimeConfig,
        parentRuntimeConfig: context.parentRuntimeConfig,
        configProjectPath: context.configProjectPath,
        canonicalModel,
        skipInitHook,
      },
      plans
    );
  }

  /** Holds a queued task's launch lease, then claims its launch under it. */
  private async leaseQueuedTaskLaunch(
    request: QueuedTaskLaunchRequest,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const { taskId } = request;
    // The launch lease before the CAS publishes `starting` (see startReservedAgentTask). A
    // removal, archive or rename of the task in progress refuses it: the task stays queued
    // and the drain retries it after a backoff.
    let launchLease: WorkspaceUseLease;
    try {
      launchLease = await workspaceUseLeasesFor(this.config).hold(taskId, "launch");
    } catch (error) {
      // A lease that cannot be written (lock I/O) leaves the task queued too: launching it
      // unleased would let another backend's startup recovery requeue it mid-launch.
      log[error instanceof WorkspaceMutationInProgressError ? "debug" : "warn"](
        "TaskService.maybeStartQueuedTasks: no launch lease; task left queued",
        { taskId, error: getErrorMessage(error) }
      );
      // The gate's release (another backend's above all) schedules no drain: retry.
      this.armQueuedLaunchLeaseRetry();
      return "skipped";
    }
    return await this.claimQueuedTaskLaunch(request, launchLease, plans);
  }

  /**
   * The launch CAS (queued → starting) under the held launch lease. Every exit without a plan
   * releases the lease; a launched task's plan takes it.
   */
  private async claimQueuedTaskLaunch(
    request: QueuedTaskLaunchRequest,
    launchLease: WorkspaceUseLease,
    plans: TaskLaunchPlan[]
  ): Promise<QueuedTaskReservation> {
    const { taskId, start } = request;
    // Exclusive launch CAS (queued → starting): a `queued` entry has never been admitted (the
    // only path back to queued sets the unproven marker), so whichever process commits this
    // transition is the attempt's single owner. The id rotates unless this process's own
    // reservation already owns it; eligibility is read from the fresh row (another process's
    // stale-starting revert can add the marker without changing the id).
    let launch: QueuedLaunchAttempt | undefined;
    let shuttingDown = false;
    try {
      await this.editActiveWorkspaceEntry(taskId, (workspace) => {
        // Once shutdown latched the sessions the launch would only fail against them: the
        // task stays queued for the next start (#4473). Checked inside the CAS so no await
        // separates the check from the reservation.
        if (this.workspaceService.isShuttingDown()) {
          shuttingDown = true;
          return;
        }
        if (
          workspace.taskStatus !== "queued" ||
          workspace.taskAttemptRetiredBy != null ||
          workspace.pendingRemoval != null
        ) {
          return;
        }
        launch = this.moveQueuedRowToStarting(taskId, start, workspace);
      });
    } catch (error) {
      await releaseLaunchLease(taskId, launchLease);
      await this.markTaskLaunchFailed(taskId, getErrorMessage(error));
      return "skipped";
    }
    if (shuttingDown) {
      await releaseLaunchLease(taskId, launchLease);
      log.info("TaskService.maybeStartQueuedTasks: shutdown began; leaving tasks queued");
      return "shutdown";
    }
    if (launch == null) {
      await releaseLaunchLease(taskId, launchLease);
      log.debug("TaskService.maybeStartQueuedTasks: launch CAS lost or attempt retired", {
        taskId,
      });
      return "skipped";
    }
    this.recordQueuedLaunch(request, launch, launchLease, plans);
    return "reserved";
  }

  /**
   * The launch CAS's write on the fresh queued row, run inside its updater: the attempt id (kept
   * only when this process's own reservation owns it), `starting`, and the brief's send id.
   */
  private moveQueuedRowToStarting(
    taskId: string,
    start: TaskLaunchStart,
    workspace: WorkspaceConfigEntry
  ): QueuedLaunchAttempt {
    const owned = this.attemptLedger.ownedAttempt(taskId);
    const attemptId =
      owned?.attemptId != null && owned.attemptId === workspace.taskAttemptId
        ? owned.attemptId
        : newTaskAttemptId();
    workspace.taskAttemptId = attemptId;
    workspace.taskStatus = "starting";
    // This launch's brief id, durable before its send (see TaskLaunchStart).
    if (start.kind === "sendMessage") workspace.taskPromptSendId = start.sendId;
    return { attemptId, receiptEligible: workspace.taskAttemptUnproven !== true };
  }

  /** Publishes a won launch CAS's attempt and collects the task's launch plan. */
  private recordQueuedLaunch(
    request: QueuedTaskLaunchRequest,
    launch: QueuedLaunchAttempt,
    launchLease: WorkspaceUseLease,
    plans: TaskLaunchPlan[]
  ): void {
    const { taskId } = request;
    this.attemptLedger.publishAttemptRotation(taskId, launch.attemptId);
    if (this.attemptLedger.ownedAttempt(taskId)?.attemptId !== launch.attemptId) {
      this.beginOwnedTaskAttempt(taskId, "launch", launch);
    }
    plans.push(this.buildQueuedTaskLaunchPlan(request, launch.attemptId, launchLease));
  }

  /** The launch plan of a queued task whose launch CAS won, from the drain's snapshots. */
  private buildQueuedTaskLaunchPlan(
    request: QueuedTaskLaunchRequest,
    attemptId: string,
    launchLease: WorkspaceUseLease
  ): TaskLaunchPlan {
    const { taskId, task, agentId, workspaceName } = request;
    return {
      taskId,
      parentWorkspaceId: request.parentWorkspaceId,
      parentMeta: request.parentMeta,
      agentId,
      agentType: task.agentType ?? agentId,
      start: request.start,
      title: task.title ?? workspaceName,
      workspaceName,
      createdAt: request.createdAt,
      taskRuntimeConfig: request.taskRuntimeConfig,
      parentRuntimeConfig: request.parentRuntimeConfig,
      configProjectPath: request.configProjectPath,
      workspaceKind: task.kind,
      taskModelString: task.taskModelString ?? defaultModel,
      canonicalModel: request.canonicalModel,
      effectiveThinkingLevel: task.taskThinkingLevel,
      // Durable pro-mode source: the task record's aiSettings (written at
      // creation, kept current by subsequent sends' persistence merge).
      effectiveReasoningMode: coerceOpenAIReasoningMode(task.aiSettings?.reasoningMode),
      skipInitHook: request.skipInitHook,
      preferredTrunkBranch: task.taskTrunkBranch,
      workflowTask: task.workflowTask,
      bestOf: this.getEffectiveTaskGroup(taskId, task),
      attemptId,
      launchLease,
      // A reservation this process owns keeps its cancellation across the queue.
      ...(() => {
        const abortSignal = this.attemptLedger.ownedAttempt(taskId)?.abortSignal;
        return abortSignal != null ? { abortSignal } : {};
      })(),
    };
  }

  /** Starts the reserved launches after the drain released the mutex; a failed one is marked. */
  private async launchReservedPlans(plans: readonly TaskLaunchPlan[]): Promise<void> {
    await Promise.allSettled(
      plans.map(async (plan) => {
        try {
          await this.enqueueReservedTaskLaunch(plan);
        } catch (error: unknown) {
          log.error("Failed to launch dequeued task", { taskId: plan.taskId, error });
          await this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error), plan);
        }
      })
    );
  }

  private async enqueueReservedTaskLaunch(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "enqueueReservedTaskLaunch requires taskId");
    await this.startReservedAgentTask(plan);
  }

  /**
   * Returns whether the status was written. With `onlyFromStatus`, the transition is skipped (and
   * false returned) when the record no longer holds that status — a guarded write for callers
   * racing a Stop that already persisted a terminal status.
   */
  private async setTaskStatus(
    workspaceId: string,
    status: AgentTaskStatus,
    options?: {
      onlyFromStatus?: AgentTaskStatus;
      /** Write only while the row still names this attempt (see rowSupersedes). */
      expectedAttemptId?: AttemptFence;
    }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "setTaskStatus: workspaceId must be non-empty");

    let written = false;
    const update = (workspace: WorkspaceConfigEntry) => {
      written = false;
      if (options?.onlyFromStatus != null && workspace.taskStatus !== options.onlyFromStatus) {
        return;
      }
      if (rowSupersedes(workspace, options?.expectedAttemptId)) return;
      written = true;
      workspace.taskStatus = status;
      if (status === "running") {
        workspace.taskPrompt = undefined;
        workspace.taskPromptSendId = undefined;
      }
      if (status === "interrupted" || status === "reported") markChildGoalPauseOwed(workspace);
    };
    if (ACTIVE_AGENT_TASK_STATUSES.has(status)) {
      await this.editActiveWorkspaceEntry(workspaceId, update);
    } else {
      await this.editWorkspaceEntry(workspaceId, update);
    }
    if (!written) return false;
    if (status === "interrupted" || status === "reported")
      await this.settleChildGoalPause(workspaceId);

    await this.emitWorkspaceMetadata(workspaceId);

    if (status === "running") {
      this.waiters.clearUnpersistedLaunchFailure(workspaceId);
      this.waiters.startPendingStartWaiters(workspaceId);
    }
    return true;
  }

  noteWorkspaceRemoved(workspaceId: string): void {
    this.waiters.clearUnpersistedLaunchFailure(workspaceId);
    // #5334: the stop generations otherwise grow with every workspace ever stopped. Dropping
    // them resets the generation to 0, which keeps the latch sound only because this runs after
    // the workspace left the config: peer-send admission rereads both endpoints from the config
    // and refuses a missing one, and a removed ancestor's descendants were removed before it.
    // Best-effort: a stop handled after this call, or a removal by another backend, can still
    // leave an entry behind.
    this.taskStopLatch.forgetStopEpoch(workspaceId);
    this.workspaceUserStopEpochs.delete(workspaceId);
    // Per-task goal arbitration history (bounded per task, but not across removed tasks).
    this.childGoalArbitratedStreams.delete(workspaceId);
    // Likewise the goal service's per-workspace stream-accounting receipts.
    this.workspaceGoalService?.forgetStreamAccountingReceipts(workspaceId);
  }

  /**
   * Reset interrupt + auto-resume state for a workspace (called when user sends a real message).
   */
  resetAutoResumeCount(workspaceId: string): void {
    assert(workspaceId.length > 0, "resetAutoResumeCount: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.delete(workspaceId);
  }

  /** Mark a parent workspace as hard-interrupted by the user. */
  markParentWorkspaceInterrupted(workspaceId: string): void {
    assert(workspaceId.length > 0, "markParentWorkspaceInterrupted: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.add(workspaceId);
    // Latch the stop: the suppression entry above is level-triggered and cleared by resume, so
    // in-flight peer-send admission also needs the monotonic generation to observe the stop.
    this.bumpWorkspaceStopEpoch(workspaceId);
    this.workspaceUserStopEpochs.set(
      workspaceId,
      (this.workspaceUserStopEpochs.get(workspaceId) ?? 0) + 1
    );
    // A user Stop refuses agent messages that were not admitted yet, including those waiting
    // for a delegated turn: their retry takes a new baseline for the target's stop epoch (see
    // sendTreeMessage), so drop them here rather than let them run after a resume.
    if (this.peerSendParking.dropParked(workspaceId)) {
      log.debug("Dropped peer messages waiting for a delegated turn after a user stop", {
        workspaceId,
      });
    }
  }

  /**
   * Hold the stop-in-progress latch for a hard-interrupted workspace across the ENTIRE hard-stop
   * flow: the caller acquires it synchronously at the request boundary (before awaiting the
   * session interrupt) and releases it only after terminateAllDescendantAgentTasks persisted the
   * descendants' terminal statuses. markParentWorkspaceInterrupted's suppression entry is
   * level-triggered and cleared by the user's next real send, and the cascade's descendant-set
   * latch only exists after the session-interrupt await plus the cascade's mutex acquisition —
   * without this boundary latch, a still-running descendant could admit a peer send in those
   * windows (the ancestor's epoch was bumped BEFORE the send captured its baseline, so it reads
   * clean) and wake a cousin or the root after Stop. Latching the subtree root suffices: peer
   * admission checks the latch on every endpoint's ancestor chain, which contains this
   * workspace for all subtree members.
   */
  latchHardInterruptCascade(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "latchHardInterruptCascade: workspaceId must be non-empty");
    return this.latchWorkspaceStopsInProgress([workspaceId]);
  }

  /**
   * If a preserved descendant task workspace was previously interrupted and the user manually
   * resumes it, restore taskStatus=running so stream-end finalization can proceed normally.
   * Shared-desktop reported tasks also need this durable reservation for direct sends that have
   * no workspace-turn handle. Their original binding is never inferred again on reawakening.
   *
   * A reported child's stopped continuation also needs a fresh attempt, but keeps its completed
   * status: manual follow-ups must not turn a historical report back into an active task.
   * Returns true only when taskStatus changed to running (and needs restoring on send failure).
   */
  async markInterruptedTaskRunning(workspaceId: string): Promise<boolean> {
    const outcome = await this.reawakenInterruptedTask(workspaceId);
    return outcome.kind === "reawakened" && outcome.statusChanged;
  }

  /**
   * markInterruptedTaskRunning with its outcome made explicit (see
   * AgentTaskIntegration.reawakenInterruptedTask): a manual send must tell "nothing to reawaken"
   * from "decided to reawaken and lost the race", and bind to exactly the attempt it committed.
   */
  async reawakenInterruptedTask(workspaceId: string): Promise<TaskReawakenOutcome> {
    assert(workspaceId.length > 0, "reawakenInterruptedTask: workspaceId must be non-empty");
    // Stop-cascade barrier: a resume must not resurrect a task whose stop is still settling.
    if (this.isWorkspaceStopInProgress(workspaceId)) {
      log.debug("markInterruptedTaskRunning refused: a stop is in progress", { workspaceId });
      return { kind: "not-applicable" };
    }

    const admission = this.classifyReawakenAdmission(workspaceId);
    if (admission.kind !== "proceed") {
      return admission;
    }
    const candidate = admission.candidate;
    // Lineage evaluation (receipt read, bounded wait for a closing producer) stays outside the
    // mutex below: it must never hold up task creation or a cascade's Phase A.
    // As in reactivation: the interrupted attempt's goal stays paused (see settleChildGoalPause).
    await this.settleChildGoalPause(workspaceId, { force: true });
    const lineage = await this.evaluateAttemptLineage(workspaceId, candidate.workspace);
    const plan: ReawakenPlan = {
      ...candidate,
      workspaceId,
      lineage,
      attemptId: newTaskAttemptId(),
    };
    const committed = await this.commitReawakenUnderMutex(plan);
    if (committed.kind === "refused") {
      return committed;
    }

    try {
      await this.emitWorkspaceMetadata(workspaceId);
    } finally {
      this.attemptLedger.endReawakening(workspaceId, plan.attemptId);
    }
    return {
      kind: "reawakened",
      attemptId: plan.attemptId,
      statusChanged: !plan.resumeSettledReportedTask,
    };
  }

  /**
   * reawakenInterruptedTask's admission, read from the row at start: not a task, not resumable,
   * retired or being removed ends the call; otherwise the row is a candidate to reawaken.
   */
  private classifyReawakenAdmission(workspaceId: string): ReawakenAdmission {
    const notApplicable = { kind: "not-applicable" } as const;
    const configAtStart = this.config.loadConfigOrDefault();
    const entryAtStart = findWorkspaceEntry(configAtStart, workspaceId);
    if (!entryAtStart?.workspace.parentWorkspaceId) {
      return notApplicable;
    }
    const predecessor = this.readReawakenPredecessor(workspaceId, entryAtStart.workspace);
    if (
      !predecessor.resumeSettledReportedTask &&
      !rowReadsInterruptedForReawaken(entryAtStart.workspace)
    ) {
      return notApplicable;
    }

    if (entryAtStart.workspace.taskAttemptRetiredBy != null) {
      log.info("markInterruptedTaskRunning refused: attempt retired by a workflow claim", {
        workspaceId,
      });
      return notApplicable;
    }
    if (entryAtStart.workspace.pendingRemoval != null) {
      return {
        kind: "refused",
        message: pendingRemovalAdmissionMessage(entryAtStart.workspace.pendingRemoval),
      };
    }
    // From here on this call has decided to reawaken: losing any race below refuses the caller's
    // send instead of letting it bind to whatever attempt the winner published.
    return {
      kind: "proceed",
      candidate: {
        workspace: entryAtStart.workspace,
        ...predecessor,
        // Admission classification: reawaken = new OWNED attempt. Lineage is proven only when the
        // predecessor is settled by this process or by a receipt; the CAS below publishes the
        // fresh id (refusing when the id moved or a claim landed) and decides the marker from the
        // fresh row.
        previousAttemptId: entryAtStart.workspace.taskAttemptId,
        // A Stop that runs to completion while this admission is still evaluating overtakes it:
        // the user's Stop came after this resume began, so the resume must not resurrect the task
        // (a recovery initiated after that Stop is a new decision and proceeds normally).
        stopEpochAtStart: this.getWorkspaceStopEpoch(workspaceId),
      },
    };
  }

  /** The settled-predecessor evidence that decides whether a reported row resumes. */
  private readReawakenPredecessor(
    workspaceId: string,
    workspace: WorkspaceConfigEntry
  ): ReawakenPredecessor {
    const settledPredecessor = this.attemptLedger.attemptSettlement(workspaceId);
    // A parent continuation preserves `reported`; Stop then closes its attempt without changing
    // that status. Explicit manual recovery must rotate the settled identity, not reopen it.
    //
    // The ordinary reported child is the other terminal shape: its report is durable and
    // releaseReportedTaskAttempt dropped the attempt's owner AND its settlement entry, so neither
    // ledger names the task. That attempt is not live in this process — a live one would still be
    // owned (live continuation: continued, not rotated), a closing or stop-closed one would still
    // have its entry (refused below and at the fence) — so a manual follow-up mints a fresh
    // attempt for it exactly as the parent's reactivation does (lineage unproven: no settlement,
    // no receipt), instead of the fence admitting the continuation under the completed id.
    // A reported row written before attempt identities existed (no taskAttemptId) is released
    // the same way — nothing in this process can own or settle an id it never had — so it gets
    // its first, unproven attempt here rather than running as an unfenced pre-identity send.
    const releasedReportedAttempt =
      settledPredecessor == null && !this.attemptLedger.hasOwnedAttempt(workspaceId);
    const resumeSettledReportedTask =
      workspace.taskStatus === "reported" &&
      workspace.taskDesktopOwnerWorkspaceId == null &&
      (settlementNamesRowAttempt(settledPredecessor, workspace.taskAttemptId) ||
        releasedReportedAttempt);
    return { settledPredecessor, releasedReportedAttempt, resumeSettledReportedTask };
  }

  /** reawakenInterruptedTask's critical section; the lock releases when this returns. */
  private async commitReawakenUnderMutex(
    plan: ReawakenPlan
  ): Promise<ReawakenRefusal | { kind: "committed" }> {
    const workspaceId = plan.workspaceId;
    // Critical section: every stop-record capture (beginWorkspaceStop, Phase A of each cascade)
    // runs under this mutex, so between the identity CAS below and the ownership it installs
    // no cascade can observe the fresh id — a Stop either latched before (refused here and in
    // the mutator) or captures the attempt owned, and its release settles exactly that attempt.
    // Ownership follows the committed CAS (as in reactivateInactiveAgentTask): a CAS that
    // loses to a concurrent writer has nothing to roll back. Only the CAS, the row check and
    // the in-memory publish/install run here; the lineage above, the metadata emission and the
    // caller's send stay outside. Lock order: this mutex → desktop admission gate → config
    // edit queue, the order create/createWorkspaceTurn already establish; no event or tree lock
    // is taken inside. No mutex holder reaches this method: launch sends are guarded
    // (admissionStale probe → WorkspaceService skips the user-resume rescue) and workspace-turn
    // sends carry their correlation.
    await using _lock = await this.mutex.acquire();
    if (this.isReawakenOvertaken(plan)) {
      log.debug("markInterruptedTaskRunning refused: overtaken by a stop", { workspaceId });
      return { kind: "refused", message: SEND_ADMISSION_STALE_MESSAGE };
    }
    // A parent's reactivation leaves the status `interrupted` while its fresh attempt launches
    // and runs, so the row alone reads resumable: rotating that live attempt would supersede the
    // continuation and drop its report. The user's send loses and
    // can retry; once the continuation streams, sends queue behind it instead of reaching here.
    if (this.attemptLedger.hasLiveReawakening(workspaceId)) {
      log.debug("markInterruptedTaskRunning refused: another reawakening is live", {
        workspaceId,
      });
      return { kind: "refused", message: TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE };
    }
    let published = false;
    let committedProven = false;
    await this.editActiveWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (!this.rowAdmitsReawaken(ws, plan)) {
          return;
        }

        // Preserve taskPrompt here: interrupted queued tasks store their only initial
        // prompt in config. If send/resume fails, restoreInterruptedTaskAfterResumeFailure
        // must be able to retain that original prompt for inspection/retry.
        if (!plan.resumeSettledReportedTask) ws.taskStatus = "running";
        // A user-initiated resume is a fresh chance: clear the recovery budget so a
        // breaker-tripped task doesn't instantly re-fail on its first recovery prompt.
        delete ws.taskRecoveryAttempts;
        ws.taskAttemptId = plan.attemptId;
        // The marker is only ever added, so one that appeared after the snapshot can only
        // downgrade the proof; a proven admission never carries it.
        committedProven = plan.lineage.proven && ws.taskAttemptUnproven !== true;
        if (!committedProven) ws.taskAttemptUnproven = true;
        published = true;
      },
      { allowMissing: true }
    );

    if (!published) {
      // Nothing was published: the previous attempt (owned or not) stays exactly as it was,
      // and the row moved under this decision (another writer's resume, a stop, a claim).
      return { kind: "refused", message: TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE };
    }
    return this.publishReawakenAttempt(plan, committedProven);
  }

  /**
   * The reported-child decision above rechecks its evidence here: a closure recorded, or an
   * owner installed for the released attempt, during the lineage awaits invalidates it.
   */
  private isReawakenOvertaken(plan: ReawakenPlan): boolean {
    const workspaceId = plan.workspaceId;
    return (
      this.isWorkspaceStopInProgress(workspaceId) ||
      this.getWorkspaceStopEpoch(workspaceId) !== plan.stopEpochAtStart ||
      (plan.resumeSettledReportedTask &&
        (this.attemptLedger.attemptSettlement(workspaceId) !== plan.settledPredecessor ||
          (plan.releasedReportedAttempt && this.attemptLedger.hasOwnedAttempt(workspaceId))))
    );
  }

  /** The CAS's row check, run inside the config edit: the row still reads as the plan saw it. */
  private rowAdmitsReawaken(ws: WorkspaceConfigEntry, plan: ReawakenPlan): boolean {
    // Only descendant task workspaces have task lifecycle status.
    if (!ws.parentWorkspaceId || this.isWorkspaceStopInProgress(plan.workspaceId)) {
      return false;
    }
    if (
      plan.resumeSettledReportedTask
        ? ws.taskStatus !== "reported" || ws.taskDesktopOwnerWorkspaceId != null
        : !rowReadsInterruptedForReawaken(ws)
    ) {
      return false;
    }
    return rowKeepsAttempt(ws, plan.previousAttemptId);
  }

  /** After the CAS: own the fresh attempt only if the durable row still names it. */
  private publishReawakenAttempt(
    plan: ReawakenPlan,
    committedProven: boolean
  ): ReawakenRefusal | { kind: "committed" } {
    const { workspaceId, attemptId } = plan;
    // The row names a new attempt now: the earlier attempt's cached report is not its (#7003).
    this.waiters.deleteCompletedReport(workspaceId);
    // Writers outside this mutex (a reactivation under its own locks, another backend) may have
    // rotated the row again during the commit's own awaits: never publish or own an identity
    // the durable row no longer names — the successor's ownership and closures stay untouched.
    const committedRow = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (committedRow?.workspace.taskAttemptId !== attemptId) {
      log.info("[task-attempt] reawakened attempt superseded before it was owned", {
        workspaceId,
        attemptId,
        current: committedRow?.workspace.taskAttemptId,
      });
      return { kind: "refused", message: TASK_REAWAKEN_LOST_SEND_BLOCKED_MESSAGE };
    }
    this.attemptLedger.publishAttemptRotation(workspaceId, attemptId);
    if (!committedProven) {
      log.info("[task-attempt] reawakened attempt is not receipt-eligible", {
        workspaceId,
        attemptId,
        reason: plan.lineage.proven
          ? "unproven marker appeared before the CAS"
          : plan.lineage.reason,
      });
    }
    this.beginOwnedTaskAttempt(workspaceId, "reawaken", {
      attemptId,
      receiptEligible: committedProven,
    });
    // Live until the caller's send binds to it (its admission is the evidence after that).
    this.attemptLedger.beginReawakening(workspaceId, attemptId);
    return { kind: "committed" };
  }

  /**
   * Revert a pre-stream interrupted->running transition when send/resume fails to start
   * or complete. This preserves fail-fast interrupted semantics for task_await.
   *
   * The reawakened attempt this process owns (`expectedAttemptId`) ends here too (#4310): it is
   * closed to sends together with the revert and settled once no execution of it can still
   * publish (recheckResumeFailureSettlement). Without that, readAttemptOutcome stayed
   * indeterminate and every retry inherited an unproven lineage.
   */
  async restoreInterruptedTaskAfterResumeFailure(
    workspaceId: string,
    previousStatus?: AgentTaskStatus | null,
    expectedAttemptId?: string
  ): Promise<void> {
    assert(
      workspaceId.length > 0,
      "restoreInterruptedTaskAfterResumeFailure: workspaceId must be non-empty"
    );

    // Captured before the awaited write: only the exact attempt the failed send was bound to,
    // and only while this process owns it, is ended here.
    const ownedAttempt = this.attemptLedger.ownedAttempt(workspaceId);
    let revertedToInterrupted = false;
    let revertedOwnedAttempt = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (!ws.parentWorkspaceId) {
          return;
        }
        if (ws.taskStatus !== "running") {
          return;
        }
        // A stale resume's rollback never flips a successor another writer admitted since.
        if (rowSupersedes(ws, expectedAttemptId)) {
          return;
        }

        parentWorkspaceId = ws.parentWorkspaceId;
        ws.taskStatus = previousStatus === "reported" ? "reported" : "interrupted";
        markChildGoalPauseOwed(ws);
        if (previousStatus !== "reported") ws.reportedAt = undefined;
        revertedToInterrupted = true;
        revertedOwnedAttempt =
          expectedAttemptId != null &&
          ws.taskAttemptId === expectedAttemptId &&
          ownedAttempt?.attemptId === expectedAttemptId;
      },
      { allowMissing: true }
    );
    // Closed only once the revert is durable: a write that rejects leaves the attempt running
    // and open, exactly as before. A send admitted between the write and this closure stays an
    // obligation of the attempt, which the settlement boundary below waits for.
    let closedAttempt: (OwnedTaskAttempt & { attemptId: string }) | undefined;
    if (
      revertedOwnedAttempt &&
      expectedAttemptId != null &&
      ownedAttempt != null &&
      this.attemptLedger.ownedAttempt(workspaceId) === ownedAttempt
    ) {
      this.closeAttemptAdmission(workspaceId, expectedAttemptId, ownedAttempt, "resume-failed");
      // Identity is what later checks compare; its attemptId was checked to be a string.
      closedAttempt = ownedAttempt as OwnedTaskAttempt & { attemptId: string };
    }

    if (!revertedToInterrupted) {
      return;
    }

    this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    if (closedAttempt != null) {
      this.attemptLedger.recordResumeFailureSettlement(workspaceId, closedAttempt);
      this.attemptLedger.recheckResumeFailureSettlement(workspaceId);
    }
    if (revertedToInterrupted) await this.settleChildGoalPause(workspaceId);
    await this.emitWorkspaceMetadata(workspaceId);
  }

  private buildTaskCompletionRecoveryMessage(
    completionKind: "final_response" | "propose_plan",
    requiresStructuredOutput: boolean,
    options?: {
      reason?: "startup" | "stream_end" | "error";
      error?: Pick<ErrorEvent, "error" | "errorType">;
      structuredOutputDiagnostic?: string;
    }
  ): string {
    const completionLabel =
      completionKind === "propose_plan" ? "propose_plan" : "final assistant response";
    const completionInstruction = getTaskCompletionInstruction({
      completionKind,
      requiresStructuredOutput,
    });
    const noExtraWorkInstruction =
      completionKind === "propose_plan"
        ? "Do not continue planning or call other tools."
        : requiresStructuredOutput
          ? "Do not continue investigating or call tools other than agent_report."
          : "Do not continue investigating or call other tools.";

    switch (options?.reason) {
      case "startup":
        return `This task is awaiting its ${completionLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
      case "error": {
        const errorType = options.error?.errorType
          ? ` (last error: ${options.error.errorType})`
          : "";
        // Only the schema validator's own diagnostic is echoed to the model, bounded to one
        // line; arbitrary provider error text never enters the prompt.
        const diagnostic =
          options.structuredOutputDiagnostic != null
            ? ` ${truncateSingleLine(options.structuredOutputDiagnostic, TASK_RECOVERY_DIAGNOSTIC_MAX_CHARS)}`
            : "";
        return `The previous ${completionLabel} attempt failed${errorType}.${diagnostic} ${noExtraWorkInstruction} ${completionInstruction}`;
      }
      case "stream_end":
      default:
        return `Your stream ended without a ${completionLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
    }
  }

  private async promptTaskForRequiredCompletionTool(
    workspaceId: string,
    options: CompletionPromptOptions
  ): Promise<boolean> {
    assert(
      workspaceId.length > 0,
      "promptTaskForRequiredCompletionTool: workspaceId must be non-empty"
    );
    const fence = options?.fence;
    // Token ownership: this method owns the caller's fence from entry until the handoff to
    // workspaceService.sendMessage. Every exit before that handoff — a return OR a throw from one
    // of the awaits — disposes it (finally below): a pending obligation nobody holds would keep
    // the attempt's stop cascade waiting on it for good. From the handoff on the token is
    // WorkspaceService.sendMessage's (its scoped disposal covers refusal and throw; the queue owns
    // an enqueued token, the session an admitted one) and is never disposed here.
    const state: CompletionPromptFenceState = { disposition: "refused" };
    try {
      const cfg = this.config.loadConfigOrDefault();
      const entry = findAwaitingReportTaskEntry(cfg, workspaceId);
      if (entry == null) {
        return withoutSend(state, false);
      }
      // `return await`, never a bare return: the finally must run after the steps settle, so it
      // sees the hand-off the send step records and leaves the token to the send.
      return await this.promptUnblockedAwaitingReportTask(
        { workspaceId, options, fence, entry, state },
        cfg
      );
    } finally {
      if (state.disposition !== "handed-off") fence?.turnAdmission.onDisposed(state.disposition);
    }
  }

  /**
   * Skips a task whose workflow owner is gone (and interrupts it), that has active owned work, or
   * that is already streaming. Otherwise prompts it.
   */
  private async promptUnblockedAwaitingReportTask(
    request: CompletionPromptRequest,
    cfg: ProjectsConfig
  ): Promise<boolean> {
    const { workspaceId, options, state } = request;
    const taskIndex = this.buildAgentTaskIndex(cfg);
    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        `completion-tool-${options?.reason ?? "unknown"}`,
        taskIndex
      )
    ) {
      return withoutSend(state, false);
    }
    if (await this.hasActiveTaskOwnedWork(workspaceId, taskIndex)) {
      return withoutSend(state, false);
    }
    if (this.aiService.isStreaming(workspaceId)) {
      return withoutSend(state, true);
    }
    return await this.promptForTaskCompletionKind(request);
  }

  /** Reads the completion the task owes, then fails it at the recovery limit or prompts it. */
  private async promptForTaskCompletionKind(request: CompletionPromptRequest): Promise<boolean> {
    const { workspaceId, entry } = request;
    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);
    const completionKind = isPlanLike ? "propose_plan" : "final_response";
    const requiresStructuredOutput =
      entry.workspace.workflowTask?.outputSchema !== undefined &&
      !(await this.shouldAllowLegacyInvalidWorkflowOutputSchema(workspaceId, entry));
    const plan: CompletionPromptPlan = { ...request, completionKind, requiresStructuredOutput };

    // Persisted circuit breaker: a task that keeps consuming recovery prompts
    // without ever completing is stuck (repeated empty output, repeated
    // length-truncated turns, or a model that never calls its completion
    // tool). Interrupt it with a descriptive error instead of prompting
    // forever. The counter lives on the workspace entry so restart loops stay
    // bounded too; finalizeAgentTaskReport clears it on success.
    const recoveryAttempts = entry.workspace.taskRecoveryAttempts ?? 0;
    if (recoveryAttempts >= MAX_TASK_RECOVERY_ATTEMPTS) {
      return await this.interruptTaskOverRecoveryBudget(plan, recoveryAttempts);
    }
    return await this.chargeRecoveryAttemptAndPrompt(plan);
  }

  /** Fails a task that used up its recovery budget, unless its fence went stale meanwhile. */
  private async interruptTaskOverRecoveryBudget(
    plan: CompletionPromptPlan,
    recoveryAttempts: number
  ): Promise<boolean> {
    const { workspaceId, entry, options, fence, state } = plan;
    const errorMessage = recoveryLimitErrorMessage(plan.completionKind, options?.error);
    log.error("Task exceeded its recovery attempt budget; interrupting task", {
      workspaceId,
      taskName: entry.workspace.name,
      recoveryAttempts,
      limit: MAX_TASK_RECOVERY_ATTEMPTS,
      reason: options?.reason,
    });
    // A fenced prompt's attempt is not this process's to end: the earlier awaits may have let
    // another writer take the row (the terminal failure would otherwise decide their attempt).
    if (fence?.turnAdmission.admissionStale() === true) {
      return withoutSend(state, false);
    }
    // The check above is one-shot: another backend can still take the row before the
    // failure's own reads and write, so the failure itself is bound to the fenced attempt.
    await this.failAgentTaskTerminally(
      workspaceId,
      entry,
      { errorType: "task_recovery_limit", errorMessage },
      { expectedAttemptId: fence?.attemptId ?? options.expectedAttemptId }
    );
    return withoutSend(state, false);
  }

  /** Charges a prompt's recovery budget on its attempt, then sends the prompt. */
  private async chargeRecoveryAttemptAndPrompt(plan: CompletionPromptPlan): Promise<boolean> {
    const { workspaceId, options, fence } = plan;
    // Consume budget before sending so a crash mid-send still counts the attempt.
    // Read the fresh value inside the mutator (not the entry-time snapshot in plan.entry)
    // so concurrent edits cannot lose an increment. A fenced prompt charges only the attempt it
    // was decided for: a row another writer re-admitted meanwhile is theirs (no write, no send).
    let fenceSuperseded = false;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (
          (fence != null && ws.taskAttemptId !== fence.attemptId) ||
          rowSupersedes(ws, options?.expectedAttemptId)
        ) {
          fenceSuperseded = true;
          return;
        }
        ws.taskRecoveryAttempts = (ws.taskRecoveryAttempts ?? 0) + 1;
      },
      { allowMissing: true }
    );
    // Sync from here to the send's handoff: the binding and the send run in this tick.
    const prepared = this.prepareCompletionPromptSend(plan, fenceSuperseded);
    if (prepared.kind === "refused") return withoutSend(plan.state, false);
    return await this.sendCompletionPrompt(plan, prepared.send);
  }

  /**
   * Refuses a prompt decided for a superseded attempt or one whose binding is refused. Otherwise
   * builds its send: the task-pinned send options, the recovery message and the token it rides.
   */
  private prepareCompletionPromptSend(
    plan: CompletionPromptPlan,
    fenceSuperseded: boolean
  ): { kind: "refused" } | { kind: "send"; send: CompletionPromptSend } {
    const { workspaceId, options, fence } = plan;
    if (fenceSuperseded || fence?.turnAdmission.admissionStale() === true) {
      log.info("[task-attempt] completion prompt refused: decided for a superseded attempt", {
        workspaceId,
        reason: options?.reason,
      });
      return { kind: "refused" };
    }

    const taskTurnSendOptions = buildTaskTurnSendOptions(plan.entry.workspace);
    const startedAt = Date.now();
    const recoveryMessage = this.buildTaskCompletionRecoveryMessage(
      plan.completionKind,
      plan.requiresStructuredOutput,
      options
    );
    const binding = this.bindCompletionPromptToken(plan);
    if (binding.kind === "stale") return { kind: "refused" };
    return {
      kind: "send",
      send: { taskTurnSendOptions, startedAt, recoveryMessage, sendToken: binding.token },
    };
  }

  /** The token a prompt's send rides, or stale when the decided attempt refuses the binding. */
  private bindCompletionPromptToken(
    plan: CompletionPromptPlan
  ): { kind: "stale" } | { kind: "bound"; token: TurnAdmissionToken | undefined } {
    const { workspaceId, options, fence } = plan;
    // Admission classification: recovery prompt = same-attempt continuation (no rotation). A
    // fenced one rides the caller's token as its obligation and staleness probe (the handoff then
    // mints none of its own — see WorkspaceService.sendMessage). A prompt decided for one attempt
    // (expectedAttemptId) is bound to that attempt here, synchronously before the handoff: left
    // to the handoff it would bind to whichever attempt holds the row then, e.g. a successor
    // another backend admitted after the budget CAS (#4414).
    let sendToken = fence?.turnAdmission;
    if (fence == null && options.expectedAttemptId != null) {
      const admission = this.admitTaskWorkspaceTurn(workspaceId, {
        acceptanceOrigin: "automatic",
        expectedAttemptId: options.expectedAttemptId,
      });
      // An expected attempt makes the row a task with that id, so anything but an admission
      // (refused, or an impossible not-a-task) means the decision is stale: no prompt.
      if (admission.kind !== "admitted") return { kind: "stale" };
      sendToken = admission.token;
    }
    return { kind: "bound", token: sendToken };
  }

  /** Hands the prompt and its token to WorkspaceService.sendMessage, then logs the result. */
  private async sendCompletionPrompt(
    plan: CompletionPromptPlan,
    send: CompletionPromptSend
  ): Promise<boolean> {
    const { workspaceId, options, state } = plan;
    const { sendToken } = send;
    state.disposition = "handed-off";
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      send.recoveryMessage,
      {
        ...send.taskTurnSendOptions,
        ...(plan.completionKind === "propose_plan"
          ? { toolPolicy: [{ regex_match: "^propose_plan$", action: "require" as const }] }
          : {}),
        // A tool-end prompt would cut the child's next turn after one step and re-enter this
        // path (observed recovery loop); wait for the turn to end instead.
        queueDispatchMode: "turn-end",
      },
      {
        acceptanceOrigin: "automatic",
        synthetic: true,
        agentInitiated: true,
        taskTurnKind: "required_report",
        queueDedupeKey: taskRecoveryPromptDedupeKey(workspaceId, "completion"),
        removableQueueDedupeKey: true,
        // Startup recovery gates the server listener: return once the prompt is accepted and
        // let stream startup (runtime readiness, MCP, model) continue in the background.
        startStreamInBackground: options?.reason === "startup",
        ...(sendToken != null
          ? {
              turnAdmission: sendToken,
              admissionStale: () => sendToken.admissionStale(),
            }
          : {}),
      }
    );
    return logCompletionPromptResult(plan, send, sendResult);
  }

  private async promptTaskForBackgroundAwait(
    workspaceId: string,
    params: { taskIds: string[]; workflowRunIds: string[] }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "promptTaskForBackgroundAwait requires workspaceId");
    assert(
      params.taskIds.length > 0 || params.workflowRunIds.length > 0,
      "promptTaskForBackgroundAwait requires at least one awaitable target"
    );

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return false;
    }

    const model = entry.workspace.taskModelString ?? defaultModel;
    const agentId = entry.workspace.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;
    // Admission classification: recovery prompt = same-attempt continuation (no rotation).
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      buildBackgroundAwaitPrompt(params),
      {
        model,
        agentId,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        reasoningMode: coerceOpenAIReasoningMode(entry.workspace.aiSettings?.reasoningMode),
        serviceTier: ServiceTierSchema.safeParse(
          resolveWorkspaceAISettings(entry.workspace, agentId)?.serviceTier
        ).data,
      },
      {
        acceptanceOrigin: "automatic",
        synthetic: true,
        agentInitiated: true,
        taskTurnKind: "recovery",
      }
    );
    if (!sendResult.success) {
      log.error("Failed to prompt task for active background awaitables", {
        workspaceId,
        taskName: entry.workspace.name,
        taskIds: params.taskIds,
        workflowRunIds: params.workflowRunIds,
        model,
        agentId,
        error: sendResult.error,
      });
      return false;
    }
    return true;
  }

  private async handleStreamEnd(
    event: StreamEndEvent,
    // Both are captured by the stream-end listener in the event's own tick, before it waits on
    // the workspace event lock: cut attribution and the task origin must reflect the state at the
    // ended stream's own event, not whatever input engaged while the lock wait or the awaits
    // below ran (see QueueCutAttributionSnapshot).
    queueCutSnapshot: QueueCutAttributionSnapshot,
    taskOrigin: StreamEndTaskOrigin
  ): Promise<"deferred" | undefined> {
    const isCompaction = event.metadata.agentId === "compact" || event.metadata.mode === "compact";
    // AgentSession resolves true only after a durable compaction follow-up is accepted. Bare,
    // rejected, and failed-to-dispatch compactions remain on the normal child recovery path.
    if (
      isCompaction &&
      (await this.workspaceService.waitForPendingCompactionCompletionDecision(
        event.workspaceId,
        event.messageId
      )) === true
    ) {
      // Compaction already transferred completion to its durable follow-up.
      this.discardCutReceipt(event);
      return;
    }

    // Ensure any in-flight notify_on_terminal persistence (from a just-detached foreground wait)
    // has settled so the config we read below reflects the durable non-blocking policy.
    const notifyOnTerminalPersists = this.terminalAttention.inFlightNotifyOnTerminalPersists();
    if (notifyOnTerminalPersists.length > 0) {
      await Promise.all(notifyOnTerminalPersists);
    }

    const admission = this.admitStreamEnd(event, taskOrigin);
    if (admission == null) return;

    // Parent workspaces must not end while they have active background tasks/workflows.
    // Enforce by auto-resuming the stream with a directive to await outstanding work.
    if (!admission.entry.workspace.parentWorkspaceId) {
      await this.resumeParentStreamEnd(event, queueCutSnapshot, admission);
      return;
    }
    return this.finalizeChildStreamEndTurn({
      ...admission,
      event,
      queueCutSnapshot,
      taskOrigin,
      isCompaction,
    });
  }

  /** True when the stream end's task execution or stop epoch moved on since the event. */
  private cutSourceIsObsolete(event: StreamEndEvent, taskOrigin: StreamEndTaskOrigin): boolean {
    return (
      taskOrigin.executionId !== this.getAgentTaskExecutionId(event.workspaceId) ||
      taskOrigin.stopEpoch !== this.getWorkspaceStopEpoch(event.workspaceId)
    );
  }

  /** Drops the queue-cut receipt of the continuation that cut this stream, if one did. */
  private discardCutReceipt(event: StreamEndEvent): void {
    const entryId = continuationEntryIdOfStopCause(event.metadata.stopCause);
    if (entryId == null) return;
    this.workspaceService.disposeQueueCut(event.workspaceId, entryId);
    this.workspaceService.markQueueCutSourceHandled(event.workspaceId, entryId);
  }

  /**
   * Reads the config once for a stream end. Undefined ends handleStreamEnd: the workspace is gone,
   * or another writer superseded the task attempt the stream ran under.
   */
  private admitStreamEnd(
    event: StreamEndEvent,
    taskOrigin: StreamEndTaskOrigin
  ): StreamEndAdmission | undefined {
    const workspaceId = event.workspaceId;

    // The owner's own stream ending is the signal to retry any terminal wake-ups that were deferred
    // while it was busy. Drain checks idle internally and leaves notifications pending otherwise.
    this.scheduleTerminalAttentionDrain(workspaceId);

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    // Only child recovery consumes receipts. Parent/workspace-turn settlement uses its own
    // attribution snapshot; retaining its receipts would grow the session map on every cut.
    if (!entry?.workspace.parentWorkspaceId) this.discardCutReceipt(event);
    if (!entry) return undefined;
    // The attempt this stream ran under, owned or not, captured at the event. A stream whose row
    // another writer re-admitted meanwhile (A → B, e.g. a second backend) ends A alone: nothing
    // below may run for B — no report publication, status write or recovery prompt — and A's
    // decision resolves in the listener's finally (its held entries then meet the stale attempt
    // at their own gates). Ownership stays untouched. The check is repeated as a CAS by every
    // status write below (streamAttemptId), since this one precedes the handler's awaits.
    const streamAttemptId: AttemptFence =
      (taskOrigin.ownedAttempt != null
        ? taskOrigin.ownedAttempt.attemptId
        : taskOrigin.unownedAttemptId) ?? null;
    if (entry.workspace.parentWorkspaceId && rowSupersedes(entry.workspace, streamAttemptId)) {
      log.info("[task-attempt] stream end ignored: its attempt was superseded by another writer", {
        workspaceId,
        attemptId: streamAttemptId,
        messageId: event.messageId,
      });
      this.discardCutReceipt(event);
      return undefined;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);
    return { workspaceId, cfg, entry, streamAttemptId, taskIndex };
  }

  /**
   * A parent (root) stream end: settles when no background work blocks the parent, else
   * auto-resumes it with a prompt to await that work.
   *
   * The parent steps run as a chain: resumeParentStreamEnd → holdOrSettleParentStreamEnd →
   * recheckParentBlockersBeforeResume → sendParentBackgroundAwaitPrompt (→
   * retryParentPromptWhenBusy). Each step starts the next one in the same tick as its own last
   * await, so no collaborator call, counter write or settle runs a microtask later than it did
   * in the inline code; only the handler's own resolution comes later.
   */
  private async resumeParentStreamEnd(
    event: StreamEndEvent,
    queueCutSnapshot: QueueCutAttributionSnapshot,
    admission: StreamEndAdmission
  ): Promise<void> {
    const { workspaceId, taskIndex } = admission;
    const ctx: ParentStreamEndContext = {
      event,
      queueCutSnapshot,
      workspaceId,
      entry: admission.entry,
      taskIndex,
    };
    const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(
      taskIndex,
      workspaceId
    );
    const referencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
      workspaceId,
      event.parts,
      event.messageId
    );
    const activeWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
      workspaceId,
      referencedWorkflowRunIds
    );
    const activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    if (!hasActiveDescendants) {
      // Foreground best-of children can finish while the parent task tool call is still pending,
      // which temporarily blocks their leaf cleanup and may defer synthetic fallback delivery.
      // Recheck both once the parent stream reaches a descendant-free stream-end.
      await this.deliverDeferredBestOfReportsForParent(workspaceId);
      await this.requestReportedChildCleanupRechecks(workspaceId);
      if (activeWorkflowRunIds.length === 0 && activeWorkspaceTurnIds.length === 0) {
        if (
          await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
            event,
            queueCutSnapshot
          )
        ) {
          return;
        }
        this.consecutiveAutoResumes.delete(workspaceId);
        return;
      }
    }

    // Workflow-owned descendants report through the workflow runner; parent nudges must not
    // bypass that journal/final-result path by asking the model to task_await those child tasks
    // directly. Instead, await the owning workflow run when one is still active.
    // Foreground waits can also be backgrounded at runtime when users queue another message.
    const activeTaskIds = this.listParentActiveTaskIds(ctx, activeWorkspaceTurnIds);
    const queueBackgroundedTaskIds = new Set(
      activeTaskIds.filter((id) => this.waiters.isTaskQueueBackgrounded(id))
    );
    // Durable `notify_on_terminal` work is non-blocking: it never forces the parent to
    // task_await and is not consumed at stream-end. Agent-task policy is applied by
    // listParentActiveTaskIds, which also suppresses descendants below a notify child;
    // workspace-turn policy comes from the handle record.
    const notifyOnTerminalTaskIds = new Set<string>();
    const blockingWorkspaceTurnIds = new Set(
      await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
        workspaceId,
        activeWorkspaceTurnIds
      )
    );
    for (const handleId of activeWorkspaceTurnIds) {
      if (!blockingWorkspaceTurnIds.has(handleId)) {
        notifyOnTerminalTaskIds.add(handleId);
      }
    }
    const blockingTaskIds = filterParentBlockingTaskIds(
      activeTaskIds,
      queueBackgroundedTaskIds,
      notifyOnTerminalTaskIds
    );
    const blockingWorkflowRunIds = await this.listBlockingWorkflowRunIds(
      workspaceId,
      activeWorkflowRunIds
    );
    return this.holdOrSettleParentStreamEnd({
      ...ctx,
      queueBackgroundedTaskIds,
      notifyOnTerminalTaskIds,
      activeTaskIds,
      blockingTaskIds,
      activeWorkflowRunIds: blockingWorkflowRunIds,
      activeWorkspaceTurnIds,
    });
  }

  /** The parent's blocking descendant tasks (workflow-owned ones excluded) and workspace turns. */
  private listParentActiveTaskIds(
    ctx: ParentStreamEndContext,
    activeWorkspaceTurnIds: readonly string[]
  ): string[] {
    return [
      ...this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(ctx.taskIndex, ctx.workspaceId, {
        excludeWorkflowTasks: true,
      }),
      ...activeWorkspaceTurnIds,
    ];
  }

  /** Only the queue-backgrounded one-shot exemption is consumed; durable notify policy stays. */
  private consumeParentQueueBackgroundedExemptions(state: ParentStreamEndState): void {
    for (const taskId of new Set([...state.activeTaskIds, ...state.queueBackgroundedTaskIds])) {
      this.markTaskForegroundRelevant(taskId);
    }
  }

  /**
   * Settles a parent that nothing blocks, else marks its workspace turn's stream end deferred and
   * holds the auto-resume while the parent streams, was hard-interrupted or has a turn queued.
   */
  private async holdOrSettleParentStreamEnd(state: ParentStreamEndState): Promise<void> {
    const { event, workspaceId } = state;
    if (state.blockingTaskIds.length === 0 && state.activeWorkflowRunIds.length === 0) {
      if (
        await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
          event,
          state.queueCutSnapshot
        )
      ) {
        return;
      }
      this.consecutiveAutoResumes.delete(workspaceId);
      this.consumeParentQueueBackgroundedExemptions(state);
      log.debug("Skipping parent auto-resume: all active descendants were queue-backgrounded", {
        workspaceId,
      });
      return;
    }

    await this.getWorkspaceTurnManager().markWorkspaceTurnStreamEndDeferred(event);

    if (this.aiService.isStreaming(workspaceId)) {
      return;
    }

    if (this.interruptedParentWorkspaceIds.has(workspaceId)) {
      log.debug("Skipping parent auto-resume after hard interrupt", { workspaceId });
      return;
    }

    // If the parent already has a follow-up turn queued or starting (for example, the user
    // interrupted with new context), do not inject a synthetic task_await warning mid-handoff.
    if (this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)) {
      this.consumeParentQueueBackgroundedExemptions(state);
      log.debug("Skipping parent auto-resume: follow-up turn already queued or preparing", {
        workspaceId,
      });
      return;
    }
    return this.recheckParentBlockersBeforeResume(state);
  }

  /**
   * Resolves the auto-resume options, then rechecks the parent's blockers: it settles when they
   * have finished meanwhile, skips the resume when the parent is no longer idle, and else takes
   * one auto-resume from the flood budget.
   */
  private async recheckParentBlockersBeforeResume(state: ParentStreamEndState): Promise<void> {
    const { workspaceId } = state;
    const resumeOptions = await this.resolveParentAutoResumeOptions(
      workspaceId,
      state.entry,
      defaultModel,
      state.event.metadata
    );

    state.activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    this.relistParentBlockingTaskIds(state);
    state.activeWorkflowRunIds = await this.listBlockingWorkflowRunIds(
      workspaceId,
      await this.listActiveBackgroundWorkflowRunIds(workspaceId, state.activeWorkflowRunIds)
    );
    if (state.blockingTaskIds.length === 0 && state.activeWorkflowRunIds.length === 0) {
      await this.settleClearedParentStreamEnd(state);
      return;
    }
    if (
      this.aiService.isStreaming(workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
    ) {
      this.consumeParentQueueBackgroundedExemptions(state);
      log.debug("Skipping parent auto-resume: workspace is no longer idle", { workspaceId });
      return;
    }

    const budget = this.consumeParentAutoResumeBudget(state);
    if (budget.kind === "spent") return;
    return this.sendParentBackgroundAwaitPrompt(state, resumeOptions, budget.resumeCount);
  }

  /** Recomputes the parent's active and blocking task ids from its re-listed workspace turns. */
  private relistParentBlockingTaskIds(state: ParentStreamEndState): void {
    state.activeTaskIds = this.listParentActiveTaskIds(state, state.activeWorkspaceTurnIds);
    state.blockingTaskIds = filterParentBlockingTaskIds(
      state.activeTaskIds,
      state.queueBackgroundedTaskIds,
      state.notifyOnTerminalTaskIds
    );
  }

  /** Settles a parent whose blockers finished during its own checks. */
  private async settleClearedParentStreamEnd(state: ParentStreamEndState): Promise<void> {
    if (
      await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
        state.event,
        state.queueCutSnapshot
      )
    ) {
      return;
    }
    this.consecutiveAutoResumes.delete(state.workspaceId);
    this.consumeParentQueueBackgroundedExemptions(state);
  }

  /** Takes one auto-resume from the parent's flood budget, unless the budget is spent. */
  private consumeParentAutoResumeBudget(
    state: ParentStreamEndState
  ): { kind: "spent" } | { kind: "taken"; resumeCount: number } {
    const { workspaceId } = state;
    // Check for auto-resume flood protection after the final active-work recheck so stale
    // workflow completions do not consume the retry budget.
    const resumeCount = this.consecutiveAutoResumes.get(workspaceId) ?? 0;
    if (resumeCount >= MAX_CONSECUTIVE_PARENT_AUTO_RESUMES) {
      this.consumeParentQueueBackgroundedExemptions(state);
      log.warn("Auto-resume limit reached for parent workspace with active background work", {
        workspaceId,
        resumeCount,
        activeTaskIds: state.blockingTaskIds,
        activeWorkflowRunIds: state.activeWorkflowRunIds,
        limit: MAX_CONSECUTIVE_PARENT_AUTO_RESUMES,
      });
      return { kind: "spent" };
    }
    this.consecutiveAutoResumes.set(workspaceId, resumeCount + 1);
    return { kind: "taken", resumeCount };
  }

  /**
   * Sends the parent the prompt to await its blocking work, idle only. A send that lost to a busy
   * workspace goes to retryParentPromptWhenBusy.
   */
  private async sendParentBackgroundAwaitPrompt(
    state: ParentStreamEndState,
    resumeOptions: ParentAutoResumeOptions,
    resumeCount: number
  ): Promise<void> {
    const prompt = buildBackgroundAwaitPrompt({
      taskIds: state.blockingTaskIds,
      workflowRunIds: state.activeWorkflowRunIds,
    });
    const workspaceTurnMuxMetadata =
      this.getWorkspaceTurnManager().resolveWorkspaceTurnMuxMetadataForStreamEnd(state.event);
    const sendOptions: SendMessageOptions = {
      model: resumeOptions.model,
      agentId: resumeOptions.agentId,
      thinkingLevel: resumeOptions.thinkingLevel,
      reasoningMode: resumeOptions.reasoningMode,
      serviceTier: resumeOptions.serviceTier,
      ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    };
    // Admission classification: in-owner auto-resume continues the same attempt (no rotation).
    const sendResult = await this.workspaceService.sendMessage(
      state.workspaceId,
      prompt,
      sendOptions,
      // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
      {
        acceptanceOrigin: "automatic",
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
        requireIdle: true,
      }
    );
    if (!sendResult.success && isWorkspaceBusyIdleOnlySend(sendResult.error)) {
      return this.retryParentPromptWhenBusy(state, sendOptions, resumeCount);
    }
    this.finishParentBackgroundAwait(state, sendResult, resumeCount);
  }

  /**
   * The idle-only send lost to a busy workspace: rechecks the blockers, then queues the prompt
   * unless they finished or the parent got a turn meanwhile.
   */
  private async retryParentPromptWhenBusy(
    state: ParentStreamEndState,
    sendOptions: SendMessageOptions,
    resumeCount: number
  ): Promise<void> {
    const { workspaceId } = state;
    state.activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    this.relistParentBlockingTaskIds(state);
    state.activeWorkflowRunIds = await this.listBlockingWorkflowRunIds(
      workspaceId,
      await this.listActiveBackgroundWorkflowRunIds(workspaceId, state.activeWorkflowRunIds)
    );
    if (state.blockingTaskIds.length === 0 && state.activeWorkflowRunIds.length === 0) {
      await this.settleClearedParentStreamEnd(state);
      return;
    }
    if (
      this.aiService.isStreaming(workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
    ) {
      this.restoreParentAutoResumeCount(workspaceId, resumeCount);
      this.consumeParentQueueBackgroundedExemptions(state);
      log.debug("Skipping parent auto-resume fallback: workspace is no longer idle", {
        workspaceId,
      });
      return;
    }

    // AgentSession can still be in COMPLETING when StreamManager has emitted stream-end.
    // Queue this nudge rather than dropping the only await prompt for active background work.
    // Admission classification: same-attempt continuation (fenced at the handoff, no rotation).
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      buildBackgroundAwaitPrompt({
        taskIds: state.blockingTaskIds,
        workflowRunIds: state.activeWorkflowRunIds,
      }),
      sendOptions,
      {
        acceptanceOrigin: "automatic",
        skipAutoResumeReset: true,
        synthetic: true,
        agentInitiated: true,
      }
    );
    this.finishParentBackgroundAwait(state, sendResult, resumeCount);
  }

  /** Gives back the auto-resume this stream end took, since no resume prompt reached the parent. */
  private restoreParentAutoResumeCount(workspaceId: string, resumeCount: number): void {
    if (resumeCount === 0) {
      this.consecutiveAutoResumes.delete(workspaceId);
    } else {
      this.consecutiveAutoResumes.set(workspaceId, resumeCount);
    }
  }

  /** Consumes the queue-backgrounded exemptions; a failed resume send gives its budget back. */
  private finishParentBackgroundAwait(
    state: ParentStreamEndState,
    sendResult: Result<void, SendMessageError>,
    resumeCount: number
  ): void {
    this.consumeParentQueueBackgroundedExemptions(state);
    if (!sendResult.success) {
      this.restoreParentAutoResumeCount(state.workspaceId, resumeCount);
      log.error("Failed to resume parent with active background work", {
        workspaceId: state.workspaceId,
        error: sendResult.error,
      });
    }
  }

  /**
   * A child (task) stream end, first step: finalizes the workspace turn from the stream end, and
   * drops the cut of a stream whose execution moved on.
   *
   * The child steps run as a chain: finalizeChildStreamEndTurn → readChildStreamEndReport →
   * settleInterruptedOrReportedChild → holdChildForBlockingDescendants →
   * holdChildForBlockingWorkflowsAndTurns → holdChildForNonblockingWork → publishOrHandOffChild →
   * publishChildFinalReport, or handoffPlanLikeChild → reconcileCutBeforeContinuation →
   * handleQueueCutContinuation → deferChildStreamEndToContinuation, or
   * recoverIncompleteChildStreamEnd. Each step starts the next one in the same tick as its own
   * last await, so no collaborator call, status write or decision runs a microtask later than it
   * did in the inline code; only the handler's own resolution comes later. Every step returns the
   * next one's result unchanged: a "deferred" from a child goal arbitration must reach
   * StreamEndLedger.runStreamEndHandler.
   */
  private async finalizeChildStreamEndTurn(
    ctx: ChildStreamEndContext
  ): Promise<"deferred" | undefined> {
    const { event, taskOrigin } = ctx;
    if (
      await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamEnd(
        event,
        ctx.queueCutSnapshot
      )
    ) {
      return;
    }

    // Stop and reactivation can pass this handler while it waits for the event lock. Its
    // original execution, not the task's current status, owns this stream-end disposition.
    if (this.cutSourceIsObsolete(event, taskOrigin)) {
      this.discardCutReceipt(event);
      return;
    }
    return this.readChildStreamEndReport(ctx);
  }

  /** Reads the task status and the stream's final report, then decides a stream without one. */
  private async readChildStreamEndReport(
    ctx: ChildStreamEndContext
  ): Promise<"deferred" | undefined> {
    const { event, workspaceId, entry } = ctx;
    const status = entry.workspace.taskStatus;
    const workflowOutputSchema = entry.workspace.workflowTask?.outputSchema;
    const acceptsSchemaShapedWorkflowReport =
      workflowOutputSchema !== undefined &&
      validateJsonSchemaSubsetSchema(workflowOutputSchema, { requireObjectSchema: true }).success;
    // Missing finish reasons are not proof of a clean stop: providers may omit them and metadata
    // collection may time out. Only explicit `stop` can promote the final assistant response to the
    // terminal report; otherwise recovery asks the child to finish instead of finalizing an update.
    const finalAgentReportArgs =
      !ctx.isCompaction && event.metadata.finishReason === "stop"
        ? await this.resolveFinalAgentReportArgs(workspaceId, event.parts, {
            acceptSchemaShapedWorkflowReport: acceptsSchemaShapedWorkflowReport,
          })
        : null;
    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);
    const state: ChildStreamEndState = {
      ...ctx,
      status,
      reportArgs: isPlanLike ? null : finalAgentReportArgs,
      isPlanLike,
      proposePlanResult: this.findProposePlanSuccessInParts(event.parts),
    };
    this.decideNonreportBeforeContinuation(state);
    return this.settleInterruptedOrReportedChild(state);
  }

  /** Resolves the stream's decision `nonreport` when the stream carried no terminal report. */
  private decideNonreportBeforeContinuation(state: ChildStreamEndState): void {
    const { workspaceId, taskOrigin } = state;
    // No terminal report in this stream: the attempt continues. Decide (and wake the held queue)
    // BEFORE the recovery/continuation sends below, so a user follow-up queued during the stream
    // still dispatches ahead of them, exactly as it did before the hold existed.
    if (
      state.reportArgs == null &&
      !(state.isPlanLike && state.proposePlanResult) &&
      state.status !== "interrupted"
    ) {
      this.streamEndLedger.resolveStreamEndDecision(
        workspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          workspaceId,
          taskOrigin.ownedAttempt,
          taskOrigin.unownedAttemptId
        ),
        "nonreport"
      );
    }
  }

  /** Settles an interrupted task's waiters, and the termination phase of a reported task. */
  private async settleInterruptedOrReportedChild(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> {
    const { workspaceId, entry, streamAttemptId, taskOrigin } = state;
    // Stream-end settlement: interrupted tasks must settle all pending waiters.
    // A workflow-owned plan step that successfully called propose_plan is already complete,
    // even if the interruption status landed before the provider emitted stream-end.
    if (state.status === "interrupted") {
      if (state.isPlanLike && state.proposePlanResult && entry.workspace.workflowTask != null) {
        await this.handleSuccessfulWorkflowProposePlan({
          workspaceId,
          entry,
          proposePlanResult: state.proposePlanResult,
          reportedAttempt: taskOrigin.ownedAttempt,
          streamAttemptId,
        });
        return;
      }
      await this.settleInterruptedTaskAtStreamEnd(
        workspaceId,
        entry,
        state.reportArgs,
        streamAttemptId,
        { reportedAttempt: taskOrigin.ownedAttempt }
      );
      return;
    }
    if (state.status === "reported") {
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }
    return this.holdChildForBlockingDescendants(state);
  }

  /**
   * Interrupts the recovery of a task whose workflow owner is inactive, and holds the task while
   * active sync descendants block it. The active descendants are captured here, before the
   * workflow and workspace-turn awaits, and read again by holdChildForNonblockingWork.
   */
  private async holdChildForBlockingDescendants(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> {
    const { workspaceId, entry, taskIndex } = state;
    if (
      state.reportArgs == null &&
      !(state.isPlanLike && state.proposePlanResult && entry.workspace.workflowTask != null) &&
      (await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        state.cfg,
        "stream-end",
        taskIndex
      ))
    ) {
      return;
    }

    const activeDescendantTaskIds = this.listActiveDescendantAgentTaskIds(workspaceId);
    const blockingDescendantTaskIds = this.listBlockingActiveDescendantAgentTaskIdsUsingIndex(
      taskIndex,
      workspaceId
    );
    if (blockingDescendantTaskIds.length > 0) {
      if (state.status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running", {
          expectedAttemptId: state.streamAttemptId,
        });
      }
      return;
    }
    return this.holdChildForBlockingWorkflowsAndTurns(state, activeDescendantTaskIds);
  }

  /**
   * Reads the task's active and blocking workflow runs and workspace turns, and prompts the task
   * to await the blocking ones.
   */
  private async holdChildForBlockingWorkflowsAndTurns(
    state: ChildStreamEndState,
    activeDescendantTaskIds: readonly string[]
  ): Promise<"deferred" | undefined> {
    const { event, workspaceId } = state;
    const taskReferencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
      workspaceId,
      event.parts,
      event.messageId
    );
    const activeTaskWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
      workspaceId,
      taskReferencedWorkflowRunIds
    );
    const blockingTaskWorkflowRunIds = await this.listBlockingBackgroundWorkflowRunIds(
      workspaceId,
      taskReferencedWorkflowRunIds,
      event.parts
    );
    const activeWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    const blockingWorkspaceTurnIds =
      await this.getWorkspaceTurnManager().listBlockingWorkspaceTurnTaskIds(
        workspaceId,
        activeWorkspaceTurnIds
      );
    if (blockingTaskWorkflowRunIds.length > 0 || blockingWorkspaceTurnIds.length > 0) {
      if (state.status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running", {
          expectedAttemptId: state.streamAttemptId,
        });
      }
      await this.promptTaskForBackgroundAwait(workspaceId, {
        taskIds: blockingWorkspaceTurnIds,
        workflowRunIds: blockingTaskWorkflowRunIds,
      });
      return;
    }
    return this.holdChildForNonblockingWork(state, {
      activeDescendantTaskIds,
      activeTaskWorkflowRunIds,
      activeWorkspaceTurnIds,
    });
  }

  /** Holds the task, without a prompt, while non-blocking background work is still active. */
  private async holdChildForNonblockingWork(
    state: ChildStreamEndState,
    work: ChildBackgroundWork
  ): Promise<"deferred" | undefined> {
    // Non-blocking background children should not force task_await, but a child task's final
    // agent_report must wait for them so the original parent does not receive an incomplete report.
    if (
      work.activeDescendantTaskIds.length > 0 ||
      work.activeTaskWorkflowRunIds.length > 0 ||
      work.activeWorkspaceTurnIds.length > 0
    ) {
      if (state.status === "awaiting_report") {
        await this.setTaskStatus(state.workspaceId, "running", {
          expectedAttemptId: state.streamAttemptId,
        });
      }
      return;
    }
    return this.publishOrHandOffChild(state);
  }

  /**
   * Holds the task while parent guidance is pending, else publishes its final report or hands off
   * its proposed plan. No await, so it returns the next step's promise, or undefined for the hold.
   */
  private publishOrHandOffChild(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> | undefined {
    // Parent corrections queued for the next task turn supersede any report emitted by the old
    // turn. Keep the task active until AgentSession accepts the reserved guidance and clears this
    // durable flag; otherwise turn-end dispatch could deliver a stale report before the correction.
    if ((state.entry.workspace.taskPendingGuidance?.length ?? 0) > 0) {
      return;
    }
    if (state.reportArgs) return this.publishChildFinalReport(state, state.reportArgs);
    return this.handoffPlanLikeChild(state);
  }

  /**
   * Publishes the child's final report to its parent, unless a live child goal takes the turn
   * first. Returns "deferred" while the goal's accounting for this stream has not settled.
   */
  private async publishChildFinalReport(
    state: ChildStreamEndState,
    reportArgs: NonNullable<ChildStreamEndState["reportArgs"]>
  ): Promise<"deferred" | undefined> {
    const { workspaceId, event, status, streamAttemptId, taskOrigin } = state;
    // A child pursuing a live goal decides report vs. goal turn BEFORE publishing: its final prose
    // stays in history, and only publication to the parent waits for the goal to finish.
    const goalOutcome = await this.arbitrateChildGoalAtStreamEnd(
      workspaceId,
      event,
      status,
      streamAttemptId,
      () =>
        this.streamEndLedger.resolveStreamEndDecision(
          workspaceId,
          this.streamEndLedger.findPendingStreamEndDecision(
            workspaceId,
            taskOrigin.ownedAttempt,
            taskOrigin.unownedAttemptId
          ),
          "nonreport"
        )
    );
    if (goalOutcome === "handled") return;
    if (goalOutcome === "deferred") return "deferred";
    if (goalOutcome === "failed") {
      // Decided nonreport, then the goal turn was refused: ask for the report rather than
      // leave the task idle with an unpublished report.
      await this.recoverTaskFromIncompleteStreamEnd(workspaceId, status, streamAttemptId);
      return;
    }
    const finalization = await this.finalizeAgentTaskReport(
      workspaceId,
      state.entry,
      reportArgs,
      taskOrigin.ownedAttempt,
      streamAttemptId
    );
    if (finalization.finalized) {
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
    } else if (finalization.reason === "retired_attempt") {
      this.rejectWaiters(workspaceId, new Error(finalization.message));
    }
  }

  /** Completes a plan-like task's successful propose_plan: a workflow step, or an exec handoff. */
  private async handoffPlanLikeChild(state: ChildStreamEndState): Promise<"deferred" | undefined> {
    const { workspaceId, entry, streamAttemptId, taskOrigin } = state;
    if (state.isPlanLike && state.proposePlanResult) {
      if (entry.workspace.workflowTask != null) {
        await this.handleSuccessfulWorkflowProposePlan({
          workspaceId,
          entry,
          proposePlanResult: state.proposePlanResult,
          reportedAttempt: taskOrigin.ownedAttempt,
          streamAttemptId,
        });
        return;
      }
      // A non-workflow plan task's propose_plan is no terminal report: the attempt continues in
      // exec. Decide (and wake the held queue) before the handoff, as for any other non-report
      // end above: the kickoff's admission reads a still-pending decision for its attempt as
      // stale and would be refused, leaving the task running with no exec turn.
      this.streamEndLedger.resolveStreamEndDecision(
        workspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          workspaceId,
          taskOrigin.ownedAttempt,
          taskOrigin.unownedAttemptId
        ),
        "nonreport"
      );
      await this.handleSuccessfulProposePlanAutoHandoff({
        workspaceId,
        entry,
        proposePlanResult: state.proposePlanResult,
        streamAttemptId,
      });
      return;
    }
    return this.reconcileCutBeforeContinuation(state);
  }

  /**
   * Re-checks the cut source after the awaits above, reconciles a deferred stream end, and leaves
   * a pending cut that another turn's stream owns alone.
   */
  private async reconcileCutBeforeContinuation(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> {
    const { event, workspaceId } = state;
    if (this.cutSourceIsObsolete(event, state.taskOrigin)) {
      this.discardCutReceipt(event);
      return;
    }
    if (await this.streamEndLedger.reconcileDeferredTaskStreamEnd(workspaceId)) return;
    const pendingCut = this.streamEndLedger.deferralOf(workspaceId);
    // A different turn can be admitted ahead of the designated continuation. Its incomplete
    // end does not withdraw that continuation or transfer the old cut's recovery obligation.
    if (
      pendingCut != null &&
      pendingCut.sourceTurnGeneration !== state.queueCutSnapshot.turnGeneration
    ) {
      return;
    }
    return this.handleQueueCutContinuation(state);
  }

  /**
   * Classifies a queue-cut continuation by its receipt: a streaming successor owns the turn, a
   * canceled or prestream-failed one falls through to recovery once, any other one defers.
   */
  private async handleQueueCutContinuation(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> {
    const { event, workspaceId } = state;
    // Host-initiated cuts (queued input, context-budget hand-over) are not incomplete responses:
    // the selected continuation owns the turn unless it is withdrawn or fails before streaming.
    const continuationEntryId = continuationEntryIdOfStopCause(event.metadata.stopCause);
    if (continuationEntryId != null) {
      const receipt = this.workspaceService.getQueueCutReceipt(workspaceId, continuationEntryId);
      if (receipt != null) {
        this.workspaceService.markQueueCutSourceHandled(workspaceId, continuationEntryId);
        if (receipt.successor === "streaming") {
          return;
        }
        if (receipt.successor === "canceled" || receipt.successor === "prestream-failed") {
          // Consume-once: the failure notification may already have recovered.
          if (!this.workspaceService.disposeQueueCut(workspaceId, continuationEntryId)) {
            return;
          }
        } else {
          return this.deferChildStreamEndToContinuation(state, continuationEntryId, receipt);
        }
      }
    }
    return this.recoverIncompleteChildStreamEnd(state);
  }

  /**
   * Records the stream end as deferred to its still-unsettled continuation (the task runs again
   * meanwhile), then reconciles it at once in case that continuation was already withdrawn.
   */
  private async deferChildStreamEndToContinuation(
    state: ChildStreamEndState,
    continuationEntryId: string,
    receipt: QueueCutReceipt
  ): Promise<undefined> {
    const { event, workspaceId, taskOrigin } = state;
    if (state.status === "awaiting_report") {
      await this.setTaskStatus(workspaceId, "running", {
        expectedAttemptId: state.streamAttemptId,
      });
    }
    this.streamEndLedger.recordDeferral(workspaceId, {
      sourceMessageId: event.messageId,
      sourceTurnGeneration: receipt.sourceTurnGeneration,
      continuationEntryId,
      executionId: taskOrigin.executionId ?? undefined,
      stopEpoch: taskOrigin.stopEpoch,
      attemptId: state.streamAttemptId,
    });
    // The successor may have been withdrawn between the cut and this classification.
    await this.streamEndLedger.reconcileDeferredTaskStreamEnd(workspaceId);
  }

  /**
   * An incomplete child stream end: a live child goal takes the turn, else the task is asked to
   * finish. Returns "deferred" while the goal's accounting for this stream has not settled.
   */
  private async recoverIncompleteChildStreamEnd(
    state: ChildStreamEndState
  ): Promise<"deferred" | undefined> {
    const { workspaceId, status, streamAttemptId } = state;
    // The decision already resolved nonreport above (no final report in this stream).
    const goalOutcome = await this.arbitrateChildGoalAtStreamEnd(
      workspaceId,
      state.event,
      status,
      streamAttemptId,
      () => undefined
    );
    if (goalOutcome === "handled") return;
    if (goalOutcome === "deferred") return "deferred";
    await this.recoverTaskFromIncompleteStreamEnd(workspaceId, status, streamAttemptId);
  }

  /**
   * Sub-agent goals: TaskService alone owns a child's turns, so the goal loop runs here, after every
   * deferring early return in handleStreamEnd, for both a stream with a final report (called before
   * publication) and one without. Mirrors the top-level loop (AgentSession): eligible only while the
   * task is running (no pending required report), no termination pause is owed and the goal needs
   * no acknowledgment; agent_report stays a progress update. First match wins:
   * - active goal, the ended turn was a tool-free goal_continuation for it that stopped -> implicit
   *   complete_goal, then the normal path (its final text is the report);
   * - active goal otherwise -> one continuation turn (any final prose is not published);
   * - budget_limited with its one wrap-up unused -> the wrap-up turn;
   * - anything else (no goal, paused, complete: live state after this stream's accounting; wrap-up
   *   used) -> the normal path: publish the report, or prompt for one.
   * Returns "none" for the normal path, "handled" when a goal turn was handed off or another turn
   * (or a duplicate delivery) owns the outcome, and "failed" when a goal turn was decided (stream
   * decided nonreport) but refused, and "deferred" when this stream's goal accounting has not
   * settled yet (see deferChildStreamEnd). `decideNonreport` runs once a turn is certain, before
   * the send.
   */
  private async arbitrateChildGoalAtStreamEnd(
    workspaceId: string,
    event: StreamEndEvent,
    status: WorkspaceConfigEntry["taskStatus"],
    streamAttemptId: AttemptFence,
    decideNonreport: () => void
  ): Promise<ChildGoalTurnOutcome> {
    const goalService = this.workspaceGoalService;
    if (goalService == null) return "none";
    // Ineligible without reading goal state: a report obligation, an owed termination pause, or
    // an attempt whose admission closed (stop, settlement, retirement) takes the normal path.
    if (
      status !== "running" ||
      this.isChildGoalPauseOwed(workspaceId) ||
      (streamAttemptId != null &&
        !this.attemptLedger.attemptAdmissionOpen(workspaceId, streamAttemptId))
    ) {
      return "none";
    }
    // The goal's status must include this stream's accounting (a budget it just exhausted) and
    // any set_goal / complete_goal it made; both commit in the session's handling of the event.
    // Accounting completion is authoritative: until it is known, nothing is decided (deferred).
    const accounting = await goalService.waitForStreamAccountingReceipt(
      workspaceId,
      event.messageId,
      CHILD_GOAL_ACCOUNTING_WAIT_MS
    );
    if (accounting === "timeout") return "deferred";
    if (accounting === "evicted") {
      // Released without accounting (see beginStreamAccountingReceipt): no goal turn from it.
      log.warn("[task-goal] stream accounting receipt evicted; no goal turn for this stream", {
        workspaceId,
        messageId: event.messageId,
      });
      return "none";
    }
    const goal = await goalService.getGoal(workspaceId);
    if (goal == null) return "none";
    // A duplicate delivery of an already-arbitrated stream is a no-op: one outcome per stream.
    const arbitrated = this.childGoalArbitratedStreams.get(workspaceId) ?? [];
    if (arbitrated.includes(event.messageId)) return "handled";
    this.childGoalArbitratedStreams.set(
      workspaceId,
      [...arbitrated, event.messageId].slice(-CHILD_GOAL_ARBITRATED_STREAMS_MAX)
    );
    if (this.isChildGoalPauseOwed(workspaceId) || goal.requireUserAcknowledgmentSinceMs != null) {
      return "none";
    }
    if (goal.status === "active") {
      if (
        event.metadata.finishReason === "stop" &&
        !event.parts.some((part) => isDynamicToolPart(part)) &&
        (await this.endedTurnContinuedGoal(workspaceId, goal.goalId))
      ) {
        await goalService.completeGoalFromSilentContinuation({
          workspaceId,
          completionSummary: synthesizeSilentContinuationSummary(event.parts),
        });
        return "none";
      }
      return this.sendChildGoalTurn(
        workspaceId,
        goal,
        GOAL_CONTINUATION_KIND,
        streamAttemptId,
        decideNonreport
      );
    }
    if (
      goal.status === "budget_limited" &&
      goal.budgetLimitInjectedForGoalId == null &&
      goal.budgetLimitOriginKind !== "user"
    ) {
      return this.sendChildGoalTurn(
        workspaceId,
        goal,
        GOAL_BUDGET_LIMIT_KIND,
        streamAttemptId,
        decideNonreport
      );
    }
    return "none";
  }

  /**
   * Whether the agent a child's goal turns run on (its task-pinned agent) can drive a goal: the
   * same capability the set_goal tool gate applies (canAgentDriveGoal, and not plan-like).
   */
  private async canChildAgentDriveGoal(workspaceId: string): Promise<boolean> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    if (entry == null) return false;
    if (!canAgentDriveGoal(resolveTaskAgentIdForResume(entry.workspace))) return false;
    return !(await this.isPlanLikeTaskWorkspace(entry));
  }

  /** Whether the child's latest user row is a goal_continuation turn for `goalId`. */
  private async endedTurnContinuedGoal(workspaceId: string, goalId: string): Promise<boolean> {
    const tail = await this.historyService.getLastMessages(workspaceId, 20);
    if (!tail.success) return false;
    const userRow = tail.data.findLast(
      (message) => message.role === "user" && !isContextBudgetWarningMessage(message)
    );
    return userRow?.metadata?.kind === GOAL_CONTINUATION_KIND && userRow.metadata.goalId === goalId;
  }

  private isChildGoalPauseOwed(workspaceId: string): boolean {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    return entry?.workspace.taskGoalPauseOwed != null;
  }

  /**
   * One automatic goal turn (continuation or budget wrap-up) for a child, modeled on
   * promptTaskForRequiredCompletionTool: bound to the decided attempt, queued turn-end behind any
   * live turn, with task-pinned options and no tool policy. Every admission gate re-checks the
   * attempt token, the goal (pause, replacement, user stop, terminal transition) and an owed
   * termination pause. Outcomes: "none" = the goal no longer wants the turn (checked synchronously
   * just before `decideNonreport`, so the caller's normal path still applies); "handled" = handed
   * off, or another turn is pending (its stream end decides), or the attempt refused (terminal);
   * "failed" = refused after `decideNonreport` ran.
   */
  private async sendChildGoalTurn(
    workspaceId: string,
    goal: GoalRecordV1,
    kind: GoalSyntheticMessageKind,
    expectedAttemptId: AttemptFence,
    decideNonreport: () => void
  ): Promise<ChildGoalTurnOutcome> {
    const goalService = this.workspaceGoalService;
    assert(goalService != null, "sendChildGoalTurn requires the goal service");
    if (expectedAttemptId == null) return "none";
    if (
      this.aiService.isStreaming(workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
    ) {
      return "handled";
    }
    // A workflow-owned child whose owning run is no longer active must not keep working for its
    // goal: the caller's normal path applies (the report publishes; a stream without one already
    // took the no-report path's inactive-owner interrupt before arbitration).
    if (
      (await this.getInactiveWorkflowTaskOwnerForRecovery(
        workspaceId,
        this.config.loadConfigOrDefault()
      )) != null
    ) {
      return "none";
    }
    // Defense in depth (set_goal is already refused there): a child pinned to plan, compact or a
    // plan-like agent never gets a goal turn; the caller's normal report / plan handoff applies.
    if (!(await this.canChildAgentDriveGoal(workspaceId))) return "none";
    // Fail closed when the pinned agent is unavailable (#5402): pause; the normal path applies.
    const childEntry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    // The check awaits (#5452): a dispatch that went stale meanwhile (its attempt replaced, or
    // its goal replaced, settled or paused and resumed) shows no chat error and pauses nothing,
    // since that goal may now belong to a newer turn. Its stream end then takes the normal path.
    // Synchronous, so the pause can evaluate it under the goal file lock right before its write.
    const stillCurrent = (live: GoalRecordV1 | null) =>
      this.currentTaskAttemptId(workspaceId) === expectedAttemptId &&
      live?.goalId === goal.goalId &&
      live.status === goal.status &&
      (live.lastUserActivationAtMs ?? null) === (goal.lastUserActivationAtMs ?? null);
    // An unreadable goal counts as current while the attempt is: the refusal stands (fail
    // closed) and the pause write, fenced again under its lock, owns any error.
    const isCurrent = async () => {
      try {
        return stillCurrent(await goalService.readGoalSerialized(workspaceId));
      } catch {
        return this.currentTaskAttemptId(workspaceId) === expectedAttemptId;
      }
    };
    const refusal =
      childEntry == null
        ? null
        : await this.workspaceService.refuseUnavailableGoalTurnAgent(
            workspaceId,
            buildTaskTurnSendOptions(childEntry.workspace),
            isCurrent
          );
    if (refusal != null) {
      // A failed write is safe to ignore: "none" leads to the report (or a report prompt, whose
      // stream end re-arbitrates here), and the reported transition marks the pause owed
      // (taskGoalPauseOwed fences goal turns) and settles it.
      await goalService.pauseForUnavailableAgent(workspaceId, goal, refusal, stillCurrent);
      return "none";
    }
    const goalAdmission = await goalService.buildGoalRedispatchAdmission(
      workspaceId,
      goal.goalId,
      kind
    );
    if (!goalAdmission.admissible) return "none";
    const admission = this.admitTaskWorkspaceTurn(workspaceId, {
      acceptanceOrigin: "automatic",
      expectedAttemptId,
    });
    // Refused before decideNonreport (e.g. a transiently unreadable registry, a stop or a
    // superseded attempt): no goal turn was queued, so the caller's normal report path — with its
    // own attempt fences and report recovery — owns the outcome, exactly as for a goal-less child.
    if (admission.kind !== "admitted") return "none";
    const token = admission.token;
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId);
    let goalStale = goalAdmission.admissionStale;
    const goalUnwanted = () => goalStale() || this.isChildGoalPauseOwed(workspaceId);
    // Synchronous with decideNonreport: a pause or stop that landed during the awaits above still
    // takes the normal path (the report publishes), never a goal turn.
    if (entry == null || goalUnwanted()) {
      token.onDisposed("refused");
      return "none";
    }
    // The attempt's stream end must be decided before the send: a still-pending decision makes
    // the send's own admission stale.
    decideNonreport();
    const isStale = () => token.admissionStale() || goalUnwanted();
    if (isStale()) {
      token.onDisposed("refused");
      return "failed";
    }
    // The report was suppressed for this turn (decideNonreport ran): a queued turn cancelled later
    // (the user paused or cleared the goal, an owed pause landed) must still lead to the report.
    let sendReturned = false;
    let canceledBeforeReturn = false;
    const attemptId = expectedAttemptId;
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      kind === GOAL_BUDGET_LIMIT_KIND
        ? buildGoalBudgetLimitMessage(goal)
        : buildGoalContinuationMessage(goal),
      { ...buildTaskTurnSendOptions(entry.workspace), queueDispatchMode: "turn-end" },
      {
        onCanceled: (reason) => {
          if (!sendReturned) {
            canceledBeforeReturn = true;
            return;
          }
          this.recoverCanceledChildGoalTurn(workspaceId, attemptId, reason);
        },
        acceptanceOrigin: "automatic",
        synthetic: true,
        agentInitiated: true,
        goalKind: kind,
        goalId: goal.goalId,
        taskTurnKind: kind,
        queueDedupeKey: taskRecoveryPromptDedupeKey(workspaceId, "goal"),
        removableQueueDedupeKey: true,
        turnAdmission: token,
        admissionStale: isStale,
        // The one wrap-up is consumed only by an accepted send (a canceled or refused one leaves
        // it available). Reserving writes the goal, which bumps its terminal generation, so the
        // probe is rebuilt over the reserved record instead of refusing this very send.
        ...(kind === GOAL_BUDGET_LIMIT_KIND
          ? {
              onAccepted: async () => {
                await goalService.reserveBudgetWrapupForRedispatch(workspaceId, goal.goalId);
                const reserved = await goalService.buildGoalRedispatchAdmission(
                  workspaceId,
                  goal.goalId,
                  kind
                );
                goalStale = reserved.admissible ? reserved.admissionStale : () => true;
              },
            }
          : {}),
      }
    );
    sendReturned = true;
    if (!sendResult.success) {
      log.info("[task-goal] child goal turn not sent", {
        workspaceId,
        kind,
        error: sendResult.error,
      });
      return "failed";
    }
    if (canceledBeforeReturn) {
      this.recoverCanceledChildGoalTurn(workspaceId, attemptId, "canceled before admission");
    }
    return "handled";
  }

  /**
   * A queued child goal turn was cancelled after its stream end had decided nonreport, so nothing
   * would publish or ask for the report: take the normal no-report path (ask for the report),
   * unless the attempt itself closed (its termination owns the outcome) or another turn now owns
   * the task (its stream end decides). Serialized on the task's event lock; scheduled, not
   * awaited, because a canceler may hold that lock.
   */
  private recoverCanceledChildGoalTurn(
    workspaceId: string,
    attemptId: string,
    reason: string
  ): void {
    void this.workspaceEventLocks
      .withLock(workspaceId, async () => {
        const status = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace
          .taskStatus;
        if (
          status !== "running" ||
          !this.attemptLedger.attemptAdmissionOpen(workspaceId, attemptId)
        )
          return;
        if (
          this.aiService.isStreaming(workspaceId) ||
          this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
        ) {
          return;
        }
        log.info("[task-goal] child goal turn canceled; asking for the report", {
          workspaceId,
          reason,
        });
        await this.recoverTaskFromIncompleteStreamEnd(workspaceId, status, attemptId);
      })
      .catch((error: unknown) => {
        log.error("TaskService: recovery after a canceled child goal turn failed", {
          workspaceId,
          error,
        });
      });
  }

  /**
   * Settle the goal pause a terminated child attempt owes (taskGoalPauseOwed, see
   * markChildGoalPauseOwed) or, with `force`, any runnable goal a terminated attempt left behind
   * (legacy rows without the marker). Pauses an active goal through the real pause path (boundary
   * row + explicit pause generation, so chat-tail reconciliation cannot re-activate it) and
   * consumes a budget-limited goal's one wrap-up (budget_limited has no pause transition; with its
   * wrap-up used no automatic turn can run it). Never completes the goal.
   *
   * Ordering: the owed marker is durable before this runs, so every later activation is refused
   * by the goal service's childActivationGate; the goal is read under the goal file lock, so an
   * activation that passed its gate earlier has finished writing and is seen here. The marker is
   * cleared only once the pause is durable, and only if it still names the same closing attempt
   * (a later termination's marker is never cleared by this settle).
   */
  private async settleChildGoalPause(
    workspaceId: string,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const goalService = this.workspaceGoalService;
    if (goalService == null) return;
    const owed = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace
      .taskGoalPauseOwed;
    if (owed == null && options.force !== true) return;
    try {
      const goal = await goalService.readGoalSerialized(workspaceId);
      if (goal?.status === "active") {
        const paused = await goalService.setGoal({
          workspaceId,
          status: "paused",
          initiator: "auto",
          expectedGoalId: goal.goalId,
        });
        if (!paused.success) throw new Error(`pause refused: ${paused.error.type}`);
      } else if (goal?.status === "budget_limited") {
        await goalService.reserveBudgetWrapupForRedispatch(workspaceId, goal.goalId);
      }
      const settled = await goalService.readGoalSerialized(workspaceId);
      if (
        settled?.status === "active" ||
        (settled?.status === "budget_limited" &&
          settled.budgetLimitInjectedForGoalId == null &&
          settled.budgetLimitOriginKind !== "user")
      ) {
        throw new Error("goal still runnable after pause");
      }
    } catch (error) {
      log.warn("[task-goal] child goal pause failed; goal activation stays fenced", {
        workspaceId,
        error: getErrorMessage(error),
      });
      if (owed == null) {
        await this.editChildGoalPauseMarker(workspaceId, (ws) => {
          ws.taskGoalPauseOwed ??= ws.taskAttemptId ?? "*";
        });
      }
      return;
    }
    if (owed != null) {
      await this.editChildGoalPauseMarker(workspaceId, (ws) => {
        if (ws.taskGoalPauseOwed === owed) delete ws.taskGoalPauseOwed;
      });
    }
  }

  /**
   * Marker bookkeeping for settleChildGoalPause, which callers (startup recovery loops, stop
   * paths) treat as non-throwing: a failed config write is logged and leaves the marker as it
   * was, so the pause is retried at the next settle point instead of aborting the caller.
   */
  private async editChildGoalPauseMarker(
    workspaceId: string,
    edit: (ws: WorkspaceConfigEntry) => void
  ): Promise<void> {
    try {
      await this.editWorkspaceEntry(workspaceId, edit, { allowMissing: true });
    } catch (error) {
      log.warn("[task-goal] child goal pause marker update failed; retried at the next settle", {
        workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * ChildGoalResumeHooks.captureActivationAttempt: the attempt a goal mutation accepted now acts
   * for (undefined: not a sub-agent task; null: no attempt that may run goal work right now).
   */
  captureChildGoalActivationAttempt(workspaceId: string): string | null | undefined {
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    if (workspace?.parentWorkspaceId == null) return undefined;
    const attemptId = this.currentTaskAttemptId(workspaceId, workspace);
    return attemptId != null && this.isChildGoalActivationAllowed(workspaceId, attemptId)
      ? attemptId
      : null;
  }

  /**
   * ChildGoalResumeHooks.isActivationAllowed, the sub-agent activation invariant: a child goal may
   * become active / budget_limited only for this exact attempt while it is running (no report
   * obligation), its admission is open (not closed, stopping, retired or being removed) and no
   * termination pause is owed. Synchronous: the goal service calls it under its file lock right
   * before the write.
   */
  isChildGoalActivationAllowed(workspaceId: string, attemptId: string | null): boolean {
    if (attemptId == null) return false;
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    return (
      workspace?.taskStatus === "running" &&
      workspace.taskGoalPauseOwed == null &&
      this.attemptLedger.attemptAdmissionOpen(workspaceId, attemptId)
    );
  }

  /**
   * ChildGoalResumeHooks.getTurnModel: the model a child goal turn is dispatched on — the same
   * task-pinned resolution (fallback included) sendChildGoalTurn sends with.
   */
  getChildGoalTurnModel(workspaceId: string): string | null {
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    return workspace == null ? null : (buildTaskTurnSendOptions(workspace).model ?? null);
  }

  /** AgentTaskIntegration.settleOwedChildGoalPause: see settleChildGoalPause. */
  async settleOwedChildGoalPause(workspaceId: string): Promise<void> {
    await this.settleChildGoalPause(workspaceId);
  }

  /** Settle each owed child goal pause in turn (see settleChildGoalPause; never throws). */
  private async settleChildGoalPauses(taskIds: Iterable<string>): Promise<void> {
    for (const taskId of taskIds) await this.settleChildGoalPause(taskId);
  }

  /**
   * WorkspaceGoalService resume gate (see ChildGoalResumeHooks): why a user may not resume this
   * child's goal now, or null. Goal work needs a live attempt in its ordinary running phase: an
   * attempt owing its required report belongs to that report (which then ends the task and
   * re-pauses the goal), so a resume there would report success without resuming anything.
   */
  getChildGoalResumeRefusal(workspaceId: string): string | null {
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    if (workspace?.taskStatus === "awaiting_report" && this.isChildAttemptOpen(workspace)) {
      return "This sub-agent task is finishing its required report, so its goal cannot resume now. Reactivate the task after it reports, then resume its goal.";
    }
    // A reactivated reported child stays reported (its new execution never runs goal turns), so
    // "reactivate it first" is a dead end there (#5411 item (c), not yet supported).
    if (workspace?.taskStatus === "reported") {
      return "This sub-agent task has already reported, and resuming a reported sub-agent's goal is not supported yet. Start a new sub-agent task for the remaining work instead.";
    }
    if (!this.isChildTaskRunning(workspaceId)) {
      return "This sub-agent task is not running. Reactivate the task first, then resume its goal.";
    }
    return null;
  }

  private isChildAttemptOpen(workspace: WorkspaceConfigEntry): boolean {
    return (
      workspace.parentWorkspaceId != null &&
      workspace.taskAttemptRetiredBy == null &&
      workspace.pendingRemoval == null
    );
  }

  /** A live child attempt in its ordinary running phase (where goal turns may run). */
  private isChildTaskRunning(workspaceId: string): boolean {
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    return workspace?.taskStatus === "running" && this.isChildAttemptOpen(workspace);
  }

  /**
   * After a user resumed a live child's goal: continue an idle child with one fenced goal turn
   * bound to its current attempt. A busy child needs nothing; its next stream end decides.
   */
  async continueResumedChildGoal(workspaceId: string): Promise<void> {
    await this.workspaceEventLocks.withLock(workspaceId, async () => {
      const goalService = this.workspaceGoalService;
      if (goalService == null) return;
      const goal = await goalService.getGoal(workspaceId);
      const running = this.isChildTaskRunning(workspaceId);
      if (goal?.status === "active" && running) {
        const outcome = await this.sendChildGoalTurn(
          workspaceId,
          goal,
          GOAL_CONTINUATION_KIND,
          this.currentTaskAttemptId(workspaceId) ?? null,
          () => undefined
        );
        if (outcome === "handled") return;
      }
      // Nothing will run the resumed goal (the task stopped, reported or owes its report since
      // the resume was admitted, or the send was refused): restore the pause durably and refuse
      // the resume — never report success for a goal no turn will drive.
      const live = await goalService.getGoal(workspaceId);
      if (live?.status === "active") {
        const paused = await goalService.setGoal({
          workspaceId,
          status: "paused",
          initiator: "auto",
          expectedGoalId: live.goalId,
        });
        if (!paused.success) {
          log.warn("[task-goal] failed to restore a child goal pause after a refused resume", {
            workspaceId,
            error: paused.error,
          });
        }
      }
      throw new Error(
        running
          ? "The sub-agent could not continue its goal, so the goal stays paused. Try again once the task is idle."
          : "The sub-agent task stopped or owes its report, so its goal stays paused. Reactivate the task, then resume its goal."
      );
    });
  }

  private async recoverTaskFromIncompleteStreamEnd(
    workspaceId: string,
    status: WorkspaceConfigEntry["taskStatus"],
    /** The ended stream's attempt: recovery writes are CAS'd on it (see AttemptFence). */
    streamAttemptId: AttemptFence
  ): Promise<void> {
    if (status !== "awaiting_report") {
      await this.setTaskStatus(workspaceId, "awaiting_report", {
        expectedAttemptId: streamAttemptId,
      });
    }

    // The prompt's budget write is CAS'd on the same attempt (a superseded row gets no prompt).
    await this.promptTaskForRequiredCompletionTool(workspaceId, {
      reason: "stream_end",
      expectedAttemptId: streamAttemptId,
    });
  }

  private async handleStreamAbort(
    event: StreamAbortEvent,
    /** Captured by the stream-abort listener in the event's own tick, before the lock wait. */
    abortOrigin: StreamAttemptOrigin
  ): Promise<void> {
    if (event.abortReason === "user") {
      // Explicit Stop withdraws the execution, not just its continuation. A later queue
      // notification or delayed source event must not turn that Stop into automatic recovery.
      this.bumpWorkspaceStopEpoch(event.workspaceId);
      this.clearTaskRecovery(event.workspaceId);
    } else {
      await this.streamEndLedger.reconcileDeferredTaskStreamEnd(event.workspaceId);
    }
    // Settles a continuation handle (execution mirror) first. A reawakened child is ALSO
    // `running` in its stable status (markInterruptedTaskRunning), and the desktop ledger treats
    // either active source as control, so the stable status must be released independently.
    await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamAbort(event);
    if (event.abortReason === "user") {
      await this.releaseSharedDesktopTaskOnUserStop(event.workspaceId, abortOrigin);
    }
  }

  /**
   * A user Stop on an ordinary child is a steerable pause: the task stays `running` so the
   * user can resume it. A shared-desktop child, however, holds the owner's desktop through that
   * `running` status (the config ledger is the only ownership source), so a paused child would
   * block the owner indefinitely — a wait timeout must never release a still-active child, only
   * an explicit stop may. Mirror task_stop instead: the durable `interrupted` status releases the
   * desktop and fails the parent's wait fast, while a user resume re-admits the child onto the
   * same desktop via markInterruptedTaskRunning.
   */
  private async releaseSharedDesktopTaskOnUserStop(
    workspaceId: string,
    /** The aborted stream's attempt, captured at the abort event (see StreamAttemptOrigin). */
    abortOrigin: StreamAttemptOrigin
  ): Promise<void> {
    // Cheap bound only; every release decision below is re-evaluated inside the serialized edit.
    const workspace = findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace;
    if (workspace?.parentWorkspaceId == null || workspace.taskDesktopOwnerWorkspaceId == null) {
      return;
    }
    // Act only for the attempt whose stream the user aborted, never for whoever holds the row
    // after the awaits since (#4414): another backend sharing this Xum root, or a local send, may
    // have re-admitted it as a successor, whose status, admission and settlement are its own.
    // Only as strong as cross-process config exclusion (#4415).
    const ownedAttempt = abortOrigin.ownedAttempt;
    const abortedAttemptId = ownedAttempt?.attemptId ?? abortOrigin.unownedAttemptId;
    let transitionedToInterrupted = false;
    let parentWorkspaceId: string | undefined;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (ws.taskDesktopOwnerWorkspaceId == null) return;
        // Captured without an identity (pre-identity row): a row that gained one since belongs
        // to a newer admission, not to the aborted stream.
        if (
          abortedAttemptId == null ? ws.taskAttemptId != null : rowSupersedes(ws, abortedAttemptId)
        ) {
          return;
        }
        if (ws.taskStatus !== "running" && ws.taskStatus !== "awaiting_report") return;
        // Evaluated against the fresh config inside the FIFO config edit: a successor that
        // claimed the execution mirror, queued a turn, started streaming, or was admitted but has
        // not claimed a turn yet (pending send obligation) while this edit waited in the queue
        // keeps the desktop (stop-and-send-queued, newer continuation). A preflight-only check
        // would let this stale abort clear that successor.
        if (
          this.aiService.isStreaming(workspaceId) ||
          this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId) ||
          this.attemptLedger.hasPendingAdmissions(workspaceId) ||
          isActiveWorkspaceTurnTaskStatus(ws.taskExecutionStatus)
        ) {
          return;
        }
        parentWorkspaceId = ws.parentWorkspaceId;
        transitionedToInterrupted = this.applyInterruptedTaskStatus(ws) === "interrupted";
        // Idle producer: close the attempt synchronously with the decision, before the write.
        if (transitionedToInterrupted) {
          this.closeAttemptAdmission(workspaceId, ws.taskAttemptId, ownedAttempt, "user-stop-idle");
        }
      },
      { allowMissing: true }
    );
    if (!transitionedToInterrupted) {
      return;
    }
    await this.settleChildGoalPause(workspaceId);
    // No deferred dispatch may outlive the closure (the queue was empty when the idleness was
    // decided; this only guards entries added while the write was awaited). Only while this
    // process still owns the attempt it decided for: a send during the write may have begun a
    // new attempt (a user message reawakening the task), and entries queued behind that turn are
    // its input, not the stopped attempt's — clearing them would drop the user's message.
    if (this.attemptLedger.ownedAttempt(workspaceId) === ownedAttempt) {
      this.workspaceService.clearQueue(workspaceId);
    }
    this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    // Before the receipt write's await: a successor's waiter registered meanwhile (another
    // backend reawakening the now-interrupted task) must not be rejected as this attempt's.
    this.rejectWaiters(workspaceId, new Error("Task interrupted"));
    // Verified idle inside the edit (no stream, no pending turn, no execution mirror).
    await this.attemptLedger.persistOwnedAttemptSettlement(
      workspaceId,
      ownedAttempt,
      "idle-settled",
      "user-stop-idle"
    );
    await this.emitWorkspaceMetadata(workspaceId);
    this.scheduleMaybeStartQueuedTasks();
  }

  private async handleTaskStreamError(
    event: ErrorEvent,
    /** Captured by the error listener in the event's own tick, before the lock wait. */
    errorAttemptId: string | undefined
  ): Promise<void> {
    if (await this.getWorkspaceTurnManager().finalizeWorkspaceTurnFromStreamError(event)) {
      return;
    }
    const workspaceId = event.workspaceId;
    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return;
    }
    // Another writer re-admitted the row since the failing stream's attempt: the error is that
    // attempt's alone (every write below is also CAS'd on it — see rowSupersedes).
    if (rowSupersedes(entry.workspace, errorAttemptId)) {
      log.info(
        "[task-attempt] stream error ignored: its attempt was superseded by another writer",
        {
          workspaceId,
          attemptId: errorAttemptId,
          errorType: event.errorType,
        }
      );
      return;
    }

    const status = entry.workspace.taskStatus;
    // Stream errors only need settlement handling while the task is mid-run
    // (running) or waiting on its completion tool (awaiting_report).
    if (status !== "running" && status !== "awaiting_report") {
      return;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);

    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        "stream-error",
        taskIndex
      )
    ) {
      return;
    }

    if (await this.hasActiveTaskOwnedWork(workspaceId, taskIndex)) {
      return;
    }

    const isNonRetryable =
      event.errorType != null && isNonRetryableStreamError({ type: event.errorType });

    // Terminal provider outcomes (e.g. model_refusal) settle the task even during its
    // first `running` turn — previously only awaiting_report settled, leaving the
    // parent's waitForAgentReport to block until timeout. Deliberately an allow-list
    // rather than "all non-retryable":
    // - `aborted` is a steerable user pause, not a terminal failure.
    // - `context_exceeded` has in-session recovery (compaction retry, post-compaction
    //   retry in AgentSession.handleStreamError) listening on the same error event;
    //   it settles below only after that recovery declines.
    const settlesRunningTask =
      event.errorType != null && RUNNING_TASK_TERMINAL_STREAM_ERRORS.has(event.errorType);

    if (isNonRetryable && (status === "awaiting_report" || settlesRunningTask)) {
      log.error("Task hit a non-retryable stream error; interrupting task", {
        workspaceId,
        taskStatus: status,
        errorType: event.errorType,
        error: event.error,
      });
      await this.failAgentTaskTerminally(
        workspaceId,
        entry,
        {
          errorType: event.errorType ?? "unknown",
          errorMessage: event.error,
        },
        { expectedAttemptId: errorAttemptId ?? null }
      );
      return;
    }

    if (status === "running" && event.errorType === "context_exceeded") {
      // Wait for AgentSession.handleStreamError's recovery decision instead of
      // racing it. When no retry started, the turn failed terminally without a
      // later stream-end, so leaving the task `running` would block the
      // parent's waitForAgentReport until timeout.
      //
      // Act on the recorded per-attempt outcome, not live phase flags: a fast
      // successful retry can start AND finish before this handler (queued
      // behind the workspace event lock) gets here, so sampling isStreaming
      // would misread a successful recovery as declined. "retry-started"
      // means this attempt's recovery completed stream startup; that retry's
      // own stream events (including a possible follow-up error event, which
      // gets its own decision) settle the task later. "terminal" means the
      // error settled with no retry. Queued messages must NOT count as
      // recovery — the terminal error path does not dispatch the queue, so an
      // unrelated queued message would otherwise leave the task running
      // forever.
      const recoveryOutcome = await this.workspaceService.waitForPendingStreamErrorRecoveryDecision(
        workspaceId,
        event.messageId
      );
      if (recoveryOutcome === "retry-started") {
        return;
      }
      // No recorded decision means the session is gone or was recreated
      // (e.g. restart recovery); a live stream then belongs to a real
      // continuing turn, so leave settlement to its stream events.
      if (recoveryOutcome === undefined && this.aiService.isStreaming(workspaceId)) {
        return;
      }
      log.error("Task hit context_exceeded and in-session recovery declined; interrupting task", {
        workspaceId,
        error: event.error,
      });
      await this.failAgentTaskTerminally(
        workspaceId,
        entry,
        {
          errorType: event.errorType,
          errorMessage: event.error,
        },
        { expectedAttemptId: errorAttemptId ?? null }
      );
      return;
    }

    // A startup error can wait behind the source handler until its continuation failure is
    // recorded. That disposition already requested recovery; do not spend the budget twice.
    if (await this.streamEndLedger.reconcileDeferredTaskStreamEnd(workspaceId)) return;

    if (status !== "awaiting_report") {
      // Retryable errors during `running` are handled by the agent session's
      // retry loop; TaskService only intervenes once the task owes its report.
      return;
    }

    log.warn(
      "Task awaiting required completion tool hit a stream error; retrying report-only recovery",
      {
        workspaceId,
        errorType: event.errorType,
        error: event.error,
      }
    );

    await this.promptTaskForRequiredCompletionTool(workspaceId, {
      expectedAttemptId: errorAttemptId ?? null,
      reason: "error",
      error: event,
    });
  }

  /**
   * Terminal settlement for a child task whose stream failed with a
   * non-retryable error: mark interrupted with a descriptive launch error,
   * persist a durable failure artifact in every ancestor session dir (so
   * background children, restarts, and post-cleanup task_awaits observe the
   * typed failure), then reject pending waiters with the failure message.
   *
   * `expectedAttemptId`: the caller decided the failure for exactly that attempt (a fenced
   * prompt). A row that no longer names it — another backend re-admitted it under its own attempt
   * — is that writer's: nothing is closed, stopped, written, cleared, settled or published. The
   * status write is a CAS on the attempt, and the stop record is captured only after it lands (a
   * record captured for a row the CAS then abandons would latch the workspace for good).
   */
  private async failAgentTaskTerminally(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    options: { expectedAttemptId: AttemptFence }
  ): Promise<void> {
    assert(workspaceId.length > 0, "failAgentTaskTerminally: workspaceId must be non-empty");
    assert(
      failure.errorMessage.length > 0,
      "failAgentTaskTerminally: errorMessage must be non-empty"
    );
    assert(options != null, "failAgentTaskTerminally: options (attempt fence) are required");
    const expectedAttemptId = options.expectedAttemptId ?? undefined;
    const logSuperseded = () =>
      log.info("[task-attempt] terminal failure abandoned: decided for a superseded attempt", {
        workspaceId,
        expectedAttemptId,
        errorType: failure.errorType,
      });
    if (expectedAttemptId != null && this.currentTaskAttemptId(workspaceId) !== expectedAttemptId) {
      logSuperseded();
      return;
    }

    // A terminal failure ends the stream's attempt: settle the attempt owned at this decision.
    // Two producers, decided BEFORE persisting `interrupted`: with no live turn generation,
    // registration, stream or pending send obligation the attempt is idle and settles here;
    // otherwise report publication may still be in flight (stream-end handling precedes turn
    // settlement), so a stop record captures the live work and the execution-settlement producer
    // settles the attempt when that record releases.
    const ownedAttempt = this.attemptLedger.ownedAttempt(workspaceId);
    // Close admission FIRST, synchronously with the decision: a send reaching the fence from here
    // on is refused, so the activity sample below is authoritative — every obligation or turn
    // admitted before it is visible to it and captured by the stop record, and none can be
    // admitted between the sample and the persisted `interrupted` (that gap would otherwise let
    // the no-record branch settle the attempt while a freshly admitted turn runs).
    this.closeAttemptAdmission(
      workspaceId,
      expectedAttemptId ?? this.currentTaskAttemptId(workspaceId),
      ownedAttempt,
      "terminal-failure"
    );
    const sampleLiveExecution = (): boolean =>
      this.workspaceService.getActiveTurnGeneration(workspaceId) != null ||
      this.getWorkspaceTurnManager().getLiveWorkspaceTurnRegistration(workspaceId) != null ||
      this.aiService.isStreaming(workspaceId) ||
      this.attemptLedger.hasPendingAdmissions(workspaceId);
    let stopRecord: WorkspaceStopRecord | undefined;
    if (expectedAttemptId == null && sampleLiveExecution()) {
      await using _lock = await this.mutex.acquire();
      stopRecord = this.taskStopLatch.beginWorkspaceStop(workspaceId);
    }
    let superseded = false;
    let transitionedToInterrupted = false;
    let parentWorkspaceId = entry.workspace.parentWorkspaceId;
    const found = await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        superseded = expectedAttemptId != null && ws.taskAttemptId !== expectedAttemptId;
        if (superseded) return;
        transitionedToInterrupted = ws.taskStatus !== "interrupted";
        parentWorkspaceId = ws.parentWorkspaceId;
        ws.taskStatus = "interrupted";
        ws.taskLaunchError = failure.errorMessage;
        markChildGoalPauseOwed(ws);
        // #4579: binds the failure to the attempt this CAS matched. The artifacts below are
        // log-only on I/O errors, and taskLaunchError is not attempt-bound or failure-only.
        if (ws.taskAttemptId != null) {
          ws.taskTerminalFailure = { attemptId: ws.taskAttemptId, errorType: failure.errorType };
        }
        if (stopRecord == null) {
          this.closeAttemptAdmission(
            workspaceId,
            ws.taskAttemptId,
            ownedAttempt,
            "terminal-failure"
          );
        }
      },
      { allowMissing: true }
    );
    if (found && !superseded) await this.settleChildGoalPause(workspaceId);
    if (expectedAttemptId != null) {
      if (superseded || !found) {
        logSuperseded();
        return;
      }
      // The marker landed on the expected attempt's row; its live work is captured now (the
      // closure above preceded the write, so this sample is authoritative) — unless another
      // writer took the row during the write's own awaits, in which case it is theirs.
      let rowStillExpected = false;
      {
        await using _lock = await this.mutex.acquire();
        rowStillExpected = this.currentTaskAttemptId(workspaceId) === expectedAttemptId;
        if (rowStillExpected && sampleLiveExecution()) {
          stopRecord = this.taskStopLatch.beginWorkspaceStop(workspaceId);
        }
      }
      if (!rowStillExpected) {
        logSuperseded();
        return;
      }
    }
    if (transitionedToInterrupted) {
      this.recordTaskInterrupted(workspaceId, parentWorkspaceId);
    }
    // The failure artifacts land BEFORE either settlement branch writes the settlement receipt
    // (idle: persistOwnedAttemptSettlement; stop: the record's release). Another backend reads
    // the receipt as "ended without a report" unless it also finds the failure, and would then
    // replace a child that must fail its step (onRefusal: "fail"). Still after the superseded
    // checks above, so a call decided for another attempt writes nothing. A failed artifact
    // write is only logged (known gap: a later restart could then replace the child).
    if (parentWorkspaceId) {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
        index.parentById,
        workspaceId
      );
      const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
        (ancestorWorkspaceId) =>
          this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
            index,
            ancestorWorkspaceId,
            workspaceId
          ) === true
      );

      const persistedAtMs = Date.now();
      for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
        try {
          await upsertSubagentFailureArtifact({
            locks: this.historyService.locks,
            workspaceId: ancestorWorkspaceId,
            workspaceSessionDir: path.join(this.config.sessionsDir, ancestorWorkspaceId),
            childTaskId: workspaceId,
            parentWorkspaceId,
            ancestorWorkspaceIds,
            workflowOwnedAncestorWorkspaceIds,
            errorType: failure.errorType,
            errorMessage: failure.errorMessage,
            model: entry.workspace.taskModelString,
            nowMs: persistedAtMs,
          });
        } catch (error: unknown) {
          log.error("Failed to persist subagent failure artifact", {
            workspaceId: ancestorWorkspaceId,
            childTaskId: workspaceId,
            error,
          });
        }
      }
    }

    if (stopRecord != null) {
      this.taskStopLatch.markWorkspaceStopPersisted(workspaceId);
      // Phase B for the single task: clearQueue + stopStream against the captured execution;
      // release (and the in-memory settlement) follows the captured turn's own settlement.
      await this.runWorkspaceStopCleanup([workspaceId], {
        label: "failAgentTaskTerminally",
        abandonPartial: false,
        clearQueue: true,
      });
    } else {
      this.workspaceService.clearQueue(workspaceId);
      // Idle terminal settlement: nothing live was admitted before the closure above.
      await this.attemptLedger.persistOwnedAttemptSettlement(
        workspaceId,
        ownedAttempt,
        "idle-settled",
        "terminal-failure"
      );
    }
    await this.emitWorkspaceMetadata(workspaceId);

    // Captured before settlement: rejectWaiters consumes the pending waiters
    // that prove a parent turn is actively listening for this task.
    const hadForegroundWaiters = this.waiters.hasPendingWaiters(workspaceId);

    await this.settleInterruptedTaskAtStreamEnd(
      workspaceId,
      entry,
      null,
      options.expectedAttemptId,
      { rejectionError: new Error(failure.errorMessage) }
    );

    // Free this task's concurrency slot for queued siblings.
    this.scheduleMaybeStartQueuedTasks();

    await this.maybeResumeParentAfterTerminalChildFailure(
      workspaceId,
      entry,
      failure,
      hadForegroundWaiters
    );
  }

  /**
   * Background-spawned children may have no pending waiter to reject, and the
   * parent stream typically already returned early because the child was still
   * active. The report path delivers into the parent context and wakes idle
   * parents (deliverReportToParent + post-report auto-resume), so terminal
   * failures must too — otherwise an idle parent stays at taskStatus "running"
   * until a timeout or manual task_await, or worse: a later sibling's report
   * wakes it and the fanout looks fully successful. Two mirrored halves:
   *
   * 1. Always append a synthetic mux_subagent_failure message to the parent
   *    history (the durable context delivery — survives any wake-up ordering).
   * 2. Auto-resume the parent only when this was the last active child and the
   *    parent is idle (same gates as the post-report auto-resume).
   */
  private async maybeResumeParentAfterTerminalChildFailure(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    hadForegroundWaiters: boolean
  ): Promise<void> {
    const parentWorkspaceId = childEntry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }
    // An active waiter (foreground task tool call or task_await) already
    // surfaced the rejection to the parent's in-flight turn.
    if (hadForegroundWaiters) {
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return;
    }
    // Workflow-owned children propagate failures through the WorkflowRunner
    // step result; do not also resume the parent from a child-level failure row.
    if (childEntry.workspace.workflowTask != null) {
      return;
    }

    const cfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    if (!parentEntry) {
      return;
    }

    // Durable context delivery, mirroring deliverReportToParent's synthetic
    // append: the failure must be visible to the parent's next turn regardless
    // of whether this settlement resumes it or a later sibling report/failure does.
    const failureMessage = createMuxMessage(
      createTaskFailureMessageId(),
      "user",
      formatSubagentFailureUserMessage({
        childWorkspaceId,
        agentType: coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent",
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
      }),
      { timestamp: Date.now(), synthetic: true, uiVisible: true }
    );
    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      failureMessage
    );
    if (appendResult.success) {
      this.workspaceService.emitChatEvent(parentWorkspaceId, {
        ...failureMessage,
        type: "message",
      });
    }
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent failure to parent history", {
        parentWorkspaceId,
        childWorkspaceId,
        error: appendResult.error,
      });
    }

    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(cfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }
    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping terminal-failure parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return;
    }
    // The failure message is already injected above. Enqueue even when other children are active:
    // the drain defers on blocking work, and the later settling child may have a foreground waiter
    // that suppresses its own terminal wake-up.
    const generationId = await this.getAgentTerminalAttentionGenerationId(
      parentWorkspaceId,
      childWorkspaceId
    );
    await this.enqueueTerminalAttention({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      terminalOutcome: "failed",
      sourceId: childWorkspaceId,
      ...(generationId != null ? { generationId } : {}),
    });
  }

  /**
   * Stream-end settlement for interrupted tasks. Guarantees every pending waiter
   * is settled exactly once: resolved if an agent_report exists, rejected otherwise.
   * No waiter should depend on timeout to discover terminal interruption.
   */
  private async settleInterruptedTaskAtStreamEnd(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    reportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    } | null,
    /** The ended stream's (or failure's) attempt; see AttemptFence. */
    attemptFence: AttemptFence,
    options?: { rejectionError?: Error; reportedAttempt?: OwnedTaskAttempt }
  ): Promise<void> {
    if (reportArgs) {
      const finalization = await this.finalizeAgentTaskReport(
        workspaceId,
        entry,
        reportArgs,
        options?.reportedAttempt,
        attemptFence
      );
      // A superseded report was not published because the row names another writer's attempt:
      // the stable-id waiters are that attempt's and must not read this report's failure.
      if (!finalization.finalized && finalization.reason !== "superseded_attempt") {
        this.rejectWaiters(workspaceId, new Error(finalization.message));
      }
      return;
    }

    // Waiters are keyed by the stable task id: once another writer re-admitted the row under its
    // own attempt they are that attempt's (checked synchronously with the rejection).
    if (
      rowSupersedes(
        findWorkspaceEntry(this.config.loadConfigOrDefault(), workspaceId)?.workspace,
        attemptFence
      )
    ) {
      return;
    }
    this.rejectWaiters(workspaceId, options?.rejectionError ?? new Error("Task interrupted"));

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    const bestOf = this.getEffectiveTaskGroup(workspaceId, entry.workspace);
    if (
      parentWorkspaceId &&
      bestOf?.total != null &&
      bestOf.total > 1 &&
      !this.aiService.isStreaming(parentWorkspaceId)
    ) {
      await this.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      });
    }
  }

  private async handleSuccessfulWorkflowProposePlan(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
    reportedAttempt: OwnedTaskAttempt | undefined;
    /** The ended stream's attempt: every write below is CAS'd on it (see AttemptFence). */
    streamAttemptId: AttemptFence;
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulWorkflowProposePlan: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulWorkflowProposePlan: planPath must be non-empty"
    );

    if (args.entry.workspace.workflowTask?.outputSchema !== undefined) {
      const error = new Error(
        "Workflow plan agents return { reportMarkdown, planFilePath }; do not provide schema/outputSchema."
      );
      let planFailureSuperseded = false;
      let transitionedToInterrupted = false;
      let parentWorkspaceId = args.entry.workspace.parentWorkspaceId;
      await this.editWorkspaceEntry(
        args.workspaceId,
        (workspace) => {
          transitionedToInterrupted = false;
          planFailureSuperseded = rowSupersedes(workspace, args.streamAttemptId);
          if (planFailureSuperseded) return;
          transitionedToInterrupted = workspace.taskStatus !== "interrupted";
          parentWorkspaceId = workspace.parentWorkspaceId;
          workspace.taskStatus = "interrupted";
          markChildGoalPauseOwed(workspace);
          workspace.taskLaunchError = error.message;
        },
        { allowMissing: true }
      );
      if (transitionedToInterrupted) {
        this.recordTaskInterrupted(args.workspaceId, parentWorkspaceId);
      }
      if (!planFailureSuperseded) await this.settleChildGoalPause(args.workspaceId);
      // Waiters of a row another writer re-admitted belong to that attempt, not this failure.
      if (!planFailureSuperseded) this.rejectWaiters(args.workspaceId, error);
      await this.emitWorkspaceMetadata(args.workspaceId);
      return;
    }

    let planSummary: { content: string; path: string } | null = null;
    try {
      const info = await this.workspaceService.getInfo(args.workspaceId);
      if (!info) {
        log.error("Workflow plan completion could not read workspace metadata", {
          workspaceId: args.workspaceId,
        });
      } else {
        const runtime = createRuntimeForWorkspace(info);
        const planResult = await readPlanFile(
          runtime,
          await resolvePlanFileLocation(this.config, runtime, info, this.historyService.locks)
        );
        if (planResult.exists && planResult.content.trim().length > 0) {
          if (planResult.path !== args.proposePlanResult.planPath) {
            log.debug("Workflow plan completion using canonical plan file path", {
              workspaceId: args.workspaceId,
              proposedPlanPath: args.proposePlanResult.planPath,
              canonicalPlanPath: planResult.path,
            });
          }
          planSummary = { content: planResult.content, path: planResult.path };
        } else {
          log.error("Workflow plan completion did not find non-empty plan file content", {
            workspaceId: args.workspaceId,
            planPath: args.proposePlanResult.planPath,
            canonicalPlanPath: planResult.path,
          });
        }
      }
    } catch (error: unknown) {
      log.error("Workflow plan completion failed to read plan file", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    }

    if (planSummary == null) {
      // No plan content: this propose_plan is no terminal report after all, so the attempt
      // continues. Decide (and wake the held queue) before the completion prompt, as for any
      // other non-report end: the prompt's admission reads a still-pending decision for its
      // attempt as stale and would be refused, leaving the task awaiting a report forever.
      this.streamEndLedger.resolveStreamEndDecision(
        args.workspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          args.workspaceId,
          args.reportedAttempt,
          args.reportedAttempt == null ? (args.streamAttemptId ?? undefined) : undefined
        ),
        "nonreport"
      );
      await this.editActiveWorkspaceEntry(
        args.workspaceId,
        (workspace) => {
          if (rowSupersedes(workspace, args.streamAttemptId)) return;
          workspace.taskStatus = "awaiting_report";
          workspace.reportedAt = undefined;
        },
        { allowMissing: true }
      );
      await this.emitWorkspaceMetadata(args.workspaceId);
      await this.promptTaskForRequiredCompletionTool(args.workspaceId, {
        reason: "stream_end",
        expectedAttemptId: args.streamAttemptId,
      });
      return;
    }

    const finalization = await this.finalizeAgentTaskReport(
      args.workspaceId,
      args.entry,
      {
        reportMarkdown: planSummary.content,
        title: "Proposed plan",
        planFilePath: planSummary.path,
      },
      args.reportedAttempt,
      args.streamAttemptId
    );
    if (finalization.finalized) {
      await this.finalizeTerminationPhaseForReportedTask(args.workspaceId);
    } else if (finalization.reason !== "superseded_attempt") {
      // A superseded report leaves the stable-id waiters to the attempt that owns the row now.
      this.rejectWaiters(args.workspaceId, new Error(finalization.message));
    }
  }

  private async handleSuccessfulProposePlanAutoHandoff(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
    /** The ended stream's attempt: the handoff's writes are CAS'd on it (see AttemptFence). */
    streamAttemptId: AttemptFence;
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: planPath must be non-empty"
    );

    if (this.handoffInProgress.has(args.workspaceId)) {
      log.debug("Skipping duplicate plan-task auto-handoff", { workspaceId: args.workspaceId });
      return;
    }

    this.handoffInProgress.add(args.workspaceId);

    try {
      let planSummary: { content: string; path: string } | null = null;

      try {
        const info = await this.workspaceService.getInfo(args.workspaceId);
        if (!info) {
          log.error("Plan-task auto-handoff could not read workspace metadata", {
            workspaceId: args.workspaceId,
          });
        } else {
          const runtime = createRuntimeForWorkspace(info);
          const planResult = await readPlanFile(
            runtime,
            await resolvePlanFileLocation(this.config, runtime, info, this.historyService.locks)
          );
          if (planResult.exists) {
            planSummary = { content: planResult.content, path: planResult.path };
          } else {
            log.error("Plan-task auto-handoff did not find plan file content", {
              workspaceId: args.workspaceId,
              planPath: args.proposePlanResult.planPath,
            });
          }
        }
      } catch (error: unknown) {
        log.error("Plan-task auto-handoff failed to read plan file", {
          workspaceId: args.workspaceId,
          planPath: args.proposePlanResult.planPath,
          error,
        });
      }

      const targetAgentId = "exec" as const;

      const summaryContent = planSummary
        ? `# Plan\n\n${planSummary.content}\n\nNote: This chat already contains the full plan; no need to re-open the plan file.\n\n---\n\n*Plan file preserved at:* \`${planSummary.path}\``
        : `A plan was proposed at ${args.proposePlanResult.planPath}. Read the plan file and implement it.`;

      const summaryMessage = createMuxMessage(
        createCompactionSummaryMessageId(),
        "assistant",
        summaryContent,
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: "plan",
        }
      );

      // The metadata and plan-file reads above awaited: another backend sharing this Xum root may
      // have re-admitted the row meanwhile, and the compaction boundary must not land in its
      // history (#4414). This check is only an early exit; the authoritative one is admitsAppend,
      // which replaceHistory evaluates under the cross-process history write lock right before the
      // append. A re-admission landing before that check refuses the boundary. One landing after
      // it cannot write history until this append releases the lock (its reawaken CAS precedes its
      // first row), so the boundary is ordered before every row of the successor: the same as
      // "A finished its handoff, then B took over". The rest of the handoff is CAS'd below.
      if (
        rowSupersedes(
          findWorkspaceEntry(this.config.loadConfigOrDefault(), args.workspaceId)?.workspace,
          args.streamAttemptId
        )
      ) {
        return;
      }
      let boundaryRefused = false;
      const replaceHistoryResult = await this.workspaceService.replaceHistory(
        args.workspaceId,
        summaryMessage,
        {
          mode: "append-compaction-boundary",
          deletePlanFile: false,
          admitsAppend: () => {
            let row: WorkspaceConfigEntry | undefined;
            try {
              row = findWorkspaceEntry(
                this.config.loadConfigOrDefault({ throwOnError: true }),
                args.workspaceId
              )?.workspace;
            } catch {
              row = undefined; // Unreadable: the attempt cannot be confirmed, so fail closed.
            }
            boundaryRefused = row == null || rowSupersedes(row, args.streamAttemptId);
            return !boundaryRefused;
          },
        }
      );
      if (boundaryRefused) {
        log.info("Plan-task auto-handoff stopped: the row no longer names its attempt", {
          workspaceId: args.workspaceId,
        });
        return;
      }
      if (!replaceHistoryResult.success) {
        log.error("Plan-task auto-handoff failed to compact history", {
          workspaceId: args.workspaceId,
          error: replaceHistoryResult.error,
        });
      }

      // Resolve a new Exec phase from this workspace, not its parent. A Plan-only
      // PRO preference still falls through via the existing workspace fallback.
      const { taskModelString, canonicalModel, effectiveThinkingLevel, effectiveReasoningMode } =
        await this.resolveTaskAISettings({
          cfg: this.config.loadConfigOrDefault(),
          parentWorkspaceId: args.workspaceId,
          parentMeta: args.entry.workspace,
          agentId: targetAgentId,
          parentRuntimeAiSettings: {
            modelString: args.entry.workspace.taskModelString,
            thinkingLevel: args.entry.workspace.taskThinkingLevel,
          },
        });

      let handoffSuperseded = false;
      await this.editWorkspaceEntry(args.workspaceId, (workspace) => {
        handoffSuperseded = rowSupersedes(workspace, args.streamAttemptId);
        if (handoffSuperseded) return;
        workspace.agentId = targetAgentId;
        workspace.agentType = targetAgentId;
        workspace.aiSettings = {
          model: canonicalModel,
          thinkingLevel: effectiveThinkingLevel,
          ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
        };
        workspace.taskModelString = taskModelString;
        workspace.taskThinkingLevel = effectiveThinkingLevel;
        // The handoff starts a fresh Exec phase and ignores explicit spawn arguments, so
        // plan-phase pins end here. Keep the marker: the task stays new-style (refreshable).
        if (workspace.taskAiPins != null) workspace.taskAiPins = {};
        // A successful propose_plan is a successful completion-tool outcome: the
        // exec phase starts with a fresh recovery budget rather than inheriting
        // whatever the plan phase consumed.
        delete workspace.taskRecoveryAttempts;
      });
      // Another writer re-admitted the row meanwhile: the handoff belongs to its attempt now.
      if (handoffSuperseded) return;

      // A lost status write means another writer took the row after the edit above: the kickoff
      // is not this handoff's to send (#4414).
      if (
        !(await this.setTaskStatus(args.workspaceId, "running", {
          expectedAttemptId: args.streamAttemptId,
        }))
      ) {
        return;
      }

      try {
        // Admission classification: plan→exec kickoff continues the handoff's attempt (no
        // rotation). With a captured attempt it is bound to that attempt here, synchronously
        // before the handoff: left to the handoff it would bind to whichever attempt holds the row
        // then, e.g. a successor another backend admitted after the status write (#4414). Without
        // one (pre-identity) the fence at the WorkspaceService handoff binds it as before.
        let kickoffToken: TurnAdmissionToken | undefined;
        if (args.streamAttemptId != null) {
          const admission = this.admitTaskWorkspaceTurn(args.workspaceId, {
            acceptanceOrigin: "automatic",
            expectedAttemptId: args.streamAttemptId,
          });
          if (admission.kind !== "admitted") {
            log.info("[task-attempt] plan-handoff kickoff refused: decided for a stale attempt", {
              workspaceId: args.workspaceId,
            });
            return;
          }
          kickoffToken = admission.token;
        }
        const sendKickoffResult = await this.workspaceService.sendMessage(
          args.workspaceId,
          "Implement the plan.",
          {
            model: taskModelString,
            agentId: targetAgentId,
            thinkingLevel: effectiveThinkingLevel,
            ...(effectiveReasoningMode != null ? { reasoningMode: effectiveReasoningMode } : {}),
          },
          {
            acceptanceOrigin: "automatic",
            synthetic: true,
            agentInitiated: true,
            ...(kickoffToken != null
              ? {
                  turnAdmission: kickoffToken,
                  admissionStale: () => kickoffToken.admissionStale(),
                }
              : {}),
          }
        );
        if (!sendKickoffResult.success) {
          // Keep status as "running" so the restart handler in initialize() can
          // re-attempt the kickoff on next startup, rather than moving to
          // "awaiting_report" which could finalize the task prematurely.
          log.error(
            "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
            {
              workspaceId: args.workspaceId,
              targetAgentId,
              error: sendKickoffResult.error,
            }
          );
        }
      } catch (error: unknown) {
        // Same as above: leave status as "running" for restart recovery.
        log.error(
          "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
          {
            workspaceId: args.workspaceId,
            targetAgentId,
            error,
          }
        );
      }
    } catch (error: unknown) {
      log.error("Plan-task auto-handoff failed", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    } finally {
      this.handoffInProgress.delete(args.workspaceId);
    }
  }

  private async finalizeTerminationPhaseForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "finalizeTerminationPhaseForReportedTask: workspaceId must be non-empty"
    );

    await this.cleanupReportedLeafTask(workspaceId);
  }

  async maybeStartPatchGenerationForReportedTask(
    workspaceId: string,
    options?: { refreshForContinuation?: boolean }
  ): Promise<void> {
    assert(
      workspaceId.length > 0,
      "maybeStartPatchGenerationForReportedTask: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const parentWorkspaceId = findWorkspaceEntry(cfg, workspaceId)?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }

    try {
      await this.gitPatchArtifactService.maybeStartGeneration(
        parentWorkspaceId,
        workspaceId,
        (wsId) => this.requestReportedTaskCleanupRecheck(wsId),
        options
      );
    } catch (error: unknown) {
      log.error("Failed to start subagent git patch generation", {
        parentWorkspaceId,
        childWorkspaceId: workspaceId,
        error,
      });
    }
  }

  private requestReportedTaskCleanupRecheck(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "requestReportedTaskCleanupRecheck: workspaceId must be non-empty"
    );

    return this.workspaceEventLocks.withLock(workspaceId, async () => {
      await this.cleanupReportedLeafTask(workspaceId);
    });
  }

  private async requestReportedChildCleanupRechecks(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "requestReportedChildCleanupRechecks: parentWorkspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const reportedChildTaskIds: string[] = [];
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const workspaceId = coerceNonEmptyString(workspace.id);
        if (!workspaceId || workspace.parentWorkspaceId !== parentWorkspaceId) {
          continue;
        }
        if (!hasCompletedAgentReport(workspace)) {
          continue;
        }
        reportedChildTaskIds.push(workspaceId);
      }
    }

    for (const workspaceId of reportedChildTaskIds) {
      await this.requestReportedTaskCleanupRecheck(workspaceId);
    }
  }

  private async deliverDeferredBestOfReportsForParent(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "deliverDeferredBestOfReportsForParent: parentWorkspaceId must be non-empty"
    );

    const pendingGroup = await this.resolvePendingBestOfGroupForParent(parentWorkspaceId);
    if (!pendingGroup) {
      return;
    }

    await this.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId,
      groupId: pendingGroup.groupId,
      total: pendingGroup.total,
    });
  }

  private async resolvePendingBestOfGroupForParent(
    parentWorkspaceId: string
  ): Promise<{ groupId: string; total: number } | null> {
    const partial = await this.historyService.readPartial(parentWorkspaceId);
    if (!partial) {
      return null;
    }

    // Every step below is sync, so the config and legacy reads run in the tick of the partial read.
    const request = readPendingBestOfRequest(partial);
    if (!request) {
      return null;
    }

    const groups = collectConfigBestOfGroups(
      this.config.loadConfigOrDefault(),
      parentWorkspaceId,
      request
    );
    if (request.legacyVariants) {
      collectLegacyBestOfGroups(
        this.config.listLegacyTaskVariantWorkspaces(parentWorkspaceId),
        request,
        groups
      );
    }

    return selectPendingBestOfGroup(groups, request.partialStartedAt);
  }

  private async deliverDeferredBestOfSiblingReports(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<void> {
    assert(
      params.parentWorkspaceId.length > 0,
      "deliverDeferredBestOfSiblingReports: parentWorkspaceId must be non-empty"
    );

    const cleanupTaskIds = new Set<string>();
    await this.deferredBestOfLocks.withLock(params.parentWorkspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const siblings = this.listBestOfSiblingTasks({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      });
      if (groupedOutput) {
        const representativeTaskId = siblings[0]?.taskId;
        if (representativeTaskId) {
          const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
            params.parentWorkspaceId,
            groupedOutput,
            representativeTaskId,
            findWorkspaceEntry(cfg, representativeTaskId)
          );
          if (finalization.kind === "finalized") {
            for (const taskId of finalization.taskIds) {
              cleanupTaskIds.add(taskId);
            }
            return;
          }
        }
      }

      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId: params.parentWorkspaceId,
          groupId: params.groupId,
          total: params.total,
        })
      ) {
        return;
      }

      const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
      const syntheticReportTaskIds = new Set<string>();
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        params.parentWorkspaceId
      );
      if (historyResult.success) {
        for (const message of historyResult.data) {
          if (message.role !== "user" || message.metadata?.synthetic !== true) {
            continue;
          }
          const text = message.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const reportEnvelope = parseSubagentReportEnvelope(text);
          if (reportEnvelope == null || reportEnvelope.status === "in_progress") {
            continue;
          }
          syntheticReportTaskIds.add(reportEnvelope.taskId);
        }
      }

      const parentSessionDir = path.join(this.config.sessionsDir, params.parentWorkspaceId);
      for (const sibling of siblings) {
        if (
          parentTaskToolState.referencedTaskIds.has(sibling.taskId) ||
          syntheticReportTaskIds.has(sibling.taskId)
        ) {
          continue;
        }
        if (!(sibling.taskStatus === "reported" || sibling.taskStatus === "interrupted")) {
          continue;
        }

        const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
        if (!artifact) {
          continue;
        }

        const siblingCleanupTaskIds = await this.deliverReportToParentUnlocked(
          params.parentWorkspaceId,
          sibling.taskId,
          findWorkspaceEntry(cfg, sibling.taskId),
          {
            reportMarkdown: artifact.reportMarkdown,
            ...(artifact.title !== undefined ? { title: artifact.title } : {}),
            ...(artifact.planFilePath !== undefined ? { planFilePath: artifact.planFilePath } : {}),
            ...(artifact.structuredOutput !== undefined
              ? { structuredOutput: artifact.structuredOutput }
              : {}),
          }
        );
        for (const taskId of siblingCleanupTaskIds) {
          cleanupTaskIds.add(taskId);
        }
      }
    });

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async getChildReportCostCents(childWorkspaceId: string): Promise<number> {
    assert(childWorkspaceId.trim().length > 0, "getChildReportCostCents requires childWorkspaceId");
    if (!this.sessionUsageService) {
      return 0;
    }

    try {
      const childUsage = await this.sessionUsageService.getSessionUsage(childWorkspaceId);
      if (!childUsage) {
        return 0;
      }
      return Math.max(
        0,
        Math.round((getTotalCost(sumUsageHistory(Object.values(childUsage.byModel))) ?? 0) * 100)
      );
    } catch (error) {
      log.warn("Failed to read child usage for goal attribution", { childWorkspaceId, error });
      return 0;
    }
  }

  private async attributeChildReportToParentGoal(
    parentWorkspaceId: string,
    childWorkspaceId: string
  ): Promise<void> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires parentWorkspaceId"
    );
    assert(
      childWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires childWorkspaceId"
    );
    if (!this.workspaceGoalService) {
      return;
    }

    // Rolled up once, at report time, and inclusive of the child's own goal turns: the parent's
    // budget is not a strict ceiling on a child pursuing its own goal (the child's goal caps that).
    const childCostCents = await this.getChildReportCostCents(childWorkspaceId);
    const attribution = await this.workspaceGoalService.attributeChildReport({
      parentWorkspaceId,
      childWorkspaceId,
      childCostCents,
    });
    if (!attribution?.causedBudgetLimit) {
      return;
    }

    this.workspaceService.emitChatEvent(parentWorkspaceId, {
      type: "goal-budget-limited",
      workspaceId: parentWorkspaceId,
      goalId: attribution.goalAfter.goalId,
      causedByChild: true,
      childWorkspaceId,
      message: "Child workspace exceeded the parent's goal budget.",
    });
  }

  private async shouldAllowLegacyInvalidWorkflowOutputSchema(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<boolean> {
    const workflowTask = childEntry?.workspace.workflowTask;
    if (workflowTask?.outputSchema === undefined) {
      return false;
    }
    if (
      validateJsonSchemaSubsetSchema(workflowTask.outputSchema, { requireObjectSchema: true })
        .success
    ) {
      return false;
    }
    const parentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
    if (parentWorkspaceId == null) {
      return false;
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: path.join(this.config.sessionsDir, parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      return run.agentOutputSchemaRequired !== true;
    } catch (error) {
      log.debug("Could not determine legacy workflow schema validation policy", {
        childWorkspaceId,
        workflowRunId: workflowTask.runId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async finalizeAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    rawReportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    },
    /** The attempt whose stream carried this report (see releaseReportedTaskAttempt). */
    reportedAttempt: OwnedTaskAttempt | undefined,
    /**
     * The attempt the reporting stream ran under (owned, or for an unowned stream the one it was
     * admitted under — resolveStreamAttemptAtEvent). The report's writes are CAS'd on it — a row
     * another writer re-admitted meanwhile is theirs, and this report is never published as
     * theirs. See AttemptFence (`null`: no proven attempt, today's unconditional writes).
     */
    reportedAttemptId: AttemptFence
  ): Promise<AgentReportFinalizationResult> {
    this.markTaskForegroundRelevant(childWorkspaceId);

    assert(
      childWorkspaceId.length > 0,
      "finalizeAgentTaskReport: childWorkspaceId must be non-empty"
    );
    assert(
      typeof rawReportArgs.reportMarkdown === "string" && rawReportArgs.reportMarkdown.length > 0,
      "finalizeAgentTaskReport: reportMarkdown must be non-empty"
    );

    const cfgBeforeReport = this.config.loadConfigOrDefault();
    const latestEntryBeforeReport =
      findWorkspaceEntry(cfgBeforeReport, childWorkspaceId) ?? childEntry;
    if ((latestEntryBeforeReport?.workspace.taskPendingGuidance?.length ?? 0) > 0) {
      return {
        finalized: false,
        reason: "pending_guidance",
        message: "A parent guidance update is pending; ignore this stale report.",
      };
    }

    const statusBefore = latestEntryBeforeReport?.workspace.taskStatus;
    if (statusBefore === "reported") {
      return { finalized: true };
    }

    const allowLegacyInvalidOutputSchema = await this.shouldAllowLegacyInvalidWorkflowOutputSchema(
      childWorkspaceId,
      latestEntryBeforeReport
    );
    const reportArgs = normalizeWorkflowAgentReportArgsForWorkflowTask(
      latestEntryBeforeReport?.workspace.workflowTask,
      rawReportArgs
    );
    const validationMessage = validateWorkflowAgentReportStructuredOutput({
      workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
      reportArgs,
      allowLegacyInvalidOutputSchema,
    });
    if (validationMessage != null) {
      log.warn("Rejecting invalid workflow agent_report structured output", {
        childWorkspaceId,
        workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
        message: validationMessage,
      });
      if (statusBefore === "interrupted") {
        return {
          finalized: false,
          reason: "terminal_interrupted",
          message: validationMessage,
        };
      }

      // A rejected report is no terminal report: the attempt continues. Decide the reporting
      // stream's pending decision before the completion prompt, as handleStreamEnd does for any
      // other non-report end: the prompt's admission reads a still-pending decision for its
      // attempt as stale and is refused, leaving the workflow step awaiting a report forever.
      this.streamEndLedger.resolveStreamEndDecision(
        childWorkspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          childWorkspaceId,
          reportedAttempt,
          reportedAttempt == null ? (reportedAttemptId ?? undefined) : undefined
        ),
        "nonreport"
      );
      await this.editActiveWorkspaceEntry(
        childWorkspaceId,
        (ws) => {
          if (rowSupersedes(ws, reportedAttemptId)) return;
          ws.taskStatus = "awaiting_report";
          ws.reportedAt = undefined;
        },
        { allowMissing: true }
      );
      await this.emitWorkspaceMetadata(childWorkspaceId);
      await this.promptTaskForRequiredCompletionTool(childWorkspaceId, {
        reason: "error",
        error: { error: validationMessage, errorType: "unknown" },
        structuredOutputDiagnostic: validationMessage,
        expectedAttemptId: reportedAttemptId,
      });
      return {
        finalized: false,
        reason: "invalid_structured_output",
        message: validationMessage,
      };
    }

    // A best-of sibling's status flip and artifact write must not interleave with the grouped
    // assembly that runs under this lock (deliverReportToParent, startup recovery): an assembly
    // that read the old artifact of a sibling already marked reported would finalize the parent
    // on the report this publication is replacing.
    const bestOfParentWorkspaceId =
      latestEntryBeforeReport != null &&
      (this.getEffectiveTaskGroup(childWorkspaceId, latestEntryBeforeReport.workspace)?.total ??
        1) > 1
        ? latestEntryBeforeReport.workspace.parentWorkspaceId
        : undefined;
    const publish = () =>
      this.publishAgentTaskReport(
        childWorkspaceId,
        childEntry,
        latestEntryBeforeReport,
        reportArgs,
        reportedAttempt,
        reportedAttemptId
      );
    const published =
      bestOfParentWorkspaceId != null
        ? await this.deferredBestOfLocks.withLock(bestOfParentWorkspaceId, publish)
        : await publish();
    if (published === "superseded") {
      return {
        finalized: false,
        reason: "superseded_attempt",
        message: "The task was re-admitted under another attempt; this report was not published.",
      };
    }
    if (published === "retired") {
      // Same attempt, so the stable-id waiters are this attempt's: callers reject them (#4545).
      return {
        finalized: false,
        reason: "retired_attempt",
        message:
          "A workflow retired this task attempt and its replacement owns the outcome; this report was not published.",
      };
    }
    if (!published) {
      return { finalized: true };
    }
    const { parentWorkspaceId, latestChildEntry, isWorkflowOwnedChildReport } = published;

    // Goal attribution is informational; if it throws (permissions failure,
    // disk-full, corrupted extensionMetadata.json in pushSnapshot), execution
    // would otherwise exit before reaching deliverReportToParent / waiter
    // resolution / queue drain — leaving the parent's task_await waiting
    // indefinitely (Coder-agents-review P1 DEREM-14). Match the
    // upsertSubagentReportArtifact pattern above: log and continue.
    try {
      await this.attributeChildReportToParentGoal(parentWorkspaceId, childWorkspaceId);
    } catch (error: unknown) {
      log.error("Failed to attribute child report to parent goal", {
        parentWorkspaceId,
        childWorkspaceId,
        error,
      });
    }

    await this.maybeStartPatchGenerationForReportedTask(childWorkspaceId);

    await this.deliverReportToParent(
      parentWorkspaceId,
      childWorkspaceId,
      latestChildEntry,
      reportArgs
    );

    const hadForegroundWaiters = this.resolveWaiters(childWorkspaceId, {
      ...reportArgs,
      model: latestChildEntry?.workspace.taskModelString,
      thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
    });

    // Track 2 r5: surface the terminal report into the parent's persistent
    // sandbox mount so a later code_execution eval can drain it via
    // mux.events(). Foreground waiters (blocking mux.task / task_await)
    // already consume the report directly, so skip the queue to avoid
    // double-delivery. Fire-and-forget by contract: the oversized-report path
    // acquires the scope lock (a long-running eval may hold it), and the
    // queue is best-effort acceleration — the durable terminal wake below
    // remains the source of truth, so failures only log.
    if (!hadForegroundWaiters) {
      void sandboxHostService
        .postTaskTerminalEvent(parentWorkspaceId, {
          taskId: childWorkspaceId,
          status: "completed",
          reportMarkdown: reportArgs.reportMarkdown,
        })
        .catch((error: unknown) => {
          log.warn("Failed to post task terminal event to sandbox mount", {
            parentWorkspaceId,
            childWorkspaceId,
            error,
          });
        });
    }

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(postCfg, parentWorkspaceId);
    if (!parentEntry) {
      // Parent may have been cleaned up (e.g. it already reported and this was its last descendant).
      return { finalized: true };
    }
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }

    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping post-report parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return { finalized: true };
    }

    if (hadForegroundWaiters) {
      log.debug("Skipping post-report parent auto-resume: report delivered to foreground waiter", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return { finalized: true };
    }

    if (isWorkflowOwnedChildReport) {
      // Workflow-owned tasks report through WorkflowRunner's journal/final-result path. Do not
      // also resume the parent directly from the child report.
      log.debug("Skipping post-report parent auto-resume for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      this.scheduleTerminalAttentionDrain(parentWorkspaceId);
      return { finalized: true };
    }

    // The report is already injected into parent history above (deliverReportToParent). Enqueue the
    // notification even when other children are still active: the drain defers on blocking work and
    // a later foreground-awaited sibling may suppress its own wake-up.
    const generationId = await this.getAgentTerminalAttentionGenerationId(
      parentWorkspaceId,
      childWorkspaceId
    );
    await this.enqueueTerminalAttention({
      ownerWorkspaceId: parentWorkspaceId,
      sourceKind: "agent_task",
      terminalOutcome: "completed",
      sourceId: childWorkspaceId,
      ...(generationId != null ? { generationId } : {}),
    });

    return { finalized: true };
  }

  /**
   * Marks the child reported and persists its report artifact in every ancestor session dir.
   * Returns null when the child is not an agent task (no parent to deliver to).
   */
  private async publishAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    latestEntryBeforeReport:
      | { projectPath: string; workspace: WorkspaceConfigEntry }
      | null
      | undefined,
    reportArgs: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    },
    reportedAttempt: OwnedTaskAttempt | undefined,
    /** See finalizeAgentTaskReport: the reporting stream's attempt (CAS on the row). */
    expectedAttemptId: AttemptFence
  ): Promise<
    | {
        parentWorkspaceId: string;
        latestChildEntry:
          | { projectPath: string; workspace: WorkspaceConfigEntry }
          | null
          | undefined;
        isWorkflowOwnedChildReport: boolean;
      }
    | null
    | "superseded"
    | "retired"
  > {
    // An unowned stream's decision (see StreamEndDecision) is keyed by the attempt the stream was
    // admitted under when the caller knows it, else by the row as read before this report.
    const unownedReportedAttemptId =
      reportedAttempt == null
        ? (expectedAttemptId ?? latestEntryBeforeReport?.workspace.taskAttemptId)
        : undefined;
    let superseded = false;
    let retired = false;
    // The attempt the `reported` write below lands on: every artifact of this report is bound to it
    // (#7003), so a reader can tell it from an earlier attempt's report.
    let reportedAttemptId: string | undefined;
    // A report ends the attempt, never the goal: the child's goal pause is owed in the same write
    // that publishes the report (never completed), and settled below.
    // Notify clients immediately even if we can't delete the workspace yet.
    await this.editWorkspaceEntry(
      childWorkspaceId,
      (ws) => {
        // A workflow claim retired the attempt (#4545): its replacement owns the step's outcome, so
        // a late report (another backend's turn bound to the same id) is refused. The claim needs
        // `interrupted` and this write sets `reported`, so config lets exactly one of them land.
        retired = ws.taskAttemptRetiredBy != null;
        superseded = retired || rowSupersedes(ws, expectedAttemptId);
        if (superseded) return;
        reportedAttemptId = ws.taskAttemptId;
        ws.taskStatus = "reported";
        ws.reportedAt = getIsoNow();
        markChildGoalPauseOwed(ws);
        // Successful completion resets the persisted recovery circuit breaker.
        delete ws.taskRecoveryAttempts;
      },
      { allowMissing: true }
    );
    if (superseded) {
      log.info(
        retired
          ? "[task-attempt] report not published: a workflow claim retired its attempt"
          : "[task-attempt] report not published: its attempt was superseded by another writer",
        {
          childWorkspaceId,
          attemptId: expectedAttemptId,
        }
      );
      // Never a continuation of the reporting attempt; its held entries are refused (they also
      // read stale at their own gates, since the row names another attempt).
      this.streamEndLedger.resolveStreamEndDecision(
        childWorkspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          childWorkspaceId,
          reportedAttempt,
          unownedReportedAttemptId
        ),
        "indeterminate"
      );
      return retired ? "retired" : "superseded";
    }
    this.clearTaskRecovery(childWorkspaceId);
    await this.settleChildGoalPause(childWorkspaceId);
    // Drop queued incremental updates synchronously with the terminal commit: while they sit at
    // the parent's queue head as tool-end entries, the parent's stream stops at its next step
    // boundary for them, and a dispatch refused as superseded cannot restore that cut turn.
    // skipCancelCallbacks: a parent running as a delegated workspace turn queues each report with
    // continuation-failure callbacks; superseding the report must not interrupt that live turn.
    const progressParentWorkspaceId = latestEntryBeforeReport?.workspace.parentWorkspaceId;
    if (progressParentWorkspaceId) {
      const queuedProgressRemoval = this.workspaceService.removeQueuedMessagesByDedupeKeyPrefix(
        progressParentWorkspaceId,
        agentReportProgressDedupePrefix(childWorkspaceId),
        { cancelReason: AGENT_REPORT_PROGRESS_SUPERSEDED_REASON, skipCancelCallbacks: true }
      );
      if (!queuedProgressRemoval.success) {
        log.warn("Failed to remove queued incremental sub-agent reports", {
          parentWorkspaceId: progressParentWorkspaceId,
          childWorkspaceId,
          error: queuedProgressRemoval.error,
        });
      }
    }
    eventSpine.emit("task.reported", { workspaceId: childWorkspaceId, taskId: childWorkspaceId });

    await this.emitWorkspaceMetadata(childWorkspaceId);

    // NOTE: Stream continues — we intentionally do NOT abort it.
    // Deterministic termination is enforced by StreamManager stopWhen logic that
    // waits for an agent_report tool result where output.success === true at the
    // step boundary (preserving usage accounting). recordSessionUsage runs when
    // the stream ends naturally.

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const latestChildEntry = findWorkspaceEntry(cfgAfterReport, childWorkspaceId) ?? childEntry;
    const parentWorkspaceId = latestChildEntry?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      const reason = latestChildEntry
        ? "missing parentWorkspaceId"
        : "workspace not found in config";
      log.debug("Ignoring agent_report: workspace is not an agent task", {
        childWorkspaceId,
        reason,
      });
      // Best-effort: resolve any foreground waiters even if we can't deliver to a parent.
      this.resolveWaiters(childWorkspaceId, reportArgs);
      this.scheduleMaybeStartQueuedTasks();
      // Reported row, no release, nobody to report to: not a continuation of the attempt.
      this.streamEndLedger.resolveStreamEndDecision(
        childWorkspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          childWorkspaceId,
          reportedAttempt,
          unownedReportedAttemptId
        ),
        "indeterminate"
      );
      return null;
    }

    const reportTitle = coerceNonEmptyString(reportArgs.title);
    this.timelineRecorder.record(parentWorkspaceId, {
      kind: "task.reported",
      // Background reports are also injected into parent history, which the timeline maps; keying
      // both on the task keeps one row per report.
      source: { system: "task", key: subagentReportSourceKey(childWorkspaceId) },
      status: "completed",
      anchor: { taskId: childWorkspaceId, childWorkspaceId },
      data: {
        ...(reportTitle ? { title: reportTitle } : {}),
        digest: reportArgs.reportMarkdown,
      },
    });

    const isWorkflowOwnedChildReport = latestChildEntry?.workspace.workflowTask != null;

    const indexAfterReport = this.buildAgentTaskIndex(cfgAfterReport);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      indexAfterReport.parentById,
      childWorkspaceId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
          indexAfterReport,
          ancestorWorkspaceId,
          childWorkspaceId
        ) === true
    );

    // Persist the completed report in the session dirs of all ancestors so `task_await` can
    // retrieve it after cleanup/restart (even if the task workspace itself is deleted).
    const persistedAtMs = Date.now();
    let persistedInEveryAncestor = ancestorWorkspaceIds.length > 0;
    for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
      try {
        const ancestorSessionDir = path.join(this.config.sessionsDir, ancestorWorkspaceId);
        await upsertSubagentReportArtifact({
          locks: this.historyService.locks,
          workspaceId: ancestorWorkspaceId,
          workspaceSessionDir: ancestorSessionDir,
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          ancestorWorkspaceIds,
          workflowOwnedAncestorWorkspaceIds,
          reportMarkdown: reportArgs.reportMarkdown,
          model: latestChildEntry?.workspace.taskModelString,
          thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
          title: reportArgs.title,
          planFilePath: reportArgs.planFilePath,
          structuredOutput: reportArgs.structuredOutput,
          nowMs: persistedAtMs,
          taskAttemptId: reportedAttemptId,
        });
      } catch (error: unknown) {
        persistedInEveryAncestor = false;
        log.error("Failed to persist subagent report artifact", {
          workspaceId: ancestorWorkspaceId,
          childTaskId: childWorkspaceId,
          error,
        });
      }
    }
    // The decision for the attempt's ended stream is settled here, before the parent delivery:
    // durable everywhere → published (held follow-ups are refused and handed back); otherwise the
    // row says reported while the attempt stays owned — neither a continuation nor a completion,
    // so held follow-ups are refused rather than run under an attempt of unknown standing.
    if (persistedInEveryAncestor) {
      this.attemptLedger.releaseReportedTaskAttempt(childWorkspaceId, reportedAttempt);
      this.streamEndLedger.resolveStreamEndDecision(
        childWorkspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          childWorkspaceId,
          reportedAttempt,
          unownedReportedAttemptId
        ),
        "published"
      );
    } else {
      this.streamEndLedger.resolveStreamEndDecision(
        childWorkspaceId,
        this.streamEndLedger.findPendingStreamEndDecision(
          childWorkspaceId,
          reportedAttempt,
          unownedReportedAttemptId
        ),
        "indeterminate"
      );
    }

    return { parentWorkspaceId, latestChildEntry, isWorkflowOwnedChildReport };
  }

  /**
   * waitForAgentReport's read of the report persisted in the requesting workspace's session dir,
   * adopting it for a row that has not reported yet (#7003: only the row's own attempt's report).
   */
  private async readPersistedReportForWait(
    taskId: string,
    requestingWorkspaceId: string | undefined
  ): Promise<{
    reportMarkdown: string;
    planFilePath?: string;
    structuredOutput?: unknown;
    title?: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
  } | null> {
    if (!requestingWorkspaceId) {
      return null;
    }

    const sessionDir = path.join(this.config.sessionsDir, requestingWorkspaceId);
    const artifact = await readSubagentReportArtifact(sessionDir, taskId);
    if (!artifact) {
      return null;
    }

    // #7003: compared BEFORE the cache below, so an ignored artifact (another attempt's) is never
    // served from it later; adoption is a CAS on the compared attempt.
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), taskId);
    const adopt = entry != null && !hasCompletedAgentReport(entry.workspace);
    if (adopt && !(await this.adoptPersistedReport(taskId, artifact, entry.workspace))) {
      return null;
    }

    // Cache for the current process (best-effort). Disk is the source of truth.
    this.waiters.cacheCompletedReport(taskId, {
      reportMarkdown: artifact.reportMarkdown,
      title: artifact.title,
      planFilePath: artifact.planFilePath,
      structuredOutput: artifact.structuredOutput,
      model: artifact.model,
      thinkingLevel: artifact.thinkingLevel,
      workflowOwnedAncestorWorkspaceIds: artifact.workflowOwnedAncestorWorkspaceIds,
      ancestorWorkspaceIds: artifact.ancestorWorkspaceIds,
    });

    // After the committed `reported` (ours above, or the other backend's): a report bound to the
    // row's attempt settles that attempt's stream-end decision (#7003); the notification then
    // re-runs its deferral (the row no longer reads running).
    if (this.streamEndLedger.resolveDecisionOfReportedAttempt(taskId, artifact.taskAttemptId)) {
      this.notifyAttemptSettlementListeners(taskId);
    }
    if (adopt) {
      // After the write resolves, so listeners read the committed `reported`: a deferred child
      // stream end settles now instead of waiting for its accounting (#6994).
      this.notifyAttemptSettlementListeners(taskId);
      // Adopting an already-persisted report owns the same terminal cleanup as publication.
      this.clearTaskRecovery(taskId);
      await this.settleChildGoalPause(taskId);
      eventSpine.emit("task.reported", { workspaceId: taskId, taskId });
      await this.maybeStartPatchGenerationForReportedTask(taskId);
      await this.emitWorkspaceMetadata(taskId);
      await this.maybeStartQueuedTasks();
      await this.cleanupReportedLeafTask(taskId);
    }

    return {
      reportMarkdown: artifact.reportMarkdown,
      title: artifact.title,
      planFilePath: artifact.planFilePath,
      structuredOutput: artifact.structuredOutput,
      model: artifact.model,
      thinkingLevel: artifact.thinkingLevel,
    };
  }

  /**
   * waitForAgentReport's read of the terminal failure persisted in the requesting workspace's
   * session dir. Persisted terminal failures (e.g. model_refusal) are checked AFTER reports —
   * report monotonicity — and surface as rejections, never as reportMarkdown.
   */
  private async readPersistedFailureForWait(request: ReportWaitRequest): Promise<Error | null> {
    if (!request.requestingWorkspaceId) {
      return null;
    }

    const sessionDir = path.join(this.config.sessionsDir, request.requestingWorkspaceId);
    const failure = await readSubagentFailureArtifact(sessionDir, request.taskId);
    return failure ? new Error(failure.errorMessage) : null;
  }

  /**
   * waitForAgentReport's adoption of a persisted report for a row that has not reported: refused
   * (false) unless the artifact belongs to the row (reportArtifactBelongsToUnreportedRow), then
   * `reported` as a CAS on the compared attempt, so a row rotated during the read is left alone.
   */
  private async adoptPersistedReport(
    taskId: string,
    artifact: Pick<SubagentReportArtifact, "taskAttemptId">,
    row: WorkspaceConfigEntry
  ): Promise<boolean> {
    if (!reportArtifactBelongsToUnreportedRow(artifact, row)) return false;
    const rowAttemptId = row.taskAttemptId;
    let rowMoved = false;
    await this.editWorkspaceEntry(
      taskId,
      (workspace) => {
        if (workspace.taskAttemptId !== rowAttemptId) {
          rowMoved = true;
          return;
        }
        workspace.taskStatus = "reported";
        workspace.reportedAt = getIsoNow();
        markChildGoalPauseOwed(workspace);
        delete workspace.taskRecoveryAttempts;
      },
      { allowMissing: true }
    );
    return !rowMoved;
  }

  private resolveWaiters(
    taskId: string,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
      model?: string;
      thinkingLevel?: ThinkingLevel;
    }
  ): boolean {
    this.markTaskForegroundRelevant(taskId);
    this.notifyAttemptSettlementListeners(taskId);

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(index, ancestorWorkspaceId, taskId) ===
        true
    );

    this.waiters.cacheCompletedReport(taskId, {
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      planFilePath: report.planFilePath,
      structuredOutput: report.structuredOutput,
      model: report.model,
      thinkingLevel: report.thinkingLevel,
      ancestorWorkspaceIds,
      workflowOwnedAncestorWorkspaceIds,
    });

    return this.waiters.resolvePendingWaiters(taskId, report);
  }

  // Kept on TaskService: tests spy on it, and every internal rejection goes through here.
  private rejectWaiters(taskId: string, error: Error): void {
    this.waiters.rejectWaiters(taskId, error);
  }

  private findProposePlanSuccessInParts(parts: readonly unknown[]): { planPath: string } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "propose_plan") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;

      const planPath =
        typeof part.output === "object" &&
        part.output !== null &&
        "planPath" in part.output &&
        typeof (part.output as { planPath?: unknown }).planPath === "string"
          ? (part.output as { planPath: string }).planPath.trim()
          : "";
      if (!planPath) continue;

      return { planPath };
    }
    return null;
  }

  private findFinalAssistantResponseInParts(
    parts: readonly unknown[]
  ): { reportMarkdown: string } | null {
    const lastToolIndex = parts.findLastIndex((part) => isDynamicToolPart(part));
    let reportMarkdown = "";
    for (let index = lastToolIndex + 1; index < parts.length; index += 1) {
      const part = parts[index];
      if (!part || typeof part !== "object") continue;
      const maybeText = part as { type?: unknown; text?: unknown };
      if (maybeText.type !== "text" || typeof maybeText.text !== "string") continue;
      reportMarkdown += maybeText.text;
    }

    const trimmedReport = reportMarkdown.trim();
    if (trimmedReport.length === 0) {
      return null;
    }

    return { reportMarkdown: trimmedReport };
  }

  private async findLatestAgentReportArgsInHistory(
    workspaceId: string,
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown } | null> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      log.warn("Failed to read sub-agent history for final report metadata", {
        workspaceId,
        error: historyResult.error,
      });
      return null;
    }

    for (let index = historyResult.data.length - 1; index >= 0; index -= 1) {
      const message = historyResult.data[index];
      if (message.role !== "assistant") {
        continue;
      }
      // A failed newer report invalidates all older structured candidates. Recovery must
      // produce a fresh successful report rather than scanning backward to stale metadata.
      const outcome = this.findLatestAgentReportOutcomeInParts(message.parts, options);
      if (outcome?.kind === "failure") {
        return null;
      }
      if (outcome?.kind === "success") {
        return outcome.report;
      }
    }
    return null;
  }

  private async resolveFinalAgentReportArgs(
    workspaceId: string,
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown } | null> {
    const finalResponse = this.findFinalAssistantResponseInParts(parts);
    if (finalResponse == null) {
      return null;
    }

    // The newest agent_report attempt controls replacement semantics: a newer correction may
    // recover from an earlier failure, while a newer failure invalidates older successes.
    const latestOutcomeInTurn = this.findLatestAgentReportOutcomeInParts(parts, options);
    const latestProgress =
      latestOutcomeInTurn?.kind === "success"
        ? latestOutcomeInTurn.report
        : latestOutcomeInTurn?.kind === "failure"
          ? null
          : await this.findLatestAgentReportArgsInHistory(workspaceId, options);
    return {
      reportMarkdown: finalResponse.reportMarkdown,
      ...(latestProgress?.title !== undefined ? { title: latestProgress.title } : {}),
      ...(latestProgress?.structuredOutput !== undefined
        ? { structuredOutput: latestProgress.structuredOutput }
        : {}),
    };
  }

  private findLatestAgentReportOutcomeInParts(
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ):
    | {
        kind: "success";
        report: { reportMarkdown: string; title?: string; structuredOutput?: unknown };
      }
    | { kind: "failure" }
    | null {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index];
      if (!isDynamicToolPart(part) || part.toolName !== "agent_report") {
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }
      if (!isSuccessfulToolResult(part.output)) {
        return { kind: "failure" };
      }
      const report = this.findAgentReportArgsInParts([part], options);
      return report == null ? { kind: "failure" } : { kind: "success", report };
    }
    return null;
  }

  private findAgentReportArgsInParts(
    parts: readonly unknown[],
    options: { acceptSchemaShapedWorkflowReport?: boolean } = {}
  ): { reportMarkdown: string; title?: string; structuredOutput?: unknown } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "agent_report") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;
      const outputReport = AgentReportSubmittedReportSchema.safeParse(
        typeof part.output === "object" && part.output !== null && "report" in part.output
          ? (part.output as { report?: unknown }).report
          : undefined
      );
      if (outputReport.success) {
        return outputReport.data;
      }

      if (
        options.acceptSchemaShapedWorkflowReport === true &&
        part.input != null &&
        typeof part.input === "object" &&
        !Array.isArray(part.input)
      ) {
        return {
          reportMarkdown: STRUCTURED_WORKFLOW_REPORT_PLACEHOLDER_MARKDOWN,
          structuredOutput: part.input,
        };
      }

      const parsedInlineArgs = AgentReportInlineToolArgsSchema.safeParse(part.input);
      if (parsedInlineArgs.success) {
        // Normalize null → undefined at the schema boundary so downstream
        // code that expects `title?: string` doesn't need to handle null.
        return {
          reportMarkdown: parsedInlineArgs.data.reportMarkdown,
          title: parsedInlineArgs.data.title ?? undefined,
        };
      }
    }
    return null;
  }

  private listBestOfSiblingTasks(params: { parentWorkspaceId: string; groupId: string }): Array<{
    taskId: string;
    index: number;
    agentId?: string;
    agentType?: string;
    taskStatus?: WorkspaceConfigEntry["taskStatus"];
    taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
  }> {
    const cfg = this.config.loadConfigOrDefault();
    const siblings: Array<{
      taskId: string;
      index: number;
      agentId?: string;
      agentType?: string;
      taskStatus?: WorkspaceConfigEntry["taskStatus"];
      taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
    }> = [];

    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const taskId = coerceNonEmptyString(workspace.id);
        if (!taskId) {
          continue;
        }
        if (workspace.parentWorkspaceId !== params.parentWorkspaceId) {
          continue;
        }
        if (workspace.bestOf?.groupId !== params.groupId) {
          continue;
        }
        if (!Number.isInteger(workspace.bestOf.index)) {
          continue;
        }

        siblings.push({
          taskId,
          index: workspace.bestOf.index,
          agentId: coerceNonEmptyString(workspace.agentId),
          agentType: coerceNonEmptyString(workspace.agentType),
          taskStatus: workspace.taskStatus,
          taskExecutionStatus: workspace.taskExecutionStatus,
        });
      }
    }

    const siblingTaskIds = new Set(siblings.map((sibling) => sibling.taskId));
    for (const workspace of this.config.listLegacyTaskVariantWorkspaces(params.parentWorkspaceId)) {
      if (workspace.bestOf.groupId !== params.groupId || siblingTaskIds.has(workspace.id)) {
        continue;
      }
      siblings.push({
        taskId: workspace.id,
        index: workspace.bestOf.index,
        agentId: workspace.agentId,
        agentType: workspace.agentType,
        taskStatus: workspace.taskStatus,
      });
    }

    siblings.sort(
      (left, right) => left.index - right.index || left.taskId.localeCompare(right.taskId)
    );
    return siblings;
  }

  /**
   * A reported sibling that a client reawakened (workspace-turn continuation), that a resume put
   * back to running (its re-run may be between streams or past stream-end but before its
   * publication), or that is streaming still owns its previous report artifact. Finalizing the
   * parent on that artifact would freeze the grouped result on a report the child is replacing,
   * so its group waits for the new report.
   */
  private isBestOfSiblingExecutingAgain(sibling: {
    taskId: string;
    taskStatus?: WorkspaceConfigEntry["taskStatus"];
    taskExecutionStatus?: WorkspaceConfigEntry["taskExecutionStatus"];
  }): boolean {
    return (
      sibling.taskStatus === "running" ||
      sibling.taskStatus === "awaiting_report" ||
      isActiveWorkspaceTurnTaskStatus(sibling.taskExecutionStatus) ||
      this.aiService.isStreaming(sibling.taskId)
    );
  }

  /**
   * Synchronous so the partial-commit transform can re-run it with no await between the check and
   * the write: every sibling the grouped output was assembled from must still be the group and
   * none may be executing again.
   */
  private areBestOfSiblingsStillSettled(params: {
    parentWorkspaceId: string;
    groupId: string;
    assembledTaskIds: readonly string[];
    reportingTaskId?: string;
  }): boolean {
    const liveSiblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    return (
      liveSiblings.length === params.assembledTaskIds.length &&
      liveSiblings.every(
        (sibling, index) =>
          sibling.taskId === params.assembledTaskIds[index] &&
          (sibling.taskId === params.reportingTaskId ||
            !this.isBestOfSiblingExecutingAgain(sibling))
      )
    );
  }

  private async buildBestOfCompletedTaskToolOutput(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
    /** The sibling whose report is being delivered right now; its execution is live by construction. */
    reportingTaskId?: string;
  }): Promise<z.infer<typeof TaskToolResultSchema> | null> {
    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    if (siblings.length === 0) {
      return null;
    }
    if (siblings.length > params.total) {
      log.error("buildBestOfCompletedTaskToolOutput: found more siblings than requested", {
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        siblingCount: siblings.length,
        requestedTotal: params.total,
      });
      return null;
    }

    // Best-of creation can fail or be interrupted after only some candidates are spawned.
    // When recovering an interrupted parent stream, finalize against the siblings that
    // actually exist so the parent task tool call does not stay pending forever.
    const parentSessionDir = path.join(this.config.sessionsDir, params.parentWorkspaceId);
    const reports: Array<{
      taskId: string;
      reportMarkdown: string;
      structuredOutput?: unknown;
      planFilePath?: string;
      title?: string;
      agentId?: string;
      agentType?: string;
      modelString?: string;
      thinkingLevel?: ThinkingLevel;
    }> = [];

    for (const sibling of siblings) {
      if (
        sibling.taskId !== params.reportingTaskId &&
        this.isBestOfSiblingExecutingAgain(sibling)
      ) {
        return null;
      }

      const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
      if (!artifact) {
        return null;
      }

      reports.push({
        taskId: sibling.taskId,
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        planFilePath: artifact.planFilePath,
        structuredOutput: artifact.structuredOutput,
        agentId: sibling.agentId,
        agentType: sibling.agentType,
        modelString: artifact.model,
        thinkingLevel: artifact.thinkingLevel,
      });
    }

    // The artifact reads above awaited disk I/O, during which a client can reawaken a sibling
    // whose old report is already in `reports`; re-read live state once more before handing out.
    // The commit transform repeats this check so a resume landing after this point cannot slip
    // between it and the partial write either.
    const taskIds = siblings.map((sibling) => sibling.taskId);
    if (
      !this.areBestOfSiblingsStillSettled({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        assembledTaskIds: taskIds,
        reportingTaskId: params.reportingTaskId,
      })
    ) {
      return null;
    }

    const output = {
      status: "completed" as const,
      taskIds,
      reports,
    };
    const parsed = TaskToolResultSchema.safeParse(output);
    if (!parsed.success) {
      log.error("buildBestOfCompletedTaskToolOutput: invalid grouped task output", {
        error: parsed.error.message,
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      return null;
    }

    return parsed.data;
  }

  private async getTaskToolPartialState(workspaceId: string): Promise<{
    pendingBestOfTaskToolCount: number;
    pendingTaskToolCount: number;
    referencedTaskIds: Set<string>;
  }> {
    const partial = await this.historyService.readPartial(workspaceId);
    const referencedTaskIds = new Set<string>();
    if (!partial) {
      return {
        pendingBestOfTaskToolCount: 0,
        pendingTaskToolCount: 0,
        referencedTaskIds,
      };
    }

    let pendingBestOfTaskToolCount = 0;
    let pendingTaskToolCount = 0;
    for (const part of partial.parts) {
      if (!isDynamicToolPart(part) || part.toolName !== "task") {
        continue;
      }

      if (part.state === "input-available") {
        pendingTaskToolCount += 1;
        const parsedInput = parseTaskToolInputForRecovery(part.input);
        if (parsedInput && parsedInput.groupCount > 1) {
          pendingBestOfTaskToolCount += 1;
        }
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }

      collectReferencedTaskIdsFromTaskToolOutput(part.output, referencedTaskIds);
    }

    return {
      pendingBestOfTaskToolCount,
      pendingTaskToolCount,
      referencedTaskIds,
    };
  }

  private async shouldDeferBestOfFallback(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<boolean> {
    const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
    if (
      parentTaskToolState.pendingBestOfTaskToolCount !== 1 ||
      parentTaskToolState.pendingTaskToolCount !== 1
    ) {
      return false;
    }

    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    const hasRecoverableSibling = siblings.some((sibling) => {
      return (
        sibling.taskStatus === "queued" ||
        sibling.taskStatus === "starting" ||
        this.isBestOfSiblingExecutingAgain(sibling)
      );
    });
    if (hasRecoverableSibling) {
      return true;
    }

    return (
      (await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      })) != null
    );
  }

  private getEffectiveTaskGroup(
    workspaceId: string,
    workspace: Pick<WorkspaceConfigEntry, "bestOf">
  ): TaskCreateArgs["bestOf"] {
    const bestOf = workspace.bestOf ?? this.config.getLegacyTaskVariantGroup(workspaceId);
    if (!bestOf) {
      return undefined;
    }
    return { groupId: bestOf.groupId, index: bestOf.index, total: bestOf.total };
  }

  private async deliverReportToParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<void> {
    assert(
      childWorkspaceId.length > 0,
      "deliverReportToParent: childWorkspaceId must be non-empty"
    );

    let cleanupTaskIds: readonly string[] = [];
    const bestOf = childEntry
      ? this.getEffectiveTaskGroup(childWorkspaceId, childEntry.workspace)
      : undefined;
    const bestOfTotal = bestOf?.total ?? 1;
    if (bestOfTotal > 1) {
      await this.deferredBestOfLocks.withLock(parentWorkspaceId, async () => {
        cleanupTaskIds = await this.deliverReportToParentUnlocked(
          parentWorkspaceId,
          childWorkspaceId,
          childEntry,
          report
        );
      });
    } else {
      cleanupTaskIds = await this.deliverReportToParentUnlocked(
        parentWorkspaceId,
        childWorkspaceId,
        childEntry,
        report
      );
    }

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async deliverReportToParentUnlocked(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: {
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
      planFilePath?: string;
    }
  ): Promise<readonly string[]> {
    const agentType = coerceNonEmptyString(childEntry?.workspace.agentType) ?? "agent";
    const childModelString = childEntry?.workspace.taskModelString;
    const childThinkingLevel = childEntry?.workspace.taskThinkingLevel;

    const output = {
      status: "completed" as const,
      taskId: childWorkspaceId,
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      planFilePath: report.planFilePath,
      structuredOutput: report.structuredOutput,
      agentType,
      modelString: childModelString,
      thinkingLevel: childThinkingLevel,
    };
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success) {
      log.error("Task tool output schema validation failed", { error: parsedOutput.error.message });
      return [];
    }

    if (childEntry?.workspace.workflowTask != null) {
      log.debug("Skipping generic parent report delivery for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return [];
    }

    // Restart-safe: if the parent has a pending task tool call in partial.json (interrupted stream),
    // finalize it with the report. Avoid rewriting persisted history to keep earlier messages immutable.
    if (!this.aiService.isStreaming(parentWorkspaceId)) {
      const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
        parentWorkspaceId,
        parsedOutput.data,
        childWorkspaceId,
        childEntry
      );
      if (finalization.kind === "finalized") {
        return finalization.taskIds.filter((taskId) => taskId !== childWorkspaceId);
      }

      const bestOf = childEntry
        ? this.getEffectiveTaskGroup(childWorkspaceId, childEntry.workspace)
        : undefined;
      if (bestOf?.total != null && bestOf.total > 1) {
        const parentTaskToolState = await this.getTaskToolPartialState(parentWorkspaceId);

        // Concurrent sibling completions can arrive after another sibling already finalized
        // the grouped task output in the interrupted parent partial. Avoid appending an
        // extra synthetic fallback report once that grouped result already contains this child.
        if (parentTaskToolState.referencedTaskIds.has(childWorkspaceId)) {
          return [];
        }

        if (
          finalization.kind === "not_ready" &&
          (await this.shouldDeferBestOfFallback({
            parentWorkspaceId,
            groupId: bestOf.groupId,
            total: bestOf.total,
          }))
        ) {
          return [];
        }
      }
    }

    // If someone is actively awaiting this report (foreground task tool call or task_await),
    // skip injecting a synthetic history message to avoid duplicating the report in context.
    if (childWorkspaceId) {
      if (this.waiters.hasPendingWaiters(childWorkspaceId)) {
        return [];
      }
    }

    // Background tasks: append a synthetic user message containing the report so earlier history
    // remains immutable (append-only) and prompt caches can still reuse the prefix.
    const titlePrefix =
      typeof report.title === "string" && report.title.trim().length > 0
        ? report.title
        : subagentReportFallbackTitle(agentType);
    const reportContent = formatSubagentReportUserMessage({
      childWorkspaceId,
      agentType,
      title: titlePrefix,
      reportMarkdown: report.reportMarkdown,
      status: "completed",
      ...(childModelString != null ? { model: childModelString } : {}),
      ...(childThinkingLevel != null ? { thinkingLevel: childThinkingLevel } : {}),
      ...(report.structuredOutput !== undefined
        ? { structuredOutput: report.structuredOutput }
        : {}),
    });

    const workspaceTurnMuxMetadata =
      await this.getWorkspaceTurnManager().getActiveWorkspaceTurnMuxMetadataForWorkspace(
        parentWorkspaceId
      );
    const messageId = createTaskReportMessageId();
    const reportMessage = createMuxMessage(messageId, "user", reportContent, {
      timestamp: Date.now(),
      synthetic: true,
      uiVisible: true,
      ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
    });

    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      reportMessage
    );
    if (appendResult.success) {
      this.workspaceService.emitChatEvent(parentWorkspaceId, {
        ...reportMessage,
        type: "message",
      });
    }
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent report to parent history", {
        parentWorkspaceId,
        error: appendResult.error,
      });
    }

    return [];
  }

  private async tryFinalizePendingTaskToolCallInPartial(
    workspaceId: string,
    output: unknown,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<
    { kind: "finalized"; taskIds: readonly string[] } | { kind: "not_ready" } | { kind: "failed" }
  > {
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success || parsedOutput.data.status !== "completed") {
      log.error("tryFinalizePendingTaskToolCallInPartial: invalid output", {
        error: parsedOutput.success ? "status is not 'completed'" : parsedOutput.error.message,
      });
      return { kind: "failed" };
    }

    const partial = await this.historyService.readPartial(workspaceId);
    if (!partial) {
      return { kind: "failed" };
    }

    type PendingTaskToolPart = DynamicToolPart & { toolName: "task"; state: "input-available" };
    const pendingParts = partial.parts.filter(
      (p): p is PendingTaskToolPart =>
        isDynamicToolPart(p) && p.toolName === "task" && p.state === "input-available"
    );

    if (pendingParts.length === 0) {
      return { kind: "failed" };
    }
    if (pendingParts.length > 1) {
      log.error("tryFinalizePendingTaskToolCallInPartial: multiple pending task tool calls", {
        workspaceId,
      });
      return { kind: "failed" };
    }

    const toolCallId = pendingParts[0].toolCallId;

    const parsedInput = parseTaskToolInputForRecovery(pendingParts[0].input);
    if (!parsedInput) {
      log.error("tryFinalizePendingTaskToolCallInPartial: task input validation failed", {
        workspaceId,
      });
      return { kind: "failed" };
    }

    let finalizedOutput: z.infer<typeof TaskToolResultSchema> = parsedOutput.data;
    let areGroupSiblingsStillSettled: (() => boolean) | undefined;
    if (parsedInput.groupCount > 1) {
      const bestOf =
        childEntry?.workspace.bestOf ?? this.config.getLegacyTaskVariantGroup(childWorkspaceId);
      if (!bestOf) {
        return { kind: "failed" };
      }

      const hasGroupedCompletedOutput =
        Array.isArray(parsedOutput.data.taskIds) &&
        "reports" in parsedOutput.data &&
        Array.isArray(parsedOutput.data.reports);
      // A caller-assembled grouped output (deferred delivery) names no reporting sibling, so
      // every sibling must be settled at commit time.
      const reportingTaskId = hasGroupedCompletedOutput ? undefined : childWorkspaceId;
      if (!hasGroupedCompletedOutput) {
        const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
          parentWorkspaceId: workspaceId,
          groupId: bestOf.groupId,
          total: bestOf.total,
          reportingTaskId,
        });
        if (!groupedOutput) {
          return { kind: "not_ready" };
        }

        finalizedOutput = groupedOutput;
      }
      const assembledTaskIds = finalizedOutput.taskIds ?? [];
      areGroupSiblingsStillSettled = () =>
        this.areBestOfSiblingsStillSettled({
          parentWorkspaceId: workspaceId,
          groupId: bestOf.groupId,
          assembledTaskIds,
          reportingTaskId,
        });
    }

    // The grouped output above was assembled from disk reads that a parent turn can overtake:
    // its commitPartial moves this partial into history and its stream writes a fresh one under a
    // new message id. Apply the finalization only while the partial is still this message with
    // this call pending, and never under a stream that has already started. A sibling resumed
    // during those reads is about to replace the artifact already assembled here; the transform
    // runs with no await before the write, so this is the last point that can still see it.
    let groupSiblingResumed = false;
    const writeResult = await this.historyService.updatePartialIfMessageIdMatches(
      workspaceId,
      partial.id,
      (current) => {
        if (this.aiService.isStreaming(workspaceId)) return null;
        if (areGroupSiblingsStillSettled != null && !areGroupSiblingsStillSettled()) {
          groupSiblingResumed = true;
          return null;
        }
        const stillPending = current.parts.some(
          (part) =>
            isDynamicToolPart(part) &&
            part.toolCallId === toolCallId &&
            part.toolName === "task" &&
            part.state === "input-available"
        );
        if (!stillPending) return null;
        return {
          ...current,
          parts: current.parts.map((part) => {
            if (!isDynamicToolPart(part)) return part;
            if (part.toolCallId !== toolCallId) return part;
            if (part.toolName !== "task") return part;
            if (part.state === "output-available") return part;
            return { ...part, state: "output-available" as const, output: finalizedOutput };
          }),
        };
      }
    );
    if (!writeResult.success) {
      log.error("Failed to write finalized task tool output to partial", {
        workspaceId,
        error: writeResult.error,
      });
      return { kind: "failed" };
    }
    if (!writeResult.data) {
      if (groupSiblingResumed) {
        return { kind: "not_ready" };
      }
      log.debug("tryFinalizePendingTaskToolCallInPartial: partial superseded before finalization", {
        workspaceId,
        messageId: partial.id,
      });
      return { kind: "failed" };
    }

    this.workspaceService.emit("chat", {
      workspaceId,
      message: {
        type: "tool-call-end",
        workspaceId,
        messageId: partial.id,
        toolCallId,
        toolName: "task",
        result: finalizedOutput,
        timestamp: Date.now(),
      },
    });

    if (Array.isArray(finalizedOutput.taskIds) && finalizedOutput.taskIds.length > 0) {
      return { kind: "finalized", taskIds: finalizedOutput.taskIds };
    }

    return {
      kind: "finalized",
      taskIds: finalizedOutput.taskId ? [finalizedOutput.taskId] : [childWorkspaceId],
    };
  }

  private async canCleanupReportedTask(
    workspaceId: string,
    config: ProjectsConfig = this.config.loadConfigOrDefault()
  ): Promise<
    | { ok: true; parentWorkspaceId: string; attemptId: string | undefined }
    | { ok: false; reason: string }
  > {
    assert(workspaceId.length > 0, "canCleanupReportedTask: workspaceId must be non-empty");

    const entry = findWorkspaceEntry(config, workspaceId);
    if (!entry) {
      return { ok: false, reason: "workspace_not_found" };
    }

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return { ok: false, reason: "missing_parent_workspace" };
    }

    if (!hasCompletedAgentReport(entry.workspace)) {
      return { ok: false, reason: "task_not_reported" };
    }

    if (isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)) {
      return { ok: false, reason: "archived" };
    }

    // A reported task reactivated through an existing-workspace turn keeps taskStatus "reported"
    // while its execution mirror is already starting or running, before any stream registers.
    if (isActiveWorkspaceTurnTaskStatus(entry.workspace.taskExecutionStatus)) {
      return { ok: false, reason: "workspace_turn_active" };
    }

    const bestOf = this.getEffectiveTaskGroup(workspaceId, entry.workspace);
    if (bestOf?.total != null && bestOf.total > 1) {
      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId,
          groupId: bestOf.groupId,
          total: bestOf.total,
        })
      ) {
        return { ok: false, reason: "best_of_parent_partial_pending" };
      }
    }

    if (this.aiService.isStreaming(workspaceId)) {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; stream still active", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "still_streaming" };
    }

    // Topology gate: a completed task can only be cleaned up when it is a structural leaf
    // (has no child agent tasks in config). This stays status-agnostic so ancestor deletion
    // never orphans descendants that have not been pruned yet.
    const index = this.buildAgentTaskIndex(config);
    const isWorkflowOwnedTask = this.isWorkflowOwnedTaskUsingIndex(index, workspaceId);
    if (this.hasChildAgentTasks(index, workspaceId)) {
      return { ok: false, reason: "has_child_tasks" };
    }

    // User-owned children persist unconditionally until task_remove. Workflow-owned workers remain
    // transient implementation details because their workflow journal owns the durable result.
    if (!isWorkflowOwnedTask) {
      return { ok: false, reason: "preserved" };
    }

    // Queued or held manual input lives only in this workspace's session, which removal disposes.
    // Keep the leaf while the user still has unsent input there. Trade-off: sending re-runs
    // cleanup at the next report, but Discard does not re-trigger it, so a leaf whose input was
    // discarded stays until the next cleanup trigger (e.g. the startup recheck).
    if (this.workspaceService.hasPendingUserInput(workspaceId)) {
      return { ok: false, reason: "pending_user_input" };
    }

    const parentSessionDir = path.join(this.config.sessionsDir, parentWorkspaceId);
    const patchArtifact = await readSubagentGitPatchArtifact(parentSessionDir, workspaceId);
    if (patchArtifact?.status === "pending") {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; patch artifact pending", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "patch_pending" };
    }

    return { ok: true, parentWorkspaceId, attemptId: entry.workspace.taskAttemptId };
  }

  /**
   * @param options.config - config snapshot used only to screen the first (depth 0) candidate
   *   cheaply; deletion eligibility is always confirmed on fresh config inside remove()'s
   *   lifecycle lock, and every later depth re-evaluates the parent after a removal changed the tree.
   * @returns the number of workspaces removed.
   */
  private async cleanupReportedLeafTask(
    workspaceId: string,
    options?: { config?: ProjectsConfig }
  ): Promise<number> {
    assert(workspaceId.length > 0, "cleanupReportedLeafTask: workspaceId must be non-empty");

    // Lineage reduction: each iteration removes exactly one completed leaf, then re-evaluates
    // the parent on fresh config. The structural-leaf gate in canCleanupReportedTask ensures
    // ancestors are only deleted after every child has been pruned.
    let currentWorkspaceId = workspaceId;
    let removedCount = 0;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.error("cleanupReportedLeafTask: possible parentWorkspaceId cycle", {
          workspaceId: currentWorkspaceId,
        });
        return removedCount;
      }
      visited.add(currentWorkspaceId);

      const targetWorkspaceId = currentWorkspaceId;
      // Screen outside any lock (with the caller's snapshot at depth 0) so the (usual) ineligible
      // majority returns without a lock acquisition or config parse.
      const screened = await this.canCleanupReportedTask(
        targetWorkspaceId,
        depth === 0 ? options?.config : undefined
      );
      if (!screened.ok) {
        return removedCount;
      }
      // Deletion is decided on live state inside the task-tree lifecycle lock that remove()
      // holds: reactivation, re-parenting, and task_stop all mutate under that lock, so a task
      // confirmed eligible there cannot change underneath the removal. remove() is the only lock
      // acquisition on this path; callers that already hold a lock hold the workspace event lock
      // (stream-end finalization, cleanup rechecks), nesting event -> task-tree, the order every
      // path holding both locks follows (see workspaceEventLocks).
      let confirmed: { ok: true; parentWorkspaceId: string } | undefined;
      const removeResult = await this.workspaceService.remove(targetWorkspaceId, true, {
        beforeRemove: async () => {
          const live = await this.canCleanupReportedTask(targetWorkspaceId);
          confirmed = live.ok ? live : undefined;
          // Bound to the attempt confirmed here (#4478): another backend can reawaken the task
          // after this in-process check, and the removal must then refuse, not delete its checkout.
          return live.ok ? { expectedAttemptId: live.attemptId } : false;
        },
      });
      if (!removeResult.success) {
        log.error("Failed to auto-delete completed task workspace", {
          workspaceId: currentWorkspaceId,
          error: removeResult.error,
        });
        return removedCount;
      }
      if (confirmed == null) {
        return removedCount;
      }
      removedCount += 1;

      // The removal just made this parent a candidate, so follow the parent the live check saw
      // (a client may have re-parented the task since the screen).
      currentWorkspaceId = confirmed.parentWorkspaceId;
    }

    log.error("cleanupReportedLeafTask: exceeded max parent traversal depth", {
      workspaceId,
    });
    return removedCount;
  }
}

/**
 * Removal deletes no checkout for isolation "none" children (they share the parent's) or for
 * project-dir local runtimes (deleteWorkspace is a no-op there), so it cannot lose their files.
 */
function subagentRemovalPreservesCheckout(ws: WorkspaceConfigEntry): boolean {
  return (
    ws.taskIsolation === "none" || isLocalProjectRuntime(ws.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG)
  );
}
