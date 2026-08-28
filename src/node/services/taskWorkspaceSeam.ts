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

type StreamErrorRecoveryOutcome = "retry-started" | "terminal";

interface WorkspaceHostArchiveOptions {
  forbidWorktreeCheckoutDeletion?: boolean;
  refuseLiveUserActivity?: boolean;
  worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior;
  forbidCoderWorkspaceDeletion?: boolean;
  coderWorkspaceArchiveBehaviorOverride?: CoderWorkspaceArchiveBehavior;
}

interface WorkspaceHostLiveActivity {
  streaming: boolean;
  queuedMessages: boolean;
  backgroundBashProcesses: boolean;
  terminalSessions: boolean;
  desktopSession: boolean;
}

interface WorkspaceHostSendInternalOptions {
  allowQueuedAgentTask?: boolean;
  skipAutoResumeReset?: boolean;
  synthetic?: boolean;
  goalContinuation?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  agentInitiated?: boolean;
  onAccepted?: () => Promise<void> | void;
  onCanceled?: (reason: string) => Promise<void> | void;
  onAcceptedPreStreamFailure?: (error: SendMessageError) => Promise<void> | void;
  cancelState?: { canceledBeforeAcceptance: boolean };
  cancelSignal?: AbortSignal;
  admissionStale?: () => boolean;
  preTurnMessages?: MuxMessage[];
  onPreTurnRowsPersisted?: () => void;
  startStreamInBackground?: boolean;
  requireIdle?: boolean;
  workspaceTurnContinuation?: boolean;
  queueDedupeKey?: string;
  removableQueueDedupeKey?: boolean;
  yieldToQueuedMessages?: boolean;
}

export interface WorkspaceHost {
  acquirePreInterruptionArchiveHold(
    workspaceId: string,
    options: {
      queuedDelegatedTurnCount: number;
      expectedDelegatedTurnCorrelations: readonly WorkspaceTurnTaskCorrelation[];
    }
  ): Result<Disposable>;
  archive(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: WorkspaceHostArchiveOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  archiveWhileTaskTreeLocked(
    workspaceId: string,
    acknowledgedUntrackedPaths?: string[],
    options?: WorkspaceHostArchiveOptions
  ): Promise<Result<ArchiveWorkspaceResult>>;
  clearQueue(workspaceId: string, options?: { cancelReason?: string }): Result<void>;
  countQueuedAgentPeerMessages(workspaceId: string): number;
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
  discardExtensionMetadataEntry(workspaceId: string): Promise<void>;
  emit(
    event: "metadata",
    payload: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }
  ): boolean;
  emit(event: "chat", payload: { workspaceId: string; message: WorkspaceChatMessage }): boolean;
  emitChatEvent(workspaceId: string, message: WorkspaceChatMessage): void;
  getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null>;
  getQueueCutCutter(workspaceId: string): QueueCutCutter | undefined;
  hasPendingAutoRetry(workspaceId: string): boolean;
  hasPendingBashMonitorWakeContinuation(workspaceId: string): boolean;
  hasPendingQueuedOrPreparingTurn(workspaceId: string): boolean;
  hasPendingWorkspaceTurnContinuation(
    workspaceId: string,
    metadata: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>
  ): boolean;
  hasQueuedMessages(workspaceId: string, dispatchMode?: "tool-end" | "turn-end"): boolean;
  hasQueuedWorkspaceTurn(workspaceId: string, handleId: string): boolean;
  hasRunningBackgroundBashProcesses(workspaceId: string): Promise<boolean>;
  hasUntrackableExternalAppOpen(workspaceId: string): Promise<boolean>;
  isBusyForMessage(workspaceId: string): boolean;
  isExperimentEnabled(experimentId: ExperimentId): boolean;
  isSnapshotArchiveEligibilityMutationSensitive(
    workspaceId: string,
    worktreeArchiveBehavior?: WorktreeArchiveBehavior,
    metadata?: WorkspaceMetadata
  ): boolean;
  isWorkflowInvocationCurrent(workspaceId: string, runId: string): Promise<boolean>;
  listLiveWorkspaceActivity(workspaceId: string): WorkspaceHostLiveActivity;
  preflightArchive(
    workspaceId: string,
    options?: { worktreeArchiveBehaviorOverride?: WorktreeArchiveBehavior }
  ): Promise<Result<ArchivePreflightResult>>;
  registerExternalBackgroundInit(
    workspaceId: string,
    abortController: AbortController,
    settled: Promise<unknown>
  ): void;
  remove(workspaceId: string, force?: boolean): Promise<Result<void>>;
  removeQueuedMessagesByDedupeKeyPrefix(
    workspaceId: string,
    prefix: string,
    options?: { cancelReason?: string }
  ): Result<number>;
  removeQueuedWorkspaceTurn(
    workspaceId: string,
    handleId: string,
    options: { cancelReason: string }
  ): Result<boolean>;
  removeWhileTaskTreeLocked(workspaceId: string, force?: boolean): Promise<Result<void>>;
  replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: {
      mode?: "destructive" | "append-compaction-boundary" | null;
      deletePlanFile?: boolean;
    }
  ): Promise<Result<void>>;
  resumeStream(
    workspaceId: string,
    options: SendMessageOptions,
    internal?: { allowQueuedAgentTask?: boolean; agentInitiated?: boolean }
  ): Promise<Result<{ started: boolean }, SendMessageError>>;
  sanitizeMaterializedTaskWorkspace(
    workspaceId: string,
    workspacePath: string,
    runtimeConfig: RuntimeConfig | undefined,
    persistentSiblingConfig?: Pick<Config, "loadConfigOrDefault">
  ): Promise<string | undefined>;
  sendMessage(
    workspaceId: string,
    message: string,
    options: SendMessageOptions & { fileParts?: FilePart[] },
    internal?: WorkspaceHostSendInternalOptions
  ): Promise<Result<void, SendMessageError>>;
  unarchiveWhileTaskTreeLocked(workspaceId: string): Promise<Result<void>>;
  updateTitle(workspaceId: string, title: string): Promise<Result<void>>;
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
