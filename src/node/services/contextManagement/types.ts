import type { buildAutoCompactionFollowUp } from "./compactionRequests";
import type { SessionContextHost } from "./sessionContextHost";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";
import type { CompactionReplacementCapture } from "../compactionCancellation";
import type { GoalSyntheticMessageKind } from "@/constants/goals";
import type { AutoModelRoutingRecord } from "@/common/types/autoModelRouting";

/** The original session object is the identity receipt; never clone it across an awaited hook. */
export interface StreamContextSnapshot {
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

export type BeforeSendInput = Parameters<typeof buildAutoCompactionFollowUp>[0] & {
  replacement: boolean;
  /** Request-owned cancellation performs the original queue/admission bookkeeping. */
  cancelBeforeAcceptance(): Promise<boolean>;
};

export type BeforeSendOutcome =
  | { kind: "proceed" }
  | { kind: "cancelled" }
  | {
      kind: "compact-first";
      usagePercent: number;
      request: ReturnType<SessionContextHost["buildAutoCompactionRequest"]>;
    };
