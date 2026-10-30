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
  StreamAbortReason,
  ToolCallExecutionStartEvent,
  CompletedMessagePart,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";

import type { SendMessageError } from "@/common/types/errors";
import type { MuxMetadata, MuxMessage, PersistedToolModelUsage } from "@/common/types/message";
import { ThinkingLevelSchema, type ThinkingLevel } from "@/common/types/thinking";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import type { HistoryService } from "./historyService";
import {
  accumulateStepsProviderMetadata,
  normalizeUsage,
  withCacheWriteMetadata,
} from "@/common/utils/tokens/usageHelpers";
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
import { getErrorMessage } from "@/common/utils/errors";
import { defaultEffectRunner, type EffectRunner } from "./di/effectRunner";
import { hostClockFor } from "./di/hostClockLive";
import { UsageLedger } from "@/node/services/turnEngine/UsageLedger";
import { PartialJournal, type PartialTarget } from "@/node/services/turnEngine/PartialJournal";
import {
  ProviderRequest,
  type StreamRequestConfig,
} from "@/node/services/turnEngine/ProviderRequest";
import {
  StepPreparation,
  transformStepMessages,
  type StepMessageTracker,
} from "@/node/services/turnEngine/StepPreparation";
import {
  metadataModelIdentity,
  TurnEventEmitter,
  TurnEvents,
  type NestedToolEvent,
} from "@/node/services/turnEngine/TurnEvents";
import type { HostClock } from "@/node/utils/hostClock";
import type {
  WorkspaceId,
  TurnEngineEventSink,
  TurnStreamHandle,
  SettledStepOutcome,
  OnStepSettled,
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
import type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
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
  StopStreamOptions,
  ActiveStreamInfo,
  MockStreamLifecycle,
  StreamManagerTokenTracker,
} from "@/node/services/turnEngine/types";
export type { WorkspaceStreamInfo } from "@/node/services/turnEngine/turnState";
import {
  StreamState,
  TurnRegistry,
  type PendingStreamStartHandle,
  type StreamToken,
} from "@/node/services/turnEngine/TurnRegistry";
import { AttemptLoop } from "@/node/services/turnEngine/AttemptLoop";
import { RefusalFallback } from "@/node/services/turnEngine/RefusalFallback";
import { StreamRetries } from "@/node/services/turnEngine/StreamRetries";
import {
  moveAnthropicThinkingReplayPoint,
  nextPartTimestamp,
  StepApply,
  turnReplayOffAfterServerTool,
} from "@/node/services/turnEngine/StepApply";
import { TurnResources } from "@/node/services/turnEngine/TurnResources";
import { TurnEngine, type TurnExecutionOptions } from "@/node/services/turnEngine/TurnEngine";
export {
  createTurnCompletionController,
  type TurnExecutionOptions,
} from "@/node/services/turnEngine/TurnEngine";

// Disable noisy AI SDK warning logging.
globalThis.AI_SDK_LOG_WARNINGS = false;

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
function hasSuccessfulRequiredToolResult(
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
function applyContextBudgetDecision(
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
  private readonly stepApply: StepApply;
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
      hostClock: this.hostClock,
      engineScope,
      turnEvents: this.turnEvents,
      mockStreamLifecycle: () => this.mockStreamLifecycle,
      flushPartialWrite: (id, info) => this.flushPartialWrite(id, info),
      // Forward at call time: AttemptLoop is built after TurnRegistry.
      cleanupAbortedStream: (id, info, abortReason, abandonPartial) =>
        this.attemptLoop.cleanupAbortedStream(id, info, abortReason, abandonPartial),
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
      effectRunner: this.effectRunner,
      hostClock: this.hostClock,
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
      moveAnthropicThinkingReplayPoint,
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
        this.streamRetries.resetStreamStateForRetry(workspaceId, streamInfo, options),
      moveAnthropicThinkingReplayPoint,
      getStreamMetadata: (streamInfo) => this.getStreamMetadata(streamInfo),
      backfillReasoningTokensFromParts: (streamInfo, usage) =>
        this.backfillReasoningTokensFromParts(streamInfo, usage),
      getAggregatedProviderMetadata: (streamInfo) => this.getAggregatedProviderMetadata(streamInfo),
      buildPartialAssistantMessage: (streamInfo, options) =>
        this.buildPartialAssistantMessage(streamInfo, options),
    });
    this.attemptLoop = new AttemptLoop({
      hostClock: this.hostClock,
      turnResources: this.turnResources,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
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
      flushPartialWrite: (workspaceId, streamInfo, terminalPartial) =>
        this.flushPartialWrite(workspaceId, streamInfo, terminalPartial),
      applyStep: (workspaceId, streamInfo, step, loop) =>
        this.stepApply.applyStep(workspaceId, streamInfo, step, loop),
      buildPartialAssistantMessage: (streamInfo, options) =>
        this.buildPartialAssistantMessage(streamInfo, options),
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
      turnReplayOffAfterServerTool,
    });
    this.stepApply = new StepApply({
      turnEvents: this.turnEvents,
      turnRegistry: this.turnRegistry,
      usageLedger: this.usageLedger,
      turnEventEmitter: this.turnEventEmitter,
      toolCallDisplayRegistry: this.toolCallDisplayRegistry,
      // Forward at call time: whitebox tests replace tokenTracker after construction
      // (Reflect.set).
      tokenTracker: { countTokens: (text) => this.tokenTracker.countTokens(text) },
      schedulePartialWrite: (workspaceId, streamInfo) =>
        this.schedulePartialWrite(workspaceId, streamInfo),
      flushPartialWrite: (workspaceId, streamInfo) =>
        this.flushPartialWrite(workspaceId, streamInfo),
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
      streamInfo.pendingToolExecutionStarts.set(toolCallId, timestamp);
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
      duration: this.hostClock.nowMs() - streamInfo.durationStartMs,
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
        anthropicCacheTtl:
          info.request.anthropicCacheTtl ?? getAnthropicCacheTtl(info.request.providerOptions),
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
