/**
 * Shared turn-engine contracts: the turn's identity and events, its completion,
 * the stream info a turn keeps while it runs, and the facade's stop, snapshot
 * and mock-lifecycle types. streamManager.ts and the turnEngine modules import
 * them from here, so no turnEngine module imports streamManager.ts.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { Instructions, LanguageModel, ModelMessage, streamText, Tool } from "ai";
import type { Fiber, Scope } from "effect";
import type { ResolvedCallSettingsOverrides } from "@/common/config/schemas/modelParameters";
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMessage, MuxMetadata } from "@/common/types/message";
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
import type { Runtime } from "@/node/runtime/Runtime";
import type {
  RebuildFirstStepForThinkingLevel,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";
import type { ExecutionScope } from "@/node/services/toolCallDisplayRegistry";
import type { PartialJournalState } from "@/node/services/turnEngine/PartialJournal";
import type { StreamRequestConfig } from "@/node/services/turnEngine/ProviderRequest";
import type { StepMessageTracker } from "@/node/services/turnEngine/StepPreparation";
import type { WorkflowRunToolAttachment } from "@/node/services/turnEngine/TurnEvents";
import type { StreamState, StreamToken } from "@/node/services/turnEngine/TurnRegistry";
import type { UsageLedgerState } from "@/node/services/turnEngine/UsageLedger";
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

// Comprehensive stream info
export interface WorkspaceStreamInfo extends PartialJournalState, Readonly<UsageLedgerState> {
  state: StreamState;
  streamResult: Awaited<ReturnType<typeof streamText>>;
  unlinkAbortSignal?: () => void;
  abortController: AbortController;
  workspaceName?: string;
  messageId: string;
  token: StreamToken;
  executionScope?: ExecutionScope;
  startTime: number;

  // Used to ensure part timestamps are strictly monotonic, even when multiple deltas land in the
  // same millisecond. This avoids collisions in reconnect replay dedupe logic which keys off of
  // (messageId, timestamp, delta).
  lastPartTimestamp: number;

  // Timestamp when each tool call reached output-available (tool-call-end emission).
  // Needed for reconnect replay filtering because dynamic-tool parts keep their
  // original start timestamp even after they gain output.
  toolCompletionTimestamps: Map<string, number>;

  // Anthropic server tools (web_search, ...) called in this row (#5887). Xum stores them as
  // client tool calls without their encrypted results, so history replays them as a
  // tool_use/tool_result pair: thinking after one is bound to a prefix never sent again.
  anthropicServerToolCallIds?: Set<string>;

  // Workflow tools can create the durable run before their stream part is stored. Keep the exact
  // attachment and apply it as soon as the matching dynamic-tool part lands.
  pendingWorkflowRunAttachments: Map<string, WorkflowRunToolAttachment>;

  // Kernel-nested tool events can arrive before the fullStream consumer stores the parent
  // code_execution part (same race as pendingToolExecutionStarts). Buffer the nested records
  // by parent toolCallId and merge them when the parent part lands, so an interrupt in that
  // window doesn't lose the nested calls (or their workflow run identity) from partial.json.
  pendingNestedCalls: Map<string, NestedToolCall[]>;

  // execute() can begin (lock acquired in withSequentialExecution) before the fullStream
  // consumer has stored the matching dynamic-tool part. Keep the execution-start timestamp
  // and apply it as soon as the part lands.
  pendingToolExecutionStarts: Map<string, number>;

  model: string;
  /** Metadata model resolved from provider mapping for cost/token metadata lookups. */
  metadataModel: string;
  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
  initialMetadata?: Partial<MuxMetadata>;
  request: StreamRequestConfig;
  // Track last prepared step messages for safe retries after tool steps
  stepTracker: StepMessageTracker;
  // Track if a previousResponseId retry happened after a step completed so
  // stream-end uses cumulative usage instead of the retried step's totalUsage.
  didRetryPreviousResponseIdAtStep: boolean;
  // Track when Xum restarted the stream after an empty-output completion so
  // stream-end prefers cumulative usage across attempts instead of the final
  // attempt's totalUsage only.
  didRetryAfterEmptyOutput?: boolean;
  // Same for a step-boundary retry without rejected reasoning replay.
  didRetryReasoningReplayAtStep?: boolean;
  // Refusal-fallback chain state. `original` keeps the pre-wrap request inputs
  // (as passed by TurnRequestBuilder) that prepare() does not rebuild, so the request can
  // be rebuilt for a different model. System, tools, and messages are rebuilt
  // per fallback model by prepare() via the prompt assembler because they are
  // model-keyed (cache wrapping, provider web tools, MCP sanitization, model
  // sections) and must not leak across providers.
  modelFallback?: {
    options: ModelFallbackOptions;
    /** Canonical model originally requested for this turn (the chain source). */
    requestedModel: string;
    /** Canonical models that refused during this turn, in order. */
    refusedModels: string[];
    original: { maxOutputTokens?: number };
  };
  // Provider streams must prove semantic completion with a terminal SDK finish part.
  // A clean EOF can be a proxy/provider drop and must not finalize partial assistant text.
  receivedTerminalEvent: boolean;
  terminalFinishReason?: string;
  // Provider-raw finish reason (e.g. Anthropic's "refusal") kept alongside the
  // unified one so refusal classification can match either representation.
  terminalRawFinishReason?: string;
  // Index into parts where the current step started (used to ensure safe retries)
  currentStepStartIndex: number;
  // Exact SDK step starts; part shapes cannot distinguish consecutive tool-only steps.
  stepStartIndices: number[];
  // Row step (index into stepStartIndices) of each SDK step the current streamText call
  // started, by SDK step number. Maps stepTracker.anthropicThinkingStripStep to the row.
  streamStepOrdinals: number[];
  historySequence: number;
  // Track accumulated parts for partial message (includes reasoning, text, and tools)
  parts: CompletedMessagePart[];
  // The reasoning block opened by the latest reasoning-start, and the last part
  // created for it (undefined until the block has a part). Anthropic replays each
  // thinking block with its own signature, so a metadata-only signature delta may
  // only attach to a part of the SAME block; otherwise it is its own (empty) block.
  currentReasoningBlock?: { lastPart?: CompletedMessagePart };
  // Reasoning parts before this index belong to refused fallback attempts whose
  // usage was already attributed separately; stream-end backfill must not bill
  // them again under the answering model.
  reasoningBackfillStartIndex?: number;
  // Track background processing promise for guaranteed cleanup
  processingPromise: Promise<void>;
  // Latched by the first cancelStreamSafely call (synchronously, before its
  // first await) so concurrent cancellers — a user stop racing shutdown's
  // engine supervisor — join one cleanup: exactly one stream-abort, one settle.
  cancelPromise?: Promise<void>;
  // Supervisor fiber in the app's AppFiberScope (superviseEngine); set only when
  // the manager was constructed with an engine scope.
  engineFiber?: Fiber.Fiber<void>;
  // Soft-interrupt state: when pending, stream will end at next block boundary
  softInterrupt:
    | { pending: false }
    | { pending: true; abandonPartial: boolean; abortReason: StreamAbortReason };
  // Temporary directory for tool outputs (auto-cleaned when stream ends)
  runtimeTempDir: string;
  // Runtime for temp directory cleanup
  runtime: Runtime;
  // Owns this stream's Effect-managed resources: the temp-dir release
  // finalizer (registered via acquireRelease in startStream) and the
  // scope-tied partial-write debounce fiber. Closed exactly once — by
  // processStreamWithCleanup's finally after registration, or by startStream
  // when registration fails. Optional: whitebox test fixtures register stream
  // infos without a resource scope.
  resourceScope?: Scope.Closeable;
  resourceCleanup?: Promise<void>;
  completionController: TurnCompletionController;
  terminalCompletion?: TurnCompletion;
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
