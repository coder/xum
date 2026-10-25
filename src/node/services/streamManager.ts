import { estimateToolResultSize } from "@/common/utils/compaction/contextBudget";
import { ContextBudgetBlockedError } from "./contextBudgetError";
import {
  createContextBudgetAnchor,
  estimateAnchoredRequestTokensForModel,
  estimateToolResultTokensForModel,
} from "./contextBudgetCounting";
import { getAnthropicCacheTtl } from "@/common/utils/ai/cacheStrategy";
import { type ContinuousPrefixSwap } from "./continuousCompactionJournal";
import type { Scope } from "effect";
import { type streamText, type stepCountIs } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { Result } from "@/common/types/result";
import assert from "@/common/utils/assert";
import { log, type Logger } from "./log";
import type {
  StreamAbortEvent,
  StreamAbortReason,
  ToolCallEndEvent,
  ToolCallExecutionStartEvent,
  CompletedMessagePart,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";

import type { SendMessageError, StreamErrorType } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage, PersistedToolModelUsage } from "@/common/types/message";
import { hasTokenUsage } from "@/common/types/message";
import {
  laterAnthropicThinkingReplayPoint,
  type AnthropicThinkingReplayPoint,
} from "@/node/utils/messages/anthropicThinkingReplay";
import { ThinkingLevelSchema, type ThinkingLevel } from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { createErrorEvent, type StreamErrorPayload } from "@/node/services/utils/sendMessageError";
import { hasCommitWorthyParts, type HistoryService } from "./historyService";
import {
  accumulateStepsProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
} from "@/common/utils/tokens/usageHelpers";
import { modelOnlyNotificationsField } from "@/common/utils/tools/internalToolResultFields";
import { buildRequiredToolPatterns } from "@/common/utils/tools/toolPolicy";
import { isAgentToolsDisabled } from "@/node/utils/agentToolsDisabled";
import {
  collectDeferLoadingToolNames,
  computeContextLoadedToolNames,
  dedupeNativeToolReferences,
  computeLoadedToolNames,
} from "@/common/utils/tools/toolCatalog";
import { StreamingTokenTracker } from "@/node/utils/main/StreamingTokenTracker";
import { countTokens } from "@/node/utils/main/tokenizer";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { ToolCallDisplayRegistry, type ExecutionScope } from "./toolCallDisplayRegistry";
import type { Runtime } from "@/node/runtime/Runtime";
import type { SessionUsageService } from "./sessionUsageService";
import { resolveModelForMetadata } from "@/common/utils/providers/modelEntries";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import { hostClockFor } from "./di/hostClockLive";
import {
  clonePersistedToolModelUsage,
  cloneUsage,
  markProviderMetadataCostsIncluded,
  UsageLedger,
} from "@/node/services/turnEngine/UsageLedger";
import { PartialJournal, type PartialTarget } from "@/node/services/turnEngine/PartialJournal";
import {
  ProviderRequest,
  type StreamRequestConfig,
} from "@/node/services/turnEngine/ProviderRequest";
import {
  isAnthropicMessagesModel,
  StepPreparation,
  transformStepMessages,
  type StepMessageTracker,
} from "@/node/services/turnEngine/StepPreparation";
import {
  buildUsageDeltaEvent,
  metadataModelIdentity,
  TurnEventEmitter,
  TurnEvents,
  type NestedToolEvent,
} from "@/node/services/turnEngine/TurnEvents";
import { nodeClock, type HostClock } from "@/node/utils/hostClock";
import type {
  WorkspaceId,
  TurnEngineEventSink,
  TurnStreamHandle,
  SettledStepOutcome,
  OnStepSettled,
  WorkspaceStreamInfo,
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
export type {
  StreamTextOnChunk,
  WorkspaceId,
  TurnEngineEvent,
  TurnEngineEventSink,
  TurnCompletion,
  TurnStreamHandle,
  SettledStepBudget,
  ContextBudgetStepDecision,
  SettledStepOutcome,
  OnStepSettled,
  ModelFallbackPrepareOptions,
  ModelFallbackOptions,
  WorkspaceStreamInfo,
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
import {
  StreamState,
  TurnRegistry,
  type PendingStreamStartHandle,
  type StreamToken,
} from "@/node/services/turnEngine/TurnRegistry";
import {
  AttemptLoop,
  type PartLoopState,
  type ToolCallMap,
} from "@/node/services/turnEngine/AttemptLoop";
import { RefusalFallback } from "@/node/services/turnEngine/RefusalFallback";
import { recordStepStart, StreamRetries } from "@/node/services/turnEngine/StreamRetries";
import { TurnResources } from "@/node/services/turnEngine/TurnResources";
import { TurnEngine, type TurnExecutionOptions } from "@/node/services/turnEngine/TurnEngine";
export {
  createTurnCompletionController,
  type TurnExecutionOptions,
} from "@/node/services/turnEngine/TurnEngine";
import { isRefusalFinishReason } from "@/common/utils/messages/refusalFinishReason";
import type { FoldIntent, FoldStep, FoldView } from "@/node/services/turnEngine/partFold";

// Disable noisy AI SDK warning logging.
globalThis.AI_SDK_LOG_WARNINGS = false;

function recordTerminalFinish(
  streamInfo: WorkspaceStreamInfo,
  intent: Extract<FoldIntent, { _tag: "RecordTerminalFinish" }>
): void {
  streamInfo.receivedTerminalEvent = true;
  if (intent.finishReason !== undefined) {
    streamInfo.terminalFinishReason = intent.finishReason;
  }
  if (intent.rawFinishReason !== undefined) {
    streamInfo.terminalRawFinishReason = intent.rawFinishReason;
  }
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

// Ensure per-stream part timestamps are strictly monotonic.
//
// Date.now() is millisecond-granularity, so two distinct chunks with identical text emitted in the
// same millisecond can otherwise collide on (timestamp, delta) during reconnect replay buffering.
//
// Part timestamps are record times (stored in history, shown and replayed), so they read the
// wall clock until #7282 moves their consumers to HostClock.
function nextPartTimestamp(streamInfo: WorkspaceStreamInfo): number {
  const now = nodeClock.nowMs();
  const last = streamInfo.lastPartTimestamp;
  const timestamp = now <= last ? last + 1 : now;
  streamInfo.lastPartTimestamp = timestamp;
  return timestamp;
}

/**
 * Optional collaborators for StreamManager. Production omits both; tests
 * inject a fake stream factory (so the real request/prepareStep wiring still
 * runs) and a no-op token tracker (so no tokenizer worker loads).
 */
export interface StreamManagerOptions {
  streamText?: typeof streamText;
  tokenTracker?: StreamManagerTokenTracker;
  /** StreamManagerLive passes the HostClock service. Default: the clock of `runner`. */
  hostClock?: HostClock;
}

/** The request fields the stop conditions read, and the stop cause they record. */
type StopWhenRequest = Pick<
  StreamRequestConfig,
  | "hasQueuedMessages"
  | "getQueuedInputStopCause"
  | "stopCause"
  | "toolPolicy"
  | "onStepSettled"
  | "modelString"
  | "tools"
  | "budgetMetadataModel"
  | "contextBudgetLimit"
  | "system"
  | "messages"
  | "toolSearchState"
>;

type StopConditionOptions = Parameters<ReturnType<typeof stepCountIs>>[0];
type StopConditionStep = StopConditionOptions["steps"][number];

// Completion-tool stop check: completion/routing tools use explicit
// success/ok markers (agent_report, propose_plan).
// When a marker is present, respect it — success:false means the tool
// should be retried, so don't stop. When no marker is present (e.g.,
// MCP tools, arbitrary required tools), treat non-null object results
// as successful completion unless the result is error-shaped.
export function isSuccessfulToolOutput(output: unknown): boolean {
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
}

/** The last step returned a successful result from a tool the policy requires. */
export function hasSuccessfulRequiredToolResult(
  { steps }: StopConditionOptions,
  requiredPatterns: readonly RegExp[]
): boolean {
  if (requiredPatterns.length === 0) {
    return false;
  }
  const lastStep = steps[steps.length - 1];
  return (
    lastStep?.toolResults?.some(
      (toolResult) =>
        // A context-lifecycle request is never a terminal completion, even if a policy
        // lists it as required; otherwise its success would end the stream before the
        // settled-step callback could schedule the rollover it promised.
        toolResult.toolName !== "new_context" &&
        requiredPatterns.some((pattern) => pattern.test(toolResult.toolName)) &&
        isSuccessfulToolOutput(toolResult.output)
    ) ?? false
  );
}

/**
 * Record a settled step's budget decision as the stop cause and say whether to stop.
 * A blocked decision throws: the settled results do not fit the context budget.
 */
export function applyContextBudgetDecision(
  request: Pick<StreamRequestConfig, "stopCause">,
  { decision, continuationEntryId }: SettledStepOutcome
): boolean {
  // All siblings have settled: stop before another provider step without discarding results.
  if (decision !== "continue") {
    // The session captured its designated successor when it decided; a blocked stop hands
    // over to nothing.
    request.stopCause ??= {
      kind: "context-budget",
      decision,
      ...(decision !== "block" && continuationEntryId != null ? { continuationEntryId } : {}),
    };
  }
  if (decision === "block")
    throw new ContextBudgetBlockedError(
      "The settled tool results exceed the context budget. Use /compact or start a new context before continuing."
    );
  return decision !== "continue";
}

/**
 * Estimate the next step's request the way its preflight will (#4855): this step's input
 * plus its response messages, anchored on this step's usage like prepareStep.
 */
async function estimateNextRequestTokens(
  request: Pick<
    StreamRequestConfig,
    | "modelString"
    | "tools"
    | "budgetMetadataModel"
    | "contextBudgetLimit"
    | "system"
    | "messages"
    | "toolSearchState"
  >,
  stepTracker: StepMessageTracker | undefined,
  steps: StopConditionOptions["steps"],
  step: StopConditionStep
): Promise<number | undefined> {
  // The next step's preflight hard-stops on the assembled estimate, which can exceed
  // provider-reported usage by ~10% (#4855). Measure that same request here so the
  // budget decision can roll over before the preflight blocks. Invariant: this measure
  // is never below the one prepareStep will enforce for the next step. The SDK builds
  // the next input as this step's input plus its response messages.
  const nextMessages =
    request.contextBudgetLimit == null
      ? undefined
      : dedupeNativeToolReferences(
          await transformStepMessages([
            ...(stepTracker?.latestMessages ?? [
              ...request.messages,
              ...steps.slice(0, -1).flatMap((prior) => prior.response.messages),
            ]),
            ...step.response.messages,
          ])
        );
  const nextRequest =
    nextMessages == null
      ? undefined
      : await estimateAnchoredRequestTokensForModel(
          {
            system: request.system,
            messages: nextMessages,
            tools: isAgentToolsDisabled() ? undefined : request.tools,
          },
          {
            model: request.modelString,
            metadataModel: request.budgetMetadataModel,
            modelContextLimit: request.contextBudgetLimit,
            activeTools: computeContextLoadedToolNames(request.toolSearchState, nextMessages),
          },
          // prepareStep anchors the next step on this same request and usage, so both
          // measures take the same anchored-or-full branch and the invariant holds.
          createContextBudgetAnchor(stepTracker?.contextBudgetRequest, step)
        );
  return nextRequest?.estimate;
}

/**
 * StreamManager - Handles all streaming operations with type safety and atomic operations
 *
 * Key invariants:
 * - Only one active stream per workspace at any time
 * - Atomic stream creation/cancellation operations
 * - Guaranteed resource cleanup in all code paths
 */
export class StreamManager {
  // TurnRegistry's slot map. Whitebox tests seed and read it through this name.
  private readonly workspaceStreams: Map<WorkspaceId, WorkspaceStreamInfo>;
  // Owns the slot, the start lock, the completion fence and stop (turnEngine/TurnRegistry.ts).
  private readonly turnRegistry: TurnRegistry;
  // Owns the temp dir, the startup abort controller and scope, stream resource
  // teardown and the MCP lease (turnEngine/TurnResources.ts).
  private readonly turnResources: TurnResources;
  // Starts turns: slot, resources, registration, envelope (turnEngine/TurnEngine.ts).
  private readonly turnEngine: TurnEngine;
  private readonly refusalFallback: RefusalFallback;
  private readonly attemptLoop: AttemptLoop;
  private readonly streamRetries: StreamRetries;
  // Read by TurnResources at call time; coreServicesRoot.test.ts reads this field.
  private mcpServerManager?: MCPServerManager;
  private mockStreamLifecycle?: MockStreamLifecycle;
  private readonly PARTIAL_WRITE_THROTTLE_MS = 500;
  private readonly historyService: HistoryService;
  // Owns this manager's partial.json and final-message writes (turnEngine/PartialJournal.ts).
  private readonly partialJournal: PartialJournal;
  // Owns the turn's usage accounting and session-usage writes (turnEngine/UsageLedger.ts).
  private readonly usageLedger: UsageLedger;
  // Owns turn event delivery and workflow-run attachments (turnEngine/TurnEvents.ts).
  private readonly turnEvents: TurnEvents<WorkspaceStreamInfo>;
  // Builds and emits part, stream-start and nested tool events, and replays streams.
  private readonly turnEventEmitter: TurnEventEmitter;
  // Builds each streamText call and prepares its steps (turnEngine/StepPreparation.ts).
  private readonly stepPreparation: StepPreparation;
  // Owns lost previousResponseIds and prefix swaps (turnEngine/ProviderRequest.ts).
  private readonly providerRequest: ProviderRequest;
  private readonly getProvidersConfig: () => ProvidersConfigMap | null;
  /**
   * Runs the clock-driven lifecycle fibers (partial-write debounce and its
   * interrupt) and is handed to per-session workers that must share this
   * stream's clock (`RetryManager`, via `AgentSessionStreamManager`). The app
   * runtime's context-bound runner in production — a `TestClock` in tests —
   * and the global runtime wherever nothing is injected (di/effectRunner.ts).
   */
  public readonly effectRunner: EffectRunner;
  /**
   * Record timestamps, throttle windows and timeouts read this clock, so they move with
   * the runner's sleeps: nodeClock in production, the runner's TestClock in tests. Handed
   * to AgentSession and TurnRequestBuilder like `effectRunner`.
   */
  public readonly hostClock: HostClock;
  // Token tracker for live streaming statistics
  private readonly tokenTracker: StreamManagerTokenTracker;
  // Injected stream factory; undefined uses the AI SDK's streamText, resolved at
  // call time so the default stays the live module export.
  private readonly streamTextOverride?: typeof streamText;

  constructor(
    historyService: HistoryService,
    sessionUsageService?: SessionUsageService,
    getProvidersConfig?: () => ProvidersConfigMap | null,
    eventSink: TurnEngineEventSink = () => undefined,
    runner: EffectRunner = defaultEffectRunner,
    engineScope?: Scope.Closeable,
    private readonly toolCallDisplayRegistry = new ToolCallDisplayRegistry(),
    options: StreamManagerOptions = {}
  ) {
    this.historyService = historyService;
    this.getProvidersConfig = getProvidersConfig ?? (() => null);
    this.usageLedger = new UsageLedger({
      sessionUsageService,
      getProvidersConfig: this.getProvidersConfig,
      workspaceLogger: (id, turn) => this.getWorkspaceLogger(id as WorkspaceId, turn),
    });
    this.providerRequest = new ProviderRequest({
      getProvidersConfig: this.getProvidersConfig,
      workspaceLogger: (id, turn) => this.getWorkspaceLogger(id as WorkspaceId, turn),
    });
    this.turnEvents = new TurnEvents<WorkspaceStreamInfo>(eventSink, {
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
    });
    this.effectRunner = runner;
    this.hostClock = options.hostClock ?? hostClockFor(runner);
    this.partialJournal = new PartialJournal({
      historyService,
      runner,
      clock: this.hostClock,
      throttleMs: this.PARTIAL_WRITE_THROTTLE_MS,
    });
    this.turnRegistry = new TurnRegistry({
      effectRunner: runner,
      engineScope,
      turnEvents: this.turnEvents,
      mockStreamLifecycle: () => this.mockStreamLifecycle,
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
      cleanupAbortedStream: (id, info, abortReason, abandonPartial) =>
        this.cleanupAbortedStream(id, info, abortReason, abandonPartial),
    });
    this.workspaceStreams = this.turnRegistry.workspaceStreams;
    this.turnResources = new TurnResources({
      effectRunner: runner,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      partialJournal: this.partialJournal,
      mcpServerManager: () => this.mcpServerManager,
      // Forward at call time: tests spy on and Reflect.set these StreamManager methods.
      createTempDirForStream: (streamToken, runtime) =>
        this.createTempDirForStream(streamToken, runtime),
      cleanupStreamTempDir: (runtime, dir) => this.cleanupStreamTempDir(runtime, dir),
    });
    this.turnEngine = new TurnEngine({
      turnRegistry: this.turnRegistry,
      turnResources: this.turnResources,
      providerRequest: this.providerRequest,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult on it.
      resolveMetadataModel: (modelString, snapshot) =>
        this.resolveMetadataModel(modelString, snapshot),
      handleToolExecutionStart: (workspaceId, messageId, toolCallId) =>
        this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      processStreamWithCleanup: (workspaceId, streamInfo, historySequence) =>
        this.processStreamWithCleanup(workspaceId, streamInfo, historySequence),
    });
    this.tokenTracker = options.tokenTracker ?? new StreamingTokenTracker();
    this.streamRetries = new StreamRetries({
      partialJournal: this.partialJournal,
      usageLedger: this.usageLedger,
      providerRequest: this.providerRequest,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult on it.
      getWorkspaceLogger: (workspaceId, streamInfo) =>
        this.getWorkspaceLogger(workspaceId, streamInfo),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      moveAnthropicThinkingReplayPoint: (streamInfo, point) =>
        this.moveAnthropicThinkingReplayPoint(streamInfo, point),
      flushPartialWrite: (workspaceId, streamInfo) =>
        this.flushPartialWrite(workspaceId, streamInfo),
    });
    this.refusalFallback = new RefusalFallback({
      usageLedger: this.usageLedger,
      providerRequest: this.providerRequest,
      historyService: this.historyService,
      turnEvents: this.turnEvents,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult and tokenTracker on it.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
      },
      getWorkspaceLogger: (workspaceId, streamInfo) =>
        this.getWorkspaceLogger(workspaceId, streamInfo),
      resolveMetadataModel: (modelString, snapshot) =>
        this.resolveMetadataModel(modelString, snapshot),
      handleToolExecutionStart: (workspaceId, messageId, toolCallId) =>
        this.handleToolExecutionStart(workspaceId, messageId, toolCallId),
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      resetStreamStateForRetry: (workspaceId, streamInfo, options) =>
        this.resetStreamStateForRetry(workspaceId, streamInfo, options),
      moveAnthropicThinkingReplayPoint: (streamInfo, point) =>
        this.moveAnthropicThinkingReplayPoint(streamInfo, point),
      getStreamMetadata: (streamInfo) => this.getStreamMetadata(streamInfo),
      backfillReasoningTokensFromParts: (streamInfo, usage) =>
        this.backfillReasoningTokensFromParts(streamInfo, usage),
      getAggregatedProviderMetadata: (streamInfo) => this.getAggregatedProviderMetadata(streamInfo),
      buildPartialAssistantMessage: (streamInfo, options) =>
        this.buildPartialAssistantMessage(streamInfo, options),
    });
    this.attemptLoop = new AttemptLoop({
      turnResources: this.turnResources,
      partialJournal: this.partialJournal,
      usageLedger: this.usageLedger,
      providerRequest: this.providerRequest,
      turnEvents: this.turnEvents,
      refusalFallback: this.refusalFallback,
      workspaceStreams: this.workspaceStreams,
      // Forward at call time: these methods stay in StreamManager, and whitebox
      // tests replace createStreamResult and tokenTracker on it.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
      },
      getWorkspaceLogger: (workspaceId, streamInfo) =>
        this.getWorkspaceLogger(workspaceId, streamInfo),
      getStreamMetadata: (streamInfo) => this.getStreamMetadata(streamInfo),
      endUsage: (streamInfo, totalUsage) => this.endUsage(streamInfo, totalUsage),
      backfillReasoningTokensFromParts: (streamInfo, usage) =>
        this.backfillReasoningTokensFromParts(streamInfo, usage),
      resolveTtftMsForStreamEnd: (streamInfo) => this.resolveTtftMsForStreamEnd(streamInfo),
      resolveProviderMetadataForStreamEnd: (streamInfo) =>
        this.resolveProviderMetadataForStreamEnd(streamInfo),
      streamRetries: this.streamRetries,
      createStreamResult: (request, abortController, stepTracker) =>
        this.createStreamResult(request, abortController, stepTracker),
      emitStreamStart: (workspaceId, streamInfo, historySequence) =>
        this.emitStreamStart(workspaceId, streamInfo, historySequence),
      flushPartialWrite: (workspaceId, streamInfo) =>
        this.flushPartialWrite(workspaceId, streamInfo),
      foldView: (workspaceId, streamInfo, loop) => this.foldView(workspaceId, streamInfo, loop),
      applyStep: (workspaceId, streamInfo, step, loop) =>
        this.applyStep(workspaceId, streamInfo, step, loop),
      persistStreamError: (workspaceId, streamInfo, payload) =>
        this.persistStreamError(workspaceId, streamInfo, payload),
      discardUnsettledSessionUsage: (workspaceId, streamInfo) =>
        this.discardUnsettledSessionUsage(workspaceId, streamInfo),
    });
    this.streamTextOverride = options.streamText;
    this.stepPreparation = new StepPreparation({
      providerRequest: this.providerRequest,
      historyService: this.historyService,
      streamTextOverride: this.streamTextOverride,
      createStopWhenCondition: (request, stepTracker) =>
        this.createStopWhenCondition(request, stepTracker),
    });
    this.turnEventEmitter = new TurnEventEmitter(this.turnEvents, {
      // Forward to the field at call time: whitebox tests replace tokenTracker after
      // construction (Reflect.set), and the emitter must use the same tracker.
      tokenTracker: {
        setModel: (model, metadataModel) => this.tokenTracker.setModel(model, metadataModel),
        countTokens: (text) => this.tokenTracker.countTokens(text),
      },
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      getStream: (id) => this.workspaceStreams.get(id),
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
      schedulePartialWrite: (id, info) => this.schedulePartialWrite(id, info),
      turnReplayOffAfterServerTool: (info) => this.turnReplayOffAfterServerTool(info),
    });
  }

  setEventSink(eventSink: TurnEngineEventSink): void {
    this.turnEvents.setEventSink(eventSink);
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
  resolveMetadataModel(modelString: string, providersConfigSnapshot?: ProvidersConfigMap): string {
    try {
      // A caller's pinned request snapshot wins over the live config so the
      // recorded identity matches the request that was actually built (a
      // concurrent catalog refresh can retag/remove the instance mid-turn).
      return resolveModelForMetadata(
        modelString,
        providersConfigSnapshot ?? this.getProvidersConfig()
      );
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

  setMockStreamLifecycle(lifecycle: MockStreamLifecycle | undefined): void {
    this.mockStreamLifecycle = lifecycle;
  }

  getStartupAbortReason(signal?: AbortSignal): StreamAbortReason {
    return this.turnRegistry.getStartupAbortReason(signal);
  }

  beginStreamStart(
    input: Parameters<TurnRegistry["beginStreamStart"]>[0]
  ): PendingStreamStartHandle {
    return this.turnRegistry.beginStreamStart(input);
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

    this.usageLedger.recordToolModelUsage(streamInfo, event);
  }

  async attachWorkflowRunToToolCall(event: WorkflowRunAttachedEvent): Promise<boolean> {
    return this.turnEvents.attachWorkflowRunToToolCall(
      event,
      this.workspaceStreams.get(event.workspaceId as WorkspaceId)
    );
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

    this.turnEvents.emitTurnEvent({
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

  private partialTarget(workspaceId: WorkspaceId, streamInfo: WorkspaceStreamInfo): PartialTarget {
    return {
      workspaceId: workspaceId as string,
      state: streamInfo,
      snapshot: () => this.buildPartialAssistantMessage(streamInfo),
    };
  }

  /** Throttled partial write (PartialJournal.schedule). */
  private async schedulePartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    await this.partialJournal.schedule(
      this.partialTarget(workspaceId, streamInfo),
      streamInfo.resourceScope
    );
  }

  /** Immediate partial write after any in-flight one (PartialJournal.flush). */
  private async flushPartialWrite(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    terminalPartial?: MuxMessage
  ): Promise<void> {
    await this.partialJournal.flush(this.partialTarget(workspaceId, streamInfo), terminalPartial);
  }

  /** Used by callers that prepare resources (like tools) before starting the stream. */
  public generateStreamToken(): StreamToken {
    return this.turnRegistry.generateStreamToken();
  }

  /** TurnResources.createTempDirForStream. Tests spy on this method; startStream calls it. */
  public async createTempDirForStream(streamToken: StreamToken, runtime: Runtime): Promise<string> {
    return this.turnResources.createTempDirForStream(streamToken, runtime);
  }

  /** TurnResources.cleanupStreamTempDir. Tests replace this method; the release calls it. */
  private cleanupStreamTempDir(runtime: Runtime, runtimeTempDir: string): void {
    this.turnResources.cleanupStreamTempDir(runtime, runtimeTempDir);
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
    // Record time: wall clock until #7282 moves its consumers to HostClock.
    const timestamp = nodeClock.nowMs();

    this.turnEvents.emitTurnEvent({
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
        new Promise<undefined>((resolve) =>
          this.hostClock.setTimer(() => resolve(undefined), timeoutMs)
        ),
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
      // Duration from the wall-clock streamInfo.startTime.
      duration: nodeClock.nowMs() - streamInfo.startTime,
    };
  }

  /**
   * A retry that restarted the SDK stream but kept the earlier attempt's billed usage: the
   * new stream's totals and steps cover only the retried call.
   */
  private restartedWithPreservedUsage(streamInfo: WorkspaceStreamInfo): boolean {
    return (
      streamInfo.didRetryPreviousResponseIdAtStep ||
      streamInfo.didRetryAfterEmptyOutput === true ||
      streamInfo.didRetryReasoningReplayAtStep === true
    );
  }

  private endUsage(
    streamInfo: WorkspaceStreamInfo,
    totalUsage: LanguageModelV2Usage | undefined
  ): LanguageModelV2Usage | undefined {
    return this.usageLedger.endUsage(
      streamInfo,
      totalUsage,
      this.restartedWithPreservedUsage(streamInfo)
    );
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
   * Provider metadata for the usage resolveTotalUsageForStreamEnd picks: after a retry that
   * kept the earlier attempt's usage, only the live accumulation also covers the steps before
   * the retry (their cache writes and long-context shares).
   */
  private async resolveProviderMetadataForStreamEnd(
    streamInfo: WorkspaceStreamInfo
  ): Promise<Record<string, unknown> | undefined> {
    return (
      this.usageLedger.preservedEndProviderMetadata(
        streamInfo,
        this.restartedWithPreservedUsage(streamInfo)
      ) ?? this.getAggregatedProviderMetadata(streamInfo)
    );
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
        new Promise<undefined>((resolve) =>
          this.hostClock.setTimer(() => resolve(undefined), timeoutMs)
        ),
      ]);

      if (!steps || steps.length === 0) {
        // The live per-step accumulation covers every step; without one, fall back to the
        // final step's provider metadata.
        if (streamInfo.cumulativeProviderMetadata) {
          return { ...streamInfo.cumulativeProviderMetadata };
        }
        const finalStep = await streamInfo.streamResult.finalStep;
        return accumulateStepsProviderMetadata([finalStep], streamInfo.metadataModel);
      }

      // Aggregate cache creation tokens and long-context shares across all steps
      // (accumulateStepsProviderMetadata re-injects AI SDK 7's per-step cache writes).
      return accumulateStepsProviderMetadata(steps, streamInfo.metadataModel);
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
  /** Read-only snapshot of the stream state that partFold reads. */
  private foldView(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    loop: PartLoopState
  ): FoldView {
    return {
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      parts: streamInfo.parts,
      currentReasoningBlock: streamInfo.currentReasoningBlock,
      lastPartTimestamp: streamInfo.lastPartTimestamp,
      model: streamInfo.model,
      anthropicMessagesWire: isAnthropicMessagesModel(streamInfo.request.model),
      toolCalls: loop.toolCalls,
    };
  }

  /**
   * Runs partFold's intents in order with the existing helpers. Synchronous
   * intents run without a yield between them, awaited helpers stay awaited, and
   * schedulePartialWrite stays fire-and-forget, as when the fold was inline.
   */
  private async applyStep(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    step: FoldStep,
    loop: PartLoopState
  ): Promise<void> {
    // Store before the first await: tool execution starts stamp parts while
    // the intents below await, and part timestamps must stay monotonic.
    streamInfo.lastPartTimestamp = step.lastPartTimestamp;
    if (step.ignoredTextDelta) {
      log.debug("[streamManager] Ignoring non-string text-delta payload", {
        workspaceId,
        model: streamInfo.model,
        ...step.ignoredTextDelta,
      });
    }
    for (const intent of step.intents) {
      const pending = this.applyIntent(workspaceId, streamInfo, intent, loop);
      if (pending !== undefined) {
        await pending;
      }
    }
  }

  /** Returns the helper's promise for intents the stream loop must await (its value is unused). */
  private applyIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "StartStep":
        recordStepStart(streamInfo);
        streamInfo.streamStepOrdinals.push(streamInfo.stepStartIndices.length - 1);
        return this.writeInTurnThinkingStripReceipt(workspaceId, streamInfo);
      case "OpenReasoningBlock":
        streamInfo.currentReasoningBlock = {};
        return undefined;
      case "Append":
        return this.appendFoldedPart(workspaceId, streamInfo, intent);
      case "UpdateReasoningPart":
        this.updateReasoningPart(streamInfo, intent);
        return undefined;
      case "Emit":
        this.turnEvents.emitTurnEvent(intent.event);
        return undefined;
      case "CheckSoftCancel":
        return this.turnRegistry.checkSoftCancelStream(workspaceId, streamInfo);
      default:
        return this.applyToolIntent(workspaceId, streamInfo, intent, loop);
    }
  }

  private applyToolIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "RecordToolCall":
        // Tool call started - store in map for later lookup
        loop.toolCalls.set(intent.toolCallId, {
          toolCallId: intent.toolCallId,
          toolName: intent.toolName,
          input: intent.input,
        });
        if (intent.anthropicServerTool) {
          (streamInfo.anthropicServerToolCallIds ??= new Set()).add(intent.toolCallId);
        }
        return undefined;
      case "SetToolCallOutput": {
        const toolCall = loop.toolCalls.get(intent.toolCallId);
        assert(toolCall != null, "partFold sets output only on a tracked tool call");
        toolCall.output = intent.output;
        return undefined;
      }
      case "FinishToolCall":
        // Use shared completion logic (await to ensure partial is flushed before event)
        return this.finishToolCall(
          workspaceId,
          streamInfo,
          loop.toolCalls,
          intent.toolCallId,
          intent.toolName,
          intent.output,
          intent.providerExecuted,
          intent.modelOnlyNotifications
        );
      case "EmitToolCallDelta":
        return this.emitToolCallDeltaIfPresent(workspaceId, streamInfo, intent.part);
      case "SchedulePartialWrite":
        void this.schedulePartialWrite(workspaceId, streamInfo);
        return undefined;
      default:
        return this.applyTurnIntent(workspaceId, streamInfo, intent, loop);
    }
  }

  private applyTurnIntent(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): Promise<unknown> | undefined {
    switch (intent._tag) {
      case "RecordTerminalFinish":
        recordTerminalFinish(streamInfo, intent);
        return undefined;
      case "RecordStepUsage":
        this.recordStepUsage(workspaceId, streamInfo, intent.usage, intent.providerMetadata);
        return undefined;
      case "RecordInFlightUsage":
        return this.usageLedger.recordInFlight(workspaceId, streamInfo);
      case "FlushPartialWrite":
        return this.flushPartialWrite(workspaceId, streamInfo);
      case "Fail":
        // Capture the error and immediately throw to trigger error handling
        throw intent.error;
      default:
        this.applyLogIntent(streamInfo, intent, loop);
        return undefined;
    }
  }

  private applyLogIntent(
    streamInfo: WorkspaceStreamInfo,
    intent: FoldIntent,
    loop: PartLoopState
  ): void {
    switch (intent._tag) {
      case "Log":
        loop.workspaceLog[intent.level](intent.message, intent.fields);
        return;
      case "LogToolCall": {
        const inputText = JSON.stringify(intent.input);
        log.debug(
          `[StreamManager] tool-call: toolName=${intent.toolName}, input length=${inputText.length}`
        );
        return;
      }
      case "LogOrphanToolResult":
        loop.orphanToolResultCount += 1;
        this.logOrphanToolResult(
          loop.workspaceLog,
          streamInfo,
          { toolCallId: intent.toolCallId, toolName: intent.toolName },
          intent.output,
          loop.orphanToolResultCount,
          loop.toolCalls.size
        );
        return;
      case "LogToolError": {
        const logLevel = streamInfo.abortController.signal.aborted ? log.debug : log.error;
        logLevel(`Tool execution error for '${intent.toolName}'`, {
          toolCallId: intent.toolCallId,
          error: intent.error,
        });
        return;
      }
      default:
        assert(false, `applyStep has no handler for ${intent._tag}`);
    }
  }

  private async appendFoldedPart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    intent: Extract<FoldIntent, { _tag: "Append" }>
  ): Promise<void> {
    await this.turnEventEmitter.appendPartAndEmit(
      workspaceId,
      streamInfo,
      intent.part,
      intent.skipPartialWrite !== true
    );
    // The same object appendPartAndEmit pushed: signature deltas compare by reference.
    if (intent.trackInBlock && streamInfo.currentReasoningBlock) {
      streamInfo.currentReasoningBlock.lastPart = intent.part;
    }
  }

  /** Adds one finish-step's usage to the stream totals, then emits usage-delta. */
  private recordStepUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    stepUsage: LanguageModelV2Usage,
    stepProviderMetadata: Record<string, unknown> | undefined
  ): void {
    // Update cumulative totals for this stream. The emit below runs with
    // zero suspension after the mutation (emitTurnEvent invokes
    // the sink synchronously), so downstream Effect queue bridges
    // (SubscriptionEmit's offerUnsafe) observe usage-delta events
    // in mutation order.
    this.usageLedger.recordStep(streamInfo, stepUsage, stepProviderMetadata);

    const usageEvent = buildUsageDeltaEvent({
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      // Step-level (for context window display)
      usage: stepUsage,
      providerMetadata: stepProviderMetadata,
      // Cumulative (for live cost display)
      cumulativeUsage: streamInfo.cumulativeUsage,
      cumulativeProviderMetadata: streamInfo.cumulativeProviderMetadata,
      // Preserve costs-included zero-cost behavior throughout the stream.
      costsIncluded: streamInfo.initialMetadata?.costsIncluded,
    });
    streamInfo.currentStepStartIndex = streamInfo.parts.length;
    this.turnEvents.emitTurnEvent(usageEvent);
  }

  private updateReasoningPart(
    streamInfo: WorkspaceStreamInfo,
    intent: Extract<FoldIntent, { _tag: "UpdateReasoningPart" }>
  ): void {
    const target = streamInfo.parts[intent.index];
    // partFold read the index from this array in the same synchronous turn.
    assert(target?.type === "reasoning", "partFold updates only reasoning parts");
    if (intent.signature) {
      target.signature = intent.signature;
    }
    target.providerOptions = intent.providerOptions;
    if (intent.trackInBlock && streamInfo.currentReasoningBlock) {
      streamInfo.currentReasoningBlock.lastPart = target;
    }
  }

  /**
   * #5887 containment: thinking that follows an Anthropic server tool in this row cannot
   * replay as the API returned it (see anthropicServerToolCallIds). Write the receipt with
   * the point at the row's end, so later requests in the context segment send no thinking
   * up to and including this row (removing every thinking block is valid; a gap or a
   * put-back block is not). Rows after it replay theirs. It wins over a step point and
   * never moves back. It rides on the partial write that stores this reasoning part (every
   * reasoning append schedules one).
   */
  private turnReplayOffAfterServerTool(streamInfo: WorkspaceStreamInfo): void {
    const serverToolIds = streamInfo.anthropicServerToolCallIds;
    if (
      serverToolIds == null ||
      streamInfo.initialMetadata?.anthropicThinkingReplayFromStep === "end"
    ) {
      return;
    }
    // Only Anthropic reasoning is bound to the native prefix: a refusal fallback to another
    // provider keeps the parts (and the IDs) but its reasoning replays nothing Anthropic.
    if (!isAnthropicMessagesModel(streamInfo.request.model)) return;
    // Read the parts, not only the ID set: a retry that drops parts drops the server tool too.
    const followsServerTool = streamInfo.parts.some(
      (part) => part.type === "dynamic-tool" && serverToolIds.has(part.toolCallId)
    );
    if (!followsServerTool) {
      // Every recorded server tool's part is gone. The tool-call case records an ID and
      // stores its part before any later reasoning, so the IDs are stale: drop them, or
      // every later reasoning delta would scan all parts again (perf).
      streamInfo.anthropicServerToolCallIds = undefined;
      return;
    }
    this.moveAnthropicThinkingReplayPoint(streamInfo, "end");
  }

  /**
   * Preserved thinking: once the step whose request stripped earlier Anthropic thinking
   * (stepTracker.anthropicThinkingStripStep) has started, write the receipt with that step as
   * the point, or the next turn replays the removed blocks and gets a 400. Persisted with the
   * next partial write; a crash before it only costs one repair (fail-safe).
   */
  private async writeInTurnThinkingStripReceipt(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    const stripStep = streamInfo.stepTracker.anthropicThinkingStripStep;
    // prepareStep may already have prepared a later step: wait until that step started.
    if (stripStep == null || stripStep >= streamInfo.streamStepOrdinals.length) return;
    streamInfo.stepTracker.anthropicThinkingStripStep = undefined;
    if (
      this.moveAnthropicThinkingReplayPoint(streamInfo, streamInfo.streamStepOrdinals[stripStep])
    ) {
      await this.schedulePartialWrite(workspaceId, streamInfo);
    }
  }

  /**
   * Write or move this row's thinking-replay receipt (MuxMetadata.anthropicThinkingReplay).
   * A second strip in the same turn moves the point forward: it removed everything the
   * earlier one did, and its later blocks are bound to the new prefix. initialMetadata feeds
   * the partial, error partial and final row alike. Returns whether anything changed; the
   * caller persists it.
   */
  private moveAnthropicThinkingReplayPoint(
    streamInfo: WorkspaceStreamInfo,
    point: AnthropicThinkingReplayPoint
  ): boolean {
    const current = streamInfo.initialMetadata;
    const next = laterAnthropicThinkingReplayPoint(
      current?.anthropicThinkingReplay === "off"
        ? current.anthropicThinkingReplayFromStep
        : undefined,
      point
    );
    if (
      current?.anthropicThinkingReplay === "off" &&
      current.anthropicThinkingReplayFromStep === next
    ) {
      return false;
    }
    streamInfo.initialMetadata = {
      ...current,
      anthropicThinkingReplay: "off",
      anthropicThinkingReplayFromStep: next,
    };
    return true;
  }

  private async cleanupAbortedStream(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean
  ): Promise<void> {
    // Close before waiting: late or queued invocations cannot publish after abort.
    if (streamInfo.executionScope) this.toolCallDisplayRegistry.close(streamInfo.executionScope);
    // CRITICAL: Wait for processing to fully complete before cleanup
    // This prevents race conditions where the old stream is still running
    // while a new stream starts (e.g., old stream writing to partial.json)
    try {
      await streamInfo.processingPromise;
    } catch (error) {
      // The provider has exited even when teardown failed. Cancellation still owns
      // an aborted terminal unless the loop already published another outcome.
      log.error("Stream processing failed during cancellation", { error });
    }

    // The cancel lost the race: the loop had already left the fullStream and
    // finished as completed/failed (terminalCompletion set, stream-end/error
    // emitted, completion settled by processStreamWithCleanup's finally).
    // Re-running the abort bookkeeping here would resurrect partial.json after
    // deletePartial and emit a second terminal event (stream-abort after
    // stream-end), which the renderer reads as "still partial".
    if (streamInfo.terminalCompletion !== undefined) {
      return;
    }

    // Also covers registered STARTING attempts: their envelope callback may itself await
    // stopStream, so join owned resources here without joining that callback back into itself.
    // The envelope only journals; its original callback/mutex lifetime stays independently
    // leased. Canceled engine model/temp/debounce resources retire before raw terminal delivery.
    await this.turnResources.closeStreamResources(streamInfo);

    // For aborts, use our tracked cumulativeUsage directly instead of AI SDK's totalUsage.
    // cumulativeUsage is updated on each finish-step event (before tool execution),
    // so it has accurate data even when the stream is interrupted mid-tool-call.
    // AI SDK's totalUsage may return zeros or stale data when aborted.
    // Duration from the wall-clock streamInfo.startTime.
    const duration = nodeClock.nowMs() - streamInfo.startTime;
    const usage = hasTokenUsage(streamInfo.cumulativeUsage)
      ? streamInfo.cumulativeUsage
      : undefined;

    // For context window display, use last step's usage (inputTokens = current context size)
    const contextUsage = streamInfo.lastStepUsage;
    const contextProviderMetadata = streamInfo.lastStepProviderMetadata;

    // Include provider metadata for accurate cost calculation
    const providerMetadata = markProviderMetadataCostsIncluded(
      streamInfo.cumulativeProviderMetadata,
      streamInfo.initialMetadata?.costsIncluded
    );

    const streamAbort: StreamAbortEvent = {
      type: "stream-abort",
      workspaceId,
      messageId: streamInfo.messageId,
      metadata: {
        usage,
        contextUsage,
        duration,
        providerMetadata,
        contextProviderMetadata,
        model: streamInfo.model,
        metadataModel: streamInfo.metadataModel,
        // Same tool-model usage the committed partial gets below, so the renderer's
        // per-turn cost views match history replay without a reload.
        ...(streamInfo.toolModelUsages.length > 0
          ? { toolModelUsages: streamInfo.toolModelUsages.map(clonePersistedToolModelUsage) }
          : {}),
      },
      abortReason,
      abandonPartial,
      acpPromptId: streamInfo.initialMetadata?.acpPromptId,
    };
    try {
      try {
        await this.backfillReasoningTokensFromParts(streamInfo, usage);
      } catch (error) {
        // Estimation is optional: preserve provider usage and the user's abort reason.
        log.error("Failed to estimate reasoning usage on abort", { error });
      }

      // Record session usage for aborted streams (mirrors stream-end path)
      // This ensures tokens consumed before abort are tracked for cost display
      await this.usageLedger.settle(
        workspaceId,
        streamInfo,
        usage,
        providerMetadata,
        "Failed to record session usage on abort",
        "error"
      );

      // Stamp the aborted turn's usage onto the partial message BEFORE committing
      // it and delivering stream-abort. Analytics
      // prices history rows from metadata.usage, so without this every
      // interrupted turn — user Esc, queued tool-end preemption, monitor wakes —
      // would ingest as $0 even though the provider billed all completed steps.
      if (!abandonPartial && (usage !== undefined || streamInfo.toolModelUsages.length > 0)) {
        try {
          await this.partialJournal.awaitPending(streamInfo);
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
          await this.partialJournal.writeAbortPartial(workspaceId as string, partialMessage);

          // Tool-only aborts (Esc while a tool is still running): commitPartial
          // refuses to commit partials whose only parts are input-available tool
          // calls, so the usage stamped above would die with the deleted
          // partial. Route that spend through the headless-usage sidecar
          // instead. Same predicate commitPartial applies, so exactly one of
          // {chat row, sidecar row} carries this turn's usage.
          if (!hasCommitWorthyParts(partialMessage.parts)) {
            await this.usageLedger.recordDroppedPartialUsage(
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
          await this.usageLedger.recordDroppedPartialUsage(
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
    } catch (error) {
      log.error("Failed abort bookkeeping; delivering preserved terminal metadata", { error });
    } finally {
      try {
        // Cancellation owns this attempt through disk cleanup and raw delivery. Keeping
        // the registration until then makes replacement startup join the same fence.
        const result = await this.partialJournal.settleAbort(
          workspaceId,
          streamInfo.messageId,
          abandonPartial === true
        );
        // commitPartial already deletes on success. On failure retain recovery data;
        // an unconditional delete here would silently discard an uncommitted answer.
        if (!result.success)
          log.error("Failed partial cleanup during stream-abort", {
            workspaceId,
            error: result.error,
          });
      } catch (error) {
        log.error("Failed partial cleanup during stream-abort", { workspaceId, error });
      }
      try {
        await this.turnEvents.deliver(streamAbort);
      } catch (error) {
        log.error("Stream-abort delivery failed", { error: getErrorMessage(error) });
      } finally {
        if (this.workspaceStreams.get(workspaceId) === streamInfo) {
          this.workspaceStreams.delete(workspaceId);
        }
        streamInfo.terminalCompletion = {
          status: "aborted",
          abortReason,
          streamAbort,
          systemMessageTokens: streamInfo.initialMetadata?.systemMessageTokens,
        };
        // Session policy consumes this promise separately. It may start a replacement,
        // so neither this fence nor the raw sink may join that policy.
        streamInfo.completionController?.settle(streamInfo.terminalCompletion);
      }
    }
  }

  /**
   * A terminal path that recorded no usage (e.g. a completion with no parts) leaves no
   * in-flight file. An abort is not terminal yet here: cleanupAbortedStream settles it after
   * processing ends, and until then the file is its only durable record.
   */
  private async discardUnsettledSessionUsage(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ): Promise<void> {
    if (streamInfo.terminalCompletion != null) {
      await this.usageLedger.discardInFlight(workspaceId, streamInfo);
    }
  }

  private createStopWhenCondition(
    request: StopWhenRequest,
    stepTracker?: StepMessageTracker
  ): Array<ReturnType<typeof stepCountIs>> {
    const requiredPatterns = buildRequiredToolPatterns(request.toolPolicy);

    return [
      ({ steps }) => {
        if (steps.length < 100000) return false;
        request.stopCause ??= { kind: "step-limit" };
        return true;
      },
      // The SDK evaluates stop conditions only after every sibling tool result in the
      // model's current step settles. Do not move this to individual tool-call-end events:
      // that would abort the remaining calls the model emitted in the same batch.
      (options) => this.stopAfterSettledStep(request, stepTracker, requiredPatterns, options),
      (options) => {
        if (!hasSuccessfulRequiredToolResult(options, requiredPatterns)) return false;
        request.stopCause ??= { kind: "required-tool" };
        return true;
      },
    ];
  }

  /**
   * The settled-step stop condition: the step's context-budget decision first, then a
   * required-tool completion (handled by its own condition), then queued input.
   */
  private async stopAfterSettledStep(
    request: StopWhenRequest,
    stepTracker: StepMessageTracker | undefined,
    requiredPatterns: readonly RegExp[],
    options: StopConditionOptions
  ): Promise<boolean> {
    const { steps } = options;
    const step = steps.at(-1);
    const onStepSettled = request.onStepSettled;
    if (onStepSettled && step && !hasSuccessfulRequiredToolResult(options, requiredPatterns)) {
      // Budget stops are authoritative even when only a turn-end message is queued.
      if (await this.settleStepBudget(request, onStepSettled, stepTracker, steps, step))
        return true;
    }
    if (hasSuccessfulRequiredToolResult(options, requiredPatterns)) return false;
    const queuedInput = request.getQueuedInputStopCause?.();
    if (queuedInput != null) {
      request.stopCause ??= queuedInput;
      return true;
    }
    return request.hasQueuedMessages?.("tool-end") ?? false;
  }

  /**
   * Report a settled step to the session's budget callback, with its tool-result size and
   * the next request's estimate, and apply the decision. True means stop now.
   */
  private async settleStepBudget(
    request: StopWhenRequest,
    onStepSettled: OnStepSettled,
    stepTracker: StepMessageTracker | undefined,
    steps: StopConditionOptions["steps"],
    step: StopConditionStep
  ): Promise<boolean> {
    const outputs = step.toolResults.map((result) => result.output);
    const size = estimateToolResultSize(outputs);
    const toolResultTokens = await estimateToolResultTokensForModel(outputs, {
      model: request.modelString,
      metadataModel: request.budgetMetadataModel,
    });
    const nextRequestTokens = await estimateNextRequestTokens(request, stepTracker, steps, step);
    const outcome = await onStepSettled({
      model: request.modelString,
      usage: normalizeUsage(step.usage),
      providerMetadata: step.providerMetadata,
      ...size,
      toolResultTokens,
      ...(nextRequestTokens != null ? { nextRequestTokens } : {}),
      sessionHistoryAvailable: request.tools?.session_history != null,
      newContextAvailable: request.tools?.new_context != null,
      newContextRequested: step.toolResults.some(
        (result) => result.toolName === "new_context" && isSuccessfulToolOutput(result.output)
      ),
    });
    return applyContextBudgetDecision(request, outcome);
  }

  getPrefixSwapPreparation(workspaceId: string) {
    const info = this.workspaceStreams.get(workspaceId as WorkspaceId);
    if (!info) return null;
    const tools = info.request.tools ?? {};
    const deferLoadingToolNames = [...collectDeferLoadingToolNames(tools)];
    return {
      requestProviderOptions: info.request.providerOptions,
      systemPrefix: info.request.messages.filter((message) => message.role === "system"),
      cacheEnabled: info.request.cacheEnabled ?? false,
      preparation: {
        effectiveAgentId: info.initialMetadata?.agentId ?? "exec",
        // Same list as the turn's own transition: native deferred tools stay unlisted until loaded.
        toolNamesForSentinel:
          computeLoadedToolNames(info.request.toolSearchState)?.sort() ?? Object.keys(tools),
        effectiveThinkingLevel: ThinkingLevelSchema.parse(info.thinkingLevel ?? "off"),
        modelString: info.model,
        providerForMessages: info.metadataModel.split(":", 1)[0],
        anthropicCacheTtl: getAnthropicCacheTtl(info.request.providerOptions),
        ...(deferLoadingToolNames.length > 0 ? { deferLoadingToolNames } : {}),
      },
    };
  }

  setPrefixSwap(workspaceId: string, swap: ContinuousPrefixSwap): boolean {
    return this.providerRequest.setPrefixSwap(
      this.workspaceStreams.get(workspaceId as WorkspaceId),
      swap
    );
  }

  clearPrefixSwap(workspaceId: string): void {
    this.providerRequest.clearPrefixSwap(
      this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker
    );
  }

  getPrefixSwapState(workspaceId: string): "none" | "pending" | "consumed" | "invalidated" {
    return this.providerRequest.getPrefixSwapState(
      this.workspaceStreams.get(workspaceId as WorkspaceId)?.stepTracker
    );
  }

  /**
   * StepPreparation.createStreamResult. Kept as a method: whitebox tests replace it on
   * StreamManager with Reflect.set, and every caller goes through it.
   */
  private createStreamResult(
    request: StreamRequestConfig,
    abortController: AbortController,
    stepTracker?: StepMessageTracker
  ): Awaited<ReturnType<typeof streamText>> {
    return this.stepPreparation.createStreamResult(request, abortController, stepTracker);
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
    providerExecuted?: boolean,
    modelOnlyNotifications?: string[]
  ): Promise<void> {
    // Find and update the existing tool part
    const existingPartIndex = streamInfo.parts.findIndex(
      (p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId
    );
    const pendingAttachment = this.turnEvents.takePendingWorkflowRunAttachment(
      streamInfo,
      toolCallId
    );
    const mcpServer = streamInfo.executionScope
      ? this.toolCallDisplayRegistry.take(streamInfo.executionScope, toolCallId)
      : undefined;

    if (existingPartIndex !== -1) {
      const existingPart = streamInfo.parts[existingPartIndex];
      if (existingPart.type === "dynamic-tool") {
        streamInfo.parts[existingPartIndex] = {
          ...existingPart,
          ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
          ...(mcpServer ? { mcpServer } : {}),
          state: "output-available" as const,
          output,
          // Set even when undefined: an earlier completion's notes must not outlive it (#6665).
          modelOnlyNotifications,
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
        ...modelOnlyNotificationsField(modelOnlyNotifications),
        ...(mcpServer ? { mcpServer } : {}),
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
      this.turnEvents.emitWorkflowRunAttachedFromAttachment({
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
    this.turnEvents.emitTurnEvent({
      type: "tool-call-end",
      workspaceId: workspaceId as string,
      messageId: streamInfo.messageId,
      toolCallId,
      toolName,
      result: output,
      ...(mcpServer ? { mcpServer } : {}),
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
    providerExecuted?: boolean,
    modelOnlyNotifications?: string[]
  ): Promise<void> {
    await this.completeToolCall(
      workspaceId,
      streamInfo,
      toolCalls,
      toolCallId,
      toolName,
      output,
      providerExecuted,
      modelOnlyNotifications
    );
    await this.turnRegistry.checkSoftCancelStream(workspaceId, streamInfo);
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

  /** Emit a PTC code_execution nested tool event (TurnEventEmitter.emitNestedToolEvent). */
  emitNestedToolEvent(scope: ExecutionScope, event: NestedToolEvent): void {
    this.turnEventEmitter.emitNestedToolEvent(scope, event);
  }

  private emitStreamStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number,
    options?: { replay?: boolean }
  ): void {
    this.turnEventEmitter.emitStreamStart(workspaceId, streamInfo, historySequence, options);
  }

  private buildPartialAssistantMessage(
    streamInfo: WorkspaceStreamInfo,
    options: { metadata?: Partial<MuxMetadata>; parts?: MuxMessage["parts"] } = {}
  ): MuxMessage {
    const canonicalModel = metadataModelIdentity(streamInfo.model);

    return {
      id: streamInfo.messageId,
      role: "assistant",
      metadata: {
        historySequence: streamInfo.historySequence,
        timestamp: streamInfo.startTime,
        ...streamInfo.initialMetadata,
        model: canonicalModel,
        metadataModel: streamInfo.metadataModel,
        ...(streamInfo.thinkingLevel && {
          thinkingLevel: streamInfo.thinkingLevel as ThinkingLevel,
        }),
        partial: true,
        ...options.metadata,
        stepStartPartIndices: streamInfo.stepStartIndices.filter(
          (index) => index < (options.parts ?? streamInfo.parts).length
        ),
      },
      parts: options.parts ?? streamInfo.parts,
    };
  }

  /** The attempt loop (AttemptLoop); TurnEngine and whitebox tests call it here. */
  private processStreamWithCleanup(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number
  ): Promise<void> {
    return this.attemptLoop.processStreamWithCleanup(workspaceId, streamInfo, historySequence);
  }

  /**
   * Write error metadata to partial.json and emit the corresponding error event.
   */
  private async persistStreamError(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    payload: StreamErrorPayload & { errorType: StreamErrorType }
  ): Promise<StreamErrorPayload & { errorType: StreamErrorType }> {
    // Clamp at the single choke point every stream error payload passes
    // through before persist/emit, including buildStreamErrorPayload's
    // early-return branches (e.g. ModelRefusalError, whose fallbackNote can
    // embed another error's message). Some SDK errors embed the entire
    // serialized prompt in their message (AI_TypeValidationError via the
    // cause walk); unbounded, that would be persisted to history metadata,
    // shipped over IPC, and rendered in the chat.
    payload = { ...payload, error: clampErrorMessage(payload.error), model: streamInfo.model };
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
      await this.usageLedger.settle(
        workspaceId,
        streamInfo,
        cumulativeErrorUsage,
        cumulativeErrorProviderMetadata,
        "Failed to record session usage for errored stream",
        "warn"
      );
    } else {
      // Refusals recorded their own usage above: drop any in-flight copy.
      await this.usageLedger.discardInFlight(workspaceId, streamInfo);
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

    // Write error state to disk through the tracked partial write: it waits for any in-flight
    // flush, cancels a scheduled one, and retires later flushes, so a concurrent cancel cannot
    // land a pre-error snapshot after it (#5344). Awaited so the state is on disk before any
    // resume.
    await this.flushPartialWrite(workspaceId, streamInfo, errorPartialMessage);

    try {
      await this.usageLedger.recordDroppedPartialUsage(
        workspaceId,
        streamInfo,
        errorUsage,
        errorProviderMetadata,
        "errored_stream",
        // A model_refusal error's stream usage row is terminalRefusalUsage
        // (only set for terminal no-fallback refusals); label it as a refusal
        // so analytics can distinguish refusals from generic stream errors.
        payload.errorType === "model_refusal" ? "refused_stream" : "errored_stream"
      );
    } catch (error) {
      log.error("Failed to record errored-stream usage in headless sidecar", { error });
    }

    // Emit error event before completion settles so recovery bookkeeping is ready for waiters.
    this.turnEvents.emitTurnEvent(createErrorEvent(workspaceId as string, payload));
    return payload;
  }

  /** StreamRetries.resetStreamStateForRetry; whitebox tests (engineInternals) call it here. */
  private resetStreamStateForRetry(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    options?: { preserveParts?: boolean; preserveUsage?: boolean; workspaceLog?: Logger }
  ): Promise<void> {
    return this.streamRetries.resetStreamStateForRetry(workspaceId, streamInfo, options);
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
    options: TurnExecutionOptions
  ): Promise<Result<TurnStreamHandle, SendMessageError>> {
    return this.turnEngine.start(options);
  }

  /**
   * Check if a previousResponseId has been marked as lost
   * Called by buildProviderOptions to filter out invalid IDs
   */
  public isResponseIdLost(responseId: string): boolean {
    return this.providerRequest.isResponseIdLost(responseId);
  }

  /**
   * Stops an active stream for a workspace
   * If soft is true, performs a soft interrupt (cancels at next block boundary)
   */
  async stopStream(workspaceId: string, options?: StopStreamOptions): Promise<Result<void>> {
    return this.turnRegistry.stopStream(workspaceId, options);
  }

  getStreamState(workspaceId: string): StreamState {
    return this.turnRegistry.getStreamState(workspaceId);
  }

  isStreaming(workspaceId: string): boolean {
    return this.turnRegistry.isStreaming(workspaceId);
  }

  getActiveStreams(): string[] {
    return this.turnRegistry.getActiveStreams();
  }

  async acquireStreamStartLock(workspaceId: string) {
    return this.turnRegistry.acquireStreamStartLock(workspaceId);
  }

  getStreamInfo(workspaceId: string, includeFinalizing = false): ActiveStreamInfo | undefined {
    return this.turnRegistry.getStreamInfo(workspaceId, includeFinalizing);
  }

  /**
   * Replay stream events
   * Emits the same events (stream-start, stream-delta, etc.) that would be emitted during live streaming
   * This allows replay to flow through the same event path as live streaming (no duplication)
   */
  async replayStream(workspaceId: string, opts?: { afterTimestamp?: number }): Promise<void> {
    if (this.mockStreamLifecycle) {
      await this.mockStreamLifecycle.replayStream(workspaceId, opts);
      return;
    }

    const typedWorkspaceId = workspaceId as WorkspaceId;
    const streamInfo = this.workspaceStreams.get(typedWorkspaceId);

    // Only replay if stream is actively running
    if (
      !streamInfo ||
      (streamInfo.state !== StreamState.STARTING && streamInfo.state !== StreamState.STREAMING)
    ) {
      return;
    }

    await this.turnEventEmitter.replayStream(workspaceId, streamInfo, opts);
  }
}
