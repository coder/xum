import type { CoderWorkspaceArchiveBehavior } from "@/common/config/coderArchiveBehavior";
import type { WorktreeArchiveBehavior } from "@/common/config/worktreeArchiveBehavior";
import type { ExperimentId } from "@/common/constants/experiments";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { ArchivePreflightResult, ArchiveWorkspaceResult } from "@/common/orpc/schemas/api";
import type { FilePart, SendMessageOptions, WorkspaceChatMessage } from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import type {
  MuxMessage,
  MuxMessageMetadata,
  WorkspaceTurnTaskCorrelation,
} from "@/common/types/message";
import type { Result } from "@/common/types/result";
import type { StreamErrorRecoveryOutcome } from "@/node/services/agentSession";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { FrontendWorkspaceMetadata, WorkspaceMetadata } from "@/common/types/workspace";
import assert from "@/common/utils/assert";
import type { Config, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { QueueCutCutter } from "@/node/services/messageQueue";

/**
 * One-directional service ports keep task and workspace orchestration from depending on each
 * other's concrete class. Host call placement intentionally stays at the race-hardened sinks and
 * admission gates; this seam is the leverage point for any later control-flow inversion.
 */

export type AgentTaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;

export interface ArchiveWorkspaceOptions {
  /** Prevent an agent-driven archive from deleting a checkout after a concurrent settings flip. */
  forbidWorktreeCheckoutDeletion?: boolean;
  /**
   * Fail closed if user activity starts after the caller's earlier check, and hold turn admission
   * through the archive. User-driven archives intentionally keep their stop-activity behavior.
   */
  refuseLiveUserActivity?: boolean;
  /** Keep archive eligibility stable after the caller commits to interrupting active turns. */
  worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior;
  /** Prevent a reversible agent archive from permanently deleting its remote Coder workspace. */
  forbidCoderWorkspaceDeletion?: boolean;
  /** Keep the Coder stop/deletion policy stable after the caller commits to interruption. */
  coderWorkspaceArchiveBehaviorOverride?: CoderWorkspaceArchiveBehavior;
}

export interface WorkspaceLiveActivity {
  streaming: boolean;
  /** Queued or dispatching (PREPARING) messages that would start a stream after archive. */
  queuedMessages: boolean;
  /**
   * Detached background bash processes still running (sync snapshot; may briefly read
   * stale-running until the next lazy refresh — callers wanting freshness should await
   * hasRunningBackgroundBashProcesses first).
   */
  backgroundBashProcesses: boolean;
  terminalSessions: boolean;
  desktopSession: boolean;
}

export interface SendMessageInternalOptions {
  allowQueuedAgentTask?: boolean;
  skipAutoResumeReset?: boolean;
  synthetic?: boolean;
  /** Marks a synthetic send as an active-goal continuation turn. */
  goalContinuation?: boolean;
  /** Specific active-goal synthetic turn kind to persist on the user message. */
  goalKind?: GoalSyntheticMessageKind;
  /** Goal identity persisted alongside goalKind so reconciliation can scope the row. */
  goalId?: string;
  /** Force Copilot billing classification to "agent" for internal sends. */
  agentInitiated?: boolean;
  onAccepted?: () => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  /** Cancels a synthetic send even after it has left MessageQueue for PREPARING. */
  cancelSignal?: AbortSignal;
  /**
   * Synchronous staleness probe from the caller, re-evaluated at the real admission points
   * (the enqueue block and the session's turn-admission gates) in addition to the
   * context-mutation epoch. Peer agent sends use it so a user Stop or task_stop landing
   * during this method's awaits refuses the send instead of queueing a wake or resurrecting
   * the stopped task via markInterruptedTaskRunning.
   */
  admissionStale?: () => boolean;
  /**
   * Synthetic assistant rows persisted just before the turn's user row
   * (family-message payloads). Delivered atomically with the message —
   * queued alongside it when the workspace is busy — so they never land
   * inside another turn's PREPARING window (see AgentSession.sendMessage).
   */
  preTurnMessages?: MuxMessage[];
  /** r54: fired once pre-turn rows cross the rollback horizon (see AgentSession). */
  onPreTurnRowsPersisted?: () => void;
  /** Return once the user message is accepted; stream startup continues asynchronously. */
  startStreamInBackground?: boolean;
  /** When true, reject instead of queueing if the workspace is busy. */
  requireIdle?: boolean;
  /** Preserve workspace-turn correlation only when this send is the next continuation. */
  workspaceTurnContinuation?: boolean;
  /** Coalescing for queued sends: drop the message when the same key is already queued. */
  queueDedupeKey?: string;
  /** Keep this dedupe-keyed queue entry isolated so it can be selectively superseded. */
  removableQueueDedupeKey?: boolean;
  /**
   * For queued sends: quietly drop the message (success) when other messages are already
   * queued at enqueue time. Scheduled heartbeats use this so a user send racing the awaits
   * in this method keeps queue ownership — MessageQueue dispatches with the latest queued
   * options, so merging a heartbeat in would run the user's queued turn with the
   * heartbeat's model/agent.
   */
  yieldToQueuedMessages?: boolean;
}

export interface WorkspaceTurnHost {
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: SendMessageInternalOptions
  ): Promise<Result<void, SendMessageError>>;
  resumeStream(
    workspaceId: string,
    options: SendMessageOptions,
    internal?: { allowQueuedAgentTask?: boolean; agentInitiated?: boolean }
  ): Promise<Result<{ started: boolean }, SendMessageError>>;
  clearQueue(workspaceId: string, options?: { cancelReason?: string }): Result<void>;
  replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: {
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }
  ): Promise<Result<void>>;
  waitForIdleAndNoQueuedMessages(workspaceId: string): Promise<void>;
  waitForPendingCompactionCompletionDecision(
    workspaceId: string,
    messageId: string
  ): Promise<boolean | undefined>;
  waitForPendingStreamErrorRecoveryDecision(
    workspaceId: string,
    messageId: string
  ): Promise<StreamErrorRecoveryOutcome | undefined>;
}

export interface TurnAdmissionHost {
  isBusyForMessage(workspaceId: string): boolean;
  hasQueuedMessages(workspaceId: string, dispatchMode?: "tool-end" | "turn-end"): boolean;
  hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
  hasPendingAutoRetry(workspaceId: string): boolean;
  hasPendingBashMonitorWakeContinuation(workspaceId: string): boolean;
  hasPendingWorkspaceTurnContinuation(
    workspaceId: string,
    metadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): boolean;
  hasQueuedWorkspaceTurn(workspaceId: string, handleId: string): boolean;
  removeQueuedWorkspaceTurn(
    workspaceId: string,
    handleId: string,
    options: { cancelReason: string }
  ): Result<boolean>;
  removeQueuedMessagesByDedupeKeyPrefix(
    workspaceId: string,
    prefix: string,
    options?: { cancelReason?: string }
  ): Result<number>;
  getQueueCutCutter(workspaceId: string): QueueCutCutter | undefined;
  countQueuedAgentPeerMessages(workspaceId: string): number;
}

export interface WorkspaceLifecycleHost {
  archive(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  archiveWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: ArchiveWorkspaceOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  unarchiveWhileTaskTreeLocked(workspaceId: string): Promise<Result<void>>;
  preflightArchive(
    workspaceId: string,
    options?: { worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior }
  ): Promise<Result<ArchivePreflightResult>>;
  acquirePreInterruptionArchiveHold(
    workspaceId: string,
    options: {
      queuedDelegatedTurnCount: number;
      expectedDelegatedTurnCorrelations: readonly WorkspaceTurnTaskCorrelation[];
    }
  ): Result<Disposable>;
  listLiveWorkspaceActivity(workspaceId: string): WorkspaceLiveActivity;
  hasRunningBackgroundBashProcesses(workspaceId: string): Promise<boolean>;
  hasUntrackableExternalAppOpen(workspaceId: string): Promise<boolean>;
  isSnapshotArchiveEligibilityMutationSensitive(
    workspaceId: string,
    worktreeArchiveBehavior?: WorktreeArchiveBehavior,
    metadata?: WorkspaceMetadata
  ): boolean;
  remove(workspaceId: string, force?: boolean): Promise<Result<void>>;
  removeWhileTaskTreeLocked(workspaceId: string, force?: boolean): Promise<Result<void>>;
}

export interface WorkspaceProvisioningHost {
  create(
    projectPath: string,
    branchName: string | undefined,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig,
    subProjectPath?: string,
    pendingAutoTitle?: boolean,
    tags?: Record<string, string>
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>>;
  sanitizeMaterializedTaskWorkspace(
    workspaceId: string,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined>;
  discardExtensionMetadataEntry(workspaceId: string): Promise<void>;
  registerExternalBackgroundInit(
    workspaceId: string,
    abortController: AbortController,
    settled: Promise<unknown>
  ): void;
}

export interface WorkspaceMetadataHost {
  getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null>;
  updateTitle(workspaceId: string, title: string): Promise<Result<void>>;
  emit(
    event: "metadata",
    payload: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }
  ): boolean;
  emit(event: "chat", payload: { workspaceId: string; message: WorkspaceChatMessage }): boolean;
  emitChatEvent(workspaceId: string, message: WorkspaceChatMessage): void;
  isExperimentEnabled(experimentId: ExperimentId): boolean;
  isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean>;
}

export type WorkspaceHost = WorkspaceTurnHost &
  TurnAdmissionHost &
  WorkspaceLifecycleHost &
  WorkspaceProvisioningHost &
  WorkspaceMetadataHost;

export interface AgentTaskIntegration {
  withTaskTreeLifecycleLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
  hasDescendantAgentTasks(workspaceId: string): boolean;
  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean;
  hasActiveTopLevelWorkflowRunsForWorkspace(workspaceId: string): Promise<boolean>;
  getAgentTaskStatus(workspaceId: string): AgentTaskStatus | null | undefined;
  resetAutoResumeCount(workspaceId: string): void;
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number;
  markInterruptedTaskRunning(workspaceId: string): Promise<boolean>;
  restoreInterruptedTaskAfterResumeFailure(workspaceId: string): Promise<void>;
  markParentWorkspaceInterrupted(workspaceId: string): void;
  latchHardInterruptCascade(workspaceId: string): (() => void) | undefined;
  terminateAllDescendantAgentTasks(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]>;
}

export function normalizeArchiveUntrackedPaths(paths: readonly string[]): string[] {
  const normalizedPaths = paths.map((untrackedPath) => {
    const trimmedPath = untrackedPath.trim();
    assert(
      trimmedPath.length > 0,
      "normalizeArchiveUntrackedPaths: untracked paths must be non-empty"
    );
    return trimmedPath;
  });
  return [...new Set(normalizedPaths)].sort();
}

// Shared so the task-side pre-interruption archive preflight applies the exact
// acknowledgement semantics enforced at the archive sink (getArchiveUntrackedFilesConfirmation):
// a drifted acknowledged set (extra OR missing paths) must re-confirm before any
// destructive interruption, not after.
export function areArchiveUntrackedPathListsEqual(
  leftPaths: readonly string[],
  rightPaths: readonly string[]
): boolean {
  const normalizedLeftPaths = normalizeArchiveUntrackedPaths(leftPaths);
  const normalizedRightPaths = normalizeArchiveUntrackedPaths(rightPaths);
  if (normalizedLeftPaths.length !== normalizedRightPaths.length) {
    return false;
  }

  return normalizedLeftPaths.every((path, index) => path === normalizedRightPaths[index]);
}
