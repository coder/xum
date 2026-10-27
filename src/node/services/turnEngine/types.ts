/**
 * Shared turn-engine contracts: the turn's identity and events, its completion,
 * the facade's stop, snapshot and mock-lifecycle types, and the turn-engine
 * state types they are built from. The stream info a turn keeps while it runs
 * is in turnState.ts.
 * A leaf: it imports no turnEngine module and not streamManager.ts. The modules
 * that owned a moved type re-export it, so their callers do not change.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { Instructions, LanguageModel, ModelMessage, streamText, Tool } from "ai";
import type { ResolvedCallSettingsOverrides } from "@/common/config/schemas/modelParameters";
import type { QueuedInputStopCause, StreamStopCause } from "@/common/types/streamStopCause";
import type { ToolSearchStreamState } from "@/common/utils/tools/toolCatalog";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { AutoThinkingEscalationState } from "@/node/services/autoThinkingEscalation";
import type {
  ContextBudgetAnchorRequest,
  TurnBudgetAnchor,
} from "@/node/services/contextBudgetCounting";
import type { ContinuousPrefixSwap } from "@/node/services/continuousCompactionJournal";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMessage, MuxMetadata, SystemSectionRecords } from "@/common/types/message";
import type { Result } from "@/common/types/result";
import type {
  CompletedMessagePart,
  ErrorEvent,
  PrefixSwapInvalidatedEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  StreamAbortEvent,
  StreamAbortReason,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  ToolCallStartEvent,
  UsageDeltaEvent,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { StreamErrorPayload } from "@/node/services/utils/sendMessageError";
import type {
  ActiveTurnThinkingOverride,
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";
import type { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";

export type StreamTextOnChunk = NonNullable<Parameters<typeof streamText>[0]["onChunk"]>;

export type WorkspaceId = string & { __brand: "WorkspaceId" };

export type TurnEngineEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamEndEvent
  | StreamAbortEvent
  | ErrorEvent
  | UsageDeltaEvent
  | ToolCallStartEvent
  | ToolCallExecutionStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | WorkflowRunAttachedEvent
  | PrefixSwapInvalidatedEvent;

export type TurnEngineEventSink = (event: TurnEngineEvent) => void | Promise<void>;

// Turn identity lives on TurnStreamHandle.messageId; completions cannot diverge from it.
export type TurnCompletion =
  | { status: "completed"; streamEnd: Omit<StreamEndEvent, "messageId"> }
  | {
      status: "aborted";
      abortReason: StreamAbortReason;
      // Absent for startup cancellation / cleanup without a delivered terminal event.
      streamAbort?: Omit<StreamAbortEvent, "messageId" | "abortReason">;
      systemMessageTokens?: number;
    }
  | { status: "failed"; streamError: StreamErrorPayload & { errorType: StreamErrorType } };

export interface TurnStreamHandle {
  messageId: string;
  completion: Promise<TurnCompletion>;
}

export interface TurnCompletionController {
  promise: Promise<TurnCompletion>;
  settle: (completion: TurnCompletion) => void;
}

export interface SettledStepBudget {
  model: string;
  usage: LanguageModelV2Usage | undefined;
  providerMetadata?: Record<string, unknown>;
  toolResultChars: number;
  imageParts: number;
  toolResultTokens?: number;
  /**
   * Assembled estimate of the next step's provider request, computed exactly as that step's
   * preflight will compute it. Absent when no context budget applies.
   */
  nextRequestTokens?: number;
  sessionHistoryAvailable: boolean;
  /** The step's request advertised `new_context`, so the final prompt can be acted on. */
  newContextAvailable: boolean;
  /** A successful `new_context` result settled in this step (its siblings included). */
  newContextRequested?: boolean;
}

export type ContextBudgetStepDecision = "continue" | "warn" | "rollover" | "block";

/**
 * Budget verdict for a settled step. `continuationEntryId` is the exact queue entry the session
 * designated to continue the turn when it decided to stop (its enqueued "Continue"); absent when
 * the stop hands over to nothing in particular.
 */
export interface SettledStepOutcome {
  decision: ContextBudgetStepDecision;
  continuationEntryId?: string;
}

export type OnStepSettled = (step: SettledStepBudget) => Promise<SettledStepOutcome>;

/**
 * Per-model request pieces for a refusal-fallback swap, rebuilt by TurnRequestBuilder so
 * provider-specific message preparation, provider options, and headers match a
 * first-class send of the fallback model (reusing the source model's request
 * verbatim would leak provider-specific options/messages across providers).
 */
export interface PreparedModelFallback {
  contextBudgetLimit?: number;
  /** Step 0's budget anchor: the previous turn's provider count (createTurnBudgetAnchor). */
  contextBudgetTurnAnchor?: TurnBudgetAnchor;
  model: LanguageModel;
  /** Canonical model string of the fallback attempt (drives metadata + tokenizer). */
  modelString: string;
  /** Messages re-prepared for the fallback model's provider. */
  messages: ModelMessage[];
  /** Provider-ready system prompt rebuilt for the fallback model. */
  system: Instructions | undefined;
  /**
   * Tools rebuilt for the fallback model. Required (even if undefined for a
   * tool-less stream) so callers cannot silently reuse the source model's
   * provider-specific tools (e.g. Anthropic web tools, unsanitized MCP schemas
   * that OpenAI rejects).
   */
  tools: Record<string, Tool> | undefined;
  providerOptions?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  callSettingsOverrides?: ResolvedCallSettingsOverrides;
  thinkingLevel?: string;
  /** Route attribution corrections (routeProvider, costsIncluded). */
  initialMetadataPatch?: Partial<MuxMetadata>;
  /**
   * Rebuild closure bound to the FALLBACK model so mid-turn thinking changes
   * keep working after a fallback hop (the source model's closure would build
   * options for the wrong model).
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  /** Step-0 message rebuild bound to the fallback request's build inputs. */
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
  forcedFirstStepToolNames?: string[];
  /**
   * Invoked once the fallback stream has been constructed successfully (but
   * before it is consumed). Durable side effects that must describe the
   * request that actually streams — e.g. the superseding turn envelope —
   * belong here, not in prepare(): a prepare that succeeds but whose stream
   * construction fails must leave no trace, or replay verification would
   * attribute an unstarted fallback identity. Must not throw.
   */
  onStreamConstructed?: () => Promise<void>;
  /**
   * Providers-config snapshot the fallback request was built from (the
   * factory's creation-time read, see TurnRequestBuilder). The swap's request-config
   * rebuild and metadata resolution must read THIS snapshot, not the live
   * config: a catalog refresh between prepare() and the swap could retag the
   * instance and hand the prepared SDK model another wire's output limits or
   * usage identity.
   */
  providersConfig?: ProvidersConfigMap;
}

export interface ModelFallbackPrepareOptions {
  /**
   * In-memory partial assistant turn to include when continuing after a
   * mid-turn refusal. This must be cloned from the stream state before prepare()
   * receives it so provider-message preparation cannot mutate live UI parts.
   */
  continuation?: { assistantMessage: MuxMessage };
  /**
   * Mid-turn thinking level to fold into the fallback's baseline: pending (not
   * yet applied) or already-applied override from the refused stream. The
   * fallback prepare re-clamps it for the next model.
   */
  thinkingLevelOverride?: ThinkingLevel;
}

export interface ModelFallbackOptions {
  /** Ordered refusal-fallback chain (canonical model strings); one attempt each. */
  chain: string[];
  /**
   * Rebuilds the full request for a fallback model. An Err result fails the
   * turn terminally as model_refusal (never a retryable error): silently
   * skipping an unstartable fallback would effectively create fallback on
   * auth/config errors, which is explicitly out of scope.
   */
  prepare: (
    nextModelString: string,
    options?: ModelFallbackPrepareOptions
  ) => Promise<
    Result<
      PreparedModelFallback,
      string | Extract<SendMessageError, { type: "context_budget_exceeded" }>
    >
  >;
}

export interface StopStreamOptions {
  soft?: boolean;
  abandonPartial?: boolean;
  abortReason?: StreamAbortReason;
  /** Teardown of an already-settled attempt must not manufacture a second raw terminal. */
  emitIfMissing?: boolean;
  /**
   * Execution the caller captured when it decided to stop. When the workspace's current
   * registered (or pending) start is a DIFFERENT message, the call is a no-op success: a late
   * stop must never cancel a replacement admitted after the caller's capture. Defense in depth
   * only — admission barriers, not this guard, keep replacements from starting mid-stop.
   */
  expectedMessageId?: string;
}

/** Snapshot of an active stream, as returned by StreamManager.getStreamInfo. */
export interface ActiveStreamInfo {
  messageId: string;
  model: string;
  historySequence: number;
  startTime: number;
  parts: CompletedMessagePart[];
  currentStepStartIndex: number;
  stepStartIndices: number[];
  initialMetadata?: Pick<
    MuxMetadata,
    "systemMessageTokens" | "anthropicThinkingReplay" | "anthropicThinkingReplayFromStep"
  >;
  toolCompletionTimestamps: Map<string, number>;
  muxMetadata?: unknown;
}

export interface MockStreamLifecycle {
  isStreaming(workspaceId: string): boolean;
  stop(workspaceId: string, options?: StopStreamOptions): Promise<void>;
  // Mock streams are not registered in workspaceStreams; reconnect replay needs both of these
  // to see them (#4542).
  getStreamInfo(workspaceId: string, includeFinalizing: boolean): ActiveStreamInfo | undefined;
  replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void>;
}

/** The token-counting surface StreamManager uses for live streaming stats. */
export type StreamManagerTokenTracker = Pick<StreamingTokenTracker, "setModel" | "countTokens">;

export interface StreamRequestConfig {
  stopCause?: StreamStopCause;
  cacheEnabled?: boolean;
  budgetMetadataModel?: string;
  model: LanguageModel;
  modelString: string;
  messages: ModelMessage[];
  /** Provider-ready system instructions from TurnContextAssembler. */
  system?: Instructions;
  tools?: Record<string, Tool>;
  providerOptions?: Record<string, unknown>;
  /** Per-request HTTP headers (e.g., anthropic-beta for 1M context). */
  headers?: Record<string, string | undefined>;
  maxOutputTokens?: number;
  streamCallSettings?: Omit<ResolvedCallSettingsOverrides, "maxOutputTokens">;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  getQueuedInputStopCause?: () => QueuedInputStopCause | undefined;
  /** Optional hook for callers that need chunk-level visibility during streaming. */
  onChunk?: StreamTextOnChunk;
  /** Optional hook for callers that need the live prepared step transcript. */
  onStepMessages?: (messages: ModelMessage[]) => void;
  onStepSettled?: OnStepSettled;
  contextBudgetLimit?: number;
  /** Step 0's budget anchor: the previous turn's provider count (createTurnBudgetAnchor). */
  contextBudgetTurnAnchor?: TurnBudgetAnchor;
  toolPolicy?: ToolPolicy;
  /**
   * Tool-search deferral state. Owned and mutated by
   * aiService/tool_catalog_search.execute; prepareStep reads it each step to
   * compute `activeTools`. Absent when the feature is inactive.
   */
  toolSearchState?: ToolSearchStreamState;
  /**
   * Mid-turn thinking override holder — the SESSION'S object, by reference
   * (never created inside StreamManager: a locally-created object would be
   * invisible to AgentSession.setActiveTurnThinkingLevel). prepareStep
   * consumes `pending` before every model step.
   */
  thinkingOverrideState?: ActiveTurnThinkingOverride;
  /**
   * Closure built by TurnRequestBuilder that re-runs the effective-level pipeline
   * (policy clamp + resolveEffectiveThinkingLevel) and rebuilds provider
   * options for the stream's model. `null` ⇒ not applicable / no-op.
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
  /**
   * Step-0 message rebuild for overrides that raced stream construction; see
   * RebuildFirstStepForThinkingLevel. Also emits the superseding envelope.
   */
  rebuildFirstStepForThinkingLevel?: RebuildFirstStepForThinkingLevel;
  /** First step must call one of these tools; later steps restore the full toolset. */
  forcedFirstStepToolNames?: string[];
}

export interface StepMessageTracker {
  workspaceId?: string;
  /** The latest step's request, anchoring the next estimate on its provider usage (#4858). */
  contextBudgetRequest?: ContextBudgetAnchorRequest;
  pendingPrefixSwap?: ContinuousPrefixSwap;
  consumedPrefixSwap?: ContinuousPrefixSwap;
  prefixSwapInvalidated?: boolean;
  prefixSwapInvalidationEmitted?: boolean;
  latestMessages?: ModelMessage[];
  /**
   * Set once a step of this turn prepared a provider request. Fallback and retry streams
   * reuse the tracker, so their step 0 is not the turn's first request (#5279).
   */
  providerRequestPrepared?: boolean;
  /** Present only when Auto set this turn's thinking level; shared across fallback hops. */
  autoThinkingEscalation?: AutoThinkingEscalationState;
  /**
   * Set when an in-turn prefix change made prepareStep strip earlier Anthropic thinking: the
   * SDK step number (of the current streamText call) whose request first sent the latest
   * strip. The stream consumer turns it into the row's replay point once that step started,
   * so the next turn neither puts the removed blocks back nor drops the ones kept after the
   * strip (preserved thinking). prepareStep can run a step ahead of the consumer, hence a
   * step number and not a flag. Cleared when a retry starts a new streamText call.
   */
  anthropicThinkingStripStep?: number;
  /** True once this turn holds the Anthropic thinking-repair receipt (reads initialMetadata). */
  hasAnthropicReplayReceipt?: () => boolean;
  /** After a step-0 rebuild: the row's system-section records and token count follow it. */
  recordSystemSections: (rebuilt: {
    systemRecords?: SystemSectionRecords;
    systemMessageTokens?: number;
  }) => void;
}

export type DynamicToolCompletedMessagePart = Extract<
  CompletedMessagePart,
  { type: "dynamic-tool" }
>;

export type WorkflowRunToolAttachment = NonNullable<DynamicToolCompletedMessagePart["workflowRun"]>;

// Stream state enum for exhaustive checking
export enum StreamState {
  IDLE = "idle",
  STARTING = "starting",
  STREAMING = "streaming",
  STOPPING = "stopping",
  COMPLETED = "completed", // Stream finished successfully (before cleanup)
  ERROR = "error",
}

export type StreamToken = string & { __brand: "StreamToken" };
