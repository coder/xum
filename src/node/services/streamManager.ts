import { EventEmitter } from "events";
import * as path from "path";
import { PlatformPaths } from "@/common/utils/paths";
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type SystemModelMessage,
  type LanguageModel,
  type Tool,
  type ToolSet,
  LoadAPIKeyError,
  APICallError,
  RetryError,
} from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { Ok, Err } from "@/common/types/result";
import { log, type Logger } from "./log";
import type {
  StreamStartEvent,
  StreamEndEvent,
  StreamAbortReason,
  UsageDeltaEvent,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  CompletedMessagePart,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";

import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage, PersistedToolModelUsage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import type {
  ActiveTurnThinkingOverride,
  RebuildProviderOptionsForThinkingLevel,
} from "@/node/services/thinkingOverride";
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  coerceStreamErrorTypeForMessage,
  createErrorEvent,
  stripNoisyErrorPrefix,
  type StreamErrorPayload,
} from "@/node/services/utils/sendMessageError";
import { hasCommitWorthyParts, type HistoryService } from "./historyService";
import {
  addUsage,
  accumulateProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import { linkAbortSignal } from "@/node/utils/abort";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import { stripInternalToolResultFields } from "@/common/utils/tools/internalToolResultFields";
import { buildRequiredToolPatterns, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
import {
  computeActiveToolNames,
  type ToolSearchStreamState,
} from "@/common/utils/tools/toolCatalog";
import { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";
import { countTokens } from "@/node/utils/main/tokenizer";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  createCachedSystemMessage,
  createOpenAICachedSystemMessage,
  applyCacheControlToTools,
  type AnthropicCacheTtl,
} from "@/common/utils/ai/cacheStrategy";
import type { SessionUsageService } from "./sessionUsageService";
import { createDisplayUsage } from "@/common/utils/tokens/displayUsage";
import { extractToolMediaAsUserMessagesFromModelMessages } from "@/node/utils/messages/extractToolMediaAsUserMessagesFromModelMessages";
import { stripEncryptedContent } from "@/node/utils/messages/stripEncryptedContent";
import { stripWorkflowRunRecordsFromModelMessages } from "@/node/utils/messages/stripWorkflowRunRecordsFromModelMessages";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { MUX_GATEWAY_SESSION_EXPIRED_MESSAGE } from "@/common/constants/muxGatewayOAuth";
import { getModelStats, getModelStatsResolved } from "@/common/utils/tokens/modelStats";
import { withSequentialExecution } from "@/node/services/tools/withSequentialExecution";
import type { ResolvedCallSettingsOverrides } from "@/common/config/schemas/modelParameters";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { getErrorMessage } from "@/common/utils/errors";
import { runLanguageModelCleanup } from "./languageModelCleanup";
import { shellQuote } from "@/common/utils/shell";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { PROVIDER_DEFINITIONS } from "@/common/constants/providers";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";

// Disable noisy AI SDK warning logging.
globalThis.AI_SDK_LOG_WARNINGS = false;

export type StreamTextOnChunk = NonNullable<Parameters<typeof streamText>[0]["onChunk"]>;

const EMPTY_STREAM_OUTPUT_ERROR_MESSAGE =
  "The model ended the stream before producing any assistant-visible output. This usually means the upstream stream was dropped rather than completed normally. Mux will retry automatically when possible, and if retries keep failing you should try again or switch models.";

const MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS = 1;
const STREAM_TRUNCATED_MESSAGE_SUFFIX =
  "stream closed unexpectedly before the response completed. Mux will retry automatically when possible, and if retries keep failing you should try again or switch models.";

class EmptyStreamOutputError extends Error {
  constructor() {
    super(EMPTY_STREAM_OUTPUT_ERROR_MESSAGE);
    this.name = "EmptyStreamOutputError";
  }
}

/**
 * Terminal provider refusal: the model declined to continue the turn. Unlike
 * EmptyStreamOutputError (a transport drop), retrying the same request will
 * likely refuse again, so this maps to the non-retryable "model_refusal" stream
 * error type.
 */
class ModelRefusalError extends Error {
  constructor(model: string, finishReason: string, fallbackNote?: string) {
    super(
      `The model refused to continue (finishReason: ${finishReason}): ${model}. ` +
        "Retrying the same request is unlikely to help; try rephrasing or a different model." +
        (fallbackNote ? ` ${fallbackNote}` : "")
    );
    this.name = "ModelRefusalError";
  }
}

class StreamTruncatedError extends Error {
  readonly providerDisplayName: string;

  constructor(providerDisplayName: string) {
    super(`${providerDisplayName} ${STREAM_TRUNCATED_MESSAGE_SUFFIX}`);
    this.name = "StreamTruncatedError";
    this.providerDisplayName = providerDisplayName;
  }
}

// Type definitions for stream parts with extended properties
interface ReasoningDeltaPart {
  type: "reasoning-delta";
  text?: string;
  delta?: string;
  providerMetadata?: {
    anthropic?: {
      signature?: string;
      redactedData?: string;
    };
  };
}

// Tool-call tracking + branded types
interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
}

type ToolCallMap = Map<string, ToolCallState>;

type WorkspaceId = string & { __brand: "WorkspaceId" };
type StreamToken = string & { __brand: "StreamToken" };

// Stream request config for start/retry

interface StepMessageTracker {
  latestMessages?: ModelMessage[];
}
interface StreamRequestConfig {
  model: LanguageModel;
  messages: ModelMessage[];
  /**
   * System instructions for streamText. Direct official OpenAI GPT-5.6
   * requests carry a structured SystemModelMessage with an explicit prompt
   * cache breakpoint (createOpenAICachedSystemMessage); everything else keeps
   * the plain string.
   */
  system?: string | SystemModelMessage;
  tools?: Record<string, Tool>;
  providerOptions?: Record<string, unknown>;
  /** Per-request HTTP headers (e.g., anthropic-beta for 1M context). */
  headers?: Record<string, string | undefined>;
  maxOutputTokens?: number;
  streamCallSettings?: Omit<ResolvedCallSettingsOverrides, "maxOutputTokens">;
  hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean;
  /** Optional hook for callers that need chunk-level visibility during streaming. */
  onChunk?: StreamTextOnChunk;
  /** Optional hook for callers that need the live prepared step transcript. */
  onStepMessages?: (messages: ModelMessage[]) => void;
  toolPolicy?: ToolPolicy;
  /**
   * Tool-search deferral state (tool-search experiment). Owned and mutated by
   * aiService/tool_catalog_search.execute; prepareStep reads it each step to compute
   * `activeTools`. Absent when the feature is inactive.
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
   * Closure built by AIService that re-runs the effective-level pipeline
   * (policy clamp + resolveEffectiveThinkingLevel) and rebuilds provider
   * options for the stream's model. `null` ⇒ not applicable / no-op.
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
}

/**
 * Per-model request pieces for a refusal-fallback swap, rebuilt by AIService so
 * provider-specific message preparation, provider options, and headers match a
 * first-class send of the fallback model (reusing the source model's request
 * verbatim would leak provider-specific options/messages across providers).
 */
export interface PreparedModelFallback {
  model: LanguageModel;
  /** Canonical model string of the fallback attempt (drives metadata + tokenizer). */
  modelString: string;
  /** Messages re-prepared for the fallback model's provider. */
  messages: ModelMessage[];
  /** System prompt rebuilt for the fallback model (model-keyed instruction sections). */
  system: string;
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
  anthropicCacheTtl?: AnthropicCacheTtl;
  thinkingLevel?: string;
  /** Route attribution corrections (routedThroughGateway, routeProvider, costsIncluded). */
  initialMetadataPatch?: Partial<MuxMetadata>;
  /**
   * Rebuild closure bound to the FALLBACK model so mid-turn thinking changes
   * keep working after a fallback hop (the source model's closure would build
   * options for the wrong model).
   */
  rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel;
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
  ) => Promise<Result<PreparedModelFallback, string>>;
}

function isKnownProviderName(provider: string): provider is keyof typeof PROVIDER_DEFINITIONS {
  return Object.hasOwn(PROVIDER_DEFINITIONS, provider);
}

function getStreamProviderDisplayName(model: string): string {
  const canonicalModel = normalizeToCanonical(model);
  const providerSeparatorIndex = canonicalModel.indexOf(":");
  const provider =
    providerSeparatorIndex > 0 ? canonicalModel.slice(0, providerSeparatorIndex) : undefined;
  if (provider && isKnownProviderName(provider)) {
    return PROVIDER_DEFINITIONS[provider].displayName;
  }

  return "The model";
}

function isStreamTruncatedMessage(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes("stream closed before message_stop") ||
    lowerMessage.includes("stream closed before terminal event") ||
    lowerMessage.includes("stream closed unexpectedly before the response completed")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAnthropicCacheTtl(value: unknown): value is AnthropicCacheTtl {
  return value === "5m" || value === "1h";
}

function getAnthropicCacheTtl(
  providerOptions?: Record<string, unknown>
): AnthropicCacheTtl | undefined {
  if (!providerOptions) {
    return undefined;
  }

  const anthropicOptions = providerOptions.anthropic;
  if (!isRecord(anthropicOptions)) {
    return undefined;
  }

  const cacheControl = anthropicOptions.cacheControl;
  if (!isRecord(cacheControl)) {
    return undefined;
  }

  const ttl = cacheControl.ttl;
  return isAnthropicCacheTtl(ttl) ? ttl : undefined;
}

// Stream state enum for exhaustive checking
enum StreamState {
  IDLE = "idle",
  STARTING = "starting",
  STREAMING = "streaming",
  STOPPING = "stopping",
  COMPLETED = "completed", // Stream finished successfully (before cleanup)
  ERROR = "error",
}

const MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM = 3;
const ORPHAN_TOOL_RESULT_PREVIEW_CHARS = 160;
const ORPHAN_TOOL_RESULT_MAX_KEYS = 8;

function summarizeToolResultForLog(output: unknown): Record<string, unknown> {
  if (output === null) {
    return { outputType: "null" };
  }

  if (typeof output === "string") {
    return {
      outputType: "string",
      outputLength: output.length,
      outputPreview: output.slice(0, ORPHAN_TOOL_RESULT_PREVIEW_CHARS),
    };
  }

  if (typeof output === "number" || typeof output === "boolean") {
    return {
      outputType: typeof output,
      outputPreview: String(output),
    };
  }

  if (Array.isArray(output)) {
    return {
      outputType: "array",
      outputLength: output.length,
      firstItemType:
        output.length > 0 && output[0] !== null
          ? typeof output[0]
          : output.length > 0
            ? "null"
            : undefined,
    };
  }

  if (typeof output === "object") {
    const outputRecord = output as Record<string, unknown>;
    const keys = Object.keys(outputRecord);
    const summary: Record<string, unknown> = {
      outputType: "object",
      outputKeyCount: keys.length,
      outputKeys: keys.slice(0, ORPHAN_TOOL_RESULT_MAX_KEYS),
    };

    if (typeof outputRecord.type === "string") {
      summary.outputFormat = outputRecord.type;
    }

    if (Array.isArray(outputRecord.value)) {
      summary.outputValueLength = outputRecord.value.length;
    }

    return summary;
  }

  return {
    outputType: typeof output,
    outputPreview: JSON.stringify(output),
  };
}

function markProviderMetadataCostsIncluded(
  providerMetadata: Record<string, unknown> | undefined,
  costsIncluded: boolean | undefined
): Record<string, unknown> | undefined {
  if (!costsIncluded) return providerMetadata;

  const muxMetadata = providerMetadata?.mux;
  const existingMux =
    muxMetadata && typeof muxMetadata === "object"
      ? (muxMetadata as Record<string, unknown>)
      : undefined;

  return {
    ...(providerMetadata ?? {}),
    mux: {
      ...(existingMux ?? {}),
      costsIncluded: true,
    },
  };
}
/** Build a UsageDeltaEvent with consistent costsIncluded stamping on cumulative metadata. */
function buildUsageDeltaEvent(opts: {
  workspaceId: string;
  messageId: string;
  usage: LanguageModelV2Usage;
  providerMetadata: Record<string, unknown> | undefined;
  cumulativeUsage: LanguageModelV2Usage;
  cumulativeProviderMetadata: Record<string, unknown> | undefined;
  costsIncluded: boolean | undefined;
  replay?: true;
}): UsageDeltaEvent {
  return {
    type: "usage-delta",
    workspaceId: opts.workspaceId,
    messageId: opts.messageId,
    ...(opts.replay ? { replay: true } : {}),
    usage: opts.usage,
    providerMetadata: opts.providerMetadata,
    cumulativeUsage: opts.cumulativeUsage,
    cumulativeProviderMetadata: markProviderMetadataCostsIncluded(
      opts.cumulativeProviderMetadata,
      opts.costsIncluded
    ),
  };
}

/**
 * Deep-clone a PersistedToolModelUsage so the stored copy is independent of the caller's object
 * (usage/providerMetadata are nested references the caller may mutate). Keeps providerMetadata
 * optional so the cloned object only carries the field when defined.
 */
function clonePersistedToolModelUsage(event: PersistedToolModelUsage): PersistedToolModelUsage {
  return {
    ...event,
    usage: { ...event.usage },
    ...(event.providerMetadata != null ? { providerMetadata: event.providerMetadata } : {}),
  };
}

function hasTokenUsage(usage: LanguageModelV2Usage | undefined): usage is LanguageModelV2Usage {
  return (
    usage !== undefined &&
    ((usage.inputTokens ?? 0) > 0 ||
      (usage.outputTokens ?? 0) > 0 ||
      (usage.totalTokens ?? 0) > 0 ||
      (usage.cachedInputTokens ?? 0) > 0 ||
      (usage.reasoningTokens ?? 0) > 0)
  );
}

function cloneUsage(usage: LanguageModelV2Usage): LanguageModelV2Usage {
  return { ...usage };
}

function hasIncompleteToolCallPart(parts: CompletedMessagePart[]): boolean {
  return parts.some((part) => part.type === "dynamic-tool" && part.state !== "output-available");
}

type DynamicToolCompletedMessagePart = Extract<CompletedMessagePart, { type: "dynamic-tool" }>;
type WorkflowRunToolAttachment = NonNullable<DynamicToolCompletedMessagePart["workflowRun"]>;

// Comprehensive stream info
interface WorkspaceStreamInfo {
  state: StreamState;
  streamResult: Awaited<ReturnType<typeof streamText>>;
  unlinkAbortSignal?: () => void;
  abortController: AbortController;
  workspaceName?: string;
  messageId: string;
  token: StreamToken;
  startTime: number;

  // Used to ensure part timestamps are strictly monotonic, even when multiple deltas land in the
  // same millisecond. This avoids collisions in reconnect replay dedupe logic which keys off of
  // (messageId, timestamp, delta).
  lastPartTimestamp: number;

  // Timestamp when each tool call reached output-available (tool-call-end emission).
  // Needed for reconnect replay filtering because dynamic-tool parts keep their
  // original start timestamp even after they gain output.
  toolCompletionTimestamps: Map<string, number>;

  // Workflow tools can create the durable run before their stream part is stored. Keep the exact
  // attachment and apply it as soon as the matching dynamic-tool part lands.
  pendingWorkflowRunAttachments: Map<string, WorkflowRunToolAttachment>;

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
  toolModelUsages: PersistedToolModelUsage[];
  request: StreamRequestConfig;
  // Track last prepared step messages for safe retries after tool steps
  stepTracker: StepMessageTracker;
  // Track if a previousResponseId retry happened after a step completed so
  // stream-end uses cumulative usage instead of the retried step's totalUsage.
  didRetryPreviousResponseIdAtStep: boolean;
  // Track when Mux restarted the stream after an empty-output completion so
  // stream-end prefers cumulative usage across attempts instead of the final
  // attempt's totalUsage only.
  didRetryAfterEmptyOutput?: boolean;
  // Refusal-fallback chain state. `original` keeps the pre-wrap request inputs
  // (as passed by AIService) that prepare() does not rebuild, so the request can
  // be rebuilt for a different model — buildStreamRequestConfig re-applies
  // provider-specific wrapping (e.g. Anthropic cached system message / tool
  // cache_control), which must not be applied twice or leak across providers.
  // System and tools are rebuilt per fallback model by prepare() because both
  // are model-keyed (provider web tools, MCP sanitization, model sections).
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
  historySequence: number;
  // Track accumulated parts for partial message (includes reasoning, text, and tools)
  parts: CompletedMessagePart[];
  // Reasoning parts before this index belong to refused fallback attempts whose
  // usage was already attributed separately; stream-end backfill must not bill
  // them again under the answering model.
  reasoningBackfillStartIndex?: number;
  // Track last partial write time for throttling
  lastPartialWriteTime: number;
  // Throttle timer for partial writes
  partialWriteTimer?: ReturnType<typeof setTimeout>;
  // Track in-flight write to serialize writes
  partialWritePromise?: Promise<void>;
  // Track background processing promise for guaranteed cleanup
  processingPromise: Promise<void>;
  // Soft-interrupt state: when pending, stream will end at next block boundary
  softInterrupt:
    | { pending: false }
    | { pending: true; abandonPartial: boolean; abortReason: StreamAbortReason };
  // Temporary directory for tool outputs (auto-cleaned when stream ends)
  runtimeTempDir: string;
  // Runtime for temp directory cleanup
  runtime: Runtime;
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

// Ensure per-stream part timestamps are strictly monotonic.
//
// Date.now() is millisecond-granularity, so two distinct chunks with identical text emitted in the
// same millisecond can otherwise collide on (timestamp, delta) during reconnect replay buffering.
function nextPartTimestamp(streamInfo: WorkspaceStreamInfo): number {
  const now = Date.now();
  const last = streamInfo.lastPartTimestamp;
  const timestamp = now <= last ? last + 1 : now;
  streamInfo.lastPartTimestamp = timestamp;
  return timestamp;
}

/**
 * StreamManager - Handles all streaming operations with type safety and atomic operations
 *
 * Key invariants:
 * - Only one active stream per workspace at any time
 * - Atomic stream creation/cancellation operations
 * - Guaranteed resource cleanup in all code paths
 */
export class StreamManager extends EventEmitter {
  private workspaceStreams = new Map<WorkspaceId, WorkspaceStreamInfo>();
  private streamLocks = new Map<WorkspaceId, AsyncMutex>();
  private readonly PARTIAL_WRITE_THROTTLE_MS = 500;
  private readonly historyService: HistoryService;
  private mcpServerManager?: MCPServerManager;
  private readonly sessionUsageService?: SessionUsageService;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;
  // Token tracker for live streaming statistics
  private tokenTracker = new StreamingTokenTracker();
  // Track OpenAI previousResponseIds that have been invalidated
  // When frontend retries, buildProviderOptions will omit these IDs
  private lostResponseIds = new Set<string>();

  constructor(
    historyService: HistoryService,
    sessionUsageService?: SessionUsageService,
    getProvidersConfig?: () => ProvidersConfigMap | null
  ) {
    super();
    this.historyService = historyService;
    this.sessionUsageService = sessionUsageService;
    this.getProvidersConfig = getProvidersConfig ?? (() => null);
  }

  private getWorkspaceLogger(
    workspaceId: WorkspaceId,
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName">
  ): Logger {
    const fields: Record<string, unknown> = { workspaceId };
    if (streamInfo?.workspaceName) {
      fields.workspaceName = streamInfo.workspaceName;
    }
    return log.withFields(fields);
  }
  // Public: AIService.resolveMetadataModel delegates here so non-stream
  // consumers (/btw answer rows) can stamp the same mappedToModel resolution.
  resolveMetadataModel(modelString: string): string {
    try {
      return resolveModelForMetadata(modelString, this.getProvidersConfig());
    } catch (error) {
      log.debug("Failed to resolve metadata model override", {
        modelString,
        error: getErrorMessage(error),
      });
      return modelString;
    }
  }

  setMCPServerManager(manager: MCPServerManager | undefined): void {
    this.mcpServerManager = manager;
  }

  recordToolModelUsage(
    workspaceId: string,
    messageId: string,
    event: PersistedToolModelUsage
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    streamInfo.toolModelUsages.push(clonePersistedToolModelUsage(event));
  }

  private getWorkflowRunAttachment(event: WorkflowRunAttachedEvent): WorkflowRunToolAttachment {
    return {
      runId: event.runId,
      ...(event.run != null ? { run: event.run } : {}),
      timestamp: event.timestamp,
    };
  }

  private takePendingWorkflowRunAttachment(
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string
  ): WorkflowRunToolAttachment | undefined {
    const pendingAttachments = (streamInfo.pendingWorkflowRunAttachments ??= new Map());
    const attachment = pendingAttachments.get(toolCallId);
    if (attachment != null) {
      pendingAttachments.delete(toolCallId);
    }
    return attachment;
  }

  private emitWorkflowRunAttachedFromAttachment(input: {
    workspaceId: WorkspaceId;
    messageId: string;
    toolCallId: string;
    attachment: WorkflowRunToolAttachment;
  }): void {
    this.emit("workflow-run-attached", {
      type: "workflow-run-attached",
      workspaceId: input.workspaceId as string,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      runId: input.attachment.runId,
      ...(input.attachment.run != null ? { run: input.attachment.run } : {}),
      timestamp: input.attachment.timestamp,
    } satisfies WorkflowRunAttachedEvent);
  }

  async attachWorkflowRunToToolCall(event: WorkflowRunAttachedEvent): Promise<boolean> {
    const workspaceId = event.workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(workspaceId);
    if (
      streamInfo == null ||
      (event.messageId != null && streamInfo.messageId !== event.messageId)
    ) {
      return false;
    }

    const attachment = this.getWorkflowRunAttachment(event);
    const partIndex = streamInfo.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === event.toolCallId
    );
    if (partIndex === -1) {
      (streamInfo.pendingWorkflowRunAttachments ??= new Map()).set(event.toolCallId, attachment);
      return true;
    }

    const part = streamInfo.parts[partIndex];
    if (part.type !== "dynamic-tool") {
      return false;
    }

    streamInfo.pendingWorkflowRunAttachments?.delete(event.toolCallId);
    streamInfo.parts[partIndex] = {
      ...part,
      workflowRun: attachment,
    };

    await this.flushPartialWrite(workspaceId, streamInfo);
    return true;
  }

  /**
   * Record on the dynamic-tool part when its execute() actually began running and notify
   * the UI. Returns false when the part has not landed in streamInfo.parts yet.
   */
  private applyToolExecutionStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCallId: string,
    timestamp: number
  ): boolean {
    const partIndex = streamInfo.parts.findIndex(
      (part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId
    );
    if (partIndex === -1) {
      return false;
    }

    const part = streamInfo.parts[partIndex];
    assert(part.type === "dynamic-tool", "applyToolExecutionStart matched a non-tool part");
    streamInfo.parts[partIndex] = { ...part, executionStartedAt: timestamp };

    this.emit("tool-call-execution-start", {
      type: "tool-call-execution-start",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      timestamp,
    } satisfies ToolCallExecutionStartEvent);
    return true;
  }

  /**
   * Called from withSequentialExecution the moment a tool call's execute() acquires the
   * execution lock. Parallel tool calls run sequentially, so this is the honest start of
   * execution — the part's own `timestamp` only marks when the model emitted the call.
   */
  private handleToolExecutionStart(
    workspaceId: WorkspaceId,
    messageId: string,
    toolCallId: string
  ): void {
    const streamInfo = this.workspaceStreams.get(workspaceId);
    if (streamInfo?.messageId !== messageId) {
      return;
    }

    // Use the stream's monotonic clock, not raw Date.now(): the tool-call part timestamp
    // was monotonicized by nextPartTimestamp(), so a same-millisecond raw reading could be
    // <= it. Reconnect replay repairs missed execution starts only when
    // executionStartedAt > cursor, and the cursor sits at the tool-call timestamp when the
    // client disconnected right after tool-call-start.
    const timestamp = nextPartTimestamp(streamInfo);
    if (!this.applyToolExecutionStart(workspaceId, streamInfo, toolCallId, timestamp)) {
      // execute() won the race against the fullStream consumer; the "tool-call" case
      // consumes this entry right after storing the part.
      (streamInfo.pendingToolExecutionStarts ??= new Map()).set(toolCallId, timestamp);
    }
  }

  /**
   * Write the current partial message to disk (throttled by mtime)
   * Ensures writes happen during rapid streaming (crash-resilient)
   */
  private async schedulePartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const now = Date.now();
    const timeSinceLastWrite = now - streamInfo.lastPartialWriteTime;

    // If enough time has passed, write immediately
    if (timeSinceLastWrite >= this.PARTIAL_WRITE_THROTTLE_MS) {
      await this.flushPartialWrite(workspaceId, streamInfo);
      return;
    }

    // Otherwise, schedule write for remaining time (fire-and-forget for scheduled writes)
    if (streamInfo.partialWriteTimer) {
      clearTimeout(streamInfo.partialWriteTimer);
    }

    const remainingTime = this.PARTIAL_WRITE_THROTTLE_MS - timeSinceLastWrite;
    streamInfo.partialWriteTimer = setTimeout(() => {
      void this.flushPartialWrite(workspaceId, streamInfo);
    }, remainingTime);
  }

  private async awaitPendingPartialWrite(streamInfo: WorkspaceStreamInfo): Promise<void> {
    if (streamInfo.partialWritePromise) {
      await streamInfo.partialWritePromise;
    }
  }

  /**
   * Flush any pending partial write and write immediately
   * Serializes writes to prevent races - waits for any in-flight write before starting new one
   */
  private async flushPartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    // Wait for any in-flight write to complete first (serialization)
    await this.awaitPendingPartialWrite(streamInfo);

    // Clear throttle timer
    if (streamInfo.partialWriteTimer) {
      clearTimeout(streamInfo.partialWriteTimer);
      streamInfo.partialWriteTimer = undefined;
    }

    // Start new write and track the promise
    streamInfo.partialWritePromise = (async () => {
      try {
        await this.historyService.writePartial(
          workspaceId as string,
          this.buildPartialAssistantMessage(streamInfo)
        );
        streamInfo.lastPartialWriteTime = Date.now();
      } catch (error) {
        log.error("Failed to write partial message:", error);
      } finally {
        // Clear promise when write completes
        streamInfo.partialWritePromise = undefined;
      }
    })();

    // Wait for this write to complete
    await streamInfo.partialWritePromise;
  }

  /**
   * Atomically ensures stream safety by cancelling any existing stream
   * @param workspaceId The workspace to ensure stream safety for
   * @returns A unique stream token for the new stream
   */
  private async ensureStreamSafety(workspaceId: WorkspaceId): Promise<StreamToken> {
    const existing = this.workspaceStreams.get(workspaceId);

    if (existing && existing.state !== StreamState.IDLE) {
      await this.cancelStreamSafely(workspaceId, existing, "system", undefined);
    }

    // Generate unique token for this stream (8 hex chars for context efficiency)
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Generate a unique stream token (8 hex characters)
   * Used by callers that need to prepare resources (like tools) before starting the stream
   * Uses 8 hex chars instead of UUID for context efficiency (shorter paths in agent output)
   */
  public generateStreamToken(): StreamToken {
    return Math.random().toString(16).substring(2, 10) as StreamToken;
  }

  /**
   * Create a temporary directory for a stream token
   * Use ~/.mux-tmp instead of system temp directory (e.g., /var/folders/...)
   * because macOS user-scoped temp paths are extremely long, which leads to:
   * - Agent mistakes when copying/manipulating paths
   * - Harder to read in tool outputs
   * - Potential path length issues on some systems
   *
   * Uses the Runtime abstraction so temp directories work for both local and SSH runtimes.
   */
  public async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    const tempDir = `~/.mux-tmp/${streamToken}`;

    // Resolve ~ in the runtime's context.
    //
    // IMPORTANT: On Windows local runtime, Git Bash may use a customized $HOME,
    // while runtime.resolvePath expands ~ via Node (USERPROFILE). To avoid drift,
    // create the directory using the resolved absolute path.
    let resolvedPath = (await runtime.resolvePath(tempDir)).trim();

    // In the main process, PlatformPaths defaults to POSIX behavior (no navigator),
    // so we normalize Windows paths to forward slashes.
    if (process.platform === "win32") {
      resolvedPath = resolvedPath.replace(/\\/g, "/");
    }

    try {
      await runtime.ensureDir(resolvedPath);
    } catch (err) {
      const msg = getErrorMessage(err);
      throw new Error(`Failed to create temp directory ${resolvedPath}: ${msg}`);
    }

    return resolvedPath;
  }

  private cleanupStreamTempDir(runtime: Runtime, runtimeTempDir: string): void {
    // Use parent directory as cwd for safety - if runtimeTempDir is malformed,
    // we won't accidentally run rm -rf from root.
    const tempDirBasename = PlatformPaths.basename(runtimeTempDir);
    const tempDirParent = path.dirname(runtimeTempDir);

    // Fire-and-forget: don't block stream completion waiting for directory deletion.
    // This is especially important for SSH where rm -rf can take 500ms-2s.
    void runtime
      .exec(`rm -rf ${shellQuote(tempDirBasename)}`, {
        cwd: tempDirParent,
        timeout: 10,
      })
      .then(async (result) => {
        await result.exitCode;
        log.debug(`Cleaned up temp dir: ${runtimeTempDir}`);
      })
      .catch((error) => {
        log.error(`Failed to cleanup temp dir ${runtimeTempDir}:`, error);
      });
  }

  /**
   * Extracts usage and duration metadata from stream result.
   *
   * Usage is only available after stream completes naturally.
   * On abort, the usage promise may hang - we use a timeout to return quickly.
   */
  private async emitToolCallDeltaIfPresent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: unknown
  ): Promise<boolean> {
    const maybeDelta = part as { type?: string } | undefined;
    if (maybeDelta?.type !== "tool-call-delta") {
      return false;
    }

    const toolDelta = part as {
      toolCallId: string;
      toolName: string;
      argsTextDelta: string;
    };

    const deltaText = String(toolDelta.argsTextDelta ?? "");
    if (deltaText.length === 0) {
      return true;
    }

    const tokens = await this.tokenTracker.countTokens(deltaText);
    const timestamp = Date.now();

    this.emit("tool-call-delta", {
      type: "tool-call-delta",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId: toolDelta.toolCallId,
      toolName: toolDelta.toolName,
      delta: toolDelta.argsTextDelta,
      tokens,
      timestamp,
    });

    return true;
  }

  private async getStreamMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<{
    totalUsage?: LanguageModelV2Usage;
    contextUsage?: LanguageModelV2Usage;
    contextProviderMetadata?: Record<string, unknown>;
    finishReason?: string;
    duration: number;
  }> {
    // Helper: wrap promise with independent timeout + error handling
    // Each promise resolves independently - one failure doesn't mask others
    const withTimeout = <T>(promise: PromiseLike<T>): Promise<T | undefined> =>
      Promise.race([
        promise,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]).catch(() => undefined);

    // Fetch all metadata in parallel with independent timeouts
    // - totalUsage: sum of all steps (for cost calculation). AI SDK 7's
    //   top-level `usage` accumulates across all steps (old `totalUsage`).
    // - contextUsage: last step only (for context window display) — moved to
    //   `finalStep.usage` in AI SDK 7.
    // - contextProviderMetadata: last step (for context window cache display)
    const streamResultWithFinishReason = streamInfo.streamResult as {
      finishReason?: PromiseLike<string>;
    };
    const [totalUsageRaw, finalStep, finishReason] = await Promise.all([
      withTimeout(streamInfo.streamResult.usage),
      withTimeout(streamInfo.streamResult.finalStep),
      streamResultWithFinishReason.finishReason
        ? withTimeout(streamResultWithFinishReason.finishReason)
        : Promise.resolve(undefined),
    ]);

    return {
      totalUsage: normalizeUsage(totalUsageRaw),
      contextUsage: normalizeUsage(finalStep?.usage),
      // AI SDK 7 moved Anthropic cache-write tokens off provider metadata;
      // re-inject from the final step's usage so cache display keeps working.
      contextProviderMetadata: withCacheWriteMetadata(
        finalStep?.providerMetadata,
        finalStep?.usage
      ),
      finishReason,
      duration: Date.now() - streamInfo.startTime,
    };
  }

  private resolveTotalUsageForStreamEnd(
    streamInfo: WorkspaceStreamInfo,
    totalUsage: LanguageModelV2Usage | undefined
  ): LanguageModelV2Usage | undefined {
    const cumulativeUsage = streamInfo.cumulativeUsage;
    if (
      (streamInfo.didRetryPreviousResponseIdAtStep || streamInfo.didRetryAfterEmptyOutput) &&
      hasTokenUsage(cumulativeUsage)
    ) {
      return cumulativeUsage;
    }

    // streamResult.totalUsage is read with a short timeout (getStreamMetadata) and can
    // resolve to undefined under slow SDK settlement even though the provider billed the
    // turn. Fall back to the live per-step accumulation so completed streams never
    // persist an unpriced assistant message (analytics prices rows from metadata.usage).
    if (!hasTokenUsage(totalUsage) && hasTokenUsage(cumulativeUsage)) {
      return cumulativeUsage;
    }

    return totalUsage;
  }

  private async backfillReasoningTokensFromParts(
    streamInfo: Pick<
      WorkspaceStreamInfo,
      "parts" | "metadataModel" | "model" | "reasoningBackfillStartIndex"
    >,
    usage: LanguageModelV2Usage | undefined
  ): Promise<void> {
    // Backfill reasoningTokens from the full reasoning text when the provider
    // doesn't report them. @ai-sdk/anthropic sets reasoning: undefined even for
    // extended-thinking models. Tokenizing concatenated text (not per-delta
    // sums) avoids BPE chunk-boundary inflation.
    if (!usage || usage.reasoningTokens) {
      return;
    }

    const reasoningText = streamInfo.parts
      .slice(streamInfo.reasoningBackfillStartIndex ?? 0)
      .filter(
        (part): part is Extract<CompletedMessagePart, { type: "reasoning" }> =>
          part.type === "reasoning"
      )
      .map((part) => part.text)
      .join("");
    if (!reasoningText) {
      return;
    }

    usage.reasoningTokens = await countTokens(
      streamInfo.metadataModel ?? streamInfo.model,
      reasoningText
    );
  }

  private resolveTtftMsForStreamEnd(streamInfo: WorkspaceStreamInfo): number | undefined {
    const firstTokenPart = streamInfo.parts.find(
      (
        part
      ): part is Extract<
        CompletedMessagePart,
        { type: "text" | "reasoning"; timestamp?: number }
      > => (part.type === "text" || part.type === "reasoning") && part.text.length > 0
    );

    if (!firstTokenPart) {
      return undefined;
    }

    if (!Number.isFinite(streamInfo.startTime)) {
      return undefined;
    }

    const firstTokenTimestamp = firstTokenPart.timestamp;
    if (typeof firstTokenTimestamp !== "number" || !Number.isFinite(firstTokenTimestamp)) {
      return undefined;
    }

    const ttftMs = Math.max(0, firstTokenTimestamp - streamInfo.startTime);
    return Number.isFinite(ttftMs) ? ttftMs : undefined;
  }

  /**
   * Aggregate provider metadata across all steps.
   *
   * CRITICAL: For multi-step tool calls, cache creation tokens are reported per-step.
   * streamResult.providerMetadata only contains the LAST step's metadata, missing
   * cache creation tokens from earlier steps. We must sum across all steps.
   */
  private async getAggregatedProviderMetadata(
    streamInfo: WorkspaceStreamInfo,
    timeoutMs = 1000
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const steps = await Promise.race([
        streamInfo.streamResult.steps,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);

      if (!steps || steps.length === 0) {
        // Fall back to the final step's provider metadata; AI SDK 7 reports
        // cache writes on usage, so re-inject them for downstream pricing.
        const finalStep = await streamInfo.streamResult.finalStep;
        return withCacheWriteMetadata(finalStep.providerMetadata, finalStep.usage);
      }

      // Aggregate cache creation tokens across all steps. AI SDK 7 moved
      // per-step cache-write tokens from providerMetadata.anthropic to
      // step.usage.inputTokenDetails, so inject them back per step before
      // accumulating (accumulateProviderMetadata sums across steps).
      let accumulated: Record<string, unknown> | undefined;
      for (const step of steps) {
        accumulated = accumulateProviderMetadata(
          accumulated,
          withCacheWriteMetadata(step.providerMetadata, step.usage)
        );
      }
      return accumulated;
    } catch (error) {
      log.debug("Could not aggregate provider metadata:", error);
      return undefined;
    }
  }

  /**
   * Safely cancels an existing stream with proper cleanup
   *
   * CRITICAL: Waits for the processing promise to complete before cleanup.
   * This ensures the old stream fully exits before a new stream can start,
   * preventing concurrent streams and race conditions.
   */
  /**
   * Convert a part to an event and emit it.
   * Shared between live streaming and replay to ensure consistent event emission.
   * This guarantees replay reconstructs the exact stream using the same tokenization logic.
   *
   * @param workspaceId - Workspace identifier
   * @param messageId - Message identifier
   * @param part - The part to emit (text, reasoning, or tool)
   */
  private async emitPartAsEvent(
    workspaceId: WorkspaceId,
    messageId: string,
    part: CompletedMessagePart,
    options?: { replay?: boolean }
  ): Promise<void> {
    const timestamp = part.timestamp ?? Date.now();
    const isReplay = options?.replay === true;

    if (part.type === "text") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emit("stream-delta", {
        type: "stream-delta",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        delta: part.text,
        tokens,
        timestamp,
      });
    } else if (part.type === "reasoning") {
      const tokens = await this.tokenTracker.countTokens(part.text);
      this.emit("reasoning-delta", {
        type: "reasoning-delta",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        delta: part.text,
        tokens,
        timestamp,
        signature: part.signature,
      });
    } else if (part.type === "dynamic-tool") {
      const inputText = JSON.stringify(part.input);
      const tokens = await this.tokenTracker.countTokens(inputText);
      this.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.input,
        tokens,
        timestamp,
        // Replays rebuild parts from scratch; carry the real execution start so
        // elapsed timers don't restart from the model-emission timestamp.
        ...(part.executionStartedAt !== undefined
          ? { executionStartedAt: part.executionStartedAt }
          : {}),
      });

      if (part.workflowRun != null) {
        this.emit("workflow-run-attached", {
          type: "workflow-run-attached",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: part.toolCallId,
          runId: part.workflowRun.runId,
          ...(part.workflowRun.run != null ? { run: part.workflowRun.run } : {}),
          timestamp: part.workflowRun.timestamp,
        } satisfies WorkflowRunAttachedEvent);
      }

      // If tool has output, emit completion
      if (part.state === "output-available") {
        this.emit("tool-call-end", {
          type: "tool-call-end",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
          timestamp: Date.now(),
        });
      }
    }
  }

  private async appendPartAndEmit(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    part: CompletedMessagePart,
    schedulePartialWrite = false
  ): Promise<void> {
    // Emit BEFORE adding to streamInfo.parts.
    //
    // On reconnect, we call replayStream() which snapshots streamInfo.parts. If we push a part to
    // streamInfo.parts and then await tokenization/emit, replay can include the "in-flight" part
    // and then the live emit still happens, causing duplicate deltas in the renderer.
    try {
      await this.emitPartAsEvent(workspaceId, streamInfo.messageId, part);
    } finally {
      // Always persist the part in-memory (and to partial.json, if enabled), even if emit fails.
      let partToPersist = part;
      let pendingAttachment: WorkflowRunToolAttachment | undefined;
      let pendingExecutionStart: number | undefined;
      if (part.type === "dynamic-tool") {
        pendingAttachment = this.takePendingWorkflowRunAttachment(streamInfo, part.toolCallId);
        // execute() may have started (lock acquired) before the fullStream consumer
        // stored this part; carry the real execution start onto the persisted part.
        pendingExecutionStart = streamInfo.pendingToolExecutionStarts?.get(part.toolCallId);
        if (pendingExecutionStart !== undefined) {
          streamInfo.pendingToolExecutionStarts.delete(part.toolCallId);
        }
        if (pendingAttachment != null || pendingExecutionStart !== undefined) {
          partToPersist = {
            ...part,
            ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
            ...(pendingExecutionStart !== undefined
              ? { executionStartedAt: pendingExecutionStart }
              : {}),
          };
        }
      }
      streamInfo.parts.push(partToPersist);
      if (pendingExecutionStart !== undefined && part.type === "dynamic-tool") {
        this.emit("tool-call-execution-start", {
          type: "tool-call-execution-start",
          workspaceId: workspaceId as string,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          timestamp: pendingExecutionStart,
        } satisfies ToolCallExecutionStartEvent);
      }
      if (pendingAttachment != null && part.type === "dynamic-tool") {
        await this.flushPartialWrite(workspaceId, streamInfo);
        this.emitWorkflowRunAttachedFromAttachment({
          workspaceId,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          attachment: pendingAttachment,
        });
      } else if (schedulePartialWrite) {
        void this.schedulePartialWrite(workspaceId, streamInfo);
      }
    }
  }

  private async cancelStreamSafely(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // If stream already completed normally (emitted stream-end), wait for its
    // finally block to finish before returning. This happens when ensureStreamSafety
    // is called for a new stream after the previous one finished but before it was
    // removed from workspaceStreams.
    // Without this guard, we'd emit stream-abort after stream-end, causing the
    // frontend to incorrectly flip the message back to partial:true.
    // We must NOT delete workspaceStreams here — the finally block does that.
    // If we delete early, the finally block's delete could race with a new stream
    // being registered and delete the new stream's entry instead.
    if (streamInfo.state === StreamState.COMPLETED) {
      await streamInfo.processingPromise;
      return;
    }

    try {
      streamInfo.state = StreamState.STOPPING;
      // Flush any pending partial write immediately (preserves work on interruption)
      await this.flushPartialWrite(workspaceId, streamInfo);

      streamInfo.abortController.abort();

      // Unlike checkSoftCancelStream, await cleanup (blocking)
      await this.cleanupAbortedStream(workspaceId, streamInfo, abortReason, abandonPartial);
    } catch (error) {
      log.error("Error during stream cancellation:", error);
      // Force cleanup even if cancellation fails
      this.workspaceStreams.delete(workspaceId);
    }
  }

  // Checks if a soft interrupt is necessary, and performs one if so
  // Similar to cancelStreamSafely but performs cleanup without blocking
  private async checkSoftCancelStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (!streamInfo.softInterrupt.pending) return;
    try {
      streamInfo.state = StreamState.STOPPING;

      // Flush any pending partial write immediately (preserves work on interruption)
      await this.flushPartialWrite(workspaceId, streamInfo);

      streamInfo.abortController.abort();

      // Return back to the stream loop so we can wait for it to finish before
      // sending the stream abort event.
      const { abandonPartial, abortReason } = streamInfo.softInterrupt;
      void this.cleanupAbortedStream(workspaceId, streamInfo, abortReason, abandonPartial);
    } catch (error) {
      log.error("Error during stream cancellation:", error);
      // Force cleanup even if cancellation fails
      this.workspaceStreams.delete(workspaceId);
    }
  }

  private async cleanupAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // CRITICAL: Wait for processing to fully complete before cleanup
    // This prevents race conditions where the old stream is still running
    // while a new stream starts (e.g., old stream writing to partial.json)
    await streamInfo.processingPromise;

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    const duration = Date.now() - streamInfo.startTime;
    const usage = hasTokenUsage(streamInfo.cumulativeUsage)
      ? streamInfo.cumulativeUsage
      : undefined;
    await this.backfillReasoningTokensFromParts(streamInfo, usage);

    // For context window display, use last step's usage (inputTokens = current context size)
    const contextUsage = streamInfo.lastStepUsage;
    const contextProviderMetadata = streamInfo.lastStepProviderMetadata;

    // Include provider metadata for accurate cost calculation
    const providerMetadata = markProviderMetadataCostsIncluded(
      streamInfo.cumulativeProviderMetadata,
      streamInfo.initialMetadata?.costsIncluded
    );

    // Record session usage for aborted streams (mirrors stream-end path)
    // This ensures tokens consumed before abort are tracked for cost display
    await this.recordSessionUsage(
      workspaceId,
      streamInfo.model,
      usage,
      providerMetadata,
      "Failed to record session usage on abort",
      "error",
      streamInfo
    );

    // Stamp the aborted turn's usage onto the partial message BEFORE emitting
    // stream-abort (whose handler commits the partial to chat.jsonl). Analytics
    // prices history rows from metadata.usage, so without this every
    // interrupted turn — user Esc, queued tool-end preemption, monitor wakes —
    // would ingest as $0 even though the provider billed all completed steps.
    if (!abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
      try {
        await this.awaitPendingPartialWrite(streamInfo);
        const partialMessage = this.buildPartialAssistantMessage(streamInfo, {
          metadata: {
            ...(usage !== undefined ? { usage: cloneUsage(usage) } : {}),
            ...(providerMetadata !== undefined ? { providerMetadata } : {}),
            ...(contextUsage !== undefined ? { contextUsage } : {}),
            ...(contextProviderMetadata !== undefined ? { contextProviderMetadata } : {}),
            duration,
            ...(streamInfo.toolModelUsages.length > 0
              ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
              : {}),
          },
        });
        await this.historyService.writePartial(workspaceId as string, partialMessage);

        // Tool-only aborts (Esc while a tool is still running): commitPartial
        // refuses to commit partials whose only parts are input-available tool
        // calls, so the usage stamped above would die with the deleted
        // partial. Route that spend through the headless-usage sidecar
        // instead. Same predicate commitPartial applies, so exactly one of
        // {chat row, sidecar row} carries this turn's usage.
        if (!hasCommitWorthyParts(partialMessage.parts)) {
          await this.recordDroppedPartialUsageInSidecar(
            workspaceId,
            streamInfo,
            usage,
            providerMetadata,
            "aborted_stream"
          );
        }
      } catch (error) {
        log.error("Failed to persist aborted-stream usage on partial message", { error });
      }
    } else if (abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
      // Abandoned aborts (edit/discard of the streaming turn): the partial is
      // deliberately dropped and its content never reaches chat.jsonl, but
      // the provider still billed every completed step. The sidecar is the
      // only route to the events table for this spend.
      try {
        await this.recordDroppedPartialUsageInSidecar(
          workspaceId,
          streamInfo,
          usage,
          providerMetadata,
          "aborted_stream"
        );
      } catch (error) {
        log.error("Failed to record abandoned-abort usage in headless sidecar", { error });
      }
    }

    // Emit abort event with usage if available
    this.emitStreamAbort(
      workspaceId,
      streamInfo.messageId,
      { usage, contextUsage, duration, providerMetadata, contextProviderMetadata },
      abortReason,
      abandonPartial,
      streamInfo.initialMetadata?.acpPromptId
    );

    // Clean up immediately
    this.workspaceStreams.delete(workspaceId);
  }

  /**
   * Route a dropped partial's billed usage to the headless-usage sidecar:
   * the parent stream's cumulative usage plus every tool-internal model call
   * (toolModelUsages). Used by the abort and error paths when the partial
   * fails commitPartial's durability predicate — metadata stamped on such a
   * partial dies with it, so the sidecar is the only route to the events
   * table. skipSessionLedger everywhere: parent usage was recorded via
   * recordSessionUsage and tool usage at report time (AIService).
   */
  private async recordDroppedPartialUsageInSidecar(
    workspaceId: WorkspaceId,
    streamInfo: Pick<WorkspaceStreamInfo, "model" | "toolModelUsages">,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    analyticsSource: "aborted_stream" | "errored_stream"
  ): Promise<void> {
    if (usage !== undefined) {
      await this.sessionUsageService?.recordHeadlessUsage(
        workspaceId as string,
        streamInfo.model,
        cloneUsage(usage),
        providerMetadata,
        { analyticsSource, skipSessionLedger: true }
      );
    }
    for (const toolUsage of streamInfo.toolModelUsages) {
      await this.sessionUsageService?.recordHeadlessUsage(
        workspaceId as string,
        toolUsage.model,
        cloneUsage(toolUsage.usage),
        toolUsage.providerMetadata,
        { analyticsSource, skipSessionLedger: true }
      );
    }
  }

  private async recordSessionUsage(
    workspaceId: WorkspaceId,
    model: string,
    usage: LanguageModelV2Usage | undefined,
    providerMetadata: Record<string, unknown> | undefined,
    logMessage: string,
    logLevel: "warn" | "error",
    streamInfo?: Pick<WorkspaceStreamInfo, "workspaceName" | "metadataModel">
  ): Promise<void> {
    if (!this.sessionUsageService || !usage) {
      return;
    }
    const messageUsage = createDisplayUsage(
      usage,
      model,
      providerMetadata,
      streamInfo?.metadataModel
    );
    if (!messageUsage) {
      return;
    }
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    try {
      await this.sessionUsageService.recordUsage(
        workspaceId as string,
        normalizeToCanonical(model),
        messageUsage
      );
    } catch (error) {
      (logLevel === "error" ? workspaceLog.error : workspaceLog.warn)(logMessage, { error });
    }
  }

  private buildStreamRequestConfig(
    model: LanguageModel,
    modelString: string,
    messages: ModelMessage[],
    system: string,
    // Backend-resolved route provider (initialMetadata.routeProvider for the
    // primary request, initialMetadataPatch.routeProvider for fallbacks).
    // Missing route metadata fails closed for OpenAI explicit prompt caching.
    routeProvider?: string,
    tools?: Record<string, Tool>,
    providerOptions?: Record<string, unknown>,
    maxOutputTokens?: number,
    callSettingsOverrides?: ResolvedCallSettingsOverrides,
    toolPolicy?: ToolPolicy,
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean,
    headers?: Record<string, string | undefined>,
    anthropicCacheTtlOverride?: AnthropicCacheTtl,
    onChunk?: StreamTextOnChunk,
    onStepMessages?: (messages: ModelMessage[]) => void,
    toolSearchState?: ToolSearchStreamState,
    onToolExecutionStart?: (toolCallId: string) => void,
    thinkingOverrideState?: ActiveTurnThinkingOverride,
    rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel
  ): StreamRequestConfig {
    // Mid-turn thinking overrides mutate providerOptions IN PLACE (the SDK's
    // per-step deep-merge reads the object passed at streamText() time, so
    // identity must stay stable). An initially-undefined value would make that
    // mutation unobservable — normalize to a guaranteed mutable object.
    const finalProviderOptions =
      rebuildProviderOptionsForThinkingLevel != null ? (providerOptions ?? {}) : providerOptions;

    // Apply cache control for Anthropic models
    let finalMessages = messages;
    let finalTools = tools;
    let finalSystem: string | SystemModelMessage | undefined = system;
    const anthropicCacheTtl =
      anthropicCacheTtlOverride ?? getAnthropicCacheTtl(finalProviderOptions);

    // For Anthropic models, convert system message to a cached message at the start
    const cachedSystemMessage = createCachedSystemMessage(system, modelString, anthropicCacheTtl);
    if (cachedSystemMessage) {
      // Prepend cached system message and set system parameter to undefined
      // Note: Must be undefined, not empty string, to avoid Anthropic API error
      finalMessages = [cachedSystemMessage, ...messages];
      finalSystem = undefined;
    } else {
      // Direct official OpenAI GPT-5.6: put one explicit prompt cache
      // breakpoint at the end of the stable system instructions. The system
      // stays in streamText's `system` argument (as a structured message);
      // request-wide caching remains implicit so OpenAI keeps placing its
      // automatic latest-message breakpoint. Ineligible routes (gateways,
      // Codex OAuth, custom base URLs, missing route metadata) keep the
      // original string.
      const openaiCachedSystem = createOpenAICachedSystemMessage(
        system,
        modelString,
        routeProvider,
        this.getProvidersConfig()
      );
      if (openaiCachedSystem) {
        finalSystem = openaiCachedSystem;
      }
    }

    // Apply cache control to tools for Anthropic models
    if (tools) {
      finalTools = applyCacheControlToTools(tools, modelString, anthropicCacheTtl);
    }

    // Use the runtime model's max_output_tokens if available and caller didn't
    // specify. This must be the runtime model (not the mapped metadata model)
    // because max_output_tokens is a request parameter sent to the provider —
    // a custom model's provider may not support the mapped model's output cap.
    // If no metadata exists, omit the parameter to let the provider use its
    // default (Anthropic requires this but has low defaults).
    const { maxOutputTokens: configMaxOutputTokens, ...streamCallSettings } =
      callSettingsOverrides ?? {};

    const runtimeModelStats = getModelStats(modelString);
    // Fall back to resolved stats for custom aliases (e.g., provider alias mappedToModel).
    const resolvedModelStats =
      runtimeModelStats ?? getModelStatsResolved(modelString, this.getProvidersConfig());
    const effectiveMaxOutputTokens =
      maxOutputTokens ?? configMaxOutputTokens ?? resolvedModelStats?.max_output_tokens;

    return {
      model,
      messages: finalMessages,
      system: finalSystem,
      // Keep provider-level parallel tool planning enabled, but serialize sibling
      // execute() handlers inside this stream so shared mutable state cannot race.
      tools: withSequentialExecution(finalTools, onToolExecutionStart),
      providerOptions: finalProviderOptions,
      headers,
      maxOutputTokens: effectiveMaxOutputTokens,
      streamCallSettings:
        Object.keys(streamCallSettings).length > 0 ? streamCallSettings : undefined,
      hasQueuedMessages,
      onChunk,
      onStepMessages,
      toolPolicy,
      toolSearchState,
      thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel,
    };
  }

  private createStopWhenCondition(
    request: Pick<StreamRequestConfig, "hasQueuedMessages" | "toolPolicy">
  ): Array<ReturnType<typeof stepCountIs>> {
    // Completion-tool stop check: completion/routing tools use explicit
    // success/ok markers (agent_report, propose_plan).
    // When a marker is present, respect it — success:false means the tool
    // should be retried, so don't stop. When no marker is present (e.g.,
    // MCP tools, arbitrary required tools), treat non-null object results
    // as successful completion unless the result is error-shaped.
    const isSuccessfulOutput = (output: unknown): boolean => {
      if (typeof output !== "object" || output === null) {
        return false;
      }
      const parsedOutput = output as Record<string, unknown>;
      if ("success" in parsedOutput) {
        return parsedOutput.success === true;
      }
      if ("ok" in parsedOutput) {
        return parsedOutput.ok === true;
      }
      if (parsedOutput.error != null || parsedOutput.isError === true) {
        return false;
      }
      return true;
    };

    const requiredPatterns = buildRequiredToolPatterns(request.toolPolicy);

    const hasSuccessfulRequiredToolResult: ReturnType<typeof stepCountIs> = ({ steps }) => {
      if (requiredPatterns.length === 0) {
        return false;
      }
      const lastStep = steps[steps.length - 1];
      return (
        lastStep?.toolResults?.some(
          (toolResult) =>
            requiredPatterns.some((pattern) => pattern.test(toolResult.toolName)) &&
            isSuccessfulOutput(toolResult.output)
        ) ?? false
      );
    };

    return [
      stepCountIs(100000),
      // The SDK evaluates stop conditions only after every sibling tool result in the
      // model's current step settles. Do not move this to individual tool-call-end events:
      // that would abort the remaining calls the model emitted in the same batch.
      () => request.hasQueuedMessages?.("tool-end") ?? false,
      hasSuccessfulRequiredToolResult,
    ];
  }

  /**
   * Consume a pending mid-turn thinking-level override for the next step.
   *
   * Consume-once: `pending` is always cleared (a failed/no-op application must
   * not retry on every subsequent step). On success the CONTENT of
   * `request.providerOptions` is replaced in place — object identity is
   * preserved because the SDK's per-step deep-merge reads the reference passed
   * at streamText() time, and deep-merge alone cannot delete keys (e.g. the
   * Anthropic `thinking` object when moving to "off").
   *
   * Returns the rebuilt options (for the prepareStep return value) or
   * undefined when there is nothing to apply.
   */
  private applyPendingThinkingOverride(
    request: StreamRequestConfig
  ): Record<string, unknown> | undefined {
    const state = request.thinkingOverrideState;
    const pending = state?.pending;
    if (state == null || pending == null) {
      return undefined;
    }
    state.pending = undefined;
    const rebuild = request.rebuildProviderOptionsForThinkingLevel;
    if (rebuild == null) {
      return undefined;
    }
    const rebuilt = rebuild(pending);
    if (rebuilt == null) {
      log.debug("Mid-turn thinking override skipped (not applicable / no-op)", {
        requestedLevel: pending,
        appliedLevel: state.applied,
      });
      return undefined;
    }
    const target = request.providerOptions;
    // buildStreamRequestConfig normalizes providerOptions to a stable object
    // whenever a rebuild closure is present, so target must exist here.
    assert(target != null, "providerOptions must be normalized when a rebuild closure is present");
    for (const key of Object.keys(target)) {
      delete target[key];
    }
    Object.assign(target, rebuilt.providerOptions);
    state.applied = rebuilt.effectiveLevel;
    state.onApplied?.(rebuilt.effectiveLevel);
    log.debug("Mid-turn thinking override applied", {
      requestedLevel: pending,
      effectiveLevel: rebuilt.effectiveLevel,
    });
    return rebuilt.providerOptions;
  }

  private createStreamResult(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker?: StepMessageTracker
  ): Awaited<ReturnType<typeof streamText>> {
    // Explicit <ToolSet> pins RUNTIME_CONTEXT to its default: mux tools use
    // Tool's `any` context, which would otherwise infect the inferred result
    // type (no-unsafe-return).
    return streamText<ToolSet>({
      model: request.model,
      messages: request.messages,
      system: request.system,
      // For Anthropic prompt caching, the system prompt is prepended to
      // `messages` as a { role: "system" } message (createCachedSystemMessage).
      // AI SDK 7 rejects system messages inside `messages` unless opted in.
      // Trusted: mux builds these messages server-side.
      allowSystemInMessages: true,
      abortSignal: abortController.signal,
      prepareStep: async ({ messages: stepMessages }) => {
        // streamText runs multiple internal LLM calls (steps) when tools are enabled.
        // Strip workflow run records from same-turn tool results (history-level redaction in
        // applyToolOutputRedaction can't see these), then extract supported attachments out of
        // tool-result JSON so providers don't treat them as text.
        const withoutWorkflowRunRecords = stripWorkflowRunRecordsFromModelMessages(stepMessages);
        const rewritten =
          await extractToolMediaAsUserMessagesFromModelMessages(withoutWorkflowRunRecords);
        const effectiveMessages = rewritten === stepMessages ? stepMessages : rewritten;
        if (stepTracker) {
          stepTracker.latestMessages = effectiveMessages;
        }
        request.onStepMessages?.(effectiveMessages);
        // Tool search (tool-search experiment): scope the advertised tool list
        // to core tools + activated deferred tools. Read per step so tools
        // activated by tool_catalog_search.execute appear on the following step.
        // undefined when the feature is inactive, keeping the return value
        // byte-identical to the pre-feature behavior.
        const activeTools = computeActiveToolNames(request.toolSearchState);
        // Mid-turn thinking-level change: consume a pending override before
        // this step's provider request is built.
        const thinkingOverride = this.applyPendingThinkingOverride(request);
        if (
          rewritten === stepMessages &&
          activeTools === undefined &&
          thinkingOverride === undefined
        ) {
          return undefined;
        }
        return {
          ...(rewritten === stepMessages ? {} : { messages: rewritten }),
          ...(activeTools !== undefined ? { activeTools } : {}),
          // Defense in depth: the in-place request mutation is authoritative
          // (per-step deep-merge cannot delete keys); returning the rebuilt
          // options also covers any future SDK options snapshotting.
          ...(thinkingOverride !== undefined
            ? { providerOptions: thinkingOverride as ProviderOptions }
            : {}),
        };
      },
      onChunk: request.onChunk,
      tools: request.tools,
      stopWhen: this.createStopWhenCondition(request),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      providerOptions: request.providerOptions as any, // Pass provider-specific options (thinking/reasoning config)
      headers: request.headers, // Per-request HTTP headers (e.g., anthropic-beta for 1M context)
      maxOutputTokens: request.maxOutputTokens,
      ...(request.streamCallSettings ?? {}),
    });
  }

  /**
   * Atomically creates a new stream with all necessary setup
   */
  private createStreamAtomically(
    workspaceId: WorkspaceId,
    streamToken: StreamToken,
    runtimeTempDir: string,
    runtime: Runtime,
    messages: ModelMessage[],
    model: LanguageModel,
    modelString: string,
    abortController: AbortController,
    system: string,
    historySequence: number,
    messageId: string,
    tools?: Record<string, Tool>,
    initialMetadata?: Partial<MuxMetadata>,
    providerOptions?: Record<string, unknown>,
    maxOutputTokens?: number,
    toolPolicy?: ToolPolicy,
    callSettingsOverrides?: ResolvedCallSettingsOverrides,
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean,
    workspaceName?: string,
    thinkingLevel?: string,
    headers?: Record<string, string | undefined>,
    anthropicCacheTtlOverride?: AnthropicCacheTtl,
    onChunk?: StreamTextOnChunk,
    onStepMessages?: (messages: ModelMessage[]) => void,
    modelFallback?: ModelFallbackOptions,
    toolSearchState?: ToolSearchStreamState,
    thinkingOverrideState?: ActiveTurnThinkingOverride,
    rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel
  ): WorkspaceStreamInfo {
    // abortController is created and linked to the caller-provided abortSignal in startStream().

    const stepTracker: StepMessageTracker = {};
    const metadataModel = this.resolveMetadataModel(modelString);
    const request = this.buildStreamRequestConfig(
      model,
      modelString,
      messages,
      system,
      initialMetadata?.routeProvider,
      tools,
      providerOptions,
      maxOutputTokens,
      callSettingsOverrides,
      toolPolicy,
      hasQueuedMessages,
      headers,
      anthropicCacheTtlOverride,
      onChunk,
      onStepMessages,
      toolSearchState,
      (toolCallId) => this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
      thinkingOverrideState,
      rebuildProviderOptionsForThinkingLevel
    );

    // Start streaming - this can throw immediately if API key is missing
    let streamResult;
    try {
      streamResult = this.createStreamResult(request, abortController, stepTracker);
    } catch (error) {
      // Clean up abort controller if stream creation fails
      abortController.abort();
      // Re-throw the error to be caught by startStream
      throw error;
    }

    const startTime = Date.now();
    const streamInfo: WorkspaceStreamInfo = {
      state: StreamState.STARTING,
      streamResult,
      workspaceName,
      abortController,
      messageId,
      token: streamToken,
      startTime,
      lastPartTimestamp: startTime,
      toolCompletionTimestamps: new Map(),
      pendingWorkflowRunAttachments: new Map(),
      pendingToolExecutionStarts: new Map(),
      model: modelString,
      metadataModel,
      thinkingLevel,
      initialMetadata,
      toolModelUsages: [],
      didRetryPreviousResponseIdAtStep: false,
      didRetryAfterEmptyOutput: false,
      ...(modelFallback && modelFallback.chain.length > 0
        ? {
            modelFallback: {
              options: modelFallback,
              requestedModel: normalizeToCanonical(modelString),
              refusedModels: [],
              // Pre-wrap inputs (NOT request.maxOutputTokens, which may already
              // carry call-settings overrides for the original model).
              original: { maxOutputTokens },
            },
          }
        : {}),
      stepTracker,
      receivedTerminalEvent: false,
      currentStepStartIndex: 0,
      request,
      historySequence,
      parts: [], // Initialize empty parts array
      lastPartialWriteTime: 0, // Initialize to 0 to allow immediate first write
      partialWritePromise: undefined, // No write in flight initially
      processingPromise: Promise.resolve(), // Placeholder, overwritten in startStream
      softInterrupt: { pending: false },
      runtimeTempDir, // Stream-scoped temp directory for tool outputs
      runtime, // Runtime for temp directory cleanup
      // Initialize cumulative tracking for multi-step streams
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      cumulativeProviderMetadata: undefined,
    };

    // Mid-turn thinking override: route applied levels into this stream's
    // metadata (partials, stream-end, final assistant message). Wired before
    // any step can run; the catch-up sync covers a holder that already applied
    // a level (e.g. re-attachment on retry paths).
    if (request.thinkingOverrideState) {
      request.thinkingOverrideState.onApplied = (level) => {
        streamInfo.thinkingLevel = level;
      };
      if (request.thinkingOverrideState.applied) {
        streamInfo.thinkingLevel = request.thinkingOverrideState.applied;
      }
    }

    // Atomically register the stream
    this.workspaceStreams.set(workspaceId, streamInfo);

    return streamInfo;
  }

  /**
   * Complete a tool call by updating its part and emitting tool-call-end event.
   * CRITICAL: Flushes partial to disk BEFORE emitting event to prevent race conditions
   * where listeners (e.g., sendQueuedMessages) read stale partial data.
   */
  private async completeToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean
  ): Promise<void> {
    // Find and update the existing tool part
    const existingPartIndex = streamInfo.parts.findIndex(
      (p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId
    );
    const pendingAttachment = this.takePendingWorkflowRunAttachment(streamInfo, toolCallId);

    if (existingPartIndex !== -1) {
      const existingPart = streamInfo.parts[existingPartIndex];
      if (existingPart.type === "dynamic-tool") {
        streamInfo.parts[existingPartIndex] = {
          ...existingPart,
          ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
          state: "output-available" as const,
          output,
        };
      }
    } else {
      // Fallback: if the matching tool-call part is missing, still persist output so the UI
      // does not stay stuck in input-available. Input may be missing for provider-native tools.
      const toolCall = toolCalls.get(toolCallId);
      streamInfo.parts.push({
        type: "dynamic-tool" as const,
        toolCallId,
        toolName,
        state: "output-available" as const,
        input: toolCall?.input ?? null,
        output,
        timestamp: nextPartTimestamp(streamInfo),
        ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
      });
    }

    // CRITICAL: Flush partial to disk BEFORE emitting event
    // This ensures listeners (like sendQueuedMessages) see the tool result when they
    // read partial.json via commitPartial. Without this await, there's a race condition
    // where the partial is read before the tool result is written, causing "amnesia".
    await this.flushPartialWrite(workspaceId, streamInfo);
    if (pendingAttachment != null) {
      this.emitWorkflowRunAttachedFromAttachment({
        workspaceId,
        messageId: streamInfo.messageId,
        toolCallId,
        attachment: pendingAttachment,
      });
    }

    // Emit tool-call-end event (listeners can now safely read partial)
    const completionTimestamp = nextPartTimestamp(streamInfo);
    streamInfo.toolCompletionTimestamps ??= new Map();
    streamInfo.toolCompletionTimestamps.set(toolCallId, completionTimestamp);
    this.emit("tool-call-end", {
      type: "tool-call-end",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      toolName,
      result: output,
      ...(providerExecuted === true ? { providerExecuted: true } : {}),
      timestamp: completionTimestamp,
    } as ToolCallEndEvent);
  }

  private async finishToolCall(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean
  ): Promise<void> {
    await this.completeToolCall(
      workspaceId,
      streamInfo,
      toolCalls,
      toolCallId,
      toolName,
      output,
      providerExecuted
    );
    await this.checkSoftCancelStream(workspaceId, streamInfo);
  }

  private logOrphanToolResult(
    workspaceLog: Logger,
    streamInfo: WorkspaceStreamInfo,
    part: { toolCallId: string; toolName: string },
    output: unknown,
    orphanCount: number,
    trackedToolCallCount: number
  ): void {
    if (orphanCount > MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      return;
    }

    workspaceLog.warn(
      "[streamManager] Received tool-result without matching tool-call map entry; persisting fallback output",
      {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        orphanCount,
        trackedToolCallCount,
        isWebSearch: part.toolName === "web_search",
        ...summarizeToolResultForLog(output),
      }
    );

    if (orphanCount === MAX_ORPHAN_TOOL_RESULT_WARNINGS_PER_STREAM) {
      workspaceLog.warn(
        "[streamManager] Suppressing additional orphan tool-result warnings for this stream",
        {
          messageId: streamInfo.messageId,
          model: streamInfo.model,
          suppressedAfter: orphanCount,
        }
      );
    }
  }

  /**
   * Emit nested tool events from PTC code_execution.
   * These are forwarded to the frontend via the same event channel as regular tool events.
   * The parentToolCallId field identifies which code_execution call spawned this nested call.
   *
   * Also persists nested calls to streamInfo.parts so they survive interruption/reload.
   */
  emitNestedToolEvent(
    workspaceId: string,
    messageId: string,
    event: {
      type: "tool-call-start" | "tool-call-end";
      callId: string;
      toolName: string;
      args: unknown;
      parentToolCallId: string;
      startTime: number;
      endTime?: number;
      result?: unknown;
      error?: string;
    }
  ): void {
    // Persist nested calls to streamInfo.parts for crash/interrupt resilience
    const streamInfo = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (streamInfo) {
      const parentPartIndex = streamInfo.parts.findIndex(
        (p): p is CompletedMessagePart & { type: "dynamic-tool"; toolCallId: string } =>
          p.type === "dynamic-tool" && "toolCallId" in p && p.toolCallId === event.parentToolCallId
      );

      if (parentPartIndex !== -1) {
        const parentPart = streamInfo.parts[parentPartIndex] as { nestedCalls?: NestedToolCall[] };
        const nestedCalls = parentPart.nestedCalls ?? [];

        if (event.type === "tool-call-start") {
          nestedCalls.push({
            toolCallId: event.callId,
            toolName: event.toolName,
            input: event.args,
            state: "input-available",
            timestamp: event.startTime,
          });
        } else if (event.type === "tool-call-end") {
          const idx = nestedCalls.findIndex((n) => n.toolCallId === event.callId);
          if (idx !== -1) {
            nestedCalls[idx] = {
              ...nestedCalls[idx],
              output: event.result ?? (event.error ? { error: event.error } : undefined),
              state: "output-available",
            };
          }
        }

        parentPart.nestedCalls = nestedCalls;

        // Schedule partial write so nested calls survive crashes
        void this.schedulePartialWrite(workspaceId as WorkspaceId, streamInfo);
      }
    }

    // Emit to frontend
    if (event.type === "tool-call-start") {
      this.emit("tool-call-start", {
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        args: event.args,
        tokens: 0, // Nested calls don't count toward stream tokens
        timestamp: event.startTime,
        parentToolCallId: event.parentToolCallId,
      });
    } else if (event.type === "tool-call-end") {
      this.emit("tool-call-end", {
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        result: event.result ?? (event.error ? { error: event.error } : undefined),
        timestamp: event.endTime!,
        parentToolCallId: event.parentToolCallId,
      });
    }
    // Console events are not streamed (appear in final result only)
  }

  private getStreamMode(initialMetadata?: Partial<MuxMetadata>): "plan" | "exec" | undefined {
    const rawMode = initialMetadata?.mode;
    // Stats schema only accepts "plan" | "exec".
    return rawMode === "plan" || rawMode === "exec" ? rawMode : undefined;
  }

  private emitStreamStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number,
    options?: { replay?: boolean }
  ): void {
    const streamStartAgentId = streamInfo.initialMetadata?.agentId;
    const streamStartMode = this.getStreamMode(streamInfo.initialMetadata);
    const canonicalModel = normalizeToCanonical(streamInfo.model);
    const routedThroughGateway =
      streamInfo.initialMetadata?.routedThroughGateway ??
      streamInfo.model.startsWith("mux-gateway:");
    const routeProvider = streamInfo.initialMetadata?.routeProvider;

    this.emit("stream-start", {
      type: "stream-start",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      ...(options?.replay && { replay: true }),
      model: canonicalModel,
      routedThroughGateway,
      ...(routeProvider != null && { routeProvider }),
      historySequence,
      startTime: streamInfo.startTime,
      ...(streamStartAgentId && { agentId: streamStartAgentId }),
      ...(streamStartMode && { mode: streamStartMode }),
      ...(streamInfo.thinkingLevel && { thinkingLevel: streamInfo.thinkingLevel }),
      ...(streamInfo.initialMetadata?.acpPromptId != null
        ? { acpPromptId: streamInfo.initialMetadata.acpPromptId }
        : {}),
    } as StreamStartEvent);
  }

  private emitStreamAbort(
    workspaceId: WorkspaceId,
    messageId: string,
    metadata: Record<string, unknown>,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean,
    acpPromptId?: string
  ): void {
    this.emit("stream-abort", {
      type: "stream-abort",
      workspaceId: workspaceId as string,
      messageId,
      abortReason,
      metadata,
      abandonPartial,
      acpPromptId,
    });
  }

  private async handleEmptyStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);
    const totalUsage = this.resolveTotalUsageForStreamEnd(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);

    // Surface silent provider drops instead of leaving an empty assistant placeholder behind.
    // Recent gpt-5.4-pro stalls only logged stream startup, so future occurrences need an
    // explicit backend breadcrumb and a user-visible retryable error.
    workspaceLog.error("Stream ended without emitting text, reasoning, or tool events", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
    });

    await this.handleStreamFailure(workspaceId, streamInfo, new EmptyStreamOutputError());
  }

  private async handleModelRefusalCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    fallbackNote?: string
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);

    workspaceLog.error("Stream ended with a terminal refusal", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      finishReason: streamInfo.terminalFinishReason,
      rawFinishReason: streamInfo.terminalRawFinishReason,
      durationMs: streamMeta.duration,
      partsCount: streamInfo.parts.length,
      fallbackNote,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new ModelRefusalError(streamInfo.model, refusalFinishReason, fallbackNote)
    );
  }

  private async getRefusalUsageSnapshot(streamInfo: WorkspaceStreamInfo): Promise<{
    usage?: LanguageModelV2Usage;
    providerMetadata?: Record<string, unknown>;
  }> {
    let usage = hasTokenUsage(streamInfo.cumulativeUsage) ? streamInfo.cumulativeUsage : undefined;
    let providerMetadata = streamInfo.cumulativeProviderMetadata
      ? { ...streamInfo.cumulativeProviderMetadata }
      : undefined;

    if (!usage) {
      const streamMeta = await this.getStreamMetadata(streamInfo);
      usage = hasTokenUsage(streamMeta.totalUsage) ? streamMeta.totalUsage : undefined;
      providerMetadata = providerMetadata ?? streamMeta.contextProviderMetadata;
    }

    if (!usage) {
      return {};
    }

    // Refused attempts never reach the normal stream-end path, so backfill
    // provider-omitted reasoningTokens before snapshotting usage for the
    // refusing model. reasoningBackfillStartIndex excludes earlier refused hops
    // when a later fallback also refuses after preserved parts.
    await this.backfillReasoningTokensFromParts(streamInfo, usage);

    providerMetadata =
      providerMetadata ??
      (streamInfo.cumulativeProviderMetadata
        ? { ...streamInfo.cumulativeProviderMetadata }
        : await this.getAggregatedProviderMetadata(streamInfo));

    return {
      usage: cloneUsage(usage),
      providerMetadata: markProviderMetadataCostsIncluded(
        providerMetadata ? { ...providerMetadata } : undefined,
        streamInfo.initialMetadata?.costsIncluded
      ),
    };
  }

  /**
   * Attribute a refused fallback attempt's token usage to the refusing model
   * before the fallback swap wipes per-attempt counters. The toolModelUsages
   * entry is the durable record (session-usage rebuilds scan it per-model); the
   * live recordSessionUsage call keeps in-memory session totals consistent with it.
   */
  private async recordRefusedAttemptUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    const { usage, providerMetadata } = await this.getRefusalUsageSnapshot(streamInfo);
    if (!usage) {
      return;
    }

    streamInfo.toolModelUsages.push({
      toolName: "model_fallback_refusal",
      timestamp: Date.now(),
      model: refusedModel,
      metadataModel: streamInfo.metadataModel,
      usage,
      ...(providerMetadata ? { providerMetadata } : {}),
    });

    await this.recordSessionUsage(
      workspaceId,
      refusedModel,
      usage,
      providerMetadata,
      "Failed to record refused-attempt session usage (fallback unaffected)",
      "warn",
      streamInfo
    );
  }

  private async recordTerminalRefusalUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusedModel: string
  ): Promise<void> {
    const { usage, providerMetadata } = await this.getRefusalUsageSnapshot(streamInfo);
    if (!usage) {
      return;
    }

    streamInfo.terminalRefusalUsage = usage;
    streamInfo.terminalRefusalProviderMetadata = providerMetadata;

    await this.recordSessionUsage(
      workspaceId,
      refusedModel,
      usage,
      providerMetadata,
      "Failed to record terminal-refusal session usage",
      "warn",
      streamInfo
    );
  }

  private buildPartialAssistantMessage(
    streamInfo: WorkspaceStreamInfo,
    options: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] } = {}
  ): MuxMessage {
    const canonicalModel = normalizeToCanonical(streamInfo.model);
    const routedThroughGateway =
      streamInfo.initialMetadata?.routedThroughGateway ??
      streamInfo.model.startsWith("mux-gateway:");

    return {
      id: streamInfo.messageId,
      role: "assistant",
      metadata: {
        historySequence: streamInfo.historySequence,
        timestamp: streamInfo.startTime,
        ...streamInfo.initialMetadata,
        model: canonicalModel,
        metadataModel: streamInfo.metadataModel,
        routedThroughGateway,
        ...(streamInfo.thinkingLevel && {
          thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
        }),
        partial: true,
        ...options.metadata,
      },
      parts: options.parts ?? streamInfo.parts,
    };
  }

  private buildPartialRefusalContinuationMessage(
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string
  ): Result<MuxMessage, string> {
    try {
      const parts = structuredClone(streamInfo.parts) as MuxMessage["parts"];
      return Ok(
        this.buildPartialAssistantMessage(streamInfo, {
          metadata: { finishReason: refusalFinishReason },
          parts,
        })
      );
    } catch (error) {
      return Err(`cloning partial assistant output failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Attempt a refusal-fallback model swap in place of a terminal model_refusal.
   *
   * This runs entirely inside the active stream loop, BEFORE any error event or
   * partial error state is committed, so TaskService/waiters never observe an
   * intermediate refusal while the chain is being attempted (no settlement
   * race) and no stale failed placeholder is persisted mid-chain.
   *
   * Returns { kind: "swapped" } when the loop should `continue` on the new
   * streamResult, or { kind: "terminal", terminalNote? } when the refusal must
   * fail the turn (no chain, chain exhausted, interrupted, or an unstartable
   * fallback model — which intentionally fails instead of skipping ahead).
   */
  private async tryModelFallbackAfterRefusal(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    refusalFinishReason: string,
    options?: { preserveParts?: boolean }
  ): Promise<{ kind: "swapped" } | { kind: "terminal"; terminalNote?: string }> {
    const fallbackState = streamInfo.modelFallback;
    const preserveParts = options?.preserveParts === true;
    const refusedModel = normalizeToCanonical(streamInfo.model);

    if (!fallbackState) {
      await this.recordTerminalRefusalUsage(workspaceId, streamInfo, refusedModel);
      return { kind: "terminal" };
    }

    fallbackState.refusedModels.push(refusedModel);
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      modelFallback: {
        requestedModel: fallbackState.requestedModel,
        refusedModels: [...fallbackState.refusedModels],
      },
    };

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModel);
      return { kind: "terminal" };
    }

    // Attribute this refused attempt's usage to the refusing model for EVERY
    // chain outcome (swap, exhaustion, unstartable fallback) before any state
    // reset. Chains that end in a terminal failure must not drop the final
    // hop's tokens from session usage / cost accounting.
    await this.recordRefusedAttemptUsage(workspaceId, streamInfo, refusedModel);

    const nextModelString = fallbackState.options.chain[fallbackState.refusedModels.length - 1];
    if (nextModelString === undefined) {
      return {
        kind: "terminal",
        terminalNote: `Model fallback chain exhausted; refused models: ${fallbackState.refusedModels.join(", ")}.`,
      };
    }

    if (preserveParts && hasIncompleteToolCallPart(streamInfo.parts)) {
      return {
        kind: "terminal",
        terminalNote:
          "Model fallback was skipped because the refused partial response had an incomplete tool call.",
      };
    }

    const continuation = preserveParts
      ? this.buildPartialRefusalContinuationMessage(streamInfo, refusalFinishReason)
      : undefined;
    if (continuation != null && !continuation.success) {
      return {
        kind: "terminal",
        terminalNote: `Model fallback was skipped because ${continuation.error}.`,
      };
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    // A throw out of prepare() must not escape to the generic stream-error path:
    // it would be categorized as a retryable api/unknown error and re-enter the
    // unbounded auto-retry loop this feature exists to prevent. Aborts rethrow so
    // a user interrupt during prepare stays an abort instead of a refusal.
    // Fold a mid-turn thinking override (pending or already applied) into the
    // fallback's baseline so the hop doesn't silently revert the user's
    // mid-turn change. Pending is cleared here — prepare() re-clamps it for
    // the fallback model and bakes it into the rebuilt provider options.
    const overrideHolder = streamInfo.request.thinkingOverrideState;
    const thinkingLevelOverride = overrideHolder?.pending ?? overrideHolder?.applied;
    if (overrideHolder?.pending != null) {
      overrideHolder.pending = undefined;
    }
    if (overrideHolder != null && thinkingLevelOverride != null) {
      // Keep the override visible to later hops: prepare() bakes it into this
      // hop's baseline, but a second hop re-folds from `applied`.
      overrideHolder.applied = thinkingLevelOverride;
    }
    const prepareCallOptions: ModelFallbackPrepareOptions | undefined =
      continuation?.success === true || thinkingLevelOverride != null
        ? {
            ...(continuation?.success === true
              ? { continuation: { assistantMessage: continuation.data } }
              : {}),
            ...(thinkingLevelOverride != null ? { thinkingLevelOverride } : {}),
          }
        : undefined;
    let prepared: Result<PreparedModelFallback, string>;
    try {
      prepared = await fallbackState.options.prepare(nextModelString, prepareCallOptions);
    } catch (error) {
      if (streamInfo.abortController.signal.aborted) {
        throw error;
      }
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`,
      };
    }
    if (!prepared.success) {
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${prepared.error}`,
      };
    }

    // Build the swapped request/stream into locals first so a failure here
    // leaves streamInfo unmodified (the terminal error then names the model
    // that actually refused, not a half-applied fallback).
    const nextRequest = this.buildStreamRequestConfig(
      prepared.data.model,
      prepared.data.modelString,
      prepared.data.messages,
      prepared.data.system,
      // Use the fallback's freshly-resolved route (not stale source metadata,
      // which streamInfo.initialMetadata still holds at this point) so the
      // OpenAI cached-system transform evaluates the fallback route.
      prepared.data.initialMetadataPatch?.routeProvider,
      prepared.data.tools,
      prepared.data.providerOptions,
      fallbackState.original.maxOutputTokens,
      prepared.data.callSettingsOverrides,
      streamInfo.request.toolPolicy,
      streamInfo.request.hasQueuedMessages,
      prepared.data.headers,
      prepared.data.anthropicCacheTtl,
      streamInfo.request.onChunk,
      streamInfo.request.onStepMessages,
      // Same state object: aiService's fallback prepare() rebuilt it in place
      // against the fallback toolset, so prepareStep keeps reading live state.
      streamInfo.request.toolSearchState,
      (toolCallId) => this.handleToolExecutionStart(workspaceId, streamInfo.messageId, toolCallId),
      // Same holder object (the session's setter keeps working across the
      // hop) with a closure bound to the FALLBACK model. Attached before
      // createStreamResult below in case the SDK eagerly prepares step 1.
      streamInfo.request.thinkingOverrideState,
      prepared.data.rebuildProviderOptionsForThinkingLevel
    );
    // createStreamResult may eagerly prepare the first fallback step and update
    // latestMessages. Clear stale source-step messages before starting it so a
    // later disk-reset await cannot wipe freshly prepared fallback messages.
    streamInfo.stepTracker.latestMessages = undefined;
    let nextStreamResult: WorkspaceStreamInfo["streamResult"];
    try {
      nextStreamResult = this.createStreamResult(
        nextRequest,
        streamInfo.abortController,
        streamInfo.stepTracker
      );
    } catch (error) {
      // The prepared fallback model never becomes streamInfo.request.model, so
      // the stream-exit finally would miss it (e.g. OpenAI WS transports hold
      // open sockets until cleanup runs).
      runLanguageModelCleanup(prepared.data.model);
      return {
        kind: "terminal",
        terminalNote: `Configured fallback model ${nextModelString} could not be started: ${getErrorMessage(error)}`,
      };
    }

    workspaceLog.warn(
      preserveParts
        ? "Model refused after partial output; continuing on configured fallback model"
        : "Model refused with no output; retrying on configured fallback model",
      {
        messageId: streamInfo.messageId,
        refusedModel,
        nextModel: prepared.data.modelString,
        refusalFinishReason,
        chain: fallbackState.options.chain,
        preservedPartCount: preserveParts ? streamInfo.parts.length : 0,
      }
    );

    // The refused attempt's usage was recorded above, BEFORE the reset wipes
    // cumulative counters (cross-model usage must not be priced under the
    // fallback model).
    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts,
      workspaceLog,
    });
    streamInfo.currentStepStartIndex = streamInfo.parts.length;
    streamInfo.reasoningBackfillStartIndex = preserveParts ? streamInfo.parts.length : undefined;

    streamInfo.model = prepared.data.modelString;
    streamInfo.metadataModel = this.resolveMetadataModel(prepared.data.modelString);
    if (prepared.data.thinkingLevel !== undefined) {
      streamInfo.thinkingLevel = prepared.data.thinkingLevel;
    }
    // Final stream-end metadata spreads initialMetadata, so route attribution
    // corrections and the fallback record propagate automatically.
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      ...prepared.data.initialMetadataPatch,
      modelFallback: {
        requestedModel: fallbackState.requestedModel,
        refusedModels: [...fallbackState.refusedModels],
      },
    };
    // Release the refused model's transport resources now: the stream-exit
    // finally only cleans the final request's model, so without this the
    // refused model (e.g. an OpenAI WS transport socket) would leak per hop.
    runLanguageModelCleanup(streamInfo.request.model);
    streamInfo.request = nextRequest;
    streamInfo.streamResult = nextStreamResult;
    await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

    return { kind: "swapped" };
  }

  private async handleTruncatedStreamCompletion(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    const streamMeta = await this.getStreamMetadata(streamInfo);
    const totalUsage = this.resolveTotalUsageForStreamEnd(streamInfo, streamMeta.totalUsage);
    const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    const providerDisplayName = getStreamProviderDisplayName(streamInfo.model);

    // Do not treat iterator EOF as success. Anthropic and OpenAI Responses both
    // have semantic terminal events; without the SDK finish part, this may be a
    // clean proxy/provider drop after partial text was already streamed.
    workspaceLog.error("Stream ended without a terminal finish event", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      providerDisplayName,
      durationMs: streamMeta.duration,
      totalUsage,
      contextUsage,
      cumulativeUsage: streamInfo.cumulativeUsage,
      previousResponseId,
      partsCount: streamInfo.parts.length,
    });

    await this.handleStreamFailure(
      workspaceId,
      streamInfo,
      new StreamTruncatedError(providerDisplayName)
    );
  }

  private async retryEmptyStreamBeforeFailure(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    emptyStreamRecoveryAttempts: number
  ): Promise<boolean> {
    if (emptyStreamRecoveryAttempts >= MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS) {
      return false;
    }

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      return false;
    }

    if (streamInfo.parts.length > 0) {
      return false;
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    workspaceLog.warn("Retrying stream after empty-output completion", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      nextAttempt: emptyStreamRecoveryAttempts + 1,
      maxAttempts: MAX_EMPTY_STREAM_RECOVERY_ATTEMPTS,
      previousResponseId: this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions),
    });

    streamInfo.didRetryAfterEmptyOutput = true;
    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveUsage: true,
      workspaceLog,
    });
    streamInfo.currentStepStartIndex = 0;
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );
    return true;
  }

  /**
   * Processes a stream with guaranteed cleanup, regardless of success or failure
   */
  private async processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    this.mcpServerManager?.acquireLease(workspaceId as string);

    try {
      // Update state to streaming
      streamInfo.state = StreamState.STREAMING;

      // Emit stream start event (include mode from initialMetadata if available)
      this.emitStreamStart(workspaceId, streamInfo, historySequence);

      // Initialize token tracker for this model
      await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

      let didRetryPreviousResponseId = false;
      let emptyStreamRecoveryAttempts = 0;
      const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
      let orphanToolResultCount = 0;

      while (true) {
        // Use fullStream to capture all events including tool calls
        const toolCalls: ToolCallMap = new Map();

        try {
          for await (const part of streamInfo.streamResult.fullStream) {
            // Check if stream was cancelled BEFORE processing any parts
            // This improves interruption responsiveness by catching aborts earlier
            if (streamInfo.abortController.signal.aborted) {
              break;
            }

            // Log all stream parts to debug reasoning (commented out - too spammy)
            // console.log("[DEBUG streamManager]: Stream part", {
            //   type: part.type,
            //   hasText: "text" in part,
            //   preview: "text" in part ? (part as StreamPartWithText).text?.substring(0, 50) : undefined,
            // });

            switch (part.type) {
              case "start-step": {
                streamInfo.currentStepStartIndex = streamInfo.parts.length;
                break;
              }

              case "text-delta": {
                // Providers/SDKs may stream text deltas under different keys.
                const textDeltaPart = part as Record<string, unknown>;

                const deltaText = extractChunkDeltaText(textDeltaPart, [
                  "text",
                  "delta",
                  "textDelta",
                ]);

                if (deltaText.length === 0) {
                  if (
                    textDeltaPart.text !== undefined ||
                    textDeltaPart.delta !== undefined ||
                    textDeltaPart.textDelta !== undefined
                  ) {
                    log.debug("[streamManager] Ignoring non-string text-delta payload", {
                      workspaceId,
                      model: streamInfo.model,
                      textType: typeof textDeltaPart.text,
                      deltaType: typeof textDeltaPart.delta,
                      textDeltaType: typeof textDeltaPart.textDelta,
                    });
                  }
                  break;
                }

                // Append each delta as a new part (merging happens at display time)
                const textPart = {
                  type: "text" as const,
                  text: deltaText,
                  timestamp: nextPartTimestamp(streamInfo),
                };
                await this.appendPartAndEmit(workspaceId, streamInfo, textPart, true);
                break;
              }

              default: {
                if (await this.emitToolCallDeltaIfPresent(workspaceId, streamInfo, part)) {
                  break;
                }
                break;
              }

              case "reasoning-delta": {
                // Both Anthropic and OpenAI use reasoning-delta for streaming reasoning content
                const reasoningPart = part as ReasoningDeltaPart;
                const delta = reasoningPart.text ?? reasoningPart.delta ?? "";
                const signature = reasoningPart.providerMetadata?.anthropic?.signature;

                // Signature deltas come separately with empty text - attach to last reasoning part
                if (signature && !delta) {
                  const lastPart = streamInfo.parts.at(-1);
                  if (lastPart?.type === "reasoning") {
                    lastPart.signature = signature;
                    // Also set providerOptions for SDK compatibility when converting to ModelMessages
                    lastPart.providerOptions = { anthropic: { signature } };
                    // Emit signature update event
                    this.emit("reasoning-delta", {
                      type: "reasoning-delta",
                      workspaceId: workspaceId as string,
                      messageId: streamInfo.messageId,
                      delta: "",
                      tokens: 0,
                      timestamp: nextPartTimestamp(streamInfo),
                      signature,
                    });
                    void this.schedulePartialWrite(workspaceId, streamInfo);
                  }
                  break;
                }

                // Append each delta as a new part (merging happens at display time)
                // Include providerOptions for SDK compatibility when converting to ModelMessages
                const newPart = {
                  type: "reasoning" as const,
                  text: delta,
                  timestamp: nextPartTimestamp(streamInfo),
                  signature, // May be undefined, will be filled by subsequent signature delta
                  providerOptions: signature ? { anthropic: { signature } } : undefined,
                };
                await this.appendPartAndEmit(workspaceId, streamInfo, newPart, true);
                break;
              }

              case "reasoning-end": {
                // Reasoning-end is just a signal - no state to update
                this.emit("reasoning-end", {
                  type: "reasoning-end",
                  workspaceId: workspaceId as string,
                  messageId: streamInfo.messageId,
                });
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }

              case "tool-call": {
                // Tool call started - store in map for later lookup
                toolCalls.set(part.toolCallId, {
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.input,
                });

                // Note: Tool availability is handled by the SDK, which emits tool-error events
                // for unavailable tools. No need to check here.

                // IMPORTANT: Add tool part to streamInfo.parts immediately (not just on completion)
                // This ensures in-progress tool calls are saved to partial.json if stream is interrupted
                const toolPart = {
                  type: "dynamic-tool" as const,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  state: "input-available" as const,
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  input: part.input,
                  timestamp: nextPartTimestamp(streamInfo),
                };

                // Emit using shared logic (ensures replay consistency)
                const inputText = JSON.stringify(part.input);
                log.debug(
                  `[StreamManager] tool-call: toolName=${part.toolName}, input length=${inputText.length}`
                );
                await this.appendPartAndEmit(workspaceId, streamInfo, toolPart);

                // CRITICAL: Flush partial immediately for ask_user_question
                // This tool blocks waiting for user input, and if the app restarts during
                // that wait, the partial must be persisted so it can be restored.
                // Without this, the throttled write might not complete before app shutdown.
                if (part.toolName === "ask_user_question") {
                  await this.flushPartialWrite(workspaceId, streamInfo);
                }
                break;
              }

              case "tool-result": {
                const toolResultPart = part as {
                  toolCallId: string;
                  toolName: string;
                  output: unknown;
                  providerExecuted?: boolean;
                };

                // Strip encrypted content from web search results before storing
                const strippedOutput = stripInternalToolResultFields(
                  stripEncryptedContent(toolResultPart.output)
                );

                // Tool call completed successfully
                const toolCall = toolCalls.get(toolResultPart.toolCallId);
                if (toolCall) {
                  toolCall.output = strippedOutput;
                } else {
                  orphanToolResultCount += 1;
                  this.logOrphanToolResult(
                    workspaceLog,
                    streamInfo,
                    {
                      toolCallId: toolResultPart.toolCallId,
                      toolName: toolResultPart.toolName,
                    },
                    strippedOutput,
                    orphanToolResultCount,
                    toolCalls.size
                  );
                }

                // Use shared completion logic (await to ensure partial is flushed before event)
                await this.finishToolCall(
                  workspaceId,
                  streamInfo,
                  toolCalls,
                  toolResultPart.toolCallId,
                  toolResultPart.toolName,
                  strippedOutput,
                  toolResultPart.providerExecuted
                );
                break;
              }

              // Handle tool-error parts from the stream (AI SDK 5.0+)
              // These are emitted when tool execution fails (e.g., tool doesn't exist)
              case "tool-error": {
                const toolErrorPart = part as {
                  toolCallId: string;
                  toolName: string;
                  error: unknown;
                  providerExecuted?: boolean;
                };

                const logLevel = streamInfo.abortController.signal.aborted ? log.debug : log.error;
                logLevel(`Tool execution error for '${toolErrorPart.toolName}'`, {
                  toolCallId: toolErrorPart.toolCallId,
                  error: toolErrorPart.error,
                });

                // Format error output
                const errorOutput = {
                  success: false,
                  error:
                    typeof toolErrorPart.error === "string"
                      ? toolErrorPart.error
                      : toolErrorPart.error instanceof Error
                        ? toolErrorPart.error.message
                        : JSON.stringify(toolErrorPart.error),
                };

                // Use shared completion logic (await to ensure partial is flushed before event)
                await this.finishToolCall(
                  workspaceId,
                  streamInfo,
                  toolCalls,
                  toolErrorPart.toolCallId,
                  toolErrorPart.toolName,
                  errorOutput,
                  toolErrorPart.providerExecuted
                );
                break;
              }

              // Handle error parts from the stream (e.g., OpenAI context_length_exceeded)
              case "error": {
                // Capture the error and immediately throw to trigger error handling
                // Error parts are structured errors from the AI SDK
                const errorPart = part as { error: unknown };

                // Try to extract error message from various possible structures
                let errorMessage: string | undefined;

                if (errorPart.error instanceof Error) {
                  throw errorPart.error;
                } else if (typeof errorPart.error === "object" && errorPart.error !== null) {
                  const errorObj = errorPart.error as Record<string, unknown>;

                  // Check for nested error object with message (OpenAI format)
                  if (
                    errorObj.error &&
                    typeof errorObj.error === "object" &&
                    errorObj.error !== null
                  ) {
                    const nestedError = errorObj.error as Record<string, unknown>;
                    if (typeof nestedError.message === "string") {
                      errorMessage = nestedError.message;
                    }
                  }

                  // Fallback to direct message property
                  errorMessage ??=
                    typeof errorObj.message === "string" ? errorObj.message : undefined;

                  // Last resort: stringify the error
                  errorMessage ??= JSON.stringify(errorObj);

                  const error = new Error(errorMessage);
                  // Preserve original error as cause for debugging
                  Object.assign(error, { cause: errorObj });
                  throw error;
                } else {
                  throw new Error(String(errorPart.error));
                }
              }

              // Handle other event types as needed
              case "start":
              case "text-start":
                // These events can be logged or handled if needed
                break;

              case "finish": {
                const finishPart = part as {
                  finishReason?: unknown;
                  rawFinishReason?: unknown;
                };
                // Skip the `ai` package's synthesized-default finish part.
                //
                // `streamText`'s internal `runStep` initializes
                // `stepFinishReason = "other"` and `stepRawFinishReason = undefined`,
                // and unconditionally emits those values from its flush() at
                // end-of-stream — even when the underlying SSE stream closed
                // before any terminal event arrived. The OpenAI Responses,
                // Chat Completions, and Anthropic Messages adapters all
                // exhibit this in practice: a clean upstream EOF (no
                // `response.completed`, no `message_stop`, no
                // `finish_reason` delta) ends up as a synthesized
                // `(other, undefined)` finish here.
                //
                // The discriminator is narrow on purpose. Every real OpenAI
                // and Anthropic finish path that maps to `"other"` pairs it
                // with a defined raw reason (e.g. Anthropic's `"compaction"`).
                // The `(other, undefined)` shape is unreachable from the
                // adapters' own finish-reason mappers and is therefore a
                // reliable signal that the finish was synthesized.
                //
                // Treating it as a non-event lets the existing
                // `!receivedTerminalEvent` branch below fire
                // `handleTruncatedStreamCompletion`, which surfaces a
                // retryable `stream_truncated` error instead of silently
                // committing partial output as a normal assistant message.
                if (
                  finishPart.finishReason === "other" &&
                  finishPart.rawFinishReason === undefined
                ) {
                  // Observability for the unaudited-adapter risk: if a future
                  // provider adapter we haven't read source for legitimately
                  // emits `(other, undefined)` as a real terminal finish, the
                  // discriminator misfires and the user sees a spurious
                  // truncated-stream retry. Surface a log so that misfires
                  // are diagnosable instead of silent.
                  workspaceLog.warn(
                    "Treating synthesized-default (other, undefined) finish as truncated stream",
                    {
                      messageId: streamInfo.messageId,
                      model: streamInfo.model,
                    }
                  );
                  break;
                }
                streamInfo.receivedTerminalEvent = true;
                if (typeof finishPart.finishReason === "string") {
                  streamInfo.terminalFinishReason = finishPart.finishReason;
                }
                if (typeof finishPart.rawFinishReason === "string") {
                  streamInfo.terminalRawFinishReason = finishPart.rawFinishReason;
                }
                break;
              }

              case "finish-step": {
                // Emit usage-delta event with usage from this step
                const finishStepPart = part as {
                  type: "finish-step";
                  usage: AiSdkUsageLike;
                  providerMetadata?: Record<string, unknown>;
                };

                // Normalize AI SDK 7 nested usage into mux's persisted flat shape,
                // re-injecting Anthropic cache-write tokens into provider metadata.
                const stepUsage = normalizeUsage(finishStepPart.usage);
                const stepProviderMetadata = withCacheWriteMetadata(
                  finishStepPart.providerMetadata,
                  finishStepPart.usage
                );

                // Update cumulative totals for this stream
                streamInfo.cumulativeUsage = addUsage(streamInfo.cumulativeUsage, stepUsage);
                streamInfo.cumulativeProviderMetadata = accumulateProviderMetadata(
                  streamInfo.cumulativeProviderMetadata,
                  stepProviderMetadata
                );

                // Track last step's data for context window display
                streamInfo.lastStepUsage = stepUsage;
                streamInfo.lastStepProviderMetadata = stepProviderMetadata;

                const usageEvent = buildUsageDeltaEvent({
                  workspaceId: workspaceId as string,
                  messageId: streamInfo.messageId,
                  // Step-level (for context window display)
                  usage: stepUsage,
                  providerMetadata: stepProviderMetadata,
                  // Cumulative (for live cost display)
                  cumulativeUsage: streamInfo.cumulativeUsage,
                  cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
                  // Preserve gateway-billed zero-cost behavior throughout the stream.
                  costsIncluded: streamInfo.initialMetadata?.costsIncluded,
                });
                streamInfo.currentStepStartIndex = streamInfo.parts.length;
                this.emit("usage-delta", usageEvent);
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }

              case "text-end": {
                await this.checkSoftCancelStream(workspaceId, streamInfo);
                break;
              }
            }
          }

          // No need to save remaining text - text-delta handler already maintains parts array
          // (Removed duplicate push that was causing double text parts)

          // Flush final state to partial.json for crash resilience
          // This happens regardless of abort status to ensure the final state is persisted to disk
          // On abort: second flush after cancelStreamSafely, ensures all streamed content is saved
          // On normal completion: provides crash resilience before AIService writes to chat.jsonl
          await this.flushPartialWrite(workspaceId, streamInfo);

          // Check if stream completed successfully
          if (!streamInfo.abortController.signal.aborted) {
            // Terminal refusal check must precede both the empty-output recovery
            // path and normal stream-end finalization. A refusal is a deliberate
            // provider outcome, not a transport drop; with partial output, a
            // configured fallback must continue from the partial transcript rather
            // than replay the original turn and re-run tools.
            const refusalFinishReason = streamInfo.receivedTerminalEvent
              ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
                  isRefusalFinishReason
                ) ?? null)
              : null;
            if (refusalFinishReason !== null) {
              // A configured fallback chain may swap models in place of the
              // terminal failure. The swap happens before any error event is
              // emitted, so task settlement can never race a pending fallback.
              const fallback = await this.tryModelFallbackAfterRefusal(
                workspaceId,
                streamInfo,
                refusalFinishReason,
                { preserveParts: streamInfo.parts.length > 0 }
              );
              if (fallback.kind === "swapped") {
                continue;
              }

              await this.handleModelRefusalCompletion(
                workspaceId,
                streamInfo,
                refusalFinishReason,
                fallback.terminalNote
              );
              break;
            }

            if (streamInfo.parts.length === 0) {
              const retriedEmptyStream = await this.retryEmptyStreamBeforeFailure(
                workspaceId,
                streamInfo,
                emptyStreamRecoveryAttempts
              );
              if (retriedEmptyStream) {
                emptyStreamRecoveryAttempts += 1;
                continue;
              }

              await this.handleEmptyStreamCompletion(workspaceId, streamInfo);
              break;
            }

            if (!streamInfo.receivedTerminalEvent) {
              await this.handleTruncatedStreamCompletion(workspaceId, streamInfo);
              break;
            }

            // Get all metadata from stream result in one call
            // - totalUsage: sum of all steps (for cost calculation)
            // - contextUsage: last step only (for context window display)
            // - contextProviderMetadata: last step (for context window cache tokens)
            // Falls back to tracked values when step retries invalidate totalUsage
            // or streamResult metadata fails/times out.
            const streamMeta = await this.getStreamMetadata(streamInfo);
            const totalUsage = this.resolveTotalUsageForStreamEnd(
              streamInfo,
              streamMeta.totalUsage
            );
            await this.backfillReasoningTokensFromParts(streamInfo, totalUsage);
            const contextUsage = streamMeta.contextUsage ?? streamInfo.lastStepUsage;
            const contextProviderMetadata =
              streamMeta.contextProviderMetadata ?? streamInfo.lastStepProviderMetadata;
            const finishReason = streamInfo.terminalFinishReason ?? streamMeta.finishReason;
            const duration = streamMeta.duration;
            const ttftMs = this.resolveTtftMsForStreamEnd(streamInfo);
            // Aggregated provider metadata across all steps (for cost calculation with cache tokens)
            const providerMetadata = markProviderMetadataCostsIncluded(
              await this.getAggregatedProviderMetadata(streamInfo),
              streamInfo.initialMetadata?.costsIncluded
            );
            const canonicalModel = normalizeToCanonical(streamInfo.model);
            const routedThroughGateway =
              streamInfo.initialMetadata?.routedThroughGateway ??
              streamInfo.model.startsWith("mux-gateway:");
            const toolModelUsages =
              streamInfo.toolModelUsages.length > 0
                ? streamInfo.toolModelUsages.map(clonePersistedToolModelUsage)
                : undefined;

            // Emit stream end event with parts preserved in temporal order
            const streamEndEvent: StreamEndEvent = {
              type: "stream-end",
              workspaceId: workspaceId as string,
              messageId: streamInfo.messageId,
              ...(streamInfo.initialMetadata?.acpPromptId != null
                ? { acpPromptId: streamInfo.initialMetadata.acpPromptId }
                : {}),
              metadata: {
                ...streamInfo.initialMetadata, // AIService-provided metadata (systemMessageTokens, etc)
                model: canonicalModel,
                metadataModel: streamInfo.metadataModel,
                routedThroughGateway,
                ...(streamInfo.thinkingLevel && {
                  thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
                }),
                usage: totalUsage, // Total across all steps (for cost calculation)
                contextUsage, // Last step only (for context window display)
                providerMetadata, // Aggregated (for cost calculation)
                contextProviderMetadata, // Last step (for context window display)
                ...(toolModelUsages != null ? { toolModelUsages } : {}),
                ...(finishReason !== undefined && { finishReason }),
                duration,
                ...(ttftMs !== undefined && { ttftMs }),
              },
              parts: streamInfo.parts, // Parts array with temporal ordering (includes reasoning)
            };

            // Update history with final message BEFORE emitting stream-end
            // This prevents a race condition where compaction (triggered by stream-end)
            // clears history while updateHistory is still running, causing old messages
            // to be written back after compaction completes.
            if (streamInfo.parts && streamInfo.parts.length > 0) {
              const finalAssistantMessage: MuxMessage = {
                id: streamInfo.messageId,
                role: "assistant",
                metadata: {
                  ...streamEndEvent.metadata,
                  historySequence: streamInfo.historySequence,
                },
                parts: streamInfo.parts,
              };

              // CRITICAL: Delete partial.json before updating chat.jsonl
              // On successful completion, partial.json becomes stale and must be removed
              const deleteResult = await this.historyService.deletePartial(workspaceId as string);
              if (!deleteResult.success) {
                workspaceLog.warn("Failed to delete partial on stream end", {
                  error: deleteResult.error,
                });
              }

              // Update the placeholder message in chat.jsonl with final content
              const updateResult = await this.historyService.updateHistory(
                workspaceId as string,
                finalAssistantMessage
              );
              if (!updateResult.success) {
                workspaceLog.warn("Failed to update history on stream end", {
                  error: updateResult.error,
                });
              }

              // Update cumulative session usage (if service is available)
              // Wrapped in try-catch: usage recording is non-critical and shouldn't block stream completion
              await this.recordSessionUsage(
                workspaceId,
                streamInfo.model,
                totalUsage,
                providerMetadata,
                "Failed to record session usage (stream completion unaffected)",
                "warn",
                streamInfo
              );
            }

            // Mark as completed right before emitting stream-end.
            // This must happen AFTER async I/O (deletePartial, updateHistory) completes.
            // If we set COMPLETED earlier, isStreaming() returns false during cleanup,
            // allowing new messages (e.g., force-compaction) to bypass queuing and write
            // to history before stream-end fires - causing compaction to use wrong parts.
            streamInfo.state = StreamState.COMPLETED;

            // Emit stream-end AFTER history is updated to prevent race with compaction
            // Compaction handler listens to this event and clears history - if we emit
            // before updateHistory completes, compaction can clear the file and then
            // updateHistory writes stale data back.
            this.emit("stream-end", streamEndEvent);
          }
          break;
        } catch (error) {
          let handledError: unknown = error;
          let retried = false;
          try {
            retried = await this.retryStreamWithoutPreviousResponseId(
              workspaceId,
              streamInfo,
              error,
              didRetryPreviousResponseId
            );
          } catch (retryError) {
            handledError = retryError;
          }

          if (retried) {
            didRetryPreviousResponseId = true;
            continue;
          }

          await this.handleStreamFailure(workspaceId, streamInfo, handledError);
          break;
        }
      }
    } catch (error) {
      await this.handleStreamFailure(workspaceId, streamInfo, error);
    } finally {
      this.mcpServerManager?.releaseLease(workspaceId as string);

      // Guaranteed cleanup in all code paths
      // Clear any pending timers to prevent keeping process alive
      if (streamInfo.partialWriteTimer) {
        clearTimeout(streamInfo.partialWriteTimer);
        streamInfo.partialWriteTimer = undefined;
      }

      runLanguageModelCleanup(streamInfo.request?.model);

      streamInfo.unlinkAbortSignal?.();
      streamInfo.unlinkAbortSignal = undefined;

      // Clean up stream temp directory using runtime (fire-and-forget)
      // Don't block stream completion waiting for directory deletion
      // This is especially important for SSH where rm -rf can take 500ms-2s
      if (streamInfo.runtimeTempDir) {
        this.cleanupStreamTempDir(streamInfo.runtime, streamInfo.runtimeTempDir);
      }

      this.workspaceStreams.delete(workspaceId);
    }
  }

  /**
   * Persist error state and emit error events for failed streams.
   */
  private async handleStreamFailure(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): Promise<void> {
    streamInfo.state = StreamState.ERROR;

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);

    // Log the actual error for debugging
    workspaceLog.error("Stream processing error:", error);

    // Record lost previousResponseId so future requests can filter it out
    this.recordLostResponseIdIfApplicable(workspaceId, error, streamInfo, workspaceLog);

    const errorPayload = this.buildStreamErrorPayload(streamInfo, error);
    await this.persistStreamError(workspaceId, streamInfo, errorPayload);
  }

  private buildStreamErrorPayload(
    streamInfo: WorkspaceStreamInfo,
    error: unknown
  ): StreamErrorPayload & { errorType: StreamErrorType } {
    if (error instanceof EmptyStreamOutputError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "empty_output",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    if (error instanceof ModelRefusalError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "model_refusal",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    if (error instanceof StreamTruncatedError) {
      return {
        messageId: streamInfo.messageId,
        error: error.message,
        errorType: "stream_truncated",
        acpPromptId: streamInfo.initialMetadata?.acpPromptId,
      };
    }

    // Extract error message (errors thrown from 'error' parts already have the correct message)
    // Apply prefix stripping to remove noisy "undefined: " prefixes from provider errors
    let errorMessage: string = stripNoisyErrorPrefix(getErrorMessage(error));
    let actualError: unknown = error;

    // For categorization, use the cause if available (preserves the original error structure)
    if (error instanceof Error && error.cause) {
      actualError = error.cause;
    }

    let errorType = this.categorizeError(actualError);

    // Enhance previous-response and model-not-found error messages

    const previousResponseId = this.extractPreviousResponseIdFromError(actualError);
    if (previousResponseId) {
      errorMessage = "OpenAI lost the previous response state while streaming. Retry to continue.";
    }
    if (errorType === "model_not_found") {
      // Extract model name from model string (e.g., "anthropic:sonnet-1m" -> "sonnet-1m")
      const [, modelName] = streamInfo.model.split(":");
      errorMessage = `Model '${modelName || streamInfo.model}' does not exist or is not available. Please check your model selection.`;
    }

    // Normalize Anthropic overload errors (HTTP 529 / overloaded_error) into a stable,
    // user-friendly message. Keep errorType = server_error so the frontend's auto-retry
    // behavior remains unchanged.
    const canonicalModel = normalizeToCanonical(streamInfo.model);
    const isAnthropic = canonicalModel.startsWith("anthropic:");

    const hasErrorProperty = (data: unknown): data is { error: { type?: string } } => {
      return (
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "object" &&
        data.error !== null
      );
    };

    const isOverloadedApiCallError = (apiError: APICallError): boolean => {
      return (
        apiError.statusCode === 529 ||
        (hasErrorProperty(apiError.data) && apiError.data.error.type === "overloaded_error")
      );
    };

    const isAnthropicOverloaded =
      isAnthropic &&
      ((APICallError.isInstance(actualError) && isOverloadedApiCallError(actualError)) ||
        (RetryError.isInstance(actualError) &&
          actualError.lastError &&
          APICallError.isInstance(actualError.lastError) &&
          isOverloadedApiCallError(actualError.lastError)));

    if (isAnthropicOverloaded) {
      errorMessage = "Anthropic is temporarily overloaded (HTTP 529). Please try again later.";
      errorType = "server_error";
    }

    const muxGatewayUnauthorized =
      streamInfo.model.startsWith("mux-gateway:") &&
      ((APICallError.isInstance(actualError) && actualError.statusCode === 401) ||
        (RetryError.isInstance(actualError) &&
          actualError.lastError &&
          APICallError.isInstance(actualError.lastError) &&
          actualError.lastError.statusCode === 401));

    if (muxGatewayUnauthorized) {
      // Friendly normalization for expired mux-gateway sessions.
      errorMessage = MUX_GATEWAY_SESSION_EXPIRED_MESSAGE;
    }
    errorType = coerceStreamErrorTypeForMessage(errorType, errorMessage);

    return {
      messageId: streamInfo.messageId,
      error: errorMessage,
      errorType,
      acpPromptId: streamInfo.initialMetadata?.acpPromptId,
    };
  }

  /**
   * Write error metadata to partial.json and emit the corresponding error event.
   */
  private async persistStreamError(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    payload: StreamErrorPayload & { errorType: StreamErrorType }
  ): Promise<void> {
    const refusalFinishReason =
      payload.errorType === "model_refusal"
        ? ([streamInfo.terminalFinishReason, streamInfo.terminalRawFinishReason].find(
            isRefusalFinishReason
          ) ?? streamInfo.terminalFinishReason)
        : undefined;
    const terminalRefusalUsage = streamInfo.terminalRefusalUsage;
    const terminalRefusalProviderMetadata = streamInfo.terminalRefusalProviderMetadata;

    // Errored turns still billed every completed step. Capture the
    // live-tracked cumulative usage for the sidecar below and mirror it into
    // session-usage.json — the error path previously skipped both, ingesting
    // failed turns as $0. Refusal errors are excluded entirely: the refusal
    // paths already attributed the refusing attempt's tokens (terminal
    // refusals via terminalRefusalUsage, fallback hops — including the FINAL
    // hop on chain exhaustion — via recordRefusedAttemptUsage into
    // toolModelUsages + the ledger), so re-recording the cumulative counters
    // here would double-count the last refusing attempt.
    let cumulativeErrorUsage: LanguageModelV2Usage | undefined;
    let cumulativeErrorProviderMetadata: Record<string, unknown> | undefined;
    if (payload.errorType !== "model_refusal" && hasTokenUsage(streamInfo.cumulativeUsage)) {
      cumulativeErrorUsage = cloneUsage(streamInfo.cumulativeUsage);
      await this.backfillReasoningTokensFromParts(streamInfo, cumulativeErrorUsage);
      cumulativeErrorProviderMetadata = markProviderMetadataCostsIncluded(
        streamInfo.cumulativeProviderMetadata
          ? { ...streamInfo.cumulativeProviderMetadata }
          : undefined,
        streamInfo.initialMetadata?.costsIncluded
      );
      await this.recordSessionUsage(
        workspaceId,
        streamInfo.model,
        cumulativeErrorUsage,
        cumulativeErrorProviderMetadata,
        "Failed to record session usage for errored stream",
        "warn",
        streamInfo
      );
    }
    const errorUsage = terminalRefusalUsage ?? cumulativeErrorUsage;
    const errorProviderMetadata =
      terminalRefusalProviderMetadata ?? cumulativeErrorProviderMetadata;

    const errorPartialMessage = this.buildPartialAssistantMessage(streamInfo, {
      metadata: {
        error: payload.error,
        errorType: payload.errorType,
        ...(refusalFinishReason !== undefined ? { finishReason: refusalFinishReason } : {}),
        ...(errorProviderMetadata !== undefined ? { providerMetadata: errorProviderMetadata } : {}),
        // INVARIANT: usage / toolModelUsages are deliberately NOT stamped on
        // the error partial. Errored turns are sidecar-canonical: unlike
        // aborts, nothing commits the partial at error time (AIService
        // forwards "error" without commitPartial), so usage stamped here
        // would strand in partial.json until an unrelated send — or die
        // entirely when a retry overwrites the partial. The sidecar rows
        // below are ingested immediately by the error listener, and the
        // eventually committed row carries no usage, so exactly one source
        // ever reaches the events table.
      },
    });

    // Wait for any in-flight partial write to complete before writing error state.
    // This prevents race conditions where the error write and a throttled flush
    // write at the same time, causing inconsistent partial.json state.
    await this.awaitPendingPartialWrite(streamInfo);

    // Write error state to disk - await to ensure consistent state before any resume.
    await this.historyService.writePartial(workspaceId as string, errorPartialMessage);

    try {
      await this.recordDroppedPartialUsageInSidecar(
        workspaceId,
        streamInfo,
        errorUsage,
        errorProviderMetadata,
        "errored_stream"
      );
    } catch (error) {
      log.error("Failed to record errored-stream usage in headless sidecar", { error });
    }

    // Emit error event.
    this.emit("error", createErrorEvent(workspaceId as string, payload));
  }

  private getOpenAIPreviousResponseId(
    providerOptions?: Record<string, unknown>
  ): string | undefined {
    if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
      return undefined;
    }

    const openaiOptions = providerOptions.openai;
    if (!openaiOptions || typeof openaiOptions !== "object") {
      return undefined;
    }

    const previousResponseId = (openaiOptions as Record<string, unknown>).previousResponseId;
    return typeof previousResponseId === "string" ? previousResponseId : undefined;
  }

  private clearOpenAIPreviousResponseId(
    providerOptions?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!providerOptions || typeof providerOptions !== "object" || !("openai" in providerOptions)) {
      return providerOptions;
    }

    const openaiOptions = providerOptions.openai;
    if (!openaiOptions || typeof openaiOptions !== "object") {
      return providerOptions;
    }

    if (!("previousResponseId" in openaiOptions)) {
      return providerOptions;
    }

    const { previousResponseId: _prev, ...rest } = openaiOptions as Record<string, unknown>;
    return {
      ...providerOptions,
      openai: rest,
    };
  }

  private async resetStreamStateForRetry(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ): Promise<void> {
    const preserveParts = options?.preserveParts ?? false;
    const preserveUsage = options?.preserveUsage ?? false;

    if (streamInfo.partialWriteTimer) {
      clearTimeout(streamInfo.partialWriteTimer);
      streamInfo.partialWriteTimer = undefined;
    }

    await this.awaitPendingPartialWrite(streamInfo);
    streamInfo.partialWritePromise = undefined;

    if (!preserveParts) {
      streamInfo.parts = [];
    }
    if (!preserveParts) {
      streamInfo.reasoningBackfillStartIndex = undefined;
    }
    streamInfo.receivedTerminalEvent = false;
    streamInfo.terminalFinishReason = undefined;
    streamInfo.terminalRawFinishReason = undefined;
    streamInfo.lastPartialWriteTime = 0;

    if (!preserveUsage) {
      streamInfo.cumulativeUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      streamInfo.cumulativeProviderMetadata = undefined;
      streamInfo.terminalRefusalUsage = undefined;
      streamInfo.terminalRefusalProviderMetadata = undefined;
      streamInfo.lastStepUsage = undefined;
      streamInfo.lastStepProviderMetadata = undefined;
    }

    if (!preserveParts) {
      try {
        await this.historyService.deletePartial(workspaceId as string);
      } catch (deleteError) {
        const logger = options?.workspaceLog ?? this.getWorkspaceLogger(workspaceId, streamInfo);
        logger.warn("Failed to clear partial state before retry", { error: deleteError });
      }
    }
  }

  private async retryStreamWithoutPreviousResponseId(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    error: unknown,
    hasRetried: boolean
  ): Promise<boolean> {
    if (hasRetried) {
      return false;
    }

    if (streamInfo.abortController.signal.aborted || streamInfo.softInterrupt.pending) {
      return false;
    }

    const hasParts = streamInfo.parts.length > 0;
    const currentStepStartIndex = streamInfo.currentStepStartIndex;
    // If the current step already emitted parts, retrying would duplicate output/tool calls.
    if (hasParts && currentStepStartIndex !== streamInfo.parts.length) {
      return false;
    }

    const responseId = this.extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return false;
    }

    const errorCode = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);
    // Retry if: we have the specific error code, OR a likely status code,
    // OR we successfully extracted a response ID from the error message
    // (the message match is strong evidence this is a "not found" error regardless of status code)
    const shouldRetry =
      errorCode === "previous_response_not_found" ||
      statusCode === 404 ||
      statusCode === 500 ||
      statusCode === 400;
    if (!shouldRetry) {
      return false;
    }

    const previousResponseId = this.getOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    if (!previousResponseId || previousResponseId !== responseId) {
      return false;
    }

    const stepMessages = streamInfo.stepTracker.latestMessages;
    if (hasParts && !stepMessages) {
      return false;
    }

    const providerOptions = this.clearOpenAIPreviousResponseId(streamInfo.request.providerOptions);
    if (providerOptions === streamInfo.request.providerOptions) {
      return false;
    }

    const workspaceLog = this.getWorkspaceLogger(workspaceId, streamInfo);
    this.recordLostResponseIdIfApplicable(workspaceId, error, streamInfo, workspaceLog);

    // Step-boundary retries restart the SDK stream, so totalUsage only reflects
    // the retried step. Track this to prefer cumulativeUsage at stream end.
    if (hasParts) {
      streamInfo.didRetryPreviousResponseIdAtStep = true;
    }

    workspaceLog.info("Retrying stream without invalid previousResponseId", {
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      retryScope: hasParts ? "step" : "stream",
      previousResponseId,
      errorCode,
      statusCode,
    });

    await this.resetStreamStateForRetry(workspaceId, streamInfo, {
      preserveParts: hasParts,
      preserveUsage: hasParts,
      workspaceLog,
    });

    streamInfo.currentStepStartIndex = streamInfo.parts.length;
    streamInfo.request = {
      ...streamInfo.request,
      ...(stepMessages ? { messages: stepMessages } : {}),
      providerOptions,
    };
    streamInfo.streamResult = this.createStreamResult(
      streamInfo.request,
      streamInfo.abortController,
      streamInfo.stepTracker
    );

    return true;
  }

  /**
   * Converts errors to strongly-typed SendMessageError
   */
  private convertToSendMessageError(error: unknown): SendMessageError {
    // Check for specific AI SDK errors using type guards
    if (LoadAPIKeyError.isInstance(error)) {
      return {
        type: "api_key_not_found",
        provider: "anthropic", // We can infer this from LoadAPIKeyError context
      };
    }

    // TODO: Add more specific error types as needed
    // if (APICallError.isInstance(error)) {
    //   if (error.statusCode === 401) return { type: "authentication", ... };
    //   if (error.statusCode === 429) return { type: "rate_limit", ... };
    // }
    // if (RetryError.isInstance(error)) {
    //   return { type: "retry_failed", ... };
    // }

    // Fallback for unknown errors
    const message = getErrorMessage(error);
    return { type: "unknown", raw: message };
  }

  /**
   * Categorizes errors for better error handling (used for event emission)
   */
  private categorizeError(error: unknown): StreamErrorType {
    if (error instanceof StreamTruncatedError) {
      return "stream_truncated";
    }

    // Use AI SDK error type guards first
    if (LoadAPIKeyError.isInstance(error)) {
      return "authentication";
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401) return "authentication";
      // 402 (Payment Required) is used by mux gateway for billing/credits issues
      // (e.g. "Insufficient balance. Please add credits to continue.").
      // Treat as non-retryable quota. Some providers also encode quota failures as
      // 429, so classify 429 by payload intent instead of status code alone.
      if (error.statusCode === 402) return "quota";
      if (error.statusCode === 429) {
        return classify429Capacity({
          message: error.message,
          data: error.data,
          responseBody: error.responseBody,
        });
      }
      if (error.statusCode && error.statusCode >= 500) return "server_error";

      // Check for model_not_found errors (OpenAI and Anthropic)
      // Type guard for error data structure
      const hasErrorProperty = (
        data: unknown
      ): data is { error: { code?: string; type?: string } } => {
        return (
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "object" &&
          data.error !== null
        );
      };

      // OpenAI: 400 with error.code === 'model_not_found'
      const isOpenAIModelError =
        error.statusCode === 400 &&
        hasErrorProperty(error.data) &&
        error.data.error.code === "model_not_found";

      // Anthropic: 404 with error.type === 'not_found_error'
      const isAnthropicModelError =
        error.statusCode === 404 &&
        hasErrorProperty(error.data) &&
        error.data.error.type === "not_found_error";

      if (isOpenAIModelError || isAnthropicModelError) {
        return "model_not_found";
      }

      // Check for context exceeded errors (Anthropic + OpenAI-compatible / Copilot)
      const msgLower = error.message.toLowerCase();

      // Anthropic: "prompt is too long" / "input is too long"
      // Copilot / OpenAI-compatible: "prompt token count of X exceeds the limit of Y"
      const isContextExceeded =
        msgLower.includes("prompt is too long") ||
        msgLower.includes("input is too long") ||
        (msgLower.includes("token") && msgLower.includes("exceeds") && msgLower.includes("limit"));

      if (isContextExceeded) {
        return "context_exceeded";
      }

      return "api";
    }
    if (RetryError.isInstance(error)) {
      // The AI SDK wraps the underlying error(s) in RetryError when it exhausts its internal retries.
      // If the underlying error is deterministically non-retryable (e.g. model_not_found), we should
      // surface that classification so the frontend auto-retry loop stops.
      //
      // Keep returning retry_failed for generic/transient failures so the UI still communicates that
      // the SDK already retried and gave up.
      const underlyingType = error.lastError ? this.categorizeError(error.lastError) : "unknown";
      if (
        underlyingType !== "unknown" &&
        underlyingType !== "api" &&
        underlyingType !== "retry_failed"
      ) {
        return underlyingType;
      }
      return "retry_failed";
    }

    // Check for OpenAI/Anthropic structured error format (from error.cause)
    // Structure: { error: { code: 'context_length_exceeded', type: '...', message: '...' } }
    if (
      typeof error === "object" &&
      error !== null &&
      "error" in error &&
      typeof error.error === "object" &&
      error.error !== null
    ) {
      const structuredError = error.error as { code?: string; type?: string };

      // Model not found
      if (
        structuredError.code === "model_not_found" ||
        structuredError.type === "not_found_error"
      ) {
        return "model_not_found";
      }

      // OpenAI context length errors have code: 'context_length_exceeded'
      if (structuredError.code === "context_length_exceeded") {
        return "context_exceeded";
      }

      // Check for other specific error codes/types
      if (structuredError.code === "rate_limit_exceeded") {
        return "rate_limit";
      }
    }

    // Fall back to string matching for other errors
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      if (isStreamTruncatedMessage(message)) {
        return "stream_truncated";
      }

      if (error.name === "AbortError" || message.includes("abort")) {
        return "aborted";
      } else if (message.includes("network") || message.includes("fetch")) {
        return "network";
      } else if (
        message.includes("model") &&
        (message.includes("does not exist") ||
          message.includes("doesn't exist") ||
          message.includes("not found") ||
          message.includes("do not have access") ||
          message.includes("don't have access") ||
          message.includes("no access"))
      ) {
        return "model_not_found";
      } else if (
        message.includes("token") ||
        message.includes("context") ||
        message.includes("too long") ||
        message.includes("maximum")
      ) {
        return "context_exceeded";
      } else if (
        message.includes("quota") ||
        message.includes("limit") ||
        message.includes("insufficient balance") ||
        message.includes("add credits") ||
        message.includes("payment required")
      ) {
        return "quota";
      } else if (message.includes("auth") || message.includes("key")) {
        return "authentication";
      } else {
        return "api";
      }
    }

    return "unknown";
  }

  /**
   * Starts a new stream for a workspace, automatically cancelling any existing stream
   *
   * Uses per-workspace mutex to prevent concurrent streams. The mutex ensures:
   * 1. Only one startStream can execute at a time per workspace
   * 2. Old stream fully exits before new stream starts
   * 3. No race conditions in stream registration or cleanup
   */
  async startStream(
    workspaceId: string,
    messages: ModelMessage[],
    model: LanguageModel,
    modelString: string,
    historySequence: number,
    system: string,
    runtime: Runtime,
    messageId: string,
    abortSignal?: AbortSignal,
    tools?: Record<string, Tool>,
    initialMetadata?: Partial<MuxMetadata>,
    providerOptions?: Record<string, unknown>,
    maxOutputTokens?: number,
    toolPolicy?: ToolPolicy,
    providedStreamToken?: StreamToken,
    hasQueuedMessages?: (dispatchMode?: "tool-end" | "turn-end") => boolean,
    workspaceName?: string,
    thinkingLevel?: string,
    headers?: Record<string, string | undefined>,
    anthropicCacheTtlOverride?: AnthropicCacheTtl,
    callSettingsOverrides?: ResolvedCallSettingsOverrides,
    onChunk?: StreamTextOnChunk,
    onStepMessages?: (messages: ModelMessage[]) => void,
    providedRuntimeTempDir?: string,
    modelFallback?: ModelFallbackOptions,
    toolSearchState?: ToolSearchStreamState,
    thinkingOverrideState?: ActiveTurnThinkingOverride,
    rebuildProviderOptionsForThinkingLevel?: RebuildProviderOptionsForThinkingLevel
  ): Promise<Result<StreamToken, SendMessageError>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;

    if (messages.length === 0) {
      return Err({
        type: "unknown",
        raw: "Invalid prompt: messages must not be empty",
      });
    }

    // Get or create mutex for this workspace
    if (!this.streamLocks.has(typedWorkspaceId)) {
      this.streamLocks.set(typedWorkspaceId, new AsyncMutex());
    }
    const mutex = this.streamLocks.get(typedWorkspaceId)!;

    try {
      // Acquire lock - guarantees only one startStream per workspace
      // Lock is automatically released when scope exits via Symbol.asyncDispose
      await using _lock = await mutex.acquire();

      // DEBUG: Log stream start
      log.debug(
        `[STREAM START] workspaceId=${workspaceId} historySequence=${historySequence} model=${modelString}`
      );

      const streamAbortController = new AbortController();
      const unlinkAbortSignal = linkAbortSignal(abortSignal, streamAbortController);

      let runtimeTempDir: string | undefined;
      let streamRegistered = false;

      try {
        // Step 1: Cancel any existing stream before proceeding
        // This must happen regardless of whether a token was provided
        const generatedStreamToken = await this.ensureStreamSafety(typedWorkspaceId);

        // Step 2: Use provided stream token or the generated one
        const streamToken = providedStreamToken ?? generatedStreamToken;

        // If the stream was interrupted while we were waiting on async setup (mutex,
        // temp dir creation, etc), avoid starting the stream entirely.
        if (streamAbortController.signal.aborted) {
          return Ok(streamToken);
        }

        // Step 3: Create temp directory for this stream using runtime.
        // AIService pre-creates this dir so tool configuration can reference the same stable path;
        // once startStream receives it, StreamManager owns cleanup for both success and abort paths.
        runtimeTempDir =
          providedRuntimeTempDir ?? (await this.createTempDirForStream(streamToken, runtime));

        if (streamAbortController.signal.aborted) {
          return Ok(streamToken);
        }

        // Step 4: Atomic stream creation and registration
        const streamInfo = this.createStreamAtomically(
          typedWorkspaceId,
          streamToken,
          runtimeTempDir,
          runtime,
          messages,
          model,
          modelString,
          streamAbortController,
          system,
          historySequence,
          messageId,
          tools,
          initialMetadata,
          providerOptions,
          maxOutputTokens,
          toolPolicy,
          callSettingsOverrides,
          hasQueuedMessages,
          workspaceName,
          thinkingLevel,
          headers,
          anthropicCacheTtlOverride,
          onChunk,
          onStepMessages,
          modelFallback,
          toolSearchState,
          thinkingOverrideState,
          rebuildProviderOptionsForThinkingLevel
        );

        // Guard against a narrow race:
        // - stopStream() may abort while we're between the last aborted-check and stream registration.
        // - If we start processStreamWithCleanup anyway, it would emit stream-start, but no one would
        //   subsequently call stopStream() again (it already ran), so we'd never emit stream-abort/end.
        // In that case, immediately drop the registered stream and rely on the caller to handle UI.
        if (streamAbortController.signal.aborted) {
          this.workspaceStreams.delete(typedWorkspaceId);
          return Ok(streamToken);
        }

        streamInfo.unlinkAbortSignal = unlinkAbortSignal;
        streamRegistered = true;

        // Step 5: Track the processing promise for guaranteed cleanup
        // This allows cancelStreamSafely to wait for full exit
        streamInfo.processingPromise = this.processStreamWithCleanup(
          typedWorkspaceId,
          streamInfo,
          historySequence
        ).catch((error) => {
          log.error("Unexpected error in stream processing:", error);
        });

        return Ok(streamToken);
      } finally {
        if (!streamRegistered) {
          runLanguageModelCleanup(model);
          unlinkAbortSignal();
          if (runtimeTempDir) {
            this.cleanupStreamTempDir(runtime, runtimeTempDir);
          }
        }
      }
    } catch (error) {
      // Guaranteed cleanup on any failure
      this.workspaceStreams.delete(typedWorkspaceId);
      // Convert to strongly-typed error
      return Err(this.convertToSendMessageError(error));
    }
  }

  /**
   * Record a previousResponseId as lost if the error indicates OpenAI no longer has it.
   * StreamManager retries once automatically, and buildProviderOptions filters it for future requests.
   */
  private recordLostResponseIdIfApplicable(
    workspaceId: WorkspaceId,
    error: unknown,
    streamInfo: WorkspaceStreamInfo,
    workspaceLog?: Logger
  ): void {
    const responseId = this.extractPreviousResponseIdFromError(error);
    if (!responseId) {
      return;
    }

    const errorCode = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);
    // Record if: we have the specific error code, OR a likely status code.
    // mux-gateway currently surfaces OpenAI's "previous_response_not_found" as a 400
    // (and omits the structured error code), so we treat 400 as eligible once the
    // responseId regex matched the error payload/message.
    const shouldRecord =
      errorCode === "previous_response_not_found" ||
      statusCode === 404 ||
      statusCode === 500 ||
      statusCode === 400;

    if (!shouldRecord || this.lostResponseIds.has(responseId)) {
      return;
    }

    const logger = workspaceLog ?? this.getWorkspaceLogger(workspaceId, streamInfo);
    logger.info("Recording lost previousResponseId for future filtering", {
      previousResponseId: responseId,
      messageId: streamInfo.messageId,
      model: streamInfo.model,
      statusCode,
      errorCode,
    });

    this.lostResponseIds.add(responseId);
  }

  /**
   * Extract previousResponseId from error response body
   * OpenAI's error message includes the ID: "Previous response with id 'resp_...' not found."
   */
  private extractPreviousResponseIdFromError(error: unknown): string | undefined {
    // Check APICallError.responseBody first
    if (APICallError.isInstance(error) && typeof error.responseBody === "string") {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.responseBody);
      if (match) {
        return match[1];
      }
    }

    // Check error message
    if (error instanceof Error) {
      const match = /'(resp_[a-f0-9]+)'/.exec(error.message);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.lostResponseIds.has(responseId);
  }

  private extractErrorCode(error: unknown): string | undefined {
    const candidates: unknown[] = [];
    if (error instanceof Error && error.cause) {
      candidates.push(error.cause);
    }
    if (APICallError.isInstance(error)) {
      candidates.push(error.data);
    }
    candidates.push(error);
    for (const candidate of candidates) {
      const directCode = this.getStructuredErrorCode(candidate);
      if (directCode) {
        return directCode;
      }
      if (candidate && typeof candidate === "object" && "data" in candidate) {
        const dataCandidate = (candidate as { data?: unknown }).data;
        const nestedCode = this.getStructuredErrorCode(dataCandidate);
        if (nestedCode) {
          return nestedCode;
        }
      }
    }
    return undefined;
  }

  private extractStatusCode(error: unknown): number | undefined {
    if (error instanceof Error && error.cause) {
      const statusCode = this.extractStatusCode(error.cause);
      if (typeof statusCode === "number") {
        return statusCode;
      }
    }

    if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
      return error.statusCode;
    }

    if (typeof error === "object" && error !== null && "statusCode" in error) {
      const candidate = (error as { statusCode?: unknown }).statusCode;
      if (typeof candidate === "number") {
        return candidate;
      }
    }

    return undefined;
  }

  private getStructuredErrorCode(candidate: unknown): string | undefined {
    if (typeof candidate === "object" && candidate !== null && "error" in candidate) {
      const withError = candidate as { error?: unknown };
      if (withError.error && typeof withError.error === "object") {
        const nested = withError.error as Record<string, unknown>;
        const code = nested.code;
        if (typeof code === "string") {
          return code;
        }
      }
    }
    return undefined;
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; abortReason?: StreamAbortReason }
  ): Promise<Result<void>> {
    const typedWorkspaceId = workspaceId as WorkspaceId;

    try {
      const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
      if (!streamInfo) {
        const abortReason = options?.abortReason ?? "startup";
        // Emit abort event so frontend clears pending stream state.
        // This handles the case where user interrupts before stream-start arrives.
        // Use empty messageId - frontend handles gracefully (just clears pendingStreamStartTime).
        this.emitStreamAbort(typedWorkspaceId, "", {}, abortReason, options?.abandonPartial);
        return Ok(undefined);
      }

      const abortReason = options?.abortReason ?? "system";
      const soft = options?.soft ?? false;

      if (soft) {
        // Soft interrupt: set flag, will cancel at next block boundary
        streamInfo.softInterrupt = {
          pending: true,
          abandonPartial: options?.abandonPartial ?? false,
          abortReason,
        };
      } else {
        // Hard interrupt: cancel immediately
        await this.cancelStreamSafely(
          typedWorkspaceId,
          streamInfo,
          abortReason,
          options?.abandonPartial
        );
      }
      return Ok(undefined);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to stop stream: ${message}`);
    }
  }

  /**
   * Gets the current stream state for a workspace
   */
  getStreamState(workspaceId: string): StreamState {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);
    return streamInfo?.state ?? StreamState.IDLE;
  }

  /**
   * Checks if a workspace currently has an active stream
   */
  isStreaming(workspaceId: string): boolean {
    const state = this.getStreamState(workspaceId);
    return state === StreamState.STARTING || state === StreamState.STREAMING;
  }

  /**
   * Gets all active workspace streams (for debugging/monitoring)
   */
  getActiveStreams(): string[] {
    return Array.from(this.workspaceStreams.keys()).map((id) => id as string);
  }

  /**
   * Gets the current stream info for a workspace if actively streaming
   * Returns undefined if no active stream exists
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(workspaceId: string):
    | {
        messageId: string;
        model: string;
        historySequence: number;
        startTime: number;
        parts: CompletedMessagePart[];
        toolCompletionTimestamps: Map<string, number>;
      }
    | undefined {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only return info if stream is actively running
    if (
      streamInfo &&
      (streamInfo.state === StreamState.STARTING || streamInfo.state === StreamState.STREAMING)
    ) {
      return {
        messageId: streamInfo.messageId,
        model: streamInfo.model,
        historySequence: streamInfo.historySequence,
        startTime: streamInfo.startTime,
        toolCompletionTimestamps: streamInfo.toolCompletionTimestamps ?? new Map(),
        parts: streamInfo.parts,
      };
    }

    return undefined;
  }

  /**
   * Replay stream events
   * Emits the same events (stream-start, stream-delta, etc.) that would be emitted during live streaming
   * This allows replay to flow through the same event path as live streaming (no duplication)
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only replay if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return;
    }

    // Initialize token tracker for this model (required for tokenization)
    await this.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

    // Emit stream-start event (include mode from initialMetadata if available)
    this.emitStreamStart(typedWorkspaceId, streamInfo, streamInfo.historySequence, {
      replay: true,
    });

    // Replay accumulated parts as events using shared emission logic.
    // IMPORTANT: Snapshot the parts array up-front.
    //
    // streamInfo.parts is mutated while the stream is running. Because emitPartAsEvent() is async
    // (tokenization happens in worker threads), iterating the live array would keep consuming newly
    // appended parts and can effectively block until the stream ends.
    //
    // That blocks AgentSession.emitHistoricalEvents() from sending "caught-up" on reconnect,
    // leaving the renderer stuck in "Loading workspace" and suppressing the streaming indicator.
    const replayParts = streamInfo.parts.slice();
    const afterTimestamp = opts?.afterTimestamp;
    const filteredReplayParts =
      afterTimestamp != null
        ? replayParts.filter((part) => {
            const partTimestamp = part.timestamp;

            // Missing timestamps should be replayed defensively rather than dropped.
            if (partTimestamp === undefined) {
              return true;
            }

            if (partTimestamp > afterTimestamp) {
              return true;
            }

            // Dynamic tool parts keep their original start timestamp even when they later
            // transition to output-available. Use the recorded tool completion timestamp
            // (from tool-call-end emission) to decide whether completion happened after
            // the reconnect cursor.
            if (part.type === "dynamic-tool") {
              const workflowRunAttachedAt = part.workflowRun?.timestamp;
              if (workflowRunAttachedAt !== undefined && workflowRunAttachedAt > afterTimestamp) {
                return true;
              }

              if (part.state === "output-available") {
                const completionTimestamp = streamInfo.toolCompletionTimestamps.get(
                  part.toolCallId
                );
                if (completionTimestamp === undefined) {
                  log.warn(
                    "[streamManager] Missing tool completion timestamp during replay; dropping replayed completion to avoid duplicate side effects",
                    {
                      workspaceId,
                      messageId: streamInfo.messageId,
                      toolCallId: part.toolCallId,
                    }
                  );
                  return false;
                }

                return completionTimestamp > afterTimestamp;
              }

              // A queued tool's execute() can begin after the reconnect cursor while the
              // part's own timestamp (model emission) is older. Replay the part so the
              // enriched tool-call-start carries executionStartedAt and the renderer can
              // start the elapsed timer (the aggregator merges it into the existing row).
              if (
                part.executionStartedAt !== undefined &&
                part.executionStartedAt > afterTimestamp
              ) {
                return true;
              }
            }

            return false;
          })
        : replayParts;

    const replayMessageId = streamInfo.messageId;
    for (const part of filteredReplayParts) {
      await this.emitPartAsEvent(typedWorkspaceId, replayMessageId, part, { replay: true });
    }

    // Live streams emit usage-delta after each finish-step. Replay part snapshots do not
    // include finish-step boundaries, so full replays emit the latest accumulated usage
    // explicitly. Incremental/live-mode replays pass afterTimestamp and should only replay
    // stream context (not stale usage snapshots) to avoid duplicate usage updates.
    if (streamInfo.lastStepUsage && afterTimestamp == null) {
      const usageEvent = buildUsageDeltaEvent({
        workspaceId,
        messageId: streamInfo.messageId,
        replay: true,
        usage: streamInfo.lastStepUsage,
        providerMetadata: streamInfo.lastStepProviderMetadata,
        cumulativeUsage: streamInfo.cumulativeUsage,
        cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
        // Replays must preserve gateway-billed zero-cost behavior from the original stream.
        costsIncluded: streamInfo.initialMetadata?.costsIncluded,
      });
      this.emit("usage-delta", usageEvent);
    }
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing
   * This method allows integration tests to simulate stream errors without
   * mocking the AI SDK or network layer. It triggers the same error handling
   * path as genuine stream errors by aborting the stream and manually triggering
   * the error event (since abort alone doesn't throw, it just sets a flag that
   * causes the for-await loop to break cleanly).
   */
  async debugTriggerStreamError(workspaceId: string, errorMessage: string): Promise<boolean> {
    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only trigger error if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return false;
    }

    // Abort the stream first (causes for-await loop to break cleanly)
    streamInfo.abortController.abort(new Error(errorMessage));

    // Mark as error state (same as catch block does)
    streamInfo.state = StreamState.ERROR;

    // Update streamInfo metadata with error (so subsequent flushes preserve it)
    streamInfo.initialMetadata = {
      ...streamInfo.initialMetadata,
      error: errorMessage,
      errorType: "network",
    };

    // Write error state to partial.json (same as real error handling)
    await this.persistStreamError(typedWorkspaceId, streamInfo, {
      messageId: streamInfo.messageId,
      error: errorMessage,
      errorType: "network",
    });

    // Wait for the stream processing to complete (cleanup)
    await streamInfo.processingPromise;

    return true;
  }
}
