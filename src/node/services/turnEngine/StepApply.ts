/**
 * Applies one partFold step to the stream: StepApply runs the fold's intents
 * (parts, events, usage, partial writes, tool calls and logs) in order against
 * the stream state. The thinking-replay receipt helpers live here too, because
 * the step's reasoning and step-start intents move the receipt.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import assert from "@/common/utils/assert";
import { log, type Logger } from "@/node/services/log";
import type { FoldIntent, FoldStep, FoldView } from "@/node/services/turnEngine/partFold";
import { isAnthropicMessagesModel } from "@/node/services/turnEngine/StepPreparation";
import { recordStepStart } from "@/node/services/turnEngine/StreamRetries";
import {
  buildUsageDeltaEvent,
  type TurnEventEmitter,
  type TurnEvents,
} from "@/node/services/turnEngine/TurnEvents";
import type { TurnRegistry } from "@/node/services/turnEngine/TurnRegistry";
import type {
  StreamManagerTokenTracker,
  WorkspaceId,
  WorkspaceStreamInfo,
} from "@/node/services/turnEngine/types";
import type { UsageLedger } from "@/node/services/turnEngine/UsageLedger";
import { nodeClock } from "@/node/utils/hostClock";
import {
  laterAnthropicThinkingReplayPoint,
  type AnthropicThinkingReplayPoint,
} from "@/node/utils/messages/anthropicThinkingReplay";

// Tool-call tracking + branded types
export interface ToolCallState {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
}

export type ToolCallMap = Map<string, ToolCallState>;

/** Stream-loop state of one processStreamWithCleanup turn that applyStep reads and updates. */
export interface PartLoopState {
  readonly workspaceLog: Logger;
  /** Per attempt: processStreamWithCleanup replaces it before each attempt. */
  toolCalls: ToolCallMap;
  /** Per turn: counts orphan tool results for log suppression. */
  orphanToolResultCount: number;
}

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

/** Read-only snapshot of the stream state that partFold reads. */
export function foldView(
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
 * #5887 containment: thinking that follows an Anthropic server tool in this row cannot
 * replay as the API returned it (see anthropicServerToolCallIds). Write the receipt with
 * the point at the row's end, so later requests in the context segment send no thinking
 * up to and including this row (removing every thinking block is valid; a gap or a
 * put-back block is not). Rows after it replay theirs. It wins over a step point and
 * never moves back. It rides on the partial write that stores this reasoning part (every
 * reasoning append schedules one).
 */
export function turnReplayOffAfterServerTool(streamInfo: WorkspaceStreamInfo): void {
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
  moveAnthropicThinkingReplayPoint(streamInfo, "end");
}

/**
 * Write or move this row's thinking-replay receipt (MuxMetadata.anthropicThinkingReplay).
 * A second strip in the same turn moves the point forward: it removed everything the
 * earlier one did, and its later blocks are bound to the new prefix. initialMetadata feeds
 * the partial, error partial and final row alike. Returns whether anything changed; the
 * caller persists it.
 */
export function moveAnthropicThinkingReplayPoint(
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

export interface StepApplyDeps {
  readonly turnEvents: Pick<TurnEvents<WorkspaceStreamInfo>, "emitTurnEvent">;
  readonly turnRegistry: Pick<TurnRegistry, "checkSoftCancelStream">;
  readonly usageLedger: Pick<UsageLedger, "recordInFlight" | "recordStep">;
  readonly turnEventEmitter: Pick<TurnEventEmitter, "appendPartAndEmit">;
  readonly tokenTracker: Pick<StreamManagerTokenTracker, "countTokens">;
  readonly schedulePartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
  readonly flushPartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
  /** StreamManager's tool-call completion (the part update, partial flush and events). */
  readonly finishToolCall: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    toolCalls: ToolCallMap,
    toolCallId: string,
    toolName: string,
    output: unknown,
    providerExecuted?: boolean,
    modelOnlyNotifications?: string[]
  ) => Promise<void>;
  readonly logOrphanToolResult: (
    workspaceLog: Logger,
    streamInfo: WorkspaceStreamInfo,
    part: { toolCallId: string; toolName: string },
    output: unknown,
    orphanCount: number,
    trackedToolCallCount: number
  ) => void;
}

export class StepApply {
  constructor(private readonly deps: StepApplyDeps) {}

  /**
   * Runs partFold's intents in order with the existing helpers. Synchronous
   * intents run without a yield between them, awaited helpers stay awaited, and
   * schedulePartialWrite stays fire-and-forget, as when the fold was inline.
   */
  async applyStep(
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
        this.deps.turnEvents.emitTurnEvent(intent.event);
        return undefined;
      case "CheckSoftCancel":
        return this.deps.turnRegistry.checkSoftCancelStream(workspaceId, streamInfo);
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
        return this.deps.finishToolCall(
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
        void this.deps.schedulePartialWrite(workspaceId, streamInfo);
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
        return this.deps.usageLedger.recordInFlight(workspaceId, streamInfo);
      case "FlushPartialWrite":
        return this.deps.flushPartialWrite(workspaceId, streamInfo);
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
        this.deps.logOrphanToolResult(
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
    await this.deps.turnEventEmitter.appendPartAndEmit(
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
    this.deps.usageLedger.recordStep(streamInfo, stepUsage, stepProviderMetadata);

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
    this.deps.turnEvents.emitTurnEvent(usageEvent);
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
    if (moveAnthropicThinkingReplayPoint(streamInfo, streamInfo.streamStepOrdinals[stripStep])) {
      await this.deps.schedulePartialWrite(workspaceId, streamInfo);
    }
  }

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

    const tokens = await this.deps.tokenTracker.countTokens(deltaText);
    // Record time: wall clock until #7282 moves its consumers to HostClock.
    const timestamp = nodeClock.nowMs();

    this.deps.turnEvents.emitTurnEvent({
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
}
