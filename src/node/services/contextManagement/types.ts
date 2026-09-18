import type { buildAutoCompactionFollowUp } from "./compactionRequests";
import type { SessionContextHost } from "./sessionContextHost";
import type { SendMessageOptions, ProvidersConfigMap } from "@/common/orpc/types";
import type { MuxMessageMetadata } from "@/common/types/message";
import type { CompactionReplacementCapture } from "../compactionCancellation";
import type { RoutedConsentRejection } from "../agentSession";
import type { GoalSyntheticMessageKind } from "@/constants/goals";

/** The original session object is the identity receipt; never clone it across an awaited hook. */
export interface StreamContextSnapshot {
  admissionCapture?: CompactionReplacementCapture;
  modelString: string;
  options?: SendMessageOptions;
  agentInitiated?: boolean;
  providersConfig: ProvidersConfigMap | null;
  goalKind?: GoalSyntheticMessageKind;
  goalId?: string;
  workspaceTurnMetadata?: Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;
  /**
   * Pre-skill-routing options for compaction requests spawned off this
   * stream. A turn routed to a small class model must never compact on that
   * model — the compaction model has to fit the full uncompacted history —
   * so the compaction sites build their request from these when present.
   * Set exactly for routed turns, which also compact under the routed-send
   * headroom policy (see SessionContextController).
   */
  compactionBaseOptions?: SendMessageOptions;
  /**
   * The routed turn's late consent gate: a continuation spawned off this
   * stream (a compaction request, the fast-apply Continue) reads the routed
   * stream's project content and inherits the obligation to re-verify trust.
   */
  routedConsentRejection?: RoutedConsentRejection;
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
  /**
   * Options the deferred follow-up is built from when they differ from the
   * stream's (a skill-routed send: the pre-routing options, so the follow-up
   * re-resolves routing at dispatch instead of pinning the routed model).
   */
  followUpOptions?: SendMessageOptions;
  /** Present for a skill-routed send (the model was replaced for this turn). */
  routed?: {
    /**
     * Context share this send itself adds (prompt, skill body, text
     * attachments), sized against the ROUTED window: the recorded usage does
     * not include the pending turn.
     */
    pendingPercent: number;
    /** Options for the compaction request (see StreamContextSnapshot.compactionBaseOptions). */
    compactionBaseOptions: SendMessageOptions;
  };
};

export type BeforeSendOutcome =
  | { kind: "proceed" }
  | { kind: "cancelled" }
  | {
      kind: "compact-first";
      usagePercent: number;
      request: ReturnType<SessionContextHost["buildAutoCompactionRequest"]>;
    };
