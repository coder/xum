import type { EventEmitter } from "events";
import type {
  WorkspaceChatMessage,
  SendMessageOptions,
  ProvidersConfigMap,
} from "@/common/orpc/types";
import type { CompactionCompletionMetadata } from "@/common/types/compaction";
import type { CompactionFollowUpRequest, MuxMessageMetadata } from "@/common/types/message";
import type { LoadedSkillSnapshot, PostCompactionAttachment } from "@/common/types/attachment";
import type { AutoCompactionUsageState } from "@/common/utils/compaction/autoCompactionCheck";
import type { FileEditDiff } from "@/common/utils/messages/extractEditedFiles";
import type { AgentSessionStreamManager } from "../agentSession";
import type { TurnCoordinator } from "../turnCoordinator";
import type { TurnAcceptanceOrigin } from "../taskWorkspaceSeam";
import type {
  ContextDispatchRequest,
  CompactionContinuation,
  StreamContextSnapshot,
} from "./types";

/** Session-owned authority, kept separate from the app-scoped factory's dependencies. */
export interface SessionContextHost {
  readonly workspaceId: string;
  readonly sessionDir: string;
  readonly emitter: EventEmitter;
  readonly coordinator: Pick<
    TurnCoordinator,
    | "recordCompactionSummary"
    | "enterExecution"
    | "beginCompactionObservation"
    | "finishCompactionObservation"
    | "setCompactionStage"
    | "abandonCompaction"
    | "disposed"
    | "closing"
    | "admissionBlocked"
    | "editReserved"
    | "editBlocked"
    | "compactionIntent"
    | "midStreamCompactionPending"
  >;
  readonly streams: Pick<
    AgentSessionStreamManager,
    | "isStreaming"
    | "getStreamInfo"
    | "setPrefixSwap"
    | "clearPrefixSwap"
    | "getPrefixSwapState"
    | "getPrefixSwapPreparation"
    | "stopStream"
  >;
  /** Live session-owned values. Stream reads occur only at the original capture/recheck points. */
  readonly state: {
    readonly stream: StreamContextSnapshot | undefined;
    readonly userMessageId: string | undefined;
    readonly usage: AutoCompactionUsageState | undefined;
    readonly systemMessageTokens: number | undefined;
    readonly providersConfig: ProvidersConfigMap | null;
  };
  /** Full invalidation retains budget-clear → continuous-reset → usage-clear ordering. */
  transitionContextState(transition: "invalidate" | "clear-usage"): void;
  /** Called after observation ownership clears and before its waiters resume. */
  onCompactionObservationSettled(): void;
  isCompactionRecoveryBlocked(): Promise<boolean>;
  /** True means stale; automatic capture is exactly the session's Stop-generation fence. */
  captureCompactionAdmission(origin: TurnAcceptanceOrigin): () => boolean;
  waitForIdle(): Promise<void>;
  isWorkspaceArchivedOnDisk(): boolean;
  buildAutoCompactionRequest(input: {
    followUpContent: CompactionFollowUpRequest;
    baseOptions: SendMessageOptions;
    reason: "on-send" | "mid-stream";
  }): {
    messageText: string;
    metadata: MuxMessageMetadata;
    sendOptions: SendMessageOptions;
    agentInitiated: boolean;
  };
  /** The session owns nested-send admission, retry bookkeeping and failure publication. */
  sendCompactionRequest(
    request: ContextDispatchRequest,
    continuation: CompactionContinuation
  ): Promise<void>;
  dispatchPendingFollowUp(summaryId: string | null, admissionStale: () => boolean): Promise<void>;
  buildAttachments(input: {
    diffs: FileEditDiff[];
    loadedSkills: LoadedSkillSnapshot[];
    readFilePaths: string[];
    reportsCompletedBeforeMs: number;
  }): Promise<PostCompactionAttachment[]>;
  emitChatEvent(event: WorkspaceChatMessage): void;
  onCompactionComplete?(metadata: CompactionCompletionMetadata): void;
  onIdleCompactionOutcome?(success: boolean): void;
}
