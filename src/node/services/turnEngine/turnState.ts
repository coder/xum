/**
 * The records a running turn's state splits into, and WorkspaceStreamInfo, the
 * stream info built from them. Each record names its owner: the one turn-engine
 * module that writes the record's fields after TurnEngine builds the stream
 * info. WorkspaceStreamInfo extends an owned record as Readonly, so a write from
 * another module does not compile. Owners take the mutable record type. The
 * view is shallow: it stops reassigning a field, not changing the Map or array
 * the field holds.
 * Imports only types.ts from turnEngine.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { streamText } from "ai";
import type { Fiber, Scope } from "effect";
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { MuxMetadata, PersistedToolModelUsage } from "@/common/types/message";
import type { CompletedMessagePart, StreamAbortReason } from "@/common/types/stream";
import type { Runtime } from "@/node/runtime/Runtime";
import type { ExecutionScope } from "@/node/services/toolCallDisplayRegistry";
import type {
  ModelFallbackOptions,
  StepMessageTracker,
  StreamRequestConfig,
  StreamState,
  StreamToken,
  TurnCompletion,
  TurnCompletionController,
  WorkflowRunToolAttachment,
} from "@/node/services/turnEngine/types";

/**
 * The turn's folded output: its parts, the step and terminal bookkeeping the fold
 * keeps beside them, and the turn metadata. Owner: StepApply.
 */
export interface TurnState {
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
  initialMetadata?: Partial<MuxMetadata>;
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
}

/**
 * The turn's slot in the workspace: identity, lifecycle state, stop latches and
 * the terminal outcome. Owner: TurnRegistry.
 */
export interface TurnSlot {
  state: StreamState;
  workspaceName?: string;
  messageId: string;
  token: StreamToken;
  executionScope?: ExecutionScope;
  startTime: number;
  /**
   * HostClock start of the stream-end and abort durations. Two start fields exist because
   * `startTime` is a record time: the assistant row stamp and the `starting-<startTime>` id
   * stay on the wall clock until the row consumers move to the HostClock (#7282).
   */
  durationStartMs: number;
  historySequence: number;
  // Track background processing promise for guaranteed cleanup
  processingPromise: Promise<void>;
  // Latched by the first cancelStreamSafely call (synchronously, before its
  // first await) so concurrent cancellers — a user stop racing shutdown's
  // "system" cancel (TurnRegistry.stopForShutdown) — join one cleanup: exactly
  // one stream-abort, one settle.
  cancelPromise?: Promise<void>;
  // The turn's child scope of the app's AppFiberScope (superviseEngine); set only
  // when the manager was constructed with an engine scope.
  turnScope?: Scope.Closeable;
  // The attempt loop's fiber (launchProcessing), in turnScope when there is one.
  engineFiber?: Fiber.Fiber<void>;
  // Soft-interrupt state: when pending, stream will end at next block boundary
  softInterrupt:
    | { pending: false }
    | { pending: true; abandonPartial: boolean; abortReason: StreamAbortReason };
  completionController: TurnCompletionController;
  terminalCompletion?: TurnCompletion;
}

/**
 * The current provider attempt: its request, stream result, model and the
 * retry marks. Owner: ProviderRequest.
 */
export interface AttemptRequest {
  streamResult: Awaited<ReturnType<typeof streamText>>;
  model: string;
  /** Metadata model resolved from provider mapping for cost/token metadata lookups. */
  metadataModel: string;
  /** Effective thinking level after model policy clamping */
  thinkingLevel?: string;
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
}

/**
 * Resources the turn holds until it ends: the abort controller and its link, the
 * runtime and its temp dir, and the resource scope. Owner: TurnResources.
 */
export interface TurnHandles {
  unlinkAbortSignal?: () => void;
  abortController: AbortController;
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
}

/** The turn's partial.json write state. Owner: PartialJournal. */
export interface PartialJournalState {
  // Track last partial write time for throttling
  lastPartialWriteTime: number;
  // Debounce fiber for throttled partial writes (Effect migration Phase 10).
  // Non-null exactly while a delayed flush is scheduled; interrupted on re-arm,
  // on explicit flush, and with resourceScope when the stream ends. Effect's
  // clock registers a plain setTimeout under the hood, so scheduling semantics
  // match the previous timer.
  partialWriteFiber?: Fiber.Fiber<void>;
  // Track in-flight write to serialize writes
  partialWritePromise?: Promise<void>;
  // Set by the completion path right before it writes the final message to
  // chat.jsonl and deletes partial.json. From then on no partial may be written for
  // this stream: a cancel landing between deletePartial and COMPLETED (the
  // state flips late, see processStreamWithCleanup) would otherwise resurrect
  // partial.json through its pre-abort flush.
  partialRetired?: boolean;
}

/** The turn's usage totals and tool-model usage. Owner: UsageLedger. */
export interface UsageLedgerState {
  toolModelUsages: PersistedToolModelUsage[];
  // Key of this attempt's in-flight usage file (SessionUsageService.recordInFlightUsage);
  // set by the first finished step, cleared when the attempt settles or is discarded.
  inFlightUsageKey?: string;
  // Cumulative usage across all steps (for live cost display during streaming)
  cumulativeUsage: LanguageModelV2Usage;
  // Cumulative provider metadata across all steps (for live cost display with cache tokens)
  cumulativeProviderMetadata?: Record<string, unknown>;
  // Terminal model_refusal usage persisted on no-fallback error partials so live
  // and rebuilt session costs include the refused attempt.
  terminalRefusalUsage?: LanguageModelV2Usage;
  terminalRefusalProviderMetadata?: Record<string, unknown>;
  // Last step's usage (for context window display during streaming)
  lastStepUsage?: LanguageModelV2Usage;
  // Last step's provider metadata (for context window cache display)
  lastStepProviderMetadata?: Record<string, unknown>;
}

/**
 * Comprehensive stream info: one object per running turn, built from the six
 * records above.
 */
export interface WorkspaceStreamInfo
  extends
    Readonly<TurnState>,
    Readonly<TurnSlot>,
    Readonly<AttemptRequest>,
    Readonly<TurnHandles>,
    Readonly<PartialJournalState>,
    Readonly<UsageLedgerState> {}
