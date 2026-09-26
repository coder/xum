import type { RequestAssemblySnapshot } from "../events/eventSpine";
import type { SendMessageError } from "@/common/types/errors";
import type { buildAutoCompactionFollowUp } from "./compactionRequests";
import type { SessionContextHost } from "./sessionContextHost";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessage, MuxMessageMetadata } from "@/common/types/message";
import type { CompactionReplacementCapture } from "../compactionCancellation";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";

/** The original session object is the identity receipt; never clone it across an awaited hook. */
export interface StreamContextSnapshot {
  contextBudgetRetried?: boolean;
  contextBudgetFlushTurn?: boolean;
  admissionCapture?: CompactionReplacementCapture;
  modelString: string;
  options?: SendMessageOptions;
  /** Auto routing decision the streaming request carries; mid-stream follow-ups inherit it. */
  autoModelRouting?: AutoModelRoutingRecord;
  agentInitiated?: boolean;
  providersConfig: ProvidersConfigMap | null;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
}

export interface ContextDispatchRequest {
  messageText: string;
  sendOptions: SendMessageOptions;
  agentInitiated?: boolean;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
}

export interface CompactionContinuation {
  stream: StreamContextSnapshot;
  admissionStale: () => boolean;
  failureDisposition: "legacy-interrupt" | "continuous-fallback";
  interruptedUserMessageId?: string;
}

export type ContextResetReason =
  | "delete-messages"
  | "edit"
  | "context-changed"
  | "settings-changed"
  | "user-interrupt"
  | "delete-message"
  | "context-mutation"
  | "context-refresh"
  | "compaction-request"
  | "disabled"
  | "legacy-fallback";

export type BeforeSendInput =
  | (Parameters<typeof buildAutoCompactionFollowUp>[0] & {
      stage: "pressure";
      replacement: boolean;
      /** Request-owned cancellation performs the original queue/admission bookkeeping. */
      cancelBeforeAcceptance(): Promise<boolean>;
    })
  | {
      stage: "request";
      userMessage: MuxMessage;
      options: SendMessageOptions;
    }
  | {
      stage: "prelude";
      userMessage: MuxMessage;
      options: SendMessageOptions;
      prefixRows: readonly MuxMessage[];
    };

export type BeforeSendOutcome =
  | {
      kind: "proceed";
      prefixRows?: MuxMessage[];
      assemblySnapshot?: RequestAssemblySnapshot;
      receipt?: PreparationReceipt;
    }
  | { kind: "reject"; error: SendMessageError }
  | { kind: "cancelled" }
  | {
      kind: "compact-first";
      usagePercent: number;
      request: ReturnType<SessionContextHost["buildAutoCompactionRequest"]>;
    };

/** Session-scoped stale-work proof. Only its issuer may validate it, without yielding. */
export interface PreparationReceipt {
  readonly owner: object;
  readonly generation: number;
}

export interface ContinuationEntry {
  admissionCapture?: CompactionReplacementCapture;
  text: string;
  dedupeKey: string;
  options: SendMessageOptions;
  model: string;
  muxMetadata: MuxMessageMetadata;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
}

export interface RestoreContextStreamInput {
  history: MuxMessage[];
  userMessage?: MuxMessage;
  options?: SendMessageOptions;
  model: string;
  admissionCapture?: CompactionReplacementCapture;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  isAborted(): boolean;
}
export interface RestoredContextStream {
  assemblySnapshot?: RequestAssemblySnapshot;
  cannotWrite: boolean;
}
export interface ContextPublicationInput {
  userMessage: MuxMessage;
  prefixRows: MuxMessage[];
  options: SendMessageOptions;
  assemblySnapshot?: RequestAssemblySnapshot;
}
export interface ContextPublication {
  prefixRows: MuxMessage[];
  options: SendMessageOptions;
  assemblySnapshot?: RequestAssemblySnapshot;
  receipt: PreparationReceipt;
}
export interface ContextRecoveryInput {
  userMessage: MuxMessage;
  context: StreamContextSnapshot;
  model: string;
  estimate?: number;
  history: MuxMessage[];
  /** The original turn/operation check, repeated only at its existing checkpoints. */
  isCurrent(): boolean;
}
export interface ContextRecovery {
  prefixRows: MuxMessage[];
  assemblySnapshot: RequestAssemblySnapshot;
  continuation: MuxMessage;
  options?: SendMessageOptions;
  preludeIds: Set<string>;
}
export type ContextSendFailure =
  | {
      phase: "preflight";
      error: SendMessageError;
      options?: SendMessageOptions;
    }
  | {
      phase: "stream";
      stream?: StreamContextSnapshot;
      isCompactionRequest: boolean;
      hadOutput: boolean;
      errorType?: string;
      exceeded?: { model: string; estimate: number };
    };
export interface ContextFailureRecovery {
  model: string;
  estimate?: number;
  rejectRequest: boolean;
}
