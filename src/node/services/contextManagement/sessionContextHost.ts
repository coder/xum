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
import type { AgentSessionStreamManager, RoutedConsentRejection } from "../agentSession";
import type { MuxMessage } from "@/common/types/message";
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
  dispatchPendingFollowUp(
    summaryId: string | null,
    admissionStale: () => boolean,
    /** The interrupted routed stream's own gate when the dispatch still has it in hand. */
    inheritedConsentRejection?: RoutedConsentRejection
  ): Promise<void>;
  /**
   * Durably stamped and quarantined rejected rows: the compaction handler keeps
   * them out of carried-over pending state, the compactor out of its heads.
   */
  getQuarantinedRowIds(): ReadonlySet<string>;
  /**
   * Provider-facing copy of continuous-compaction rows (the summarizer's head,
   * the swapped prefix's sources): rejected rows never ride it, and during a
   * ROUTED turn an untrusted workspace's project skill content is withheld the
   * way the routed request's own assembly withholds it. Null: the compactor
   * stands down (see AgentSession.prepareContinuousCompactionRows).
   */
  prepareContinuousCompactionRows(
    rows: MuxMessage[],
    routedTurn: boolean
  ): Promise<{
    rows: MuxMessage[];
    trustedProjectContent: boolean;
    projectContentWithheld: boolean;
  } | null>;
  /** Dispatch-time recheck of prepareContinuousCompactionRows' verdict. */
  continuousCompactionRowsStillEligible(prepared: {
    rows: MuxMessage[];
    trustedProjectContent: boolean;
  }): Promise<boolean>;
  /** Request-copy filter for rejected rows (the swapped prefix is rebuilt from history). */
  excludeRejectedRows(rows: MuxMessage[]): MuxMessage[];
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
